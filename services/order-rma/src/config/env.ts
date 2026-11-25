import * as fs from 'node:fs';
import * as path from 'node:path';

export const SERVICE_NAME = '@atelier/order-rma';
export const BOUNDED_CONTEXT = 'order-rma';
export const DEFAULT_PORT = 4006;
export const DATABASE_ENV_VAR = 'ORDER_DATABASE_URL';
export const EXPECTED_DATABASE_NAME = 'order_db';
export const DEFAULT_ORDER_DATABASE_URL =
  'postgresql://svc_order:Atelier_Order2026!@127.0.0.1:5432/order_db?schema=public';
export const DEFAULT_INTERNAL_SECRET = 'Atelier_Internal_Svc_2026!';

export interface OrderRmaConfig {
  serviceName: string;
  boundedContext: string;
  port: number;
  nodeEnv: string;
  internalServiceSecret: string;
  corsAllowedOrigins: string[];
  reservationTtlSeconds: number;
  sweeperIntervalMs: number;
  database: {
    envVar: string;
    configured: boolean;
    url: string;
    targetDatabase: string;
    host: string;
    port: number;
  };
  rabbitmq: {
    configured: boolean;
    url: string;
  };
  upstreams: {
    authCustomerServiceUrl: string;
    catalogLookbookServiceUrl: string;
    inventoryServiceUrl: string;
    cartOutfitServiceUrl: string;
    paymentPromoServiceUrl: string;
    notifyReviewServiceUrl: string;
    bffUrl: string;
  };
  infra: {
    rabbitmqConfigured: boolean;
  };
  shipping: {
    originProvinceCode: string;
    originProvinceName: string;
    originDistrictCode: string;
    originDistrictName: string;
    originWardCode: string;
    originWardName: string;
    originAddress: string;
    originPhone: string;
    originName: string;
    ghn: {
      token: string | null;
      shopId: string | null;
      apiUrl: string;
      webhookSecret: string;
      fromDistrictId: number;
      fromWardCode: string;
    };
    ghtk: {
      token: string | null;
      apiUrl: string;
      webhookSecret: string;
    };
    ahamove: {
      token: string | null;
      apiUrl: string;
      webhookSecret: string;
    };
  };
}

let envLoaded = false;

