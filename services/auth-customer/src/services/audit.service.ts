import * as crypto from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  AuditActorType,
  type AuditActorType as AuditActorTypeValue,
  type AuditLogDto,
} from '@atelier/contracts';
import type { AtelierDbExecutor } from '@atelier/db-client';
import { DatabaseService } from '../infra/database.service';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AuditLogViewDto extends AuditLogDto {
  beforeJsonb: Record<string, unknown> | null;
  afterJsonb: Record<string, unknown> | null;
  targetType: string;
  targetId: string | null;
  metadataJson: Record<string, unknown>;
}

export interface RecordAuditLogParams {
  actorId?: string | null;
  actorEmail?: string | null;
  actorType: AuditActorTypeValue;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  beforeJsonb?: Record<string, unknown> | null;
  afterJsonb?: Record<string, unknown> | null;
  metadata?: Record<string, unknown>;
  correlationId?: string | null;
  ipAddress?: string | null;
}

export interface ListAuditLogsQuery {
  action?: string;
  actor?: string;
  actorType?: string;
  resourceType?: string;
  correlationId?: string;
  search?: string;
  q?: string;
  from?: string;
  to?: string;
  page?: number;
  limit?: number;
  offset?: number;
}

export interface PaginatedAuditLogsView {
  items: AuditLogViewDto[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

interface AuditLogRow {
  id: string;
  actor_id: string | null;
  actor_email: string | null;
  actor_type: AuditActorTypeValue;
  action: string;
  resource_type: string;
  resource_id: string | null;
  before_jsonb: Record<string, unknown> | null;
  after_jsonb: Record<string, unknown> | null;
  metadata_jsonb: Record<string, unknown> | null;
  correlation_id: string | null;
  ip_address: string | null;
  created_at: Date | string;
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function parseJsonObject(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return null;
    }
  }
  return null;
}

function mapAuditRow(row: AuditLogRow): AuditLogViewDto {
  const beforeJsonb = parseJsonObject(row.before_jsonb);
  const afterJsonb = parseJsonObject(row.after_jsonb);
  const baseMetadata = parseJsonObject(row.metadata_jsonb) ?? {};

  const metadata: Record<string, unknown> = {
    ...baseMetadata,
    ...(beforeJsonb !== null ? { beforeJsonb } : {}),
    ...(afterJsonb !== null ? { afterJsonb } : {}),
  };

  return {
    id: row.id,
    actorId: row.actor_id,
    actorEmail: row.actor_email ?? null,
    actorType: row.actor_type,
    action: row.action,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    targetType: row.resource_type,
    targetId: row.resource_id,
    beforeJsonb,
    afterJsonb,
    correlationId: row.correlation_id,
    ipAddress: row.ip_address ?? null,
    metadata,
    metadataJson: metadata,
    createdAt: toIsoString(row.created_at),
  };
}

@Injectable()
export class AuditService {
  constructor(private readonly db: DatabaseService) {}

  async record(
    params: RecordAuditLogParams,
    executor?: AtelierDbExecutor,
  ): Promise<AuditLogViewDto> {
    const runner = executor ?? this.db;
    const id = crypto.randomUUID();
    const rawActorId = params.actorId?.trim() || null;
    const validActorUuid = rawActorId && UUID_REGEX.test(rawActorId) ? rawActorId : null;
    const metadata: Record<string, unknown> = {
      ...(params.metadata ?? {}),
      ...(rawActorId && !validActorUuid ? { rawActorId } : {}),
    };

    const res = await runner.query<AuditLogRow>(
      `INSERT INTO audit_logs (
        id, actor_id, actor_email, actor_type, action, resource_type, resource_id,
        before_jsonb, after_jsonb, metadata_jsonb, correlation_id, ip_address, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10::jsonb, $11, $12, NOW())
      RETURNING *`,
      [
        id,
        validActorUuid,
        params.actorEmail ?? null,
        params.actorType ?? AuditActorType.SYSTEM,
        params.action,
        params.resourceType,
        params.resourceId ?? null,
        params.beforeJsonb !== undefined && params.beforeJsonb !== null
          ? JSON.stringify(params.beforeJsonb)
          : null,
        params.afterJsonb !== undefined && params.afterJsonb !== null
          ? JSON.stringify(params.afterJsonb)
          : null,
        JSON.stringify(metadata),
        params.correlationId ?? null,
        params.ipAddress ?? null,
      ],
    );

    return mapAuditRow(res.rows[0]);
  }

