import {
  Body,
  Controller,
  Delete,
  Get,
  HttpException,
  HttpStatus,
  Inject,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { redactRestrictedFields } from '@atelier/ai-harness';
import {
  createApiErrorResponse,
  ErrorCode,
  hasPermission,
  Permission,
  Role,
  type JwtAccessPayload,
} from '@atelier/contracts';
import { getOrCreateCorrelationId, type HeaderBag } from '@atelier/observability';
import type { Request, Response } from 'express';
import { HttpProxyService } from '../common/http-proxy.service';
import { BffRedisService } from '../common/redis.service';
import { buildCanonicalQueryString } from '../common/sanitize';
import { BFF_CONFIG_TOKEN, type BffConfig } from '../config/env';
import { AuditLoggerService } from '../security/audit-logger.service';
import { CurrentUser, RequirePermissions } from '../security/auth-types';
import { AdminPortalGuard, JwtAuthGuard } from '../security/guards';

const ALLOWED_RAG_ROLES: ReadonlySet<Role> = new Set([
  Role.SUPER_ADMIN,
  Role.CATALOG_AI_OPERATOR,
]);

const COPILOT_CACHE_PATTERN = 'copilot:cache:*';

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function extractDataObject(body: unknown): Record<string, unknown> | null {
  const root = asRecord(body);
  if (!root) {
    return null;
  }
  const inner = asRecord(root.data);
  return inner ?? root;
}

function summarizeDocForAudit(
  snapshot: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!snapshot) {
    return null;
  }
  const content = typeof snapshot.content === 'string' ? snapshot.content : undefined;
  return {
    ...snapshot,
    ...(content !== undefined && content.length > 800
      ? {
          content: `${content.slice(0, 800)}…`,
          contentLength: content.length,
        }
      : {}),
  };
}

function extractBeforeAfter(
  upstreamBody: unknown,
  fallbackBefore: Record<string, unknown> | null,
): {
  beforeJsonb: Record<string, unknown> | null;
  afterJsonb: Record<string, unknown> | null;
} {
  const dataObj = extractDataObject(upstreamBody);
  const upstreamBefore = asRecord(dataObj?.before);
  const upstreamAfter = asRecord(dataObj?.after) ?? asRecord(dataObj?.document) ?? dataObj;
  return {
    beforeJsonb: summarizeDocForAudit(upstreamBefore ?? fallbackBefore),
    afterJsonb: summarizeDocForAudit(upstreamAfter),
  };
}

function extractDocumentId(
  upstreamBody: unknown,
  fallbackId: string | null = null,
): string | null {
  const dataObj = extractDataObject(upstreamBody);
  const docObj = asRecord(dataObj?.after) ?? asRecord(dataObj?.document) ?? dataObj;
  const candidate = docObj?.id ?? dataObj?.id ?? fallbackId;
  return typeof candidate === 'string' && candidate.trim().length > 0
    ? candidate.trim()
    : fallbackId;
}

function attachCopilotCacheFlushMeta(
  body: unknown,
  flushedBffCacheKeys: number,
): unknown {
  const rec = asRecord(body);
  if (!rec) {
    return body;
  }
  const existingMeta = asRecord(rec.meta) ?? {};
  return {
    ...rec,
    meta: {
      ...existingMeta,
      copilotCacheFlushed: true,
      flushedBffCacheKeys,
    },
  };
}

@Controller('api/v1/admin/rag')
@UseGuards(JwtAuthGuard, AdminPortalGuard)
export class AdminRagController {
  constructor(
    @Inject(BFF_CONFIG_TOKEN) private readonly config: BffConfig,
    @Inject(HttpProxyService) private readonly proxy: HttpProxyService,
    @Inject(BffRedisService) private readonly redis: BffRedisService,
    @Inject(AuditLoggerService) private readonly audit: AuditLoggerService,
  ) {}

  // ============================================================================
  // Strict Zero-Trust RBAC Guard (SUPER_ADMIN & CATALOG_AI_OPERATOR ONLY)
  // ============================================================================

