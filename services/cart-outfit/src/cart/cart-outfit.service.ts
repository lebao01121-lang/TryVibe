import { randomBytes, randomUUID } from 'node:crypto';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import {
  AddCartItemSchema,
  AddOutfitBundleSchema,
  CreateSavedOutfitSchema,
  ErrorCode,
  MergeCartRequestSchema,
  OutfitSlot,
  OutfitSlotSchema,
  OutfitStudioPreviewRequestSchema,
  UpdateCartPackagingSchema,
  type CartDto,
  type CartItemDto,
  type OutfitStudioPreviewResponse,
  type OutfitStudioSlotItem,
  type SavedOutfitDto,
} from '@atelier/contracts';
import type { AtelierDbExecutor } from '@atelier/db-client';
import { CartRedisService } from '../cache/cart-redis.service';
import {
  UpstreamClientService,
  type CatalogSkuSnapshot,
} from '../clients/upstream.client';
import { CartApiException } from '../common/cart-api.exception';
import {
  CART_CONFIG_TOKEN,
  type CartOutfitConfig,
} from '../config/env';
import { CartDbService } from '../db/cart-db.service';
import {
  computeCartTotals,
  computeComboDiscountPct,
  countDistinctSlots,
} from './pricing';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHARE_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const PatchCartItemSchema = z
  .object({
    qty: z.number().int().min(0).max(99).optional(),
    skuId: z.string().min(1).optional(),
  })
  .refine((v: { qty?: number; skuId?: string }) => v.qty !== undefined || v.skuId !== undefined, {
    message: 'Either qty or skuId must be provided',
  });

const InternalClearCartSchema = z
  .object({
    userId: z.string().min(1).nullable().optional(),
    guestSessionId: z.string().min(1).nullable().optional(),
    skuIds: z.array(z.string().min(1)).optional(),
  })
  .refine((v) => Boolean(v.userId || v.guestSessionId), {
    message: 'Either userId or guestSessionId is required',
  });

export interface CartActorContext {
  correlationId: string;
  traceparent?: string;
  userId: string | null;
  guestSessionId: string | null;
}

interface CartOwnerTarget {
  ownerKey: string;
  redisKey: string;
  userId: string | null;
  guestSessionId: string | null;
}

interface PersistedCartItem {
  id: string;
  skuId: string;
  productId: string;
  variantId: string;
  slot: OutfitSlot | null;
  qty: number;
  bundleGroupId: string | null;
  fromAiTryon: boolean;
  createdAt: string;
}

interface PersistedCartState {
  cartId: string | null;
  ownerKey: string;
  userId: string | null;
  guestSessionId: string | null;
  packagingOptionId: string | null;
  giftNote: string;
  items: PersistedCartItem[];
  updatedAt: string;
}

interface CartRow {
  id: string;
  owner_key: string;
  user_id: string | null;
  guest_session_id: string | null;
  packaging_option_id: string | null;
  gift_note: string | null;
  updated_at: Date | string;
}

interface CartItemRow {
  id: string;
  cart_id: string;
  sku_id: string;
  product_id: string;
  variant_id: string;
  slot: string | null;
  qty: number;
  bundle_group_id: string | null;
  from_ai_tryon: boolean;
  created_at: Date | string;
}

interface SavedOutfitRow {
  id: string;
  user_id: string | null;
  guest_session_id: string | null;
  share_code: string;
  title: string;
  slots_jsonb: OutfitStudioSlotItem[] | string;
  packaging_option_id: string | null;
  gift_note: string | null;
  preview_url: string | null;
  created_at: Date | string;
}

function isValidUuid(value: string | null | undefined): value is string {
  return typeof value === 'string' && UUID_REGEX.test(value.trim());
}

function toIsoString(value: Date | string | null | undefined): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }
  return new Date().toISOString();
}

function normalizeSlot(raw: string | null | undefined): OutfitSlot | null {
  if (!raw) {
    return null;
  }
  const parsed = OutfitSlotSchema.safeParse(raw);
  return parsed.success ? parsed.data : OutfitSlot.TOP;
}

function parseSlotsJson(raw: OutfitStudioSlotItem[] | string): OutfitStudioSlotItem[] {
  if (Array.isArray(raw)) {
    return raw;
  }
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? (parsed as OutfitStudioSlotItem[]) : [];
    } catch {
      return [];
    }
  }
  return [];
}

function generateShareCode(): string {
  const bytes = randomBytes(6);
  let suffix = '';
  for (let i = 0; i < 6; i += 1) {
    suffix += SHARE_CODE_ALPHABET[bytes[i] % SHARE_CODE_ALPHABET.length];
  }
  return `ATEL${suffix}`;
}

@Injectable()
export class CartOutfitService {
  constructor(
    @Inject(CART_CONFIG_TOKEN) private readonly config: CartOutfitConfig,
    private readonly db: CartDbService,
    private readonly redis: CartRedisService,
    private readonly upstream: UpstreamClientService,
  ) {}

  private resolveOwnerTarget(actor: CartActorContext): CartOwnerTarget {
    if (actor.userId) {
      return {
        ownerKey: `user:${actor.userId}`,
        redisKey: `cart:user:${actor.userId}`,
        userId: actor.userId,
        guestSessionId: null,
      };
    }
    if (actor.guestSessionId) {
      return {
        ownerKey: `guest:${actor.guestSessionId}`,
        redisKey: `cart:guest:${actor.guestSessionId}`,
        userId: null,
        guestSessionId: actor.guestSessionId,
      };
    }
    throw new CartApiException(
      HttpStatus.BAD_REQUEST,
      ErrorCode.VALIDATION_ERROR,
      'Thiếu định danh giỏ hàng (x-user-id hoặc x-guest-session-id). / Missing cart identity header.',
    );
  }

  private emptyPersistedState(owner: CartOwnerTarget): PersistedCartState {
    return {
      cartId: null,
      ownerKey: owner.ownerKey,
      userId: owner.userId,
      guestSessionId: owner.guestSessionId,
      packagingOptionId: null,
      giftNote: '',
      items: [],
      updatedAt: new Date().toISOString(),
    };
  }

  private mapCartItemRow(row: CartItemRow): PersistedCartItem {
    return {
      id: row.id,
      skuId: row.sku_id,
      productId: row.product_id,
      variantId: row.variant_id,
      slot: normalizeSlot(row.slot),
      qty: Number(row.qty),
      bundleGroupId: row.bundle_group_id ?? null,
      fromAiTryon: Boolean(row.from_ai_tryon),
      createdAt: toIsoString(row.created_at),
    };
  }

