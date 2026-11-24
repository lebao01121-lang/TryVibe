import { randomUUID } from 'node:crypto';
import { HttpStatus, Injectable } from '@nestjs/common';
import { z } from 'zod';
import {
  ErrorCode,
  LockPromotionDtoSchema,
  PromoStatus,
  PromoType,
  ReleasePromotionDtoSchema,
  type AllocatedItemDiscount,
  type EvaluatePromotionResultDTO,
  type PromotionDTO,
} from '@atelier/contracts';
import { PaymentRedisService } from '../cache/payment-redis.service';
import { PaymentApiException } from '../common/payment-api.exception';
import { FREE_SHIP_THRESHOLD_VND } from '../config/env';
import { PaymentDbService } from '../db/payment-db.service';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface EvaluateLineItemInput {
  skuId: string;
  productId?: string;
  unitPriceVnd: number;
  qty: number;
  slot?: string | null;
  sizeCode?: string;
  bundleGroupId?: string | null;
}

const ExtendedEvaluateLineItemSchema = z.object({
  skuId: z.string().min(1),
  productId: z.string().min(1).optional(),
  unitPriceVnd: z.number().int().nonnegative(),
  qty: z.number().int().positive(),
  slot: z.string().nullable().optional(),
  sizeCode: z.string().trim().max(16).optional(),
  bundleGroupId: z.string().nullable().optional(),
});

const ExtendedEvaluatePromotionSchema = z.object({
  voucherCode: z.string().trim().max(64).nullable().optional(),
  items: z.array(ExtendedEvaluateLineItemSchema).min(1),
  subtotalVnd: z.number().int().nonnegative().optional(),
  shippingFeeVnd: z.number().int().nonnegative().optional(),
  shippingMethod: z.enum(['GHN', 'GHTK', 'AHAMOVE_2H', 'PICKUP']).optional(),
  userId: z.string().min(1).nullable().optional(),
  isNewCustomer: z.boolean().optional(),
  comboDistinctSlots: z.number().int().nonnegative().optional(),
});

const ExtendedClearanceDraftSchema = z.object({
  code: z.string().trim().min(3).max(64),
  name: z.string().trim().min(2).max(180),
  description: z.string().max(500).optional(),
  discountPercent: z.number().min(1).max(70),
  targetProductIds: z.array(z.string().min(1)).default([]),
  targetSkuCodes: z.array(z.string().min(1)).default([]),
  targetSizes: z.array(z.string().trim().min(1)).optional(),
  maxUses: z.number().int().positive().max(100_000).default(100),
  minOrderVnd: z.number().int().nonnegative().optional(),
  maxDiscountVnd: z.number().int().nonnegative().optional(),
  startsAt: z.string().nullable().optional(),
  endsAt: z.string().nullable().optional(),
  rationale: z.string().max(500).optional(),
});

interface PromotionRow {
  id: string;
  code: string;
  name: string;
  description: string | null;
  promo_type: PromoType;
  discount_value: number;
  max_discount_vnd: string | number | bigint;
  min_order_vnd: string | number | bigint;
  target_sizes_jsonb: string[] | string | null;
  target_product_ids_jsonb: string[] | string | null;
  target_sku_codes_jsonb: string[] | string | null;
  bonus_tryon_credits: number;
  usage_limit: number;
  used_count: number;
  per_user_limit: number;
  status: PromoStatus;
  created_by_actor_type: 'USER' | 'AI_COPILOT' | 'SYSTEM';
  start_at: Date | string;
  end_at: Date | string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface RedemptionRow {
  id: string;
  promotion_id: string;
  user_id: string | null;
  order_id: string;
  status: string;
  expires_at: Date | string;
}

export interface RichPromotionDto extends PromotionDTO {
  promoType: PromoType;
  discountValue: number;
  targetSizes: string[];
  bonusTryonCredits: number;
}

export interface RichEvaluatePromotionResult extends EvaluatePromotionResultDTO {
  subtotalVnd: number;
  comboDiscountPct: number;
  comboDiscountVnd: number;
  voucherDiscountVnd: number;
  shippingFeeVnd: number;
  bonusTryonCredits: number;
  allocatedDiscounts: AllocatedItemDiscount[];
}

export interface LockPromotionResult {
  redemptionId: string;
  promotionId: string;
  voucherCode: string;
  orderId: string;
  status: 'LOCKED' | 'REDEEMED';
  expiresAt: string;
  idempotentReplay: boolean;
}

export interface ReleasePromotionResult {
  orderId: string;
  releasedCount: number;
  releasedCodes: string[];
}

function toIso(value: Date | string | null | undefined): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }
  return new Date().toISOString();
}

