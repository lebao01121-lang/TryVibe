#!/usr/bin/env node
/**
 * Progressive Canary Rollout & Automated SLA Rollback Controller
 * Fashion Atelier AI Platform (v3.1)
 *
 * Supports:
 *   - `--dry-run`: Evaluates live `/health` (BFF :4000 + microservices :4001..:4010)
 *     and parses real Prometheus `/metrics` without executing traffic-shift commands.
 *   - Production Canary mode: Executes progressive traffic shifts (`10% -> 50% -> 100%`)
 *     via `NGINX_SWITCH_CMD`, enforces SLA gates (`5xx <= 1%`, `p95 <= 400ms`, `*.dlq <= 0`,
 *     all `/health` UP), and triggers `ROLLBACK_CMD` automatically on any breach.
 *
 * Usage:
 *   node scripts/canary-deploy.mjs --dry-run
 *   node scripts/canary-deploy.mjs --image-tag <sha> --phases 10,50,100 \
 *     --max-5xx-rate 0.01 --max-p95-ms 400 --max-dlq-depth 0
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_SERVICE_ENDPOINTS = [
  { name: 'bff', port: 4000 },
  { name: 'auth-customer', port: 4001 },
  { name: 'catalog-lookbook', port: 4002 },
  { name: 'media-pipeline', port: 4003 },
  { name: 'inventory', port: 4004 },
  { name: 'cart-outfit', port: 4005 },
  { name: 'order-rma', port: 4006 },
  { name: 'payment-promo', port: 4007 },
  { name: 'notify-review', port: 4008 },
  { name: 'ai-tryon-api', port: 4009 },
  { name: 'mcp-copilot', port: 4010 },
];

export function parseCliArgs(argv) {
  const opts = {
    imageTag: process.env.IMAGE_TAG || process.env.GITHUB_SHA || 'local-dev',
    phases: [10, 50, 100],
    dryRun: process.env.CANARY_DRY_RUN === 'true',
    baseUrl: (process.env.CANARY_BASE_URL || 'http://127.0.0.1:4000').replace(/\/+$/, ''),
    metricsUrl: process.env.CANARY_METRICS_URL || '',
    max5xxRate: Number.parseFloat(process.env.CANARY_MAX_5XX_RATE || '0.01'),
    maxP95Ms: Number.parseFloat(process.env.CANARY_MAX_P95_MS || '400'),
    maxDlqDepth: Number.parseFloat(process.env.CANARY_MAX_DLQ_DEPTH || '0'),
    soakMs: Number.parseInt(process.env.CANARY_SOAK_MS || '0', 10),
    timeoutMs: Number.parseInt(process.env.CANARY_HTTP_TIMEOUT_MS || '4000', 10),
    skipServiceMesh: process.env.CANARY_SKIP_SERVICE_MESH === 'true',
    outputPath: process.env.CANARY_OUTPUT_PATH || '',
    simulateBreach: 'none',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    switch (arg) {
      case '--dry-run':
        opts.dryRun = true;
        break;
      case '--skip-service-mesh':
        opts.skipServiceMesh = true;
        break;
      case '--image-tag':
        if (next) {
          opts.imageTag = next;
          i += 1;
        }
        break;
      case '--phases':
        if (next) {
          const parsed = next
            .split(',')
            .map((v) => Number.parseInt(v.trim(), 10))
            .filter((n) => Number.isFinite(n) && n > 0 && n <= 100);
          if (parsed.length > 0) {
            opts.phases = parsed;
          }
          i += 1;
        }
        break;
      case '--base-url':
        if (next) {
          opts.baseUrl = next.replace(/\/+$/, '');
          i += 1;
        }
        break;
      case '--metrics-url':
        if (next) {
          opts.metricsUrl = next;
          i += 1;
        }
        break;
      case '--max-5xx-rate':
        if (next) {
          opts.max5xxRate = Number.parseFloat(next);
          i += 1;
        }
        break;
      case '--max-p95-ms':
        if (next) {
          opts.maxP95Ms = Number.parseFloat(next);
          i += 1;
        }
        break;
      case '--max-dlq-depth':
        if (next) {
          opts.maxDlqDepth = Number.parseFloat(next);
          i += 1;
        }
        break;
      case '--soak-ms':
        if (next) {
          opts.soakMs = Number.parseInt(next, 10);
          i += 1;
        }
        break;
      case '--output':
        if (next) {
          opts.outputPath = next;
          i += 1;
        }
        break;
      case '--simulate-breach':
        if (next) {
          opts.simulateBreach = next;
          i += 1;
        }
        break;
      default:
        break;
    }
  }

  if (!opts.metricsUrl) {
    opts.metricsUrl = `${opts.baseUrl}/metrics`;
  }
  return opts;
}

/**
 * Parses Prometheus text exposition lines (v0.0.4) into structured samples.
 */
