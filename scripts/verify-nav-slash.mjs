#!/usr/bin/env node
/**
 * <SiteHeader /> Diagonal Gold Slash Scroll-Spy & GPU Journey Progress Verification
 * Target: Live http://127.0.0.1:3000 (1440x900 Real Chrome)
 *
 * STRICT SAFETY RULES:
 *   - Read-only browser verification against live :3000, :4000, :11434.
 *   - NEVER resets DB, NEVER drops tables, NEVER touches .project-data.
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { chromium } from 'playwright-core';

const BASE_URL = process.env.STOREFRONT_URL || 'http://127.0.0.1:3000';
const AUDIT_DIR =
  process.env.NAV_SLASH_AUDIT_DIR ||
  'C:\\Users\\Admin\\.gemini\\antigravity\\brain\\d1783908-6521-4608-8b37-41aae3ee9a65\\scratch\\nav-slash-audit';

const EXPECTED_ITEMS = [
  { id: 'rack', label: 'BỘ SƯU TẬP', step: '01/06' },
  { id: 'occasion', label: 'THEO DỊP', step: '02/06' },
  { id: 'build', label: 'PHỐI ĐỒ', step: '03/06' },
  { id: 'seasons', label: 'LỊCH BST', step: '04/06' },
  { id: 'atelier', label: 'XƯỞNG MAY', step: '05/06' },
  { id: 'contact', label: 'CỬA HÀNG', step: '06/06' },
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

function httpGetStatus(url) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const req = http.get(
      { hostname: u.hostname, port: u.port || 80, path: `${u.pathname}${u.search}`, timeout: 5000 },
      (res) => {
        res.resume();
        resolve(res.statusCode || 0);
      },
    );
    req.on('timeout', () => {
      req.destroy();
      resolve(0);
    });
    req.on('error', () => resolve(0));
  });
}

const results = [];
function record(id, title, ok, details = []) {
  results.push({ id, title, ok, details });
  console.log(`\n[${ok ? 'PASS' : 'FAIL'}] ${id} — ${title}`);
  for (const line of details) {
    console.log(`       ${line}`);
  }
}

async function waitForPageReady(page) {
  await page.waitForSelector('header.nav', { timeout: 15_000 });
  await page.waitForSelector('[data-testid="nav-journey-item-rack"]', { timeout: 15_000 });
  await page.evaluate(async () => {
    if (document.fonts && document.fonts.ready) {
      await document.fonts.ready;
    }
  });
  await page.waitForTimeout(700);
}

async function readNavSnapshot(page) {
  return page.evaluate((ids) => {
    const header = document.querySelector('header.nav');
    const isLight = header ? header.classList.contains('is-light') : null;
    const progressEl = document.querySelector('[data-testid="nav-journey-progress"]');
    const progressStyle = progressEl ? getComputedStyle(progressEl) : null;
    const progressTransform = progressStyle ? progressStyle.transform : 'none';
    let scaleX = 0;
    if (progressTransform && progressTransform !== 'none') {
      const m = progressTransform.match(/matrix\(([^)]+)\)/);
      if (m) {
        const parts = m[1].split(',').map((s) => Number.parseFloat(s.trim()));
        if (Number.isFinite(parts[0])) {
          scaleX = parts[0];
        }
      }
    }
    const barEndX = scaleX * window.innerWidth;

    const items = ids.map((id) => {
      const el = document.querySelector(`[data-testid="nav-journey-item-${id}"]`);
      if (!el) return { id, missing: true };
      const rect = el.getBoundingClientRect();
      const labelEl = el.querySelector('span:last-of-type');
      const badgeEl = el.querySelector('span:first-of-type');
      const svgEl = el.querySelector('svg');
      const lineEl = svgEl ? svgEl.querySelector('line') : null;
      const tipEl = svgEl ? svgEl.querySelector('circle') : null;

      const badgeStyle = badgeEl ? getComputedStyle(badgeEl) : null;
      const lineStyle = lineEl ? getComputedStyle(lineEl) : null;
      const tipStyle = tipEl ? getComputedStyle(tipEl) : null;
      const elStyle = getComputedStyle(el);
      const svgStyle = svgEl ? getComputedStyle(svgEl) : null;

      const dashoffsetRaw = lineStyle ? lineStyle.strokeDashoffset : '';
      const dashoffsetNum = Number.parseFloat(dashoffsetRaw);
      const strokeWidthNum = lineStyle ? Number.parseFloat(lineStyle.strokeWidth) : Number.NaN;

      return {
        id,
        missing: false,
        state: el.getAttribute('data-nav-state'),
        ariaCurrent: el.getAttribute('aria-current'),
        labelText: (labelEl?.textContent || '').trim(),
        badgeTestId: badgeEl?.getAttribute('data-testid') || null,
        badgeText: (badgeEl?.textContent || '').trim(),
        badgeOpacity: badgeStyle ? Number.parseFloat(badgeStyle.opacity) : 0,
        badgeVisibility: badgeStyle ? badgeStyle.visibility : 'hidden',
        lineDashoffset: Number.isFinite(dashoffsetNum) ? dashoffsetNum : null,
        lineOpacity: lineStyle ? Number.parseFloat(lineStyle.opacity) : 0,
        lineStrokeWidth: Number.isFinite(strokeWidthNum) ? strokeWidthNum : null,
        tipOpacity: tipStyle ? Number.parseFloat(tipStyle.opacity) : 0,
        tipVisibility: tipStyle ? tipStyle.visibility : 'hidden',
        tipRadius: tipEl ? tipEl.getAttribute('r') : null,
        hasBlurFilter:
          (elStyle.filter && elStyle.filter.includes('blur')) ||
          (svgStyle?.filter && svgStyle.filter.includes('blur')) ||
          false,
        linkCenterX: rect.left + rect.width / 2,
        linkLeft: rect.left,
        linkRight: rect.right,
      };
    });

    const activeItems = items.filter((i) => !i.missing && i.state === 'active');
    const passedItems = items.filter((i) => !i.missing && i.state === 'passed');
    const upcomingItems = items.filter((i) => !i.missing && i.state === 'upcoming');
    const ariaCurrentItems = items.filter((i) => !i.missing && i.ariaCurrent === 'location');

    return {
      scrollY: window.scrollY,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      scrollHeight: document.documentElement.scrollHeight,
      isLight,
      scaleX,
      barEndX,
      progressTransform,
      activeCount: activeItems.length,
      passedCount: passedItems.length,
      upcomingCount: upcomingItems.length,
      ariaCurrentCount: ariaCurrentItems.length,
      activeId: activeItems[0]?.id ?? null,
      items,
    };
  }, EXPECTED_ITEMS.map((i) => i.id));
}

async function getSectionScrollMetrics(page, id) {
  return page.evaluate((sectionId) => {
    const el = document.getElementById(sectionId);
    if (!el) return null;
    const container = el.closest('.pin-spacer') ?? el;
    const rect = container.getBoundingClientRect();
    const docTop = rect.top + window.scrollY;
    const maxScroll = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
    return {
      sectionId,
      pinned: container !== el,
      docTop,
      height: rect.height,
      rectTop: rect.top,
      rectBottom: rect.bottom,
      maxScroll,
    };
  }, id);
}

/**
 * Scroll smoothly in small steps so Lenis + GSAP ScrollTrigger + IntersectionObserver
 * stay completely synchronized, then wait for CSS 0.45s transitions to finish.
 */
