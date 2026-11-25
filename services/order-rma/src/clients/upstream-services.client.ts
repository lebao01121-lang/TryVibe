import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import {
  ErrorCode,
  InventoryLedgerReason,
  type CartDto,
  type PaymentIntentResponseDTO,
  type PaymentMethod,
  type RefundResponseDTO,
  type ReserveStockResponse,
  type ShipmentDTO,
  type ShippingMethod,
} from '@atelier/contracts';
import {
  createChildTraceparent,
  createLogger,
  TRACEPARENT_HEADER,
} from '@atelier/observability';
import { ApiDomainException } from '../common/api-exception';
import { ORDER_CONFIG_TOKEN, SERVICE_NAME, type OrderRmaConfig } from '../config/env';

export interface TraceContext {
  correlationId: string;
  traceparent?: string;
}

export interface CatalogSkuSnapshot {
  skuId: string;
  skuCode: string;
  variantId: string;
  productId: string;
  productName: string;
  productSlug: string;
  colorName: string;
  colorHex: string;
  sizeCode: string;
  basePriceVnd: number;
  salePriceVnd: number;
  effectivePriceVnd: number;
  weightGrams: number;
  inStock: boolean;
  isReturnable: boolean;
  imageUrl: string | null;
}

export interface PackagingOptionInfo {
  id: string;
  code: string;
  name: string;
  priceVnd: number;
  isDefault: boolean;
}

export interface CustomerCheckoutProfile {
  userId: string;
  email: string | null;
  fullName: string | null;
  loyaltyTier: string;
  codTrustScore: number;
}

export interface PromoEvaluateInputItem {
  skuId: string;
  productId: string;
  sizeCode: string;
  unitPriceVnd: number;
  qty: number;
  slot: string | null;
  bundleGroupId: string | null;
}

export interface EvaluatedPromotionRaw {
  reachable: boolean;
  valid: boolean;
  promotionId: string | null;
  voucherCode: string | null;
  promoType: string | null;
  comboDiscountVnd: number | null;
  voucherDiscountVnd: number | null;
  discountVnd: number | null;
  shippingFeeVnd: number | null;
  shippingDiscountVnd: number | null;
  totalDiscountVnd: number | null;
  allocatedItems: Array<{
    skuId: string;
    qty: number;
    unitPriceVnd: number;
    allocatedDiscountVnd: number;
    netRefundableUnitVnd: number;
  }>;
  reason: string | null;
}

const DEFAULT_PACKAGING_OPTIONS: readonly PackagingOptionInfo[] = [
  {
    id: 'tui-vai-linen-moc',
    code: 'tui-vai-linen-moc',
    name: 'Túi Vải Linen Mộc Tiêu Chuẩn',
    priceVnd: 0,
    isDefault: true,
  },
  {
    id: 'hop-lua-co-dien',
    code: 'hop-lua-co-dien',
    name: 'Hộp Lụa Cổ Điển Ivory',
    priceVnd: 80_000,
    isDefault: false,
  },
  {
    id: 'hop-qua-khac-ten-gold',
    code: 'hop-qua-khac-ten-gold',
    name: 'Hộp Quà Khắc Tên Ánh Kim Gold',
    priceVnd: 150_000,
    isDefault: false,
  },
] as const;

const PACKAGING_CACHE_TTL_MS = 30_000;

const VALID_ERROR_CODES = new Set<string>(Object.values(ErrorCode));

interface ParsedJsonBody {
  data?: unknown;
  error?: {
    code?: string;
    message?: string;
    details?: Record<string, unknown>;
  } | null;
  [key: string]: unknown;
}

@Injectable()
export class UpstreamServicesClient {
  private readonly logger = createLogger(`${SERVICE_NAME}:upstream`);
  private packagingCache: { items: PackagingOptionInfo[]; expiresAt: number } | null = null;

  constructor(@Inject(ORDER_CONFIG_TOKEN) private readonly config: OrderRmaConfig) {}

  private buildTraceHeaders(
    trace: string | TraceContext,
    extra: Record<string, string> = {},
  ): Record<string, string> {
    const correlationId = typeof trace === 'string' ? trace : trace.correlationId;
    const parentTrace = typeof trace === 'string' ? undefined : trace.traceparent;
    return {
      'X-Correlation-Id': correlationId,
      [TRACEPARENT_HEADER]: createChildTraceparent(parentTrace),
      ...extra,
    };
  }

  private getCorrelationId(trace: string | TraceContext): string {
    return typeof trace === 'string' ? trace : trace.correlationId;
  }

