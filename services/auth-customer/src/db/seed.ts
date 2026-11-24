import * as crypto from 'node:crypto';
import {
  ALL_PERMISSIONS,
  ALL_ROLES,
  FitPreference,
  LoyaltyTier,
  Role,
  ROLE_PERMISSIONS,
  UserStatus,
  type LoyaltyTier as LoyaltyTierType,
} from '@atelier/contracts';
import type { AtelierDbClient } from '@atelier/db-client';
import { hashPassword } from '../crypto/password';

export const SEED_PASSWORD_PLAIN = 'Atelier@2026!';
export const SUPPLIER_A_ID = '11111111-1111-4111-8111-111111111101';
export const SUPPLIER_B_ID = '22222222-2222-4222-8222-222222222202';
export const SUPPLIER_C_ID = '33333333-3333-4333-8333-333333333303';

export function getDailyTryOnLimitForTier(tier: LoyaltyTierType): number {
  switch (tier) {
    case LoyaltyTier.DIAMOND:
      return 20;
    case LoyaltyTier.GOLD:
      return 12;
    case LoyaltyTier.SILVER:
      return 8;
    case LoyaltyTier.BRONZE:
    default:
      return 5;
  }
}

/**
 * Produces a deterministic RFC 4122 UUIDv4-formatted string for idempotent seeding.
 */