export function parsePrometheusMetrics(rawText) {
  let totalHttpRequests = 0;
  let serverError5xxRequests = 0;
  /** @type {Map<number, number>} */
  const durationBuckets = new Map();
  /** @type {Record<string, number>} */
  const dlqByQueue = {};
  let totalDlqDepth = 0;
  let oversellBlockedTotal = 0;
  let tryonCacheHits = 0;
  let tryonCacheMisses = 0;
  /** @type {Record<string, number>} */
  const ollamaTokensPerSec = {};

  const lineRegex =
    /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{([^}]*)\})?\s+([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?|[+-]?Inf|NaN)/;

  for (const rawLine of rawText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    const match = lineRegex.exec(line);
    if (!match) {
      continue;
    }
    const metricName = match[1];
    const labelsRaw = match[2] || '';
    const valueStr = match[3];
    const value =
      valueStr === '+Inf'
        ? Number.POSITIVE_INFINITY
        : valueStr === '-Inf'
          ? Number.NEGATIVE_INFINITY
          : Number.parseFloat(valueStr);

    if (Number.isNaN(value)) {
      continue;
    }

    const labels = parsePrometheusLabels(labelsRaw);

    if (metricName === 'atelier_http_requests_total') {
      totalHttpRequests += value;
      const status = String(labels.status_code || '');
      if (/^5\d\d$/.test(status)) {
        serverError5xxRequests += value;
      }
    } else if (metricName === 'atelier_http_request_duration_seconds_bucket') {
      const leRaw = labels.le;
      if (leRaw !== undefined) {
        const leBound = leRaw === '+Inf' ? Number.POSITIVE_INFINITY : Number.parseFloat(leRaw);
        if (!Number.isNaN(leBound)) {
          durationBuckets.set(leBound, (durationBuckets.get(leBound) || 0) + value);
        }
      }
    } else if (
      metricName === 'atelier_rabbitmq_dlq_depth' ||
      (metricName === 'rabbitmq_queue_messages' && /\.dlq$/i.test(labels.queue || ''))
    ) {
      const queueName = labels.queue || 'unknown.dlq';
      dlqByQueue[queueName] = Math.max(dlqByQueue[queueName] || 0, value);
    } else if (metricName === 'atelier_inventory_oversell_blocked_total') {
      oversellBlockedTotal += value;
    } else if (metricName === 'atelier_tryon_cache_events_total') {
      if (labels.outcome === 'hit') {
        tryonCacheHits += value;
      } else if (labels.outcome === 'miss') {
        tryonCacheMisses += value;
      }
    } else if (metricName === 'atelier_ollama_tokens_per_second') {
      const model = labels.model || 'default';
      ollamaTokensPerSec[model] = value;
    }
  }

  for (const depth of Object.values(dlqByQueue)) {
    totalDlqDepth += depth;
  }

  const error5xxRate =
    totalHttpRequests > 0 ? serverError5xxRequests / totalHttpRequests : 0;
  const p50Ms = estimateHistogramQuantileMs(durationBuckets, 0.5);
  const p95Ms = estimateHistogramQuantileMs(durationBuckets, 0.95);
  const p99Ms = estimateHistogramQuantileMs(durationBuckets, 0.99);
  const tryonTotal = tryonCacheHits + tryonCacheMisses;
  const tryonCacheHitRatio = tryonTotal > 0 ? tryonCacheHits / tryonTotal : null;

  return {
    totalHttpRequests,
    serverError5xxRequests,
    error5xxRate,
    p50Ms,
    p95Ms,
    p99Ms,
    totalDlqDepth,
    dlqByQueue,
    oversellBlockedTotal,
    tryonCacheHits,
    tryonCacheMisses,
    tryonCacheHitRatio,
    ollamaTokensPerSec,
  };
}