function parseStringArray(raw: string[] | string | null | undefined): string[] {
  if (Array.isArray(raw)) {
    return raw.map((v) => String(v));
  }
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? parsed.map((v) => String(v)) : [];
    } catch {
      return [];
    }
  }
  return [];
}

function computeComboDiscountPct(distinctSlotCount: number): number {
  if (distinctSlotCount >= 3) {
    return 10;
  }
  if (distinctSlotCount === 2) {
    return 5;
  }
  return 0;
}

@Injectable()
export class PromotionsService {
  constructor(
    private readonly db: PaymentDbService,
    private readonly redis: PaymentRedisService,
  ) {}

  private mapPromotionRow(row: PromotionRow): RichPromotionDto {
    const discountValue = Number(row.discount_value ?? 0);
    const isPercentType =
      row.promo_type === PromoType.PERCENT ||
      row.promo_type === PromoType.CLEARANCE_ODD_SIZE ||
      row.promo_type === PromoType.OUTFIT_COMBO ||
      (row.promo_type === PromoType.FLASH_SALE && discountValue <= 100);

    const maxDiscountNum = Number(row.max_discount_vnd ?? 0);

    return {
      id: row.id,
      code: row.code,
      name: row.name,
      description: row.description ?? null,
      type: row.promo_type,
      promoType: row.promo_type,
      status: row.status,
      discountValue,
      discountPercent: isPercentType ? discountValue : null,
      discountAmountVnd: isPercentType ? null : discountValue,
      maxDiscountVnd: maxDiscountNum > 0 ? maxDiscountNum : null,
      minOrderVnd: Number(row.min_order_vnd ?? 0),
      maxUses: Number(row.usage_limit ?? 0) > 0 ? Number(row.usage_limit) : null,
      usedCount: Number(row.used_count ?? 0),
      perUserLimit: Number(row.per_user_limit ?? 0) > 0 ? Number(row.per_user_limit) : null,
      targetSizes: parseStringArray(row.target_sizes_jsonb),
      targetProductIds: parseStringArray(row.target_product_ids_jsonb),
      targetSkuCodes: parseStringArray(row.target_sku_codes_jsonb),
      bonusTryonCredits: Number(row.bonus_tryon_credits ?? 0),
      startsAt: toIso(row.start_at),
      endsAt: toIso(row.end_at),
      createdByActorType: row.created_by_actor_type ?? 'SYSTEM',
      createdAt: toIso(row.created_at),
      updatedAt: toIso(row.updated_at),
    };
  }

  async listPromotions(statusFilter?: string): Promise<RichPromotionDto[]> {
    const normalized = statusFilter?.trim().toUpperCase();
    const res =
      normalized && normalized !== 'ALL'
        ? await this.db.query<PromotionRow>(
            `
            SELECT *
            FROM promotions
            WHERE status = $1
            ORDER BY created_at DESC
            `,
            [normalized],
          )
        : await this.db.query<PromotionRow>(
            `
            SELECT *
            FROM promotions
            ORDER BY created_at DESC
            `,
          );

    return res.rows.map((row: PromotionRow) => this.mapPromotionRow(row));
  }

  async evaluatePromotion(rawBody: unknown): Promise<RichEvaluatePromotionResult> {
    const parsed = ExtendedEvaluatePromotionSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new PaymentApiException(
        HttpStatus.BAD_REQUEST,
        ErrorCode.VALIDATION_ERROR,
        'Dữ liệu tính toán khuyến mãi không hợp lệ. / Invalid promotion evaluation payload.',
        { issues: parsed.error.issues },
      );
    }

    const input = parsed.data;
    const lineItems: EvaluateLineItemInput[] = input.items;
    const subtotalVnd = lineItems.reduce(
      (sum: number, item: EvaluateLineItemInput) => sum + item.unitPriceVnd * item.qty,
      0,
    );

