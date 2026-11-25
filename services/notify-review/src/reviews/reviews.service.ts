import { createHash, randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import {
  CreateReviewRequestSchema,
  ErrorCode,
  FitFeedback,
  HTTP_HEADERS,
  NotificationChannel,
  ReviewModerationStatus,
  type FitFeedback as FitFeedbackType,
  type ModerateReviewDto,
  type NotificationChannel as NotificationChannelType,
  type ProductFitStatsDto,
  type ProductReviewsResponseDto,
  type ReviewModerationStatus as ReviewModerationStatusType,
  type VerifiedReviewDto,
} from '@atelier/contracts';
import {
  createChildTraceparent,
  createLogger,
  TRACEPARENT_HEADER,
} from '@atelier/observability';
import {
  NOTIFY_CONFIG_TOKEN,
  SERVICE_NAME,
  type NotifyReviewConfig,
} from '../config/env';
import { NotifyDbService } from '../db/notify-db.service';
import { runNotifyReviewSeed, type NotifySeedSummary } from '../db/seed';
import { ReviewEventPublisherService } from '../messaging/review-event-publisher.service';
import {
  computeFallbackVietnameseSentiment,
  deriveSentimentLabelFromScore,
  SentimentService,
  type ReviewSentimentResult,
  type SentimentLabel,
} from './sentiment.service';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_CUSTOMER_USER_ID = '33333333-3333-4333-8333-333333333301';

interface ProductReviewRow {
  id: string;
  order_id: string | null;
  order_item_id: string | null;
  product_id: string;
  sku_id: string;
  user_id: string;
  reviewer_name: string;
  rating: number | string;
  fit_feedback: string;
  reviewer_height_cm: number | string | null;
  reviewer_weight_kg: number | string | null;
  size_purchased: string;
  comment: string;
  photo_urls_jsonb: unknown;
  sentiment_score: number | string | null;
  sentiment_label: string | null;
  moderation_status: string;
  is_hidden?: boolean | null;
  moderation_note?: string | null;
  moderated_by?: string | null;
  moderated_at?: Date | string | null;
  created_at: Date | string;
}

interface AggregateFitStatsRow {
  product_id: string;
  total_reviews: number | string;
  runs_small_count: number | string;
  true_to_size_count: number | string;
  runs_large_count: number | string;
  avg_rating: number | string | null;
}

interface NotificationLogRow {
  id: string;
  event_id: string;
  channel: string;
  recipient: string;
  template_code: string;
  subject: string | null;
  payload_jsonb: unknown;
  status: string;
  retry_count: number | string;
  provider_message_id: string | null;
  provider_error_code: string | null;
  provider_error_message: string | null;
  delivery_mode: string | null;
  sent_at: Date | string;
  created_at: Date | string;
}

export interface NotificationLogDto {
  id: string;
  eventId: string;
  channel: NotificationChannelType;
  recipient: string;
  templateCode: string;
  subject: string | null;
  payload: Record<string, unknown> | null;
  status: string;
  retryCount: number;
  providerMessageId: string | null;
  providerErrorCode: string | null;
  providerErrorMessage: string | null;
  deliveryMode: string;
  sentAt: string;
  createdAt: string;
}

export interface NotificationLogsQueryFilters {
  limit?: number;
  page?: number;
  channel?: string;
  status?: string;
  eventId?: string;
  q?: string;
  search?: string;
}

export interface PaginatedNotificationLogsResponse {
  items: NotificationLogDto[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export interface AdminReviewsQueryFilters {
  productId?: string;
  rating?: number;
  sentiment?: string;
  sentimentLabel?: string;
  isHidden?: boolean;
  moderationStatus?: string;
  q?: string;
  search?: string;
  page?: number;
  limit?: number;
}

export interface AdminReviewsListResponse {
  items: VerifiedReviewWithSentimentDto[];
  reviews: VerifiedReviewWithSentimentDto[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
  sentimentSummary: ProductSentimentSummaryDto;
  summary: {
    totalAll: number;
    hiddenCount: number;
    visibleCount: number;
    averageRating: number;
  };
}

export interface ModerateReviewResult {
  review: VerifiedReviewWithSentimentDto;
  before: VerifiedReviewWithSentimentDto;
  after: VerifiedReviewWithSentimentDto;
  isHidden: boolean;
  visibilityStatus: 'VISIBLE' | 'HIDDEN';
  moderationStatus: ReviewModerationStatusType;
  fitStats: ProductFitStatsDto;
  sentimentSummary: ProductSentimentSummaryDto;
}

export interface DeleteReviewResult {
  deleted: true;
  id: string;
  productId: string;
  deletedReview: VerifiedReviewWithSentimentDto;
  fitStats: ProductFitStatsDto;
  sentimentSummary: ProductSentimentSummaryDto;
}

export interface ProductReviewsQueryFilters {
  size?: string;
  heightCm?: number;
  weightKg?: number;
  toleranceCm?: number;
  toleranceKg?: number;
}

export interface ReviewActorContext {
  userId?: string;
  reviewerName?: string;
  adminSeedOverride?: boolean;
}

export type VietnameseFitFeedbackCode = 'CHAT' | 'VUA' | 'RONG';

export interface VerifiedReviewWithSentimentDto extends VerifiedReviewDto {
  sentimentScore: number;
  diemCamXucNlp: number;
  sentimentLabel: SentimentLabel;
  fitFeedbackVi: VietnameseFitFeedbackCode;
  fitFeedbackLabelVi: 'Hơi chật' | 'Chuẩn size' | 'Hơi rộng';
  isHidden: boolean;
  visibilityStatus: 'VISIBLE' | 'HIDDEN';
  moderationNote: string | null;
  moderatedBy: string | null;
  moderatedAt: string | null;
}

export interface ProductSentimentSummaryDto {
  positivePct: number;
  neutralPct: number;
  negativePct: number;
  positiveCount: number;
  neutralCount: number;
  negativeCount: number;
  averageSentimentScore: number;
  totalScored: number;
}

export interface ProductReviewsWithSentimentResponseDto
  extends Omit<ProductReviewsResponseDto, 'reviews'> {
  reviews: VerifiedReviewWithSentimentDto[];
  sentimentSummary: ProductSentimentSummaryDto;
  appliedBodyFilter?: {
    heightCm: number | null;
    weightKg: number | null;
    toleranceCm: number;
    toleranceKg: number;
  } | null;
}

export interface CreateReviewResult {
  review: VerifiedReviewWithSentimentDto;
  fitStats: ProductFitStatsDto;
  sentimentSummary: ProductSentimentSummaryDto;
  sentiment: ReviewSentimentResult;
}

export interface ProductFitSummaryItem {
  productId: string;
  totalVerifiedReviews: number;
  totalReviews: number;
  averageRating: number;
  dominantFeedback: FitFeedbackType;
  fitDistribution: {
    runsSmallPct: number;
    trueToSizePct: number;
    runsLargePct: number;
  };
  runsSmallPct: number;
  trueToSizePct: number;
  runsLargePct: number;
  positiveSentimentPct: number;
  sentimentSummary: ProductSentimentSummaryDto;
  aggregatedAt: string;
}

export interface ReviewOpsSummaryResponse {
  totalVerifiedReviews: number;
  averageRating: number;
  notificationsSentCount: number;
  totalNotificationLogs: number;
  productsCovered: number;
  sentimentSummary: ProductSentimentSummaryDto;
  generatedAt: string;
}

export interface FitSummaryResponse {
  productId: string | null;
  totalVerifiedReviews: number;
  totalReviews: number;
  averageRating: number;
  dominantFeedback: FitFeedbackType;
  fitDistribution: {
    runsSmallPct: number;
    trueToSizePct: number;
    runsLargePct: number;
  };
  runsSmallPct: number;
  trueToSizePct: number;
  runsLargePct: number;
  positiveSentimentPct: number;
  sentimentSummary: ProductSentimentSummaryDto;
  aggregatedAt: string;
  items: ProductFitSummaryItem[];
  byProductId?: Record<string, ProductFitSummaryItem>;
}

function isValidUuid(value: string): boolean {
  return UUID_REGEX.test(value.trim());
}

function toUuidOrDerive(raw: string | undefined, fallback: string): string {
  if (!raw || !raw.trim()) {
    return fallback;
  }
  const trimmed = raw.trim();
  if (isValidUuid(trimmed)) {
    return trimmed;
  }
  const hex = createHash('sha256').update(`atelier-user:${trimmed}`).digest('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    `8${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join('-');
}

function parsePhotoUrls(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.filter((item): item is string => typeof item === 'string');
  }
  if (typeof raw === 'string') {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.filter((item): item is string => typeof item === 'string');
      }
    } catch {
      return [];
    }
  }
  return [];
}

function parseJsonObject(raw: unknown): Record<string, unknown> | null {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw === 'string') {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return null;
    }
  }
  return null;
}

