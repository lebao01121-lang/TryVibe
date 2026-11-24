import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { z } from 'zod';
import {
  createApiResponse,
  ErrorCode,
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
  type CreateReviewResult,
  type FitSummaryResponse,
  type NotificationLogDto,
  type ProductReviewsWithSentimentResponseDto,
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

@Controller()
export class ReviewsController {
  constructor(
    @Inject(NOTIFY_CONFIG_TOKEN) private readonly config: NotifyReviewConfig,
    @Inject(ReviewsService) private readonly reviewsService: ReviewsService,
  ) {}

  @Get('v1/reviews/products/:productId')
  async getProductReviews(
    @Param('productId') productId: string,
    @Query('size') size: string | undefined,
    @Query('heightCm') heightCmRaw: string | undefined,
    @Query('weightKg') weightKgRaw: string | undefined,
    @Headers() headers: HeaderBag,
  ): Promise<ApiResponse<ProductReviewsWithSentimentResponseDto>> {
    const correlationId = getOrCreateCorrelationId(headers);
    const heightCm = parseOptionalNumericQuery(heightCmRaw, 'heightCm');
    const weightKg = parseOptionalNumericQuery(weightKgRaw, 'weightKg');

    const data = await this.reviewsService.getProductReviews(productId, {
      size,
      heightCm,
      weightKg,
    });

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

  @Get('v1/notifications/logs')
  async listNotificationLogs(
    @Query('limit') limitRaw: string | undefined,
    @Query('channel') channel: string | undefined,
    @Query('eventId') eventId: string | undefined,
    @Headers() headers: HeaderBag,
  ): Promise<ApiResponse<{ items: NotificationLogDto[]; total: number }>> {
    const correlationId = getOrCreateCorrelationId(headers);
    const limit = parseOptionalNumericQuery(limitRaw, 'limit') ?? 50;
    const items = await this.reviewsService.listNotificationLogs({
      limit,
      channel,
      eventId,
    });

    return createApiResponse(
      { items, total: items.length },
      {
        correlationId,
        service: this.config.serviceName,
      },
    );
  }
}
