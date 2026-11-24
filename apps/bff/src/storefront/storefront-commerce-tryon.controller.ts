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
    const upstream = await this.proxy.request({
      method: 'POST',
      url: `${this.config.cartOutfitServiceUrl}/v1/cart/items`,
      req,
      body,
      extraHeaders,
    });
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
    const upstream = await this.proxy.request({
      method: 'POST',
      url: `${this.config.cartOutfitServiceUrl}/v1/cart/outfit-bundle`,
      req,
      body,
      extraHeaders,
    });
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
  // AI Virtual Try-On (proxied to ai-tryon:4009)
  // ============================================================================

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
      timeoutMs: 15_000,
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
