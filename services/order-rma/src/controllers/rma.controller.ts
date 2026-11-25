import {
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
import {
  createApiResponse,
  type ApiResponse,
  type RmaRequestDTO,
  type RmaStatsSummaryDTO,
} from '@atelier/contracts';
import {
  getOrCreateCorrelationId,
  getOrCreateTraceparent,
  type HeaderBag,
} from '@atelier/observability';
import { ORDER_CONFIG_TOKEN, SERVICE_NAME, type OrderRmaConfig } from '../config/env';
import { OrderRmaService, type RmaMutationResult } from '../services/order-rma.service';
import { extractOrderActor } from './orders.controller';

@Controller()
export class RmaController {
  constructor(
    @Inject(ORDER_CONFIG_TOKEN) private readonly config: OrderRmaConfig,
    private readonly orderRmaService: OrderRmaService,
  ) {}

  @Post('v1/orders/:orderCode/rma')
  @HttpCode(HttpStatus.CREATED)
  async createRma(
    @Param('orderCode') orderCode: string,
    @Body() body: unknown,
    @Headers() headers: HeaderBag,
  ): Promise<ApiResponse<RmaRequestDTO>> {
    const actor = extractOrderActor(headers, this.config.internalServiceSecret);
    const data = await this.orderRmaService.createRmaRequest(orderCode, body, actor);
    return createApiResponse(data, {
      correlationId: actor.correlationId,
      service: SERVICE_NAME,
    });
  }

  @Get('v1/orders/:orderCode/rma')
  async listOrderRmas(
    @Param('orderCode') orderCode: string,
    @Headers() headers: HeaderBag,
  ): Promise<ApiResponse<RmaRequestDTO[]>> {
    const actor = extractOrderActor(headers, this.config.internalServiceSecret);
    const data = await this.orderRmaService.listOrderRmas(orderCode, actor);
    return createApiResponse(data, {
      correlationId: actor.correlationId,
      service: SERVICE_NAME,
    });
  }

  @Get('v1/admin/rma/stats')
  async getRmaStats(
    @Query('productId') productId: string | undefined,
    @Query('periodDays') periodDaysRaw: string | undefined,
    @Headers() headers: HeaderBag,
  ): Promise<ApiResponse<RmaStatsSummaryDTO>> {
    const correlationId = getOrCreateCorrelationId(headers);
    const parsedDays = periodDaysRaw ? Number.parseInt(periodDaysRaw, 10) : 30;
    const data = await this.orderRmaService.getRmaStats({
      productId,
      periodDays: Number.isFinite(parsedDays) ? parsedDays : 30,
    });
    return createApiResponse(data, {
      correlationId,
      service: SERVICE_NAME,
    });
  }

  @Get('v1/rma')
  async listRmas(
    @Query('status') status: string | undefined,
    @Query('rmaType') rmaType: string | undefined,
    @Query('reasonCode') reasonCode: string | undefined,
    @Query('orderCode') orderCode: string | undefined,
    @Query('productId') productId: string | undefined,
    @Query('from') from: string | undefined,
    @Query('to') to: string | undefined,
    @Query('limit') limitRaw: string | undefined,
    @Headers() headers: HeaderBag,
  ): Promise<ApiResponse<RmaRequestDTO[]>> {
    const correlationId = getOrCreateCorrelationId(headers);
    const parsedLimit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined;
    const data = await this.orderRmaService.listAdminRmas({
      status,
      rmaType,
      reasonCode,
      orderCode,
      productId,
      from,
      to,
      limit: Number.isFinite(parsedLimit) ? parsedLimit : 500,
    });
    return createApiResponse(data, {
      correlationId,
      service: SERVICE_NAME,
    });
  }

  @Post('v1/rma/:rmaId/reject')
  @HttpCode(HttpStatus.OK)
  async rejectRmaDirect(
    @Param('rmaId') rmaId: string,
    @Body() body: unknown,
    @Headers() headers: HeaderBag,
  ): Promise<ApiResponse<RmaMutationResult>> {
    const actor = extractOrderActor(headers, this.config.internalServiceSecret);
    const data = await this.orderRmaService.rejectRma(rmaId, body, actor);
    return createApiResponse(data, {
      correlationId: actor.correlationId,
      service: SERVICE_NAME,
    });
  }

  @Get('v1/admin/rma')
  async listAdminRmas(
    @Query('status') status: string | undefined,
    @Query('rmaType') rmaType: string | undefined,
    @Query('reasonCode') reasonCode: string | undefined,
    @Query('orderCode') orderCode: string | undefined,
    @Query('productId') productId: string | undefined,
    @Query('from') from: string | undefined,
    @Query('to') to: string | undefined,
    @Query('limit') limitRaw: string | undefined,
    @Headers() headers: HeaderBag,
  ): Promise<ApiResponse<RmaRequestDTO[]>> {
    const correlationId = getOrCreateCorrelationId(headers);
    const parsedLimit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined;
    const data = await this.orderRmaService.listAdminRmas({
      status,
      rmaType,
      reasonCode,
      orderCode,
      productId,
      from,
      to,
      limit: Number.isFinite(parsedLimit) ? parsedLimit : undefined,
    });
    return createApiResponse(data, {
      correlationId,
      service: SERVICE_NAME,
    });
  }

  @Post('v1/admin/rma/:rmaId/reject')
  @HttpCode(HttpStatus.OK)
  async rejectRmaAdmin(
    @Param('rmaId') rmaId: string,
    @Body() body: unknown,
    @Headers() headers: HeaderBag,
  ): Promise<ApiResponse<RmaMutationResult>> {
    const actor = extractOrderActor(headers, this.config.internalServiceSecret);
    const data = await this.orderRmaService.rejectRma(rmaId, body, actor);
    return createApiResponse(data, {
      correlationId: actor.correlationId,
      service: SERVICE_NAME,
    });
  }

  @Post('v1/admin/rma/:rmaId/approve')
  @HttpCode(HttpStatus.OK)
  async approveRma(
    @Param('rmaId') rmaId: string,
    @Body() body: unknown,
    @Headers() headers: HeaderBag,
  ): Promise<ApiResponse<RmaRequestDTO>> {
    const correlationId = getOrCreateCorrelationId(headers);
    const traceparent = getOrCreateTraceparent(headers);
    const data = await this.orderRmaService.approveRma(rmaId, body, {
      correlationId,
      traceparent,
    });
    return createApiResponse(data, {
      correlationId,
      service: SERVICE_NAME,
    });
  }

  @Post('v1/admin/rma/:rmaId/qc-complete')
  @HttpCode(HttpStatus.OK)
  async completeRmaQc(
    @Param('rmaId') rmaId: string,
    @Body() body: unknown,
    @Headers() headers: HeaderBag,
  ): Promise<ApiResponse<RmaRequestDTO>> {
    const correlationId = getOrCreateCorrelationId(headers);
    const traceparent = getOrCreateTraceparent(headers);
    const data = await this.orderRmaService.completeRmaQc(rmaId, body, {
      correlationId,
      traceparent,
    });
    return createApiResponse(data, {
      correlationId,
      service: SERVICE_NAME,
    });
  }
}
