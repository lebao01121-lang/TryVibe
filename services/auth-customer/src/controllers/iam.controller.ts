import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import {
  AdminCreateUserDtoSchema,
  AuditActorType,
  AuditActorTypeSchema,
  createApiResponse,
  ErrorCode,
  Permission,
  Role,
  UpdateRolePermissionsSchema,
  UpdateUserRolesSchema,
  UpdateUserStatusSchema,
  type ApiResponse,
  type UserSummaryDto,
} from '@atelier/contracts';
import {
  ApiDomainException,
  extractClientIp,
  getCorrelationIdFromRequest,
  parseWithZod,
} from '../common/api-exception';
import { AUTH_CONFIG_TOKEN, SERVICE_NAME, type AuthCustomerConfig } from '../config/env';
import { constantTimeEqualString } from '../crypto/jwks.service';
import {
  AuditService,
  type AuditLogViewDto,
  type PaginatedAuditLogsView,
} from '../services/audit.service';
import { AuthService, type ExtendedUserSummaryDto } from '../services/auth.service';
import {
  CustomerService,
  type PaginatedAdminCustomersResult,
  type TryOnQuotaViewDto,
} from '../services/customer.service';
import {
  IamService,
  type ResetUserTwoFactorResult,
  type RoleDetailDto,
  type SoftDeleteUserResult,
} from '../services/iam.service';

const InternalAuditLogSchema = z.object({
  actorId: z.string().nullable().optional(),
  actorEmail: z.string().nullable().optional(),
  actorType: AuditActorTypeSchema.default(AuditActorType.USER),
  action: z.string().trim().min(1).max(120),
  resourceType: z.string().trim().min(1).max(120),
  resourceId: z.string().nullable().optional(),
  beforeJsonb: z.record(z.unknown()).nullable().optional(),
  afterJsonb: z.record(z.unknown()).nullable().optional(),
  before_jsonb: z.record(z.unknown()).nullable().optional(),
  after_jsonb: z.record(z.unknown()).nullable().optional(),
  metadata: z.record(z.unknown()).optional(),
  correlationId: z.string().nullable().optional(),
  ipAddress: z.string().nullable().optional(),
});

@Controller('v1')
export class IamController {
  constructor(
    @Inject(AUTH_CONFIG_TOKEN) private readonly config: AuthCustomerConfig,
    private readonly authService: AuthService,
    private readonly iamService: IamService,
    private readonly auditService: AuditService,
    private readonly customerService: CustomerService,
  ) {}

  private hasValidInternalSecret(req: Request): boolean {
    const rawHeader = req.headers['x-internal-secret'];
    const candidate = (Array.isArray(rawHeader) ? rawHeader[0] : rawHeader)?.trim() ?? '';
    const expected = this.config.security.internalServiceSecret;
    return Boolean(candidate && expected && constantTimeEqualString(candidate, expected));
  }

  private assertInternalSecret(req: Request): void {
    if (!this.hasValidInternalSecret(req)) {
      throw new ApiDomainException(
        HttpStatus.FORBIDDEN,
        ErrorCode.FORBIDDEN,
        'Thiếu hoặc sai mã xác thực nội bộ (x-internal-secret).',
      );
    }
  }

  @Get('me/tryon-quota')
  async getMeTryOnQuota(@Req() req: Request): Promise<ApiResponse<TryOnQuotaViewDto>> {
    const authUser = await this.authService.authenticateRequest(req);
    const data = await this.customerService.getTryOnQuota(authUser.sub);
    return createApiResponse(data, {
      correlationId: getCorrelationIdFromRequest(req),
      service: SERVICE_NAME,
    });
  }

  @Get('customers')
  async listCustomersAdmin(
    @Query('q') q: string | undefined,
    @Query('search') search: string | undefined,
    @Query('vipTier') vipTier: string | undefined,
    @Query('loyaltyTier') loyaltyTier: string | undefined,
    @Query('isActive') isActiveRaw: string | undefined,
    @Query('status') status: string | undefined,
    @Query('page') page: string | undefined,
    @Query('limit') limit: string | undefined,
    @Query('pageSize') pageSize: string | undefined,
    @Req() req: Request,
  ): Promise<ApiResponse<PaginatedAdminCustomersResult>> {
    if (!this.hasValidInternalSecret(req)) {
      await this.authService.authenticateRequest(req, {
        requiredPermissions: [
          Permission.ORDER_READ,
          Permission.CATALOG_PRODUCT_READ,
          Permission.ADMIN_AUDIT_READ,
          Permission.ADMIN_RBAC_MANAGE,
        ],
      });
    }

    let isActive: boolean | undefined;
    if (isActiveRaw !== undefined && isActiveRaw !== '') {
      const lowered = isActiveRaw.trim().toLowerCase();
      if (lowered === 'true' || lowered === '1') isActive = true;
      else if (lowered === 'false' || lowered === '0') isActive = false;
    }

    const rawLimit = limit ?? pageSize;
    const data = await this.customerService.listCustomersAdmin({
      q,
      search,
      vipTier,
      loyaltyTier,
      isActive,
      status,
      page: page ? Number.parseInt(page, 10) : undefined,
      limit: rawLimit ? Number.parseInt(rawLimit, 10) : undefined,
    });
    return createApiResponse(data, {
      correlationId: getCorrelationIdFromRequest(req),
      service: SERVICE_NAME,
    });
  }

