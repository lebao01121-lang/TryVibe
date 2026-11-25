import {
  collectDefaultMetrics,
  Counter,
  Gauge,
  Histogram,
  Registry,
} from 'prom-client';
import type { NextFunctionLike } from './correlation';

export const HTTP_REQUEST_DURATION_BUCKETS: readonly number[] = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.4, 0.75, 1, 2.5, 5,
] as const;

export type TryOnCacheOutcome = 'hit' | 'miss';

export interface AtelierMetricsOptions {
  serviceName: string;
  collectDefaultProcessMetrics?: boolean;
  defaultLabels?: Record<string, string>;
  registry?: Registry;
}

export interface HttpObservationParams {
  method: string;
  route: string;
  statusCode: number;
  durationSeconds: number;
  service?: string;
}

export interface PrometheusMetricsPayload {
  contentType: string;
  body: string;
}

export interface MetricsRequestLike {
  method?: string;
  url?: string;
  originalUrl?: string;
  baseUrl?: string;
  path?: string;
  route?: {
    path?: string | RegExp;
  };
}

export interface MetricsResponseLike {
  statusCode: number;
  on(event: 'finish' | 'close', listener: () => void): unknown;
}

export interface MetricsRouteResponseLike extends MetricsResponseLike {
  setHeader(name: string, value: string): unknown;
  end(body?: string): unknown;
}

const UUID_REGEX = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const LONG_HEX_REGEX = /(?<=\/)[0-9a-f]{16,}(?=\/|$)/gi;
const NUMERIC_SEGMENT_REGEX = /(?<=\/)\d+(?=\/|$)/g;
const ORDER_CODE_REGEX = /(?<=\/)TX-[0-9A-Z]{6,}(?=\/|$)/gi;

/**
 * Normalizes dynamic path segments (UUIDs, numeric IDs, hex hashes, order codes)
 * so Prometheus label cardinality stays bounded across all endpoints.
 */
export function normalizeMetricsRoute(rawUrl: string): string {
  const withoutQuery = (rawUrl || '/').split('?')[0] ?? '/';
  const collapsed = withoutQuery.replace(/\/{2,}/g, '/');
  const normalized = collapsed
    .replace(UUID_REGEX, ':uuid')
    .replace(ORDER_CODE_REGEX, ':order_code')
    .replace(LONG_HEX_REGEX, ':hex')
    .replace(NUMERIC_SEGMENT_REGEX, ':id');

  if (normalized.length > 1 && normalized.endsWith('/')) {
    return normalized.slice(0, -1);
  }
  return normalized || '/';
}

/**
 * Per-service isolated Prometheus Registry exposing standardized Fashion Atelier
 * HTTP latency/error, Anti-Oversell, Ollama LLM throughput, Try-On cache, and RabbitMQ DLQ metrics.
 */
export class AtelierMetricsRegistry {
  public readonly serviceName: string;
  public readonly registry: Registry;

  public readonly httpRequestDurationSeconds: Histogram<
    'service' | 'method' | 'route' | 'status_code'
  >;
  public readonly httpRequestsTotal: Counter<
    'service' | 'method' | 'route' | 'status_code'
  >;
  public readonly inventoryOversellBlockedTotal: Counter<
    'service' | 'sku_group' | 'reason'
  >;
  public readonly ollamaTokensPerSecond: Gauge<'service' | 'model'>;
  public readonly tryonCacheEventsTotal: Counter<'service' | 'outcome'>;
  public readonly rabbitmqDlqDepth: Gauge<'service' | 'queue'>;

