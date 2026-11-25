import type { AtelierDbClient } from '@atelier/db-client';

interface PromotionSeedEntry {
  id: string;
  code: string;
  name: string;
  description: string;
  promoType: string;
  discountValue: number;
  maxDiscountVnd: number;
  minOrderVnd: number;
  targetSizes: string[];
  bonusTryonCredits: number;
  usageLimit: number;
  perUserLimit: number;
  status: string;
  createdByActorType?: 'USER' | 'AI_COPILOT' | 'SYSTEM';
}

export const PROMOTION_SEEDS: readonly PromotionSeedEntry[] = [
  {
    id: '71000000-0000-4000-8000-000000000001',
    code: 'ATELIER10',
    name: 'Ưu đãi TryVibe 10% + Tặng 2 lượt Thử đồ AI',
    description: 'Giảm 10% (tối đa 500.000₫) cho đơn từ 1.000.000₫, tặng thêm 2 lượt Virtual Try-On.',
    promoType: 'PERCENT',
    discountValue: 10,
    maxDiscountVnd: 500_000,
    minOrderVnd: 1_000_000,
    targetSizes: [],
    bonusTryonCredits: 2,
    usageLimit: 1000,
    perUserLimit: 5,
    status: 'ACTIVE',
  },
  {
    id: '71000000-0000-4000-8000-000000000002',
    code: 'FREESHIP',
    name: 'Miễn phí vận chuyển Tiêu chuẩn',
    description: 'Miễn phí giao hàng (tối đa 35.000₫) cho đơn hàng từ 500.000₫.',
    promoType: 'FREESHIP',
    discountValue: 35_000,
    maxDiscountVnd: 55_000,
    minOrderVnd: 500_000,
    targetSizes: [],
    bonusTryonCredits: 0,
    usageLimit: 2000,
    perUserLimit: 10,
    status: 'ACTIVE',
  },
  {
    id: '71000000-0000-4000-8000-000000000003',
    code: 'FLASH200K',
    name: 'Flash Sale Atelier — Giảm trực tiếp 200.000₫',
    description: 'Giới hạn 50 suất toàn hệ thống cho đơn hàng từ 1.500.000₫.',
    promoType: 'FLASH_SALE',
    discountValue: 200_000,
    maxDiscountVnd: 200_000,
    minOrderVnd: 1_500_000,
    targetSizes: [],
    bonusTryonCredits: 0,
    usageLimit: 50,
    perUserLimit: 1,
    status: 'ACTIVE',
  },
  {
    id: '71000000-0000-4000-8000-000000000004',
    code: 'ODD_SIZE_XS_XL',
    name: 'Ưu đãi Lẻ Size XS / XL / XXL — Giảm 15%',
    description: 'Giảm 15% cho các thiết kế lẻ size XS, XL, XXL còn sẵn tại showroom.',
    promoType: 'CLEARANCE_ODD_SIZE',
    discountValue: 15,
    maxDiscountVnd: 1_000_000,
    minOrderVnd: 0,
    targetSizes: ['XS', 'XL', 'XXL'],
    bonusTryonCredits: 0,
    usageLimit: 500,
    perUserLimit: 5,
    status: 'ACTIVE',
  },
  {
    id: '71000000-0000-4000-8000-000000000005',
    code: 'AI_CLEARANCE_DRAFT_01',
    name: 'Đề xuất AI — Xả hàng Lẻ Size Cuối Mùa (20%)',
    description:
      'Chiến dịch nháp do AI Copilot đề xuất cho các mã lẻ size XS/XL/XXL tồn kho chậm quay vòng (chờ phê duyệt HITL).',
    promoType: 'CLEARANCE_ODD_SIZE',
    discountValue: 20,
    maxDiscountVnd: 1_200_000,
    minOrderVnd: 800_000,
    targetSizes: ['XS', 'XL', 'XXL'],
    bonusTryonCredits: 0,
    usageLimit: 150,
    perUserLimit: 3,
    status: 'NHAP_AI',
    createdByActorType: 'AI_COPILOT',
  },
] as const;

export async function seedPromotionsIdempotently(db: AtelierDbClient): Promise<number> {
  let inserted = 0;
  for (const promo of PROMOTION_SEEDS) {
    const res = await db.query<{ id: string }>(
      `
      INSERT INTO promotions (
        id, code, name, description, promo_type, discount_value,
        max_discount_vnd, min_order_vnd, target_sizes_jsonb,
        bonus_tryon_credits, usage_limit, used_count, per_user_limit,
        status, created_by_actor_type, start_at, end_at
      )
      VALUES (
        $1, $2, $3, $4, $5, $6,
        $7, $8, $9::jsonb,
        $10, $11, 0, $12,
        $13, $14, NOW() - INTERVAL '1 day', NOW() + INTERVAL '365 days'
      )
      ON CONFLICT (code) DO NOTHING
      RETURNING id
      `,
      [
        promo.id,
        promo.code,
        promo.name,
        promo.description,
        promo.promoType,
        promo.discountValue,
        promo.maxDiscountVnd,
        promo.minOrderVnd,
        JSON.stringify(promo.targetSizes),
        promo.bonusTryonCredits,
        promo.usageLimit,
        promo.perUserLimit,
        promo.status,
        promo.createdByActorType ?? 'SYSTEM',
      ],
    );
    if (res.rows.length > 0) {
      inserted += 1;
    } else if (promo.code === 'ATELIER10') {
      const legacyToken = 'T\u1EA7m Xu\u00E2n';
      await db.query(
        `UPDATE promotions SET name = $2 WHERE code = $1 AND name ILIKE $3`,
        [promo.code, promo.name, `%${legacyToken}%`],
      );
    }
  }
  return inserted;
}
