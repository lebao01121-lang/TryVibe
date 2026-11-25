import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { z } from 'zod';
import {
  createApiResponse,
  ErrorCode,
  ModerateReviewDtoSchema,
  type ApiResponse,
  type ProductFitStatsDto,
} from '@atelier/contracts';
import {
  getOrCreateCorrelationId,
  getOrCreateTraceparent,
  type HeaderBag,
} from '@atelier/observability';
import { hasValidInternalSecret, readHeader } from '../common/internal-secret';
import { NOTIFY_CONFIG_TOKEN, type NotifyReviewConfig } from '../config/env';
import {
  ReviewsService,
  type AdminReviewsListResponse,
  type CreateReviewResult,
  type DeleteReviewResult,
  type FitSummaryResponse,
  type ModerateReviewResult,
  type PaginatedNotificationLogsResponse,
  type ProductReviewsWithSentimentResponseDto,
  type ProductSentimentSummaryDto,
  type ReviewOpsSummaryResponse,
} from './reviews.service';
import type { ReviewSentimentResult } from './sentiment.service';

const AnalyzeSentimentRequestSchema = z.object({
  text: z.string().trim().min(1).max(2000),
  rating: z.number().int().min(1).max(5).optional(),
});

function parseOptionalNumericQuery(
  raw: string | undefined,
  fieldName: string,
): number | undefined {
  if (raw === undefined || raw === null || raw.trim() === '') {
    return undefined;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new BadRequestException({
      code: ErrorCode.VALIDATION_ERROR,
      message: `Query parameter "${fieldName}" must be a valid number.`,
      details: { [fieldName]: raw },
    });
  }
  return parsed;
}

