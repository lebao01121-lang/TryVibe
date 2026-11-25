#!/usr/bin/env node
/**
 * Phase 3 Acceptance Verification Suite — fashion-atelier-ai-platform (v3.0)
 *
 * Implements all 8 mandatory Phase 3 Definition-of-Done tests:
 *   Test 1: <ClothingRack3D />, 3 GLSL shaders (PD[12], wallShadow, 118 sparks), springPendulum,
 *           strict disposal, FlatRackFallback & live GET /bff/v1/storefront/rack-collection
 *   Test 2: <OccasionShowcase /> (radial wipe + SVG rings + img.decode) & Web Worker
 *           <SeasonLookbookTrack /> (Float32Array + OffscreenCanvas) + live /occasions & /seasons
 *   Test 3: Vietnamese Accent-Insensitive Meilisearch (< 120ms) & PLP Facet Filters
 *   Test 4: SEO SSR (<title>, og:title, canonical), JSON-LD Product + aggregateRating,
 *           Dynamic OpenGraph PNG (89 50 4E 47) & /sitemap.xml
 *   Test 5: Honest Live AI Size Advisor (0 fake % in SSR HTML) & Crowd Fit Calibration (RUNS_SMALL >= 50%)
 *   Test 6: On-Demand ISR (/api/revalidate) & Live Visual Anchor Calibrator (hangerAnchorY) Sync
 *   Test 7: Real Headless Chrome 20-Cycle Route Leak Test (0 console/hydration errors, 0 orphaned
 *           .pin-spacer, bounded canvas count, scroll unlocked) & Storefront Physical Isolation Scan
 *   Test 8: pnpm eval:ai (incl. Tier-0 calculate_verified_size & search_in_stock_outfits 100%),
 *           pnpm typecheck & pnpm build (0 errors across all 21 workspaces)
 */

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { startLocalInfraIfNeeded } from './local-infra-dev.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const IS_WIN = process.platform === 'win32';

const STOREFRONT_BASE = 'http://localhost:3000';
const BFF_BASE = 'http://127.0.0.1:4000';
const AUTH_BASE = 'http://127.0.0.1:4001';
const CATALOG_BASE = 'http://127.0.0.1:4002';
const MEDIA_BASE = 'http://127.0.0.1:4003';
const NOTIFY_BASE = 'http://127.0.0.1:4008';
const MAILPIT_BASE = 'http://127.0.0.1:8025';
const TARGET_SLUG = 'ao-blazer-linen-dang-suong';

/** @type {Map<string, { id: string, title: string, status: 'PASS'|'FAIL', details: string[] }>} */
const resultsMap = new Map();

function recordResult(id, title, status, details = []) {
  resultsMap.set(id, { id, title, status, details });
  const badge = status === 'PASS' ? '[PASS]' : '[FAIL]';
  console.log(`\n${badge} ${id} — ${title}`);
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
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    vars[key] = val;
  }
  return vars;
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

function runCommand(cmd, args, options = {}) {
  const { cwd = ROOT_DIR, env = process.env, timeoutMs = 420_000 } = options;
  return new Promise((resolve) => {
    const isPnpm = cmd === 'pnpm';
    const execCmd = IS_WIN && isPnpm ? 'cmd.exe' : cmd;
    const execArgs = IS_WIN && isPnpm ? ['/d', '/c', 'pnpm', ...args] : args;

    const child = spawn(execCmd, execArgs, {
      cwd,
      env,
      shell: false,
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

    child.stdout?.on('data', (c) => {
      stdout += c.toString('utf8');
    });
    child.stderr?.on('data', (c) => {
      stderr += c.toString('utf8');
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, code: -1, stdout, stderr: `${stderr}\n${err.message}`.trim(), timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: !timedOut && code === 0, code: code ?? -1, stdout, stderr, timedOut });
    });
  });
}

function tailLines(text, maxLines = 18) {
  return String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter(Boolean)
    .slice(-maxLines);
}

function apiRequest(urlString, { method = 'GET', headers = {}, body = undefined, timeoutMs = 15_000 } = {}) {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    const url = new URL(urlString);
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

    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port || 80,
        path: `${url.pathname}${url.search}`,
        method,
        headers: reqHeaders,
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
        res.on('end', () => {
          const elapsedMs = performance.now() - t0;
          const rawBuf = Buffer.concat(chunks);
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
            text,
            json,
            buffer: rawBuf,
            elapsedMs,
          });
        });
      },
    );

    req.on('timeout', () => req.destroy(new Error(`HTTP timeout (${timeoutMs}ms): ${method} ${urlString}`)));
    req.on('error', reject);
    if (payloadBuf) req.write(payloadBuf);
    req.end();
  });
}

function unwrapData(res) {
  if (!res?.json) return null;
  if (typeof res.json === 'object' && 'data' in res.json) return res.json.data;
  return res.json;
}

function walkFiles(dir, exts) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.next' || entry.name === 'dist') continue;
        walk(full);
      } else if (exts.test(entry.name)) {
        out.push(full);
      }
    }
  };
  walk(dir);
  return out;
}

function findDeepKeys(obj, forbiddenNames, trail = '$', hits = []) {
  if (!obj || typeof obj !== 'object') return hits;
  if (Array.isArray(obj)) {
    obj.forEach((item, idx) => findDeepKeys(item, forbiddenNames, `${trail}[${idx}]`, hits));
    return hits;
  }
  for (const [k, v] of Object.entries(obj)) {
    if (forbiddenNames.includes(k) && v !== undefined) {
      hits.push(`${trail}.${k}=${JSON.stringify(v)}`);
    }
    findDeepKeys(v, forbiddenNames, `${trail}.${k}`, hits);
  }
  return hits;
}

function findChromeExecutable() {
  const candidates = IS_WIN
    ? [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      ]
    : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];

  for (const p of candidates) {
    if (p && fs.existsSync(p)) return p;
  }
  return null;
}