  private async loadStateFromDb(
    executor: AtelierDbExecutor,
    owner: CartOwnerTarget,
  ): Promise<PersistedCartState | null> {
    const cartRes = await executor.query<CartRow>(
      `
      SELECT id, owner_key, user_id, guest_session_id, packaging_option_id, gift_note, updated_at
      FROM carts
      WHERE owner_key = $1
      LIMIT 1
      `,
      [owner.ownerKey],
    );
    const cartRow = cartRes.rows[0];
    if (!cartRow) {
      return null;
    }

    const itemsRes = await executor.query<CartItemRow>(
      `
      SELECT id, cart_id, sku_id, product_id, variant_id, slot, qty, bundle_group_id, from_ai_tryon, created_at
      FROM cart_items
      WHERE cart_id = $1
      ORDER BY created_at ASC, id ASC
      `,
      [cartRow.id],
    );

    return {
      cartId: cartRow.id,
      ownerKey: cartRow.owner_key,
      userId: cartRow.user_id ?? owner.userId,
      guestSessionId: cartRow.guest_session_id ?? owner.guestSessionId,
      packagingOptionId: cartRow.packaging_option_id ?? null,
      giftNote: cartRow.gift_note ?? '',
      items: itemsRes.rows.map((r: CartItemRow) => this.mapCartItemRow(r)),
      updatedAt: toIsoString(cartRow.updated_at),
    };
  }

  private async ensureCartRow(
    tx: AtelierDbExecutor,
    owner: CartOwnerTarget,
  ): Promise<CartRow> {
    const existing = await tx.query<CartRow>(
      `
      SELECT id, owner_key, user_id, guest_session_id, packaging_option_id, gift_note, updated_at
      FROM carts
      WHERE owner_key = $1
      LIMIT 1
      `,
      [owner.ownerKey],
    );
    if (existing.rows[0]) {
      return existing.rows[0];
    }

    const cartId = randomUUID();
    const inserted = await tx.query<CartRow>(
      `
      INSERT INTO carts (id, owner_key, user_id, guest_session_id, packaging_option_id, gift_note, updated_at)
      VALUES ($1, $2, $3, $4, NULL, '', NOW())
      ON CONFLICT (owner_key) DO UPDATE SET updated_at = NOW()
      RETURNING id, owner_key, user_id, guest_session_id, packaging_option_id, gift_note, updated_at
      `,
      [cartId, owner.ownerKey, owner.userId, owner.guestSessionId],
    );
    return inserted.rows[0];
  }

  private async loadActiveCartState(owner: CartOwnerTarget): Promise<PersistedCartState> {
    const cached = await this.redis.getJson<PersistedCartState>(owner.redisKey);
    if (cached && cached.ownerKey === owner.ownerKey && Array.isArray(cached.items)) {
      return cached;
    }

    const fromDb = await this.loadStateFromDb(this.db, owner);
    const state = fromDb ?? this.emptyPersistedState(owner);
    if (fromDb) {
      await this.redis.setJson(owner.redisKey, state, this.config.cartRedisTtlSeconds);
    }
    return state;
  }

  private async resolveSkuAndStock(
    skuIds: string[],
    correlationId: string,
    traceparent?: string,
  ): Promise<{
    catalogReachable: boolean;
    skus: Map<string, CatalogSkuSnapshot>;
    inventoryReachable: boolean;
    availability: Map<
      string,
      { availableQty: number; inStock: boolean; lowStockWarning: boolean }
    >;
  }> {
    const [skuRes, availRes] = await Promise.all([
      this.upstream.fetchSkusSnapshot(skuIds, correlationId, traceparent),
      this.upstream.fetchBatchAvailability(skuIds, correlationId, traceparent),
    ]);

    const availability = new Map<
      string,
      { availableQty: number; inStock: boolean; lowStockWarning: boolean }
    >();

    for (const skuId of skuIds) {
      const live = availRes.map.get(skuId);
      if (live) {
        const availableQty = Math.max(0, Math.trunc(Number(live.availableQty ?? 0)));
        availability.set(skuId, {
          availableQty,
          inStock: Boolean(live.inStock && availableQty > 0),
          lowStockWarning: Boolean(
            live.lowStockWarning || (availableQty > 0 && availableQty <= 3),
          ),
        });
      } else {
        const snap = skuRes.map.get(skuId);
        const fallbackInStock = snap ? snap.inStock : true;
        const fallbackQty = fallbackInStock ? 20 : 0;
        availability.set(skuId, {
          availableQty: fallbackQty,
          inStock: fallbackInStock,
          lowStockWarning: false,
        });
      }
    }

    return {
      catalogReachable: skuRes.reachable,
      skus: skuRes.map,
      inventoryReachable: availRes.reachable,
      availability,
    };
  }

  private async hydrateCartDto(
    state: PersistedCartState,
    owner: CartOwnerTarget,
    correlationId: string,
    traceparent?: string,
  ): Promise<CartDto> {
    const skuIds = state.items.map((item) => item.skuId);
    const [resolved, packagingInfo] = await Promise.all([
      this.resolveSkuAndStock(skuIds, correlationId, traceparent),
      this.upstream.resolvePackagingOption(state.packagingOptionId, correlationId, traceparent),
    ]);

    const hydratedItems: CartItemDto[] = state.items.map((item) => {
      const snap = resolved.skus.get(item.skuId);
      const stock = resolved.availability.get(item.skuId) ?? {
        availableQty: snap?.inStock === false ? 0 : 20,
        inStock: snap?.inStock !== false,
        lowStockWarning: false,
      };
      const unitPriceVnd = snap ? snap.effectivePriceVnd : 0;
      return {
        id: item.id,
        skuId: item.skuId,
        productId: snap?.productId || item.productId,
        variantId: snap?.variantId || item.variantId,
        slug: snap?.productSlug || item.productId,
        productName: snap?.productName || 'Thiết kế Tầm Xuân',
        colorName: snap?.colorName || 'Mặc định',
        colorHex: snap?.colorHex || '#1C1410',
        sizeCode: snap?.sizeCode || 'M',
        imageUrl: snap?.imageUrl ?? null,
        slot: item.slot,
        unitPriceVnd,
        qty: item.qty,
        lineTotalVnd: unitPriceVnd * item.qty,
        bundleGroupId: item.bundleGroupId,
        fromAiTryon: item.fromAiTryon,
        availableQty: stock.availableQty,
        inStock: stock.inStock,
        lowStockWarning: stock.lowStockWarning,
      };
    });

    const packagingPriceVnd = packagingInfo ? packagingInfo.priceVnd : 0;
    const totals = computeCartTotals(
      hydratedItems,
      packagingPriceVnd,
      this.config.freeShipThresholdVnd,
    );

    return {
      cartKey: owner.redisKey,
      items: hydratedItems,
      packagingOptionId: state.packagingOptionId,
      packagingName: packagingInfo ? packagingInfo.name : null,
      packagingPriceVnd,
      giftNote: state.giftNote || null,
      subtotalVnd: totals.subtotalVnd,
      comboDiscountPct: totals.comboDiscountPct,
      comboDiscountVnd: totals.comboDiscountVnd,
      totalVnd: totals.totalVnd,
      totalQty: totals.totalQty,
      freeShipThresholdVnd: totals.freeShipThresholdVnd,
      remainingForFreeShipVnd: totals.remainingForFreeShipVnd,
      updatedAt: state.updatedAt,
    };
  }