    // 1. Combo Set Discount (2 distinct slots -> 5%, >= 3 distinct slots -> 10%)
    const slotSet = new Set<string>();
    for (const item of input.items) {
      if (item.slot && item.slot.trim().length > 0) {
        slotSet.add(item.slot.trim().toUpperCase());
      }
    }
    const distinctSlots =
      input.comboDistinctSlots !== undefined ? input.comboDistinctSlots : slotSet.size;
    const comboDiscountPct = computeComboDiscountPct(distinctSlots);
    const comboDiscountVnd = Math.round((subtotalVnd * comboDiscountPct) / 100);
    const netAfterComboVnd = Math.max(0, subtotalVnd - comboDiscountVnd);

    // 2. Base Shipping Fee
    let baseShippingFeeVnd: number;
    if (input.shippingMethod === 'PICKUP') {
      baseShippingFeeVnd = 0;
    } else if (netAfterComboVnd >= FREE_SHIP_THRESHOLD_VND) {
      baseShippingFeeVnd = 0;
    } else if (input.shippingMethod === 'AHAMOVE_2H') {
      baseShippingFeeVnd = 55_000;
    } else if (input.shippingMethod === 'GHN' || input.shippingMethod === 'GHTK') {
      baseShippingFeeVnd = 35_000;
    } else if (input.shippingFeeVnd !== undefined && input.shippingFeeVnd > 0) {
      baseShippingFeeVnd = input.shippingFeeVnd;
    } else {
      baseShippingFeeVnd = 35_000;
    }

    // 3. Optional Voucher Validation & Discount
    const normalizedCode = input.voucherCode?.trim().toUpperCase() || '';
    let valid = true;
    let reason: string | null = null;
    let matchedPromo: PromotionRow | null = null;
    let voucherDiscountVnd = 0;
    let shippingDiscountVnd = 0;
    let finalShippingFeeVnd = baseShippingFeeVnd;

    if (normalizedCode.length > 0) {
      const promoRes = await this.db.query<PromotionRow>(
        'SELECT * FROM promotions WHERE UPPER(code) = $1 LIMIT 1',
        [normalizedCode],
      );
      const promo = promoRes.rows[0];
      const nowMs = Date.now();

      if (!promo) {
        valid = false;
        reason = `Mã khuyến mãi "${normalizedCode}" không tồn tại. / Voucher code not found.`;
      } else if (promo.status !== PromoStatus.ACTIVE) {
        valid = false;
        reason = `Mã khuyến mãi "${promo.code}" chưa được kích hoạt (${promo.status}). / Promotion is not active.`;
      } else if (nowMs < new Date(promo.start_at).getTime() || nowMs > new Date(promo.end_at).getTime()) {
        valid = false;
        reason = `Mã khuyến mãi "${promo.code}" đã hết hạn hoặc chưa đến thời gian áp dụng. / Promotion expired.`;
      } else if (Number(promo.used_count) >= Number(promo.usage_limit)) {
        valid = false;
        reason = `Mã khuyến mãi "${promo.code}" đã hết lượt sử dụng. / Promotion usage limit exhausted.`;
      } else if (subtotalVnd < Number(promo.min_order_vnd)) {
        valid = false;
        reason = `Đơn hàng cần tối thiểu ${Number(promo.min_order_vnd).toLocaleString('vi-VN')}₫ để áp dụng mã "${promo.code}". / Minimum order threshold not met.`;
      } else {
        const targetSizes = parseStringArray(promo.target_sizes_jsonb).map((s) =>
          s.toUpperCase(),
        );
        const itemsWithSize = lineItems.filter(
          (i: EvaluateLineItemInput) =>
            typeof i.sizeCode === 'string' && i.sizeCode.trim().length > 0,
        );

        let eligibleBaseVnd = netAfterComboVnd;
        if (targetSizes.length > 0 && itemsWithSize.length > 0) {
          const matchingSubtotal = itemsWithSize
            .filter((i: EvaluateLineItemInput) =>
              targetSizes.includes(i.sizeCode!.trim().toUpperCase()),
            )
            .reduce(
              (sum: number, i: EvaluateLineItemInput) => sum + i.unitPriceVnd * i.qty,
              0,
            );

          if (matchingSubtotal <= 0) {
            valid = false;
            reason = `Mã "${promo.code}" chỉ áp dụng cho các kích cỡ: ${targetSizes.join(', ')}. / Target sizes not matched.`;
          } else {
            eligibleBaseVnd = Math.min(netAfterComboVnd, matchingSubtotal);
          }
        }

        if (valid) {
          matchedPromo = promo;
          const discountVal = Number(promo.discount_value ?? 0);
          const maxCap = Number(promo.max_discount_vnd ?? 0);

          if (promo.promo_type === PromoType.FREESHIP) {
            shippingDiscountVnd = baseShippingFeeVnd;
            finalShippingFeeVnd = 0;
            voucherDiscountVnd = 0;
          } else if (
            promo.promo_type === PromoType.PERCENT ||
            promo.promo_type === PromoType.CLEARANCE_ODD_SIZE ||
            promo.promo_type === PromoType.OUTFIT_COMBO ||
            (promo.promo_type === PromoType.FLASH_SALE && discountVal <= 100)
          ) {
            let computed = Math.round((eligibleBaseVnd * discountVal) / 100);
            if (maxCap > 0) {
              computed = Math.min(computed, maxCap);
            }
            voucherDiscountVnd = Math.min(netAfterComboVnd, Math.max(0, computed));
          } else {
            // FIXED or FLASH_SALE fixed VND amount (e.g. FLASH200K = 200_000)
            let computed = discountVal;
            if (maxCap > 0) {
              computed = Math.min(computed, maxCap);
            }
            voucherDiscountVnd = Math.min(netAfterComboVnd, Math.max(0, computed));
          }
        }
      }
    }

