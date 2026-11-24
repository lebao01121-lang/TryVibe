#!/usr/bin/env node
/**
 * Stability Fixes End-to-End Verification Suite (Step 4)
 * Verifies:
 *   PREFLIGHT: Live endpoints (:3000/, :3000/thu-do-ai, :4000/health,
 *              :3000/bff/v1/storefront/bootstrap, Host Ollama :11434/api/tags) -> 200 OK
 *   TEST 1: Direct BFF CORS Preflight (OPTIONS :4000/bff/v1/storefront/inventory/batch-availability)
 *           with Origin: http://127.0.0.1:3000 -> 204/200 + ACAO + ACAC
 *   TEST 2: Live http://127.0.0.1:3000/ (#rack WebGL shaders + #build BFF calls)
 *           0 requests to localhost:4000, 0 CORS errors, 0 HTTP 400, 0 ChunkLoadError,
 *           0 f_soft / warning X4000 warnings, 0 pageErrors -> 01-home-127-console-clean.png
 *   TEST 3: Client-side nav `/` -> `/thu-do-ai` via header "THỬ ĐỒ AI" AND cold load `/thu-do-ai`
 *           No Error Boundary, [data-testid="virtual-tryon-modal"] + 3D Mirror mounted cleanly,
 *           0 HTTP 400 on /_next/static/*, 0 ChunkLoadError, 0 CORS, 0 f_soft/X4000, 0 pageErrors
 *           -> 02-tryon-127-loaded-clean.png
 */

import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const IS_WIN = process.platform === 'win32';

const sharp = createRequire(
  path.join(ROOT_DIR, 'services', 'media-pipeline', 'package.json'),
)('sharp');

const AUDIT_DIR =
  process.env.STABILITY_AUDIT_DIR ||
  'C:\\Users\\Admin\\.gemini\\antigravity\\brain\\d1783908-6521-4608-8b37-41aae3ee9a65\\scratch\\stability-audit';

const ORIGIN_IP = 'http://127.0.0.1:3000';
const BFF_DIRECT = 'http://127.0.0.1:4000';

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

function httpRequest(urlString, { method = 'GET', headers = {}, timeoutMs = 10_000 } = {}) {
  return new Promise((resolve) => {
    const parsed = new URL(urlString);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || 80,
        path: `${parsed.pathname}${parsed.search}`,
        method,
        headers,
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const body = Buffer.concat(chunks);
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            bytes: body.length,
            error: null,
          });
        });
      },
    );
    req.on('timeout', () => {
      req.destroy();
      resolve({ status: 0, headers: {}, bytes: 0, error: 'timeout' });
    });
    req.on('error', (err) => {
      resolve({ status: 0, headers: {}, bytes: 0, error: err.message });
    });
    req.end();
  });
}

async function analyzeCanvasBuffer(buf) {
  const { data, info } = await sharp(buf)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const pixels = info.width * info.height;
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  let nonBlack = 0;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    sumR += r;
    sumG += g;
    sumB += b;
    if (r > 18 || g > 18 || b > 18) nonBlack += 1;
  }
  const meanR = sumR / Math.max(1, pixels);
  const meanG = sumG / Math.max(1, pixels);
  const meanB = sumB / Math.max(1, pixels);
  let varSum = 0;
  for (let i = 0; i < data.length; i += 4) {
    const dr = data[i] - meanR;
    const dg = data[i + 1] - meanG;
    const db = data[i + 2] - meanB;
    varSum += (dr * dr + dg * dg + db * db) / 3;
  }
  return {
    width: info.width,
    height: info.height,
    nonBlackRatio: nonBlack / Math.max(1, pixels),
    stdDev: Math.sqrt(varSum / Math.max(1, pixels)),
  };
}

function createTelemetry() {
  return {
    requests: [],
    localhost4000Requests: [],
    direct4000Requests: [],
    sameOriginBffRequests: [],
    badRequests400: [],
    failedStaticRequests: [],
    failedBffRequests: [],
    corsErrors: [],
    chunkLoadErrors: [],
    shaderWarnings: [],
    consoleErrors: [],
    preexistingSeasons404s: [],
    consoleWarnings: [],
    pageErrors: [],
  };
}

