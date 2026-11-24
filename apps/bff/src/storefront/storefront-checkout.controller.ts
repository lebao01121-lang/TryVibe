import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { JwtAccessPayload } from '@atelier/contracts';
import { getOrCreateCorrelationId, type HeaderBag } from '@atelier/observability';
import type { Response } from 'express';
import { HttpProxyService } from '../common/http-proxy.service';
import {
  buildCanonicalQueryString,
  stripStorefrontSensitiveFields,
} from '../common/sanitize';
import { BFF_CONFIG_TOKEN, type BffConfig } from '../config/env';
import { CurrentUser, type AuthenticatedRequest } from '../security/auth-types';
import { JwtAuthGuard } from '../security/guards';
import { JwtVerifierService } from '../security/jwt-verifier.service';

@Controller('bff/v1/storefront')
export class StorefrontCheckoutController {
  constructor(
    @Inject(BFF_CONFIG_TOKEN) private readonly config: BffConfig,
    @Inject(HttpProxyService) private readonly proxy: HttpProxyService,
    @Inject(JwtVerifierService) private readonly jwtVerifier: JwtVerifierService,
  ) {}

  // ============================================================================
  // Checkout & Order Tracking (proxied to order-rma:4006)
  // ============================================================================

  @Post('orders')
  async createOrder(
    @Body() body: unknown,
    @Req() req: AuthenticatedRequest,
    @Res() res: Response,
  ): Promise<void> {
    const extraHeaders = await this.resolveCallerHeaders(req);
    const upstream = await this.proxy.request({
      method: 'POST',
      url: `${this.config.orderRmaServiceUrl}/v1/orders`,
      req,
      body,
      extraHeaders,
      timeoutMs: 20_000,
    });
    this.proxy.sendProxyResponse(res, upstream, (payload) =>
      stripStorefrontSensitiveFields(payload),
    );
  }

