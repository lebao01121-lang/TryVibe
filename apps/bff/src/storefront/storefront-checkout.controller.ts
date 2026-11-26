import * as crypto from 'node:crypto';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  createApiErrorResponse,
  createApiResponse,
  ErrorCode,
  type JwtAccessPayload,
} from '@atelier/contracts';
import { getOrCreateCorrelationId, type HeaderBag } from '@atelier/observability';
import type { Response } from 'express';
import {
  collectRawRequestBody,
  HttpProxyService,
} from '../common/http-proxy.service';
import {
  buildCanonicalQueryString,
  stripStorefrontSensitiveFields,
} from '../common/sanitize';
import { BFF_CONFIG_TOKEN, type BffConfig } from '../config/env';
import { CurrentUser, type AuthenticatedRequest } from '../security/auth-types';
import { JwtAuthGuard } from '../security/guards';
import { JwtVerifierService } from '../security/jwt-verifier.service';
import {
  extractRawQueryString,
  extractWebhookForwardHeaders,
  resolveWebhookRawBody,
} from '../webhooks/public-webhooks.controller';

const MAX_RMA_EVIDENCE_BYTES = 5 * 1024 * 1024; // 5MB
const MAX_RMA_MULTIPART_BYTES = MAX_RMA_EVIDENCE_BYTES + 256 * 1024;

type DetectedEvidenceImage = {
  valid: true;
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
  ext: 'jpg' | 'png' | 'webp';
};

function detectImageMagicBytes(
  buf: Buffer,
): DetectedEvidenceImage | { valid: false } {
  if (buf.length < 12) {
    return { valid: false };
  }
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { valid: true, mimeType: 'image/jpeg', ext: 'jpg' };
  }
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  ) {
    return { valid: true, mimeType: 'image/png', ext: 'png' };
  }
  // WebP: RIFF....WEBP
  if (
    buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buf.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return { valid: true, mimeType: 'image/webp', ext: 'webp' };
  }
  return { valid: false };
}

function parseFirstMultipartFile(
  rawBody: Buffer,
  contentType: string,
): { buffer: Buffer; fileName: string; mimeType?: string } | null {
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  const boundary = boundaryMatch?.[1] || boundaryMatch?.[2];
  if (!boundary) {
    return null;
  }

  const delimiter = Buffer.from(`--${boundary}`, 'latin1');
  const headerSep = Buffer.from('\r\n\r\n', 'latin1');
  let cursor = rawBody.indexOf(delimiter);

  while (cursor !== -1) {
    const partStart = cursor + delimiter.length;
    if (
      rawBody[partStart] === 0x2d &&
      rawBody[partStart + 1] === 0x2d
    ) {
      break; // closing --boundary--
    }
    const nextBoundaryIdx = rawBody.indexOf(delimiter, partStart);
    if (nextBoundaryIdx === -1) {
      break;
    }

    const headerOffset =
      rawBody[partStart] === 0x0d && rawBody[partStart + 1] === 0x0a
        ? partStart + 2
        : partStart;
    const sepIdx = rawBody.indexOf(headerSep, headerOffset);
    if (sepIdx !== -1 && sepIdx < nextBoundaryIdx) {
      const headersText = rawBody.subarray(headerOffset, sepIdx).toString('utf8');
      const dispMatch = /filename="([^"]*)"/i.exec(headersText);
      const nameMatch = /\bname="([^"]*)"/i.exec(headersText);
      const isFilePart =
        Boolean(dispMatch) ||
        nameMatch?.[1] === 'file' ||
        nameMatch?.[1] === 'image';

      if (isFilePart) {
        let dataEnd = nextBoundaryIdx;
        if (
          dataEnd >= 2 &&
          rawBody[dataEnd - 2] === 0x0d &&
          rawBody[dataEnd - 1] === 0x0a
        ) {
          dataEnd -= 2;
        }
        const fileBuffer = rawBody.subarray(sepIdx + 4, dataEnd);
        const typeMatch = /content-type:\s*([^\r\n;]+)/i.exec(headersText);
        return {
          buffer: fileBuffer,
          fileName: dispMatch?.[1]?.trim() || 'rma-evidence.jpg',
          mimeType: typeMatch?.[1]?.trim().toLowerCase(),
        };
      }
    }

    cursor = nextBoundaryIdx;
  }

  return null;
}

