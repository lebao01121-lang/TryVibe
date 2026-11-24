import { loadRootEnv } from '@atelier/db-client';

export const SERVICE_NAME = '@atelier/media-pipeline';
export const BOUNDED_CONTEXT = 'media-pipeline';
export const DEFAULT_PORT = 4003;
export const DATABASE_ENV_VAR = 'MEDIA_DATABASE_URL';
export const EXPECTED_DATABASE_NAME = 'media_db';
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10MB hard limit

const DEFAULT_CORS_ORIGINS = [
  'http://localhost:3000',
  'http://localhost:3001',
  'http://localhost:3002',
  'http://localhost:4000',
  'http://localhost:4003',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:3001',
  'http://127.0.0.1:3002',
  'http://127.0.0.1:4000',
  'https://localhost',
  'https://admin.localhost',
  'https://partner.localhost',
] as const;

export interface MediaPipelineConfig {
  serviceName: string;
  boundedContext: string;
  port: number;
  nodeEnv: string;
  publicBaseUrl: string;
  maxUploadBytes: number;
  corsAllowedOrigins: string[];
  database: {
    envVar: string;
    url: string;
    configured: boolean;
    targetDatabase: string;
    host: string;
    port: number;
  };
  infra: {
    minioEndpoint: string;
    minioPort: number;
    minioUseSsl: boolean;
    minioEndpointUrl: string;
    minioPublicUrl: string;
    minioAccessKey: string;
    minioSecretKey: string;
    minioConfigured: boolean;
    buckets: {
      public: string;
      garments: string;
      privateTryOn: string;
    };
    rabbitmqUrl: string;
    rabbitmqConfigured: boolean;
  };
}

function parsePort(raw: string | undefined, fallback: number): number {
  if (!raw || raw.trim() === '') {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`Invalid port value "${raw}" for ${SERVICE_NAME}.`);
  }
  return parsed;
}

function parseBoolean(raw: string | undefined, fallback: boolean): boolean {
  if (!raw || raw.trim() === '') {
    return fallback;
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'yes') {
    return true;
  }
  if (normalized === 'false' || normalized === '0' || normalized === 'no') {
    return false;
  }
  return fallback;
}

function parseCorsOrigins(raw: string | undefined): string[] {
  const merged = new Set<string>(DEFAULT_CORS_ORIGINS);
  if (raw && raw.trim() !== '') {
    for (const entry of raw.split(',')) {
      const cleaned = entry.trim().replace(/\/+$/, '');
      if (cleaned) {
        merged.add(cleaned);
      }
    }
  }
  return Array.from(merged);
}

export function isAllowedCorsOrigin(
  origin: string | undefined,
  allowedOrigins: readonly string[],
): boolean {
  if (!origin) {
    return true;
  }
  const normalized = origin.trim().replace(/\/+$/, '');
  if (allowedOrigins.includes(normalized)) {
    return true;
  }
  if (/^https?:\/\/(localhost|127\.0\.0\.1):(3000|3001|3002|4000|4003)$/i.test(normalized)) {
    return true;
  }
  if (/^https:\/\/([a-z0-9-]+\.)*localhost(:\d+)?$/i.test(normalized)) {
    return true;
  }
  return false;
}

function parseIsolatedDatabaseTarget(rawUrl: string | undefined): MediaPipelineConfig['database'] {
  const fallbackUrl = 'postgresql://svc_media:Atelier_Media2026!@127.0.0.1:5432/media_db?schema=public';
  if (!rawUrl || rawUrl.trim() === '') {
    return {
      envVar: DATABASE_ENV_VAR,
      url: fallbackUrl,
      configured: false,
      targetDatabase: EXPECTED_DATABASE_NAME,
      host: '127.0.0.1',
      port: 5432,
    };
  }
  const parsed = new URL(rawUrl);
  const dbName = parsed.pathname.replace(/^\//, '') || EXPECTED_DATABASE_NAME;
  return {
    envVar: DATABASE_ENV_VAR,
    url: rawUrl.trim(),
    configured: true,
    targetDatabase: dbName,
    host: parsed.hostname || '127.0.0.1',
    port: parsed.port ? Number.parseInt(parsed.port, 10) : 5432,
  };
}

export function loadMediaPipelineConfig(): MediaPipelineConfig {
  loadRootEnv();

  const port = parsePort(process.env.MEDIA_PIPELINE_PORT ?? process.env.PORT, DEFAULT_PORT);
  const minioEndpoint = process.env.MINIO_ENDPOINT?.trim() || '127.0.0.1';
  const minioPort = parsePort(process.env.MINIO_PORT, 9000);
  const minioUseSsl = parseBoolean(process.env.MINIO_USE_SSL, false);
  const minioProtocol = minioUseSsl ? 'https' : 'http';
  const minioEndpointUrl = `${minioProtocol}://${minioEndpoint}:${minioPort}`;
  const minioPublicUrl = (process.env.MINIO_PUBLIC_URL?.trim() || minioEndpointUrl).replace(
    /\/+$/,
    '',
  );
  const minioAccessKey = process.env.MINIO_ROOT_USER?.trim() || 'atelier_minio';
  const minioSecretKey = process.env.MINIO_ROOT_PASSWORD?.trim() || 'Atelier_Minio2026!';
  const publicBaseUrl = (
    process.env.MEDIA_PUBLIC_BASE_URL?.trim() || `http://localhost:${port}/v1/media/public`
  ).replace(/\/+$/, '');
  const rabbitmqUrl =
    process.env.RABBITMQ_URL?.trim() || 'amqp://atelier_mq:Atelier_Mq2026!@127.0.0.1:5672';

  return {
    serviceName: SERVICE_NAME,
    boundedContext: BOUNDED_CONTEXT,
    port,
    nodeEnv: process.env.NODE_ENV ?? 'development',
    publicBaseUrl,
    maxUploadBytes: MAX_UPLOAD_BYTES,
    corsAllowedOrigins: parseCorsOrigins(process.env.CORS_ALLOWED_ORIGINS),
    database: parseIsolatedDatabaseTarget(process.env.MEDIA_DATABASE_URL),
    infra: {
      minioEndpoint,
      minioPort,
      minioUseSsl,
      minioEndpointUrl,
      minioPublicUrl,
      minioAccessKey,
      minioSecretKey,
      minioConfigured: Boolean(
        (process.env.MINIO_ENDPOINT?.trim() || minioEndpoint) &&
          minioAccessKey &&
          minioSecretKey,
      ),
      buckets: {
        public: process.env.MINIO_BUCKET_PUBLIC?.trim() || 'atelier-public',
        garments: process.env.MINIO_BUCKET_GARMENTS?.trim() || 'atelier-garments',
        privateTryOn: process.env.MINIO_BUCKET_PRIVATE_TRYON?.trim() || 'atelier-private-tryon',
      },
      rabbitmqUrl,
      rabbitmqConfigured: Boolean(process.env.RABBITMQ_URL?.trim()),
    },
  };
}

export const MEDIA_CONFIG_TOKEN = 'MEDIA_CONFIG_TOKEN';
