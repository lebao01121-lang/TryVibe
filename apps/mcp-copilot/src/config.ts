import { existsSync, readFileSync } from 'node:fs';
import { Socket } from 'node:net';
import { resolve } from 'node:path';
import {
  DEFAULT_OLLAMA_EMBED_DIM,
  DEFAULT_OLLAMA_EMBED_MODEL,
  DEFAULT_OLLAMA_FAST_MODEL,
  DEFAULT_OLLAMA_KEEP_ALIVE,
  DEFAULT_OLLAMA_NUM_CTX,
  DEFAULT_OLLAMA_TIMEOUT_MS,
  resolveOllamaBaseUrl,
} from '@atelier/ai-harness';

export interface McpCopilotConfig {
  serviceName: string;
  port: number;
  host: string;
  bffUrl: string;
  ragVectorDatabaseUrl: string;
  redisUrl: string;
  meilisearchHost: string;
  meilisearchMasterKey: string;
  aiProvider: 'ollama';
  ollamaBaseUrl: string;
  ollamaMainModel: string;
  ollamaFastModel: string;
  ollamaEmbedModel: string;
  ollamaEmbedDim: number;
  ollamaNumCtx: number;
  ollamaKeepAlive: string;
  ollamaTimeoutMs: number;
  ollamaOfflineMode?: boolean;
  vtonProvider: 'mock' | 'fal';
  defaultSupplierId: string;
  semanticCacheTtlSeconds: number;
}

function loadEnvFileIfPresent(): void {
  const candidates = [
    resolve(process.cwd(), '.env'),
    resolve(process.cwd(), '../../.env'),
    resolve(__dirname, '../../../.env'),
  ];

  for (const envPath of candidates) {
    if (!existsSync(envPath)) {
      continue;
    }
    try {
      const content = readFileSync(envPath, 'utf8');
      for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) {
          continue;
        }
        const eqIdx = line.indexOf('=');
        if (eqIdx <= 0) {
          continue;
        }
        const key = line.slice(0, eqIdx).trim();
        let value = line.slice(eqIdx + 1).trim();
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1);
        }
        if (process.env[key] === undefined) {
          process.env[key] = value;
        }
      }
      break;
    } catch {
      // Ignore unreadable .env files
    }
  }
}

export function loadConfig(): McpCopilotConfig {
  loadEnvFileIfPresent();

  const rawPort = Number(process.env.MCP_COPILOT_PORT ?? 4010);
  const port = Number.isFinite(rawPort) && rawPort > 0 ? rawPort : 4010;
  const vtonEnv = (process.env.VTON_PROVIDER ?? 'mock').toLowerCase();
  const embedDimRaw = Number(process.env.OLLAMA_EMBED_DIM ?? DEFAULT_OLLAMA_EMBED_DIM);
  const numCtxRaw = Number(process.env.OLLAMA_NUM_CTX ?? DEFAULT_OLLAMA_NUM_CTX);
  const timeoutRaw = Number(process.env.OLLAMA_TIMEOUT_MS ?? DEFAULT_OLLAMA_TIMEOUT_MS);

  return {
    serviceName: 'mcp-copilot',
    port,
    host: process.env.MCP_COPILOT_HOST ?? '0.0.0.0',
    bffUrl: (process.env.BFF_URL ?? 'http://127.0.0.1:4000').replace(/\/+$/, ''),
    ragVectorDatabaseUrl: (process.env.RAG_VECTOR_DATABASE_URL ?? '').trim(),
    redisUrl: (
      process.env.REDIS_URL ?? 'redis://:Atelier_Redis2026!@127.0.0.1:6379'
    ).trim(),
    meilisearchHost: (
      process.env.MEILISEARCH_HOST ?? 'http://127.0.0.1:7700'
    ).replace(/\/+$/, ''),
    meilisearchMasterKey: (process.env.MEILISEARCH_MASTER_KEY ?? '').trim(),
    aiProvider: 'ollama',
    ollamaBaseUrl: resolveOllamaBaseUrl(process.env.OLLAMA_BASE_URL),
    ollamaMainModel: (
      process.env.OLLAMA_MAIN_MODEL ?? DEFAULT_OLLAMA_FAST_MODEL
    ).trim(),
    ollamaFastModel: (
      process.env.OLLAMA_FAST_MODEL ?? DEFAULT_OLLAMA_FAST_MODEL
    ).trim(),
    ollamaEmbedModel: (
      process.env.OLLAMA_EMBED_MODEL ?? DEFAULT_OLLAMA_EMBED_MODEL
    ).trim(),
    ollamaEmbedDim:
      Number.isFinite(embedDimRaw) && embedDimRaw > 0
        ? embedDimRaw
        : DEFAULT_OLLAMA_EMBED_DIM,
    ollamaNumCtx:
      Number.isFinite(numCtxRaw) && numCtxRaw > 0
        ? numCtxRaw
        : DEFAULT_OLLAMA_NUM_CTX,
    ollamaKeepAlive: (
      process.env.OLLAMA_KEEP_ALIVE ?? DEFAULT_OLLAMA_KEEP_ALIVE
    ).trim(),
    ollamaTimeoutMs:
      Number.isFinite(timeoutRaw) && timeoutRaw > 0
        ? timeoutRaw
        : DEFAULT_OLLAMA_TIMEOUT_MS,
    vtonProvider: vtonEnv === 'fal' ? 'fal' : 'mock',
    defaultSupplierId: (
      process.env.SUPPLIER_A_ID ?? '11111111-1111-4111-8111-111111111101'
    ).trim(),
    semanticCacheTtlSeconds: 300,
  };
}

export function parseSafeConnectionTarget(
  urlString: string,
): { host: string; port: number; database?: string; password?: string } | null {
  if (!urlString) {
    return null;
  }
  try {
    const parsed = new URL(urlString);
    const defaultPort =
      parsed.protocol === 'https:'
        ? 443
        : parsed.protocol === 'http:'
          ? 80
          : parsed.protocol === 'redis:' || parsed.protocol === 'rediss:'
            ? 6379
            : 5432;
    const port = parsed.port ? Number(parsed.port) : defaultPort;
    const database = parsed.pathname.replace(/^\//, '') || undefined;
    const password = parsed.password ? decodeURIComponent(parsed.password) : undefined;
    return { host: parsed.hostname, port, database, password };
  } catch {
    return null;
  }
}

export function probeTcpConnectivity(
  host: string,
  port: number,
  timeoutMs = 300,
): Promise<{ reachable: boolean; latencyMs: number }> {
  const startedAt = Date.now();
  return new Promise((resolvePromise) => {
    const socket = new Socket();
    let settled = false;

    const finish = (reachable: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      resolvePromise({ reachable, latencyMs: Date.now() - startedAt });
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, host);
  });
}