function toIsoString(value: Date | string): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString();
}

function normalizeSentimentLabel(
  raw: string | null | undefined,
  score: number | null,
): SentimentLabel {
  if (typeof raw === 'string') {
    const upper = raw.trim().toUpperCase();
    if (upper === 'POSITIVE' || upper === 'NEUTRAL' || upper === 'NEGATIVE') {
      return upper;
    }
  }
  return deriveSentimentLabelFromScore(score ?? 0.75);
}

function normalizeFitFeedbackInput(raw: unknown): FitFeedbackType | null {
  if (typeof raw !== 'string') {
    return null;
  }
  const normalized = raw
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, '_');

  if (
    normalized === FitFeedback.RUNS_SMALL ||
    normalized === 'CHAT' ||
    normalized === 'HOI_CHAT' ||
    normalized === 'SMALL'
  ) {
    return FitFeedback.RUNS_SMALL;
  }
  if (
    normalized === FitFeedback.TRUE_TO_SIZE ||
    normalized === 'VUA' ||
    normalized === 'CHUAN_SIZE' ||
    normalized === 'CHUAN_PHOM' ||
    normalized === 'TRUE'
  ) {
    return FitFeedback.TRUE_TO_SIZE;
  }
  if (
    normalized === FitFeedback.RUNS_LARGE ||
    normalized === 'RONG' ||
    normalized === 'HOI_RONG' ||
    normalized === 'LARGE'
  ) {
    return FitFeedback.RUNS_LARGE;
  }
  return null;
}

function toVietnameseFitFeedback(feedback: FitFeedbackType): {
  code: VietnameseFitFeedbackCode;
  label: 'Hơi chật' | 'Chuẩn size' | 'Hơi rộng';
} {
  if (feedback === FitFeedback.RUNS_SMALL) {
    return { code: 'CHAT', label: 'Hơi chật' };
  }
  if (feedback === FitFeedback.RUNS_LARGE) {
    return { code: 'RONG', label: 'Hơi rộng' };
  }
  return { code: 'VUA', label: 'Chuẩn size' };
}

function resolveRowSentiment(row: {
  rating: number | string;
  comment: string;
  sentiment_score: number | string | null;
  sentiment_label: string | null;
}): { sentimentScore: number; sentimentLabel: SentimentLabel } {
  const numericRaw =
    row.sentiment_score === null || row.sentiment_score === undefined
      ? Number.NaN
      : Number(row.sentiment_score);

  if (Number.isFinite(numericRaw)) {
    const clamped = Math.round(Math.min(1, Math.max(-1, numericRaw)) * 1000) / 1000;
    return {
      sentimentScore: clamped,
      sentimentLabel: normalizeSentimentLabel(row.sentiment_label, clamped),
    };
  }

  const fallback = computeFallbackVietnameseSentiment(
    row.comment ?? '',
    Number.isFinite(Number(row.rating)) ? Number(row.rating) : undefined,
  );
  return {
    sentimentScore: fallback.sentimentScore,
    sentimentLabel: normalizeSentimentLabel(row.sentiment_label, fallback.sentimentScore),
  };
}

function buildEmptySentimentSummary(): ProductSentimentSummaryDto {
  return {
    positivePct: 0,
    neutralPct: 0,
    negativePct: 0,
    positiveCount: 0,
    neutralCount: 0,
    negativeCount: 0,
    averageSentimentScore: 0,
    totalScored: 0,
  };
}

function computeSentimentSummaryFromItems(
  items: ReadonlyArray<{ sentimentScore: number; sentimentLabel: SentimentLabel }>,
): ProductSentimentSummaryDto {
  const totalScored = items.length;
  if (totalScored <= 0) {
    return buildEmptySentimentSummary();
  }

  let positiveCount = 0;
  let neutralCount = 0;
  let negativeCount = 0;
  let scoreSum = 0;

  for (const item of items) {
    scoreSum += item.sentimentScore;
    if (item.sentimentLabel === 'POSITIVE') {
      positiveCount += 1;
    } else if (item.sentimentLabel === 'NEGATIVE') {
      negativeCount += 1;
    } else {
      neutralCount += 1;
    }
  }

  const buckets = [
    { key: 'POSITIVE' as const, raw: (positiveCount / totalScored) * 100 },
    { key: 'NEUTRAL' as const, raw: (neutralCount / totalScored) * 100 },
    { key: 'NEGATIVE' as const, raw: (negativeCount / totalScored) * 100 },
  ].map((b) => ({
    ...b,
    floored: Math.floor(b.raw),
    remainder: b.raw - Math.floor(b.raw),
  }));

  let remainderPoints = 100 - buckets.reduce((acc, b) => acc + b.floored, 0);
  const ranked = [...buckets].sort((a, b) => b.remainder - a.remainder);
  for (let i = 0; i < ranked.length && remainderPoints > 0; i += 1) {
    ranked[i].floored += 1;
    remainderPoints -= 1;
  }

  const pctByKey = new Map(ranked.map((b) => [b.key, b.floored]));
  const averageSentimentScore = Math.round((scoreSum / totalScored) * 1000) / 1000;

  return {
    positivePct: pctByKey.get('POSITIVE') ?? 0,
    neutralPct: pctByKey.get('NEUTRAL') ?? 0,
    negativePct: pctByKey.get('NEGATIVE') ?? 0,
    positiveCount,
    neutralCount,
    negativeCount,
    averageSentimentScore,
    totalScored,
  };
}

