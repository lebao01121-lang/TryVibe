import * as fs from 'node:fs';
import { loadRootEnv as loadMonorepoEnv } from '@atelier/db-client';

export const SERVICE_NAME = '@atelier/notify-review';
export const BOUNDED_CONTEXT = 'notify-review';
export const DEFAULT_PORT = 4008;
export const DATABASE_ENV_VAR = 'NOTIFY_DATABASE_URL';
export const EXPECTED_DATABASE_NAME = 'notify_db';

const DEFAULT_NOTIFY_DB_URL =
  'postgresql://svc_notify:Atelier_Notify2026!@127.0.0.1:5432/notify_db?schema=public';
const DEFAULT_RABBITMQ_URL = 'amqp://atelier_mq:Atelier_Mq2026!@127.0.0.1:5672';
const DEFAULT_CATALOG_SERVICE_URL = 'http://127.0.0.1:4002';
const DEFAULT_ORDER_RMA_SERVICE_URL = 'http://127.0.0.1:4006';
const DEFAULT_INTERNAL_SERVICE_SECRET = 'Atelier_Internal_Svc_2026!';
const DEFAULT_OLLAMA_FAST_MODEL = 'qwen2.5:3b';
const DEFAULT_OLLAMA_KEEP_ALIVE = '30m';
const DEFAULT_OLLAMA_SENTIMENT_TIMEOUT_MS = 10_000;

export interface NotifyReviewConfig {
  serviceName: string;
  boundedContext: string;
  port: number;
  nodeEnv: string;
  internalServiceSecret: string;
  database: {
    envVar: string;
    url: string;
    configured: boolean;
    targetDatabase: string;
    host: string;
    port: number;
  };
  infra: {
    smtpHost: string;
    smtpPort: number;
    mailpitUiPort: number;
    smtpFrom: string;
    mailpitConfigured: boolean;
    rabbitmqUrl: string;
    rabbitmqConfigured: boolean;
    catalogServiceUrl: string;
    orderRmaServiceUrl: string;
  };
  ollama: {
    baseUrl: string;
    fastModel: string;
    keepAlive: string;
    sentimentTimeoutMs: number;
  };
}

let envLoaded = false;

export function loadRootEnv(): void {
  if (envLoaded) {
    return;
  }
  envLoaded = true;
  loadMonorepoEnv(__dirname);
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

function parseIsolatedDatabaseTarget(rawUrl: string | undefined): NotifyReviewConfig['database'] {
  const configured = Boolean(rawUrl && rawUrl.trim() !== '');
  const effectiveUrl = configured ? rawUrl!.trim() : DEFAULT_NOTIFY_DB_URL;

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
      url: DEFAULT_NOTIFY_DB_URL,
      configured,
      targetDatabase: EXPECTED_DATABASE_NAME,
      host: '127.0.0.1',
      port: 5432,
    };
  }
}

export function loadNotifyReviewConfig(): NotifyReviewConfig {
  loadRootEnv();

  const smtpHost = process.env.SMTP_HOST?.trim() || '127.0.0.1';
  const smtpPort = parsePort(process.env.SMTP_PORT, 1025);
  const mailpitUiPort = parsePort(process.env.MAILPIT_UI_PORT, 8025);
  const smtpFrom = process.env.SMTP_FROM?.trim() || 'atelier@fashion-atelier.local';
  const rabbitmqUrl = process.env.RABBITMQ_URL?.trim() || DEFAULT_RABBITMQ_URL;
  const catalogServiceUrl = (
    process.env.CATALOG_SERVICE_URL?.trim() || DEFAULT_CATALOG_SERVICE_URL
  ).replace(/\/+$/, '');
  const orderRmaServiceUrl = (
    process.env.ORDER_RMA_SERVICE_URL?.trim() || DEFAULT_ORDER_RMA_SERVICE_URL
  ).replace(/\/+$/, '');
  const internalServiceSecret =
    process.env.INTERNAL_SERVICE_SECRET?.trim() || DEFAULT_INTERNAL_SERVICE_SECRET;
  const inDocker = fs.existsSync('/.dockerenv');
  const ollamaBaseUrl = (
    process.env.OLLAMA_BASE_URL?.trim() ||
    (inDocker ? 'http://host.docker.internal:11434' : 'http://127.0.0.1:11434')
  ).replace(/\/+$/, '');
  const ollamaFastModel =
    process.env.OLLAMA_FAST_MODEL?.trim() || DEFAULT_OLLAMA_FAST_MODEL;
  const ollamaKeepAlive =
    process.env.OLLAMA_KEEP_ALIVE?.trim() || DEFAULT_OLLAMA_KEEP_ALIVE;

  return {
    serviceName: SERVICE_NAME,
    boundedContext: BOUNDED_CONTEXT,
    port: parsePort(process.env.NOTIFY_REVIEW_PORT ?? process.env.PORT, DEFAULT_PORT),
    nodeEnv: process.env.NODE_ENV ?? 'development',
    internalServiceSecret,
    database: parseIsolatedDatabaseTarget(process.env.NOTIFY_DATABASE_URL),
    infra: {
      smtpHost,
      smtpPort,
      mailpitUiPort,
      smtpFrom,
      mailpitConfigured: Boolean(process.env.SMTP_HOST?.trim()),
      rabbitmqUrl,
      rabbitmqConfigured: Boolean(process.env.RABBITMQ_URL?.trim()),
      catalogServiceUrl,
      orderRmaServiceUrl,
    },
    ollama: {
      baseUrl: ollamaBaseUrl,
      fastModel: ollamaFastModel,
      keepAlive: ollamaKeepAlive,
      sentimentTimeoutMs: DEFAULT_OLLAMA_SENTIMENT_TIMEOUT_MS,
    },
  };
}

export const NOTIFY_CONFIG_TOKEN = 'NOTIFY_CONFIG_TOKEN';