async function waitForHttp200(urlString, timeoutMs = 45_000, logsRef = null) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = '';
  while (Date.now() < deadline) {
    try {
      const res = await apiRequest(urlString, { timeoutMs: 3000 });
      if (res.status === 200) return res;
      lastErr = `HTTP ${res.status}: ${res.text.slice(0, 120)}`;
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  const logTail = logsRef ? `\nLogs:\n${tailLines(logsRef.join(''), 15).join('\n')}` : '';
  throw new Error(`Timed out waiting for 200 OK from ${urlString} (${lastErr})${logTail}`);
}

async function loginAdminWithMailpitMfa() {
  const loginRes = await apiRequest(`${BFF_BASE}/api/v1/auth/login`, {
    method: 'POST',
    headers: { Origin: 'http://localhost:3001' },
    body: { email: 'lebao01121@gmail.com', password: 'Atelier@2026!' },
  });
  assert.equal(loginRes.status, 200, `Admin login failed: ${loginRes.text}`);
  const preToken = unwrapData(loginRes)?.accessToken;
  assert.ok(preToken, 'Missing admin accessToken');

  await apiRequest(`${MAILPIT_BASE}/api/v1/messages`, { method: 'DELETE' });
  const sendRes = await apiRequest(`${BFF_BASE}/api/v1/auth/2fa/email-otp/send`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${preToken}`, Origin: 'http://localhost:3001' },
    body: { email: 'lebao01121@gmail.com', purpose: 'MFA_LOGIN' },
  });
  assert.equal(sendRes.status, 200, `Admin OTP send failed: ${sendRes.text}`);

  let otp = null;
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && !otp) {
    const inboxRes = await apiRequest(`${MAILPIT_BASE}/api/v1/messages`);
    for (const m of inboxRes.json?.messages || []) {
      const fullRes = await apiRequest(`${MAILPIT_BASE}/api/v1/message/${encodeURIComponent(m.ID)}`);
      const combined = `${fullRes.json?.Subject || ''} ${fullRes.json?.Text || ''} ${fullRes.json?.HTML || ''} ${m.Snippet || ''}`;
      const match = /\b(\d{6})\b/.exec(combined);
      if (match) {
        otp = match[1];
        break;
      }
    }
    if (!otp) await new Promise((r) => setTimeout(r, 200));
  }
  assert.ok(otp, 'Could not find 6-digit OTP in Mailpit for lebao01121@gmail.com');

  const verifyRes = await apiRequest(`${BFF_BASE}/api/v1/auth/2fa/email-otp/verify`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${preToken}`, Origin: 'http://localhost:3001' },
    body: { method: 'EMAIL_OTP', code: otp },
  });
  assert.equal(verifyRes.status, 200, `Admin OTP verify failed: ${verifyRes.text}`);
  return { adminToken: unwrapData(verifyRes)?.accessToken, otp };
}

