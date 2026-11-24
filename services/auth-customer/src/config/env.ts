import * as path from 'node:path';
import { findRepoRoot, loadRootEnv as loadWorkspaceRootEnv } from '@atelier/db-client';

export const SERVICE_NAME = '@atelier/auth-customer';
export const BOUNDED_CONTEXT = 'auth-customer';
export const DEFAULT_PORT = 4001;
export const DATABASE_ENV_VAR = 'AUTH_DATABASE_URL';
export const EXPECTED_DATABASE_NAME = 'auth_db';

export const DEFAULT_AUTH_DATABASE_URL =
  'postgresql://svc_auth:Atelier_Auth2026!@127.0.0.1:5432/auth_db?schema=public';

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

export interface AuthCustomerConfig {
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
  smtp: {
    host: string;
    port: number;
    from: string;
  };
  jwt: {
    keyDir: string;
    accessTtlSeconds: number;
    refreshTtlSeconds: number;
    issuer: string;
  };
  security: {
    mfaEncryptionKey: string;
    internalServiceSecret: string;
    allowedOrigins: string[];
  };
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

function parseIsolatedDatabaseTarget(rawUrl: string | undefined): AuthCustomerConfig['database'] {
  const effectiveUrl = rawUrl?.trim() || DEFAULT_AUTH_DATABASE_URL;
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
      url: DEFAULT_AUTH_DATABASE_URL,
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

export function loadAuthCustomerConfig(): AuthCustomerConfig {
  loadRootEnv();
  const repoRoot = findRepoRoot(__dirname);
  const redisUrl = process.env.REDIS_URL?.trim() || 'redis://:Atelier_Redis2026!@127.0.0.1:6379';
  const redisPassword = process.env.REDIS_PASSWORD?.trim() || undefined;

  return {
    serviceName: SERVICE_NAME,
    boundedContext: BOUNDED_CONTEXT,
    port: parsePort(process.env.AUTH_CUSTOMER_PORT ?? process.env.PORT, DEFAULT_PORT),
    nodeEnv: process.env.NODE_ENV ?? 'development',
    repoRoot,
    database: parseIsolatedDatabaseTarget(process.env.AUTH_DATABASE_URL),
    redis: {
      url: redisUrl,
      ...(redisPassword ? { password: redisPassword } : {}),
      configured: Boolean(process.env.REDIS_URL?.trim()),
    },
    smtp: {
      host: process.env.SMTP_HOST?.trim() || '127.0.0.1',
      port: parsePort(process.env.SMTP_PORT, 1025),
      from: process.env.SMTP_FROM?.trim() || 'atelier@fashion-atelier.local',
    },
    jwt: {
      keyDir: path.join(repoRoot, '.secrets', 'jwt'),
      accessTtlSeconds: 15 * 60,
      refreshTtlSeconds: 7 * 24 * 60 * 60,
      issuer: 'atelier-auth-customer',
    },
    security: {
      mfaEncryptionKey:
        process.env.MFA_ENCRYPTION_KEY?.trim() ||
        process.env.JWT_ACCESS_SECRET?.trim() ||
        'atelier_local_dev_mfa_encryption_key_2026',
      internalServiceSecret:
        process.env.INTERNAL_SERVICE_SECRET?.trim() || 'Atelier_Internal_Svc_2026!',
      allowedOrigins: parseAllowedOrigins(process.env.CORS_ALLOWED_ORIGINS),
    },
    infra: {
      redisConfigured: Boolean(process.env.REDIS_URL?.trim()),
      rabbitmqConfigured: Boolean(process.env.RABBITMQ_URL?.trim()),
    },
  };
}

export const AUTH_CONFIG_TOKEN = 'AUTH_CONFIG_TOKEN';
