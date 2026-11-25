import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { getOrCreateCorrelationId, type HeaderBag } from '@atelier/observability';
import type { Request, Response } from 'express';
import {
  collectRawRequestBody,
  HttpProxyService,
} from '../common/http-proxy.service';
import { BFF_CONFIG_TOKEN, type BffConfig } from '../config/env';

type RequestWithRawBody = Request & { rawBody?: Buffer };

const FORWARDED_WEBHOOK_HEADERS: readonly string[] = [
  'x-signature',
  'x-hmac-signature',
  'x-webhook-signature',
  'x-webhook-token',
  'x-ghn-signature',
  'x-ghtk-signature',
  'x-ahamove-signature',
  'x-payos-signature',
  'x-momo-signature',
  'x-vnpay-signature',
  'x-vnp-signature',
  'x-vietqr-signature',
  'x-hub-signature',
  'x-hub-signature-256',
  'x-event-id',
  'x-webhook-id',
  'x-timestamp',
  'token',
  'shopid',
];

export function extractRawQueryString(req: Request): string {
  const rawUrl = req.originalUrl || req.url || '';
  const qIdx = rawUrl.indexOf('?');
  return qIdx >= 0 ? rawUrl.slice(qIdx) : '';
}

export function extractWebhookForwardHeaders(
  req: Request,
  correlationId: string,
  clientIp: string,
): Record<string, string | undefined> {
  const forwarded: Record<string, string | undefined> = {
    'x-correlation-id': correlationId,
    'x-client-ip': clientIp,
  };

  for (const headerName of FORWARDED_WEBHOOK_HEADERS) {
    const raw = req.headers[headerName];
    if (typeof raw === 'string' && raw.length > 0) {
      forwarded[headerName] = raw;
    } else if (Array.isArray(raw) && raw.length > 0) {
      forwarded[headerName] = raw.join(', ');
    }
  }

  return forwarded;
}

export async function resolveWebhookRawBody(
  req: RequestWithRawBody,
): Promise<{ rawBody?: Buffer; body?: unknown; contentType?: string }> {
  const contentType =
    typeof req.headers['content-type'] === 'string' && req.headers['content-type'].trim().length > 0
      ? req.headers['content-type']
      : undefined;

  if (Buffer.isBuffer(req.rawBody)) {
    return {
      rawBody: req.rawBody,
      contentType: contentType ?? 'application/json',
    };
  }

  if (req.readable && !req.readableEnded && req.body === undefined) {
    try {
      const collected = await collectRawRequestBody(req, 5 * 1024 * 1024);
      if (collected.length > 0) {
        return {
          rawBody: collected,
          contentType: contentType ?? 'application/octet-stream',
        };
      }
    } catch {
      // Fall through to parsed body if stream was already consumed
    }
  }

  if (Buffer.isBuffer(req.body)) {
    return {
      rawBody: req.body,
      contentType: contentType ?? 'application/octet-stream',
    };
  }

  return {
    body: req.body ?? {},
    contentType: contentType ?? 'application/json',
  };
}

/**
 * External Provider Webhooks & IPN Gateway (CSRF-exempt by design: external payment
 * gateways & shipping carriers authenticate via HMAC / provider signature headers).
 */
@Controller('bff/v1')
export class PublicWebhooksController {
  constructor(
    @Inject(BFF_CONFIG_TOKEN) private readonly config: BffConfig,
    @Inject(HttpProxyService) private readonly proxy: HttpProxyService,
  ) {}

  @Get('payments/webhooks/:provider')
  async paymentWebhookGet(
    @Param('provider') provider: string,
    @Req() req: RequestWithRawBody,
    @Res() res: Response,
  ): Promise<void> {
    await this.proxyWebhook(
      'GET',
      `${this.config.paymentPromoServiceUrl}/v1/payments/webhooks/${encodeURIComponent(provider)}`,
      req,
      res,
    );
  }

  @Post('payments/webhooks/:provider')
  @HttpCode(HttpStatus.OK)
  async paymentWebhookPost(
    @Param('provider') provider: string,
    @Req() req: RequestWithRawBody,
    @Res() res: Response,
  ): Promise<void> {
    await this.proxyWebhook(
      'POST',
      `${this.config.paymentPromoServiceUrl}/v1/payments/webhooks/${encodeURIComponent(provider)}`,
      req,
      res,
    );
  }

  @Get('payments/vnpay/ipn')
  async vnpayIpnGet(
    @Req() req: RequestWithRawBody,
    @Res() res: Response,
  ): Promise<void> {
    await this.proxyWebhook(
      'GET',
      `${this.config.paymentPromoServiceUrl}/v1/payments/vnpay/ipn`,
      req,
      res,
    );
  }

  @Post('payments/vnpay/ipn')
  @HttpCode(HttpStatus.OK)
  async vnpayIpnPost(
    @Req() req: RequestWithRawBody,
    @Res() res: Response,
  ): Promise<void> {
    await this.proxyWebhook(
      'POST',
      `${this.config.paymentPromoServiceUrl}/v1/payments/vnpay/ipn`,
      req,
      res,
    );
  }

  @Post('payments/momo/ipn')
  @HttpCode(HttpStatus.OK)
  async momoIpnPost(
    @Req() req: RequestWithRawBody,
    @Res() res: Response,
  ): Promise<void> {
    await this.proxyWebhook(
      'POST',
      `${this.config.paymentPromoServiceUrl}/v1/payments/momo/ipn`,
      req,
      res,
    );
  }

  @Post('payments/payos/webhook')
  @HttpCode(HttpStatus.OK)
  async payosWebhookPost(
    @Req() req: RequestWithRawBody,
    @Res() res: Response,
  ): Promise<void> {
    await this.proxyWebhook(
      'POST',
      `${this.config.paymentPromoServiceUrl}/v1/payments/payos/webhook`,
      req,
      res,
    );
  }

  @Post('webhooks/shipping/:provider')
  @HttpCode(HttpStatus.OK)
  async shippingWebhookPost(
    @Param('provider') provider: string,
    @Req() req: RequestWithRawBody,
    @Res() res: Response,
  ): Promise<void> {
    await this.proxyWebhook(
      'POST',
      `${this.config.orderRmaServiceUrl}/v1/shipping/webhooks/${encodeURIComponent(provider)}`,
      req,
      res,
    );
  }

  private async proxyWebhook(
    method: 'GET' | 'POST',
    baseTargetUrl: string,
    req: RequestWithRawBody,
    res: Response,
  ): Promise<void> {
    const correlationId = getOrCreateCorrelationId(req.headers as HeaderBag);
    const clientIp = this.proxy.extractClientIp(req);
    const rawQs = extractRawQueryString(req);
    const extraHeaders = extractWebhookForwardHeaders(req, correlationId, clientIp);

    if (method === 'GET') {
      const upstream = await this.proxy.request({
        method: 'GET',
        url: `${baseTargetUrl}${rawQs}`,
        req,
        correlationId,
        extraHeaders,
        timeoutMs: 20_000,
      });
      res.setHeader('Cache-Control', 'no-store');
      this.proxy.sendProxyResponse(res, upstream);
      return;
    }

    const payload = await resolveWebhookRawBody(req);
    const upstream = await this.proxy.request({
      method: 'POST',
      url: `${baseTargetUrl}${rawQs}`,
      req,
      rawBody: payload.rawBody,
      body: payload.body,
      contentType: payload.contentType,
      correlationId,
      extraHeaders,
      timeoutMs: 20_000,
    });
    res.setHeader('Cache-Control', 'no-store');
    this.proxy.sendProxyResponse(res, upstream);
  }
}
