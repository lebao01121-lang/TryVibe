import { Inject, Injectable } from '@nestjs/common';
import { AuditActorType } from '@atelier/contracts';
import { createLogger, type Logger } from '@atelier/observability';
import { HttpProxyService } from '../common/http-proxy.service';
import { BFF_CONFIG_TOKEN, BFF_SERVICE_NAME, type BffConfig } from '../config/env';

export interface RecordAuditEntryInput {
  actorId: string;
  actorEmail?: string;
  action: string;
  resourceType: string;
  resourceId: string | null;
  beforeJsonb?: Record<string, unknown> | null;
  afterJsonb?: Record<string, unknown> | null;
  correlationId: string;
  ipAddress?: string;
  extraMetadata?: Record<string, unknown>;
}

@Injectable()
export class AuditLoggerService {
  private readonly logger: Logger = createLogger(BFF_SERVICE_NAME);

  constructor(
    @Inject(BFF_CONFIG_TOKEN) private readonly config: BffConfig,
    @Inject(HttpProxyService) private readonly proxy: HttpProxyService,
  ) {}

  async record(entry: RecordAuditEntryInput): Promise<void> {
    const beforeJsonb = entry.beforeJsonb ?? null;
    const afterJsonb = entry.afterJsonb ?? null;

    const payload = {
      actorId: entry.actorId,
      actorEmail: entry.actorEmail ?? null,
      actorType: AuditActorType.USER,
      action: entry.action,
      resourceType: entry.resourceType,
      resourceId: entry.resourceId,
      beforeJsonb,
      afterJsonb,
      correlationId: entry.correlationId,
      ipAddress: entry.ipAddress ?? null,
      metadata: {
        ...(entry.extraMetadata ?? {}),
        beforeJsonb,
        afterJsonb,
      },
    };

    try {
      const res = await this.proxy.request({
        method: 'POST',
        url: `${this.config.upstreams.authCustomerUrl}/v1/internal/audit-logs`,
        body: payload,
        correlationId: entry.correlationId,
        timeoutMs: 3000,
      });

      if (!res.ok) {
        this.logger.warn(
          {
            status: res.status,
            action: entry.action,
            resourceType: entry.resourceType,
            resourceId: entry.resourceId,
            correlationId: entry.correlationId,
          },
          'Audit log downstream write returned non-2xx',
        );
      }
    } catch (error) {
      this.logger.warn(
        {
          action: entry.action,
          correlationId: entry.correlationId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to forward audit log to auth-customer',
      );
    }
  }
}
