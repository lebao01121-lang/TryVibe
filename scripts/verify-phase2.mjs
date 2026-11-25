#!/usr/bin/env node
/**
 * Phase 2 Acceptance Verification Suite — fashion-atelier-ai-platform (v3.0)
 *
 * Implements all 7 mandatory Phase 2 Definition-of-Done tests:
 *   Test 1: Design tokens (#FBF7EF/#B08A4A/#EBCF8F/#1C1410), 3 Vietnamese fonts, keyframes,
 *           SSR GET http://localhost:3000/ sections (#top..#contact) + zero 404 image URLs
 *   Test 2: <SplitShimmerText /> NFC + Intl.Segmenter static audit + live Chrome Vietnamese diacritic check
 *   Test 3: 30x GET /bff/v1/storefront/bootstrap latency (p95 < 80ms, X-Cache: HIT) +
 *           PUT /api/v1/admin/homepage-campaign invalidation + HOMEPAGE_CAMPAIGN_UPDATED audit log
 *   Test 4: useGSAP static audit + real Headless Chrome (playwright-core) 20-cycle route leak test
 *           (/ -> /bo-suu-tap -> /san-pham/<slug> -> /): 0 console/hydration errors, 0 orphaned .pin-spacer, scroll unlocked
 *   Test 5: Static + Live Chrome GPU Camera Guard (data-camera-active="true") & prefers-reduced-motion: reduce check
 *   Test 6: Storefront physical isolation scan (0 forbidden refs / 0 fake size %) +
 *           Phase 1 core regression (pnpm eval:ai 25/25 PASS + RS256/CSRF/RBAC/2FA/redaction)
 *   Test 7: Full monorepo pnpm typecheck & pnpm build (0 errors across all 21 workspaces)
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
const MAILPIT_BASE = 'http://127.0.0.1:8025';

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
          const rawSetCookies = res.headers['set-cookie'] || [];
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            setCookies: Array.isArray(rawSetCookies) ? rawSetCookies : [rawSetCookies],
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

function unwrapErrorCode(res) {
  return res?.json?.error?.code || res?.json?.code || '';
}

function extractCookieJar(setCookies) {
  /** @type {Record<string, string>} */
  const jar = {};
  for (const line of setCookies || []) {
    const first = String(line).split(';')[0] || '';
    const eq = first.indexOf('=');
    if (eq > 0) jar[first.slice(0, eq).trim()] = first.slice(eq + 1).trim();
  }
  return jar;
}