    // 4. Exact proportional per-item discount allocation so SUM(allocatedDiscountVnd) === comboDiscountVnd + voucherDiscountVnd
    const totalItemDiscountVnd = Math.min(subtotalVnd, comboDiscountVnd + voucherDiscountVnd);
    const allocatedItems: AllocatedItemDiscount[] = [];
    let allocatedRunningTotal = 0;

    for (let idx = 0; idx < input.items.length; idx += 1) {
      const item = input.items[idx];
      const lineTotal = item.unitPriceVnd * item.qty;
      const isLast = idx === input.items.length - 1;

      const allocatedDiscountVnd = isLast
        ? Math.max(0, totalItemDiscountVnd - allocatedRunningTotal)
        : subtotalVnd > 0
          ? Math.floor((totalItemDiscountVnd * lineTotal) / subtotalVnd)
          : 0;

      allocatedRunningTotal += allocatedDiscountVnd;
      const netLineTotal = Math.max(0, lineTotal - allocatedDiscountVnd);
      const netRefundableUnitVnd = Math.max(0, Math.round(netLineTotal / item.qty));

      allocatedItems.push({
        skuId: item.skuId,
        qty: item.qty,
        unitPriceVnd: item.unitPriceVnd,
        allocatedDiscountVnd,
        netRefundableUnitVnd,
      });
    }

