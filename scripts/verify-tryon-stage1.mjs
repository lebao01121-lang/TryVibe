#!/usr/bin/env node
/**
 * Virtual Try-On Stage 1 — Comprehensive Functional & Visual Verification Suite
 * fashion-atelier-ai-platform (v3.1)
 *
 * Verifies live `http://127.0.0.1:3000` & `http://localhost:3000` + BFF `:4000`
 * in Real Chrome (1440x900):
 *   PREFLIGHT : 200 OK on :3000/, :3000/thu-do-ai, :4000/health, :4002/health,
 *               :11434/api/tags, and POST /bff/v1/tryon/synthesize (stage2Ready: true)
 *   CHECK 1   : Header Isolation & Z-Index (SiteHeader CTA, #occasion, #build, #seasons,
 *               direct /thu-do-ai on both 127.0.0.1 & localhost, elementsFromPoint,
 *               privacy badge, zero WEBGL 3D text, cameraActive cleanup)
 *   CHECK 2   : 3 Input Tabs & Zero Live-Video 2D/WebGL Garment Paste
 *               + Screenshot 1: tryon-header-and-mirror.png
 *   CHECK 3   : Dáng Mẫu Thử Nhanh (4/4 portraits loaded) + Áo Len Cashmere Cổ Lọ
 *               (Kem Cashmere clean collar + 3 lighting presets + BeforeAfterSlider
 *               + 768x1024) + Instant Cacao Đậm switch on locked frame + SHA-256 cache hit
 *               + Screenshot 2: tryon-preset-cashmere-ivory.png
 *               + Screenshot 3: tryon-preset-cashmere-cacao.png
 *   CHECK 4   : Tải Ảnh Của Bạn upload flow -> 768x1024 smart crop & synthesis
 *   CHECK 5   : Left-Bottom Compact Compare Tray (0/3 -> 1/3 -> 2/3 + Đối chiếu 2 bộ)
 *               + Canonical XS..XL order + Size Recommendation + Sticky Buy CTA inside 900px
 *               + Add to Bag -> QuickBagDrawer opens with item
 *               + Screenshot 4: tryon-standalone-and-compare.png
 *   CHECK 6   : Runtime Hygiene (0 pageerror, 0 console errors, 0 HTTP >= 400 on tryon/models/cart)
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const IS_WIN = process.platform === 'win32';

const ORIGIN_IP = 'http://127.0.0.1:3000';
const ORIGIN_LOCALHOST = 'http://localhost:3000';

const AUDIT_DIR =
  process.env.TRYON_STAGE1_AUDIT_DIR ||
  'C:\\Users\\Admin\\.gemini\\antigravity\\brain\\d1783908-6521-4608-8b37-41aae3ee9a65\\scratch\\tryon-v2-audit';

const TEST_UPLOAD_PORTRAIT = path.join(
  ROOT_DIR,
  'apps',
  'storefront',
  'public',
  'images',
  'tryon-models',
  'vn-model-tall-m.webp',
);

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

function httpRequest(urlString, { method = 'GET', headers = {}, body = undefined, timeoutMs = 12_000 } = {}) {
  return new Promise((resolve) => {
    const parsed = new URL(urlString);
    const reqHeaders = { ...headers };
    let buf = null;
    if (body !== undefined) {
      buf = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
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
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            // non-JSON
          }
          resolve({ status: res.statusCode ?? 0, bytes: Buffer.byteLength(text), text, json, error: null });
        });
      },
    );
    req.on('timeout', () => {
      req.destroy();
      resolve({ status: 0, bytes: 0, text: '', json: null, error: 'timeout' });
    });
    req.on('error', (err) => {
      resolve({ status: 0, bytes: 0, text: '', json: null, error: err.message });
    });
    if (buf) req.write(buf);
    req.end();
  });
}

async function auditTopBarAndIsolation(page, label) {
  return page.evaluate((tag) => {
    const modal = document.querySelector('[data-testid="virtual-tryon-modal"]');
    const topBar = document.querySelector('[data-testid="tryon-top-bar"]');
    const eyebrow = document.querySelector('[data-testid="tryon-header-eyebrow"]');
    const title = document.querySelector('[data-testid="tryon-header-title"]');
    const privacy = document.querySelector('[data-testid="tryon-privacy-badge"]');
    const siteHeader = document.querySelector('header.nav');
    const fullModalText = (modal?.textContent || '').trim();

    if (!modal || !topBar || !eyebrow || !title || !privacy) {
      return {
        tag,
        ok: false,
        reason: 'Missing studio header elements',
        hasModal: Boolean(modal),
        hasTopBar: Boolean(topBar),
        hasEyebrow: Boolean(eyebrow),
        hasTitle: Boolean(title),
        hasPrivacy: Boolean(privacy),
      };
    }

    const topBarRect = topBar.getBoundingClientRect();
    const eyebrowRect = eyebrow.getBoundingClientRect();
    const titleRect = title.getBoundingClientRect();
    const privacyRect = privacy.getBoundingClientRect();

    const cx = Math.min(window.innerWidth - 2, Math.max(2, titleRect.left + Math.min(titleRect.width * 0.5, 180)));
    const cy = Math.min(window.innerHeight - 2, Math.max(2, titleRect.top + titleRect.height * 0.5));
    const stackAtTitle = document.elementsFromPoint(cx, cy);
    const topHit = stackAtTitle[0] || null;
    const titleIndex = stackAtTitle.findIndex((el) => el === title || topBar.contains(el));
    const headerIndex = stackAtTitle.findIndex((el) => el.matches?.('header.nav') || Boolean(el.closest?.('header.nav')));

    const topHitInsideTopBar = Boolean(topHit && (topHit === topBar || topBar.contains(topHit)));
    const headerOverlapsTitle = headerIndex !== -1 && (titleIndex === -1 || headerIndex < titleIndex);

    const eyebrowText = (eyebrow.textContent || '').trim();
    const titleText = (title.textContent || '').trim();
    const privacyText = (privacy.textContent || '').trim();
    const hasOldWebglText =
      fullModalText.toUpperCase().includes('WEBGL 3D') ||
      fullModalText.toUpperCase().includes('100% TẠI THIẾT BỊ');

    const ok =
      topBarRect.top >= -0.5 &&
      eyebrowRect.top >= -0.5 &&
      titleRect.top >= -0.5 &&
      privacyRect.top >= -0.5 &&
      topHitInsideTopBar &&
      !headerOverlapsTitle &&
      eyebrowText.includes('PHÒNG THỬ ĐỒ AI · VIRTUAL TRY-ON ATELIER') &&
      titleText.includes('Ướm thử trực tiếp trên vóc dáng thật') &&
      privacyText.includes('TỰ ĐỘNG XÓA ẢNH SAU 15 PHÚT') &&
      !hasOldWebglText;

    return {
      tag,
      ok,
      siteHeaderPresent: Boolean(siteHeader),
      cameraActive: document.body.dataset.cameraActive ?? null,
      topBarTop: Math.round(topBarRect.top * 10) / 10,
      titleRect: {
        top: Math.round(titleRect.top * 10) / 10,
        bottom: Math.round(titleRect.bottom * 10) / 10,
        left: Math.round(titleRect.left * 10) / 10,
      },
      topHitTag: topHit ? `${topHit.tagName.toLowerCase()}[data-testid="${topHit.getAttribute('data-testid') || ''}"]` : null,
      topHitInsideTopBar,
      headerOverlapsTitle,
      eyebrowText,
      titleText,
      privacyText,
      hasOldWebglText,
    };
  }, label);
}

async function waitForSynthesizedImage(page, { prevSrc = null, timeoutMs = 20_000 } = {}) {
  await page.waitForFunction(
    (previous) => {
      const scan = document.querySelector('[data-testid="optical-tryon-scan"]');
      if (scan) return false;
      const img = document.querySelector('[data-testid="before-after-after-img"]');
      if (!(img instanceof HTMLImageElement)) return false;
      if (!img.complete || img.naturalWidth !== 768 || img.naturalHeight !== 1024) return false;
      if (!img.src || !img.src.startsWith('data:image/')) return false;
      if (previous && img.src === previous) return false;
      return true;
    },
    prevSrc,
    { timeout: timeoutMs },
  );

  // Small settle for BeforeAfterSlider sweep animation
  await page.waitForTimeout(750);

  return page.evaluate(() => {
    const stage = document.querySelector('[data-testid="tryon-stage-viewport"]');
    const afterImg = document.querySelector('[data-testid="before-after-after-img"]');
    const beforeImg = document.querySelector('[data-testid="before-after-before-img"]');
    const badge = document.querySelector('[data-testid="tryon-session-frame-badge"]');
    return {
      cacheHit: stage?.getAttribute('data-cache-hit') ?? null,
      provider: stage?.getAttribute('data-provider') ?? null,
      cleanCollar: stage?.getAttribute('data-clean-collar') ?? null,
      afterSrc: afterImg instanceof HTMLImageElement ? afterImg.src : null,
      afterW: afterImg instanceof HTMLImageElement ? afterImg.naturalWidth : 0,
      afterH: afterImg instanceof HTMLImageElement ? afterImg.naturalHeight : 0,
      beforeW: beforeImg instanceof HTMLImageElement ? beforeImg.naturalWidth : 0,
      beforeH: beforeImg instanceof HTMLImageElement ? beforeImg.naturalHeight : 0,
      frameBadge: (badge?.textContent || '').trim(),
    };
  });
}

async function main() {
  const startedAt = Date.now();
  fs.mkdirSync(AUDIT_DIR, { recursive: true });

  console.log('========================================================================');
  console.log(' Virtual Try-On Stage 1 — Build, Live & Real Chrome Visual Verifier');
  console.log(` Audit Dir: ${AUDIT_DIR}`);
  console.log('========================================================================');

  // ---------------------------------------------------------------------------
  // PREFLIGHT: Live Endpoints & POST /bff/v1/tryon/synthesize
  // ---------------------------------------------------------------------------
  const getChecks = await Promise.all(
    [
      ['storefront-ip-home', `${ORIGIN_IP}/`],
      ['storefront-lh-home', `${ORIGIN_LOCALHOST}/`],
      ['storefront-ip-tryon', `${ORIGIN_IP}/thu-do-ai`],
      ['storefront-lh-tryon', `${ORIGIN_LOCALHOST}/thu-do-ai`],
      ['bff-health', 'http://127.0.0.1:4000/health'],
      ['catalog-health', 'http://127.0.0.1:4002/health'],
      ['ollama-tags', 'http://127.0.0.1:11434/api/tags'],
    ].map(async ([label, url]) => ({ label, url, ...(await httpRequest(url)) })),
  );

  const synthPayload = {
    personFrameHash: 'stage1-verify-hash-768x1024',
    lightingPreset: 'atelier',
    poseLandmarks: [],
    garments: [
      {
        productId: 'prod-cashmere',
        variantId: 'var-ivory',
        slot: 'upper',
        colorHex: '#FAF6F0',
      },
    ],
  };

  const synthIp = await httpRequest(`${ORIGIN_IP}/bff/v1/tryon/synthesize`, {
    method: 'POST',
    body: synthPayload,
  });
  const synthLh = await httpRequest(`${ORIGIN_LOCALHOST}/bff/v1/tryon/synthesize`, {
    method: 'POST',
    body: synthPayload,
  });

  const preflightOk =
    getChecks.every((r) => r.status === 200) &&
    synthIp.status === 200 &&
    synthIp.json?.stage2Ready === true &&
    synthLh.status === 200 &&
    synthLh.json?.stage2Ready === true;

  recordCheck(
    'PREFLIGHT',
    'Live endpoints 200 OK & POST /bff/v1/tryon/synthesize returns stage2Ready: true',
    preflightOk,
    [
      ...getChecks.map((r) => `${r.label}: HTTP ${r.status} (${r.bytes}B) — ${r.url}`),
      `POST ${ORIGIN_IP}/bff/v1/tryon/synthesize -> HTTP ${synthIp.status}, provider=${synthIp.json?.provider}, stage2Ready=${synthIp.json?.stage2Ready}, cacheKey=${String(synthIp.json?.cacheKey || '').slice(0, 12)}...`,
      `POST ${ORIGIN_LOCALHOST}/bff/v1/tryon/synthesize -> HTTP ${synthLh.status}, provider=${synthLh.json?.provider}, stage2Ready=${synthLh.json?.stage2Ready}`,
    ],
  );
  if (!preflightOk) {
    process.exit(1);
  }

  // Launch Real Chrome (1440x900)
  const chromePath = findChromeExecutable();
  if (!chromePath) {
    throw new Error('Could not find local Chrome/Edge executable.');
  }
  console.log(`[BROWSER] Real Chrome binary: ${chromePath}`);

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
  const failedTryOnHttp = [];
  const otherConsoleErrors = [];

  const attachListeners = (page, tag, { isStandaloneTryOn = false } = {}) => {
    page.on('pageerror', (err) => {
      pageErrors.push(`[${tag}] ${err.message}`);
    });
    page.on('response', (res) => {
      const status = res.status();
      if (status >= 400) {
        const url = res.url();
        const isCriticalTryOn =
          url.includes('/bff/v1/tryon/') ||
          url.includes('/images/tryon-models/') ||
          url.includes('/bff/v1/cart') ||
          (isStandaloneTryOn && !url.includes('/favicon'));
        if (isCriticalTryOn) {
          failedTryOnHttp.push(`[${tag}] ${status} ${res.request().method()} ${url}`);
        }
      }
    });
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        const text = msg.text();
        const loc = msg.location()?.url || '';
        // MediaPipe TFLite WASM occasionally logs INFO lines to stderr mapped as console.error
        if (text.startsWith('INFO:') && loc.includes('/models/wasm/')) {
          return;
        }
        const isPreexistingSeasons404 =
          !isStandaloneTryOn &&
          (loc.includes('/seasons-lookbook/') ||
            text.includes('/seasons-lookbook/') ||
            text.includes('Failed to load resource: the server responded with a status of 404'));
        if (isPreexistingSeasons404) {
          otherConsoleErrors.push(`[${tag}] ${text}`);
        } else {
          consoleErrors.push(`[${tag}] ${text}${loc ? ` (${loc})` : ''}`);
        }
      }
    });
  };

  try {
    // =========================================================================
    // CHECK 1: Header Isolation & Z-Index across BOTH origins + ALL triggers
    // =========================================================================
    const check1Reports = [];

    for (const [originTag, originUrl] of [
      ['127.0.0.1', ORIGIN_IP],
      ['localhost', ORIGIN_LOCALHOST],
    ]) {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const p = await ctx.newPage();
      attachListeners(p, `check1-${originTag}-standalone`, { isStandaloneTryOn: true });

      // 1A: Direct /thu-do-ai
      await p.goto(`${originUrl}/thu-do-ai`, { waitUntil: 'load', timeout: 45_000 });
      await p.locator('[data-testid="virtual-tryon-modal"]').first().waitFor({ state: 'visible', timeout: 15_000 });
      await p.waitForTimeout(450);
      const repDirect = await auditTopBarAndIsolation(p, `${originTag}:direct:/thu-do-ai`);
      check1Reports.push({
        ...repDirect,
        ok: repDirect.ok && !repDirect.siteHeaderPresent && repDirect.cameraActive === 'true',
      });

      // 1B: Home -> click <SiteHeader /> THỬ ĐỒ AI -> /thu-do-ai
      const pHome = await ctx.newPage();
      attachListeners(pHome, `check1-${originTag}-home`, { isStandaloneTryOn: false });
      await pHome.goto(`${originUrl}/`, { waitUntil: 'load', timeout: 45_000 });
      await pHome.waitForTimeout(700);
      const headerCta = pHome.locator('header.nav a.nav__cta').first();
      await headerCta.waitFor({ state: 'visible', timeout: 10_000 });
      await headerCta.click();
      await pHome.waitForURL('**/thu-do-ai**', { timeout: 15_000 });
      await pHome.locator('[data-testid="virtual-tryon-modal"]').first().waitFor({ state: 'visible', timeout: 15_000 });
      await pHome.waitForTimeout(450);
      const repHeaderCta = await auditTopBarAndIsolation(pHome, `${originTag}:header-cta:/thu-do-ai`);
      check1Reports.push({
        ...repHeaderCta,
        ok: repHeaderCta.ok && !repHeaderCta.siteHeaderPresent && repHeaderCta.cameraActive === 'true',
      });

      await ctx.close();
    }

    // 1C: Portal modal from #occasion, #build, #seasons on 127.0.0.1 + cameraActive cleanup
    const ctxTriggers = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const pTrig = await ctxTriggers.newPage();
    attachListeners(pTrig, 'check1-home-triggers', { isStandaloneTryOn: false });
    await pTrig.goto(`${ORIGIN_IP}/`, { waitUntil: 'load', timeout: 45_000 });
    await pTrig.waitForTimeout(900);

    const sectionTriggers = [
      { id: '#occasion', btn: '[data-testid="occasion-tryon-pill"]' },
      { id: '#build', btn: '[data-testid="stage-tryon-btn"]' },
      { id: '#seasons', btn: '[data-testid="season-card-tryon-0"]' },
    ];

    let cameraActiveCleanupsOk = true;
    for (const trig of sectionTriggers) {
      await pTrig.locator(trig.id).scrollIntoViewIfNeeded();
      await pTrig.waitForTimeout(450);
      const btn = pTrig.locator(trig.btn).first();
      await btn.waitFor({ state: 'visible', timeout: 12_000 });
      await btn.click();
      await pTrig.locator('[data-testid="virtual-tryon-modal"]').first().waitFor({ state: 'visible', timeout: 12_000 });
      await pTrig.waitForTimeout(400);

      const rep = await auditTopBarAndIsolation(pTrig, `127.0.0.1:modal:${trig.id}`);

      // Close modal and verify cameraActive cleans up cleanly
      await pTrig.locator('[data-testid="tryon-close-btn"]').click();
      await pTrig.locator('[data-testid="virtual-tryon-modal"]').first().waitFor({ state: 'detached', timeout: 8_000 });
      await pTrig.waitForTimeout(250);
      const afterCloseCam = await pTrig.evaluate(() => document.body.dataset.cameraActive ?? null);
      const cleanupOk = afterCloseCam === null || afterCloseCam === 'false';
      if (!cleanupOk) cameraActiveCleanupsOk = false;

      check1Reports.push({
        ...rep,
        afterCloseCam,
        ok: rep.ok && rep.cameraActive === 'true' && cleanupOk,
      });
    }

    const check1Ok = check1Reports.every((r) => r.ok) && cameraActiveCleanupsOk;
    recordCheck(
      'CHECK 1',
      'Header Isolation & Z-Index across 127.0.0.1 & localhost (/thu-do-ai, Header CTA, #occasion, #build, #seasons)',
      check1Ok,
      check1Reports.map(
        (r) =>
          `${r.tag}: ok=${r.ok}, topBarTop=${r.topBarTop}, topHitInside=${r.topHitInsideTopBar}, headerOverlap=${r.headerOverlapsTitle}, siteHeader=${r.siteHeaderPresent}, cam=${r.cameraActive}->${r.afterCloseCam ?? 'n/a'}`,
      ),
    );

    // =========================================================================
    // CHECK 2: 3 Input Tabs & Zero Live-Video 2D/WebGL Garment Paste + Screenshot #1
    // =========================================================================
    // Open modal cleanly from #occasion for main interactive studio session
    await pTrig.locator('#occasion').scrollIntoViewIfNeeded();
    await pTrig.waitForTimeout(350);
    await pTrig.locator('[data-testid="occasion-tryon-pill"]').first().click();
    await pTrig.locator('[data-testid="virtual-tryon-modal"]').first().waitFor({ state: 'visible', timeout: 12_000 });
    await pTrig.waitForTimeout(450);

    // Select Áo Len Cashmere Cổ Lọ first so SelectedGarmentPip displays Cashmere in Screenshot #1!
    const cashmereCard = pTrig.locator('[data-testid="wardrobe-card-ao-len-cashmere-co-lo"]');
    await cashmereCard.scrollIntoViewIfNeeded();
    await cashmereCard.click();
    await pTrig.waitForTimeout(350);

    const check2Info = await pTrig.evaluate(() => {
      const tabCamera = document.querySelector('[data-testid="tryon-tab-camera"]');
      const tabUpload = document.querySelector('[data-testid="tryon-tab-upload"]');
      const tabPresets = document.querySelector('[data-testid="tryon-tab-presets"]');
      const stage = document.querySelector('[data-testid="tryon-stage-viewport"]');
      const smartMirror = document.querySelector('[data-testid="smart-mirror-camera"]');
      const pip = document.querySelector('[data-testid="selected-garment-pip"]');
      const consent = document.querySelector('[data-testid="tryon-privacy-consent-gate"]');
      const webglCanvas = document.querySelector('[data-testid="tryon-3d-webgl-canvas"]');
      const stageCanvases = stage ? stage.querySelectorAll('canvas').length : -1;
      const buyBtn = document.querySelector('[data-testid="tryon-add-to-bag-btn"]');
      const buyRect = buyBtn?.getBoundingClientRect();

      return {
        tabs: [
          (tabCamera?.textContent || '').trim(),
          (tabUpload?.textContent || '').trim(),
          (tabPresets?.textContent || '').trim(),
        ],
        hasSmartMirror: Boolean(smartMirror),
        hasSelectedGarmentPip: Boolean(pip),
        hasConsentGate: Boolean(consent),
        hasOldWebglCanvas: Boolean(webglCanvas),
        stageCanvases,
        buyVisibleInside900: Boolean(buyRect && buyRect.top >= 0 && buyRect.bottom <= 900.5 && buyRect.height > 0),
        buyRect: buyRect ? { top: Math.round(buyRect.top), bottom: Math.round(buyRect.bottom) } : null,
      };
    });

    const png1 = path.join(AUDIT_DIR, 'tryon-header-and-mirror.png');
    await pTrig.screenshot({ path: png1, fullPage: false });

    const check2Ok =
      check2Info.tabs[0].includes('Gương Camera Thông Minh') &&
      check2Info.tabs[1].includes('Tải Ảnh Của Bạn') &&
      check2Info.tabs[2].includes('Dáng Mẫu Thử Nhanh') &&
      check2Info.hasSmartMirror &&
      check2Info.hasSelectedGarmentPip &&
      check2Info.hasConsentGate &&
      !check2Info.hasOldWebglCanvas &&
      check2Info.stageCanvases === 0 &&
      check2Info.buyVisibleInside900;

    recordCheck(
      'CHECK 2',
      '3 Input Tabs & Zero Live-Video 2D/WebGL Garment Paste (Smart Mirror + SelectedGarmentPip + Sticky CTA)',
      check2Ok,
      [
        `Tabs: ${JSON.stringify(check2Info.tabs)}`,
        `smartMirror=${check2Info.hasSmartMirror}, pip=${check2Info.hasSelectedGarmentPip}, consentGate=${check2Info.hasConsentGate}, stageCanvases=${check2Info.stageCanvases}, oldWebgl=${check2Info.hasOldWebglCanvas}`,
        `Sticky Buy CTA in 1440x900: ${check2Info.buyVisibleInside900} (${JSON.stringify(check2Info.buyRect)})`,
        `Screenshot #1: ${png1}`,
      ],
    );

    // =========================================================================
    // CHECK 3: Dáng Mẫu Thử Nhanh + Áo Len Cashmere Cổ Lọ + Instant Swatch + Cache Hit
    // =========================================================================
    await pTrig.locator('[data-testid="tryon-tab-presets"]').click();
    await pTrig.locator('[data-testid="tryon-preset-models-strip"]').waitFor({ state: 'visible', timeout: 8_000 });

    // Wait for all 4 preset model thumbnails to finish loading
    await pTrig.waitForFunction(
      () => {
        const imgs = Array.from(document.querySelectorAll('[data-testid="tryon-preset-models-strip"] img'));
        return imgs.length === 4 && imgs.every((img) => img instanceof HTMLImageElement && img.complete && img.naturalWidth > 0);
      },
      { timeout: 15_000 },
    );

    const presetModelsAudit = await pTrig.evaluate(() => {
      const ids = ['vn-petite-xs', 'vn-balanced-s', 'vn-tall-m', 'vn-curvy-l'];
      return ids.map((id) => {
        const btn = document.querySelector(`[data-testid="tryon-preset-model-${id}"]`);
        const img = btn?.querySelector('img');
        return {
          id,
          found: Boolean(btn),
          loaded: Boolean(img instanceof HTMLImageElement && img.complete && img.naturalWidth > 0),
          naturalWidth: img instanceof HTMLImageElement ? img.naturalWidth : 0,
          naturalHeight: img instanceof HTMLImageElement ? img.naturalHeight : 0,
        };
      });
    });

    // Ensure Single Mode + Áo Len Cashmere Cổ Lọ + Kem Cashmere
    await pTrig.locator('[data-testid="tryon-mode-single"]').click();
    await cashmereCard.scrollIntoViewIfNeeded();
    await cashmereCard.click();

    // Ensure Kem Cashmere swatch is selected
    const ivorySwatch = pTrig.locator('[data-testid^="tryon-color-swatch-"][data-color-name*="Kem Cashmere"]').first();
    if ((await ivorySwatch.count()) > 0 && (await ivorySwatch.getAttribute('aria-pressed')) !== 'true') {
      await ivorySwatch.click();
    }

    const ivorySynth = await waitForSynthesizedImage(pTrig);

    // Verify BeforeAfterSlider + 3 lighting presets (Nắng Sớm, Showroom Atelier, Đèn Tiệc Tối)
    const sliderBeforeText = await pTrig.locator('[data-testid="before-after-slider"]').innerText();
    await pTrig.locator('[data-testid="tryon-light-morning"]').click();
    const morningSynth = await waitForSynthesizedImage(pTrig, { prevSrc: ivorySynth.afterSrc });
    await pTrig.locator('[data-testid="tryon-light-evening"]').click();
    const eveningSynth = await waitForSynthesizedImage(pTrig, { prevSrc: morningSynth.afterSrc });
    await pTrig.locator('[data-testid="tryon-light-atelier"]').click();
    const atelierReturnSynth = await waitForSynthesizedImage(pTrig, { prevSrc: eveningSynth.afterSrc });

    // Capture Screenshot #2: Kem Cashmere on Dáng Mẫu Thử Nhanh
    const png2 = path.join(AUDIT_DIR, 'tryon-preset-cashmere-ivory.png');
    await pTrig.screenshot({ path: png2, fullPage: false });

    // Save Look #1 (Kem Cashmere) into bottom-left Compact Compare Bar (0/3 -> 1/3)
    await pTrig.locator('[data-testid="tryon-save-look-btn"]').click();
    await pTrig.locator('[data-testid="tryon-saved-look-0"]').waitFor({ state: 'visible', timeout: 6_000 });
    const saveTextAfter1 = (await pTrig.locator('[data-testid="tryon-save-look-btn"]').innerText()).trim();

    // Switch color swatch to Cacao Đậm on the SAME locked session frame
    const cacaoSwatch = pTrig.locator('[data-testid^="tryon-color-swatch-"][data-color-name*="Cacao"]').first();
    await cacaoSwatch.waitFor({ state: 'visible', timeout: 6_000 });
    await cacaoSwatch.click();
    const cacaoSynth = await waitForSynthesizedImage(pTrig, { prevSrc: atelierReturnSynth.afterSrc });

    // Verify camera prompt did NOT appear and session frame stayed locked
    const stillHasCameraPrompt = (await pTrig.locator('[data-testid="smart-mirror-camera"]').count()) > 0;
    const cacaoFrameLocked =
      cacaoSynth.frameBadge.length > 0 && cacaoSynth.frameBadge === ivorySynth.frameBadge;

    // Save Look #2 (Cacao Đậm) into bottom-left Compact Compare Bar (1/3 -> 2/3)
    await pTrig.locator('[data-testid="tryon-save-look-btn"]').click();
    await pTrig.locator('[data-testid="tryon-saved-look-1"]').waitFor({ state: 'visible', timeout: 6_000 });
    const saveTextAfter2 = (await pTrig.locator('[data-testid="tryon-save-look-btn"]').innerText()).trim();

    // Capture Screenshot #3: Cacao Đậm on same locked frame + 2 saved looks in bottom-left tray
    const png3 = path.join(AUDIT_DIR, 'tryon-preset-cashmere-cacao.png');
    await pTrig.screenshot({ path: png3, fullPage: false });

    // Switch BACK to Kem Cashmere -> assert SHA-256 cache hit!
    const tCacheStart = Date.now();
    await ivorySwatch.click();
    await pTrig.waitForFunction(
      (expectedSrc) => {
        const stage = document.querySelector('[data-testid="tryon-stage-viewport"]');
        const img = document.querySelector('[data-testid="before-after-after-img"]');
        return (
          stage?.getAttribute('data-cache-hit') === 'true' &&
          img instanceof HTMLImageElement &&
          img.src === expectedSrc
        );
      },
      ivorySynth.afterSrc,
      { timeout: 6_000 },
    );
    const cacheHitMs = Date.now() - tCacheStart;
    const cacheHitAttr = await pTrig.locator('[data-testid="tryon-stage-viewport"]').getAttribute('data-cache-hit');

    const check3Ok =
      presetModelsAudit.every((m) => m.found && m.loaded) &&
      ivorySynth.afterW === 768 &&
      ivorySynth.afterH === 1024 &&
      ivorySynth.cleanCollar === 'true' &&
      sliderBeforeText.includes('Trước') &&
      sliderBeforeText.includes('Sau') &&
      sliderBeforeText.includes('Nắng Sớm') &&
      sliderBeforeText.includes('Showroom Atelier') &&
      sliderBeforeText.includes('Đèn Tiệc Tối') &&
      morningSynth.afterW === 768 &&
      eveningSynth.afterW === 768 &&
      cacaoSynth.afterW === 768 &&
      cacaoSynth.afterH === 1024 &&
      cacaoSynth.afterSrc !== ivorySynth.afterSrc &&
      !stillHasCameraPrompt &&
      cacaoFrameLocked &&
      cacheHitAttr === 'true';

    recordCheck(
      'CHECK 3',
      'Dáng Mẫu Thử Nhanh (4/4 portraits) + Áo Len Cashmere Cổ Lọ Clean Collar + Instant Cacao Switch + SHA-256 Cache Hit',
      check3Ok,
      [
        `4 Preset Models: ${presetModelsAudit.map((m) => `${m.id}(${m.naturalWidth}x${m.naturalHeight})`).join(', ')}`,
        `Ivory Cashmere: ${ivorySynth.afterW}x${ivorySynth.afterH}, cleanCollar=${ivorySynth.cleanCollar}, provider=${ivorySynth.provider}, frame="${ivorySynth.frameBadge}"`,
        `Lighting switches: morning=${morningSynth.afterW}x${morningSynth.afterH}, evening=${eveningSynth.afterW}x${eveningSynth.afterH}, atelierReturn cacheHit=${atelierReturnSynth.cacheHit}`,
        `Cacao Đậm switch on same frame: ${cacaoSynth.afterW}x${cacaoSynth.afterH}, frameLocked=${cacaoFrameLocked}, cameraPrompt=${stillHasCameraPrompt}`,
        `Return to Kem Cashmere SHA-256 cache hit: data-cache-hit=${cacheHitAttr} in ${cacheHitMs}ms`,
        `Compare Tray saves: "${saveTextAfter1}" -> "${saveTextAfter2}"`,
        `Screenshot #2: ${png2}`,
        `Screenshot #3: ${png3}`,
      ],
    );

    // =========================================================================
    // CHECK 4: Tải Ảnh Của Bạn Upload Flow (768x1024 smart crop & synthesis)
    // =========================================================================
    await pTrig.locator('[data-testid="tryon-tab-upload"]').click();
    await pTrig.locator('[data-testid="photo-upload-gate"]').waitFor({ state: 'visible', timeout: 8_000 });
    await pTrig.locator('[data-testid="tryon-photo-upload-input"]').setInputFiles(TEST_UPLOAD_PORTRAIT);

    const uploadSynth = await waitForSynthesizedImage(pTrig, { timeoutMs: 25_000 });
    const check4Ok =
      uploadSynth.beforeW === 768 &&
      uploadSynth.beforeH === 1024 &&
      uploadSynth.afterW === 768 &&
      uploadSynth.afterH === 1024 &&
      uploadSynth.afterSrc !== uploadSynth.beforeW;

    recordCheck(
      'CHECK 4',
      'Tải Ảnh Của Bạn Upload Flow (768x1024 Smart Crop & Synthesis)',
      check4Ok,
      [
        `Uploaded file: ${path.basename(TEST_UPLOAD_PORTRAIT)}`,
        `Cropped Before: ${uploadSynth.beforeW}x${uploadSynth.beforeH} | Synthesized After: ${uploadSynth.afterW}x${uploadSynth.afterH}`,
        `Frame badge: "${uploadSynth.frameBadge}", cleanCollar=${uploadSynth.cleanCollar}`,
      ],
    );

    // =========================================================================
    // CHECK 5: Left-Bottom Compare Tray + Đối chiếu 2 bộ + Canonical Sizes + Sticky CTA + QuickBagDrawer
    // =========================================================================
    // Switch back to Dáng Mẫu Thử Nhanh and verify compact compare tray placement & right column conversion bar
    await pTrig.locator('[data-testid="tryon-tab-presets"]').click();
    await pTrig.waitForTimeout(450);

    const layoutCheck5 = await pTrig.evaluate(() => {
      const stageSection = document.querySelector('section[aria-label="Sân khấu Phòng Thử Đồ AI"]');
      const rightAside = document.querySelector('aside[aria-label="Tủ đồ Atelier và đặt mua trực tiếp"]');
      const compareBar = document.querySelector('[data-testid="tryon-compact-compare-bar"]');
      const stageViewport = document.querySelector('[data-testid="tryon-stage-viewport"]');
      const sizeBtns = Array.from(document.querySelectorAll('[data-testid="tryon-size-list"] button'));
      const sizeOrder = sizeBtns.map((b) => (b.textContent || '').trim());
      const sizeRec = (document.querySelector('[data-testid="tryon-size-recommendation"]')?.textContent || '').trim();
      const buyBtn = document.querySelector('[data-testid="tryon-add-to-bag-btn"]');
      const buyRect = buyBtn?.getBoundingClientRect();
      const compareRect = compareBar?.getBoundingClientRect();
      const stageRect = stageViewport?.getBoundingClientRect();

      const saved0Img = document.querySelector('[data-testid="tryon-saved-look-0"] img');
      const saved1Img = document.querySelector('[data-testid="tryon-saved-look-1"] img');
      const empty2 = document.querySelector('[data-testid="tryon-saved-empty-2"]');

      return {
        compareInsideLeftSection: Boolean(stageSection && compareBar && stageSection.contains(compareBar)),
        compareInsideRightAside: Boolean(rightAside && compareBar && rightAside.contains(compareBar)),
        compareBelowStage: Boolean(compareRect && stageRect && compareRect.top >= stageRect.bottom - 2),
        savedThumbsOk: Boolean(
          saved0Img instanceof HTMLImageElement &&
            saved0Img.complete &&
            saved0Img.naturalWidth > 0 &&
            saved1Img instanceof HTMLImageElement &&
            saved1Img.complete &&
            saved1Img.naturalWidth > 0 &&
            empty2,
        ),
        sizeOrder,
        sizeRec,
        buyText: (buyBtn?.textContent || '').trim(),
        buyRect: buyRect
          ? {
              top: Math.round(buyRect.top * 10) / 10,
              bottom: Math.round(buyRect.bottom * 10) / 10,
              height: Math.round(buyRect.height * 10) / 10,
            }
          : null,
        buyInsideViewportNoScroll: Boolean(
          buyRect && buyRect.top >= 0 && buyRect.bottom <= 900.5 && buyRect.height > 0,
        ),
      };
    });

    // Open Đối chiếu 2 bộ side-by-side modal and verify both cards load cleanly
    await pTrig.locator('[data-testid="tryon-compare-two-btn"]').click();
    await pTrig.locator('[data-testid="tryon-compare-modal"]').waitFor({ state: 'visible', timeout: 6_000 });
    await pTrig.waitForTimeout(350);

    const compareModalCheck = await pTrig.evaluate(() => {
      const leftImg = document.querySelector('[data-testid="compare-card-left"] img');
      const rightImg = document.querySelector('[data-testid="compare-card-right"] img');
      return {
        leftLoaded: Boolean(leftImg instanceof HTMLImageElement && leftImg.complete && leftImg.naturalWidth === 768),
        rightLoaded: Boolean(rightImg instanceof HTMLImageElement && rightImg.complete && rightImg.naturalWidth === 768),
      };
    });

    await pTrig.locator('[data-testid="tryon-compare-close-btn"]').click();
    await pTrig.locator('[data-testid="tryon-compare-modal"]').waitFor({ state: 'detached', timeout: 6_000 });

    // Click THÊM VÀO GIỎ HÀNG -> assert POST /bff/v1/cart/items 200/201 + QuickBagDrawer opens with item
    const cartRespPromise = pTrig.waitForResponse(
      (res) => res.request().method() === 'POST' && res.url().includes('/bff/v1/cart/'),
      { timeout: 12_000 },
    );
    await pTrig.locator('[data-testid="tryon-add-to-bag-btn"]').click();
    const cartResp = await cartRespPromise;
    const cartStatus = cartResp.status();

    await pTrig.waitForFunction(
      () => {
        const aside = document.querySelector('aside#order');
        return Boolean(
          aside && aside.classList.contains('on') && aside.getAttribute('aria-hidden') === 'false',
        );
      },
      { timeout: 10_000 },
    );
    await pTrig.waitForTimeout(650);

    const drawerInfo = await pTrig.evaluate(() => {
      const aside = document.querySelector('aside#order');
      const text = (aside?.textContent || '').trim();
      return {
        isOpen: Boolean(aside?.classList.contains('on')),
        hasEmptyText: text.includes('Túi đồ của bạn đang trống'),
        hasCashmereOrItem: text.toLowerCase().includes('cashmere') || text.includes('Size'),
        sample: text.replace(/\s+/g, ' ').slice(0, 140),
      };
    });

    await ctxTriggers.close();

    // Screenshot #4 on standalone `/thu-do-ai` (localhost) with 2 saved looks + Đối chiếu 2 bộ side-by-side comparison proving zero <SiteHeader /> overlap
    const ctxStandalone = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const pStandalone = await ctxStandalone.newPage();
    attachListeners(pStandalone, 'check5-standalone-compare', { isStandaloneTryOn: true });
    await pStandalone.goto(`${ORIGIN_LOCALHOST}/thu-do-ai`, { waitUntil: 'load', timeout: 45_000 });
    await pStandalone.locator('[data-testid="virtual-tryon-modal"]').first().waitFor({ state: 'visible', timeout: 15_000 });
    await pStandalone.locator('[data-testid="tryon-tab-presets"]').click();
    const sCashmere = pStandalone.locator('[data-testid="wardrobe-card-ao-len-cashmere-co-lo"]');
    await sCashmere.scrollIntoViewIfNeeded();
    await sCashmere.click();
    const sIvory = await waitForSynthesizedImage(pStandalone);
    await pStandalone.locator('[data-testid="tryon-save-look-btn"]').click();
    await pStandalone.locator('[data-testid="tryon-saved-look-0"]').waitFor({ state: 'visible', timeout: 6_000 });

    const sCacaoSwatch = pStandalone.locator('[data-testid^="tryon-color-swatch-"][data-color-name*="Cacao"]').first();
    await sCacaoSwatch.click();
    await waitForSynthesizedImage(pStandalone, { prevSrc: sIvory.afterSrc });
    await pStandalone.locator('[data-testid="tryon-save-look-btn"]').click();
    await pStandalone.locator('[data-testid="tryon-saved-look-1"]').waitFor({ state: 'visible', timeout: 6_000 });

    await pStandalone.locator('[data-testid="tryon-compare-two-btn"]').click();
    await pStandalone.locator('[data-testid="tryon-compare-modal"]').waitFor({ state: 'visible', timeout: 6_000 });
    await pStandalone.waitForTimeout(450);

    const standaloneSiteHeaderCount = await pStandalone.locator('header.nav').count();
    const png4 = path.join(AUDIT_DIR, 'tryon-standalone-and-compare.png');
    await pStandalone.screenshot({ path: png4, fullPage: false });
    await ctxStandalone.close();

    const canonicalSizesMatch =
      JSON.stringify(layoutCheck5.sizeOrder) === JSON.stringify(['XS', 'S', 'M', 'L', 'XL']);

    const check5Ok =
      layoutCheck5.compareInsideLeftSection &&
      !layoutCheck5.compareInsideRightAside &&
      layoutCheck5.compareBelowStage &&
      layoutCheck5.savedThumbsOk &&
      compareModalCheck.leftLoaded &&
      compareModalCheck.rightLoaded &&
      canonicalSizesMatch &&
      layoutCheck5.sizeRec.includes('Cỡ gợi ý cho bạn') &&
      layoutCheck5.buyInsideViewportNoScroll &&
      (cartStatus === 200 || cartStatus === 201) &&
      drawerInfo.isOpen &&
      !drawerInfo.hasEmptyText &&
      standaloneSiteHeaderCount === 0;

    recordCheck(
      'CHECK 5',
      'Compact Compare Tray (Left-Bottom) + Đối chiếu 2 bộ + Canonical XS..XL + Sticky Buy CTA (<=900px) + QuickBagDrawer',
      check5Ok,
      [
        `Compare bar: inLeft=${layoutCheck5.compareInsideLeftSection}, inRight=${layoutCheck5.compareInsideRightAside}, belowStage=${layoutCheck5.compareBelowStage}, savedThumbsOk=${layoutCheck5.savedThumbsOk}`,
        `Đối chiếu 2 bộ: left768=${compareModalCheck.leftLoaded}, right768=${compareModalCheck.rightLoaded}, standaloneSiteHeaders=${standaloneSiteHeaderCount}`,
        `Sizes: ${JSON.stringify(layoutCheck5.sizeOrder)} (canonical=${canonicalSizesMatch}) | Rec: "${layoutCheck5.sizeRec}"`,
        `Sticky Buy CTA ("${layoutCheck5.buyText}"): inside900=${layoutCheck5.buyInsideViewportNoScroll}, rect=${JSON.stringify(layoutCheck5.buyRect)}`,
        `Add to Bag POST HTTP ${cartStatus} -> QuickBagDrawer open=${drawerInfo.isOpen}, empty=${drawerInfo.hasEmptyText} ("${drawerInfo.sample}")`,
        `Screenshot #4: ${png4}`,
      ],
    );

    // =========================================================================
    // CHECK 6: Runtime Hygiene
    // =========================================================================
    const check6Ok =
      pageErrors.length === 0 &&
      consoleErrors.length === 0 &&
      failedTryOnHttp.length === 0;

    recordCheck(
      'CHECK 6',
      'Runtime Hygiene (0 pageerror, 0 console errors, 0 HTTP >= 400 on /bff/v1/tryon/*, /bff/v1/cart/*, /images/tryon-models/*)',
      check6Ok,
      [
        `pageErrors=${pageErrors.length}`,
        `consoleErrors=${consoleErrors.length}`,
        `failedTryOnHttp=${failedTryOnHttp.length}`,
        ...(otherConsoleErrors.length > 0
          ? [`(non-tryon home 404 notices ignored: ${otherConsoleErrors.length})`]
          : []),
        ...pageErrors.slice(0, 5),
        ...consoleErrors.slice(0, 5),
        ...failedTryOnHttp.slice(0, 5),
      ],
    );
  } finally {
    await browser.close();
  }

  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;
  const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);

  console.log('\n========================================================================');
  console.log(` SUMMARY: PASS=${passed}/${results.length} | FAIL=${failed} | ${elapsedSec}s`);
  console.log('========================================================================');

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('\n[FATAL]', err);
  process.exit(1);
});