function mapReviewRowToDto(row: ProductReviewRow): VerifiedReviewWithSentimentDto {
  const fitFeedback =
    normalizeFitFeedbackInput(row.fit_feedback) ?? FitFeedback.TRUE_TO_SIZE;
  const fitVi = toVietnameseFitFeedback(fitFeedback);

  const moderationStatus = (Object.values(ReviewModerationStatus) as string[]).includes(
    row.moderation_status,
  )
    ? (row.moderation_status as ReviewModerationStatusType)
    : ReviewModerationStatus.APPROVED;

  const { sentimentScore, sentimentLabel } = resolveRowSentiment(row);
  const isHidden =
    Boolean(row.is_hidden) || moderationStatus === ReviewModerationStatus.REJECTED;

  return {
    id: row.id,
    orderId: row.order_id,
    orderItemId: row.order_item_id,
    productId: row.product_id,
    skuId: row.sku_id,
    userId: row.user_id,
    reviewerName: row.reviewer_name,
    rating: Number(row.rating),
    fitFeedback,
    fitFeedbackVi: fitVi.code,
    fitFeedbackLabelVi: fitVi.label,
    reviewerHeightCm:
      row.reviewer_height_cm === null || row.reviewer_height_cm === undefined
        ? null
        : Number(row.reviewer_height_cm),
    reviewerWeightKg:
      row.reviewer_weight_kg === null || row.reviewer_weight_kg === undefined
        ? null
        : Number(row.reviewer_weight_kg),
    sizePurchased: row.size_purchased,
    comment: row.comment,
    photoUrls: parsePhotoUrls(row.photo_urls_jsonb),
    sentimentScore,
    diemCamXucNlp: sentimentScore,
    sentimentLabel,
    moderationStatus,
    isHidden,
    visibilityStatus: isHidden ? 'HIDDEN' : 'VISIBLE',
    moderationNote: row.moderation_note ?? null,
    moderatedBy: row.moderated_by ?? null,
    moderatedAt: row.moderated_at ? toIsoString(row.moderated_at) : null,
    createdAt: toIsoString(row.created_at),
  };
}

function buildEmptyFitStats(productId: string): ProductFitStatsDto {
  return {
    productId,
    runsSmallPct: 0,
    trueToSizePct: 0,
    runsLargePct: 0,
    totalReviews: 0,
    averageRating: 0,
    dominantFeedback: FitFeedback.TRUE_TO_SIZE,
  };
}

function toFitSummaryItem(
  stats: ProductFitStatsDto,
  aggregatedAt: string,
  sentimentSummary: ProductSentimentSummaryDto = buildEmptySentimentSummary(),
): ProductFitSummaryItem {
  return {
    productId: stats.productId,
    totalVerifiedReviews: stats.totalReviews,
    totalReviews: stats.totalReviews,
    averageRating: stats.averageRating,
    dominantFeedback: stats.dominantFeedback,
    fitDistribution: {
      runsSmallPct: stats.runsSmallPct,
      trueToSizePct: stats.trueToSizePct,
      runsLargePct: stats.runsLargePct,
    },
    runsSmallPct: stats.runsSmallPct,
    trueToSizePct: stats.trueToSizePct,
    runsLargePct: stats.runsLargePct,
    positiveSentimentPct: sentimentSummary.positivePct,
    sentimentSummary,
    aggregatedAt,
  };
}

/**
 * Computes integer percentages summing to 100 using the largest-remainder method
 * when `totalReviews > 0`.
 */
function computeFitStatsFromRow(row: AggregateFitStatsRow): ProductFitStatsDto {
  const totalReviews = Number(row.total_reviews ?? 0);
  if (totalReviews <= 0) {
    return buildEmptyFitStats(row.product_id);
  }

  const runsSmallCount = Number(row.runs_small_count ?? 0);
  const trueToSizeCount = Number(row.true_to_size_count ?? 0);
  const runsLargeCount = Number(row.runs_large_count ?? 0);

  const buckets = [
    { key: FitFeedback.RUNS_SMALL, raw: (runsSmallCount / totalReviews) * 100 },
    { key: FitFeedback.TRUE_TO_SIZE, raw: (trueToSizeCount / totalReviews) * 100 },
    { key: FitFeedback.RUNS_LARGE, raw: (runsLargeCount / totalReviews) * 100 },
  ].map((b) => ({
    ...b,
    floored: Math.floor(b.raw),
    remainder: b.raw - Math.floor(b.raw),
  }));

  let remainderPoints = 100 - buckets.reduce((acc, b) => acc + b.floored, 0);
  const ranked = [...buckets].sort((a, b) => b.remainder - a.remainder);
  for (let i = 0; i < ranked.length && remainderPoints > 0; i += 1) {
    ranked[i].floored += 1;
    remainderPoints -= 1;
  }

  const pctByKey = new Map(ranked.map((b) => [b.key, b.floored]));
  const runsSmallPct = pctByKey.get(FitFeedback.RUNS_SMALL) ?? 0;
  const trueToSizePct = pctByKey.get(FitFeedback.TRUE_TO_SIZE) ?? 0;
  const runsLargePct = pctByKey.get(FitFeedback.RUNS_LARGE) ?? 0;

  let dominantFeedback: FitFeedbackType = FitFeedback.TRUE_TO_SIZE;
  if (runsSmallCount > trueToSizeCount && runsSmallCount >= runsLargeCount) {
    dominantFeedback = FitFeedback.RUNS_SMALL;
  } else if (runsLargeCount > trueToSizeCount && runsLargeCount > runsSmallCount) {
    dominantFeedback = FitFeedback.RUNS_LARGE;
  }

  const rawAvg = Number(row.avg_rating ?? 0);
  const averageRating = Math.min(5, Math.max(0, Math.round(rawAvg * 10) / 10));

  return {
    productId: row.product_id,
    runsSmallPct,
    trueToSizePct,
    runsLargePct,
    totalReviews,
    averageRating,
    dominantFeedback,
  };
}

@Injectable()
export class ReviewsService implements OnModuleInit {
  private readonly logger = createLogger(`${SERVICE_NAME}:reviews`);
  private lastSeedSummary: NotifySeedSummary | null = null;

  constructor(
    @Inject(NOTIFY_CONFIG_TOKEN) private readonly config: NotifyReviewConfig,
    @Inject(NotifyDbService) private readonly db: NotifyDbService,
    @Inject(ReviewEventPublisherService)
    private readonly eventPublisher: ReviewEventPublisherService,
    @Inject(SentimentService)
    private readonly sentimentService: SentimentService,
  ) {}

  async onModuleInit(): Promise<void> {
    const client = await this.db.getClient();
    const summary = await runNotifyReviewSeed(client);
    this.lastSeedSummary = summary;
    this.logger.info(
      {
        skipped: summary.skipped,
        totalReviews: summary.totalReviews,
        totalProductsCovered: summary.totalProductsCovered,
        notificationLogs: summary.notificationLogs,
      },
      'Verified Fit Reviews idempotent seed ready',
    );
  }

  public getLastSeedSummary(): NotifySeedSummary | null {
    return this.lastSeedSummary;
  }

  public async computeFitStatsForProduct(productId: string): Promise<ProductFitStatsDto> {
    const res = await this.db.query<AggregateFitStatsRow>(
      `SELECT
         product_id,
         COUNT(*)::int AS total_reviews,
         COUNT(*) FILTER (WHERE UPPER(fit_feedback) IN ('RUNS_SMALL', 'CHAT', 'HOI_CHAT'))::int AS runs_small_count,
         COUNT(*) FILTER (WHERE UPPER(fit_feedback) IN ('TRUE_TO_SIZE', 'VUA', 'CHUAN_SIZE'))::int AS true_to_size_count,
         COUNT(*) FILTER (WHERE UPPER(fit_feedback) IN ('RUNS_LARGE', 'RONG', 'HOI_RONG'))::int AS runs_large_count,
         ROUND(AVG(rating)::numeric, 2)::double precision AS avg_rating
       FROM product_reviews
       WHERE product_id = $1
         AND moderation_status = 'APPROVED'
         AND COALESCE(is_hidden, FALSE) = FALSE
       GROUP BY product_id`,
      [productId],
    );

    const row = res.rows[0];
    return row ? computeFitStatsFromRow(row) : buildEmptyFitStats(productId);
  }