    return {
      valid,
      voucherCode: matchedPromo ? matchedPromo.code : normalizedCode || null,
      promotionId: matchedPromo ? matchedPromo.id : null,
      promoType: matchedPromo ? matchedPromo.promo_type : null,
      subtotalVnd,
      comboDiscountPct,
      comboDiscountVnd,
      voucherDiscountVnd,
      discountVnd: totalItemDiscountVnd,
      shippingFeeVnd: finalShippingFeeVnd,
      shippingDiscountVnd,
      totalDiscountVnd: totalItemDiscountVnd + shippingDiscountVnd,
      bonusTryonCredits: matchedPromo ? Number(matchedPromo.bonus_tryon_credits ?? 0) : 0,
      allocatedItems,
      allocatedDiscounts: allocatedItems,
      reason,
    };
  }

  async lockPromotion(rawBody: unknown): Promise<LockPromotionResult> {
    const parsed = LockPromotionDtoSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new PaymentApiException(
        HttpStatus.BAD_REQUEST,
        ErrorCode.VALIDATION_ERROR,
        'Dữ liệu khóa mã khuyến mãi không hợp lệ. / Invalid promotion lock payload.',
        { issues: parsed.error.issues },
      );
    }

    const input = parsed.data;
    if (!UUID_REGEX.test(input.orderId)) {
      throw new PaymentApiException(
        HttpStatus.BAD_REQUEST,
        ErrorCode.VALIDATION_ERROR,
        'orderId phải là UUID hợp lệ. / orderId must be a valid UUID.',
      );
    }

    const normalizedCode = input.voucherCode.trim().toUpperCase();
    const promoRes =
      input.promotionId && UUID_REGEX.test(input.promotionId)
        ? await this.db.query<PromotionRow>(
            'SELECT * FROM promotions WHERE id = $1 LIMIT 1',
            [input.promotionId],
          )
        : await this.db.query<PromotionRow>(
            'SELECT * FROM promotions WHERE UPPER(code) = $1 LIMIT 1',
            [normalizedCode],
          );

    const promo = promoRes.rows[0];
    if (!promo || promo.status !== PromoStatus.ACTIVE) {
      throw new PaymentApiException(
        HttpStatus.BAD_REQUEST,
        ErrorCode.PROMOTION_INVALID,
        `Mã khuyến mãi "${normalizedCode}" không hợp lệ hoặc chưa kích hoạt. / Invalid or inactive promotion.`,
      );
    }

    // Idempotency check: if already locked/redeemed for this order, replay cleanly
    const existingRes = await this.db.query<RedemptionRow>(
      `
      SELECT id, promotion_id, user_id, order_id, status, expires_at
      FROM voucher_redemptions
      WHERE promotion_id = $1 AND order_id = $2 AND status IN ('LOCKED', 'REDEEMED')
      LIMIT 1
      `,
      [promo.id, input.orderId],
    );
    const existing = existingRes.rows[0];
    if (existing) {
      return {
        redemptionId: existing.id,
        promotionId: existing.promotion_id,
        voucherCode: promo.code,
        orderId: existing.order_id,
        status: existing.status as 'LOCKED' | 'REDEEMED',
        expiresAt: toIso(existing.expires_at),
        idempotentReplay: true,
      };
    }

    // Atomic Redis Flash-Sale counter check
    const redisLock = await this.redis.tryAcquireFlashCounter(
      promo.code,
      Number(promo.usage_limit),
      Number(promo.used_count),
    );
    if (!redisLock.allowed) {
      throw new PaymentApiException(
        HttpStatus.CONFLICT,
        ErrorCode.PROMOTION_EXHAUSTED,
        `Mã khuyến mãi "${promo.code}" đã hết suất sử dụng. / Promotion usage limit exhausted.`,
        { voucherCode: promo.code, usageLimit: Number(promo.usage_limit) },
      );
    }

    const redemptionId = randomUUID();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

    try {
      await this.db.transaction(async (tx) => {
        const updated = await tx.query<{ used_count: number }>(
          `
          UPDATE promotions
          SET used_count = used_count + 1, updated_at = NOW()
          WHERE id = $1 AND used_count < usage_limit
          RETURNING used_count
          `,
          [promo.id],
        );
        if (updated.rows.length === 0) {
          throw new PaymentApiException(
            HttpStatus.CONFLICT,
            ErrorCode.PROMOTION_EXHAUSTED,
            `Mã khuyến mãi "${promo.code}" đã hết suất sử dụng. / Promotion usage limit exhausted.`,
            { voucherCode: promo.code, usageLimit: Number(promo.usage_limit) },
          );
        }

        await tx.query(
          `
          INSERT INTO voucher_redemptions (id, promotion_id, user_id, order_id, status, expires_at)
          VALUES ($1, $2, $3, $4, 'LOCKED', $5)
          `,
          [redemptionId, promo.id, input.userId ?? null, input.orderId, expiresAt],
        );
      });
    } catch (error: unknown) {
      if (redisLock.available) {
        await this.redis.releaseFlashCounter(promo.code);
      }
      throw error;
    }

    return {
      redemptionId,
      promotionId: promo.id,
      voucherCode: promo.code,
      orderId: input.orderId,
      status: 'LOCKED',
      expiresAt,
      idempotentReplay: false,
    };
  }

  async releasePromotion(rawBody: unknown): Promise<ReleasePromotionResult> {
    const parsed = ReleasePromotionDtoSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new PaymentApiException(
        HttpStatus.BAD_REQUEST,
        ErrorCode.VALIDATION_ERROR,
        'Dữ liệu hoàn trả mã khuyến mãi không hợp lệ. / Invalid promotion release payload.',
        { issues: parsed.error.issues },
      );
    }

    const input = parsed.data;
    if (!UUID_REGEX.test(input.orderId)) {
      return { orderId: input.orderId, releasedCount: 0, releasedCodes: [] };
    }

    const releasedCodes: string[] = [];

    await this.db.transaction(async (tx) => {
      const lockedRes = await tx.query<{ id: string; promotion_id: string; code: string }>(
        `
        SELECT r.id, r.promotion_id, p.code
        FROM voucher_redemptions r
        JOIN promotions p ON p.id = r.promotion_id
        WHERE r.order_id = $1 AND r.status = 'LOCKED'
        `,
        [input.orderId],
      );

      for (const row of lockedRes.rows) {
        if (input.promotionId && row.promotion_id !== input.promotionId) {
          continue;
        }
        if (input.voucherCode && row.code.toUpperCase() !== input.voucherCode.trim().toUpperCase()) {
          continue;
        }

        const upd = await tx.query<{ id: string }>(
          `
          UPDATE voucher_redemptions
          SET status = 'RELEASED'
          WHERE id = $1 AND status = 'LOCKED'
          RETURNING id
          `,
          [row.id],
        );

        if (upd.rows.length > 0) {
          await tx.query(
            `
            UPDATE promotions
            SET used_count = GREATEST(0, used_count - 1), updated_at = NOW()
            WHERE id = $1
            `,
            [row.promotion_id],
          );
          releasedCodes.push(row.code);
        }
      }
    });

    for (const code of releasedCodes) {
      await this.redis.releaseFlashCounter(code);
    }

    return {
      orderId: input.orderId,
      releasedCount: releasedCodes.length,
      releasedCodes,
    };
  }

  /**
   * Strictly creates a CLEARANCE_ODD_SIZE promotion locked to `status = 'NHAP_AI'`.
   * Never activates a campaign directly from AI Copilot without human approval.
   */
  async createAiClearanceDraft(rawBody: unknown): Promise<RichPromotionDto> {
    const parsed = ExtendedClearanceDraftSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new PaymentApiException(
        HttpStatus.BAD_REQUEST,
        ErrorCode.VALIDATION_ERROR,
        'Dữ liệu tạo nháp chiến dịch xả hàng lẻ size không hợp lệ. / Invalid clearance draft payload.',
        { issues: parsed.error.issues },
      );
    }

    const input = parsed.data;
    const normalizedCode = input.code.trim().toUpperCase();
    const id = randomUUID();
    const targetSizes =
      input.targetSizes && input.targetSizes.length > 0 ? input.targetSizes : ['XS', 'XL', 'XXL'];
    const startAt = input.startsAt ?? new Date().toISOString();
    const endAt =
      input.endsAt ?? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

    const description = [input.description, input.rationale].filter(Boolean).join(' — ') || null;

    try {
      const inserted = await this.db.query<PromotionRow>(
        `
        INSERT INTO promotions (
          id, code, name, description, promo_type, discount_value,
          max_discount_vnd, min_order_vnd, target_sizes_jsonb,
          target_product_ids_jsonb, target_sku_codes_jsonb,
          bonus_tryon_credits, usage_limit, used_count, per_user_limit,
          status, created_by_actor_type, start_at, end_at
        )
        VALUES (
          $1, $2, $3, $4, 'CLEARANCE_ODD_SIZE', $5,
          $6, $7, $8::jsonb,
          $9::jsonb, $10::jsonb,
          0, $11, 0, 5,
          'NHAP_AI', 'AI_COPILOT', $12, $13
        )
        RETURNING *
        `,
        [
          id,
          normalizedCode,
          input.name,
          description,
          Math.round(input.discountPercent),
          input.maxDiscountVnd ?? 1_000_000,
          input.minOrderVnd ?? 0,
          JSON.stringify(targetSizes),
          JSON.stringify(input.targetProductIds),
          JSON.stringify(input.targetSkuCodes),
          input.maxUses,
          startAt,
          endAt,
        ],
      );

      const row = inserted.rows[0];
      if (!row) {
        throw new PaymentApiException(
          HttpStatus.INTERNAL_SERVER_ERROR,
          ErrorCode.INTERNAL_ERROR,
          'Failed to create AI clearance campaign draft.',
        );
      }

      return this.mapPromotionRow(row);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes('unique') || msg.includes('duplicate')) {
        throw new PaymentApiException(
          HttpStatus.CONFLICT,
          ErrorCode.CONFLICT,
          `Mã chiến dịch "${normalizedCode}" đã tồn tại. / Campaign code already exists.`,
          { code: normalizedCode },
        );
      }
      throw error;
    }
  }
}