export function loadRootEnv(): void {
  if (envLoaded) {
    return;
  }
  envLoaded = true;

  const candidates = [
    path.resolve(process.cwd(), '.env'),
    path.resolve(__dirname, '../../../.env'),
    path.resolve(__dirname, '../../../../.env'),
  ];

  const envPath = candidates.find((candidate) => fs.existsSync(candidate));
  if (!envPath) {
    return;
  }

  const raw = fs.readFileSync(envPath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex <= 0) {
      continue;
    }
    const key = trimmed.slice(0, eqIndex).trim();
    if (!key || process.env[key] !== undefined) {
      continue;
    }
    let value = trimmed.slice(eqIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
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

function normalizeUrl(raw: string | undefined, fallback: string): string {
  const candidate = raw?.trim();
  const base = candidate && candidate.length > 0 ? candidate : fallback;
  return base.replace(/\/+$/, '');
}

function parseCorsOrigins(raw: string | undefined): string[] {
  const defaults = [
    'http://localhost:3000',
    'http://localhost:3001',
    'http://localhost:3002',
    'http://127.0.0.1:3000',
    'http://127.0.0.1:3001',
    'http://127.0.0.1:3002',
    'http://127.0.0.1:4000',
    'http://localhost:4000',
  ];
  if (!raw || raw.trim() === '') {
    return defaults;
  }
  const parsed = raw
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  return parsed.length > 0 ? Array.from(new Set([...parsed, ...defaults])) : defaults;
}

function parseIsolatedDatabaseTarget(rawUrl: string | undefined): OrderRmaConfig['database'] {
  const configured = Boolean(rawUrl && rawUrl.trim().length > 0);
  const effectiveUrl = configured ? rawUrl!.trim() : DEFAULT_ORDER_DATABASE_URL;
  const parsed = new URL(effectiveUrl);
  const dbName = parsed.pathname.replace(/^\//, '') || EXPECTED_DATABASE_NAME;
  return {
    envVar: DATABASE_ENV_VAR,
    configured,
    url: effectiveUrl,
    targetDatabase: dbName,
    host: parsed.hostname || '127.0.0.1',
    port: parsed.port ? Number.parseInt(parsed.port, 10) : 5432,
  };
}

export function loadOrderRmaConfig(): OrderRmaConfig {
  loadRootEnv();
  const rabbitmqUrl = process.env.RABBITMQ_URL?.trim() ?? '';
  const rabbitmqConfigured = rabbitmqUrl.length > 0;

  return {
    serviceName: SERVICE_NAME,
    boundedContext: BOUNDED_CONTEXT,
    port: parsePort(process.env.ORDER_RMA_PORT ?? process.env.PORT, DEFAULT_PORT),
    nodeEnv: process.env.NODE_ENV ?? 'development',
    internalServiceSecret:
      process.env.INTERNAL_SERVICE_SECRET?.trim() || DEFAULT_INTERNAL_SECRET,
    corsAllowedOrigins: parseCorsOrigins(process.env.CORS_ALLOWED_ORIGINS),
    reservationTtlSeconds: 900,
    sweeperIntervalMs: 20_000,
    database: parseIsolatedDatabaseTarget(process.env.ORDER_DATABASE_URL),
    rabbitmq: {
      configured: rabbitmqConfigured,
      url: rabbitmqUrl || 'amqp://atelier_mq:Atelier_Mq2026!@127.0.0.1:5672',
    },
    upstreams: {
      authCustomerServiceUrl: normalizeUrl(
        process.env.AUTH_CUSTOMER_SERVICE_URL,
        'http://127.0.0.1:4001',
      ),
      catalogLookbookServiceUrl: normalizeUrl(
        process.env.CATALOG_LOOKBOOK_SERVICE_URL,
        'http://127.0.0.1:4002',
      ),
      inventoryServiceUrl: normalizeUrl(
        process.env.INVENTORY_SERVICE_URL,
        'http://127.0.0.1:4004',
      ),
      cartOutfitServiceUrl: normalizeUrl(
        process.env.CART_OUTFIT_SERVICE_URL,
        'http://127.0.0.1:4005',
      ),
      paymentPromoServiceUrl: normalizeUrl(
        process.env.PAYMENT_PROMO_SERVICE_URL,
        'http://127.0.0.1:4007',
      ),
      notifyReviewServiceUrl: normalizeUrl(
        process.env.NOTIFY_REVIEW_SERVICE_URL,
        'http://127.0.0.1:4008',
      ),
      bffUrl: normalizeUrl(
        process.env.BFF_URL ?? process.env.NEXT_PUBLIC_BFF_URL,
        'http://127.0.0.1:4000',
      ),
    },
    infra: {
      rabbitmqConfigured,
    },
    shipping: {
      originProvinceCode: process.env.SHIPPING_ORIGIN_PROVINCE_CODE?.trim() || '01',
      originProvinceName: process.env.SHIPPING_ORIGIN_PROVINCE_NAME?.trim() || 'Thành phố Hà Nội',
      originDistrictCode: process.env.SHIPPING_ORIGIN_DISTRICT_CODE?.trim() || '001',
      originDistrictName: process.env.SHIPPING_ORIGIN_DISTRICT_NAME?.trim() || 'Quận Ba Đình',
      originWardCode: process.env.SHIPPING_ORIGIN_WARD_CODE?.trim() || '00013',
      originWardName: process.env.SHIPPING_ORIGIN_WARD_NAME?.trim() || 'Phường Quán Thánh',
      originAddress:
        process.env.SHIPPING_ORIGIN_ADDRESS?.trim() ||
        '18 Phố Phan Đình Phùng, Phường Quán Thánh, Quận Ba Đình, Hà Nội',
      originPhone: process.env.SHIPPING_ORIGIN_PHONE?.trim() || '02438882026',
      originName: process.env.SHIPPING_ORIGIN_NAME?.trim() || 'TryVibe Fashion Atelier',
      ghn: {
        token: process.env.GHN_TOKEN?.trim() || null,
        shopId: process.env.GHN_SHOP_ID?.trim() || null,
        apiUrl: normalizeUrl(
          process.env.GHN_API_URL,
          'https://dev-online-gateway.ghn.vn/shiip/public-api',
        ),
        webhookSecret:
          process.env.GHN_WEBHOOK_SECRET?.trim() || 'Atelier_GHN_Webhook_2026!',
        fromDistrictId: Number.parseInt(process.env.GHN_FROM_DISTRICT_ID?.trim() || '1482', 10) || 1482,
        fromWardCode: process.env.GHN_FROM_WARD_CODE?.trim() || '1A0107',
      },
      ghtk: {
        token: process.env.GHTK_TOKEN?.trim() || null,
        apiUrl: normalizeUrl(
          process.env.GHTK_API_URL,
          'https://services.giaohangtietkiem.vn',
        ),
        webhookSecret:
          process.env.GHTK_WEBHOOK_SECRET?.trim() || 'Atelier_GHTK_Webhook_2026!',
      },
      ahamove: {
        token: process.env.AHAMOVE_TOKEN?.trim() || null,
        apiUrl: normalizeUrl(process.env.AHAMOVE_API_URL, 'https://apistg.ahamove.com'),
        webhookSecret:
          process.env.AHAMOVE_WEBHOOK_SECRET?.trim() || 'Atelier_AhaMove_Webhook_2026!',
      },
    },
  };
}

export const ORDER_CONFIG_TOKEN = 'ORDER_CONFIG_TOKEN';