function attachTelemetry(page, telemetry, tag) {
  page.on('request', (req) => {
    const url = req.url();
    telemetry.requests.push(`[${tag}] ${req.method()} ${url}`);
    if (/^https?:\/\/localhost:4000(\/|$)/i.test(url)) {
      telemetry.localhost4000Requests.push(`[${tag}] ${req.method()} ${url}`);
    }
    if (/^https?:\/\/(localhost|127\.0\.0\.1):4000(\/|$)/i.test(url)) {
      telemetry.direct4000Requests.push(`[${tag}] ${req.method()} ${url}`);
    }
    if (url.startsWith(`${ORIGIN_IP}/bff/`)) {
      telemetry.sameOriginBffRequests.push(`[${tag}] ${req.method()} ${url}`);
    }
  });

  page.on('response', (res) => {
    const status = res.status();
    const url = res.url();
    const entry = `[${tag}] ${status} ${res.request().method()} ${url}`;
    if (status === 400) {
      telemetry.badRequests400.push(entry);
    }
    if (url.includes('/_next/static/') && status >= 400) {
      telemetry.failedStaticRequests.push(entry);
    }
    if (url.includes('/bff/') && status >= 400) {
      telemetry.failedBffRequests.push(entry);
    }
  });

  page.on('console', (msg) => {
    const type = msg.type();
    const text = msg.text();
    const locUrl = msg.location()?.url || '';
    const line = `[${tag}] [${type}] ${text}${locUrl ? ` (${locUrl})` : ''}`;

    const isShaderWarning =
      /f_soft|f_softAlpha|warning\s+X4000|X4000:|use of potentially uninitialized variable/i.test(
        text,
      );
    if (isShaderWarning) {
      telemetry.shaderWarnings.push(line);
    }

    const isCorsError =
      /access-control-allow-origin|blocked by cors|cors policy|preflight request/i.test(text);
    if (isCorsError) {
      telemetry.corsErrors.push(line);
    }

    const isChunkError =
      /ChunkLoadError|Loading chunk [\w-]+ failed|Failed to fetch dynamically imported module|Importing a module script failed/i.test(
        text,
      );
    if (isChunkError) {
      telemetry.chunkLoadErrors.push(line);
    }

    // Ignore MediaPipe TFLite WASM info logs printed via console.error by Emscripten
    const isTfliteWasmInfo =
      type === 'error' &&
      text.startsWith('INFO:') &&
      locUrl.includes('/models/wasm/');

    // Separate pre-existing missing /seasons-lookbook/ static assets on `/` (matches verify-tryon-3d.mjs)
    const isPreexistingSeasons404 =
      type === 'error' &&
      text.includes('404') &&
      (locUrl.includes('/seasons-lookbook/') || text.includes('/seasons-lookbook/'));

    if (type === 'error' && !isTfliteWasmInfo) {
      if (isPreexistingSeasons404) {
        telemetry.preexistingSeasons404s.push(line);
      } else {
        telemetry.consoleErrors.push(line);
      }
    } else if (type === 'warning') {
      telemetry.consoleWarnings.push(line);
    }
  });

  page.on('pageerror', (err) => {
    const text = `${err?.name || 'Error'}: ${err?.message || String(err)}`;
    telemetry.pageErrors.push(`[${tag}] ${text}`);
    if (
      /ChunkLoadError|Loading chunk [\w-]+ failed|Failed to fetch dynamically imported module/i.test(
        text,
      )
    ) {
      telemetry.chunkLoadErrors.push(`[${tag}] [pageerror] ${text}`);
    }
  });
}

async function detectWebGlRenderer(page) {
  return page.evaluate(() => {
    const canvas = document.createElement('canvas');
    const gl =
      canvas.getContext('webgl2') ||
      canvas.getContext('webgl') ||
      canvas.getContext('experimental-webgl');
    if (!gl) return { available: false, renderer: 'none', vendor: 'none' };
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    return {
      available: true,
      vendor: dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
      renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
    };
  });
}

