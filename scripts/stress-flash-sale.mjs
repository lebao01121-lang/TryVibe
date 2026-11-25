#!/usr/bin/env node
/**
 * 100-Request Flash Sale Contention Stress Test (`pnpm test:flash-sale`)
 * fashion-atelier-ai-platform (v3.0)
 *
 * Works BOTH against already-running services (e.g., invoked inside `verify-all.mjs`)
 * AND standalone (auto-boots local infra + inventory + catalog services and tears down cleanly in finally).
 *
 * Verifies:
 *   - Target Flash Sale SKU initialized to availableQty = 15, reservedQty = 0
 *   - 100 simultaneous Promise.all reservation requests ->
 *       EXACTLY 15 succeed (HTTP 201)
 *       EXACTLY 85 rejected (HTTP 409 Conflict INSUFFICIENT_STOCK)
 *       0% oversell, 0 HTTP 5xx, 0 PostgreSQL deadlocks
 *       Final stock strictly availableQty === 0, reservedQty === 15
 *   - Reports exact min / p50 / p95 / p99 / max latencies in ms
 */

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isPortOpen, startLocalInfraIfNeeded } from './local-infra-dev.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const IS_WIN = process.platform === 'win32';

const INVENTORY_BASE = 'http://127.0.0.1:4004';
const CATALOG_BASE = 'http://127.0.0.1:4002';
const FLAGSHIP_PRODUCT_ID = 'abc8d089-785d-4562-89dc-e788ab683f30';