async function scrollSmoothlyToY(page, targetY, steps = 8) {
  await page.evaluate(
    async ({ dest, count }) => {
      const maxScroll = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
      const clampedDest = Math.max(0, Math.min(maxScroll, dest));
      const start = window.scrollY;
      for (let i = 1; i <= count; i += 1) {
        const y = start + ((clampedDest - start) * i) / count;
        window.scrollTo({ top: y, behavior: 'instant' });
        window.dispatchEvent(new Event('scroll'));
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      }
      window.scrollTo({ top: clampedDest, behavior: 'instant' });
      window.dispatchEvent(new Event('scroll'));
    },
    { dest: targetY, count: steps },
  );
  await page.waitForTimeout(700);
}

async function waitForNavSettled(page, expectedActiveId = null, timeoutMs = 4000) {
  await page.waitForFunction(
    (targetId) => {
      const bar = document.querySelector('[data-testid="nav-journey-progress"]');
      if (!bar) return false;
      const inlineMatch = (bar.style.transform || '').match(/scaleX\(([^)]+)\)/);
      const targetScale = inlineMatch ? Number.parseFloat(inlineMatch[1]) : 0;
      const cs = getComputedStyle(bar).transform;
      let currentScale = 0;
      if (cs && cs !== 'none') {
        const m = cs.match(/matrix\(([^)]+)\)/);
        if (m) currentScale = Number.parseFloat(m[1].split(',')[0]) || 0;
      }
      if (Math.abs(currentScale - targetScale) > 0.008) return false;

      if (!targetId) {
        return document.querySelectorAll('[data-nav-state="active"]').length === 0;
      }
      const el = document.querySelector(`[data-testid="nav-journey-item-${targetId}"]`);
      if (!el || el.getAttribute('data-nav-state') !== 'active') return false;
      const line = el.querySelector('svg line');
      const tip = el.querySelector('svg circle');
      if (!line || !tip) return false;
      const lineCs = getComputedStyle(line);
      const tipCs = getComputedStyle(tip);
      const dashOffset = Number.parseFloat(lineCs.strokeDashoffset || '1');
      const lineOp = Number.parseFloat(lineCs.opacity || '0');
      const sw = Number.parseFloat(lineCs.strokeWidth || '0');
      const tipOp = Number.parseFloat(tipCs.opacity || '0');
      if (dashOffset > 0.02 || lineOp < 0.95 || Math.abs(sw - 1.5) > 0.1 || tipOp < 0.95) {
        return false;
      }

      // Also ensure all passed items finished transitioning to stroke-width: 1px
      const passedEls = Array.from(document.querySelectorAll('[data-nav-state="passed"]'));
      for (const pel of passedEls) {
        const pLine = pel.querySelector('svg line');
        const pTip = pel.querySelector('svg circle');
        if (pLine) {
          const pcs = getComputedStyle(pLine);
          if (Math.abs(Number.parseFloat(pcs.strokeWidth || '0') - 1.0) > 0.1) return false;
          if (Number.parseFloat(pcs.strokeDashoffset || '1') > 0.02) return false;
        }
        if (pTip && Number.parseFloat(getComputedStyle(pTip).opacity || '1') > 0.05) {
          return false;
        }
      }
      return true;
    },
    expectedActiveId,
    { timeout: timeoutMs },
  );
  await page.waitForTimeout(120);
}

