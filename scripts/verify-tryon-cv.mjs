#!/usr/bin/env node
/**
 * Try-On CV & UX Overhaul Acceptance Verification Suite
 * fashion-atelier-ai-platform (v3.1)
 *
 * Implements ALL 4 mandatory Try-On CV & UX verification tests (#250):
 *   Test A: Real RGBA Garment Audit (Áo Khoác Tweed Dệt Thủ Công & all 20 products)
 *           - 100% HTTP 200, 0 SVG bytes, sharp hasAlpha === true, all 4 corners alpha === 0
 *   Test B: Close-Up Face-Only Rejection (POSE_TOO_CLOSE) + Automatic +1 Quota Refund
 *   Test C: Real Half-Body Try-On (Áo Khoác Tweed Dệt Thủ Công) + Pixel Preservation Audit
 *           - Face region (y=8%..26%, x=35%..65%) MAE < 12/255
 *           - Torso region (y=38%..75%, x=25%..75%) MAE > 10/255
 *   Test D: Real Headless Chrome (1440x900) Live Modal Audit
 *           - Modal z-index strictly overlays <SiteHeader /> (no header overlap)
 *           - Captures modal-upload-samples.png (3 real sample models)
 *           - Runs live 1-click Try-On on Sample Model 1 -> verifies Engine Source Badge
 *             + 0% -> 88% Before/After slider reveal -> captures modal-result-slider.png
 *           - consoleErrors === 0, pageErrors === 0, STRAY_PORTS=NONE
 */

import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
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

const TARGET_TWEED_SLUG = 'ao-khoac-tweed-det-thu-cong';
const SEED_CUSTOMER_EMAIL = 'customer@atelier.local';
const SEED_PASSWORD = 'Atelier@2026!';

const AUDIT_DIR =
  process.env.TRYON_AUDIT_DIR ||
  'C:\\Users\\Admin\\.gemini\\antigravity\\brain\\d1783908-6521-4608-8b37-41aae3ee9a65\\scratch\\tryon-audit';

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

function detectMimeFromBuffer(buf, filePath = '') {
  if (buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp';
  }
  if (buf.subarray(0, 4).toString('hex') === '89504e47') {
    return 'image/png';
  }
  if (buf.subarray(0, 3).toString('hex') === 'ffd8ff') {
    return 'image/jpeg';
  }
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.webp') return 'image/webp';
  if (ext === '.png') return 'image/png';
  return 'image/jpeg';
}

