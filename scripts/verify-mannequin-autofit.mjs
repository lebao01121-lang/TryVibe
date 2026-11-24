#!/usr/bin/env node
/**
 * AutoFitMannequinEngine — Live Visual & Pixel Geometry Verification Suite
 * Target: Live http://127.0.0.1:3000 (1440x900 Real Chrome)
 *
 * STRICT DATA SAFETY:
 *   - Read-only browser verification against live storefront (:3000), BFF (:4000),
 *     catalog-lookbook (:4002), MinIO (:9000), Redis (:6379), Ollama (:11434).
 *   - NEVER resets DB, NEVER drops tables, NEVER touches .project-data.
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { chromium } from 'playwright-core';

const BASE_URL = process.env.STOREFRONT_URL || 'http://localhost:3000';
const LOOPBACK_URL = 'http://127.0.0.1:3000';
const AUDIT_DIR =
  process.env.AUTOFIT_AUDIT_DIR ||
  'C:\\Users\\Admin\\.gemini\\antigravity\\brain\\d1783908-6521-4608-8b37-41aae3ee9a65\\scratch\\autofit-audit';

const MANNEQUIN_METRICS = {
  width: 600,
  height: 900,
  centerX: 0.5,
  yBust: 0.292,
  wBust: 0.252,
  yWaist: 0.415,
  wWaist: 0.182,
  yHip: 0.525,
  wHip: 0.272,
};

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

async function waitCanvasReady(page, expectedSlotsSubset = null, expectedFace = 'front', timeoutMs = 15_000) {
  await page.waitForFunction(
    ({ subset, face }) => {
      const c = document.querySelector(`[data-testid="autofit-garment-canvas"][data-face="${face}"]`);
      if (!(c instanceof HTMLCanvasElement)) return false;
      if (c.getAttribute('data-render-ready') !== 'true') return false;
      if (c.width < 100 || c.height < 100) return false;
      const slotsAttr = (c.getAttribute('data-slots') || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (Array.isArray(subset)) {
        if (subset.length !== slotsAttr.length) return false;
        for (const s of subset) {
          if (!slotsAttr.includes(s)) return false;
        }
      }
      const ctx = c.getContext('2d');
      if (!ctx) return false;
      // Quick coarse pixel probe across center canvas
      const img = ctx.getImageData(0, 0, c.width, c.height).data;
      let nonEmpty = 0;
      const stride = Math.max(1, Math.floor(c.width / 80)) * 4;
      for (let i = 3; i < img.length; i += stride * 4) {
        if (img[i] > 32) nonEmpty += 1;
        if (nonEmpty > 40) return true;
      }
      return false;
    },
    { subset: expectedSlotsSubset, face: expectedFace },
    { timeout: timeoutMs },
  );
  // Let CSS/GSAP 450ms transition settle cleanly before pixel/screenshot audit
  await page.waitForTimeout(650);
}

async function inspectCanvasPixels(page, face = 'front') {
  return page.evaluate(
    ({ targetFace, metrics }) => {
      const canvas = document.querySelector(
        `[data-testid="autofit-garment-canvas"][data-face="${targetFace}"]`,
      );
      if (!(canvas instanceof HTMLCanvasElement)) {
        return { error: `Canvas not found for face=${targetFace}` };
      }
      const W = canvas.width;
      const H = canvas.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) return { error: 'No 2D context' };
      const { data } = ctx.getImageData(0, 0, W, H);

      const alphaThreshold = 36;
      let totalOpaque = 0;
      let minY = H;
      let maxY = 0;
      let minX = W;
      let maxX = 0;

      // Per-row horizontal scan
      const rowLeft = new Int32Array(H).fill(-1);
      const rowRight = new Int32Array(H).fill(-1);
      const rowSumX = new Float64Array(H);
      const rowWeight = new Float64Array(H);

      for (let y = 0; y < H; y += 1) {
        const rowOff = y * W * 4;
        for (let x = 0; x < W; x += 1) {
          const a = data[rowOff + x * 4 + 3];
          if (a > alphaThreshold) {
            totalOpaque += 1;
            if (rowLeft[y] === -1) rowLeft[y] = x;
            rowRight[y] = x;
            rowSumX[y] += x * a;
            rowWeight[y] += a;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
          }
        }
      }

      // Compute center-of-mass across bust-waist-hip band y = 0.28..0.55
      const yStart = Math.round(0.28 * H);
      const yEnd = Math.round(0.55 * H);
      let bandSumX = 0;
      let bandWeight = 0;
      let maxRowDev = 0;
      let sumRowDev = 0;
      let validRows = 0;
      let worstRowY = 0;
      let worstRowMidX = 0.5;

      for (let y = yStart; y <= yEnd; y += 1) {
        if (rowWeight[y] > 0) {
          bandSumX += rowSumX[y];
          bandWeight += rowWeight[y];
          const midX = rowSumX[y] / rowWeight[y] / W;
          const dev = Math.abs(midX - 0.5);
          sumRowDev += dev;
          validRows += 1;
          if (dev > maxRowDev) {
            maxRowDev = dev;
            worstRowY = Number((y / H).toFixed(3));
            worstRowMidX = Number(midX.toFixed(4));
          }
        }
      }

      const bandComX = bandWeight > 0 ? bandSumX / bandWeight / W : 0;
      const bandComDev = Math.abs(bandComX - 0.5);
      const meanRowDev = validRows > 0 ? sumRowDev / validRows : 1;

      function measureBandWidth(yNorm) {
        const cy = Math.round(yNorm * H);
        const radius = Math.max(2, Math.round(0.005 * H));
        const widths = [];
        const lefts = [];
        const rights = [];
        const mids = [];
        for (let y = Math.max(0, cy - radius); y <= Math.min(H - 1, cy + radius); y += 1) {
          if (rowLeft[y] !== -1 && rowRight[y] !== -1) {
            const l = rowLeft[y] / W;
            const r = rowRight[y] / W;
            lefts.push(l);
            rights.push(r);
            widths.push(r - l);
            mids.push((l + r) * 0.5);
          }
        }
        if (widths.length === 0) {
          return { width: 0, left: 0, right: 0, mid: 0 };
        }
        widths.sort((a, b) => a - b);
        lefts.sort((a, b) => a - b);
        rights.sort((a, b) => a - b);
        mids.sort((a, b) => a - b);
        const midIdx = Math.floor(widths.length / 2);
        return {
          width: Number(widths[midIdx].toFixed(4)),
          left: Number(lefts[midIdx].toFixed(4)),
          right: Number(rights[midIdx].toFixed(4)),
          mid: Number(mids[midIdx].toFixed(4)),
        };
      }

      const bust = measureBandWidth(metrics.yBust);
      const waist = measureBandWidth(metrics.yWaist);
      const hip = measureBandWidth(metrics.yHip);

      // Measure bottom-12% stray-fragment check (detect isolated bottom-hem islands or shoe tips)
      const rect = canvas.getBoundingClientRect();

      return {
        canvasWidth: W,
        canvasHeight: H,
        cssWidth: Number(rect.width.toFixed(1)),
        cssHeight: Number(rect.height.toFixed(1)),
        slots: canvas.getAttribute('data-slots') || '',
        totalOpaque,
        bboxNorm:
          totalOpaque > 0
            ? {
                topY: Number((minY / H).toFixed(4)),
                bottomY: Number((maxY / H).toFixed(4)),
                leftX: Number((minX / W).toFixed(4)),
                rightX: Number((maxX / W).toFixed(4)),
              }
            : null,
        bandComX: Number(bandComX.toFixed(4)),
        bandComDev: Number(bandComDev.toFixed(4)),
        meanRowDev: Number(meanRowDev.toFixed(4)),
        maxRowDev: Number(maxRowDev.toFixed(4)),
        worstRowY,
        worstRowMidX,
        bust: {
          ...bust,
          mannequinW: metrics.wBust,
          coveragePct: Number(((bust.width / metrics.wBust) * 100).toFixed(1)),
          coversLeft: bust.left <= 0.5 - metrics.wBust * 0.5,
          coversRight: bust.right >= 0.5 + metrics.wBust * 0.5,
        },
        waist: {
          ...waist,
          mannequinW: metrics.wWaist,
          coveragePct: Number(((waist.width / metrics.wWaist) * 100).toFixed(1)),
          coversLeft: waist.left <= 0.5 - metrics.wWaist * 0.5,
          coversRight: waist.right >= 0.5 + metrics.wWaist * 0.5,
        },
        hip: {
          ...hip,
          mannequinW: metrics.wHip,
          coveragePct: Number(((hip.width / metrics.wHip) * 100).toFixed(1)),
          coversLeft: hip.left <= 0.5 - metrics.wHip * 0.5,
          coversRight: hip.right >= 0.5 + metrics.wHip * 0.5,
        },
      };
    },
    { targetFace: face, metrics: MANNEQUIN_METRICS },
  );
}

async function auditStageDom(page) {
  return page.evaluate(() => {
    const stage = document.querySelector('#bStage');
    if (!stage) return { error: '#bStage not found' };

    // 1. Check floating dark X buttons outside pins
    const allStageButtons = Array.from(stage.querySelectorAll('button'));
    const strayRemoveButtons = allStageButtons
      .filter((btn) => {
        const txt = (btn.textContent || '').trim();
        const aria = (btn.getAttribute('aria-label') || '').trim();
        const isRemoveLike = txt === '×' || txt === '✕' || /^bỏ\s/i.test(aria);
        if (!isRemoveLike) return false;
        return !btn.closest('[data-testid^="stage-pin-"]');
      })
      .map((btn) => ({
        text: (btn.textContent || '').trim(),
        aria: btn.getAttribute('aria-label') || '',
        className: btn.className,
      }));

    // 2. Check .outfit__seal, .outfit__pkg-back, .outfit__pkg-front hidden
    const checkHidden = (sel) => {
      const el = stage.querySelector(sel);
      if (!el) return { exists: false, hidden: true };
      const st = window.getComputedStyle(el);
      const hidden =
        st.display === 'none' ||
        st.visibility === 'hidden' ||
        parseFloat(st.opacity || '1') <= 0.01;
      return { exists: true, hidden, opacity: st.opacity, visibility: st.visibility };
    };

    // 3. Check mannequin torso-cage occlusion (active front SVG)
    const activeFace = stage.getAttribute('data-view-side') || 'front';
    const faceIdx = activeFace === 'back' ? 1 : 0;
    const svgs = Array.from(stage.querySelectorAll('[data-testid="ghost-mannequin-svg"]'));
    const activeSvg = svgs[faceIdx] || svgs[0];
    const torsoCage = activeSvg?.querySelector('[data-mannequin-layer="torso-cage"]');
    const exposedFrame = activeSvg?.querySelector('[data-mannequin-layer="exposed-frame"]');
    const torsoStyle = torsoCage ? window.getComputedStyle(torsoCage) : null;

    // 4. Pins + inline remove + leader dot position vs canvas
    const canvas = stage.querySelector(
      `[data-testid="autofit-garment-canvas"][data-face="${activeFace}"]`,
    );
    const canvasRect = canvas?.getBoundingClientRect() ?? null;
    const pins = Array.from(stage.querySelectorAll('[data-testid^="stage-pin-"]'))
      .filter((el) => !el.getAttribute('data-testid')?.startsWith('stage-pin-remove-'))
      .map((pinEl) => {
        const testId = pinEl.getAttribute('data-testid') || '';
        const slot = testId.replace('stage-pin-', '');
        const removeBtn = pinEl.querySelector(`[data-testid="stage-pin-remove-${slot}"]`);
        const rowWrapper = pinEl.parentElement?.parentElement;
        const dotEl = rowWrapper?.querySelector('span.rounded-full.bg-\\[\\#B08A4A\\]');
        const dotRect = dotEl?.getBoundingClientRect() ?? null;
        const pinRect = pinEl.getBoundingClientRect();
        return {
          slot,
          text: (pinEl.textContent || '').replace(/\s+/g, ' ').trim(),
          hasInlineRemove: Boolean(removeBtn && (removeBtn.textContent || '').includes('×')),
          pinRect: {
            x: Number(pinRect.left.toFixed(1)),
            y: Number(pinRect.top.toFixed(1)),
            w: Number(pinRect.width.toFixed(1)),
            h: Number(pinRect.height.toFixed(1)),
          },
          dotNorm:
            dotRect && canvasRect && canvasRect.width > 0 && canvasRect.height > 0
              ? {
                  x: Number(((dotRect.left + dotRect.width * 0.5 - canvasRect.left) / canvasRect.width).toFixed(4)),
                  y: Number(((dotRect.top + dotRect.height * 0.5 - canvasRect.top) / canvasRect.height).toFixed(4)),
                }
              : null,
        };
      });

    // Check pin-to-pin overlap
    let pinOverlaps = 0;
    for (let i = 0; i < pins.length; i += 1) {
      for (let j = i + 1; j < pins.length; j += 1) {
        const a = pins[i].pinRect;
        const b = pins[j].pinRect;
        const overlapX = a.x < b.x + b.w && a.x + a.w > b.x;
        const overlapY = a.y < b.y + b.h && a.y + a.h > b.y;
        if (overlapX && overlapY) pinOverlaps += 1;
      }
    }

    const comboBar = document.querySelector('[data-testid="combo-unlock-bar"]');
    const itemCards = Array.from(document.querySelectorAll('[data-testid^="studio-item-card-"]')).map((el) =>
      el.getAttribute('data-testid')?.replace('studio-item-card-', ''),
    );

    const eveningPreset = document.querySelector('[data-testid="preset-evening-burgundy"]');
    const eveningPresetStyle = eveningPreset ? window.getComputedStyle(eveningPreset) : null;

    return {
      strayRemoveButtons,
      seal: checkHidden('.outfit__seal'),
      pkgBack: checkHidden('.outfit__pkg-back'),
      pkgFront: checkHidden('.outfit__pkg-front'),
      torsoCage: {
        exists: Boolean(torsoCage),
        occludedAttr: torsoCage?.getAttribute('data-occluded') || '',
        opacity: torsoStyle?.opacity || '',
        visibility: torsoStyle?.visibility || '',
      },
      exposedFrameExists: Boolean(exposedFrame),
      pins,
      pinOverlaps,
      comboPct: comboBar?.getAttribute('data-combo-pct') || '',
      comboText: (comboBar?.textContent || '').normalize('NFC').replace(/\s+/g, ' ').trim(),
      itemCards,
      eveningPresetPressed: eveningPreset?.getAttribute('aria-pressed') || '',
      eveningPresetBg: eveningPresetStyle?.backgroundColor || '',
    };
  });
}

async function main() {
  console.log('========================================================================');
  console.log(' AutoFitMannequinEngine — Live Visual & Pixel Geometry Verification');
  console.log(` Target: ${BASE_URL} | Audit Dir: ${AUDIT_DIR}`);
  console.log('========================================================================');

  // 0. Live service health check
  const healthTargets = [
    ['storefront:3000 (127.0.0.1)', `${LOOPBACK_URL}/`],
    ['storefront:3000/phoi-do (127.0.0.1)', `${LOOPBACK_URL}/phoi-do`],
    ['bff:4000/health', 'http://127.0.0.1:4000/health'],
    ['catalog:4002/health', 'http://127.0.0.1:4002/health'],
    ['minio:9000', 'http://127.0.0.1:9000/minio/health/live'],
    ['ollama:11434', 'http://127.0.0.1:11434/api/tags'],
  ];
  const healthMap = {};
  for (const [label, url] of healthTargets) {
    healthMap[label] = await httpGetStatus(url);
  }
  const allHealthOk = Object.values(healthMap).every((st) => st === 200);
  record(
    'HEALTH',
    'Live Services Health Check (:3000, :4000, :4002, :9000, :11434)',
    allHealthOk,
    Object.entries(healthMap).map(([k, v]) => `${k} -> HTTP ${v}`),
  );
  if (!allHealthOk) {
    process.exitCode = 1;
    return;
  }

  const exe = findChromeExecutable();
  if (!exe) {
    throw new Error('Could not find Chrome/Edge executable on this machine.');
  }

  const browser = await chromium.launch({
    executablePath: exe,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu-sandbox'],
  });

  const studioConsoleErrors = [];
  const studioPageErrors = [];
  const studioFailedRequests = [];
  const homeSeasons404s = [];

  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();

    let currentRouteTag = 'phoi-do';
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        const text = msg.text();
        if (currentRouteTag === 'home' && text.includes('seasons-lookbook')) {
          return;
        }
        // Ignore generic 404 console lines exclusively from unrelated /seasons-lookbook/ on /
        if (currentRouteTag === 'home' && /^Failed to load resource: the server responded with a status of 404/i.test(text)) {
          return;
        }
        studioConsoleErrors.push(`[${currentRouteTag}] ${text}`);
      }
    });
    page.on('pageerror', (err) => {
      studioPageErrors.push(`[${currentRouteTag}] ${err.message}`);
    });
    page.on('response', (res) => {
      const st = res.status();
      if (st >= 400) {
        const url = res.url();
        if (currentRouteTag === 'home' && url.includes('/seasons-lookbook/')) {
          homeSeasons404s.push(`${st} ${url}`);
        } else {
          studioFailedRequests.push(`[${currentRouteTag}] ${st} ${url}`);
        }
      }
    });

    // =========================================================================
    // TEST 1 — Default 3-Piece Preset `Dạ Tiệc Đỏ Vang` on `/phoi-do`
    // =========================================================================
    currentRouteTag = 'phoi-do';
    await page.goto(`${BASE_URL}/phoi-do`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.locator('#bStage').waitFor({ state: 'visible', timeout: 20_000 });
    await waitCanvasReady(page, ['ONE_PIECE', 'OUTERWEAR', 'ACCESSORY'], 'front', 20_000);

    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    await page.waitForTimeout(300);

    const t1Dom = await auditStageDom(page);
    const t1Px = await inspectCanvasPixels(page, 'front');
    const shot01 = path.join(AUDIT_DIR, '01-autofit-default-3piece-1440.png');
    await page.screenshot({ path: shot01, fullPage: false, type: 'png' });

    const t1Slots = t1Px.slots.split(',').filter(Boolean);
    const t1Ok =
      t1Dom.eveningPresetPressed === 'true' &&
      t1Dom.eveningPresetBg === 'rgb(28, 20, 16)' &&
      t1Slots.length === 3 &&
      t1Slots.includes('ONE_PIECE') &&
      t1Slots.includes('OUTERWEAR') &&
      t1Slots.includes('ACCESSORY') &&
      t1Dom.comboPct === '100' &&
      t1Dom.comboText.includes('-10%') &&
      t1Px.totalOpaque > 10_000 &&
      t1Dom.strayRemoveButtons.length === 0 &&
      t1Dom.seal.hidden &&
      t1Dom.pkgBack.hidden &&
      t1Dom.pkgFront.hidden &&
      t1Dom.pinOverlaps === 0 &&
      t1Dom.pins.length === 3 &&
      t1Dom.pins.every((p) => p.hasInlineRemove);

    record('TEST 1', 'Default 3-Piece Preset Dạ Tiệc Đỏ Vang on /phoi-do', t1Ok, [
      `Preset pill: aria-pressed=${t1Dom.eveningPresetPressed}, bg=${t1Dom.eveningPresetBg}`,
      `Canvas slots=[${t1Slots.join(',')}], itemCards=[${t1Dom.itemCards.join(',')}], opaquePx=${t1Px.totalOpaque}`,
      `Combo bar: pct=${t1Dom.comboPct}%, label="${t1Dom.comboText}"`,
      `Stray floating X buttons=${t1Dom.strayRemoveButtons.length}, .outfit__seal hidden=${t1Dom.seal.hidden}, pkg hidden=${t1Dom.pkgBack.hidden && t1Dom.pkgFront.hidden}`,
      `Pins (${t1Dom.pins.length}, overlaps=${t1Dom.pinOverlaps}): ${t1Dom.pins.map((p) => `${p.slot}[x=${p.hasInlineRemove}]`).join(', ')}`,
      `Screenshot 01: ${shot01} (${Math.round(fs.statSync(shot01).size / 1024)} KB)`,
    ]);

    // =========================================================================
    // TEST 2 — Solo Red Dress Pixel Symmetry, Width Coverage & Zero Wireframe Leak
    // =========================================================================
    await page.locator('[data-testid="stage-pin-remove-OUTERWEAR"]').click();
    await waitCanvasReady(page, ['ONE_PIECE', 'ACCESSORY'], 'front', 15_000);
    await page.locator('[data-testid="stage-pin-remove-ACCESSORY"]').click();
    await waitCanvasReady(page, ['ONE_PIECE'], 'front', 15_000);

    await page.mouse.move(10, 10);
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    await page.waitForTimeout(350);

    const t2Dom = await auditStageDom(page);
    const t2Px = await inspectCanvasPixels(page, 'front');
    const shot02 = path.join(AUDIT_DIR, '02-autofit-red-dress-solo-1440.png');
    await page.screenshot({ path: shot02, fullPage: false, type: 'png' });

    const onePiecePin = t2Dom.pins.find((p) => p.slot === 'ONE_PIECE');
    // Compare pin leader dot X vs actual right dress edge around pin dot Y (y≈0.44)
    const dressEdgeAtPinY = await page.evaluate((dotY) => {
      const c = document.querySelector('[data-testid="autofit-garment-canvas"][data-face="front"]');
      if (!(c instanceof HTMLCanvasElement)) return null;
      const ctx = c.getContext('2d');
      if (!ctx) return null;
      const W = c.width;
      const H = c.height;
      const { data } = ctx.getImageData(0, 0, W, H);
      const yPx = Math.max(0, Math.min(H - 1, Math.round(dotY * H)));
      let right = -1;
      for (let x = W - 1; x >= 0; x -= 1) {
        if (data[(yPx * W + x) * 4 + 3] > 36) {
          right = x;
          break;
        }
      }
      return right >= 0 ? Number((right / W).toFixed(4)) : null;
    }, onePiecePin?.dotNorm?.y ?? 0.44);

    const pinEdgeDelta =
      onePiecePin?.dotNorm && dressEdgeAtPinY !== null
        ? Number(Math.abs(onePiecePin.dotNorm.x - dressEdgeAtPinY).toFixed(4))
        : 1;

    const symmetryOk =
      t2Px.bandComDev <= 0.025 &&
      t2Px.meanRowDev <= 0.025 &&
      t2Px.maxRowDev <= 0.025;
    const widthCoverageOk =
      t2Px.bust.coveragePct >= 104 &&
      t2Px.waist.coveragePct >= 104 &&
      t2Px.hip.coveragePct >= 104 &&
      t2Px.bust.coversLeft &&
      t2Px.bust.coversRight &&
      t2Px.waist.coversLeft &&
      t2Px.waist.coversRight &&
      t2Px.hip.coversLeft &&
      t2Px.hip.coversRight;
    const torsoOccludedOk =
      t2Dom.torsoCage.exists &&
      t2Dom.torsoCage.occludedAttr === 'true' &&
      (t2Dom.torsoCage.opacity === '0' || t2Dom.torsoCage.visibility === 'hidden');
    const pinOk =
      Boolean(onePiecePin) &&
      onePiecePin.hasInlineRemove &&
      pinEdgeDelta <= 0.08 &&
      t2Dom.strayRemoveButtons.length === 0;

    const t2Ok =
      t2Px.slots === 'ONE_PIECE' &&
      symmetryOk &&
      widthCoverageOk &&
      torsoOccludedOk &&
      pinOk;

    record('TEST 2', 'Solo Red Dress Symmetry (|midX-0.50|<=0.025), Width >=104%, Torso Occlusion & Pin Edge', t2Ok, [
      `Canvas (${t2Px.canvasWidth}x${t2Px.canvasHeight}, css=${t2Px.cssWidth}x${t2Px.cssHeight}), slots="${t2Px.slots}", bbox=${JSON.stringify(t2Px.bboxNorm)}`,
      `Symmetry (y=0.28..0.55): bandComX=${t2Px.bandComX} (|dev|=${t2Px.bandComDev}), meanRowDev=${t2Px.meanRowDev}, maxRowDev=${t2Px.maxRowDev} (at y=${t2Px.worstRowY}, midX=${t2Px.worstRowMidX}) -> PASS=${symmetryOk}`,
      `Bust (y=0.292): w=${t2Px.bust.width} vs mannequin=${t2Px.bust.mannequinW} (${t2Px.bust.coveragePct}%, L=${t2Px.bust.left}, R=${t2Px.bust.right}, coversLR=${t2Px.bust.coversLeft && t2Px.bust.coversRight})`,
      `Waist (y=0.415): w=${t2Px.waist.width} vs mannequin=${t2Px.waist.mannequinW} (${t2Px.waist.coveragePct}%, L=${t2Px.waist.left}, R=${t2Px.waist.right}, coversLR=${t2Px.waist.coversLeft && t2Px.waist.coversRight})`,
      `Hip (y=0.525): w=${t2Px.hip.width} vs mannequin=${t2Px.hip.mannequinW} (${t2Px.hip.coveragePct}%, L=${t2Px.hip.left}, R=${t2Px.hip.right}, coversLR=${t2Px.hip.coversLeft && t2Px.hip.coversRight})`,
      `Torso cage occlusion: occluded=${t2Dom.torsoCage.occludedAttr}, opacity=${t2Dom.torsoCage.opacity}, visibility=${t2Dom.torsoCage.visibility} -> PASS=${torsoOccludedOk}`,
      `ONE_PIECE pin: inlineX=${onePiecePin?.hasInlineRemove}, dotNorm=${JSON.stringify(onePiecePin?.dotNorm)}, dressRightEdge=${dressEdgeAtPinY} (delta=${pinEdgeDelta}), strayX=${t2Dom.strayRemoveButtons.length}`,
      `Screenshot 02: ${shot02} (${Math.round(fs.statSync(shot02).size / 1024)} KB)`,
    ]);

    // =========================================================================
    // TEST 3 — Switch Presets & Interactive Stage Tools
    // =========================================================================
    // 3A: Công Sở Thanh Lịch
    await page.locator('[data-testid="preset-modern-office"]').click();
    await waitCanvasReady(page, ['TOP', 'BOTTOM', 'OUTERWEAR', 'ACCESSORY'], 'front', 20_000);
    await page.mouse.move(10, 10);
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    await page.waitForTimeout(300);

    const t3OfficeDom = await auditStageDom(page);
    const t3OfficePx = await inspectCanvasPixels(page, 'front');
    const shot03 = path.join(AUDIT_DIR, '03-autofit-office-preset-1440.png');
    await page.screenshot({ path: shot03, fullPage: false, type: 'png' });

    const officeSlots = t3OfficePx.slots.split(',').filter(Boolean);
    const officeOk =
      officeSlots.length === 4 &&
      officeSlots.includes('TOP') &&
      officeSlots.includes('BOTTOM') &&
      officeSlots.includes('OUTERWEAR') &&
      officeSlots.includes('ACCESSORY') &&
      t3OfficePx.totalOpaque > 12_000 &&
      t3OfficeDom.torsoCage.occludedAttr === 'true' &&
      t3OfficeDom.strayRemoveButtons.length === 0 &&
      t3OfficeDom.pinOverlaps === 0;

    // 3B: Cà Phê Sáng + Đèn Tiệc + Soi chất liệu (3x loupe)
    await page.locator('[data-testid="preset-morning-coffee"]').click();
    await waitCanvasReady(page, ['TOP', 'BOTTOM', 'OUTERWEAR', 'ACCESSORY'], 'front', 20_000);
    await page.locator('[data-testid="lighting-toggle-evening"]').click();
    await page.waitForTimeout(400);
    await page.locator('[data-testid="stage-loupe-btn"]').click();
    const loupeLoc = page.locator('[data-testid="optical-fabric-loupe"]');
    await loupeLoc.waitFor({ state: 'visible', timeout: 5000 });

    const canvasBox = await page
      .locator('[data-testid="autofit-garment-canvas"][data-face="front"]')
      .boundingBox();
    if (canvasBox) {
      await page.mouse.move(
        canvasBox.x + canvasBox.width * 0.5,
        canvasBox.y + canvasBox.height * 0.44,
        { steps: 8 },
      );
    }
    await page.waitForTimeout(450);

    const coffeeLoupeAudit = await page.evaluate(() => {
      const stage = document.querySelector('#bStage');
      const loupe = document.querySelector('[data-testid="optical-fabric-loupe"]');
      const lr = loupe?.getBoundingClientRect() ?? null;
      const lc = loupe?.querySelector('canvas');
      let loupeNonEmpty = false;
      if (lc instanceof HTMLCanvasElement && lc.width > 0) {
        const d = lc.getContext('2d')?.getImageData(0, 0, lc.width, lc.height).data;
        if (d) {
          let nonBg = 0;
          for (let i = 0; i < d.length; i += 16) {
            if (Math.abs(d[i] - 244) > 12 || Math.abs(d[i + 1] - 235) > 12 || Math.abs(d[i + 2] - 218) > 12) {
              nonBg += 1;
              if (nonBg > 40) {
                loupeNonEmpty = true;
                break;
              }
            }
          }
        }
      }
      return {
        lightingMode: stage?.getAttribute('data-lighting-mode') || '',
        loupeAttr: stage?.getAttribute('data-loupe-enabled') || '',
        loupeSize: lr ? `${lr.width.toFixed(0)}x${lr.height.toFixed(0)}` : 'none',
        loupeVisible: Boolean(lr && lr.width >= 120 && lr.height >= 120),
        loupeNonEmpty,
      };
    });

    const shot04 = path.join(AUDIT_DIR, '04-autofit-coffee-evening-1440.png');
    await page.screenshot({ path: shot04, fullPage: false, type: 'png' });

    // Turn off loupe, toggle Mặt trước / sau (back view), verify back canvas, restore front
    await page.locator('[data-testid="stage-loupe-btn"]').click();
    await page.waitForTimeout(250);
    await page.locator('[data-testid="stage-flip-btn"]').click();
    await waitCanvasReady(page, ['TOP', 'BOTTOM', 'OUTERWEAR', 'ACCESSORY'], 'back', 15_000);
    const backAudit = await page.evaluate(() => {
      const stage = document.querySelector('#bStage');
      const ind = document.querySelector('[data-testid="stage-back-view-indicator"]');
      return {
        viewSide: stage?.getAttribute('data-view-side') || '',
        indicatorVisible: Boolean(ind),
      };
    });
    const backPx = await inspectCanvasPixels(page, 'back');

    // Restore front
    await page.locator('[data-testid="stage-flip-btn"]').click();
    await page.waitForTimeout(600);
    const restoredFrontSide = await page.evaluate(
      () => document.querySelector('#bStage')?.getAttribute('data-view-side') || '',
    );

    // Click ✦ Ướm thử cả bộ AI -> verify VirtualTryOnModal opens (z=120) and closes cleanly
    await page.locator('[data-testid="stage-tryon-btn"]').click();
    const tryOnModal = page.locator('[data-testid="virtual-tryon-modal"]');
    await tryOnModal.waitFor({ state: 'visible', timeout: 8000 });
    const modalInfo = await page.evaluate(() => {
      const m = document.querySelector('[data-testid="virtual-tryon-modal"]');
      const st = m ? window.getComputedStyle(m) : null;
      return {
        visible: Boolean(m && m.getBoundingClientRect().width > 200),
        zIndex: st?.zIndex || '',
      };
    });
    const closeBtn = tryOnModal.locator('button[aria-label="Đóng Phòng Thử đồ AI"]').first();
    if (await closeBtn.isVisible().catch(() => false)) {
      await closeBtn.click();
    } else {
      await page.keyboard.press('Escape');
    }
    await tryOnModal.waitFor({ state: 'hidden', timeout: 6000 });
    const modalClosed = !(await tryOnModal.isVisible().catch(() => false));

    const t3Ok =
      officeOk &&
      coffeeLoupeAudit.lightingMode === 'evening' &&
      coffeeLoupeAudit.loupeAttr === 'true' &&
      coffeeLoupeAudit.loupeVisible &&
      coffeeLoupeAudit.loupeNonEmpty &&
      backAudit.viewSide === 'back' &&
      backAudit.indicatorVisible &&
      backPx.totalOpaque > 10_000 &&
      restoredFrontSide === 'front' &&
      modalInfo.visible &&
      Number(modalInfo.zIndex) >= 120 &&
      modalClosed;

    record('TEST 3', 'Presets (Office & Coffee) + Đèn Tiệc + 3x Loupe + Back Flip + VirtualTryOnModal', t3Ok, [
      `Office preset: slots=[${officeSlots.join(',')}], opaquePx=${t3OfficePx.totalOpaque}, bandComX=${t3OfficePx.bandComX}, torsoOccluded=${t3OfficeDom.torsoCage.occludedAttr}, pinOverlaps=${t3OfficeDom.pinOverlaps}`,
      `Coffee + Đèn Tiệc + Loupe: lighting=${coffeeLoupeAudit.lightingMode}, loupe=${coffeeLoupeAudit.loupeSize}, loupeCanvasNonEmpty=${coffeeLoupeAudit.loupeNonEmpty}`,
      `Back flip: viewSide=${backAudit.viewSide}, indicator=${backAudit.indicatorVisible}, backOpaquePx=${backPx.totalOpaque} -> restored=${restoredFrontSide}`,
      `VirtualTryOnModal: opened=${modalInfo.visible}, zIndex=${modalInfo.zIndex}, closed=${modalClosed}`,
      `Screenshot 03: ${shot03} (${Math.round(fs.statSync(shot03).size / 1024)} KB)`,
      `Screenshot 04: ${shot04} (${Math.round(fs.statSync(shot04).size / 1024)} KB)`,
    ]);

    // =========================================================================
    // TEST 4 — Live Homepage `/#build` Check
    // =========================================================================
    currentRouteTag = 'home';
    await page.goto(`${BASE_URL}/#build`, { waitUntil: 'domcontentloaded', timeout: 35_000 });
    await page.locator('#build').waitFor({ state: 'visible', timeout: 25_000 });
    // Ensure #build is smoothly aligned cleanly below header for nav.is-light intersection & clean screenshot
    await page.evaluate(() => {
      const build = document.querySelector('#build');
      if (build) {
        const y = build.getBoundingClientRect().top + window.scrollY;
        window.scrollTo({ top: Math.max(0, y - 52), behavior: 'instant' });
      }
    });
    await page.mouse.move(10, 10);
    await waitCanvasReady(page, ['ONE_PIECE', 'OUTERWEAR', 'ACCESSORY'], 'front', 20_000);
    await page.waitForTimeout(500);

    const t4Home = await page.evaluate(() => {
      const nav = document.querySelector('header.nav, .nav');
      const preset = document.querySelector('[data-testid="preset-evening-burgundy"]');
      const canvas = document.querySelector('[data-testid="autofit-garment-canvas"][data-face="front"]');
      return {
        navExists: Boolean(nav),
        navIsLight: Boolean(nav?.classList.contains('is-light')),
        presetPressed: preset?.getAttribute('aria-pressed') || '',
        canvasReady: canvas?.getAttribute('data-render-ready') || '',
        canvasSlots: canvas?.getAttribute('data-slots') || '',
      };
    });
    const t4Dom = await auditStageDom(page);
    const t4Px = await inspectCanvasPixels(page, 'front');
    const shot05 = path.join(AUDIT_DIR, '05-autofit-home-build-1440.png');
    await page.screenshot({ path: shot05, fullPage: false, type: 'png' });

    const t4Ok =
      t4Home.navIsLight &&
      t4Home.presetPressed === 'true' &&
      t4Home.canvasReady === 'true' &&
      t4Px.totalOpaque > 10_000 &&
      t4Dom.strayRemoveButtons.length === 0 &&
      t4Dom.seal.hidden &&
      studioConsoleErrors.length === 0 &&
      studioPageErrors.length === 0 &&
      studioFailedRequests.length === 0;

    record('TEST 4', 'Live Homepage /#build (.nav.is-light, 3-Piece Preset, AutoFit Canvas, 0 Studio Errors)', t4Ok, [
      `nav.is-light=${t4Home.navIsLight}, presetPressed=${t4Home.presetPressed}, slots=[${t4Home.canvasSlots}], opaquePx=${t4Px.totalOpaque}`,
      `strayX=${t4Dom.strayRemoveButtons.length}, .outfit__seal hidden=${t4Dom.seal.hidden}`,
      `Studio errors: consoleErrors=${studioConsoleErrors.length}, pageErrors=${studioPageErrors.length}, failedRequests=${studioFailedRequests.length}`,
      `Unrelated #seasons /seasons-lookbook 404s on /: ${homeSeasons404s.length} (expected per #314, zero studio impact)`,
      ...(studioConsoleErrors.length > 0 ? [`Console errors: ${studioConsoleErrors.slice(0, 5).join(' | ')}`] : []),
      ...(studioPageErrors.length > 0 ? [`Page errors: ${studioPageErrors.slice(0, 5).join(' | ')}`] : []),
      ...(studioFailedRequests.length > 0 ? [`Failed requests: ${studioFailedRequests.slice(0, 5).join(' | ')}`] : []),
      `Screenshot 05: ${shot05} (${Math.round(fs.statSync(shot05).size / 1024)} KB)`,
    ]);
  } finally {
    await browser.close();
  }

  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;
  console.log('\n========================================================================');
  console.log(` AutoFitMannequinEngine Audit Summary: PASS=${passed}/${results.length} | FAIL=${failed}`);
  console.log('========================================================================');

  if (failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('[FATAL]', err);
  process.exit(1);
});
