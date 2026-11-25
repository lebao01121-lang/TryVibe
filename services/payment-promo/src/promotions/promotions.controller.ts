import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { createApiResponse, type ApiResponse } from '@atelier/contracts';
import { getOrCreateCorrelationId, type HeaderBag } from '@atelier/observability';
import { SERVICE_NAME } from '../config/env';
import {
  PromotionsService,
  type AdminPromotionsListResult,
  type LockPromotionResult,
  type PromotionMutationResult,
  type ReleasePromotionResult,
  type RichEvaluatePromotionResult,
  type RichPromotionDto,
} from './promotions.service';

function readActorHeader(headers: HeaderBag): string | null {
  const raw =
    headers['x-user-email'] ??
    headers['X-User-Email'] ??
    headers['x-user-id'] ??
    headers['X-User-Id'];
  const val = Array.isArray(raw) ? raw[0] : raw;
  return typeof val === 'string' && val.trim().length > 0 ? val.trim() : null;
}

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

  @Get('active')
  async listActivePromotions(
    @Headers() headers: HeaderBag,
  ): Promise<ApiResponse<RichPromotionDto[]>> {
    const correlationId = getOrCreateCorrelationId(headers);
    const data = await this.promotionsService.listActivePromotions();
    return createApiResponse(data, { correlationId, service: SERVICE_NAME });
  }

  @Get('admin')
  async listAdminPromotions(
    @Query() query: Record<string, unknown>,
    @Headers() headers: HeaderBag,
  ): Promise<ApiResponse<AdminPromotionsListResult>> {
    const correlationId = getOrCreateCorrelationId(headers);
    const data = await this.promotionsService.listAdminPromotions(query);
    return createApiResponse(data, { correlationId, service: SERVICE_NAME });
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async createPromotion(
    @Body() body: unknown,
    @Headers() headers: HeaderBag,
  ): Promise<ApiResponse<RichPromotionDto>> {
    const correlationId = getOrCreateCorrelationId(headers);
    const data = await this.promotionsService.createPromotion(body);
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

  @Get(':id')
  async getPromotionById(
    @Param('id') id: string,
    @Headers() headers: HeaderBag,
  ): Promise<ApiResponse<RichPromotionDto>> {
    const correlationId = getOrCreateCorrelationId(headers);
    const data = await this.promotionsService.getPromotionById(id);
    return createApiResponse(data, { correlationId, service: SERVICE_NAME });
  }

  @Patch(':id')
  async updatePromotion(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers() headers: HeaderBag,
  ): Promise<ApiResponse<PromotionMutationResult>> {
    const correlationId = getOrCreateCorrelationId(headers);
    const data = await this.promotionsService.updatePromotion(id, body);
    return createApiResponse(data, { correlationId, service: SERVICE_NAME });
  }

  @Delete(':id')
  async archivePromotion(
    @Param('id') id: string,
    @Headers() headers: HeaderBag,
  ): Promise<ApiResponse<PromotionMutationResult>> {
    const correlationId = getOrCreateCorrelationId(headers);
    const data = await this.promotionsService.archivePromotion(id);
    return createApiResponse(data, { correlationId, service: SERVICE_NAME });
  }

  @Post(':id/approve-draft')
  @HttpCode(HttpStatus.OK)
  async approveDraft(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers() headers: HeaderBag,
  ): Promise<ApiResponse<PromotionMutationResult>> {
    const correlationId = getOrCreateCorrelationId(headers);
    const actor = readActorHeader(headers);
    const data = await this.promotionsService.approveDraftPromotion(id, body, actor);
    return createApiResponse(data, { correlationId, service: SERVICE_NAME });
  }
}