function parseArgInt(flagName, fallback) {
  const found = process.argv.find((a) => a.startsWith(`${flagName}=`));
  if (!found) return fallback;
  const parsed = Number.parseInt(found.slice(flagName.length + 1), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const TARGET_STOCK = parseArgInt('--stock', 15);
const CONCURRENCY = parseArgInt('--concurrency', 100);
const JSON_ONLY = process.argv.includes('--json');

function loadDotEnv(filePath) {
  const vars = {};
  if (!fs.existsSync(filePath)) return vars;
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const k = trimmed.slice(0, eq).trim();
    let v = trimmed.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    vars[k] = v;
  }
  return vars;
}

function killTree(child) {
  if (!child || !child.pid) return;
  try {
    if (IS_WIN) {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } else {
      child.kill('SIGTERM');
    }
  } catch {
    // ignore
  }
}

function httpJson(urlStr, options = {}) {
  const { method = 'GET', headers = {}, body, timeoutMs = 20_000 } = options;
  const t0 = performance.now();
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const reqHeaders = { ...headers };
    let payload = null;
    if (body !== undefined) {
      payload = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
      if (!reqHeaders['Content-Type']) reqHeaders['Content-Type'] = 'application/json';
      reqHeaders['Content-Length'] = String(payload.length);
    }
    const req = http.request(
      { hostname: u.hostname, port: u.port || 80, path: `${u.pathname}${u.search}`, method, headers: reqHeaders, timeout: timeoutMs },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            // non-JSON
          }
          resolve({ status: res.statusCode ?? 0, json, text, elapsedMs: performance.now() - t0 });
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error(`Timeout: ${method} ${urlStr}`)));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function waitHealthy(urlStr, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await httpJson(urlStr, { timeoutMs: 2000 });
      if (r.status >= 200 && r.status < 300) return;
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Timed out waiting for ${urlStr}`);
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Number(sorted[idx].toFixed(2));
}

async function pickFlashSaleSku(catalogAvailable) {
  if (catalogAvailable) {
    const res = await httpJson(`${CATALOG_BASE}/v1/catalog/products?limit=25`);
    const data = res.json?.data ?? res.json;
    const items = Array.isArray(data) ? data : data?.items || data?.products || [];
    for (const prod of items) {
      if (prod.id === FLAGSHIP_PRODUCT_ID) continue;
      const slugRes = await httpJson(`${CATALOG_BASE}/v1/catalog/products/${encodeURIComponent(prod.slug)}`);
      const detail = slugRes.json?.data ?? slugRes.json;
      const variants = detail?.variants || [];
      for (const v of variants) {
        const skus = v?.skus || [];
        for (const s of skus) {
          if (s?.id && s?.skuCode && !String(s.skuCode).endsWith('-M')) {
            return { skuId: s.id, skuCode: s.skuCode, productId: prod.id };
          }
        }
      }
    }
  }
  // Fallback deterministic SKU from inventory admin stock-levels
  const listRes = await httpJson(`${INVENTORY_BASE}/v1/inventory/admin/stock-levels?limit=30`);
  const listData = listRes.json?.data ?? listRes.json;
  const rows = Array.isArray(listData) ? listData : listData?.items || [];
  const picked = rows.find((r) => r.skuId && r.skuCode && r.skuCode !== 'AT-AOBLLI-C1-M' && r.skuCode !== 'AT-AOPODE-C1-M') || rows[0];
  assert.ok(picked?.skuId, `Unable to pick a test SKU for flash sale stress test: ${listRes.text}`);
  return { skuId: picked.skuId, skuCode: picked.skuCode || picked.skuId, productId: picked.productId || '' };
}

export async function runFlashSaleStress({ stock = TARGET_STOCK, concurrency = CONCURRENCY, quiet = JSON_ONLY } = {}) {
  const envVars = { ...loadDotEnv(path.join(ROOT_DIR, '.env')), ...process.env };
  const internalSecret = envVars.INTERNAL_SERVICE_SECRET || 'Atelier_Internal_Svc_2026!';
  const spawnedChildren = [];
  let infraHandle = null;

  try {
    const invUp = await isPortOpen('127.0.0.1', 4004);
    const catUp = await isPortOpen('127.0.0.1', 4002);

    if (!invUp) {
      infraHandle = await startLocalInfraIfNeeded(envVars);
      const invEntry = path.join(ROOT_DIR, 'services', 'inventory', 'dist', 'main.js');
      assert.ok(fs.existsSync(invEntry), 'services/inventory/dist/main.js missing — run `pnpm build` first');
      const child = spawn(process.execPath, [invEntry], {
        cwd: ROOT_DIR,
        env: { ...envVars, NODE_ENV: 'development', INVENTORY_SERVICE_PORT: '4004', INTERNAL_SERVICE_SECRET: internalSecret },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      spawnedChildren.push(child);
      await waitHealthy(`${INVENTORY_BASE}/ready`, 35_000);
    }

    const target = await pickFlashSaleSku(catUp);

    // Capture original stock so we can restore cleanly after test
    const beforeAvailRes = await httpJson(`${INVENTORY_BASE}/v1/inventory/availability/batch`, {
      method: 'POST',
      body: { skuIds: [target.skuId] },
    });
    const beforeData = beforeAvailRes.json?.data ?? beforeAvailRes.json;
    const beforeEntry =
      beforeData?.items?.[target.skuId] ||
      beforeData?.list?.find((x) => x.skuId === target.skuId) ||
      null;
    const originalAvailable = Number(beforeEntry?.availableQty ?? 20);

    // Initialize exact Flash Sale stock: availableQty = stock (15), reservedQty = 0
    const setRes = await httpJson(`${INVENTORY_BASE}/v1/inventory/internal/test-set-stock`, {
      method: 'POST',
      headers: { 'x-internal-secret': internalSecret },
      body: { skuId: target.skuId, availableQty: stock, reservedQty: 0 },
    });
    assert.ok(setRes.status >= 200 && setRes.status < 300, `Failed to set flash-sale stock (${setRes.status}): ${setRes.text}`);

    const runId = crypto.randomUUID().slice(0, 8);
    const tWallStart = performance.now();

    // Fire 100 simultaneous reservation requests via Promise.all
    const requests = Array.from({ length: concurrency }, (_, idx) => {
      const orderRef = `FS-${runId}-${String(idx + 1).padStart(3, '0')}`;
      return httpJson(`${INVENTORY_BASE}/v1/inventory/reservations`, {
        method: 'POST',
        headers: { 'x-load-test-bypass': '1' },
        body: {
          referenceId: orderRef,
          reservationType: 'CHECKOUT',
          ttlSeconds: 900,
          idempotencyKey: `idem-${orderRef}`,
          items: [{ skuId: target.skuId, qty: 1 }],
        },
      }).then((res) => ({ idx, orderRef, ...res }));
    });

    const responses = await Promise.all(requests);
    const wallDurationMs = Number((performance.now() - tWallStart).toFixed(1));

    const succeeded = responses.filter((r) => r.status === 201 || r.status === 200);
    const conflicts = responses.filter((r) => r.status === 409);
    const serverErrors = responses.filter((r) => r.status >= 500 || r.status === 0);
    const deadlocks = responses.filter((r) => /deadlock|40P01/i.test(r.text || ''));
    const otherErrors = responses.filter((r) => r.status !== 201 && r.status !== 200 && r.status !== 409 && r.status < 500 && r.status !== 0);

    const latencies = responses.map((r) => r.elapsedMs).sort((a, b) => a - b);
    const afterAvailRes = await httpJson(`${INVENTORY_BASE}/v1/inventory/availability/batch`, {
      method: 'POST',
      body: { skuIds: [target.skuId] },
    });
    const afterData = afterAvailRes.json?.data ?? afterAvailRes.json;
    const afterEntry =
      afterData?.items?.[target.skuId] ||
      afterData?.list?.find((x) => x.skuId === target.skuId) ||
      null;

    const finalAvailableQty = Number(afterEntry?.availableQty ?? -1);
    const finalReservedQty = Number(afterEntry?.reservedQty ?? -1);

    // Release our test reservations and restore original stock cleanly
    for (const s of succeeded) {
      await httpJson(`${INVENTORY_BASE}/v1/inventory/reservations/${encodeURIComponent(s.orderRef)}/release`, {
        method: 'POST',
        body: { reason: 'CANCEL_RELEASE' },
      }).catch(() => {});
    }
    await httpJson(`${INVENTORY_BASE}/v1/inventory/internal/test-set-stock`, {
      method: 'POST',
      headers: { 'x-internal-secret': internalSecret },
      body: { skuId: target.skuId, availableQty: Math.max(originalAvailable, 15), reservedQty: 0 },
    }).catch(() => {});

    const metrics = {
      skuId: target.skuId,
      skuCode: target.skuCode,
      warehouseCode: 'CENTRAL_WH',
      initialStock: stock,
      concurrency,
      succeeded201: succeeded.length,
      conflicts409: conflicts.length,
      serverErrors5xx: serverErrors.length,
      otherStatusCount: otherErrors.length,
      deadlocks: deadlocks.length,
      oversellCount: Math.max(0, succeeded.length - stock),
      oversellPct: Number(((Math.max(0, succeeded.length - stock) / stock) * 100).toFixed(2)),
      finalAvailableQty,
      finalReservedQty,
      wallDurationMs,
      latencyMs: {
        min: Number(latencies[0]?.toFixed(2) ?? 0),
        p50: percentile(latencies, 50),
        p95: percentile(latencies, 95),
        p99: percentile(latencies, 99),
        max: Number(latencies[latencies.length - 1]?.toFixed(2) ?? 0),
      },
    };

    assert.equal(metrics.succeeded201, stock, `Expected exactly ${stock} HTTP 201 successes, got ${metrics.succeeded201} (other=${otherErrors.map((e) => `${e.status}:${e.text.slice(0, 60)}`).slice(0, 3).join('|')})`);
    assert.equal(metrics.conflicts409, concurrency - stock, `Expected exactly ${concurrency - stock} HTTP 409 conflicts, got ${metrics.conflicts409}`);
    assert.equal(metrics.serverErrors5xx, 0, `Expected 0 HTTP 5xx errors, got ${metrics.serverErrors5xx}`);
    assert.equal(metrics.deadlocks, 0, `Expected 0 deadlocks, got ${metrics.deadlocks}`);
    assert.equal(metrics.oversellCount, 0, `Oversell detected: ${metrics.oversellCount}`);
    assert.equal(metrics.finalAvailableQty, 0, `Expected finalAvailableQty=0, got ${metrics.finalAvailableQty}`);
    assert.equal(metrics.finalReservedQty, stock, `Expected finalReservedQty=${stock}, got ${metrics.finalReservedQty}`);

    if (!quiet) {
      console.log('========================================================================');
      console.log(' fashion-atelier-ai-platform (v3.0) — 100-Request Flash Sale Stress Test');
      console.log('------------------------------------------------------------------------');
      console.log(`  SKU              : ${metrics.skuCode} (${metrics.skuId})`);
      console.log(`  Contention       : ${concurrency} simultaneous requests against stock = ${stock}`);
      console.log(`  Results          : 201=${metrics.succeeded201} | 409=${metrics.conflicts409} | 5xx=${metrics.serverErrors5xx} | Deadlocks=${metrics.deadlocks}`);
      console.log(`  Integrity        : oversell=0% | final availableQty=${metrics.finalAvailableQty}, reservedQty=${metrics.finalReservedQty}`);
      console.log(
        `  Latency (ms)     : min=${metrics.latencyMs.min} | p50=${metrics.latencyMs.p50} | p95=${metrics.latencyMs.p95} | p99=${metrics.latencyMs.p99} | max=${metrics.latencyMs.max} (wall=${metrics.wallDurationMs}ms)`,
      );
      console.log('========================================================================');
      console.log(`FLASH_SALE_METRICS_JSON=${JSON.stringify(metrics)}`);
    } else {
      console.log(JSON.stringify(metrics));
    }
    return metrics;
  } finally {
    for (const c of spawnedChildren) killTree(c);
    if (infraHandle) await infraHandle.stop();
  }
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename);
if (isDirect) {
  runFlashSaleStress().catch((err) => {
    console.error('[FAIL] stress-flash-sale:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
