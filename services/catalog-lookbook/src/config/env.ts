import { loadRootEnv as loadMonorepoRootEnv } from '@atelier/db-client';

export const SERVICE_NAME = '@atelier/catalog-lookbook';
export const BOUNDED_CONTEXT = 'catalog-lookbook';
export const DEFAULT_PORT = 4002;
export const DATABASE_ENV_VAR = 'CATALOG_DATABASE_URL';
export const EXPECTED_DATABASE_NAME = 'catalog_db';
export const DEFAULT_CATALOG_DATABASE_URL =
  'postgresql://svc_catalog:Atelier_Cat2026!@127.0.0.1:5432/catalog_db';
export const DEFAULT_RAG_DATABASE_URL =
  'postgresql://svc_rag:Atelier_Rag2026!@127.0.0.1:5432/rag_vector_db';

export interface CatalogLookbookConfig {
  serviceName: string;
  boundedContext: string;
  port: number;
  nodeEnv: string;
  database: {
    envVar: string;
    url: string;
    configured: boolean;
    targetDatabase: string;
    host: string;
    port: number;
  };
  ragDatabase: {
    envVar: string;
    url: string;
    targetDatabase: string;
  };
  infra: {
    meilisearchHost: string;
    meilisearchMasterKey: string;
    meilisearchConfigured: boolean;
    minioEndpoint: string;
    minioPort: number;
    minioRootUser: string;
    minioRootPassword: string;
    minioBucketPublic: string;
    minioBucketGarments: string;
    minioPublicBaseUrl: string;
    mediaServiceUrl: string;
    notifyReviewServiceUrl: string;
    aiTryOnServiceUrl: string;
    storefrontUrl: string;
    revalidateSecret: string;
    internalServiceSecret: string;
    redisUrl: string;
    rabbitmqConfigured: boolean;
  };
}

let envLoaded = false;

export function loadRootEnv(): void {
  if (envLoaded) {
    return;
  }
  envLoaded = true;
  loadMonorepoRootEnv(__dirname);
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

function parseIsolatedDatabaseTarget(
  rawUrl: string | undefined,
): CatalogLookbookConfig['database'] {
  const effectiveUrl = rawUrl?.trim() || DEFAULT_CATALOG_DATABASE_URL;
  const configured = Boolean(rawUrl && rawUrl.trim() !== '');
  try {
    const parsed = new URL(effectiveUrl);
    const dbName = parsed.pathname.replace(/^\//, '') || EXPECTED_DATABASE_NAME;
    return {
      envVar: DATABASE_ENV_VAR,
      url: effectiveUrl,
      configured,
      targetDatabase: dbName,
      host: parsed.hostname || '127.0.0.1',
      port: parsed.port ? Number.parseInt(parsed.port, 10) : 5432,
    };
  } catch {
    return {
      envVar: DATABASE_ENV_VAR,
      url: DEFAULT_CATALOG_DATABASE_URL,
      configured: false,
      targetDatabase: EXPECTED_DATABASE_NAME,
      host: '127.0.0.1',
      port: 5432,
    };
  }
}

export function loadCatalogLookbookConfig(): CatalogLookbookConfig {
  loadRootEnv();

  const meilisearchHost = (
    process.env.MEILISEARCH_HOST?.trim() || 'http://127.0.0.1:7700'
  ).replace(/\/+$/, '');
  const meilisearchMasterKey =
    process.env.MEILISEARCH_MASTER_KEY?.trim() || 'Atelier_Meili2026!';
  const minioEndpoint = process.env.MINIO_ENDPOINT?.trim() || '127.0.0.1';
  const minioPort = parsePort(process.env.MINIO_PORT, 9000);
  const minioRootUser = process.env.MINIO_ROOT_USER?.trim() || 'atelier_minio';
  const minioRootPassword =
    process.env.MINIO_ROOT_PASSWORD?.trim() || 'Atelier_Minio2026!';
  const minioBucketPublic =
    process.env.MINIO_BUCKET_PUBLIC?.trim() || 'atelier-public';
  const minioBucketGarments =
    process.env.MINIO_BUCKET_GARMENTS?.trim() || 'atelier-garments';
  const minioPublicBaseUrl = (
    process.env.MINIO_PUBLIC_URL?.trim() || `http://127.0.0.1:${minioPort}`
  ).replace(/\/+$/, '');

  const ragUrl =
    process.env.RAG_VECTOR_DATABASE_URL?.trim() || DEFAULT_RAG_DATABASE_URL;

  return {
    serviceName: SERVICE_NAME,
    boundedContext: BOUNDED_CONTEXT,
    port: parsePort(
      process.env.CATALOG_LOOKBOOK_PORT ?? process.env.PORT,
      DEFAULT_PORT,
    ),
    nodeEnv: process.env.NODE_ENV ?? 'development',
    database: parseIsolatedDatabaseTarget(process.env.CATALOG_DATABASE_URL),
    ragDatabase: {
      envVar: 'RAG_VECTOR_DATABASE_URL',
      url: ragUrl,
      targetDatabase: 'rag_vector_db',
    },
    infra: {
      meilisearchHost,
      meilisearchMasterKey,
      meilisearchConfigured: Boolean(meilisearchHost),
      minioEndpoint,
      minioPort,
      minioRootUser,
      minioRootPassword,
      minioBucketPublic,
      minioBucketGarments,
      minioPublicBaseUrl,
      mediaServiceUrl: (
        process.env.MEDIA_SERVICE_URL?.trim() || 'http://127.0.0.1:4003'
      ).replace(/\/+$/, ''),
      notifyReviewServiceUrl: (
        process.env.NOTIFY_REVIEW_SERVICE_URL?.trim() || 'http://127.0.0.1:4008'
      ).replace(/\/+$/, ''),
      aiTryOnServiceUrl: (
        process.env.AI_TRYON_SERVICE_URL?.trim() || 'http://127.0.0.1:4009'
      ).replace(/\/+$/, ''),
      storefrontUrl: (
        process.env.STOREFRONT_URL?.trim() || 'http://127.0.0.1:3000'
      ).replace(/\/+$/, ''),
      revalidateSecret:
        process.env.REVALIDATE_SECRET?.trim() || 'Atelier_Isr_Revalidate_2026!',
      internalServiceSecret:
        process.env.INTERNAL_SERVICE_SECRET?.trim() || 'Atelier_Internal_Svc_2026!',
      redisUrl:
        process.env.REDIS_URL?.trim() || 'redis://:Atelier_Redis2026!@127.0.0.1:6379',
      rabbitmqConfigured: Boolean(process.env.RABBITMQ_URL?.trim()),
    },
  };
}

export const CATALOG_CONFIG_TOKEN = 'CATALOG_CONFIG_TOKEN';