  private async fetchJson(
    url: string,
    init: RequestInit,
    timeoutMs: number = 4000,
  ): Promise<{ ok: boolean; status: number; json: ParsedJsonBody | null; rawText: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        ...init,
        signal: controller.signal,
      });
      const rawText = await response.text();
      let json: ParsedJsonBody | null = null;
      if (rawText.trim().length > 0) {
        try {
          json = JSON.parse(rawText) as ParsedJsonBody;
        } catch {
          json = null;
        }
      }
      return { ok: response.ok, status: response.status, json, rawText };
    } finally {
      clearTimeout(timer);
    }
  }

  private unwrapData<T>(json: ParsedJsonBody | null): T | null {
    if (!json) {
      return null;
    }
    if ('data' in json && json.data !== undefined && json.data !== null) {
      return json.data as T;
    }
    return json as unknown as T;
  }

  private mapErrorCode(raw: string | undefined, fallback: ErrorCode): ErrorCode {
    if (raw && VALID_ERROR_CODES.has(raw)) {
      return raw as ErrorCode;
    }
    return fallback;
  }

  // ==========================================================================
  // 1. Cart & Outfit Service (:4005)
  // ==========================================================================

  async fetchCart(
    actor: { userId: string | null; guestSessionId: string | null },
    trace: string | TraceContext,
  ): Promise<CartDto> {
    const headers = this.buildTraceHeaders(trace, {
      Accept: 'application/json',
      ...(actor.userId ? { 'x-user-id': actor.userId } : {}),
      ...(actor.guestSessionId ? { 'x-guest-session-id': actor.guestSessionId } : {}),
    });

    try {
      const res = await this.fetchJson(
        `${this.config.upstreams.cartOutfitServiceUrl}/v1/cart`,
        { method: 'GET', headers },
        4000,
      );
      if (!res.ok) {
        throw new ApiDomainException(
          HttpStatus.BAD_GATEWAY,
          ErrorCode.DEPENDENCY_UNAVAILABLE,
          res.json?.error?.message || 'Không thể tải giỏ hàng từ dịch vụ cart-outfit.',
        );
      }
      const cart = this.unwrapData<CartDto>(res.json);
      if (!cart || !Array.isArray(cart.items)) {
        throw new ApiDomainException(
          HttpStatus.BAD_REQUEST,
          ErrorCode.VALIDATION_ERROR,
          'Giỏ hàng hiện đang trống.',
        );
      }
      return cart;
    } catch (error: unknown) {
      if (error instanceof ApiDomainException) {
        throw error;
      }
      throw new ApiDomainException(
        HttpStatus.SERVICE_UNAVAILABLE,
        ErrorCode.DEPENDENCY_UNAVAILABLE,
        'Dịch vụ giỏ hàng (cart-outfit) tạm thời không khả dụng.',
      );
    }
  }

  async clearCartNonFatal(
    payload: { userId: string | null; guestSessionId: string | null; skuIds: string[] },
    trace: string | TraceContext,
  ): Promise<void> {
    if (!payload.userId && !payload.guestSessionId) {
      return;
    }
    const correlationId = this.getCorrelationId(trace);
    try {
      const res = await this.fetchJson(
        `${this.config.upstreams.cartOutfitServiceUrl}/v1/cart/internal/clear`,
        {
          method: 'POST',
          headers: this.buildTraceHeaders(trace, {
            'Content-Type': 'application/json',
            'x-internal-secret': this.config.internalServiceSecret,
          }),
          body: JSON.stringify({
            ...(payload.userId ? { userId: payload.userId } : {}),
            ...(payload.guestSessionId ? { guestSessionId: payload.guestSessionId } : {}),
            skuIds: payload.skuIds,
          }),
        },
        3000,
      );
      if (!res.ok) {
        this.logger.warn(
          { status: res.status, correlationId },
          'Non-fatal cart clear returned non-OK status',
        );
      }
    } catch (error: unknown) {
      this.logger.warn(
        { err: error instanceof Error ? error.message : String(error), correlationId },
        'Non-fatal cart clear failed',
      );
    }
  }

  // ==========================================================================
  // 2. Catalog & Lookbook Service (:4002) — Authoritative Server Pricing
  // ==========================================================================

  async fetchSkusSnapshot(
    params: { skuIds?: string[]; skuCodes?: string[] },
    trace: string | TraceContext,
  ): Promise<Map<string, CatalogSkuSnapshot>> {
    const skuIds = Array.from(new Set((params.skuIds ?? []).map((s) => s.trim()).filter(Boolean)));
    const skuCodes = Array.from(
      new Set((params.skuCodes ?? []).map((s) => s.trim()).filter(Boolean)),
    );
    const map = new Map<string, CatalogSkuSnapshot>();

    if (skuIds.length === 0 && skuCodes.length === 0) {
      return map;
    }

    try {
      const res = await this.fetchJson(
        `${this.config.upstreams.catalogLookbookServiceUrl}/v1/catalog/internal/skus/snapshot`,
        {
          method: 'POST',
          headers: this.buildTraceHeaders(trace, {
            'Content-Type': 'application/json',
            'x-internal-secret': this.config.internalServiceSecret,
          }),
          body: JSON.stringify({
            ...(skuIds.length > 0 ? { skuIds } : {}),
            ...(skuCodes.length > 0 ? { skuCodes } : {}),
          }),
        },
        4000,
      );

      if (!res.ok) {
        throw new ApiDomainException(
          HttpStatus.SERVICE_UNAVAILABLE,
          ErrorCode.DEPENDENCY_UNAVAILABLE,
          'Không thể xác thực giá niêm yết từ dịch vụ catalog-lookbook.',
        );
      }

      const rows = this.unwrapData<unknown[]>(res.json);
      if (!Array.isArray(rows)) {
        return map;
      }

      for (const raw of rows) {
        if (!raw || typeof raw !== 'object') {
          continue;
        }
        const rec = raw as Record<string, unknown>;
        const skuId = typeof rec.skuId === 'string' ? rec.skuId : '';
        if (!skuId) {
          continue;
        }
        const basePriceVnd = Math.max(0, Math.round(Number(rec.basePriceVnd ?? 0) || 0));
        const effectivePriceVnd = Math.max(
          0,
          Math.round(Number(rec.effectivePriceVnd ?? rec.salePriceVnd ?? basePriceVnd) || 0),
        );
        const snap: CatalogSkuSnapshot = {
          skuId,
          skuCode: String(rec.skuCode ?? skuId),
          variantId: String(rec.variantId ?? ''),
          productId: String(rec.productId ?? ''),
          productName: String(rec.productName ?? 'Thiết kế TryVibe Atelier'),
          productSlug: String(rec.productSlug ?? ''),
          colorName: String(rec.colorName ?? 'Mặc định'),
          colorHex: String(rec.colorHex ?? '#1C1410'),
          sizeCode: String(rec.sizeCode ?? 'M'),
          basePriceVnd,
          salePriceVnd: effectivePriceVnd,
          effectivePriceVnd,
          weightGrams: Math.max(0, Math.round(Number(rec.weightGrams ?? 350) || 350)),
          inStock: rec.inStock !== false,
          isReturnable: rec.isReturnable !== false,
          imageUrl:
            typeof rec.imageUrl === 'string' && rec.imageUrl.trim().length > 0
              ? rec.imageUrl.trim()
              : null,
        };
        map.set(skuId, snap);
        map.set(snap.skuCode, snap);
      }

      return map;
    } catch (error: unknown) {
      if (error instanceof ApiDomainException) {
        throw error;
      }
      throw new ApiDomainException(
        HttpStatus.SERVICE_UNAVAILABLE,
        ErrorCode.DEPENDENCY_UNAVAILABLE,
        'Dịch vụ danh mục (catalog-lookbook) tạm thời không khả dụng.',
      );
    }
  }

  async resolvePackagingOption(
    packagingOptionId: string | null | undefined,
    trace: string | TraceContext,
  ): Promise<PackagingOptionInfo | null> {
    if (!packagingOptionId || packagingOptionId.trim().length === 0) {
      return null;
    }
    const target = packagingOptionId.trim();
    const options = await this.fetchPackagingOptions(trace);
    const matched = options.find((opt) => opt.id === target || opt.code === target);
    if (matched) {
      return matched;
    }
    return DEFAULT_PACKAGING_OPTIONS.find((opt) => opt.id === target || opt.code === target) ?? null;
  }

  private async fetchPackagingOptions(trace: string | TraceContext): Promise<PackagingOptionInfo[]> {
    if (this.packagingCache && Date.now() < this.packagingCache.expiresAt) {
      return this.packagingCache.items;
    }

    try {
      const res = await this.fetchJson(
        `${this.config.upstreams.catalogLookbookServiceUrl}/v1/catalog/bootstrap`,
        {
          method: 'GET',
          headers: this.buildTraceHeaders(trace, {
            Accept: 'application/json',
          }),
        },
        2500,
      );
      if (res.ok) {
        const data = this.unwrapData<{ packagingOptions?: Array<Record<string, unknown>> }>(
          res.json,
        );
        const list = Array.isArray(data?.packagingOptions) ? data.packagingOptions : [];
        if (list.length > 0) {
          const items: PackagingOptionInfo[] = list.map((raw) => ({
            id: String(raw.id ?? raw.code ?? ''),
            code: String(raw.code ?? raw.id ?? ''),
            name: String(raw.name ?? 'Đóng gói tiêu chuẩn'),
            priceVnd: Math.max(0, Math.round(Number(raw.priceVnd ?? 0) || 0)),
            isDefault: Boolean(raw.isDefault),
          }));
          this.packagingCache = { items, expiresAt: Date.now() + PACKAGING_CACHE_TTL_MS };
          return items;
        }
      }
    } catch {
      // Fallback safely to static packaging defaults
    }

    return [...DEFAULT_PACKAGING_OPTIONS];
  }

  // ==========================================================================
  // 3. Payment & Promotion Service (:4007)
  // ==========================================================================

  async evaluatePromotions(
    params: {
      items: PromoEvaluateInputItem[];
      voucherCode: string | null;
      shippingMethod: ShippingMethod;
      shippingFeeVnd: number;
      subtotalVnd: number;
      userId: string | null;
      comboDistinctSlots: number;
    },
    trace: string | TraceContext,
  ): Promise<EvaluatedPromotionRaw> {
    const correlationId = this.getCorrelationId(trace);
    try {
      const res = await this.fetchJson(
        `${this.config.upstreams.paymentPromoServiceUrl}/v1/promotions/evaluate`,
        {
          method: 'POST',
          headers: this.buildTraceHeaders(trace, {
            'Content-Type': 'application/json',
          }),
          body: JSON.stringify({
            voucherCode: params.voucherCode,
            shippingMethod: params.shippingMethod,
            shippingFeeVnd: params.shippingFeeVnd,
            subtotalVnd: params.subtotalVnd,
            userId: params.userId,
            comboDistinctSlots: params.comboDistinctSlots,
            items: params.items,
          }),
        },
        4000,
      );

      if (!res.ok) {
        const status =
          res.status === 409
            ? HttpStatus.CONFLICT
            : res.status === 400
              ? HttpStatus.BAD_REQUEST
              : HttpStatus.BAD_GATEWAY;
        const code = this.mapErrorCode(
          res.json?.error?.code,
          res.status === 409 ? ErrorCode.PROMOTION_EXHAUSTED : ErrorCode.PROMOTION_INVALID,
        );
        throw new ApiDomainException(
          status,
          code,
          res.json?.error?.message || 'Mã khuyến mãi không hợp lệ hoặc không thể áp dụng.',
          res.json?.error?.details,
        );
      }

      const data = this.unwrapData<Record<string, unknown>>(res.json) ?? {};
      const rawAllocated = Array.isArray(data.allocatedDiscounts)
        ? data.allocatedDiscounts
        : Array.isArray(data.allocatedItems)
          ? data.allocatedItems
          : [];

      const allocatedItems = rawAllocated
        .filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === 'object'))
        .map((entry) => ({
          skuId: String(entry.skuId ?? ''),
          qty: Math.max(1, Math.round(Number(entry.qty ?? 1) || 1)),
          unitPriceVnd: Math.max(0, Math.round(Number(entry.unitPriceVnd ?? 0) || 0)),
          allocatedDiscountVnd: Math.max(
            0,
            Math.round(Number(entry.allocatedDiscountVnd ?? 0) || 0),
          ),
          netRefundableUnitVnd: Math.max(
            0,
            Math.round(Number(entry.netRefundableUnitVnd ?? 0) || 0),
          ),
        }))
        .filter((entry) => entry.skuId.length > 0);

      return {
        reachable: true,
        valid: data.valid !== false,
        promotionId: typeof data.promotionId === 'string' ? data.promotionId : null,
        voucherCode: typeof data.voucherCode === 'string' ? data.voucherCode : params.voucherCode,
        promoType: typeof data.promoType === 'string' ? data.promoType : null,
        comboDiscountVnd:
          typeof data.comboDiscountVnd === 'number'
            ? Math.max(0, Math.round(data.comboDiscountVnd))
            : null,
        voucherDiscountVnd:
          typeof data.voucherDiscountVnd === 'number'
            ? Math.max(0, Math.round(data.voucherDiscountVnd))
            : null,
        discountVnd:
          typeof data.discountVnd === 'number' ? Math.max(0, Math.round(data.discountVnd)) : null,
        shippingFeeVnd:
          typeof data.shippingFeeVnd === 'number'
            ? Math.max(0, Math.round(data.shippingFeeVnd))
            : null,
        shippingDiscountVnd:
          typeof data.shippingDiscountVnd === 'number'
            ? Math.max(0, Math.round(data.shippingDiscountVnd))
            : null,
        totalDiscountVnd:
          typeof data.totalDiscountVnd === 'number'
            ? Math.max(0, Math.round(data.totalDiscountVnd))
            : null,
        allocatedItems,
        reason: typeof data.reason === 'string' ? data.reason : null,
      };
    } catch (error: unknown) {
      if (error instanceof ApiDomainException) {
        throw error;
      }
      if (params.voucherCode) {
        throw new ApiDomainException(
          HttpStatus.SERVICE_UNAVAILABLE,
          ErrorCode.DEPENDENCY_UNAVAILABLE,
          'Dịch vụ khuyến mãi (payment-promo) tạm thời không khả dụng.',
        );
      }
      this.logger.warn(
        { err: error instanceof Error ? error.message : String(error), correlationId },
        'payment-promo evaluate unreachable without voucher; using deterministic local combo fallback',
      );
      return {
        reachable: false,
        valid: true,
        promotionId: null,
        voucherCode: null,
        promoType: null,
        comboDiscountVnd: null,
        voucherDiscountVnd: 0,
        discountVnd: null,
        shippingFeeVnd: null,
        shippingDiscountVnd: null,
        totalDiscountVnd: null,
        allocatedItems: [],
        reason: null,
      };
    }
  }

  async lockPromotion(
    params: {
      promotionId?: string | null;
      voucherCode: string;
      orderId: string;
      userId: string | null;
      discountVnd: number;
    },
    trace: string | TraceContext,
  ): Promise<void> {
    const res = await this.fetchJson(
      `${this.config.upstreams.paymentPromoServiceUrl}/v1/promotions/lock`,
      {
        method: 'POST',
        headers: this.buildTraceHeaders(trace, {
          'Content-Type': 'application/json',
          'x-internal-secret': this.config.internalServiceSecret,
        }),
        body: JSON.stringify({
          ...(params.promotionId ? { promotionId: params.promotionId } : {}),
          voucherCode: params.voucherCode,
          orderId: params.orderId,
          userId: params.userId,
          discountVnd: params.discountVnd,
        }),
      },
      4000,
    );

    if (!res.ok) {
      const status =
        res.status === 409
          ? HttpStatus.CONFLICT
          : res.status === 400
            ? HttpStatus.BAD_REQUEST
            : HttpStatus.BAD_GATEWAY;
      const code = this.mapErrorCode(
        res.json?.error?.code,
        res.status === 409 ? ErrorCode.PROMOTION_EXHAUSTED : ErrorCode.PROMOTION_INVALID,
      );
      throw new ApiDomainException(
        status,
        code,
        res.json?.error?.message || 'Không thể giữ lượt sử dụng mã khuyến mãi.',
        res.json?.error?.details,
      );
    }
  }

  async releasePromotionNonFatal(
    params: { voucherCode: string; orderId: string; reason: string },
    trace: string | TraceContext,
  ): Promise<void> {
    const correlationId = this.getCorrelationId(trace);
    try {
      await this.fetchJson(
        `${this.config.upstreams.paymentPromoServiceUrl}/v1/promotions/release`,
        {
          method: 'POST',
          headers: this.buildTraceHeaders(trace, {
            'Content-Type': 'application/json',
            'x-internal-secret': this.config.internalServiceSecret,
          }),
          body: JSON.stringify(params),
        },
        3000,
      );
    } catch (error: unknown) {
      this.logger.warn(
        { err: error instanceof Error ? error.message : String(error), correlationId, ...params },
        'Non-fatal promotion release failed',
      );
    }
  }

  async createPaymentIntent(
    params: {
      orderId: string;
      orderCode: string;
      provider: PaymentMethod;
      amountVnd: number;
      expiresAt: string;
      customerEmail: string | null;
      idempotencyKey: string;
    },
    trace: string | TraceContext,
  ): Promise<PaymentIntentResponseDTO> {
    try {
      const res = await this.fetchJson(
        `${this.config.upstreams.paymentPromoServiceUrl}/v1/payments/intents`,
        {
          method: 'POST',
          headers: this.buildTraceHeaders(trace, {
            'Content-Type': 'application/json',
            'Idempotency-Key': params.idempotencyKey,
            'x-internal-secret': this.config.internalServiceSecret,
          }),
          body: JSON.stringify({
            orderId: params.orderId,
            orderCode: params.orderCode,
            provider: params.provider,
            amountVnd: params.amountVnd,
            expiresAt: params.expiresAt,
            customerEmail: params.customerEmail,
            idempotencyKey: params.idempotencyKey,
          }),
        },
        5000,
      );

      if (!res.ok) {
        throw new ApiDomainException(
          HttpStatus.BAD_GATEWAY,
          ErrorCode.DEPENDENCY_UNAVAILABLE,
          res.json?.error?.message || 'Không thể khởi tạo phiên thanh toán từ dịch vụ payment-promo.',
          res.json?.error?.details,
        );
      }

      const intent = this.unwrapData<PaymentIntentResponseDTO>(res.json);
      if (!intent || !intent.transactionId) {
        throw new ApiDomainException(
          HttpStatus.BAD_GATEWAY,
          ErrorCode.DEPENDENCY_UNAVAILABLE,
          'Phản hồi phiên thanh toán từ payment-promo không hợp lệ.',
        );
      }
      return intent;
    } catch (error: unknown) {
      if (error instanceof ApiDomainException) {
        throw error;
      }
      throw new ApiDomainException(
        HttpStatus.SERVICE_UNAVAILABLE,
        ErrorCode.DEPENDENCY_UNAVAILABLE,
        'Dịch vụ thanh toán (payment-promo) tạm thời không khả dụng.',
      );
    }
  }

  async createRefund(
    params: {
      orderId: string;
      orderCode: string;
      amountVnd: number;
      reason: string;
      rmaId?: string | null;
      idempotencyKey: string;
    },
    trace: string | TraceContext,
  ): Promise<RefundResponseDTO> {
    try {
      const res = await this.fetchJson(
        `${this.config.upstreams.paymentPromoServiceUrl}/v1/payments/refunds`,
        {
          method: 'POST',
          headers: this.buildTraceHeaders(trace, {
            'Content-Type': 'application/json',
            'Idempotency-Key': params.idempotencyKey,
            'x-internal-secret': this.config.internalServiceSecret,
          }),
          body: JSON.stringify({
            orderId: params.orderId,
            orderCode: params.orderCode,
            amountVnd: params.amountVnd,
            reason: params.reason,
            ...(params.rmaId ? { rmaId: params.rmaId } : {}),
            idempotencyKey: params.idempotencyKey,
          }),
        },
        5000,
      );

      if (!res.ok) {
        const status =
          res.status === 400
            ? HttpStatus.BAD_REQUEST
            : res.status === 404
              ? HttpStatus.NOT_FOUND
              : res.status === 409
                ? HttpStatus.CONFLICT
                : HttpStatus.BAD_GATEWAY;
        throw new ApiDomainException(
          status,
          this.mapErrorCode(res.json?.error?.code, ErrorCode.DEPENDENCY_UNAVAILABLE),
          res.json?.error?.message || 'Không thể thực hiện hoàn tiền tại payment-promo.',
          res.json?.error?.details,
        );
      }

      const data = this.unwrapData<Record<string, unknown>>(res.json) ?? {};
      return {
        refundId: String(data.refundId ?? data.transactionId ?? data.id ?? params.idempotencyKey),
        orderId: String(data.orderId ?? params.orderId),
        orderCode: String(data.orderCode ?? params.orderCode),
        rmaId: typeof data.rmaId === 'string' ? data.rmaId : (params.rmaId ?? null),
        amountVnd: Math.max(1, Math.round(Number(data.amountVnd ?? params.amountVnd))),
        status:
          data.status === 'PROCESSING' || data.status === 'FAILED' ? data.status : 'COMPLETED',
        provider: (data.provider as PaymentMethod) ?? 'VIETQR',
        idempotentReplay: Boolean(data.idempotentReplay),
        refundedAt:
          typeof data.refundedAt === 'string' ? data.refundedAt : new Date().toISOString(),
      };
    } catch (error: unknown) {
      if (error instanceof ApiDomainException) {
        throw error;
      }
      throw new ApiDomainException(
        HttpStatus.SERVICE_UNAVAILABLE,
        ErrorCode.DEPENDENCY_UNAVAILABLE,
        'Dịch vụ hoàn tiền (payment-promo) tạm thời không khả dụng.',
      );
    }
  }

  // ==========================================================================
  // 4. Inventory Service (:4004)
  // ==========================================================================

  async reserveStock(
    params: {
      referenceId: string;
      reservationType: 'CHECKOUT' | 'SIZE_EXCHANGE';
      items: Array<{ skuId: string; qty: number }>;
      preferredWarehouseCode?: string;
      ttlSeconds: number;
      idempotencyKey: string;
    },
    trace: string | TraceContext,
  ): Promise<ReserveStockResponse> {
    try {
      const res = await this.fetchJson(
        `${this.config.upstreams.inventoryServiceUrl}/v1/inventory/reservations`,
        {
          method: 'POST',
          headers: this.buildTraceHeaders(trace, {
            'Content-Type': 'application/json',
            'Idempotency-Key': params.idempotencyKey,
            'x-internal-secret': this.config.internalServiceSecret,
          }),
          body: JSON.stringify({
            referenceId: params.referenceId,
            reservationType: params.reservationType,
            items: params.items,
            ...(params.preferredWarehouseCode
              ? { preferredWarehouseCode: params.preferredWarehouseCode }
              : {}),
            ttlSeconds: params.ttlSeconds,
            idempotencyKey: params.idempotencyKey,
          }),
        },
        5000,
      );

      if (res.status === 409) {
        throw new ApiDomainException(
          HttpStatus.CONFLICT,
          ErrorCode.INSUFFICIENT_STOCK,
          res.json?.error?.message || 'Sản phẩm trong giỏ hiện không đủ tồn kho khả dụng.',
          res.json?.error?.details ?? { shortages: [] },
        );
      }

      if (!res.ok) {
        throw new ApiDomainException(
          HttpStatus.BAD_GATEWAY,
          ErrorCode.DEPENDENCY_UNAVAILABLE,
          res.json?.error?.message || 'Không thể giữ tồn kho tại dịch vụ inventory.',
          res.json?.error?.details,
        );
      }

      const data = this.unwrapData<ReserveStockResponse>(res.json);
      if (!data || !data.reservationId) {
        throw new ApiDomainException(
          HttpStatus.BAD_GATEWAY,
          ErrorCode.DEPENDENCY_UNAVAILABLE,
          'Phản hồi giữ tồn kho từ inventory không hợp lệ.',
        );
      }
      return data;
    } catch (error: unknown) {
      if (error instanceof ApiDomainException) {
        throw error;
      }
      throw new ApiDomainException(
        HttpStatus.SERVICE_UNAVAILABLE,
        ErrorCode.DEPENDENCY_UNAVAILABLE,
        'Dịch vụ kho vận (inventory) tạm thời không khả dụng.',
      );
    }
  }

  async commitReservation(
    referenceId: string,
    reservationId: string | null | undefined,
    trace: string | TraceContext,
  ): Promise<void> {
    const body = JSON.stringify({
      referenceId,
      orderId: referenceId,
      ...(reservationId ? { reservationId } : {}),
    });
    const headers = this.buildTraceHeaders(trace, {
      'Content-Type': 'application/json',
      'x-internal-secret': this.config.internalServiceSecret,
    });

    const primaryUrl = `${this.config.upstreams.inventoryServiceUrl}/v1/inventory/reservations/${encodeURIComponent(referenceId)}/commit`;
    let res = await this.fetchJson(primaryUrl, { method: 'POST', headers, body }, 5000);

    if (res.status === 404) {
      const fallbackUrl = `${this.config.upstreams.inventoryServiceUrl}/v1/inventory/reservations/commit`;
      res = await this.fetchJson(fallbackUrl, { method: 'POST', headers, body }, 5000);
    }

    if (!res.ok) {
      throw new ApiDomainException(
        res.status === 409 ? HttpStatus.CONFLICT : HttpStatus.BAD_GATEWAY,
        this.mapErrorCode(res.json?.error?.code, ErrorCode.DEPENDENCY_UNAVAILABLE),
        res.json?.error?.message || 'Không thể xác nhận xuất giữ kho (commit reservation).',
        res.json?.error?.details,
      );
    }
  }

  async releaseReservationNonFatal(
    referenceId: string,
    reason: 'RELEASE_EXPIRED' | 'CANCEL_RELEASE',
    reservationId: string | null | undefined,
    trace: string | TraceContext,
  ): Promise<boolean> {
    const correlationId = this.getCorrelationId(trace);
    const body = JSON.stringify({
      referenceId,
      ...(reservationId ? { reservationId } : {}),
      reason:
        reason === 'RELEASE_EXPIRED'
          ? InventoryLedgerReason.RELEASE_EXPIRED
          : InventoryLedgerReason.CANCEL_RELEASE,
    });
    const headers = this.buildTraceHeaders(trace, {
      'Content-Type': 'application/json',
      'x-internal-secret': this.config.internalServiceSecret,
    });

    try {
      const primaryUrl = `${this.config.upstreams.inventoryServiceUrl}/v1/inventory/reservations/${encodeURIComponent(referenceId)}/release`;
      let res = await this.fetchJson(primaryUrl, { method: 'POST', headers, body }, 4000);
      if (res.status === 404) {
        const fallbackUrl = `${this.config.upstreams.inventoryServiceUrl}/v1/inventory/reservations/release`;
        res = await this.fetchJson(fallbackUrl, { method: 'POST', headers, body }, 4000);
      }
      if (!res.ok) {
        this.logger.warn(
          { status: res.status, referenceId, reason, correlationId },
          'Inventory release reservation returned non-OK status',
        );
        return false;
      }
      return true;
    } catch (error: unknown) {
      this.logger.warn(
        { err: error instanceof Error ? error.message : String(error), referenceId, correlationId },
        'Non-fatal inventory release reservation failed',
      );
      return false;
    }
  }

  async rmaRestock(
    params: {
      skuId: string;
      qty: number;
      restockable: boolean;
      warehouseCode?: string;
      referenceId: string;
    },
    trace: string | TraceContext,
  ): Promise<void> {
    try {
      const res = await this.fetchJson(
        `${this.config.upstreams.inventoryServiceUrl}/v1/inventory/rma-restock`,
        {
          method: 'POST',
          headers: this.buildTraceHeaders(trace, {
            'Content-Type': 'application/json',
            'x-internal-secret': this.config.internalServiceSecret,
          }),
          body: JSON.stringify(params),
        },
        5000,
      );
      if (!res.ok) {
        throw new ApiDomainException(
          HttpStatus.BAD_GATEWAY,
          this.mapErrorCode(res.json?.error?.code, ErrorCode.DEPENDENCY_UNAVAILABLE),
          res.json?.error?.message || 'Không thể nhập hoàn kho RMA tại dịch vụ inventory.',
          res.json?.error?.details,
        );
      }
    } catch (error: unknown) {
      if (error instanceof ApiDomainException) {
        throw error;
      }
      throw new ApiDomainException(
        HttpStatus.SERVICE_UNAVAILABLE,
        ErrorCode.DEPENDENCY_UNAVAILABLE,
        'Dịch vụ kho vận (inventory) tạm thời không khả dụng khi nhập hoàn RMA.',
      );
    }
  }

  // ==========================================================================
  // 5. Auth & Customer Service (:4001)
  // ==========================================================================

  async fetchCustomerCheckoutProfile(
    userId: string,
    trace: string | TraceContext,
  ): Promise<CustomerCheckoutProfile | null> {
    try {
      const res = await this.fetchJson(
        `${this.config.upstreams.authCustomerServiceUrl}/internal/auth/users/${encodeURIComponent(userId)}/checkout-profile`,
        {
          method: 'GET',
          headers: this.buildTraceHeaders(trace, {
            Accept: 'application/json',
            'x-internal-secret': this.config.internalServiceSecret,
          }),
        },
        3000,
      );
      if (!res.ok) {
        return null;
      }
      const data = this.unwrapData<Record<string, unknown>>(res.json);
      if (!data) {
        return null;
      }
      return {
        userId: String(data.userId ?? userId),
        email: typeof data.email === 'string' ? data.email : null,
        fullName: typeof data.fullName === 'string' ? data.fullName : null,
        loyaltyTier: typeof data.loyaltyTier === 'string' ? data.loyaltyTier : 'BRONZE',
        codTrustScore: Number.isFinite(Number(data.codTrustScore))
          ? Number(data.codTrustScore)
          : 100,
      };
    } catch {
      return null;
    }
  }

  async grantTryOnBonusNonFatal(
    params: { userId: string; bonusCredits: number; reason: string },
    trace: string | TraceContext,
  ): Promise<void> {
    const correlationId = this.getCorrelationId(trace);
    try {
      const res = await this.fetchJson(
        `${this.config.upstreams.authCustomerServiceUrl}/internal/auth/tryon-quota/bonus`,
        {
          method: 'POST',
          headers: this.buildTraceHeaders(trace, {
            'Content-Type': 'application/json',
            'x-internal-secret': this.config.internalServiceSecret,
          }),
          body: JSON.stringify(params),
        },
        3500,
      );
      if (!res.ok) {
        this.logger.warn(
          { status: res.status, userId: params.userId, correlationId },
          'Non-fatal tryon-quota bonus returned non-OK status',
        );
      }
    } catch (error: unknown) {
      this.logger.warn(
        { err: error instanceof Error ? error.message : String(error), correlationId },
        'Non-fatal tryon-quota bonus failed',
      );
    }
  }

  // ==========================================================================
  // 6. Notify & Review Service (:4008)
  // ==========================================================================

  async notifyOrderConfirmedNonFatal(
    payload: {
      eventId: string;
      orderCode: string;
      customerEmail: string;
      customerPhone?: string | null;
      customerName?: string | null;
      grandTotalVnd: number;
      trackingCode?: string | null;
      items: Array<{
        productName: string;
        colorName: string;
        sizeCode: string;
        qty: number;
        unitPriceVnd: number;
      }>;
    },
    trace: string | TraceContext,
  ): Promise<void> {
    const correlationId = this.getCorrelationId(trace);
    try {
      const res = await this.fetchJson(
        `${this.config.upstreams.notifyReviewServiceUrl}/internal/notify/order-confirmed`,
        {
          method: 'POST',
          headers: this.buildTraceHeaders(trace, {
            'Content-Type': 'application/json',
            'x-internal-secret': this.config.internalServiceSecret,
          }),
          body: JSON.stringify(payload),
        },
        3500,
      );
      if (!res.ok) {
        this.logger.warn(
          { status: res.status, orderCode: payload.orderCode, correlationId },
          'Non-fatal order-confirmed notification returned non-OK status',
        );
      }
    } catch (error: unknown) {
      this.logger.warn(
        { err: error instanceof Error ? error.message : String(error), correlationId },
        'Non-fatal order-confirmed notification failed',
      );
    }
  }

  async notifyOrderPackedNonFatal(
    payload: {
      eventId: string;
      orderCode: string;
      customerEmail: string;
      customerPhone?: string | null;
      packPhotoUrl: string;
      trackingCode?: string | null;
    },
    trace: string | TraceContext,
  ): Promise<void> {
    const correlationId = this.getCorrelationId(trace);
    try {
      const res = await this.fetchJson(
        `${this.config.upstreams.notifyReviewServiceUrl}/internal/notify/order-packed`,
        {
          method: 'POST',
          headers: this.buildTraceHeaders(trace, {
            'Content-Type': 'application/json',
            'x-internal-secret': this.config.internalServiceSecret,
          }),
          body: JSON.stringify(payload),
        },
        3500,
      );
      if (!res.ok) {
        this.logger.warn(
          { status: res.status, orderCode: payload.orderCode, correlationId },
          'Non-fatal order-packed notification returned non-OK status',
        );
      }
    } catch (error: unknown) {
      this.logger.warn(
        { err: error instanceof Error ? error.message : String(error), correlationId },
        'Non-fatal order-packed notification failed',
      );
    }
  }

  async notifyRmaRejectedNonFatal(
    payload: {
      eventId: string;
      rmaId: string;
      rmaCode: string;
      orderCode: string;
      customerEmail: string;
      customerPhone?: string | null;
      customerName?: string | null;
      reason: string;
      rejectedBy?: string | null;
    },
    trace: string | TraceContext,
  ): Promise<boolean> {
    const correlationId = this.getCorrelationId(trace);
    try {
      const res = await this.fetchJson(
        `${this.config.upstreams.notifyReviewServiceUrl}/internal/notify/rma-rejected`,
        {
          method: 'POST',
          headers: this.buildTraceHeaders(trace, {
            'Content-Type': 'application/json',
            'x-internal-secret': this.config.internalServiceSecret,
          }),
          body: JSON.stringify(payload),
        },
        3500,
      );
      if (!res.ok) {
        this.logger.warn(
          { status: res.status, rmaCode: payload.rmaCode, orderCode: payload.orderCode, correlationId },
          'Non-fatal rma-rejected notification returned non-OK status',
        );
        return false;
      }
      return true;
    } catch (error: unknown) {
      this.logger.warn(
        {
          err: error instanceof Error ? error.message : String(error),
          rmaCode: payload.rmaCode,
          correlationId,
        },
        'Non-fatal rma-rejected notification failed',
      );
      return false;
    }
  }

  // ==========================================================================
  // 7. BFF Realtime Socket.io Hub (:4000)
  // ==========================================================================

  async emitRealtimeOrderEventNonFatal(
    payload: {
      event: 'order:paid' | 'order:updated' | 'order:packed' | 'order:shipped' | 'order:delivered';
      orderId: string;
      orderCode: string;
      status: string;
      shipment?: ShipmentDTO | null;
      trackingEvent?: Record<string, unknown> | null;
    },
    trace: string | TraceContext,
  ): Promise<void> {
    const correlationId = this.getCorrelationId(trace);
    try {
      const res = await this.fetchJson(
        `${this.config.upstreams.bffUrl}/internal/realtime/order-event`,
        {
          method: 'POST',
          headers: this.buildTraceHeaders(trace, {
            'Content-Type': 'application/json',
            'x-internal-secret': this.config.internalServiceSecret,
          }),
          body: JSON.stringify({
            event: payload.event,
            orderId: payload.orderId,
            orderCode: payload.orderCode,
            status: payload.status,
            ...(payload.shipment ? { shipment: payload.shipment } : {}),
            ...(payload.trackingEvent ? { trackingEvent: payload.trackingEvent } : {}),
            payload: {
              orderId: payload.orderId,
              orderCode: payload.orderCode,
              status: payload.status,
              ...(payload.shipment ? { shipment: payload.shipment } : {}),
              ...(payload.trackingEvent ? { trackingEvent: payload.trackingEvent } : {}),
            },
          }),
        },
        2500,
      );
      if (!res.ok) {
        this.logger.warn(
          { status: res.status, event: payload.event, orderCode: payload.orderCode, correlationId },
          'Non-fatal BFF realtime order-event returned non-OK status',
        );
      }
    } catch (error: unknown) {
      this.logger.warn(
        { err: error instanceof Error ? error.message : String(error), correlationId },
        'Non-fatal BFF realtime order-event failed',
      );
    }
  }
}