  public async computeSentimentSummaryForProduct(
    productId: string,
  ): Promise<ProductSentimentSummaryDto> {
    const res = await this.db.query<{
      rating: number | string;
      comment: string;
      sentiment_score: number | string | null;
      sentiment_label: string | null;
    }>(
      `SELECT rating, comment, sentiment_score, sentiment_label
       FROM product_reviews
       WHERE product_id = $1
         AND moderation_status = 'APPROVED'
         AND COALESCE(is_hidden, FALSE) = FALSE`,
      [productId],
    );

    return computeSentimentSummaryFromItems(res.rows.map(resolveRowSentiment));
  }

  public async getProductReviews(
    productId: string,
    filters: ProductReviewsQueryFilters = {},
  ): Promise<ProductReviewsWithSentimentResponseDto> {
    const trimmedProductId = productId.trim();
    if (!isValidUuid(trimmedProductId)) {
      throw new BadRequestException({
        code: ErrorCode.VALIDATION_ERROR,
        message: 'Invalid productId UUID format.',
        details: { productId },
      });
    }

    // ALWAYS compute overall fitStats & sentimentSummary across ALL APPROVED visible reviews for this product
    const [fitStats, sentimentSummary] = await Promise.all([
      this.computeFitStatsForProduct(trimmedProductId),
      this.computeSentimentSummaryForProduct(trimmedProductId),
    ]);

    const toleranceCm =
      typeof filters.toleranceCm === 'number' && Number.isFinite(filters.toleranceCm)
        ? Math.min(20, Math.max(1, filters.toleranceCm))
        : 4;
    const toleranceKg =
      typeof filters.toleranceKg === 'number' && Number.isFinite(filters.toleranceKg)
        ? Math.min(20, Math.max(1, filters.toleranceKg))
        : 4;

    const conditions: string[] = [
      'product_id = $1',
      `moderation_status = '${ReviewModerationStatus.APPROVED}'`,
      'COALESCE(is_hidden, FALSE) = FALSE',
    ];
    const params: unknown[] = [trimmedProductId];

    if (filters.size && filters.size.trim() !== '') {
      params.push(filters.size.trim().toUpperCase());
      conditions.push(`UPPER(size_purchased) = $${params.length}`);
    }

    const hasHeightFilter =
      typeof filters.heightCm === 'number' && Number.isFinite(filters.heightCm);
    const hasWeightFilter =
      typeof filters.weightKg === 'number' && Number.isFinite(filters.weightKg);

    if (hasHeightFilter) {
      params.push(filters.heightCm);
      const heightIdx = params.length;
      params.push(toleranceCm);
      const tolIdx = params.length;
      conditions.push(`ABS(reviewer_height_cm - $${heightIdx}) <= $${tolIdx}`);
    }

    if (hasWeightFilter) {
      params.push(filters.weightKg);
      const weightIdx = params.length;
      params.push(toleranceKg);
      const tolIdx = params.length;
      conditions.push(`ABS(reviewer_weight_kg - $${weightIdx}) <= $${tolIdx}`);
    }

    const reviewsRes = await this.db.query<ProductReviewRow>(
      `SELECT
         id, order_id, order_item_id, product_id, sku_id, user_id,
         reviewer_name, rating, fit_feedback, reviewer_height_cm,
         reviewer_weight_kg, size_purchased, comment, photo_urls_jsonb,
         sentiment_score, sentiment_label, moderation_status,
         is_hidden, moderation_note, moderated_by, moderated_at, created_at
       FROM product_reviews
       WHERE ${conditions.join(' AND ')}
       ORDER BY created_at DESC`,
      params,
    );

    const reviews = reviewsRes.rows.map(mapReviewRowToDto);

    return {
      productId: trimmedProductId,
      fitStats,
      sentimentSummary,
      reviews,
      total: reviews.length,
      appliedBodyFilter:
        hasHeightFilter || hasWeightFilter
          ? {
              heightCm: hasHeightFilter ? (filters.heightCm ?? null) : null,
              weightKg: hasWeightFilter ? (filters.weightKg ?? null) : null,
              toleranceCm,
              toleranceKg,
            }
          : null,
    };
  }

  public async getBatchFitStats(
    productIds?: string[],
  ): Promise<Record<string, ProductFitStatsDto>> {
    const cleanedIds = (productIds ?? [])
      .map((id) => id.trim())
      .filter((id) => id.length > 0);

    if (cleanedIds.length > 0) {
      const invalidIds = cleanedIds.filter((id) => !isValidUuid(id));
      if (invalidIds.length > 0) {
        throw new BadRequestException({
          code: ErrorCode.VALIDATION_ERROR,
          message: 'One or more productIds have invalid UUID format.',
          details: { invalidIds },
        });
      }

      const uniqueIds = Array.from(new Set(cleanedIds));
      const placeholders = uniqueIds.map((_, idx) => `$${idx + 1}`).join(', ');
      const res = await this.db.query<AggregateFitStatsRow>(
        `SELECT
           product_id,
           COUNT(*)::int AS total_reviews,
           COUNT(*) FILTER (WHERE UPPER(fit_feedback) IN ('RUNS_SMALL', 'CHAT', 'HOI_CHAT'))::int AS runs_small_count,
           COUNT(*) FILTER (WHERE UPPER(fit_feedback) IN ('TRUE_TO_SIZE', 'VUA', 'CHUAN_SIZE'))::int AS true_to_size_count,
           COUNT(*) FILTER (WHERE UPPER(fit_feedback) IN ('RUNS_LARGE', 'RONG', 'HOI_RONG'))::int AS runs_large_count,
           ROUND(AVG(rating)::numeric, 2)::double precision AS avg_rating
         FROM product_reviews
         WHERE moderation_status = 'APPROVED'
           AND COALESCE(is_hidden, FALSE) = FALSE
           AND product_id IN (${placeholders})
         GROUP BY product_id`,
        uniqueIds,
      );

      const map: Record<string, ProductFitStatsDto> = {};
      for (const id of uniqueIds) {
        map[id] = buildEmptyFitStats(id);
      }
      for (const row of res.rows) {
        map[row.product_id] = computeFitStatsFromRow(row);
      }
      return map;
    }

    const res = await this.db.query<AggregateFitStatsRow>(
      `SELECT
         product_id,
         COUNT(*)::int AS total_reviews,
         COUNT(*) FILTER (WHERE UPPER(fit_feedback) IN ('RUNS_SMALL', 'CHAT', 'HOI_CHAT'))::int AS runs_small_count,
         COUNT(*) FILTER (WHERE UPPER(fit_feedback) IN ('TRUE_TO_SIZE', 'VUA', 'CHUAN_SIZE'))::int AS true_to_size_count,
         COUNT(*) FILTER (WHERE UPPER(fit_feedback) IN ('RUNS_LARGE', 'RONG', 'HOI_RONG'))::int AS runs_large_count,
         ROUND(AVG(rating)::numeric, 2)::double precision AS avg_rating
       FROM product_reviews
       WHERE moderation_status = 'APPROVED'
         AND COALESCE(is_hidden, FALSE) = FALSE
       GROUP BY product_id`,
    );

    const map: Record<string, ProductFitStatsDto> = {};
    for (const row of res.rows) {
      map[row.product_id] = computeFitStatsFromRow(row);
    }
    return map;
  }

