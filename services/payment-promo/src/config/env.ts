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
  bffPublicUrl: string;
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
  vietqr: {
    bankBin: string;
    accountNo: string;
    accountName: string;
  };
  payos: {
    clientId: string;
    apiKey: string;
    checksumKey: string;
    baseUrl: string;
    isLiveConfigured: boolean;
  };
  vnpay: {
    tmnCode: string;
    hashSecret: string;
    paymentUrl: string;
    apiUrl: string;
    returnUrl: string;
    isLiveConfigured: boolean;
    liveApiEnabled: boolean;
  };
  momo: {
    partnerCode: string;
    accessKey: string;
    secretKey: string;
    apiUrl: string;
    redirectUrl: string;
    ipnUrl: string;
    isLiveConfigured: boolean;
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
  const bffPublicUrl = (
    process.env.BFF_PUBLIC_URL?.trim() ||
    process.env.NEXT_PUBLIC_BFF_URL?.trim() ||
    'http://localhost:4000'
  ).replace(/\/+$/, '');

  const defaultReturnUrl = `${storefrontPublicUrl}/thanh-toan/ket-qua`;

  const vietqrWebhookSecret =
    process.env.VIETQR_WEBHOOK_SECRET?.trim() || 'Atelier_VietQR_Hmac_2026!';
  const vnpayWebhookSecret =
    process.env.VNPAY_WEBHOOK_SECRET?.trim() || 'Atelier_VNPay_Hmac_2026!';
  const momoWebhookSecret =
    process.env.MOMO_WEBHOOK_SECRET?.trim() || 'Atelier_MoMo_Hmac_2026!';

  const payosClientId = process.env.PAYOS_CLIENT_ID?.trim() || '';
  const payosApiKey = process.env.PAYOS_API_KEY?.trim() || '';
  const payosChecksumKey = process.env.PAYOS_CHECKSUM_KEY?.trim() || '';
  const payosBaseUrl = (
    process.env.PAYOS_BASE_URL?.trim() || 'https://api-merchant.payos.vn'
  ).replace(/\/+$/, '');
  const payosLiveConfigured = Boolean(payosClientId && payosApiKey && payosChecksumKey);

  const rawVnpayTmnCode = process.env.VNPAY_TMN_CODE?.trim() || '';
  const rawVnpayHashSecret = process.env.VNPAY_HASH_SECRET?.trim() || '';
  const rawVnpayApiUrl = process.env.VNPAY_API_URL?.trim() || '';
  const vnpayIsLiveConfigured = Boolean(rawVnpayTmnCode && rawVnpayHashSecret);
  const vnpayLiveApiEnabled = Boolean(
    vnpayIsLiveConfigured &&
      (process.env.VNPAY_LIVE_API?.trim().toLowerCase() === 'true' ||
        (rawVnpayApiUrl.length > 0 && rawVnpayHashSecret !== vnpayWebhookSecret)),
  );

  const rawMomoPartnerCode = process.env.MOMO_PARTNER_CODE?.trim() || '';
  const rawMomoAccessKey = process.env.MOMO_ACCESS_KEY?.trim() || '';
  const rawMomoSecretKey = process.env.MOMO_SECRET_KEY?.trim() || '';
  const momoIsLiveConfigured = Boolean(
    rawMomoPartnerCode && rawMomoAccessKey && rawMomoSecretKey,
  );

  return {
    serviceName: SERVICE_NAME,
    boundedContext: BOUNDED_CONTEXT,
    port: parsePort(process.env.PAYMENT_PROMO_PORT ?? process.env.PORT, DEFAULT_PORT),
    nodeEnv: process.env.NODE_ENV ?? 'development',
    corsAllowedOrigins: parseCorsOrigins(process.env.CORS_ALLOWED_ORIGINS),
    internalServiceSecret:
      process.env.INTERNAL_SERVICE_SECRET?.trim() || 'Atelier_Internal_Svc_2026!',
    storefrontPublicUrl,
    bffPublicUrl,
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
      VIETQR: vietqrWebhookSecret,
      VNPAY: vnpayWebhookSecret,
      MOMO: momoWebhookSecret,
    },
    vietqr: {
      bankBin: process.env.VIETQR_BANK_BIN?.trim() || '970422',
      accountNo: process.env.VIETQR_ACCOUNT_NO?.trim() || '088820269999',
      accountName: process.env.VIETQR_ACCOUNT_NAME?.trim() || 'TRYVIBE ATELIER',
    },
    payos: {
      clientId: payosClientId,
      apiKey: payosApiKey,
      checksumKey: payosChecksumKey,
      baseUrl: payosBaseUrl,
      isLiveConfigured: payosLiveConfigured,
    },
    vnpay: {
      tmnCode: rawVnpayTmnCode || 'ATELIER01',
      hashSecret: rawVnpayHashSecret || vnpayWebhookSecret,
      paymentUrl:
        process.env.VNPAY_PAYMENT_URL?.trim() ||
        'https://sandbox.vnpayment.vn/paymentv2/vpcpay.html',
      apiUrl:
        rawVnpayApiUrl ||
        'https://sandbox.vnpayment.vn/merchant_webapi/api/transaction',
      returnUrl: process.env.VNPAY_RETURN_URL?.trim() || defaultReturnUrl,
      isLiveConfigured: vnpayIsLiveConfigured,
      liveApiEnabled: vnpayLiveApiEnabled,
    },
    momo: {
      partnerCode: rawMomoPartnerCode || 'ATELIER_MOMO',
      accessKey: rawMomoAccessKey || 'ATELIER_MOMO_ACCESS_KEY',
      secretKey: rawMomoSecretKey || momoWebhookSecret,
      apiUrl: (
        process.env.MOMO_API_URL?.trim() || 'https://test-payment.momo.vn'
      ).replace(/\/+$/, ''),
      redirectUrl: process.env.MOMO_REDIRECT_URL?.trim() || defaultReturnUrl,
      ipnUrl:
        process.env.MOMO_IPN_URL?.trim() || `${bffPublicUrl}/bff/v1/payments/momo/ipn`,
      isLiveConfigured: momoIsLiveConfigured,
    },
  };
}

export const PAYMENT_CONFIG_TOKEN = 'PAYMENT_CONFIG_TOKEN';
