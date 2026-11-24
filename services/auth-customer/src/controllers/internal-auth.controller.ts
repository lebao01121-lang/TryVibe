import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import {
  AuditActorType,
  AuditActorTypeSchema,
  createApiResponse,
  ErrorCode,
  type ApiResponse,
} from '@atelier/contracts';
import {
  ApiDomainException,
  extractClientIp,
  getCorrelationIdFromRequest,
  parseWithZod,
} from '../common/api-exception';
import { AUTH_CONFIG_TOKEN, SERVICE_NAME, type AuthCustomerConfig } from '../config/env';
import { constantTimeEqualString } from '../crypto/jwks.service';
import { AuditService, type AuditLogViewDto } from '../services/audit.service';
import {
  CustomerService,
  type TryOnQuotaViewDto,
  type UserCheckoutProfileDto,
} from '../services/customer.service';

const TryOnQuotaBonusSchema = z.object({
  userId: z.string().trim().min(1),
  bonusCredits: z.number().int().positive().max(100).default(5),
  reason: z.string().trim().max(240).optional(),
});

const InternalPhase5AuditLogSchema = z.object({
  actorId: z.string().nullable().optional(),
  actorEmail: z.string().nullable().optional(),
  actorType: AuditActorTypeSchema.default(AuditActorType.USER),
  action: z.string().trim().min(1).max(120),
  targetType: z.string().trim().min(1).max(120).optional(),
  resourceType: z.string().trim().min(1).max(120).optional(),
  targetId: z.string().nullable().optional(),
  resourceId: z.string().nullable().optional(),
  beforeJsonb: z.record(z.unknown()).nullable().optional(),
  afterJsonb: z.record(z.unknown()).nullable().optional(),
  metadataJson: z.record(z.unknown()).optional(),
  metadata: z.record(z.unknown()).optional(),
  correlationId: z.string().nullable().optional(),
  ipAddress: z.string().nullable().optional(),
});

@Controller('internal/auth')
export class InternalAuthController {
  constructor(
    @Inject(AUTH_CONFIG_TOKEN) private readonly config: AuthCustomerConfig,
    private readonly customerService: CustomerService,
    private readonly auditService: AuditService,
  ) {}

  private assertInternalSecret(req: Request): void {
    const rawHeader = req.headers['x-internal-secret'];
    const candidate = (Array.isArray(rawHeader) ? rawHeader[0] : rawHeader)?.trim() ?? '';
    const expected = this.config.security.internalServiceSecret;
    if (!candidate || !constantTimeEqualString(candidate, expected)) {
      throw new ApiDomainException(
        HttpStatus.FORBIDDEN,
        ErrorCode.FORBIDDEN,
        'Thiếu hoặc sai mã xác thực nội bộ (x-internal-secret).',
      );
    }
  }

  @Post('tryon-quota/bonus')
  @HttpCode(HttpStatus.OK)
  async grantTryOnQuotaBonus(
    @Body() body: unknown,
    @Req() req: Request,
  ): Promise<ApiResponse<TryOnQuotaViewDto & { bonusCredits: number }>> {
    this.assertInternalSecret(req);
    const input = parseWithZod(TryOnQuotaBonusSchema, body);
    const correlationId = getCorrelationIdFromRequest(req);
    const data = await this.customerService.grantTryOnQuotaBonus({
      userId: input.userId,
      bonusCredits: input.bonusCredits,
      reason: input.reason,
      correlationId,
      ipAddress: extractClientIp(req),
    });

    return createApiResponse(data, {
      correlationId,
      service: SERVICE_NAME,
    });
  }

  @Get('users/:userId/checkout-profile')
  async getUserCheckoutProfile(
    @Param('userId') userId: string,
    @Req() req: Request,
  ): Promise<ApiResponse<UserCheckoutProfileDto>> {
    this.assertInternalSecret(req);
    const data = await this.customerService.getCheckoutProfile(userId);
    return createApiResponse(data, {
      correlationId: getCorrelationIdFromRequest(req),
      service: SERVICE_NAME,
    });
  }

  @Post('audit-logs')
  @HttpCode(HttpStatus.CREATED)
  async createInternalAuditLog(
    @Body() body: unknown,
    @Req() req: Request,
  ): Promise<ApiResponse<AuditLogViewDto>> {
    this.assertInternalSecret(req);
    const input = parseWithZod(InternalPhase5AuditLogSchema, body);
    const reqCorrelationId = getCorrelationIdFromRequest(req);

    const data = await this.auditService.record({
      actorId: input.actorId ?? null,
      actorEmail: input.actorEmail ?? null,
      actorType: input.actorType,
      action: input.action,
      resourceType: input.targetType ?? input.resourceType ?? 'system',
      resourceId: input.targetId ?? input.resourceId ?? null,
      beforeJsonb: input.beforeJsonb ?? null,
      afterJsonb: input.afterJsonb ?? input.metadataJson ?? null,
      metadata: input.metadataJson ?? input.metadata ?? {},
      correlationId: input.correlationId ?? reqCorrelationId,
      ipAddress: input.ipAddress ?? extractClientIp(req),
    });

    return createApiResponse(data, {
      correlationId: reqCorrelationId,
      service: SERVICE_NAME,
    });
  }
}
