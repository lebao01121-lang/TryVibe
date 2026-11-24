import * as crypto from 'node:crypto';
import { HttpStatus, Injectable } from '@nestjs/common';
import {
  AuditActorType,
  ErrorCode,
  type CreateCustomerAddressRequest,
  type CustomerAddressDto,
  type CustomerBodyProfileDto,
  type FitPreference,
  type LoyaltyTier,
  type TryOnQuotaDto,
  type UpdateBodyProfileRequest,
  type UpdateCustomerAddressRequest,
} from '@atelier/contracts';
import { ApiDomainException } from '../common/api-exception';
import { getDailyTryOnLimitForTier } from '../db/seed';
import { DatabaseService } from '../infra/database.service';
import { AuditService } from './audit.service';

interface BodyProfileRow {
  user_id: string;
  height_cm: number;
  weight_kg: number;
  bust_cm: number | null;
  waist_cm: number | null;
  hip_cm: number | null;
  shoulder_cm: number | null;
  fit_preference: FitPreference;
  updated_at: Date | string;
}

interface AddressRow {
  id: string;
  user_id: string;
  recipient_name: string;
  phone: string;
  province_code: string;
  province_name: string;
  district_code: string;
  district_name: string;
  ward_code: string;
  ward_name: string;
  street_line: string;
  is_default: boolean;
  created_at: Date | string;
  updated_at: Date | string;
}

