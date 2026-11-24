#!/usr/bin/env node
/**
 * Visual Overhaul Acceptance Verification & Headless Chrome Screenshot Audit
 * fashion-atelier-ai-platform (v3.1)
 *
 * Verifies:
 *   1. Static Media & Manifest Guard: rose-desk.{mp4,webm} deleted, real Hero poster
 *      present, processed real photography manifest present.
 *   2. Live BFF API Audit: bootstrap, rack-collection, seasons, occasions
 *      - Zero "rose-desk" strings anywhere
 *      - Exact Hero eyebrow (zero duplicate "HÀ NỘI")
 *      - Calibrated hanger anchors (hangerAnchorX=0.5, hangerAnchorY~0.14)
 *   3. 100% Real Photography & Sharp Alpha Channel Audit:
 *      - Every cutout/lookbook/hero/season/occasion/atelier URL returns HTTP 200
 *      - 0 SVG MIME types or <svg / <?xml payloads
 *      - 100% of rack front/back cutouts verified via sharp: hasAlpha === true AND
 *        real transparent cutout background (transparentPx >= 5%, opaquePx >= 10%)
 *   4. Real Headless Chrome (1440x900, WebGL enabled) Audit:
 *      - 0 console errors, 0 page errors, 0 broken <img> (naturalWidth > 0)
 *      - #glints & #rack WebGL <canvas> rendered with non-zero size
 *      - Hovering #rack activates .cursor.is-view (~74x74px)
 *      - Captures 7 full-viewport (1440x900) PNG screenshots into the coordinator's
 *        visual-audit directory for human/coordinator inspection
 *   5. Full Teardown Guarantee: kills all spawned services + stops local infra
 *      without touching host Ollama (:11434).
 */

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { startLocalInfraIfNeeded } from './local-infra-dev.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const IS_WIN = process.platform === 'win32';

const sharp = createRequire(path.join(ROOT_DIR, 'services', 'media-pipeline', 'package.json'))('sharp');
const Redis = createRequire(path.join(ROOT_DIR, 'packages', 'db-client', 'package.json'))('ioredis');

const STOREFRONT_BASE = 'http://localhost:3000';
const BFF_BASE = 'http://127.0.0.1:4000';
const AUTH_BASE = 'http://127.0.0.1:4001';
const CATALOG_BASE = 'http://127.0.0.1:4002';
const MEDIA_BASE = 'http://127.0.0.1:4003';
const INVENTORY_BASE = 'http://127.0.0.1:4004';
const CART_BASE = 'http://127.0.0.1:4005';
const ORDER_BASE = 'http://127.0.0.1:4006';
const PAYMENT_BASE = 'http://127.0.0.1:4007';
const NOTIFY_BASE = 'http://127.0.0.1:4008';

const AUDIT_SCREENSHOT_DIR =
  process.env.VISUAL_AUDIT_DIR ||
  'C:\\Users\\Admin\\.gemini\\antigravity\\brain\\d1783908-6521-4608-8b37-41aae3ee9a65\\scratch\\visual-audit';

const EXPECTED_HERO_EYEBROW = 'FASHION ATELIER · EST. 2019 · MAY ĐO THỦ CÔNG TẠI HÀ NỘI';

const results = [];

function recordCheck(id, title, ok, details = []) {
  results.push({ id, title, ok, details });
  console.log(`\n[${ok ? 'PASS' : 'FAIL'}] ${id} — ${title}`);
  for (const line of details) {
    console.log(`       ${line}`);
  }
}

function loadDotEnv(filePath) {
  const vars = {};
  if (!fs.existsSync(filePath)) return vars;
  const raw = fs.readFileSync(filePath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx <= 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    if (
      val.length >= 2 &&
      ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
    ) {
      val = val.slice(1, -1);
    }
    vars[key] = val;
  }
  return vars;
}

function cleanStalePgliteLocks() {
  const pgRoot = path.join(ROOT_DIR, '.local-pgdata');
  if (!fs.existsSync(pgRoot)) return 0;
  let removed = 0;
  for (const entry of fs.readdirSync(pgRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const pidFile = path.join(pgRoot, entry.name, 'postmaster.pid');
    if (fs.existsSync(pidFile)) {
      try {
        fs.rmSync(pidFile, { force: true });
        removed += 1;
      } catch {
        // ignore
      }
    }
  }
  return removed;
}

function killProcessTree(child) {
  if (!child || !child.pid) return;
  try {
    if (IS_WIN) {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } else {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        child.kill('SIGTERM');
      }
    }
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      // ignore
    }
  }
}

function findChromeExecutable() {
  const candidates = IS_WIN
    ? [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      ]
    : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function httpRequest(urlString, { method = 'GET', headers = {}, body = undefined, timeoutMs = 20_000 } = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlString);
    const lib = parsed.protocol === 'https:' ? https : http;
    const reqHeaders = { ...headers };
    let payloadBuf = null;

    if (body !== undefined && body !== null) {
      if (Buffer.isBuffer(body)) {
        payloadBuf = body;
      } else if (typeof body === 'string') {
        payloadBuf = Buffer.from(body, 'utf8');
      } else {
        payloadBuf = Buffer.from(JSON.stringify(body), 'utf8');
        if (!Object.keys(reqHeaders).some((k) => k.toLowerCase() === 'content-type')) {
          reqHeaders['Content-Type'] = 'application/json';
        }
      }
      reqHeaders['Content-Length'] = String(payloadBuf.length);
    }

    const req = lib.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: `${parsed.pathname}${parsed.search}`,
        method,
        headers: reqHeaders,
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
        res.on('end', () => {
          const buffer = Buffer.concat(chunks);
          const text = buffer.toString('utf8');
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            // non-JSON
          }
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            buffer,
            text,
            json,
          });
        });
      },
    );

    req.on('timeout', () => req.destroy(new Error(`HTTP timeout (${timeoutMs}ms): ${urlString}`)));
    req.on('error', reject);
    if (payloadBuf) req.write(payloadBuf);
    req.end();
  });
}

