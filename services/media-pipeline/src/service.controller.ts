import { Controller, Get, Headers, Inject } from '@nestjs/common';
import {
  createApiResponse,
  EVENT_NAMES,
  RABBITMQ_EXCHANGES,
  type ApiResponse,
  type DependencyCheck,
} from '@atelier/contracts';
import {
  buildHealthPayload,
  buildReadinessPayload,
  getOrCreateCorrelationId,
  type HeaderBag,
  type StandardHealthPayload,
  type StandardReadinessPayload,
} from '@atelier/observability';
import { MEDIA_CONFIG_TOKEN, type MediaPipelineConfig } from './config/env';
import { MediaDbService } from './db/media-db.service';
import { MediaEventPublisherService } from './messaging/media-event-publisher.service';
import { MinioStorageService } from './storage/minio-storage.service';

@Controller()
export class MediaPipelineController {
  constructor(
    @Inject(MEDIA_CONFIG_TOKEN) private readonly config: MediaPipelineConfig,
    private readonly db: MediaDbService,
    private readonly storage: MinioStorageService,
    private readonly eventPublisher: MediaEventPublisherService,
  ) {}

  @Get('health')
  getHealth(): StandardHealthPayload {
    const startedAtMs = Date.now();
    return buildHealthPayload(this.config.serviceName, this.config.port, {
      version: '3.0.0',
      startedAtMs,
      metadata: {
        boundedContext: this.config.boundedContext,
        isolatedDatabase: this.config.database.targetDatabase,
        databaseMode: this.db.getMode(),
      },
    });
  }

  @Get('ready')
  async getReadiness(): Promise<StandardReadinessPayload> {
    const startedAtMs = Date.now();
    const [dbCheck, minioCheck] = await Promise.all([
      this.db.ping(),
      this.storage.checkHealth(),
    ]);
    const mqConnected = this.eventPublisher.isConnected();

    const checks: DependencyCheck[] = [
      {
        name: 'isolated-media-db',
        status: dbCheck.ok ? 'up' : 'down',
        latencyMs: dbCheck.latencyMs,
        detail: `${this.config.database.envVar} -> ${dbCheck.detail}`,
      },
      {
        name: 'minio-object-storage',
        status: minioCheck.ok ? 'up' : 'down',
        latencyMs: minioCheck.latencyMs,
        detail: minioCheck.detail,
      },
    ];

    return buildReadinessPayload(this.config.serviceName, checks, {
      port: this.config.port,
      version: '3.0.0',
      startedAtMs,
      metadata: {
        boundedContext: this.config.boundedContext,
        isolatedDatabase: this.config.database.targetDatabase,
        databaseMode: dbCheck.mode,
        databaseEnvVar: this.config.database.envVar,
        rabbitmqConnected: mqConnected,
      },
    });
  }

  @Get('api/v1/media/meta')
  getMeta(@Headers() headers: HeaderBag): ApiResponse<Record<string, unknown>> {
    const correlationId = getOrCreateCorrelationId(headers);

    return createApiResponse(
      {
        service: this.config.serviceName,
        boundedContext: this.config.boundedContext,
        port: this.config.port,
        phase: 'phase-1',
        databaseIsolation: {
          envVar: this.config.database.envVar,
          targetDatabase: this.config.database.targetDatabase,
          mode: this.db.getMode(),
          configured: this.config.database.configured,
        },
        aggregates: ['media_assets', 'asset_spatial_metadata'],
        storage: {
          provider: 'MinIO',
          endpoint: this.config.infra.minioEndpointUrl,
          publicBaseUrl: this.config.publicBaseUrl,
          buckets: this.config.infra.buckets,
          privateTryOnPublicAccess: 'DENIED_403',
        },
        assetGovernance: {
          maxFileSizeBytes: this.config.maxUploadBytes,
          magicBytesValidation: ['JPEG', 'PNG', 'WebP'],
          rackCutoutAspectRatio: '2:3 (±2%)',
          rackCutoutAlphaRequired: true,
          tryOnFlatLaySize: '768x1024 (3:4)',
          autoAttachAsTryOnGarment: false,
          requiresHumanApproval: true,
        },
        messaging: {
          exchange: RABBITMQ_EXCHANGES.DOMAIN_TOPIC,
          connected: this.eventPublisher.isConnected(),
          publishes: [EVENT_NAMES.MEDIA_ASSET_PROCESSED, EVENT_NAMES.TRYON_MEDIA_PURGED],
          consumes: ['review.photo.uploaded'],
        },
      },
      {
        correlationId,
        service: this.config.serviceName,
      },
    );
  }
}