  @Get('orders/me')
  @UseGuards(JwtAuthGuard)
  async listMyOrders(
    @Query() query: Record<string, unknown>,
    @Req() req: AuthenticatedRequest,
    @Res() res: Response,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<void> {
    const qs = buildCanonicalQueryString(query);
    const upstream = await this.proxy.request({
      method: 'GET',
      url: `${this.config.orderRmaServiceUrl}/v1/orders/me${qs ? `?${qs}` : ''}`,
      req,
      extraHeaders: this.buildVerifiedHeaders(req, user),
    });
    this.proxy.sendProxyResponse(res, upstream, (payload) =>
      stripStorefrontSensitiveFields(payload),
    );
  }

  @Get('orders/:orderCode')
  async getOrderByCode(
    @Param('orderCode') orderCode: string,
    @Req() req: AuthenticatedRequest,
    @Res() res: Response,
  ): Promise<void> {
    const extraHeaders = await this.resolveCallerHeaders(req);
    const upstream = await this.proxy.request({
      method: 'GET',
      url: `${this.config.orderRmaServiceUrl}/v1/orders/${encodeURIComponent(orderCode)}`,
      req,
      extraHeaders,
    });
    this.proxy.sendProxyResponse(res, upstream, (payload) =>
      stripStorefrontSensitiveFields(payload),
    );
  }

  @Post('orders/:orderCode/rma')
  @UseGuards(JwtAuthGuard)
  async createOrderRma(
    @Param('orderCode') orderCode: string,
    @Body() body: unknown,
    @Req() req: AuthenticatedRequest,
    @Res() res: Response,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<void> {
    const upstream = await this.proxy.request({
      method: 'POST',
      url: `${this.config.orderRmaServiceUrl}/v1/orders/${encodeURIComponent(orderCode)}/rma`,
      req,
      body,
      extraHeaders: this.buildVerifiedHeaders(req, user),
    });
    this.proxy.sendProxyResponse(res, upstream, (payload) =>
      stripStorefrontSensitiveFields(payload),
    );
  }

  @Get('orders/:orderCode/rma')
  async listOrderRmas(
    @Param('orderCode') orderCode: string,
    @Req() req: AuthenticatedRequest,
    @Res() res: Response,
  ): Promise<void> {
    const extraHeaders = await this.resolveCallerHeaders(req);
    const upstream = await this.proxy.request({
      method: 'GET',
      url: `${this.config.orderRmaServiceUrl}/v1/orders/${encodeURIComponent(orderCode)}/rma`,
      req,
      extraHeaders,
    });
    this.proxy.sendProxyResponse(res, upstream, (payload) =>
      stripStorefrontSensitiveFields(payload),
    );
  }

  // ============================================================================
  // Promotions & Dev Webhook Simulator (proxied to payment-promo:4007)
  // ============================================================================

  @Get('promotions')
  async listPromotions(
    @Req() req: AuthenticatedRequest,
    @Res() res: Response,
  ): Promise<void> {
    const extraHeaders = await this.resolveCallerHeaders(req);
    const upstream = await this.proxy.request({
      method: 'GET',
      url: `${this.config.paymentPromoServiceUrl}/v1/promotions`,
      req,
      extraHeaders,
    });
    this.proxy.sendProxyResponse(res, upstream, (payload) =>
      stripStorefrontSensitiveFields(payload),
    );
  }

  @Post('promotions/evaluate')
  async evaluatePromotions(
    @Body() body: unknown,
    @Req() req: AuthenticatedRequest,
    @Res() res: Response,
  ): Promise<void> {
    const extraHeaders = await this.resolveCallerHeaders(req);
    const upstream = await this.proxy.request({
      method: 'POST',
      url: `${this.config.paymentPromoServiceUrl}/v1/promotions/evaluate`,
      req,
      body,
      extraHeaders,
    });
    this.proxy.sendProxyResponse(res, upstream, (payload) =>
      stripStorefrontSensitiveFields(payload),
    );
  }

  @Post('payments/dev-simulate-webhook')
  async simulatePaymentWebhook(
    @Body() body: unknown,
    @Req() req: AuthenticatedRequest,
    @Res() res: Response,
  ): Promise<void> {
    const extraHeaders = await this.resolveCallerHeaders(req);
    const upstream = await this.proxy.request({
      method: 'POST',
      url: `${this.config.paymentPromoServiceUrl}/v1/payments/dev-simulate-webhook`,
      req,
      body,
      extraHeaders,
      timeoutMs: 20_000,
    });
    this.proxy.sendProxyResponse(res, upstream, (payload) =>
      stripStorefrontSensitiveFields(payload),
    );
  }

  private async resolveCallerHeaders(
    req: AuthenticatedRequest,
  ): Promise<Record<string, string | undefined>> {
    // Strip any client-spoofed privileged headers before injecting verified JWT claims
    delete req.headers['x-user-id'];
    delete req.headers['x-actor-roles'];
    delete req.headers['x-supplier-id'];
    delete req.headers['x-internal-secret'];

    const user = await this.jwtVerifier.verifyRequestOptional(req);
    const guestSessionId = this.extractGuestSessionId(req);
    const correlationId = getOrCreateCorrelationId(req.headers as HeaderBag);
    const clientIp = this.proxy.extractClientIp(req);

    return {
      'x-user-id': user?.sub,
      'x-actor-roles': user ? user.roles.join(',') : undefined,
      'x-user-email': user?.email,
      'x-loyalty-tier': user?.loyaltyTier,
      'x-guest-session-id': guestSessionId,
      'x-client-ip': clientIp,
      'x-correlation-id': correlationId,
    };
  }

  private buildVerifiedHeaders(
    req: AuthenticatedRequest,
    user: JwtAccessPayload,
  ): Record<string, string | undefined> {
    delete req.headers['x-user-id'];
    delete req.headers['x-actor-roles'];
    delete req.headers['x-supplier-id'];
    delete req.headers['x-internal-secret'];

    const guestSessionId = this.extractGuestSessionId(req);
    const correlationId = getOrCreateCorrelationId(req.headers as HeaderBag);
    const clientIp = this.proxy.extractClientIp(req);

    return {
      'x-user-id': user.sub,
      'x-actor-roles': user.roles.join(','),
      'x-user-email': user.email,
      'x-loyalty-tier': user.loyaltyTier,
      'x-guest-session-id': guestSessionId,
      'x-client-ip': clientIp,
      'x-correlation-id': correlationId,
    };
  }

  private extractGuestSessionId(req: AuthenticatedRequest): string | undefined {
    const raw = req.headers['x-guest-session-id'];
    const val = Array.isArray(raw) ? raw[0] : raw;
    if (typeof val === 'string' && val.trim().length > 0) {
      return val.trim();
    }
    return undefined;
  }
}