  private assertAuthoritativeSku(
    skuId: string,
    snap: CatalogSkuSnapshot | undefined,
    catalogReachable: boolean,
    fallbackProductId?: string,
    fallbackVariantId?: string,
  ): { productId: string; variantId: string } {
    if (snap) {
      return { productId: snap.productId, variantId: snap.variantId };
    }
    if (catalogReachable) {
      throw new CartApiException(
        HttpStatus.NOT_FOUND,
        ErrorCode.NOT_FOUND,
        `Không tìm thấy SKU "${skuId}" trong danh mục sản phẩm. / SKU not found in catalog.`,
        { skuId },
      );
    }
    if (isValidUuid(fallbackProductId) && isValidUuid(fallbackVariantId)) {
      return { productId: fallbackProductId, variantId: fallbackVariantId };
    }
    throw new CartApiException(
      HttpStatus.SERVICE_UNAVAILABLE,
      ErrorCode.DEPENDENCY_UNAVAILABLE,
      'Dịch vụ danh mục tạm thời không khả dụng để xác thực SKU. / Catalog service unavailable to resolve SKU.',
      { skuId },
    );
  }

  // ============================================================================
  // Cart Operations
  // ============================================================================

  async getCart(actor: CartActorContext): Promise<CartDto> {
    const owner = this.resolveOwnerTarget(actor);
    const state = await this.loadActiveCartState(owner);
    return this.hydrateCartDto(state, owner, actor.correlationId, actor.traceparent);
  }

  async addItem(rawBody: unknown, actor: CartActorContext): Promise<CartDto> {
    const parsed = AddCartItemSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new CartApiException(
        HttpStatus.BAD_REQUEST,
        ErrorCode.VALIDATION_ERROR,
        'Dữ liệu thêm sản phẩm vào giỏ không hợp lệ. / Invalid add-to-cart payload.',
        { issues: parsed.error.issues },
      );
    }

    const input = parsed.data;
    if (!isValidUuid(input.skuId)) {
      throw new CartApiException(
        HttpStatus.BAD_REQUEST,
        ErrorCode.VALIDATION_ERROR,
        'skuId phải là UUID hợp lệ. / skuId must be a valid UUID.',
      );
    }

    const owner = this.resolveOwnerTarget(actor);
    const resolved = await this.resolveSkuAndStock([input.skuId], actor.correlationId);
    const snap = resolved.skus.get(input.skuId);
    const { productId, variantId } = this.assertAuthoritativeSku(
      input.skuId,
      snap,
      resolved.catalogReachable,
      input.productId,
      input.variantId,
    );

    const stock = resolved.availability.get(input.skuId) ?? {
      availableQty: 20,
      inStock: true,
      lowStockWarning: false,
    };

    const nextState = await this.db.transaction(async (tx) => {
      const cartRow = await this.ensureCartRow(tx, owner);
      const bundleGroupId = input.bundleGroupId ?? null;

      const existingRes = await tx.query<CartItemRow>(
        bundleGroupId === null
          ? `
            SELECT id, cart_id, sku_id, product_id, variant_id, slot, qty, bundle_group_id, from_ai_tryon, created_at
            FROM cart_items
            WHERE cart_id = $1 AND sku_id = $2 AND bundle_group_id IS NULL
            LIMIT 1
          `
          : `
            SELECT id, cart_id, sku_id, product_id, variant_id, slot, qty, bundle_group_id, from_ai_tryon, created_at
            FROM cart_items
            WHERE cart_id = $1 AND sku_id = $2 AND bundle_group_id = $3
            LIMIT 1
          `,
        bundleGroupId === null ? [cartRow.id, input.skuId] : [cartRow.id, input.skuId, bundleGroupId],
      );

      const existing = existingRes.rows[0];
      const nextQty = existing ? Number(existing.qty) + input.qty : input.qty;

      if (nextQty > stock.availableQty) {
        throw new CartApiException(
          HttpStatus.CONFLICT,
          ErrorCode.INSUFFICIENT_STOCK,
          stock.availableQty === 0
            ? 'Sản phẩm hiện đã hết hàng. / Selected SKU is out of stock.'
            : `Chỉ còn ${stock.availableQty} sản phẩm khả dụng trong kho. / Requested quantity exceeds available stock.`,
          {
            skuId: input.skuId,
            requestedQty: nextQty,
            availableQty: stock.availableQty,
          },
        );
      }

      if (existing) {
        const mergedFromAiTryon = Boolean(existing.from_ai_tryon || input.fromAiTryon);
        const nextSlot = input.slot ?? normalizeSlot(existing.slot) ?? OutfitSlot.TOP;
        await tx.query(
          `
          UPDATE cart_items
          SET qty = $2, from_ai_tryon = $3, slot = $4, product_id = $5, variant_id = $6
          WHERE id = $1
          `,
          [existing.id, nextQty, mergedFromAiTryon, nextSlot, productId, variantId],
        );
      } else {
        await tx.query(
          `
          INSERT INTO cart_items (
            id, cart_id, sku_id, product_id, variant_id, slot, qty, bundle_group_id, from_ai_tryon
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          `,
          [
            randomUUID(),
            cartRow.id,
            input.skuId,
            productId,
            variantId,
            input.slot ?? OutfitSlot.TOP,
            input.qty,
            bundleGroupId,
            Boolean(input.fromAiTryon),
          ],
        );
      }

      await tx.query('UPDATE carts SET updated_at = NOW() WHERE id = $1', [cartRow.id]);
      const loaded = await this.loadStateFromDb(tx, owner);
      return loaded ?? this.emptyPersistedState(owner);
    });