function parsePrometheusLabels(raw) {
  /** @type {Record<string, string>} */
  const labels = {};
  if (!raw) {
    return labels;
  }
  const labelRegex = /([a-zA-Z_][a-zA-Z0-9_]*)="((?:\\.|[^"\\])*)"/g;
  let match = labelRegex.exec(raw);
  while (match !== null) {
    labels[match[1]] = match[2].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    match = labelRegex.exec(raw);
  }
  return labels;
}

/**
 * Computes Prometheus-compatible linear-interpolated histogram quantile in milliseconds.
 */
export function estimateHistogramQuantileMs(bucketsMap, quantile) {
  if (!bucketsMap || bucketsMap.size === 0) {
    return 0;
  }
  const sorted = [...bucketsMap.entries()].sort((a, b) => a[0] - b[0]);
  const totalCount = sorted[sorted.length - 1]?.[1] || 0;
  if (totalCount <= 0) {
    return 0;
  }

  const rank = quantile * totalCount;
  let prevBound = 0;
  let prevCount = 0;

  for (const [bound, cumulativeCount] of sorted) {
    if (cumulativeCount >= rank) {
      if (!Number.isFinite(bound)) {
        return Math.round(prevBound * 1000 * 100) / 100;
      }
      const bucketCount = cumulativeCount - prevCount;
      if (bucketCount <= 0) {
        return Math.round(bound * 1000 * 100) / 100;
      }
      const fraction = Math.max(0, Math.min(1, (rank - prevCount) / bucketCount));
      const seconds = prevBound + (bound - prevBound) * fraction;
      return Math.round(seconds * 1000 * 100) / 100;
    }
    if (Number.isFinite(bound)) {
      prevBound = bound;
    }
    prevCount = cumulativeCount;
  }

  return Math.round(prevBound * 1000 * 100) / 100;
}

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json, text/plain;q=0.9, */*;q=0.1',
        Connection: 'close',
      },
      signal: controller.signal,
    });
    const text = await response.text();
    const latencyMs = Math.max(0, Date.now() - startedAt);
    return { ok: response.ok, status: response.status, text, latencyMs, error: null };
  } catch (error) {
    const latencyMs = Math.max(0, Date.now() - startedAt);
    return {
      ok: false,
      status: 0,
      text: '',
      latencyMs,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function checkClusterHealth(opts) {
  const parsedBase = new URL(opts.baseUrl);
  const isLocalTarget =
    parsedBase.hostname === '127.0.0.1' || parsedBase.hostname === 'localhost';

  const targets =
    isLocalTarget && !opts.skipServiceMesh
      ? DEFAULT_SERVICE_ENDPOINTS.map((svc) => ({
          name: svc.name,
          url: `http://${parsedBase.hostname}:${svc.port}/health`,
          required: svc.port === 4000,
        }))
      : [{ name: 'canary-gateway', url: `${opts.baseUrl}/health`, required: true }];

  const results = await Promise.all(
    targets.map(async (target) => {
      const res = await fetchWithTimeout(target.url, opts.timeoutMs);
      let payloadStatus = null;
      try {
        const parsed = JSON.parse(res.text);
        payloadStatus = parsed?.status || null;
      } catch {
        payloadStatus = null;
      }
      const healthy =
        res.ok &&
        (payloadStatus === null ||
          ['UP', 'OK', 'ok', 'healthy', 'HEALTHY'].includes(String(payloadStatus)));
      return {
        name: target.name,
        url: target.url,
        required: target.required,
        healthy,
        httpStatus: res.status,
        payloadStatus,
        latencyMs: res.latencyMs,
        error: res.error,
      };
    }),
  );

  const healthyCount = results.filter((item) => item.healthy).length;
  const unhealthyServices = results.filter((item) => !item.healthy);
  const allHealthy = unhealthyServices.length === 0;

  return {
    allHealthy,
    healthyCount,
    totalCount: results.length,
    unhealthyServices,
    services: results,
  };
}

function evaluateSlaGates(healthResult, metrics, opts) {
  /** @type {string[]} */
  const breaches = [];

  if (opts.simulateBreach === 'health' || !healthResult.allHealthy) {
    const failedNames = healthResult.unhealthyServices.map((s) => s.name).join(', ') || 'simulated';
    breaches.push(`HEALTH_CHECK_FAILED (${failedNames})`);
  }

  const effective5xx = opts.simulateBreach === '5xx' ? opts.max5xxRate + 0.05 : metrics.error5xxRate;
  if (effective5xx > opts.max5xxRate) {
    breaches.push(
      `HTTP_5XX_RATE_EXCEEDED (${(effective5xx * 100).toFixed(2)}% > ${(opts.max5xxRate * 100).toFixed(2)}%)`,
    );
  }

  const effectiveP95 = opts.simulateBreach === 'p95' ? opts.maxP95Ms + 150 : metrics.p95Ms;
  if (effectiveP95 > opts.maxP95Ms) {
    breaches.push(`HTTP_P95_LATENCY_EXCEEDED (${effectiveP95}ms > ${opts.maxP95Ms}ms)`);
  }

  const effectiveDlq = opts.simulateBreach === 'dlq' ? opts.maxDlqDepth + 3 : metrics.totalDlqDepth;
  if (effectiveDlq > opts.maxDlqDepth) {
    breaches.push(`RABBITMQ_DLQ_DEPTH_EXCEEDED (${effectiveDlq} > ${opts.maxDlqDepth})`);
  }

  return {
    passed: breaches.length === 0,
    breaches,
    observed: {
      error5xxRate: effective5xx,
      p95Ms: effectiveP95,
      dlqDepth: effectiveDlq,
    },
  };
}