function safeDecodeHeader(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function parseOptionalBooleanQuery(raw: string | undefined): boolean | undefined {
  if (raw === undefined || raw === null || raw.trim() === '') {
    return undefined;
  }
  const lowered = raw.trim().toLowerCase();
  if (lowered === 'true' || lowered === '1') return true;
  if (lowered === 'false' || lowered === '0') return false;
  return undefined;
}

@Controller()
export class ReviewsController {
  constructor(
    @Inject(NOTIFY_CONFIG_TOKEN) private readonly config: NotifyReviewConfig,
    @Inject(ReviewsService) private readonly reviewsService: ReviewsService,
  ) {}

  @Get(['v1/reviews', 'v1/reviews/admin'])
  async listAdminReviews(
    @Query('productId') productId: string | undefined,
    @Query('rating') ratingRaw: string | undefined,
    @Query('sentiment') sentiment: string | undefined,
    @Query('sentimentLabel') sentimentLabel: string | undefined,
    @Query('isHidden') isHiddenRaw: string | undefined,
    @Query('moderationStatus') moderationStatus: string | undefined,
    @Query('q') q: string | undefined,
    @Query('search') search: string | undefined,
    @Query('page') pageRaw: string | undefined,
    @Query('limit') limitRaw: string | undefined,
    @Query('pageSize') pageSizeRaw: string | undefined,
    @Headers() headers: HeaderBag,
  ): Promise<ApiResponse<AdminReviewsListResponse>> {
    const correlationId = getOrCreateCorrelationId(headers);
    const rating = parseOptionalNumericQuery(ratingRaw, 'rating');
    const page = parseOptionalNumericQuery(pageRaw, 'page') ?? 1;
    const limit = parseOptionalNumericQuery(limitRaw ?? pageSizeRaw, 'limit') ?? 20;

    const data = await this.reviewsService.listAdminReviews({
      productId,
      rating,
      sentiment,
      sentimentLabel,
      isHidden: parseOptionalBooleanQuery(isHiddenRaw),
      moderationStatus,
      q,
      search,
      page,
      limit,
    });

    return createApiResponse(data, {
      correlationId,
      service: this.config.serviceName,
    });
  }

  @Get('v1/reviews/products/:productId')
  async getProductReviews(
    @Param('productId') productId: string,
    @Query('size') size: string | undefined,
    @Query('heightCm') heightCmRaw: string | undefined,
    @Query('weightKg') weightKgRaw: string | undefined,
    @Query('toleranceCm') toleranceCmRaw: string | undefined,
    @Query('toleranceKg') toleranceKgRaw: string | undefined,
    @Headers() headers: HeaderBag,
  ): Promise<ApiResponse<ProductReviewsWithSentimentResponseDto>> {
    const correlationId = getOrCreateCorrelationId(headers);
    const heightCm = parseOptionalNumericQuery(heightCmRaw, 'heightCm');
    const weightKg = parseOptionalNumericQuery(weightKgRaw, 'weightKg');
    const toleranceCm = parseOptionalNumericQuery(toleranceCmRaw, 'toleranceCm');
    const toleranceKg = parseOptionalNumericQuery(toleranceKgRaw, 'toleranceKg');

    const data = await this.reviewsService.getProductReviews(productId, {
      size,
      heightCm,
      weightKg,
      toleranceCm,
      toleranceKg,
    });

    return createApiResponse(data, {
      correlationId,
      service: this.config.serviceName,
    });
  }

  @Get('v1/reviews/products/:productId/sentiment-summary')
  async getProductSentimentSummary(
    @Param('productId') productId: string,
    @Headers() headers: HeaderBag,
  ): Promise<ApiResponse<ProductSentimentSummaryDto>> {
    const correlationId = getOrCreateCorrelationId(headers);
    const data = await this.reviewsService.computeSentimentSummaryForProduct(
      productId.trim(),
    );

    return createApiResponse(data, {
      correlationId,
      service: this.config.serviceName,
    });
  }

  @Get('v1/reviews/stats/batch')
  async getBatchFitStats(
    @Query('productIds') productIdsRaw: string | string[] | undefined,
    @Headers() headers: HeaderBag,
  ): Promise<ApiResponse<Record<string, ProductFitStatsDto>>> {
    const correlationId = getOrCreateCorrelationId(headers);

    let productIds: string[] | undefined;
    if (Array.isArray(productIdsRaw)) {
      productIds = productIdsRaw.flatMap((part) => part.split(','));
    } else if (typeof productIdsRaw === 'string' && productIdsRaw.trim() !== '') {
      productIds = productIdsRaw.split(',');
    }

    const statsMap = await this.reviewsService.getBatchFitStats(productIds);
    return createApiResponse(statsMap, {
      correlationId,
      service: this.config.serviceName,
    });
  }

  @Get('v1/reviews/fit-summary')
  async getFitSummary(
    @Query('productId') productId: string | undefined,
    @Headers() headers: HeaderBag,
  ): Promise<ApiResponse<FitSummaryResponse>> {
    const correlationId = getOrCreateCorrelationId(headers);
    const summary = await this.reviewsService.getFitSummary(productId);

    return createApiResponse(summary, {
      correlationId,
      service: this.config.serviceName,
    });
  }

  @Get('v1/reviews/ops/summary')
  async getOpsSummary(
    @Headers() headers: HeaderBag,
  ): Promise<ApiResponse<ReviewOpsSummaryResponse>> {
    const correlationId = getOrCreateCorrelationId(headers);
    const summary = await this.reviewsService.getOpsSummary();

    return createApiResponse(summary, {
      correlationId,
      service: this.config.serviceName,
    });
  }

  @Post('v1/reviews/analyze-sentiment')
  @HttpCode(HttpStatus.OK)
  async analyzeSentiment(
    @Body() rawBody: unknown,
    @Headers() headers: HeaderBag,
  ): Promise<ApiResponse<ReviewSentimentResult>> {
    const correlationId = getOrCreateCorrelationId(headers);
    const parsed = AnalyzeSentimentRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new BadRequestException({
        code: ErrorCode.VALIDATION_ERROR,
        message: 'Body must include non-empty "text" string (max 2000 chars).',
        details: { issues: parsed.error.flatten() },
      });
    }

    const result = await this.reviewsService.analyzeTextSentiment(
      parsed.data.text,
      parsed.data.rating,
      correlationId,
    );
    return createApiResponse(result, {
      correlationId,
      service: this.config.serviceName,
    });
  }

  @Post('v1/reviews')
  @HttpCode(HttpStatus.CREATED)
  async createReview(
    @Body() body: unknown,
    @Headers() headers: HeaderBag,
  ): Promise<ApiResponse<CreateReviewResult>> {
    const correlationId = getOrCreateCorrelationId(headers);
    const traceparent = getOrCreateTraceparent(headers);

    const internalSecretOk = hasValidInternalSecret(
      headers,
      this.config.internalServiceSecret,
    );
    const overrideFlag =
      readHeader(headers, 'x-admin-seed-override') ??
      readHeader(headers, 'x-skip-delivered-check');
    const adminSeedOverride =
      internalSecretOk && (overrideFlag === 'true' || overrideFlag === '1');

    const actor = {
      userId: readHeader(headers, 'x-user-id'),
      reviewerName: safeDecodeHeader(
        readHeader(headers, 'x-reviewer-name') ?? readHeader(headers, 'x-user-name'),
      ),
      adminSeedOverride,
    };

    const result = await this.reviewsService.createReview(
      body,
      actor,
      correlationId,
      traceparent,
    );
    return createApiResponse(result, {
      correlationId,
      service: this.config.serviceName,
    });
  }

  @Patch('v1/reviews/:id/moderation')
  async moderateReview(
    @Param('id') id: string,
    @Body() rawBody: unknown,
    @Headers() headers: HeaderBag,
  ): Promise<ApiResponse<ModerateReviewResult>> {
    const correlationId = getOrCreateCorrelationId(headers);
    const traceparent = getOrCreateTraceparent(headers);
    const parsed = ModerateReviewDtoSchema.safeParse(rawBody ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        code: ErrorCode.VALIDATION_ERROR,
        message: 'Invalid review moderation payload.',
        details: { issues: parsed.error.flatten() },
      });
    }
    const actorIdentifier =
      readHeader(headers, 'x-user-email') ?? readHeader(headers, 'x-user-id');
    const result = await this.reviewsService.moderateReview(
      id,
      parsed.data,
      actorIdentifier,
      correlationId,
      traceparent,
    );
    return createApiResponse(result, {
      correlationId,
      service: this.config.serviceName,
    });
  }

  @Delete('v1/reviews/:id')
  async deleteReview(
    @Param('id') id: string,
    @Headers() headers: HeaderBag,
  ): Promise<ApiResponse<DeleteReviewResult>> {
    const correlationId = getOrCreateCorrelationId(headers);
    const traceparent = getOrCreateTraceparent(headers);
    const result = await this.reviewsService.deleteReview(
      id,
      correlationId,
      traceparent,
    );
    return createApiResponse(result, {
      correlationId,
      service: this.config.serviceName,
    });
  }

  @Get('v1/notifications/logs')
  async listNotificationLogs(
    @Query('limit') limitRaw: string | undefined,
    @Query('pageSize') pageSizeRaw: string | undefined,
    @Query('page') pageRaw: string | undefined,
    @Query('channel') channel: string | undefined,
    @Query('status') status: string | undefined,
    @Query('eventId') eventId: string | undefined,
    @Query('q') q: string | undefined,
    @Query('search') search: string | undefined,
    @Headers() headers: HeaderBag,
  ): Promise<ApiResponse<PaginatedNotificationLogsResponse>> {
    const correlationId = getOrCreateCorrelationId(headers);
    const limit = parseOptionalNumericQuery(limitRaw ?? pageSizeRaw, 'limit') ?? 50;
    const page = parseOptionalNumericQuery(pageRaw, 'page') ?? 1;
    const data = await this.reviewsService.listNotificationLogsPaginated({
      limit,
      page,
      channel,
      status,
      eventId,
      q,
      search,
    });

    return createApiResponse(data, {
      correlationId,
      service: this.config.serviceName,
    });
  }
}