  /**
   * Returns per-product fit summary (`totalVerifiedReviews`, `averageRating`,
   * `fitDistribution`) for MCP Copilot `analyze_refund_and_sizing_issues`.
   */
  public async getFitSummary(productId?: string): Promise<FitSummaryResponse> {
    const aggregatedAt = new Date().toISOString();

    if (productId && productId.trim() !== '') {
      const trimmed = productId.trim();
      if (!isValidUuid(trimmed)) {
        throw new BadRequestException({
          code: ErrorCode.VALIDATION_ERROR,
          message: 'Invalid productId UUID format.',
          details: { productId },
        });
      }
      const [stats, productSentiment] = await Promise.all([
        this.computeFitStatsForProduct(trimmed),
        this.computeSentimentSummaryForProduct(trimmed),
      ]);
      const item = toFitSummaryItem(stats, aggregatedAt, productSentiment);
      return {
        ...item,
        items: [item],
        byProductId: { [trimmed]: item },
      };
    }

    const [allStatsMap, overallRes, sentimentRowsRes] = await Promise.all([
      this.getBatchFitStats(),
      this.db.query<AggregateFitStatsRow>(
        `SELECT
           '00000000-0000-0000-0000-000000000000'::text AS product_id,
           COUNT(*)::int AS total_reviews,
           COUNT(*) FILTER (WHERE UPPER(fit_feedback) IN ('RUNS_SMALL', 'CHAT', 'HOI_CHAT'))::int AS runs_small_count,
           COUNT(*) FILTER (WHERE UPPER(fit_feedback) IN ('TRUE_TO_SIZE', 'VUA', 'CHUAN_SIZE'))::int AS true_to_size_count,
           COUNT(*) FILTER (WHERE UPPER(fit_feedback) IN ('RUNS_LARGE', 'RONG', 'HOI_RONG'))::int AS runs_large_count,
           ROUND(AVG(rating)::numeric, 2)::double precision AS avg_rating
         FROM product_reviews
         WHERE moderation_status = 'APPROVED'
           AND COALESCE(is_hidden, FALSE) = FALSE`,
      ),
      this.db.query<{
        product_id: string;
        rating: number | string;
        comment: string;
        sentiment_score: number | string | null;
        sentiment_label: string | null;
      }>(
        `SELECT product_id, rating, comment, sentiment_score, sentiment_label
         FROM product_reviews
         WHERE moderation_status = 'APPROVED'
           AND COALESCE(is_hidden, FALSE) = FALSE`,
      ),
    ]);

    const sentimentRowsByProduct = new Map<
      string,
      Array<{ sentimentScore: number; sentimentLabel: SentimentLabel }>
    >();
    const allResolvedSentiments: Array<{
      sentimentScore: number;
      sentimentLabel: SentimentLabel;
    }> = [];

    for (const row of sentimentRowsRes.rows) {
      const resolved = resolveRowSentiment(row);
      allResolvedSentiments.push(resolved);
      const list = sentimentRowsByProduct.get(row.product_id) ?? [];
      list.push(resolved);
      sentimentRowsByProduct.set(row.product_id, list);
    }

    const items = Object.values(allStatsMap)
      .map((stats) => {
        const prodSent = computeSentimentSummaryFromItems(
          sentimentRowsByProduct.get(stats.productId) ?? [],
        );
        return toFitSummaryItem(stats, aggregatedAt, prodSent);
      })
      .sort(
        (a, b) =>
          b.fitDistribution.runsSmallPct - a.fitDistribution.runsSmallPct ||
          b.totalVerifiedReviews - a.totalVerifiedReviews,
      );

    const byProductId: Record<string, ProductFitSummaryItem> = {};
    for (const item of items) {
      byProductId[item.productId] = item;
    }

    const overallStats = overallRes.rows[0]
      ? computeFitStatsFromRow(overallRes.rows[0])
      : buildEmptyFitStats('all');
    const overallSentimentSummary = computeSentimentSummaryFromItems(allResolvedSentiments);

    return {
      productId: null,
      totalVerifiedReviews: overallStats.totalReviews,
      totalReviews: overallStats.totalReviews,
      averageRating: overallStats.averageRating,
      dominantFeedback: overallStats.dominantFeedback,
      fitDistribution: {
        runsSmallPct: overallStats.runsSmallPct,
        trueToSizePct: overallStats.trueToSizePct,
        runsLargePct: overallStats.runsLargePct,
      },
      runsSmallPct: overallStats.runsSmallPct,
      trueToSizePct: overallStats.trueToSizePct,
      runsLargePct: overallStats.runsLargePct,
      positiveSentimentPct: overallSentimentSummary.positivePct,
      sentimentSummary: overallSentimentSummary,
      aggregatedAt,
      items,
      byProductId,
    };
  }

