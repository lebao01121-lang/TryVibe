#!/usr/bin/env node
/**
 * FULL 6-Season `#seasons` Vitrine Image, Photometric Recolor, UI Polish & Network Hygiene Verification
 * Targets: Live http://127.0.0.1:3000 AND http://localhost:3000 (1440x900 Real Chrome)
 *
 * STRICT SAFETY RULES:
 *   - Read-only browser & HTTP verification against live :3000, :4000, :4002, :11434.
 *   - NEVER runs --reset, NEVER drops DB tables, NEVER touches .project-data.
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { chromium } from 'playwright-core';

const AUDIT_DIR =
  process.env.SEASONS_AUDIT_DIR ||
  'C:\\Users\\Admin\\.gemini\\antigravity\\brain\\d1783908-6521-4608-8b37-41aae3ee9a65\\scratch\\seasons-audit';

const TARGET_ORIGINS = ['http://127.0.0.1:3000', 'http://localhost:3000'];

const EXPECTED_SEASONS = [
  { idx: 0, orderLabel: '01', slug: 'xuan-tam-xuan', shortHint: 'XUÂN LỤA' },
  { idx: 1, orderLabel: '02', slug: 'ha-pho-co', shortHint: 'HẠ LINEN' },
  { idx: 2, orderLabel: '03', slug: 'resort-ban-mai', shortHint: 'RESORT BIỂN' },
  { idx: 3, orderLabel: '04', slug: 'thu-hoang-hon', shortHint: 'THU CÔNG SỞ' },
  { idx: 4, orderLabel: '05', slug: 'dong-cashmere', shortHint: 'DẠ TWEED' },
  { idx: 5, orderLabel: '06', slug: 'atelier-di-san', shortHint: 'DẠ TIỆC' },
];

fs.mkdirSync(AUDIT_DIR, { recursive: true });

function findChromeExecutable() {
  const candidates =
    process.platform === 'win32'
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

function httpGetJsonOrStatus(url) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const req = http.get(
      {
        hostname: u.hostname,
        port: u.port || 80,
        path: `${u.pathname}${u.search}`,
        timeout: 8000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode || 0, body });
        });
      },
    );
    req.on('timeout', () => {
      req.destroy();
      resolve({ status: 0, body: '' });
    });
    req.on('error', () => resolve({ status: 0, body: '' }));
  });
}

function isImageLikeUrl(url) {
  return (
    /\.(webp|png|jpe?g|gif|avif|svg)(\?|#|$)/i.test(url) ||
    url.includes('/images/') ||
    url.includes('/seasons-lookbook/') ||
    url.includes('/occasion-macro/') ||
    url.includes('/_next/image')
  );
}

function parseRgb(rgbStr) {
  const m = /rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i.exec(rgbStr || '');
  if (!m) return null;
  return {
    r: Math.round(Number.parseFloat(m[1])),
    g: Math.round(Number.parseFloat(m[2])),
    b: Math.round(Number.parseFloat(m[3])),
  };
}

function relativeLuminance(rgb) {
  const srgb = [rgb.r, rgb.g, rgb.b].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * srgb[0] + 0.7152 * srgb[1] + 0.0722 * srgb[2];
}

function contrastRatio(rgb1, rgb2) {
  const l1 = relativeLuminance(rgb1);
  const l2 = relativeLuminance(rgb2);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

const results = [];
function record(id, title, ok, details = []) {
  results.push({ id, title, ok, details });
  console.log(`\n[${ok ? 'PASS' : 'FAIL'}] ${id} — ${title}`);
  for (const line of details) {
    console.log(`       ${line}`);
  }
}

async function scrollToSeasonsSection(page) {
  await page.waitForSelector('#seasons', { timeout: 25_000 });
  await page.waitForSelector('[data-testid="season-timeline-bar"]', { timeout: 25_000 });
  await page.evaluate(async () => {
    if (document.fonts && document.fonts.ready) {
      await document.fonts.ready;
    }
    const el = document.getElementById('seasons');
    if (!el) return;
    const container = el.closest('.pin-spacer') || el;
    const rect = container.getBoundingClientRect();
    const targetY = Math.max(0, rect.top + window.scrollY + 12);
    window.scrollTo({ top: targetY, behavior: 'instant' });
    window.dispatchEvent(new Event('scroll'));
  });
  await page.waitForTimeout(900);
  // Re-sync in case lazy layout shifted above #seasons
  await page.evaluate(() => {
    const el = document.getElementById('seasons');
    if (!el) return;
    const container = el.closest('.pin-spacer') || el;
    const rect = container.getBoundingClientRect();
    if (Math.abs(rect.top) > 30) {
      window.scrollTo({ top: Math.max(0, rect.top + window.scrollY + 8), behavior: 'instant' });
      window.dispatchEvent(new Event('scroll'));
    }
  });
  await page.waitForTimeout(700);
}

async function waitForSeasonSettled(page, expectedSlug) {
  await page.waitForFunction(
    (slug) => {
      const stage = document.querySelector('#seasons [data-season-slug][data-restyle-ready]');
      if (!stage) return false;
      if (stage.getAttribute('data-season-slug') !== slug) return false;
      if (stage.getAttribute('data-restyle-ready') !== 'true') return false;
      const imgs = Array.from(document.querySelectorAll('#seasons img'));
      if (imgs.length < 4) return false;
      return imgs.every((img) => img.complete && img.naturalWidth > 0);
    },
    expectedSlug,
    { timeout: 20_000 },
  );
  // Wait for 0.65s silk curtain reveal + crossfade transitions to settle cleanly
  await page.waitForTimeout(950);
}

async function inspectSeasonsDom(page) {
  return page.evaluate(() => {
    const section = document.getElementById('seasons');
    if (!section) return { missing: true };

    const stage = section.querySelector('[data-restyle-ready]');
    const activeSlug = stage?.getAttribute('data-season-slug') ?? null;
    const restyleReady = stage?.getAttribute('data-restyle-ready') === 'true';

    const imgs = Array.from(section.querySelectorAll('img')).map((img) => ({
      src: img.getAttribute('src') || '',
      currentSrc: img.currentSrc || '',
      alt: img.getAttribute('alt') || '',
      complete: img.complete,
      naturalWidth: img.naturalWidth,
      naturalHeight: img.naturalHeight,
      ariaHidden: img.getAttribute('aria-hidden') === 'true',
      inMacro: Boolean(img.closest('[data-testid="season-macro-swatch"]')),
      inCard0: Boolean(img.closest('[data-testid="season-product-card-0"]')),
      inCard1: Boolean(img.closest('[data-testid="season-product-card-1"]')),
      inCard2: Boolean(img.closest('[data-testid="season-product-card-2"]')),
    }));

    const brokenImgs = imgs.filter((i) => !i.complete || i.naturalWidth <= 0);
    const legacyImgs = imgs.filter((i) => i.src.includes('/seasons-lookbook/'));

    const macroOk = imgs.some((i) => i.inMacro && !i.ariaHidden && i.complete && i.naturalWidth > 0);
    const card0Ok = imgs.some((i) => i.inCard0 && i.complete && i.naturalWidth > 0);
    const card1Ok = imgs.some((i) => i.inCard1 && i.complete && i.naturalWidth > 0);
    const card2Ok = imgs.some((i) => i.inCard2 && i.complete && i.naturalWidth > 0);

    // Inspect center canvas pixels
    const canvas = section.querySelector('[data-testid="season-ai-canvas"]');
    let canvasMetrics = {
      present: false,
      width: 0,
      height: 0,
      nonEmptyRatio: 0,
      stdDev: 0,
      sampleHash: '',
    };
    if (canvas && canvas.width > 0 && canvas.height > 0) {
      const ctx = canvas.getContext('2d');
      if (ctx) {
        const w = canvas.width;
        const h = canvas.height;
        const stepX = Math.max(1, Math.floor(w / 40));
        const stepY = Math.max(1, Math.floor(h / 50));
        const data = ctx.getImageData(0, 0, w, h).data;
        let count = 0;
        let nonEmpty = 0;
        let sumLum = 0;
        let sumLumSq = 0;
        let checksumR = 0;
        let checksumG = 0;
        let checksumB = 0;
        for (let y = 0; y < h; y += stepY) {
          for (let x = 0; x < w; x += stepX) {
            const idx = (y * w + x) * 4;
            const r = data[idx];
            const g = data[idx + 1];
            const b = data[idx + 2];
            const a = data[idx + 3];
            count += 1;
            if (a > 10) nonEmpty += 1;
            const lum = 0.299 * r + 0.587 * g + 0.114 * b;
            sumLum += lum;
            sumLumSq += lum * lum;
            checksumR += r;
            checksumG += g;
            checksumB += b;
          }
        }
        const mean = count > 0 ? sumLum / count : 0;
        const variance = count > 0 ? Math.max(0, sumLumSq / count - mean * mean) : 0;
        canvasMetrics = {
          present: true,
          width: w,
          height: h,
          nonEmptyRatio: count > 0 ? nonEmpty / count : 0,
          stdDev: Math.sqrt(variance),
          sampleHash: `${Math.round(checksumR / Math.max(1, count))}-${Math.round(checksumG / Math.max(1, count))}-${Math.round(checksumB / Math.max(1, count))}`,
          avgRgb: [
            checksumR / Math.max(1, count),
            checksumG / Math.max(1, count),
            checksumB / Math.max(1, count),
          ],
        };
      }
    }

    return {
      missing: false,
      activeSlug,
      restyleReady,
      imgCount: imgs.length,
      brokenCount: brokenImgs.length,
      brokenImgs,
      legacyCount: legacyImgs.length,
      framesOk: { macroOk, card0Ok, card1Ok, card2Ok },
      canvasMetrics,
      imgs,
    };
  });
}

async function verifyOrigin(browser, origin, captureScreenshots) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();

  const pageErrors = [];
  const consoleErrors = [];
  const failedImageResponses = [];
  const failedImageRequests = [];
  const failedNonImageResponses = [];

  page.on('pageerror', (err) => {
    pageErrors.push(err.message || String(err));
  });
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      consoleErrors.push(msg.text());
    }
  });
  page.on('response', (res) => {
    const status = res.status();
    const req = res.request();
    const url = res.url();
    if (status >= 400) {
      if (req.resourceType() === 'image' || isImageLikeUrl(url)) {
        failedImageResponses.push({ status, url, resourceType: req.resourceType() });
      } else {
        failedNonImageResponses.push({
          status,
          method: req.method(),
          url,
          resourceType: req.resourceType(),
        });
      }
    }
  });
  page.on('requestfailed', (req) => {
    const url = req.url();
    const errText = req.failure()?.errorText || 'FAILED';
    if (req.resourceType() === 'image' || isImageLikeUrl(url)) {
      if (!errText.includes('ERR_ABORTED')) {
        failedImageRequests.push({ url, errorText: errText });
      }
    }
  });

  const seasonReports = [];
  let s04TitleCheck = null;
  let s04BadgeCheck = null;
  const capturedPaths = [];

  try {
    await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded', timeout: 35_000 });
    await scrollToSeasonsSection(page);

    for (const season of EXPECTED_SEASONS) {
      // Click season tab
      const tabSelector = `[data-testid="season-tab-${season.idx}"]`;
      await page.waitForSelector(tabSelector, { timeout: 15_000 });
      await page.click(tabSelector);
      await waitForSeasonSettled(page, season.slug);

      // Re-verify #seasons top alignment cleanly on viewport
      await page.evaluate(() => {
        const el = document.getElementById('seasons');
        if (!el) return;
        const rect = el.getBoundingClientRect();
        if (Math.abs(rect.top) > 16) {
          window.scrollBy({ top: rect.top, behavior: 'instant' });
        }
      });
      await page.waitForTimeout(250);

      const defaultAudit = await inspectSeasonsDom(page);

      // Capture clean default screenshots on primary origin (127.0.0.1:3000)
      if (captureScreenshots) {
        if (season.idx === 0) {
          const p = path.join(AUDIT_DIR, '01-seasons-s01-xuan-lua-1440.png');
          await page.screenshot({ path: p });
          capturedPaths.push(p);
        } else if (season.idx === 3) {
          const p = path.join(AUDIT_DIR, '02-seasons-s04-thu-cong-so-1440.png');
          await page.screenshot({ path: p });
          capturedPaths.push(p);
        } else if (season.idx === 5) {
          const p = path.join(AUDIT_DIR, '04-seasons-s06-da-tiec-1440.png');
          await page.screenshot({ path: p });
          capturedPaths.push(p);
        }
      }

      // Season 04 Specific UI Checks: 2-line title clamp & (ĐANG MỞ BÁN) dark bronze badge contrast
      if (season.idx === 3) {
        s04TitleCheck = await page.evaluate(() => {
          const card1 = document.querySelector('[data-testid="season-product-card-1"]');
          const titleEl = card1 ? card1.querySelector('a') : null;
          if (!titleEl) return { found: false };
          const cs = getComputedStyle(titleEl);
          const rect = titleEl.getBoundingClientRect();
          const lineHeight = Number.parseFloat(cs.lineHeight) || 22.95;
          const approxLines = rect.height / lineHeight;
          return {
            found: true,
            text: (titleEl.textContent || '').trim(),
            display: cs.display,
            webkitLineClamp: cs.webkitLineClamp || cs.getPropertyValue('-webkit-line-clamp'),
            webkitBoxOrient: cs.webkitBoxOrient || cs.getPropertyValue('-webkit-box-orient'),
            whiteSpace: cs.whiteSpace,
            overflow: cs.overflow,
            lineHeight,
            clientHeight: titleEl.clientHeight,
            scrollHeight: titleEl.scrollHeight,
            rectHeight: rect.height,
            approxLines: Number(approxLines.toFixed(2)),
            notClipped: titleEl.scrollHeight <= titleEl.clientHeight + 2,
          };
        });

        s04BadgeCheck = await page.evaluate(() => {
          const tab0 = document.querySelector('[data-testid="season-tab-0"]');
          if (!tab0) return { found: false };
          const ariaSelected = tab0.getAttribute('aria-selected');
          const spans = Array.from(tab0.querySelectorAll('span'));
          const badge = spans.find(
            (s) => s.children.length === 0 && (s.textContent || '').trim() === '(ĐANG MỞ BÁN)',
          );
          if (!badge) return { found: false, ariaSelected };
          const cs = getComputedStyle(badge);
          return {
            found: true,
            ariaSelected,
            text: (badge.textContent || '').trim(),
            color: cs.color,
            backgroundColor: cs.backgroundColor,
            fontWeight: cs.fontWeight,
            fontSize: cs.fontSize,
            borderRadius: cs.borderRadius,
          };
        });
      }

      // Swatch Test A: Click alternate color swatch on Standing Product Card 0
      const card0AltSwatch = page.locator(
        '[data-testid="season-product-card-0"] [data-testid^="season-card-swatch-"][aria-pressed="false"]',
      ).first();
      const card0AltColor = await card0AltSwatch.getAttribute('data-color-key');
      await card0AltSwatch.click();
      await page.waitForTimeout(750);
      await waitForSeasonSettled(page, season.slug);
      const afterCardSwatchAudit = await inspectSeasonsDom(page);

      // Swatch Test B: Open a hotspot popover (prefer slot 1, fallback slot 0) and click alternate color swatch
      const hotspotPins = page.locator('#seasons [data-hotspot-pin="true"]');
      const pinCount = await hotspotPins.count();
      const targetPinIdx = pinCount >= 2 ? 1 : 0;
      await hotspotPins.nth(targetPinIdx).click();
      await page.waitForSelector('[data-testid="season-swatch-popover"]', { timeout: 6_000 });
      const popoverAltSwatch = page.locator(
        '[data-testid="season-swatch-popover"] [data-testid^="season-popover-swatch-"][aria-pressed="false"]',
      ).first();
      const popoverAltColor = await popoverAltSwatch.getAttribute('data-color-key');
      await popoverAltSwatch.click();
      await page.waitForTimeout(750);
      // Close popover cleanly so UI & screenshot stay crisp
      const closeBtn = page.locator('[data-testid="season-swatch-popover"] button[aria-label="Đóng bảng màu"]');
      if (await closeBtn.isVisible()) {
        await closeBtn.click();
      }
      await page.waitForTimeout(450);
      await waitForSeasonSettled(page, season.slug);
      const afterPopoverSwatchAudit = await inspectSeasonsDom(page);

      // Capture Season 04 swatch-recolor screenshot after both alternate color clicks
      if (captureScreenshots && season.idx === 3) {
        const p = path.join(AUDIT_DIR, '03-seasons-s04-swatch-recolor-1440.png');
        await page.screenshot({ path: p });
        capturedPaths.push(p);
      }

      const canvasRgbDelta =
        defaultAudit.canvasMetrics.avgRgb && afterPopoverSwatchAudit.canvasMetrics.avgRgb
          ? Math.hypot(
              defaultAudit.canvasMetrics.avgRgb[0] - afterPopoverSwatchAudit.canvasMetrics.avgRgb[0],
              defaultAudit.canvasMetrics.avgRgb[1] - afterPopoverSwatchAudit.canvasMetrics.avgRgb[1],
              defaultAudit.canvasMetrics.avgRgb[2] - afterPopoverSwatchAudit.canvasMetrics.avgRgb[2],
            )
          : 0;

      const allFramesOk =
        defaultAudit.framesOk.macroOk &&
        defaultAudit.framesOk.card0Ok &&
        defaultAudit.framesOk.card1Ok &&
        defaultAudit.framesOk.card2Ok &&
        afterCardSwatchAudit.framesOk.macroOk &&
        afterCardSwatchAudit.framesOk.card0Ok &&
        afterCardSwatchAudit.framesOk.card1Ok &&
        afterCardSwatchAudit.framesOk.card2Ok &&
        afterPopoverSwatchAudit.framesOk.macroOk &&
        afterPopoverSwatchAudit.framesOk.card0Ok &&
        afterPopoverSwatchAudit.framesOk.card1Ok &&
        afterPopoverSwatchAudit.framesOk.card2Ok;

      const brokenTotal =
        defaultAudit.brokenCount +
        afterCardSwatchAudit.brokenCount +
        afterPopoverSwatchAudit.brokenCount;

      const legacyTotal =
        defaultAudit.legacyCount +
        afterCardSwatchAudit.legacyCount +
        afterPopoverSwatchAudit.legacyCount;

      const canvasOk =
        defaultAudit.canvasMetrics.present &&
        defaultAudit.canvasMetrics.nonEmptyRatio > 0.9 &&
        defaultAudit.canvasMetrics.stdDev > 8 &&
        afterCardSwatchAudit.canvasMetrics.nonEmptyRatio > 0.9 &&
        afterCardSwatchAudit.canvasMetrics.stdDev > 8 &&
        afterPopoverSwatchAudit.canvasMetrics.nonEmptyRatio > 0.9 &&
        afterPopoverSwatchAudit.canvasMetrics.stdDev > 8;

      seasonReports.push({
        orderLabel: season.orderLabel,
        slug: season.slug,
        ok: allFramesOk && brokenTotal === 0 && legacyTotal === 0 && canvasOk,
        imgCount: defaultAudit.imgCount,
        brokenTotal,
        legacyTotal,
        allFramesOk,
        canvasOk,
        defaultStdDev: Number(defaultAudit.canvasMetrics.stdDev.toFixed(2)),
        recoloredStdDev: Number(afterPopoverSwatchAudit.canvasMetrics.stdDev.toFixed(2)),
        canvasRgbDelta: Number(canvasRgbDelta.toFixed(2)),
        card0AltColor,
        popoverAltColor,
      });
    }
  } finally {
    await context.close();
  }

  return {
    origin,
    seasonReports,
    s04TitleCheck,
    s04BadgeCheck,
    failedImageResponses,
    failedImageRequests,
    failedNonImageResponses,
    pageErrors,
    consoleErrors,
    capturedPaths,
  };
}

async function main() {
  console.log('=== FULL 6-Season `#seasons` Vitrine Image & Network Verification ===');
  console.log(`Audit Dir: ${AUDIT_DIR}`);

  // 1. Live Service Health + BFF /bff/v1/seasons API Contract Check
  const [st3000, st4000, st4002, st11434, seasonsApi] = await Promise.all([
    httpGetJsonOrStatus('http://127.0.0.1:3000/'),
    httpGetJsonOrStatus('http://127.0.0.1:4000/health'),
    httpGetJsonOrStatus('http://127.0.0.1:4002/health'),
    httpGetJsonOrStatus('http://127.0.0.1:11434/api/tags'),
    httpGetJsonOrStatus('http://127.0.0.1:3000/bff/v1/seasons'),
  ]);

  const healthOk =
    st3000.status === 200 &&
    st4000.status === 200 &&
    st4002.status === 200 &&
    st11434.status === 200;

  record('HEALTH', 'Live services (:3000, :4000/health, :4002/health, :11434/api/tags)', healthOk, [
    `:3000 -> ${st3000.status}`,
    `:4000/health -> ${st4000.status}`,
    `:4002/health -> ${st4002.status}`,
    `:11434/api/tags -> ${st11434.status}`,
  ]);

  let apiSeasonCount = 0;
  let apiVitrineUrlCount = 0;
  let apiLegacyUrlCount = 0;
  let apiOk = false;
  try {
    const parsed = JSON.parse(seasonsApi.body);
    const list = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.data)
        ? parsed.data
        : Array.isArray(parsed?.seasons)
          ? parsed.seasons
          : [];
    apiSeasonCount = list.length;
    const rawStr = JSON.stringify(list);
    apiVitrineUrlCount = (rawStr.match(/\/images\/seasons-vitrine\//g) || []).length;
    apiLegacyUrlCount = (rawStr.match(/\/seasons-lookbook\//g) || []).length;
    apiOk =
      seasonsApi.status === 200 &&
      apiSeasonCount === 6 &&
      apiVitrineUrlCount >= 60 &&
      apiLegacyUrlCount === 0;
  } catch {
    apiOk = false;
  }

  record(
    'BFF-SEASONS-API',
    'GET /bff/v1/seasons returns 6 seasons with /images/seasons-vitrine/ URLs and 0 legacy URLs',
    apiOk,
    [
      `HTTP status=${seasonsApi.status}`,
      `seasons=${apiSeasonCount}/6`,
      `/images/seasons-vitrine/ refs=${apiVitrineUrlCount}`,
      `/seasons-lookbook/ legacy refs=${apiLegacyUrlCount}`,
    ],
  );

  // 2. Real Chrome 1440x900 Verification across BOTH 127.0.0.1:3000 and localhost:3000
  const chromePath = findChromeExecutable();
  if (!chromePath) {
    throw new Error('Could not find Chrome/Edge executable on this machine.');
  }

  const browser = await chromium.launch({
    executablePath: chromePath,
    headless: true,
    args: ['--no-sandbox', '--disable-gpu-sandbox', '--window-size=1440,900'],
  });

  try {
    for (let i = 0; i < TARGET_ORIGINS.length; i += 1) {
      const origin = TARGET_ORIGINS[i];
      const captureScreenshots = i === 0;
      const report = await verifyOrigin(browser, origin, captureScreenshots);

      const allSeasonsPassed =
        report.seasonReports.length === 6 && report.seasonReports.every((s) => s.ok);
      const totalBrokenImgs = report.seasonReports.reduce((acc, s) => acc + s.brokenTotal, 0);

      record(
        `SEASONS-${i + 1}`,
        `All 6 Seasons (01..06) images + canvas + 2-swatch recolor on ${origin}`,
        allSeasonsPassed && totalBrokenImgs === 0,
        report.seasonReports.map(
          (s) =>
            `S${s.orderLabel} (${s.slug}): ok=${s.ok}, imgs=${s.imgCount}, broken=${s.brokenTotal}, legacy=${s.legacyTotal}, canvasStdDev=${s.defaultStdDev}->${s.recoloredStdDev} (ΔRGB=${s.canvasRgbDelta}), swatches=[card:${s.card0AltColor}, popover:${s.popoverAltColor}]`,
        ),
      );

      // Season 04 Specific Title + Contrast Badge Assertion
      const title = report.s04TitleCheck;
      const titleOk = Boolean(
        title &&
          title.found &&
          title.text === 'Quần Tây Ống Suông Xếp Ly Đôi' &&
          String(title.webkitLineClamp) === '2' &&
          title.whiteSpace === 'normal' &&
          (title.display === '-webkit-box' || title.display === 'flow-root') &&
          title.approxLines >= 1.5 &&
          title.notClipped,
      );

      const badge = report.s04BadgeCheck;
      const badgeRgb = badge?.found ? parseRgb(badge.color) : null;
      const targetDarkBronze = { r: 110, g: 78, b: 25 }; // #6E4E19
      const creamPillBg = { r: 239, g: 229, b: 211 }; // rgba(176,138,74,0.16) over #FBF7EF
      const badgeLum = badgeRgb ? relativeLuminance(badgeRgb) : 1;
      const maxDarkBronzeLum = relativeLuminance(targetDarkBronze) + 0.005;
      const badgeContrast = badgeRgb ? contrastRatio(badgeRgb, creamPillBg) : 0;
      const badgeOk = Boolean(
        badge &&
          badge.found &&
          badge.ariaSelected === 'false' &&
          badgeRgb &&
          badgeLum <= maxDarkBronzeLum &&
          badgeContrast >= 5.0,
      );

      record(
        `S04-POLISH-${i + 1}`,
        `Season 04 2-line title clamp & inactive Tab 01 (ĐANG MỞ BÁN) dark bronze badge on ${origin}`,
        titleOk && badgeOk,
        [
          `Title: text="${title?.text}", clamp=${title?.webkitLineClamp}, display=${title?.display}, whiteSpace=${title?.whiteSpace}, height=${title?.rectHeight?.toFixed?.(1)}px (~${title?.approxLines} lines), notClipped=${title?.notClipped}, ok=${titleOk}`,
          `Badge(tab0 inactive): ariaSelected=${badge?.ariaSelected}, color=${badge?.color}, bg=${badge?.backgroundColor}, weight=${badge?.fontWeight}, lum=${badgeLum.toFixed(4)} (<=${maxDarkBronzeLum.toFixed(4)}), contrast=${badgeContrast.toFixed(2)}:1, ok=${badgeOk}`,
        ],
      );

      // Global Network & Console Hygiene Check
      const netOk =
        report.failedImageResponses.length === 0 &&
        report.failedImageRequests.length === 0 &&
        report.pageErrors.length === 0 &&
        totalBrokenImgs === 0;

      record(
        `HYGIENE-${i + 1}`,
        `Global Network & Console Hygiene on ${origin} (0 failed images, 0 pageErrors, 0 brokenImgs)`,
        netOk,
        [
          `failedImageResponses(>=400)=${report.failedImageResponses.length}`,
          `failedImageRequests=${report.failedImageRequests.length}`,
          `brokenSeasonImgs=${totalBrokenImgs}`,
          `pageErrors=${report.pageErrors.length}`,
          `nonImage>=400=${report.failedNonImageResponses.length} (${Array.from(new Set(report.failedNonImageResponses.map((r) => `${r.status} ${r.method} ${new URL(r.url).pathname}`))).join(', ') || 'none'})`,
          ...report.failedImageResponses.map(
            (f) => `  FAILED_IMG_RES: ${f.status} ${f.url} (${f.resourceType})`,
          ),
          ...report.failedImageRequests.map(
            (f) => `  FAILED_IMG_REQ: ${f.errorText} ${f.url}`,
          ),
          ...report.pageErrors.map((e) => `  PAGE_ERROR: ${e}`),
        ],
      );

      if (captureScreenshots) {
        const allShotsExist =
          report.capturedPaths.length === 4 &&
          report.capturedPaths.every((p) => fs.existsSync(p) && fs.statSync(p).size > 20_000);
        record('SCREENSHOTS', 'Captured 4 clean 1440x900 audit PNGs', allShotsExist, [
          ...report.capturedPaths.map((p) => {
            const kb = fs.existsSync(p) ? (fs.statSync(p).size / 1024).toFixed(1) : '0';
            return `${p} (${kb} KB)`;
          }),
        ]);
      }
    }
  } finally {
    await browser.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log('\n============================================================');
  console.log(
    `SUMMARY: ${results.length - failed.length}/${results.length} PASS, ${failed.length} FAIL`,
  );
  console.log('============================================================');
  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
