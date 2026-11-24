import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
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
  AuditActorType,
  AuditActorTypeSchema,
  createApiResponse,
  Permission,
  UpdateRolePermissionsSchema,
  UpdateUserRolesSchema,
  UpdateUserStatusSchema,
  type ApiResponse,
  type UserSummaryDto,
} from '@atelier/contracts';
import {
  extractClientIp,
  getCorrelationIdFromRequest,
  parseWithZod,
} from '../common/api-exception';
import { SERVICE_NAME } from '../config/env';
import { AuditService, type AuditLogViewDto } from '../services/audit.service';
import { AuthService } from '../services/auth.service';
import { CustomerService, type TryOnQuotaViewDto } from '../services/customer.service';
import { IamService, type RoleDetailDto } from '../services/iam.service';

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
    private readonly authService: AuthService,
    private readonly iamService: IamService,
    private readonly auditService: AuditService,
    private readonly customerService: CustomerService,
  ) {}

  @Get('me/tryon-quota')
  async getMeTryOnQuota(@Req() req: Request): Promise<ApiResponse<TryOnQuotaViewDto>> {
    const authUser = await this.authService.authenticateRequest(req);
    const data = await this.customerService.getTryOnQuota(authUser.sub);
    return createApiResponse(data, {
      correlationId: getCorrelationIdFromRequest(req),
      service: SERVICE_NAME,
    });
  }

  @Get('users')
  async listUsers(
    @Query('search') search: string | undefined,
    @Query('role') role: string | undefined,
    @Query('status') status: string | undefined,
    @Req() req: Request,
  ): Promise<ApiResponse<UserSummaryDto[]>> {
    await this.authService.authenticateRequest(req, {
      requireMfa: true,
      requiredPermissions: [Permission.ADMIN_RBAC_MANAGE],
    });
    const data = await this.iamService.listUsers({ search, role, status });
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
    @Query('actorType') actorType: string | undefined,
    @Query('resourceType') resourceType: string | undefined,
    @Query('correlationId') correlationId: string | undefined,
    @Query('search') search: string | undefined,
    @Query('limit') limit: string | undefined,
    @Query('offset') offset: string | undefined,
    @Req() req: Request,
  ): Promise<ApiResponse<AuditLogViewDto[]>> {
    await this.authService.authenticateRequest(req, {
      requireMfa: true,
      requiredPermissions: [Permission.ADMIN_AUDIT_READ, Permission.ADMIN_RBAC_MANAGE],
    });
    const data = await this.auditService.list({
      action,
      actorType,
      resourceType,
      correlationId,
      search,
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
    @Query('actorType') actorType: string | undefined,
    @Query('resourceType') resourceType: string | undefined,
    @Query('correlationId') correlationId: string | undefined,
    @Query('search') search: string | undefined,
    @Query('limit') limit: string | undefined,
    @Query('offset') offset: string | undefined,
    @Req() req: Request,
  ): Promise<ApiResponse<AuditLogViewDto[]>> {
    return this.listAuditLogs(
      action,
      actorType,
      resourceType,
      correlationId,
      search,
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
