import { loadRootEnv } from '@atelier/db-client';

export const SERVICE_NAME = '@atelier/payment-promo';
export const BOUNDED_CONTEXT = 'payment-promo';
export const DEFAULT_PORT = 4007;
export const DATABASE_ENV_VAR = 'PAYMENT_DATABASE_URL';
export const EXPECTED_DATABASE_NAME = 'payment_db';
export const FREE_SHIP_THRESHOLD_VND = 2_000_000;

const DEFAULT_CORS_ORIGINS = [
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

export interface PaymentPromoConfig {
  serviceName: string;
  boundedContext: string;
  port: number;
  nodeEnv: string;
  corsAllowedOrigins: string[];
  internalServiceSecret: string;
  storefrontPublicUrl: string;
  database: {
    envVar: string;
    url: string;
    configured: boolean;
    targetDatabase: string;
    host: string;
    port: number;
  };
  infra: {
    redisUrl: string;
    redisConfigured: boolean;
    rabbitmqUrl: string;
    rabbitmqConfigured: boolean;
  };
  upstreams: {
    orderRmaServiceUrl: string;
  };
  webhookSecrets: {
    VIETQR: string;
    VNPAY: string;
    MOMO: string;
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
  if (/^https?:\/\/(localhost|127\.0\.0\.1):(3000|3001|3002|4000|4007)$/i.test(normalized)) {
    return true;
  }
  if (/^https:\/\/([a-z0-9-]+\.)*localhost(:\d+)?$/i.test(normalized)) {
    return true;
  }
  return false;
}

function parseIsolatedDatabaseTarget(rawUrl: string | undefined): PaymentPromoConfig['database'] {
  const fallbackUrl =
    'postgresql://svc_payment:Atelier_Pay2026!@127.0.0.1:5432/payment_db?schema=public';
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

export function loadPaymentPromoConfig(): PaymentPromoConfig {
  loadRootEnv();

  const redisUrl =
    process.env.REDIS_URL?.trim() || 'redis://:Atelier_Redis2026!@127.0.0.1:6379';
  const rabbitmqUrl =
    process.env.RABBITMQ_URL?.trim() || 'amqp://atelier_mq:Atelier_Mq2026!@127.0.0.1:5672';
  const orderRmaServiceUrl = (
    process.env.ORDER_RMA_SERVICE_URL?.trim() || 'http://127.0.0.1:4006'
  ).replace(/\/+$/, '');
  const storefrontPublicUrl = (
    process.env.NEXT_PUBLIC_STOREFRONT_URL?.trim() ||
    process.env.STOREFRONT_URL?.trim() ||
    'http://localhost:3000'
  ).replace(/\/+$/, '');

  return {
    serviceName: SERVICE_NAME,
    boundedContext: BOUNDED_CONTEXT,
    port: parsePort(process.env.PAYMENT_PROMO_PORT ?? process.env.PORT, DEFAULT_PORT),
    nodeEnv: process.env.NODE_ENV ?? 'development',
    corsAllowedOrigins: parseCorsOrigins(process.env.CORS_ALLOWED_ORIGINS),
    internalServiceSecret:
      process.env.INTERNAL_SERVICE_SECRET?.trim() || 'Atelier_Internal_Svc_2026!',
    storefrontPublicUrl,
    database: parseIsolatedDatabaseTarget(process.env.PAYMENT_DATABASE_URL),
    infra: {
      redisUrl,
      redisConfigured: Boolean(process.env.REDIS_URL?.trim()),
      rabbitmqUrl,
      rabbitmqConfigured: Boolean(process.env.RABBITMQ_URL?.trim()),
    },
    upstreams: {
      orderRmaServiceUrl,
    },
    webhookSecrets: {
      VIETQR: process.env.VIETQR_WEBHOOK_SECRET?.trim() || 'Atelier_VietQR_Hmac_2026!',
      VNPAY: process.env.VNPAY_WEBHOOK_SECRET?.trim() || 'Atelier_VNPay_Hmac_2026!',
      MOMO: process.env.MOMO_WEBHOOK_SECRET?.trim() || 'Atelier_MoMo_Hmac_2026!',
    },
  };
}

export const PAYMENT_CONFIG_TOKEN = 'PAYMENT_CONFIG_TOKEN';