interface QuotaRow {
  user_id: string;
  daily_limit: number;
  used_today: number;
  reset_at: Date | string;
  loyalty_tier: LoyaltyTier;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function mapBodyProfile(row: BodyProfileRow): CustomerBodyProfileDto {
  return {
    userId: row.user_id,
    heightCm: Number(row.height_cm),
    weightKg: Number(row.weight_kg),
    bustCm: row.bust_cm !== null ? Number(row.bust_cm) : null,
    waistCm: row.waist_cm !== null ? Number(row.waist_cm) : null,
    hipCm: row.hip_cm !== null ? Number(row.hip_cm) : null,
    shoulderCm: row.shoulder_cm !== null ? Number(row.shoulder_cm) : null,
    fitPreference: row.fit_preference,
    updatedAt: toIso(row.updated_at),
  };
}

function mapAddress(row: AddressRow): CustomerAddressDto {
  return {
    id: row.id,
    userId: row.user_id,
    recipientName: row.recipient_name,
    phone: row.phone,
    provinceCode: row.province_code,
    provinceName: row.province_name,
    districtCode: row.district_code,
    districtName: row.district_name,
    wardCode: row.ward_code,
    wardName: row.ward_name,
    streetLine: row.street_line,
    isDefault: Boolean(row.is_default),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

export interface TryOnQuotaViewDto extends TryOnQuotaDto {
  remaining: number;
}

export interface UserCheckoutProfileDto {
  userId: string;
  email: string;
  fullName: string;
  loyaltyTier: LoyaltyTier;
  codTrustScore: number;
  status: string;
}

@Injectable()
export class CustomerService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  async getBodyProfile(userId: string): Promise<CustomerBodyProfileDto | null> {
    const res = await this.db.query<BodyProfileRow>(
      'SELECT * FROM customer_body_profiles WHERE user_id = $1',
      [userId],
    );
    if (res.rows.length === 0) {
      return null;
    }
    return mapBodyProfile(res.rows[0]);
  }

  async upsertBodyProfile(
    userId: string,
    input: UpdateBodyProfileRequest,
  ): Promise<CustomerBodyProfileDto> {
    const res = await this.db.query<BodyProfileRow>(
      `INSERT INTO customer_body_profiles (
        user_id, height_cm, weight_kg, bust_cm, waist_cm, hip_cm, shoulder_cm, fit_preference, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
      ON CONFLICT (user_id) DO UPDATE
      SET height_cm = EXCLUDED.height_cm,
          weight_kg = EXCLUDED.weight_kg,
          bust_cm = EXCLUDED.bust_cm,
          waist_cm = EXCLUDED.waist_cm,
          hip_cm = EXCLUDED.hip_cm,
          shoulder_cm = EXCLUDED.shoulder_cm,
          fit_preference = EXCLUDED.fit_preference,
          updated_at = NOW()
      RETURNING *`,
      [
        userId,
        input.heightCm,
        input.weightKg,
        input.bustCm ?? null,
        input.waistCm ?? null,
        input.hipCm ?? null,
        input.shoulderCm ?? null,
        input.fitPreference,
      ],
    );
    return mapBodyProfile(res.rows[0]);
  }

  async listAddresses(userId: string): Promise<CustomerAddressDto[]> {
    const res = await this.db.query<AddressRow>(
      `SELECT * FROM customer_addresses
       WHERE user_id = $1
       ORDER BY is_default DESC, created_at DESC`,
      [userId],
    );
    return res.rows.map(mapAddress);
  }

  async createAddress(
    userId: string,
    input: CreateCustomerAddressRequest,
  ): Promise<CustomerAddressDto> {
    return this.db.transaction(async (tx) => {
      const existingCountRes = await tx.query<{ cnt: string | number }>(
        'SELECT COUNT(*)::int AS cnt FROM customer_addresses WHERE user_id = $1',
        [userId],
      );
      const existingCount = Number(existingCountRes.rows[0]?.cnt ?? 0);
      const shouldBeDefault = Boolean(input.isDefault) || existingCount === 0;

      if (shouldBeDefault) {
        await tx.query('UPDATE customer_addresses SET is_default = FALSE WHERE user_id = $1', [
          userId,
        ]);
      }

      const id = crypto.randomUUID();
      const inserted = await tx.query<AddressRow>(
        `INSERT INTO customer_addresses (
          id, user_id, recipient_name, phone,
          province_code, province_name, district_code, district_name,
          ward_code, ward_name, street_line, is_default, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW(), NOW())
        RETURNING *`,
        [
          id,
          userId,
          input.recipientName,
          input.phone,
          input.provinceCode,
          input.provinceName,
          input.districtCode,
          input.districtName,
          input.wardCode,
          input.wardName,
          input.streetLine,
          shouldBeDefault,
        ],
      );

      return mapAddress(inserted.rows[0]);
    });
  }

  async updateAddress(
    userId: string,
    addressId: string,
    input: UpdateCustomerAddressRequest,
  ): Promise<CustomerAddressDto> {
    return this.db.transaction(async (tx) => {
      const existingRes = await tx.query<AddressRow>(
        'SELECT * FROM customer_addresses WHERE id = $1',
        [addressId],
      );
      if (existingRes.rows.length === 0) {
        throw new ApiDomainException(
          HttpStatus.NOT_FOUND,
          ErrorCode.NOT_FOUND,
          'Không tìm thấy địa chỉ giao hàng.',
        );
      }
      if (existingRes.rows[0].user_id !== userId) {
        throw new ApiDomainException(
          HttpStatus.FORBIDDEN,
          ErrorCode.FORBIDDEN,
          'Bạn không có quyền chỉnh sửa địa chỉ thuộc khách hàng khác.',
        );
      }

      const current = existingRes.rows[0];
      const nextIsDefault =
        input.isDefault !== undefined ? Boolean(input.isDefault) : Boolean(current.is_default);

      if (nextIsDefault) {
        await tx.query(
          'UPDATE customer_addresses SET is_default = FALSE WHERE user_id = $1 AND id <> $2',
          [userId, addressId],
        );
      }

      const updated = await tx.query<AddressRow>(
        `UPDATE customer_addresses
         SET recipient_name = $1,
             phone = $2,
             province_code = $3,
             province_name = $4,
             district_code = $5,
             district_name = $6,
             ward_code = $7,
             ward_name = $8,
             street_line = $9,
             is_default = $10,
             updated_at = NOW()
         WHERE id = $11 AND user_id = $12
         RETURNING *`,
        [
          input.recipientName ?? current.recipient_name,
          input.phone ?? current.phone,
          input.provinceCode ?? current.province_code,
          input.provinceName ?? current.province_name,
          input.districtCode ?? current.district_code,
          input.districtName ?? current.district_name,
          input.wardCode ?? current.ward_code,
          input.wardName ?? current.ward_name,
          input.streetLine ?? current.street_line,
          nextIsDefault,
          addressId,
          userId,
        ],
      );

      return mapAddress(updated.rows[0]);
    });
  }

  async deleteAddress(userId: string, addressId: string): Promise<{ deleted: true; id: string }> {
    return this.db.transaction(async (tx) => {
      const ownerCheck = await tx.query<{ user_id: string }>(
        'SELECT user_id FROM customer_addresses WHERE id = $1',
        [addressId],
      );
      if (ownerCheck.rows.length === 0) {
        throw new ApiDomainException(
          HttpStatus.NOT_FOUND,
          ErrorCode.NOT_FOUND,
          'Không tìm thấy địa chỉ cần xóa.',
        );
      }
      if (ownerCheck.rows[0].user_id !== userId) {
        throw new ApiDomainException(
          HttpStatus.FORBIDDEN,
          ErrorCode.FORBIDDEN,
          'Bạn không có quyền xóa địa chỉ thuộc khách hàng khác.',
        );
      }

      const deleted = await tx.query<AddressRow>(
        'DELETE FROM customer_addresses WHERE id = $1 AND user_id = $2 RETURNING *',
        [addressId, userId],
      );

      if (deleted.rows[0].is_default) {
        const nextCandidate = await tx.query<{ id: string }>(
          `SELECT id FROM customer_addresses
           WHERE user_id = $1
           ORDER BY created_at DESC
           LIMIT 1`,
          [userId],
        );
        if (nextCandidate.rows.length > 0) {
          await tx.query(
            'UPDATE customer_addresses SET is_default = TRUE, updated_at = NOW() WHERE id = $1',
            [nextCandidate.rows[0].id],
          );
        }
      }

      return { deleted: true, id: addressId };
    });
  }

  async getTryOnQuota(userId: string): Promise<TryOnQuotaViewDto> {
    const userRes = await this.db.query<{ loyalty_tier: LoyaltyTier }>(
      'SELECT loyalty_tier FROM users WHERE id = $1',
      [userId],
    );
    if (userRes.rows.length === 0) {
      throw new ApiDomainException(
        HttpStatus.NOT_FOUND,
        ErrorCode.NOT_FOUND,
        'Không tìm thấy tài khoản người dùng.',
      );
    }

    const loyaltyTier = userRes.rows[0].loyalty_tier;
    const expectedLimit = getDailyTryOnLimitForTier(loyaltyTier);

    await this.db.query(
      `INSERT INTO tryon_quotas (user_id, daily_limit, used_today, reset_at)
       VALUES ($1, $2, 0, NOW() + INTERVAL '1 day')
       ON CONFLICT (user_id) DO NOTHING`,
      [userId, expectedLimit],
    );

    const quotaRes = await this.db.query<QuotaRow>(
      `SELECT q.user_id, q.daily_limit, q.used_today, q.reset_at, u.loyalty_tier
       FROM tryon_quotas q
       INNER JOIN users u ON u.id = q.user_id
       WHERE q.user_id = $1`,
      [userId],
    );

    let row = quotaRes.rows[0];
    const expired = new Date(row.reset_at).getTime() <= Date.now();
    const currentLimit = Number(row.daily_limit);
    // Preserve VIP bonus credits (never downgrade daily_limit below currentLimit)
    const effectiveLimit = Math.max(currentLimit, expectedLimit);

    if (expired || effectiveLimit !== currentLimit) {
      const updated = await this.db.query<{
        user_id: string;
        daily_limit: number;
        used_today: number;
        reset_at: Date | string;
      }>(
        `UPDATE tryon_quotas
         SET daily_limit = $1,
             used_today = CASE WHEN $2 THEN 0 ELSE used_today END,
             reset_at = CASE WHEN $2 THEN NOW() + INTERVAL '1 day' ELSE reset_at END
         WHERE user_id = $3
         RETURNING user_id, daily_limit, used_today, reset_at`,
        [effectiveLimit, expired, userId],
      );
      row = { ...updated.rows[0], loyalty_tier: loyaltyTier };
    }

    const dailyLimit = Number(row.daily_limit);
    const usedToday = Number(row.used_today);
    const remaining = Math.max(0, dailyLimit - usedToday);
    return {
      userId: row.user_id,
      loyaltyTier: row.loyalty_tier,
      dailyLimit,
      usedToday,
      remaining,
      remainingToday: remaining,
      resetAt: toIso(row.reset_at),
    };
  }

  async grantTryOnQuotaBonus(params: {
    userId: string;
    bonusCredits: number;
    reason?: string;
    correlationId?: string;
    ipAddress?: string;
  }): Promise<TryOnQuotaViewDto & { bonusCredits: number }> {
    const userRes = await this.db.query<{ id: string; email: string; loyalty_tier: LoyaltyTier }>(
      'SELECT id, email, loyalty_tier FROM users WHERE id = $1',
      [params.userId],
    );
    if (userRes.rows.length === 0) {
      throw new ApiDomainException(
        HttpStatus.NOT_FOUND,
        ErrorCode.NOT_FOUND,
        'Không tìm thấy người dùng để cộng lượt thử đồ thưởng.',
      );
    }

    const user = userRes.rows[0];
    const baseLimit = getDailyTryOnLimitForTier(user.loyalty_tier);

    const updated = await this.db.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO tryon_quotas (user_id, daily_limit, used_today, reset_at)
         VALUES ($1, $2, 0, NOW() + INTERVAL '1 day')
         ON CONFLICT (user_id) DO NOTHING`,
        [user.id, baseLimit],
      );

      const res = await tx.query<{
        user_id: string;
        daily_limit: number;
        used_today: number;
        reset_at: Date | string;
      }>(
        `UPDATE tryon_quotas
         SET daily_limit = daily_limit + $1
         WHERE user_id = $2
         RETURNING user_id, daily_limit, used_today, reset_at`,
        [params.bonusCredits, user.id],
      );

      const row = res.rows[0];
      await this.audit.record(
        {
          actorId: user.id,
          actorEmail: user.email,
          actorType: AuditActorType.SYSTEM,
          action: 'TRYON_QUOTA_BONUS_GRANTED',
          resourceType: 'tryon_quota',
          resourceId: user.id,
          afterJsonb: {
            bonusCredits: params.bonusCredits,
            dailyLimit: Number(row.daily_limit),
            reason: params.reason ?? 'ORDER_CONFIRMED_BONUS',
          },
          correlationId: params.correlationId ?? null,
          ipAddress: params.ipAddress ?? null,
        },
        tx,
      );

      return row;
    });

    const dailyLimit = Number(updated.daily_limit);
    const usedToday = Number(updated.used_today);
    const remaining = Math.max(0, dailyLimit - usedToday);

    return {
      userId: updated.user_id,
      loyaltyTier: user.loyalty_tier,
      dailyLimit,
      usedToday,
      remaining,
      remainingToday: remaining,
      bonusCredits: params.bonusCredits,
      resetAt: toIso(updated.reset_at),
    };
  }

  async getCheckoutProfile(userId: string): Promise<UserCheckoutProfileDto> {
    const res = await this.db.query<{
      id: string;
      email: string;
      full_name: string;
      loyalty_tier: LoyaltyTier;
      cod_trust_score: number;
      status: string;
    }>(
      'SELECT id, email, full_name, loyalty_tier, cod_trust_score, status FROM users WHERE id = $1',
      [userId],
    );

    if (res.rows.length === 0) {
      throw new ApiDomainException(
        HttpStatus.NOT_FOUND,
        ErrorCode.NOT_FOUND,
        'Không tìm thấy hồ sơ thanh toán của người dùng.',
      );
    }

    const row = res.rows[0];
    return {
      userId: row.id,
      email: row.email,
      fullName: row.full_name,
      loyaltyTier: row.loyalty_tier,
      codTrustScore: Number(row.cod_trust_score),
      status: row.status,
    };
  }
}