function decodeBase64Payload(raw: string): Buffer {
  const trimmed = raw.trim();
  const dataUriMatch = /^data:([^;]+);base64,([\s\S]+)$/i.exec(trimmed);
  const b64 = (dataUriMatch ? dataUriMatch[2] : trimmed).replace(/\s+/g, '');
  return Buffer.from(b64, 'base64');
}

function sanitizeActivePromotionsEnvelope(payload: unknown): unknown {
  const stripped = stripStorefrontSensitiveFields(payload);
  if (!stripped || typeof stripped !== 'object' || Array.isArray(stripped)) {
    return stripped;
  }
  const root = stripped as Record<string, unknown>;
  const rawList = Array.isArray(root.data)
    ? root.data
    : root.data &&
        typeof root.data === 'object' &&
        !Array.isArray(root.data) &&
        Array.isArray((root.data as Record<string, unknown>).items)
      ? ((root.data as Record<string, unknown>).items as unknown[])
      : null;
  if (!rawList) {
    return stripped;
  }

  const nowMs = Date.now();
  const INTERNAL_PROMO_KEYS = new Set([
    'createdByActorType',
    'created_by_actor_type',
    'createdBy',
    'created_by',
    'internalNotes',
    'internal_notes',
    'rationale',
  ]);

  const filtered = rawList
    .filter((entry): entry is Record<string, unknown> => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        return false;
      }
      const rec = entry as Record<string, unknown>;
      if (String(rec.status ?? '').toUpperCase() !== 'ACTIVE') {
        return false;
      }
      if (typeof rec.startsAt === 'string') {
        const startMs = Date.parse(rec.startsAt);
        if (Number.isFinite(startMs) && startMs > nowMs) {
          return false;
        }
      }
      if (typeof rec.endsAt === 'string') {
        const endMs = Date.parse(rec.endsAt);
        if (Number.isFinite(endMs) && endMs < nowMs) {
          return false;
        }
      }
      const maxUses =
        rec.maxUses !== null && rec.maxUses !== undefined ? Number(rec.maxUses) : null;
      const usedCount = Number(rec.usedCount ?? 0);
      if (maxUses !== null && Number.isFinite(maxUses) && maxUses > 0 && usedCount >= maxUses) {
        return false;
      }
      return true;
    })
    .map((rec) => {
      const clean: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(rec)) {
        if (!INTERNAL_PROMO_KEYS.has(key)) {
          clean[key] = val;
        }
      }
      return clean;
    });

  return {
    ...root,
    data: filtered,
  };
}

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

  @Post('orders/:orderCode/cancel')
  @HttpCode(HttpStatus.OK)
  async cancelOrder(
    @Param('orderCode') orderCode: string,
    @Body() body: unknown,
    @Req() req: AuthenticatedRequest,
    @Res() res: Response,
  ): Promise<void> {
    const extraHeaders = await this.resolveCallerHeaders(req);
    const upstream = await this.proxy.request({
      method: 'POST',
      url: `${this.config.orderRmaServiceUrl}/v1/orders/${encodeURIComponent(orderCode)}/cancel`,
      req,
      body: body ?? {},
      extraHeaders,
      timeoutMs: 20_000,
    });
    this.proxy.sendProxyResponse(res, upstream, (payload) =>
      stripStorefrontSensitiveFields(payload),
    );
  }

  @Post('rma/evidence-upload')
  @HttpCode(HttpStatus.OK)
  async uploadRmaEvidence(
    @Req() req: AuthenticatedRequest,
    @Res() res: Response,
  ): Promise<void> {
    const correlationId = getOrCreateCorrelationId(req.headers as HeaderBag);
    const extraHeaders = await this.resolveCallerHeaders(req);
    if (!extraHeaders['x-user-id'] && !extraHeaders['x-guest-session-id']) {
      res.status(401).json(
        createApiErrorResponse(
          ErrorCode.UNAUTHORIZED,
          'Vui lòng đăng nhập hoặc cung cấp phiên khách hàng để tải lên ảnh minh chứng RMA.',
          undefined,
          { correlationId, service: this.config.serviceName },
        ),
      );
      return;
    }

    const contentType = String(req.headers['content-type'] ?? 'application/json');
    const lowerContentType = contentType.toLowerCase();

    let fileBuffer: Buffer | null = null;
    let fileName = `rma-evidence-${crypto.randomUUID().slice(0, 8)}.jpg`;

    if (lowerContentType.includes('multipart/form-data')) {
      let rawBody: Buffer;
      try {
        rawBody = await collectRawRequestBody(req, MAX_RMA_MULTIPART_BYTES);
      } catch {
        res.status(413).json(
          createApiErrorResponse(
            ErrorCode.VALIDATION_ERROR,
            'Ảnh minh chứng RMA vượt quá giới hạn tối đa 5MB.',
            { maxBytes: MAX_RMA_EVIDENCE_BYTES },
            { correlationId, service: this.config.serviceName },
          ),
        );
        return;
      }

      const parsedPart = parseFirstMultipartFile(rawBody, contentType);
      if (!parsedPart || parsedPart.buffer.length === 0) {
        res.status(400).json(
          createApiErrorResponse(
            ErrorCode.VALIDATION_ERROR,
            'Không tìm thấy tệp ảnh hợp lệ trong yêu cầu multipart/form-data.',
            undefined,
            { correlationId, service: this.config.serviceName },
          ),
        );
        return;
      }
      fileBuffer = parsedPart.buffer;
      if (parsedPart.fileName) {
        fileName = parsedPart.fileName;
      }
    } else if (
      lowerContentType.startsWith('image/') ||
      lowerContentType.includes('application/octet-stream')
    ) {
      try {
        fileBuffer = await collectRawRequestBody(req, MAX_RMA_EVIDENCE_BYTES);
      } catch {
        res.status(413).json(
          createApiErrorResponse(
            ErrorCode.VALIDATION_ERROR,
            'Ảnh minh chứng RMA vượt quá giới hạn tối đa 5MB.',
            { maxBytes: MAX_RMA_EVIDENCE_BYTES },
            { correlationId, service: this.config.serviceName },
          ),
        );
        return;
      }
    } else {
      const bodyRec =
        req.body && typeof req.body === 'object' && !Array.isArray(req.body)
          ? (req.body as Record<string, unknown>)
          : {};
      const rawB64 =
        typeof bodyRec.fileBase64 === 'string'
          ? bodyRec.fileBase64
          : typeof bodyRec.imageBase64 === 'string'
            ? bodyRec.imageBase64
            : typeof bodyRec.dataUrl === 'string'
              ? bodyRec.dataUrl
              : typeof bodyRec.file === 'string'
                ? bodyRec.file
                : '';

      if (!rawB64.trim()) {
        res.status(400).json(
          createApiErrorResponse(
            ErrorCode.VALIDATION_ERROR,
            'Vui lòng gửi ảnh dạng multipart/form-data (trường "file") hoặc JSON chứa "fileBase64".',
            undefined,
            { correlationId, service: this.config.serviceName },
          ),
        );
        return;
      }

      fileBuffer = decodeBase64Payload(rawB64);
      if (typeof bodyRec.fileName === 'string' && bodyRec.fileName.trim()) {
        fileName = bodyRec.fileName.trim();
      }
    }

    if (!fileBuffer || fileBuffer.length === 0) {
      res.status(400).json(
        createApiErrorResponse(
          ErrorCode.VALIDATION_ERROR,
          'Tệp ảnh minh chứng rỗng.',
          undefined,
          { correlationId, service: this.config.serviceName },
        ),
      );
      return;
    }

    if (fileBuffer.length > MAX_RMA_EVIDENCE_BYTES) {
      res.status(413).json(
        createApiErrorResponse(
          ErrorCode.VALIDATION_ERROR,
          'Ảnh minh chứng RMA vượt quá giới hạn tối đa 5MB.',
          { sizeBytes: fileBuffer.length, maxBytes: MAX_RMA_EVIDENCE_BYTES },
          { correlationId, service: this.config.serviceName },
        ),
      );
      return;
    }

    // Strict Magic Bytes verification (JPEG, PNG, WebP ONLY)
    const detected = detectImageMagicBytes(fileBuffer);
    if (!detected.valid) {
      res.status(400).json(
        createApiErrorResponse(
          ErrorCode.INVALID_MAGIC_BYTES,
          'Tệp minh chứng RMA không hợp lệ: chữ ký nhị phân (Magic Bytes) không khớp JPEG, PNG hoặc WebP thực.',
          { reason: 'INVALID_MAGIC_BYTES' },
          { correlationId, service: this.config.serviceName },
        ),
      );
      return;
    }

    const baseSafe = fileName
      .replace(/\.[^.]+$/, '')
      .replace(/[^a-zA-Z0-9_-]+/g, '_')
      .slice(0, 64);
    const normalizedFileName = `rma-evidence-${baseSafe || crypto.randomUUID().slice(0, 8)}.${detected.ext}`;

    const upstream = await this.proxy.request({
      method: 'POST',
      url: `${this.config.upstreams.mediaPipelineUrl}/v1/media/upload`,
      req,
      body: {
        assetType: 'LOOKBOOK_PHOTO',
        fileName: normalizedFileName,
        mimeType: detected.mimeType,
        fileBase64: fileBuffer.toString('base64'),
      },
      contentType: 'application/json',
      correlationId,
      timeoutMs: 30_000,
      extraHeaders,
    });

    if (!upstream.ok) {
      this.proxy.sendProxyResponse(res, upstream, (payload) =>
        stripStorefrontSensitiveFields(payload),
      );
      return;
    }

    const rawBody =
      upstream.body && typeof upstream.body === 'object' && !Array.isArray(upstream.body)
        ? (upstream.body as Record<string, unknown>)
        : {};
    const mediaAsset =
      rawBody.data && typeof rawBody.data === 'object' && !Array.isArray(rawBody.data)
        ? (rawBody.data as Record<string, unknown>)
        : rawBody;

    const bucketName =
      typeof mediaAsset.bucketName === 'string' && mediaAsset.bucketName.trim()
        ? mediaAsset.bucketName.trim()
        : 'atelier-public';
    const objectKey =
      typeof mediaAsset.originalKey === 'string' && mediaAsset.originalKey.trim()
        ? mediaAsset.originalKey.trim()
        : '';
    const variants =
      mediaAsset.variants && typeof mediaAsset.variants === 'object'
        ? (mediaAsset.variants as Record<string, unknown>)
        : {};
    const previewEntry = variants.preview_url ?? variants['720w'] ?? variants['480w'];
    const variantUrl =
      typeof previewEntry === 'string'
        ? previewEntry
        : previewEntry &&
            typeof previewEntry === 'object' &&
            typeof (previewEntry as Record<string, unknown>).url === 'string'
          ? String((previewEntry as Record<string, unknown>).url)
          : '';
    const resolvedUrl =
      (typeof mediaAsset.publicUrl === 'string' && mediaAsset.publicUrl.trim()) ||
      variantUrl ||
      (objectKey
        ? `${this.config.minioPublicUrl}/${encodeURIComponent(bucketName)}/${objectKey
            .split('/')
            .map((seg) => encodeURIComponent(seg))
            .join('/')}`
        : '');

    res.status(200).json(
      createApiResponse(
        {
          url: resolvedUrl,
          publicUrl: resolvedUrl,
          objectKey,
          assetId: typeof mediaAsset.id === 'string' ? mediaAsset.id : null,
          mimeType: detected.mimeType,
          sizeBytes: fileBuffer.length,
        },
        {
          correlationId,
          service: this.config.serviceName,
        },
      ),
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
      url: `${this.config.paymentPromoServiceUrl}/v1/promotions?status=ACTIVE`,
      req,
      extraHeaders,
    });
    res.setHeader('Cache-Control', 'no-store');
    this.proxy.sendProxyResponse(res, upstream, (payload) =>
      sanitizeActivePromotionsEnvelope(payload),
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

  @Get('payments/sepay/status/:orderCode')
  async getSePayOrderStatus(
    @Param('orderCode') orderCode: string,
    @Req() req: AuthenticatedRequest,
    @Res() res: Response,
  ): Promise<void> {
    const extraHeaders = await this.resolveCallerHeaders(req);
    const upstream = await this.proxy.request({
      method: 'GET',
      url: `${this.config.paymentPromoServiceUrl}/v1/payments/sepay/status/${encodeURIComponent(orderCode)}`,
      req,
      extraHeaders,
      timeoutMs: 20_000,
    });
    res.setHeader('Cache-Control', 'no-store');
    this.proxy.sendProxyResponse(res, upstream, (payload) =>
      stripStorefrontSensitiveFields(payload),
    );
  }

  @Post('payments/sepay/simulate')
  @HttpCode(HttpStatus.OK)
  async simulateSePayPayment(
    @Body() body: unknown,
    @Req() req: AuthenticatedRequest,
    @Res() res: Response,
  ): Promise<void> {
    const extraHeaders = await this.resolveCallerHeaders(req);
    const upstream = await this.proxy.request({
      method: 'POST',
      url: `${this.config.paymentPromoServiceUrl}/v1/payments/sepay/simulate`,
      req,
      body: body ?? {},
      extraHeaders,
      timeoutMs: 20_000,
    });
    res.setHeader('Cache-Control', 'no-store');
    this.proxy.sendProxyResponse(res, upstream, (payload) =>
      stripStorefrontSensitiveFields(payload),
    );
  }

  // ============================================================================
  // Payment Gateway Return Verification & Provider Webhooks (payment-promo:4007)
  // ============================================================================

  @Get('payments/return')
  async verifyPaymentReturn(
    @Req() req: AuthenticatedRequest,
    @Res() res: Response,
  ): Promise<void> {
    const extraHeaders = await this.resolveCallerHeaders(req);
    const rawQs = extractRawQueryString(req);
    const upstream = await this.proxy.request({
      method: 'GET',
      url: `${this.config.paymentPromoServiceUrl}/v1/payments/return${rawQs}`,
      req,
      extraHeaders,
      timeoutMs: 20_000,
    });
    res.setHeader('Cache-Control', 'no-store');
    this.proxy.sendProxyResponse(res, upstream, (payload) =>
      stripStorefrontSensitiveFields(payload),
    );
  }

  @Get('payments/webhooks/:provider')
  async storefrontPaymentWebhookGet(
    @Param('provider') provider: string,
    @Req() req: AuthenticatedRequest,
    @Res() res: Response,
  ): Promise<void> {
    const correlationId = getOrCreateCorrelationId(req.headers as HeaderBag);
    const clientIp = this.proxy.extractClientIp(req);
    const rawQs = extractRawQueryString(req);
    const upstream = await this.proxy.request({
      method: 'GET',
      url: `${this.config.paymentPromoServiceUrl}/v1/payments/webhooks/${encodeURIComponent(provider)}${rawQs}`,
      req,
      correlationId,
      extraHeaders: extractWebhookForwardHeaders(req, correlationId, clientIp),
      timeoutMs: 20_000,
    });
    res.setHeader('Cache-Control', 'no-store');
    this.proxy.sendProxyResponse(res, upstream);
  }

  @Post('payments/webhooks/:provider')
  @HttpCode(HttpStatus.OK)
  async storefrontPaymentWebhookPost(
    @Param('provider') provider: string,
    @Req() req: AuthenticatedRequest,
    @Res() res: Response,
  ): Promise<void> {
    const correlationId = getOrCreateCorrelationId(req.headers as HeaderBag);
    const clientIp = this.proxy.extractClientIp(req);
    const rawQs = extractRawQueryString(req);
    const payload = await resolveWebhookRawBody(
      req as AuthenticatedRequest & { rawBody?: Buffer },
    );
    const upstream = await this.proxy.request({
      method: 'POST',
      url: `${this.config.paymentPromoServiceUrl}/v1/payments/webhooks/${encodeURIComponent(provider)}${rawQs}`,
      req,
      rawBody: payload.rawBody,
      body: payload.body,
      contentType: payload.contentType,
      correlationId,
      extraHeaders: extractWebhookForwardHeaders(req, correlationId, clientIp),
      timeoutMs: 20_000,
    });
    res.setHeader('Cache-Control', 'no-store');
    this.proxy.sendProxyResponse(res, upstream);
  }

  // ============================================================================
  // Live Shipping Fee & ETA Quotes (order-rma:4006 — GHN / GHTK / AhaMove)
  // ============================================================================

  @Post('shipping/quote')
  @HttpCode(HttpStatus.OK)
  async getShippingQuote(
    @Body() body: unknown,
    @Req() req: AuthenticatedRequest,
    @Res() res: Response,
  ): Promise<void> {
    const extraHeaders = await this.resolveCallerHeaders(req);
    const upstream = await this.proxy.request({
      method: 'POST',
      url: `${this.config.orderRmaServiceUrl}/v1/shipping/quote`,
      req,
      body: body ?? {},
      extraHeaders,
      timeoutMs: 12_000,
    });
    res.setHeader('Cache-Control', 'no-store');
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
