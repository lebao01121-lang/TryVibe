import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AtelierMetricsRegistry,
  buildHealthPayload,
  buildReadinessPayload,
  correlationIdMiddleware,
  createChildTraceparent,
  createPrometheusHttpMiddleware,
  createPrometheusMetricsRouteMiddleware,
  getActiveOpenTelemetryHandle,
  getActiveTraceparent,
  getOrCreateMetricsRegistry,
  getPrometheusMetricsPayload,
  initOpenTelemetry,
  injectTraceHeaders,
  normalizeMetricsRoute,
  parseTraceparent,
  redactPiiForLog,
  setDefaultMetricsRegistry,
  shutdownOpenTelemetry,
  withSpan,
} from './index';

describe('@atelier/observability — Prometheus Metrics & OpenTelemetry SDK', () => {
  afterEach(async () => {
    await shutdownOpenTelemetry();
  });

  it('normalizes UUID, numeric, hex, and order-code route segments to bound cardinality', () => {
    expect(
      normalizeMetricsRoute(
        '/api/v1/admin/orders/abc8d089-785d-4562-89dc-e788ab683f30/items/42?tab=ledger',
      ),
    ).toBe('/api/v1/admin/orders/:uuid/items/:id');
    expect(normalizeMetricsRoute('/bff/v1/storefront/orders/TX-20267D3E24/status')).toBe(
      '/bff/v1/storefront/orders/:order_code/status',
    );
    expect(normalizeMetricsRoute('/api/v1/media/abcdef0123456789abcdef01/preview/')).toBe(
      '/api/v1/media/:hex/preview',
    );
  });

  it('exposes HTTP latency histogram, request counters, oversell, Ollama, Try-On cache, and DLQ metrics', async () => {
    const metrics = new AtelierMetricsRegistry({
      serviceName: 'bff',
      collectDefaultProcessMetrics: false,
    });

    // 1. HTTP latency histogram + request totals
    metrics.observeHttpRequest({
      method: 'GET',
      route: '/bff/v1/storefront/products/abc8d089-785d-4562-89dc-e788ab683f30',
      statusCode: 200,
      durationSeconds: 0.042,
    });
    metrics.observeHttpRequest({
      method: 'POST',
      route: '/bff/v1/storefront/orders',
      statusCode: 503,
      durationSeconds: 0.62,
    });

    // 2. Anti-Oversell counter
    metrics.recordInventoryOversellBlocked('AT-AOBLLI-C1', 'INSUFFICIENT_STOCK', 3);

    // 3. Ollama local LLM speed gauge (tokens/s)
    metrics.setOllamaTokensPerSecond('qwen2.5:14b', 38.4);

    // 4. AI Try-On SHA-256 Cache Hit/Miss counters (3 hits, 1 miss -> 75% hit ratio)
    metrics.recordTryOnCacheEvent('hit', 3);
    metrics.recordTryOnCacheEvent('miss', 1);

    // 5. RabbitMQ Dead-Letter Queue depth gauge
    metrics.setRabbitMqDlqDepth('atelier.tryon.dlq', 0);
    metrics.setRabbitMqDlqDepth('atelier.notify.dlq', 2);

    const payload = await getPrometheusMetricsPayload(metrics);
    expect(payload.contentType).toContain('text/plain');

    // Histogram buckets (including 0.4s SLA boundary) & request counters
    expect(payload.body).toContain('atelier_http_request_duration_seconds_bucket');
    expect(payload.body).toContain('le="0.4"');
    expect(payload.body).toContain(
      'atelier_http_requests_total{service="bff",method="GET",route="/bff/v1/storefront/products/:uuid",status_code="200"} 1',
    );
    expect(payload.body).toContain(
      'atelier_http_requests_total{service="bff",method="POST",route="/bff/v1/storefront/orders",status_code="503"} 1',
    );

    // Anti-Oversell counter
    expect(payload.body).toContain(
      'atelier_inventory_oversell_blocked_total{service="bff",sku_group="AT-AOBLLI-C1",reason="INSUFFICIENT_STOCK"} 3',
    );

    // Ollama tokens/s gauge
    expect(payload.body).toContain(
      'atelier_ollama_tokens_per_second{service="bff",model="qwen2.5:14b"} 38.4',
    );

    // Try-On Cache Hit ratio counters
    expect(payload.body).toContain(
      'atelier_tryon_cache_events_total{service="bff",outcome="hit"} 3',
    );
    expect(payload.body).toContain(
      'atelier_tryon_cache_events_total{service="bff",outcome="miss"} 1',
    );

    // RabbitMQ DLQ depth gauge
    expect(payload.body).toContain(
      'atelier_rabbitmq_dlq_depth{service="bff",queue="atelier.tryon.dlq"} 0',
    );
    expect(payload.body).toContain(
      'atelier_rabbitmq_dlq_depth{service="bff",queue="atelier.notify.dlq"} 2',
    );
  });

  it('records HTTP metrics via createPrometheusHttpMiddleware and skips /metrics self-scrapes', async () => {
    const metrics = new AtelierMetricsRegistry({
      serviceName: 'bff',
      collectDefaultProcessMetrics: false,
    });
    const middleware = createPrometheusHttpMiddleware('bff', metrics);

    // Normal request -> recorded
    const listeners = new Map<string, () => void>();
    let nextCalled = false;
    middleware(
      { method: 'GET', originalUrl: '/health?probe=1' },
      {
        statusCode: 200,
        on(event, fn) {
          listeners.set(event, fn);
        },
      },
      () => {
        nextCalled = true;
      },
    );
    expect(nextCalled).toBe(true);
    listeners.get('finish')?.();

    // /metrics scrape -> skipped
    let metricsNextCalled = false;
    middleware(
      { method: 'GET', originalUrl: '/metrics' },
      {
        statusCode: 200,
        on() {
          throw new Error('Should not attach listeners for /metrics self-scrape');
        },
      },
      () => {
        metricsNextCalled = true;
      },
    );
    expect(metricsNextCalled).toBe(true);

    const { body } = await metrics.getMetricsPayload();
    expect(body).toContain(
      'atelier_http_requests_total{service="bff",method="GET",route="/health",status_code="200"} 1',
    );
    expect(body).not.toContain('route="/metrics"');
  });

  it('initializes OpenTelemetry offline safely and propagates W3C traceparent across spans', async () => {
    const handle = initOpenTelemetry({
      serviceName: 'bff-test',
      serviceVersion: '3.1.0',
      environment: 'test',
      enabled: false,
    });

    expect(handle.serviceName).toBe('bff-test');
    expect(handle.otlpEnabled).toBe(false);
    expect(handle.otlpEndpoint).toBeNull();

    const parentTraceId = '4bf92f3577b34da6a3ce929d0e0e4736';
    const parentSpanId = '00f067aa0ba902b7';
    const incomingTraceparent = `00-${parentTraceId}-${parentSpanId}-01`;

    const childTraceparent = await withSpan(
      'bff.checkout.reserve',
      async (span) => {
        span.setAttribute('atelier.order_code', 'TX-2026TEST01');
        return getActiveTraceparent();
      },
      { parentTraceparent: incomingTraceparent },
    );

    expect(childTraceparent).not.toBeNull();
    const parsed = parseTraceparent(childTraceparent);
    expect(parsed).not.toBeNull();
    expect(parsed?.traceId).toBe(parentTraceId);
    expect(parsed?.spanId).not.toBe(parentSpanId);
    expect(parsed?.traceFlags).toBe('01');

    // Also verify fresh root span produces valid W3C traceparent
    const rootTraceparent = await withSpan('bff.health.probe', () => getActiveTraceparent());
    expect(parseTraceparent(rootTraceparent)).not.toBeNull();
  });

  it('serves GET /metrics via createPrometheusMetricsRouteMiddleware and forwards non-metrics requests', async () => {
    const metrics = new AtelierMetricsRegistry({
      serviceName: 'inventory',
      collectDefaultProcessMetrics: false,
    });
    metrics.recordInventoryOversellBlocked('FLASH-DROP', 'INSUFFICIENT_STOCK', 2);

    const routeMiddleware = createPrometheusMetricsRouteMiddleware(metrics);

    // Non-/metrics request passes straight through
    let passedThrough = false;
    routeMiddleware(
      { method: 'GET', originalUrl: '/health' },
      {
        statusCode: 200,
        on() {},
        setHeader() {},
        end() {},
      },
      () => {
        passedThrough = true;
      },
    );
    expect(passedThrough).toBe(true);

    // GET /metrics responds with Prometheus exposition text
    const headers: Record<string, string> = {};
    const renderedBody = await new Promise<string>((resolve) => {
      routeMiddleware(
        { method: 'GET', originalUrl: '/metrics' },
        {
          statusCode: 0,
          on() {},
          setHeader(name, value) {
            headers[name.toLowerCase()] = value;
          },
          end(body) {
            resolve(body ?? '');
          },
        },
        () => {},
      );
    });

    expect(headers['content-type']).toContain('text/plain');
    expect(renderedBody).toContain('atelier_inventory_oversell_blocked_total');
  });

  it('activates OTLP endpoint normalization, exports spans over HTTP, records errors, and injects traceparent headers', async () => {
    const receivedPaths: string[] = [];
    const collectorServer = http.createServer((req, res) => {
      receivedPaths.push(req.url ?? '');
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
      });
    });
    await new Promise<void>((resolve) => collectorServer.listen(0, '127.0.0.1', resolve));
    const address = collectorServer.address();
    const port = typeof address === 'object' && address ? address.port : 4318;

    try {
      const handle = initOpenTelemetry({
        serviceName: 'bff-otlp',
        serviceVersion: '3.1.0',
        environment: 'staging',
        otlpEndpoint: `http://127.0.0.1:${port}`,
      });

      expect(handle.otlpEnabled).toBe(true);
      expect(handle.otlpEndpoint).toBe(`http://127.0.0.1:${port}/v1/traces`);
      // Idempotent second call returns same handle
      expect(initOpenTelemetry({ serviceName: 'ignored' })).toBe(handle);
      expect(getActiveOpenTelemetryHandle()).toBe(handle);

      const outgoing = await withSpan('bff.downstream.call', () =>
        injectTraceHeaders({ 'x-test': '1' }),
      );
      expect(outgoing['x-test']).toBe('1');
      expect(parseTraceparent(outgoing.traceparent)).not.toBeNull();

      await expect(
        withSpan('bff.failing.span', () => {
          throw new Error('simulated downstream timeout');
        }),
      ).rejects.toThrow('simulated downstream timeout');

      await shutdownOpenTelemetry();
      expect(receivedPaths).toContain('/v1/traces');
    } finally {
      await new Promise<void>((resolve) => collectorServer.close(() => resolve()));
    }
  });

  it('preserves existing correlation, health/readiness, default registry, and PII redaction exports', async () => {
    const req: { headers: Record<string, string>; correlationId?: string; traceparent?: string } = {
      headers: {},
    };
    const resHeaders: Record<string, string> = {};
    let nextCalled = false;
    correlationIdMiddleware(
      req,
      {
        setHeader(name, value) {
          resHeaders[name.toLowerCase()] = value;
        },
      },
      () => {
        nextCalled = true;
      },
    );
    expect(nextCalled).toBe(true);
    expect(req.correlationId).toBeTruthy();
    expect(parseTraceparent(req.traceparent)).not.toBeNull();
    expect(parseTraceparent(createChildTraceparent(req.traceparent))).not.toBeNull();

    const health = buildHealthPayload('bff', 4000, { latencyMs: 1 });
    expect(health.status).toBe('UP');
    const readiness = buildReadinessPayload('bff', [{ name: 'redis', status: 'up', latencyMs: 1 }]);
    expect(readiness.ready).toBe(true);

    const scrubbed = redactPiiForLog({
      phone: '0912345678',
      costPriceVnd: 500000,
      note: 'Call 0987654321 with Bearer secretToken123',
    });
    expect(scrubbed.phone).toBe('[REDACTED]');
    expect(scrubbed.costPriceVnd).toBe('[REDACTED]');
    expect(scrubbed.note).toContain('[REDACTED_PHONE]');
    expect(scrubbed.note).toContain('[REDACTED]');

    setDefaultMetricsRegistry(null);
    const defaultReg = getOrCreateMetricsRegistry('bff-default', {
      collectDefaultProcessMetrics: false,
    });
    defaultReg.observeHttpRequest({ method: 'GET', route: '/health', statusCode: 200, durationSeconds: 0.001 });
    const payload = await getPrometheusMetricsPayload();
    expect(payload.body).toContain('service="bff-default"');
    defaultReg.reset();
    setDefaultMetricsRegistry(null);
  });
});