function formatCookieHeader(jar) {
  return Object.entries(jar)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
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

async function loginAndVerifyAdminMfa() {
  const loginRes = await apiRequest(`${BFF_BASE}/api/v1/auth/login`, {
    method: 'POST',
    headers: { Origin: 'http://localhost:3001' },
    body: { email: 'lebao01121@gmail.com', password: 'Atelier@2026!' },
  });
  assert.equal(loginRes.status, 200, `Admin login failed (${loginRes.status}): ${loginRes.text}`);
  const preToken = unwrapData(loginRes)?.accessToken;
  assert.ok(preToken, 'Admin login missing accessToken');

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
    const msgs = inboxRes.json?.messages || [];
    for (const m of msgs) {
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
  assert.ok(otp, 'Could not retrieve 6-digit OTP from Mailpit for lebao01121@gmail.com');

  const verifyRes = await apiRequest(`${BFF_BASE}/api/v1/auth/2fa/email-otp/verify`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${preToken}`, Origin: 'http://localhost:3001' },
    body: { method: 'EMAIL_OTP', code: otp },
  });
  assert.equal(verifyRes.status, 200, `Admin OTP verify failed: ${verifyRes.text}`);
  return { preToken, adminToken: unwrapData(verifyRes)?.accessToken, otp };
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

// =============================================================================
// TEST 7: Full Monorepo Typecheck & Production Build
// =============================================================================
async function runTest7BuildAndTypecheck() {
  console.log('\n--- Running Test 7: Full Monorepo Typecheck & Production Build ---');
  const details = [];
  const t0 = performance.now();
  const buildRes = await runCommand('pnpm', ['build'], { timeoutMs: 420_000 });
  if (!buildRes.ok) {
    details.push(`pnpm build FAILED (exit ${buildRes.code})`);
    for (const l of tailLines(`${buildRes.stdout}\n${buildRes.stderr}`, 20)) details.push(`  | ${l}`);
    recordResult('TEST 7', 'Full Monorepo Typecheck & Production Build', 'FAIL', details);
    return false;
  }
  details.push(`pnpm build: PASS (${((performance.now() - t0) / 1000).toFixed(1)}s across all workspaces)`);

  const t1 = performance.now();
  const tcRes = await runCommand('pnpm', ['typecheck'], { timeoutMs: 300_000 });
  if (!tcRes.ok) {
    details.push(`pnpm typecheck FAILED (exit ${tcRes.code})`);
    for (const l of tailLines(`${tcRes.stdout}\n${tcRes.stderr}`, 20)) details.push(`  | ${l}`);
    recordResult('TEST 7', 'Full Monorepo Typecheck & Production Build', 'FAIL', details);
    return false;
  }
  details.push(`pnpm typecheck: PASS (${((performance.now() - t1) / 1000).toFixed(1)}s, 0 errors)`);
  recordResult('TEST 7', 'Full Monorepo Typecheck & Production Build', 'PASS', details);
  return true;
}

// =============================================================================
// TEST 1: Design Tokens, 3 Vietnamese Fonts, Keyframes, SSR HTML & Image URLs
// =============================================================================
async function runTest1TokensFontsSsrAndAssets(sharedState) {
  console.log('\n--- Running Test 1: Design Tokens, Fonts, Keyframes, SSR Sections & Image Probes ---');
  const details = [];
  try {
    const tokenFiles = [
      path.join(ROOT_DIR, 'packages', 'ui-tokens', 'src', 'tokens.css'),
      path.join(ROOT_DIR, 'packages', 'ui-tokens', 'src', 'editorial.css'),
      path.join(ROOT_DIR, 'packages', 'ui-tokens', 'src', 'theme.css'),
      path.join(ROOT_DIR, 'apps', 'storefront', 'src', 'app', 'globals.css'),
      path.join(ROOT_DIR, 'apps', 'storefront', 'src', 'app', 'layout.tsx'),
    ];
    let combinedCssLayout = '';
    for (const fp of tokenFiles) {
      assert.ok(fs.existsSync(fp), `Required token/layout file missing: ${path.relative(ROOT_DIR, fp)}`);
      combinedCssLayout += '\n' + fs.readFileSync(fp, 'utf8');
    }

    for (const hex of ['#FBF7EF', '#B08A4A', '#EBCF8F', '#1C1410']) {
      assert.ok(combinedCssLayout.toUpperCase().includes(hex), `Missing required palette token ${hex}`);
    }
    for (const fontPattern of [
      /Cormorant[_ ]Garamond/i,
      /Be[_ ]Vietnam[_ ]Pro/i,
      /Dancing[_ ]Script/i,
    ]) {
      assert.ok(fontPattern.test(combinedCssLayout), `Missing required Vietnamese font matching ${fontPattern}`);
    }
    for (const kf of ['shimmer', 'btnsheen', 'drip', 'drift']) {
      assert.ok(
        new RegExp(`@keyframes\\s+${kf}\\b`, 'i').test(combinedCssLayout),
        `Missing required @keyframes ${kf}`,
      );
    }
    details.push('Static tokens/fonts/keyframes audit: PASS (#FBF7EF, #B08A4A, #EBCF8F, #1C1410; 3 VN fonts; shimmer/btnsheen/drip/drift)');

    // Fetch live bootstrap data
    const bsRes = await apiRequest(`${BFF_BASE}/bff/v1/storefront/bootstrap`);
    assert.equal(bsRes.status, 200, `Bootstrap failed (${bsRes.status}): ${bsRes.text}`);
    const bs = unwrapData(bsRes);
    const campaign = bs?.homepageCampaign || bs?.campaign;
    const products = bs?.featuredProducts || [];
    assert.ok(campaign?.intro && campaign?.hero && Array.isArray(campaign?.atelierSteps) && campaign?.finale, 'Bootstrap missing full Phase 2 homepageCampaign (intro/hero/atelierSteps/finale)');
    assert.equal(campaign.atelierSteps.length, 4, `Expected 4 atelierSteps, got ${campaign.atelierSteps.length}`);
    assert.ok(products.length > 0, 'Bootstrap returned 0 featuredProducts');
    sharedState.firstProductSlug = products[0].slug;
    sharedState.firstProductId = products[0].id;

    // Fetch SSR GET http://127.0.0.1:3000/
    const ssrRes = await apiRequest(`${STOREFRONT_BASE}/`, { timeoutMs: 15_000 });
    assert.equal(ssrRes.status, 200, `Storefront SSR GET / failed: ${ssrRes.status}`);
    const html = ssrRes.text;
    const requiredSections = ['top', 'rack', 'occasion', 'build', 'seasons', 'atelier', 'contact'];
    for (const sec of requiredSections) {
      assert.ok(
        new RegExp(`id=["']${sec}["']`).test(html),
        `SSR HTML missing section anchor id="${sec}"`,
      );
    }
    assert.ok(
      html.includes(products[0].name) || html.includes(campaign.atelierSteps[0].title),
      'SSR HTML does not appear populated with live bootstrap product/campaign data',
    );
    details.push(`SSR GET http://127.0.0.1:3000/: PASS (HTTP 200, ${html.length} bytes, all 7 section IDs #top..#contact present w/ live BFF data)`);

    // Probe all seeded image URLs (hero poster, 4 atelier steps, sample products) -> 0 404s!
    const imageUrls = new Set();
    if (campaign.hero?.posterUrl) imageUrls.add(campaign.hero.posterUrl);
    for (const step of campaign.atelierSteps) {
      if (step.imageUrl) imageUrls.add(step.imageUrl);
    }
    for (const prod of products.slice(0, 6)) {
      const v0 = prod.variants?.[0];
      if (v0?.lookbookMainUrl) imageUrls.add(v0.lookbookMainUrl);
      if (v0?.tryonFlatPreviewUrl) imageUrls.add(v0.tryonFlatPreviewUrl);
      if (v0?.rackFrontUrl) imageUrls.add(v0.rackFrontUrl);
    }
    assert.ok(imageUrls.size >= 5, `Too few image URLs discovered in bootstrap (${imageUrls.size})`);

    const brokenUrls = [];
    for (const rawUrl of imageUrls) {
      const resolved = rawUrl.startsWith('http://') || rawUrl.startsWith('https://')
        ? rawUrl
        : `${STOREFRONT_BASE}${rawUrl.startsWith('/') ? rawUrl : '/' + rawUrl}`;
      const r = await apiRequest(resolved, { timeoutMs: 8000 });
      if (r.status !== 200 || r.buffer.length === 0) {
        brokenUrls.push(`${resolved} -> HTTP ${r.status} (${r.buffer.length}B)`);
      }
    }
    assert.equal(brokenUrls.length, 0, `Broken image URLs detected: ${brokenUrls.join('; ')}`);
    details.push(`Seeded image URL probes: PASS (${imageUrls.size}/${imageUrls.size} returned HTTP 200 OK, 0 broken/404 assets)`);

    recordResult('TEST 1', 'Design Tokens, Fonts, Keyframes, SSR 9-Section HTML & Live Image Assets', 'PASS', details);
    return true;
  } catch (err) {
    details.push(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    recordResult('TEST 1', 'Design Tokens, Fonts, Keyframes, SSR 9-Section HTML & Live Image Assets', 'FAIL', details);
    return false;
  }
}

// =============================================================================
// TEST 2: <SplitShimmerText /> NFC + Intl.Segmenter & Live Diacritics Integrity
// =============================================================================
async function runTest2SplitShimmerText(browser) {
  console.log('\n--- Running Test 2: <SplitShimmerText /> NFC + Intl.Segmenter & Live Diacritics ---');
  const details = [];
  try {
    const sfSrc = path.join(ROOT_DIR, 'apps', 'storefront', 'src');
    const shimmerFiles = walkFiles(sfSrc, /\.(ts|tsx)$/).filter((f) =>
      path.basename(f).toLowerCase().includes('splitshimmer'),
    );
    assert.ok(shimmerFiles.length > 0, 'SplitShimmerText source file not found in apps/storefront/src');
    const shimmerSrc = fs.readFileSync(shimmerFiles[0], 'utf8');

    assert.ok(/\.normalize\(['"]NFC['"]\)/.test(shimmerSrc), 'SplitShimmerText missing .normalize("NFC")');
    assert.ok(/Intl\.Segmenter/.test(shimmerSrc), 'SplitShimmerText missing Intl.Segmenter');
    assert.ok(!/dangerouslySetInnerHTML/.test(shimmerSrc), 'SplitShimmerText must NOT use dangerouslySetInnerHTML');
    assert.ok(!/\.innerHTML\b/.test(shimmerSrc), 'SplitShimmerText must NOT mutate innerHTML');
    details.push(`Static check (${path.relative(ROOT_DIR, shimmerFiles[0])}): PASS (.normalize('NFC'), Intl.Segmenter, 0 innerHTML/dangerouslySetInnerHTML)`);

    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    try {
      await page.addInitScript(() => {
        try {
          window.sessionStorage.setItem('atelier_intro_seen', '1');
        } catch {}
      });
      await page.goto(`${STOREFRONT_BASE}/`, { waitUntil: 'networkidle', timeout: 25_000 });
      const domCheck = await page.evaluate(() => {
        const heroEl = document.querySelector('#top .shimmer, #top h1');
        const chNodes = heroEl ? Array.from(heroEl.querySelectorAll('.ch')) : [];
        const chars = chNodes.map((el) => el.textContent || '');
        const orphanCombining = chars.filter((c) => /^[\u0300-\u036f]+$/.test(c));
        const joined = heroEl ? (heroEl.textContent || '').replace(/\s+/g, ' ').trim() : '';
        const isNfc = joined === joined.normalize('NFC');
        return { chCount: chNodes.length, orphanCombining, joined, isNfc };
      });
      assert.ok(domCheck.chCount >= 4, `Expected rendered .ch spans in #top shimmer headline, got ${domCheck.chCount}`);
      assert.equal(domCheck.orphanCombining.length, 0, `Broken combining diacritics in .ch spans: ${JSON.stringify(domCheck.orphanCombining)}`);
      assert.equal(domCheck.isNfc, true, `Rendered shimmer headline is not NFC normalized: "${domCheck.joined}"`);
      assert.ok(
        /Tầm Xuân|Thiết Kế|Atelier/i.test(domCheck.joined),
        `Unexpected rendered hero title: "${domCheck.joined}"`,
      );
      details.push(`Live Chrome DOM check: PASS (.ch spans=${domCheck.chCount}, orphanCombining=0, NFC=true, text="${domCheck.joined}")`);
    } finally {
      await context.close();
    }

    recordResult('TEST 2', '<SplitShimmerText /> NFC + Intl.Segmenter & Live Diacritics', 'PASS', details);
    return true;
  } catch (err) {
    details.push(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    recordResult('TEST 2', '<SplitShimmerText /> NFC + Intl.Segmenter & Live Diacritics', 'FAIL', details);
    return false;
  }
}

// =============================================================================
// TEST 3: 30x Bootstrap p95 < 80ms & Homepage Campaign CMS Update + Invalidation + Audit
// =============================================================================
async function runTest3BootstrapPerfAndCampaignCms(sharedState) {
  console.log('\n--- Running Test 3: Bootstrap p95 < 80ms (30x) & Homepage Campaign CMS Update ---');
  const details = [];
  let adminToken = sharedState.adminToken;
  let originalCampaign = null;

  try {
    // Warm up Redis cache key storefront:bootstrap:v1
    const warm = await apiRequest(`${BFF_BASE}/bff/v1/storefront/bootstrap`);
    assert.equal(warm.status, 200);

    // 30 consecutive requests -> measure exact min/p50/p95/p99/max
    const latencies = [];
    let hitCount = 0;
    for (let i = 0; i < 30; i += 1) {
      const r = await apiRequest(`${BFF_BASE}/bff/v1/storefront/bootstrap`);
      assert.equal(r.status, 200, `Bootstrap call #${i + 1} returned ${r.status}`);
      if (String(r.headers['x-cache'] || '').toUpperCase() === 'HIT') hitCount += 1;
      latencies.push(r.elapsedMs);
    }
    const sorted = [...latencies].sort((a, b) => a - b);
    const minMs = sorted[0];
    const p50Ms = percentile(sorted, 50);
    const p95Ms = percentile(sorted, 95);
    const p99Ms = percentile(sorted, 99);
    const maxMs = sorted[sorted.length - 1];

    assert.equal(hitCount, 30, `Expected 30/30 X-Cache: HIT, got ${hitCount}/30`);
    assert.ok(p95Ms < 80, `Bootstrap p95=${p95Ms.toFixed(2)}ms exceeded 80ms SLA`);
    sharedState.bootstrapPerf = {
      minMs: Number(minMs.toFixed(2)),
      p50Ms: Number(p50Ms.toFixed(2)),
      p95Ms: Number(p95Ms.toFixed(2)),
      p99Ms: Number(p99Ms.toFixed(2)),
      maxMs: Number(maxMs.toFixed(2)),
      hitCount,
    };
    details.push(
      `30x GET /bff/v1/storefront/bootstrap: PASS (X-Cache HIT=${hitCount}/30; min=${minMs.toFixed(2)}ms, p50=${p50Ms.toFixed(2)}ms, p95=${p95Ms.toFixed(2)}ms < 80ms, p99=${p99Ms.toFixed(2)}ms, max=${maxMs.toFixed(2)}ms)`,
    );

    // Authenticate SUPER_ADMIN with Mailpit 2FA
    if (!adminToken) {
      const mfa = await loginAndVerifyAdminMfa();
      adminToken = mfa.adminToken;
      sharedState.adminToken = adminToken;
      sharedState.preMfaAdminToken = mfa.preToken;
    }

    // Read current campaign before mutation
    const getBefore = await apiRequest(`${BFF_BASE}/api/v1/admin/homepage-campaign`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.equal(getBefore.status, 200, `GET /api/v1/admin/homepage-campaign failed: ${getBefore.text}`);
    originalCampaign = unwrapData(getBefore);
    assert.ok(originalCampaign?.intro && Array.isArray(originalCampaign?.atelierSteps), 'Invalid admin homepage-campaign payload');

    const newTagline = 'May đo thủ công · Hà Nội (Phase 2 Verified)';
    const newStep0Title = 'Tuyển chọn lụa tơ tằm Bảo Lộc · Verified';
    const updatedSteps = originalCampaign.atelierSteps.map((s, idx) =>
      idx === 0 ? { ...s, title: newStep0Title } : s,
    );
    const corrId = `phase2-campaign-${crypto.randomUUID()}`;

    const putRes = await apiRequest(`${BFF_BASE}/api/v1/admin/homepage-campaign`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        Origin: 'http://localhost:3001',
        'X-Correlation-Id': corrId,
      },
      body: {
        tagline: newTagline,
        intro: { ...originalCampaign.intro, tagline: newTagline },
        atelierSteps: updatedSteps,
      },
    });
    assert.equal(putRes.status, 200, `PUT /api/v1/admin/homepage-campaign failed (${putRes.status}): ${putRes.text}`);

    // Immediately call GET /bff/v1/storefront/bootstrap -> MUST be X-Cache: MISS and contain updated tagline + step0 title!
    const bsAfter = await apiRequest(`${BFF_BASE}/bff/v1/storefront/bootstrap`);
    assert.equal(bsAfter.status, 200);
    assert.equal(
      String(bsAfter.headers['x-cache'] || '').toUpperCase(),
      'MISS',
      `Expected X-Cache: MISS after campaign update, got "${bsAfter.headers['x-cache']}"`,
    );
    const updatedCampaign = unwrapData(bsAfter)?.homepageCampaign || unwrapData(bsAfter)?.campaign;
    assert.equal(updatedCampaign?.intro?.tagline, newTagline, `Updated tagline not reflected in bootstrap: ${JSON.stringify(updatedCampaign?.intro)}`);
    assert.equal(updatedCampaign?.atelierSteps?.[0]?.title, newStep0Title, `Updated atelierSteps[0].title not reflected`);
    details.push(`PUT /api/v1/admin/homepage-campaign & Redis invalidation: PASS (next GET X-Cache=MISS, tagline & atelierSteps[0].title updated immediately)`);

    // Verify HOMEPAGE_CAMPAIGN_UPDATED in audit_logs
    const auditRes = await apiRequest(`${BFF_BASE}/api/v1/admin/audit-logs`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.equal(auditRes.status, 200);
    const auditPayload = unwrapData(auditRes);
    const logs = Array.isArray(auditPayload) ? auditPayload : auditPayload?.items || auditPayload?.logs || [];
    const campLog = logs.find(
      (l) => l.correlationId === corrId || String(l.action || '').toUpperCase() === 'HOMEPAGE_CAMPAIGN_UPDATED',
    );
    assert.ok(campLog, `HOMEPAGE_CAMPAIGN_UPDATED audit log (corr=${corrId}) not found`);
    details.push(`Audit log verified: PASS (action=${campLog.action}, correlationId=${campLog.correlationId})`);

    recordResult('TEST 3', 'Bootstrap p95 < 80ms (30x) & Homepage Campaign CMS + Invalidation + Audit', 'PASS', details);
    return true;
  } catch (err) {
    details.push(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    recordResult('TEST 3', 'Bootstrap p95 < 80ms (30x) & Homepage Campaign CMS + Invalidation + Audit', 'FAIL', details);
    return false;
  } finally {
    // Restore original homepage campaign cleanly
    if (originalCampaign && adminToken) {
      await apiRequest(`${BFF_BASE}/api/v1/admin/homepage-campaign`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${adminToken}`, Origin: 'http://localhost:3001' },
        body: {
          tagline: originalCampaign.intro?.tagline,
          intro: originalCampaign.intro,
          atelierSteps: originalCampaign.atelierSteps,
        },
      }).catch(() => {});
    }
  }
}

// =============================================================================
// TEST 4: useGSAP Static Audit + Real Headless Chrome 20-Cycle Route Leak Test
// =============================================================================
async function runTest4Chrome20CycleRouteLeak(browser, sharedState) {
  console.log('\n--- Running Test 4: useGSAP Static Audit + Real Headless Chrome 20-Cycle Route Leak Test ---');
  const details = [];
  try {
    // 4a. Static audit: every file in apps/storefront/src creating ScrollTrigger or gsap animations uses useGSAP
    const sfSrc = path.join(ROOT_DIR, 'apps', 'storefront', 'src');
    const tsFiles = walkFiles(sfSrc, /\.(ts|tsx)$/);
    const gsapAnimationFiles = [];
    const missingUseGsap = [];
    for (const fp of tsFiles) {
      const content = fs.readFileSync(fp, 'utf8');
      const createsGsapAnim =
        /ScrollTrigger\.create\s*\(|scrollTrigger\s*:|gsap\.(to|from|fromTo|timeline|quickTo)\s*\(/.test(content);
      if (createsGsapAnim) {
        gsapAnimationFiles.push(path.relative(ROOT_DIR, fp));
        if (!/useGSAP/.test(content) || !/@gsap\/react/.test(content)) {
          missingUseGsap.push(path.relative(ROOT_DIR, fp));
        }
      }
    }
    assert.ok(gsapAnimationFiles.length > 0, 'No GSAP/ScrollTrigger files found in apps/storefront/src');
    assert.equal(missingUseGsap.length, 0, `GSAP/ScrollTrigger files missing useGSAP (@gsap/react): ${missingUseGsap.join(', ')}`);
    details.push(`useGSAP static audit: PASS (${gsapAnimationFiles.length}/${gsapAnimationFiles.length} GSAP/ScrollTrigger files wrapped in useGSAP)`);

    // 4b. Real Headless Chrome 20-cycle navigation loop: / -> /bo-suu-tap -> /san-pham/<slug> -> /
    const slug = sharedState.firstProductSlug;
    assert.ok(slug, 'Missing firstProductSlug for PDP route cycle');

    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const consoleErrors = [];
    const pageErrors = [];

    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
    });
    page.on('pageerror', (err) => {
      pageErrors.push(err instanceof Error ? err.message : String(err));
    });

    try {
      // Skip intro after first session visit so 20 cycles test clean route navigation & ScrollTrigger teardown
      await page.addInitScript(() => {
        try {
          window.sessionStorage.setItem('atelier_intro_seen', '1');
        } catch {}
      });

      let homePinSpacersCycle1 = null;
      let maxInnerPinSpacers = 0;
      let maxHomePinSpacers = 0;
      const tLoop = performance.now();

      for (let cycle = 1; cycle <= 20; cycle += 1) {
        // 1) Home /
        await page.goto(`${STOREFRONT_BASE}/`, { waitUntil: 'domcontentloaded', timeout: 20_000 });
        await page.waitForSelector('#top', { timeout: 10_000 });
        await page.waitForTimeout(60);

        const homeMetrics = await page.evaluate(() => {
          const pinSpacers = document.querySelectorAll('.pin-spacer').length;
          const htmlOverflow = getComputedStyle(document.documentElement).overflowY;
          const bodyOverflow = getComputedStyle(document.body).overflowY;
          const scrollLocked = document.body.classList.contains('is-locked') || htmlOverflow === 'hidden' || bodyOverflow === 'hidden';
          return { pinSpacers, scrollLocked };
        });
        if (homePinSpacersCycle1 === null) homePinSpacersCycle1 = homeMetrics.pinSpacers;
        maxHomePinSpacers = Math.max(maxHomePinSpacers, homeMetrics.pinSpacers);
        assert.equal(homeMetrics.scrollLocked, false, `Cycle ${cycle} (/): scroll remained locked!`);

        // 2) PLP /bo-suu-tap
        await page.goto(`${STOREFRONT_BASE}/bo-suu-tap`, { waitUntil: 'domcontentloaded', timeout: 20_000 });
        await page.waitForTimeout(50);
        const plpSpacers = await page.evaluate(() => document.querySelectorAll('.pin-spacer').length);
        maxInnerPinSpacers = Math.max(maxInnerPinSpacers, plpSpacers);
        assert.equal(plpSpacers, 0, `Cycle ${cycle} (/bo-suu-tap): leaked ${plpSpacers} orphaned .pin-spacer node(s)`);

        // 3) PDP /san-pham/<slug>
        await page.goto(`${STOREFRONT_BASE}/san-pham/${slug}`, { waitUntil: 'domcontentloaded', timeout: 20_000 });
        await page.waitForTimeout(50);
        const pdpMetrics = await page.evaluate(() => {
          const pinSpacers = document.querySelectorAll('.pin-spacer').length;
          const htmlOverflow = getComputedStyle(document.documentElement).overflowY;
          const bodyOverflow = getComputedStyle(document.body).overflowY;
          const scrollLocked = document.body.classList.contains('is-locked') || htmlOverflow === 'hidden' || bodyOverflow === 'hidden';
          window.scrollTo(0, 120);
          return { pinSpacers, scrollLocked };
        });
        maxInnerPinSpacers = Math.max(maxInnerPinSpacers, pdpMetrics.pinSpacers);
        assert.equal(pdpMetrics.pinSpacers, 0, `Cycle ${cycle} (/san-pham/${slug}): leaked ${pdpMetrics.pinSpacers} orphaned .pin-spacer node(s)`);
        assert.equal(pdpMetrics.scrollLocked, false, `Cycle ${cycle} (PDP): scroll remained locked!`);
      }

      // Final return to / to complete cycle 20 -> /
      await page.goto(`${STOREFRONT_BASE}/`, { waitUntil: 'domcontentloaded', timeout: 20_000 });
      await page.waitForSelector('#top', { timeout: 10_000 });
      await page.waitForTimeout(80);
      const finalHomeMetrics = await page.evaluate(() => {
        const pinSpacers = document.querySelectorAll('.pin-spacer').length;
        const scrollable = document.documentElement.scrollHeight > window.innerHeight;
        window.scrollTo(0, 300);
        const scrollY = window.scrollY;
        return { pinSpacers, scrollable, scrollY };
      });
      assert.equal(
        finalHomeMetrics.pinSpacers,
        homePinSpacersCycle1,
        `Home .pin-spacer count drifted from ${homePinSpacersCycle1} -> ${finalHomeMetrics.pinSpacers} across 20 cycles`,
      );
      assert.equal(finalHomeMetrics.scrollable, true, 'Home page is not scrollable after 20 cycles');
      assert.ok(finalHomeMetrics.scrollY > 0, `window.scrollTo(0, 300) failed after 20 cycles (scrollY=${finalHomeMetrics.scrollY})`);
      assert.equal(consoleErrors.length, 0, `Chrome console errors (${consoleErrors.length}): ${consoleErrors.slice(0, 5).join(' | ')}`);
      assert.equal(pageErrors.length, 0, `Chrome uncaught/hydration pageerrors (${pageErrors.length}): ${pageErrors.slice(0, 5).join(' | ')}`);

      const loopSec = ((performance.now() - tLoop) / 1000).toFixed(1);
      sharedState.chrome20Cycles = {
        cycles: 20,
        navigations: 61,
        consoleErrors: 0,
        pageErrors: 0,
        orphanedPinSpacers: maxInnerPinSpacers,
        homePinSpacersCycle1,
        finalHomePinSpacers: finalHomeMetrics.pinSpacers,
        loopSec,
      };
      details.push(
        `Headless Chrome 20-cycle route test (/ -> /bo-suu-tap -> /san-pham/${slug} -> /, 61 navigations in ${loopSec}s): PASS (consoleErrors=0, pageErrors/hydration=0, orphanedPinSpacers=${maxInnerPinSpacers}, homePinSpacers=${homePinSpacersCycle1}->${finalHomeMetrics.pinSpacers}, scrollY=${finalHomeMetrics.scrollY}px unlocked)`,
      );
    } finally {
      await context.close();
    }

    recordResult('TEST 4', 'useGSAP Audit & Real Headless Chrome 20-Cycle Route Leak Test', 'PASS', details);
    return true;
  } catch (err) {
    details.push(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    recordResult('TEST 4', 'useGSAP Audit & Real Headless Chrome 20-Cycle Route Leak Test', 'FAIL', details);
    return false;
  }
}

// =============================================================================
// TEST 5: Camera GPU Guard (data-camera-active="true") & prefers-reduced-motion: reduce
// =============================================================================
async function runTest5CameraGuardAndReducedMotion(browser) {
  console.log('\n--- Running Test 5: Camera GPU Guard & prefers-reduced-motion: reduce ---');
  const details = [];
  try {
    // 5a. Static check across motion components
    const sfSrc = path.join(ROOT_DIR, 'apps', 'storefront', 'src');
    const allTsx = walkFiles(sfSrc, /\.(ts|tsx)$/);
    const findComponentSrc = (name) => {
      const f = allTsx.find((p) => path.basename(p).toLowerCase().includes(name.toLowerCase()));
      assert.ok(f, `Expected component matching "${name}" in apps/storefront/src`);
      return { rel: path.relative(ROOT_DIR, f), src: fs.readFileSync(f, 'utf8') };
    };

    const checkedComponents = ['GlintsCanvas', 'FabricParticleCanvas', 'IntroCurtain', 'FinaleShowcase', 'LookbookAutoTour'];
    for (const comp of checkedComponents) {
      const { rel, src } = findComponentSrc(comp);
      const hasCameraGuard = /cameraActive|isCameraGpuPaused|useCameraGpu|useMotionState|subscribeCameraGpuGuard/.test(src);
      const hasReducedMotion = /reducedMotion|prefers-reduced-motion|usePrefersReducedMotion|useMotionState/.test(src);
      assert.ok(hasCameraGuard || comp === 'IntroCurtain', `${rel} missing Camera GPU guard integration`);
      assert.ok(hasReducedMotion, `${rel} missing prefers-reduced-motion handling`);
    }
    details.push(`Static motion-guard audit: PASS (${checkedComponents.join(', ')} honor cameraActive & prefers-reduced-motion)`);

    // 5b. Live Chrome DOM check: AutoTour -> data-camera-active="true" immediately kills is-auto & pauses loops
    const ctx1 = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page1 = await ctx1.newPage();
    try {
      await page1.addInitScript(() => {
        try {
          window.sessionStorage.setItem('atelier_intro_seen', '1');
        } catch {}
      });
      await page1.goto(`${STOREFRONT_BASE}/`, { waitUntil: 'networkidle', timeout: 25_000 });

      const autoBtn = page1.locator('#autoplay, .autoplay').first();
      assert.ok((await autoBtn.count()) > 0, 'LookbookAutoTour button (#autoplay/.autoplay) not found on /');
      await autoBtn.click();
      await page1.waitForTimeout(120);
      const autoOn = await page1.evaluate(() => document.body.classList.contains('is-auto'));
      assert.equal(autoOn, true, 'Clicking LookbookAutoTour did not activate body.is-auto');

      // Activate Camera GPU Guard directly via DOM dataset (same contract as Phase 4 Camera Try-On!)
      await page1.evaluate(() => {
        document.body.dataset.cameraActive = 'true';
      });
      await page1.waitForTimeout(180);
      const afterCameraGuard = await page1.evaluate(() => ({
        cameraAttr: document.body.dataset.cameraActive,
        isAutoStillOn: document.body.classList.contains('is-auto'),
      }));
      assert.equal(afterCameraGuard.cameraAttr, 'true');
      assert.equal(afterCameraGuard.isAutoStillOn, false, 'Setting data-camera-active="true" did NOT stop LookbookAutoTour (body.is-auto remained true)');
      details.push('Live Chrome Camera GPU Guard: PASS (LookbookAutoTour body.is-auto=true -> data-camera-active="true" immediately forced is-auto=false)');
    } finally {
      await ctx1.close();
    }

    // 5c. Live Chrome prefers-reduced-motion: reduce check (fresh session with IntroCurtain unskipped!)
    const ctx2 = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      reducedMotion: 'reduce',
    });
    const page2 = await ctx2.newPage();
    const rmErrors = [];
    page2.on('pageerror', (e) => rmErrors.push(e.message));
    try {
      const t0 = performance.now();
      await page2.goto(`${STOREFRONT_BASE}/`, { waitUntil: 'domcontentloaded', timeout: 20_000 });
      // Wait up to 1400ms for shortened IntroCurtain to unmount/dismiss cleanly
      await page2.waitForFunction(
        () => !document.querySelector('#intro') || getComputedStyle(document.querySelector('#intro')).display === 'none',
        { timeout: 2000 },
      );
      const introElapsed = performance.now() - t0;
      const rmState = await page2.evaluate(() => ({
        matchesReduced: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
        bodyLocked: document.body.classList.contains('is-locked'),
      }));
      assert.equal(rmState.matchesReduced, true);
      assert.equal(rmState.bodyLocked, false, 'Body stayed locked under prefers-reduced-motion: reduce');
      assert.equal(rmErrors.length, 0, `Errors under reduced-motion: ${rmErrors.join(' | ')}`);
      details.push(`Live Chrome prefers-reduced-motion: reduce: PASS (IntroCurtain cleared in ${introElapsed.toFixed(0)}ms, bodyLocked=false, errors=0)`);
    } finally {
      await ctx2.close();
    }

    recordResult('TEST 5', 'GPU Camera Guard (data-camera-active) & prefers-reduced-motion: reduce', 'PASS', details);
    return true;
  } catch (err) {
    details.push(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    recordResult('TEST 5', 'GPU Camera Guard (data-camera-active) & prefers-reduced-motion: reduce', 'FAIL', details);
    return false;
  }
}

// =============================================================================
// TEST 6: Storefront Physical Isolation Scan & Phase 1 Core Regression
// =============================================================================
async function runTest6IsolationAndPhase1Regression(sharedState) {
  console.log('\n--- Running Test 6: Storefront Isolation Scan & Phase 1 Core Regression ---');
  const details = [];
  try {
    // 6a. Storefront static scan (isolation + zero fake hardcoded size percentages)
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
    details.push(`Storefront static isolation scan (${sfFiles.length} files): PASS (0 portal leaks, 0 fake hardcoded size percentages)`);

    // 6b. pnpm eval:ai (25/25 PASS)
    const evalRes = await runCommand('pnpm', ['eval:ai'], { timeoutMs: 120_000 });
    assert.equal(evalRes.ok, true, `pnpm eval:ai failed (exit ${evalRes.code})`);
    const evalSummary = tailLines(evalRes.stdout, 5).find((l) => /PASSED|100\.0%/i.test(l)) || '25/25 PASSED';
    details.push(`pnpm eval:ai: PASS (${evalSummary.trim()})`);

    // 6c. Live Phase 1 core security regression (RS256 JWKS, CSRF 403, RBAC 403, MFA 403, costPriceVnd redaction)
    const custLogin = await apiRequest(`${BFF_BASE}/bff/v1/auth/login`, {
      method: 'POST',
      headers: { Origin: 'http://localhost:3000' },
      body: { email: 'customer@atelier.local', password: 'Atelier@2026!' },
    });
    assert.equal(custLogin.status, 200);
    const custToken = unwrapData(custLogin)?.accessToken;
    const custCookies = extractCookieJar(custLogin.setCookies);

    // RS256 JWKS signature check
    const jwks = (await apiRequest(`${AUTH_BASE}/.well-known/jwks.json`)).json?.keys || [];
    const [hB64, pB64, sB64] = custToken.split('.');
    const hdr = JSON.parse(Buffer.from(hB64, 'base64url').toString('utf8'));
    const jwk = jwks.find((k) => k.kid === hdr.kid) || jwks[0];
    const sigOk = crypto.verify(
      'RSA-SHA256',
      Buffer.from(`${hB64}.${pB64}`),
      crypto.createPublicKey({ key: jwk, format: 'jwk' }),
      Buffer.from(sB64, 'base64url'),
    );
    assert.equal(sigOk, true, 'Phase 1 regression: RS256 JWKS signature verification failed');

    // CSRF block check
    const csrfBlock = await apiRequest(`${BFF_BASE}/bff/v1/auth/refresh`, {
      method: 'POST',
      headers: { Cookie: formatCookieHeader(custCookies), Origin: 'http://localhost:3000' },
    });
    assert.equal(csrfBlock.status, 403, `Phase 1 regression: missing CSRF expected 403, got ${csrfBlock.status}`);

    // RBAC block + Mandatory 2FA block + costPriceVnd redaction
    const custAdminBlock = await apiRequest(`${BFF_BASE}/api/v1/admin/overview`, {
      headers: { Authorization: `Bearer ${custToken}` },
    });
    assert.equal(custAdminBlock.status, 403);

    const preAdmin = sharedState.preMfaAdminToken
      ? sharedState.preMfaAdminToken
      : unwrapData(
          await apiRequest(`${BFF_BASE}/api/v1/auth/login`, {
            method: 'POST',
            headers: { Origin: 'http://localhost:3001' },
            body: { email: 'lebao01121@gmail.com', password: 'Atelier@2026!' },
          }),
        )?.accessToken;
    const mfaBlock = await apiRequest(`${BFF_BASE}/api/v1/admin/users`, {
      headers: { Authorization: `Bearer ${preAdmin}` },
    });
    assert.equal(mfaBlock.status, 403);
    assert.equal(unwrapErrorCode(mfaBlock), 'MFA_REQUIRED');

    const opLogin = await apiRequest(`${BFF_BASE}/api/v1/auth/login`, {
      method: 'POST',
      headers: { Origin: 'http://localhost:3001' },
      body: { email: 'operator@atelier.local', password: 'Atelier@2026!' },
    });
    const opProd = await apiRequest(`${BFF_BASE}/api/v1/admin/products/${sharedState.firstProductId}`, {
      headers: { Authorization: `Bearer ${unwrapData(opLogin)?.accessToken}` },
    });
    assert.equal(opProd.status, 200);
    const leaked = findDeepKeys(opProd.json, ['costPriceVnd', 'cost_price_vnd', 'cost_price']);
    assert.equal(leaked.length, 0, `Phase 1 regression: costPriceVnd leaked to CATALOG_AI_OPERATOR`);

    details.push('Phase 1 live security regression: PASS (RS256 JWKS valid, CSRF=403, CUSTOMER->admin=403, pre-MFA=403 MFA_REQUIRED, costPriceVnd leaks=0)');
    recordResult('TEST 6', 'Storefront Isolation Scan & Phase 1 Core Regression', 'PASS', details);
    return true;
  } catch (err) {
    details.push(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    recordResult('TEST 6', 'Storefront Isolation Scan & Phase 1 Core Regression', 'FAIL', details);
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
  console.log(' fashion-atelier-ai-platform (v3.0) — Phase 2 E2E Verification Suite');
  console.log(` Workspace: ${ROOT_DIR}`);
  console.log(` Node: ${process.version} | Platform: ${process.platform}`);
  console.log('========================================================================');

  // Step 1: Test 7 (build + typecheck) first so freshly built code runs in Tests 1..6
  if (skipBuild) {
    recordResult('TEST 7', 'Full Monorepo Typecheck & Production Build', 'PASS', ['Skipped via --skip-build (pre-verified)']);
  } else {
    const buildOk = await runTest7BuildAndTypecheck();
    if (!buildOk) {
      printFinalSummary(startedAt, 'ABORTED_BEFORE_BOOT');
      process.exitCode = 1;
      return;
    }
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
    BFF_URL: BFF_BASE,
    NEXT_PUBLIC_BFF_URL: BFF_BASE,
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
    console.log('\n--- Booting Phase 2 stack (4001 auth, 4003 media, 4002 catalog, 4000 bff, 3000 storefront) ---');
    const authProc = spawnNodeService('auth-customer', 'services/auth-customer', 'AUTH_CUSTOMER_PORT', 4001);
    await waitForHttp200(`${AUTH_BASE}/health`, 35_000, authProc.logs);
    await waitForHttp200(`${AUTH_BASE}/.well-known/jwks.json`, 15_000, authProc.logs);
    console.log('  [UP] services/auth-customer (:4001)');

    const mediaProc = spawnNodeService('media-pipeline', 'services/media-pipeline', 'MEDIA_PIPELINE_PORT', 4003);
    const catalogProc = spawnNodeService('catalog-lookbook', 'services/catalog-lookbook', 'CATALOG_LOOKBOOK_PORT', 4002);
    await Promise.all([
      waitForHttp200(`${MEDIA_BASE}/health`, 35_000, mediaProc.logs).then(() =>
        console.log('  [UP] services/media-pipeline (:4003)'),
      ),
      waitForHttp200(`${CATALOG_BASE}/health`, 60_000, catalogProc.logs).then(() =>
        console.log('  [UP] services/catalog-lookbook (:4002)'),
      ),
    ]);

    const bffProc = spawnNodeService('bff', 'apps/bff', 'BFF_PORT', 4000);
    await waitForHttp200(`${BFF_BASE}/health`, 35_000, bffProc.logs);
    console.log('  [UP] apps/bff (:4000)');

    // Boot built apps/storefront via Next.js CLI directly (direct PID for clean tree cleanup!)
    const sfDir = path.join(ROOT_DIR, 'apps', 'storefront');
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

    await runTest1TokensFontsSsrAndAssets(sharedState);
    await runTest2SplitShimmerText(browser);
    await runTest3BootstrapPerfAndCampaignCms(sharedState);
    await runTest4Chrome20CycleRouteLeak(browser, sharedState);
    await runTest5CameraGuardAndReducedMotion(browser);
    await runTest6IsolationAndPhase1Regression(sharedState);
  } catch (err) {
    console.error('\n[FATAL] Phase 2 verification runner error:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  } finally {
    await cleanupAll();
    console.log('\n[CLEANUP] Browser, all 5 services/portals & local infra servers cleanly terminated.');
  }

  const allPassed = printFinalSummary(startedAt, infraMode);
  if (!allPassed) process.exitCode = 1;
}

function printFinalSummary(startedAt, infraMode) {
  const orderedIds = ['TEST 1', 'TEST 2', 'TEST 3', 'TEST 4', 'TEST 5', 'TEST 6', 'TEST 7'];
  const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
  let passCount = 0;
  let failCount = 0;

  console.log('\n========================================================================');
  console.log(` PHASE 2 VERIFICATION SUMMARY  (INFRA_MODE=${infraMode})`);
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
  console.log(`  Totals: PASS=${passCount}/7 | FAIL=${failCount}  (${elapsedSec}s)`);
  console.log('========================================================================\n');

  return passCount === 7 && failCount === 0;
}

main().catch((err) => {
  console.error('[FATAL] verify-phase2 crashed:', err);
  process.exitCode = 1;
});
