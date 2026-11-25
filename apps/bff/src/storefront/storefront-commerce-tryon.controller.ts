import { createHash } from 'node:crypto';
import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { JwtAccessPayload } from '@atelier/contracts';
import { getOrCreateCorrelationId, type HeaderBag } from '@atelier/observability';
import type { Response } from 'express';
import {
  collectRawRequestBody,
  HttpProxyService,
  type ProxyResponseResult,
} from '../common/http-proxy.service';
import {
  buildCanonicalQueryString,
  stripStorefrontSensitiveFields,
} from '../common/sanitize';
import { BFF_CONFIG_TOKEN, type BffConfig } from '../config/env';
import { CurrentUser, type AuthenticatedRequest } from '../security/auth-types';
import { JwtAuthGuard } from '../security/guards';
import { JwtVerifierService } from '../security/jwt-verifier.service';

type TryOnLightingPreset = 'morning' | 'atelier' | 'evening';
type TryOnSynthesizeProvider = 'local_preview' | 'fal' | 'fashn' | 'catvton';

const TRYON_SUPPORTED_PROVIDERS: readonly TryOnSynthesizeProvider[] = [
  'local_preview',
  'fal',
  'fashn',
  'catvton',
];
const TRYON_LIGHTING_PRESETS: ReadonlySet<TryOnLightingPreset> = new Set([
  'morning',
  'atelier',
  'evening',
]);
const TRYON_PRIVACY_TTL_SECONDS = 900;
const TRYON_SYNTHESIZE_TIMEOUT_MS = 15_000;
const TRYON_SIGNAL_TIMEOUT_MS = 5_000;

interface TryOnConversionSignalMetadata {
  productId: string;
  skuId?: string;
  variantId?: string;
  skuCode?: string;
  sizeCode?: string;
  sessionId?: string;
}

const TRYON_SLOT_TO_OUTFIT_SLOT: Record<string, string> = {
  upper: 'TOP',
  top: 'TOP',
  lower: 'BOTTOM',
  bottom: 'BOTTOM',
  onepiece: 'ONE_PIECE',
  one_piece: 'ONE_PIECE',
  outerwear: 'OUTERWEAR',
  accessory: 'ACCESSORY',
};

interface TryOnSynthesizeGarmentPayload {
  productId: string;
  variantId: string;
  slot: string;
  cleanGarmentUrl768x1024?: string;
  colorHex?: string;
}

interface TryOnSynthesizeRequestPayload {
  personFrameHash: string;
  lightingPreset: TryOnLightingPreset;
  poseLandmarks?: unknown[];
  garments: TryOnSynthesizeGarmentPayload[];
  personImageDataUrl?: string;
}

interface TryOnSynthesizeResponsePayload {
  success: true;
  status: string;
  provider: TryOnSynthesizeProvider;
  stage2Ready: true;
  supportedProviders: readonly TryOnSynthesizeProvider[];
  cacheKey: string;
  privacyTtlSeconds: number;
  resultImageUrl: string | null;
}

@Controller(['bff/v1/storefront', 'bff/v1'])
export class StorefrontCommerceTryOnController {
  constructor(
    @Inject(BFF_CONFIG_TOKEN) private readonly config: BffConfig,
    @Inject(HttpProxyService) private readonly proxy: HttpProxyService,
    @Inject(JwtVerifierService) private readonly jwtVerifier: JwtVerifierService,
  ) {}

  // ============================================================================
  // Inventory Availability (proxied to inventory:4004)
  // ============================================================================

  @Post('inventory/batch-availability')
  async batchAvailability(
    @Body() body: unknown,
    @Req() req: AuthenticatedRequest,
    @Res() res: Response,
  ): Promise<void> {
    const extraHeaders = await this.resolveCallerHeaders(req);
    const upstream = await this.proxy.request({
      method: 'POST',
      url: `${this.config.inventoryServiceUrl}/v1/inventory/availability/batch`,
      req,
      body,
      extraHeaders,
    });
    this.proxy.sendProxyResponse(res, upstream, (payload) =>
      stripStorefrontSensitiveFields(payload),
    );
  }

  // ============================================================================
  // Cart & Mix-Match Outfit Studio (proxied to cart-outfit:4005)
  // ============================================================================

  @Get('cart')
  async getCart(
    @Req() req: AuthenticatedRequest,
    @Res() res: Response,
  ): Promise<void> {
    const extraHeaders = await this.resolveCallerHeaders(req);
    const upstream = await this.proxy.request({
      method: 'GET',
      url: `${this.config.cartOutfitServiceUrl}/v1/cart`,
      req,
      extraHeaders,
    });
    this.proxy.sendProxyResponse(res, upstream, (payload) =>
      stripStorefrontSensitiveFields(payload),
    );
  }

