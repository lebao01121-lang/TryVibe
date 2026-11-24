import { findRepoRoot, loadRootEnv as loadWorkspaceRootEnv } from '@atelier/db-client';

export const SERVICE_NAME = '@atelier/inventory';
export const BOUNDED_CONTEXT = 'inventory';
export const DEFAULT_PORT = 4004;
export const DATABASE_ENV_VAR = 'INVENTORY_DATABASE_URL';
export const EXPECTED_DATABASE_NAME = 'inventory_db';

export const DEFAULT_INVENTORY_DATABASE_URL =
  'postgresql://svc_inventory:Atelier_Inv2026!@127.0.0.1:5432/inventory_db?schema=public';

export const DEFAULT_ALLOWED_ORIGINS = [
  'http://localhost:3000',
  'http://localhost:3001',
  'http://localhost:3002',
  'http://localhost:4000',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:3001',
  'http://127.0.0.1:3002',
  'http://127.0.0.1:4000',
  'https://localhost',
  'https://admin.localhost',
  'https://partner.localhost',
] as const;

export interface InventoryConfig {
  serviceName: string;
  boundedContext: string;
  port: number;
  nodeEnv: string;
  repoRoot: string;
  database: {
    envVar: string;
    url: string;
    configured: boolean;
    targetDatabase: string;
    host: string;
    port: number;
  };
  redis: {
    url: string;
    password?: string;
    configured: boolean;
  };
  rabbitmq: {
    url: string;
    configured: boolean;
  };
  internalServiceSecret: string;
  authCustomerServiceUrl: string;
  notifyReviewServiceUrl: string;
  catalogServiceUrl: string;
  allowedOrigins: string[];
  expireSweepIntervalMs: number;
  infra: {
    redisConfigured: boolean;
    rabbitmqConfigured: boolean;
  };
}

let envLoaded = false;

export function loadRootEnv(): void {
  if (envLoaded) {
    return;
  }
  envLoaded = true;
  loadWorkspaceRootEnv(__dirname);
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

function parseIsolatedDatabaseTarget(rawUrl: string | undefined): InventoryConfig['database'] {
  const effectiveUrl = rawUrl?.trim() || DEFAULT_INVENTORY_DATABASE_URL;
  const configured = Boolean(rawUrl?.trim());
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
      url: DEFAULT_INVENTORY_DATABASE_URL,
      configured: false,
      targetDatabase: EXPECTED_DATABASE_NAME,
      host: '127.0.0.1',
      port: 5432,
    };
  }
}

function parseAllowedOrigins(raw: string | undefined): string[] {
  const merged = new Set<string>(DEFAULT_ALLOWED_ORIGINS);
  if (raw) {
    for (const part of raw.split(',')) {
      const normalized = part.trim().replace(/\/+$/, '');
      if (normalized) {
        merged.add(normalized);
      }
    }
  }
  return [...merged];
}

export function loadInventoryConfig(): InventoryConfig {
  loadRootEnv();
  const repoRoot = findRepoRoot(__dirname);
  const redisUrl = process.env.REDIS_URL?.trim() || 'redis://:Atelier_Redis2026!@127.0.0.1:6379';
  const redisPassword = process.env.REDIS_PASSWORD?.trim() || undefined;
  const rabbitmqUrl =
    process.env.RABBITMQ_URL?.trim() || 'amqp://atelier_mq:Atelier_Mq2026!@127.0.0.1:5672';

  return {
    serviceName: SERVICE_NAME,
    boundedContext: BOUNDED_CONTEXT,
    port: parsePort(process.env.INVENTORY_PORT ?? process.env.PORT, DEFAULT_PORT),
    nodeEnv: process.env.NODE_ENV ?? 'development',
    repoRoot,
    database: parseIsolatedDatabaseTarget(process.env.INVENTORY_DATABASE_URL),
    redis: {
      url: redisUrl,
      ...(redisPassword ? { password: redisPassword } : {}),
      configured: Boolean(process.env.REDIS_URL?.trim()),
    },
    rabbitmq: {
      url: rabbitmqUrl,
      configured: Boolean(process.env.RABBITMQ_URL?.trim()),
    },
    internalServiceSecret:
      process.env.INTERNAL_SERVICE_SECRET?.trim() || 'Atelier_Internal_Svc_2026!',
    authCustomerServiceUrl:
      process.env.AUTH_CUSTOMER_SERVICE_URL?.trim() ||
      process.env.AUTH_SERVICE_URL?.trim() ||
      'http://127.0.0.1:4001',
    notifyReviewServiceUrl:
      process.env.NOTIFY_REVIEW_SERVICE_URL?.trim() || 'http://127.0.0.1:4008',
    catalogServiceUrl:
      process.env.CATALOG_LOOKBOOK_SERVICE_URL?.trim() ||
      process.env.CATALOG_SERVICE_URL?.trim() ||
      'http://127.0.0.1:4002',
    allowedOrigins: parseAllowedOrigins(process.env.CORS_ALLOWED_ORIGINS),
    expireSweepIntervalMs: 15_000,
    infra: {
      redisConfigured: Boolean(process.env.REDIS_URL?.trim()),
      rabbitmqConfigured: Boolean(process.env.RABBITMQ_URL?.trim()),
    },
  };
}

export const INVENTORY_CONFIG_TOKEN = 'INVENTORY_CONFIG_TOKEN';
