import * as crypto from 'node:crypto';
import { HttpStatus, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import {
  ALL_PERMISSIONS,
  AuditActorType,
  ErrorCode,
  LoyaltyTier,
  Role,
  UserStatus,
  type AdminCreateUserRequest,
  type AdminReset2FaResultDto,
  type JwtAccessPayload,
  type Permission,
  type Role as RoleType,
  type RoleWithPermissionsDto,
  type UpdateRolePermissionsRequest,
  type UpdateUserRolesRequest,
  type UpdateUserStatusRequest,
  type UserSummaryDto,
} from '@atelier/contracts';
import {
  ApiDomainException,
  extractClientIp,
  getCorrelationIdFromRequest,
} from '../common/api-exception';
import { hashPassword } from '../crypto/password';
import { getDailyTryOnLimitForTier } from '../db/seed';
import { DatabaseService } from '../infra/database.service';
import { AuthRedisService } from '../infra/redis.service';
import { AuditService } from './audit.service';
import {
  AuthService,
  type ExtendedUserSummaryDto,
  type UserDbRow,
} from './auth.service';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_PERMISSION_SET = new Set<string>(ALL_PERMISSIONS);

export interface RoleDetailDto extends RoleWithPermissionsDto {
  id: string;
  code: RoleType;
  name: string;
}

export interface ListUsersQuery {
  search?: string;
  q?: string;
  role?: string;
  status?: string;
}

export interface SoftDeleteUserResult {
  deleted: true;
  deactivated: true;
  id: string;
  isActive: false;
  deletedAt: string;
  revokedSessionsCount: number;
  user: ExtendedUserSummaryDto;
}

export interface ResetUserTwoFactorResult extends AdminReset2FaResultDto {
  reset: true;
  twoFactorVerified: false;
  revokedSessionsCount: number;
  user: ExtendedUserSummaryDto;
}

@Injectable()
export class IamService {
  constructor(
    private readonly db: DatabaseService,
    private readonly redis: AuthRedisService,
    private readonly authService: AuthService,
    private readonly audit: AuditService,
  ) {}

  async listUsers(query: ListUsersQuery = {}): Promise<ExtendedUserSummaryDto[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (query.status && query.status.trim()) {
      params.push(query.status.trim().toUpperCase());
      conditions.push(`u.status = $${params.length}`);
    }

    const searchTerm = (query.search ?? query.q ?? '').trim();
    if (searchTerm) {
      params.push(`%${searchTerm}%`);
      const p = `$${params.length}`;
      conditions.push(`(u.email ILIKE ${p} OR u.full_name ILIKE ${p} OR COALESCE(u.phone, '') ILIKE ${p})`);
    }

    if (query.role && query.role.trim()) {
      params.push(query.role.trim().toUpperCase());
      conditions.push(
        `EXISTS (
          SELECT 1 FROM user_roles ur
          INNER JOIN roles r ON r.id = ur.role_id
          WHERE ur.user_id = u.id AND r.code = $${params.length}
        )`,
      );
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const usersRes = await this.db.query<UserDbRow>(
      `SELECT u.* FROM users u ${whereClause} ORDER BY u.created_at ASC`,
      params,
    );

    const summaries: ExtendedUserSummaryDto[] = [];
    for (const row of usersRes.rows) {
      summaries.push(await this.authService.buildUserSummary(row));
    }
    return summaries;
  }

  async createUser(
    actor: JwtAccessPayload,
    input: AdminCreateUserRequest,
    req: Request,
  ): Promise<ExtendedUserSummaryDto> {
    const email = input.email.trim().toLowerCase();
    const phone = input.phone?.trim() || null;
    const rawSupplierId = input.supplierId?.trim() || null;
    const uniqueRoles = [...new Set(input.roles)];
    const correlationId = getCorrelationIdFromRequest(req);
    const ipAddress = extractClientIp(req);

    if (uniqueRoles.includes(Role.SUPPLIER)) {
      if (!rawSupplierId || !UUID_REGEX.test(rawSupplierId)) {
        throw new ApiDomainException(
          HttpStatus.BAD_REQUEST,
          ErrorCode.VALIDATION_ERROR,
          'Tài khoản đối tác SUPPLIER bắt buộc phải có supplierId (UUID hợp lệ).',
        );
      }
    } else if (rawSupplierId && !UUID_REGEX.test(rawSupplierId)) {
      throw new ApiDomainException(
        HttpStatus.BAD_REQUEST,
        ErrorCode.VALIDATION_ERROR,
        'supplierId phải là UUID hợp lệ.',
      );
    }

    const existingEmail = await this.db.query<{ id: string }>(
      'SELECT id FROM users WHERE LOWER(email) = LOWER($1)',
      [email],
    );
    if (existingEmail.rows.length > 0) {
      throw new ApiDomainException(
        HttpStatus.CONFLICT,
        ErrorCode.CONFLICT,
        `Email "${email}" đã tồn tại trong hệ thống.`,
      );
    }

    if (phone) {
      const existingPhone = await this.db.query<{ id: string }>(
        'SELECT id FROM users WHERE phone = $1',
        [phone],
      );
      if (existingPhone.rows.length > 0) {
        throw new ApiDomainException(
          HttpStatus.CONFLICT,
          ErrorCode.CONFLICT,
          `Số điện thoại "${phone}" đã được sử dụng.`,
        );
      }
    }

    const userId = crypto.randomUUID();
    const passwordHash = hashPassword(input.password);
    const initialStatus = input.status ?? UserStatus.ACTIVE;
    const isActive = initialStatus === UserStatus.ACTIVE;

    const created = await this.db.transaction(async (tx) => {
      const roleRows = await tx.query<{ id: string; code: RoleType }>(
        'SELECT id, code FROM roles WHERE code = ANY($1::text[])',
        [uniqueRoles],
      );
      if (roleRows.rows.length !== uniqueRoles.length) {
        throw new ApiDomainException(
          HttpStatus.BAD_REQUEST,
          ErrorCode.VALIDATION_ERROR,
          'Một hoặc nhiều vai trò không tồn tại trong hệ thống.',
        );
      }

      await tx.query(
        `INSERT INTO users (
           id, email, phone, password_hash, full_name, status, is_active, deleted_at,
           mfa_enabled, permission_version, loyalty_tier, cod_trust_score, supplier_id
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, FALSE, 1, $8, 100, $9)`,
        [
          userId,
          email,
          phone,
          passwordHash,
          input.fullName.trim(),
          initialStatus,
          isActive,
          LoyaltyTier.BRONZE,
          rawSupplierId,
        ],
      );

      for (const roleRow of roleRows.rows) {
        await tx.query(
          `INSERT INTO user_roles (user_id, role_id)
           VALUES ($1, $2)
           ON CONFLICT (user_id, role_id) DO NOTHING`,
          [userId, roleRow.id],
        );
      }

      await tx.query(
        `INSERT INTO tryon_quotas (user_id, daily_limit, used_today, reset_at)
         VALUES ($1, $2, 0, NOW() + INTERVAL '1 day')
         ON CONFLICT (user_id) DO NOTHING`,
        [userId, getDailyTryOnLimitForTier(LoyaltyTier.BRONZE)],
      );

      const summary = await this.authService.loadUserSummaryById(userId, tx);
      if (!summary) {
        throw new Error('Failed to load newly created user.');
      }

      await this.audit.record(
        {
          actorId: actor.sub,
          actorEmail: actor.email,
          actorType: AuditActorType.USER,
          action: 'USER_CREATED',
          resourceType: 'user',
          resourceId: userId,
          beforeJsonb: null,
          afterJsonb: {
            id: summary.id,
            email: summary.email,
            fullName: summary.fullName,
            phone: summary.phone,
            roles: summary.roles,
            supplierId: summary.supplierId,
            status: summary.status,
            isActive: summary.isActive,
          },
          correlationId,
          ipAddress,
        },
        tx,
      );

      return summary;
    });

    await this.redis.setUserPermissionVersion(created.id, created.permissionVersion);
    await this.redis.setUserLocked(created.id, initialStatus === UserStatus.LOCKED);
    return created;
  }

  async softDeleteUser(
    actor: JwtAccessPayload,
    targetUserId: string,
    req: Request,
  ): Promise<SoftDeleteUserResult> {
    if (actor.sub === targetUserId) {
      throw new ApiDomainException(
        HttpStatus.BAD_REQUEST,
        ErrorCode.VALIDATION_ERROR,
        'Không thể tự xóa mềm hoặc vô hiệu hóa tài khoản đang đăng nhập.',
      );
    }
    if (!UUID_REGEX.test(targetUserId)) {
      throw new ApiDomainException(
        HttpStatus.NOT_FOUND,
        ErrorCode.NOT_FOUND,
        'Không tìm thấy người dùng cần vô hiệu hóa.',
      );
    }

    const correlationId = getCorrelationIdFromRequest(req);
    const ipAddress = extractClientIp(req);

    const txResult = await this.db.transaction(async (tx) => {
      const beforeSummary = await this.authService.loadUserSummaryById(targetUserId, tx);
      if (!beforeSummary) {
        throw new ApiDomainException(
          HttpStatus.NOT_FOUND,
          ErrorCode.NOT_FOUND,
          'Không tìm thấy người dùng cần vô hiệu hóa.',
        );
      }

      const deletedAtRes = await tx.query<{ deleted_at: Date | string }>(
        `UPDATE users
         SET status = $1,
             is_active = FALSE,
             deleted_at = NOW(),
             permission_version = permission_version + 1,
             updated_at = NOW()
         WHERE id = $2
         RETURNING deleted_at`,
        [UserStatus.LOCKED, targetUserId],
      );

      const revokedSessions = await tx.query<{
        token_family_id: string;
        last_access_jti: string | null;
      }>(
        `UPDATE auth_sessions
         SET revoked = TRUE
         WHERE user_id = $1 AND revoked = FALSE
         RETURNING token_family_id, last_access_jti`,
        [targetUserId],
      );

      const afterSummary = await this.authService.loadUserSummaryById(targetUserId, tx);
      if (!afterSummary) {
        throw new Error('Failed to reload user after soft delete.');
      }

      const deletedAtIso =
        deletedAtRes.rows[0]?.deleted_at instanceof Date
          ? deletedAtRes.rows[0].deleted_at.toISOString()
          : new Date(deletedAtRes.rows[0]?.deleted_at ?? Date.now()).toISOString();

      await this.audit.record(
        {
          actorId: actor.sub,
          actorEmail: actor.email,
          actorType: AuditActorType.USER,
          action: 'USER_SOFT_DELETED',
          resourceType: 'user',
          resourceId: targetUserId,
          beforeJsonb: {
            email: beforeSummary.email,
            status: beforeSummary.status,
            isActive: beforeSummary.isActive,
            permissionVersion: beforeSummary.permissionVersion,
          },
          afterJsonb: {
            email: afterSummary.email,
            status: afterSummary.status,
            isActive: false,
            deletedAt: deletedAtIso,
            permissionVersion: afterSummary.permissionVersion,
            revokedSessionsCount: revokedSessions.rows.length,
          },
          correlationId,
          ipAddress,
        },
        tx,
      );

      return {
        afterSummary,
        deletedAtIso,
        revokedSessions: revokedSessions.rows,
      };
    });

    await this.redis.setUserLocked(targetUserId, true);
    await this.redis.setUserPermissionVersion(
      targetUserId,
      txResult.afterSummary.permissionVersion,
    );
    await this.redis.deleteEmailOtp(targetUserId);

    const uniqueFamilies = new Set<string>();
    const uniqueJtis = new Set<string>();
    for (const s of txResult.revokedSessions) {
      if (s.token_family_id) uniqueFamilies.add(s.token_family_id);
      if (s.last_access_jti) uniqueJtis.add(s.last_access_jti);
    }
    await Promise.all([
      ...[...uniqueFamilies].map((familyId) => this.redis.revokeTokenFamily(familyId)),
      ...[...uniqueJtis].map((jti) => this.redis.revokeJti(jti, 900)),
    ]);

    return {
      deleted: true,
      deactivated: true,
      id: targetUserId,
      isActive: false,
      deletedAt: txResult.deletedAtIso,
      revokedSessionsCount: txResult.revokedSessions.length,
      user: txResult.afterSummary,
    };
  }

  async resetUserTwoFactor(
    actor: JwtAccessPayload,
    targetUserId: string,
    req: Request,
  ): Promise<ResetUserTwoFactorResult> {
    if (!actor.roles.includes(Role.SUPER_ADMIN) || actor.mfaVerified !== true) {
      throw new ApiDomainException(
        HttpStatus.FORBIDDEN,
        ErrorCode.FORBIDDEN,
        'Chỉ SUPER_ADMIN đã xác thực 2FA mới được phép đặt lại 2FA cho tài khoản.',
      );
    }
    if (!UUID_REGEX.test(targetUserId)) {
      throw new ApiDomainException(
        HttpStatus.NOT_FOUND,
        ErrorCode.NOT_FOUND,
        'Không tìm thấy người dùng cần đặt lại 2FA.',
      );
    }

    const correlationId = getCorrelationIdFromRequest(req);
    const ipAddress = extractClientIp(req);

    const txResult = await this.db.transaction(async (tx) => {
      const beforeSummary = await this.authService.loadUserSummaryById(targetUserId, tx);
      if (!beforeSummary) {
        throw new ApiDomainException(
          HttpStatus.NOT_FOUND,
          ErrorCode.NOT_FOUND,
          'Không tìm thấy người dùng cần đặt lại 2FA.',
        );
      }

      // Clear TOTP secret, recovery codes & verification timestamp so user must re-enroll 2FA
      await tx.query('DELETE FROM two_factor_auth WHERE user_id = $1', [targetUserId]);

      await tx.query(
        `UPDATE users
         SET mfa_enabled = FALSE,
             permission_version = permission_version + 1,
             updated_at = NOW()
         WHERE id = $1`,
        [targetUserId],
      );

      const revokedSessions = await tx.query<{
        token_family_id: string;
        last_access_jti: string | null;
      }>(
        `UPDATE auth_sessions
         SET revoked = TRUE,
             mfa_verified = FALSE
         WHERE user_id = $1 AND revoked = FALSE
         RETURNING token_family_id, last_access_jti`,
        [targetUserId],
      );

      const afterSummary = await this.authService.loadUserSummaryById(targetUserId, tx, false);
      if (!afterSummary) {
        throw new Error('Failed to reload user after 2FA reset.');
      }

      await this.audit.record(
        {
          actorId: actor.sub,
          actorEmail: actor.email,
          actorType: AuditActorType.USER,
          action: 'USER_2FA_RESET',
          resourceType: 'two_factor_auth',
          resourceId: targetUserId,
          beforeJsonb: {
            email: beforeSummary.email,
            mfaEnabled: beforeSummary.mfaEnabled,
            permissionVersion: beforeSummary.permissionVersion,
          },
          afterJsonb: {
            email: afterSummary.email,
            mfaEnabled: false,
            twoFactorVerified: false,
            permissionVersion: afterSummary.permissionVersion,
            revokedSessionsCount: revokedSessions.rows.length,
          },
          correlationId,
          ipAddress,
        },
        tx,
      );

      return {
        afterSummary,
        revokedSessions: revokedSessions.rows,
      };
    });

    await this.redis.setUserPermissionVersion(
      targetUserId,
      txResult.afterSummary.permissionVersion,
    );
    await this.redis.deleteEmailOtp(targetUserId);

    const uniqueFamilies = new Set<string>();
    const uniqueJtis = new Set<string>();
    for (const s of txResult.revokedSessions) {
      if (s.token_family_id) uniqueFamilies.add(s.token_family_id);
      if (s.last_access_jti) uniqueJtis.add(s.last_access_jti);
    }
    await Promise.all([
      ...[...uniqueFamilies].map((familyId) => this.redis.revokeTokenFamily(familyId)),
      ...[...uniqueJtis].map((jti) => this.redis.revokeJti(jti, 900)),
    ]);

    return {
      reset: true,
      userId: targetUserId,
      mfaEnabled: false,
      twoFactorVerified: false,
      revokedSessions: true,
      revokedSessionsCount: txResult.revokedSessions.length,
      resetAt: new Date().toISOString(),
      user: txResult.afterSummary,
    };
  }

  async updateUserRoles(
    actor: JwtAccessPayload,
    targetUserId: string,
    input: UpdateUserRolesRequest,
    req: Request,
  ): Promise<UserSummaryDto> {
    const correlationId = getCorrelationIdFromRequest(req);
    const ipAddress = extractClientIp(req);

    const result = await this.db.transaction(async (tx) => {
      const beforeSummary = await this.authService.loadUserSummaryById(targetUserId, tx);
      if (!beforeSummary) {
        throw new ApiDomainException(
          HttpStatus.NOT_FOUND,
          ErrorCode.NOT_FOUND,
          'Không tìm thấy người dùng cần cập nhật vai trò.',
        );
      }

      const uniqueRoles = [...new Set(input.roles)];
      const roleRows = await tx.query<{ id: string; code: Role }>(
        'SELECT id, code FROM roles WHERE code = ANY($1::text[])',
        [uniqueRoles],
      );
      if (roleRows.rows.length !== uniqueRoles.length) {
        throw new ApiDomainException(
          HttpStatus.BAD_REQUEST,
          ErrorCode.VALIDATION_ERROR,
          'Một hoặc nhiều vai trò không tồn tại trong hệ thống.',
        );
      }

      await tx.query('DELETE FROM user_roles WHERE user_id = $1', [targetUserId]);
      for (const roleRow of roleRows.rows) {
        await tx.query(
          `INSERT INTO user_roles (user_id, role_id)
           VALUES ($1, $2)
           ON CONFLICT (user_id, role_id) DO NOTHING`,
          [targetUserId, roleRow.id],
        );
      }

      if (input.supplierId !== undefined) {
        await tx.query(
          `UPDATE users
           SET permission_version = permission_version + 1,
               supplier_id = $1,
               updated_at = NOW()
           WHERE id = $2`,
          [input.supplierId, targetUserId],
        );
      } else {
        await tx.query(
          `UPDATE users
           SET permission_version = permission_version + 1,
               updated_at = NOW()
           WHERE id = $1`,
          [targetUserId],
        );
      }

      const afterSummary = await this.authService.loadUserSummaryById(targetUserId, tx);
      if (!afterSummary) {
        throw new Error('Failed to reload user after updating roles.');
      }

      await this.audit.record(
        {
          actorId: actor.sub,
          actorEmail: actor.email,
          actorType: AuditActorType.USER,
          action: 'USER_ROLES_UPDATED',
          resourceType: 'user',
          resourceId: targetUserId,
          beforeJsonb: {
            email: beforeSummary.email,
            roles: beforeSummary.roles,
            permissions: beforeSummary.permissions,
            permissionVersion: beforeSummary.permissionVersion,
            supplierId: beforeSummary.supplierId,
          },
          afterJsonb: {
            email: afterSummary.email,
            roles: afterSummary.roles,
            permissions: afterSummary.permissions,
            permissionVersion: afterSummary.permissionVersion,
            supplierId: afterSummary.supplierId,
          },
          correlationId,
          ipAddress,
        },
        tx,
      );

      return afterSummary;
    });

    await this.redis.setUserPermissionVersion(result.id, result.permissionVersion);
    return result;
  }

  async updateUserStatus(
    actor: JwtAccessPayload,
    targetUserId: string,
    input: UpdateUserStatusRequest,
    req: Request,
  ): Promise<UserSummaryDto> {
    const correlationId = getCorrelationIdFromRequest(req);
    const ipAddress = extractClientIp(req);

    const { afterSummary, revokedJtis } = await this.db.transaction(async (tx) => {
      const beforeSummary = await this.authService.loadUserSummaryById(targetUserId, tx);
      if (!beforeSummary) {
        throw new ApiDomainException(
          HttpStatus.NOT_FOUND,
          ErrorCode.NOT_FOUND,
          'Không tìm thấy người dùng cần cập nhật trạng thái.',
        );
      }

      const nextIsActive = input.status === UserStatus.ACTIVE;
      await tx.query(
        `UPDATE users
         SET status = $1,
             is_active = $2,
             deleted_at = CASE WHEN $2 THEN NULL ELSE deleted_at END,
             permission_version = permission_version + 1,
             updated_at = NOW()
         WHERE id = $3`,
        [input.status, nextIsActive, targetUserId],
      );

      let jtis: string[] = [];
      if (input.status === UserStatus.LOCKED) {
        const activeSessions = await tx.query<{ last_access_jti: string | null }>(
          `UPDATE auth_sessions
           SET revoked = TRUE
           WHERE user_id = $1 AND revoked = FALSE
           RETURNING last_access_jti`,
          [targetUserId],
        );
        jtis = activeSessions.rows
          .map((row) => row.last_access_jti)
          .filter((jti): jti is string => typeof jti === 'string' && jti.length > 0);
      }

      const reloaded = await this.authService.loadUserSummaryById(targetUserId, tx);
      if (!reloaded) {
        throw new Error('Failed to reload user after status update.');
      }

      await this.audit.record(
        {
          actorId: actor.sub,
          actorEmail: actor.email,
          actorType: AuditActorType.USER,
          action: 'USER_STATUS_UPDATED',
          resourceType: 'user',
          resourceId: targetUserId,
          beforeJsonb: {
            email: beforeSummary.email,
            status: beforeSummary.status,
            permissionVersion: beforeSummary.permissionVersion,
          },
          afterJsonb: {
            email: reloaded.email,
            status: reloaded.status,
            permissionVersion: reloaded.permissionVersion,
            ...(input.reason ? { reason: input.reason } : {}),
          },
          correlationId,
          ipAddress,
        },
        tx,
      );

      return { afterSummary: reloaded, revokedJtis: jtis };
    });

    await this.redis.setUserPermissionVersion(afterSummary.id, afterSummary.permissionVersion);
    await this.redis.setUserLocked(afterSummary.id, afterSummary.status === UserStatus.LOCKED);
    for (const jti of revokedJtis) {
      await this.redis.revokeJti(jti, 900);
    }

    return afterSummary;
  }

  async listRoles(): Promise<RoleDetailDto[]> {
    const rolesRes = await this.db.query<{
      id: string;
      code: Role;
      name: string;
      description: string;
    }>('SELECT id, code, name, description FROM roles ORDER BY code ASC');

    const result: RoleDetailDto[] = [];
    for (const roleRow of rolesRes.rows) {
      const permsRes = await this.db.query<{ code: string }>(
        `SELECT p.code
         FROM permissions p
         INNER JOIN role_permissions rp ON rp.permission_id = p.id
         WHERE rp.role_id = $1
         ORDER BY p.code ASC`,
        [roleRow.id],
      );
      const permissions = permsRes.rows
        .map((row) => row.code)
        .filter((code): code is Permission => VALID_PERMISSION_SET.has(code));

      result.push({
        id: roleRow.id,
        code: roleRow.code,
        role: roleRow.code,
        name: roleRow.name,
        description: roleRow.description,
        permissions,
      });
    }
    return result;
  }

  async updateRolePermissions(
    actor: JwtAccessPayload,
    roleIdOrCode: string,
    input: UpdateRolePermissionsRequest,
    req: Request,
  ): Promise<RoleDetailDto> {
    const correlationId = getCorrelationIdFromRequest(req);
    const ipAddress = extractClientIp(req);

    const { updatedRole, affectedUsers } = await this.db.transaction(async (tx) => {
      const roleRes = await tx.query<{
        id: string;
        code: Role;
        name: string;
        description: string;
      }>('SELECT id, code, name, description FROM roles WHERE id::text = $1 OR code = $1', [
        roleIdOrCode,
      ]);
      if (roleRes.rows.length === 0) {
        throw new ApiDomainException(
          HttpStatus.NOT_FOUND,
          ErrorCode.NOT_FOUND,
          'Không tìm thấy vai trò cần cập nhật quyền.',
        );
      }

      const role = roleRes.rows[0];
      const beforePermsRes = await tx.query<{ code: string }>(
        `SELECT p.code
         FROM permissions p
         INNER JOIN role_permissions rp ON rp.permission_id = p.id
         WHERE rp.role_id = $1
         ORDER BY p.code ASC`,
        [role.id],
      );
      const beforePermissions = beforePermsRes.rows.map((r) => r.code);

      const uniquePerms = [...new Set(input.permissions)];
      const permRows =
        uniquePerms.length > 0
          ? await tx.query<{ id: string; code: Permission }>(
              'SELECT id, code FROM permissions WHERE code = ANY($1::text[])',
              [uniquePerms],
            )
          : { rows: [] as { id: string; code: Permission }[] };

      if (permRows.rows.length !== uniquePerms.length) {
        throw new ApiDomainException(
          HttpStatus.BAD_REQUEST,
          ErrorCode.VALIDATION_ERROR,
          'Một hoặc nhiều mã quyền không hợp lệ.',
        );
      }

      await tx.query('DELETE FROM role_permissions WHERE role_id = $1', [role.id]);
      for (const permRow of permRows.rows) {
        await tx.query(
          `INSERT INTO role_permissions (role_id, permission_id)
           VALUES ($1, $2)
           ON CONFLICT (role_id, permission_id) DO NOTHING`,
          [role.id, permRow.id],
        );
      }

      const bumpedUsers = await tx.query<{ id: string; permission_version: number }>(
        `UPDATE users
         SET permission_version = permission_version + 1,
             updated_at = NOW()
         WHERE id IN (SELECT user_id FROM user_roles WHERE role_id = $1)
         RETURNING id, permission_version`,
        [role.id],
      );

      const afterPermissions = permRows.rows
        .map((r) => r.code)
        .sort((a, b) => a.localeCompare(b));

      await this.audit.record(
        {
          actorId: actor.sub,
          actorEmail: actor.email,
          actorType: AuditActorType.USER,
          action: 'ROLE_PERMISSIONS_UPDATED',
          resourceType: 'role',
          resourceId: role.id,
          beforeJsonb: {
            roleCode: role.code,
            permissions: beforePermissions,
          },
          afterJsonb: {
            roleCode: role.code,
            permissions: afterPermissions,
            affectedUsersCount: bumpedUsers.rows.length,
          },
          correlationId,
          ipAddress,
        },
        tx,
      );

      return {
        updatedRole: {
          id: role.id,
          code: role.code,
          role: role.code,
          name: role.name,
          description: role.description,
          permissions: afterPermissions,
        },
        affectedUsers: bumpedUsers.rows,
      };
    });

    for (const affected of affectedUsers) {
      await this.redis.setUserPermissionVersion(affected.id, Number(affected.permission_version));
    }

    return updatedRole;
  }
}
