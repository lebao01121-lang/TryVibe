import type {
  DependencyCheck,
  HealthResponse,
  HealthStatus,
  ReadinessResponse,
} from '@atelier/contracts';

const PROCESS_STARTED_AT_MS = Date.now();

export type StandardHealthStatus = 'UP' | 'DEGRADED' | 'DOWN';

export interface HealthBuildOptions {
  version?: string;
  metadata?: Record<string, unknown>;
  startedAtMs?: number;
  latencyMs?: number;
}

export interface ReadinessBuildOptions {
  port?: number;
  version?: string;
  metadata?: Record<string, unknown>;
  startedAtMs?: number;
  latencyMs?: number;
}

export interface StandardHealthPayload {
  status: StandardHealthStatus;
  service: string;
  port: number;
  version: string;
  uptimeSeconds: number;
  latencyMs: number;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

export interface StandardReadinessPayload {
  status: StandardHealthStatus;
  ready: boolean;
  service: string;
  port?: number;
  version: string;
  latencyMs: number;
  checks: DependencyCheck[];
  timestamp: string;
  metadata?: Record<string, unknown>;
}

function resolveLatencyMs(
  explicitLatencyMs: number | undefined,
  startedAtMs: number | undefined,
  checks?: DependencyCheck[],
): number {
  if (typeof explicitLatencyMs === 'number' && Number.isFinite(explicitLatencyMs)) {
    return Math.max(0, Math.round(explicitLatencyMs));
  }
  if (typeof startedAtMs === 'number' && Number.isFinite(startedAtMs)) {
    return Math.max(0, Math.round(Date.now() - startedAtMs));
  }
  if (checks && checks.length > 0) {
    const sum = checks.reduce(
      (acc, check) => acc + (typeof check.latencyMs === 'number' ? check.latencyMs : 0),
      0,
    );
    return Math.max(0, Math.round(sum));
  }
  return 0;
}

export function buildHealthResponse(
  service: string,
  port: number,
  options: HealthBuildOptions = {},
): HealthResponse & { latencyMs: number } {
  return {
    status: 'ok',
    service,
    port,
    version: options.version ?? '3.0.0',
    uptimeSeconds: Math.max(0, Math.floor((Date.now() - PROCESS_STARTED_AT_MS) / 1000)),
    latencyMs: resolveLatencyMs(options.latencyMs, options.startedAtMs),
    timestamp: new Date().toISOString(),
    ...(options.metadata ? { metadata: options.metadata } : {}),
  };
}

export function buildReadinessResponse(
  service: string,
  checks: DependencyCheck[],
  options: ReadinessBuildOptions = {},
): ReadinessResponse & { latencyMs: number } {
  const hasDown = checks.some((check) => check.status === 'down');
  const hasSkippedOnly =
    checks.length > 0 && checks.every((check) => check.status === 'skipped');

  let status: HealthStatus = 'ok';
  if (hasDown) {
    status = 'down';
  } else if (hasSkippedOnly) {
    status = 'degraded';
  }

  return {
    status,
    ready: !hasDown,
    service,
    ...(options.port !== undefined ? { port: options.port } : {}),
    latencyMs: resolveLatencyMs(options.latencyMs, options.startedAtMs, checks),
    checks,
    timestamp: new Date().toISOString(),
    ...(options.metadata ? { metadata: options.metadata } : {}),
  };
}

/**
 * Phase 6 standardized health payload (`UP | DEGRADED | DOWN` + `latencyMs`).
 */
export function buildHealthPayload(
  service: string,
  port: number,
  options: HealthBuildOptions = {},
): StandardHealthPayload {
  return {
    status: 'UP',
    service,
    port,
    version: options.version ?? '3.0.0',
    uptimeSeconds: Math.max(0, Math.floor((Date.now() - PROCESS_STARTED_AT_MS) / 1000)),
    latencyMs: resolveLatencyMs(options.latencyMs, options.startedAtMs),
    timestamp: new Date().toISOString(),
    ...(options.metadata ? { metadata: options.metadata } : {}),
  };
}

/**
 * Phase 6 standardized readiness payload (`UP | DEGRADED | DOWN` + `latencyMs`).
 */
export function buildReadinessPayload(
  service: string,
  checks: DependencyCheck[],
  options: ReadinessBuildOptions = {},
): StandardReadinessPayload {
  const hasDown = checks.some((check) => check.status === 'down');
  const hasSkipped = checks.some((check) => check.status === 'skipped');

  let status: StandardHealthStatus = 'UP';
  if (hasDown) {
    status = 'DOWN';
  } else if (hasSkipped) {
    status = 'DEGRADED';
  }

  return {
    status,
    ready: !hasDown,
    service,
    ...(options.port !== undefined ? { port: options.port } : {}),
    version: options.version ?? '3.0.0',
    latencyMs: resolveLatencyMs(options.latencyMs, options.startedAtMs, checks),
    checks,
    timestamp: new Date().toISOString(),
    ...(options.metadata ? { metadata: options.metadata } : {}),
  };
}