  @Post('cart/items')
  async addCartItem(
    @Body() body: unknown,
    @Req() req: AuthenticatedRequest,
    @Res() res: Response,
  ): Promise<void> {
    const extraHeaders = await this.resolveCallerHeaders(req);
    const normalizedBody = this.normalizeCartItemBody(body);
    const upstream = await this.proxy.request({
      method: 'POST',
      url: `${this.config.cartOutfitServiceUrl}/v1/cart/items`,
      req,
      body: normalizedBody,
      extraHeaders,
    });
    if (upstream.ok) {
      const signals = this.extractTryOnConversionSignals(
        body,
        upstream.body,
        false,
      );
      if (signals.length > 0) {
        this.fireTryOnConversionSignals(signals, req, extraHeaders);
      }
    }
    this.proxy.sendProxyResponse(res, upstream, (payload) =>
      stripStorefrontSensitiveFields(payload),
    );
  }

  @Post('cart/outfit-bundle')
  async addOutfitBundle(
    @Body() body: unknown,
    @Req() req: AuthenticatedRequest,
    @Res() res: Response,
  ): Promise<void> {
    const extraHeaders = await this.resolveCallerHeaders(req);
    const normalizedBody = this.normalizeOutfitBundleBody(body);
    const upstream = await this.proxy.request({
      method: 'POST',
      url: `${this.config.cartOutfitServiceUrl}/v1/cart/outfit-bundle`,
      req,
      body: normalizedBody,
      extraHeaders,
    });
    if (upstream.ok) {
      const signals = this.extractTryOnConversionSignals(
        body,
        upstream.body,
        true,
      );
      if (signals.length > 0) {
        this.fireTryOnConversionSignals(signals, req, extraHeaders);
      }
    }
    this.proxy.sendProxyResponse(res, upstream, (payload) =>
      stripStorefrontSensitiveFields(payload),
    );
  }

  @Patch('cart/items/:itemId')
  async updateCartItem(
    @Param('itemId') itemId: string,
    @Body() body: unknown,
    @Req() req: AuthenticatedRequest,
    @Res() res: Response,
  ): Promise<void> {
    const extraHeaders = await this.resolveCallerHeaders(req);
    const upstream = await this.proxy.request({
      method: 'PATCH',
      url: `${this.config.cartOutfitServiceUrl}/v1/cart/items/${encodeURIComponent(itemId)}`,
      req,
      body,
      extraHeaders,
    });
    this.proxy.sendProxyResponse(res, upstream, (payload) =>
      stripStorefrontSensitiveFields(payload),
    );
  }

  @Delete('cart/items/:itemId')
  async deleteCartItem(
    @Param('itemId') itemId: string,
    @Req() req: AuthenticatedRequest,
    @Res() res: Response,
  ): Promise<void> {
    const extraHeaders = await this.resolveCallerHeaders(req);
    const upstream = await this.proxy.request({
      method: 'DELETE',
      url: `${this.config.cartOutfitServiceUrl}/v1/cart/items/${encodeURIComponent(itemId)}`,
      req,
      extraHeaders,
    });
    this.proxy.sendProxyResponse(res, upstream, (payload) =>
      stripStorefrontSensitiveFields(payload),
    );
  }

  @Put('cart/packaging')
  async updateCartPackaging(
    @Body() body: unknown,
    @Req() req: AuthenticatedRequest,
    @Res() res: Response,
  ): Promise<void> {
    const extraHeaders = await this.resolveCallerHeaders(req);
    const upstream = await this.proxy.request({
      method: 'PUT',
      url: `${this.config.cartOutfitServiceUrl}/v1/cart/packaging`,
      req,
      body,
      extraHeaders,
    });
    this.proxy.sendProxyResponse(res, upstream, (payload) =>
      stripStorefrontSensitiveFields(payload),
    );
  }

