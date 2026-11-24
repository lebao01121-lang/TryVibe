import { loadRootEnv } from '@atelier/db-client';

export const BFF_SERVICE_NAME = '@atelier/bff';
export const DEFAULT_BFF_PORT = 4000;

export const DEFAULT_CORS_ORIGINS: string[] = [
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:3001',
  'http://127.0.0.1:3001',
  'http://localhost:3002',
  'http://127.0.0.1:3002',
  'https://localhost',
  'https://admin.localhost',
  'https://partner.localhost',
];

export const DEFAULT_CSRF_ORIGINS: string[] = [
  ...DEFAULT_CORS_ORIGINS,
  'http://localhost:4000',
  'http://127.0.0.1:4000',
];

export type BffVtonProviderMode = 'mock' | 'fal' | 'auto' | 'pose_warp' | 'hf_gradio';

const VALID_VTON_PROVIDERS: ReadonlySet<BffVtonProviderMode> = new Set([
  'mock',
  'fal',
  'auto',
  'pose_warp',
  'hf_gradio',
]);

export function parseVtonProvider(
  tryonProviderRaw: string | undefined,
  vtonProviderRaw: string | undefined,
): BffVtonProviderMode {
  const candidate = (tryonProviderRaw?.trim() || vtonProviderRaw?.trim() || '').toLowerCase();
  if (VALID_VTON_PROVIDERS.has(candidate as BffVtonProviderMode)) {
    return candidate as BffVtonProviderMode;
  }
  return 'auto';
}

export interface BffConfig {
  serviceName: string;
  port: number;
  nodeEnv: string;
  corsAllowedOrigins: string[];
  csrfAllowedOrigins: string[];
  vtonProvider: BffVtonProviderMode;
  redisUrl: string;
  redisConfigured: boolean;
  rabbitmqConfigured: boolean;
  meilisearchHost: string;
  minioPublicUrl: string;
  mailpitUiUrl: string;
  rabbitmqMgmtUrl: string;
  rabbitmqUser: string;
  rabbitmqPassword: string;
  ollamaBaseUrl: string;
  ollamaMainModel: string;
  ollamaFastModel: string;
  ollamaEmbedModel: string;
  ollamaEmbedDim: number;
  inventoryServiceUrl: string;
  cartOutfitServiceUrl: string;
  orderRmaServiceUrl: string;
  paymentPromoServiceUrl: string;
  notifyReviewServiceUrl: string;
  aiTryonServiceUrl: string;
  mcpCopilotUrl: string;
  storefrontUrl: string;
  revalidateSecret: string;
  internalServiceSecret: string;
  upstreams: {
    authCustomerUrl: string;
    catalogLookbookUrl: string;
    mediaPipelineUrl: string;
    inventoryUrl: string;
    cartOutfitUrl: string;
    orderRmaUrl: string;
    paymentPromoUrl: string;
    notifyReviewUrl: string;
    aiTryOnUrl: string;
    mcpCopilotUrl: string;
  };
}

let envLoaded = false;

function ensureRootEnv(): void {
  if (envLoaded) {
    return;
  }
  envLoaded = true;
  loadRootEnv(__dirname);
}

export function parsePort(raw: string | undefined, fallback: number): number {
  if (!raw || raw.trim() === '') {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`Invalid port value "${raw}"; expected integer between 1 and 65535.`);
  }
  return parsed;
}

export function parseOrigins(raw: string | undefined, defaults: readonly string[]): string[] {
  const originSet = new Set<string>(defaults.map((item) => item.trim().replace(/\/+$/, '')));
  if (raw) {
    for (const item of raw.split(',')) {
      const trimmed = item.trim().replace(/\/+$/, '');
      if (trimmed.length > 0) {
        originSet.add(trimmed);
      }
    }
  }
  return Array.from(originSet);
}

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