    await this.redis.setJson(owner.redisKey, nextState, this.config.cartRedisTtlSeconds);
    return this.hydrateCartDto(nextState, owner, actor.correlationId);
  }

  async addOutfitBundle(rawBody: unknown, actor: CartActorContext): Promise<CartDto> {
    const parsed = AddOutfitBundleSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new CartApiException(
        HttpStatus.BAD_REQUEST,
        ErrorCode.VALIDATION_ERROR,
        'Dữ liệu thêm cả bộ phối đồ không hợp lệ. / Invalid outfit bundle payload.',
        { issues: parsed.error.issues },
      );
    }

    const input = parsed.data;
    for (const item of input.items) {
      if (!isValidUuid(item.skuId)) {
        throw new CartApiException(
          HttpStatus.BAD_REQUEST,
          ErrorCode.VALIDATION_ERROR,
          `skuId "${item.skuId}" phải là UUID hợp lệ. / Invalid skuId UUID.`,
        );
      }
    }

    const owner = this.resolveOwnerTarget(actor);
    const skuIds = input.items.map((i) => i.skuId);
    const resolved = await this.resolveSkuAndStock(skuIds, actor.correlationId);

    // Validate all SKUs exist and sum requested qty per SKU against live availability (NEVER reserves!)
    const qtyBySku = new Map<string, number>();
    const authoritativeBySku = new Map<string, { productId: string; variantId: string }>();

    for (const item of input.items) {
      const auth = this.assertAuthoritativeSku(
        item.skuId,
        resolved.skus.get(item.skuId),
        resolved.catalogReachable,
        item.productId,
        item.variantId,
      );
      authoritativeBySku.set(item.skuId, auth);
      qtyBySku.set(item.skuId, (qtyBySku.get(item.skuId) ?? 0) + item.qty);
    }

    for (const [skuId, requestedQty] of qtyBySku.entries()) {
      const stock = resolved.availability.get(skuId) ?? {
        availableQty: 20,
        inStock: true,
        lowStockWarning: false,
      };
      if (requestedQty > stock.availableQty) {
        throw new CartApiException(
          HttpStatus.CONFLICT,
          ErrorCode.INSUFFICIENT_STOCK,
          `Sản phẩm trong bộ phối không đủ tồn kho (còn ${stock.availableQty} chiếc). / Outfit bundle item exceeds available stock.`,
          { skuId, requestedQty, availableQty: stock.availableQty },
        );
      }
    }

    const bundleGroupId = `bundle-${randomUUID().replace(/-/g, '').slice(0, 8)}`;

    const nextState = await this.db.transaction(async (tx) => {
      const cartRow = await this.ensureCartRow(tx, owner);

      for (const item of input.items) {
        const auth = authoritativeBySku.get(item.skuId)!;
        await tx.query(
          `
          INSERT INTO cart_items (
            id, cart_id, sku_id, product_id, variant_id, slot, qty, bundle_group_id, from_ai_tryon
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          `,
          [
            randomUUID(),
            cartRow.id,
            item.skuId,
            auth.productId,
            auth.variantId,
            item.slot,
            item.qty,
            bundleGroupId,
            Boolean(item.fromAiTryon),
          ],
        );
      }

      const nextPackaging =
        input.packagingOptionId !== undefined
          ? input.packagingOptionId
          : cartRow.packaging_option_id;
      const nextGiftNote =
        input.giftNote !== undefined ? (input.giftNote ?? '') : (cartRow.gift_note ?? '');

      await tx.query(
        `
        UPDATE carts
        SET packaging_option_id = $2, gift_note = $3, updated_at = NOW()
        WHERE id = $1
        `,
        [cartRow.id, nextPackaging, nextGiftNote],
      );

      const loaded = await this.loadStateFromDb(tx, owner);
      return loaded ?? this.emptyPersistedState(owner);
    });

    await this.redis.setJson(owner.redisKey, nextState, this.config.cartRedisTtlSeconds);
    return this.hydrateCartDto(nextState, owner, actor.correlationId);
  }

  private async assertCartItemOwnership(
    executor: AtelierDbExecutor,
    itemId: string,
    owner: CartOwnerTarget,
  ): Promise<{ cartId: string }> {
    const res = await executor.query<{ id: string; cart_id: string; owner_key: string }>(
      `
      SELECT ci.id, ci.cart_id, c.owner_key
      FROM cart_items ci
      JOIN carts c ON c.id = ci.cart_id
      WHERE ci.id = $1
      LIMIT 1
      `,
      [itemId],
    );
    const row = res.rows[0];
    if (!row) {
      throw new CartApiException(
        HttpStatus.NOT_FOUND,
        ErrorCode.NOT_FOUND,
        `Không tìm thấy mục giỏ hàng "${itemId}". / Cart item not found.`,
      );
    }
    if (row.owner_key !== owner.ownerKey) {
      throw new CartApiException(
        HttpStatus.FORBIDDEN,
        ErrorCode.FORBIDDEN,
        'Bạn không có quyền thao tác mục giỏ hàng của khách hàng khác. / Cross-user cart item access denied.',
        { itemId },
      );
    }
    return { cartId: row.cart_id };
  }

  async updateItem(
    itemId: string,
    rawBody: unknown,
    actor: CartActorContext,
  ): Promise<CartDto> {
    if (!isValidUuid(itemId)) {
      throw new CartApiException(
        HttpStatus.NOT_FOUND,
        ErrorCode.NOT_FOUND,
        `Không tìm thấy mục giỏ hàng "${itemId}". / Cart item not found.`,
      );
    }

    const parsed = PatchCartItemSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new CartApiException(
        HttpStatus.BAD_REQUEST,
        ErrorCode.VALIDATION_ERROR,
        'Dữ liệu cập nhật mục giỏ hàng không hợp lệ. / Invalid cart item update payload.',
        { issues: parsed.error.issues },
      );
    }

    const input = parsed.data;
    if (input.skuId !== undefined && !isValidUuid(input.skuId)) {
      throw new CartApiException(
        HttpStatus.BAD_REQUEST,
        ErrorCode.VALIDATION_ERROR,
        'skuId mới phải là UUID hợp lệ. / Replacement skuId must be a valid UUID.',
      );
    }

    const owner = this.resolveOwnerTarget(actor);
    // Strict owner_key IDOR verification before touching any item
    const { cartId } = await this.assertCartItemOwnership(this.db, itemId, owner);

    const currentState = await this.loadActiveCartState(owner);
    const existingItem = currentState.items.find((i) => i.id === itemId);

    if (!existingItem) {
      throw new CartApiException(
        HttpStatus.NOT_FOUND,
        ErrorCode.NOT_FOUND,
        `Không tìm thấy mục giỏ hàng "${itemId}". / Cart item not found.`,
      );
    }

    // Remove item if qty <= 0
    if (input.qty !== undefined && input.qty <= 0) {
      return this.deleteItem(itemId, actor);
    }

    const targetSkuId = input.skuId ?? existingItem.skuId;
    const targetQty = input.qty ?? existingItem.qty;

    const resolved = await this.resolveSkuAndStock(
      [targetSkuId],
      actor.correlationId,
      actor.traceparent,
    );
    let nextProductId = existingItem.productId;
    let nextVariantId = existingItem.variantId;

    if (targetSkuId !== existingItem.skuId) {
      const auth = this.assertAuthoritativeSku(
        targetSkuId,
        resolved.skus.get(targetSkuId),
        resolved.catalogReachable,
      );
      nextProductId = auth.productId;
      nextVariantId = auth.variantId;
    }

    const stock = resolved.availability.get(targetSkuId) ?? {
      availableQty: 20,
      inStock: true,
      lowStockWarning: false,
    };
    if (targetQty > stock.availableQty) {
      throw new CartApiException(
        HttpStatus.CONFLICT,
        ErrorCode.INSUFFICIENT_STOCK,
        `Chỉ còn ${stock.availableQty} sản phẩm khả dụng trong kho. / Requested quantity exceeds available stock.`,
        { skuId: targetSkuId, requestedQty: targetQty, availableQty: stock.availableQty },
      );
    }

    const nextState = await this.db.transaction(async (tx) => {
      await this.assertCartItemOwnership(tx, itemId, owner);
      await tx.query(
        `
        UPDATE cart_items
        SET sku_id = $2, product_id = $3, variant_id = $4, qty = $5
        WHERE id = $1 AND cart_id = $6
        `,
        [itemId, targetSkuId, nextProductId, nextVariantId, targetQty, cartId],
      );
      await tx.query('UPDATE carts SET updated_at = NOW() WHERE id = $1', [cartId]);
      const loaded = await this.loadStateFromDb(tx, owner);
      return loaded ?? this.emptyPersistedState(owner);
    });

    await this.redis.setJson(owner.redisKey, nextState, this.config.cartRedisTtlSeconds);
    return this.hydrateCartDto(nextState, owner, actor.correlationId, actor.traceparent);
  }

  async deleteItem(itemId: string, actor: CartActorContext): Promise<CartDto> {
    if (!isValidUuid(itemId)) {
      throw new CartApiException(
        HttpStatus.NOT_FOUND,
        ErrorCode.NOT_FOUND,
        `Không tìm thấy mục giỏ hàng "${itemId}". / Cart item not found.`,
      );
    }

    const owner = this.resolveOwnerTarget(actor);
    const nextState = await this.db.transaction(async (tx) => {
      // Strict owner_key IDOR check (returns 403 if item belongs to another customer, 404 if missing)
      const { cartId } = await this.assertCartItemOwnership(tx, itemId, owner);

      const deleted = await tx.query<{ id: string }>(
        'DELETE FROM cart_items WHERE id = $1 AND cart_id = $2 RETURNING id',
        [itemId, cartId],
      );
      if (deleted.rows.length === 0) {
        throw new CartApiException(
          HttpStatus.NOT_FOUND,
          ErrorCode.NOT_FOUND,
          `Không tìm thấy mục giỏ hàng "${itemId}". / Cart item not found.`,
        );
      }

      await tx.query('UPDATE carts SET updated_at = NOW() WHERE id = $1', [cartId]);
      const loaded = await this.loadStateFromDb(tx, owner);
      return loaded ?? this.emptyPersistedState(owner);
    });

    await this.redis.setJson(owner.redisKey, nextState, this.config.cartRedisTtlSeconds);
    return this.hydrateCartDto(nextState, owner, actor.correlationId, actor.traceparent);
  }

  async updatePackaging(rawBody: unknown, actor: CartActorContext): Promise<CartDto> {
    const parsed = UpdateCartPackagingSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new CartApiException(
        HttpStatus.BAD_REQUEST,
        ErrorCode.VALIDATION_ERROR,
        'Thông tin đóng gói hoặc lời nhắn thiệp (tối đa 140 ký tự) không hợp lệ. / Invalid packaging or gift note payload.',
        { issues: parsed.error.issues },
      );
    }

    const input = parsed.data;
    const owner = this.resolveOwnerTarget(actor);

    const nextState = await this.db.transaction(async (tx) => {
      const cartRow = await this.ensureCartRow(tx, owner);
      const nextPackaging =
        input.packagingOptionId !== undefined
          ? input.packagingOptionId
          : cartRow.packaging_option_id;
      const nextGiftNote =
        input.giftNote !== undefined ? (input.giftNote ?? '') : (cartRow.gift_note ?? '');

      await tx.query(
        `
        UPDATE carts
        SET packaging_option_id = $2, gift_note = $3, updated_at = NOW()
        WHERE id = $1
        `,
        [cartRow.id, nextPackaging, nextGiftNote],
      );

      const loaded = await this.loadStateFromDb(tx, owner);
      return loaded ?? this.emptyPersistedState(owner);
    });

    await this.redis.setJson(owner.redisKey, nextState, this.config.cartRedisTtlSeconds);
    return this.hydrateCartDto(nextState, owner, actor.correlationId);
  }

  /**
   * Idempotent Guest-to-User Cart Merge:
   * - Loads guest cart; if missing/empty, returns user cart untouched (zero duplication).
   * - Inside single transaction: merges matching (skuId, bundleGroupId) capped at live availableQty,
   *   preserves distinct bundleGroupId & fromAiTryon flags, copies guest packaging/giftNote if user lacked them,
   *   and deletes guest cart from cart_db.
   * - Immediately deletes `cart:guest:{guestSessionId}` from Redis and writes through `cart:user:{userId}`.
   */
  async mergeGuestCart(rawBody: unknown, actor: CartActorContext): Promise<CartDto> {
    if (!actor.userId) {
      throw new CartApiException(
        HttpStatus.UNAUTHORIZED,
        ErrorCode.UNAUTHORIZED,
        'Yêu cầu đăng nhập hợp lệ (x-user-id) để gộp giỏ hàng. / Authenticated user required for cart merge.',
      );
    }

    const bodyRecord = rawBody && typeof rawBody === 'object' ? (rawBody as Record<string, unknown>) : {};
    const candidateGuestId =
      typeof bodyRecord.guestSessionId === 'string' && bodyRecord.guestSessionId.trim().length > 0
        ? bodyRecord.guestSessionId.trim()
        : actor.guestSessionId;

    const parsed = MergeCartRequestSchema.safeParse({ guestSessionId: candidateGuestId ?? '' });
    if (!parsed.success) {
      throw new CartApiException(
        HttpStatus.BAD_REQUEST,
        ErrorCode.VALIDATION_ERROR,
        'Thiếu guestSessionId hợp lệ để gộp giỏ hàng. / Missing valid guestSessionId.',
        { issues: parsed.error.issues },
      );
    }

    const guestSessionId = parsed.data.guestSessionId.trim();
    const userOwner: CartOwnerTarget = {
      ownerKey: `user:${actor.userId}`,
      redisKey: `cart:user:${actor.userId}`,
      userId: actor.userId,
      guestSessionId: null,
    };
    const guestOwner: CartOwnerTarget = {
      ownerKey: `guest:${guestSessionId}`,
      redisKey: `cart:guest:${guestSessionId}`,
      userId: null,
      guestSessionId,
    };

    const preGuestState = await this.loadActiveCartState(guestOwner);
    const hasGuestData =
      preGuestState.items.length > 0 ||
      Boolean(preGuestState.packagingOptionId) ||
      preGuestState.giftNote.trim().length > 0;

    if (!hasGuestData) {
      await this.redis.del(guestOwner.redisKey);
      const userState = await this.loadActiveCartState(userOwner);
      return this.hydrateCartDto(userState, userOwner, actor.correlationId);
    }

    const preUserState = await this.loadActiveCartState(userOwner);
    const allSkuIds = Array.from(
      new Set([
        ...preGuestState.items.map((i) => i.skuId),
        ...preUserState.items.map((i) => i.skuId),
      ]),
    );
    const availRes = await this.upstream.fetchBatchAvailability(allSkuIds, actor.correlationId);

    const mergedState = await this.db.transaction(async (tx) => {
      const dbGuestState = await this.loadStateFromDb(tx, guestOwner);
      const guestHasContent =
        dbGuestState !== null &&
        (dbGuestState.items.length > 0 ||
          Boolean(dbGuestState.packagingOptionId) ||
          dbGuestState.giftNote.trim().length > 0);

      if (!guestHasContent || !dbGuestState || !dbGuestState.cartId) {
        const existingUser = await this.loadStateFromDb(tx, userOwner);
        return existingUser ?? this.emptyPersistedState(userOwner);
      }

      const userCartRow = await this.ensureCartRow(tx, userOwner);
      const existingUserItemsRes = await tx.query<CartItemRow>(
        `
        SELECT id, cart_id, sku_id, product_id, variant_id, slot, qty, bundle_group_id, from_ai_tryon, created_at
        FROM cart_items
        WHERE cart_id = $1
        ORDER BY created_at ASC, id ASC
        `,
        [userCartRow.id],
      );
      const userItems = existingUserItemsRes.rows.map((r: CartItemRow) => this.mapCartItemRow(r));

      for (const guestItem of dbGuestState.items) {
        const liveAvail = availRes.map.get(guestItem.skuId);
        const capQty = liveAvail
          ? Math.max(1, Math.min(99, Number(liveAvail.availableQty)))
          : 99;

        const matchingUserItem = userItems.find(
          (u: PersistedCartItem) =>
            u.skuId === guestItem.skuId &&
            (u.bundleGroupId ?? null) === (guestItem.bundleGroupId ?? null),
        );

        if (matchingUserItem) {
          const summed = matchingUserItem.qty + guestItem.qty;
          const capped = Math.max(1, Math.min(summed, capQty));
          const mergedFromAi = Boolean(matchingUserItem.fromAiTryon || guestItem.fromAiTryon);
          await tx.query(
            `
            UPDATE cart_items
            SET qty = $2, from_ai_tryon = $3
            WHERE id = $1
            `,
            [matchingUserItem.id, capped, mergedFromAi],
          );
          matchingUserItem.qty = capped;
          matchingUserItem.fromAiTryon = mergedFromAi;
        } else {
          const insertedQty = Math.max(1, Math.min(guestItem.qty, capQty));
          const newItemId = randomUUID();
          await tx.query(
            `
            INSERT INTO cart_items (
              id, cart_id, sku_id, product_id, variant_id, slot, qty, bundle_group_id, from_ai_tryon
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            `,
            [
              newItemId,
              userCartRow.id,
              guestItem.skuId,
              guestItem.productId,
              guestItem.variantId,
              guestItem.slot ?? OutfitSlot.TOP,
              insertedQty,
              guestItem.bundleGroupId,
              guestItem.fromAiTryon,
            ],
          );
          userItems.push({
            ...guestItem,
            id: newItemId,
            qty: insertedQty,
          });
        }
      }

      const nextPackaging =
        userCartRow.packaging_option_id || dbGuestState.packagingOptionId || null;
      const existingGiftNote = (userCartRow.gift_note ?? '').trim();
      const nextGiftNote = existingGiftNote.length > 0 ? existingGiftNote : dbGuestState.giftNote;

      await tx.query(
        `
        UPDATE carts
        SET packaging_option_id = $2, gift_note = $3, updated_at = NOW()
        WHERE id = $1
        `,
        [userCartRow.id, nextPackaging, nextGiftNote],
      );

      // Re-assign guest saved outfits to the authenticated user
      await tx.query(
        `
        UPDATE saved_outfits
        SET user_id = $1
        WHERE guest_session_id = $2 AND user_id IS NULL
        `,
        [actor.userId, guestSessionId],
      );

      // Immediately purge guest cart rows inside the same transaction for strict idempotency
      await tx.query('DELETE FROM carts WHERE id = $1', [dbGuestState.cartId]);

      const reloaded = await this.loadStateFromDb(tx, userOwner);
      return reloaded ?? this.emptyPersistedState(userOwner);
    });

    // Immediately clear guest Redis key and write-through merged user cart
    await Promise.all([
      this.redis.del(guestOwner.redisKey),
      this.redis.setJson(userOwner.redisKey, mergedState, this.config.cartRedisTtlSeconds),
    ]);

    return this.hydrateCartDto(mergedState, userOwner, actor.correlationId);
  }

  // ============================================================================
  // Outfit Studio Operations
  // ============================================================================

  private async hydrateOutfitSlots(
    rawSlots: readonly OutfitStudioSlotItem[],
    correlationId: string,
    strictCatalogCheck: boolean,
  ): Promise<OutfitStudioSlotItem[]> {
    const skuIds = rawSlots.map((s) => s.skuId);
    const resolved = await this.resolveSkuAndStock(skuIds, correlationId);

    return rawSlots.map((slotItem) => {
      const snap = resolved.skus.get(slotItem.skuId);
      if (strictCatalogCheck && !snap && resolved.catalogReachable) {
        throw new CartApiException(
          HttpStatus.NOT_FOUND,
          ErrorCode.NOT_FOUND,
          `Không tìm thấy SKU "${slotItem.skuId}" trong danh mục sản phẩm. / SKU not found in catalog.`,
          { skuId: slotItem.skuId },
        );
      }

      const stock = resolved.availability.get(slotItem.skuId) ?? {
        availableQty: snap?.inStock === false ? 0 : 20,
        inStock: snap?.inStock !== false,
        lowStockWarning: false,
      };

      const unitPriceVnd = snap
        ? snap.effectivePriceVnd
        : Math.max(0, Math.round(slotItem.unitPriceVnd ?? 0));

      return {
        slot: slotItem.slot,
        productId: snap?.productId || slotItem.productId,
        variantId: snap?.variantId || slotItem.variantId,
        skuId: slotItem.skuId,
        slug: snap?.productSlug || slotItem.slug,
        productName: snap?.productName || slotItem.productName || 'Thiết kế Tầm Xuân',
        colorName: snap?.colorName || slotItem.colorName || 'Mặc định',
        colorHex: snap?.colorHex || slotItem.colorHex || '#1C1410',
        sizeCode: snap?.sizeCode || slotItem.sizeCode || 'M',
        imageUrl: snap?.imageUrl ?? slotItem.imageUrl ?? null,
        unitPriceVnd,
        qty: slotItem.qty ?? 1,
        availableQty: stock.availableQty,
        inStock: stock.inStock,
        lowStockWarning: stock.lowStockWarning,
      };
    });
  }

  async previewOutfit(
    rawBody: unknown,
    actor: CartActorContext,
  ): Promise<OutfitStudioPreviewResponse> {
    const parsed = OutfitStudioPreviewRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new CartApiException(
        HttpStatus.BAD_REQUEST,
        ErrorCode.VALIDATION_ERROR,
        'Dữ liệu xem trước set phối đồ không hợp lệ. / Invalid outfit preview payload.',
        { issues: parsed.error.issues },
      );
    }

    const input = parsed.data;
    const [hydratedItems, packagingInfo] = await Promise.all([
      this.hydrateOutfitSlots(input.items, actor.correlationId, true),
      this.upstream.resolvePackagingOption(input.packagingOptionId, actor.correlationId),
    ]);

    const distinctSlotCount = countDistinctSlots(hydratedItems.map((i) => i.slot));
    const comboDiscountPct = computeComboDiscountPct(distinctSlotCount);
    const subtotalVnd = hydratedItems.reduce(
      (sum, item) => sum + (item.unitPriceVnd ?? 0) * (item.qty ?? 1),
      0,
    );
    const comboDiscountVnd = Math.round((subtotalVnd * comboDiscountPct) / 100);
    const packagingPriceVnd = packagingInfo ? packagingInfo.priceVnd : 0;
    const totalVnd = Math.max(0, subtotalVnd - comboDiscountVnd) + packagingPriceVnd;

    const allInStock = hydratedItems.every(
      (item) => Boolean(item.inStock) && (item.availableQty ?? 0) >= (item.qty ?? 1),
    );

    const lowStockItems = hydratedItems
      .filter(
        (item) =>
          Boolean(item.lowStockWarning) ||
          !item.inStock ||
          (item.availableQty ?? 0) < (item.qty ?? 1),
      )
      .map((item) => ({
        skuId: item.skuId,
        ...(item.productName ? { productName: item.productName } : {}),
        availableQty: item.availableQty ?? 0,
      }));

    return {
      items: hydratedItems,
      distinctSlotCount,
      subtotalVnd,
      comboDiscountPct,
      comboDiscountVnd,
      packagingOptionId: input.packagingOptionId ?? null,
      packagingPriceVnd,
      totalVnd,
      giftNote: input.giftNote ?? null,
      allInStock,
      lowStockItems,
    };
  }

  async createSavedOutfit(rawBody: unknown, actor: CartActorContext): Promise<SavedOutfitDto> {
    const parsed = CreateSavedOutfitSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new CartApiException(
        HttpStatus.BAD_REQUEST,
        ErrorCode.VALIDATION_ERROR,
        'Dữ liệu lưu set phối đồ không hợp lệ. / Invalid save-outfit payload.',
        { issues: parsed.error.issues },
      );
    }

    const input = parsed.data;
    const hydratedSlots = await this.hydrateOutfitSlots(
      input.slots,
      actor.correlationId,
      false,
    );

    const id = randomUUID();
    const giftNote = input.giftNote ?? '';
    const packagingOptionId = input.packagingOptionId ?? null;
    const previewUrl = input.previewUrl ?? null;

    let savedRow: SavedOutfitRow | null = null;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const shareCode = generateShareCode();
      try {
        const res = await this.db.query<SavedOutfitRow>(
          `
          INSERT INTO saved_outfits (
            id, user_id, guest_session_id, share_code, title, slots_jsonb,
            packaging_option_id, gift_note, preview_url
          )
          VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)
          RETURNING id, user_id, guest_session_id, share_code, title, slots_jsonb,
                    packaging_option_id, gift_note, preview_url, created_at
          `,
          [
            id,
            actor.userId,
            actor.guestSessionId,
            shareCode,
            input.title,
            JSON.stringify(hydratedSlots),
            packagingOptionId,
            giftNote,
            previewUrl,
          ],
        );
        savedRow = res.rows[0] ?? null;
        if (savedRow) {
          break;
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (attempt < 4 && (msg.includes('unique') || msg.includes('duplicate'))) {
          continue;
        }
        throw err;
      }
    }

    if (!savedRow) {
      throw new CartApiException(
        HttpStatus.INTERNAL_SERVER_ERROR,
        ErrorCode.INTERNAL_ERROR,
        'Không thể tạo mã chia sẻ set phối đồ. / Failed to generate unique outfit shareCode.',
      );
    }

    return {
      id: savedRow.id,
      userId: savedRow.user_id ?? null,
      shareCode: savedRow.share_code,
      title: savedRow.title,
      slots: hydratedSlots,
      packagingOptionId: savedRow.packaging_option_id ?? null,
      giftNote: savedRow.gift_note ? savedRow.gift_note : null,
      previewUrl: savedRow.preview_url ?? null,
      createdAt: toIsoString(savedRow.created_at),
    };
  }

  async getSavedOutfitByShareCode(
    shareCode: string,
    actor: CartActorContext,
  ): Promise<SavedOutfitDto> {
    const normalized = shareCode.trim().toUpperCase();
    if (!normalized || normalized.length > 16) {
      throw new CartApiException(
        HttpStatus.NOT_FOUND,
        ErrorCode.NOT_FOUND,
        `Không tìm thấy set phối đồ với mã "${shareCode}". / Shared outfit not found.`,
      );
    }

    const res = await this.db.query<SavedOutfitRow>(
      `
      SELECT id, user_id, guest_session_id, share_code, title, slots_jsonb,
             packaging_option_id, gift_note, preview_url, created_at
      FROM saved_outfits
      WHERE UPPER(share_code) = $1
      LIMIT 1
      `,
      [normalized],
    );

    const row = res.rows[0];
    if (!row) {
      throw new CartApiException(
        HttpStatus.NOT_FOUND,
        ErrorCode.NOT_FOUND,
        `Không tìm thấy set phối đồ với mã "${normalized}". / Shared outfit not found.`,
      );
    }

    const rawSlots = parseSlotsJson(row.slots_jsonb);
    const hydratedSlots = await this.hydrateOutfitSlots(
      rawSlots,
      actor.correlationId,
      false,
    );

    return {
      id: row.id,
      userId: row.user_id ?? null,
      shareCode: row.share_code,
      title: row.title,
      slots: hydratedSlots,
      packagingOptionId: row.packaging_option_id ?? null,
      giftNote: row.gift_note ? row.gift_note : null,
      previewUrl: row.preview_url ?? null,
      createdAt: toIsoString(row.created_at),
    };
  }

  async listMySavedOutfits(actor: CartActorContext): Promise<SavedOutfitDto[]> {
    if (!actor.userId && !actor.guestSessionId) {
      return [];
    }

    const res = actor.userId
      ? await this.db.query<SavedOutfitRow>(
          `
          SELECT id, user_id, guest_session_id, share_code, title, slots_jsonb,
                 packaging_option_id, gift_note, preview_url, created_at
          FROM saved_outfits
          WHERE user_id = $1
          ORDER BY created_at DESC
          LIMIT 50
          `,
          [actor.userId],
        )
      : await this.db.query<SavedOutfitRow>(
          `
          SELECT id, user_id, guest_session_id, share_code, title, slots_jsonb,
                 packaging_option_id, gift_note, preview_url, created_at
          FROM saved_outfits
          WHERE guest_session_id = $1
          ORDER BY created_at DESC
          LIMIT 50
          `,
          [actor.guestSessionId],
        );

    const results: SavedOutfitDto[] = [];
    for (const row of res.rows) {
      const rawSlots = parseSlotsJson(row.slots_jsonb);
      const hydratedSlots = await this.hydrateOutfitSlots(
        rawSlots,
        actor.correlationId,
        false,
      );
      results.push({
        id: row.id,
        userId: row.user_id ?? null,
        shareCode: row.share_code,
        title: row.title,
        slots: hydratedSlots,
        packagingOptionId: row.packaging_option_id ?? null,
        giftNote: row.gift_note ? row.gift_note : null,
        previewUrl: row.preview_url ?? null,
        createdAt: toIsoString(row.created_at),
      });
    }

    return results;
  }

  async clearCartInternal(
    rawBody: unknown,
    _correlationId: string,
  ): Promise<{
    cleared: boolean;
    deletedItemCount: number;
    clearedKeys: string[];
  }> {
    const parsed = InternalClearCartSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new CartApiException(
        HttpStatus.BAD_REQUEST,
        ErrorCode.VALIDATION_ERROR,
        'Invalid internal cart clear payload',
        { issues: parsed.error.issues },
      );
    }

    const targets: CartOwnerTarget[] = [];
    if (parsed.data.userId && isValidUuid(parsed.data.userId)) {
      const uid = parsed.data.userId.trim();
      targets.push({
        ownerKey: `user:${uid}`,
        redisKey: `cart:user:${uid}`,
        userId: uid,
        guestSessionId: null,
      });
    }
    if (parsed.data.guestSessionId && parsed.data.guestSessionId.trim().length > 0) {
      const gid = parsed.data.guestSessionId.trim().slice(0, 120);
      targets.push({
        ownerKey: `guest:${gid}`,
        redisKey: `cart:guest:${gid}`,
        userId: null,
        guestSessionId: gid,
      });
    }

    const requestedSkuIds = (parsed.data.skuIds ?? []).filter((id) => isValidUuid(id));
    const partialClear = Array.isArray(parsed.data.skuIds) && parsed.data.skuIds.length > 0;
    let deletedItemCount = 0;
    const clearedKeys: string[] = [];

    for (const owner of targets) {
      const updatedState = await this.db.transaction(async (tx) => {
        const cartRes = await tx.query<CartRow>(
          `SELECT id, owner_key, user_id, guest_session_id, packaging_option_id, gift_note, updated_at
           FROM carts
           WHERE owner_key = $1
           LIMIT 1`,
          [owner.ownerKey],
        );
        const cartRow = cartRes.rows[0];
        if (!cartRow) {
          return null;
        }

        if (partialClear) {
          if (requestedSkuIds.length > 0) {
            const delRes = await tx.query<{ id: string }>(
              `DELETE FROM cart_items
               WHERE cart_id = $1 AND sku_id = ANY($2::uuid[])
               RETURNING id`,
              [cartRow.id, requestedSkuIds],
            );
            deletedItemCount += delRes.rows.length;
          }
          await tx.query('UPDATE carts SET updated_at = NOW() WHERE id = $1', [
            cartRow.id,
          ]);
          return this.loadStateFromDb(tx, owner);
        }

        const delRes = await tx.query<{ id: string }>(
          'DELETE FROM cart_items WHERE cart_id = $1 RETURNING id',
          [cartRow.id],
        );
        deletedItemCount += delRes.rows.length;
        await tx.query(
          `UPDATE carts
           SET packaging_option_id = NULL,
               gift_note = '',
               updated_at = NOW()
           WHERE id = $1`,
          [cartRow.id],
        );
        return null;
      });

      clearedKeys.push(owner.redisKey);
      if (updatedState && updatedState.items.length > 0) {
        await this.redis.setJson(owner.redisKey, updatedState);
      } else {
        await this.redis.del(owner.redisKey);
      }
    }

    return {
      cleared: true,
      deletedItemCount,
      clearedKeys,
    };
  }
}
