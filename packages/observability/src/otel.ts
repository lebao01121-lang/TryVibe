import {
  context,
  propagation,
  SpanKind,
  SpanStatusCode,
  trace,
  type Attributes,
  type Context,
  type Span,
  type SpanOptions,
} from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  BatchSpanProcessor,
  NodeTracerProvider,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace-node';
import {
  ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions';
import { parseTraceparent, TRACEPARENT_HEADER, type HeaderBag } from './correlation';

export const DEFAULT_OTLP_HTTP_TRACES_ENDPOINT = 'http://otel-collector:4318/v1/traces' as const;

export interface InitOpenTelemetryOptions {
  serviceName: string;
  serviceVersion?: string;
  environment?: string;
  otlpEndpoint?: string;
  enabled?: boolean;
  extraSpanProcessors?: SpanProcessor[];
}

export interface OpenTelemetryHandle {
  serviceName: string;
  serviceVersion: string;
  environment: string;
  otlpEnabled: boolean;
  otlpEndpoint: string | null;
  provider: NodeTracerProvider;
  shutdown: () => Promise<void>;
}

export interface WithSpanOptions {
  tracerName?: string;
  kind?: SpanKind;
  attributes?: Attributes;
  parentTraceparent?: string | null;
  headers?: HeaderBag;
}

let activeHandle: OpenTelemetryHandle | null = null;

function normalizeOtlpTracesUrl(rawEndpoint: string): string {
  const trimmed = rawEndpoint.trim().replace(/\/+$/, '');
  if (/\/v1\/traces$/i.test(trimmed)) {
    return trimmed;
  }
  return `${trimmed}/v1/traces`;
}

function resolveOtlpConfig(options: InitOpenTelemetryOptions): {
  otlpEnabled: boolean;
  otlpEndpoint: string | null;
} {
  const envEndpoint = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
    ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  const envEnabled = (process.env.OTEL_ENABLED ?? '').trim().toLowerCase() === 'true';
  const explicitEndpoint = options.otlpEndpoint?.trim();

  if (options.enabled === false) {
    return { otlpEnabled: false, otlpEndpoint: null };
  }

  const candidateEndpoint = explicitEndpoint || envEndpoint?.trim() || '';
  if (candidateEndpoint.length > 0) {
    return {
      otlpEnabled: true,
      otlpEndpoint: normalizeOtlpTracesUrl(candidateEndpoint),
    };
  }

  if (options.enabled === true || envEnabled) {
    return {
      otlpEnabled: true,
      otlpEndpoint: DEFAULT_OTLP_HTTP_TRACES_ENDPOINT,
    };
  }

  return { otlpEnabled: false, otlpEndpoint: null };
}

/**
 * Safely and idempotently initializes OpenTelemetry for a Fashion Atelier Node.js service.
 *
 * - Always registers W3C `traceparent` context propagation (`AsyncLocalStorage` + W3C TraceContext)
 *   so distributed traces flow across HTTP and AMQP boundaries even offline in local dev.
 * - Only activates the HTTP `OTLPTraceExporter` + `BatchSpanProcessor` when
 *   `OTEL_EXPORTER_OTLP_ENDPOINT` (or `OTEL_ENABLED=true`) is configured, preventing
 *   network hangs/timeouts during offline local development and unit tests.
 */
export function initOpenTelemetry(options: InitOpenTelemetryOptions): OpenTelemetryHandle {
  if (activeHandle) {
    return activeHandle;
  }

  const serviceName = options.serviceName;
  const serviceVersion = options.serviceVersion ?? process.env.SERVICE_VERSION ?? '3.1.0';
  const environment =
    options.environment ?? process.env.DEPLOYMENT_ENVIRONMENT ?? process.env.NODE_ENV ?? 'development';

  const { otlpEnabled, otlpEndpoint } = resolveOtlpConfig(options);

  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: serviceName,
    [ATTR_SERVICE_VERSION]: serviceVersion,
    'deployment.environment': environment,
    [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: environment,
  });

  const spanProcessors: SpanProcessor[] = [...(options.extraSpanProcessors ?? [])];

  if (otlpEnabled && otlpEndpoint) {
    const exporter = new OTLPTraceExporter({
      url: otlpEndpoint,
      timeoutMillis: 5000,
    });
    spanProcessors.push(
      new BatchSpanProcessor(exporter, {
        maxQueueSize: 1024,
        maxExportBatchSize: 256,
        scheduledDelayMillis: 2000,
        exportTimeoutMillis: 5000,
      }),
    );
  }

  const provider = new NodeTracerProvider({
    resource,
    spanProcessors,
  });

  provider.register();

  const handle: OpenTelemetryHandle = {
    serviceName,
    serviceVersion,
    environment,
    otlpEnabled,
    otlpEndpoint,
    provider,
    shutdown: async () => {
      await shutdownOpenTelemetry();
    },
  };

  activeHandle = handle;
  return handle;
}

