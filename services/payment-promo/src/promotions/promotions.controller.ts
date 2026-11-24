import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  Query,
} from '@nestjs/common';
import { createApiResponse, type ApiResponse } from '@atelier/contracts';
import { getOrCreateCorrelationId, type HeaderBag } from '@atelier/observability';
import { SERVICE_NAME } from '../config/env';
import {
  PromotionsService,
  type LockPromotionResult,
  type ReleasePromotionResult,
  type RichEvaluatePromotionResult,
  type RichPromotionDto,
} from './promotions.service';

@Controller('v1/promotions')
export class PromotionsController {
  constructor(private readonly promotionsService: PromotionsService) {}

  @Get()
  async listPromotions(
    @Query('status') status: string | undefined,
    @Headers() headers: HeaderBag,
  ): Promise<ApiResponse<RichPromotionDto[]>> {
    const correlationId = getOrCreateCorrelationId(headers);
    const data = await this.promotionsService.listPromotions(status);
    return createApiResponse(data, { correlationId, service: SERVICE_NAME });
  }

  @Post('evaluate')
  @HttpCode(HttpStatus.OK)
  async evaluate(
    @Body() body: unknown,
    @Headers() headers: HeaderBag,
  ): Promise<ApiResponse<RichEvaluatePromotionResult>> {
    const correlationId = getOrCreateCorrelationId(headers);
    const data = await this.promotionsService.evaluatePromotion(body);
    return createApiResponse(data, { correlationId, service: SERVICE_NAME });
  }

  @Post('lock')
  @HttpCode(HttpStatus.OK)
  async lock(
    @Body() body: unknown,
    @Headers() headers: HeaderBag,
  ): Promise<ApiResponse<LockPromotionResult>> {
    const correlationId = getOrCreateCorrelationId(headers);
    const data = await this.promotionsService.lockPromotion(body);
    return createApiResponse(data, { correlationId, service: SERVICE_NAME });
  }

  @Post('release')
  @HttpCode(HttpStatus.OK)
  async release(
    @Body() body: unknown,
    @Headers() headers: HeaderBag,
  ): Promise<ApiResponse<ReleasePromotionResult>> {
    const correlationId = getOrCreateCorrelationId(headers);
    const data = await this.promotionsService.releasePromotion(body);
    return createApiResponse(data, { correlationId, service: SERVICE_NAME });
  }

  @Post('ai-clearance-draft')
  async createAiClearanceDraft(
    @Body() body: unknown,
    @Headers() headers: HeaderBag,
  ): Promise<ApiResponse<RichPromotionDto>> {
    const correlationId = getOrCreateCorrelationId(headers);
    const data = await this.promotionsService.createAiClearanceDraft(body);
    return createApiResponse(data, { correlationId, service: SERVICE_NAME });
  }
}