export function deterministicUuid(key: string): string {
  const bytes = crypto.createHash('sha256').update(`atelier:auth:${key}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

const ROLE_METADATA: Record<Role, { name: string; description: string }> = {
  [Role.SUPER_ADMIN]: {
    name: 'Super Admin',
    description: 'Quản trị toàn hệ thống, phân quyền RBAC, Audit Logs và dữ liệu giá vốn.',
  },
  [Role.CATALOG_AI_OPERATOR]: {
    name: 'Catalog & AI Operator',
    description: 'Quản trị danh mục sản phẩm, bảng size, kiểm định ảnh kép 2:3 & 3:4 và duyệt mẫu AI.',
  },
  [Role.WAREHOUSE_MANAGER]: {
    name: 'Warehouse Manager',
    description: 'Quản lý tồn kho, nhập hàng PO/GRN và xem giá nhập phục vụ mua hàng.',
  },
  [Role.ORDER_STAFF]: {
    name: 'Order & CS Staff',
    description: 'Xử lý đơn hàng, đổi trả RMA và chăm sóc khách hàng.',
  },
  [Role.SUPPLIER]: {
    name: 'Supplier Partner',
    description: 'Đối tác nhà cung cấp truy cập Partner Portal cách ly theo supplier_id.',
  },
  [Role.CUSTOMER]: {
    name: 'Customer',
    description: 'Khách hàng Storefront với hồ sơ số đo, địa chỉ giao hàng và phòng thử đồ AI.',
  },
};

interface SeedUserSpec {
  email: string;
  fullName: string;
  phone: string | null;
  role: Role;
  loyaltyTier: LoyaltyTierType;
  supplierId: string | null;
}

const SEED_USERS: readonly SeedUserSpec[] = [
  {
    email: 'admin@atelier.local',
    fullName: 'Nguyễn Minh Quản Trị',
    phone: '0901000001',
    role: Role.SUPER_ADMIN,
    loyaltyTier: LoyaltyTier.DIAMOND,
    supplierId: null,
  },
  {
    email: 'operator@atelier.local',
    fullName: 'Trần Thảo Catalog AI',
    phone: '0901000002',
    role: Role.CATALOG_AI_OPERATOR,
    loyaltyTier: LoyaltyTier.GOLD,
    supplierId: null,
  },
  {
    email: 'warehouse@atelier.local',
    fullName: 'Lê Hoàng Kho Vận',
    phone: '0901000003',
    role: Role.WAREHOUSE_MANAGER,
    loyaltyTier: LoyaltyTier.GOLD,
    supplierId: null,
  },
  {
    email: 'staff@atelier.local',
    fullName: 'Phạm Linh Đơn Hàng',
    phone: '0901000004',
    role: Role.ORDER_STAFF,
    loyaltyTier: LoyaltyTier.SILVER,
    supplierId: null,
  },
  {
    email: 'supplier-a@atelier.local',
    fullName: 'Atelier Silk Partner A',
    phone: '0901000005',
    role: Role.SUPPLIER,
    loyaltyTier: LoyaltyTier.SILVER,
    supplierId: SUPPLIER_A_ID,
  },
  {
    email: 'supplier-b@atelier.local',
    fullName: 'Maison Linen Partner B',
    phone: '0901000006',
    role: Role.SUPPLIER,
    loyaltyTier: LoyaltyTier.SILVER,
    supplierId: SUPPLIER_B_ID,
  },
  {
    email: 'supplier-c@atelier.local',
    fullName: 'Atelier Couture Partner C',
    phone: '0901000007',
    role: Role.SUPPLIER,
    loyaltyTier: LoyaltyTier.SILVER,
    supplierId: SUPPLIER_C_ID,
  },
  {
    email: 'customer@atelier.local',
    fullName: 'Vũ Ngọc Minh Anh',
    phone: '0901234567',
    role: Role.CUSTOMER,
    loyaltyTier: LoyaltyTier.GOLD,
    supplierId: null,
  },
  {
    email: 'customer-b@atelier.local',
    fullName: 'Trần Gia Bảo',
    phone: '0901234568',
    role: Role.CUSTOMER,
    loyaltyTier: LoyaltyTier.SILVER,
    supplierId: null,
  },
] as const;

export interface SeedSummary {
  rolesCount: number;
  permissionsCount: number;
  seededUsersCount: number;
  createdUsersCount: number;
}

export async function seedAuthDatabase(db: AtelierDbClient): Promise<SeedSummary> {
  const roleIdByCode = new Map<Role, string>();
  const permIdByCode = new Map<string, string>();

  for (const roleCode of ALL_ROLES) {
    const meta = ROLE_METADATA[roleCode];
    const desiredId = deterministicUuid(`role:${roleCode}`);
    await db.query(
      `INSERT INTO roles (id, code, name, description)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (code) DO NOTHING`,
      [desiredId, roleCode, meta.name, meta.description],
    );
    const existing = await db.query<{ id: string }>('SELECT id FROM roles WHERE code = $1', [
      roleCode,
    ]);
    roleIdByCode.set(roleCode, existing.rows[0].id);
  }

  for (const permCode of ALL_PERMISSIONS) {
    const domain = permCode.split('.')[0] || 'general';
    const desiredId = deterministicUuid(`perm:${permCode}`);
    await db.query(
      `INSERT INTO permissions (id, code, domain, description)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (code) DO NOTHING`,
      [desiredId, permCode, domain, `Quyền ${permCode}`],
    );
    const existing = await db.query<{ id: string }>(
      'SELECT id FROM permissions WHERE code = $1',
      [permCode],
    );
    permIdByCode.set(permCode, existing.rows[0].id);
  }

  // Seed default role_permissions only if a role currently has no permissions mapped
  for (const roleCode of ALL_ROLES) {
    const roleId = roleIdByCode.get(roleCode);
    if (!roleId) {
      continue;
    }
    const countRes = await db.query<{ cnt: string | number }>(
      'SELECT COUNT(*)::int AS cnt FROM role_permissions WHERE role_id = $1',
      [roleId],
    );
    const existingCount = Number(countRes.rows[0]?.cnt ?? 0);
    if (existingCount === 0) {
      const defaultPerms = ROLE_PERMISSIONS[roleCode] ?? [];
      for (const permCode of defaultPerms) {
        const permId = permIdByCode.get(permCode);
        if (!permId) {
          continue;
        }
        await db.query(
          `INSERT INTO role_permissions (role_id, permission_id)
           VALUES ($1, $2)
           ON CONFLICT (role_id, permission_id) DO NOTHING`,
          [roleId, permId],
        );
      }
    }
  }

  let createdUsersCount = 0;

  for (const spec of SEED_USERS) {
    const existingUser = await db.query<{ id: string }>(
      'SELECT id FROM users WHERE LOWER(email) = LOWER($1)',
      [spec.email],
    );

    let userId: string;
    let justCreated = false;

    if (existingUser.rows.length > 0) {
      userId = existingUser.rows[0].id;
    } else {
      userId = deterministicUuid(`user:${spec.email}`);
      const passwordHash = hashPassword(SEED_PASSWORD_PLAIN);
      await db.query(
        `INSERT INTO users (
          id, email, phone, password_hash, full_name, status,
          mfa_enabled, permission_version, loyalty_tier, cod_trust_score, supplier_id
        ) VALUES ($1, $2, $3, $4, $5, $6, FALSE, 1, $7, 100, $8)
        ON CONFLICT (email) DO NOTHING`,
        [
          userId,
          spec.email,
          spec.phone,
          passwordHash,
          spec.fullName,
          UserStatus.ACTIVE,
          spec.loyaltyTier,
          spec.supplierId,
        ],
      );
      const reloaded = await db.query<{ id: string }>(
        'SELECT id FROM users WHERE LOWER(email) = LOWER($1)',
        [spec.email],
      );
      userId = reloaded.rows[0].id;
      createdUsersCount += 1;
      justCreated = true;
    }

    const roleId = roleIdByCode.get(spec.role);
    if (roleId) {
      const roleCountRes = await db.query<{ cnt: string | number }>(
        'SELECT COUNT(*)::int AS cnt FROM user_roles WHERE user_id = $1',
        [userId],
      );
      if (justCreated || Number(roleCountRes.rows[0]?.cnt ?? 0) === 0) {
        await db.query(
          `INSERT INTO user_roles (user_id, role_id)
           VALUES ($1, $2)
           ON CONFLICT (user_id, role_id) DO NOTHING`,
          [userId, roleId],
        );
      }
    }

    const dailyLimit = getDailyTryOnLimitForTier(spec.loyaltyTier);
    await db.query(
      `INSERT INTO tryon_quotas (user_id, daily_limit, used_today, reset_at)
       VALUES ($1, $2, 0, NOW() + INTERVAL '1 day')
       ON CONFLICT (user_id) DO NOTHING`,
      [userId, dailyLimit],
    );

    if (spec.email === 'customer@atelier.local') {
      await db.query(
        `INSERT INTO customer_body_profiles (
          user_id, height_cm, weight_kg, bust_cm, waist_cm, hip_cm, shoulder_cm, fit_preference, updated_at
        ) VALUES ($1, 165, 54, 84, 66, 92, 38, $2, NOW())
        ON CONFLICT (user_id) DO NOTHING`,
        [userId, FitPreference.REGULAR],
      );

      const addrCountRes = await db.query<{ cnt: string | number }>(
        'SELECT COUNT(*)::int AS cnt FROM customer_addresses WHERE user_id = $1',
        [userId],
      );
      if (Number(addrCountRes.rows[0]?.cnt ?? 0) === 0) {
        const addressId = deterministicUuid(`address:${spec.email}:hanoi-default`);
        await db.query(
          `INSERT INTO customer_addresses (
            id, user_id, recipient_name, phone,
            province_code, province_name, district_code, district_name,
            ward_code, ward_name, street_line, is_default
          ) VALUES ($1, $2, $3, $4, '01', 'Thành phố Hà Nội', '002', 'Quận Hoàn Kiếm', '00070', 'Phường Tràng Tiền', '28 Phố Tràng Tiền', TRUE)
          ON CONFLICT (id) DO NOTHING`,
          [addressId, userId, spec.fullName, spec.phone ?? '0901234567'],
        );
      }
    }

    if (spec.email === 'customer-b@atelier.local') {
      await db.query(
        `INSERT INTO customer_body_profiles (
          user_id, height_cm, weight_kg, bust_cm, waist_cm, hip_cm, shoulder_cm, fit_preference, updated_at
        ) VALUES ($1, 172, 66, 92, 76, 94, 43, $2, NOW())
        ON CONFLICT (user_id) DO NOTHING`,
        [userId, FitPreference.REGULAR],
      );

      const addrCountRes = await db.query<{ cnt: string | number }>(
        'SELECT COUNT(*)::int AS cnt FROM customer_addresses WHERE user_id = $1',
        [userId],
      );
      if (Number(addrCountRes.rows[0]?.cnt ?? 0) === 0) {
        const addressId = deterministicUuid(`address:${spec.email}:hcm-default`);
        await db.query(
          `INSERT INTO customer_addresses (
            id, user_id, recipient_name, phone,
            province_code, province_name, district_code, district_name,
            ward_code, ward_name, street_line, is_default
          ) VALUES ($1, $2, $3, $4, '79', 'Thành phố Hồ Chí Minh', '760', 'Quận 1', '26740', 'Phường Bến Nghé', '18 Đường Nguyễn Huệ', TRUE)
          ON CONFLICT (id) DO NOTHING`,
          [addressId, userId, spec.fullName, spec.phone ?? '0901234568'],
        );
      }
    }
  }

  return {
    rolesCount: ALL_ROLES.length,
    permissionsCount: ALL_PERMISSIONS.length,
    seededUsersCount: SEED_USERS.length,
    createdUsersCount,
  };
}