/**
 * Gracefully flushes pending spans and shuts down the active OpenTelemetry TracerProvider.
 */
export async function shutdownOpenTelemetry(): Promise<void> {
  const current = activeHandle;
  activeHandle = null;
  if (!current) {
    return;
  }
  try {
    await current.provider.shutdown();
  } catch {
    // Do not crash service shutdown if remote OTLP collector is unreachable
  } finally {
    trace.disable();
    context.disable();
    propagation.disable();
  }
}

export function getActiveOpenTelemetryHandle(): OpenTelemetryHandle | null {
  return activeHandle;
}

/**
 * Extracts a W3C Trace Context from incoming HTTP/AMQP headers.
 */
export function extractTraceContextFromHeaders(headers?: HeaderBag): Context {
  if (!headers) {
    return context.active();
  }
  const normalizedCarrier: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === 'string') {
      normalizedCarrier[key.toLowerCase()] = value;
    } else if (Array.isArray(value) && typeof value[0] === 'string') {
      normalizedCarrier[key.toLowerCase()] = value[0];
    }
  }
  return propagation.extract(context.active(), normalizedCarrier);
}

/**
 * Injects the active OpenTelemetry W3C Trace Context (`traceparent`, `tracestate`) into outgoing headers.
 */
export function injectTraceHeaders(
  headers: Record<string, string> = {},
): Record<string, string> {
  const carrier: Record<string, string> = { ...headers };
  propagation.inject(context.active(), carrier);
  return carrier;
}

/**
 * Returns the active W3C `traceparent` string (`00-<traceId>-<spanId>-<flags>`)
 * from the current OpenTelemetry context, or `null` if no span is active.
 */
export function getActiveTraceparent(): string | null {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  const injected = parseTraceparent(carrier[TRACEPARENT_HEADER]);
  if (injected) {
    return injected.raw;
  }

  const activeSpan = trace.getSpan(context.active());
  if (!activeSpan) {
    return null;
  }
  const spanCtx = activeSpan.spanContext();
  const flagsHex = spanCtx.traceFlags.toString(16).padStart(2, '0');
  const candidate = `00-${spanCtx.traceId}-${spanCtx.spanId}-${flagsHex}`;
  return parseTraceparent(candidate)?.raw ?? null;
}

/**
 * Executes an async or sync unit of work inside an OpenTelemetry span,
 * automatically recording exceptions, setting span status, and ending the span.
 */
export async function withSpan<T>(
  spanName: string,
  fn: (span: Span) => Promise<T> | T,
  options: WithSpanOptions = {},
): Promise<T> {
  const tracerName = options.tracerName ?? activeHandle?.serviceName ?? '@atelier/observability';
  const tracer = trace.getTracer(tracerName, activeHandle?.serviceVersion ?? '3.1.0');

  let parentCtx = context.active();
  if (options.headers) {
    parentCtx = extractTraceContextFromHeaders(options.headers);
  } else if (options.parentTraceparent) {
    parentCtx = extractTraceContextFromHeaders({ [TRACEPARENT_HEADER]: options.parentTraceparent });
  }

  const spanOptions: SpanOptions = {
    kind: options.kind ?? SpanKind.INTERNAL,
    ...(options.attributes ? { attributes: options.attributes } : {}),
  };

  return tracer.startActiveSpan(spanName, spanOptions, parentCtx, async (span) => {
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      if (error instanceof Error) {
        span.recordException(error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
      } else {
        span.setStatus({ code: SpanStatusCode.ERROR, message: String(error) });
      }
      throw error;
    } finally {
      span.end();
    }
  });
}

export { SpanKind, SpanStatusCode, type Attributes, type Context, type Span };