async function scrollToSectionStart(page, id, extraOffset = 24) {
  // First pass to resolve any lazy layout / pin-spacer geometry
  let m = await getSectionScrollMetrics(page, id);
  if (!m) {
    throw new Error(`Section #${id} not found on page`);
  }
  await scrollSmoothlyToY(page, Math.max(0, m.docTop + extraOffset), 10);
  // Second check in case GSAP/images shifted height during scroll
  const m2 = await getSectionScrollMetrics(page, id);
  if (m2 && Math.abs(m2.rectTop + extraOffset) > 60) {
    await scrollSmoothlyToY(page, Math.max(0, m2.docTop + extraOffset), 6);
  }
  await waitForNavSettled(page, id, 4500);
  return getSectionScrollMetrics(page, id);
}

async function captureHeaderViewport(page, filename) {
  const outPath = path.join(AUDIT_DIR, filename);
  await page.screenshot({
    path: outPath,
    clip: { x: 0, y: 0, width: 1440, height: 640 },
  });
  return outPath;
}

async function main() {
  console.log('=== <SiteHeader /> Diagonal Gold Slash & Journey Progress Verification ===');
  console.log(`Target: ${BASE_URL}`);
  console.log(`Audit Dir: ${AUDIT_DIR}`);

  // 0. Verify live services
  const [st3000, st4000, st11434] = await Promise.all([
    httpGetStatus('http://127.0.0.1:3000/'),
    httpGetStatus('http://127.0.0.1:4000/health'),
    httpGetStatus('http://127.0.0.1:11434/api/tags'),
  ]);
  record(
    'HEALTH',
    'Live services (:3000, :4000/health, :11434/api/tags)',
    st3000 === 200 && st4000 === 200 && st11434 === 200,
    [`:3000 -> ${st3000}`, `:4000/health -> ${st4000}`, `:11434/api/tags -> ${st11434}`],
  );

  const chromePath = findChromeExecutable();
  if (!chromePath) {
    throw new Error('Could not find Chrome/Edge executable on this machine.');
  }

  const browser = await chromium.launch({
    executablePath: chromePath,
    headless: true,
    args: ['--no-sandbox', '--disable-gpu-sandbox', '--window-size=1440,900'],
  });

  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();

  const pageErrors = [];
  const consoleErrors = [];
  const navConsoleErrors = [];

  page.on('pageerror', (err) => {
    pageErrors.push(err.message || String(err));
  });
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      const txt = msg.text();
      consoleErrors.push(txt);
      // Flag any error related to SiteHeader, nav, hydration, React, SVG, Lenis, or non-CORS app bugs
      const isExpectedLoopbackBffCors =
        txt.includes('127.0.0.1:4000') ||
        txt.includes('localhost:4000') ||
        txt.includes('ERR_FAILED') ||
        txt.includes('Access-Control-Allow-Origin') ||
        txt.includes('Failed to load resource');
      if (!isExpectedLoopbackBffCors) {
        navConsoleErrors.push(txt);
      }
    }
  });

  try {
    // =========================================================================
    // TEST 1 — Hero Top (#top, y=0)
    // =========================================================================
    await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await waitForPageReady(page);
    await scrollSmoothlyToY(page, 0, 2);

    const snap1 = await readNavSnapshot(page);
    const labelsMatch = EXPECTED_ITEMS.every((exp, idx) => {
      const actual = snap1.items[idx];
      return actual && !actual.missing && actual.labelText.toUpperCase() === exp.label;
    });
    const zeroBlur = snap1.items.every((item) => !item.hasBlurFilter);

    const shot1 = await captureHeaderViewport(page, '01-nav-hero-top-1440.png');
    const t1Ok =
      snap1.activeCount === 0 &&
      snap1.passedCount === 0 &&
      snap1.upcomingCount === 6 &&
      snap1.ariaCurrentCount === 0 &&
      Math.abs(snap1.scaleX) <= 0.001 &&
      snap1.isLight === false &&
      labelsMatch &&
      zeroBlur;

    record('TEST 1', 'Hero Top (#top, y=0) clean dark header & zero active slashes', t1Ok, [
      `scrollY=${snap1.scrollY}, isLight=${snap1.isLight}`,
      `active=${snap1.activeCount}, passed=${snap1.passedCount}, upcoming=${snap1.upcomingCount}, ariaCurrent=${snap1.ariaCurrentCount}`,
      `scaleX=${snap1.scaleX.toFixed(5)} (transform=${snap1.progressTransform})`,
      `labelsMatch=${labelsMatch}, zeroBlur=${zeroBlur}`,
      `Screenshot: ${shot1}`,
    ]);

    // =========================================================================
    // TEST 2 — Dark Header State (#rack 01/06)
    // =========================================================================
    const rackMetrics = await scrollToSectionStart(page, 'rack', 32);
    const snap2 = await readNavSnapshot(page);
    const rackItem = snap2.items[0];
    const rackTipDiff = Math.abs(snap2.barEndX - rackItem.linkCenterX);
    const shot2 = await captureHeaderViewport(page, '02-nav-dark-rack-01-1440.png');

    const t2Ok =
      snap2.isLight === false &&
      rackItem.ariaCurrent === 'location' &&
      rackItem.state === 'active' &&
      rackItem.badgeTestId === 'nav-step-badge' &&
      rackItem.badgeText === '01/06' &&
      rackItem.badgeOpacity >= 0.75 &&
      rackItem.badgeVisibility === 'visible' &&
      rackItem.lineDashoffset === 0 &&
      rackItem.lineOpacity >= 0.9 &&
      Math.abs((rackItem.lineStrokeWidth ?? 0) - 1.5) <= 0.15 &&
      rackItem.tipOpacity >= 0.9 &&
      rackItem.tipVisibility === 'visible' &&
      rackTipDiff <= 36;

    record('TEST 2', 'Dark Header State (#rack 01/06) gold slash + tip dot + progress sync', t2Ok, [
      `scrollY=${snap2.scrollY}, pinned=${rackMetrics?.pinned}, isLight=${snap2.isLight}`,
      `rack: state=${rackItem.state}, ariaCurrent=${rackItem.ariaCurrent}, badge="${rackItem.badgeText}" (op=${rackItem.badgeOpacity.toFixed(2)}, vis=${rackItem.badgeVisibility})`,
      `slash: dashoffset=${rackItem.lineDashoffset}, opacity=${rackItem.lineOpacity.toFixed(2)}, strokeWidth=${rackItem.lineStrokeWidth}px, tipOp=${rackItem.tipOpacity.toFixed(2)}, r=${rackItem.tipRadius}`,
      `progress: scaleX=${snap2.scaleX.toFixed(4)}, barEndX=${snap2.barEndX.toFixed(1)}px vs linkCenterX=${rackItem.linkCenterX.toFixed(1)}px (|diff|=${rackTipDiff.toFixed(1)}px <= 36px)`,
      `Screenshot: ${shot2}`,
    ]);

    // =========================================================================
    // TEST 3 — Light Header State (#build 03/06)
    // =========================================================================
    const buildMetrics = await scrollToSectionStart(page, 'build', 48);
    const snap3 = await readNavSnapshot(page);
    const buildItem = snap3.items[2];
    const passedRack = snap3.items[0];
    const passedOccasion = snap3.items[1];
    const upcoming3 = snap3.items.slice(3);
    const buildTipDiff = Math.abs(snap3.barEndX - buildItem.linkCenterX);
    const shot3 = await captureHeaderViewport(page, '03-nav-light-build-03-1440.png');

    const passedOk = [passedRack, passedOccasion].every(
      (it) =>
        it.state === 'passed' &&
        it.ariaCurrent === null &&
        it.lineDashoffset === 0 &&
        Math.abs((it.lineStrokeWidth ?? 0) - 1.0) <= 0.15 &&
        it.lineOpacity >= 0.35 &&
        it.lineOpacity <= 0.65 &&
        it.tipOpacity <= 0.05,
    );
    const upcomingOk = upcoming3.every(
      (it) => it.state === 'upcoming' && it.ariaCurrent === null && it.lineOpacity <= 0.05,
    );

    const t3Ok =
      snap3.isLight === true &&
      buildItem.state === 'active' &&
      buildItem.ariaCurrent === 'location' &&
      buildItem.badgeTestId === 'nav-step-badge' &&
      buildItem.badgeText === '03/06' &&
      buildItem.badgeOpacity >= 0.75 &&
      buildItem.lineDashoffset === 0 &&
      Math.abs((buildItem.lineStrokeWidth ?? 0) - 1.5) <= 0.15 &&
      buildItem.tipOpacity >= 0.9 &&
      passedOk &&
      upcomingOk &&
      buildTipDiff <= 36;

    record('TEST 3', 'Light Header State (#build 03/06) active + passed + upcoming + progress sync', t3Ok, [
      `scrollY=${snap3.scrollY}, pinned=${buildMetrics?.pinned}, isLight=${snap3.isLight}`,
      `build(03/06): state=${buildItem.state}, ariaCurrent=${buildItem.ariaCurrent}, dashoffset=${buildItem.lineDashoffset}, sw=${buildItem.lineStrokeWidth}px, tipOp=${buildItem.tipOpacity.toFixed(2)}`,
      `passed(rack,occasion): ok=${passedOk} [rack: sw=${passedRack.lineStrokeWidth}px/do=${passedRack.lineDashoffset}/op=${passedRack.lineOpacity.toFixed(2)}, occasion: sw=${passedOccasion.lineStrokeWidth}px/do=${passedOccasion.lineDashoffset}/op=${passedOccasion.lineOpacity.toFixed(2)}]`,
      `upcoming(seasons,atelier,contact): ok=${upcomingOk} [${upcoming3.map((u) => `${u.id}:${u.state}`).join(', ')}]`,
      `progress: scaleX=${snap3.scaleX.toFixed(4)}, barEndX=${snap3.barEndX.toFixed(1)}px vs linkCenterX=${buildItem.linkCenterX.toFixed(1)}px (|diff|=${buildTipDiff.toFixed(1)}px <= 36px)`,
      `Screenshot: ${shot3}`,
    ]);

    // =========================================================================
    // TEST 4 — Full 6-Section Progression (#rack -> #occasion -> #build -> #seasons -> #atelier -> #contact)
    // =========================================================================
    await scrollSmoothlyToY(page, 0, 4);
    const progressionLogs = [];
    let progressionAllOk = true;
    let prevScale = -1;

    for (let idx = 0; idx < EXPECTED_ITEMS.length; idx += 1) {
      const exp = EXPECTED_ITEMS[idx];
      const secM = await scrollToSectionStart(page, exp.id, 40);
      const snap = await readNavSnapshot(page);
      const cur = snap.items[idx];
      const stepOk =
        snap.activeId === exp.id &&
        cur.ariaCurrent === 'location' &&
        cur.badgeText === exp.step &&
        cur.badgeOpacity >= 0.75 &&
        snap.passedCount === idx &&
        snap.upcomingCount === EXPECTED_ITEMS.length - 1 - idx &&
        snap.scaleX > prevScale;

      if (!stepOk) progressionAllOk = false;
      prevScale = snap.scaleX;
      progressionLogs.push(
        `#${exp.id} (${exp.step}): active=${snap.activeId}, passed=${snap.passedCount}, upcoming=${snap.upcomingCount}, isLight=${snap.isLight}, pinned=${secM?.pinned}, scaleX=${snap.scaleX.toFixed(4)}, ok=${stepOk}`,
      );
    }

    // Scroll to the very bottom of #contact
    const bottomY = await page.evaluate(
      () => Math.max(0, document.documentElement.scrollHeight - window.innerHeight),
    );
    await scrollSmoothlyToY(page, bottomY, 8);
    await waitForNavSettled(page, 'contact', 4500);
    const snapBottom = await readNavSnapshot(page);
    const contactItem = snapBottom.items[5];
    const items0to4Passed = snapBottom.items.slice(0, 5).every((it) => it.state === 'passed');
    const shot4 = await captureHeaderViewport(page, '04-nav-contact-06-1440.png');

    const bottomOk =
      contactItem.state === 'active' &&
      contactItem.ariaCurrent === 'location' &&
      contactItem.badgeText === '06/06' &&
      items0to4Passed &&
      snapBottom.scaleX >= 0.9;

    record('TEST 4', 'Full 6-Section Progression (01/06..06/06) & #contact bottom scaleX >= 0.90', progressionAllOk && bottomOk, [
      ...progressionLogs,
      `bottom(#contact): scrollY=${snapBottom.scrollY}/${bottomY}, active=${snapBottom.activeId} (${contactItem.badgeText}), items0..4Passed=${items0to4Passed}, scaleX=${snapBottom.scaleX.toFixed(4)} (>= 0.90), isLight=${snapBottom.isLight}`,
      `Screenshot: ${shot4}`,
    ]);

    // =========================================================================
    // TEST 5 — Click Navigation & Subpage Route Matching (/bo-suu-tap, /phoi-do)
    // =========================================================================
    await scrollSmoothlyToY(page, 0, 6);
    await page.click('[data-testid="nav-journey-item-occasion"]');
    await page.waitForFunction(
      () =>
        document
          .querySelector('[data-testid="nav-journey-item-occasion"]')
          ?.getAttribute('data-nav-state') === 'active',
      null,
      { timeout: 6_000 },
    );
    // Let smooth scroll finish completely (Lenis duration is 1.15s)
    await page.waitForTimeout(1400);
    const snapClick = await readNavSnapshot(page);
    const occasionRectAfterClick = await getSectionScrollMetrics(page, 'occasion');
    const clickItem = snapClick.items[1];
    const clickOk =
      clickItem.state === 'active' &&
      clickItem.ariaCurrent === 'location' &&
      clickItem.badgeText === '02/06' &&
      occasionRectAfterClick !== null &&
      occasionRectAfterClick.rectTop <= 360 &&
      occasionRectAfterClick.rectBottom > 120;

    // Visit /bo-suu-tap
    await page.goto(`${BASE_URL}/bo-suu-tap`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await waitForPageReady(page);
    const snapCatalog = await readNavSnapshot(page);
    const catalogItem = snapCatalog.items[0];
    const catalogTipDiff = Math.abs(snapCatalog.barEndX - catalogItem.linkCenterX);
    const catalogOk =
      snapCatalog.isLight === true &&
      catalogItem.ariaCurrent === 'location' &&
      catalogItem.state === 'active' &&
      catalogItem.badgeText === '01/06' &&
      catalogTipDiff <= 36;

    // Visit /phoi-do
    await page.goto(`${BASE_URL}/phoi-do`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await waitForPageReady(page);
    const snapOutfit = await readNavSnapshot(page);
    const outfitItem = snapOutfit.items[2];
    const outfitTipDiff = Math.abs(snapOutfit.barEndX - outfitItem.linkCenterX);
    const outfitOk =
      snapOutfit.isLight === true &&
      outfitItem.ariaCurrent === 'location' &&
      outfitItem.state === 'active' &&
      outfitItem.badgeText === '03/06' &&
      outfitTipDiff <= 36;

    record('TEST 5', 'Click Navigation (THEO DỊP -> #occasion) & Subpages (/bo-suu-tap, /phoi-do)', clickOk && catalogOk && outfitOk, [
      `click THEO DỊP: state=${clickItem.state}, ariaCurrent=${clickItem.ariaCurrent}, badge=${clickItem.badgeText}, occasionRectTop=${occasionRectAfterClick?.rectTop?.toFixed(1)}px, ok=${clickOk}`,
      `/bo-suu-tap: isLight=${snapCatalog.isLight}, rack.state=${catalogItem.state}, ariaCurrent=${catalogItem.ariaCurrent}, badge=${catalogItem.badgeText}, |tipDiff|=${catalogTipDiff.toFixed(1)}px, ok=${catalogOk}`,
      `/phoi-do: isLight=${snapOutfit.isLight}, build.state=${outfitItem.state}, ariaCurrent=${outfitItem.ariaCurrent}, badge=${outfitItem.badgeText}, |tipDiff|=${outfitTipDiff.toFixed(1)}px, ok=${outfitOk}`,
    ]);

    // =========================================================================
    // CONSOLE / PAGE ERRORS AUDIT
    // =========================================================================
    const errorsOk = pageErrors.length === 0 && navConsoleErrors.length === 0;
    record('ERRORS', 'Zero uncaught pageErrors & zero SiteHeader/nav console errors', errorsOk, [
      `pageErrors=${pageErrors.length}`,
      `navConsoleErrors=${navConsoleErrors.length}`,
      `totalConsoleErrors(incl. loopback BFF CORS if any)=${consoleErrors.length}`,
      ...pageErrors.map((e) => `pageerror: ${e}`),
      ...navConsoleErrors.map((e) => `navConsoleError: ${e}`),
    ]);
  } finally {
    await browser.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log('\n============================================================');
  console.log(`SUMMARY: ${results.length - failed.length}/${results.length} PASS, ${failed.length} FAIL`);
  console.log('============================================================');
  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