  @Post('cart/merge')
  @UseGuards(JwtAuthGuard)
  async mergeCart(
    @Body() body: unknown,
    @Req() req: AuthenticatedRequest,
    @Res() res: Response,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<void> {
    const guestFromHeader = this.extractGuestSessionId(req);
    const guestFromBody =
      body && typeof body === 'object' && typeof (body as Record<string, unknown>).guestSessionId === 'string'
        ? ((body as Record<string, unknown>).guestSessionId as string).trim()
        : undefined;
    const guestSessionId = guestFromBody || guestFromHeader;

    const upstream = await this.proxy.request({
      method: 'POST',
      url: `${this.config.cartOutfitServiceUrl}/v1/cart/merge`,
      req,
      body:
        body && typeof body === 'object'
          ? { ...(body as Record<string, unknown>), ...(guestSessionId ? { guestSessionId } : {}) }
          : guestSessionId
            ? { guestSessionId }
            : {},
      extraHeaders: {
        'x-user-id': user.sub,
        'x-loyalty-tier': user.loyaltyTier,
        ...(guestSessionId ? { 'x-guest-session-id': guestSessionId } : {}),
        'x-client-ip': this.proxy.extractClientIp(req),
      },
    });
    this.proxy.sendProxyResponse(res, upstream, (payload) =>
      stripStorefrontSensitiveFields(payload),
    );
  }

  @Post('outfit-studio/preview')
  async previewOutfitStudio(
    @Body() body: unknown,
    @Req() req: AuthenticatedRequest,
    @Res() res: Response,
  ): Promise<void> {
    await this.forwardOutfitPreview(body, req, res);
  }

  @Post('outfits/preview')
  async previewOutfitAlias(
    @Body() body: unknown,
    @Req() req: AuthenticatedRequest,
    @Res() res: Response,
  ): Promise<void> {
    await this.forwardOutfitPreview(body, req, res);
  }

  @Post('outfits')
  async createSavedOutfit(
    @Body() body: unknown,
    @Req() req: AuthenticatedRequest,
    @Res() res: Response,
  ): Promise<void> {
    const extraHeaders = await this.resolveCallerHeaders(req);
    const upstream = await this.proxy.request({
      method: 'POST',
      url: `${this.config.cartOutfitServiceUrl}/v1/outfits`,
      req,
      body,
      extraHeaders,
    });
    this.proxy.sendProxyResponse(res, upstream, (payload) =>
      stripStorefrontSensitiveFields(payload),
    );
  }

  @Get('outfits/share/:shareCode')
  async getSharedOutfit(
    @Param('shareCode') shareCode: string,
    @Req() req: AuthenticatedRequest,
    @Res() res: Response,
  ): Promise<void> {
    const extraHeaders = await this.resolveCallerHeaders(req);
    const upstream = await this.proxy.request({
      method: 'GET',
      url: `${this.config.cartOutfitServiceUrl}/v1/outfits/share/${encodeURIComponent(shareCode)}`,
      req,
      extraHeaders,
    });
    this.proxy.sendProxyResponse(res, upstream, (payload) =>
      stripStorefrontSensitiveFields(payload),
    );
  }

  @Get('outfits/me')
  async listMyOutfits(
    @Req() req: AuthenticatedRequest,
    @Res() res: Response,
  ): Promise<void> {
    const extraHeaders = await this.resolveCallerHeaders(req);
    const upstream = await this.proxy.request({
      method: 'GET',
      url: `${this.config.cartOutfitServiceUrl}/v1/outfits/me`,
      req,
      extraHeaders,
    });
    this.proxy.sendProxyResponse(res, upstream, (payload) =>
      stripStorefrontSensitiveFields(payload),
    );
  }

  // ============================================================================
  // AI Virtual Try-On (proxied to ai-tryon:4009 & Stage-2 VTON synthesis contract)
  // ============================================================================

  @Post('tryon/synthesize')
  async synthesizeTryOn(
    @Body() body: unknown,
    @Req() req: AuthenticatedRequest,
    @Res() res: Response,
  ): Promise<void> {
    await this.forwardTryOnSynthesize(body, req, res);
  }

  @Post('tryon/jobs')
  async createTryOnJob(
    @Body() body: unknown,
    @Req() req: AuthenticatedRequest,
    @Res() res: Response,
  ): Promise<void> {
    await this.forwardTryOnSynthesize(body, req, res);
  }

  @Get('tryon/jobs/:jobId')
  async getTryOnJob(
    @Param('jobId') jobId: string,
    @Req() req: AuthenticatedRequest,
    @Res() res: Response,
  ): Promise<void> {
    const extraHeaders = await this.resolveCallerHeaders(req);
    const upstream = await this.proxy.request({
      method: 'GET',
      url: `${this.config.aiTryonServiceUrl}/v1/tryon/jobs/${encodeURIComponent(jobId)}`,
      req,
      extraHeaders,
      timeoutMs: TRYON_SYNTHESIZE_TIMEOUT_MS,
    });
    this.proxy.sendProxyResponse(res, upstream);
  }

  @Post('tryon/jobs/:jobId/cancel')
  async cancelTryOnJob(
    @Param('jobId') jobId: string,
    @Body() body: unknown,
    @Req() req: AuthenticatedRequest,
    @Res() res: Response,
  ): Promise<void> {
    const extraHeaders = await this.resolveCallerHeaders(req);
    const upstream = await this.proxy.request({
      method: 'POST',
      url: `${this.config.aiTryonServiceUrl}/v1/tryon/jobs/${encodeURIComponent(jobId)}/cancel`,
      req,
      body: body ?? {},
      extraHeaders,
      timeoutMs: TRYON_SYNTHESIZE_TIMEOUT_MS,
    });
    this.proxy.sendProxyResponse(res, upstream);
  }

  @Post('tryon/upload-url')
  async createTryOnUploadUrl(
    @Body() body: unknown,
    @Req() req: AuthenticatedRequest,
    @Res() res: Response,
  ): Promise<void> {
    const extraHeaders = await this.resolveCallerHeaders(req);
    const upstream = await this.proxy.request({
      method: 'POST',
      url: `${this.config.aiTryonServiceUrl}/v1/tryon/upload-url`,
      req,
      body,
      extraHeaders,
      timeoutMs: TRYON_SYNTHESIZE_TIMEOUT_MS,
    });
    this.proxy.sendProxyResponse(res, upstream);
  }

  @Post('tryon/upload')
  async uploadTryOnImage(
    @Req() req: AuthenticatedRequest,
    @Res() res: Response,
  ): Promise<void> {
    const extraHeaders = await this.resolveCallerHeaders(req);
    const contentType = req.headers['content-type'] ?? 'application/json';
    const lowerContentType = contentType.toLowerCase();
    const isRawUpload =
      lowerContentType.includes('multipart/form-data') ||
      lowerContentType.startsWith('image/') ||
      lowerContentType.includes('application/octet-stream');

    if (isRawUpload) {
      let rawBody: Buffer;
      try {
        rawBody = await collectRawRequestBody(req);
      } catch (error) {
        res.status(413).json({
          success: false,
          data: null,
          error: {
            code: 'PAYLOAD_TOO_LARGE',
            message:
              error instanceof Error
                ? error.message
                : 'Uploaded try-on image exceeds maximum allowed size.',
          },
        });
        return;
      }

      const upstream = await this.proxy.request({
        method: 'POST',
        url: `${this.config.aiTryonServiceUrl}/v1/tryon/upload`,
        req,
        rawBody,
        contentType,
        extraHeaders,
        timeoutMs: TRYON_SYNTHESIZE_TIMEOUT_MS,
      });
      this.proxy.sendProxyResponse(res, upstream);
      return;
    }

    const upstream = await this.proxy.request({
      method: 'POST',
      url: `${this.config.aiTryonServiceUrl}/v1/tryon/upload`,
      req,
      body: req.body,
      contentType: 'application/json',
      extraHeaders,
      timeoutMs: TRYON_SYNTHESIZE_TIMEOUT_MS,
    });
    this.proxy.sendProxyResponse(res, upstream);
  }

  @Post('tryon/sessions')
  async createTryOnSession(
    @Body() body: unknown,
    @Req() req: AuthenticatedRequest,
    @Res() res: Response,
  ): Promise<void> {
    const extraHeaders = await this.resolveCallerHeaders(req);
    const upstream = await this.proxy.request({
      method: 'POST',
      url: `${this.config.aiTryonServiceUrl}/v1/tryon/sessions`,
      req,
      body,
      extraHeaders,
      timeoutMs: 30_000,
    });
    this.proxy.sendProxyResponse(res, upstream);
  }

  @Get('tryon/sessions/:sessionId')
  async getTryOnSession(
    @Param('sessionId') sessionId: string,
    @Req() req: AuthenticatedRequest,
    @Res() res: Response,
  ): Promise<void> {
    const extraHeaders = await this.resolveCallerHeaders(req);
    const upstream = await this.proxy.request({
      method: 'GET',
      url: `${this.config.aiTryonServiceUrl}/v1/tryon/sessions/${encodeURIComponent(sessionId)}`,
      req,
      extraHeaders,
    });
    this.proxy.sendProxyResponse(res, upstream);
  }

  @Get('tryon/quota')
  async getTryOnQuota(
    @Req() req: AuthenticatedRequest,
    @Res() res: Response,
  ): Promise<void> {
    const extraHeaders = await this.resolveCallerHeaders(req);
    const upstream = await this.proxy.request({
      method: 'GET',
      url: `${this.config.aiTryonServiceUrl}/v1/tryon/quota`,
      req,
      extraHeaders,
    });
    this.proxy.sendProxyResponse(res, upstream);
  }

  @Get('tryon/bookmarks')
  async listTryOnBookmarks(
    @Req() req: AuthenticatedRequest,
    @Res() res: Response,
  ): Promise<void> {
    const extraHeaders = await this.resolveCallerHeaders(req);
    const upstream = await this.proxy.request({
      method: 'GET',
      url: `${this.config.aiTryonServiceUrl}/v1/tryon/bookmarks`,
      req,
      extraHeaders,
    });
    this.proxy.sendProxyResponse(res, upstream);
  }

  @Post('tryon/bookmarks')
  async createTryOnBookmark(
    @Body() body: unknown,
    @Req() req: AuthenticatedRequest,
    @Res() res: Response,
  ): Promise<void> {
    const extraHeaders = await this.resolveCallerHeaders(req);
    const upstream = await this.proxy.request({
      method: 'POST',
      url: `${this.config.aiTryonServiceUrl}/v1/tryon/bookmarks`,
      req,
      body,
      extraHeaders,
    });
    this.proxy.sendProxyResponse(res, upstream);
  }

  @Delete('tryon/bookmarks/:id')
  async deleteTryOnBookmark(
    @Param('id') id: string,
    @Req() req: AuthenticatedRequest,
    @Res() res: Response,
  ): Promise<void> {
    const extraHeaders = await this.resolveCallerHeaders(req);
    const upstream = await this.proxy.request({
      method: 'DELETE',
      url: `${this.config.aiTryonServiceUrl}/v1/tryon/bookmarks/${encodeURIComponent(id)}`,
      req,
      extraHeaders,
    });
    this.proxy.sendProxyResponse(res, upstream);
  }

  @Post('tryon/signals')
  async createTryOnSignal(
    @Body() body: unknown,
    @Req() req: AuthenticatedRequest,
    @Res() res: Response,
  ): Promise<void> {
    const extraHeaders = await this.resolveCallerHeaders(req);
    const upstream = await this.proxy.request({
      method: 'POST',
      url: `${this.config.aiTryonServiceUrl}/v1/tryon/signals`,
      req,
      body,
      extraHeaders,
    });
    this.proxy.sendProxyResponse(res, upstream);
  }

  @Get('tryon/signals')
  async listTryOnSignals(
    @Query() query: Record<string, unknown>,
    @Req() req: AuthenticatedRequest,
    @Res() res: Response,
  ): Promise<void> {
    const extraHeaders = await this.resolveCallerHeaders(req);
    const qs = buildCanonicalQueryString(query);
    const upstream = await this.proxy.request({
      method: 'GET',
      url: `${this.config.aiTryonServiceUrl}/v1/tryon/signals${qs ? `?${qs}` : ''}`,
      req,
      extraHeaders,
    });
    this.proxy.sendProxyResponse(res, upstream);
  }

  private async forwardOutfitPreview(
    body: unknown,
    req: AuthenticatedRequest,
    res: Response,
  ): Promise<void> {
    const extraHeaders = await this.resolveCallerHeaders(req);
    const upstream = await this.proxy.request({
      method: 'POST',
      url: `${this.config.cartOutfitServiceUrl}/v1/outfits/preview`,
      req,
      body,
      extraHeaders,
    });
    this.proxy.sendProxyResponse(res, upstream, (payload) =>
      stripStorefrontSensitiveFields(payload),
    );
  }

  private async forwardTryOnSynthesize(
    body: unknown,
    req: AuthenticatedRequest,
    res: Response,
  ): Promise<void> {
    const normalizedForFallback = this.normalizeSynthesizeRequest(body);
    const fallbackCacheKey = this.computeSynthesizeCacheKey(normalizedForFallback);
    const forwardBody = this.prepareTryOnSynthesizeBody(body);
    const extraHeaders = await this.resolveCallerHeaders(req);

    const upstream = await this.proxy.request({
      method: 'POST',
      url: `${this.config.aiTryonServiceUrl}/v1/tryon/synthesize`,
      req,
      body: forwardBody,
      extraHeaders,
      timeoutMs: TRYON_SYNTHESIZE_TIMEOUT_MS,
    });

    if (this.isUpstreamUnreachable(upstream)) {
      res.setHeader('X-Cache-Key', fallbackCacheKey);
      res
        .status(200)
        .json(this.buildLocalPreviewSynthesizeResponse(fallbackCacheKey));
      return;
    }

    const upstreamCacheKey = this.extractUpstreamCacheKey(upstream.body);
    res.setHeader('X-Cache-Key', upstreamCacheKey ?? fallbackCacheKey);
    this.proxy.sendProxyResponse(res, upstream);
  }

  private prepareTryOnSynthesizeBody(raw: unknown): unknown {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return raw;
    }

    const input = raw as Record<string, unknown>;
    const prepared: Record<string, unknown> = { ...input };

    // Preserve all caller fields verbatim (including privacyConsent, mode, personObjectKey, poseLandmarks, etc.)
    // while bridging legacy alias keys non-destructively.
    if (
      prepared.personImageDataUrl === undefined &&
      typeof input.personImageBase64 === 'string' &&
      input.personImageBase64.trim().length > 0
    ) {
      prepared.personImageDataUrl = input.personImageBase64.trim();
    }

    if (Array.isArray(input.garments)) {
      prepared.garments = input.garments.map((item) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
          return item;
        }
        const record = item as Record<string, unknown>;
        const garmentCopy: Record<string, unknown> = { ...record };
        const hasGarmentImageUrl =
          typeof record.garmentImageUrl === 'string' &&
          record.garmentImageUrl.trim().length > 0;
        const hasCleanUrl =
          typeof record.cleanGarmentUrl768x1024 === 'string' &&
          record.cleanGarmentUrl768x1024.trim().length > 0;

        if (!hasGarmentImageUrl && hasCleanUrl) {
          garmentCopy.garmentImageUrl = (
            record.cleanGarmentUrl768x1024 as string
          ).trim();
        } else if (!hasCleanUrl && hasGarmentImageUrl) {
          garmentCopy.cleanGarmentUrl768x1024 = (
            record.garmentImageUrl as string
          ).trim();
        }
        return garmentCopy;
      });
    }

    return prepared;
  }

  private extractUpstreamCacheKey(body: unknown): string | null {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return null;
    }
    const record = body as Record<string, unknown>;
    if (typeof record.cacheKey === 'string' && record.cacheKey.trim().length > 0) {
      return record.cacheKey.trim();
    }
    if (
      record.data &&
      typeof record.data === 'object' &&
      !Array.isArray(record.data)
    ) {
      const dataRecord = record.data as Record<string, unknown>;
      if (
        typeof dataRecord.cacheKey === 'string' &&
        dataRecord.cacheKey.trim().length > 0
      ) {
        return dataRecord.cacheKey.trim();
      }
    }
    return null;
  }

  private isUpstreamUnreachable(upstream: ProxyResponseResult): boolean {
    if (
      upstream.status !== 503 ||
      !upstream.body ||
      typeof upstream.body !== 'object' ||
      Array.isArray(upstream.body)
    ) {
      return false;
    }
    const record = upstream.body as Record<string, unknown>;
    const err =
      record.error && typeof record.error === 'object'
        ? (record.error as Record<string, unknown>)
        : undefined;
    const meta =
      record.meta && typeof record.meta === 'object'
        ? (record.meta as Record<string, unknown>)
        : undefined;
    return (
      err?.code === 'DEPENDENCY_UNAVAILABLE' &&
      meta?.service === this.config.serviceName
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
      'x-loyalty-tier': user?.loyaltyTier,
      'x-guest-session-id': guestSessionId,
      'x-client-ip': clientIp,
      'x-forwarded-for': clientIp,
      'x-correlation-id': correlationId,
    };
  }

  private hasExplicitTryOnFlag(record: Record<string, unknown>): boolean {
    return (
      record.fromAiTryOn === true ||
      record.tuPhongThuDoAi === true ||
      record.fromAiTryon === true
    );
  }

  private readNonEmptyString(
    record: Record<string, unknown>,
    ...keys: readonly string[]
  ): string | undefined {
    for (const key of keys) {
      const value = record[key];
      if (typeof value === 'string' && value.trim().length > 0) {
        return value.trim();
      }
    }
    return undefined;
  }

  private indexCartItemsBySku(
    cartResponseBody: unknown,
  ): Map<string, Record<string, unknown>> {
    const map = new Map<string, Record<string, unknown>>();
    if (
      !cartResponseBody ||
      typeof cartResponseBody !== 'object' ||
      Array.isArray(cartResponseBody)
    ) {
      return map;
    }

    const root = cartResponseBody as Record<string, unknown>;
    const payload =
      root.data && typeof root.data === 'object' && !Array.isArray(root.data)
        ? (root.data as Record<string, unknown>)
        : root;

    if (!Array.isArray(payload.items)) {
      return map;
    }

    for (const rawItem of payload.items) {
      if (!rawItem || typeof rawItem !== 'object' || Array.isArray(rawItem)) {
        continue;
      }
      const item = rawItem as Record<string, unknown>;
      const skuId = this.readNonEmptyString(item, 'skuId');
      if (skuId) {
        map.set(skuId, item);
      }
    }
    return map;
  }

  private extractTryOnConversionSignals(
    rawBody: unknown,
    cartResponseBody: unknown,
    isBundle: boolean,
  ): TryOnConversionSignalMetadata[] {
    if (!rawBody || typeof rawBody !== 'object' || Array.isArray(rawBody)) {
      return [];
    }

    const input = rawBody as Record<string, unknown>;
    const cartBySku = this.indexCartItemsBySku(cartResponseBody);
    const topLevelSessionId = this.readNonEmptyString(
      input,
      'sessionId',
      'tryOnSessionId',
      'tryonSessionId',
    );
    const candidates: Record<string, unknown>[] = [];

    if (isBundle) {
      if (!Array.isArray(input.items)) {
        return [];
      }
      const bundleFlag = this.hasExplicitTryOnFlag(input);
      for (const rawItem of input.items) {
        if (!rawItem || typeof rawItem !== 'object' || Array.isArray(rawItem)) {
          continue;
        }
        const itemRecord = rawItem as Record<string, unknown>;
        if (bundleFlag || this.hasExplicitTryOnFlag(itemRecord)) {
          candidates.push(itemRecord);
        }
      }
    } else if (this.hasExplicitTryOnFlag(input)) {
      candidates.push(input);
    }

    const signals: TryOnConversionSignalMetadata[] = [];
    const seen = new Set<string>();

    for (const item of candidates) {
      const skuId = this.readNonEmptyString(item, 'skuId');
      const matchedCartItem = skuId ? cartBySku.get(skuId) : undefined;
      const variantId =
        this.readNonEmptyString(item, 'variantId') ??
        (matchedCartItem
          ? this.readNonEmptyString(matchedCartItem, 'variantId')
          : undefined);
      const productId =
        this.readNonEmptyString(item, 'productId') ??
        (matchedCartItem
          ? this.readNonEmptyString(matchedCartItem, 'productId')
          : undefined) ??
        variantId ??
        skuId;

      if (!productId) {
        continue;
      }

      const skuCode =
        this.readNonEmptyString(item, 'skuCode') ??
        (matchedCartItem
          ? this.readNonEmptyString(matchedCartItem, 'skuCode')
          : undefined);
      const sizeCode =
        this.readNonEmptyString(item, 'sizeCode') ??
        (matchedCartItem
          ? this.readNonEmptyString(matchedCartItem, 'sizeCode')
          : undefined);
      const sessionId =
        this.readNonEmptyString(
          item,
          'sessionId',
          'tryOnSessionId',
          'tryonSessionId',
        ) ?? topLevelSessionId;

      const dedupeKey = `${productId}|${skuId ?? ''}|${variantId ?? ''}`;
      if (seen.has(dedupeKey)) {
        continue;
      }
      seen.add(dedupeKey);

      signals.push({
        productId,
        ...(skuId ? { skuId } : {}),
        ...(variantId ? { variantId } : {}),
        ...(skuCode ? { skuCode } : {}),
        ...(sizeCode ? { sizeCode } : {}),
        ...(sessionId ? { sessionId } : {}),
      });
    }

    return signals;
  }

  private fireTryOnConversionSignals(
    signals: readonly TryOnConversionSignalMetadata[],
    req: AuthenticatedRequest,
    extraHeaders: Record<string, string | undefined>,
  ): void {
    // Strictly non-blocking fire-and-forget anonymous metadata telemetry (zero personal image!)
    void Promise.allSettled(
      signals.map(async (signal) => {
        const anonymousPayload: Record<string, unknown> = {
          productId: signal.productId,
          ...(signal.skuId ? { skuId: signal.skuId } : {}),
          ...(signal.variantId ? { variantId: signal.variantId } : {}),
          ...(signal.skuCode ? { skuCode: signal.skuCode } : {}),
          ...(signal.sizeCode ? { sizeCode: signal.sizeCode } : {}),
          ...(signal.sessionId ? { sessionId: signal.sessionId } : {}),
        };

        const primaryRes = await this.proxy.request({
          method: 'POST',
          url: `${this.config.aiTryonServiceUrl}/v1/tryon/signals`,
          req,
          body: {
            ...anonymousPayload,
            eventType: 'THEM_GIO_SAU_THU',
          },
          extraHeaders,
          timeoutMs: TRYON_SIGNAL_TIMEOUT_MS,
        });

        if (
          !primaryRes.ok &&
          (primaryRes.status === 400 || primaryRes.status === 422)
        ) {
          await this.proxy.request({
            method: 'POST',
            url: `${this.config.aiTryonServiceUrl}/v1/tryon/signals`,
            req,
            body: {
              ...anonymousPayload,
              signalType: 'ADD_TO_CART_AFTER_TRYON',
              eventType: 'ADD_TO_CART_AFTER_TRYON',
            },
            extraHeaders,
            timeoutMs: TRYON_SIGNAL_TIMEOUT_MS,
          });
        }
      }),
    );
  }

  private normalizeCartItemBody(raw: unknown): unknown {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return raw;
    }

    const input = raw as Record<string, unknown>;
    const normalized: Record<string, unknown> = { ...input };

    // Map optional Try-On attribution aliases (`fromAiTryOn`, `tuPhongThuDoAi`) to canonical `fromAiTryon`
    // and strip non-canonical alias keys so downstream cart validation never rejects with HTTP 400.
    const hasTryOnFlag =
      'fromAiTryon' in input ||
      'fromAiTryOn' in input ||
      'tuPhongThuDoAi' in input;
    if (hasTryOnFlag) {
      normalized.fromAiTryon =
        Boolean(input.fromAiTryon) ||
        Boolean(input.fromAiTryOn) ||
        Boolean(input.tuPhongThuDoAi);
    }
    delete normalized.fromAiTryOn;
    delete normalized.tuPhongThuDoAi;

    // Normalize optional `quantity` alias to canonical `qty`
    if (normalized.qty === undefined && input.quantity !== undefined) {
      const parsedQty =
        typeof input.quantity === 'number'
          ? input.quantity
          : Number.parseInt(String(input.quantity), 10);
      if (Number.isInteger(parsedQty) && parsedQty >= 1 && parsedQty <= 99) {
        normalized.qty = parsedQty;
      }
    }
    delete normalized.quantity;

    // Map Try-On garment slot aliases (`upper`, `lower`, `onePiece`, `outerwear`) to canonical `OutfitSlot`
    if (typeof input.slot === 'string') {
      const mappedSlot = TRYON_SLOT_TO_OUTFIT_SLOT[input.slot.trim().toLowerCase()];
      if (mappedSlot) {
        normalized.slot = mappedSlot;
      }
    }

    return normalized;
  }

  private normalizeOutfitBundleBody(raw: unknown): unknown {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return raw;
    }

    const input = raw as Record<string, unknown>;
    if (!Array.isArray(input.items)) {
      return raw;
    }

    const topLevelTryOn = this.hasExplicitTryOnFlag(input);
    const normalized: Record<string, unknown> = {
      ...input,
      items: input.items.map((item) => {
        if (
          topLevelTryOn &&
          item &&
          typeof item === 'object' &&
          !Array.isArray(item)
        ) {
          return this.normalizeCartItemBody({
            ...(item as Record<string, unknown>),
            fromAiTryon: true,
          });
        }
        return this.normalizeCartItemBody(item);
      }),
    };
    delete normalized.fromAiTryOn;
    delete normalized.tuPhongThuDoAi;
    delete normalized.fromAiTryon;

    return normalized;
  }

  private normalizeSynthesizeRequest(raw: unknown): TryOnSynthesizeRequestPayload {
    const body =
      raw && typeof raw === 'object' && !Array.isArray(raw)
        ? (raw as Record<string, unknown>)
        : {};

    const personFrameHash =
      typeof body.personFrameHash === 'string' &&
      body.personFrameHash.trim().length > 0
        ? body.personFrameHash.trim()
        : 'anonymous';

    const rawPreset =
      typeof body.lightingPreset === 'string'
        ? body.lightingPreset.trim().toLowerCase()
        : 'atelier';
    const lightingPreset: TryOnLightingPreset = TRYON_LIGHTING_PRESETS.has(
      rawPreset as TryOnLightingPreset,
    )
      ? (rawPreset as TryOnLightingPreset)
      : 'atelier';

    const poseLandmarks = Array.isArray(body.poseLandmarks)
      ? body.poseLandmarks
      : undefined;

    const rawGarments = Array.isArray(body.garments) ? body.garments : [];
    const garments: TryOnSynthesizeGarmentPayload[] = rawGarments
      .filter(
        (item): item is Record<string, unknown> =>
          Boolean(item) && typeof item === 'object' && !Array.isArray(item),
      )
      .map((item) => {
        const cleanUrl =
          typeof item.cleanGarmentUrl768x1024 === 'string' &&
          item.cleanGarmentUrl768x1024.trim().length > 0
            ? item.cleanGarmentUrl768x1024.trim()
            : typeof item.garmentImageUrl === 'string' &&
                item.garmentImageUrl.trim().length > 0
              ? item.garmentImageUrl.trim()
              : undefined;
        const colorHex =
          typeof item.colorHex === 'string' && item.colorHex.trim().length > 0
            ? item.colorHex.trim()
            : undefined;

        return {
          productId:
            typeof item.productId === 'string' ? item.productId.trim() : '',
          variantId:
            typeof item.variantId === 'string' ? item.variantId.trim() : '',
          slot: typeof item.slot === 'string' ? item.slot.trim() : 'upper',
          ...(cleanUrl ? { cleanGarmentUrl768x1024: cleanUrl } : {}),
          ...(colorHex ? { colorHex } : {}),
        };
      });

    const personImageDataUrl =
      typeof body.personImageDataUrl === 'string' &&
      body.personImageDataUrl.trim().length > 0
        ? body.personImageDataUrl.trim()
        : typeof body.personImageBase64 === 'string' &&
            body.personImageBase64.trim().length > 0
          ? body.personImageBase64.trim()
          : undefined;

    return {
      personFrameHash,
      lightingPreset,
      ...(poseLandmarks ? { poseLandmarks } : {}),
      garments,
      ...(personImageDataUrl ? { personImageDataUrl } : {}),
    };
  }

  private computeSynthesizeCacheKey(
    payload: TryOnSynthesizeRequestPayload,
  ): string {
    const sortedGarments = payload.garments
      .map((item) => ({
        productId: item.productId,
        variantId: item.variantId,
        slot: item.slot.toLowerCase(),
        cleanGarmentUrl768x1024: item.cleanGarmentUrl768x1024 ?? '',
        colorHex: (item.colorHex ?? '').toLowerCase(),
      }))
      .sort((a, b) =>
        `${a.slot}|${a.productId}|${a.variantId}|${a.colorHex}|${a.cleanGarmentUrl768x1024}`.localeCompare(
          `${b.slot}|${b.productId}|${b.variantId}|${b.colorHex}|${b.cleanGarmentUrl768x1024}`,
        ),
      );

    return createHash('sha256')
      .update(
        JSON.stringify({
          personFrameHash: payload.personFrameHash,
          garments: sortedGarments,
          lightingPreset: payload.lightingPreset,
        }),
      )
      .digest('hex');
  }

  private buildLocalPreviewSynthesizeResponse(
    cacheKey: string,
  ): TryOnSynthesizeResponsePayload {
    return {
      success: true,
      status: 'LOCAL_PREVIEW_READY',
      provider: 'local_preview',
      stage2Ready: true,
      supportedProviders: [...TRYON_SUPPORTED_PROVIDERS],
      cacheKey,
      privacyTtlSeconds: TRYON_PRIVACY_TTL_SECONDS,
      resultImageUrl: null,
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
