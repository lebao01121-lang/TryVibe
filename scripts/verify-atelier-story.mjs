#!/usr/bin/env node
/**
 * End-to-End Functional & Visual Chrome Verification for `#atelier`
 * ("Xưởng May Đo · Sợi Chỉ Vàng")
 *
 * Targets: BOTH http://127.0.0.1:3000 AND http://localhost:3000 (1440x900 Real Chrome)
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
  process.env.ATELIER_AUDIT_DIR ||
  'C:\\Users\\Admin\\.gemini\\antigravity\\brain\\d1783908-6521-4608-8b37-41aae3ee9a65\\scratch\\atelier-audit';

const TARGET_ORIGINS = ['http://127.0.0.1:3000', 'http://localhost:3000'];

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
      : [
          '/usr/bin/google-chrome',
          '/usr/bin/chromium',
          '/usr/bin/chromium-browser',
        ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function httpGetStatus(url) {
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

async function waitForScrollSettled(page, maxWaitMs = 2800) {
  const start = Date.now();
  let lastY = await page.evaluate(() => window.scrollY);
  let stableCount = 0;

  while (Date.now() - start < maxWaitMs) {
    await page.waitForTimeout(160);
    const currY = await page.evaluate(() => window.scrollY);
    if (Math.abs(currY - lastY) < 1.5) {
      stableCount += 1;
      if (stableCount >= 4) break;
    } else {
      stableCount = 0;
    }
    lastY = currY;
  }
  // Allow rAF smoothing of thread & pearl to finish converging
  await page.waitForTimeout(450);
}

async function measureAtelierState(page) {
  return page.evaluate(() => {
    const section = document.getElementById('atelier');
    const body = section?.querySelector('.atelier__body') ?? null;
    const svg = document.getElementById('thread');
    const track = document.getElementById('threadTrack');
    const path = document.getElementById('threadPath');
    const glow = document.getElementById('threadGlow');
    const pearl = document.getElementById('pearl');
    const header = document.querySelector('header.nav');
    const navAtelier = document.querySelector(
      '[data-testid="nav-journey-item-atelier"]',
    );
    const pagination = document.querySelector(
      '[data-testid="atelier-pagination"]',
    );
    const counter = document.querySelector(
      '[data-testid="atelier-step-counter"]',
    );
    const progressFill = document.querySelector(
      '[data-testid="atelier-pagination-progress"]',
    );

    const viewBox = svg?.getAttribute('viewBox') ?? null;
    const dAttr = path?.getAttribute('d') ?? '';
    const trackD = track?.getAttribute('d') ?? '';
    const totalLength =
      path && typeof path.getTotalLength === 'function'
        ? Number(path.getTotalLength().toFixed(2))
        : 0;

    const pathStyle = path ? getComputedStyle(path) : null;
    const trackStyle = track ? getComputedStyle(track) : null;
    const glowStyle = glow ? getComputedStyle(glow) : null;

    const dashOffsetRaw = path?.style.strokeDashoffset || pathStyle?.strokeDashoffset || '';
    const dashOffset = Number.parseFloat(dashOffsetRaw);
    const dataProgress = Number.parseFloat(svg?.dataset.threadProgress || 'NaN');
    const impliedProgress =
      totalLength > 0 && Number.isFinite(dashOffset)
        ? Number((1 - dashOffset / totalLength).toFixed(4))
        : 0;

    const pearlRect = pearl?.getBoundingClientRect() ?? null;
    const pearlDataY = Number.parseFloat(pearl?.dataset.pearlY || 'NaN');
    const pearlDocY = pearlRect
      ? Number((pearlRect.top + window.scrollY).toFixed(2))
      : null;

    const waypoints = Array.from(
      document.querySelectorAll('[data-testid="thread-waypoints"] [data-thread-waypoint]'),
    ).map((wp) => {
      const dot = wp.querySelector('.thread__waypoint-dot');
      const halo = wp.querySelector('.thread__waypoint-halo');
      const dotStyle = dot ? getComputedStyle(dot) : null;
      const haloStyle = halo ? getComputedStyle(halo) : null;
      const rect = wp.getBoundingClientRect();
      return {
        index: Number(wp.getAttribute('data-thread-waypoint')),
        state: wp.getAttribute('data-waypoint-state'),
        dotOpacity: dotStyle ? Number.parseFloat(dotStyle.opacity) : 0,
        haloOpacity: haloStyle ? Number.parseFloat(haloStyle.opacity) : 0,
        width: Number(rect.width.toFixed(1)),
        height: Number(rect.height.toFixed(1)),
      };
    });

    const medallions = Array.from(
      document.querySelectorAll('[data-waypoint-button]'),
    ).map((btn) => {
      const r = btn.getBoundingClientRect();
      return {
        index: Number(btn.getAttribute('data-waypoint-button')),
        state: btn.getAttribute('data-waypoint-state'),
        ariaCurrent: btn.getAttribute('aria-current'),
        width: Number(r.width.toFixed(1)),
        height: Number(r.height.toFixed(1)),
      };
    });

    const steps = Array.from(document.querySelectorAll('#atelier .step')).map(
      (el, i) => {
        const img = el.querySelector('img');
        const r = el.getBoundingClientRect();
        return {
          idx: i,
          id: el.id,
          state: el.getAttribute('data-step-state'),
          ariaCurrent: el.getAttribute('aria-current'),
          rectTop: Number(r.top.toFixed(1)),
          rectBottom: Number(r.bottom.toFixed(1)),
          rectCenterY: Number((r.top + r.height / 2).toFixed(1)),
          imgComplete: Boolean(img?.complete),
          imgNaturalWidth: img?.naturalWidth ?? 0,
          imgNaturalHeight: img?.naturalHeight ?? 0,
          imgSrc: img?.getAttribute('src') ?? '',
        };
      },
    );

    const tabs = Array.from(
      document.querySelectorAll('[data-testid^="atelier-page-btn-"]'),
    ).map((btn) => ({
      testId: btn.getAttribute('data-testid'),
      state: btn.getAttribute('data-step-state'),
      ariaCurrent: btn.getAttribute('aria-current'),
    }));

    const prevBtn = document.querySelector('[data-testid="atelier-page-prev"]');
    const nextBtn = document.querySelector('[data-testid="atelier-page-next"]');

    const headerRect = header?.getBoundingClientRect() ?? null;
    const paginationRect = pagination?.getBoundingClientRect() ?? null;
    const sectionRect = section?.getBoundingClientRect() ?? null;
    const bodyRect = body?.getBoundingClientRect() ?? null;

    return {
      scrollY: Number(window.scrollY.toFixed(1)),
      viewportHeight: window.innerHeight,
      sectionFound: Boolean(section),
      sectionRect: sectionRect
        ? {
            top: Number(sectionRect.top.toFixed(1)),
            bottom: Number(sectionRect.bottom.toFixed(1)),
            height: Number(sectionRect.height.toFixed(1)),
          }
        : null,
      bodyRect: bodyRect
        ? {
            top: Number(bodyRect.top.toFixed(1)),
            bottom: Number(bodyRect.bottom.toFixed(1)),
            width: Number(bodyRect.width.toFixed(1)),
            height: Number(bodyRect.height.toFixed(1)),
          }
        : null,
      svg: {
        viewBox,
        dLength: dAttr.length,
        trackDLength: trackD.length,
        totalLength,
        dashOffset: Number.isFinite(dashOffset) ? Number(dashOffset.toFixed(2)) : null,
        dataProgress: Number.isFinite(dataProgress) ? dataProgress : null,
        impliedProgress,
        pathOpacity: pathStyle ? Number.parseFloat(pathStyle.opacity) : 0,
        trackOpacity: trackStyle ? Number.parseFloat(trackStyle.opacity) : 0,
        glowOpacity: glowStyle ? Number.parseFloat(glowStyle.opacity) : 0,
      },
      pearl: {
        found: Boolean(pearl),
        dataY: Number.isFinite(pearlDataY) ? pearlDataY : null,
        docY: pearlDocY,
        viewportTop: pearlRect ? Number(pearlRect.top.toFixed(1)) : null,
        viewportLeft: pearlRect ? Number(pearlRect.left.toFixed(1)) : null,
        width: pearlRect ? Number(pearlRect.width.toFixed(1)) : 0,
        height: pearlRect ? Number(pearlRect.height.toFixed(1)) : 0,
      },
      waypoints,
      medallions,
      steps,
      tabs,
      prevDisabled: Boolean(prevBtn?.hasAttribute('disabled')),
      nextDisabled: Boolean(nextBtn?.hasAttribute('disabled')),
      counterText: (counter?.textContent || '').replace(/\s+/g, ' ').trim(),
      progressTransform: progressFill?.style.transform || '',
      header: {
        isLight: Boolean(header?.classList.contains('is-light')),
        bottom: headerRect ? Number(headerRect.bottom.toFixed(1)) : null,
        atelierNavState: navAtelier?.getAttribute('data-nav-state') ?? null,
        atelierAriaCurrent: navAtelier?.getAttribute('aria-current') ?? null,
      },
      pagination: {
        found: Boolean(pagination),
        top: paginationRect ? Number(paginationRect.top.toFixed(1)) : null,
        bottom: paginationRect ? Number(paginationRect.bottom.toFixed(1)) : null,
        height: paginationRect ? Number(paginationRect.height.toFixed(1)) : null,
        clearanceBelowHeader:
          headerRect && paginationRect
            ? Number((paginationRect.top - headerRect.bottom).toFixed(1))
            : null,
      },
    };
  });
}

async function attachErrorListeners(page) {
  const errors = {
    consoleErrors: [],
    pageErrors: [],
    failedResponses: [],
    failedRequests: [],
  };

  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      errors.consoleErrors.push(msg.text());
    }
  });
  page.on('pageerror', (err) => {
    errors.pageErrors.push(err.message || String(err));
  });
  page.on('response', (res) => {
    if (res.status() >= 400) {
      errors.failedResponses.push({
        status: res.status(),
        method: res.request().method(),
        url: res.url(),
        resourceType: res.request().resourceType(),
      });
    }
  });
  page.on('requestfailed', (req) => {
    const errText = req.failure()?.errorText || 'FAILED';
    if (!errText.includes('ERR_ABORTED')) {
      errors.failedRequests.push({
        url: req.url(),
        resourceType: req.resourceType(),
        errorText: errText,
      });
    }
  });

  return errors;
}

async function runOriginSuite(browser, origin, captureScreenshots) {
  const screenshots = {};

  // =========================================================================
  // TEST 1: Full-page scroll from top down through #rack -> #occasion -> #build -> #seasons -> #atelier
  // =========================================================================
  const ctx1 = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
  });
  const page1 = await ctx1.newPage();
  const errors1 = await attachErrorListeners(page1);

  let test1Metrics = null;
  try {
    await page1.goto(`${origin}/`, {
      waitUntil: 'domcontentloaded',
      timeout: 35_000,
    });
    await page1.waitForSelector('#atelier', { timeout: 25_000 });
    await page1.waitForSelector('#threadPath', { timeout: 25_000 });
    await page1.evaluate(async () => {
      if (document.fonts?.ready) await document.fonts.ready;
    });
    await page1.waitForTimeout(900);

    // Progressive scroll down through upstream sections (#rack, #occasion, #build, #seasons) into #atelier
    const upstreamIds = ['rack', 'occasion', 'build', 'seasons'];
    const visitedUpstream = [];
    for (const secId of upstreamIds) {
      const targetY = await page1.evaluate((id) => {
        const el = document.getElementById(id);
        if (!el) return null;
        const container = el.closest('.pin-spacer') || el;
        const r = container.getBoundingClientRect();
        return Math.max(0, Math.round(r.top + window.scrollY + 80));
      }, secId);
      if (targetY !== null) {
        await page1.evaluate((y) => {
          window.scrollTo({ top: y, behavior: 'instant' });
          window.dispatchEvent(new Event('scroll'));
        }, targetY);
        await page1.waitForTimeout(320);
        visitedUpstream.push({ id: secId, y: targetY });
      }
    }

    // Now scroll into #atelier and position cleanly at each Step (1..4)
    const stepCount = await page1.locator('#atelier .step').count();
    const stepSamples = [];

    for (let idx = 0; idx < stepCount; idx += 1) {
      // Position step so its center sits right around viewport probe (~48%)
      // while ensuring the sticky pagination bar is cleanly below SiteHeader.
      await page1.evaluate((stepIdx) => {
        const stepEl = document.getElementById(`atelier-step-${stepIdx + 1}`);
        if (!stepEl) return;
        const rect = stepEl.getBoundingClientRect();
        const docTop = rect.top + window.scrollY;
        const offsetFromTop = stepIdx === 0 ? 225 : 210;
        const target = Math.max(0, Math.round(docTop - offsetFromTop));
        window.scrollTo({ top: target, behavior: 'instant' });
        window.dispatchEvent(new Event('scroll'));
      }, idx);

      // Force eager decoding check for lazy images once scrolled into view
      await page1.waitForFunction(
        (stepIdx) => {
          const stepEl = document.getElementById(`atelier-step-${stepIdx + 1}`);
          const img = stepEl?.querySelector('img');
          return Boolean(img && img.complete && img.naturalWidth > 0);
        },
        idx,
        { timeout: 15_000 },
      );

      // Wait for rAF thread & pearl smoothing + CSS state transition to settle
      await waitForScrollSettled(page1, 2000);
      // Small additional pause for .step__time roll-up & active transitions
      await page1.waitForTimeout(450);

      const sample = await measureAtelierState(page1);
      stepSamples.push({ stepNum: idx + 1, ...sample });

      if (captureScreenshots) {
        if (idx === 0) {
          const p = path.join(AUDIT_DIR, 'atelier-step1.png');
          await page1.screenshot({ path: p });
          screenshots.step1 = p;
        } else if (idx === 1) {
          const p = path.join(AUDIT_DIR, 'atelier-step2-mid.png');
          await page1.screenshot({ path: p });
          screenshots.step2Mid = p;
        } else if (idx === stepCount - 1) {
          const p = path.join(AUDIT_DIR, 'atelier-step-last.png');
          await page1.screenshot({ path: p });
          screenshots.stepLast = p;
        }
      }
    }

    // Re-verify all step images loaded after walking the full section
    const finalState = stepSamples[stepSamples.length - 1];
    test1Metrics = {
      visitedUpstream,
      stepCount,
      stepSamples,
      finalState,
    };
  } finally {
    await ctx1.close();
  }

  // =========================================================================
  // TEST 2 & TEST 3: Direct Header Jump from scrollY=0 -> Interactive Pagination
  // =========================================================================
  const ctx2 = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
  });
  const page2 = await ctx2.newPage();
  const errors2 = await attachErrorListeners(page2);

  let test2Metrics = null;
  let test3Metrics = null;
  try {
    await page2.goto(`${origin}/`, {
      waitUntil: 'domcontentloaded',
      timeout: 35_000,
    });
    await page2.waitForSelector('[data-testid="nav-journey-item-atelier"]', {
      timeout: 25_000,
    });
    await page2.evaluate(async () => {
      if (document.fonts?.ready) await document.fonts.ready;
    });
    await page2.waitForTimeout(1000);

    const initialScrollY = await page2.evaluate(() => window.scrollY);

    // TEST 2: Click <SiteHeader /> XƯỞNG MAY (#atelier) from top
    await page2.click('[data-testid="nav-journey-item-atelier"]');
    await waitForScrollSettled(page2, 3200);
    await page2.waitForTimeout(450);

    // Ensure Step 1 image is loaded after jump
    await page2.waitForFunction(
      () => {
        const img = document.querySelector('#atelier-step-1 img');
        return Boolean(img && img.complete && img.naturalWidth > 0);
      },
      { timeout: 15_000 },
    );

    const afterHeaderJump = await measureAtelierState(page2);
    test2Metrics = {
      initialScrollY,
      afterHeaderJump,
    };

    // TEST 3: Interactive Craft Step Pagination (Step 2 -> Step 3 -> Next to Step 4 -> Prev back to Step 3)
    const paginationClicks = [];

    // Click Step 2 tab
    await page2.click('[data-testid="atelier-page-btn-2"]');
    await waitForScrollSettled(page2, 2600);
    await page2.waitForTimeout(350);
    const afterStep2 = await measureAtelierState(page2);
    paginationClicks.push({ action: 'click-tab-2', targetStep: 2, state: afterStep2 });

    // Click Step 3 tab
    await page2.click('[data-testid="atelier-page-btn-3"]');
    await waitForScrollSettled(page2, 2600);
    await page2.waitForTimeout(400);
    await page2.waitForFunction(
      () => {
        const img = document.querySelector('#atelier-step-3 img');
        return Boolean(img && img.complete && img.naturalWidth > 0);
      },
      { timeout: 15_000 },
    );
    const afterStep3 = await measureAtelierState(page2);
    paginationClicks.push({ action: 'click-tab-3', targetStep: 3, state: afterStep3 });

    if (captureScreenshots) {
      const p = path.join(AUDIT_DIR, 'atelier-pagination-click.png');
      await page2.screenshot({ path: p });
      screenshots.paginationClick = p;
    }

    // Click Next button -> Step 4
    await page2.click('[data-testid="atelier-page-next"]');
    await waitForScrollSettled(page2, 2600);
    await page2.waitForTimeout(350);
    const afterNextStep4 = await measureAtelierState(page2);
    paginationClicks.push({ action: 'click-next-to-4', targetStep: 4, state: afterNextStep4 });

    // Click Prev button -> back to Step 3
    await page2.click('[data-testid="atelier-page-prev"]');
    await waitForScrollSettled(page2, 2600);
    await page2.waitForTimeout(350);
    const afterPrevStep3 = await measureAtelierState(page2);
    paginationClicks.push({ action: 'click-prev-to-3', targetStep: 3, state: afterPrevStep3 });

    test3Metrics = {
      paginationClicks,
    };
  } finally {
    await ctx2.close();
  }

  const combinedErrors = {
    consoleErrors: [...errors1.consoleErrors, ...errors2.consoleErrors],
    pageErrors: [...errors1.pageErrors, ...errors2.pageErrors],
    failedResponses: [...errors1.failedResponses, ...errors2.failedResponses],
    failedRequests: [...errors1.failedRequests, ...errors2.failedRequests],
  };

  return {
    origin,
    test1Metrics,
    test2Metrics,
    test3Metrics,
    combinedErrors,
    screenshots,
  };
}

async function main() {
  console.log('=== `#atelier` ("Xưởng May Đo · Sợi Chỉ Vàng") End-to-End Chrome Verification ===');
  console.log(`Audit Dir: ${AUDIT_DIR}`);

  // 0. Health check across live ports
  const [st3000Ip, st3000Host, st4000, st4002, st11434] = await Promise.all([
    httpGetStatus('http://127.0.0.1:3000/'),
    httpGetStatus('http://localhost:3000/'),
    httpGetStatus('http://127.0.0.1:4000/health'),
    httpGetStatus('http://127.0.0.1:4002/health'),
    httpGetStatus('http://127.0.0.1:11434/api/tags'),
  ]);

  const healthOk =
    st3000Ip === 200 &&
    st3000Host === 200 &&
    st4000 === 200 &&
    st4002 === 200 &&
    st11434 === 200;

  record('HEALTH', 'Live services (:3000 IP/localhost, :4000, :4002, :11434)', healthOk, [
    `http://127.0.0.1:3000/ -> ${st3000Ip}`,
    `http://localhost:3000/ -> ${st3000Host}`,
    `http://127.0.0.1:4000/health -> ${st4000}`,
    `http://127.0.0.1:4002/health -> ${st4002}`,
    `http://127.0.0.1:11434/api/tags -> ${st11434}`,
  ]);

  const chromePath = findChromeExecutable();
  if (!chromePath) {
    throw new Error('Could not find Chrome/Edge executable.');
  }

  const browser = await chromium.launch({
    executablePath: chromePath,
    headless: true,
    args: ['--no-sandbox', '--disable-gpu-sandbox', '--window-size=1440,900'],
  });

  const capturedScreenshots = {};

  try {
    for (let i = 0; i < TARGET_ORIGINS.length; i += 1) {
      const origin = TARGET_ORIGINS[i];
      const tag = i === 0 ? '127.0.0.1' : 'localhost';
      const report = await runOriginSuite(browser, origin, i === 0);
      Object.assign(capturedScreenshots, report.screenshots);

      // ---- Validate Test 1 ----
      const samples = report.test1Metrics.stepSamples;
      const first = samples[0];
      const last = samples[samples.length - 1];

      const viewBoxValid = Boolean(
        first?.svg?.viewBox && /^0\s+0\s+\d+\s+\d+$/.test(first.svg.viewBox),
      );
      const pathValid =
        (first?.svg?.dLength ?? 0) > 20 &&
        (first?.svg?.trackDLength ?? 0) > 20 &&
        (first?.svg?.totalLength ?? 0) > 500;

      let dashStrictlyDecreases = samples.length >= 4;
      let pearlStrictlyAdvances = samples.length >= 4;
      for (let k = 1; k < samples.length; k += 1) {
        const prev = samples[k - 1];
        const curr = samples[k];
        if (
          prev.svg.dashOffset === null ||
          curr.svg.dashOffset === null ||
          !(curr.svg.dashOffset < prev.svg.dashOffset - 50)
        ) {
          dashStrictlyDecreases = false;
        }
        if (
          prev.pearl.dataY === null ||
          curr.pearl.dataY === null ||
          prev.pearl.docY === null ||
          curr.pearl.docY === null ||
          !(curr.pearl.dataY > prev.pearl.dataY + 100) ||
          !(curr.pearl.docY > prev.pearl.docY + 100)
        ) {
          pearlStrictlyAdvances = false;
        }
      }

      const notStuckAtZero =
        (first?.svg?.impliedProgress ?? 0) > 0.05 &&
        (last?.svg?.impliedProgress ?? 0) >= 0.72;

      const elementsVisible =
        (first?.svg?.trackOpacity ?? 0) > 0 &&
        (first?.svg?.pathOpacity ?? 0) > 0 &&
        (first?.svg?.glowOpacity ?? 0) > 0 &&
        (first?.waypoints?.length ?? 0) === samples.length &&
        first.waypoints.every((wp) => wp.dotOpacity > 0 && wp.haloOpacity > 0) &&
        (first?.medallions?.length ?? 0) === samples.length;

      const allImagesLoaded =
        (last?.steps?.length ?? 0) === samples.length &&
        last.steps.every((s) => s.imgComplete && s.imgNaturalWidth > 0);

      const headerDarkAndActive = samples.every(
        (s) =>
          s.header.isLight === false &&
          s.header.atelierNavState === 'active',
      );

      const test1Ok =
        viewBoxValid &&
        pathValid &&
        dashStrictlyDecreases &&
        pearlStrictlyAdvances &&
        notStuckAtZero &&
        elementsVisible &&
        allImagesLoaded &&
        headerDarkAndActive;

      record(
        `TEST1-${tag}`,
        `Full-page scroll through #rack/#occasion/#build/#seasons into #atelier (${origin})`,
        test1Ok,
        [
          `upstream visited=${report.test1Metrics.visitedUpstream.map((u) => `${u.id}@${u.y}`).join(' -> ')}`,
          `svg viewBox="${first?.svg?.viewBox}", totalLength=${first?.svg?.totalLength}px, trackOp=${first?.svg?.trackOpacity}, pathOp=${first?.svg?.pathOpacity}, glowOp=${first?.svg?.glowOpacity}`,
          `dashOffset: ${samples.map((s) => `S${s.stepNum}=${s.svg.dashOffset}`).join(' -> ')} (strictlyDecreases=${dashStrictlyDecreases})`,
          `progress: ${samples.map((s) => `S${s.stepNum}=${(s.svg.impliedProgress * 100).toFixed(1)}%`).join(' -> ')}`,
          `pearl dataY: ${samples.map((s) => `S${s.stepNum}=${s.pearl.dataY}px`).join(' -> ')} (strictlyAdvances=${pearlStrictlyAdvances})`,
          `pearl docY: ${samples.map((s) => `S${s.stepNum}=${s.pearl.docY}px`).join(' -> ')}`,
          `waypoints=${first?.waypoints?.length}, medallions=${first?.medallions?.length}, allImagesLoaded=${allImagesLoaded} (${last?.steps?.map((s) => `${s.imgNaturalWidth}x${s.imgNaturalHeight}`).join(', ')})`,
          `SiteHeader dark (!is-light) & XƯỞNG MAY active across all steps=${headerDarkAndActive}`,
        ],
      );

      // ---- Validate Test 2 ----
      const j = report.test2Metrics.afterHeaderJump;
      const inView =
        j.sectionRect !== null &&
        j.sectionRect.top <= 120 &&
        j.sectionRect.bottom > 450;
      const threadDrawnOnJump =
        j.svg.totalLength > 500 &&
        j.svg.dashOffset !== null &&
        j.svg.dashOffset < j.svg.totalLength - 40 &&
        j.svg.impliedProgress > 0.03;
      const step1ActiveOnJump =
        j.steps[0]?.state === 'active' &&
        j.tabs[0]?.ariaCurrent === 'step' &&
        j.counterText.includes('01');
      const headerOkOnJump =
        j.header.isLight === false && j.header.atelierNavState === 'active';

      const test2Ok =
        report.test2Metrics.initialScrollY === 0 &&
        inView &&
        threadDrawnOnJump &&
        step1ActiveOnJump &&
        headerOkOnJump;

      record(
        `TEST2-${tag}`,
        `Direct <SiteHeader /> XƯỞNG MAY jump from scrollY=0 (${origin})`,
        test2Ok,
        [
          `scrollY: ${report.test2Metrics.initialScrollY} -> ${j.scrollY}, #atelier rectTop=${j.sectionRect?.top}, rectBottom=${j.sectionRect?.bottom}`,
          `thread drawn immediately: dashOffset=${j.svg.dashOffset}/${j.svg.totalLength} (${(j.svg.impliedProgress * 100).toFixed(1)}%), pearlY=${j.pearl.dataY}px`,
          `step1 state="${j.steps[0]?.state}", tab1 aria-current="${j.tabs[0]?.ariaCurrent}", counter="${j.counterText}"`,
          `SiteHeader isLight=${j.header.isLight}, atelierNavState="${j.header.atelierNavState}"`,
        ],
      );

      // ---- Validate Test 3 ----
      const clicks = report.test3Metrics.paginationClicks;
      const c2 = clicks[0].state;
      const c3 = clicks[1].state;
      const c4 = clicks[2].state;
      const c3Back = clicks[3].state;

      const tabsAccurate =
        c2.tabs[1]?.ariaCurrent === 'step' &&
        c2.steps[1]?.state === 'active' &&
        c2.counterText.includes('02') &&
        c3.tabs[2]?.ariaCurrent === 'step' &&
        c3.steps[2]?.state === 'active' &&
        c3.counterText.includes('03') &&
        c4.tabs[3]?.ariaCurrent === 'step' &&
        c4.steps[3]?.state === 'active' &&
        c4.counterText.includes('04') &&
        c4.nextDisabled === true &&
        c3Back.tabs[2]?.ariaCurrent === 'step' &&
        c3Back.steps[2]?.state === 'active' &&
        c3Back.counterText.includes('03');

      const scrollMovedCorrectly =
        c2.scrollY > j.scrollY + 150 &&
        c3.scrollY > c2.scrollY + 250 &&
        c4.scrollY > c3.scrollY + 250 &&
        c3Back.scrollY < c4.scrollY - 250;

      const threadAdvancedOnClicks =
        c2.svg.dashOffset < j.svg.dashOffset - 50 &&
        c3.svg.dashOffset < c2.svg.dashOffset - 50 &&
        c4.svg.dashOffset < c3.svg.dashOffset - 50 &&
        c3Back.svg.dashOffset > c4.svg.dashOffset + 50 &&
        c2.pearl.dataY > j.pearl.dataY + 80 &&
        c3.pearl.dataY > c2.pearl.dataY + 80 &&
        c4.pearl.dataY > c3.pearl.dataY + 80 &&
        c3Back.pearl.dataY < c4.pearl.dataY - 80;

      const allClearances = [c2, c3, c4, c3Back].map(
        (st) => st.pagination.clearanceBelowHeader,
      );
      const noHeaderOverlap = allClearances.every(
        (gap) => gap !== null && gap >= 0,
      );

      const test3Ok =
        tabsAccurate &&
        scrollMovedCorrectly &&
        threadAdvancedOnClicks &&
        noHeaderOverlap;

      record(
        `TEST3-${tag}`,
        `Interactive Craft Step Pagination & Sticky Clearance (${origin})`,
        test3Ok,
        [
          `scrollY sequence: jump=${j.scrollY} -> S2=${c2.scrollY} -> S3=${c3.scrollY} -> Next(S4)=${c4.scrollY} -> Prev(S3)=${c3Back.scrollY}`,
          `counters: S2="${c2.counterText}", S3="${c3.counterText}", S4="${c4.counterText}" (nextDisabled=${c4.nextDisabled}), Prev="${c3Back.counterText}"`,
          `dashOffset: jump=${j.svg.dashOffset} -> S2=${c2.svg.dashOffset} -> S3=${c3.svg.dashOffset} -> S4=${c4.svg.dashOffset} -> Prev=${c3Back.svg.dashOffset}`,
          `pearlY: jump=${j.pearl.dataY} -> S2=${c2.pearl.dataY} -> S3=${c3.pearl.dataY} -> S4=${c4.pearl.dataY} -> Prev=${c3Back.pearl.dataY}`,
          `sticky bar clearance below SiteHeader (header.bottom -> pagination.top): [${allClearances.map((g) => `${g}px`).join(', ')}] (noOverlap=${noHeaderOverlap})`,
        ],
      );

      // ---- Validate Test 4 ----
      const errs = report.combinedErrors;
      const test4Ok =
        errs.consoleErrors.length === 0 &&
        errs.pageErrors.length === 0 &&
        errs.failedResponses.length === 0 &&
        errs.failedRequests.length === 0;

      record(
        `TEST4-${tag}`,
        `Zero console errors, pageerrors, and >=400 network failures (${origin})`,
        test4Ok,
        [
          `consoleErrors=${errs.consoleErrors.length}`,
          `pageErrors=${errs.pageErrors.length}`,
          `failedResponses=${errs.failedResponses.length}`,
          `failedRequests=${errs.failedRequests.length}`,
          ...errs.consoleErrors.slice(0, 5).map((e) => `console.error: ${e}`),
          ...errs.pageErrors.slice(0, 5).map((e) => `pageerror: ${e}`),
          ...errs.failedResponses
            .slice(0, 5)
            .map((r) => `HTTP ${r.status} ${r.method} ${r.url}`),
          ...errs.failedRequests
            .slice(0, 5)
            .map((r) => `REQFAIL ${r.errorText} ${r.url}`),
        ],
      );
    }
  } finally {
    await browser.close();
  }

  console.log('\n=== Captured Screenshots ===');
  for (const [k, v] of Object.entries(capturedScreenshots)) {
    console.log(`  ${k}: ${v}`);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(
    `\n=== SUMMARY: PASS=${results.length - failed.length}/${results.length} | FAIL=${failed.length} ===`,
  );
  if (failed.length > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('[FATAL] verify-atelier-story:', err);
  process.exit(1);
});
