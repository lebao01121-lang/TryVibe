#!/usr/bin/env node
/**
 * Occasion Luxury Overhaul Visual & Playwright Verification Suite
 * fashion-atelier-ai-platform (v3.1)
 *
 * Verifies #264 checklist end-to-end:
 *   1. Boots live stack (local-infra-dev + auth:4001, catalog:4002, media:4003,
 *      inventory:4004, cart:4005, order:4006, payment:4007, notify:4008,
 *      ai-tryon:4009, bff:4000, storefront:3000).
 *   2. Forces fresh data sync:
 *      - POST /v1/catalog/internal/reseed (200 OK)
 *      - node infra/seeds/seed-demo-data.mjs
 *      - Redis FLUSHALL (clears storefront:* & occasions:*)
 *      - POST /api/revalidate (200 OK)
 *      - Audits GET /bff/v1/occasions & GET /bff/v1/storefront/bootstrap for
 *        macroImageUrl & real raster lookbook URLs (0 SVG data URIs).
 *   3. Real Headless Chrome (1440x900) Visual & DOM Audit across `#occasion`:
 *      - Check 1: Light Header (.nav.is-light), espresso text, ::before opacity 0,
 *        translucent ivory bg, zero dark gradient bar.
 *      - Check 2: Enlarged Arch (>=330x450, radius>=180px), #occWord overlap
 *        (5..32px) & z-index > arch, 2 concentric gold arch rings, visible
 *        MacroFabricInset left of arch with loaded raster img, frosted
 *        `✦ THỬ ĐỒ AI` pill in bottom 20% of arch.
 *      - Check 3: Rectangular 3:4 4-Card Gallery (#occSets width>=390px, 4 cards,
 *        frame border-radius<=14px, aspect-ratio ~0.75, 2-line title clamp).
 *      - Check 4: Left copy column cleanly above .autoplay (LOOKBOOK TOUR) pill.
 *      - Captures 4 full-viewport (1440x900) PNGs into scratch/occasion-audit/.
 *      - Verifies Card 2 click switch, Dark Header restoration on EVENING COUTURE,
 *        and `✦ THỬ ĐỒ AI` modal opening above header with active silk shirt.
 *      - Asserts consoleErrors=0, pageErrors=0, failedHttp=0, brokenImgs=0.
 *   4. Clean teardown: kills all spawned services + stops local infra without
 *      touching host Ollama (:11434).
 */

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
const TRYON_BASE = 'http://127.0.0.1:4009';

const AUDIT_DIR =
  process.env.OCCASION_AUDIT_DIR ||
  'C:\\Users\\Admin\\.gemini\\antigravity\\brain\\d1783908-6521-4608-8b37-41aae3ee9a65\\scratch\\occasion-audit';

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

function resolvePythonBin() {
  const candidates = IS_WIN
    ? [path.join(ROOT_DIR, 'services', 'ai-tryon', '.venv', 'Scripts', 'python.exe'), 'python']
    : [path.join(ROOT_DIR, 'services', 'ai-tryon', '.venv', 'bin', 'python'), 'python3'];
  for (const c of candidates) {
    if (c.includes(path.sep)) {
      if (fs.existsSync(c)) return c;
    } else {
      return c;
    }
  }
  return candidates[0];
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

function httpRequest(urlString, { method = 'GET', headers = {}, body = undefined, timeoutMs = 25_000 } = {}) {
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

async function waitForHttp200(url, timeoutMs = 50_000, logs = []) {
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
  const tail = logs.join('').split(/\r?\n/).filter(Boolean).slice(-14).join('\n');
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

async function verifyRasterUrl(url) {
  const res = await httpRequest(url, { timeoutMs: 15_000 });
  const contentType = String(res.headers['content-type'] || '').toLowerCase();
  if (res.status !== 200) {
    return { ok: false, url, reason: `HTTP ${res.status}` };
  }
  if (contentType.includes('svg')) {
    return { ok: false, url, reason: `SVG MIME (${contentType})` };
  }
  const head = res.buffer.subarray(0, 512).toString('utf8').toLowerCase();
  if (head.includes('<svg') || head.includes('<?xml')) {
    return { ok: false, url, reason: 'SVG/XML bytes detected' };
  }
  const meta = await sharp(res.buffer).metadata();
  if (!meta.width || !meta.height || meta.width < 200 || meta.height < 200) {
    return { ok: false, url, reason: `Raster too small (${meta.width}x${meta.height})` };
  }
  return { ok: true, url, format: meta.format, width: meta.width, height: meta.height };
}

async function flushAllRedis(envVars) {
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
    await redis.flushall();
    return true;
  } finally {
    redis.disconnect();
  }
}

function parseRgb(str) {
  if (!str) return null;
  const m = str.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)/i);
  if (!m) return null;
  return {
    r: Math.round(Number(m[1])),
    g: Math.round(Number(m[2])),
    b: Math.round(Number(m[3])),
    a: m[4] !== undefined ? Number(m[4]) : 1,
  };
}

async function waitImagesLoaded(page) {
  await page
    .evaluate(async () => {
      const imgs = Array.from(document.querySelectorAll('#occasion img'));
      await Promise.all(
        imgs.map((img) => {
          if (img.complete) return Promise.resolve();
          return new Promise((r) => {
            img.addEventListener('load', r, { once: true });
            img.addEventListener('error', r, { once: true });
            setTimeout(r, 3000);
          });
        }),
      );
    })
    .catch(() => {});
}