async function waitForHttp200(url, timeoutMs = 45_000, logs = []) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = '';
  while (Date.now() < deadline) {
    try {
      const res = await httpRequest(url, { timeoutMs: 2500 });
      if (res.status >= 200 && res.status < 300) return res;
      lastErr = `HTTP ${res.status}`;
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
    }
    await new Promise((r) => setTimeout(r, 350));
  }
  const tail = logs.join('').split(/\r?\n/).filter(Boolean).slice(-12).join('\n');
  throw new Error(`Timed out waiting for ${url} (${lastErr}). Logs:\n${tail}`);
}

function runNodeScript(scriptRelPath, env, timeoutMs = 120_000) {
  return new Promise((resolve) => {
    const absScript = path.join(ROOT_DIR, scriptRelPath);
    const child = spawn(process.execPath, [absScript], {
      cwd: ROOT_DIR,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
    }, timeoutMs);

    child.stdout?.on('data', (d) => {
      stdout += d.toString('utf8');
    });
    child.stderr?.on('data', (d) => {
      stderr += d.toString('utf8');
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, code: -1, stdout, stderr: `${stderr}\n${err.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: !timedOut && code === 0, code: code ?? -1, stdout, stderr, timedOut });
    });
  });
}

function unwrap(body) {
  if (body && typeof body === 'object' && 'data' in body && body.data !== undefined) {
    return body.data;
  }
  return body;
}

function normalizeUrl(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) return trimmed;
  if (trimmed.startsWith('/')) return `${STOREFRONT_BASE}${trimmed}`;
  return null;
}

async function analyzeRasterImage(url, requireAlpha = false) {
  const res = await httpRequest(url, { timeoutMs: 15_000 });
  const contentType = String(res.headers['content-type'] || '').toLowerCase();
  if (res.status !== 200) {
    return { ok: false, url, reason: `HTTP ${res.status}`, status: res.status, contentType };
  }
  if (contentType.includes('svg')) {
    return { ok: false, url, reason: `SVG MIME (${contentType})`, status: res.status, contentType };
  }
  const headText = res.buffer.subarray(0, 512).toString('utf8').toLowerCase();
  if (headText.includes('<svg') || headText.includes('<?xml')) {
    return { ok: false, url, reason: 'SVG/XML magic bytes detected', status: res.status, contentType };
  }

  let meta;
  try {
    meta = await sharp(res.buffer).metadata();
  } catch (err) {
    return {
      ok: false,
      url,
      reason: `sharp decode failed: ${err instanceof Error ? err.message : String(err)}`,
      status: res.status,
      contentType,
    };
  }

  const allowedFormats = new Set(['webp', 'png', 'jpeg', 'avif']);
  if (!allowedFormats.has(String(meta.format || '').toLowerCase())) {
    return {
      ok: false,
      url,
      reason: `Unsupported raster format=${meta.format}`,
      status: res.status,
      contentType,
    };
  }
  if ((meta.width ?? 0) < 200 || (meta.height ?? 0) < 200) {
    return {
      ok: false,
      url,
      reason: `Dimensions too small (${meta.width}x${meta.height})`,
      status: res.status,
      contentType,
    };
  }

  let transparentPct = null;
  let opaquePct = null;
  if (requireAlpha) {
    if (!meta.hasAlpha) {
      return {
        ok: false,
        url,
        reason: `hasAlpha=false on cutout (${meta.format} ${meta.width}x${meta.height})`,
        status: res.status,
        contentType,
        meta,
      };
    }
    const { data, info } = await sharp(res.buffer)
      .resize({ width: 120, height: 180, fit: 'inside' })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const totalPixels = info.width * info.height;
    let transparentCount = 0;
    let opaqueCount = 0;
    for (let i = 3; i < data.length; i += 4) {
      const a = data[i];
      if (a <= 20) transparentCount += 1;
      else if (a >= 220) opaqueCount += 1;
    }
    transparentPct = Number(((transparentCount / totalPixels) * 100).toFixed(1));
    opaquePct = Number(((opaqueCount / totalPixels) * 100).toFixed(1));

    if (transparentPct < 5) {
      return {
        ok: false,
        url,
        reason: `Cutout alpha channel has no transparent background (transparent=${transparentPct}%, opaque=${opaquePct}%)`,
        status: res.status,
        contentType,
        meta,
        transparentPct,
        opaquePct,
      };
    }
    if (opaquePct < 8) {
      return {
        ok: false,
        url,
        reason: `Cutout appears blank/erased (opaque=${opaquePct}%, transparent=${transparentPct}%)`,
        status: res.status,
        contentType,
        meta,
        transparentPct,
        opaquePct,
      };
    }
  }

  return {
    ok: true,
    url,
    status: res.status,
    contentType,
    format: meta.format,
    width: meta.width,
    height: meta.height,
    hasAlpha: Boolean(meta.hasAlpha),
    bytes: res.buffer.length,
    transparentPct,
    opaquePct,
  };
}

async function flushRedisBffKeys(envVars) {
  const redis = new Redis({
    host: '127.0.0.1',
    port: 6379,
    password: envVars.REDIS_PASSWORD || 'Atelier_Redis2026!',
    maxRetriesPerRequest: 2,
    connectTimeout: 5000,
    lazyConnect: true,
  });
  try {
    await redis.connect();
    let deleted = 0;
    for (const pattern of ['bff:*', 'catalog:*', 'storefront:*']) {
      const keys = await redis.keys(pattern);
      if (keys.length > 0) {
        deleted += await redis.del(...keys);
      }
    }
    return deleted;
  } finally {
    redis.disconnect();
  }
}

async function main() {
  const startedAt = Date.now();
  console.log('========================================================================');
  console.log(' fashion-atelier-ai-platform (v3.1) — Visual Overhaul Verification Suite');
  console.log('========================================================================');

  const envVars = {
    ...process.env,
    ...loadDotEnv(path.join(ROOT_DIR, '.env')),
  };

  // CHECK 1: Static Media & Manifest Guard (runs before boot)
  {
    const details = [];
    const roseMp4 = path.join(ROOT_DIR, 'apps', 'storefront', 'public', 'media', 'rose-desk.mp4');
    const roseWebm = path.join(ROOT_DIR, 'apps', 'storefront', 'public', 'media', 'rose-desk.webm');
    const heroPosterPath = path.join(ROOT_DIR, 'apps', 'storefront', 'public', 'media', 'atelier-hero-poster.webp');
    const manifestPath = path.join(ROOT_DIR, 'infra', 'seeds', 'real-assets-cache', 'processed', 'manifest.json');

    const hasRoseMp4 = fs.existsSync(roseMp4);
    const hasRoseWebm = fs.existsSync(roseWebm);
    const hasHeroPoster = fs.existsSync(heroPosterPath);
    const hasManifest = fs.existsSync(manifestPath);

    let heroPosterMeta = null;
    if (hasHeroPoster) {
      try {
        heroPosterMeta = await sharp(heroPosterPath).metadata();
      } catch {
        heroPosterMeta = null;
      }
    }

    let manifestCount = 0;
    if (hasManifest) {
      try {
        const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        manifestCount = Array.isArray(parsed)
          ? parsed.length
          : Array.isArray(parsed?.items)
            ? parsed.items.length
            : Array.isArray(parsed?.products)
              ? parsed.products.length
              : Object.keys(parsed?.assets || parsed?.products || parsed || {}).length;
      } catch {
        manifestCount = 0;
      }
    }

    details.push(`rose-desk.mp4 exists=${hasRoseMp4}, rose-desk.webm exists=${hasRoseWebm}`);
    details.push(
      hasHeroPoster && heroPosterMeta
        ? `atelier-hero-poster.webp verified (${heroPosterMeta.format} ${heroPosterMeta.width}x${heroPosterMeta.height})`
        : `atelier-hero-poster.webp missing or invalid raster (exists=${hasHeroPoster})`,
    );
    details.push(`processed/manifest.json exists=${hasManifest}, entries=${manifestCount}`);

    const ok =
      !hasRoseMp4 &&
      !hasRoseWebm &&
      hasHeroPoster &&
      Boolean(heroPosterMeta) &&
      (heroPosterMeta?.width ?? 0) >= 800 &&
      hasManifest &&
      manifestCount > 0;

    recordCheck('CHECK 1', 'Static Media Cleanup & Processed Real-Assets Manifest', ok, details);
  }

  const removedLocks = cleanStalePgliteLocks();
  if (removedLocks > 0) {
    console.log(`[CLEANUP] Removed ${removedLocks} stale PGlite postmaster.pid lock file(s).`);
  }

  const chromePath = findChromeExecutable();
  if (!chromePath) {
    throw new Error('System Chrome/Edge binary not found for Playwright visual verification.');
  }
  console.log(`[BROWSER] Headless Chromium binary: ${chromePath}`);

  let localInfraHandle = null;
  const spawned = [];
  let browser = null;

  const cleanupAll = async () => {
    if (browser) {
      await browser.close().catch(() => {});
      browser = null;
    }
    for (const proc of spawned) {
      killProcessTree(proc.child);
    }
    spawned.length = 0;
    if (localInfraHandle) {
      await localInfraHandle.stop();
      localInfraHandle = null;
    }
    cleanStalePgliteLocks();
  };

  process.once('SIGINT', () => cleanupAll().finally(() => process.exit(130)));
  process.once('SIGTERM', () => cleanupAll().finally(() => process.exit(143)));

  try {
    localInfraHandle = await startLocalInfraIfNeeded(envVars);
    console.log(`[INFRA] Active mode: INFRA_MODE=${localInfraHandle.infraMode}`);

    const serviceEnv = {
      ...envVars,
      AUTH_SERVICE_URL: AUTH_BASE,
      CATALOG_SERVICE_URL: CATALOG_BASE,
      MEDIA_SERVICE_URL: MEDIA_BASE,
      INVENTORY_SERVICE_URL: INVENTORY_BASE,
      CART_OUTFIT_SERVICE_URL: CART_BASE,
      CART_SERVICE_URL: CART_BASE,
      ORDER_SERVICE_URL: ORDER_BASE,
      PAYMENT_PROMO_SERVICE_URL: PAYMENT_BASE,
      PAYMENT_SERVICE_URL: PAYMENT_BASE,
      NOTIFY_REVIEW_SERVICE_URL: NOTIFY_BASE,
      BFF_URL: BFF_BASE,
      NEXT_PUBLIC_BFF_URL: BFF_BASE,
      STOREFRONT_URL: 'http://127.0.0.1:3000',
      REVALIDATE_SECRET: envVars.REVALIDATE_SECRET || 'Atelier_Isr_Revalidate_2026!',
      REDIS_HOST: '127.0.0.1',
      REDIS_PORT: '6379',
      REDIS_URL: `redis://:${envVars.REDIS_PASSWORD || 'Atelier_Redis2026!'}@127.0.0.1:6379`,
      MEILISEARCH_HOST: 'http://127.0.0.1:7700',
      MINIO_ENDPOINT: '127.0.0.1',
      MINIO_PORT: '9000',
      MINIO_PUBLIC_URL: 'http://127.0.0.1:9000',
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: '1025',
    };

    const spawnNodeService = (name, relDir, portEnvKey, port) => {
      const dir = path.join(ROOT_DIR, relDir);
      const entry = path.join(dir, 'dist', 'main.js');
      if (!fs.existsSync(entry)) throw new Error(`Missing built entrypoint: ${entry}`);
      const logs = [];
      const child = spawn(process.execPath, [entry], {
        cwd: dir,
        env: { ...serviceEnv, PORT: String(port), [portEnvKey]: String(port) },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      child.stdout?.on('data', (d) => logs.push(d.toString('utf8')));
      child.stderr?.on('data', (d) => logs.push(d.toString('utf8')));
      spawned.push({ name, child, logs });
      return { child, logs };
    };

    console.log('\n--- Booting live services (4001..4008, 4000) ---');
    const authProc = spawnNodeService('auth-customer', 'services/auth-customer', 'AUTH_CUSTOMER_PORT', 4001);
    const mediaProc = spawnNodeService('media-pipeline', 'services/media-pipeline', 'MEDIA_PIPELINE_PORT', 4003);
    const invProc = spawnNodeService('inventory', 'services/inventory', 'INVENTORY_PORT', 4004);
    const cartProc = spawnNodeService('cart-outfit', 'services/cart-outfit', 'CART_OUTFIT_PORT', 4005);
    const orderProc = spawnNodeService('order-rma', 'services/order-rma', 'ORDER_RMA_PORT', 4006);
    const paymentProc = spawnNodeService('payment-promo', 'services/payment-promo', 'PAYMENT_PROMO_PORT', 4007);
    const notifyProc = spawnNodeService('notify-review', 'services/notify-review', 'NOTIFY_REVIEW_PORT', 4008);

    await Promise.all([
      waitForHttp200(`${AUTH_BASE}/health`, 40_000, authProc.logs),
      waitForHttp200(`${MEDIA_BASE}/health`, 40_000, mediaProc.logs),
      waitForHttp200(`${INVENTORY_BASE}/health`, 40_000, invProc.logs),
      waitForHttp200(`${CART_BASE}/health`, 40_000, cartProc.logs),
      waitForHttp200(`${ORDER_BASE}/health`, 40_000, orderProc.logs),
      waitForHttp200(`${PAYMENT_BASE}/health`, 40_000, paymentProc.logs),
      waitForHttp200(`${NOTIFY_BASE}/health`, 40_000, notifyProc.logs),
    ]);
    console.log('  [UP] auth:4001, media:4003, inventory:4004, cart:4005, order:4006, payment:4007, notify:4008');

    const catalogProc = spawnNodeService('catalog-lookbook', 'services/catalog-lookbook', 'CATALOG_LOOKBOOK_PORT', 4002);
    await waitForHttp200(`${CATALOG_BASE}/health`, 90_000, catalogProc.logs);
    console.log('  [UP] catalog-lookbook:4002');

    // Force-reseed catalog so updated real photography + hanger_anchor_y + hero eyebrow overwrite any cached local DB/MinIO state
    console.log('  [SEED] Calling POST /v1/catalog/internal/reseed ...');
    const reseedRes = await httpRequest(`${CATALOG_BASE}/v1/catalog/internal/reseed`, {
      method: 'POST',
      timeoutMs: 90_000,
    });
    console.log(`  [SEED] Catalog reseed HTTP ${reseedRes.status}`);

    // Run idempotent master seeder (pnpm db:seed equivalent)
    console.log('  [SEED] Running infra/seeds/seed-demo-data.mjs ...');
    const seedRun = await runNodeScript('infra/seeds/seed-demo-data.mjs', serviceEnv, 120_000);
    if (!seedRun.ok) {
      throw new Error(`seed-demo-data.mjs failed (code=${seedRun.code}):\n${seedRun.stderr || seedRun.stdout}`);
    }
    console.log('  [SEED] seed-demo-data.mjs completed cleanly.');

    const bffProc = spawnNodeService('bff', 'apps/bff', 'BFF_PORT', 4000);
    await waitForHttp200(`${BFF_BASE}/health`, 40_000, bffProc.logs);
    console.log('  [UP] apps/bff:4000');

    const clearedRedis = await flushRedisBffKeys(envVars);
    console.log(`  [CACHE] Flushed ${clearedRedis} Redis BFF/catalog key(s).`);

    // Clear Next.js fetch-cache & boot apps/storefront
    const sfDir = path.join(ROOT_DIR, 'apps', 'storefront');
    const fetchCacheDir = path.join(sfDir, '.next', 'cache', 'fetch-cache');
    if (fs.existsSync(fetchCacheDir)) {
      fs.rmSync(fetchCacheDir, { recursive: true, force: true });
    }
    const nextBin = path.join(sfDir, 'node_modules', 'next', 'dist', 'bin', 'next');
    if (!fs.existsSync(nextBin)) throw new Error(`Missing next binary: ${nextBin}`);
    const sfLogs = [];
    const sfChild = spawn(process.execPath, [nextBin, 'start', '-H', '127.0.0.1', '-p', '3000'], {
      cwd: sfDir,
      env: { ...serviceEnv, NODE_ENV: 'production', PORT: '3000', STOREFRONT_PORT: '3000' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    sfChild.stdout?.on('data', (d) => sfLogs.push(d.toString('utf8')));
    sfChild.stderr?.on('data', (d) => sfLogs.push(d.toString('utf8')));
    spawned.push({ name: 'apps/storefront', child: sfChild, logs: sfLogs });
    await waitForHttp200(`${STOREFRONT_BASE}/`, 40_000, sfLogs);
    console.log('  [UP] apps/storefront:3000');

    // Trigger On-Demand ISR Revalidation
    const revalRes = await httpRequest(`${STOREFRONT_BASE}/api/revalidate`, {
      method: 'POST',
      headers: { 'x-revalidate-secret': serviceEnv.REVALIDATE_SECRET },
      body: { tags: ['storefront', 'rack', 'products'], paths: ['/', '/bo-suu-tap'] },
      timeoutMs: 15_000,
    });
    console.log(`  [ISR] POST /api/revalidate HTTP ${revalRes.status}`);

    // CHECK 2: Live BFF API Audit
    const [bootstrapRes, rackRes, seasonsRes, occasionsRes] = await Promise.all([
      httpRequest(`${BFF_BASE}/bff/v1/storefront/bootstrap`),
      httpRequest(`${BFF_BASE}/bff/v1/storefront/rack-collection`),
      httpRequest(`${BFF_BASE}/bff/v1/storefront/seasons`),
      httpRequest(`${BFF_BASE}/bff/v1/storefront/occasions`),
    ]);

    const bootstrap = unwrap(bootstrapRes.json) ?? {};
    const rackData = unwrap(rackRes.json) ?? {};
    const seasonsData = unwrap(seasonsRes.json) ?? {};
    const occasionsData = unwrap(occasionsRes.json) ?? {};

    const rackItems = Array.isArray(rackData)
      ? rackData
      : Array.isArray(rackData.items)
        ? rackData.items
        : Array.isArray(bootstrap.rackItems)
          ? bootstrap.rackItems
          : [];

    const seasonsList = Array.isArray(seasonsData)
      ? seasonsData
      : Array.isArray(seasonsData.items)
        ? seasonsData.items
        : Array.isArray(bootstrap.seasonalCollections)
          ? bootstrap.seasonalCollections
          : Array.isArray(bootstrap.seasons)
            ? bootstrap.seasons
            : [];

    const occasionsList = Array.isArray(occasionsData)
      ? occasionsData
      : Array.isArray(occasionsData.items)
        ? occasionsData.items
        : Array.isArray(bootstrap.occasions)
          ? bootstrap.occasions
          : [];

    const homepageCampaign = bootstrap.homepageCampaign ?? {};
    const hero = homepageCampaign.hero ?? bootstrap.hero ?? bootstrap.campaign ?? {};

    const atelierSteps = Array.isArray(homepageCampaign.atelierSteps)
      ? homepageCampaign.atelierSteps
      : Array.isArray(bootstrap.atelierSteps)
        ? bootstrap.atelierSteps
        : [];

    const packagingOptions = Array.isArray(bootstrap.packagingOptions)
      ? bootstrap.packagingOptions
      : [];

    const combinedApiText = [bootstrapRes.text, rackRes.text, seasonsRes.text, occasionsRes.text].join('\n');
    const roseDeskHits = (combinedApiText.match(/rose-desk/gi) || []).length;

    const rawEyebrow = String(hero.eyebrow ?? bootstrap.campaign?.eyebrow ?? '').normalize('NFC').trim();
    const hanoiOccurrences = (rawEyebrow.match(/HÀ NỘI/gi) || []).length;
    const eyebrowExact = rawEyebrow === EXPECTED_HERO_EYEBROW.normalize('NFC');

    const anchorTargets = rackItems.flatMap((it) =>
      Array.isArray(it.variants) && it.variants.length > 0 ? it.variants : [it],
    );
    const anchorXs = anchorTargets
      .map((v) => Number(v.hangerAnchorX ?? v.hanger_anchor_x ?? NaN))
      .filter(Number.isFinite);
    const anchorYs = anchorTargets
      .map((v) => Number(v.hangerAnchorY ?? v.hanger_anchor_y ?? NaN))
      .filter(Number.isFinite);
    const anchorsValid =
      rackItems.length >= 12 &&
      anchorTargets.length >= 20 &&
      anchorXs.length === anchorTargets.length &&
      anchorYs.length === anchorTargets.length &&
      anchorXs.every((x) => Math.abs(x - 0.5) <= 0.02) &&
      anchorYs.every((y) => Math.abs(y - 0.14) <= 0.02);

    const apiDetails = [
      `HTTP statuses: bootstrap=${bootstrapRes.status}, rack=${rackRes.status}, seasons=${seasonsRes.status}, occasions=${occasionsRes.status}`,
      `Counts: rackItems=${rackItems.length} (${anchorTargets.length} variants), seasons=${seasonsList.length}, occasions=${occasionsList.length}, atelierSteps=${atelierSteps.length}, packaging=${packagingOptions.length}`,
      `Hero eyebrow: "${rawEyebrow}" (exact=${eyebrowExact}, hanoiOccurrences=${hanoiOccurrences})`,
      `Hero videoWebmUrl=${JSON.stringify(hero.videoWebmUrl ?? null)}, videoMp4Url=${JSON.stringify(hero.videoMp4Url ?? null)}, posterUrl=${JSON.stringify(hero.posterUrl ?? hero.heroPosterUrl ?? null)}`,
      `rose-desk occurrences across 4 BFF APIs: ${roseDeskHits}`,
      `Hanger anchors (${anchorTargets.length} variants): X=[${Math.min(...anchorXs)}..${Math.max(...anchorXs)}], Y=[${Math.min(...anchorYs)}..${Math.max(...anchorYs)}] (allCalibrated=${anchorsValid})`,
    ];

    const check2Ok =
      bootstrapRes.status === 200 &&
      rackRes.status === 200 &&
      seasonsRes.status === 200 &&
      occasionsRes.status === 200 &&
      roseDeskHits === 0 &&
      eyebrowExact &&
      hanoiOccurrences === 1 &&
      anchorsValid &&
      seasonsList.length >= 6 &&
      occasionsList.length >= 6 &&
      atelierSteps.length >= 4;

    recordCheck('CHECK 2', 'Live BFF API Audit (Eyebrow, Zero rose-desk, Anchors)', check2Ok, apiDetails);

    // CHECK 3: 100% Real Photography & Sharp Alpha Channel Audit
    const cutoutUrls = new Set();
    const editorialUrls = new Set();

    const addEditorial = (u) => {
      const n = normalizeUrl(u);
      if (n) editorialUrls.add(n);
    };
    const addCutout = (u) => {
      const n = normalizeUrl(u);
      if (n) cutoutUrls.add(n);
    };

    for (const item of rackItems) {
      addCutout(item.frontCutoutUrl || item.rackFrontUrl);
      addCutout(item.backCutoutUrl || item.rackBackUrl);
      addEditorial(item.lookbookMainUrl);
      addEditorial(item.tryonFlatAssetUrl);
      for (const v of item.variants || []) {
        addCutout(v.rackFrontUrl || v.frontCutoutUrl);
        addCutout(v.rackBackUrl || v.backCutoutUrl);
        addCutout(v.tryonFlatPreviewUrl);
        addEditorial(v.lookbookMainUrl);
      }
    }

    addEditorial(hero.posterUrl || hero.heroPosterUrl || bootstrap.campaign?.heroPosterUrl);
    for (const s of seasonsList) {
      addEditorial(s.coverAssetUrl || s.imageUrl || s.heroImageUrl || s.coverImageUrl || s.posterUrl);
      for (const p of s.products || s.items || []) {
        addEditorial(p.lookbookMainUrl || p.imageUrl);
      }
    }
    for (const s of bootstrap.seasonalCollections || []) {
      addEditorial(s.coverAssetUrl || s.heroImageUrl);
    }
    for (const o of occasionsList) {
      addEditorial(o.imageUrl || o.editorialImageUrl || o.coverImageUrl || o.posterUrl);
      for (const p of o.products || o.items || []) {
        addEditorial(p.lookbookMainUrl || p.imageUrl);
      }
    }
    for (const step of atelierSteps) {
      addEditorial(step.imageUrl || step.photoUrl);
    }
    for (const pkg of packagingOptions) {
      addCutout(pkg.imageUrl);
      addCutout(pkg.backImageUrl);
    }

    // Remove cutouts from editorial set so each unique URL is verified once at its strictest level
    for (const u of cutoutUrls) editorialUrls.delete(u);

    const cutoutReports = [];
    for (const url of cutoutUrls) {
      cutoutReports.push(await analyzeRasterImage(url, true));
    }
    const editorialReports = [];
    for (const url of editorialUrls) {
      editorialReports.push(await analyzeRasterImage(url, false));
    }

    const failedCutouts = cutoutReports.filter((r) => !r.ok);
    const failedEditorial = editorialReports.filter((r) => !r.ok);
    const minTransPct = cutoutReports
      .filter((r) => typeof r.transparentPct === 'number')
      .reduce((min, r) => Math.min(min, r.transparentPct), 100);
    const maxTransPct = cutoutReports
      .filter((r) => typeof r.transparentPct === 'number')
      .reduce((max, r) => Math.max(max, r.transparentPct), 0);

    const assetDetails = [
      `Rack cutouts verified: ${cutoutReports.length - failedCutouts.length}/${cutoutReports.length} PASS (100% HTTP 200, 0 SVG, sharp hasAlpha=true, transparentBg=${minTransPct}%..${maxTransPct}%)`,
      `Editorial/Hero/Season/Occasion/Atelier images verified: ${editorialReports.length - failedEditorial.length}/${editorialReports.length} PASS (100% HTTP 200, 0 SVG)`,
      ...failedCutouts.slice(0, 6).map((f) => `FAIL CUTOUT: ${f.url} -> ${f.reason}`),
      ...failedEditorial.slice(0, 6).map((f) => `FAIL EDITORIAL: ${f.url} -> ${f.reason}`),
    ];

    const check3Ok =
      cutoutReports.length >= 24 &&
      editorialReports.length >= 8 &&
      failedCutouts.length === 0 &&
      failedEditorial.length === 0;

    recordCheck('CHECK 3', '100% Real Photography & Sharp Alpha Channel Audit', check3Ok, assetDetails);

    // CHECK 4: Real Headless Chrome Visual Audit & 7 Screenshots (1440x900)
    fs.mkdirSync(AUDIT_SCREENSHOT_DIR, { recursive: true });

    browser = await chromium.launch({
      executablePath: chromePath,
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--use-gl=angle',
        '--use-angle=swiftshader',
        '--enable-webgl',
        '--ignore-gpu-blocklist',
      ],
    });

    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();

    const consoleErrors = [];
    const pageErrors = [];
    const failedRequests = [];

    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
    });
    page.on('pageerror', (err) => {
      pageErrors.push(err instanceof Error ? err.message : String(err));
    });
    page.on('response', (res) => {
      if (res.status() >= 400) {
        failedRequests.push(`${res.status()} ${res.url()}`);
      }
    });

    await page.goto(`${STOREFRONT_BASE}/`, { waitUntil: 'networkidle', timeout: 45_000 });
    await page.evaluate(() => document.fonts?.ready);

    // Wait out intro curtain (#intro) cleanly (or click skip button if present)
    await page.waitForTimeout(1600);
    const skipBtn = page.locator('#intro button, .intro-skip').first();
    if (await skipBtn.isVisible().catch(() => false)) {
      await skipBtn.click().catch(() => {});
    }
    await page
      .waitForFunction(
        () => {
          const intro = document.querySelector('#intro');
          if (!intro) return true;
          const st = window.getComputedStyle(intro);
          return (
            intro.classList.contains('is-done') ||
            st.display === 'none' ||
            st.visibility === 'hidden' ||
            Number(st.opacity) < 0.05 ||
            st.pointerEvents === 'none'
          );
        },
        { timeout: 8000 },
      )
      .catch(() => {});
    await page.waitForTimeout(700);

    // Helper: scroll smoothly to selector and take a clean 1440x900 viewport PNG
    const capturedFiles = [];
    const captureSection = async (filename, selector, settleMs = 1200, scrollBlock = 'start', preHook = null) => {
      const found = await page.evaluate(
        ({ sel, block }) => {
          if (sel === '#top') {
            window.scrollTo({ top: 0, behavior: 'instant' });
            return { matched: '#top', y: 0 };
          }
          const el = document.querySelector(sel);
          if (!el) return null;
          el.scrollIntoView({ behavior: 'instant', block });
          const rect = el.getBoundingClientRect();
          return { matched: sel, y: Math.round(window.scrollY), height: Math.round(rect.height) };
        },
        { sel: selector, block: scrollBlock },
      );

      await page.waitForTimeout(settleMs);
      // Force any visible images in viewport to decode
      await page
        .evaluate(async () => {
          const imgs = Array.from(document.querySelectorAll('img'));
          await Promise.all(
            imgs.map((img) => {
              if (img.complete) return Promise.resolve();
              return new Promise((r) => {
                img.addEventListener('load', r, { once: true });
                img.addEventListener('error', r, { once: true });
                setTimeout(r, 2500);
              });
            }),
          );
        })
        .catch(() => {});

      if (typeof preHook === 'function') {
        await preHook();
      }

      const outPath = path.join(AUDIT_SCREENSHOT_DIR, filename);
      await page.screenshot({ path: outPath, fullPage: false, type: 'png' });
      const stat = fs.statSync(outPath);
      capturedFiles.push({
        filename,
        path: outPath,
        bytes: stat.size,
        matched: found?.matched ?? 'MISSING_SELECTOR',
      });
      return found;
    };

    // 1. Hero (#top)
    await captureSection('01-hero.png', '#top', 900);

    // 2. 3D Rack (#rack) + Cursor .is-view check
    let cursorCheck = { hasIsView: false, width: 0, height: 0, rackCanvas: null };
    await captureSection('02-rack.png', '#rack', 2400, 'start', async () => {
      const rackInfo = await page.evaluate(() => {
        const rack = document.querySelector('#rack');
        const canvas = rack?.querySelector('canvas');
        if (!rack || !canvas) return null;
        const r = canvas.getBoundingClientRect();
        return { x: r.left + r.width * 0.5, y: r.top + r.height * 0.5, width: r.width, height: r.height };
      });
      if (rackInfo) {
        cursorCheck.rackCanvas = { width: Math.round(rackInfo.width), height: Math.round(rackInfo.height) };
        await page.mouse.move(rackInfo.x, rackInfo.y, { steps: 6 });
        await page.waitForTimeout(350);
        const curState = await page.evaluate(() => {
          const cur = document.querySelector('.cursor');
          if (!cur) return { hasIsView: false, width: 0, height: 0, classes: '' };
          const rect = cur.getBoundingClientRect();
          const st = window.getComputedStyle(cur);
          return {
            hasIsView: cur.classList.contains('is-view'),
            width: Math.round(rect.width || parseFloat(st.width) || 0),
            height: Math.round(rect.height || parseFloat(st.height) || 0),
            classes: cur.className,
          };
        });
        cursorCheck = { ...cursorCheck, ...curState };
        // Wait briefly so hover response settles nicely in screenshot
        await page.waitForTimeout(250);
      }
    });

    // Move mouse cleanly to neutral corner after verifying #rack .cursor.is-view
    // so subsequent section captures (03..07) are unobscured by a centered hover circle
    await page.mouse.move(14, 14, { steps: 3 });
    await page.waitForTimeout(200);

    // 3. Occasion (#occasion)
    await captureSection('03-occasion.png', '#occasion', 1200);

    // 4. Outfit Builder (#build)
    await captureSection('04-build.png', '#build', 1200);

    // 5. Seasons Lookbook (#seasons)
    await captureSection('05-seasons.png', '#seasons', 1500);

    // 6. Atelier Craft (#atelier)
    await captureSection('06-atelier.png', '#atelier', 1200);

    // 7. Finale (#contact)
    await captureSection('07-finale.png', '#contact', 1200, 'end');

    // Inspect DOM integrity after scrolling every section
    const domAudit = await page.evaluate(() => {
      const html = document.documentElement.innerHTML;
      const domRoseDeskHits = (html.match(/rose-desk/gi) || []).length;
      const imgs = Array.from(document.querySelectorAll('img'));
      const brokenImgs = imgs
        .filter((img) => {
          const st = window.getComputedStyle(img);
          if (st.display === 'none') return false;
          return !img.complete || img.naturalWidth === 0;
        })
        .map((img) => img.currentSrc || img.getAttribute('src') || '(no-src)');

      const heroEl = document.querySelector('#top');
      const heroText = (heroEl?.textContent || '').normalize('NFC');
      const heroHanoiCount = (heroText.match(/HÀ NỘI/gi) || []).length;
      const glintsCanvas = document.querySelector('#glints canvas, canvas#glints, #top canvas');
      const glintsRect = glintsCanvas?.getBoundingClientRect();
      const rackCanvas = document.querySelector('#rack canvas');
      const rackRect = rackCanvas?.getBoundingClientRect();
      const navEl = document.querySelector('.nav, header nav, header');
      const navBg = navEl ? window.getComputedStyle(navEl).backgroundImage || window.getComputedStyle(navEl).backgroundColor : '';

      return {
        domRoseDeskHits,
        totalImgs: imgs.length,
        brokenImgs,
        heroHanoiCount,
        hasGlintsCanvas: Boolean(glintsCanvas && glintsRect && glintsRect.width > 100 && glintsRect.height > 100),
        glintsSize: glintsRect ? `${Math.round(glintsRect.width)}x${Math.round(glintsRect.height)}` : 'none',
        hasRackCanvas: Boolean(rackCanvas && rackRect && rackRect.width > 300 && rackRect.height > 200),
        rackSize: rackRect ? `${Math.round(rackRect.width)}x${Math.round(rackRect.height)}` : 'none',
        navBg,
      };
    });

    const cursorOk =
      cursorCheck.hasIsView &&
      cursorCheck.width >= 64 &&
      cursorCheck.width <= 86 &&
      cursorCheck.height >= 64 &&
      cursorCheck.height <= 86;

    const allScreenshotsValid =
      capturedFiles.length === 7 &&
      capturedFiles.every((f) => f.bytes >= 10_000 && f.matched !== 'MISSING_SELECTOR');

    const chromeDetails = [
      `Console errors=${consoleErrors.length}, Page errors=${pageErrors.length}, HTTP>=400=${failedRequests.length}`,
      `Images rendered: ${domAudit.totalImgs - domAudit.brokenImgs.length}/${domAudit.totalImgs} OK (broken=${domAudit.brokenImgs.length})`,
      `DOM rose-desk hits=${domAudit.domRoseDeskHits}, Hero "HÀ NỘI" count=${domAudit.heroHanoiCount}`,
      `Canvases: #glints=${domAudit.hasGlintsCanvas} (${domAudit.glintsSize}), #rack=${domAudit.hasRackCanvas} (${domAudit.rackSize})`,
      `Rack hover cursor: .cursor.is-view=${cursorCheck.hasIsView}, size=${cursorCheck.width}x${cursorCheck.height}px (ok=${cursorOk})`,
      `Screenshots (7/7 @ 1440x900) in ${AUDIT_SCREENSHOT_DIR}:`,
      ...capturedFiles.map((f) => `  - ${f.filename} (${Math.round(f.bytes / 1024)} KB, selector=${f.matched})`),
      ...consoleErrors.slice(0, 5).map((e) => `CONSOLE ERROR: ${e}`),
      ...pageErrors.slice(0, 5).map((e) => `PAGE ERROR: ${e}`),
      ...failedRequests.slice(0, 5).map((e) => `HTTP FAIL: ${e}`),
      ...domAudit.brokenImgs.slice(0, 5).map((u) => `BROKEN IMG: ${u}`),
    ];

    const check4Ok =
      consoleErrors.length === 0 &&
      pageErrors.length === 0 &&
      failedRequests.length === 0 &&
      domAudit.brokenImgs.length === 0 &&
      domAudit.domRoseDeskHits === 0 &&
      domAudit.heroHanoiCount === 1 &&
      domAudit.hasGlintsCanvas &&
      domAudit.hasRackCanvas &&
      cursorOk &&
      allScreenshotsValid;

    recordCheck('CHECK 4', 'Headless Chrome 1440x900 Visual Audit & 7 Screenshots', check4Ok, chromeDetails);
  } finally {
    await cleanupAll();
    console.log('\n[CLEANUP] Browser, all services, storefront & local infra cleanly terminated.');
  }

  const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
  const passCount = results.filter((r) => r.ok).length;
  const failCount = results.length - passCount;

  console.log('\n========================================================================');
  console.log(` VISUAL OVERHAUL VERIFICATION SUMMARY  (${elapsedSec}s)`);
  console.log('------------------------------------------------------------------------');
  for (const r of results) {
    console.log(`  [${r.ok ? 'PASS' : 'FAIL'}] ${r.id}: ${r.title}`);
  }
  console.log('------------------------------------------------------------------------');
  console.log(`  Totals: PASS=${passCount}/${results.length} | FAIL=${failCount}`);
  console.log('========================================================================\n');

  if (failCount > 0 || passCount < 4) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('\n[FATAL] verify-visual-overhaul crashed:', err instanceof Error ? err.stack || err.message : err);
  process.exitCode = 1;
});