  /**
   * Returns high-level verification & Admin AI Ops summary counts for
   * `GET /v1/reviews/ops/summary`.
   */
  public async getOpsSummary(): Promise<ReviewOpsSummaryResponse> {
    const [reviewsRes, notifRes, sentimentRowsRes] = await Promise.all([
      this.db.query<{
        total_reviews: number | string;
        avg_rating: number | string | null;
        products_covered: number | string;
      }>(
        `SELECT
           COUNT(*)::int AS total_reviews,
           ROUND(AVG(rating)::numeric, 2)::double precision AS avg_rating,
           COUNT(DISTINCT product_id)::int AS products_covered
         FROM product_reviews
         WHERE moderation_status = 'APPROVED'
           AND COALESCE(is_hidden, FALSE) = FALSE`,
      ),
      this.db.query<{
        sent_count: number | string;
        total_count: number | string;
      }>(
        `SELECT
           COUNT(*) FILTER (WHERE status IN ('SENT', 'DELIVERED'))::int AS sent_count,
           COUNT(*)::int AS total_count
         FROM notification_logs`,
      ),
      this.db.query<{
        rating: number | string;
        comment: string;
        sentiment_score: number | string | null;
        sentiment_label: string | null;
      }>(
        `SELECT rating, comment, sentiment_score, sentiment_label
         FROM product_reviews
         WHERE moderation_status = 'APPROVED'
           AND COALESCE(is_hidden, FALSE) = FALSE`,
      ),
    ]);

    const rawAvg = Number(reviewsRes.rows[0]?.avg_rating ?? 0);
    const averageRating = Math.min(5, Math.max(0, Math.round(rawAvg * 100) / 100));
    const sentimentSummary = computeSentimentSummaryFromItems(
      sentimentRowsRes.rows.map(resolveRowSentiment),
    );

    return {
      totalVerifiedReviews: Number(reviewsRes.rows[0]?.total_reviews ?? 0),
      averageRating,
      notificationsSentCount: Number(notifRes.rows[0]?.sent_count ?? 0),
      totalNotificationLogs: Number(notifRes.rows[0]?.total_count ?? 0),
      productsCovered: Number(reviewsRes.rows[0]?.products_covered ?? 0),
      sentimentSummary,
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * Delivered-Order Review Gate: verifies with `order-rma` (`:4006`) that
   * `userId` has a DELIVERED/COMPLETED order containing `productId`.
   * Fails closed (`403 ORDER_NOT_DELIVERED`) whenever `eligible !== true`.
   */
  private async verifyDeliveredOrderEligibility(
    userId: string,
    productId: string,
    correlationId: string,
    traceparent?: string,
  ): Promise<{ eligible: boolean; orderId?: string; orderCode?: string }> {
    const endpoint = `${this.config.infra.orderRmaServiceUrl}/internal/orders/delivered-check?userId=${encodeURIComponent(userId)}&productId=${encodeURIComponent(productId)}`;
    const childTraceparent = createChildTraceparent(traceparent);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    try {
      const response = await fetch(endpoint, {
        method: 'GET',
        headers: {
          'x-internal-secret': this.config.internalServiceSecret,
          [HTTP_HEADERS.CORRELATION_ID]: correlationId,
          [TRACEPARENT_HEADER]: childTraceparent,
        },
        signal: controller.signal,
      });

      if (!response.ok) {
        this.logger.warn(
          { endpoint, status: response.status, userId, productId, correlationId },
          'order-rma delivered-check returned non-2xx; denying review submission',
        );
        return { eligible: false };
      }

      const json = (await response.json().catch(() => null)) as
        | {
            eligible?: boolean;
            orderId?: string;
            orderCode?: string;
            data?: { eligible?: boolean; orderId?: string; orderCode?: string };
          }
        | null;

      const payload = json?.data ?? json;
      const eligible = payload?.eligible === true;
      return {
        eligible,
        orderId: typeof payload?.orderId === 'string' ? payload.orderId : undefined,
        orderCode: typeof payload?.orderCode === 'string' ? payload.orderCode : undefined,
      };
    } catch (error: unknown) {
      this.logger.warn(
        {
          endpoint,
          userId,
          productId,
          correlationId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to contact order-rma delivered-check; failing closed with ORDER_NOT_DELIVERED',
      );
      return { eligible: false };
    } finally {
      clearTimeout(timer);
    }
  }

  public async createReview(
    rawBody: unknown,
    actor: ReviewActorContext,
    correlationId: string,
    traceparent?: string,
  ): Promise<CreateReviewResult> {
    const normalizedBody =
      rawBody && typeof rawBody === 'object' && !Array.isArray(rawBody)
        ? (() => {
            const rec = { ...(rawBody as Record<string, unknown>) };
            const mappedFit = normalizeFitFeedbackInput(rec.fitFeedback);
            if (mappedFit) {
              rec.fitFeedback = mappedFit;
            }
            return rec;
          })()
        : rawBody;

    const parsedResult = CreateReviewRequestSchema.safeParse(normalizedBody);
    if (!parsedResult.success) {
      throw new BadRequestException({
        code: ErrorCode.VALIDATION_ERROR,
        message: 'Invalid review submission payload.',
        details: { issues: parsedResult.error.flatten() },
      });
    }

    const payload = parsedResult.data;

    if (!isValidUuid(payload.productId)) {
      throw new BadRequestException({
        code: ErrorCode.VALIDATION_ERROR,
        message: 'productId must be a valid UUID.',
        details: { productId: payload.productId },
      });
    }
    if (!isValidUuid(payload.skuId)) {
      throw new BadRequestException({
        code: ErrorCode.VALIDATION_ERROR,
        message: 'skuId must be a valid UUID.',
        details: { skuId: payload.skuId },
      });
    }
    if (payload.orderId && !isValidUuid(payload.orderId)) {
      throw new BadRequestException({
        code: ErrorCode.VALIDATION_ERROR,
        message: 'orderId must be a valid UUID when provided.',
        details: { orderId: payload.orderId },
      });
    }
    if (payload.orderItemId && !isValidUuid(payload.orderItemId)) {
      throw new BadRequestException({
        code: ErrorCode.VALIDATION_ERROR,
        message: 'orderItemId must be a valid UUID when provided.',
        details: { orderItemId: payload.orderItemId },
      });
    }

    const bodyRecord =
      rawBody && typeof rawBody === 'object' ? (rawBody as Record<string, unknown>) : {};
    const rawUserId =
      actor.userId ?? (typeof bodyRecord.userId === 'string' ? bodyRecord.userId : undefined);
    const rawReviewerName =
      actor.reviewerName ??
      (typeof bodyRecord.reviewerName === 'string' ? bodyRecord.reviewerName : undefined);

    const userId = toUuidOrDerive(rawUserId, DEFAULT_CUSTOMER_USER_ID);
    const reviewerName =
      rawReviewerName && rawReviewerName.trim().length > 0
        ? rawReviewerName.trim().slice(0, 120)
        : 'Khách hàng Tầm Xuân';

    let resolvedOrderId = payload.orderId ?? null;

    if (!actor.adminSeedOverride) {
      const eligibility = await this.verifyDeliveredOrderEligibility(
        userId,
        payload.productId,
        correlationId,
        traceparent,
      );
      if (!eligibility.eligible) {
        throw new ForbiddenException({
          code: ErrorCode.ORDER_NOT_DELIVERED,
          message:
            'Chỉ khách hàng đã nhận hàng thành công (DELIVERED) mới có thể gửi đánh giá độ vừa cho sản phẩm này.',
          details: {
            userId,
            productId: payload.productId,
          },
        });
      }
      if (!resolvedOrderId && eligibility.orderId && isValidUuid(eligibility.orderId)) {
        resolvedOrderId = eligibility.orderId;
      }
    }

    const reviewId = randomUUID();
    const sentiment = await this.sentimentService.analyzeVietnameseSentiment(
      payload.comment,
      payload.rating,
      { correlationId, userId },
    );
    const photoUrls = payload.photoUrls ?? [];
    const normalizedSize = payload.sizePurchased.trim().toUpperCase();

    let insertedRow: ProductReviewRow | undefined;
    try {
      const insertRes = await this.db.query<ProductReviewRow>(
        `INSERT INTO product_reviews (
           id, order_id, order_item_id, product_id, sku_id, user_id,
           reviewer_name, rating, fit_feedback, reviewer_height_cm,
           reviewer_weight_kg, size_purchased, comment, photo_urls_jsonb,
           sentiment_score, sentiment_label, moderation_status
         ) VALUES (
           $1, $2, $3, $4, $5, $6,
           $7, $8, $9, $10,
           $11, $12, $13, $14::jsonb,
           $15, $16, $17
         )
         RETURNING
           id, order_id, order_item_id, product_id, sku_id, user_id,
           reviewer_name, rating, fit_feedback, reviewer_height_cm,
           reviewer_weight_kg, size_purchased, comment, photo_urls_jsonb,
           sentiment_score, sentiment_label, moderation_status, created_at`,
        [
          reviewId,
          resolvedOrderId,
          payload.orderItemId ?? null,
          payload.productId,
          payload.skuId,
          userId,
          reviewerName,
          payload.rating,
          payload.fitFeedback,
          Math.round(payload.reviewerHeightCm),
          Math.round(payload.reviewerWeightKg),
          normalizedSize,
          payload.comment,
          JSON.stringify(photoUrls),
          sentiment.sentimentScore,
          sentiment.sentimentLabel,
          ReviewModerationStatus.APPROVED,
        ],
      );
      insertedRow = insertRes.rows[0];
    } catch (error: unknown) {
      const pgErr = error as { code?: string; message?: string };
      if (pgErr?.code === '23505' || pgErr?.message?.includes('order_item_id')) {
        throw new ConflictException({
          code: ErrorCode.CONFLICT,
          message: 'A review has already been submitted for this orderItemId.',
          details: { orderItemId: payload.orderItemId },
        });
      }
      throw error;
    }

    if (!insertedRow) {
      throw new Error('Failed to persist product review.');
    }

    const review = mapReviewRowToDto(insertedRow);
    const [fitStats, sentimentSummary] = await Promise.all([
      this.computeFitStatsForProduct(payload.productId),
      this.computeSentimentSummaryForProduct(payload.productId),
    ]);

    this.eventPublisher.dispatchFitStatsUpdated(fitStats, correlationId, traceparent);

    return { review, fitStats, sentimentSummary, sentiment };
  }

  public async analyzeTextSentiment(
    text: string,
    rating?: number,
    correlationId?: string,
  ): Promise<ReviewSentimentResult> {
    return this.sentimentService.analyzeVietnameseSentiment(text, rating, {
      correlationId,
    });
  }

  public async listAdminReviews(
    filters: AdminReviewsQueryFilters = {},
  ): Promise<AdminReviewsListResponse> {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filters.productId && filters.productId.trim()) {
      const trimmed = filters.productId.trim();
      if (!isValidUuid(trimmed)) {
        throw new BadRequestException({
          code: ErrorCode.VALIDATION_ERROR,
          message: 'Invalid productId UUID filter.',
          details: { productId: filters.productId },
        });
      }
      params.push(trimmed);
      conditions.push(`product_id = $${params.length}`);
    }

    if (typeof filters.rating === 'number' && Number.isFinite(filters.rating)) {
      params.push(Math.trunc(filters.rating));
      conditions.push(`rating = $${params.length}`);
    }

    const sentimentFilter = (filters.sentiment ?? filters.sentimentLabel ?? '')
      .trim()
      .toUpperCase();
    if (
      sentimentFilter === 'POSITIVE' ||
      sentimentFilter === 'NEUTRAL' ||
      sentimentFilter === 'NEGATIVE'
    ) {
      params.push(sentimentFilter);
      conditions.push(`UPPER(COALESCE(sentiment_label, 'POSITIVE')) = $${params.length}`);
    }

    if (filters.isHidden !== undefined) {
      if (filters.isHidden) {
        conditions.push(`(COALESCE(is_hidden, FALSE) = TRUE OR moderation_status = 'REJECTED')`);
      } else {
        conditions.push(`(COALESCE(is_hidden, FALSE) = FALSE AND moderation_status <> 'REJECTED')`);
      }
    }

    if (filters.moderationStatus && filters.moderationStatus.trim()) {
      const modUpper = filters.moderationStatus.trim().toUpperCase();
      if (modUpper === 'HIDDEN') {
        conditions.push(`(COALESCE(is_hidden, FALSE) = TRUE OR moderation_status = 'REJECTED')`);
      } else if (modUpper === 'VISIBLE') {
        conditions.push(`(COALESCE(is_hidden, FALSE) = FALSE AND moderation_status = 'APPROVED')`);
      } else if (
        modUpper === 'APPROVED' ||
        modUpper === 'PENDING' ||
        modUpper === 'REJECTED'
      ) {
        params.push(modUpper);
        conditions.push(`moderation_status = $${params.length}`);
      }
    }

    const qText = (filters.q ?? filters.search ?? '').trim();
    if (qText) {
      params.push(`%${qText}%`);
      const p = `$${params.length}`;
      conditions.push(
        `(comment ILIKE ${p} OR reviewer_name ILIKE ${p} OR size_purchased ILIKE ${p} OR COALESCE(moderation_note, '') ILIKE ${p} OR product_id::text ILIKE ${p})`,
      );
    }

    const page = Math.max(
      1,
      Number.isFinite(Number(filters.page)) ? Math.trunc(Number(filters.page)) : 1,
    );
    const limit = Math.min(
      200,
      Math.max(
        1,
        Number.isFinite(Number(filters.limit)) ? Math.trunc(Number(filters.limit)) : 20,
      ),
    );
    const offset = (page - 1) * limit;
    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const [countRes, summaryRes, rowsRes] = await Promise.all([
      this.db.query<{ total: number | string }>(
        `SELECT COUNT(*)::int AS total FROM product_reviews ${whereClause}`,
        params,
      ),
      this.db.query<{
        total_all: number | string;
        hidden_count: number | string;
        avg_rating: number | string | null;
      }>(
        `SELECT
           COUNT(*)::int AS total_all,
           COUNT(*) FILTER (WHERE COALESCE(is_hidden, FALSE) = TRUE OR moderation_status = 'REJECTED')::int AS hidden_count,
           ROUND(AVG(rating)::numeric, 2)::double precision AS avg_rating
         FROM product_reviews`,
      ),
      this.db.query<ProductReviewRow>(
        `SELECT
           id, order_id, order_item_id, product_id, sku_id, user_id,
           reviewer_name, rating, fit_feedback, reviewer_height_cm,
           reviewer_weight_kg, size_purchased, comment, photo_urls_jsonb,
           sentiment_score, sentiment_label, moderation_status,
           is_hidden, moderation_note, moderated_by, moderated_at, created_at
         FROM product_reviews
         ${whereClause}
         ORDER BY created_at DESC
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset],
      ),
    ]);

    const total = Number(countRes.rows[0]?.total ?? 0);
    const totalPages = Math.max(1, Math.ceil(total / limit));
    const items = rowsRes.rows.map(mapReviewRowToDto);
    const sentimentSummary = computeSentimentSummaryFromItems(
      items.map((r) => ({
        sentimentScore: r.sentimentScore,
        sentimentLabel: r.sentimentLabel,
      })),
    );

    const totalAll = Number(summaryRes.rows[0]?.total_all ?? 0);
    const hiddenCount = Number(summaryRes.rows[0]?.hidden_count ?? 0);
    const rawAvg = Number(summaryRes.rows[0]?.avg_rating ?? 0);

    return {
      items,
      reviews: items,
      total,
      page,
      limit,
      totalPages,
      pagination: {
        page,
        limit,
        total,
        totalPages,
      },
      sentimentSummary,
      summary: {
        totalAll,
        hiddenCount,
        visibleCount: Math.max(0, totalAll - hiddenCount),
        averageRating: Math.min(5, Math.max(0, Math.round(rawAvg * 100) / 100)),
      },
    };
  }

  public async moderateReview(
    reviewId: string,
    input: ModerateReviewDto,
    actorIdentifier: string | undefined,
    correlationId: string,
    traceparent?: string,
  ): Promise<ModerateReviewResult> {
    const trimmedId = reviewId.trim();
    if (!isValidUuid(trimmedId)) {
      throw new NotFoundException({
        code: ErrorCode.NOT_FOUND,
        message: `Review "${reviewId}" not found.`,
      });
    }

    const existingRes = await this.db.query<ProductReviewRow>(
      `SELECT
         id, order_id, order_item_id, product_id, sku_id, user_id,
         reviewer_name, rating, fit_feedback, reviewer_height_cm,
         reviewer_weight_kg, size_purchased, comment, photo_urls_jsonb,
         sentiment_score, sentiment_label, moderation_status,
         is_hidden, moderation_note, moderated_by, moderated_at, created_at
       FROM product_reviews
       WHERE id = $1`,
      [trimmedId],
    );
    const existingRow = existingRes.rows[0];
    if (!existingRow) {
      throw new NotFoundException({
        code: ErrorCode.NOT_FOUND,
        message: `Review "${reviewId}" not found.`,
      });
    }

    const before = mapReviewRowToDto(existingRow);

    let nextHidden: boolean;
    if (typeof input.isHidden === 'boolean') {
      nextHidden = input.isHidden;
    } else if (
      input.moderationStatus === 'HIDDEN' ||
      input.moderationStatus === 'REJECTED'
    ) {
      nextHidden = true;
    } else if (
      input.moderationStatus === 'VISIBLE' ||
      input.moderationStatus === 'APPROVED'
    ) {
      nextHidden = false;
    } else {
      nextHidden = !before.isHidden;
    }

    const nextModStatus: ReviewModerationStatusType = nextHidden
      ? ReviewModerationStatus.REJECTED
      : input.moderationStatus === 'PENDING'
        ? ReviewModerationStatus.PENDING
        : ReviewModerationStatus.APPROVED;

    const nextModerationNote =
      input.moderationNote !== undefined
        ? input.moderationNote
        : (existingRow.moderation_note ?? null);
    const nextModeratedBy =
      (input.moderatedBy?.trim() || actorIdentifier?.trim() || existingRow.moderated_by) ??
      null;

    const updatedRes = await this.db.query<ProductReviewRow>(
      `UPDATE product_reviews
       SET is_hidden = $2,
           moderation_status = $3,
           moderation_note = $4,
           moderated_by = $5,
           moderated_at = NOW()
       WHERE id = $1
       RETURNING
         id, order_id, order_item_id, product_id, sku_id, user_id,
         reviewer_name, rating, fit_feedback, reviewer_height_cm,
         reviewer_weight_kg, size_purchased, comment, photo_urls_jsonb,
         sentiment_score, sentiment_label, moderation_status,
         is_hidden, moderation_note, moderated_by, moderated_at, created_at`,
      [trimmedId, nextHidden, nextModStatus, nextModerationNote, nextModeratedBy],
    );

    const after = mapReviewRowToDto(updatedRes.rows[0]);
    const [fitStats, sentimentSummary] = await Promise.all([
      this.computeFitStatsForProduct(after.productId),
      this.computeSentimentSummaryForProduct(after.productId),
    ]);

    this.eventPublisher.dispatchFitStatsUpdated(fitStats, correlationId, traceparent);

    return {
      review: after,
      before,
      after,
      isHidden: after.isHidden,
      visibilityStatus: after.isHidden ? 'HIDDEN' : 'VISIBLE',
      moderationStatus: after.moderationStatus,
      fitStats,
      sentimentSummary,
    };
  }

  public async deleteReview(
    reviewId: string,
    correlationId: string,
    traceparent?: string,
  ): Promise<DeleteReviewResult> {
    const trimmedId = reviewId.trim();
    if (!isValidUuid(trimmedId)) {
      throw new NotFoundException({
        code: ErrorCode.NOT_FOUND,
        message: `Review "${reviewId}" not found.`,
      });
    }

    const existingRes = await this.db.query<ProductReviewRow>(
      `SELECT
         id, order_id, order_item_id, product_id, sku_id, user_id,
         reviewer_name, rating, fit_feedback, reviewer_height_cm,
         reviewer_weight_kg, size_purchased, comment, photo_urls_jsonb,
         sentiment_score, sentiment_label, moderation_status,
         is_hidden, moderation_note, moderated_by, moderated_at, created_at
       FROM product_reviews
       WHERE id = $1`,
      [trimmedId],
    );
    const existingRow = existingRes.rows[0];
    if (!existingRow) {
      throw new NotFoundException({
        code: ErrorCode.NOT_FOUND,
        message: `Review "${reviewId}" not found.`,
      });
    }

    const deletedReview = mapReviewRowToDto(existingRow);
    await this.db.query('DELETE FROM product_reviews WHERE id = $1', [trimmedId]);

    const [fitStats, sentimentSummary] = await Promise.all([
      this.computeFitStatsForProduct(deletedReview.productId),
      this.computeSentimentSummaryForProduct(deletedReview.productId),
    ]);

    this.eventPublisher.dispatchFitStatsUpdated(fitStats, correlationId, traceparent);

    return {
      deleted: true,
      id: trimmedId,
      productId: deletedReview.productId,
      deletedReview,
      fitStats,
      sentimentSummary,
    };
  }

  public async listNotificationLogs(
    filters: NotificationLogsQueryFilters = {},
  ): Promise<NotificationLogDto[]> {
    const paginated = await this.listNotificationLogsPaginated(filters);
    return paginated.items;
  }

  public async listNotificationLogsPaginated(
    filters: NotificationLogsQueryFilters = {},
  ): Promise<PaginatedNotificationLogsResponse> {
    const safeLimit = Math.min(200, Math.max(1, Math.floor(filters.limit ?? 50)));
    const page = Math.max(1, Math.floor(filters.page ?? 1));
    const offset = (page - 1) * safeLimit;
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filters.channel && filters.channel.trim() !== '') {
      let normalized = filters.channel.trim().toUpperCase();
      if (normalized === 'ZNS') {
        normalized = NotificationChannel.ZALO_ZNS;
      }
      if (!(Object.values(NotificationChannel) as string[]).includes(normalized)) {
        throw new BadRequestException({
          code: ErrorCode.VALIDATION_ERROR,
          message: 'Invalid notification channel filter.',
          details: { channel: filters.channel },
        });
      }
      params.push(normalized);
      conditions.push(`channel = $${params.length}`);
    }

    if (filters.status && filters.status.trim() !== '') {
      params.push(filters.status.trim().toUpperCase());
      conditions.push(`UPPER(status) = $${params.length}`);
    }

    if (filters.eventId && filters.eventId.trim() !== '') {
      params.push(filters.eventId.trim());
      conditions.push(`event_id = $${params.length}`);
    }

    const qText = (filters.q ?? filters.search ?? '').trim();
    if (qText) {
      params.push(`%${qText}%`);
      const p = `$${params.length}`;
      conditions.push(
        `(recipient ILIKE ${p} OR COALESCE(subject, '') ILIKE ${p} OR template_code ILIKE ${p} OR event_id ILIKE ${p} OR status ILIKE ${p})`,
      );
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const [countRes, res] = await Promise.all([
      this.db.query<{ total: number | string }>(
        `SELECT COUNT(*)::int AS total FROM notification_logs ${whereClause}`,
        params,
      ),
      this.db.query<NotificationLogRow>(
        `SELECT
           id, event_id, channel, recipient, template_code, subject,
           payload_jsonb, status, retry_count,
           provider_message_id, provider_error_code, provider_error_message, delivery_mode,
           sent_at, created_at
         FROM notification_logs
         ${whereClause}
         ORDER BY COALESCE(created_at, sent_at) DESC, sent_at DESC
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, safeLimit, offset],
      ),
    ]);

    const total = Number(countRes.rows[0]?.total ?? 0);
    const totalPages = Math.max(1, Math.ceil(total / safeLimit));
    const items: NotificationLogDto[] = res.rows.map((row) => ({
      id: row.id,
      eventId: row.event_id,
      channel: row.channel as NotificationChannelType,
      recipient: row.recipient,
      templateCode: row.template_code,
      subject: row.subject ?? null,
      payload: parseJsonObject(row.payload_jsonb),
      status: row.status,
      retryCount: Number(row.retry_count ?? 0),
      providerMessageId: row.provider_message_id ?? null,
      providerErrorCode: row.provider_error_code ?? null,
      providerErrorMessage: row.provider_error_message ?? null,
      deliveryMode: row.delivery_mode ?? 'LIVE',
      sentAt: toIsoString(row.sent_at),
      createdAt: toIsoString(row.created_at ?? row.sent_at),
    }));

    return {
      items,
      total,
      page,
      limit: safeLimit,
      totalPages,
      pagination: {
        page,
        limit: safeLimit,
        total,
        totalPages,
      },
    };
  }
}