async function main() {
  const startedAt = Date.now();
  fs.mkdirSync(AUDIT_DIR, { recursive: true });

  console.log('========================================================================');
  console.log(' Stability Fixes Verification Suite — Real Chrome (1440x900, WebGL)');
  console.log(` Target:    ${ORIGIN_IP}`);
  console.log(` Audit Dir: ${AUDIT_DIR}`);
  console.log('========================================================================');

  // ---------------------------------------------------------------------------
  // PREFLIGHT: Live Endpoints 200 OK
  // ---------------------------------------------------------------------------
  const preflightTargets = [
    ['storefront-home', `${ORIGIN_IP}/`],
    ['storefront-tryon', `${ORIGIN_IP}/thu-do-ai`],
    ['bff-health', `${BFF_DIRECT}/health`],
    ['bff-bootstrap-rewrite', `${ORIGIN_IP}/bff/v1/storefront/bootstrap`],
    ['host-ollama', 'http://127.0.0.1:11434/api/tags'],
  ];

  const preflightResults = await Promise.all(
    preflightTargets.map(async ([label, url]) => ({
      label,
      url,
      ...(await httpRequest(url)),
    })),
  );
  const preflightOk = preflightResults.every((r) => r.status === 200);
  recordCheck(
    'PREFLIGHT',
    'All live endpoints (:3000/, /thu-do-ai, :4000/health, /bff/bootstrap, Ollama :11434) return 200 OK',
    preflightOk,
    preflightResults.map(
      (r) => `${r.label}: HTTP ${r.status} (${r.bytes} bytes)${r.error ? ` err=${r.error}` : ''}`,
    ),
  );
  if (!preflightOk) {
    process.exit(1);
  }

  // ---------------------------------------------------------------------------
  // TEST 1: Direct BFF CORS Preflight (OPTIONS)
  // ---------------------------------------------------------------------------
  const preflightUrl = `${BFF_DIRECT}/bff/v1/storefront/inventory/batch-availability`;
  const corsRes = await httpRequest(preflightUrl, {
    method: 'OPTIONS',
    headers: {
      Origin: ORIGIN_IP,
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type,x-guest-session-id',
    },
  });
  const acao = String(corsRes.headers['access-control-allow-origin'] || '');
  const acac = String(corsRes.headers['access-control-allow-credentials'] || '');
  const acam = String(corsRes.headers['access-control-allow-methods'] || '');
  const acah = String(corsRes.headers['access-control-allow-headers'] || '');
  const test1Ok =
    (corsRes.status === 204 || corsRes.status === 200) &&
    acao === ORIGIN_IP &&
    acac.toLowerCase() === 'true';

  recordCheck(
    'TEST 1',
    'Direct BFF CORS Preflight (OPTIONS /inventory/batch-availability) returns 204/200 + ACAO + ACAC',
    test1Ok,
    [
      `URL: OPTIONS ${preflightUrl}`,
      `Status: ${corsRes.status}`,
      `Access-Control-Allow-Origin: ${acao || '(missing)'}`,
      `Access-Control-Allow-Credentials: ${acac || '(missing)'}`,
      `Access-Control-Allow-Methods: ${acam || '(missing)'}`,
      `Access-Control-Allow-Headers: ${acah || '(missing)'}`,
    ],
  );

  // Launch Real Chrome with ANGLE WebGL
  const chromePath = findChromeExecutable();
  if (!chromePath) {
    throw new Error('Could not find Chrome/Edge executable.');
  }
  const browser = await chromium.launch({
    executablePath: chromePath,
    headless: true,
    args: [
      '--enable-webgl',
      '--ignore-gpu-blocklist',
      '--use-gl=angle',
      '--enable-unsafe-swiftshader',
      '--disable-dev-shm-usage',
      '--no-sandbox',
    ],
  });

  try {
    // -------------------------------------------------------------------------
    // TEST 2: Live http://127.0.0.1:3000/ (#rack WebGL Shaders + #build BFF Calls)
    // -------------------------------------------------------------------------
    const homeCtx = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 1,
    });
    const page = await homeCtx.newPage();
    const homeTel = createTelemetry();
    attachTelemetry(page, homeTel, 'home');

    const bffResponses = [];
    page.on('response', (res) => {
      const url = res.url();
      if (url.includes('/bff/v1/storefront/')) {
        bffResponses.push(`${res.status()} ${res.request().method()} ${url}`);
      }
    });

    await page.goto(`${ORIGIN_IP}/`, { waitUntil: 'load', timeout: 45_000 });
    await page.waitForTimeout(1800);

    const glInfo = await detectWebGlRenderer(page);

    // Scroll to #rack so WebGL 3D garment rack compiles all GLSL shaders and renders
    await page.locator('#rack').scrollIntoViewIfNeeded();
    await page.waitForTimeout(2500);

    const rackCanvas = page.locator('#rack canvas').first();
    const rackCanvasVisible = await rackCanvas.isVisible().catch(() => false);
    let rackCanvasStats = null;
    if (rackCanvasVisible) {
      const rackBuf = await rackCanvas.screenshot();
      rackCanvasStats = await analyzeCanvasBuffer(rackBuf);
    }

    // Scroll to #build so Outfit Studio executes batch-availability & outfit-studio/preview
    await page.locator('#build').scrollIntoViewIfNeeded();
    await page.waitForTimeout(2800);

    // Ensure outfit-studio/preview and batch-availability were called
    const hasBatchAvailability = bffResponses.some(
      (line) =>
        line.includes('/bff/v1/storefront/inventory/batch-availability') &&
        line.startsWith('2'),
    );
    const hasOutfitPreview = bffResponses.some(
      (line) =>
        line.includes('/bff/v1/storefront/outfit-studio/preview') &&
        line.startsWith('2'),
    );

    // Capture 01-home-127-console-clean.png showing live #build (or #rack) cleanly loaded
    const homeShotPath = path.join(AUDIT_DIR, '01-home-127-console-clean.png');
    await page.screenshot({ path: homeShotPath, fullPage: false });

    const test2Ok =
      homeTel.localhost4000Requests.length === 0 &&
      homeTel.direct4000Requests.length === 0 &&
      homeTel.corsErrors.length === 0 &&
      homeTel.badRequests400.length === 0 &&
      homeTel.chunkLoadErrors.length === 0 &&
      homeTel.shaderWarnings.length === 0 &&
      homeTel.pageErrors.length === 0 &&
      homeTel.consoleErrors.length === 0 &&
      homeTel.failedStaticRequests.length === 0 &&
      homeTel.failedBffRequests.length === 0 &&
      rackCanvasVisible &&
      (rackCanvasStats?.stdDev ?? 0) > 5 &&
      hasBatchAvailability &&
      hasOutfitPreview;

    recordCheck(
      'TEST 2',
      'Live http://127.0.0.1:3000/ (#rack WebGL shaders + #build BFF calls) zero errors & zero localhost:4000',
      test2Ok,
      [
        `WebGL Renderer: ${glInfo.renderer} (vendor=${glInfo.vendor})`,
        `#rack canvas visible=${rackCanvasVisible} size=${rackCanvasStats?.width || 0}x${rackCanvasStats?.height || 0} nonBlack=${((rackCanvasStats?.nonBlackRatio || 0) * 100).toFixed(1)}% stdDev=${(rackCanvasStats?.stdDev || 0).toFixed(2)}`,
        `Same-origin /bff/ requests: ${homeTel.sameOriginBffRequests.length} (batch-availability 2xx=${hasBatchAvailability}, outfit-studio/preview 2xx=${hasOutfitPreview})`,
        `BFF responses: ${bffResponses.join(' | ') || 'none'}`,
        `localhost:4000 requests: ${homeTel.localhost4000Requests.length}, direct :4000 requests: ${homeTel.direct4000Requests.length}`,
        `CORS errors: ${homeTel.corsErrors.length}, HTTP 400: ${homeTel.badRequests400.length}, ChunkLoadError: ${homeTel.chunkLoadErrors.length}`,
        `Shader f_soft/X4000 warnings: ${homeTel.shaderWarnings.length}, pageErrors: ${homeTel.pageErrors.length}`,
        `Console errors (excluding pre-existing /seasons-lookbook/ 404s): ${homeTel.consoleErrors.length} (pre-existing /seasons-lookbook/ 404s=${homeTel.preexistingSeasons404s.length})`,
        `All console warnings (${homeTel.consoleWarnings.length}): ${homeTel.consoleWarnings.join(' ; ') || 'none'}`,
        `Screenshot: ${homeShotPath}`,
      ],
    );

    // -------------------------------------------------------------------------
    // TEST 3A: Client-side navigation `/` -> `/thu-do-ai` via header "THỬ ĐỒ AI"
    // -------------------------------------------------------------------------
    const navTel = createTelemetry();
    attachTelemetry(page, navTel, 'nav-tryon');

    const tryOnCta = page.locator('header a.nav__cta[href="/thu-do-ai"]').first();
    await tryOnCta.waitFor({ state: 'visible', timeout: 10_000 });
    await tryOnCta.click();
    await page.waitForURL((url) => url.pathname === '/thu-do-ai', { timeout: 25_000 });

    const modalNav = page.locator('[data-testid="virtual-tryon-modal"]').first();
    await modalNav.waitFor({ state: 'visible', timeout: 25_000 });
    await page.waitForTimeout(1600);

    // Switch to interactive 3D Mannequin mode to verify live WebGL 3D Mirror stage
    const mannequinTab = page.locator('[data-testid="tryon-tab-mannequin"]').first();
    if (await mannequinTab.isVisible().catch(() => false)) {
      await mannequinTab.click();
      await page.waitForTimeout(1800);
    }
    await modalNav.scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);

    const navState = await page.evaluate(() => {
      const bodyText = document.body.innerText || '';
      const modal = document.querySelector('[data-testid="virtual-tryon-modal"]');
      const canvas = modal?.querySelector('canvas') || document.querySelector('canvas');
      const rect = canvas ? canvas.getBoundingClientRect() : null;
      return {
        url: window.location.href,
        hasErrorBoundary: bodyText.includes('Không gian đang tạm gián đoạn'),
        hasModal: Boolean(modal),
        canvasWidth: rect ? Math.round(rect.width) : 0,
        canvasHeight: rect ? Math.round(rect.height) : 0,
      };
    });

    let navCanvasStats = null;
    const navCanvas = modalNav.locator('canvas').first();
    if (await navCanvas.isVisible().catch(() => false)) {
      navCanvasStats = await analyzeCanvasBuffer(await navCanvas.screenshot());
    }

    const tryOnShotPath = path.join(AUDIT_DIR, '02-tryon-127-loaded-clean.png');
    await page.screenshot({ path: tryOnShotPath, fullPage: false });
    await homeCtx.close();

    // -------------------------------------------------------------------------
    // TEST 3B: Direct Cold Load `http://127.0.0.1:3000/thu-do-ai`
    // -------------------------------------------------------------------------
    const coldCtx = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 1,
    });
    const coldPage = await coldCtx.newPage();
    const coldTel = createTelemetry();
    attachTelemetry(coldPage, coldTel, 'cold-tryon');

    await coldPage.goto(`${ORIGIN_IP}/thu-do-ai`, { waitUntil: 'load', timeout: 45_000 });
    const modalCold = coldPage.locator('[data-testid="virtual-tryon-modal"]').first();
    await modalCold.waitFor({ state: 'visible', timeout: 25_000 });
    await coldPage.waitForTimeout(2600);

    const coldState = await coldPage.evaluate(() => {
      const bodyText = document.body.innerText || '';
      const modal = document.querySelector('[data-testid="virtual-tryon-modal"]');
      const canvas = modal?.querySelector('canvas') || document.querySelector('canvas');
      const rect = canvas ? canvas.getBoundingClientRect() : null;
      return {
        url: window.location.href,
        hasErrorBoundary: bodyText.includes('Không gian đang tạm gián đoạn'),
        hasModal: Boolean(modal),
        canvasWidth: rect ? Math.round(rect.width) : 0,
        canvasHeight: rect ? Math.round(rect.height) : 0,
      };
    });

    let coldCanvasStats = null;
    const coldCanvas = modalCold.locator('canvas').first();
    if (await coldCanvas.isVisible().catch(() => false)) {
      coldCanvasStats = await analyzeCanvasBuffer(await coldCanvas.screenshot());
    }
    await coldCtx.close();

    const test3Ok =
      !navState.hasErrorBoundary &&
      navState.hasModal &&
      navState.canvasWidth > 200 &&
      navState.canvasHeight > 200 &&
      (navCanvasStats?.stdDev ?? 0) > 5 &&
      navTel.localhost4000Requests.length === 0 &&
      navTel.direct4000Requests.length === 0 &&
      navTel.failedStaticRequests.length === 0 &&
      navTel.badRequests400.length === 0 &&
      navTel.chunkLoadErrors.length === 0 &&
      navTel.corsErrors.length === 0 &&
      navTel.shaderWarnings.length === 0 &&
      navTel.pageErrors.length === 0 &&
      navTel.consoleErrors.length === 0 &&
      !coldState.hasErrorBoundary &&
      coldState.hasModal &&
      coldState.canvasWidth > 200 &&
      coldState.canvasHeight > 200 &&
      (coldCanvasStats?.stdDev ?? 0) > 5 &&
      coldTel.localhost4000Requests.length === 0 &&
      coldTel.direct4000Requests.length === 0 &&
      coldTel.failedStaticRequests.length === 0 &&
      coldTel.badRequests400.length === 0 &&
      coldTel.chunkLoadErrors.length === 0 &&
      coldTel.corsErrors.length === 0 &&
      coldTel.shaderWarnings.length === 0 &&
      coldTel.pageErrors.length === 0 &&
      coldTel.consoleErrors.length === 0;

    recordCheck(
      'TEST 3',
      'Client-side nav `/` -> `/thu-do-ai` AND cold load `/thu-do-ai` mount 3D Mirror with zero errors',
      test3Ok,
      [
        `Client Nav: url=${navState.url} modal=${navState.hasModal} errorBoundary=${navState.hasErrorBoundary} canvas=${navState.canvasWidth}x${navState.canvasHeight} stdDev=${(navCanvasStats?.stdDev || 0).toFixed(2)}`,
        `Client Nav Errors: 400=${navTel.badRequests400.length} staticFail=${navTel.failedStaticRequests.length} chunk=${navTel.chunkLoadErrors.length} cors=${navTel.corsErrors.length} shader=${navTel.shaderWarnings.length} pageErr=${navTel.pageErrors.length} consoleErr=${navTel.consoleErrors.length} direct4000=${navTel.direct4000Requests.length}`,
        `Cold Load:  url=${coldState.url} modal=${coldState.hasModal} errorBoundary=${coldState.hasErrorBoundary} canvas=${coldState.canvasWidth}x${coldState.canvasHeight} stdDev=${(coldCanvasStats?.stdDev || 0).toFixed(2)}`,
        `Cold Load Errors:  400=${coldTel.badRequests400.length} staticFail=${coldTel.failedStaticRequests.length} chunk=${coldTel.chunkLoadErrors.length} cors=${coldTel.corsErrors.length} shader=${coldTel.shaderWarnings.length} pageErr=${coldTel.pageErrors.length} consoleErr=${coldTel.consoleErrors.length} direct4000=${coldTel.direct4000Requests.length}`,
        ...(navTel.consoleErrors.length > 0 ? [`Nav ConsoleErrors: ${navTel.consoleErrors.join(' ; ')}`] : []),
        ...(coldTel.consoleErrors.length > 0 ? [`Cold ConsoleErrors: ${coldTel.consoleErrors.join(' ; ')}`] : []),
        `Screenshot: ${tryOnShotPath}`,
      ],
    );
  } finally {
    await browser.close();
  }

  const passed = results.filter((r) => r.ok).length;
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log('\n========================================================================');
  console.log(` SUMMARY: ${passed}/${results.length} CHECKS PASSED in ${elapsed}s`);
  console.log('========================================================================');

  if (passed !== results.length) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('[FATAL] verify-stability-fixes failed:', err);
  process.exit(1);
});