  @Get('users')
  async listUsers(
    @Query('search') search: string | undefined,
    @Query('q') q: string | undefined,
    @Query('role') role: string | undefined,
    @Query('status') status: string | undefined,
    @Req() req: Request,
  ): Promise<ApiResponse<ExtendedUserSummaryDto[]>> {
    await this.authService.authenticateRequest(req, {
      requireMfa: true,
      requiredPermissions: [Permission.ADMIN_RBAC_MANAGE],
    });
    const data = await this.iamService.listUsers({ search: search ?? q, role, status });
    return createApiResponse(data, {
      correlationId: getCorrelationIdFromRequest(req),
      service: SERVICE_NAME,
    });
  }

  @Post('users')
  @HttpCode(HttpStatus.CREATED)
  async createUser(
    @Body() body: unknown,
    @Req() req: Request,
  ): Promise<ApiResponse<ExtendedUserSummaryDto>> {
    const actor = await this.authService.authenticateRequest(req, {
      requireMfa: true,
      requiredPermissions: [Permission.ADMIN_RBAC_MANAGE],
    });
    const input = parseWithZod(AdminCreateUserDtoSchema, body);
    const data = await this.iamService.createUser(actor, input, req);
    return createApiResponse(data, {
      correlationId: getCorrelationIdFromRequest(req),
      service: SERVICE_NAME,
    });
  }

  @Delete('users/:id')
  async softDeleteUser(
    @Param('id') id: string,
    @Req() req: Request,
  ): Promise<ApiResponse<SoftDeleteUserResult>> {
    const actor = await this.authService.authenticateRequest(req, {
      requireMfa: true,
      requiredPermissions: [Permission.ADMIN_RBAC_MANAGE],
    });
    const data = await this.iamService.softDeleteUser(actor, id, req);
    return createApiResponse(data, {
      correlationId: getCorrelationIdFromRequest(req),
      service: SERVICE_NAME,
    });
  }

  @Post('users/:id/reset-2fa')
  @HttpCode(HttpStatus.OK)
  async resetUserTwoFactor(
    @Param('id') id: string,
    @Req() req: Request,
  ): Promise<ApiResponse<ResetUserTwoFactorResult>> {
    const actor = await this.authService.authenticateRequest(req, {
      requireMfa: true,
      requiredPermissions: [Permission.ADMIN_RBAC_MANAGE],
    });
    if (!actor.roles.includes(Role.SUPER_ADMIN) || actor.mfaVerified !== true) {
      throw new ApiDomainException(
        HttpStatus.FORBIDDEN,
        ErrorCode.FORBIDDEN,
        'Chỉ SUPER_ADMIN đã xác thực 2FA mới được phép đặt lại 2FA.',
      );
    }
    const data = await this.iamService.resetUserTwoFactor(actor, id, req);
    return createApiResponse(data, {
      correlationId: getCorrelationIdFromRequest(req),
      service: SERVICE_NAME,
    });
  }

  @Patch('users/:id/roles')
  async updateUserRoles(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: Request,
  ): Promise<ApiResponse<UserSummaryDto>> {
    const actor = await this.authService.authenticateRequest(req, {
      requireMfa: true,
      requiredPermissions: [Permission.ADMIN_RBAC_MANAGE],
    });
    const input = parseWithZod(UpdateUserRolesSchema, body);
    const data = await this.iamService.updateUserRoles(actor, id, input, req);
    return createApiResponse(data, {
      correlationId: getCorrelationIdFromRequest(req),
      service: SERVICE_NAME,
    });
  }

  @Patch('users/:id/status')
  async updateUserStatus(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: Request,
  ): Promise<ApiResponse<UserSummaryDto>> {
    const actor = await this.authService.authenticateRequest(req, {
      requireMfa: true,
      requiredPermissions: [Permission.ADMIN_RBAC_MANAGE],
    });
    const input = parseWithZod(UpdateUserStatusSchema, body);
    const data = await this.iamService.updateUserStatus(actor, id, input, req);
    return createApiResponse(data, {
      correlationId: getCorrelationIdFromRequest(req),
      service: SERVICE_NAME,
    });
  }