  private assertRagOperatorAccess(
    user: JwtAccessPayload,
    correlationId: string,
    options?: { requireSuperAdminMfa?: boolean },
  ): void {
    const hasAllowedRole = user.roles.some((role) => ALLOWED_RAG_ROLES.has(role));
    if (!hasAllowedRole) {
      throw new HttpException(
        createApiErrorResponse(
          ErrorCode.FORBIDDEN,
          'Chỉ SUPER_ADMIN và CATALOG_AI_OPERATOR mới được phép truy cập quản trị Tri thức AI (RAG).',
          {
            roles: user.roles,
            allowedRoles: [Role.SUPER_ADMIN, Role.CATALOG_AI_OPERATOR],
          },
          { correlationId, service: this.config.serviceName },
        ),
        HttpStatus.FORBIDDEN,
      );
    }

    const isSuperAdmin = user.roles.includes(Role.SUPER_ADMIN);
    if (!isSuperAdmin) {
      const hasWrite =
        user.permissions.includes(Permission.CATALOG_PRODUCT_WRITE) ||
        hasPermission(user.roles, Permission.CATALOG_PRODUCT_WRITE);
      const hasAiApprove =
        user.permissions.includes(Permission.CATALOG_AI_APPROVE) ||
        hasPermission(user.roles, Permission.CATALOG_AI_APPROVE);

      if (!hasWrite || !hasAiApprove) {
        throw new HttpException(
          createApiErrorResponse(
            ErrorCode.FORBIDDEN,
            'Thiếu quyền tối thiểu (catalog.product.write & catalog.ai.approve) để quản trị Tri thức AI (RAG).',
            { roles: user.roles },
            { correlationId, service: this.config.serviceName },
          ),
          HttpStatus.FORBIDDEN,
        );
      }
    }

    if (options?.requireSuperAdminMfa && isSuperAdmin && user.mfaVerified !== true) {
      throw new HttpException(
        createApiErrorResponse(
          ErrorCode.MFA_REQUIRED,
          'SUPER_ADMIN bắt buộc xác thực 2FA (mfaVerified) trước khi Re-index Vector RAG.',
          { roles: user.roles },
          { correlationId, service: this.config.serviceName },
        ),
        HttpStatus.FORBIDDEN,
      );
    }
  }

  private buildInternalHeaders(user: JwtAccessPayload): Record<string, string> {
    return {
      'x-internal-secret': this.config.internalServiceSecret,
      'x-user-id': user.sub,
      'x-user-email': user.email,
      'x-actor-roles': user.roles.join(','),
    };
  }

  private async flushBffCopilotCache(): Promise<number> {
    return this.redis.delByPatternSafe(COPILOT_CACHE_PATTERN);
  }

  private async fetchDocumentSnapshot(
    id: string,
    req: Request,
    correlationId: string,
    user: JwtAccessPayload,
  ): Promise<Record<string, unknown> | null> {
    try {
      const upstream = await this.proxy.request({
        method: 'GET',
        url: `${this.config.upstreams.mcpCopilotUrl}/internal/rag/documents/${encodeURIComponent(id)}`,
        req,
        correlationId,
        timeoutMs: 3_000,
        extraHeaders: this.buildInternalHeaders(user),
      });
      if (!upstream.ok) {
        return null;
      }
      const dataObj = extractDataObject(upstream.body);
      return asRecord(dataObj?.document) ?? dataObj;
    } catch {
      return null;
    }
  }

  // ============================================================================
  // 1. GET /api/v1/admin/rag/documents — List Dynamic RAG Corpus + Index Metadata
  // ============================================================================

