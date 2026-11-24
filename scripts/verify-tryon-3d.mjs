#!/usr/bin/env node
/**
 * Real-Time 3D AR Virtual Try-On Mirror — Full Automated & Visual Verification Suite
 * fashion-atelier-ai-platform (v3.1)
 *
 * Verifies against live `http://127.0.0.1:3000` & `http://localhost:3000` + BFF `:4000`:
 *   PREFLIGHT: 200 OK on :3000/, localhost:3000/thu-do-ai, :4000/health, :4002/health,
 *              :3000/bff/v1/storefront/bootstrap (Next.js rewrite), Host Ollama :11434/api/tags
 *   TEST 1: ZERO "Failed to fetch" on 127.0.0.1:3000 & localhost:3000 + Offline Resilience
 *           (blocking /bff/v1/storefront/tryon/** & /v1/tryon/**) + ZERO legacy jargon / <select>
 *   TEST 2: Viewport Clipping Check (1440x900 & 1366x768) & GPU Guard (`data-camera-active`)
 *   TEST 3: All 3 Modes (`Ma-nơ-canh 3D 360°`, `Ướm 3D Trên Ảnh`, `Gương 3D Camera`),
 *           WebGL non-empty pixels + 360° drag delta, Multi-Layer Outfit, Color Swatches,
 *           Lighting (`Đèn Tiệc Tối`), BeforeAfterSlider, Camera fallback + Tailor's Pins
 *   TEST 4: Max-3 Saved Looks (`3/3` + 4th-Look Limit Alert) at 1366x768 + 3 Wardrobe Tabs +
 *           Size Recommendation + Size M + Add-to-Cart POST 200/201 -> <QuickBagDrawer /> open
 *   TEST 5: Mobile 390x844 layout (`horizontalOverflow === 0`, cleanly stacked)
 *   HYGIENE: consoleErrors(tryon) === 0, pageErrors === 0
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
  process.env.TRYON3D_AUDIT_DIR ||
  'C:\\Users\\Admin\\.gemini\\antigravity\\brain\\d1783908-6521-4608-8b37-41aae3ee9a65\\scratch\\tryon3d-audit';

const ORIGIN_IP = 'http://127.0.0.1:3000';
const ORIGIN_LOCALHOST = 'http://localhost:3000';

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

function httpGetStatus(urlString, timeoutMs = 10_000) {
  return new Promise((resolve) => {
    const parsed = new URL(urlString);
    const req = http.get(
      {
        hostname: parsed.hostname,
        port: parsed.port || 80,
        path: `${parsed.pathname}${parsed.search}`,
        timeout: timeoutMs,
      },
      (res) => {
        let bytes = 0;
        res.on('data', (chunk) => {
          bytes += chunk.length;
        });
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, bytes, error: null });
        });
      },
    );
    req.on('timeout', () => {
      req.destroy();
      resolve({ status: 0, bytes: 0, error: 'timeout' });
    });
    req.on('error', (err) => {
      resolve({ status: 0, bytes: 0, error: err.message });
    });
  });
}

async function analyzePngBuffer(buf) {
  const { data, info } = await sharp(buf)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const pixels = info.width * info.height;
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  let nonDarkPixels = 0;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    sumR += r;
    sumG += g;
    sumB += b;
    if (r > 38 || g > 30 || b > 26) nonDarkPixels += 1;
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
  const stdDev = Math.sqrt(varSum / Math.max(1, pixels));

  return {
    width: info.width,
    height: info.height,
    nonDarkRatio: nonDarkPixels / Math.max(1, pixels),
    stdDev,
    raw: data,
  };
}

function computeRawMae(bufA, bufB) {
  const len = Math.min(bufA.length, bufB.length);
  if (len === 0) return 0;
  let diffSum = 0;
  let count = 0;
  for (let i = 0; i < len; i += 4) {
    diffSum +=
      Math.abs(bufA[i] - bufB[i]) +
      Math.abs(bufA[i + 1] - bufB[i + 1]) +
      Math.abs(bufA[i + 2] - bufB[i + 2]);
    count += 3;
  }
  return diffSum / Math.max(1, count);
}

async function auditForbiddenDom(page) {
  return page.evaluate(() => {
    const fullText = (document.body.innerText || '').toLowerCase();
    const modals = document.querySelectorAll('[data-testid="virtual-tryon-modal"]');
    const modal = modals[0] ?? null;
    const modalText = (modal?.textContent || '').toLowerCase();
    const selectCount = modal ? modal.querySelectorAll('select').length : -1;
    return {
      hasModal: Boolean(modal),
      modalCount: modals.length,
      hasFailedToFetch:
        fullText.includes('failed to fetch') || modalText.includes('failed to fetch'),
      hasPrivateTryonJargon:
        fullText.includes('atelier-private-tryon') ||
        modalText.includes('atelier-private-tryon'),
      hasTtl15: fullText.includes('ttl 15:00') || modalText.includes('ttl 15:00'),
      selectCount,
    };
  });
}

async function inspectViewportBounds(page) {
  return page.evaluate(() => {
    const vh = window.innerHeight;
    const vw = window.innerWidth;
    const measure = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {
        top: Math.round(r.top * 10) / 10,
        bottom: Math.round(r.bottom * 10) / 10,
        left: Math.round(r.left * 10) / 10,
        right: Math.round(r.right * 10) / 10,
        height: Math.round(r.height * 10) / 10,
        text: (el.textContent || '').trim().slice(0, 80),
        insideY: r.top >= -0.5 && r.bottom <= vh + 0.5 && r.height > 0,
      };
    };
    return {
      vw,
      vh,
      cameraActive: document.body.dataset.cameraActive ?? null,
      eyebrow: measure('[data-testid="tryon-header-eyebrow"]'),
      title: measure('[data-testid="tryon-header-title"]'),
      footer: measure('[data-testid="tryon-privacy-footer"]'),
    };
  });
}

async function openOverlayModalFromHome(page) {
  await page.goto(`${ORIGIN_IP}/`, { waitUntil: 'load', timeout: 45_000 });
  const pill = page.locator('[data-testid="occasion-tryon-pill"]').first();
  await pill.scrollIntoViewIfNeeded();
  await page.waitForTimeout(350);
  await pill.click();
  await page.locator('[data-testid="virtual-tryon-modal"]').first().waitFor({
    state: 'visible',
    timeout: 15_000,
  });
  await page.waitForTimeout(450);
}

async function main() {
  const startedAt = Date.now();
  fs.mkdirSync(AUDIT_DIR, { recursive: true });

  console.log('========================================================================');
  console.log(' Real-Time 3D AR Virtual Try-On Mirror — Automated & Visual Audit');
  console.log(` Audit Dir: ${AUDIT_DIR}`);
  console.log('========================================================================');

  // ---------------------------------------------------------------------------
  // PREFLIGHT: Live Stack Endpoint Health Checks
  // ---------------------------------------------------------------------------
  const healthTargets = [
    ['storefront-127', `${ORIGIN_IP}/`],
    ['storefront-localhost-tryon', `${ORIGIN_LOCALHOST}/thu-do-ai`],
    ['bff-health', 'http://127.0.0.1:4000/health'],
    ['catalog-health', 'http://127.0.0.1:4002/health'],
    ['next-bff-rewrite', `${ORIGIN_IP}/bff/v1/storefront/bootstrap`],
    ['host-ollama', 'http://127.0.0.1:11434/api/tags'],
  ];

  const healthResults = await Promise.all(
    healthTargets.map(async ([label, url]) => ({
      label,
      url,
      ...(await httpGetStatus(url)),
    })),
  );
  const healthAllOk = healthResults.every((r) => r.status === 200);
  recordCheck(
    'PREFLIGHT',
    'Live stack endpoints & Next.js /bff rewrite all return 200 OK',
    healthAllOk,
    healthResults.map((r) => `${r.label}: HTTP ${r.status} (${r.bytes} bytes) — ${r.url}`),
  );
  if (!healthAllOk) {
    process.exit(1);
  }

  // Launch Real Chrome with WebGL
  const chromePath = findChromeExecutable();
  if (!chromePath) {
    throw new Error('Could not find local Chrome/Edge executable.');
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

  const consoleErrors = [];
  const pageErrors = [];

  const attachErrorListeners = (page, tag) => {
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        consoleErrors.push(`[${tag}] ${msg.text()}`);
      }
    });
    page.on('pageerror', (err) => {
      pageErrors.push(`[${tag}] ${err.message}`);
    });
  };

  try {
    // =========================================================================
    // TEST 1: ZERO "Failed to fetch" on 127.0.0.1 & localhost + Offline Resilience
    // =========================================================================
    const ctx1 = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page1 = await ctx1.newPage();
    attachErrorListeners(page1, 'test1');

    // 1A. http://127.0.0.1:3000/thu-do-ai
    await page1.goto(`${ORIGIN_IP}/thu-do-ai`, { waitUntil: 'load', timeout: 45_000 });
    await page1.locator('[data-testid="virtual-tryon-modal"]').first().waitFor({ state: 'visible', timeout: 15_000 });
    await page1.waitForTimeout(600);
    const domIp = await auditForbiddenDom(page1);

    // 1B. http://localhost:3000/thu-do-ai
    await page1.goto(`${ORIGIN_LOCALHOST}/thu-do-ai`, { waitUntil: 'load', timeout: 45_000 });
    await page1.locator('[data-testid="virtual-tryon-modal"]').first().waitFor({ state: 'visible', timeout: 15_000 });
    await page1.waitForTimeout(600);
    const domLocalhost = await auditForbiddenDom(page1);

    // 1C. Open Try-On from http://127.0.0.1:3000 header button "THỬ ĐỒ AI"
    await page1.goto(`${ORIGIN_IP}/`, { waitUntil: 'load', timeout: 45_000 });
    const headerTryOnBtn = page1.locator('header.nav a.nav__cta').first();
    await headerTryOnBtn.waitFor({ state: 'visible', timeout: 10_000 });
    const headerBtnText = (await headerTryOnBtn.innerText()).trim();
    await headerTryOnBtn.click();
    await page1.waitForURL('**/thu-do-ai**', { timeout: 15_000 });
    await page1.locator('[data-testid="virtual-tryon-modal"]').first().waitFor({ state: 'visible', timeout: 15_000 });
    await page1.waitForTimeout(500);
    const domHeaderNav = await auditForbiddenDom(page1);

    // 1D. Explicit Offline Resilience: block /bff/v1/storefront/tryon/** & /v1/tryon/**
    const ctxOffline = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const pageOffline = await ctxOffline.newPage();
    attachErrorListeners(pageOffline, 'test1-offline');
    let blockedTryonHits = 0;
    await pageOffline.route('**/bff/v1/storefront/tryon/**', (route) => {
      blockedTryonHits += 1;
      return route.abort('failed');
    });
    await pageOffline.route('**/v1/tryon/**', (route) => {
      blockedTryonHits += 1;
      return route.abort('failed');
    });
    await pageOffline.goto(`${ORIGIN_IP}/thu-do-ai`, { waitUntil: 'load', timeout: 45_000 });
    await pageOffline.locator('[data-testid="virtual-tryon-modal"]').first().waitFor({ state: 'visible', timeout: 15_000 });
    await pageOffline.locator('[data-testid="tryon-tab-mannequin"]').click();
    await pageOffline.waitForTimeout(900);
    const offlineCanvasBox = await pageOffline.locator('[data-testid="tryon-3d-webgl-canvas"]').boundingBox();
    await pageOffline.locator('[data-testid="tryon-tab-photo"]').click();
    await pageOffline.locator('[data-testid="tryon-sample-female-1"]').click();
    await pageOffline.waitForTimeout(800);
    const domOffline = await auditForbiddenDom(pageOffline);
    await ctxOffline.close();
    await ctx1.close();

    const test1Ok =
      domIp.hasModal &&
      !domIp.hasFailedToFetch &&
      !domIp.hasPrivateTryonJargon &&
      !domIp.hasTtl15 &&
      domIp.selectCount === 0 &&
      domLocalhost.hasModal &&
      !domLocalhost.hasFailedToFetch &&
      !domLocalhost.hasPrivateTryonJargon &&
      !domLocalhost.hasTtl15 &&
      domLocalhost.selectCount === 0 &&
      domHeaderNav.hasModal &&
      !domHeaderNav.hasFailedToFetch &&
      domHeaderNav.selectCount === 0 &&
      domOffline.hasModal &&
      !domOffline.hasFailedToFetch &&
      !domOffline.hasPrivateTryonJargon &&
      !domOffline.hasTtl15 &&
      domOffline.selectCount === 0 &&
      Boolean(offlineCanvasBox && offlineCanvasBox.width > 120 && offlineCanvasBox.height > 120);

    recordCheck(
      'TEST 1',
      'ZERO "Failed to fetch" on 127.0.0.1 & localhost + Offline Resilience + ZERO <select> / legacy jargon',
      test1Ok,
      [
        `127.0.0.1/thu-do-ai: ${JSON.stringify(domIp)}`,
        `localhost/thu-do-ai: ${JSON.stringify(domLocalhost)}`,
        `Header CTA "${headerBtnText}" -> /thu-do-ai: ${JSON.stringify(domHeaderNav)}`,
        `Offline block (/tryon/** hits=${blockedTryonHits}): ${JSON.stringify(domOffline)}, canvas=${JSON.stringify(offlineCanvasBox)}`,
      ],
    );

    // =========================================================================
    // TEST 2: Viewport Clipping Check (1440x900 & 1366x768) & GPU Guard
    // =========================================================================
    const ctxMain = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctxMain.newPage();
    attachErrorListeners(page, 'main');

    await openOverlayModalFromHome(page);
    const domOverlay = await auditForbiddenDom(page);
    const bounds1440 = await inspectViewportBounds(page);

    await page.setViewportSize({ width: 1366, height: 768 });
    await page.waitForTimeout(350);
    const bounds1366 = await inspectViewportBounds(page);

    // Close modal -> verify GPU guard resets cameraActive to 'false'
    await page.locator('[data-testid="tryon-close-btn"]').click();
    await page.locator('[data-testid="virtual-tryon-modal"]').first().waitFor({
      state: 'detached',
      timeout: 8000,
    });
    await page.waitForTimeout(250);
    const cameraActiveAfterClose = await page.evaluate(
      () => document.body.dataset.cameraActive ?? null,
    );

    const test2Ok =
      domOverlay.hasModal &&
      !domOverlay.hasFailedToFetch &&
      domOverlay.selectCount === 0 &&
      bounds1440.cameraActive === 'true' &&
      Boolean(bounds1440.eyebrow?.insideY) &&
      Boolean(bounds1440.eyebrow?.text.includes('PHÒNG THỬ ĐỒ 3D AR')) &&
      Boolean(bounds1440.title?.insideY) &&
      Boolean(bounds1440.footer?.insideY) &&
      bounds1366.cameraActive === 'true' &&
      Boolean(bounds1366.eyebrow?.insideY) &&
      Boolean(bounds1366.title?.insideY) &&
      Boolean(bounds1366.footer?.insideY) &&
      cameraActiveAfterClose === 'false';

    recordCheck(
      'TEST 2',
      'Viewport Clipping Check (1440x900 & 1366x768) & GPU Guard (data-camera-active)',
      test2Ok,
      [
        `1440x900: cameraActive=${bounds1440.cameraActive}, eyebrow=[${bounds1440.eyebrow?.top}..${bounds1440.eyebrow?.bottom}] inside=${bounds1440.eyebrow?.insideY}, title=[${bounds1440.title?.top}..${bounds1440.title?.bottom}] inside=${bounds1440.title?.insideY}, footer=[${bounds1440.footer?.top}..${bounds1440.footer?.bottom}] inside=${bounds1440.footer?.insideY}`,
        `1366x768: cameraActive=${bounds1366.cameraActive}, eyebrow=[${bounds1366.eyebrow?.top}..${bounds1366.eyebrow?.bottom}] inside=${bounds1366.eyebrow?.insideY}, title=[${bounds1366.title?.top}..${bounds1366.title?.bottom}] inside=${bounds1366.title?.insideY}, footer=[${bounds1366.footer?.top}..${bounds1366.footer?.bottom}] inside=${bounds1366.footer?.insideY}`,
        `After close: cameraActive=${cameraActiveAfterClose}`,
      ],
    );

    // =========================================================================
    // TEST 3: All 3 Modes, Multi-Layer Outfit, Color Swatches & Lighting (1440x900)
    // =========================================================================
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForTimeout(250);
    await page.locator('[data-testid="occasion-tryon-pill"]').first().click();
    await page.locator('[data-testid="virtual-tryon-modal"]').first().waitFor({
      state: 'visible',
      timeout: 10_000,
    });
    await page.waitForTimeout(450);

    // 3A. Ma-nơ-canh 3D 360°
    await page.locator('[data-testid="tryon-tab-mannequin"]').click();
    await page.waitForTimeout(1400);

    const canvasLoc = page.locator('[data-testid="tryon-3d-webgl-canvas"]');
    await canvasLoc.waitFor({ state: 'visible', timeout: 10_000 });
    const canvasBox = await canvasLoc.boundingBox();
    if (!canvasBox || canvasBox.width < 120 || canvasBox.height < 120) {
      throw new Error(`Invalid WebGL canvas bounding box: ${JSON.stringify(canvasBox)}`);
    }

    const beforeDragPng = await canvasLoc.screenshot();
    const beforeDragStats = await analyzePngBuffer(beforeDragPng);

    // Perform smooth 360° mouse drag horizontally across the WebGL canvas
    const dragY = canvasBox.y + canvasBox.height * 0.5;
    const dragStartX = canvasBox.x + canvasBox.width * 0.35;
    const dragEndX = canvasBox.x + canvasBox.width * 0.72;
    await page.mouse.move(dragStartX, dragY);
    await page.mouse.down();
    await page.mouse.move(dragEndX, dragY, { steps: 14 });
    await page.mouse.up();
    await page.waitForTimeout(600);

    const afterDragPng = await canvasLoc.screenshot();
    const afterDragStats = await analyzePngBuffer(afterDragPng);
    const dragMae = computeRawMae(beforeDragStats.raw, afterDragStats.raw);

    // Reset slightly to a clean front/3-4 editorial angle, then switch to MIX_MATCH_OUTFIT
    await page.locator('[data-testid="tryon-reset-orbit-btn"]').click();
    await page.waitForTimeout(500);
    await page.locator('[data-testid="tryon-mode-outfit"]').click();
    await page.waitForTimeout(700);

    // Make sure focused garment has >=2 swatches (select Blazer Linen or first multi-swatch item if needed)
    let swatchCount = await page.locator('[data-testid^="tryon-color-swatch-"]').count();
    if (swatchCount < 2) {
      const multiCandidate = page.locator('[data-testid="wardrobe-card-ao-blazer-linen-cat-tay"]');
      if ((await multiCandidate.count()) > 0) {
        await multiCandidate.click();
        await page.waitForTimeout(500);
      } else {
        const cards = page.locator('[data-testid^="wardrobe-card-"]');
        const totalCards = await cards.count();
        for (let i = 0; i < Math.min(totalCards, 8); i += 1) {
          await cards.nth(i).click();
          await page.waitForTimeout(250);
          if ((await page.locator('[data-testid^="tryon-color-swatch-"]').count()) >= 2) {
            break;
          }
        }
      }
      swatchCount = await page.locator('[data-testid^="tryon-color-swatch-"]').count();
    }

    let swatchSwitched = false;
    if (swatchCount >= 2) {
      await page.locator('[data-testid="tryon-color-swatch-1"]').click();
      await page.waitForTimeout(650);
      swatchSwitched =
        (await page.locator('[data-testid="tryon-color-swatch-1"]').getAttribute('aria-pressed')) ===
        'true';
    } else if (swatchCount === 1) {
      await page.locator('[data-testid="tryon-color-swatch-0"]').click();
      swatchSwitched = true;
    }

    // Switch lighting to "Đèn Tiệc Tối"
    await page.locator('[data-testid="tryon-light-evening"]').click();
    await page.waitForTimeout(900);
    const eveningPressed =
      (await page.locator('[data-testid="tryon-light-evening"]').getAttribute('aria-pressed')) ===
      'true';

    const wornCountText = await page
      .locator('[data-testid="virtual-tryon-modal"]')
      .evaluate((el) => {
        const match = (el.textContent || '').match(/Đang mặc\s+(\d+)\s+món/);
        return match ? Number(match[1]) : 0;
      });

    // Subtle drag for 3D depth showcase (~22 deg angle)
    await page.mouse.move(canvasBox.x + canvasBox.width * 0.48, dragY);
    await page.mouse.down();
    await page.mouse.move(canvasBox.x + canvasBox.width * 0.57, dragY, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(550);

    const png01 = path.join(AUDIT_DIR, '01-tryon3d-mannequin-1440.png');
    await page.screenshot({ path: png01, fullPage: false });

    // 3B. Ướm 3D Trên Ảnh + Sample Model 1 (Minh Thư) + BeforeAfterSlider
    await page.locator('[data-testid="tryon-light-showroom"]').click();
    await page.locator('[data-testid="tryon-tab-photo"]').click();
    await page.waitForTimeout(450);
    await page.locator('[data-testid="tryon-sample-female-1"]').click();
    await page.waitForTimeout(1600);

    const sliderLoc = page.locator('[data-testid="before-after-slider"]');
    await sliderLoc.waitFor({ state: 'visible', timeout: 10_000 });
    const sliderBeforePct = Number((await sliderLoc.getAttribute('aria-valuenow')) ?? '0');
    const sliderBox = await sliderLoc.boundingBox();
    if (sliderBox) {
      await page.mouse.move(sliderBox.x + sliderBox.width * 0.78, sliderBox.y + sliderBox.height * 0.5);
      await page.mouse.down();
      await page.mouse.move(sliderBox.x + sliderBox.width * 0.62, sliderBox.y + sliderBox.height * 0.5, {
        steps: 8,
      });
      await page.mouse.up();
      await page.waitForTimeout(450);
    }
    const sliderAfterPct = Number((await sliderLoc.getAttribute('aria-valuenow')) ?? '0');

    const png02 = path.join(AUDIT_DIR, '02-tryon3d-photo-slider-1440.png');
    await page.screenshot({ path: png02, fullPage: false });

    // 3C. Gương 3D Camera + Graceful no-webcam state + Tailor's Pins toggle
    await page.locator('[data-testid="tryon-tab-camera"]').click();
    await page.waitForTimeout(1100);

    const cameraState = await page.evaluate(() => {
      const fallback = document.querySelector('[data-testid="tryon-camera-fallback"]');
      const stage = document.querySelector('[data-testid="tryon-3d-stage"]');
      const video = stage?.querySelector('video');
      return {
        hasFallbackPanel: Boolean(fallback),
        fallbackText: (fallback?.textContent || '').trim().slice(0, 120),
        hasVideo: Boolean(video),
      };
    });

    const pinsToggle = page.locator('[data-testid="tryon-tailor-pins-toggle"]');
    await pinsToggle.waitFor({ state: 'visible', timeout: 8000 });
    const pinsInitial = await pinsToggle.getAttribute('aria-pressed');
    await pinsToggle.click();
    await page.waitForTimeout(200);
    const pinsAfter1 = await pinsToggle.getAttribute('aria-pressed');
    await pinsToggle.click();
    await page.waitForTimeout(200);
    const pinsAfter2 = await pinsToggle.getAttribute('aria-pressed');

    const png03 = path.join(AUDIT_DIR, '03-tryon3d-camera-1440.png');
    await page.screenshot({ path: png03, fullPage: false });

    const test3Ok =
      beforeDragStats.stdDev > 6 &&
      beforeDragStats.nonDarkRatio > 0.05 &&
      dragMae > 0.6 &&
      wornCountText >= 2 &&
      swatchSwitched &&
      eveningPressed &&
      sliderBeforePct >= 10 &&
      Math.abs(sliderAfterPct - sliderBeforePct) >= 5 &&
      (cameraState.hasFallbackPanel || cameraState.hasVideo) &&
      pinsInitial !== pinsAfter1 &&
      pinsAfter2 === pinsInitial;

    recordCheck(
      'TEST 3',
      'All 3 Modes (Mannequin 360°, Photo + BeforeAfterSlider, Camera + Tailor Pins), Multi-Layer Outfit, Swatches & Lighting',
      test3Ok,
      [
        `Mannequin WebGL: ${beforeDragStats.width}x${beforeDragStats.height}, stdDev=${beforeDragStats.stdDev.toFixed(2)}, nonDark=${(beforeDragStats.nonDarkRatio * 100).toFixed(1)}%, 360° drag MAE=${dragMae.toFixed(2)}`,
        `Multi-layer outfit: wornCount=${wornCountText}, swatches=${swatchCount}, swatchSwitched=${swatchSwitched}, eveningLight=${eveningPressed}`,
        `Photo mode: sample=Minh Thư, BeforeAfterSlider=${sliderBeforePct}% -> ${sliderAfterPct}%`,
        `Camera mode: fallback=${cameraState.hasFallbackPanel} ("${cameraState.fallbackText.slice(0, 60)}..."), pins=${pinsInitial}->${pinsAfter1}->${pinsAfter2}`,
        `PNGs: 01-tryon3d-mannequin-1440.png, 02-tryon3d-photo-slider-1440.png, 03-tryon3d-camera-1440.png`,
      ],
    );

    // =========================================================================
    // TEST 4: Max-3 Saved Looks (3/3 + 4th-Look Limit Alert) at 1366x768 +
    //         Visual Wardrobe Tabs + Size Recommendation + Add-to-Cart Loop
    // =========================================================================
    await page.setViewportSize({ width: 1366, height: 768 });
    await page.waitForTimeout(350);
    await page.locator('[data-testid="tryon-tab-mannequin"]').click();
    await page.waitForTimeout(850);

    const captureBtn = page.locator('[data-testid="tryon-capture-look-btn"]');
    const trayCount = page.locator('[data-testid="tryon-saved-tray-count"]');

    // Capture 1 (Showroom)
    await page.locator('[data-testid="tryon-light-showroom"]').click();
    await page.waitForTimeout(350);
    await captureBtn.click();
    await page.waitForFunction(
      () => document.querySelector('[data-testid="tryon-saved-tray-count"]')?.textContent?.trim() === '1/3',
      { timeout: 8000 },
    );

    // Capture 2 (Morning)
    await page.locator('[data-testid="tryon-light-morning"]').click();
    await page.waitForTimeout(350);
    await captureBtn.click();
    await page.waitForFunction(
      () => document.querySelector('[data-testid="tryon-saved-tray-count"]')?.textContent?.trim() === '2/3',
      { timeout: 8000 },
    );

    // Capture 3 (Evening)
    await page.locator('[data-testid="tryon-light-evening"]').click();
    await page.waitForTimeout(350);
    await captureBtn.click();
    await page.waitForFunction(
      () => document.querySelector('[data-testid="tryon-saved-tray-count"]')?.textContent?.trim() === '3/3',
      { timeout: 8000 },
    );

    // Capture 4th time -> assert refined max-3 warning notice appears and count stays 3/3
    await captureBtn.click();
    const limitAlertLoc = page.locator('[data-testid="tryon-saved-limit-alert"]');
    await limitAlertLoc.waitFor({ state: 'visible', timeout: 6000 });
    const limitAlertText = (await limitAlertLoc.innerText()).trim();
    const trayCountAfter4th = (await trayCount.innerText()).trim();

    // Scroll Saved Tray into view in right column for crystal-clear screenshot at 1366x768
    await page.locator('[data-testid="tryon-saved-looks-tray"]').scrollIntoViewIfNeeded();
    await page.waitForTimeout(350);

    const savedThumbsOk = await page.evaluate(() => {
      const checks = [0, 1, 2].map((idx) => {
        const li = document.querySelector(`[data-testid="tryon-saved-look-${idx}"]`);
        const img = li?.querySelector('img');
        return Boolean(li && img && img.complete && img.naturalWidth > 0);
      });
      return checks;
    });
    const bounds1366Tray = await inspectViewportBounds(page);

    const png04 = path.join(AUDIT_DIR, '04-tryon3d-saved-tray-1366.png');
    await page.screenshot({ path: png04, fullPage: false });

    // Verify all 3 Wardrobe Source Tabs
    const tabChecks = {};
    for (const key of ['cart', 'studio', 'catalog']) {
      const tabLoc = page.locator(`[data-testid="wardrobe-source-${key}"]`);
      await tabLoc.scrollIntoViewIfNeeded();
      await tabLoc.click();
      await page.waitForTimeout(200);
      tabChecks[key] = {
        selected: (await tabLoc.getAttribute('aria-selected')) === 'true',
        label: (await tabLoc.innerText()).trim(),
      };
    }

    // Verify size recommendation banner + select Size M
    const sizeRecLoc = page.locator('[data-testid="tryon-size-recommendation"]');
    await sizeRecLoc.scrollIntoViewIfNeeded();
    const sizeRecText = (await sizeRecLoc.innerText()).trim();

    const sizeMBtn = page.locator('[data-testid="tryon-size-btn-M"]');
    await sizeMBtn.scrollIntoViewIfNeeded();
    await sizeMBtn.click();
    await page.waitForTimeout(200);
    const sizeMPressed = (await sizeMBtn.getAttribute('aria-pressed')) === 'true';

    // Click Add-to-Bag CTA & assert POST /bff/v1/storefront/cart/... returns 200/201 + QuickBagDrawer opens
    const cartRespPromise = page.waitForResponse(
      (res) =>
        res.request().method() === 'POST' &&
        res.url().includes('/bff/v1/storefront/cart/'),
      { timeout: 12_000 },
    );
    await page.locator('[data-testid="tryon-add-to-bag-btn"]').click();
    const cartResp = await cartRespPromise;
    const cartPostStatus = cartResp.status();
    const cartPostUrl = cartResp.url();

    // Wait for QuickBagDrawer (`aside#order.on`) to open and hydrate items
    await page.waitForFunction(
      () => {
        const aside = document.querySelector('aside#order');
        return Boolean(
          aside &&
            aside.classList.contains('on') &&
            aside.getAttribute('aria-hidden') === 'false',
        );
      },
      { timeout: 10_000 },
    );
    await page.waitForTimeout(800);

    const bagDrawerInfo = await page.evaluate(() => {
      const aside = document.querySelector('aside#order');
      const text = (aside?.textContent || '').trim();
      const hasEmptyMsg = text.includes('Túi đồ của bạn đang trống');
      return {
        isOpen: Boolean(aside?.classList.contains('on')),
        ariaHidden: aside?.getAttribute('aria-hidden'),
        hasEmptyMsg,
        textSample: text.replace(/\s+/g, ' ').slice(0, 140),
      };
    });

    await ctxMain.close();

    const test4Ok =
      trayCountAfter4th === '3/3' &&
      savedThumbsOk.every(Boolean) &&
      limitAlertText.includes('3 bộ') &&
      Boolean(bounds1366Tray.eyebrow?.insideY) &&
      Boolean(bounds1366Tray.footer?.insideY) &&
      tabChecks.cart.selected &&
      tabChecks.studio.selected &&
      tabChecks.catalog.selected &&
      sizeRecText.includes('Cỡ gợi ý') &&
      sizeMPressed &&
      (cartPostStatus === 200 || cartPostStatus === 201) &&
      bagDrawerInfo.isOpen &&
      !bagDrawerInfo.hasEmptyMsg;

    recordCheck(
      'TEST 4',
      'Max-3 Saved Looks (3/3 + 4th-Look Alert) at 1366x768 + 3 Wardrobe Tabs + Size M + Add-to-Cart -> QuickBagDrawer',
      test4Ok,
      [
        `Saved tray: count=${trayCountAfter4th}, thumbsLoaded=${JSON.stringify(savedThumbsOk)}, alert="${limitAlertText}"`,
        `1366x768 bounds intact: eyebrowInside=${bounds1366Tray.eyebrow?.insideY}, footerInside=${bounds1366Tray.footer?.insideY}`,
        `Wardrobe tabs: cart="${tabChecks.cart.label}", studio="${tabChecks.studio.label}", catalog="${tabChecks.catalog.label}"`,
        `Size recommendation: "${sizeRecText.replace(/\s+/g, ' ').slice(0, 70)}", sizeMPressed=${sizeMPressed}`,
        `Add-to-Bag: POST ${cartPostStatus} (${cartPostUrl}), QuickBagDrawer open=${bagDrawerInfo.isOpen}, empty=${bagDrawerInfo.hasEmptyMsg}`,
        `PNG: 04-tryon3d-saved-tray-1366.png`,
      ],
    );

    // =========================================================================
    // TEST 5: Mobile 390x844 Layout (/thu-do-ai)
    // =========================================================================
    const ctxMobile = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    const pageMobile = await ctxMobile.newPage();
    attachErrorListeners(pageMobile, 'mobile');

    await pageMobile.goto(`${ORIGIN_IP}/thu-do-ai`, { waitUntil: 'load', timeout: 45_000 });
    await pageMobile.locator('[data-testid="virtual-tryon-modal"]').first().waitFor({
      state: 'visible',
      timeout: 15_000,
    });
    await pageMobile.locator('[data-testid="tryon-tab-mannequin"]').click();
    await pageMobile.waitForTimeout(1200);

    // Scroll to the modal top so header + mode tabs + 3D stage are cleanly framed on 390x844
    await pageMobile.locator('[data-testid="virtual-tryon-modal"]').scrollIntoViewIfNeeded();
    await pageMobile.waitForTimeout(350);

    const mobileAudit = await pageMobile.evaluate(() => {
      const dom = document.documentElement;
      const modal = document.querySelector('[data-testid="virtual-tryon-modal"]');
      const stage = document.querySelector('[data-testid="tryon-3d-stage-frame"]');
      const cta = document.querySelector('[data-testid="tryon-add-to-bag-btn"]');
      const header = document.querySelector('[data-testid="tryon-header-eyebrow"]');
      const fullText = (document.body.innerText || '').toLowerCase();
      return {
        scrollWidth: dom.scrollWidth,
        innerWidth: window.innerWidth,
        horizontalOverflow: Math.max(0, dom.scrollWidth - window.innerWidth),
        hasFailedToFetch: fullText.includes('failed to fetch'),
        selectCount: modal ? modal.querySelectorAll('select').length : -1,
        headerRect: header ? header.getBoundingClientRect().toJSON() : null,
        stageRect: stage ? stage.getBoundingClientRect().toJSON() : null,
        ctaRect: cta ? cta.getBoundingClientRect().toJSON() : null,
      };
    });

    const png05 = path.join(AUDIT_DIR, '05-tryon3d-mobile-390.png');
    await pageMobile.screenshot({ path: png05, fullPage: false });
    await ctxMobile.close();

    const test5Ok =
      mobileAudit.horizontalOverflow === 0 &&
      !mobileAudit.hasFailedToFetch &&
      mobileAudit.selectCount === 0 &&
      Boolean(mobileAudit.headerRect && mobileAudit.stageRect && mobileAudit.ctaRect) &&
      mobileAudit.stageRect.top >= mobileAudit.headerRect.bottom - 2 &&
      mobileAudit.ctaRect.top >= mobileAudit.stageRect.bottom - 2;

    recordCheck(
      'TEST 5',
      'Mobile 390x844 Layout — horizontalOverflow === 0 & cleanly stacked',
      test5Ok,
      [
        `scrollWidth=${mobileAudit.scrollWidth}, innerWidth=${mobileAudit.innerWidth}, horizontalOverflow=${mobileAudit.horizontalOverflow}`,
        `stacked order: header.bottom=${Math.round(mobileAudit.headerRect?.bottom ?? -1)} <= stage.top=${Math.round(mobileAudit.stageRect?.top ?? -1)} < stage.bottom=${Math.round(mobileAudit.stageRect?.bottom ?? -1)} <= cta.top=${Math.round(mobileAudit.ctaRect?.top ?? -1)}`,
        `failedToFetch=${mobileAudit.hasFailedToFetch}, selectCount=${mobileAudit.selectCount}`,
        `PNG: 05-tryon3d-mobile-390.png`,
      ],
    );

    // =========================================================================
    // RUNTIME HYGIENE: consoleErrors === 0 & pageErrors === 0
    // =========================================================================
    const hygieneOk = consoleErrors.length === 0 && pageErrors.length === 0;
    recordCheck(
      'HYGIENE',
      'Zero browser console errors & zero uncaught page errors',
      hygieneOk,
      [
        `consoleErrors=${consoleErrors.length}`,
        `pageErrors=${pageErrors.length}`,
        ...consoleErrors.slice(0, 8).map((e) => `CONSOLE_ERR: ${e}`),
        ...pageErrors.slice(0, 8).map((e) => `PAGE_ERR: ${e}`),
      ],
    );
  } finally {
    await browser.close();
  }

  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);

  console.log('\n========================================================================');
  console.log(` 3D AR Try-On Verification Summary: PASS=${passed}/${results.length} | FAIL=${failed} (${elapsedSec}s)`);
  console.log('========================================================================');

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('\n[FATAL]', err);
  process.exit(1);
});