  @Get('roles')
  async listRoles(@Req() req: Request): Promise<ApiResponse<RoleDetailDto[]>> {
    await this.authService.authenticateRequest(req, {
      requireMfa: true,
      requiredPermissions: [Permission.ADMIN_RBAC_MANAGE],
    });
    const data = await this.iamService.listRoles();
    return createApiResponse(data, {
      correlationId: getCorrelationIdFromRequest(req),
      service: SERVICE_NAME,
    });
  }

  @Put('roles/:id/permissions')
  async updateRolePermissions(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: Request,
  ): Promise<ApiResponse<RoleDetailDto>> {
    const actor = await this.authService.authenticateRequest(req, {
      requireMfa: true,
      requiredPermissions: [Permission.ADMIN_RBAC_MANAGE],
    });
    const input = parseWithZod(UpdateRolePermissionsSchema, body);
    const data = await this.iamService.updateRolePermissions(actor, id, input, req);
    return createApiResponse(data, {
      correlationId: getCorrelationIdFromRequest(req),
      service: SERVICE_NAME,
    });
  }

  @Get('audit-logs')
  async listAuditLogs(
    @Query('action') action: string | undefined,
    @Query('actor') actor: string | undefined,
    @Query('actorType') actorType: string | undefined,
    @Query('resourceType') resourceType: string | undefined,
    @Query('correlationId') correlationId: string | undefined,
    @Query('search') search: string | undefined,
    @Query('q') q: string | undefined,
    @Query('from') from: string | undefined,
    @Query('to') to: string | undefined,
    @Query('page') page: string | undefined,
    @Query('limit') limit: string | undefined,
    @Query('offset') offset: string | undefined,
    @Req() req: Request,
  ): Promise<ApiResponse<PaginatedAuditLogsView>> {
    await this.authService.authenticateRequest(req, {
      requireMfa: true,
      requiredPermissions: [Permission.ADMIN_AUDIT_READ, Permission.ADMIN_RBAC_MANAGE],
    });
    const data = await this.auditService.listPaginated({
      action,
      actor,
      actorType,
      resourceType,
      correlationId,
      search: search ?? q,
      from,
      to,
      page: page ? Number.parseInt(page, 10) : undefined,
      limit: limit ? Number.parseInt(limit, 10) : undefined,
      offset: offset ? Number.parseInt(offset, 10) : undefined,
    });
    return createApiResponse(data, {
      correlationId: getCorrelationIdFromRequest(req),
      service: SERVICE_NAME,
    });
  }

  @Get('admin/audit-logs')
  async listAdminAuditLogsAlias(
    @Query('action') action: string | undefined,
    @Query('actor') actor: string | undefined,
    @Query('actorType') actorType: string | undefined,
    @Query('resourceType') resourceType: string | undefined,
    @Query('correlationId') correlationId: string | undefined,
    @Query('search') search: string | undefined,
    @Query('q') q: string | undefined,
    @Query('from') from: string | undefined,
    @Query('to') to: string | undefined,
    @Query('page') page: string | undefined,
    @Query('limit') limit: string | undefined,
    @Query('offset') offset: string | undefined,
    @Req() req: Request,
  ): Promise<ApiResponse<PaginatedAuditLogsView>> {
    return this.listAuditLogs(
      action,
      actor,
      actorType,
      resourceType,
      correlationId,
      search,
      q,
      from,
      to,
      page,
      limit,
      offset,
      req,
    );
  }

  @Post('internal/audit-logs')
  @HttpCode(HttpStatus.CREATED)
  async recordInternalAuditLog(
    @Body() body: unknown,
    @Req() req: Request,
  ): Promise<ApiResponse<AuditLogViewDto>> {
    this.assertInternalSecret(req);
    const input = parseWithZod(InternalAuditLogSchema, body);
    const reqCorrelationId = getCorrelationIdFromRequest(req);
    const data = await this.auditService.record({
      actorId: input.actorId ?? null,
      actorEmail: input.actorEmail ?? null,
      actorType: input.actorType,
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId ?? null,
      beforeJsonb: input.beforeJsonb ?? input.before_jsonb ?? null,
      afterJsonb: input.afterJsonb ?? input.after_jsonb ?? null,
      metadata: input.metadata ?? {},
      correlationId: input.correlationId ?? reqCorrelationId,
      ipAddress: input.ipAddress ?? extractClientIp(req),
    });

    return createApiResponse(data, {
      correlationId: reqCorrelationId,
      service: SERVICE_NAME,
    });
  }
}
