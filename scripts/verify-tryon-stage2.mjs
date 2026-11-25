#!/usr/bin/env node
/**
 * Virtual Try-On Stage 2 — Comprehensive Full-Stack E2E & Real Chrome Visual Suite
 * fashion-atelier-ai-platform (v3.2)
 *
 * Tests:
 *   PREFLIGHT : Live 200 OK on :4009/health, :4009/ready, :4000/health, :4002/health,
 *               :3000/, :3000/thu-do-ai, :11434/api/tags + D: drive storageIsolation
 *   TEST 1    : Magic Bytes (400 INVALID_IMAGE_MAGIC_BYTES) & Private MinIO Bucket Security
 *               (Presigned X-Amz-Signature 200 OK vs unsigned direct GET 403 Forbidden)
 *   TEST 2    : Single Garment Synthesis (Áo Len Cashmere Cổ Lọ -> 202 QUEUED -> COMPLETED,
 *               768x1024 output, saved as stage2-result-raw-768x1024.png)
 *   TEST 3    : Redis SHA-256 Cache (< 500ms, HTTP 200 OK, cacheHit=true, ZERO quota deduction)
 *   TEST 4    : Sequential 2-Step Mix & Match (OUTFIT: UPPER + LOWER, stepTotal=2, 768x1024)
 *   TEST 5    : 15-Min Auto-Purge (POST /internal/tryon/purge-now -> 403 without secret,
 *               200 with secret -> presigned URL becomes 404) & C: Drive Temp Zero-Pollution
 *   TEST 6    : Real Chrome (1440x900) Live UI Proof on http://127.0.0.1:3000 & http://localhost:3000
 *               (SiteHeader -> THỬ ĐỒ AI, Thảo Vy + Áo Len Cashmere Cổ Lọ -> live backend provider,
 *               Before/After slider, provider badge, 🔒 Tự xóa sau MM:SS, Sticky CTA,
 *               Cacao Đậm -> Kem Cashmere instant ⚡ cache hit, Phối cả bộ 2-step + THÊM CẢ BỘ VÀO GIỎ,
 *               0 pageerror / 0 console.error / 0 HTTP>=400)
 *
 * Captures 4 crisp PNGs into:
 *   C:\Users\Admin\.gemini\antigravity\brain\d1783908-6521-4608-8b37-41aae3ee9a65\scratch\tryon-stage2-audit\
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const IS_WIN = process.platform === 'win32';

const ORIGIN_IP = 'http://127.0.0.1:3000';
const ORIGIN_LOCALHOST = 'http://localhost:3000';
const AI_TRYON_URL = 'http://127.0.0.1:4009';
const BFF_URL = 'http://127.0.0.1:4000';

const AUDIT_DIR =
  process.env.TRYON_STAGE2_AUDIT_DIR ||
  'C:\\Users\\Admin\\.gemini\\antigravity\\brain\\d1783908-6521-4608-8b37-41aae3ee9a65\\scratch\\tryon-stage2-audit';

const PORTRAIT_PATH = path.join(
  ROOT_DIR,
  'apps',
  'storefront',
  'public',
  'images',
  'tryon-models',
  'vn-model-balanced-s.webp',
);

const VENV_PYTHON = path.join(ROOT_DIR, 'services', 'ai-tryon', '.venv', 'Scripts', 'python.exe');
const D_TMP_DIR = path.join(ROOT_DIR, '.project-data', 'tmp');
const D_MODELS_DIR = path.join(ROOT_DIR, '.project-data', 'ai-models');
const C_TEMP_DIR = IS_WIN ? 'C:\\Users\\Admin\\AppData\\Local\\Temp' : os.tmpdir();

function readEnvValue(key, fallback = '') {
  if (process.env[key]) return process.env[key];
  const envPath = path.join(ROOT_DIR, '.env');
  if (!fs.existsSync(envPath)) return fallback;
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    if (trimmed.slice(0, eq).trim() === key) {
      return trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    }
  }
  return fallback;
}

const INTERNAL_SECRET = readEnvValue('INTERNAL_SERVICE_SECRET', 'Atelier_Internal_Svc_2026!');

const results = [];

function recordCheck(id, title, ok, details = []) {
  results.push({ id, title, ok, details });
  console.log(`\n[${ok ? 'PASS' : 'FAIL'}] ${id} — ${title}`);
  for (const line of details) {
    console.log(`       ${line}`);
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

function httpRequest(
  urlString,
  { method = 'GET', headers = {}, body = undefined, timeoutMs = 20_000, binary = false } = {},
) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const parsed = new URL(urlString);
    const reqHeaders = { ...headers };
    let buf = null;
    if (body !== undefined) {
      buf = Buffer.isBuffer(body)
        ? body
        : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
      if (!reqHeaders['Content-Type']) reqHeaders['Content-Type'] = 'application/json';
      reqHeaders['Content-Length'] = String(buf.length);
    }
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || 80,
        path: `${parsed.pathname}${parsed.search}`,
        method,
        headers: reqHeaders,
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const latencyMs = Math.round(performance.now() - t0);
          const rawBuf = Buffer.concat(chunks);
          if (binary) {
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers,
              bytes: rawBuf.length,
              buffer: rawBuf,
              text: '',
              json: null,
              latencyMs,
              error: null,
            });
            return;
          }
          const text = rawBuf.toString('utf8');
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            // non-JSON
          }
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            bytes: rawBuf.length,
            buffer: rawBuf,
            text,
            json,
            latencyMs,
            error: null,
          });
        });
      },
    );
    req.on('timeout', () => {
      req.destroy();
      resolve({
        status: 0,
        headers: {},
        bytes: 0,
        buffer: Buffer.alloc(0),
        text: '',
        json: null,
        latencyMs: Math.round(performance.now() - t0),
        error: 'timeout',
      });
    });
    req.on('error', (err) => {
      resolve({
        status: 0,
        headers: {},
        bytes: 0,
        buffer: Buffer.alloc(0),
        text: '',
        json: null,
        latencyMs: Math.round(performance.now() - t0),
        error: err.message,
      });
    });
    if (buf) req.write(buf);
    req.end();
  });
}

function inspectAndOptionallySavePng(imageBuffer, outPngPath = null) {
  const pyCode = [
    'import io, json, sys',
    'from PIL import Image',
    'data = sys.stdin.buffer.read()',
    'im = Image.open(io.BytesIO(data))',
    'fmt = im.format',
    'w, h = im.size',
    'out_path = sys.argv[1] if len(sys.argv) > 1 and sys.argv[1] else ""',
    'if out_path:',
    '    im.convert("RGB").save(out_path, format="PNG")',
    'print(json.dumps({"format": fmt, "width": w, "height": h, "bytes": len(data)}))',
  ].join('\n');

  const out = execFileSync(VENV_PYTHON, ['-c', pyCode, outPngPath || ''], {
    input: imageBuffer,
    env: {
      ...process.env,
      TMP: D_TMP_DIR,
      TEMP: D_TMP_DIR,
      TMPDIR: D_TMP_DIR,
      GRADIO_TEMP_DIR: D_TMP_DIR,
      HF_HOME: path.join(D_MODELS_DIR, 'huggingface'),
      U2NET_HOME: path.join(D_MODELS_DIR, 'u2net'),
      MPLCONFIGDIR: path.join(D_MODELS_DIR, 'mpl'),
    },
    maxBuffer: 20 * 1024 * 1024,
  });
  return JSON.parse(out.toString('utf8').trim());
}

function listDirEntriesSafe(dirPath) {
  try {
    return new Set(fs.readdirSync(dirPath));
  } catch {
    return new Set();
  }
}

async function pollJobUntilDone(jobId, headers, { maxWaitMs = 95_000, pollIntervalMs = 800 } = {}) {
  const t0 = performance.now();
  const seenStatuses = [];
  let lastPayload = null;

  while (performance.now() - t0 < maxWaitMs) {
    const res = await httpRequest(`${ORIGIN_IP}/bff/v1/tryon/jobs/${encodeURIComponent(jobId)}`, {
      method: 'GET',
      headers,
      timeoutMs: 12_000,
    });
    if (res.status === 200 && res.json) {
      lastPayload = res.json;
      const st = String(res.json.status || '').toUpperCase();
      if (seenStatuses[seenStatuses.length - 1] !== st) {
        seenStatuses.push(st);
      }
      if (st === 'COMPLETED' || st === 'FAILED' || st === 'CANCELLED') {
        return {
          status: st,
          payload: res.json,
          seenStatuses,
          elapsedMs: Math.round(performance.now() - t0),
        };
      }
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
  return {
    status: 'TIMEOUT',
    payload: lastPayload,
    seenStatuses,
    elapsedMs: Math.round(performance.now() - t0),
  };
}

async function waitForStage2UiResult(page, { prevSrc = null, timeoutMs = 95_000 } = {}) {
  await page.waitForFunction(
    (previous) => {
      const scan = document.querySelector('[data-testid="optical-tryon-scan"]');
      if (scan) return false;
      const img = document.querySelector('[data-testid="before-after-after-img"]');
      if (!(img instanceof HTMLImageElement)) return false;
      if (!img.complete || img.naturalWidth !== 768 || img.naturalHeight !== 1024) return false;
      if (!img.src || (!img.src.startsWith('http://') && !img.src.startsWith('https://') && !img.src.startsWith('data:image/'))) {
        return false;
      }
      if (previous && img.src === previous) return false;
      return true;
    },
    prevSrc,
    { timeout: timeoutMs },
  );

  // Allow the 0.85s smooth 15% -> 88% curtain reveal to finish cleanly
  await page.waitForTimeout(1050);

  return page.evaluate(() => {
    const stage = document.querySelector('[data-testid="tryon-stage-viewport"]');
    const afterImg = document.querySelector('[data-testid="before-after-after-img"]');
    const beforeImg = document.querySelector('[data-testid="before-after-before-img"]');
    const providerBadge = document.querySelector('[data-testid="tryon-provider-badge"]');
    const countdown = document.querySelector('[data-testid="tryon-privacy-countdown"]');
    const slider = document.querySelector('[data-testid="before-after-slider"]');
    const buyBtn = document.querySelector('[data-testid="tryon-add-to-bag-btn"]');
    const buyRect = buyBtn?.getBoundingClientRect();
    const errEl = document.querySelector('[data-testid="tryon-synthesis-error"]');

    return {
      provider: stage?.getAttribute('data-provider') ?? null,
      cacheHit: stage?.getAttribute('data-cache-hit') ?? null,
      jobId: stage?.getAttribute('data-job-id') ?? null,
      stepTotal: stage?.getAttribute('data-step-total') ?? null,
      dataProviderBadge: stage?.getAttribute('data-provider-badge') ?? null,
      cleanCollar: stage?.getAttribute('data-clean-collar') ?? null,
      providerBadgeText: (providerBadge?.textContent || '').trim(),
      countdownText: (countdown?.textContent || '').trim(),
      sliderValNow: slider?.getAttribute('aria-valuenow') ?? null,
      afterSrc: afterImg instanceof HTMLImageElement ? afterImg.src : null,
      afterW: afterImg instanceof HTMLImageElement ? afterImg.naturalWidth : 0,
      afterH: afterImg instanceof HTMLImageElement ? afterImg.naturalHeight : 0,
      beforeW: beforeImg instanceof HTMLImageElement ? beforeImg.naturalWidth : 0,
      beforeH: beforeImg instanceof HTMLImageElement ? beforeImg.naturalHeight : 0,
      buyText: (buyBtn?.textContent || '').trim(),
      buyRect: buyRect
        ? {
            top: Math.round(buyRect.top * 10) / 10,
            bottom: Math.round(buyRect.bottom * 10) / 10,
            height: Math.round(buyRect.height * 10) / 10,
          }
        : null,
      buyInViewport: Boolean(
        buyRect && buyRect.top >= 0 && buyRect.bottom <= 900.5 && buyRect.height > 0,
      ),
      synthesisErrorText: errEl ? (errEl.textContent || '').trim() : null,
    };
  });
}

async function main() {
  const startedAt = Date.now();
  fs.mkdirSync(AUDIT_DIR, { recursive: true });
  const runSalt = `s2-${Date.now().toString(36)}`;

  console.log('========================================================================');
  console.log(' Virtual Try-On Stage 2 — Full-Stack E2E & Real Chrome Visual Suite');
  console.log(` Audit Dir : ${AUDIT_DIR}`);
  console.log(` Run Salt  : ${runSalt}`);
  console.log('========================================================================');

  // Snapshot C:\Users\Admin\AppData\Local\Temp BEFORE any synthesis runs (for Test 5)
  const cTempBefore = listDirEntriesSafe(C_TEMP_DIR);

  // ---------------------------------------------------------------------------
  // PREFLIGHT: All 7 live services + D: drive isolation check + live catalog SKUs
  // ---------------------------------------------------------------------------
  const healthTargets = [
    ['ai-tryon-health', `${AI_TRYON_URL}/health`],
    ['ai-tryon-ready', `${AI_TRYON_URL}/ready`],
    ['bff-health', `${BFF_URL}/health`],
    ['catalog-health', 'http://127.0.0.1:4002/health'],
    ['storefront-ip-home', `${ORIGIN_IP}/`],
    ['storefront-ip-tryon', `${ORIGIN_IP}/thu-do-ai`],
    ['storefront-lh-tryon', `${ORIGIN_LOCALHOST}/thu-do-ai`],
    ['ollama-tags', 'http://127.0.0.1:11434/api/tags'],
  ];

  const healthChecks = await Promise.all(
    healthTargets.map(async ([label, url]) => ({ label, url, ...(await httpRequest(url)) })),
  );
  const readyJson = healthChecks.find((c) => c.label === 'ai-tryon-ready')?.json;
  const tmpDirConfigured = String(readyJson?.checks?.storageIsolation?.tmpDir || '');
  const modelsDirConfigured = String(readyJson?.checks?.storageIsolation?.modelsDir || '');
  const dDriveIsoOk =
    tmpDirConfigured.toUpperCase().startsWith('D:\\') &&
    modelsDirConfigured.toUpperCase().startsWith('D:\\');

  const catalogRes = await httpRequest(`${BFF_URL}/bff/v1/storefront/products?limit=40`);
  const products =
    catalogRes.json?.data?.items ||
    catalogRes.json?.data?.products ||
    catalogRes.json?.data ||
    [];
  const cashmereProd = products.find((p) => p.slug === 'ao-len-cashmere-co-lo');
  const woolTrousersProd = products.find((p) => p.slug === 'quan-ong-suong-wool-blend');

  const preflightOk =
    healthChecks.every((c) => c.status === 200) &&
    readyJson?.ready === true &&
    readyJson?.checks?.redis?.status === 'up' &&
    readyJson?.checks?.minio?.status === 'up' &&
    dDriveIsoOk &&
    Boolean(cashmereProd) &&
    Boolean(woolTrousersProd);

  recordCheck(
    'PREFLIGHT',
    'All 7 live services 200 OK, Redis/MinIO UP, D: Drive isolation active, Catalog SKUs resolved',
    preflightOk,
    [
      ...healthChecks.map((c) => `${c.label}: HTTP ${c.status} (${c.bytes}B, ${c.latencyMs}ms)`),
      `storageIsolation: tmpDir="${tmpDirConfigured}", modelsDir="${modelsDirConfigured}"`,
      `Cashmere SKU: ${cashmereProd?.id} / ${cashmereProd?.variants?.[0]?.id}`,
      `Wool Trousers SKU: ${woolTrousersProd?.id} / ${woolTrousersProd?.variants?.[0]?.id}`,
    ],
  );
  if (!preflightOk) {
    process.exit(1);
  }

  const pickGarmentUrl = (prod) => {
    const v = prod.variants?.[0] || {};
    return v.studioLayerUrl || v.rackFrontUrl || v.tryonFlatPreviewUrl || v.lookbookMainUrl;
  };

  const cashmereGarmentBase = {
    productId: cashmereProd.id,
    variantId: `${cashmereProd.variants[0].id}-${runSalt}`,
    slot: 'upper',
    name: cashmereProd.name,
    garmentImageUrl: pickGarmentUrl(cashmereProd),
    colorHex: cashmereProd.variants[0].colorHex,
    colorName: cashmereProd.variants[0].colorName,
  };

  const woolTrousersGarmentBase = {
    productId: woolTrousersProd.id,
    variantId: `${woolTrousersProd.variants[0].id}-${runSalt}`,
    slot: 'lower',
    name: woolTrousersProd.name,
    garmentImageUrl: pickGarmentUrl(woolTrousersProd),
    colorHex: woolTrousersProd.variants[0].colorHex,
    colorName: woolTrousersProd.variants[0].colorName,
  };

  const portraitBytes = fs.readFileSync(PORTRAIT_PATH);
  const portraitDataUrl = `data:image/webp;base64,${portraitBytes.toString('base64')}`;

  // Isolated test user headers so quota assertions are deterministic & unaffected by browser traffic
  const apiTestHeaders = {
    'x-user-id': `stage2-verifier-${runSalt}`,
    'x-forwarded-for': '10.99.2.10',
  };

  // ---------------------------------------------------------------------------
  // TEST 1A: Magic Bytes Security (Spoofed text-as-JPEG rejected with 400 INVALID_IMAGE_MAGIC_BYTES)
  // ---------------------------------------------------------------------------
  const spoofedPayload = Buffer.from(
    'THIS IS PLAIN TEXT SPOOFED AS A JPEG FILE - MALICIOUS PAYLOAD TEST',
    'utf8',
  ).toString('base64');

  const spoofRes = await httpRequest(`${ORIGIN_IP}/bff/v1/tryon/synthesize`, {
    method: 'POST',
    headers: apiTestHeaders,
    body: {
      personImageDataUrl: `data:image/jpeg;base64,${spoofedPayload}`,
      personFrameHash: `spoof-${runSalt}`,
      mode: 'SINGLE',
      lightingPreset: 'atelier',
      privacyConsent: true,
      garments: [cashmereGarmentBase],
    },
  });

  const spoofCode = spoofRes.json?.code || spoofRes.json?.error?.code || spoofRes.json?.errorCode;

  const noConsentRes = await httpRequest(`${ORIGIN_IP}/bff/v1/tryon/synthesize`, {
    method: 'POST',
    headers: apiTestHeaders,
    body: {
      personImageDataUrl: portraitDataUrl,
      personFrameHash: `noconsent-${runSalt}`,
      mode: 'SINGLE',
      lightingPreset: 'atelier',
      privacyConsent: false,
      garments: [cashmereGarmentBase],
    },
  });
  const noConsentCode =
    noConsentRes.json?.code || noConsentRes.json?.error?.code || noConsentRes.json?.errorCode;

  // ---------------------------------------------------------------------------
  // TEST 2: Single Garment Synthesis (Áo Len Cashmere Cổ Lọ -> 202 -> COMPLETED, 768x1024)
  // ---------------------------------------------------------------------------
  const singleBody = {
    personImageDataUrl: portraitDataUrl,
    personFrameHash: `balanced-s-${runSalt}`,
    mode: 'SINGLE',
    lightingPreset: 'atelier',
    privacyConsent: true,
    garments: [cashmereGarmentBase],
  };

  const singleStart = await httpRequest(`${ORIGIN_IP}/bff/v1/tryon/synthesize`, {
    method: 'POST',
    headers: apiTestHeaders,
    body: singleBody,
  });

  const singleJobId = singleStart.json?.jobId || singleStart.json?.sessionId;
  const test2QuotaAfterSubmit = singleStart.json?.quotaRemaining;
  let singlePoll = null;
  let singleResultUrl = null;
  let singleImgMeta = null;
  const rawPngOut = path.join(AUDIT_DIR, 'stage2-result-raw-768x1024.png');

  if (singleStart.status === 202 && singleJobId) {
    singlePoll = await pollJobUntilDone(singleJobId, apiTestHeaders, { maxWaitMs: 95_000 });
    singleResultUrl = singlePoll.payload?.resultUrl || singlePoll.payload?.resultImageUrl || null;
  }

  let signedGetRes = null;
  let unsignedGetRes = null;
  if (singleResultUrl) {
    signedGetRes = await httpRequest(singleResultUrl, { binary: true, timeoutMs: 12_000 });
    if (signedGetRes.status === 200 && signedGetRes.buffer.length > 0) {
      singleImgMeta = inspectAndOptionallySavePng(signedGetRes.buffer, rawPngOut);
    }
    const unsignedUrl = singleResultUrl.split('?')[0];
    unsignedGetRes = await httpRequest(unsignedUrl, { timeoutMs: 10_000 });
  }

  const test1Ok =
    spoofRes.status === 400 &&
    spoofCode === 'INVALID_IMAGE_MAGIC_BYTES' &&
    noConsentRes.status === 400 &&
    noConsentCode === 'PRIVACY_CONSENT_REQUIRED' &&
    Boolean(singleResultUrl && singleResultUrl.includes('X-Amz-Signature')) &&
    signedGetRes?.status === 200 &&
    unsignedGetRes?.status === 403;

  recordCheck(
    'TEST 1',
    'Magic Bytes Validation (400 INVALID_IMAGE_MAGIC_BYTES) & Private Bucket Security (Signed 200 vs Unsigned 403)',
    test1Ok,
    [
      `Spoofed .jpg -> HTTP ${spoofRes.status}, code=${spoofCode}`,
      `privacyConsent=false -> HTTP ${noConsentRes.status}, code=${noConsentCode}`,
      `Presigned URL has X-Amz-Signature: ${Boolean(singleResultUrl?.includes('X-Amz-Signature'))}`,
      `Signed GET -> HTTP ${signedGetRes?.status} (${signedGetRes?.bytes}B)`,
      `Unsigned direct MinIO GET (atelier-private-tryon) -> HTTP ${unsignedGetRes?.status} (expected 403)`,
    ],
  );

  const test2Ok =
    singleStart.status === 202 &&
    singleStart.json?.status === 'QUEUED' &&
    singlePoll?.status === 'COMPLETED' &&
    Boolean(singleResultUrl) &&
    singleImgMeta?.width === 768 &&
    singleImgMeta?.height === 1024 &&
    fs.existsSync(rawPngOut);

  const test2ProviderUsed = singlePoll?.payload?.providerUsed || null;
  const test2ProviderBadge = singlePoll?.payload?.providerBadge || null;

  recordCheck(
    'TEST 2',
    'Single Garment Async Synthesis (Áo Len Cashmere Cổ Lọ -> 202 QUEUED -> COMPLETED, 768x1024)',
    test2Ok,
    [
      `POST /bff/v1/tryon/synthesize -> HTTP ${singleStart.status}, jobId=${singleJobId}, quotaRemaining=${test2QuotaAfterSubmit}`,
      `Poll transitions: QUEUED -> ${singlePoll?.seenStatuses?.join(' -> ')} (${singlePoll?.elapsedMs}ms)`,
      `Provider: ${test2ProviderUsed} | Badge: "${test2ProviderBadge}"`,
      `Result image: ${singleImgMeta?.format} ${singleImgMeta?.width}x${singleImgMeta?.height} (${singleImgMeta?.bytes}B)`,
      `Saved raw result PNG: ${rawPngOut}`,
    ],
  );

  // ---------------------------------------------------------------------------
  // TEST 3: Redis SHA-256 Cache (< 500ms, HTTP 200 OK, cacheHit=true, ZERO quota deduction)
  // ---------------------------------------------------------------------------
  const cacheRes = await httpRequest(`${ORIGIN_IP}/bff/v1/tryon/synthesize`, {
    method: 'POST',
    headers: apiTestHeaders,
    body: singleBody,
  });

  const test3CacheHitMs = cacheRes.latencyMs;
  const test3QuotaAfter = cacheRes.json?.quotaRemaining;
  const test3Ok =
    cacheRes.status === 200 &&
    cacheRes.json?.cacheHit === true &&
    cacheRes.json?.status === 'COMPLETED' &&
    test3CacheHitMs < 500 &&
    typeof test2QuotaAfterSubmit === 'number' &&
    test3QuotaAfter === test2QuotaAfterSubmit &&
    Boolean(cacheRes.json?.resultUrl?.includes('X-Amz-Signature'));

  recordCheck(
    'TEST 3',
    'Redis SHA-256 Content-Hash Cache (< 500ms, HTTP 200, cacheHit=true, Zero Quota Deduction)',
    test3Ok,
    [
      `Repeat exact request -> HTTP ${cacheRes.status} in ${test3CacheHitMs}ms (< 500ms)`,
      `cacheHit=${cacheRes.json?.cacheHit}, status=${cacheRes.json?.status}, providerBadge="${cacheRes.json?.providerBadge}"`,
      `quotaRemaining: Test2=${test2QuotaAfterSubmit} -> Test3=${test3QuotaAfter} (delta=${(test3QuotaAfter ?? 0) - (test2QuotaAfterSubmit ?? 0)})`,
      `cacheKey=${cacheRes.json?.cacheKey}`,
    ],
  );

  // ---------------------------------------------------------------------------
  // TEST 4: Sequential 2-Step Mix & Match (OUTFIT: UPPER + LOWER, stepTotal=2, 768x1024)
  // ---------------------------------------------------------------------------
  const outfitBody = {
    personImageDataUrl: portraitDataUrl,
    personFrameHash: `balanced-s-${runSalt}`,
    mode: 'OUTFIT',
    lightingPreset: 'atelier',
    privacyConsent: true,
    garments: [
      {
        ...cashmereGarmentBase,
        variantId: `${cashmereProd.variants[0].id}-outfit-${runSalt}`,
      },
      {
        ...woolTrousersGarmentBase,
        variantId: `${woolTrousersProd.variants[0].id}-outfit-${runSalt}`,
      },
    ],
  };

  const outfitStart = await httpRequest(`${ORIGIN_IP}/bff/v1/tryon/synthesize`, {
    method: 'POST',
    headers: apiTestHeaders,
    body: outfitBody,
  });
  const outfitJobId = outfitStart.json?.jobId || outfitStart.json?.sessionId;
  let outfitPoll = null;
  let outfitImgMeta = null;
  if (outfitStart.status === 202 && outfitJobId) {
    outfitPoll = await pollJobUntilDone(outfitJobId, apiTestHeaders, { maxWaitMs: 95_000 });
    const outfitUrl = outfitPoll.payload?.resultUrl || outfitPoll.payload?.resultImageUrl;
    if (outfitUrl) {
      const bin = await httpRequest(outfitUrl, { binary: true, timeoutMs: 12_000 });
      if (bin.status === 200 && bin.buffer.length > 0) {
        outfitImgMeta = inspectAndOptionallySavePng(bin.buffer);
      }
    }
  }

  const test4Ok =
    outfitStart.status === 202 &&
    outfitStart.json?.stepTotal === 2 &&
    outfitPoll?.status === 'COMPLETED' &&
    outfitPoll?.payload?.stepTotal === 2 &&
    outfitImgMeta?.width === 768 &&
    outfitImgMeta?.height === 1024;

  recordCheck(
    'TEST 4',
    'Sequential 2-Step Mix & Match (OUTFIT: UPPER Cashmere + LOWER Wool Trousers -> stepTotal=2, 768x1024)',
    test4Ok,
    [
      `POST /bff/v1/tryon/synthesize (OUTFIT) -> HTTP ${outfitStart.status}, jobId=${outfitJobId}, stepTotal=${outfitStart.json?.stepTotal}`,
      `Poll transitions: QUEUED -> ${outfitPoll?.seenStatuses?.join(' -> ')} (${outfitPoll?.elapsedMs}ms)`,
      `Provider: ${outfitPoll?.payload?.providerUsed} | Badge: "${outfitPoll?.payload?.providerBadge}"`,
      `Result image: ${outfitImgMeta?.format} ${outfitImgMeta?.width}x${outfitImgMeta?.height} (${outfitImgMeta?.bytes}B)`,
    ],
  );

  // ---------------------------------------------------------------------------
  // TEST 5: 15-Min Auto-Purge (Dedicated Throwaway Session -> 404 after purge) & C: Zero-Pollution
  // ---------------------------------------------------------------------------
  const throwawayBody = {
    personImageDataUrl: portraitDataUrl,
    personFrameHash: `throwaway-${runSalt}`,
    mode: 'SINGLE',
    lightingPreset: 'morning',
    privacyConsent: true,
    garments: [
      {
        ...cashmereGarmentBase,
        variantId: `${cashmereProd.variants[0].id}-purge-${runSalt}`,
      },
    ],
  };

  const throwawayStart = await httpRequest(`${ORIGIN_IP}/bff/v1/tryon/synthesize`, {
    method: 'POST',
    headers: {
      'x-user-id': `stage2-purge-${runSalt}`,
      'x-forwarded-for': '10.99.2.11',
    },
    body: throwawayBody,
  });
  const throwawayJobId = throwawayStart.json?.jobId || throwawayStart.json?.sessionId;
  const throwawayPoll =
    throwawayStart.status === 202 && throwawayJobId
      ? await pollJobUntilDone(
          throwawayJobId,
          { 'x-user-id': `stage2-purge-${runSalt}`, 'x-forwarded-for': '10.99.2.11' },
          { maxWaitMs: 95_000 },
        )
      : null;
  const throwawayResultUrl = throwawayPoll?.payload?.resultUrl || null;
  const prePurgeGet = throwawayResultUrl
    ? await httpRequest(throwawayResultUrl, { binary: true, timeoutMs: 10_000 })
    : null;

  // Verify purge-now rejects missing secret with 403
  const purgeUnauthRes = await httpRequest(`${AI_TRYON_URL}/internal/tryon/purge-now`, {
    method: 'POST',
    body: { session_id: throwawayJobId },
  });

  // Trigger authorized purge ONLY for the dedicated throwaway test session
  const futureIso = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const purgeAuthRes = await httpRequest(`${AI_TRYON_URL}/internal/tryon/purge-now`, {
    method: 'POST',
    headers: { 'x-internal-secret': INTERNAL_SECRET },
    body: {
      session_id: throwawayJobId,
      force_before_iso: futureIso,
    },
  });

  const postPurgeGet = throwawayResultUrl
    ? await httpRequest(throwawayResultUrl, { timeoutMs: 10_000 })
    : null;

  // Verify Test 2's active session was NOT touched by targeted throwaway purge
  const test2StillAlive = singleResultUrl
    ? (await httpRequest(singleResultUrl, { binary: true, timeoutMs: 10_000 })).status === 200
    : false;

  // Check C:\Users\Admin\AppData\Local\Temp for any new gradio/tryon/catvton temp files
  const cTempAfter = listDirEntriesSafe(C_TEMP_DIR);
  const newCTempEntries = [...cTempAfter].filter((name) => !cTempBefore.has(name));
  const suspiciousCTemp = newCTempEntries.filter((name) =>
    /gradio|tryon|catvton|idm.?vton|kolors|u2net|rembg|fashn/i.test(name),
  );

  const test5Ok =
    prePurgeGet?.status === 200 &&
    purgeUnauthRes.status === 403 &&
    purgeAuthRes.status === 200 &&
    (purgeAuthRes.json?.purgedSessions ?? 0) >= 1 &&
    (purgeAuthRes.json?.deletedObjects ?? 0) >= 1 &&
    postPurgeGet?.status === 404 &&
    test2StillAlive &&
    suspiciousCTemp.length === 0;

  recordCheck(
    'TEST 5',
    '15-Min Auto-Purge (Unauthorized 403, Targeted Purge -> MinIO 404) & C: Drive Zero-Pollution',
    test5Ok,
    [
      `Throwaway jobId=${throwawayJobId}: pre-purge GET=${prePurgeGet?.status}, post-purge GET=${postPurgeGet?.status} (expected 404)`,
      `Unauth purge-now -> HTTP ${purgeUnauthRes.status} (expected 403)`,
      `Auth purge-now -> HTTP ${purgeAuthRes.status}, purgedSessions=${purgeAuthRes.json?.purgedSessions}, deletedObjects=${purgeAuthRes.json?.deletedObjects}`,
      `Other active session (Test 2) untouched: ${test2StillAlive}`,
      `C: Temp (${C_TEMP_DIR}) new gradio/tryon/catvton entries: ${JSON.stringify(suspiciousCTemp)} (total new entries: ${newCTempEntries.length})`,
    ],
  );

  // ---------------------------------------------------------------------------
  // TEST 6: Real Chrome (1440x900) Live UI Proof on http://127.0.0.1:3000 & http://localhost:3000
  // ---------------------------------------------------------------------------
  const chromePath = findChromeExecutable();
  if (!chromePath) {
    throw new Error('Could not find local Chrome/Edge executable.');
  }
  console.log(`\n[BROWSER] Launching Real Chrome: ${chromePath}`);

  const browser = await chromium.launch({
    executablePath: chromePath,
    headless: true,
    args: [
      '--disable-dev-shm-usage',
      '--no-sandbox',
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
    ],
  });

  const pageErrors = [];
  const consoleErrors = [];
  const failedHttp = [];

  const attachListeners = (page, tag) => {
    page.on('pageerror', (err) => {
      pageErrors.push(`[${tag}] ${err.message}`);
    });
    page.on('response', (res) => {
      const status = res.status();
      if (status >= 400) {
        const url = res.url();
        if (!url.includes('/favicon')) {
          failedHttp.push(`[${tag}] ${status} ${res.request().method()} ${url}`);
        }
      }
    });
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        const text = msg.text();
        const loc = msg.location()?.url || '';
        if (text.startsWith('INFO:') && loc.includes('/models/wasm/')) return;
        consoleErrors.push(`[${tag}] ${text}${loc ? ` (${loc})` : ''}`);
      }
    });
  };

  let uiSingle = null;
  let uiCacao = null;
  let uiCacheReturn = null;
  let uiCacheReturnMs = 0;
  let uiOutfit = null;
  let localhostCheckOk = false;

  const pngSingle = path.join(AUDIT_DIR, 'stage2-single-cashmere.png');
  const pngCache = path.join(AUDIT_DIR, 'stage2-cache-hit-instant.png');
  const pngOutfit = path.join(AUDIT_DIR, 'stage2-outfit-2step.png');

  try {
    // 6A. Quick localhost:3000 parity check (/thu-do-ai opens cleanly with 0 errors)
    const lhCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const lhPage = await lhCtx.newPage();
    attachListeners(lhPage, 'localhost-tryon');
    await lhPage.goto(`${ORIGIN_LOCALHOST}/thu-do-ai`, { waitUntil: 'load', timeout: 45_000 });
    await lhPage.locator('[data-testid="virtual-tryon-modal"]').first().waitFor({ state: 'visible', timeout: 15_000 });
    localhostCheckOk = await lhPage.locator('[data-testid="tryon-top-bar"]').isVisible();
    await lhCtx.close();

    // 6B. Main Live UI Proof on http://127.0.0.1:3000 via <SiteHeader /> THỬ ĐỒ AI
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    attachListeners(page, '127.0.0.1-stage2');

    await page.goto(`${ORIGIN_IP}/`, { waitUntil: 'load', timeout: 45_000 });
    await page.waitForTimeout(700);
    const headerCta = page.locator('header.nav a.nav__cta').first();
    await headerCta.waitFor({ state: 'visible', timeout: 10_000 });
    await headerCta.click();
    await page.waitForURL('**/thu-do-ai**', { timeout: 15_000 });
    await page.locator('[data-testid="virtual-tryon-modal"]').first().waitFor({ state: 'visible', timeout: 15_000 });

    // Select Dáng Mẫu Thử Nhanh -> Thảo Vy (vn-balanced-s)
    await page.locator('[data-testid="tryon-tab-presets"]').click();
    await page.locator('[data-testid="tryon-preset-models-strip"]').waitFor({ state: 'visible', timeout: 8_000 });
    await page.locator('[data-testid="tryon-preset-model-vn-balanced-s"]').click();

    // Select Áo Len Cashmere Cổ Lọ + Kem Cashmere
    await page.locator('[data-testid="tryon-mode-single"]').click();
    const cashmereCard = page.locator('[data-testid="wardrobe-card-ao-len-cashmere-co-lo"]');
    await cashmereCard.scrollIntoViewIfNeeded();
    await cashmereCard.click();

    const ivorySwatch = page.locator('[data-testid^="tryon-color-swatch-"][data-color-name*="Kem Cashmere"]').first();
    if ((await ivorySwatch.count()) > 0 && (await ivorySwatch.getAttribute('aria-pressed')) !== 'true') {
      await ivorySwatch.click();
    }

    uiSingle = await waitForStage2UiResult(page, { timeoutMs: 95_000 });
    await page.screenshot({ path: pngSingle, fullPage: false });

    // Toggle color -> Cacao Đậm
    const cacaoSwatch = page.locator('[data-testid^="tryon-color-swatch-"][data-color-name*="Cacao"]').first();
    await cacaoSwatch.waitFor({ state: 'visible', timeout: 8_000 });
    await cacaoSwatch.click();
    uiCacao = await waitForStage2UiResult(page, { prevSrc: uiSingle.afterSrc, timeoutMs: 95_000 });

    // Toggle BACK -> Kem Cashmere -> assert instant cache hit (⚡ Tức thì từ bộ nhớ đệm)
    const tCacheUi = performance.now();
    await ivorySwatch.click();
    await page.waitForFunction(
      (expectedSrc) => {
        const stage = document.querySelector('[data-testid="tryon-stage-viewport"]');
        const badge = document.querySelector('[data-testid="tryon-provider-badge"]');
        const img = document.querySelector('[data-testid="before-after-after-img"]');
        return (
          stage?.getAttribute('data-cache-hit') === 'true' &&
          Boolean(badge?.textContent?.includes('Tức thì từ bộ nhớ đệm')) &&
          img instanceof HTMLImageElement &&
          img.complete &&
          img.naturalWidth === 768 &&
          img.src === expectedSrc
        );
      },
      uiSingle.afterSrc,
      { timeout: 8_000 },
    );
    uiCacheReturnMs = Math.round(performance.now() - tCacheUi);
    await page.waitForTimeout(1050); // allow smooth curtain settle for crisp screenshot
    uiCacheReturn = await waitForStage2UiResult(page, { timeoutMs: 10_000 });
    await page.screenshot({ path: pngCache, fullPage: false });

    // Switch to Phối cả bộ (UPPER Cashmere + LOWER Quần Ống Suông Wool Blend)
    await page.locator('[data-testid="tryon-mode-outfit"]').click();
    await page.waitForTimeout(250);
    const woolCard = page.locator('[data-testid="wardrobe-card-quan-ong-suong-wool-blend"]');
    await woolCard.scrollIntoViewIfNeeded();
    if ((await woolCard.getAttribute('aria-pressed')) !== 'true') {
      await woolCard.click();
    }
    // Wait until stepTotal=2 synthesis finishes
    await page.waitForFunction(
      (prevSingleSrc) => {
        const scan = document.querySelector('[data-testid="optical-tryon-scan"]');
        if (scan) return false;
        const stage = document.querySelector('[data-testid="tryon-stage-viewport"]');
        const img = document.querySelector('[data-testid="before-after-after-img"]');
        if (!(img instanceof HTMLImageElement)) return false;
        return (
          stage?.getAttribute('data-step-total') === '2' &&
          img.complete &&
          img.naturalWidth === 768 &&
          img.naturalHeight === 1024 &&
          img.src !== prevSingleSrc
        );
      },
      uiSingle.afterSrc,
      { timeout: 110_000 },
    );
    await page.waitForTimeout(1050);
    uiOutfit = await waitForStage2UiResult(page, { timeoutMs: 10_000 });
    await page.screenshot({ path: pngOutfit, fullPage: false });

    await ctx.close();
  } finally {
    await browser.close();
  }

  const countdownRegex = /Tự xóa sau \d{2}:\d{2}/;
  const test6SingleOk =
    Boolean(uiSingle) &&
    uiSingle.provider &&
    uiSingle.provider !== 'local_preview' &&
    uiSingle.afterW === 768 &&
    uiSingle.afterH === 1024 &&
    uiSingle.providerBadgeText.length > 0 &&
    countdownRegex.test(uiSingle.countdownText) &&
    uiSingle.buyText.includes('THÊM VÀO GIỎ HÀNG') &&
    uiSingle.buyInViewport &&
    !uiSingle.synthesisErrorText;

  const test6CacheOk =
    Boolean(uiCacao) &&
    uiCacao.provider !== 'local_preview' &&
    uiCacao.afterSrc !== uiSingle?.afterSrc &&
    Boolean(uiCacheReturn) &&
    uiCacheReturn.cacheHit === 'true' &&
    uiCacheReturn.providerBadgeText.includes('⚡') &&
    uiCacheReturn.providerBadgeText.includes('Tức thì từ bộ nhớ đệm');

  const test6OutfitOk =
    Boolean(uiOutfit) &&
    uiOutfit.provider &&
    uiOutfit.provider !== 'local_preview' &&
    uiOutfit.stepTotal === '2' &&
    uiOutfit.afterW === 768 &&
    uiOutfit.afterH === 1024 &&
    uiOutfit.buyText.includes('THÊM CẢ BỘ VÀO GIỎ') &&
    uiOutfit.buyInViewport &&
    !uiOutfit.synthesisErrorText;

  const hygieneOk =
    pageErrors.length === 0 && consoleErrors.length === 0 && failedHttp.length === 0;

  const test6Ok = localhostCheckOk && test6SingleOk && test6CacheOk && test6OutfitOk && hygieneOk;

  recordCheck(
    'TEST 6',
    'Real Chrome (1440x900) Live UI Proof (Single Cashmere + Cache Hit + 2-Step Outfit + 0 Errors)',
    test6Ok,
    [
      `localhost:3000/thu-do-ai parity: ${localhostCheckOk}`,
      `Single Cashmere: provider=${uiSingle?.provider}, badge="${uiSingle?.providerBadgeText}", timer="${uiSingle?.countdownText}", img=${uiSingle?.afterW}x${uiSingle?.afterH}, slider=${uiSingle?.sliderValNow}%, CTA="${uiSingle?.buyText}" inViewport=${uiSingle?.buyInViewport}`,
      `Cacao Đậm switch: provider=${uiCacao?.provider}, img=${uiCacao?.afterW}x${uiCacao?.afterH}, distinctSrc=${uiCacao?.afterSrc !== uiSingle?.afterSrc}`,
      `Cache Return (Kem Cashmere): cacheHit=${uiCacheReturn?.cacheHit}, badge="${uiCacheReturn?.providerBadgeText}", uiLatency=${uiCacheReturnMs}ms`,
      `Outfit 2-Step: provider=${uiOutfit?.provider}, stepTotal=${uiOutfit?.stepTotal}, badge="${uiOutfit?.providerBadgeText}", img=${uiOutfit?.afterW}x${uiOutfit?.afterH}, CTA="${uiOutfit?.buyText}" inViewport=${uiOutfit?.buyInViewport}`,
      `Runtime Hygiene: pageErrors=${pageErrors.length}, consoleErrors=${consoleErrors.length}, failedHttp=${failedHttp.length}`,
      ...(pageErrors.length ? [`  pageErrors: ${JSON.stringify(pageErrors)}`] : []),
      ...(consoleErrors.length ? [`  consoleErrors: ${JSON.stringify(consoleErrors)}`] : []),
      ...(failedHttp.length ? [`  failedHttp: ${JSON.stringify(failedHttp)}`] : []),
      `Screenshots: ${pngSingle} | ${pngCache} | ${pngOutfit} | ${rawPngOut}`,
    ],
  );

  // Final C: temp check after Chrome as well
  const cTempFinal = listDirEntriesSafe(C_TEMP_DIR);
  const finalSuspiciousC = [...cTempFinal]
    .filter((n) => !cTempBefore.has(n))
    .filter((n) => /gradio|tryon|catvton|idm.?vton|kolors|u2net|rembg|fashn/i.test(n));

  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);

  console.log('\n========================================================================');
  console.log(
    ` Stage 2 Verification Summary: PASS=${passed}/${results.length} | FAIL=${failed} | Time=${elapsedSec}s`,
  );
  console.log(` Final C: Temp VTON Pollution Check: ${JSON.stringify(finalSuspiciousC)}`);
  console.log('========================================================================');

  if (failed > 0 || finalSuspiciousC.length > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('\n[FATAL]', err);
  process.exit(1);
});