  @Get('documents')
  @RequirePermissions(Permission.CATALOG_PRODUCT_WRITE, Permission.CATALOG_AI_APPROVE)
  async listDocuments(
    @Query() query: Record<string, unknown>,
    @Req() req: Request,
    @Res() res: Response,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<void> {
    const correlationId = getOrCreateCorrelationId(req.headers as HeaderBag);
    this.assertRagOperatorAccess(user, correlationId);

    const qs = buildCanonicalQueryString(query);
    const upstream = await this.proxy.request({
      method: 'GET',
      url: `${this.config.upstreams.mcpCopilotUrl}/internal/rag/documents${qs ? `?${qs}` : ''}`,
      req,
      correlationId,
      timeoutMs: 15_000,
      extraHeaders: this.buildInternalHeaders(user),
    });

    this.proxy.sendProxyResponse(res, upstream, (payload) =>
      redactRestrictedFields(payload, user.roles),
    );
  }

  // ============================================================================
  // 1b. GET /api/v1/admin/rag/documents/:id — Inspect Single Document & Chunks
  // ============================================================================

  @Get('documents/:id')
  @RequirePermissions(Permission.CATALOG_PRODUCT_WRITE, Permission.CATALOG_AI_APPROVE)
  async getDocumentById(
    @Param('id') id: string,
    @Req() req: Request,
    @Res() res: Response,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<void> {
    const correlationId = getOrCreateCorrelationId(req.headers as HeaderBag);
    this.assertRagOperatorAccess(user, correlationId);

    const trimmedId = id.trim();
    if (!trimmedId) {
      res.status(HttpStatus.BAD_REQUEST).json(
        createApiErrorResponse(
          ErrorCode.VALIDATION_ERROR,
          'Mã tài liệu RAG (id) không hợp lệ.',
          undefined,
          { correlationId, service: this.config.serviceName },
        ),
      );
      return;
    }

    const upstream = await this.proxy.request({
      method: 'GET',
      url: `${this.config.upstreams.mcpCopilotUrl}/internal/rag/documents/${encodeURIComponent(trimmedId)}`,
      req,
      correlationId,
      timeoutMs: 15_000,
      extraHeaders: this.buildInternalHeaders(user),
    });

    this.proxy.sendProxyResponse(res, upstream, (payload) =>
      redactRestrictedFields(payload, user.roles),
    );
  }

  // ============================================================================
  // 2. POST /api/v1/admin/rag/documents — Create, Chunk, Embed & Flush Cache
  // ============================================================================

  @Post('documents')
  @RequirePermissions(Permission.CATALOG_PRODUCT_WRITE, Permission.CATALOG_AI_APPROVE)
  async createDocument(
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<void> {
    const correlationId = getOrCreateCorrelationId(req.headers as HeaderBag);
    this.assertRagOperatorAccess(user, correlationId);

    const payload = asRecord(body);
    const title = typeof payload?.title === 'string' ? payload.title.trim() : '';
    const content = typeof payload?.content === 'string' ? payload.content.trim() : '';
    if (!payload || !title || !content) {
      res.status(HttpStatus.BAD_REQUEST).json(
        createApiErrorResponse(
          ErrorCode.VALIDATION_ERROR,
          'Thiếu trường bắt buộc: title và content phải là chuỗi không rỗng.',
          undefined,
          { correlationId, service: this.config.serviceName },
        ),
      );
      return;
    }

    const actorIdentity = user.email || user.sub;
    const forwardedBody: Record<string, unknown> = {
      ...payload,
      title,
      content,
      updatedBy: actorIdentity,
    };

    const upstream = await this.proxy.request({
      method: 'POST',
      url: `${this.config.upstreams.mcpCopilotUrl}/internal/rag/documents`,
      req,
      body: forwardedBody,
      correlationId,
      timeoutMs: 30_000,
      extraHeaders: this.buildInternalHeaders(user),
    });

    let flushedKeys = 0;
    if (upstream.ok) {
      flushedKeys = await this.flushBffCopilotCache();
      const { afterJsonb } = extractBeforeAfter(upstream.body, null);
      const resourceId = extractDocumentId(
        upstream.body,
        typeof payload.id === 'string' ? payload.id.trim() : null,
      );

      await this.audit.record({
        actorId: user.sub,
        actorEmail: user.email,
        action: 'RAG_DOCUMENT_CREATED',
        resourceType: 'RAG_DOCUMENT',
        resourceId,
        beforeJsonb: null,
        afterJsonb,
        correlationId,
        ipAddress: this.proxy.extractClientIp(req),
        extraMetadata: {
          flushedBffCacheKeys: flushedKeys,
        },
      });
    }

    this.proxy.sendProxyResponse(res, upstream, (respBody) => {
      const redacted = redactRestrictedFields(respBody, user.roles);
      return upstream.ok ? attachCopilotCacheFlushMeta(redacted, flushedKeys) : redacted;
    });
  }

  // ============================================================================
  // 3. PUT /api/v1/admin/rag/documents/:id — Update Version, Re-Embed & Flush Cache
  // ============================================================================

  @Put('documents/:id')
  @RequirePermissions(Permission.CATALOG_PRODUCT_WRITE, Permission.CATALOG_AI_APPROVE)
  async updateDocument(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<void> {
    const correlationId = getOrCreateCorrelationId(req.headers as HeaderBag);
    this.assertRagOperatorAccess(user, correlationId);

    const trimmedId = id.trim();
    const payload = asRecord(body);
    if (!trimmedId || !payload) {
      res.status(HttpStatus.BAD_REQUEST).json(
        createApiErrorResponse(
          ErrorCode.VALIDATION_ERROR,
          'Yêu cầu cập nhật tài liệu RAG không hợp lệ.',
          undefined,
          { correlationId, service: this.config.serviceName },
        ),
      );
      return;
    }

    const fallbackBefore = await this.fetchDocumentSnapshot(
      trimmedId,
      req,
      correlationId,
      user,
    );

    const actorIdentity = user.email || user.sub;
    const forwardedBody: Record<string, unknown> = {
      ...payload,
      updatedBy: actorIdentity,
    };

    const upstream = await this.proxy.request({
      method: 'PUT',
      url: `${this.config.upstreams.mcpCopilotUrl}/internal/rag/documents/${encodeURIComponent(trimmedId)}`,
      req,
      body: forwardedBody,
      correlationId,
      timeoutMs: 30_000,
      extraHeaders: this.buildInternalHeaders(user),
    });

    let flushedKeys = 0;
    if (upstream.ok) {
      flushedKeys = await this.flushBffCopilotCache();
      const { beforeJsonb, afterJsonb } = extractBeforeAfter(
        upstream.body,
        fallbackBefore,
      );

      await this.audit.record({
        actorId: user.sub,
        actorEmail: user.email,
        action: 'RAG_DOCUMENT_UPDATED',
        resourceType: 'RAG_DOCUMENT',
        resourceId: trimmedId,
        beforeJsonb,
        afterJsonb,
        correlationId,
        ipAddress: this.proxy.extractClientIp(req),
        extraMetadata: {
          flushedBffCacheKeys: flushedKeys,
        },
      });
    }

    this.proxy.sendProxyResponse(res, upstream, (respBody) => {
      const redacted = redactRestrictedFields(respBody, user.roles);
      return upstream.ok ? attachCopilotCacheFlushMeta(redacted, flushedKeys) : redacted;
    });
  }

  // ============================================================================
  // 4. DELETE /api/v1/admin/rag/documents/:id — Soft-Deactivate & Flush Cache
  // ============================================================================

  @Delete('documents/:id')
  @RequirePermissions(Permission.CATALOG_PRODUCT_WRITE, Permission.CATALOG_AI_APPROVE)
  async deactivateDocument(
    @Param('id') id: string,
    @Req() req: Request,
    @Res() res: Response,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<void> {
    const correlationId = getOrCreateCorrelationId(req.headers as HeaderBag);
    this.assertRagOperatorAccess(user, correlationId);

    const trimmedId = id.trim();
    if (!trimmedId) {
      res.status(HttpStatus.BAD_REQUEST).json(
        createApiErrorResponse(
          ErrorCode.VALIDATION_ERROR,
          'Mã tài liệu RAG (id) không hợp lệ.',
          undefined,
          { correlationId, service: this.config.serviceName },
        ),
      );
      return;
    }

    const fallbackBefore = await this.fetchDocumentSnapshot(
      trimmedId,
      req,
      correlationId,
      user,
    );

    const actorIdentity = user.email || user.sub;
    const upstream = await this.proxy.request({
      method: 'DELETE',
      url: `${this.config.upstreams.mcpCopilotUrl}/internal/rag/documents/${encodeURIComponent(trimmedId)}?updatedBy=${encodeURIComponent(actorIdentity)}`,
      req,
      correlationId,
      timeoutMs: 20_000,
      extraHeaders: this.buildInternalHeaders(user),
    });

    let flushedKeys = 0;
    if (upstream.ok) {
      flushedKeys = await this.flushBffCopilotCache();
      const { beforeJsonb, afterJsonb } = extractBeforeAfter(
        upstream.body,
        fallbackBefore,
      );

      await this.audit.record({
        actorId: user.sub,
        actorEmail: user.email,
        action: 'RAG_DOCUMENT_DEACTIVATED',
        resourceType: 'RAG_DOCUMENT',
        resourceId: trimmedId,
        beforeJsonb,
        afterJsonb,
        correlationId,
        ipAddress: this.proxy.extractClientIp(req),
        extraMetadata: {
          flushedBffCacheKeys: flushedKeys,
        },
      });
    }

    this.proxy.sendProxyResponse(res, upstream, (respBody) => {
      const redacted = redactRestrictedFields(respBody, user.roles);
      return upstream.ok ? attachCopilotCacheFlushMeta(redacted, flushedKeys) : redacted;
    });
  }

  // ============================================================================
  // 5. POST /api/v1/admin/rag/reindex — Re-Embed Corpus (60s) & Flush Cache
  // ============================================================================

  @Post('reindex')
  @RequirePermissions(Permission.CATALOG_PRODUCT_WRITE, Permission.CATALOG_AI_APPROVE)
  async reindexCorpus(
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<void> {
    const correlationId = getOrCreateCorrelationId(req.headers as HeaderBag);
    this.assertRagOperatorAccess(user, correlationId, {
      requireSuperAdminMfa: true,
    });

    const payload = asRecord(body) ?? {};
    const actorIdentity = user.email || user.sub;

    const upstream = await this.proxy.request({
      method: 'POST',
      url: `${this.config.upstreams.mcpCopilotUrl}/internal/rag/reindex`,
      req,
      body: {
        ...payload,
        updatedBy: actorIdentity,
      },
      correlationId,
      timeoutMs: 60_000,
      extraHeaders: this.buildInternalHeaders(user),
    });

    let flushedKeys = 0;
    if (upstream.ok) {
      flushedKeys = await this.flushBffCopilotCache();
      const dataObj = extractDataObject(upstream.body);
      const afterJsonb: Record<string, unknown> = {
        ...(dataObj ?? {}),
        flushedBffCacheKeys: flushedKeys,
      };

      await this.audit.record({
        actorId: user.sub,
        actorEmail: user.email,
        action: 'RAG_CORPUS_REINDEXED',
        resourceType: 'RAG_CORPUS',
        resourceId: 'rag_documents',
        beforeJsonb: null,
        afterJsonb,
        correlationId,
        ipAddress: this.proxy.extractClientIp(req),
        extraMetadata: {
          flushedBffCacheKeys: flushedKeys,
        },
      });
    }

    this.proxy.sendProxyResponse(res, upstream, (respBody) => {
      const redacted = redactRestrictedFields(respBody, user.roles);
      return upstream.ok ? attachCopilotCacheFlushMeta(redacted, flushedKeys) : redacted;
    });
  }

  // ============================================================================
  // 6. POST /api/v1/admin/rag/test-retrieval — Hybrid RAG RRF k=60 Sandbox
  // ============================================================================

  @Post('test-retrieval')
  @RequirePermissions(Permission.CATALOG_PRODUCT_WRITE, Permission.CATALOG_AI_APPROVE)
  async testRetrieval(
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<void> {
    const correlationId = getOrCreateCorrelationId(req.headers as HeaderBag);
    this.assertRagOperatorAccess(user, correlationId);

    const payload = asRecord(body);
    const query = typeof payload?.query === 'string' ? payload.query.trim() : '';
    if (!payload || !query) {
      res.status(HttpStatus.BAD_REQUEST).json(
        createApiErrorResponse(
          ErrorCode.VALIDATION_ERROR,
          'Câu hỏi truy xuất thử (query) không được để trống.',
          undefined,
          { correlationId, service: this.config.serviceName },
        ),
      );
      return;
    }

    const upstream = await this.proxy.request({
      method: 'POST',
      url: `${this.config.upstreams.mcpCopilotUrl}/internal/rag/test-retrieval`,
      req,
      body: {
        ...payload,
        query,
      },
      correlationId,
      timeoutMs: 25_000,
      extraHeaders: this.buildInternalHeaders(user),
    });

    this.proxy.sendProxyResponse(res, upstream, (respBody) =>
      redactRestrictedFields(respBody, user.roles),
    );
  }
}
