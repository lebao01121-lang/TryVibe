#!/usr/bin/env node
/**
 * Outfit Studio Luxury Overhaul Visual & Playwright Verification Suite
 * fashion-atelier-ai-platform (v3.1)
 *
 * Verifies #277 / #283 checklist end-to-end:
 *   1. Stack detection & process preservation:
 *      - NEVER kills pre-existing user IDE `./run` or Host Ollama (:11434).
 *      - Mode A (REUSE_ACTIVE_STACK): reuses live 3000/4000..4009 when already
 *        serving freshly built Outfit Studio & 23-product catalog.
 *      - Mode B (SHADOW_REBUILT_OVERLAY): when user's active `./run` is live on
 *        3000/4000/4002 with pre-overhaul in-memory builds, reuses live infra
 *        (6379/7700/9000/1025/8025/15672) and unchanged services (4001/4003/
 *        4004/4006..4009) while booting isolated rebuilt catalog (:4102),
 *        cart-outfit (:4105), bff (:4100), and storefront (:3100) cleanly.
 *      - Mode C (FRESH_LOCAL_STACK): when ports are free, boots local infra +
 *        full stack on 3000/4000..4009 and tears down ONLY spawned processes.
 *   2. Fresh data sync & API/Asset audit:
 *      - POST /v1/catalog/internal/reseed (200/201)
 *      - node infra/seeds/seed-demo-data.mjs + live inventory sync check for all
 *        23 products (including 3 new ACCESSORY products!)
 *      - Redis FLUSHALL + POST /api/revalidate (200)
 *      - Verifies GET /bff/v1/storefront/products?limit=32 returns >= 23
 *        products incl. `vi-cam-tay-clutch-champagne`,
 *        `khan-lua-hoa-tiet-tam-xuan`, `that-lung-da-khoa-dong` with RGBA alpha
 *        cutouts (`hasAlpha=true`, transparent corners) & valid packaging URLs.
 *   3. Playwright Real Chrome Audit (`1440x900` on `/phoi-do` + `/#build`, and
 *      `390x844` mobile on `/phoi-do`):
 *      - Check 1: Light header (.nav.is-light), zero "7 TẦNG"/"1 TẦNG", exact
 *        eyebrow "XƯỞNG PHỐI ĐỒ CÁ NHÂN · MIX & MATCH", `.outfit__seal` hidden.
 *      - Check 2: Default 3-piece preset `Dạ Tiệc Đỏ Vang` on gold mannequin,
 *        ComboUnlockBar 100% (-10%), 6 tabs, 3:4 cards, canonical XS..XL pills,
 *        loaded packaging thumbs, -4deg Dancing Script gift card ->
 *        `01-studio-default-preset-1440.png`.
 *      - Check 3: Handwritten gift note, `Đèn Tiệc` evening lighting, 3x
 *        OpticalFabricLoupe over dress center -> `02-studio-evening-loupe-1440.png`;
 *        back flip (`stage-flip-btn`) & restore.
 *      - Check 4: `Phụ kiện` tab (>=3 accessory 3:4 cards loaded), `Công Sở
 *        Thanh Lịch` preset (TOP+BOTTOM loaded, ONE_PIECE cleared) ->
 *        `03-studio-accessories-tab-1440.png`; `SizeGuideModal` save updates size.
 *      - Check 5: `✦ Ướm thử cả bộ AI` opens `[data-testid="virtual-tryon-modal"]`,
 *        `♡` Save/Share creates share link + toast, `THÊM CẢ BỘ VÀO GIỎ` runs
 *        0.9s box-close ritual + `POST /bff/v1/storefront/cart/outfit-bundle` ->
 *        `<QuickBagDrawer />` opens with bundle -> `04-studio-bag-drawer-1440.png`.
 *      - Check 6: Mobile `390x844` stacked layout + sticky bottom summary bar ->
 *        `05-studio-mobile-390.png`; Homepage `/#build` light header & preset.
 *      - Check 7: Zero console/page/HTTP errors & zero broken images.
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
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

const AUDIT_DIR =
  process.env.STUDIO_AUDIT_DIR ||
  'C:\\Users\\Admin\\.gemini\\antigravity\\brain\\d1783908-6521-4608-8b37-41aae3ee9a65\\scratch\\studio-audit';

const NEW_ACCESSORY_SLUGS = [
  'vi-cam-tay-clutch-champagne',
  'khan-lua-hoa-tiet-tam-xuan',
  'that-lung-da-khoa-dong',
];

const PACKAGING_CODES = [
  'tui-vai-linen-moc',
  'hop-lua-co-dien',
  'hop-qua-khac-ten-gold',
];

const CANONICAL_CLOTHING_SIZES = ['XS', 'S', 'M', 'L', 'XL'];

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

function isPortOpen(port, host = '127.0.0.1', timeoutMs = 450) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let settled = false;
    const finish = (open) => {
      if (settled) return;
      settled = true;
      sock.removeAllListeners();
      sock.destroy();
      resolve(open);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
    sock.connect(port, host);
  });
}

function cleanStalePgliteLocks(onlyNames = null) {
  const pgRoot = path.join(ROOT_DIR, '.local-pgdata');
  if (!fs.existsSync(pgRoot)) return 0;
  let removed = 0;
  for (const entry of fs.readdirSync(pgRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (onlyNames && !onlyNames.includes(entry.name)) continue;
    const pidFile = path.join(pgRoot, entry.name, 'postmaster.pid');
    if (fs.existsSync(pidFile)) {
      try {
        fs.rmSync(pidFile, { force: true });
        removed += 1;
      } catch {
        // ignore locked files owned by active processes
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

async function waitForHttp200(url, timeoutMs = 60_000, logs = []) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = '';
  while (Date.now() < deadline) {
    try {
      const res = await httpRequest(url, { timeoutMs: 3000 });
      if (res.status >= 200 && res.status < 300) return res;
      lastErr = `HTTP ${res.status}`;
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
    }
    await new Promise((r) => setTimeout(r, 350));
  }
  const tail = logs.join('').split(/\r?\n/).filter(Boolean).slice(-16).join('\n');
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

function normalizeUrl(raw, storefrontBase) {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) return trimmed;
  if (trimmed.startsWith('/')) return `${storefrontBase}${trimmed}`;
  return null;
}

async function verifyRgbaCutoutUrl(url) {
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
  const img = sharp(res.buffer);
  const meta = await img.metadata();
  if (!meta.width || !meta.height || meta.width < 120 || meta.height < 120) {
    return { ok: false, url, reason: `Too small (${meta.width}x${meta.height})` };
  }
  if (!meta.hasAlpha) {
    return { ok: false, url, reason: `hasAlpha=${meta.hasAlpha}` };
  }
  const { data, info } = await img.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const alphaAt = (x, y) => data[(y * info.width + x) * info.channels + 3];
  const corners = [
    alphaAt(0, 0),
    alphaAt(info.width - 1, 0),
    alphaAt(0, info.height - 1),
    alphaAt(info.width - 1, info.height - 1),
  ];
  const cornersTransparent = corners.every((a) => a <= 10);
  if (!cornersTransparent) {
    return { ok: false, url, reason: `Corners not transparent [${corners.join(',')}]` };
  }
  return {
    ok: true,
    url,
    format: meta.format,
    width: meta.width,
    height: meta.height,
    hasAlpha: meta.hasAlpha,
    corners,
  };
}

async function verifyRasterImageUrl(url) {
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
  if (!meta.width || !meta.height || meta.width < 100 || meta.height < 100) {
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

async function waitImagesLoaded(page, rootSelector = '#build') {
  await page
    .evaluate(async (sel) => {
      const scope = document.querySelector(sel) || document;
      const imgs = Array.from(scope.querySelectorAll('img')).filter((img) => {
        const st = window.getComputedStyle(img);
        return st.display !== 'none' && st.visibility !== 'hidden';
      });
      await Promise.all(
        imgs.map((img) => {
          if (img.complete) return Promise.resolve();
          return new Promise((r) => {
            img.addEventListener('load', r, { once: true });
            img.addEventListener('error', r, { once: true });
            setTimeout(r, 4000);
          });
        }),
      );
    }, rootSelector)
    .catch(() => {});
}

async function collectBrokenVisibleImages(page, scopeSelector = null) {
  return page.evaluate((sel) => {
    const scope = sel ? document.querySelector(sel) || document : document;
    const imgs = Array.from(scope.querySelectorAll('img')).filter((im) => {
      const st = window.getComputedStyle(im);
      if (st.display === 'none' || st.visibility === 'hidden' || parseFloat(st.opacity) === 0) return false;
      const r = im.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return false;
      const inBuild = Boolean(im.closest('#build, #order, [data-testid="virtual-tryon-modal"]'));
      const inViewport = r.bottom > 0 && r.top < window.innerHeight && r.right > 0 && r.left < window.innerWidth;
      const isLazyOffscreen = im.loading === 'lazy' && !inViewport && !inBuild;
      return !isLazyOffscreen;
    });
    return imgs
      .filter((im) => !im.complete || im.naturalWidth === 0)
      .map((im) => im.currentSrc || im.getAttribute('src') || '(no-src)');
  }, scopeSelector);
}

async function main() {
  const startedAt = Date.now();
  console.log('========================================================================');
  console.log(' fashion-atelier-ai-platform (v3.1) — Outfit Studio Luxury Overhaul Audit');
  console.log('========================================================================');

  const envVars = {
    ...process.env,
    ...loadDotEnv(path.join(ROOT_DIR, '.env')),
  };
  const internalSecret = envVars.INTERNAL_SERVICE_SECRET || 'Atelier_Internal_Svc_2026!';

  fs.mkdirSync(AUDIT_DIR, { recursive: true });

  const chromePath = findChromeExecutable();
  if (!chromePath) {
    throw new Error('System Chrome/Edge executable not found for Playwright verification.');
  }
  console.log(`[BROWSER] Headless Chromium binary: ${chromePath}`);

  // Detect pre-existing active stack (e.g., user's IDE `./run`) — NEVER kill it!
  const preExistingPorts = {};
  for (const p of [3000, 4000, 4001, 4002, 4003, 4004, 4005, 4006, 4007, 4008, 4009, 6379, 7700, 9000, 11434]) {
    preExistingPorts[p] = await isPortOpen(p);
  }
  const hasPreExistingStack =
    preExistingPorts[3000] &&
    preExistingPorts[4000] &&
    preExistingPorts[4002] &&
    preExistingPorts[4004] &&
    preExistingPorts[4005];
  console.log(
    `[DETECT] Pre-existing stack: ${hasPreExistingStack ? 'ACTIVE (preserving user ./run)' : 'NOT FULLY ACTIVE'} | Ollama :11434=${preExistingPorts[11434] ? 'ONLINE' : 'OFFLINE'}`,
  );

  // Determine whether pre-existing :3000 & :4002 are already running the rebuilt overhaul code
  let stackMode = 'FRESH_LOCAL_STACK';
  if (hasPreExistingStack) {
    let active3000HasOverhaul = false;
    let active4002Has23 = false;
    try {
      const htmlRes = await httpRequest('http://127.0.0.1:3000/phoi-do', { timeoutMs: 8000 });
      active3000HasOverhaul =
        htmlRes.status === 200 &&
        htmlRes.text.includes('ghost-mannequin-svg') &&
        htmlRes.text.includes('combo-unlock-bar');
    } catch {
      active3000HasOverhaul = false;
    }
    try {
      const reseedProbe = await httpRequest('http://127.0.0.1:4002/v1/catalog/internal/reseed', {
        method: 'POST',
        headers: { 'x-internal-secret': internalSecret },
        timeoutMs: 45_000,
      });
      if (reseedProbe.status >= 200 && reseedProbe.status < 300) {
        const prodProbe = await httpRequest('http://127.0.0.1:4002/v1/catalog/admin/products?pageSize=50', {
          timeoutMs: 10_000,
        });
        const pItems = unwrap(prodProbe.json)?.items ?? [];
        active4002Has23 =
          Array.isArray(pItems) &&
          pItems.length >= 23 &&
          NEW_ACCESSORY_SLUGS.every((slug) => pItems.some((p) => p.slug === slug));
      }
    } catch {
      active4002Has23 = false;
    }

    if (active3000HasOverhaul && active4002Has23) {
      stackMode = 'REUSE_ACTIVE_STACK';
    } else {
      stackMode = 'SHADOW_REBUILT_OVERLAY';
      console.log(
        `[DETECT] Pre-existing user ./run is running older in-memory code (3000_new=${active3000HasOverhaul}, 4002_23=${active4002Has23}).`,
      );
      console.log(
        '[DETECT] Preserving user ./run untouched and launching isolated freshly-built overlay (:4102, :4105, :4100, :3100)!',
      );
    }
  }
  console.log(`[STACK] Verification mode: ${stackMode}`);

  const AUTH_BASE = 'http://127.0.0.1:4001';
  const MEDIA_BASE = 'http://127.0.0.1:4003';
  const INVENTORY_BASE = 'http://127.0.0.1:4004';
  const ORDER_BASE = 'http://127.0.0.1:4006';
  const PAYMENT_BASE = 'http://127.0.0.1:4007';
  const NOTIFY_BASE = 'http://127.0.0.1:4008';
  const TRYON_BASE = 'http://127.0.0.1:4009';

  const CATALOG_PORT = stackMode === 'SHADOW_REBUILT_OVERLAY' ? 4102 : 4002;
  const CART_PORT = stackMode === 'SHADOW_REBUILT_OVERLAY' ? 4105 : 4005;
  const BFF_PORT = stackMode === 'SHADOW_REBUILT_OVERLAY' ? 4100 : 4000;
  const STOREFRONT_PORT = stackMode === 'SHADOW_REBUILT_OVERLAY' ? 3100 : 3000;

  const CATALOG_BASE = `http://127.0.0.1:${CATALOG_PORT}`;
  const CART_BASE = `http://127.0.0.1:${CART_PORT}`;
  const BFF_BASE = `http://127.0.0.1:${BFF_PORT}`;
  const STOREFRONT_BASE = `http://localhost:${STOREFRONT_PORT}`;

  const tempVerifyPgDirs = [];
  let localInfraHandle = null;
  const spawned = [];
  let browser = null;

  const cleanupAll = async () => {
    if (browser) {
      await browser.close().catch(() => {});
      browser = null;
    }
    for (const proc of spawned.reverse()) {
      killProcessTree(proc.child);
    }
    spawned.length = 0;
    if (localInfraHandle) {
      await localInfraHandle.stop();
      localInfraHandle = null;
    }
    for (const dirPath of tempVerifyPgDirs) {
      try {
        if (fs.existsSync(dirPath)) {
          fs.rmSync(dirPath, { recursive: true, force: true });
        }
      } catch {
        // ignore best-effort cleanup
      }
    }
    if (stackMode === 'FRESH_LOCAL_STACK') {
      cleanStalePgliteLocks();
    }
  };

  process.once('SIGINT', () => cleanupAll().finally(() => process.exit(130)));
  process.once('SIGTERM', () => cleanupAll().finally(() => process.exit(143)));

  try {
    // Only clean stale PGlite locks for directories NOT owned by a running ./run
    if (stackMode === 'FRESH_LOCAL_STACK') {
      const removedLocks = cleanStalePgliteLocks();
      if (removedLocks > 0) {
        console.log(`[CLEANUP] Removed ${removedLocks} stale PGlite postmaster.pid lock file(s).`);
      }
      localInfraHandle = await startLocalInfraIfNeeded(envVars);
      console.log(`[INFRA] Active mode: INFRA_MODE=${localInfraHandle.infraMode}`);
    } else {
      console.log('[INFRA] Reusing live infra on :6379 / :7700 / :9000 / :1025 / :8025 / :15672.');
    }

    const revalidateSecret = envVars.REVALIDATE_SECRET || 'Atelier_Isr_Revalidate_2026!';

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
      STOREFRONT_URL: STOREFRONT_BASE,
      REVALIDATE_SECRET: revalidateSecret,
      INTERNAL_SERVICE_SECRET: internalSecret,
      CORS_ALLOWED_ORIGINS: [
        'http://localhost:3000',
        'http://127.0.0.1:3000',
        `http://localhost:${STOREFRONT_PORT}`,
        `http://127.0.0.1:${STOREFRONT_PORT}`,
      ].join(','),
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

    const spawnNodeService = (name, relDir, portEnvKey, port, extraEnv = {}) => {
      const dir = path.join(ROOT_DIR, relDir);
      const entry = path.join(dir, 'dist', 'main.js');
      if (!fs.existsSync(entry)) throw new Error(`Missing built entrypoint: ${entry}`);
      const logs = [];
      const child = spawn(process.execPath, [entry], {
        cwd: dir,
        env: { ...serviceEnv, PORT: String(port), [portEnvKey]: String(port), ...extraEnv },
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

    const spawnStorefront = (port) => {
      const sfDir = path.join(ROOT_DIR, 'apps', 'storefront');
      const nextBin = path.join(sfDir, 'node_modules', 'next', 'dist', 'bin', 'next');
      if (!fs.existsSync(nextBin)) throw new Error(`Missing next binary: ${nextBin}`);
      const logs = [];
      const child = spawn(process.execPath, [nextBin, 'start', '-p', String(port)], {
        cwd: sfDir,
        env: {
          ...serviceEnv,
          NODE_ENV: 'production',
          PORT: String(port),
          STOREFRONT_PORT: String(port),
          NEXT_PUBLIC_BFF_URL: BFF_BASE,
          BFF_URL: BFF_BASE,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      child.stdout?.on('data', (d) => logs.push(d.toString('utf8')));
      child.stderr?.on('data', (d) => logs.push(d.toString('utf8')));
      spawned.push({ name: `apps/storefront:${port}`, child, logs });
      return { child, logs };
    };

    if (stackMode === 'FRESH_LOCAL_STACK') {
      console.log('\n--- Booting fresh local stack (4001..4009, 4000, 3000) ---');
      const waitList = [];
      const maybeSpawn = (port, name, relDir, envKey) => {
        if (preExistingPorts[port]) {
          console.log(`  [REUSE] ${name}:${port} already running`);
          return;
        }
        const proc = spawnNodeService(name, relDir, envKey, port);
        waitList.push(waitForHttp200(`http://127.0.0.1:${port}/health`, 50_000, proc.logs));
      };
      maybeSpawn(4001, 'auth-customer', 'services/auth-customer', 'AUTH_CUSTOMER_PORT');
      maybeSpawn(4003, 'media-pipeline', 'services/media-pipeline', 'MEDIA_PIPELINE_PORT');
      maybeSpawn(4004, 'inventory', 'services/inventory', 'INVENTORY_PORT');
      maybeSpawn(4006, 'order-rma', 'services/order-rma', 'ORDER_RMA_PORT');
      maybeSpawn(4007, 'payment-promo', 'services/payment-promo', 'PAYMENT_PROMO_PORT');
      maybeSpawn(4008, 'notify-review', 'services/notify-review', 'NOTIFY_REVIEW_PORT');
      await Promise.all(waitList);

      const wait2 = [];
      maybeSpawn(4002, 'catalog-lookbook', 'services/catalog-lookbook', 'CATALOG_LOOKBOOK_PORT');
      maybeSpawn(4005, 'cart-outfit', 'services/cart-outfit', 'CART_OUTFIT_PORT');
      if (!preExistingPorts[4009]) {
        const tryonProc = spawnPythonTryOn();
        wait2.push(waitForHttp200(`${TRYON_BASE}/health`, 60_000, tryonProc.logs));
      }
      await Promise.all([
        waitForHttp200(`${CATALOG_BASE}/health`, 90_000),
        waitForHttp200(`${CART_BASE}/health`, 50_000),
        ...wait2,
      ]);
      console.log('  [UP] Microservices 4001..4009 online');
    } else if (stackMode === 'SHADOW_REBUILT_OVERLAY') {
      console.log('\n--- Booting isolated rebuilt overlay (:4102, :4105, :4100, :3100) ---');
      const verifyCatDir = path.join(ROOT_DIR, '.local-pgdata', 'catalog_db_verify');
      const verifyCartDir = path.join(ROOT_DIR, '.local-pgdata', 'cart_db_verify');
      for (const d of [verifyCatDir, verifyCartDir]) {
        if (fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true });
        tempVerifyPgDirs.push(d);
      }

      const catProc = spawnNodeService('catalog-lookbook-verify', 'services/catalog-lookbook', 'CATALOG_LOOKBOOK_PORT', CATALOG_PORT, {
        CATALOG_DATABASE_URL: 'postgresql://svc_catalog:Atelier_Cat2026!@127.0.0.1:5432/catalog_db_verify',
      });
      await waitForHttp200(`${CATALOG_BASE}/health`, 120_000, catProc.logs);
      console.log(`  [UP] rebuilt catalog-lookbook:${CATALOG_PORT}`);

      const cartProc = spawnNodeService('cart-outfit-verify', 'services/cart-outfit', 'CART_OUTFIT_PORT', CART_PORT, {
        CART_DATABASE_URL: 'postgresql://svc_cart:Atelier_Cart2026!@127.0.0.1:5432/cart_db_verify',
        CATALOG_SERVICE_URL: CATALOG_BASE,
        INVENTORY_SERVICE_URL: INVENTORY_BASE,
      });
      await waitForHttp200(`${CART_BASE}/health`, 50_000, cartProc.logs);
      console.log(`  [UP] isolated cart-outfit:${CART_PORT}`);
    }

    // =========================================================================
    // DATA SYNC: Reseed Catalog, Seed Demo Data + Inventory Stock, Redis Flush
    // =========================================================================
    console.log(`  [SEED] Calling POST ${CATALOG_BASE}/v1/catalog/internal/reseed ...`);
    const reseedRes = await httpRequest(`${CATALOG_BASE}/v1/catalog/internal/reseed`, {
      method: 'POST',
      headers: { 'x-internal-secret': internalSecret },
      timeoutMs: 120_000,
    });
    console.log(`  [SEED] Catalog reseed HTTP ${reseedRes.status}`);

    // Run infra/seeds/seed-demo-data.mjs when catalog is on canonical :4002;
    // in SHADOW_REBUILT_OVERLAY mode (:4002 is user's pre-overhaul ./run), execute
    // the exact same catalog->inventory sync against rebuilt :4102 so we never kill ./run.
    const seedRelPath = 'infra/seeds/seed-demo-data.mjs';
    if (stackMode !== 'SHADOW_REBUILT_OVERLAY') {
      console.log(`  [SEED] Running node ${seedRelPath} ...`);
      const seedRun = await runNodeScript(seedRelPath, serviceEnv, 120_000);
      if (!seedRun.ok) {
        throw new Error(`${seedRelPath} failed (code=${seedRun.code}):\n${seedRun.stderr || seedRun.stdout}`);
      }
      console.log(`  [SEED] ${seedRelPath} completed (exit 0).`);
    } else {
      console.log('  [SEED] SHADOW_REBUILT_OVERLAY active (:4002 owned by pre-overhaul ./run); syncing all 23 rebuilt products directly from :4102 -> inventory :4004.');
    }

    // Explicitly verify & sync all 23 products' SKUs into live inventory (:4004)
    const adminProdsRes = await httpRequest(`${CATALOG_BASE}/v1/catalog/admin/products?pageSize=50`, {
      timeoutMs: 15_000,
    });
    const adminProducts = unwrap(adminProdsRes.json)?.items ?? [];
    const allCatalogSkus = [];
    for (const p of adminProducts) {
      for (const v of p.variants ?? []) {
        for (const s of v.skus ?? []) {
          allCatalogSkus.push({
            skuId: s.id,
            skuCode: s.skuCode,
            productId: p.id,
            variantId: v.id,
            sizeCode: s.sizeCode,
            costPriceVnd: s.costPriceVnd ?? 0,
            supplierId: s.supplierId ?? null,
          });
        }
      }
    }
    const syncInvRes = await httpRequest(`${INVENTORY_BASE}/v1/inventory/internal/sync-catalog-skus`, {
      method: 'POST',
      headers: { 'x-internal-secret': internalSecret },
      body: { skus: allCatalogSkus },
      timeoutMs: 20_000,
    });
    console.log(`  [INVENTORY] Synced ${allCatalogSkus.length} SKUs across ${adminProducts.length} products -> HTTP ${syncInvRes.status}`);

    // Check real stock availability for the 3 new accessory products
    const accessoryProductsAdmin = adminProducts.filter((p) => NEW_ACCESSORY_SLUGS.includes(p.slug));
    const accessorySkuIds = [];
    for (const p of accessoryProductsAdmin) {
      for (const v of p.variants ?? []) {
        for (const s of v.skus ?? []) {
          accessorySkuIds.push(s.id);
        }
      }
    }
    let accessoryStockInStockCount = 0;
    let accessoryMinQty = 0;
    if (accessorySkuIds.length > 0) {
      const availRes = await httpRequest(`${INVENTORY_BASE}/v1/inventory/availability/batch`, {
        method: 'POST',
        body: { skuIds: accessorySkuIds },
        timeoutMs: 15_000,
      });
      const itemsMap = unwrap(availRes.json)?.items ?? {};
      const qtys = accessorySkuIds.map((id) => Number(itemsMap[id]?.availableQty ?? 0));
      accessoryStockInStockCount = qtys.filter((q) => q >= 10).length;
      accessoryMinQty = qtys.length > 0 ? Math.min(...qtys) : 0;
    }

    await flushAllRedis(envVars);
    console.log('  [CACHE] Redis FLUSHALL complete.');

    // Boot BFF & Storefront if needed (FRESH_LOCAL_STACK or SHADOW_REBUILT_OVERLAY)
    if (stackMode === 'FRESH_LOCAL_STACK') {
      if (!preExistingPorts[4000]) {
        const bffProc = spawnNodeService('bff', 'apps/bff', 'BFF_PORT', BFF_PORT);
        await waitForHttp200(`${BFF_BASE}/health`, 50_000, bffProc.logs);
        console.log(`  [UP] apps/bff:${BFF_PORT}`);
      }
      if (!preExistingPorts[3000]) {
        const fetchCacheDir = path.join(ROOT_DIR, 'apps', 'storefront', '.next', 'cache', 'fetch-cache');
        if (fs.existsSync(fetchCacheDir)) {
          fs.rmSync(fetchCacheDir, { recursive: true, force: true });
        }
        const sfProc = spawnStorefront(STOREFRONT_PORT);
        await waitForHttp200(`http://127.0.0.1:${STOREFRONT_PORT}/phoi-do`, 50_000, sfProc.logs);
        console.log(`  [UP] apps/storefront:${STOREFRONT_PORT}`);
      }
    } else if (stackMode === 'SHADOW_REBUILT_OVERLAY') {
      const bffProc = spawnNodeService('bff-verify', 'apps/bff', 'BFF_PORT', BFF_PORT, {
        CATALOG_SERVICE_URL: CATALOG_BASE,
        CART_OUTFIT_SERVICE_URL: CART_BASE,
        CART_SERVICE_URL: CART_BASE,
        STOREFRONT_URL: STOREFRONT_BASE,
      });
      await waitForHttp200(`${BFF_BASE}/health`, 50_000, bffProc.logs);
      console.log(`  [UP] isolated apps/bff:${BFF_PORT}`);

      const sfProc = spawnStorefront(STOREFRONT_PORT);
      await waitForHttp200(`http://127.0.0.1:${STOREFRONT_PORT}/phoi-do`, 50_000, sfProc.logs);
      console.log(`  [UP] rebuilt apps/storefront:${STOREFRONT_PORT}`);
    }

    const revalRes = await httpRequest(`${STOREFRONT_BASE}/api/revalidate`, {
      method: 'POST',
      headers: { 'x-revalidate-secret': revalidateSecret },
      body: { tags: ['storefront', 'rack', 'products', 'occasions'], paths: ['/', '/phoi-do', '/bo-suu-tap'] },
      timeoutMs: 15_000,
    });
    console.log(`  [ISR] POST ${STOREFRONT_BASE}/api/revalidate HTTP ${revalRes.status}`);

    // =========================================================================
    // API & MEDIA CHECK: 23 Products, 3 RGBA Accessories, Real Packaging URLs
    // =========================================================================
    {
      const [prodsRes, bootRes] = await Promise.all([
        httpRequest(`${BFF_BASE}/bff/v1/storefront/products?limit=32`, { timeoutMs: 15_000 }),
        httpRequest(`${BFF_BASE}/bff/v1/storefront/bootstrap`, { timeoutMs: 15_000 }),
      ]);
      const prodsPayload = unwrap(prodsRes.json) ?? {};
      const productList = Array.isArray(prodsPayload)
        ? prodsPayload
        : Array.isArray(prodsPayload.items)
          ? prodsPayload.items
          : Array.isArray(prodsPayload.products)
            ? prodsPayload.products
            : [];

      const bootData = unwrap(bootRes.json) ?? {};
      const packagingOptions = Array.isArray(bootData.packagingOptions) ? bootData.packagingOptions : [];

      const foundAccessories = NEW_ACCESSORY_SLUGS.map((slug) =>
        productList.find((p) => p.slug === slug) || null,
      );
      const missingSlugs = NEW_ACCESSORY_SLUGS.filter((slug, idx) => !foundAccessories[idx]);

      const cutoutChecks = [];
      for (const acc of foundAccessories) {
        if (!acc) continue;
        const v0 = acc.variants?.[0];
        const rawUrl =
          acc.tryonFlatAssetUrl ||
          v0?.studioLayerUrl ||
          v0?.tryonFlatPreviewUrl ||
          v0?.rackFrontUrl ||
          v0?.rackCutout2x3Url ||
          null;
        const norm = normalizeUrl(rawUrl, STOREFRONT_BASE);
        if (!norm) {
          cutoutChecks.push({ ok: false, slug: acc.slug, url: String(rawUrl), reason: 'Missing cutout URL' });
        } else {
          const check = await verifyRgbaCutoutUrl(norm);
          cutoutChecks.push({ ...check, slug: acc.slug });
        }
      }

      const packagingChecks = [];
      for (const pkg of packagingOptions) {
        const rawUrl = pkg.imageUrl || pkg.frontAssetUrl || pkg.backAssetUrl || `/packaging/${pkg.code}.webp`;
        const norm = normalizeUrl(rawUrl, STOREFRONT_BASE);
        if (!norm) {
          packagingChecks.push({ ok: false, code: pkg.code, url: String(rawUrl), reason: 'Missing packaging URL' });
        } else {
          const check = await verifyRasterImageUrl(norm);
          packagingChecks.push({ ...check, code: pkg.code });
        }
      }

      const allCutoutsOk = cutoutChecks.length === 3 && cutoutChecks.every((c) => c.ok);
      const allPackagingOk =
        packagingOptions.length >= 3 &&
        PACKAGING_CODES.every((code) => packagingOptions.some((p) => p.code === code)) &&
        packagingChecks.every((c) => c.ok);
      const allAccessoryStockOk =
        accessorySkuIds.length > 0 && accessoryStockInStockCount === accessorySkuIds.length;

      const apiOk =
        reseedRes.status >= 200 &&
        reseedRes.status < 300 &&
        syncInvRes.status >= 200 &&
        syncInvRes.status < 300 &&
        revalRes.status === 200 &&
        prodsRes.status === 200 &&
        bootRes.status === 200 &&
        productList.length >= 23 &&
        missingSlugs.length === 0 &&
        allCutoutsOk &&
        allPackagingOk &&
        allAccessoryStockOk;

      recordCheck('API SYNC', 'Reseed, Inventory Sync, Redis Flush, 23 Products (3 RGBA Accessories) & Real Packaging', apiOk, [
        `Stack mode=${stackMode} | Reseed HTTP=${reseedRes.status} | InvSync HTTP=${syncInvRes.status} | Revalidate HTTP=${revalRes.status}`,
        `GET /bff/v1/storefront/products?limit=32 -> ${productList.length} products (>=23), missingAccessories=${missingSlugs.length}`,
        `Accessory SKU stock (>=10): ${accessoryStockInStockCount}/${accessorySkuIds.length} SKUs (minQty=${accessoryMinQty})`,
        ...cutoutChecks.map((c) =>
          c.ok
            ? `  RGBA Cutout [${c.slug}]: ${c.format} ${c.width}x${c.height} hasAlpha=${c.hasAlpha} corners=[${c.corners.join(',')}] (${c.url})`
            : `  RGBA FAIL [${c.slug}]: ${c.reason} (${c.url})`,
        ),
        ...packagingChecks.map((c) =>
          c.ok
            ? `  Packaging [${c.code}]: ${c.format} ${c.width}x${c.height} (${c.url})`
            : `  Packaging FAIL [${c.code}]: ${c.reason} (${c.url})`,
        ),
      ]);
    }

    // =========================================================================
    // PLAYWRIGHT REAL CHROME AUDIT (`1440x900` on `/phoi-do` & `/#build`, `390x844` mobile)
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

    const consoleErrors = [];
    const pageErrors = [];
    const failedHttp = [];
    const allBrokenImgs = new Set();

    const attachDiagnosticsAndRouting = async (context, page, tag = '') => {
      const prefix = tag ? `[${tag}] ` : '';
      if (stackMode === 'SHADOW_REBUILT_OVERLAY') {
        // Transparently route client-side baked `localhost:4000/bff/**` calls to isolated rebuilt BFF (`:4100`)
        await context.route(/^http:\/\/(localhost|127\.0\.0\.1):4000\/bff\/.*/, async (route) => {
          const targetUrl = route
            .request()
            .url()
            .replace(/^http:\/\/(localhost|127\.0\.0\.1):4000/, BFF_BASE);
          try {
            const response = await route.fetch({ url: targetUrl });
            await route.fulfill({ response });
          } catch (err) {
            await route.abort();
            failedHttp.push(`${prefix}ROUTE_ERR ${targetUrl}: ${err instanceof Error ? err.message : String(err)}`);
          }
        });
      }

      page.on('console', (msg) => {
        if (msg.type() === 'error') {
          consoleErrors.push(`${prefix}${msg.text()}`);
        }
      });
      page.on('pageerror', (err) => {
        pageErrors.push(`${prefix}${err instanceof Error ? err.message : String(err)}`);
      });
      page.on('response', (res) => {
        if (res.status() >= 400) {
          failedHttp.push(`${prefix}${res.status()} ${res.url()}`);
        }
      });
    };

    // -------------------------------------------------------------------------
    // DESKTOP 1440x900 ON `/phoi-do`
    // -------------------------------------------------------------------------
    const desktopContext = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 1,
    });
    const page = await desktopContext.newPage();
    await attachDiagnosticsAndRouting(desktopContext, page, 'desktop:/phoi-do');

    await page.goto(`${STOREFRONT_BASE}/phoi-do`, { waitUntil: 'networkidle', timeout: 45_000 });
    await page.evaluate(() => document.fonts?.ready);
    await page.waitForTimeout(900);
    await waitImagesLoaded(page, '#build');

    // CHECK 1: Language, Light Header (.nav.is-light, dark #1C1410, ::before opacity 0), Seal Hidden
    const check1Data = await page.evaluate(() => {
      const header = document.querySelector('header.nav, .nav');
      const headerStyle = header ? window.getComputedStyle(header) : null;
      const headerBeforeStyle = header ? window.getComputedStyle(header, '::before') : null;
      const buildEl = document.querySelector('#build');
      const buildText = (buildEl?.textContent || '').normalize('NFC');
      const eyebrow = (buildEl?.querySelector('.eyebrow')?.textContent || '').normalize('NFC').trim();
      const seal = document.querySelector('.outfit__seal');
      const pkgBack = document.querySelector('.outfit__pkg-back');
      const pkgFront = document.querySelector('.outfit__pkg-front');
      const styleOf = (el) => {
        if (!el) return null;
        const st = window.getComputedStyle(el);
        return { visibility: st.visibility, opacity: st.opacity, display: st.display };
      };
      return {
        hasIsLight: Boolean(header?.classList.contains('is-light')),
        headerColor: headerStyle?.color ?? '',
        headerBeforeOpacity: headerBeforeStyle ? parseFloat(headerBeforeStyle.opacity) : -1,
        has7Tang: /7\s*TẦNG/i.test(buildText),
        has1Tang: /1\s*TẦNG/i.test(buildText),
        eyebrow,
        seal: styleOf(seal),
        pkgBack: styleOf(pkgBack),
        pkgFront: styleOf(pkgFront),
      };
    });

    const isStrictlyHidden = (st) =>
      Boolean(st) && (st.visibility === 'hidden' || parseFloat(st.opacity) === 0 || st.display === 'none');
    const check1Ok =
      check1Data.hasIsLight &&
      check1Data.headerColor === 'rgb(28, 20, 16)' &&
      check1Data.headerBeforeOpacity === 0 &&
      !check1Data.has7Tang &&
      !check1Data.has1Tang &&
      check1Data.eyebrow === 'XƯỞNG PHỐI ĐỒ CÁ NHÂN · MIX & MATCH' &&
      isStrictlyHidden(check1Data.seal) &&
      isStrictlyHidden(check1Data.pkgBack) &&
      isStrictlyHidden(check1Data.pkgFront);

    recordCheck('CHECK 1', 'Luxury Language, Light Header (.nav.is-light) & Wax Seal Strictly Hidden', check1Ok, [
      `.nav.is-light=${check1Data.hasIsLight}, color=${check1Data.headerColor}, ::before opacity=${check1Data.headerBeforeOpacity}, eyebrow="${check1Data.eyebrow}"`,
      `Forbidden copy: has7Tang=${check1Data.has7Tang}, has1Tang=${check1Data.has1Tang}`,
      `.outfit__seal=${JSON.stringify(check1Data.seal)}, .outfit__pkg-back=${JSON.stringify(check1Data.pkgBack)}, .outfit__pkg-front=${JSON.stringify(check1Data.pkgFront)}`,
    ]);

    // CHECK 2: Default 3-Piece Preset, Gold Mannequin, 6 Tabs, 3:4 Cards, Canonical Sizes, -4deg Gift Card
    const check2Data = await page.evaluate(() => {
      const mannequin = document.querySelector('[data-testid="ghost-mannequin-svg"]');
      const mannequinRect = mannequin?.getBoundingClientRect() ?? null;
      const presetBtn = document.querySelector('[data-testid="preset-evening-burgundy"]');
      const stageLayers = Array.from(document.querySelectorAll('#bStage [data-outfit-layer]')).map((el) =>
        el.getAttribute('data-outfit-layer'),
      );
      const comboBar = document.querySelector('[data-testid="combo-unlock-bar"]');
      const comboPct = comboBar?.getAttribute('data-combo-pct') ?? '';
      const comboText = (comboBar?.textContent || '').normalize('NFC').trim();

      const tabIds = [
        'studio-tab-ALL',
        'studio-tab-TOP',
        'studio-tab-BOTTOM',
        'studio-tab-ONE_PIECE',
        'studio-tab-OUTERWEAR',
        'studio-tab-ACCESSORY',
      ];
      const presentTabs = tabIds.filter((id) => Boolean(document.querySelector(`[data-testid="${id}"]`)));

      // Check 3:4 cards in left wardrobe grid
      const cards = Array.from(document.querySelectorAll('[data-testid^="studio-product-card-"]'));
      const sampleCards = cards.slice(0, 6).map((card) => {
        const frame = card.querySelector('[role="button"]');
        const img = card.querySelector('img');
        const r = frame?.getBoundingClientRect();
        return {
          slug: card.getAttribute('data-testid')?.replace('studio-product-card-', ''),
          width: r ? Number(r.width.toFixed(1)) : 0,
          height: r ? Number(r.height.toFixed(1)) : 0,
          aspectRatio: r && r.height > 0 ? Number((r.width / r.height).toFixed(3)) : 0,
          imgLoaded: Boolean(img && img.complete && img.naturalWidth > 0),
          naturalWidth: img?.naturalWidth ?? 0,
        };
      });

      // Check canonical size pills in right-column item cards
      const sizeGroups = Array.from(document.querySelectorAll('[data-testid^="studio-size-pills-"]')).map((el) => {
        const slot = el.getAttribute('data-testid')?.replace('studio-size-pills-', '') || '';
        const pills = Array.from(el.querySelectorAll('button[data-size-code]')).map((b) =>
          (b.getAttribute('data-size-code') || b.textContent || '').trim().toUpperCase(),
        );
        return { slot, pills };
      });

      // Check packaging thumbnails
      const pkgBtns = Array.from(document.querySelectorAll('[data-testid^="studio-packaging-"]'));
      const pkgThumbs = pkgBtns.map((btn) => {
        const img = btn.querySelector('img');
        return {
          code: btn.getAttribute('data-testid')?.replace('studio-packaging-', ''),
          complete: Boolean(img?.complete),
          naturalWidth: img?.naturalWidth ?? 0,
          src: img?.currentSrc || img?.getAttribute('src') || '',
        };
      });

      // Check -4deg tilted Dancing Script gift card
      const giftCard = document.querySelector('[data-testid="studio-gift-card"]');
      const giftPaper = giftCard?.querySelector('[style*="rotate(-4deg)"]') ?? null;
      const giftPaperStyle = giftPaper ? window.getComputedStyle(giftPaper) : null;
      const giftTextarea = document.querySelector('[data-testid="studio-gift-note-input"]');
      const giftTextareaStyle = giftTextarea ? window.getComputedStyle(giftTextarea) : null;
      const harmonyBanner = document.querySelector('[data-testid="stylist-harmony-banner"]');
      const harmonyRect = harmonyBanner?.getBoundingClientRect() ?? null;

      let paperRotationDeg = null;
      if (giftPaperStyle?.transform && giftPaperStyle.transform.startsWith('matrix(')) {
        const vals = giftPaperStyle.transform
          .replace(/^matrix\(|\)$/g, '')
          .split(',')
          .map((v) => parseFloat(v.trim()));
        if (vals.length >= 2 && !Number.isNaN(vals[0]) && !Number.isNaN(vals[1])) {
          paperRotationDeg = Number(((Math.atan2(vals[1], vals[0]) * 180) / Math.PI).toFixed(2));
        }
      }

      return {
        mannequinVisible: Boolean(mannequinRect && mannequinRect.width > 60 && mannequinRect.height > 150),
        presetActive: presetBtn?.getAttribute('aria-pressed') === 'true',
        stageLayers,
        comboPct,
        comboText,
        presentTabsCount: presentTabs.length,
        harmonyBannerVisible: Boolean(harmonyRect && harmonyRect.width > 120 && harmonyRect.height >= 24),
        harmonyBannerText: (harmonyBanner?.textContent || '').normalize('NFC').replace(/\s+/g, ' ').trim(),
        totalCardsRendered: cards.length,
        sampleCards,
        sizeGroups,
        pkgThumbs,
        giftCardExists: Boolean(giftCard && giftPaper && giftTextarea),
        paperRotationDeg,
        giftFontFamily: giftTextareaStyle?.fontFamily ?? '',
      };
    });

    // Verify StylistHarmonyBanner toggles aria-pressed cleanly and restore
    const harmonyLoc = page.locator('[data-testid="stylist-harmony-banner"]');
    await harmonyLoc.click();
    await page.waitForTimeout(150);
    const harmonyPressedOn = (await harmonyLoc.getAttribute('aria-pressed')) === 'true';
    await harmonyLoc.click();
    await page.waitForTimeout(150);

    for (const u of await collectBrokenVisibleImages(page, '#build')) allBrokenImgs.add(u);

    // Frame full 3-column Studio cleanly at top (InnerPageFrame pt-24 clears light header)
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    await page.waitForTimeout(300);
    const shot01Path = path.join(AUDIT_DIR, '01-studio-default-preset-1440.png');
    await page.screenshot({ path: shot01Path, fullPage: false, type: 'png' });

    const clothingSizeGroups = check2Data.sizeGroups.filter((g) => g.slot !== 'ACCESSORY');
    const canonicalSizesOk =
      clothingSizeGroups.length >= 2 &&
      clothingSizeGroups.every(
        (g) => JSON.stringify(g.pills) === JSON.stringify(CANONICAL_CLOTHING_SIZES),
      );
    const cards3x4Ok =
      check2Data.totalCardsRendered >= 23 &&
      check2Data.sampleCards.every(
        (c) => c.aspectRatio >= 0.68 && c.aspectRatio <= 0.82 && c.imgLoaded && c.naturalWidth > 0,
      );
    const pkgThumbsOk =
      check2Data.pkgThumbs.length >= 3 &&
      check2Data.pkgThumbs.every((t) => t.complete && t.naturalWidth > 0);
    const giftCardOk =
      check2Data.giftCardExists &&
      check2Data.paperRotationDeg !== null &&
      Math.abs(check2Data.paperRotationDeg - -4) <= 0.5 &&
      /dancing|cursive/i.test(check2Data.giftFontFamily);

    const check2Ok =
      check2Data.mannequinVisible &&
      check2Data.presetActive &&
      check2Data.stageLayers.length === 3 &&
      check2Data.comboPct === '100' &&
      check2Data.comboText.includes('-10%') &&
      check2Data.presentTabsCount === 6 &&
      check2Data.harmonyBannerVisible &&
      harmonyPressedOn &&
      cards3x4Ok &&
      canonicalSizesOk &&
      pkgThumbsOk &&
      giftCardOk;

    recordCheck('CHECK 2', 'Default 3-Piece Preset, Gold Mannequin, 6 Tabs, Harmony Banner, 3:4 Cards, Canonical Sizes & -4deg Gift Card', check2Ok, [
      `Mannequin visible=${check2Data.mannequinVisible}, presetActive=${check2Data.presetActive}, stageLayers=[${check2Data.stageLayers.join(',')}]`,
      `ComboUnlockBar: pct=${check2Data.comboPct}%, label="${check2Data.comboText}"`,
      `Tabs=${check2Data.presentTabsCount}/6, StylistHarmonyBanner visible=${check2Data.harmonyBannerVisible} (toggle=${harmonyPressedOn}) "${check2Data.harmonyBannerText}"`,
      `Wardrobe cards=${check2Data.totalCardsRendered} (>=23), sample 3:4 AR=[${check2Data.sampleCards.map((c) => c.aspectRatio).join(',')}]`,
      `Canonical size groups: ${check2Data.sizeGroups.map((g) => `${g.slot}:[${g.pills.join(',')}]`).join(' | ')} (strictXS..XL=${canonicalSizesOk})`,
      `Packaging thumbs: ${check2Data.pkgThumbs.map((t) => `${t.code}(${t.naturalWidth}px)`).join(', ')}`,
      `Gift card: exists=${check2Data.giftCardExists}, rotation=${check2Data.paperRotationDeg}deg, font="${check2Data.giftFontFamily}"`,
      `Screenshot 01: ${shot01Path} (${Math.round(fs.statSync(shot01Path).size / 1024)} KB)`,
    ]);

    // CHECK 3: Stage Tools (Gift Note + Gift Card Summary Capture, Đèn Tiệc, 3x Optical Loupe, Back Flip)
    const giftInput = page.locator('[data-testid="studio-gift-note-input"]');
    await giftInput.scrollIntoViewIfNeeded();
    await giftInput.fill('Chúc nàng một đêm tiệc thật rạng rỡ...');
    await giftInput.blur();
    await page.waitForTimeout(300);

    // Frame right column: -4deg tilted <StudioGiftCard />, -10% financial breakdown, ♡ save/share & THÊM CẢ BỘ VÀO GIỎ
    await page.evaluate(() => {
      const giftCard = document.querySelector('[data-testid="studio-gift-card"]');
      const addBtn = document.querySelector('[data-testid="studio-add-bundle-btn"]');
      if (giftCard && addBtn) {
        const gRect = giftCard.getBoundingClientRect();
        const bRect = addBtn.getBoundingClientRect();
        const groupTop = gRect.top + window.scrollY;
        const groupBottom = bRect.bottom + window.scrollY;
        const targetY = Math.max(0, Math.round(groupBottom - window.innerHeight + 44));
        const clampedY = Math.min(targetY, Math.max(0, Math.round(groupTop - 110)));
        window.scrollTo({ top: clampedY, behavior: 'instant' });
      }
    });
    await page.waitForTimeout(350);

    const giftSummaryAudit = await page.evaluate(() => {
      const giftCard = document.querySelector('[data-testid="studio-gift-card"]');
      const saveBtn = document.querySelector('[data-testid="studio-save-share-btn"]');
      const addBtn = document.querySelector('[data-testid="studio-add-bundle-btn"]');
      const asideText = (document.querySelector('#build .build__side')?.textContent || '').normalize('NFC');
      const inView = (el) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        return r.top >= 64 && r.bottom <= window.innerHeight + 4 && r.width > 0 && r.height > 0;
      };
      return {
        giftCardInView: inView(giftCard),
        saveBtnInView: inView(saveBtn),
        addBtnInView: inView(addBtn),
        hasMinus10Breakdown: /Ưu đãi Combo\s*\([−-]10%\)/i.test(asideText) && /THÊM CẢ BỘ VÀO GIỎ/i.test(asideText),
      };
    });

    const shot06Path = path.join(AUDIT_DIR, '06-studio-giftcard-summary-1440.png');
    await page.screenshot({ path: shot06Path, fullPage: false, type: 'png' });

    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    await page.waitForTimeout(250);

    await page.locator('[data-testid="lighting-toggle-evening"]').click();
    await page.waitForTimeout(450);

    await page.locator('[data-testid="stage-loupe-btn"]').click();
    const loupeLoc = page.locator('[data-testid="optical-fabric-loupe"]');
    await loupeLoc.waitFor({ state: 'visible', timeout: 5000 });

    // Hover over primary dress center so loupe zooms right over the burgundy silk dress
    const dressTarget = page.locator('#bStage [data-loupe-target="true"]').first();
    const dressBox = await dressTarget.boundingBox();
    if (dressBox) {
      await page.mouse.move(dressBox.x + dressBox.width * 0.5, dressBox.y + dressBox.height * 0.48, { steps: 10 });
    }
    await page.waitForTimeout(450);

    const eveningLoupeState = await page.evaluate(() => {
      const stage = document.querySelector('#bStage');
      const loupe = document.querySelector('[data-testid="optical-fabric-loupe"]');
      const loupeRect = loupe?.getBoundingClientRect() ?? null;
      const noteVal = document.querySelector('[data-testid="studio-gift-note-input"]')?.value ?? '';
      return {
        lightingMode: stage?.getAttribute('data-lighting-mode') ?? '',
        loupeEnabledAttr: stage?.getAttribute('data-loupe-enabled') ?? '',
        loupeVisible: Boolean(loupeRect && loupeRect.width >= 120 && loupeRect.height >= 120),
        noteVal,
      };
    });

    const shot02Path = path.join(AUDIT_DIR, '02-studio-evening-loupe-1440.png');
    await page.screenshot({ path: shot02Path, fullPage: false, type: 'png' });

    // Toggle Front/Back flip cleanly, verify back state, then restore front & loupe off
    await page.locator('[data-testid="stage-flip-btn"]').click();
    await page.waitForTimeout(700);
    const backFlipState = await page.evaluate(() => {
      const stage = document.querySelector('#bStage');
      const indicator = document.querySelector('[data-testid="stage-back-view-indicator"]');
      return {
        viewSide: stage?.getAttribute('data-view-side') ?? '',
        indicatorVisible: Boolean(indicator),
      };
    });

    await page.locator('[data-testid="stage-flip-btn"]').click();
    await page.waitForTimeout(450);
    await page.locator('[data-testid="stage-loupe-btn"]').click();
    await page.waitForTimeout(250);
    const restoredStageState = await page.evaluate(() => ({
      viewSide: document.querySelector('#bStage')?.getAttribute('data-view-side') ?? '',
      loupeExists: Boolean(document.querySelector('[data-testid="optical-fabric-loupe"]')),
    }));

    const check3Ok =
      giftSummaryAudit.giftCardInView &&
      giftSummaryAudit.saveBtnInView &&
      giftSummaryAudit.addBtnInView &&
      giftSummaryAudit.hasMinus10Breakdown &&
      eveningLoupeState.noteVal.includes('Chúc nàng một đêm tiệc thật rạng rỡ') &&
      eveningLoupeState.lightingMode === 'evening' &&
      eveningLoupeState.loupeEnabledAttr === 'true' &&
      eveningLoupeState.loupeVisible &&
      backFlipState.viewSide === 'back' &&
      backFlipState.indicatorVisible &&
      restoredStageState.viewSide === 'front' &&
      !restoredStageState.loupeExists;

    recordCheck('CHECK 3', 'Interactive Stage Tools (Gift Note, -4deg Summary, Đèn Tiệc, 3x Loupe & Front/Back Flip)', check3Ok, [
      `Gift card summary framed: giftCard=${giftSummaryAudit.giftCardInView}, saveBtn=${giftSummaryAudit.saveBtnInView}, addBtn=${giftSummaryAudit.addBtnInView}, -10%Breakdown=${giftSummaryAudit.hasMinus10Breakdown}`,
      `Gift note="${eveningLoupeState.noteVal}", lighting=${eveningLoupeState.lightingMode}, loupeVisible=${eveningLoupeState.loupeVisible}`,
      `Flip to back: viewSide=${backFlipState.viewSide}, indicator=${backFlipState.indicatorVisible} | Restored: viewSide=${restoredStageState.viewSide}, loupeExists=${restoredStageState.loupeExists}`,
      `Screenshot 02: ${shot02Path} (${Math.round(fs.statSync(shot02Path).size / 1024)} KB)`,
      `Screenshot 06: ${shot06Path} (${Math.round(fs.statSync(shot06Path).size / 1024)} KB)`,
    ]);

    // CHECK 4: Phụ kiện Tab, Công Sở Thanh Lịch Preset, Mutual Exclusion & SizeGuideModal
    await page.locator('[data-testid="studio-tab-ACCESSORY"]').click();
    await page.waitForTimeout(400);
    await waitImagesLoaded(page, '#build');

    await page.locator('[data-testid="preset-modern-office"]').click();
    await page.waitForTimeout(850);
    await waitImagesLoaded(page, '#build');

    const check4StageData = await page.evaluate(() => {
      const accCards = Array.from(document.querySelectorAll('[data-testid^="studio-product-card-"]')).map((li) => {
        const img = li.querySelector('img');
        const frame = li.querySelector('[role="button"]');
        const r = frame?.getBoundingClientRect();
        return {
          slug: li.getAttribute('data-testid')?.replace('studio-product-card-', ''),
          naturalWidth: img?.naturalWidth ?? 0,
          complete: Boolean(img?.complete),
          aspectRatio: r && r.height > 0 ? Number((r.width / r.height).toFixed(3)) : 0,
        };
      });
      const stageLayers = Array.from(document.querySelectorAll('#bStage [data-outfit-layer]')).map((el) =>
        el.getAttribute('data-outfit-layer'),
      );
      const itemCards = Array.from(document.querySelectorAll('[data-testid^="studio-item-card-"]')).map((el) =>
        el.getAttribute('data-testid')?.replace('studio-item-card-', ''),
      );
      return { accCards, stageLayers, itemCards };
    });

    for (const u of await collectBrokenVisibleImages(page, '#build')) allBrokenImgs.add(u);

    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    await page.waitForTimeout(250);
    const shot03Path = path.join(AUDIT_DIR, '03-studio-accessories-tab-1440.png');
    await page.screenshot({ path: shot03Path, fullPage: false, type: 'png' });

    // Verify click `+` layering on an unselected accessory card
    const unselectedAccPlus = page.locator('[data-testid^="studio-product-card-"] button[aria-pressed="false"]').first();
    await unselectedAccPlus.click();
    await page.waitForTimeout(400);
    const afterPlusClickHasAccessory = await page.evaluate(() =>
      Boolean(document.querySelector('#bStage [data-outfit-layer="ACCESSORY"]')),
    );

    // Verify HTML5 drag-and-drop layering + ONE_PIECE vs TOP+BOTTOM mutual exclusion
    await page.locator('[data-testid="studio-tab-ONE_PIECE"]').click();
    await page.waitForTimeout(300);
    const firstDressCard = page.locator('[data-testid^="studio-product-card-"]').first();
    await firstDressCard.scrollIntoViewIfNeeded();
    await firstDressCard.dragTo(page.locator('#bStage'));
    await page.waitForTimeout(650);
    const afterDragExclusion = await page.evaluate(() => {
      const layers = Array.from(document.querySelectorAll('#bStage [data-outfit-layer]')).map((el) =>
        el.getAttribute('data-outfit-layer'),
      );
      const bannerText = (document.querySelector('[data-testid="studio-mutual-exclusion-banner"]')?.textContent || '')
        .normalize('NFC')
        .trim();
      return {
        layers,
        bannerText,
        hasOnePiece: layers.includes('ONE_PIECE'),
        topBottomCleared: !layers.includes('TOP') && !layers.includes('BOTTOM'),
      };
    });

    // Restore 3-piece Công Sở Thanh Lịch preset so SizeGuideModal & Check 5 operate on a full 3-piece bundle
    await page.locator('[data-testid="preset-modern-office"]').click();
    await page.waitForTimeout(750);
    await waitImagesLoaded(page, '#build');

    // Open SizeGuideModal, adjust weight & height so recommended size updates, save & close
    const sizeProfileBtn = page.locator('[data-testid="studio-size-profile-btn"]');
    await sizeProfileBtn.scrollIntoViewIfNeeded();
    await sizeProfileBtn.click();
    const sizeModal = page.locator('[data-testid="size-guide-modal"]');
    await sizeModal.waitFor({ state: 'visible', timeout: 5000 });

    const beforeRecText = (await page.locator('[data-testid="size-guide-recommended"]').textContent())?.trim() || '';
    // Move weight to 65 kg & height to 171 cm -> shifts recommendation to Size L
    await page.locator('#studio-size-height').fill('171');
    await page.locator('#studio-size-weight').fill('65');
    // Also adjust bust/waist/hip inputs cleanly so weighted distance lands unmistakably on L
    const numInputs = sizeModal.locator('input[type="number"]');
    await numInputs.nth(0).fill('93');
    await numInputs.nth(1).fill('75');
    await numInputs.nth(2).fill('99');
    await page.waitForTimeout(200);

    const afterRecText = (await page.locator('[data-testid="size-guide-recommended"]').textContent())?.trim() || '';
    await page.locator('[data-testid="size-guide-save-btn"]').click();
    await sizeModal.waitFor({ state: 'hidden', timeout: 5000 });
    await page.waitForTimeout(300);

    const updatedProfileBtnText = ((await sizeProfileBtn.textContent()) || '').normalize('NFC').trim();
    const expectedRecSize = afterRecText.replace(/^Size\s*/i, '').trim();

    const accCardsOk =
      check4StageData.accCards.length >= 3 &&
      NEW_ACCESSORY_SLUGS.every((slug) => check4StageData.accCards.some((c) => c.slug === slug)) &&
      check4StageData.accCards.every((c) => c.complete && c.naturalWidth > 0 && c.aspectRatio >= 0.68 && c.aspectRatio <= 0.82);
    const mutualExclusionOk =
      check4StageData.stageLayers.includes('TOP') &&
      check4StageData.stageLayers.includes('BOTTOM') &&
      !check4StageData.stageLayers.includes('ONE_PIECE') &&
      check4StageData.itemCards.includes('TOP') &&
      check4StageData.itemCards.includes('BOTTOM') &&
      !check4StageData.itemCards.includes('ONE_PIECE');
    const sizeGuideOk =
      beforeRecText !== afterRecText &&
      Boolean(expectedRecSize) &&
      updatedProfileBtnText.includes(`Size ${expectedRecSize}`);

    const dragDropExclusionOk =
      afterPlusClickHasAccessory &&
      afterDragExclusion.hasOnePiece &&
      afterDragExclusion.topBottomCleared &&
      afterDragExclusion.bannerText.includes('Đầm liền');

    const check4Ok = accCardsOk && mutualExclusionOk && dragDropExclusionOk && sizeGuideOk;

    recordCheck('CHECK 4', 'Phụ kiện Tab, Drag-Drop & Click + Layering, Mutual Exclusion & SizeGuideModal', check4Ok, [
      `Accessory cards (${check4StageData.accCards.length}): ${check4StageData.accCards.map((c) => `${c.slug}(${c.naturalWidth}px, ar=${c.aspectRatio})`).join(' | ')}`,
      `Preset modern-office layers=[${check4StageData.stageLayers.join(',')}], itemCards=[${check4StageData.itemCards.join(',')}] (TOP+BOTTOM present, ONE_PIECE cleared=${mutualExclusionOk})`,
      `Click + accessory=${afterPlusClickHasAccessory} | Drag ONE_PIECE -> layers=[${afterDragExclusion.layers.join(',')}], topBottomCleared=${afterDragExclusion.topBottomCleared}, banner="${afterDragExclusion.bannerText}"`,
      `SizeGuideModal: "${beforeRecText}" -> "${afterRecText}", button text="${updatedProfileBtnText}"`,
      `Screenshot 03: ${shot03Path} (${Math.round(fs.statSync(shot03Path).size / 1024)} KB)`,
    ]);

    // CHECK 5: ✦ Ướm thử cả bộ AI, ♡ Save/Share & THÊM CẢ BỘ VÀO GIỎ -> QuickBagDrawer
    await page.evaluate(() => window.scrollTo({ top: 96, behavior: 'instant' }));
    await page.waitForTimeout(200);

    // 5A: ✦ Ướm thử cả bộ AI
    await page.locator('[data-testid="stage-tryon-btn"]').click();
    const tryOnModal = page.locator('[data-testid="virtual-tryon-modal"]');
    await tryOnModal.waitFor({ state: 'visible', timeout: 8000 });
    const tryOnOpened = await tryOnModal.isVisible();
    await page.waitForTimeout(300);
    const closeTryOnBtn = tryOnModal.locator('button[aria-label="Đóng Phòng Thử đồ AI"]').first();
    if (await closeTryOnBtn.isVisible().catch(() => false)) {
      await closeTryOnBtn.click();
    } else {
      await page.keyboard.press('Escape');
    }
    await tryOnModal.waitFor({ state: 'hidden', timeout: 6000 });
    const tryOnClosed = !(await tryOnModal.isVisible().catch(() => false));

    // 5B: ♡ Save/Share
    const saveShareBtn = page.locator('[data-testid="studio-save-share-btn"]');
    await saveShareBtn.scrollIntoViewIfNeeded();
    await saveShareBtn.click();
    const shareStrip = page.locator('[data-testid="studio-share-result"]');
    await shareStrip.waitFor({ state: 'visible', timeout: 10_000 });
    const shareInfo = await page.evaluate(() => {
      const strip = document.querySelector('[data-testid="studio-share-result"]');
      const inputVal = strip?.querySelector('input')?.value ?? '';
      const feedback = (document.querySelector('[data-testid="studio-status-feedback"]')?.textContent || '').trim();
      return {
        text: (strip?.textContent || '').trim(),
        shareUrl: inputVal,
        feedback,
      };
    });

    // 5C: THÊM CẢ BỘ VÀO GIỎ -> 0.9s box-close ritual + POST /bff/v1/storefront/cart/outfit-bundle -> QuickBagDrawer
    const bundleResponsePromise = page.waitForResponse(
      (res) =>
        res.url().includes('/bff/v1/storefront/cart/outfit-bundle') &&
        res.request().method() === 'POST',
      { timeout: 15_000 },
    );

    const addBundleBtn = page.locator('[data-testid="studio-add-bundle-btn"]');
    await addBundleBtn.scrollIntoViewIfNeeded();
    await addBundleBtn.click();

    const bundleRes = await bundleResponsePromise;
    const bundleHttpStatus = bundleRes.status();

    // Wait for QuickBagDrawer (#order.on) to slide open cleanly
    await page.waitForFunction(
      () => {
        const drawer = document.querySelector('#order');
        return Boolean(drawer && drawer.classList.contains('on'));
      },
      undefined,
      { timeout: 10_000 },
    );
    await page.waitForTimeout(950);
    await waitImagesLoaded(page, '#order');

    const bagDrawerState = await page.evaluate(() => {
      const drawer = document.querySelector('#order');
      const panel = drawer?.querySelector('.order__panel');
      const panelText = (panel?.textContent || '').normalize('NFC');
      const itemsCount = panel ? panel.querySelectorAll('ul > li').length : 0;
      const hasBundleHeader = /Outfit Bundle/i.test(panelText);
      const hasComboDiscount = /Combo\s*[−-]\s*(?:5|10)%/i.test(panelText);
      return {
        isOpen: Boolean(drawer?.classList.contains('on')),
        itemsCount,
        hasBundleHeader,
        hasComboDiscount,
        title: (document.querySelector('#odDrawerTitle')?.textContent || '').trim(),
      };
    });

    for (const u of await collectBrokenVisibleImages(page, '#order')) allBrokenImgs.add(u);

    const shot04Path = path.join(AUDIT_DIR, '04-studio-bag-drawer-1440.png');
    await page.screenshot({ path: shot04Path, fullPage: false, type: 'png' });

    const check5Ok =
      tryOnOpened &&
      tryOnClosed &&
      shareInfo.shareUrl.includes('/phoi-do?share=') &&
      (bundleHttpStatus === 200 || bundleHttpStatus === 201) &&
      bagDrawerState.isOpen &&
      bagDrawerState.itemsCount >= 3 &&
      bagDrawerState.hasBundleHeader &&
      bagDrawerState.hasComboDiscount;

    recordCheck('CHECK 5', 'AI Try-On Modal, ♡ Save/Share & Add Outfit Bundle -> QuickBagDrawer', check5Ok, [
      `VirtualTryOnModal: opened=${tryOnOpened}, closed=${tryOnClosed}`,
      `Save/Share: url="${shareInfo.shareUrl}", feedback="${shareInfo.feedback}"`,
      `POST /bff/v1/storefront/cart/outfit-bundle -> HTTP ${bundleHttpStatus}`,
      `QuickBagDrawer: open=${bagDrawerState.isOpen}, title="${bagDrawerState.title}", items=${bagDrawerState.itemsCount}, bundleHeader=${bagDrawerState.hasBundleHeader}, comboBadge=${bagDrawerState.hasComboDiscount}`,
      `Screenshot 04: ${shot04Path} (${Math.round(fs.statSync(shot04Path).size / 1024)} KB)`,
    ]);

    await desktopContext.close();

    // -------------------------------------------------------------------------
    // CHECK 6A: MOBILE `390x844` ON `/phoi-do`
    // -------------------------------------------------------------------------
    const mobileContext = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 1,
      isMobile: true,
      hasTouch: true,
    });
    const mobilePage = await mobileContext.newPage();
    await attachDiagnosticsAndRouting(mobileContext, mobilePage, 'mobile:/phoi-do');

    await mobilePage.goto(`${STOREFRONT_BASE}/phoi-do`, { waitUntil: 'networkidle', timeout: 45_000 });
    await mobilePage.evaluate(() => document.fonts?.ready);
    await mobilePage.waitForTimeout(800);
    await waitImagesLoaded(mobilePage, '#build');

    const mobileAudit = await mobilePage.evaluate(() => {
      const docOverflow = document.documentElement.scrollWidth - window.innerWidth;
      const summaryBar = document.querySelector('[data-testid="studio-mobile-summary-bar"]');
      const barRect = summaryBar?.getBoundingClientRect() ?? null;
      const barStyle = summaryBar ? window.getComputedStyle(summaryBar) : null;
      const grid = document.querySelector('#build .build__left')?.parentElement ?? null;
      const gridCols = grid ? window.getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length : 0;
      const stageLayers = document.querySelectorAll('#bStage [data-outfit-layer]').length;
      return {
        docOverflow,
        gridCols,
        stageLayers,
        summaryBarVisible: Boolean(
          barStyle && barStyle.display !== 'none' && barRect && barRect.height >= 44 && barRect.bottom <= 848,
        ),
        summaryBarText: (summaryBar?.textContent || '').normalize('NFC').replace(/\s+/g, ' ').trim(),
        summaryBarBottom: barRect ? Number(barRect.bottom.toFixed(1)) : null,
      };
    });

    for (const u of await collectBrokenVisibleImages(mobilePage, '#build')) allBrokenImgs.add(u);

    const shot05Path = path.join(AUDIT_DIR, '05-studio-mobile-390.png');
    await mobilePage.screenshot({ path: shot05Path, fullPage: false, type: 'png' });
    await mobileContext.close();

    // -------------------------------------------------------------------------
    // CHECK 6B: HOMEPAGE `/#build` AT `1440x900`
    // -------------------------------------------------------------------------
    const homeContext = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 1,
    });
    const homePage = await homeContext.newPage();
    await attachDiagnosticsAndRouting(homeContext, homePage, 'home:/#build');
    await homePage.addInitScript(() => {
      window.__navLog = [];
      window.addEventListener('atelier:nav-theme', (e) => {
        window.__navLog.push({ t: Math.round(performance.now()), ev: 'atelier:nav-theme', detail: e.detail });
      });
    });

    await homePage.goto(`${STOREFRONT_BASE}/#build`, { waitUntil: 'networkidle', timeout: 45_000 });
    await homePage.evaluate(() => document.fonts?.ready);
    // Let IntroCurtain finish its natural reveal cleanly (IntroCurtain mounts in useEffect after hydration!)
    await homePage.waitForTimeout(400);
    await homePage
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
    await homePage.waitForTimeout(700);

    // Scroll cleanly to #build after IntroCurtain scroll-lock releases & ScrollTrigger refreshes
    await homePage.evaluate(() => {
      const el = document.querySelector('#build');
      if (el) {
        const y = Math.max(0, Math.round(el.getBoundingClientRect().top + window.scrollY - 8));
        window.scrollTo({ top: y, behavior: 'instant' });
        window.dispatchEvent(new Event('scroll'));
      }
    });
    await homePage.waitForTimeout(900);
    await homePage.evaluate(() => {
      const el = document.querySelector('#build');
      if (el) {
        const rect = el.getBoundingClientRect();
        if (rect.top > 32 || rect.top < -40) {
          const y = Math.max(0, Math.round(rect.top + window.scrollY - 8));
          window.scrollTo({ top: y, behavior: 'instant' });
        }
        window.dispatchEvent(new Event('scroll'));
      }
    });
    await homePage.mouse.wheel(0, 12);
    await homePage.waitForTimeout(700);
    await waitImagesLoaded(homePage, '#build');

    const homeBuildAudit = await homePage.evaluate(() => {
      const header = document.querySelector('header.nav, .nav');
      const headerStyle = header ? window.getComputedStyle(header) : null;
      const headerBeforeStyle = header ? window.getComputedStyle(header, '::before') : null;
      const buildEl = document.querySelector('#build');
      const buildRect = buildEl?.getBoundingClientRect() ?? null;
      const buildText = (buildEl?.textContent || '').normalize('NFC');
      const mannequin = buildEl?.querySelector('[data-testid="ghost-mannequin-svg"]');
      const stageLayers = buildEl ? buildEl.querySelectorAll('#bStage [data-outfit-layer]').length : 0;
      const seal = buildEl?.querySelector('.outfit__seal');
      const sealStyle = seal ? window.getComputedStyle(seal) : null;
      const allThemed = Array.from(document.querySelectorAll('[data-nav-theme]')).map((s) => {
        const r = s.getBoundingClientRect();
        return {
          id: s.id || s.tagName,
          theme: s.getAttribute('data-nav-theme'),
          top: Math.round(r.top),
          bottom: Math.round(r.bottom),
        };
      });
      const probeSections = allThemed.filter((s) => s.top <= 64 && s.bottom > 64);
      return {
        hasIsLight: Boolean(header?.classList.contains('is-light')),
        headerClass: header?.className ?? '',
        headerColor: headerStyle?.color ?? '',
        headerBeforeOpacity: headerBeforeStyle ? parseFloat(headerBeforeStyle.opacity) : -1,
        scrollY: Math.round(window.scrollY),
        introExists: Boolean(document.querySelector('#intro')),
        hasMannequin: Boolean(mannequin),
        stageLayers,
        hasBadCopy: /7\s*TẦNG|1\s*TẦNG/i.test(buildText),
        sealHidden: Boolean(sealStyle && (sealStyle.visibility === 'hidden' || parseFloat(sealStyle.opacity) === 0)),
        buildTop: buildRect ? Math.round(buildRect.top) : null,
        probeSections,
        navLog: window.__navLog || [],
      };
    });

    for (const u of await collectBrokenVisibleImages(homePage, '#build')) allBrokenImgs.add(u);
    const shot07Path = path.join(AUDIT_DIR, '07-home-build-light-header-1440.png');
    await homePage.screenshot({ path: shot07Path, fullPage: false, type: 'png' });
    await homeContext.close();

    const check6Ok =
      mobileAudit.docOverflow <= 2 &&
      mobileAudit.gridCols === 1 &&
      mobileAudit.stageLayers === 3 &&
      mobileAudit.summaryBarVisible &&
      homeBuildAudit.hasIsLight &&
      homeBuildAudit.headerColor === 'rgb(28, 20, 16)' &&
      homeBuildAudit.headerBeforeOpacity === 0 &&
      homeBuildAudit.hasMannequin &&
      homeBuildAudit.stageLayers === 3 &&
      !homeBuildAudit.hasBadCopy &&
      homeBuildAudit.sealHidden;

    recordCheck('CHECK 6', 'Mobile 390x844 Stacked Layout + Sticky Summary Bar & Cold Homepage /#build Light Header', check6Ok, [
      `Mobile 390x844: overflow=${mobileAudit.docOverflow}px (<=2), gridCols=${mobileAudit.gridCols}, stageLayers=${mobileAudit.stageLayers}, summaryBarVisible=${mobileAudit.summaryBarVisible} (bottom=${mobileAudit.summaryBarBottom}px) "${mobileAudit.summaryBarText}"`,
      `Homepage /#build: .nav.is-light=${homeBuildAudit.hasIsLight} (cls="${homeBuildAudit.headerClass}", color=${homeBuildAudit.headerColor}, ::before opacity=${homeBuildAudit.headerBeforeOpacity}, y=${homeBuildAudit.scrollY}, intro=${homeBuildAudit.introExists}, buildTop=${homeBuildAudit.buildTop}px), probeAt64=${JSON.stringify(homeBuildAudit.probeSections)}, mannequin=${homeBuildAudit.hasMannequin}, stageLayers=${homeBuildAudit.stageLayers}, badCopy=${homeBuildAudit.hasBadCopy}, sealHidden=${homeBuildAudit.sealHidden}`,
      `Screenshot 05: ${shot05Path} (${Math.round(fs.statSync(shot05Path).size / 1024)} KB)`,
      `Screenshot 07: ${shot07Path} (${Math.round(fs.statSync(shot07Path).size / 1024)} KB)`,
    ]);

    // CHECK 7: Browser Hygiene (0 console/page/HTTP errors & 0 broken images)
    const brokenImgsList = Array.from(allBrokenImgs);
    const hygieneOk =
      consoleErrors.length === 0 &&
      pageErrors.length === 0 &&
      failedHttp.length === 0 &&
      brokenImgsList.length === 0;

    recordCheck('CHECK 7', 'Browser Hygiene (Zero Console/Page/HTTP Errors & Zero Broken Images)', hygieneOk, [
      `consoleErrors=${consoleErrors.length}, pageErrors=${pageErrors.length}, failedHttp=${failedHttp.length}, brokenImgs=${brokenImgsList.length}`,
      ...consoleErrors.slice(0, 5).map((e) => `CONSOLE ERROR: ${e}`),
      ...pageErrors.slice(0, 5).map((e) => `PAGE ERROR: ${e}`),
      ...failedHttp.slice(0, 5).map((e) => `HTTP FAIL: ${e}`),
      ...brokenImgsList.slice(0, 5).map((u) => `BROKEN IMG: ${u}`),
    ]);
  } finally {
    await cleanupAll();
    console.log('\n[CLEANUP] Browser & verifier-spawned processes cleanly terminated (pre-existing user ./run & Ollama :11434 preserved).');
  }

  const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
  const passCount = results.filter((r) => r.ok).length;
  const failCount = results.length - passCount;

  console.log('\n========================================================================');
  console.log(` OUTFIT STUDIO OVERHAUL VERIFICATION SUMMARY  (${elapsedSec}s)`);
  console.log('------------------------------------------------------------------------');
  for (const r of results) {
    console.log(`  [${r.ok ? 'PASS' : 'FAIL'}] ${r.id}: ${r.title}`);
  }
  console.log('------------------------------------------------------------------------');
  console.log(`  Totals: PASS=${passCount}/${results.length} | FAIL=${failCount}`);
  console.log('========================================================================\n');

  if (failCount > 0 || passCount < 8) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('\n[FATAL] verify-outfit-studio-overhaul crashed:', err instanceof Error ? err.stack || err.message : err);
  process.exitCode = 1;
});
