import { createHash, randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
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
  sentAt: string;
  createdAt: string;
}

export interface NotificationLogsQueryFilters {
  limit?: number;
  channel?: string;
  eventId?: string;
}

export interface ProductReviewsQueryFilters {
  size?: string;
  heightCm?: number;
  weightKg?: number;
}

export interface ReviewActorContext {
  userId?: string;
  reviewerName?: string;
  adminSeedOverride?: boolean;
}

export interface VerifiedReviewWithSentimentDto extends VerifiedReviewDto {
  diemCamXucNlp: number | null;
  sentimentLabel: SentimentLabel;
}

export interface ProductReviewsWithSentimentResponseDto
  extends Omit<ProductReviewsResponseDto, 'reviews'> {
  reviews: VerifiedReviewWithSentimentDto[];
}

export interface CreateReviewResult {
  review: VerifiedReviewWithSentimentDto;
  fitStats: ProductFitStatsDto;
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
  aggregatedAt: string;
}

export interface ReviewOpsSummaryResponse {
  totalVerifiedReviews: number;
  averageRating: number;
  notificationsSentCount: number;
  totalNotificationLogs: number;
  productsCovered: number;
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

function mapReviewRowToDto(row: ProductReviewRow): VerifiedReviewWithSentimentDto {
  const fitFeedback = (Object.values(FitFeedback) as string[]).includes(row.fit_feedback)
    ? (row.fit_feedback as FitFeedbackType)
    : FitFeedback.TRUE_TO_SIZE;

  const moderationStatus = (Object.values(ReviewModerationStatus) as string[]).includes(
    row.moderation_status,
  )
    ? (row.moderation_status as ReviewModerationStatusType)
    : ReviewModerationStatus.APPROVED;

  const sentimentScore =
    row.sentiment_score === null || row.sentiment_score === undefined
      ? null
      : Number(row.sentiment_score);
  const sentimentLabel = normalizeSentimentLabel(row.sentiment_label, sentimentScore);

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
         COUNT(*) FILTER (WHERE fit_feedback = 'RUNS_SMALL')::int AS runs_small_count,
         COUNT(*) FILTER (WHERE fit_feedback = 'TRUE_TO_SIZE')::int AS true_to_size_count,
         COUNT(*) FILTER (WHERE fit_feedback = 'RUNS_LARGE')::int AS runs_large_count,
         ROUND(AVG(rating)::numeric, 2)::double precision AS avg_rating
       FROM product_reviews
       WHERE product_id = $1
         AND moderation_status = 'APPROVED'
       GROUP BY product_id`,
      [productId],
    );

    const row = res.rows[0];
    return row ? computeFitStatsFromRow(row) : buildEmptyFitStats(productId);
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

    // ALWAYS compute overall fitStats across ALL APPROVED reviews for this product
    const fitStats = await this.computeFitStatsForProduct(trimmedProductId);

    const conditions: string[] = [
      'product_id = $1',
      `moderation_status = '${ReviewModerationStatus.APPROVED}'`,
    ];
    const params: unknown[] = [trimmedProductId];

    if (filters.size && filters.size.trim() !== '') {
      params.push(filters.size.trim().toUpperCase());
      conditions.push(`UPPER(size_purchased) = $${params.length}`);
    }

    if (typeof filters.heightCm === 'number' && Number.isFinite(filters.heightCm)) {
      params.push(filters.heightCm);
      conditions.push(`ABS(reviewer_height_cm - $${params.length}) <= 4`);
    }

    if (typeof filters.weightKg === 'number' && Number.isFinite(filters.weightKg)) {
      params.push(filters.weightKg);
      conditions.push(`ABS(reviewer_weight_kg - $${params.length}) <= 4`);
    }

    const reviewsRes = await this.db.query<ProductReviewRow>(
      `SELECT
         id, order_id, order_item_id, product_id, sku_id, user_id,
         reviewer_name, rating, fit_feedback, reviewer_height_cm,
         reviewer_weight_kg, size_purchased, comment, photo_urls_jsonb,
         sentiment_score, sentiment_label, moderation_status, created_at
       FROM product_reviews
       WHERE ${conditions.join(' AND ')}
       ORDER BY created_at DESC`,
      params,
    );

    const reviews = reviewsRes.rows.map(mapReviewRowToDto);

    return {
      productId: trimmedProductId,
      fitStats,
      reviews,
      total: reviews.length,
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
           COUNT(*) FILTER (WHERE fit_feedback = 'RUNS_SMALL')::int AS runs_small_count,
           COUNT(*) FILTER (WHERE fit_feedback = 'TRUE_TO_SIZE')::int AS true_to_size_count,
           COUNT(*) FILTER (WHERE fit_feedback = 'RUNS_LARGE')::int AS runs_large_count,
           ROUND(AVG(rating)::numeric, 2)::double precision AS avg_rating
         FROM product_reviews
         WHERE moderation_status = 'APPROVED'
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
         COUNT(*) FILTER (WHERE fit_feedback = 'RUNS_SMALL')::int AS runs_small_count,
         COUNT(*) FILTER (WHERE fit_feedback = 'TRUE_TO_SIZE')::int AS true_to_size_count,
         COUNT(*) FILTER (WHERE fit_feedback = 'RUNS_LARGE')::int AS runs_large_count,
         ROUND(AVG(rating)::numeric, 2)::double precision AS avg_rating
       FROM product_reviews
       WHERE moderation_status = 'APPROVED'
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
      const stats = await this.computeFitStatsForProduct(trimmed);
      const item = toFitSummaryItem(stats, aggregatedAt);
      return {
        ...item,
        items: [item],
        byProductId: { [trimmed]: item },
      };
    }

    const allStatsMap = await this.getBatchFitStats();
    const items = Object.values(allStatsMap)
      .map((stats) => toFitSummaryItem(stats, aggregatedAt))
      .sort(
        (a, b) =>
          b.fitDistribution.runsSmallPct - a.fitDistribution.runsSmallPct ||
          b.totalVerifiedReviews - a.totalVerifiedReviews,
      );

    const byProductId: Record<string, ProductFitSummaryItem> = {};
    for (const item of items) {
      byProductId[item.productId] = item;
    }

    const overallRes = await this.db.query<AggregateFitStatsRow>(
      `SELECT
         '00000000-0000-0000-0000-000000000000'::text AS product_id,
         COUNT(*)::int AS total_reviews,
         COUNT(*) FILTER (WHERE fit_feedback = 'RUNS_SMALL')::int AS runs_small_count,
         COUNT(*) FILTER (WHERE fit_feedback = 'TRUE_TO_SIZE')::int AS true_to_size_count,
         COUNT(*) FILTER (WHERE fit_feedback = 'RUNS_LARGE')::int AS runs_large_count,
         ROUND(AVG(rating)::numeric, 2)::double precision AS avg_rating
       FROM product_reviews
       WHERE moderation_status = 'APPROVED'`,
    );

    const overallStats = overallRes.rows[0]
      ? computeFitStatsFromRow(overallRes.rows[0])
      : buildEmptyFitStats('all');

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
    const [reviewsRes, notifRes] = await Promise.all([
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
         WHERE moderation_status = 'APPROVED'`,
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
    ]);

    const rawAvg = Number(reviewsRes.rows[0]?.avg_rating ?? 0);
    const averageRating = Math.min(5, Math.max(0, Math.round(rawAvg * 100) / 100));

    return {
      totalVerifiedReviews: Number(reviewsRes.rows[0]?.total_reviews ?? 0),
      averageRating,
      notificationsSentCount: Number(notifRes.rows[0]?.sent_count ?? 0),
      totalNotificationLogs: Number(notifRes.rows[0]?.total_count ?? 0),
      productsCovered: Number(reviewsRes.rows[0]?.products_covered ?? 0),
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
    const parsedResult = CreateReviewRequestSchema.safeParse(rawBody);
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
    const fitStats = await this.computeFitStatsForProduct(payload.productId);

    this.eventPublisher.dispatchFitStatsUpdated(fitStats, correlationId, traceparent);

    return { review, fitStats, sentiment };
  }

  public async analyzeTextSentiment(
    text: string,
    rating?: number,
  ): Promise<ReviewSentimentResult> {
    return this.sentimentService.analyzeVietnameseSentiment(text, rating);
  }

  public async listNotificationLogs(
    filters: NotificationLogsQueryFilters = {},
  ): Promise<NotificationLogDto[]> {
    const safeLimit = Math.min(200, Math.max(1, Math.floor(filters.limit ?? 50)));
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filters.channel && filters.channel.trim() !== '') {
      const normalized = filters.channel.trim().toUpperCase();
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

    if (filters.eventId && filters.eventId.trim() !== '') {
      params.push(filters.eventId.trim());
      conditions.push(`event_id = $${params.length}`);
    }

    params.push(safeLimit);
    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const res = await this.db.query<NotificationLogRow>(
      `SELECT
         id, event_id, channel, recipient, template_code, subject,
         payload_jsonb, status, retry_count, sent_at, created_at
       FROM notification_logs
       ${whereClause}
       ORDER BY COALESCE(created_at, sent_at) DESC, sent_at DESC
       LIMIT $${params.length}`,
      params,
    );

    return res.rows.map((row) => ({
      id: row.id,
      eventId: row.event_id,
      channel: row.channel as NotificationChannelType,
      recipient: row.recipient,
      templateCode: row.template_code,
      subject: row.subject ?? null,
      payload: parseJsonObject(row.payload_jsonb),
      status: row.status,
      retryCount: Number(row.retry_count ?? 0),
      sentAt: toIsoString(row.sent_at),
      createdAt: toIsoString(row.created_at ?? row.sent_at),
    }));
  }
}