export function loadBffConfig(): BffConfig {
  ensureRootEnv();

  const port = parsePort(process.env.BFF_PORT ?? process.env.PORT, DEFAULT_BFF_PORT);
  const vtonProvider = parseVtonProvider(process.env.TRYON_PROVIDER, process.env.VTON_PROVIDER);
  const redisUrl = process.env.REDIS_URL?.trim() || 'redis://127.0.0.1:6379';

  const meilisearchHost = trimTrailingSlash(
    process.env.MEILISEARCH_HOST?.trim() ||
      `http://127.0.0.1:${parsePort(process.env.MEILISEARCH_PORT, 7700)}`,
  );

  const minioPublicUrl = trimTrailingSlash(
    process.env.MINIO_PUBLIC_URL?.trim() ||
      `http://${process.env.MINIO_ENDPOINT?.trim() || '127.0.0.1'}:${parsePort(process.env.MINIO_PORT, 9000)}`,
  );

  const mailpitUiUrl = trimTrailingSlash(
    `http://${process.env.SMTP_HOST?.trim() || '127.0.0.1'}:${parsePort(process.env.MAILPIT_UI_PORT, 8025)}`,
  );

  const rabbitmqMgmtUrl = trimTrailingSlash(
    process.env.RABBITMQ_MGMT_URL?.trim() ||
      `http://${process.env.RABBITMQ_HOST?.trim() || '127.0.0.1'}:${parsePort(process.env.RABBITMQ_MGMT_PORT, 15672)}`,
  );

  const rabbitmqUser = process.env.RABBITMQ_USER?.trim() || 'atelier_mq';
  const rabbitmqPassword = process.env.RABBITMQ_PASSWORD?.trim() || 'Atelier_Mq2026!';

  const ollamaBaseUrl = trimTrailingSlash(
    process.env.OLLAMA_BASE_URL?.trim() || 'http://127.0.0.1:11434',
  );
  const ollamaMainModel = process.env.OLLAMA_MAIN_MODEL?.trim() || 'qwen2.5:3b';
  const ollamaFastModel = process.env.OLLAMA_FAST_MODEL?.trim() || 'qwen2.5:3b';
  const ollamaEmbedModel = process.env.OLLAMA_EMBED_MODEL?.trim() || 'nomic-embed-text';
  const parsedEmbedDim = Number.parseInt(process.env.OLLAMA_EMBED_DIM?.trim() || '768', 10);
  const ollamaEmbedDim =
    Number.isInteger(parsedEmbedDim) && parsedEmbedDim > 0 ? parsedEmbedDim : 768;

  const inventoryServiceUrl = trimTrailingSlash(
    process.env.INVENTORY_SERVICE_URL?.trim() ||
      `http://127.0.0.1:${parsePort(process.env.INVENTORY_PORT, 4004)}`,
  );

  const cartOutfitServiceUrl = trimTrailingSlash(
    process.env.CART_OUTFIT_SERVICE_URL?.trim() ||
      process.env.CART_SERVICE_URL?.trim() ||
      `http://127.0.0.1:${parsePort(process.env.CART_OUTFIT_PORT, 4005)}`,
  );

  const orderRmaServiceUrl = trimTrailingSlash(
    process.env.ORDER_RMA_SERVICE_URL?.trim() ||
      process.env.ORDER_SERVICE_URL?.trim() ||
      `http://127.0.0.1:${parsePort(process.env.ORDER_RMA_PORT, 4006)}`,
  );

  const paymentPromoServiceUrl = trimTrailingSlash(
    process.env.PAYMENT_PROMO_SERVICE_URL?.trim() ||
      process.env.PAYMENT_SERVICE_URL?.trim() ||
      `http://127.0.0.1:${parsePort(process.env.PAYMENT_PROMO_PORT, 4007)}`,
  );

  const notifyReviewServiceUrl = trimTrailingSlash(
    process.env.NOTIFY_REVIEW_SERVICE_URL?.trim() ||
      process.env.NOTIFY_SERVICE_URL?.trim() ||
      `http://127.0.0.1:${parsePort(process.env.NOTIFY_REVIEW_PORT, 4008)}`,
  );

  const aiTryonServiceUrl = trimTrailingSlash(
    process.env.AI_TRYON_SERVICE_URL?.trim() ||
      `http://127.0.0.1:${parsePort(process.env.AI_TRYON_PORT, 4009)}`,
  );

  const mcpCopilotUrl = trimTrailingSlash(
    process.env.MCP_COPILOT_URL?.trim() ||
      `http://127.0.0.1:${parsePort(process.env.MCP_COPILOT_PORT, 4010)}`,
  );

  const storefrontUrl = trimTrailingSlash(
    process.env.STOREFRONT_URL?.trim() ||
      process.env.NEXT_PUBLIC_STOREFRONT_URL?.trim() ||
      `http://127.0.0.1:${parsePort(process.env.STOREFRONT_PORT, 3000)}`,
  );

  const revalidateSecret =
    process.env.REVALIDATE_SECRET?.trim() || 'Atelier_Isr_Revalidate_2026!';

  const internalServiceSecret =
    process.env.INTERNAL_SERVICE_SECRET?.trim() || 'Atelier_Internal_Svc_2026!';

  return {
    serviceName: BFF_SERVICE_NAME,
    port,
    nodeEnv: process.env.NODE_ENV ?? 'development',
    corsAllowedOrigins: parseOrigins(process.env.CORS_ALLOWED_ORIGINS, DEFAULT_CORS_ORIGINS),
    csrfAllowedOrigins: parseOrigins(process.env.CORS_ALLOWED_ORIGINS, DEFAULT_CSRF_ORIGINS),
    vtonProvider,
    redisUrl,
    redisConfigured: Boolean(process.env.REDIS_URL && process.env.REDIS_URL.trim().length > 0),
    rabbitmqConfigured: Boolean(
      process.env.RABBITMQ_URL && process.env.RABBITMQ_URL.trim().length > 0,
    ),
    meilisearchHost,
    minioPublicUrl,
    mailpitUiUrl,
    rabbitmqMgmtUrl,
    rabbitmqUser,
    rabbitmqPassword,
    ollamaBaseUrl,
    ollamaMainModel,
    ollamaFastModel,
    ollamaEmbedModel,
    ollamaEmbedDim,
    inventoryServiceUrl,
    cartOutfitServiceUrl,
    orderRmaServiceUrl,
    paymentPromoServiceUrl,
    notifyReviewServiceUrl,
    aiTryonServiceUrl,
    mcpCopilotUrl,
    storefrontUrl,
    revalidateSecret,
    internalServiceSecret,
    upstreams: {
      authCustomerUrl: trimTrailingSlash(
        process.env.AUTH_SERVICE_URL?.trim() ||
          `http://127.0.0.1:${parsePort(process.env.AUTH_CUSTOMER_PORT, 4001)}`,
      ),
      catalogLookbookUrl: trimTrailingSlash(
        process.env.CATALOG_SERVICE_URL?.trim() ||
          `http://127.0.0.1:${parsePort(process.env.CATALOG_LOOKBOOK_PORT, 4002)}`,
      ),
      mediaPipelineUrl: trimTrailingSlash(
        process.env.MEDIA_SERVICE_URL?.trim() ||
          `http://127.0.0.1:${parsePort(process.env.MEDIA_PIPELINE_PORT, 4003)}`,
      ),
      inventoryUrl: inventoryServiceUrl,
      cartOutfitUrl: cartOutfitServiceUrl,
      orderRmaUrl: orderRmaServiceUrl,
      paymentPromoUrl: paymentPromoServiceUrl,
      notifyReviewUrl: notifyReviewServiceUrl,
      aiTryOnUrl: aiTryonServiceUrl,
      mcpCopilotUrl,
    },
  };
}

export const BFF_CONFIG_TOKEN = 'BFF_CONFIG_TOKEN';