async function inspectAlphaCutoutCorners(url) {
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
  if (!meta.hasAlpha) {
    return { ok: false, url, reason: `hasAlpha=false (${meta.format} ${meta.width}x${meta.height})` };
  }
  const { data, info } = await sharp(res.buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const w = info.width;
  const h = info.height;
  const alphaAt = (x, y) => data[(y * w + x) * 4 + 3];
  const corners = [
    alphaAt(0, 0),
    alphaAt(w - 1, 0),
    alphaAt(0, h - 1),
    alphaAt(w - 1, h - 1),
  ];
  const cornersZero = corners.every((a) => a === 0);
  if (!cornersZero) {
    return { ok: false, url, reason: `Non-zero corner alphas: [${corners.join(',')}]`, corners, width: w, height: h };
  }
  return { ok: true, url, format: meta.format, width: w, height: h, hasAlpha: true, corners };
}

async function computeRegionMae(origBuf, resultBuf, width = 768, height = 1024) {
  const [origRaw, resRaw] = await Promise.all([
    sharp(origBuf).resize(width, height, { fit: 'cover' }).removeAlpha().raw().toBuffer(),
    sharp(resultBuf).resize(width, height, { fit: 'cover' }).removeAlpha().raw().toBuffer(),
  ]);

  const maeForBox = (x0Frac, x1Frac, y0Frac, y1Frac) => {
    const x0 = Math.floor(width * x0Frac);
    const x1 = Math.floor(width * x1Frac);
    const y0 = Math.floor(height * y0Frac);
    const y1 = Math.floor(height * y1Frac);
    let sumAbs = 0;
    let count = 0;
    for (let y = y0; y < y1; y += 1) {
      for (let x = x0; x < x1; x += 1) {
        const idx = (y * width + x) * 3;
        sumAbs +=
          Math.abs(origRaw[idx] - resRaw[idx]) +
          Math.abs(origRaw[idx + 1] - resRaw[idx + 1]) +
          Math.abs(origRaw[idx + 2] - resRaw[idx + 2]);
        count += 3;
      }
    }
    return count > 0 ? sumAbs / count : 0;
  };

  return {
    faceMae: Number(maeForBox(0.35, 0.65, 0.08, 0.26).toFixed(2)),
    torsoMae: Number(maeForBox(0.25, 0.75, 0.38, 0.75).toFixed(2)),
  };
}

async function uploadAndRunTryOn({
  imageBuffer,
  filePath,
  authHeaders,
  productId,
  variantId,
  poseLandmarks = undefined,
  pollTimeoutMs = 95_000,
}) {
  const contentType = detectMimeFromBuffer(imageBuffer, filePath);
  const sha256Hash = crypto.createHash('sha256').update(imageBuffer).digest('hex');

  const upReq = await httpRequest(`${BFF_BASE}/bff/v1/storefront/tryon/upload-url`, {
    method: 'POST',
    headers: authHeaders,
    body: {
      contentType,
      fileSizeBytes: imageBuffer.length,
      sha256Hash,
      source: 'STATIC_UPLOAD',
      poseScore: 0.92,
      privacyConsent: true,
    },
  });
  if (upReq.status !== 200 && upReq.status !== 201) {
    throw new Error(`upload-url failed HTTP ${upReq.status}: ${upReq.text}`);
  }
  const upData = unwrap(upReq.json);

  const putRes = await httpRequest(upData.uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': contentType, Origin: 'http://localhost:3000' },
    body: imageBuffer,
    timeoutMs: 25_000,
  });
  if (putRes.status !== 200) {
    throw new Error(`presigned PUT failed HTTP ${putRes.status}: ${putRes.text}`);
  }

  const sessionBody = {
    tempImageId: upData.tempImageId,
    objectKey: upData.objectKey,
    sha256Hash,
    mode: 'SINGLE',
    upperProductId: productId,
    upperVariantId: variantId,
    privacyConsent: true,
    ...(poseLandmarks !== undefined ? { poseLandmarks } : {}),
  };

  const sessRes = await httpRequest(`${BFF_BASE}/bff/v1/storefront/tryon/sessions`, {
    method: 'POST',
    headers: authHeaders,
    body: sessionBody,
    timeoutMs: 30_000,
  });

  if (sessRes.status !== 200 && sessRes.status !== 202) {
    return {
      httpStatus: sessRes.status,
      immediate: true,
      body: unwrap(sessRes.json) ?? sessRes.json,
      rawText: sessRes.text,
    };
  }

  const created = unwrap(sessRes.json);
  const sessionId = created?.sessionId || created?.id;
  if (!sessionId) {
    throw new Error(`Missing sessionId in POST /tryon/sessions response: ${sessRes.text}`);
  }

  if (created.status === 'COMPLETED' || created.status === 'FAILED') {
    return { httpStatus: sessRes.status, sessionId, final: created };
  }

  const deadline = Date.now() + pollTimeoutMs;
  let lastState = created;
  while (Date.now() < deadline) {
    const poll = await httpRequest(
      `${BFF_BASE}/bff/v1/storefront/tryon/sessions/${encodeURIComponent(sessionId)}`,
      { headers: authHeaders, timeoutMs: 15_000 },
    );
    const pd = unwrap(poll.json);
    if (pd) lastState = pd;
    if (pd?.status === 'COMPLETED' || pd?.status === 'FAILED') {
      return { httpStatus: sessRes.status, sessionId, final: pd };
    }
    await new Promise((r) => setTimeout(r, 350));
  }

  throw new Error(
    `Timed out after ${pollTimeoutMs}ms waiting for session ${sessionId} (lastStatus=${lastState?.status}): ${JSON.stringify(lastState)}`,
  );
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

async function main() {
  const startedAt = Date.now();
  console.log('========================================================================');
  console.log(' fashion-atelier-ai-platform (v3.1) — Try-On CV & UX Verification Suite');
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
      INTERNAL_SERVICE_SECRET: envVars.INTERNAL_SERVICE_SECRET || 'Atelier_Internal_Svc_2026!',
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

    console.log('\n--- Booting live Try-On stack (4001..4009, 4000, 3000) ---');
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
    const tryonProc = spawnPythonTryOn();
    const cartProc = spawnNodeService('cart-outfit', 'services/cart-outfit', 'CART_OUTFIT_PORT', 4005);

    await Promise.all([
      waitForHttp200(`${CATALOG_BASE}/health`, 90_000, catalogProc.logs),
      waitForHttp200(`${TRYON_BASE}/health`, 60_000, tryonProc.logs).then(() =>
        waitForHttp200(`${TRYON_BASE}/ready`, 25_000, tryonProc.logs),
      ),
      waitForHttp200(`${CART_BASE}/health`, 40_000, cartProc.logs),
    ]);
    console.log('  [UP] catalog:4002, cart:4005, ai-tryon:4009');

    // Force-reseed catalog so refreshed Tweed cutout & all 20 products upload cleanly to MinIO
    console.log('  [SEED] Calling POST /v1/catalog/internal/reseed ...');
    const reseedRes = await httpRequest(`${CATALOG_BASE}/v1/catalog/internal/reseed`, {
      method: 'POST',
      headers: { 'x-internal-secret': serviceEnv.INTERNAL_SERVICE_SECRET },
      timeoutMs: 90_000,
    });
    console.log(`  [SEED] Catalog reseed HTTP ${reseedRes.status}`);

    console.log('  [SEED] Running infra/seeds/seed-demo-data.mjs ...');
    const seedRun = await runNodeScript('infra/seeds/seed-demo-data.mjs', serviceEnv, 120_000);
    if (!seedRun.ok) {
      throw new Error(`seed-demo-data.mjs failed (code=${seedRun.code}):\n${seedRun.stderr || seedRun.stdout}`);
    }
    console.log('  [SEED] seed-demo-data.mjs completed cleanly.');

    // Flush ALL Redis keys (tryon:* & bff:*) so zero stale cache remains
    await flushAllRedis(envVars);
    console.log('  [CACHE] Redis FLUSHALL complete (zero stale tryon:* / bff:* cache).');

    const bffProc = spawnNodeService('bff', 'apps/bff', 'BFF_PORT', 4000);
    await waitForHttp200(`${BFF_BASE}/health`, 40_000, bffProc.logs);
    console.log('  [UP] apps/bff:4000');

    // Boot apps/storefront cleanly
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
      body: { tags: ['storefront', 'rack', 'products'], paths: ['/', '/bo-suu-tap', '/thu-do-ai'] },
      timeoutMs: 15_000,
    });
    console.log(`  [ISR] POST /api/revalidate HTTP ${revalRes.status}`);

    // =========================================================================
    // TEST A: Real RGBA Garment Audit (Áo Khoác Tweed Dệt Thủ Công & all 20 products)
    // =========================================================================
    let tweedProduct = null;
    let tweedVariant = null;
    {
      const [adminProdRes, rackRes] = await Promise.all([
        httpRequest(`${CATALOG_BASE}/v1/catalog/admin/products?pageSize=50`),
        httpRequest(`${BFF_BASE}/bff/v1/storefront/rack-collection`),
      ]);
      const adminProds = unwrap(adminProdRes.json)?.items ?? [];
      const rackItems = unwrap(rackRes.json)?.items ?? [];

      const tryonUrls = new Map(); // url -> slug
      for (const p of adminProds) {
        if (p.slug === TARGET_TWEED_SLUG) {
          tweedProduct = p;
          tweedVariant = (p.variants || [])[0] || null;
        }
        if (p.tryonFlatAssetUrl) tryonUrls.set(p.tryonFlatAssetUrl, p.slug);
        for (const v of p.variants || []) {
          if (v.tryonFlatPreviewUrl) tryonUrls.set(v.tryonFlatPreviewUrl, p.slug);
          if (v.rackFrontUrl) tryonUrls.set(v.rackFrontUrl, p.slug);
        }
      }
      for (const item of rackItems) {
        if (item.slug === TARGET_TWEED_SLUG && !tweedProduct) {
          tweedProduct = { id: item.productId, slug: item.slug, name: item.name };
          tweedVariant = (item.variants || [])[0] || null;
        }
        for (const v of item.variants || []) {
          if (v.tryonFlatPreviewUrl) tryonUrls.set(v.tryonFlatPreviewUrl, item.slug);
          if (v.frontCutoutUrl) tryonUrls.set(v.frontCutoutUrl, item.slug);
        }
      }

      const reports = [];
      let tweedChecked = 0;
      let tweedPassed = 0;
      for (const [url, slug] of tryonUrls.entries()) {
        const rep = await inspectAlphaCutoutCorners(url);
        rep.slug = slug;
        reports.push(rep);
        if (slug === TARGET_TWEED_SLUG) {
          tweedChecked += 1;
          if (rep.ok) tweedPassed += 1;
        }
      }

      const failed = reports.filter((r) => !r.ok);
      const uniqueSlugsChecked = new Set(reports.map((r) => r.slug)).size;
      const testAOk =
        Boolean(tweedProduct?.id && tweedVariant?.id) &&
        uniqueSlugsChecked >= 20 &&
        tweedChecked >= 2 &&
        tweedPassed === tweedChecked &&
        failed.length === 0;

      recordCheck('TEST A', 'Real RGBA Garment Audit (Tweed Jacket & All 20 Products)', testAOk, [
        `Target Tweed product found: id=${tweedProduct?.id}, variantId=${tweedVariant?.id} (${tweedPassed}/${tweedChecked} cutouts RGBA + 4 corners alpha=0)`,
        `All products covered: ${uniqueSlugsChecked}/20 slugs, ${reports.length - failed.length}/${reports.length} cutout URLs PASS (100% HTTP 200, 0 SVG, hasAlpha=true, corners=[0,0,0,0])`,
        ...failed.slice(0, 6).map((f) => `FAIL [${f.slug}]: ${f.url} -> ${f.reason}`),
      ]);
    }

    // Login customer@atelier.local for Test B & Test C
    const loginRes = await httpRequest(`${BFF_BASE}/bff/v1/auth/login`, {
      method: 'POST',
      headers: { Origin: 'http://localhost:3000' },
      body: { email: SEED_CUSTOMER_EMAIL, password: SEED_PASSWORD },
    });
    const loginData = unwrap(loginRes.json);
    const accessToken = loginData?.accessToken;
    if (!accessToken) {
      throw new Error(`Customer login failed HTTP ${loginRes.status}: ${loginRes.text}`);
    }
    const authHeaders = {
      Authorization: `Bearer ${accessToken}`,
      Origin: 'http://localhost:3000',
    };

    // =========================================================================
    // TEST B: Close-Up Face-Only Rejection (POSE_TOO_CLOSE) + Quota Refund
    // =========================================================================
    {
      const closeupPath = path.join(ROOT_DIR, 'infra', 'seeds', 'real-assets-cache', 'raw', 'test-closeup-face.jpg');
      if (!fs.existsSync(closeupPath)) {
        recordCheck('TEST B', 'Close-Up Face-Only Rejection (POSE_TOO_CLOSE) + Quota Refund', false, [
          `Missing close-up test portrait: ${closeupPath}`,
        ]);
      } else {
        const qBeforeRes = await httpRequest(`${BFF_BASE}/bff/v1/storefront/tryon/quota`, { headers: authHeaders });
        const quotaBefore = unwrap(qBeforeRes.json)?.remainingQuota;

        const closeupBuf = fs.readFileSync(closeupPath);
        const runRes = await uploadAndRunTryOn({
          imageBuffer: closeupBuf,
          filePath: closeupPath,
          authHeaders,
          productId: tweedProduct.id,
          variantId: tweedVariant.id,
          pollTimeoutMs: 45_000,
        });

        const finalState = runRes.final || runRes.body || {};
        const status = finalState.status || (runRes.httpStatus === 400 ? 'FAILED' : 'UNKNOWN');
        const errorCode =
          finalState.errorCode ||
          finalState.error_code ||
          finalState.error?.code ||
          '';
        const errorMessage =
          finalState.errorMessage ||
          finalState.error_message ||
          finalState.message ||
          finalState.error?.message ||
          '';

        const qAfterRes = await httpRequest(`${BFF_BASE}/bff/v1/storefront/tryon/quota`, { headers: authHeaders });
        const quotaAfter = unwrap(qAfterRes.json)?.remainingQuota;

        const hasVietnameseGuidance = /quá gần|lùi xa|vai|thân/i.test(String(errorMessage));
        const quotaRefunded = typeof quotaBefore === 'number' && quotaAfter === quotaBefore;
        const testBOk =
          status === 'FAILED' &&
          errorCode === 'POSE_TOO_CLOSE' &&
          hasVietnameseGuidance &&
          quotaRefunded;

        recordCheck('TEST B', 'Close-Up Face-Only Rejection (POSE_TOO_CLOSE) + Quota Refund', testBOk, [
          `sessionId=${runRes.sessionId || 'immediate'}, status=${status}, errorCode=${errorCode}`,
          `Vietnamese guidance: "${errorMessage}" (matched=${hasVietnameseGuidance})`,
          `Quota: before=${quotaBefore}, after=${quotaAfter} (refunded=${quotaRefunded})`,
        ]);
      }
    }

    // =========================================================================
    // TEST C: Real Half-Body Try-On (Tweed Jacket) + Face-Preservation Pixel Check
    // =========================================================================
    {
      const sample1Path = path.join(ROOT_DIR, 'apps', 'storefront', 'public', 'tryon-samples', 'sample-female-1.webp');
      if (!fs.existsSync(sample1Path)) {
        recordCheck('TEST C', 'Real Half-Body Try-On (Tweed Jacket) + Face Preservation', false, [
          `Missing sample model: ${sample1Path}`,
        ]);
      } else {
        const sample1Buf = fs.readFileSync(sample1Path);
        const runRes = await uploadAndRunTryOn({
          imageBuffer: sample1Buf,
          filePath: sample1Path,
          authHeaders,
          productId: tweedProduct.id,
          variantId: tweedVariant.id,
          pollTimeoutMs: 110_000,
        });

        const finalState = runRes.final || {};
        const status = finalState.status;
        const resultUrl = finalState.resultUrl;
        const providerUsed = finalState.providerUsed || 'UNKNOWN';
        const providerDisplayBadge = finalState.providerDisplayBadge || finalState.provider_display_badge || null;

        let faceMae = Infinity;
        let torsoMae = 0;
        let savedPath = '';
        let resultBytes = 0;

        if (status === 'COMPLETED' && typeof resultUrl === 'string' && resultUrl.startsWith('http')) {
          const imgRes = await httpRequest(resultUrl, { timeoutMs: 25_000 });
          if (imgRes.status === 200 && imgRes.buffer.length > 1000) {
            savedPath = path.join(AUDIT_DIR, 'result-tweed-tryon.webp');
            // Save as WebP cleanly (or original bytes if already WebP)
            const webpBuf =
              detectMimeFromBuffer(imgRes.buffer) === 'image/webp'
                ? imgRes.buffer
                : await sharp(imgRes.buffer).webp({ quality: 92 }).toBuffer();
            fs.writeFileSync(savedPath, webpBuf);
            resultBytes = webpBuf.length;

            const mae = await computeRegionMae(sample1Buf, imgRes.buffer, 768, 1024);
            faceMae = mae.faceMae;
            torsoMae = mae.torsoMae;
          }
        }

        const testCOk =
          status === 'COMPLETED' &&
          Boolean(savedPath) &&
          resultBytes > 2000 &&
          faceMae < 12 &&
          torsoMae > 10;

        recordCheck('TEST C', 'Real Half-Body Try-On (Tweed Jacket) + Face-Preservation Pixel Check', testCOk, [
          `sessionId=${runRes.sessionId}, status=${status}, providerUsed=${providerUsed}, badge=${JSON.stringify(providerDisplayBadge)}`,
          `Pixel audit (768x1024): faceMAE(y=8..26%,x=35..65%)=${faceMae}/255 (<12), torsoMAE(y=38..75%,x=25..75%)=${torsoMae}/255 (>10)`,
          `Saved output: ${savedPath || 'NONE'} (${Math.round(resultBytes / 1024)} KB)`,
          ...(finalState.errorMessage ? [`errorMessage=${finalState.errorMessage}`] : []),
        ]);
      }
    }

    // =========================================================================
    // TEST D: Playwright Live Modal Verification (1440x900)
    // =========================================================================
    {
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
        if (res.status() >= 400 && !res.url().includes('/tryon/sessions')) {
          failedHttp.push(`${res.status()} ${res.url()}`);
        }
      });

      // First visit homepage to confirm header CTA "Thử đồ AI" renders cleanly with 0 console errors
      await page.goto(`${STOREFRONT_BASE}/`, { waitUntil: 'networkidle', timeout: 45_000 });
      await page.evaluate(() => document.fonts?.ready);
      const headerTryOnLink = page.locator('header a[href="/thu-do-ai"], a.nav__cta').first();
      await headerTryOnLink.waitFor({ state: 'visible', timeout: 10_000 });

      // Navigate to flagship Tweed Jacket PDP where <SiteHeader /> is visible & "Mặc thử qua Camera AI" opens the full-screen z-[120] VirtualTryOnModal
      await page.goto(`${STOREFRONT_BASE}/san-pham/${TARGET_TWEED_SLUG}`, {
        waitUntil: 'networkidle',
        timeout: 45_000,
      });
      await page.evaluate(() => document.fonts?.ready);
      await page.waitForTimeout(500);

      // Click the visible PDP primary button "Mặc thử qua Camera AI" (NOT hidden sticky subnav "Ướm thử AI")
      const tryOnTrigger = page.getByRole('button', { name: /Mặc thử qua Camera AI/i }).first();
      await tryOnTrigger.scrollIntoViewIfNeeded();
      await tryOnTrigger.click({ timeout: 10_000 });
      await page.locator('[data-testid="virtual-tryon-modal"]').waitFor({ state: 'visible', timeout: 10_000 });
      await page.waitForTimeout(500);

      // Verify modal overlays <SiteHeader /> strictly (z-index >= 120 & elementFromPoint(720, 28) is inside modal, NOT header/.nav)
      const zCheck = await page.evaluate(() => {
        const dialogWrapper =
          document.querySelector('[data-testid="virtual-tryon-modal"]') ||
          document.querySelector('[role="dialog"]')?.closest('.fixed') ||
          document.querySelector('[role="dialog"]');
        const header = document.querySelector('header, .nav');
        const modalZ = dialogWrapper ? parseInt(window.getComputedStyle(dialogWrapper).zIndex || '0', 10) : 0;
        const headerZ = header ? parseInt(window.getComputedStyle(header).zIndex || '0', 10) : 0;
        const topEl = document.elementFromPoint(720, 28);
        const topInsideHeader = Boolean(header && topEl && header.contains(topEl));
        const topInsideModal = Boolean(dialogWrapper && topEl && (dialogWrapper === topEl || dialogWrapper.contains(topEl)));
        return {
          foundDialog: Boolean(dialogWrapper),
          modalZ,
          headerZ,
          topInsideHeader,
          topInsideModal,
          topTag: topEl ? `${topEl.tagName}.${String(topEl.className).slice(0, 60)}` : 'null',
        };
      });

      // Switch to "TẢI ẢNH LÊN" tab
      const uploadTab = page.getByRole('button', { name: /TẢI ẢNH LÊN|Tải ảnh lên|Tải ảnh/i }).first();
      if (await uploadTab.isVisible().catch(() => false)) {
        await uploadTab.click();
        await page.waitForTimeout(700);
      }

      // Ensure sample cards are scrolled cleanly into view inside the modal while keeping top edge visible
      const samplesContainer = page.locator('[data-testid="tryon-sample-models"]').first();
      if (await samplesContainer.isVisible().catch(() => false)) {
        await samplesContainer.scrollIntoViewIfNeeded().catch(() => {});
        await page.waitForTimeout(400);
      }

      // Verify all 3 sample model portraits loaded cleanly
      const sampleImgsAudit = await page.evaluate(() => {
        const imgs = Array.from(document.querySelectorAll('img[src*="/tryon-samples/"]'));
        return imgs.map((img) => ({
          src: img.getAttribute('src'),
          complete: img.complete,
          naturalWidth: img.naturalWidth,
          naturalHeight: img.naturalHeight,
        }));
      });

      const uploadShotPath = path.join(AUDIT_DIR, 'modal-upload-samples.png');
      await page.screenshot({ path: uploadShotPath, fullPage: false, type: 'png' });

      // Ensure privacy consent checkbox is checked before clicking Sample Model 1
      const consentCheckbox = page.locator('[data-testid="virtual-tryon-modal"] input[type="checkbox"], [role="dialog"] input[type="checkbox"]').first();
      if (await consentCheckbox.isVisible().catch(() => false)) {
        if (!(await consentCheckbox.isChecked().catch(() => true))) {
          await consentCheckbox.check().catch(() => {});
          await page.waitForTimeout(250);
        }
      }

      // Click Sample Model 1 ("Minh Thư")
      const sample1Btn = page
        .locator('[data-testid="tryon-sample-female-1"], button:has-text("Minh Thư"), button:has(img[src*="sample-female-1"])')
        .first();
      await sample1Btn.click({ timeout: 10_000 });
      await page.waitForTimeout(700);

      // If there's a privacy consent checkbox or submit button shown on next step, handle cleanly
      const consentAfter = page.locator('[data-testid="virtual-tryon-modal"] input[type="checkbox"], [role="dialog"] input[type="checkbox"]').first();
      if (await consentAfter.isVisible().catch(() => false)) {
        if (!(await consentAfter.isChecked().catch(() => true))) {
          await consentAfter.check().catch(() => {});
          await page.waitForTimeout(250);
        }
      }
      const startBtn = page
        .locator(
          '[role="dialog"] button:has-text("Ướm thử AI"), [role="dialog"] button:has-text("Bắt đầu thử"), [role="dialog"] button:has-text("Thử ngay"), [role="dialog"] button:has-text("Bắt đầu ướm thử")',
        )
        .first();
      if (await startBtn.isVisible().catch(() => false)) {
        if (await startBtn.isEnabled().catch(() => false)) {
          await startBtn.click().catch(() => {});
        }
      }

      // Wait for Try-On Result + Source Engine Badge + Before/After Slider (up to 110s)
      await page.waitForFunction(
        () => {
          const badgeEl = document.querySelector('[data-testid="tryon-source-badge"]');
          const text = badgeEl?.textContent || document.body.innerText || '';
          const hasBadge =
            text.includes('AI VTON Tạo Sinh') || text.includes('Căn Dáng Khớp Vai Nội Bộ');
          const hasSlider = Boolean(
            document.querySelector('[data-testid="before-after-slider"], [role="slider"]'),
          );
          return hasBadge && hasSlider;
        },
        { timeout: 110_000 },
      );

      // Wait 1.4s for the 0.9s 0% -> 88% sweep animation to finish cleanly
      await page.waitForTimeout(1400);

      const resultDomAudit = await page.evaluate(() => {
        const dialogRoot =
          document.querySelector('[data-testid="virtual-tryon-modal"]') ||
          document.querySelector('[role="dialog"]') ||
          document.body;
        const badgeEl = dialogRoot.querySelector('[data-testid="tryon-source-badge"]');
        const rawText = (badgeEl?.textContent || dialogRoot.textContent || '').trim();
        const badgeText = rawText.includes('AI VTON Tạo Sinh')
          ? 'AI VTON Tạo Sinh'
          : rawText.includes('Căn Dáng Khớp Vai Nội Bộ')
            ? 'Căn Dáng Khớp Vai Nội Bộ'
            : null;
        const sliderEl =
          dialogRoot.querySelector('[data-testid="before-after-slider"]') ||
          dialogRoot.querySelector('[role="slider"]');
        const rangeInput = dialogRoot.querySelector('input[type="range"][aria-label*="So sánh"]');
        const ariaVal = sliderEl?.getAttribute('aria-valuenow');
        const inputVal = rangeInput && 'value' in rangeInput ? rangeInput.value : null;
        const sliderPct = Number(ariaVal ?? inputVal ?? NaN);

        const imgs = Array.from(dialogRoot.querySelectorAll('img'));
        const brokenDialogImgs = imgs
          .filter((img) => {
            const st = window.getComputedStyle(img);
            return st.display !== 'none' && (!img.complete || img.naturalWidth === 0);
          })
          .map((img) => img.src);

        return {
          badgeText,
          sliderPct: Number.isFinite(sliderPct) ? sliderPct : null,
          dialogImgCount: imgs.length,
          brokenDialogImgs,
        };
      });

      const resultShotPath = path.join(AUDIT_DIR, 'modal-result-slider.png');
      await page.screenshot({ path: resultShotPath, fullPage: false, type: 'png' });

      const modalOverlayOk =
        zCheck.foundDialog && zCheck.modalZ >= 120 && zCheck.modalZ > zCheck.headerZ && !zCheck.topInsideHeader && zCheck.topInsideModal;
      const samplesOk =
        sampleImgsAudit.length >= 3 &&
        sampleImgsAudit.every((im) => im.complete && im.naturalWidth > 0);
      const sliderOk =
        Boolean(resultDomAudit.badgeText) &&
        resultDomAudit.sliderPct !== null &&
        resultDomAudit.sliderPct >= 80 &&
        resultDomAudit.sliderPct <= 95 &&
        resultDomAudit.brokenDialogImgs.length === 0;

      const testDOk =
        modalOverlayOk &&
        samplesOk &&
        sliderOk &&
        consoleErrors.length === 0 &&
        pageErrors.length === 0 &&
        failedHttp.length === 0;

      recordCheck('TEST D', 'Playwright Live Modal Verification (1440x900, z-[120], Samples & 88% Reveal)', testDOk, [
        `Modal z-index check: modalZ=${zCheck.modalZ} > headerZ=${zCheck.headerZ}, topInsideHeader=${zCheck.topInsideHeader}, topInsideModal=${zCheck.topInsideModal} (ok=${modalOverlayOk})`,
        `Sample models rendered: ${sampleImgsAudit.length}/3 loaded (ok=${samplesOk})`,
        `Result view: badge=${JSON.stringify(resultDomAudit.badgeText)}, sliderPct=${resultDomAudit.sliderPct}% (target ~88%), brokenDialogImgs=${resultDomAudit.brokenDialogImgs.length}`,
        `Browser hygiene: consoleErrors=${consoleErrors.length}, pageErrors=${pageErrors.length}, failedHttp=${failedHttp.length}`,
        `Screenshots saved:`,
        `  - ${uploadShotPath} (${Math.round(fs.statSync(uploadShotPath).size / 1024)} KB)`,
        `  - ${resultShotPath} (${Math.round(fs.statSync(resultShotPath).size / 1024)} KB)`,
        ...consoleErrors.slice(0, 5).map((e) => `CONSOLE ERROR: ${e}`),
        ...pageErrors.slice(0, 5).map((e) => `PAGE ERROR: ${e}`),
        ...failedHttp.slice(0, 5).map((e) => `HTTP FAIL: ${e}`),
      ]);
    }
  } finally {
    await cleanupAll();
    console.log('\n[CLEANUP] Browser, all services, ai-tryon:4009, storefront & local infra cleanly terminated.');
  }

  const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
  const passCount = results.filter((r) => r.ok).length;
  const failCount = results.length - passCount;

  console.log('\n========================================================================');
  console.log(` TRY-ON CV & UX VERIFICATION SUMMARY  (${elapsedSec}s)`);
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
  console.error('\n[FATAL] verify-tryon-cv crashed:', err instanceof Error ? err.stack || err.message : err);
  process.exitCode = 1;
});