  constructor(options: AtelierMetricsOptions) {
    this.serviceName = options.serviceName;
    this.registry = options.registry ?? new Registry();

    if (options.defaultLabels && Object.keys(options.defaultLabels).length > 0) {
      this.registry.setDefaultLabels(options.defaultLabels);
    }

    if (options.collectDefaultProcessMetrics !== false) {
      collectDefaultMetrics({
        register: this.registry,
        prefix: 'atelier_process_',
      });
    }

    this.httpRequestDurationSeconds = new Histogram({
      name: 'atelier_http_request_duration_seconds',
      help: 'HTTP request latency in seconds for Fashion Atelier services (p50/p95/p99 via histogram_quantile).',
      labelNames: ['service', 'method', 'route', 'status_code'] as const,
      buckets: [...HTTP_REQUEST_DURATION_BUCKETS],
      registers: [this.registry],
    });

    this.httpRequestsTotal = new Counter({
      name: 'atelier_http_requests_total',
      help: 'Total count of HTTP requests handled by Fashion Atelier services.',
      labelNames: ['service', 'method', 'route', 'status_code'] as const,
      registers: [this.registry],
    });

    this.inventoryOversellBlockedTotal = new Counter({
      name: 'atelier_inventory_oversell_blocked_total',
      help: 'Total count of inventory oversell attempts atomically blocked.',
      labelNames: ['service', 'sku_group', 'reason'] as const,
      registers: [this.registry],
    });

    this.ollamaTokensPerSecond = new Gauge({
      name: 'atelier_ollama_tokens_per_second',
      help: 'Observed local Ollama LLM inference speed in tokens per second.',
      labelNames: ['service', 'model'] as const,
      registers: [this.registry],
    });

    this.tryonCacheEventsTotal = new Counter({
      name: 'atelier_tryon_cache_events_total',
      help: 'Total count of AI Virtual Try-On SHA-256 cache hits and misses.',
      labelNames: ['service', 'outcome'] as const,
      registers: [this.registry],
    });

    this.rabbitmqDlqDepth = new Gauge({
      name: 'atelier_rabbitmq_dlq_depth',
      help: 'Current message depth of RabbitMQ Dead-Letter Queues (*.dlq).',
      labelNames: ['service', 'queue'] as const,
      registers: [this.registry],
    });
  }

  public observeHttpRequest(params: HttpObservationParams): void {
    const labels = {
      service: params.service ?? this.serviceName,
      method: (params.method || 'GET').toUpperCase(),
      route: normalizeMetricsRoute(params.route),
      status_code: String(params.statusCode),
    };
    const safeDuration =
      Number.isFinite(params.durationSeconds) && params.durationSeconds >= 0
        ? params.durationSeconds
        : 0;
    this.httpRequestDurationSeconds.observe(labels, safeDuration);
    this.httpRequestsTotal.inc(labels, 1);
  }

  public recordInventoryOversellBlocked(
    skuGroup: string,
    reason: string,
    count = 1,
    service?: string,
  ): void {
    this.inventoryOversellBlockedTotal.inc(
      {
        service: service ?? this.serviceName,
        sku_group: skuGroup || 'default',
        reason: reason || 'INSUFFICIENT_STOCK',
      },
      count,
    );
  }

  public setOllamaTokensPerSecond(
    model: string,
    tokensPerSecond: number,
    service?: string,
  ): void {
    const safeSpeed = Number.isFinite(tokensPerSecond) && tokensPerSecond >= 0 ? tokensPerSecond : 0;
    this.ollamaTokensPerSecond.set(
      {
        service: service ?? this.serviceName,
        model: model || 'unknown',
      },
      safeSpeed,
    );
  }

  public recordTryOnCacheEvent(
    outcome: TryOnCacheOutcome,
    count = 1,
    service?: string,
  ): void {
    this.tryonCacheEventsTotal.inc(
      {
        service: service ?? this.serviceName,
        outcome,
      },
      count,
    );
  }

  public setRabbitMqDlqDepth(queue: string, depth: number, service?: string): void {
    const safeDepth = Number.isFinite(depth) && depth >= 0 ? depth : 0;
    this.rabbitmqDlqDepth.set(
      {
        service: service ?? this.serviceName,
        queue: queue || 'unknown.dlq',
      },
      safeDepth,
    );
  }

  public async getMetricsPayload(): Promise<PrometheusMetricsPayload> {
    const body = await this.registry.metrics();
    return {
      contentType: this.registry.contentType,
      body,
    };
  }

  public reset(): void {
    this.registry.resetMetrics();
  }
}

let defaultMetricsRegistry: AtelierMetricsRegistry | null = null;

/**
 * Returns or initializes the process-wide default `AtelierMetricsRegistry`.
 */
