import { HttpStatus, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import {
  ALL_PERMISSIONS,
  AuditActorType,
  ErrorCode,
  UserStatus,
  type JwtAccessPayload,
  type Permission,
  type Role,
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
import { DatabaseService } from '../infra/database.service';
import { AuthRedisService } from '../infra/redis.service';
import { AuditService } from './audit.service';
import { AuthService, type UserDbRow } from './auth.service';

const VALID_PERMISSION_SET = new Set<string>(ALL_PERMISSIONS);

export interface RoleDetailDto extends RoleWithPermissionsDto {
  id: string;
  code: Role;
  name: string;
}

export interface ListUsersQuery {
  search?: string;
  role?: string;
  status?: string;
}

@Injectable()
export class IamService {
  constructor(
    private readonly db: DatabaseService,
    private readonly redis: AuthRedisService,
    private readonly authService: AuthService,
    private readonly audit: AuditService,
  ) {}

  async listUsers(query: ListUsersQuery = {}): Promise<UserSummaryDto[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (query.status && query.status.trim()) {
      params.push(query.status.trim().toUpperCase());
      conditions.push(`u.status = $${params.length}`);
    }

    if (query.search && query.search.trim()) {
      params.push(`%${query.search.trim()}%`);
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

    const summaries: UserSummaryDto[] = [];
    for (const row of usersRes.rows) {
      summaries.push(await this.authService.buildUserSummary(row));
    }
    return summaries;
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

      await tx.query(
        `UPDATE users
         SET status = $1,
             permission_version = permission_version + 1,
             updated_at = NOW()
         WHERE id = $2`,
        [input.status, targetUserId],
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
