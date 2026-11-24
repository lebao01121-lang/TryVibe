import pino, { type DestinationStream, type Logger, type LoggerOptions } from 'pino';

export const REDACTED_VALUE = '[REDACTED]' as const;
export const REDACTED_PHONE_VALUE = '[REDACTED_PHONE]' as const;

export const DEFAULT_REDACT_PATHS: readonly string[] = [
  // Credentials & secrets
  'password',
  '*.password',
  'pass',
  '*.pass',
  'secret',
  '*.secret',
  'totpSecret',
  '*.totpSecret',
  'totp_secret',
  '*.totp_secret',

  // Auth tokens, headers & webhook signatures
  'token',
  '*.token',
  'accessToken',
  '*.accessToken',
  'refreshToken',
  '*.refreshToken',
  'idToken',
  '*.idToken',
  'apiKey',
  '*.apiKey',
  'authorization',
  '*.authorization',
  'headers.authorization',
  'req.headers.authorization',
  'cookie',
  '*.cookie',
  'headers.cookie',
  'req.headers.cookie',
  '["set-cookie"]',
  'headers["set-cookie"]',
  'res.headers["set-cookie"]',
  '["x-webhook-signature"]',
  'headers["x-webhook-signature"]',
  'req.headers["x-webhook-signature"]',
  'signature',
  '*.signature',

  // Customer PII: phone numbers & detailed addresses
  'phone',
  '*.phone',
  'phoneNumber',
  '*.phoneNumber',
  'soDienThoai',
  '*.soDienThoai',
  'customerPhone',
  '*.customerPhone',
  'customer_phone',
  '*.customer_phone',
  'streetLine',
  '*.streetLine',
  'street_line',
  '*.street_line',
  'shippingAddress.streetLine',
  '*.shippingAddress.streetLine',
  'shipping_address_jsonb',
  '*.shipping_address_jsonb',

  // Personal body measurements
  'bodyMeasurements',
  '*.bodyMeasurements',
  'soDoCoThe',
  '*.soDoCoThe',
  'bustCm',
  '*.bustCm',
  'waistCm',
  '*.waistCm',
  'hipCm',
  '*.hipCm',
  'shoulderCm',
  '*.shoulderCm',
  'heightCm',
  '*.heightCm',
  'weightKg',
  '*.weightKg',
  'bust_cm',
  '*.bust_cm',
  'waist_cm',
  '*.waist_cm',
  'hip_cm',
  '*.hip_cm',
  'shoulder_cm',
  '*.shoulder_cm',
  'height_cm',
  '*.height_cm',
  'weight_kg',
  '*.weight_kg',

  // Restricted procurement/finance cost fields
  'cost_price',
  '*.cost_price',
  'costPrice',
  '*.costPrice',
  'costPriceVnd',
  '*.costPriceVnd',
  'cost_price_vnd',
  '*.cost_price_vnd',
  'giaNhap',
  '*.giaNhap',
  'gia_nhap',
  '*.gia_nhap',
  'cogs',
  '*.cogs',
] as const;

const SENSITIVE_KEY_NORMALIZED = new Set<string>([
  'password',
  'pass',
  'secret',
  'totpsecret',
  'token',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'apikey',
  'authorization',
  'cookie',
  'setcookie',
  'xwebhooksignature',
  'signature',
  'phone',
  'phonenumber',
  'sodienthoai',
  'customerphone',
  'streetline',
  'shippingaddressjsonb',
  'bodymeasurements',
  'sodocothe',
  'bustcm',
  'waistcm',
  'hipcm',
  'shouldercm',
  'heightcm',
  'weightkg',
  'costprice',
  'costpricevnd',
  'gianhap',
  'cogs',
]);

// Inline Vietnamese phone numbers (03/05/07/08/09 + 8 digits, or +84 + 9 digits)
const VN_PHONE_INLINE_REGEX = /(?<!\d)(?:\+84\d{9}|0[35789]\d{8})(?!\d)/g;
const BEARER_TOKEN_INLINE_REGEX = /\b(Bearer\s+)[A-Za-z0-9\-._~+/]+=*/gi;

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function scrubStringPii(input: string): string {
  return input
    .replace(VN_PHONE_INLINE_REGEX, REDACTED_PHONE_VALUE)
    .replace(BEARER_TOKEN_INLINE_REGEX, `$1${REDACTED_VALUE}`);
}

function redactRecursive(value: unknown, ancestors: WeakSet<object>): unknown {
  if (typeof value === 'string') {
    return scrubStringPii(value);
  }
  if (value === null || value === undefined || typeof value !== 'object') {
    return value;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (value instanceof Error) {
    return {
      name: value.name,
      message: scrubStringPii(value.message),
      ...(value.stack ? { stack: scrubStringPii(value.stack) } : {}),
    };
  }
  if (ancestors.has(value)) {
    return '[Circular]';
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => redactRecursive(item, ancestors));
    }

    const inputObj = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    for (const [key, propValue] of Object.entries(inputObj)) {
      const normalized = normalizeKey(key);
      if (SENSITIVE_KEY_NORMALIZED.has(normalized)) {
        output[key] = REDACTED_VALUE;
      } else {
        output[key] = redactRecursive(propValue, ancestors);
      }
    }
    return output;
  } finally {
    ancestors.delete(value);
  }
}

/**
 * Deterministically redacts credentials, tokens, webhook signatures,
 * Vietnamese phone numbers, detailed street addresses, personal body
 * measurements, and restricted procurement cost fields before logging.
 */
export function redactPiiForLog<T = unknown>(value: T): T {
  return redactRecursive(value, new WeakSet<object>()) as T;
}

export interface CreateLoggerOptions {
  level?: string;
  extraRedactPaths?: string[];
  destination?: DestinationStream;
  pinoOptions?: Omit<LoggerOptions, 'base' | 'level' | 'redact'>;
}

export function createLogger(serviceName: string, options: CreateLoggerOptions = {}): Logger {
  const level = options.level ?? process.env.LOG_LEVEL ?? 'info';
  const redactPaths = [...DEFAULT_REDACT_PATHS, ...(options.extraRedactPaths ?? [])];
  const existingFormatters = options.pinoOptions?.formatters;
  const existingHooks = options.pinoOptions?.hooks;

  const loggerOptions: LoggerOptions = {
    ...options.pinoOptions,
    level,
    base: {
      service: serviceName,
      env: process.env.NODE_ENV ?? 'development',
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: redactPaths,
      censor: REDACTED_VALUE,
    },
    formatters: {
      ...existingFormatters,
      log(obj: Record<string, unknown>): Record<string, unknown> {
        const baseFormatted = existingFormatters?.log ? existingFormatters.log(obj) : obj;
        return redactPiiForLog(baseFormatted);
      },
    },
    hooks: {
      ...existingHooks,
      logMethod(inputArgs, method, lvl) {
        const sanitizedArgs = inputArgs.map((arg) =>
          typeof arg === 'string'
            ? scrubStringPii(arg)
            : arg && typeof arg === 'object'
              ? redactPiiForLog(arg)
              : arg,
        ) as Parameters<typeof method>;
        if (existingHooks?.logMethod) {
          existingHooks.logMethod.call(this, sanitizedArgs, method, lvl);
          return;
        }
        method.apply(this, sanitizedArgs);
      },
    },
  };

  return options.destination ? pino(loggerOptions, options.destination) : pino(loggerOptions);
}

export type { DestinationStream, Logger };