  async list(query: ListAuditLogsQuery = {}): Promise<AuditLogViewDto[]> {
    const result = await this.listPaginated(query);
    return result.items;
  }

  async listPaginated(query: ListAuditLogsQuery = {}): Promise<PaginatedAuditLogsView> {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (query.action && query.action.trim()) {
      params.push(`%${query.action.trim()}%`);
      conditions.push(`action ILIKE $${params.length}`);
    }

    if (query.actor && query.actor.trim()) {
      params.push(`%${query.actor.trim()}%`);
      const p = `$${params.length}`;
      conditions.push(`(COALESCE(actor_email, '') ILIKE ${p} OR COALESCE(actor_id::text, '') ILIKE ${p})`);
    }

    if (query.actorType && query.actorType.trim()) {
      params.push(query.actorType.trim());
      conditions.push(`UPPER(actor_type) = UPPER($${params.length})`);
    }

    if (query.resourceType && query.resourceType.trim()) {
      params.push(`%${query.resourceType.trim()}%`);
      conditions.push(`resource_type ILIKE $${params.length}`);
    }

    if (query.correlationId && query.correlationId.trim()) {
      params.push(query.correlationId.trim());
      conditions.push(`correlation_id = $${params.length}`);
    }

    const searchText = (query.search ?? query.q ?? '').trim();
    if (searchText) {
      params.push(`%${searchText}%`);
      const p = `$${params.length}`;
      conditions.push(
        `(action ILIKE ${p} OR resource_type ILIKE ${p} OR COALESCE(resource_id, '') ILIKE ${p} OR COALESCE(actor_email, '') ILIKE ${p} OR COALESCE(actor_id::text, '') ILIKE ${p} OR COALESCE(correlation_id, '') ILIKE ${p})`,
      );
    }

    if (query.from && query.from.trim()) {
      const fromDate = new Date(query.from.trim());
      if (!Number.isNaN(fromDate.getTime())) {
        params.push(fromDate.toISOString());
        conditions.push(`created_at >= $${params.length}::timestamptz`);
      }
    }

    if (query.to && query.to.trim()) {
      const rawTo = query.to.trim();
      const normalizedTo = /^\d{4}-\d{2}-\d{2}$/.test(rawTo)
        ? `${rawTo}T23:59:59.999Z`
        : rawTo;
      const toDate = new Date(normalizedTo);
      if (!Number.isNaN(toDate.getTime())) {
        params.push(toDate.toISOString());
        conditions.push(`created_at <= $${params.length}::timestamptz`);
      }
    }

    const limit = Math.min(Math.max(Number(query.limit ?? 25) || 25, 1), 200);
    const hasExplicitPage = query.page !== undefined && Number.isFinite(Number(query.page));
    const page = hasExplicitPage
      ? Math.max(1, Math.trunc(Number(query.page)))
      : Math.max(1, Math.floor((Number(query.offset ?? 0) || 0) / limit) + 1);
    const offset = hasExplicitPage
      ? (page - 1) * limit
      : Math.max(Number(query.offset ?? 0) || 0, 0);

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const countRes = await this.db.query<{ total: string | number }>(
      `SELECT COUNT(*)::int AS total FROM audit_logs ${whereClause}`,
      params,
    );
    const total = Number(countRes.rows[0]?.total ?? 0);
    const totalPages = Math.max(1, Math.ceil(total / limit));

    const dataParams = [...params, limit, offset];
    const limitParam = `$${dataParams.length - 1}`;
    const offsetParam = `$${dataParams.length}`;

    const sql = `
      SELECT *
      FROM audit_logs
      ${whereClause}
      ORDER BY created_at DESC
      LIMIT ${limitParam}
      OFFSET ${offsetParam}
    `;

    const res = await this.db.query<AuditLogRow>(sql, dataParams);
    const items = res.rows.map(mapAuditRow);

    return {
      items,
      total,
      page,
      limit,
      totalPages,
      pagination: {
        page,
        limit,
        total,
        totalPages,
      },
    };
  }
}