export function getOrCreateMetricsRegistry(
  serviceName = 'atelier-service',
  options: Omit<AtelierMetricsOptions, 'serviceName'> = {},
): AtelierMetricsRegistry {
  if (!defaultMetricsRegistry) {
    defaultMetricsRegistry = new AtelierMetricsRegistry({
      serviceName,
      ...options,
    });
  }
  return defaultMetricsRegistry;
}

export function setDefaultMetricsRegistry(registry: AtelierMetricsRegistry | null): void {
  defaultMetricsRegistry = registry;
}

function resolveRequestRoute(req: MetricsRequestLike): string {
  if (req.route?.path && typeof req.route.path === 'string') {
    const combined = `${req.baseUrl ?? ''}${req.route.path}`;
    return normalizeMetricsRoute(combined);
  }
  return normalizeMetricsRoute(req.originalUrl ?? req.url ?? req.path ?? '/');
}

/**
 * Express/NestJS HTTP middleware that observes request duration and counts
 * into `atelier_http_request_duration_seconds` and `atelier_http_requests_total`
 * with bounded route cardinality.
 */
export function createPrometheusHttpMiddleware(
  serviceName: string,
  registry?: AtelierMetricsRegistry,
): (req: MetricsRequestLike, res: MetricsResponseLike, next: NextFunctionLike) => void {
  const targetRegistry = registry ?? getOrCreateMetricsRegistry(serviceName);

  return function prometheusHttpMiddleware(
    req: MetricsRequestLike,
    res: MetricsResponseLike,
    next: NextFunctionLike,
  ): void {
    const rawPath = (req.originalUrl ?? req.url ?? req.path ?? '/').split('?')[0] ?? '/';
    // Skip Prometheus self-scrapes to keep application latency & RPS accurate
    if (rawPath === '/metrics') {
      next();
      return;
    }

    const startedAtNs = process.hrtime.bigint();
    let recorded = false;

    const finalize = (): void => {
      if (recorded) {
        return;
      }
      recorded = true;
      const elapsedNs = Number(process.hrtime.bigint() - startedAtNs);
      const durationSeconds = Math.max(0, elapsedNs / 1e9);
      targetRegistry.observeHttpRequest({
        service: serviceName,
        method: req.method ?? 'GET',
        route: resolveRequestRoute(req),
        statusCode: res.statusCode || 200,
        durationSeconds,
      });
    };

    res.on('finish', finalize);
    res.on('close', finalize);
    next();
  };
}

/**
 * Lightweight Express/Connect middleware serving `GET /metrics` in Prometheus text format
 * with near-zero overhead on non-metrics routes (keeps `/health` & `/ready` `< 1ms`).
 */
export function createPrometheusMetricsRouteMiddleware(
  registry?: AtelierMetricsRegistry | Registry,
  metricsPath = '/metrics',
): (req: MetricsRequestLike, res: MetricsRouteResponseLike, next: NextFunctionLike) => void {
  return function prometheusMetricsRouteMiddleware(
    req: MetricsRequestLike,
    res: MetricsRouteResponseLike,
    next: NextFunctionLike,
  ): void {
    const method = (req.method ?? 'GET').toUpperCase();
    const pathname = (req.originalUrl ?? req.url ?? req.path ?? '/').split('?')[0] ?? '/';
    if (method !== 'GET' || pathname !== metricsPath) {
      next();
      return;
    }

    void getPrometheusMetricsPayload(registry)
      .then((payload) => {
        res.statusCode = 200;
        res.setHeader('Content-Type', payload.contentType);
        res.setHeader('Cache-Control', 'no-store');
        res.end(payload.body);
      })
      .catch((error: unknown) => {
        next(error);
      });
  };
}

/**
 * Renders Prometheus exposition text payload and content-type header.
 */
export async function getPrometheusMetricsPayload(
  registry?: AtelierMetricsRegistry | Registry,
): Promise<PrometheusMetricsPayload> {
  if (registry instanceof AtelierMetricsRegistry) {
    return registry.getMetricsPayload();
  }
  if (registry instanceof Registry) {
    const body = await registry.metrics();
    return {
      contentType: registry.contentType,
      body,
    };
  }
  const active = getOrCreateMetricsRegistry();
  return active.getMetricsPayload();
}

export { Counter, Gauge, Histogram, Registry };