function runShellHook(templateCmd, context, dryRun) {
  if (!templateCmd || !templateCmd.trim()) {
    return { executed: false, mode: dryRun ? 'dry-run' : 'noop', command: null };
  }
  const rendered = templateCmd
    .replaceAll('{{PHASE}}', String(context.phase ?? ''))
    .replaceAll('{{IMAGE_TAG}}', String(context.imageTag ?? ''))
    .replaceAll('{{REASON}}', String(context.reason ?? ''));

  if (dryRun) {
    return { executed: false, mode: 'dry-run', command: rendered };
  }

  const output = execSync(rendered, {
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      ...process.env,
      CANARY_PHASE: String(context.phase ?? ''),
      CANARY_IMAGE_TAG: String(context.imageTag ?? ''),
      CANARY_ROLLBACK_REASON: String(context.reason ?? ''),
    },
  });
  return { executed: true, mode: 'live', command: rendered, output: output.trim() };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runCanaryDeployment(argv = process.argv.slice(2)) {
  const opts = parseCliArgs(argv);
  const startedAt = new Date().toISOString();
  const nginxSwitchCmd = process.env.NGINX_SWITCH_CMD || '';
  const rollbackCmd = process.env.ROLLBACK_CMD || '';

  const report = {
    startedAt,
    finishedAt: null,
    imageTag: opts.imageTag,
    mode: opts.dryRun ? 'dry-run' : 'live',
    baseUrl: opts.baseUrl,
    metricsUrl: opts.metricsUrl,
    slaThresholds: {
      max5xxRate: opts.max5xxRate,
      maxP95Ms: opts.maxP95Ms,
      maxDlqDepth: opts.maxDlqDepth,
    },
    phases: [],
    rollback: null,
    status: 'PENDING',
  };

  for (const phase of opts.phases) {
    const switchResult = runShellHook(
      nginxSwitchCmd,
      { phase, imageTag: opts.imageTag },
      opts.dryRun,
    );

    if (!opts.dryRun && opts.soakMs > 0) {
      await sleep(opts.soakMs);
    }

    const healthResult = await checkClusterHealth(opts);
    const metricsRes = await fetchWithTimeout(opts.metricsUrl, opts.timeoutMs);
    const metricsAvailable = metricsRes.ok && metricsRes.text.length > 0;
    const parsedMetrics = metricsAvailable
      ? parsePrometheusMetrics(metricsRes.text)
      : {
          totalHttpRequests: 0,
          serverError5xxRequests: 0,
          error5xxRate: 0,
          p50Ms: 0,
          p95Ms: 0,
          p99Ms: 0,
          totalDlqDepth: 0,
          dlqByQueue: {},
          oversellBlockedTotal: 0,
          tryonCacheHits: 0,
          tryonCacheMisses: 0,
          tryonCacheHitRatio: null,
          ollamaTokensPerSec: {},
        };

    const gate = evaluateSlaGates(healthResult, parsedMetrics, opts);
    if (!metricsAvailable) {
      gate.passed = false;
      gate.breaches.push(
        `METRICS_ENDPOINT_UNAVAILABLE (${opts.metricsUrl} -> HTTP ${metricsRes.status}${metricsRes.error ? ` ${metricsRes.error}` : ''})`,
      );
    }

    report.phases.push({
      phasePercent: phase,
      timestamp: new Date().toISOString(),
      trafficShift: switchResult,
      health: {
        allHealthy: healthResult.allHealthy,
        healthyCount: healthResult.healthyCount,
        totalCount: healthResult.totalCount,
        unhealthyServices: healthResult.unhealthyServices.map((s) => ({
          name: s.name,
          httpStatus: s.httpStatus,
          error: s.error,
        })),
      },
      metricsAvailable,
      metrics: parsedMetrics,
      slaGate: gate,
    });

    if (!gate.passed) {
      const reason = `Phase ${phase}% SLA breach: ${gate.breaches.join('; ')}`;
      const rollbackResult = runShellHook(
        rollbackCmd || 'echo "ROLLBACK_TRIGGERED: shift NGINX upstream back to blue slot"',
        { phase, imageTag: opts.imageTag, reason },
        opts.dryRun,
      );
      report.rollback = {
        triggered: true,
        triggeredAtPhase: phase,
        reason,
        hook: rollbackResult,
      };
      report.status = 'ROLLED_BACK';
      report.finishedAt = new Date().toISOString();
      writeReportIfConfigured(opts.outputPath, report);
      return { exitCode: 1, report };
    }
  }

  report.status = opts.dryRun ? 'DRY_RUN_PASSED' : 'PROMOTED';
  report.finishedAt = new Date().toISOString();
  writeReportIfConfigured(opts.outputPath, report);
  return { exitCode: 0, report };
}

function writeReportIfConfigured(outputPath, report) {
  if (!outputPath) {
    return;
  }
  const absPath = path.resolve(process.cwd(), outputPath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

const isMainModule =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMainModule) {
  runCanaryDeployment()
    .then(({ exitCode, report }) => {
      console.log(JSON.stringify(report, null, 2));
      process.exitCode = exitCode;
    })
    .catch((error) => {
      console.error(
        JSON.stringify(
          {
            status: 'ERROR',
            error: error instanceof Error ? error.message : String(error),
          },
          null,
          2,
        ),
      );
      process.exitCode = 1;
    });
}