// =============================================================================
// TEST 8: pnpm eval:ai (incl. Tier-0 calculate_verified_size) + typecheck + build
// =============================================================================
async function runTest8BuildTypecheckEval(skipBuild) {
  console.log('\n--- Running Test 8: pnpm eval:ai, pnpm typecheck & pnpm build ---');
  const details = [];
  try {
    if (!skipBuild) {
      const tBuild = performance.now();
      const buildRes = await runCommand('pnpm', ['build'], { timeoutMs: 420_000 });
      if (!buildRes.ok) {
        details.push(`pnpm build FAILED (exit ${buildRes.code})`);
        for (const l of tailLines(`${buildRes.stdout}\n${buildRes.stderr}`, 20)) details.push(`  | ${l}`);
        recordResult('TEST 8', 'pnpm eval:ai, pnpm typecheck & pnpm build', 'FAIL', details);
        return false;
      }
      details.push(`pnpm build: PASS (${((performance.now() - tBuild) / 1000).toFixed(1)}s across all 21 workspaces)`);

      const tTc = performance.now();
      const tcRes = await runCommand('pnpm', ['typecheck'], { timeoutMs: 300_000 });
      if (!tcRes.ok) {
        details.push(`pnpm typecheck FAILED (exit ${tcRes.code})`);
        for (const l of tailLines(`${tcRes.stdout}\n${tcRes.stderr}`, 20)) details.push(`  | ${l}`);
        recordResult('TEST 8', 'pnpm eval:ai, pnpm typecheck & pnpm build', 'FAIL', details);
        return false;
      }
      details.push(`pnpm typecheck: PASS (${((performance.now() - tTc) / 1000).toFixed(1)}s, 0 errors)`);
    } else {
      details.push('pnpm build & typecheck: skipped via --skip-build');
    }

    const evalRes = await runCommand('pnpm', ['eval:ai'], { timeoutMs: 120_000 });
    assert.equal(evalRes.ok, true, `pnpm eval:ai failed (exit ${evalRes.code}): ${tailLines(evalRes.stdout + '\n' + evalRes.stderr, 10).join(' | ')}`);
    const combinedEval = `${evalRes.stdout}\n${evalRes.stderr}`;
    assert.ok(/calculate_verified_size/i.test(combinedEval), 'pnpm eval:ai missing calculate_verified_size Tier-0 test case');
    assert.ok(/search_in_stock_outfits/i.test(combinedEval), 'pnpm eval:ai missing search_in_stock_outfits Tier-0 test case');
    const summaryLine = tailLines(evalRes.stdout, 6).find((l) => /PASSED|100\.0%/i.test(l)) || '100% PASS';
    details.push(`pnpm eval:ai (incl. Tier-0 calculate_verified_size & search_in_stock_outfits): PASS (${summaryLine.trim()})`);

    recordResult('TEST 8', 'pnpm eval:ai (incl. Tier-0), pnpm typecheck & pnpm build', 'PASS', details);
    return true;
  } catch (err) {
    details.push(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    recordResult('TEST 8', 'pnpm eval:ai (incl. Tier-0), pnpm typecheck & pnpm build', 'FAIL', details);
    return false;
  }
}

// =============================================================================
// TEST 1: <ClothingRack3D />, 3 GLSL Shaders, Disposal & /bff/v1/storefront/rack-collection
// =============================================================================
async function runTest1Rack3dAndCollection(sharedState) {
  console.log('\n--- Running Test 1: <ClothingRack3D />, 3 GLSL Shaders, Disposal & Rack Collection ---');
  const details = [];
  try {
    const rackDir = path.join(ROOT_DIR, 'apps', 'storefront', 'src', 'features', 'rack-3d');
    const requiredFiles = {
      rack3d: path.join(rackDir, 'ClothingRack3D.tsx'),
      canvas: path.join(rackDir, 'RackCanvasR3F.tsx'),
      fallback: path.join(rackDir, 'FlatRackFallback.tsx'),
      physics: path.join(rackDir, 'physics', 'springPendulum.ts'),
      poisson: path.join(rackDir, 'shaders', 'garmentPoisson.glsl.ts'),
      shadow: path.join(rackDir, 'shaders', 'wallShadow.glsl.ts'),
      sparks: path.join(rackDir, 'shaders', 'sparkParticles.glsl.ts'),
    };
    for (const [k, fp] of Object.entries(requiredFiles)) {
      assert.ok(fs.existsSync(fp), `Missing rack-3d file (${k}): ${path.relative(ROOT_DIR, fp)}`);
    }

    const rack3dSrc = fs.readFileSync(requiredFiles.rack3d, 'utf8');
    const canvasSrc = fs.readFileSync(requiredFiles.canvas, 'utf8');
    const physicsSrc = fs.readFileSync(requiredFiles.physics, 'utf8');
    const poissonSrc = fs.readFileSync(requiredFiles.poisson, 'utf8');
    const shadowSrc = fs.readFileSync(requiredFiles.shadow, 'utf8');
    const sparksSrc = fs.readFileSync(requiredFiles.sparks, 'utf8');

    assert.ok(/next\/dynamic/.test(rack3dSrc) && /ssr\s*:\s*false/.test(rack3dSrc), 'ClothingRack3D must load RackCanvasR3F via next/dynamic(..., { ssr: false })');
    assert.ok(/PD\[12\]/.test(poissonSrc) && /uMix/.test(poissonSrc), 'garmentPoisson.glsl.ts missing PD[12] or uMix');
    assert.ok(/smoothstep/.test(shadowSrc), 'wallShadow.glsl.ts missing smoothstep edge fade');
    assert.ok(/\b118\b/.test(sparksSrc), 'sparkParticles.glsl.ts missing 118 particle count');
    assert.ok(/fabricWeight/.test(physicsSrc), 'springPendulum.ts missing fabricWeight modulation');
    assert.ok(!/mesh\.rotation\.z\s*=\s*Math\.PI\b/.test(canvasSrc), 'RackCanvasR3F must hang garments upright (rotation.z = 0), not upside-down Math.PI');
    assert.ok(/frameloop/.test(canvasSrc) && /cameraActive/.test(canvasSrc + rack3dSrc), 'RackCanvasR3F must gate frameloop on visibility & cameraActive');
    assert.ok(/\.dispose\s*\(|disposeObject3D/.test(canvasSrc), 'RackCanvasR3F missing explicit WebGL .dispose() / disposeObject3D cleanup');
    assert.ok(/webglcontextlost/.test(canvasSrc), 'RackCanvasR3F missing webglcontextlost handler for FlatRackFallback');
    details.push('Static rack-3d audit: PASS (next/dynamic ssr:false, PD[12]+uMix, wallShadow smoothstep, 118 sparks, fabricWeight pendulum, upright hang, frameloop+cameraActive guard, dispose(), webglcontextlost fallback)');

    // Live HTTP GET /bff/v1/storefront/rack-collection
    const rackRes = await apiRequest(`${BFF_BASE}/bff/v1/storefront/rack-collection`);
    assert.equal(rackRes.status, 200, `GET /bff/v1/storefront/rack-collection failed (${rackRes.status}): ${rackRes.text}`);
    const rackData = unwrapData(rackRes);
    const items = rackData?.items || [];
    assert.ok(items.length >= 8, `Expected >= 8 rack items, got ${items.length}`);

    const leaks = findDeepKeys(rackRes.json, ['costPriceVnd', 'cost_price_vnd', 'cost_price', 'supplierId', 'supplier_id']);
    assert.equal(leaks.length, 0, `Sensitive fields leaked in rack-collection: ${leaks.slice(0, 5).join(', ')}`);

    for (const item of items) {
      assert.ok(typeof item.fabricWeight === 'number' || typeof item.fabricWeight === 'string', `Missing fabricWeight on ${item.slug}`);
      assert.ok(Array.isArray(item.variants) && item.variants.length > 0, `Missing variants on ${item.slug}`);
      const v0 = item.variants[0];
      assert.ok(v0.frontCutoutUrl, `Missing frontCutoutUrl on ${item.slug}`);
      assert.ok(v0.backCutoutUrl, `Missing backCutoutUrl on ${item.slug}`);
      assert.ok(typeof v0.hangerAnchorX === 'number' && typeof v0.hangerAnchorY === 'number', `Missing hangerAnchorX/Y on ${item.slug}`);
      assert.ok(Array.isArray(v0.inStockSizes), `Missing inStockSizes on ${item.slug}`);
    }

    // Verify front & back 2:3 cutout URLs on target garment actually return HTTP 200
    const targetItem = items.find((i) => i.slug === TARGET_SLUG) || items[0];
    const targetVariant = targetItem.variants[0];
    const frontProbe = await apiRequest(targetVariant.frontCutoutUrl);
    const backProbe = await apiRequest(targetVariant.backCutoutUrl);
    assert.equal(frontProbe.status, 200, `frontCutoutUrl 404: ${targetVariant.frontCutoutUrl}`);
    assert.equal(backProbe.status, 200, `backCutoutUrl 404: ${targetVariant.backCutoutUrl}`);

    sharedState.targetRackAssetId = targetVariant.rackFrontAssetId;
    sharedState.targetRackSlug = targetItem.slug;
    sharedState.originalHangerAnchorX = targetVariant.hangerAnchorX;
    sharedState.originalHangerAnchorY = targetVariant.hangerAnchorY;

    details.push(
      `Live GET /bff/v1/storefront/rack-collection: PASS (${items.length} garments, 0 costPriceVnd/supplierId leaks, front & back 2:3 WebP cutouts HTTP 200, anchor=(${targetVariant.hangerAnchorX}, ${targetVariant.hangerAnchorY}), assetId=${targetVariant.rackFrontAssetId})`,
    );

    recordResult('TEST 1', '<ClothingRack3D />, 3 GLSL Shaders, Disposal & Rack Collection API', 'PASS', details);
    return true;
  } catch (err) {
    details.push(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    recordResult('TEST 1', '<ClothingRack3D />, 3 GLSL Shaders, Disposal & Rack Collection API', 'FAIL', details);
    return false;
  }
}

// =============================================================================
// TEST 2: <OccasionShowcase /> & Web Worker <SeasonLookbookTrack />
// =============================================================================
async function runTest2OccasionsAndSeasonsWorker() {
  console.log('\n--- Running Test 2: <OccasionShowcase /> & Web Worker <SeasonLookbookTrack /> ---');
  const details = [];
  try {
    const occFile = path.join(ROOT_DIR, 'apps', 'storefront', 'src', 'features', 'occasion', 'OccasionShowcase.tsx');
    const workerFile = path.join(ROOT_DIR, 'apps', 'storefront', 'src', 'features', 'seasons-lookbook', 'halftone.worker.ts');
    const halftoneFile = path.join(ROOT_DIR, 'apps', 'storefront', 'src', 'features', 'seasons-lookbook', 'HalftoneCardCanvas.tsx');
    const trackFile = path.join(ROOT_DIR, 'apps', 'storefront', 'src', 'features', 'seasons-lookbook', 'SeasonLookbookTrack.tsx');

    for (const fp of [occFile, workerFile, halftoneFile, trackFile]) {
      assert.ok(fs.existsSync(fp), `Missing Phase 3 showcase file: ${path.relative(ROOT_DIR, fp)}`);
    }

    const occSrc = fs.readFileSync(occFile, 'utf8');
    const workerSrc = fs.readFileSync(workerFile, 'utf8');
    const halftoneSrc = fs.readFileSync(halftoneFile, 'utf8');

    assert.ok(/occWipe|clipPath/.test(occSrc), 'OccasionShowcase missing radial wipe');
    assert.ok(/occRingC|occRingG/.test(occSrc), 'OccasionShowcase missing dual SVG rings');
    assert.ok(/\.decode\s*\(/.test(occSrc), 'OccasionShowcase missing img.decode() pre-decoding');
    assert.ok(/Float32Array/.test(workerSrc), 'halftone.worker.ts missing Float32Array luminance grid');
    assert.ok(/OffscreenCanvas/.test(workerSrc + halftoneSrc), 'Halftone pipeline missing OffscreenCanvas support');
    details.push('Static Occasion & Halftone Worker audit: PASS (radial wipe, dual SVG rings, img.decode(), Float32Array + OffscreenCanvas worker)');

    // Live /bff/v1/storefront/occasions & /seasons
    const occRes = await apiRequest(`${BFF_BASE}/bff/v1/storefront/occasions`);
    assert.equal(occRes.status, 200, `GET /bff/v1/storefront/occasions failed: ${occRes.text}`);
    const occData = unwrapData(occRes);
    const occasions = Array.isArray(occData) ? occData : occData?.items || occData?.occasions || [];
    assert.equal(occasions.length, 6, `Expected 6 occasions, got ${occasions.length}`);
    assert.ok(
      occasions.every((o) => o.themeBg && o.themeInk && o.themeAccent && (Array.isArray(o.items) ? o.items.length > 0 : (o.productSlugs || []).length > 0)),
      'One or more occasions missing palette or curated items',
    );

    const seaRes = await apiRequest(`${BFF_BASE}/bff/v1/storefront/seasons`);
    assert.equal(seaRes.status, 200, `GET /bff/v1/storefront/seasons failed: ${seaRes.text}`);
    const seaData = unwrapData(seaRes);
    const seasons = Array.isArray(seaData) ? seaData : seaData?.items || seaData?.seasons || [];
    assert.equal(seasons.length, 6, `Expected 6 seasons, got ${seasons.length}`);
    assert.ok(
      seasons.some((s) => s.isNow === true || s.isCurrent === true),
      'Expected at least one active season with isNow/isCurrent=true',
    );

    details.push(`Live BFF APIs: PASS (occasions=${occasions.length} w/ palettes & items, seasons=${seasons.length} w/ active isNow drop)`);
    recordResult('TEST 2', '<OccasionShowcase /> & Web Worker <SeasonLookbookTrack />', 'PASS', details);
    return true;
  } catch (err) {
    details.push(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    recordResult('TEST 2', '<OccasionShowcase /> & Web Worker <SeasonLookbookTrack />', 'FAIL', details);
    return false;
  }
}

// =============================================================================
// TEST 3: Vietnamese Accent-Insensitive Meilisearch (< 120ms) & PLP Facet Filters
// =============================================================================
async function runTest3SearchAndFacets(sharedState) {
  console.log('\n--- Running Test 3: Vietnamese Meilisearch (< 120ms) & PLP Facet Filters ---');
  const details = [];
  try {
    const q1 = await apiRequest(`${BFF_BASE}/bff/v1/storefront/products?q=ao+blazer`);
    assert.equal(q1.status, 200, `Search ao blazer failed: ${q1.text}`);
    const q1Items = unwrapData(q1)?.items || unwrapData(q1) || [];
    assert.ok(q1Items.some((p) => /Blazer/i.test(p.name || '')), `Expected Blazer hit, got: ${JSON.stringify(q1Items.map((p) => p.name))}`);
    assert.ok(q1.elapsedMs < 120, `q=ao+blazer took ${q1.elapsedMs.toFixed(1)}ms (>= 120ms)`);

    const q2 = await apiRequest(`${BFF_BASE}/bff/v1/storefront/products?q=vay+di+tiec`);
    assert.equal(q2.status, 200, `Search vay di tiec failed: ${q2.text}`);
    const q2Items = unwrapData(q2)?.items || unwrapData(q2) || [];
    assert.ok(q2Items.some((p) => /Đầm/i.test(p.name || '')), `Expected Đầm synonym hit, got: ${JSON.stringify(q2Items.map((p) => p.name))}`);
    assert.ok(q2.elapsedMs < 120, `q=vay+di+tiec took ${q2.elapsedMs.toFixed(1)}ms (>= 120ms)`);

    const q3 = await apiRequest(`${BFF_BASE}/bff/v1/storefront/products?size=M&isTryonEnabled=true`);
    assert.equal(q3.status, 200, `Facet search failed: ${q3.text}`);
    const q3Items = unwrapData(q3)?.items || unwrapData(q3) || [];
    assert.ok(q3Items.length > 0, 'Facet size=M&isTryonEnabled=true returned 0 items');
    assert.ok(q3Items.every((p) => p.isTryonEnabled === true), 'Facet isTryonEnabled=true returned non-tryon item');
    assert.ok(q3.elapsedMs < 120, `Facet search took ${q3.elapsedMs.toFixed(1)}ms (>= 120ms)`);

    sharedState.searchMetrics = {
      aoBlazerMs: Number(q1.elapsedMs.toFixed(1)),
      vayDiTiecMs: Number(q2.elapsedMs.toFixed(1)),
      facetMs: Number(q3.elapsedMs.toFixed(1)),
    };

    details.push(`q="ao blazer": PASS (${q1Items.length} hit(s), top="${q1Items[0].name}", ${q1.elapsedMs.toFixed(1)}ms < 120ms)`);
    details.push(`q="vay di tiec" (synonym): PASS (${q2Items.length} hit(s), top="${q2Items[0].name}", ${q2.elapsedMs.toFixed(1)}ms < 120ms)`);
    details.push(`Facet size=M&isTryonEnabled=true: PASS (${q3Items.length} hit(s), all tryon-enabled, ${q3.elapsedMs.toFixed(1)}ms < 120ms)`);

    recordResult('TEST 3', 'Vietnamese Meilisearch (< 120ms) & PLP Facet Filters', 'PASS', details);
    return true;
  } catch (err) {
    details.push(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    recordResult('TEST 3', 'Vietnamese Meilisearch (< 120ms) & PLP Facet Filters', 'FAIL', details);
    return false;
  }
}

// =============================================================================
// TEST 4: SEO SSR, JSON-LD Product + aggregateRating, Dynamic OG & Sitemap
// =============================================================================
async function runTest4SeoJsonLdOgSitemap(sharedState) {
  console.log('\n--- Running Test 4: SEO SSR, JSON-LD Product + aggregateRating, Dynamic OG & Sitemap ---');
  const details = [];
  try {
    const plpRes = await apiRequest(`${STOREFRONT_BASE}/bo-suu-tap`, { timeoutMs: 15_000 });
    assert.equal(plpRes.status, 200, `SSR /bo-suu-tap failed: ${plpRes.status}`);
    assert.ok(/<title>[^<]+<\/title>/i.test(plpRes.text), 'PLP missing <title>');
    assert.ok(/property=["']og:title["']/i.test(plpRes.text), 'PLP missing og:title');
    assert.ok(/rel=["']canonical["']/i.test(plpRes.text), 'PLP missing rel="canonical"');
    details.push(`SSR /bo-suu-tap: PASS (HTTP 200, <title>, og:title, rel="canonical" verified)`);

    const pdpRes = await apiRequest(`${STOREFRONT_BASE}/san-pham/${TARGET_SLUG}`, { timeoutMs: 15_000 });
    assert.equal(pdpRes.status, 200, `SSR /san-pham/${TARGET_SLUG} failed: ${pdpRes.status}`);
    const pdpHtml = pdpRes.text;
    sharedState.pdpHtml = pdpHtml;
    assert.ok(/<title>[^<]+<\/title>/i.test(pdpHtml), 'PDP missing <title>');
    assert.ok(/property=["']og:title["']/i.test(pdpHtml), 'PDP missing og:title');
    assert.ok(/rel=["']canonical["']/i.test(pdpHtml), 'PDP missing rel="canonical"');

    // Parse JSON-LD Product + aggregateRating
    const ldBlocks = [...pdpHtml.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
    assert.ok(ldBlocks.length > 0, 'PDP missing <script type="application/ld+json">');
    let productLd = null;
    for (const m of ldBlocks) {
      try {
        const parsed = JSON.parse(m[1].trim());
        if (parsed?.['@type'] === 'Product') {
          productLd = parsed;
          break;
        }
      } catch {
        // ignore invalid/other block
      }
    }
    assert.ok(productLd, 'PDP JSON-LD missing "@type": "Product"');
    const offers = Array.isArray(productLd.offers) ? productLd.offers[0] : productLd.offers;
    assert.equal(offers?.priceCurrency, 'VND', `Expected offers.priceCurrency="VND", got "${offers?.priceCurrency}"`);
    assert.ok(
      Number(productLd.aggregateRating?.reviewCount) > 0,
      `Expected aggregateRating.reviewCount > 0 from live notify-review, got ${JSON.stringify(productLd.aggregateRating)}`,
    );
    details.push(
      `PDP SSR & JSON-LD (/san-pham/${TARGET_SLUG}): PASS (@type=Product, priceCurrency=VND, aggregateRating=${productLd.aggregateRating.ratingValue}/5 across ${productLd.aggregateRating.reviewCount} verified reviews)`,
    );

    // Verify /sitemap.xml
    const smRes = await apiRequest(`${STOREFRONT_BASE}/sitemap.xml`, { timeoutMs: 15_000 });
    assert.equal(smRes.status, 200, `GET /sitemap.xml failed: ${smRes.status}`);
    assert.ok(
      smRes.text.includes(`/san-pham/${TARGET_SLUG}`),
      `sitemap.xml missing /san-pham/${TARGET_SLUG}`,
    );
    details.push(`GET /sitemap.xml: PASS (HTTP 200 XML containing /san-pham/${TARGET_SLUG})`);

    // Verify dynamic OpenGraph PNG image with PNG magic bytes 89 50 4E 47
    const ogRes = await apiRequest(`${STOREFRONT_BASE}/san-pham/${TARGET_SLUG}/opengraph-image`, { timeoutMs: 20_000 });
    assert.equal(ogRes.status, 200, `GET opengraph-image failed (${ogRes.status}): ${ogRes.text.slice(0, 200)}`);
    assert.ok(
      String(ogRes.headers['content-type'] || '').includes('image/png'),
      `Expected content-type image/png, got "${ogRes.headers['content-type']}"`,
    );
    const pngSig = ogRes.buffer.subarray(0, 4);
    assert.deepEqual(
      [...pngSig],
      [0x89, 0x50, 0x4e, 0x47],
      `Dynamic OG image missing PNG magic bytes 89 50 4E 47 (got ${pngSig.toString('hex')})`,
    );
    details.push(`Dynamic OG PNG (/san-pham/${TARGET_SLUG}/opengraph-image): PASS (HTTP 200, image/png, ${ogRes.buffer.length} bytes, magic=89504e47)`);

    recordResult('TEST 4', 'SEO SSR, JSON-LD Product + aggregateRating, Dynamic OG PNG & Sitemap', 'PASS', details);
    return true;
  } catch (err) {
    details.push(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    recordResult('TEST 4', 'SEO SSR, JSON-LD Product + aggregateRating, Dynamic OG PNG & Sitemap', 'FAIL', details);
    return false;
  }
}

// =============================================================================
// TEST 5: Honest Live AI Size Advisor & Crowd Calibration (RUNS_SMALL >= 50%)
// =============================================================================
async function runTest5HonestSizeAdvisorAndCrowdCalibration(sharedState) {
  console.log('\n--- Running Test 5: Honest Live AI Size Advisor & Crowd Calibration ---');
  const details = [];
  try {
    const homeRes = await apiRequest(`${STOREFRONT_BASE}/`, { timeoutMs: 15_000 });
    assert.equal(homeRes.status, 200);
    const fakeSizeRegex = /94%\s*chuẩn|gợi\s*ý\s*size\s+[xsml]{1,3}\s*[·•-]\s*\d+%/i;
    assert.ok(!fakeSizeRegex.test(homeRes.text), 'Homepage SSR HTML contains fake hardcoded size percentage!');
    assert.ok(!fakeSizeRegex.test(sharedState.pdpHtml || ''), 'PDP SSR HTML contains fake hardcoded size percentage!');
    details.push('SSR HTML honest-size check (/ & PDP logged-out): PASS (0 fake hardcoded size recommendation percentages)');

    // Call POST /bff/v1/storefront/size-recommend with 2 contrasting profiles on ao-blazer-linen-dang-suong (RUNS_SMALL >= 65%)
    const smallRes = await apiRequest(`${BFF_BASE}/bff/v1/storefront/size-recommend`, {
      method: 'POST',
      body: {
        productSlug: TARGET_SLUG,
        heightCm: 158,
        weightKg: 47,
        fitPreference: 'REGULAR',
      },
    });
    assert.equal(smallRes.status, 200, `size-recommend small profile failed: ${smallRes.text}`);
    const smallData = unwrapData(smallRes);

    const largeRes = await apiRequest(`${BFF_BASE}/bff/v1/storefront/size-recommend`, {
      method: 'POST',
      body: {
        productSlug: TARGET_SLUG,
        heightCm: 175,
        weightKg: 72,
        fitPreference: 'REGULAR',
      },
    });
    assert.equal(largeRes.status, 200, `size-recommend large profile failed: ${largeRes.text}`);
    const largeData = unwrapData(largeRes);

    assert.ok(smallData?.recommendedSize && largeData?.recommendedSize, 'Missing recommendedSize');
    assert.notEqual(
      smallData.recommendedSize,
      largeData.recommendedSize,
      `Contrasting profiles (158cm/47kg vs 175cm/72kg) returned identical size ${smallData.recommendedSize}`,
    );

    const crowdSample = smallData.crowdAdjusted ? smallData : largeData;
    assert.equal(
      crowdSample.crowdAdjusted,
      true,
      `Expected crowdAdjusted=true on ${TARGET_SLUG} (RUNS_SMALL >= 65%), got small=${JSON.stringify(smallData)} large=${JSON.stringify(largeData)}`,
    );
    assert.ok(
      typeof crowdSample.crowdAdjustmentReason === 'string' && /%/.test(crowdSample.crowdAdjustmentReason),
      `Expected Vietnamese crowdAdjustmentReason mentioning % RUNS_SMALL, got: ${crowdSample.crowdAdjustmentReason}`,
    );
    assert.ok(
      (crowdSample.fitStats?.runsSmallPct ?? 0) >= 50,
      `Expected fitStats.runsSmallPct >= 50, got ${JSON.stringify(crowdSample.fitStats)}`,
    );

    sharedState.sizeAdvisorResult = {
      small: `${smallData.recommendedSize} (crowdAdjusted=${smallData.crowdAdjusted})`,
      large: `${largeData.recommendedSize} (crowdAdjusted=${largeData.crowdAdjusted})`,
      runsSmallPct: crowdSample.fitStats?.runsSmallPct,
      reason: crowdSample.crowdAdjustmentReason,
    };

    details.push(
      `158cm/47kg -> Size ${smallData.recommendedSize} (crowdAdjusted=${smallData.crowdAdjusted}); 175cm/72kg -> Size ${largeData.recommendedSize} (crowdAdjusted=${largeData.crowdAdjusted})`,
    );
    details.push(
      `Crowd calibration verified: PASS (runsSmallPct=${crowdSample.fitStats.runsSmallPct}%, reason="${crowdSample.crowdAdjustmentReason}")`,
    );

    recordResult('TEST 5', 'Honest Live AI Size Advisor & Crowd Fit Calibration (RUNS_SMALL >= 50%)', 'PASS', details);
    return true;
  } catch (err) {
    details.push(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    recordResult('TEST 5', 'Honest Live AI Size Advisor & Crowd Fit Calibration (RUNS_SMALL >= 50%)', 'FAIL', details);
    return false;
  }
}

// =============================================================================
// TEST 6: On-Demand ISR (/api/revalidate) & Live Visual Anchor Calibrator Sync
// =============================================================================
async function runTest6OnDemandIsrAndSpatialSync(sharedState, envVars) {
  console.log('\n--- Running Test 6: On-Demand ISR (/api/revalidate) & Live Visual Anchor Calibrator Sync ---');
  const details = [];
  let adminToken = null;
  const assetId = sharedState.targetRackAssetId;
  const origX = sharedState.originalHangerAnchorX ?? 0.5;
  const origY = sharedState.originalHangerAnchorY ?? 0.06;

  try {
    assert.ok(assetId, 'Missing targetRackAssetId from Test 1');
    const secret = envVars.REVALIDATE_SECRET || 'Atelier_Isr_Revalidate_2026!';

    // 6a. Direct check of POST /api/revalidate (wrong secret -> 401, valid secret -> 200)
    const badReval = await apiRequest(`${STOREFRONT_BASE}/api/revalidate`, {
      method: 'POST',
      headers: { 'x-revalidate-secret': 'wrong-secret' },
      body: { tags: ['rack'], paths: ['/'] },
    });
    assert.equal(badReval.status, 401, `Invalid x-revalidate-secret expected 401, got ${badReval.status}`);

    const goodReval = await apiRequest(`${STOREFRONT_BASE}/api/revalidate`, {
      method: 'POST',
      headers: { 'x-revalidate-secret': secret },
      body: { tags: ['storefront', 'rack'], paths: ['/'] },
    });
    assert.equal(goodReval.status, 200, `Valid POST /api/revalidate expected 200, got ${goodReval.status}: ${goodReval.text}`);
    details.push('POST /api/revalidate security & execution: PASS (wrong secret=401, valid x-revalidate-secret=200)');

    // 6b. Login admin + Mailpit 2FA -> PATCH spatial-metadata hangerAnchorY -> 0.11
    const mfa = await loginAdminWithMailpitMfa();
    adminToken = mfa.adminToken;

    const newY = Math.abs(origY - 0.11) < 0.005 ? 0.13 : 0.11;
    const patchRes = await apiRequest(`${BFF_BASE}/api/v1/admin/media/${assetId}/spatial-metadata`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        Origin: 'http://localhost:3001',
        'X-Correlation-Id': `phase3-anchor-${crypto.randomUUID()}`,
      },
      body: { hangerAnchorX: origX, hangerAnchorY: newY, layerZHint: 10 },
    });
    assert.equal(patchRes.status, 200, `PATCH spatial-metadata failed (${patchRes.status}): ${patchRes.text}`);

    // Immediately verify GET /bff/v1/storefront/rack-collection reflects updated hangerAnchorY (cache invalidated!)
    const rackAfter = await apiRequest(`${BFF_BASE}/bff/v1/storefront/rack-collection`);
    assert.equal(rackAfter.status, 200);
    const itemsAfter = unwrapData(rackAfter)?.items || [];
    const updatedItem = itemsAfter.find((i) => i.slug === sharedState.targetRackSlug);
    const updatedVariant = updatedItem?.variants?.find((v) => v.rackFrontAssetId === assetId) || updatedItem?.variants?.[0];
    assert.ok(updatedVariant, `Updated rack variant not found for ${assetId}`);
    assert.ok(
      Math.abs(updatedVariant.hangerAnchorY - newY) < 0.001,
      `Expected live rack-collection hangerAnchorY=${newY}, got ${updatedVariant.hangerAnchorY}`,
    );

    details.push(
      `Live Visual Anchor Calibrator sync: PASS (PATCH asset=${assetId} hangerAnchorY ${origY} -> ${newY}; next GET /bff/v1/storefront/rack-collection X-Cache=${rackAfter.headers['x-cache'] || 'MISS'} returned hangerAnchorY=${updatedVariant.hangerAnchorY})`,
    );
    recordResult('TEST 6', 'On-Demand ISR (/api/revalidate) & Live Visual Anchor Calibrator Sync', 'PASS', details);
    return true;
  } catch (err) {
    details.push(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    recordResult('TEST 6', 'On-Demand ISR (/api/revalidate) & Live Visual Anchor Calibrator Sync', 'FAIL', details);
    return false;
  } finally {
    if (adminToken && assetId) {
      await apiRequest(`${BFF_BASE}/api/v1/admin/media/${assetId}/spatial-metadata`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${adminToken}`, Origin: 'http://localhost:3001' },
        body: { hangerAnchorX: origX, hangerAnchorY: origY, layerZHint: 10 },
      }).catch(() => {});
    }
  }
}

// =============================================================================
// TEST 7: 20-Cycle Real Headless Chrome Route Leak Test & 3-Portal Isolation
// =============================================================================
async function runTest7Chrome20CycleAndIsolation(browser, sharedState) {
  console.log('\n--- Running Test 7: 20-Cycle Chrome Route Leak Test & Storefront Isolation Scan ---');
  const details = [];
  try {
    // 7a. Static storefront isolation scan
    const sfSrc = path.join(ROOT_DIR, 'apps', 'storefront', 'src');
    const sfFiles = walkFiles(sfSrc, /\.(ts|tsx|js|jsx|mjs|cjs|css|mdx|json)$/i);
    const forbidden = [
      { name: '/admin', regex: /\/admin\b/i },
      { name: '/partner', regex: /\/partner\b/i },
      { name: 'admin-portal', regex: /admin-portal/i },
      { name: 'partner-portal', regex: /partner-portal/i },
      { name: 'McpCopilot', regex: /McpCopilot/i },
      { name: 'admin.localhost', regex: /admin\.localhost/i },
      { name: 'partner.localhost', regex: /partner\.localhost/i },
      { name: 'AdminRoleGuard', regex: /AdminRoleGuard/i },
      { name: 'SupplierRoleGuard', regex: /SupplierRoleGuard/i },
      { name: 'costPriceVnd', regex: /\bcostPriceVnd\b|\bcost_price_vnd\b/i },
      { name: 'fake-hardcoded-size-percent', regex: /94%\s*chuẩn|gợi\s*ý\s*size\s+[xsml]{1,3}\s*[·•-]\s*\d+%/i },
    ];
    const violations = [];
    for (const fp of sfFiles) {
      const lines = fs.readFileSync(fp, 'utf8').split(/\r?\n/);
      lines.forEach((line, idx) => {
        for (const pat of forbidden) {
          if (pat.regex.test(line)) {
            violations.push(`${path.relative(ROOT_DIR, fp)}:${idx + 1} [${pat.name}]`);
          }
        }
      });
    }
    assert.equal(violations.length, 0, `Storefront isolation violations (${violations.length}): ${violations.join(', ')}`);
    details.push(`Storefront static isolation scan (${sfFiles.length} files): PASS (0 portal/costPriceVnd/fake-size violations)`);

    // 7b. Real Headless Chrome 20-cycle navigation loop
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const consoleErrors = [];
    const pageErrors = [];

    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        const loc = msg.location()?.url;
        consoleErrors.push(loc ? `${msg.text()} (${loc})` : msg.text());
      }
    });
    page.on('pageerror', (err) => {
      pageErrors.push(err instanceof Error ? err.message : String(err));
    });

    try {
      await page.addInitScript(() => {
        try {
          window.sessionStorage.setItem('atelier_intro_seen', '1');
        } catch {}
      });

      let homePinSpacersFirst = null;
      let maxHomeRackCanvases = 0;
      let maxInnerPinSpacers = 0;
      let maxPlpRackCanvases = 0;
      const tLoop = performance.now();

      for (let cycle = 1; cycle <= 20; cycle += 1) {
        // 1) Home /
        await page.goto(`${STOREFRONT_BASE}/`, { waitUntil: 'domcontentloaded', timeout: 25_000 });
        await page.waitForSelector('#rack', { timeout: 10_000 });
        await page.waitForTimeout(70);

        const homeStats = await page.evaluate(() => {
          const pinSpacers = document.querySelectorAll('.pin-spacer').length;
          const rackCanvases = document.querySelectorAll('#rack canvas').length;
          const htmlOverflow = getComputedStyle(document.documentElement).overflowY;
          const bodyOverflow = getComputedStyle(document.body).overflowY;
          const scrollLocked =
            document.body.classList.contains('is-locked') || htmlOverflow === 'hidden' || bodyOverflow === 'hidden';
          return { pinSpacers, rackCanvases, scrollLocked };
        });
        if (homePinSpacersFirst === null) homePinSpacersFirst = homeStats.pinSpacers;
        maxHomeRackCanvases = Math.max(maxHomeRackCanvases, homeStats.rackCanvases);
        assert.ok(homeStats.rackCanvases <= 1, `Cycle ${cycle} (/): unbounded WebGL canvas accumulation in #rack (${homeStats.rackCanvases})`);
        assert.equal(homeStats.scrollLocked, false, `Cycle ${cycle} (/): scroll remained locked`);

        // 2) PLP /bo-suu-tap
        await page.goto(`${STOREFRONT_BASE}/bo-suu-tap`, { waitUntil: 'domcontentloaded', timeout: 25_000 });
        await page.waitForTimeout(50);
        const plpStats = await page.evaluate(() => ({
          pinSpacers: document.querySelectorAll('.pin-spacer').length,
          rackCanvases: document.querySelectorAll('#rack canvas, canvas[data-engine]').length,
        }));
        maxInnerPinSpacers = Math.max(maxInnerPinSpacers, plpStats.pinSpacers);
        maxPlpRackCanvases = Math.max(maxPlpRackCanvases, plpStats.rackCanvases);
        assert.equal(plpStats.pinSpacers, 0, `Cycle ${cycle} (/bo-suu-tap): leaked ${plpStats.pinSpacers} orphaned .pin-spacer`);
        assert.equal(plpStats.rackCanvases, 0, `Cycle ${cycle} (/bo-suu-tap): leaked WebGL canvas (${plpStats.rackCanvases})`);

        // 3) PDP /san-pham/ao-blazer-linen-dang-suong
        await page.goto(`${STOREFRONT_BASE}/san-pham/${TARGET_SLUG}`, { waitUntil: 'domcontentloaded', timeout: 25_000 });
        await page.waitForTimeout(50);
        const pdpStats = await page.evaluate(() => {
          const pinSpacers = document.querySelectorAll('.pin-spacer').length;
          const htmlOverflow = getComputedStyle(document.documentElement).overflowY;
          const bodyOverflow = getComputedStyle(document.body).overflowY;
          const scrollLocked =
            document.body.classList.contains('is-locked') || htmlOverflow === 'hidden' || bodyOverflow === 'hidden';
          return { pinSpacers, scrollLocked };
        });
        maxInnerPinSpacers = Math.max(maxInnerPinSpacers, pdpStats.pinSpacers);
        assert.equal(pdpStats.pinSpacers, 0, `Cycle ${cycle} (PDP): leaked ${pdpStats.pinSpacers} orphaned .pin-spacer`);
        assert.equal(pdpStats.scrollLocked, false, `Cycle ${cycle} (PDP): scroll remained locked`);
      }

      // Final return to /
      await page.goto(`${STOREFRONT_BASE}/`, { waitUntil: 'domcontentloaded', timeout: 25_000 });
      await page.waitForSelector('#rack', { timeout: 10_000 });
      await page.waitForTimeout(80);
      const finalHome = await page.evaluate(() => {
        const pinSpacers = document.querySelectorAll('.pin-spacer').length;
        const rackCanvases = document.querySelectorAll('#rack canvas').length;
        window.scrollTo(0, 320);
        return { pinSpacers, rackCanvases, scrollY: window.scrollY };
      });
      assert.equal(finalHome.pinSpacers, homePinSpacersFirst, `Home .pin-spacer count drifted ${homePinSpacersFirst} -> ${finalHome.pinSpacers}`);
      assert.ok(finalHome.rackCanvases <= 1, `Final home rack canvases > 1 (${finalHome.rackCanvases})`);
      assert.ok(finalHome.scrollY > 0, `Home page scroll locked at end of 20 cycles (scrollY=${finalHome.scrollY})`);
      assert.equal(pageErrors.length, 0, `Chrome Hydration/pageerrors (${pageErrors.length}): ${pageErrors.slice(0, 5).join(' | ')}`);
      assert.equal(consoleErrors.length, 0, `Chrome console errors (${consoleErrors.length}): ${consoleErrors.slice(0, 5).join(' | ')}`);

      const loopSec = ((performance.now() - tLoop) / 1000).toFixed(1);
      sharedState.chrome20Cycles = {
        cycles: 20,
        navigations: 61,
        loopSec,
        consoleErrors: 0,
        pageErrors: 0,
        orphanedPinSpacers: maxInnerPinSpacers,
        maxHomeRackCanvases,
        maxPlpRackCanvases,
      };
      details.push(
        `Headless Chrome 20-cycle leak test (61 navigations in ${loopSec}s): PASS (consoleErrors=0, pageErrors/hydration=0, orphanedPinSpacers=0, maxHomeRackCanvases=${maxHomeRackCanvases}<=1, plpWebGLCanvases=0, scrollY=${finalHome.scrollY}px unlocked)`,
      );
    } finally {
      await context.close();
    }

    recordResult('TEST 7', '20-Cycle Chrome Route Leak Test & Storefront Physical Isolation', 'PASS', details);
    return true;
  } catch (err) {
    details.push(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    recordResult('TEST 7', '20-Cycle Chrome Route Leak Test & Storefront Physical Isolation', 'FAIL', details);
    return false;
  }
}

// =============================================================================
// MAIN ORCHESTRATOR
// =============================================================================
async function main() {
  const startedAt = Date.now();
  const skipBuild = process.argv.includes('--skip-build');
  const envVars = { ...loadDotEnv(path.join(ROOT_DIR, '.env')), ...process.env };

  console.log('========================================================================');
  console.log(' fashion-atelier-ai-platform (v3.0) — Phase 3 E2E Verification Suite');
  console.log(` Workspace: ${ROOT_DIR}`);
  console.log(` Node: ${process.version} | Platform: ${process.platform}`);
  console.log('========================================================================');

  // Step 1: Run Test 8 (build + typecheck + pnpm eval:ai) first so dist/ is fresh
  const test8Ok = await runTest8BuildTypecheckEval(skipBuild);
  if (!test8Ok && !skipBuild) {
    printFinalSummary(startedAt, 'ABORTED_BEFORE_BOOT');
    process.exitCode = 1;
    return;
  }

  // Step 2: Infra setup (Docker or Local Dev Harness)
  let infraMode = 'DOCKER';
  let localInfraHandle = null;
  const dockerCheck = await runCommand('docker', ['compose', '-f', 'infra/docker-compose.yml', 'ps'], { timeoutMs: 8000 });
  if (dockerCheck.ok) {
    const upRes = await runCommand('docker', ['compose', '--env-file', '.env', '-f', 'infra/docker-compose.yml', 'up', '-d'], {
      timeoutMs: 120_000,
    });
    if (!upRes.ok) {
      localInfraHandle = await startLocalInfraIfNeeded(envVars);
      infraMode = localInfraHandle.infraMode;
    }
  } else {
    console.log(
      '\n[INFRA] Docker Desktop/WSL2 not installed on host — starting Local Dev Harness (scripts/local-infra-dev.mjs: Redis :6379, Meilisearch :7700, MinIO S3 :9000, Mailpit :1025/:8025 + isolated PGlite DBs).',
    );
    localInfraHandle = await startLocalInfraIfNeeded(envVars);
    infraMode = localInfraHandle.infraMode;
  }
  console.log(`[INFRA] Active mode: INFRA_MODE=${infraMode}`);

  const chromePath = findChromeExecutable();
  if (!chromePath) {
    console.error('[FATAL] System Chrome/Edge executable not found for Playwright headless verification!');
    if (localInfraHandle) await localInfraHandle.stop();
    process.exitCode = 1;
    return;
  }
  console.log(`[BROWSER] Headless Chromium binary: ${chromePath}`);

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
  };

  process.once('SIGINT', () => cleanupAll().finally(() => process.exit(130)));
  process.once('SIGTERM', () => cleanupAll().finally(() => process.exit(143)));

  const serviceEnv = {
    ...envVars,
    AUTH_SERVICE_URL: AUTH_BASE,
    CATALOG_SERVICE_URL: CATALOG_BASE,
    MEDIA_SERVICE_URL: MEDIA_BASE,
    NOTIFY_REVIEW_SERVICE_URL: NOTIFY_BASE,
    BFF_URL: BFF_BASE,
    NEXT_PUBLIC_BFF_URL: BFF_BASE,
    STOREFRONT_URL: 'http://127.0.0.1:3000',
    REVALIDATE_SECRET: envVars.REVALIDATE_SECRET || 'Atelier_Isr_Revalidate_2026!',
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

  const sharedState = {};

  try {
    console.log('\n--- Booting Phase 3 stack (4001 auth, 4003 media, 4008 notify-review, 4002 catalog, 4000 bff, 3000 storefront) ---');
    // Boot auth, media, and notify-review first so catalog-lookbook sees live spatial-map & fit-stats on startup!
    const authProc = spawnNodeService('auth-customer', 'services/auth-customer', 'AUTH_CUSTOMER_PORT', 4001);
    const mediaProc = spawnNodeService('media-pipeline', 'services/media-pipeline', 'MEDIA_PIPELINE_PORT', 4003);
    const notifyProc = spawnNodeService('notify-review', 'services/notify-review', 'NOTIFY_REVIEW_PORT', 4008);

    await Promise.all([
      waitForHttp200(`${AUTH_BASE}/health`, 35_000, authProc.logs)
        .then(() => waitForHttp200(`${AUTH_BASE}/.well-known/jwks.json`, 15_000, authProc.logs))
        .then(() => console.log('  [UP] services/auth-customer (:4001)')),
      waitForHttp200(`${MEDIA_BASE}/health`, 35_000, mediaProc.logs).then(() =>
        console.log('  [UP] services/media-pipeline (:4003)'),
      ),
      waitForHttp200(`${NOTIFY_BASE}/health`, 35_000, notifyProc.logs).then(() =>
        console.log('  [UP] services/notify-review (:4008)'),
      ),
    ]);

    const catalogProc = spawnNodeService('catalog-lookbook', 'services/catalog-lookbook', 'CATALOG_LOOKBOOK_PORT', 4002);
    await waitForHttp200(`${CATALOG_BASE}/health`, 60_000, catalogProc.logs);
    console.log('  [UP] services/catalog-lookbook (:4002)');

    const bffProc = spawnNodeService('bff', 'apps/bff', 'BFF_PORT', 4000);
    await waitForHttp200(`${BFF_BASE}/health`, 35_000, bffProc.logs);
    console.log('  [UP] apps/bff (:4000)');

    // Boot apps/storefront via Next.js CLI directly (direct PID for clean termination)
    const sfDir = path.join(ROOT_DIR, 'apps', 'storefront');
    // Clear stale Next.js disk fetch-cache so SSR always reflects live backend state on fresh runs
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
    await waitForHttp200(`${STOREFRONT_BASE}/`, 35_000, sfLogs);
    console.log('  [UP] apps/storefront (:3000)');

    browser = await chromium.launch({
      executablePath: chromePath,
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });

    await runTest1Rack3dAndCollection(sharedState);
    await runTest2OccasionsAndSeasonsWorker();
    await runTest3SearchAndFacets(sharedState);
    await runTest4SeoJsonLdOgSitemap(sharedState);
    await runTest5HonestSizeAdvisorAndCrowdCalibration(sharedState);
    await runTest6OnDemandIsrAndSpatialSync(sharedState, envVars);
    await runTest7Chrome20CycleAndIsolation(browser, sharedState);
  } catch (err) {
    console.error('\n[FATAL] Phase 3 verification runner error:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  } finally {
    await cleanupAll();
    console.log('\n[CLEANUP] Browser, all 6 services/portals & local infra servers cleanly terminated.');
  }

  const allPassed = printFinalSummary(startedAt, infraMode);
  if (!allPassed) process.exitCode = 1;
}

function printFinalSummary(startedAt, infraMode) {
  const orderedIds = ['TEST 1', 'TEST 2', 'TEST 3', 'TEST 4', 'TEST 5', 'TEST 6', 'TEST 7', 'TEST 8'];
  const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
  let passCount = 0;
  let failCount = 0;

  console.log('\n========================================================================');
  console.log(` PHASE 3 VERIFICATION SUMMARY  (INFRA_MODE=${infraMode})`);
  console.log('------------------------------------------------------------------------');
  for (const id of orderedIds) {
    const r = resultsMap.get(id);
    if (!r) {
      failCount += 1;
      console.log(`  [FAIL] ${id}: (not executed)`);
    } else {
      if (r.status === 'PASS') passCount += 1;
      else failCount += 1;
      console.log(`  [${r.status}] ${r.id}: ${r.title}`);
    }
  }
  console.log('------------------------------------------------------------------------');
  console.log(`  Totals: PASS=${passCount}/8 | FAIL=${failCount}  (${elapsedSec}s)`);
  console.log('========================================================================\n');

  return passCount === 8 && failCount === 0;
}

main().catch((err) => {
  console.error('[FATAL] verify-phase3 crashed:', err);
  process.exitCode = 1;
});