async function main() {
  const startedAt = Date.now();
  console.log('========================================================================');
  console.log(' fashion-atelier-ai-platform (v3.1) — Occasion Luxury Overhaul Audit');
  console.log('========================================================================');

  const envVars = {
    ...process.env,
    ...loadDotEnv(path.join(ROOT_DIR, '.env')),
  };

  fs.mkdirSync(AUDIT_DIR, { recursive: true });

  const removedLocks = cleanStalePgliteLocks();
  if (removedLocks > 0) {
    console.log(`[CLEANUP] Removed ${removedLocks} stale PGlite postmaster.pid lock file(s).`);
  }

  const chromePath = findChromeExecutable();
  if (!chromePath) {
    throw new Error('System Chrome/Edge executable not found for Playwright verification.');
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
      AI_TRYON_SERVICE_URL: TRYON_BASE,
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

    const spawnPythonTryOn = () => {
      const dir = path.join(ROOT_DIR, 'services', 'ai-tryon');
      const pyBin = resolvePythonBin();
      const logs = [];
      const child = spawn(
        pyBin,
        ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', '4009'],
        {
          cwd: dir,
          env: { ...serviceEnv, PORT: '4009', AI_TRYON_PORT: '4009' },
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        },
      );
      child.stdout?.on('data', (d) => logs.push(d.toString('utf8')));
      child.stderr?.on('data', (d) => logs.push(d.toString('utf8')));
      spawned.push({ name: 'services/ai-tryon', child, logs });
      return { child, logs };
    };

    console.log('\n--- Booting live stack (4001..4009, 4000, 3000) ---');
    const authProc = spawnNodeService('auth-customer', 'services/auth-customer', 'AUTH_CUSTOMER_PORT', 4001);
    const mediaProc = spawnNodeService('media-pipeline', 'services/media-pipeline', 'MEDIA_PIPELINE_PORT', 4003);
    const invProc = spawnNodeService('inventory', 'services/inventory', 'INVENTORY_PORT', 4004);
    const orderProc = spawnNodeService('order-rma', 'services/order-rma', 'ORDER_RMA_PORT', 4006);
    const paymentProc = spawnNodeService('payment-promo', 'services/payment-promo', 'PAYMENT_PROMO_PORT', 4007);
    const notifyProc = spawnNodeService('notify-review', 'services/notify-review', 'NOTIFY_REVIEW_PORT', 4008);

    await Promise.all([
      waitForHttp200(`${AUTH_BASE}/health`, 40_000, authProc.logs),
      waitForHttp200(`${MEDIA_BASE}/health`, 40_000, mediaProc.logs),
      waitForHttp200(`${INVENTORY_BASE}/health`, 40_000, invProc.logs),
      waitForHttp200(`${ORDER_BASE}/health`, 40_000, orderProc.logs),
      waitForHttp200(`${PAYMENT_BASE}/health`, 40_000, paymentProc.logs),
      waitForHttp200(`${NOTIFY_BASE}/health`, 40_000, notifyProc.logs),
    ]);
    console.log('  [UP] auth:4001, media:4003, inventory:4004, order:4006, payment:4007, notify:4008');

    const catalogProc = spawnNodeService('catalog-lookbook', 'services/catalog-lookbook', 'CATALOG_LOOKBOOK_PORT', 4002);
    const cartProc = spawnNodeService('cart-outfit', 'services/cart-outfit', 'CART_OUTFIT_PORT', 4005);
    const tryonProc = spawnPythonTryOn();

    await Promise.all([
      waitForHttp200(`${CATALOG_BASE}/health`, 90_000, catalogProc.logs),
      waitForHttp200(`${CART_BASE}/health`, 40_000, cartProc.logs),
      waitForHttp200(`${TRYON_BASE}/health`, 60_000, tryonProc.logs),
    ]);
    console.log('  [UP] catalog:4002, cart:4005, ai-tryon:4009');

    // Step 3: Fresh data sync (Reseed + Seed + Redis FLUSHALL + ISR Revalidate)
    console.log('  [SEED] Calling POST /v1/catalog/internal/reseed ...');
    const reseedRes = await httpRequest(`${CATALOG_BASE}/v1/catalog/internal/reseed`, {
      method: 'POST',
      timeoutMs: 90_000,
    });
    console.log(`  [SEED] Catalog reseed HTTP ${reseedRes.status}`);

    const seedRelPath = fs.existsSync(path.join(ROOT_DIR, 'scripts', 'seed-demo-data.mjs'))
      ? 'scripts/seed-demo-data.mjs'
      : 'infra/seeds/seed-demo-data.mjs';
    console.log(`  [SEED] Running ${seedRelPath} ...`);
    const seedRun = await runNodeScript(seedRelPath, serviceEnv, 120_000);
    if (!seedRun.ok) {
      throw new Error(`${seedRelPath} failed (code=${seedRun.code}):\n${seedRun.stderr || seedRun.stdout}`);
    }
    console.log(`  [SEED] ${seedRelPath} completed cleanly.`);

    await flushAllRedis(envVars);
    console.log('  [CACHE] Redis FLUSHALL complete (cleared storefront:* & occasions:*).');

    const bffProc = spawnNodeService('bff', 'apps/bff', 'BFF_PORT', 4000);
    await waitForHttp200(`${BFF_BASE}/health`, 40_000, bffProc.logs);
    console.log('  [UP] apps/bff:4000');

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

    const revalRes = await httpRequest(`${STOREFRONT_BASE}/api/revalidate`, {
      method: 'POST',
      headers: { 'x-revalidate-secret': serviceEnv.REVALIDATE_SECRET },
      body: { tags: ['storefront', 'rack', 'products', 'occasions'], paths: ['/', '/bo-suu-tap', '/thu-do-ai'] },
      timeoutMs: 15_000,
    });
    console.log(`  [ISR] POST /api/revalidate HTTP ${revalRes.status}`);

    // =========================================================================
    // API & MEDIA CHECK: /bff/v1/occasions & /bff/v1/storefront/bootstrap
    // =========================================================================
    {
      const [occRes, bootRes] = await Promise.all([
        httpRequest(`${BFF_BASE}/bff/v1/occasions`),
        httpRequest(`${BFF_BASE}/bff/v1/storefront/bootstrap`),
      ]);
      const occData = unwrap(occRes.json);
      const bootData = unwrap(bootRes.json) ?? {};

      const occList = Array.isArray(occData)
        ? occData
        : Array.isArray(occData?.items)
          ? occData.items
          : Array.isArray(occData?.occasions)
            ? occData.occasions
            : [];
      const bootOccList = Array.isArray(bootData.occasionLookbooks) ? bootData.occasionLookbooks : [];

      const svgHits = [];
      const lookbookUrls = new Set();
      const macroUrls = new Set();
      let totalItems = 0;
      let itemsWithMacro = 0;

      for (const occ of occList) {
        const items = Array.isArray(occ.items) ? occ.items : [];
        for (const it of items) {
          totalItems += 1;
          const img = it.lookbookMainUrl || it.imageUrl || '';
          if (!img || img.startsWith('data:image/svg') || /\.svg(\?|$)/i.test(img)) {
            svgHits.push(`lookbook(${occ.slug}/${it.slug}): ${img.slice(0, 60)}`);
          } else {
            const norm = normalizeUrl(img);
            if (norm) lookbookUrls.add(norm);
          }

          if (it.macroImageUrl) {
            itemsWithMacro += 1;
            if (it.macroImageUrl.startsWith('data:image/svg') || /\.svg(\?|$)/i.test(it.macroImageUrl)) {
              svgHits.push(`macro(${occ.slug}/${it.slug}): ${it.macroImageUrl.slice(0, 60)}`);
            } else {
              const normM = normalizeUrl(it.macroImageUrl);
              if (normM) macroUrls.add(normM);
            }
          }
        }
      }

      const rasterChecks = [];
      for (const u of [...lookbookUrls, ...macroUrls]) {
        rasterChecks.push(await verifyRasterUrl(u));
      }
      const failedRasters = rasterChecks.filter((r) => !r.ok);

      const weekendOcc = occList.find((o) => o.slug === 'cuoi-tuan-thu-thai');
      const eveningOcc = occList.find((o) => o.slug === 'du-tiec-toi');
      const weekendUsesPrimaryV0 = Boolean(
        weekendOcc &&
          (weekendOcc.items || []).every(
            (it) => typeof it.lookbookMainUrl === 'string' && !it.lookbookMainUrl.includes('-v1-lookbook'),
          ),
      );
      const bootHasMacro = bootOccList.some((o) =>
        (o.items || []).some((it) => typeof it.macroImageUrl === 'string' && it.macroImageUrl.length > 0),
      );

      const apiOk =
        reseedRes.status >= 200 &&
        reseedRes.status < 300 &&
        revalRes.status === 200 &&
        occRes.status === 200 &&
        bootRes.status === 200 &&
        occList.length >= 6 &&
        Boolean(weekendOcc) &&
        Boolean(eveningOcc) &&
        weekendUsesPrimaryV0 &&
        totalItems >= 24 &&
        itemsWithMacro >= 24 &&
        bootHasMacro &&
        svgHits.length === 0 &&
        failedRasters.length === 0;

      recordCheck('API SYNC', 'Reseed, Redis Flush, Revalidate & BFF Occasions + Macro Photography', apiOk, [
        `Reseed HTTP=${reseedRes.status}, Revalidate HTTP=${revalRes.status}, /bff/v1/occasions=${occRes.status}, /bff/v1/storefront/bootstrap=${bootRes.status}`,
        `Occasions=${occList.length} (bootstrap occasionLookbooks=${bootOccList.length}, bootHasMacro=${bootHasMacro}, weekendUsesPrimaryV0=${weekendUsesPrimaryV0})`,
        `Lookbook items=${totalItems}, itemsWithMacro=${itemsWithMacro}, uniqueLookbookUrls=${lookbookUrls.size}, uniqueMacroUrls=${macroUrls.size}`,
        `SVG data URI / .svg hits=${svgHits.length}, Raster HTTP/sharp verification=${rasterChecks.length - failedRasters.length}/${rasterChecks.length} PASS`,
        ...(weekendOcc
          ? [
              `WEEKEND EASE items: ${(weekendOcc.items || [])
                .map((i) => `${i.slug} [macro=${i.macroImageUrl || 'NONE'}]`)
                .join(' | ')}`,
            ]
          : ['MISSING cuoi-tuan-thu-thai occasion!']),
        ...svgHits.slice(0, 5).map((s) => `SVG HIT: ${s}`),
        ...failedRasters.slice(0, 5).map((f) => `RASTER FAIL: ${f.url} -> ${f.reason}`),
      ]);
    }

    // =========================================================================
    // PLAYWRIGHT REAL CHROME (1440x900) VISUAL & DOM AUDIT
    // =========================================================================
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
    const failedHttp = [];

    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => {
      pageErrors.push(err instanceof Error ? err.message : String(err));
    });
    page.on('response', (res) => {
      if (res.status() >= 400) {
        failedHttp.push(`${res.status()} ${res.url()}`);
      }
    });

    await page.goto(`${STOREFRONT_BASE}/`, { waitUntil: 'networkidle', timeout: 45_000 });
    await page.evaluate(() => document.fonts?.ready);

    // Wait out / skip intro curtain cleanly
    await page.waitForTimeout(1400);
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
        undefined,
        { timeout: 10_000 },
      )
      .catch(() => {});
    await page.waitForTimeout(600);

    // Scroll cleanly to #occasion so pinned ScrollTrigger activates
    await page.evaluate(() => {
      const el = document.querySelector('#occasion');
      if (el) {
        el.scrollIntoView({ behavior: 'instant', block: 'start' });
        window.scrollBy(0, 12);
      }
    });
    await page.waitForTimeout(800);

    // Select WEEKEND EASE · CUỐI TUẦN THƯ THÁI
    const weekendTab = page
      .locator('#occTabs button')
      .filter({ hasText: /WEEKEND EASE|Cuối Tuần Thư Thái/i })
      .first();
    await weekendTab.waitFor({ state: 'visible', timeout: 10_000 });
    await weekendTab.click();
    await page.mouse.move(14, 14, { steps: 3 });

    await page.waitForFunction(
      () => {
        const word = (document.querySelector('#occWord')?.textContent || '').normalize('NFC');
        return /Cuối Tuần Thư Thái/i.test(word);
      },
      undefined,
      { timeout: 12_000 },
    );
    // Allow Lenis scroll, radial wipe (1.0s), elastic drop (1.25s), particle burst, macro stagger, and nav transition (0.45s) to settle
    await page.waitForTimeout(2100);
    await waitImagesLoaded(page);

    // Measure ALL 4 Visual/DOM Checks on WEEKEND EASE
    const weekendAudit = await page.evaluate(() => {
      const header = document.querySelector('header.nav, .nav');
      const headerStyle = header ? window.getComputedStyle(header) : null;
      const headerBeforeStyle = header ? window.getComputedStyle(header, '::before') : null;

      const arch = document.querySelector('#occBouquet');
      const archRect = arch?.getBoundingClientRect() ?? null;
      const archStyle = arch ? window.getComputedStyle(arch) : null;

      const word = document.querySelector('#occWord');
      const wordRect = word?.getBoundingClientRect() ?? null;
      const wordStyle = word ? window.getComputedStyle(word) : null;
      const headingWrap = word?.parentElement ?? null;
      const headingWrapStyle = headingWrap ? window.getComputedStyle(headingWrap) : null;

      const macro = document.querySelector('[data-testid="occasion-macro-inset"]');
      const macroRect = macro?.getBoundingClientRect() ?? null;
      const macroStyle = macro ? window.getComputedStyle(macro) : null;
      const macroImg = macro?.querySelector('img') ?? null;

      const pill = document.querySelector('[data-testid="occasion-tryon-pill"]');
      const pillRect = pill?.getBoundingClientRect() ?? null;

      const archImg = document.querySelector('#occImg');
      const occMeta = document.querySelector('#occMeta');

      // Concentric gold arch rings (siblings of #occBouquet inside archStage)
      const archStage = arch?.parentElement ?? null;
      const decorativeRings = archStage
        ? Array.from(archStage.children).filter((el) => el !== arch && el.getAttribute('aria-hidden') === 'true' && !el.hasAttribute('data-testid'))
        : [];

      const setsEl = document.querySelector('#occSets');
      const setsRect = setsEl?.getBoundingClientRect() ?? null;
      const cardLis = setsEl ? Array.from(setsEl.querySelectorAll(':scope > li')) : [];
      const cards = cardLis.map((li, idx) => {
        const frame = li.querySelector('.occ__setimg');
        const img = li.querySelector('img');
        const title = li.querySelector('b');
        const frameRect = frame?.getBoundingClientRect() ?? null;
        const frameStyle = frame ? window.getComputedStyle(frame) : null;
        const titleStyle = title ? window.getComputedStyle(title) : null;
        return {
          idx,
          titleText: (title?.textContent || '').trim(),
          frameWidth: frameRect ? Number(frameRect.width.toFixed(1)) : 0,
          frameHeight: frameRect ? Number(frameRect.height.toFixed(1)) : 0,
          aspectRatio: frameRect && frameRect.height > 0 ? Number((frameRect.width / frameRect.height).toFixed(3)) : 0,
          radiusTL: frameStyle ? parseFloat(frameStyle.borderTopLeftRadius) : 999,
          radiusTR: frameStyle ? parseFloat(frameStyle.borderTopRightRadius) : 999,
          imgComplete: Boolean(img && img.complete),
          imgNaturalWidth: img?.naturalWidth ?? 0,
          imgSrc: img?.currentSrc || img?.getAttribute('src') || '',
          webkitLineClamp: titleStyle ? titleStyle.getPropertyValue('-webkit-line-clamp').trim() : '',
          lineClamp: titleStyle ? titleStyle.getPropertyValue('line-clamp').trim() : '',
          whiteSpace: titleStyle ? titleStyle.whiteSpace : '',
        };
      });

      const copyEl = document.querySelector('.occ__copy');
      const copyLastChild = copyEl?.lastElementChild ?? copyEl;
      const copyRect = copyEl?.getBoundingClientRect() ?? null;
      const copyContentRect = copyLastChild?.getBoundingClientRect() ?? copyRect;
      const autoplayEl = document.querySelector('.autoplay, #autoplay');
      const autoplayRect = autoplayEl?.getBoundingClientRect() ?? null;

      const occasionSection = document.querySelector('#occasion');

      const allCheckedImgs = Array.from(document.querySelectorAll('img')).filter((im) => {
        const st = window.getComputedStyle(im);
        if (st.display === 'none' || st.visibility === 'hidden') return false;
        const r = im.getBoundingClientRect();
        const inOccasion = Boolean(im.closest('#occasion'));
        const inViewport = r.bottom > 0 && r.top < window.innerHeight && r.right > 0 && r.left < window.innerWidth;
        const isLazyOffscreen = im.loading === 'lazy' && !inViewport && !inOccasion;
        return !isLazyOffscreen;
      });
      const brokenImgs = allCheckedImgs
        .filter((im) => !im.complete || im.naturalWidth === 0)
        .map((im) => im.currentSrc || im.getAttribute('src') || '(no-src)');

      return {
        navThemeAttr: occasionSection?.getAttribute('data-nav-theme') ?? null,
        header: {
          exists: Boolean(header),
          hasIsLight: Boolean(header?.classList.contains('is-light')),
          color: headerStyle?.color ?? '',
          backgroundColor: headerStyle?.backgroundColor ?? '',
          backgroundImage: headerStyle?.backgroundImage ?? '',
          beforeOpacity: headerBeforeStyle ? parseFloat(headerBeforeStyle.opacity) : -1,
          zIndex: headerStyle ? parseInt(headerStyle.zIndex || '0', 10) : 0,
        },
        arch: {
          width: archRect ? Number(archRect.width.toFixed(1)) : 0,
          height: archRect ? Number(archRect.height.toFixed(1)) : 0,
          top: archRect ? Number(archRect.top.toFixed(1)) : 0,
          bottom: archRect ? Number(archRect.bottom.toFixed(1)) : 0,
          left: archRect ? Number(archRect.left.toFixed(1)) : 0,
          right: archRect ? Number(archRect.right.toFixed(1)) : 0,
          radiusTL: archStyle ? parseFloat(archStyle.borderTopLeftRadius) : 0,
          radiusTR: archStyle ? parseFloat(archStyle.borderTopRightRadius) : 0,
          zIndex: archStyle ? parseInt(archStyle.zIndex || '0', 10) : 0,
          ringCount: decorativeRings.length,
          imgSrc: archImg?.currentSrc || archImg?.getAttribute('src') || '',
          imgComplete: Boolean(archImg && archImg.complete),
          imgNaturalWidth: archImg?.naturalWidth ?? 0,
          metaText: (occMeta?.textContent || '').trim(),
        },
        word: {
          text: (word?.textContent || '').normalize('NFC').trim(),
          top: wordRect ? Number(wordRect.top.toFixed(1)) : 0,
          bottom: wordRect ? Number(wordRect.bottom.toFixed(1)) : 0,
          zIndex: wordStyle ? parseInt(wordStyle.zIndex || '0', 10) : 0,
          wrapZIndex: headingWrapStyle ? parseInt(headingWrapStyle.zIndex || '0', 10) : 0,
        },
        macro: {
          exists: Boolean(macro),
          display: macroStyle?.display ?? 'none',
          opacity: macroStyle ? parseFloat(macroStyle.opacity) : 0,
          left: macroRect ? Number(macroRect.left.toFixed(1)) : 0,
          right: macroRect ? Number(macroRect.right.toFixed(1)) : 0,
          width: macroRect ? Number(macroRect.width.toFixed(1)) : 0,
          height: macroRect ? Number(macroRect.height.toFixed(1)) : 0,
          imgComplete: Boolean(macroImg && macroImg.complete),
          imgNaturalWidth: macroImg?.naturalWidth ?? 0,
          imgSrc: macroImg?.currentSrc || macroImg?.getAttribute('src') || '',
        },
        pill: {
          exists: Boolean(pill),
          text: (pill?.textContent || '').trim(),
          top: pillRect ? Number(pillRect.top.toFixed(1)) : 0,
          bottom: pillRect ? Number(pillRect.bottom.toFixed(1)) : 0,
          left: pillRect ? Number(pillRect.left.toFixed(1)) : 0,
          right: pillRect ? Number(pillRect.right.toFixed(1)) : 0,
          height: pillRect ? Number(pillRect.height.toFixed(1)) : 0,
        },
        sets: {
          width: setsRect ? Number(setsRect.width.toFixed(1)) : 0,
          count: cards.length,
          cards,
        },
        clearance: {
          copyBottom: copyContentRect ? Number(copyContentRect.bottom.toFixed(1)) : null,
          copyBoxBottom: copyRect ? Number(copyRect.bottom.toFixed(1)) : null,
          autoplayTop: autoplayRect ? Number(autoplayRect.top.toFixed(1)) : null,
          autoplayExists: Boolean(autoplayEl),
        },
        brokenImgs,
      };
    });

    // Save Screenshot 01: WEEKEND EASE
    const shot01Path = path.join(AUDIT_DIR, '01-occasion-weekend-ease-1440.png');
    await page.screenshot({ path: shot01Path, fullPage: false, type: 'png' });

    // Evaluate Check 1: Light Header (.nav.is-light)
    {
      const colorRgb = parseRgb(weekendAudit.header.color);
      const bgRgb = parseRgb(weekendAudit.header.backgroundColor);
      const isDarkEspresso =
        Boolean(colorRgb) &&
        ((colorRgb.r === 28 && colorRgb.g === 20 && colorRgb.b === 16) ||
          (colorRgb.r === 43 && colorRgb.g === 32 && colorRgb.b === 25));
      const isTranslucentIvory =
        Boolean(bgRgb) &&
        Math.abs(bgRgb.r - 251) <= 2 &&
        Math.abs(bgRgb.g - 247) <= 2 &&
        Math.abs(bgRgb.b - 239) <= 2 &&
        bgRgb.a > 0.5 &&
        bgRgb.a < 1;
      const check1Ok =
        weekendAudit.header.exists &&
        weekendAudit.header.hasIsLight &&
        isDarkEspresso &&
        weekendAudit.header.beforeOpacity === 0 &&
        isTranslucentIvory &&
        weekendAudit.header.backgroundImage === 'none';

      recordCheck('CHECK 1', 'Light Header (.nav.is-light) on WEEKEND EASE', check1Ok, [
        `navThemeAttr=${weekendAudit.navThemeAttr}, hasIsLight=${weekendAudit.header.hasIsLight}`,
        `color=${weekendAudit.header.color} (darkEspresso=${isDarkEspresso}), backgroundColor=${weekendAudit.header.backgroundColor} (translucentIvory=${isTranslucentIvory})`,
        `::before opacity=${weekendAudit.header.beforeOpacity} (expected 0), backgroundImage=${weekendAudit.header.backgroundImage}`,
      ]);
    }

    // Evaluate Check 2: Enlarged Arch, Heading Overlap, Gold Rings, Macro Inset & Bottom Pill
    {
      const overlapPx = Number((weekendAudit.word.bottom - weekendAudit.arch.top).toFixed(1));
      const headingZ = Math.max(weekendAudit.word.zIndex, weekendAudit.word.wrapZIndex);
      const archZ = weekendAudit.arch.zIndex;
      const pillRelTop =
        weekendAudit.arch.height > 0
          ? Number(((weekendAudit.pill.top - weekendAudit.arch.top) / weekendAudit.arch.height).toFixed(3))
          : 0;
      const pillInsideArch =
        weekendAudit.pill.exists &&
        weekendAudit.pill.left >= weekendAudit.arch.left - 2 &&
        weekendAudit.pill.right <= weekendAudit.arch.right + 2 &&
        weekendAudit.pill.bottom <= weekendAudit.arch.bottom + 2 &&
        pillRelTop >= 0.8;

      const macroOk =
        weekendAudit.macro.exists &&
        weekendAudit.macro.display !== 'none' &&
        weekendAudit.macro.opacity >= 0.8 &&
        weekendAudit.macro.width >= 120 &&
        weekendAudit.macro.height >= 120 &&
        weekendAudit.macro.left < weekendAudit.arch.left &&
        weekendAudit.macro.imgComplete &&
        weekendAudit.macro.imgNaturalWidth > 0;

      const archSizeOk =
        weekendAudit.arch.width >= 330 &&
        weekendAudit.arch.height >= 450 &&
        weekendAudit.arch.radiusTL >= 180 &&
        weekendAudit.arch.radiusTR >= 180 &&
        weekendAudit.arch.imgComplete &&
        weekendAudit.arch.imgNaturalWidth > 0;

      const overlapOk = overlapPx >= 5 && overlapPx <= 32 && headingZ > archZ;

      const check2Ok = archSizeOk && overlapOk && weekendAudit.arch.ringCount >= 2 && macroOk && pillInsideArch;

      recordCheck('CHECK 2', 'Enlarged Arch, Heading Overlap, Gold Rings, Macro Inset & Try-On Pill', check2Ok, [
        `Arch bbox: ${weekendAudit.arch.width}x${weekendAudit.arch.height}px (>=330x450), topRadius=${weekendAudit.arch.radiusTL}/${weekendAudit.arch.radiusTR}px (>=180), rings=${weekendAudit.arch.ringCount}`,
        `Heading "${weekendAudit.word.text}": wordBottom=${weekendAudit.word.bottom}px, archTop=${weekendAudit.arch.top}px -> overlap=${overlapPx}px (target 5..32px), zIndex heading=${headingZ} > arch=${archZ}`,
        `MacroFabricInset: visible=${macroOk}, bbox=${weekendAudit.macro.width}x${weekendAudit.macro.height}px, left=${weekendAudit.macro.left} < archLeft=${weekendAudit.arch.left}, img=${weekendAudit.macro.imgNaturalWidth}px src=${weekendAudit.macro.imgSrc}`,
        `Try-On Pill "${weekendAudit.pill.text}": relTop=${(pillRelTop * 100).toFixed(1)}% (target >=80% = bottom 20%), insideArch=${pillInsideArch}`,
      ]);
    }

    // Evaluate Check 3: Rectangular 3:4 4-Card Gallery
    {
      const all4FramesValid =
        weekendAudit.sets.count === 4 &&
        weekendAudit.sets.cards.every(
          (c) =>
            c.radiusTL <= 14 &&
            c.radiusTR <= 14 &&
            c.aspectRatio >= 0.68 &&
            c.aspectRatio <= 0.82 &&
            c.imgComplete &&
            c.imgNaturalWidth > 0,
        );
      const all4TitlesValid =
        weekendAudit.sets.count === 4 &&
        weekendAudit.sets.cards.every(
          (c) => (c.webkitLineClamp === '2' || c.lineClamp === '2') && c.whiteSpace !== 'nowrap',
        );

      const check3Ok = weekendAudit.sets.width >= 390 && all4FramesValid && all4TitlesValid;

      recordCheck('CHECK 3', 'Rectangular 3:4 4-Card Gallery (#occSets)', check3Ok, [
        `#occSets width=${weekendAudit.sets.width}px (>=390), cards=${weekendAudit.sets.count}/4`,
        ...weekendAudit.sets.cards.map(
          (c) =>
            `  Card ${c.idx + 1}: "${c.titleText}" | ${c.frameWidth}x${c.frameHeight}px (ar=${c.aspectRatio}), radius=${c.radiusTL}px, natW=${c.imgNaturalWidth}, clamp=${c.webkitLineClamp || c.lineClamp}, ws=${c.whiteSpace}`,
        ),
      ]);
    }

    // Evaluate Check 4: Left Column & Lookbook Tour Clearance
    {
      const gapPx =
        weekendAudit.clearance.copyBottom !== null && weekendAudit.clearance.autoplayTop !== null
          ? Number((weekendAudit.clearance.autoplayTop - weekendAudit.clearance.copyBottom).toFixed(1))
          : null;
      const check4Ok =
        weekendAudit.clearance.autoplayExists &&
        weekendAudit.clearance.copyBottom !== null &&
        weekendAudit.clearance.autoplayTop !== null &&
        weekendAudit.clearance.copyBottom < weekendAudit.clearance.autoplayTop;

      recordCheck('CHECK 4', 'Left Copy Column vs LOOKBOOK TOUR Clearance', check4Ok, [
        `.occ__copy bottom=${weekendAudit.clearance.copyBottom}px, .autoplay top=${weekendAudit.clearance.autoplayTop}px, verticalGap=${gapPx}px (must be > 0)`,
      ]);
    }

    // =========================================================================
    // INTERACTION 1: Click 2nd thumbnail card in WEEKEND EASE
    // =========================================================================
    const initialArchSrc = weekendAudit.arch.imgSrc;
    const initialMetaText = weekendAudit.arch.metaText;
    const card2TitleExpected = weekendAudit.sets.cards[1]?.titleText || '';

    const card2Btn = page.locator('#occSets > li').nth(1).locator('button');
    await card2Btn.click();
    await page.mouse.move(14, 14, { steps: 3 });
    await page.waitForTimeout(950);
    await waitImagesLoaded(page);

    const card2State = await page.evaluate(() => {
      const archImg = document.querySelector('#occImg');
      const occMeta = document.querySelector('#occMeta');
      const macroImg = document.querySelector('[data-testid="occasion-macro-inset"] img');
      return {
        archSrc: archImg?.currentSrc || archImg?.getAttribute('src') || '',
        archLoaded: Boolean(archImg && archImg.complete && archImg.naturalWidth > 0),
        metaText: (occMeta?.textContent || '').trim(),
        macroSrc: macroImg?.currentSrc || macroImg?.getAttribute('src') || '',
        macroLoaded: Boolean(macroImg && macroImg.complete && macroImg.naturalWidth > 0),
      };
    });

    const shot02Path = path.join(AUDIT_DIR, '02-occasion-weekend-card2-1440.png');
    await page.screenshot({ path: shot02Path, fullPage: false, type: 'png' });

    const card2Ok =
      card2State.archLoaded &&
      card2State.macroLoaded &&
      card2State.archSrc !== initialArchSrc &&
      card2State.metaText !== initialMetaText &&
      (card2TitleExpected ? card2State.metaText.includes(card2TitleExpected) : true);

    recordCheck('CHECK 5', 'Card 2 Click Updates Arch Portrait, Macro & Active Title', card2Ok, [
      `Initial meta="${initialMetaText}" -> Card 2 meta="${card2State.metaText}"`,
      `Arch src changed=${card2State.archSrc !== initialArchSrc} (loaded=${card2State.archLoaded})`,
      `Macro img loaded=${card2State.macroLoaded} (${card2State.macroSrc})`,
    ]);

    // =========================================================================
    // INTERACTION 2: Switch to EVENING COUTURE (Dark Luxury Header Restored)
    // =========================================================================
    const eveningTab = page
      .locator('#occTabs button')
      .filter({ hasText: /EVENING COUTURE|Dạ Tiệc Tối/i })
      .first();
    await eveningTab.click();
    await page.mouse.move(14, 14, { steps: 3 });
    await page.waitForFunction(
      () => {
        const word = (document.querySelector('#occWord')?.textContent || '').normalize('NFC');
        return /Dạ Tiệc Tối/i.test(word);
      },
      undefined,
      { timeout: 12_000 },
    );
    await page.waitForTimeout(2100);
    await waitImagesLoaded(page);

    const eveningState = await page.evaluate(() => {
      const header = document.querySelector('header.nav, .nav');
      const headerStyle = header ? window.getComputedStyle(header) : null;
      const section = document.querySelector('#occasion');
      const word = (document.querySelector('#occWord')?.textContent || '').normalize('NFC').trim();
      const archImg = document.querySelector('#occImg');
      return {
        hasIsLight: Boolean(header?.classList.contains('is-light')),
        headerColor: headerStyle?.color ?? '',
        navThemeAttr: section?.getAttribute('data-nav-theme') ?? null,
        word,
        archLoaded: Boolean(archImg && archImg.complete && archImg.naturalWidth > 0),
      };
    });

    const shot03Path = path.join(AUDIT_DIR, '03-occasion-evening-dark-1440.png');
    await page.screenshot({ path: shot03Path, fullPage: false, type: 'png' });

    const eveningOk =
      !eveningState.hasIsLight &&
      eveningState.navThemeAttr === 'dark' &&
      /Dạ Tiệc Tối/i.test(eveningState.word) &&
      eveningState.archLoaded;

    recordCheck('CHECK 6', 'EVENING COUTURE Restores Dark Luxury Header', eveningOk, [
      `word="${eveningState.word}", navThemeAttr=${eveningState.navThemeAttr}, .nav.is-light=${eveningState.hasIsLight} (expected false), headerColor=${eveningState.headerColor}`,
    ]);

    // =========================================================================
    // INTERACTION 3: Switch back to WEEKEND EASE & Click `✦ THỬ ĐỒ AI` Pill
    // =========================================================================
    await weekendTab.click();
    await page.mouse.move(14, 14, { steps: 3 });
    await page.waitForFunction(
      () => {
        const word = (document.querySelector('#occWord')?.textContent || '').normalize('NFC');
        return /Cuối Tuần Thư Thái/i.test(word);
      },
      undefined,
      { timeout: 12_000 },
    );
    await page.waitForTimeout(1400);
    await waitImagesLoaded(page);

    const tryOnPill = page.locator('[data-testid="occasion-tryon-pill"]');
    await tryOnPill.waitFor({ state: 'visible', timeout: 10_000 });
    await tryOnPill.click();

    const modalLoc = page.locator('[data-testid="virtual-tryon-modal"]');
    await modalLoc.waitFor({ state: 'visible', timeout: 10_000 });
    // Wait for StorefrontShellOverlays lazy BFF catalog hydration to bind the silk shirt product cleanly
    await page
      .waitForFunction(
        () => {
          const modal = document.querySelector('[data-testid="virtual-tryon-modal"]');
          const txt = (modal?.textContent || '').normalize('NFC');
          return /Sơ Mi Lụa|Tơ Tằm/i.test(txt);
        },
        undefined,
        { timeout: 8000 },
      )
      .catch(() => {});
    await page.waitForTimeout(700);

    const modalState = await page.evaluate(() => {
      const modal = document.querySelector('[data-testid="virtual-tryon-modal"]');
      const header = document.querySelector('header.nav, .nav');
      const modalZ = modal ? parseInt(window.getComputedStyle(modal).zIndex || '0', 10) : 0;
      const headerZ = header ? parseInt(window.getComputedStyle(header).zIndex || '0', 10) : 0;
      const topEl = document.elementFromPoint(720, 28);
      const topInsideHeader = Boolean(header && topEl && header.contains(topEl));
      const topInsideModal = Boolean(modal && topEl && (modal === topEl || modal.contains(topEl)));
      const text = (modal?.textContent || '').normalize('NFC');
      const hasSilkShirtSelected = /Sơ Mi Lụa|Tơ Tằm/i.test(text);

      const visibleImgs = Array.from(document.querySelectorAll('img')).filter((im) => {
        const st = window.getComputedStyle(im);
        if (st.display === 'none' || st.visibility === 'hidden') return false;
        const r = im.getBoundingClientRect();
        const inModalOrOcc = Boolean(im.closest('[data-testid="virtual-tryon-modal"], #occasion'));
        const inViewport = r.bottom > 0 && r.top < window.innerHeight && r.right > 0 && r.left < window.innerWidth;
        const isLazyOffscreen = im.loading === 'lazy' && !inViewport && !inModalOrOcc;
        return !isLazyOffscreen;
      });
      const brokenImgs = visibleImgs
        .filter((im) => !im.complete || im.naturalWidth === 0)
        .map((im) => im.currentSrc || im.getAttribute('src') || '(no-src)');

      return {
        visible: Boolean(modal),
        modalZ,
        headerZ,
        topInsideHeader,
        topInsideModal,
        hasSilkShirtSelected,
        brokenImgs,
      };
    });

    const shot04Path = path.join(AUDIT_DIR, '04-occasion-tryon-modal-1440.png');
    await page.screenshot({ path: shot04Path, fullPage: false, type: 'png' });

    const allBrokenImgs = [...new Set([...weekendAudit.brokenImgs, ...modalState.brokenImgs])];
    const modalOk =
      modalState.visible &&
      modalState.modalZ > modalState.headerZ &&
      modalState.topInsideModal &&
      !modalState.topInsideHeader &&
      modalState.hasSilkShirtSelected;

    recordCheck('CHECK 7', 'Try-On Pill Opens Modal Above Header with Active Silk Shirt', modalOk, [
      `modalZ=${modalState.modalZ} > headerZ=${modalState.headerZ}, topInsideModal=${modalState.topInsideModal}, topInsideHeader=${modalState.topInsideHeader}`,
      `Active silk shirt selected in modal=${modalState.hasSilkShirtSelected}`,
      `Screenshots saved:`,
      `  - ${shot01Path} (${Math.round(fs.statSync(shot01Path).size / 1024)} KB)`,
      `  - ${shot02Path} (${Math.round(fs.statSync(shot02Path).size / 1024)} KB)`,
      `  - ${shot03Path} (${Math.round(fs.statSync(shot03Path).size / 1024)} KB)`,
      `  - ${shot04Path} (${Math.round(fs.statSync(shot04Path).size / 1024)} KB)`,
    ]);

    const hygieneOk =
      consoleErrors.length === 0 &&
      pageErrors.length === 0 &&
      failedHttp.length === 0 &&
      allBrokenImgs.length === 0;

    recordCheck('CHECK 8', 'Browser Hygiene (Zero Console/Page/HTTP Errors & Zero Broken Images)', hygieneOk, [
      `consoleErrors=${consoleErrors.length}, pageErrors=${pageErrors.length}, failedHttp=${failedHttp.length}, brokenImgs=${allBrokenImgs.length}`,
      ...consoleErrors.slice(0, 5).map((e) => `CONSOLE ERROR: ${e}`),
      ...pageErrors.slice(0, 5).map((e) => `PAGE ERROR: ${e}`),
      ...failedHttp.slice(0, 5).map((e) => `HTTP FAIL: ${e}`),
      ...allBrokenImgs.slice(0, 5).map((u) => `BROKEN IMG: ${u}`),
    ]);
  } finally {
    await cleanupAll();
    console.log('\n[CLEANUP] Browser, all services, storefront & local infra cleanly terminated.');
  }

  const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
  const passCount = results.filter((r) => r.ok).length;
  const failCount = results.length - passCount;

  console.log('\n========================================================================');
  console.log(` OCCASION OVERHAUL VERIFICATION SUMMARY  (${elapsedSec}s)`);
  console.log('------------------------------------------------------------------------');
  for (const r of results) {
    console.log(`  [${r.ok ? 'PASS' : 'FAIL'}] ${r.id}: ${r.title}`);
  }
  console.log('------------------------------------------------------------------------');
  console.log(`  Totals: PASS=${passCount}/${results.length} | FAIL=${failCount}`);
  console.log('========================================================================\n');

  if (failCount > 0 || passCount < 9) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('\n[FATAL] verify-occasion-overhaul crashed:', err instanceof Error ? err.stack || err.message : err);
  process.exitCode = 1;
});
