#!/usr/bin/env node
/**
 * Frameless Atmospheric Couture (#occasion) Visual & Playwright Verification Suite
 * fashion-atelier-ai-platform (v3.1)
 *
 * Audits:
 *   1. Local alpha-matting cutout integrity in `apps/storefront/public/occasion-cutouts/`
 *      (width >= 1080, height >= 1440, hasAlpha === true, all 4 corners strictly alpha === 0).
 *   2. Live stack detection & non-destructive verification:
 *      - NEVER kills user's active `./run` or Host Ollama (:11434).
 *      - Mode A (REUSE_ACTIVE_STACK): reuses live :4002 / :4000 / :3000 when already serving
 *        `heroCutoutUrl` + frameless UI.
 *      - Mode B (SHADOW_STOREFRONT_ONLY): reuses live :4002 / :4000 and boots fresh
 *        storefront on :3099 when only :3000 is running an older `.next` build.
 *      - Mode C (SHADOW_REBUILT_OVERLAY): preserves user's `./run` untouched and boots
 *        isolated freshly-built catalog (:4102, temp PGlite DB), BFF (:4100), and
 *        storefront (:3099) reusing live Redis/Meilisearch/MinIO/unchanged services.
 *      - Mode D (FRESH_LOCAL_STACK): boots infra + full local stack on canonical ports.
 *   3. Data sync & API audit:
 *      - POST /v1/catalog/internal/reseed
 *      - Redis FLUSHALL + POST /api/revalidate
 *      - Verifies GET /bff/v1/occasions & GET /bff/v1/storefront/bootstrap return 6 occasions
 *        with 24/24 items having non-null `heroCutoutUrl` AND untouched `lookbookMainUrl`.
 *   4. Real Chrome Playwright (`1440x900`) DOM & Visual Audit across all 6 occasions:
 *      - 01-frameless-weekend-1440.png (Checks 1..4 on WEEKEND EASE)
 *      - 02-frameless-weekend-card2-1440.png (Cards 2, 3, 4 frameless swap)
 *      - 03-frameless-evening-dark-1440.png (EVENING COUTURE dark mode + .nav.is-light=false)
 *      - 04-frameless-modern-tailoring-1440.png (MODERN TAILORING)
 *      - 05-frameless-bridal-1440.png (BRIDAL GUEST)
 *      - Virtual Try-On modal opens cleanly (z=120) with active product selected
 *      - consoleErrors === 0, pageErrors === 0, failedHttp === 0, brokenImgs === 0
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { startLocalInfraIfNeeded } from './local-infra-dev.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const IS_WIN = process.platform === 'win32';

const sharp = createRequire(path.join(ROOT_DIR, 'services', 'media-pipeline', 'package.json'))('sharp');
const Redis = createRequire(path.join(ROOT_DIR, 'packages', 'db-client', 'package.json'))('ioredis');

const AUDIT_DIR =
  process.env.FRAMELESS_AUDIT_DIR ||
  'C:\\Users\\Admin\\.gemini\\antigravity\\brain\\d1783908-6521-4608-8b37-41aae3ee9a65\\scratch\\frameless-audit';

const PUBLIC_CUTOUTS_DIR = path.join(ROOT_DIR, 'apps', 'storefront', 'public', 'occasion-cutouts');
const CACHE_CUTOUTS_DIR = path.join(
  ROOT_DIR,
  'infra',
  'seeds',
  'real-assets-cache',
  'processed',
  'occasion-cutouts',
);

const EXPECTED_BADGES = [
  'EVENING COUTURE',
  'MODERN TAILORING',
  'WEEKEND EASE',
  'RESORT CAPSULE',
  'GALLERY EDIT',
  'BRIDAL GUEST',
];

const results = [];

function recordCheck(id, title, ok, details = []) {
  results.push({ id, title, ok, details });
  console.log(`\n[${ok ? 'PASS' : 'FAIL'}] ${id} — ${title}`);
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
      val.length >= 2 &&
      ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
    ) {
      val = val.slice(1, -1);
    }
    vars[key] = val;
  }
  return vars;
}

function isPortOpen(port, host = '127.0.0.1', timeoutMs = 450) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let settled = false;
    const finish = (open) => {
      if (settled) return;
      settled = true;
      sock.removeAllListeners();
      sock.destroy();
      resolve(open);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
    sock.connect(port, host);
  });
}

function cleanStalePgliteLocks(onlyNames = null) {
  const pgRoot = path.join(ROOT_DIR, '.local-pgdata');
  if (!fs.existsSync(pgRoot)) return 0;
  let removed = 0;
  for (const entry of fs.readdirSync(pgRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (onlyNames && !onlyNames.includes(entry.name)) continue;
    const pidFile = path.join(pgRoot, entry.name, 'postmaster.pid');
    if (fs.existsSync(pidFile)) {
      try {
        fs.rmSync(pidFile, { force: true });
        removed += 1;
      } catch {
        // ignore locked files owned by active processes
      }
    }
  }
  return removed;
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

function resolvePythonBin() {
  const candidates = IS_WIN
    ? [path.join(ROOT_DIR, 'services', 'ai-tryon', '.venv', 'Scripts', 'python.exe'), 'python']
    : [path.join(ROOT_DIR, 'services', 'ai-tryon', '.venv', 'bin', 'python'), 'python3'];
  for (const c of candidates) {
    if (c.includes(path.sep)) {
      if (fs.existsSync(c)) return c;
    } else {
      return c;
    }
  }
  return candidates[0];
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

function httpRequest(urlString, { method = 'GET', headers = {}, body = undefined, timeoutMs = 25_000 } = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlString);
    const lib = parsed.protocol === 'https:' ? https : http;
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

    const req = lib.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: `${parsed.pathname}${parsed.search}`,
        method,
        headers: reqHeaders,
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
        res.on('end', () => {
          const buffer = Buffer.concat(chunks);
          const text = buffer.toString('utf8');
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            // non-JSON
          }
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            buffer,
            text,
            json,
          });
        });
      },
    );

    req.on('timeout', () => req.destroy(new Error(`HTTP timeout (${timeoutMs}ms): ${urlString}`)));
    req.on('error', reject);
    if (payloadBuf) req.write(payloadBuf);
    req.end();
  });
}

async function waitForHttp200(url, timeoutMs = 60_000, logs = []) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = '';
  while (Date.now() < deadline) {
    try {
      const res = await httpRequest(url, { timeoutMs: 3000 });
      if (res.status >= 200 && res.status < 300) return res;
      lastErr = `HTTP ${res.status}`;
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
    }
    await new Promise((r) => setTimeout(r, 350));
  }
  const tail = logs.join('').split(/\r?\n/).filter(Boolean).slice(-16).join('\n');
  throw new Error(`Timed out waiting for ${url} (${lastErr}). Logs:\n${tail}`);
}

function unwrap(body) {
  if (body && typeof body === 'object' && 'data' in body && body.data !== undefined) {
    return body.data;
  }
  return body;
}

function normalizeUrl(raw, storefrontBase) {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) return trimmed;
  if (trimmed.startsWith('/')) return `${storefrontBase}${trimmed}`;
  return null;
}

async function flushAllRedis(envVars) {
  const redis = new Redis({
    host: '127.0.0.1',
    port: 6379,
    password: envVars.REDIS_PASSWORD || 'Atelier_Redis2026!',
    maxRetriesPerRequest: 2,
    connectTimeout: 5000,
    lazyConnect: true,
  });
  try {
    await redis.connect();
    await redis.flushall();
    return true;
  } finally {
    redis.disconnect();
  }
}

async function auditLocalCutouts() {
  if (!fs.existsSync(PUBLIC_CUTOUTS_DIR)) {
    return { ok: false, files: [], failures: [`Directory missing: ${PUBLIC_CUTOUTS_DIR}`] };
  }
  const files = fs
    .readdirSync(PUBLIC_CUTOUTS_DIR)
    .filter((f) => f.toLowerCase().endsWith('.webp'))
    .sort();

  const failures = [];
  const inspected = [];

  if (files.length === 0) {
    failures.push('No .webp cutouts found in apps/storefront/public/occasion-cutouts/');
  }

  for (const filename of files) {
    const absPath = path.join(PUBLIC_CUTOUTS_DIR, filename);
    const cachePath = path.join(CACHE_CUTOUTS_DIR, filename);
    const img = sharp(absPath);
    const meta = await img.metadata();
    const { data, info } = await img.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const alphaAt = (x, y) => data[(y * info.width + x) * info.channels + 3];
    const corners = [
      alphaAt(0, 0),
      alphaAt(info.width - 1, 0),
      alphaAt(0, info.height - 1),
      alphaAt(info.width - 1, info.height - 1),
    ];

    const widthOk = (meta.width ?? 0) >= 1080;
    const heightOk = (meta.height ?? 0) >= 1440;
    const alphaOk = meta.hasAlpha === true;
    const cornersZero = corners.every((a) => a === 0);
    const cacheMirrorOk = fs.existsSync(cachePath);

    inspected.push({
      filename,
      format: meta.format,
      width: meta.width,
      height: meta.height,
      hasAlpha: meta.hasAlpha,
      corners,
      cacheMirrorOk,
    });

    if (!widthOk || !heightOk || !alphaOk || !cornersZero || !cacheMirrorOk) {
      failures.push(
        `${filename}: ${meta.width}x${meta.height} hasAlpha=${meta.hasAlpha} corners=[${corners.join(',')}] cacheMirror=${cacheMirrorOk}`,
      );
    }
  }

  return { ok: failures.length === 0 && files.length > 0, files: inspected, failures };
}

async function waitForOccasionSettle(page, expectedBadge = null) {
  if (expectedBadge) {
    await page
      .waitForFunction(
        (badge) => {
          const activeBtn = document.querySelector('#occTabs button[aria-pressed="true"]');
          return activeBtn && activeBtn.textContent && activeBtn.textContent.toUpperCase().includes(badge);
        },
        expectedBadge,
        { timeout: 10_000 },
      )
      .catch(() => {});
  }

  await page
    .waitForFunction(
      () => {
        const img = document.querySelector('#occImg');
        if (!img || !img.complete || img.naturalWidth < 1080) return false;
        const st = window.getComputedStyle(img);
        const op = parseFloat(st.opacity || '0');
        const flt = st.filter || 'none';
        const blurSettled = flt === 'none' || flt === 'blur(0px)';
        return op >= 0.98 && blurSettled;
      },
      null,
      { timeout: 10_000 },
    )
    .catch(() => {});

  // Allow 1.0s radial wipe, 0.85s title shimmer, and 0.66s fabric lens stagger to finish completely
  await page.waitForTimeout(1150);

  await page
    .evaluate(async () => {
      const sec = document.querySelector('#occasion');
      if (!sec) return;
      const imgs = Array.from(sec.querySelectorAll('img')).filter((im) => {
        const st = window.getComputedStyle(im);
        return st.display !== 'none' && st.visibility !== 'hidden';
      });
      await Promise.all(
        imgs.map((im) => {
          if (im.complete) return Promise.resolve();
          return new Promise((r) => {
            im.addEventListener('load', r, { once: true });
            im.addEventListener('error', r, { once: true });
            setTimeout(r, 4000);
          });
        }),
      );
    })
    .catch(() => {});
}

async function selectOccasionByBadge(page, badgeText) {
  const clicked = await page.evaluate((badge) => {
    const btns = Array.from(document.querySelectorAll('#occTabs button'));
    const target = btns.find((b) => (b.textContent || '').toUpperCase().includes(badge));
    if (!target) return false;
    target.click();
    return true;
  }, badgeText);
  if (!clicked) {
    throw new Error(`Occasion tab button not found for badge: ${badgeText}`);
  }
  await waitForOccasionSettle(page, badgeText);
}

async function inspectCurrentOccasionState(page) {
  return page.evaluate(() => {
    const section = document.querySelector('#occasion');
    const stage = section?.querySelector('.occ__stage') || null;
    const nav = document.querySelector('.nav, header nav, header.nav');
    const navLinks = Array.from(document.querySelectorAll('.nav a, header nav a'));
    const navColor = navLinks[0]
      ? window.getComputedStyle(navLinks[0]).color
      : nav
        ? window.getComputedStyle(nav).color
        : null;
    const navBeforeOpacity = nav ? window.getComputedStyle(nav, '::before').opacity : null;
    const navIsLight = nav ? nav.classList.contains('is-light') : null;

    const archEls = section ? section.querySelectorAll('.occ__arch').length : -1;
    const bouquet = document.querySelector('#occBouquet');
    const subjectStage = bouquet?.parentElement || null;
    const centerColumn = subjectStage?.parentElement || null;
    const mainGrid = centerColumn?.parentElement || null;
    const subjectLink = bouquet?.querySelector('a') || null;
    const img = document.querySelector('#occImg');
    const word = document.querySelector('#occWord');
    const headingWrap = word?.parentElement || null;
    const aura = section?.querySelector('.occ__aura') || null;
    const wireHalo = section?.querySelector('.occ__halo') || null;
    const lens = section?.querySelector('[data-testid="occasion-fabric-lens"]') || null;
    const lensImg = lens?.querySelector('img') || null;
    const lensPointer = section?.querySelector('[data-testid="occasion-lens-pointer"]') || null;
    const tryOnPill = section?.querySelector('[data-testid="occasion-tryon-pill"]') || null;
    const bgEl = document.querySelector('#occBg');

    const boxAudit = (el) => {
      if (!el) return null;
      const st = window.getComputedStyle(el);
      return {
        borderRadius: st.borderRadius,
        overflow: st.overflow,
        borderWidth: `${st.borderTopWidth}/${st.borderRightWidth}/${st.borderBottomWidth}/${st.borderLeftWidth}`,
        borderStyle: st.borderTopStyle,
        boxShadow: st.boxShadow,
        backgroundColor: st.backgroundColor,
        zIndex: st.zIndex,
      };
    };

    const imgRect = img?.getBoundingClientRect() || null;
    const wordRect = word?.getBoundingClientRect() || null;
    const auraRect = aura?.getBoundingClientRect() || null;
    const haloRect = wireHalo?.getBoundingClientRect() || null;
    const lensRect = lens?.getBoundingClientRect() || null;
    const pointerRect = lensPointer?.getBoundingClientRect() || null;
    const pillRect = tryOnPill?.getBoundingClientRect() || null;

    const imgStyle = img ? window.getComputedStyle(img) : null;
    const haloStyle = wireHalo ? window.getComputedStyle(wireHalo) : null;
    const auraStyle = aura ? window.getComputedStyle(aura) : null;
    const lensStyle = lens ? window.getComputedStyle(lens) : null;
    const wordStyle = word ? window.getComputedStyle(word) : null;
    const headingWrapStyle = headingWrap ? window.getComputedStyle(headingWrap) : null;
    const pillStyle = tryOnPill ? window.getComputedStyle(tryOnPill) : null;
    const bgStyle = bgEl ? window.getComputedStyle(bgEl) : null;

    const tabBadges = Array.from(document.querySelectorAll('#occTabs li button em')).map((el) =>
      (el.textContent || '').trim().toUpperCase(),
    );
    const activeTabText = (
      document.querySelector('#occTabs button[aria-pressed="true"]')?.textContent || ''
    )
      .replace(/\s+/g, ' ')
      .trim();

    const thumbs = Array.from(
      document.querySelectorAll('[data-testid="occasion-set-thumbnails"] .occ__setimg'),
    ).map((frame) => {
      const fSt = window.getComputedStyle(frame);
      const fRect = frame.getBoundingClientRect();
      const tImg = frame.querySelector('img');
      return {
        borderRadius: fSt.borderRadius,
        width: Math.round(fRect.width * 10) / 10,
        height: Math.round(fRect.height * 10) / 10,
        aspect: fRect.height > 0 ? Math.round((fRect.width / fRect.height) * 1000) / 1000 : 0,
        src: tImg?.currentSrc || tImg?.getAttribute('src') || '',
        complete: Boolean(tImg?.complete),
        naturalWidth: tImg?.naturalWidth ?? 0,
        naturalHeight: tImg?.naturalHeight ?? 0,
      };
    });

    const copyVisible = Boolean(
      document.querySelector('#occLine')?.textContent?.trim() &&
        document.querySelector('#occMeta')?.textContent?.trim() &&
        document.querySelector('#occPrice')?.textContent?.trim(),
    );

    return {
      navThemeAttr: section?.getAttribute('data-nav-theme') || null,
      navIsLight,
      navColor,
      navBeforeOpacity,
      bgColor: bgStyle?.backgroundColor || null,
      wordText: (word?.textContent || '').trim(),
      metaText: (document.querySelector('#occMeta')?.textContent || '').trim(),
      activeTabText,
      tabBadges,
      archEls,
      mainGridZ: mainGrid ? window.getComputedStyle(mainGrid).zIndex : null,
      headingZ: Number.parseInt(wordStyle?.zIndex || headingWrapStyle?.zIndex || '0', 10),
      bouquetZ: Number.parseInt(bouquet ? window.getComputedStyle(bouquet).zIndex : '0', 10),
      auraZ: Number.parseInt(auraStyle?.zIndex || '0', 10),
      haloZ: Number.parseInt(haloStyle?.zIndex || '0', 10),
      boxes: {
        bouquet: boxAudit(bouquet),
        subjectStage: boxAudit(subjectStage),
        centerColumn: boxAudit(centerColumn),
        subjectLink: boxAudit(subjectLink),
      },
      aura: auraRect
        ? {
            width: Math.round(auraRect.width),
            height: Math.round(auraRect.height),
            filter: auraStyle?.filter || '',
          }
        : null,
      wireHalo: haloRect
        ? {
            width: Math.round(haloRect.width),
            height: Math.round(haloRect.height),
            circles: wireHalo?.querySelectorAll('circle').length ?? 0,
            maskImage: haloStyle?.maskImage || haloStyle?.webkitMaskImage || '',
          }
        : null,
      subjectImg: img
        ? {
            src: img.currentSrc || img.getAttribute('src') || '',
            complete: img.complete,
            naturalWidth: img.naturalWidth,
            naturalHeight: img.naturalHeight,
            opacity: imgStyle?.opacity || '',
            maskImage: imgStyle?.maskImage || imgStyle?.webkitMaskImage || '',
            rect: imgRect
              ? {
                  top: Math.round(imgRect.top * 10) / 10,
                  bottom: Math.round(imgRect.bottom * 10) / 10,
                  left: Math.round(imgRect.left * 10) / 10,
                  right: Math.round(imgRect.right * 10) / 10,
                  width: Math.round(imgRect.width * 10) / 10,
                  height: Math.round(imgRect.height * 10) / 10,
                }
              : null,
          }
        : null,
      wordRect: wordRect
        ? {
            top: Math.round(wordRect.top * 10) / 10,
            bottom: Math.round(wordRect.bottom * 10) / 10,
            height: Math.round(wordRect.height * 10) / 10,
          }
        : null,
      overlapPx:
        wordRect && imgRect ? Math.round((wordRect.bottom - imgRect.top) * 10) / 10 : null,
      lens: lensRect
        ? {
            width: Math.round(lensRect.width * 10) / 10,
            height: Math.round(lensRect.height * 10) / 10,
            borderRadius: lensStyle?.borderRadius || '',
            borderWidth: lensStyle?.borderTopWidth || '',
            borderColor: lensStyle?.borderTopColor || '',
            backgroundColor: lensStyle?.backgroundColor || '',
            imgLoaded: Boolean(lensImg?.complete && (lensImg?.naturalWidth ?? 0) > 0),
            imgSrc: lensImg?.currentSrc || lensImg?.getAttribute('src') || '',
          }
        : null,
      lensPointer: pointerRect
        ? {
            visible: pointerRect.width > 10 && pointerRect.height >= 1,
            width: Math.round(pointerRect.width * 10) / 10,
            height: Math.round(pointerRect.height * 10) / 10,
          }
        : null,
      tryOnPill: pillRect
        ? {
            text: (tryOnPill?.textContent || '').trim(),
            zIndex: Number.parseInt(pillStyle?.zIndex || '0', 10),
            top: Math.round(pillRect.top * 10) / 10,
            bottom: Math.round(pillRect.bottom * 10) / 10,
            relTopInSubject:
              imgRect && imgRect.height > 0
                ? Math.round(((pillRect.top - imgRect.top) / imgRect.height) * 1000) / 1000
                : null,
            backgroundColor: pillStyle?.backgroundColor || '',
            color: pillStyle?.color || '',
          }
        : null,
      thumbs,
      copyVisible,
      stageTop: stage ? Math.round(stage.getBoundingClientRect().top) : null,
    };
  });
}

async function main() {
  const startedAt = Date.now();
  console.log('============================================================================');
  console.log(' fashion-atelier-ai-platform — Frameless Atmospheric Couture (#occasion) Audit');
  console.log('============================================================================');

  const envVars = {
    ...process.env,
    ...loadDotEnv(path.join(ROOT_DIR, '.env')),
  };

  fs.mkdirSync(AUDIT_DIR, { recursive: true });

  const chromePath = findChromeExecutable();
  if (!chromePath) {
    throw new Error('System Chrome/Edge executable not found for Playwright verification.');
  }
  console.log(`[BROWSER] Headless Chromium binary: ${chromePath}`);

  // =========================================================================
  // CHECK 0: Audit ALL local alpha cutouts in apps/storefront/public/occasion-cutouts/
  // =========================================================================
  const localCutoutAudit = await auditLocalCutouts();
  recordCheck(
    'CUTOUTS',
    'Local RGBA alpha cutouts (width>=1080, height>=1440, hasAlpha=true, 4 corners alpha===0)',
    localCutoutAudit.ok,
    localCutoutAudit.ok
      ? [
          `Audited ${localCutoutAudit.files.length} cutouts (public + cache mirror): ALL PASS`,
          ...localCutoutAudit.files.map(
            (f) =>
              `${f.filename}: ${f.width}x${f.height} (${f.format}) hasAlpha=${f.hasAlpha} corners=[${f.corners.join(',')}]`,
          ),
        ]
      : [
          `Audited ${localCutoutAudit.files.length} cutouts; failures=${localCutoutAudit.failures.length}`,
          ...localCutoutAudit.failures,
        ],
  );

  // =========================================================================
  // STACK DETECTION: Preserve user's ./run & Host Ollama (:11434) untouched!
  // =========================================================================
  const preExistingPorts = {};
  for (const p of [3000, 4000, 4001, 4002, 4003, 4004, 4005, 4006, 4007, 4008, 4009, 6379, 7700, 9000, 11434]) {
    preExistingPorts[p] = await isPortOpen(p);
  }
  const hasPreExistingStack =
    preExistingPorts[3000] && preExistingPorts[4000] && preExistingPorts[4002];

  console.log(
    `[DETECT] Pre-existing stack: ${hasPreExistingStack ? 'ACTIVE (preserving user ./run)' : 'NOT FULLY ACTIVE'} | Host Ollama :11434=${preExistingPorts[11434] ? 'ONLINE' : 'OFFLINE'}`,
  );

  let stackMode = 'FRESH_LOCAL_STACK';
  if (hasPreExistingStack) {
    let active4002HasCutouts = false;
    let active3000HasFrameless = false;
    try {
      const occProbe = await httpRequest('http://127.0.0.1:4002/v1/catalog/occasions', { timeoutMs: 8000 });
      const occList = unwrap(occProbe.json);
      active4002HasCutouts =
        Array.isArray(occList) &&
        occList.length === 6 &&
        occList.every(
          (o) => Array.isArray(o.items) && o.items.length === 4 && o.items.every((i) => Boolean(i.heroCutoutUrl)),
        );
    } catch {
      active4002HasCutouts = false;
    }
    try {
      const htmlRes = await httpRequest('http://127.0.0.1:3000/', { timeoutMs: 8000 });
      active3000HasFrameless =
        htmlRes.status === 200 &&
        htmlRes.text.includes('occasion-fabric-lens') &&
        htmlRes.text.includes('occasion-subject-stage');
    } catch {
      active3000HasFrameless = false;
    }

    if (active4002HasCutouts && active3000HasFrameless) {
      stackMode = 'REUSE_ACTIVE_STACK';
    } else if (active4002HasCutouts && !active3000HasFrameless) {
      stackMode = 'SHADOW_STOREFRONT_ONLY';
    } else {
      stackMode = 'SHADOW_REBUILT_OVERLAY';
      console.log(
        `[DETECT] Live ./run running older in-memory build (4002_cutouts=${active4002HasCutouts}, 3000_frameless=${active3000HasFrameless}).`,
      );
      console.log(
        '[DETECT] Preserving user ./run untouched; booting isolated freshly-built overlay (:4102, :4100, :3099)!',
      );
    }
  }
  console.log(`[STACK] Verification mode: ${stackMode}`);

  const AUTH_BASE = 'http://127.0.0.1:4001';
  const MEDIA_BASE = 'http://127.0.0.1:4003';
  const INVENTORY_BASE = 'http://127.0.0.1:4004';
  const CART_BASE = 'http://127.0.0.1:4005';
  const ORDER_BASE = 'http://127.0.0.1:4006';
  const PAYMENT_BASE = 'http://127.0.0.1:4007';
  const NOTIFY_BASE = 'http://127.0.0.1:4008';
  const TRYON_BASE = 'http://127.0.0.1:4009';

  const CATALOG_PORT = stackMode === 'SHADOW_REBUILT_OVERLAY' ? 4102 : 4002;
  const BFF_PORT = stackMode === 'SHADOW_REBUILT_OVERLAY' ? 4100 : 4000;
  const STOREFRONT_PORT =
    stackMode === 'SHADOW_REBUILT_OVERLAY' || stackMode === 'SHADOW_STOREFRONT_ONLY' ? 3099 : 3000;

  const CATALOG_BASE = `http://127.0.0.1:${CATALOG_PORT}`;
  const BFF_BASE = `http://127.0.0.1:${BFF_PORT}`;
  const STOREFRONT_BASE = `http://localhost:${STOREFRONT_PORT}`;

  const tempVerifyPgDirs = [];
  let localInfraHandle = null;
  const spawned = [];
  let browser = null;

  const cleanupAll = async () => {
    if (browser) {
      await browser.close().catch(() => {});
      browser = null;
    }
    for (const proc of spawned.reverse()) {
      killProcessTree(proc.child);
    }
    spawned.length = 0;
    if (localInfraHandle) {
      await localInfraHandle.stop();
      localInfraHandle = null;
    }
    for (const dirPath of tempVerifyPgDirs) {
      try {
        if (fs.existsSync(dirPath)) {
          fs.rmSync(dirPath, { recursive: true, force: true });
        }
      } catch {
        // best-effort cleanup
      }
    }
    if (stackMode === 'FRESH_LOCAL_STACK') {
      cleanStalePgliteLocks();
    }
  };

  process.once('SIGINT', () => cleanupAll().finally(() => process.exit(130)));
  process.once('SIGTERM', () => cleanupAll().finally(() => process.exit(143)));

  try {
    if (stackMode === 'FRESH_LOCAL_STACK') {
      cleanStalePgliteLocks();
      localInfraHandle = await startLocalInfraIfNeeded(envVars);
      console.log(`[INFRA] Active mode: INFRA_MODE=${localInfraHandle.infraMode}`);
    } else {
      console.log('[INFRA] Reusing live infra on :6379 / :7700 / :9000 / :1025.');
    }

    const internalSecret = envVars.INTERNAL_SERVICE_SECRET || 'Atelier_Internal_Svc_2026!';
    const revalidateSecret = envVars.REVALIDATE_SECRET || 'Atelier_Isr_Revalidate_2026!';

    const serviceEnv = {
      ...envVars,
      AUTH_SERVICE_URL: AUTH_BASE,
      CATALOG_SERVICE_URL: CATALOG_BASE,
      MEDIA_SERVICE_URL: MEDIA_BASE,
      INVENTORY_SERVICE_URL: INVENTORY_BASE,
      CART_OUTFIT_SERVICE_URL: CART_BASE,
      CART_SERVICE_URL: CART_BASE,
      ORDER_SERVICE_URL: ORDER_BASE,
      PAYMENT_PROMO_SERVICE_URL: PAYMENT_BASE,
      PAYMENT_SERVICE_URL: PAYMENT_BASE,
      NOTIFY_REVIEW_SERVICE_URL: NOTIFY_BASE,
      AI_TRYON_SERVICE_URL: TRYON_BASE,
      BFF_URL: BFF_BASE,
      NEXT_PUBLIC_BFF_URL: BFF_BASE,
      STOREFRONT_URL: STOREFRONT_BASE,
      REVALIDATE_SECRET: revalidateSecret,
      INTERNAL_SERVICE_SECRET: internalSecret,
      CORS_ALLOWED_ORIGINS: [
        'http://localhost:3000',
        'http://127.0.0.1:3000',
        `http://localhost:${STOREFRONT_PORT}`,
        `http://127.0.0.1:${STOREFRONT_PORT}`,
      ].join(','),
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

    const spawnNodeService = (name, relDir, portEnvKey, port, extraEnv = {}) => {
      const dir = path.join(ROOT_DIR, relDir);
      const entry = path.join(dir, 'dist', 'main.js');
      if (!fs.existsSync(entry)) throw new Error(`Missing built entrypoint: ${entry}`);
      const logs = [];
      const child = spawn(process.execPath, [entry], {
        cwd: dir,
        env: { ...serviceEnv, PORT: String(port), [portEnvKey]: String(port), ...extraEnv },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      child.stdout?.on('data', (d) => logs.push(d.toString('utf8')));
      child.stderr?.on('data', (d) => logs.push(d.toString('utf8')));
      spawned.push({ name, child, logs });
      return { child, logs };
    };

    const spawnPythonTryOn = () => {
      const dir = path.join(ROOT_DIR, 'services', 'ai-tryon');
      const pyBin = resolvePythonBin();
      const logs = [];
      const child = spawn(
        pyBin,
        ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', '4009'],
        {
          cwd: dir,
          env: { ...serviceEnv, PORT: '4009', AI_TRYON_PORT: '4009' },
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        },
      );
      child.stdout?.on('data', (d) => logs.push(d.toString('utf8')));
      child.stderr?.on('data', (d) => logs.push(d.toString('utf8')));
      spawned.push({ name: 'services/ai-tryon', child, logs });
      return { child, logs };
    };

    const spawnStorefront = (port) => {
      const sfDir = path.join(ROOT_DIR, 'apps', 'storefront');
      const nextBin = path.join(sfDir, 'node_modules', 'next', 'dist', 'bin', 'next');
      if (!fs.existsSync(nextBin)) throw new Error(`Missing next binary: ${nextBin}`);
      const logs = [];
      const child = spawn(process.execPath, [nextBin, 'start', '-p', String(port)], {
        cwd: sfDir,
        env: {
          ...serviceEnv,
          NODE_ENV: 'production',
          PORT: String(port),
          STOREFRONT_PORT: String(port),
          NEXT_PUBLIC_BFF_URL: BFF_BASE,
          BFF_URL: BFF_BASE,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      child.stdout?.on('data', (d) => logs.push(d.toString('utf8')));
      child.stderr?.on('data', (d) => logs.push(d.toString('utf8')));
      spawned.push({ name: `apps/storefront:${port}`, child, logs });
      return { child, logs };
    };

    if (stackMode === 'FRESH_LOCAL_STACK') {
      const waitList = [];
      const maybeSpawn = (port, name, relDir, envKey) => {
        if (preExistingPorts[port]) return;
        const proc = spawnNodeService(name, relDir, envKey, port);
        waitList.push(waitForHttp200(`http://127.0.0.1:${port}/health`, 50_000, proc.logs));
      };
      maybeSpawn(4001, 'auth-customer', 'services/auth-customer', 'AUTH_CUSTOMER_PORT');
      maybeSpawn(4003, 'media-pipeline', 'services/media-pipeline', 'MEDIA_PIPELINE_PORT');
      maybeSpawn(4004, 'inventory', 'services/inventory', 'INVENTORY_PORT');
      maybeSpawn(4006, 'order-rma', 'services/order-rma', 'ORDER_RMA_PORT');
      maybeSpawn(4007, 'payment-promo', 'services/payment-promo', 'PAYMENT_PROMO_PORT');
      maybeSpawn(4008, 'notify-review', 'services/notify-review', 'NOTIFY_REVIEW_PORT');
      await Promise.all(waitList);

      const wait2 = [];
      maybeSpawn(4002, 'catalog-lookbook', 'services/catalog-lookbook', 'CATALOG_LOOKBOOK_PORT');
      maybeSpawn(4005, 'cart-outfit', 'services/cart-outfit', 'CART_OUTFIT_PORT');
      if (!preExistingPorts[4009]) {
        const tryonProc = spawnPythonTryOn();
        wait2.push(waitForHttp200(`${TRYON_BASE}/health`, 60_000, tryonProc.logs));
      }
      await Promise.all([
        waitForHttp200(`${CATALOG_BASE}/health`, 90_000),
        waitForHttp200(`${CART_BASE}/health`, 50_000),
        ...wait2,
      ]);
    } else if (stackMode === 'SHADOW_REBUILT_OVERLAY') {
      const verifyCatDir = path.join(ROOT_DIR, '.local-pgdata', 'catalog_db_frameless_verify');
      if (fs.existsSync(verifyCatDir)) fs.rmSync(verifyCatDir, { recursive: true, force: true });
      tempVerifyPgDirs.push(verifyCatDir);

      const catProc = spawnNodeService(
        'catalog-lookbook-frameless',
        'services/catalog-lookbook',
        'CATALOG_LOOKBOOK_PORT',
        CATALOG_PORT,
        {
          CATALOG_DATABASE_URL:
            'postgresql://svc_catalog:Atelier_Cat2026!@127.0.0.1:5432/catalog_db_frameless_verify',
        },
      );
      await waitForHttp200(`${CATALOG_BASE}/health`, 120_000, catProc.logs);
      console.log(`  [UP] rebuilt catalog-lookbook:${CATALOG_PORT}`);
    }

    // Reseed catalog + flush Redis
    console.log(`  [SEED] POST ${CATALOG_BASE}/v1/catalog/internal/reseed ...`);
    const reseedRes = await httpRequest(`${CATALOG_BASE}/v1/catalog/internal/reseed`, {
      method: 'POST',
      timeoutMs: 120_000,
    });
    console.log(`  [SEED] Reseed HTTP ${reseedRes.status}`);

    await flushAllRedis(envVars);
    console.log('  [CACHE] Redis FLUSHALL complete.');

    // Boot BFF / Storefront if needed
    if (stackMode === 'FRESH_LOCAL_STACK') {
      if (!preExistingPorts[4000]) {
        const bffProc = spawnNodeService('bff', 'apps/bff', 'BFF_PORT', BFF_PORT);
        await waitForHttp200(`${BFF_BASE}/health`, 50_000, bffProc.logs);
      }
      if (!preExistingPorts[3000]) {
        const sfProc = spawnStorefront(STOREFRONT_PORT);
        await waitForHttp200(`http://127.0.0.1:${STOREFRONT_PORT}/`, 60_000, sfProc.logs);
      }
    } else if (stackMode === 'SHADOW_REBUILT_OVERLAY') {
      const bffProc = spawnNodeService('bff-frameless', 'apps/bff', 'BFF_PORT', BFF_PORT, {
        CATALOG_SERVICE_URL: CATALOG_BASE,
        STOREFRONT_URL: STOREFRONT_BASE,
      });
      await waitForHttp200(`${BFF_BASE}/health`, 50_000, bffProc.logs);
      console.log(`  [UP] isolated apps/bff:${BFF_PORT}`);

      const sfProc = spawnStorefront(STOREFRONT_PORT);
      await waitForHttp200(`http://127.0.0.1:${STOREFRONT_PORT}/`, 60_000, sfProc.logs);
      console.log(`  [UP] fresh apps/storefront:${STOREFRONT_PORT}`);
    } else if (stackMode === 'SHADOW_STOREFRONT_ONLY') {
      const sfProc = spawnStorefront(STOREFRONT_PORT);
      await waitForHttp200(`http://127.0.0.1:${STOREFRONT_PORT}/`, 60_000, sfProc.logs);
      console.log(`  [UP] fresh apps/storefront:${STOREFRONT_PORT}`);
    }

    const revalRes = await httpRequest(`${STOREFRONT_BASE}/api/revalidate`, {
      method: 'POST',
      headers: { 'x-revalidate-secret': revalidateSecret },
      body: { tags: ['storefront', 'occasions', 'products', 'bootstrap'], paths: ['/'] },
      timeoutMs: 15_000,
    });
    console.log(`  [ISR] POST ${STOREFRONT_BASE}/api/revalidate HTTP ${revalRes.status}`);

    // =========================================================================
    // API CHECK: /bff/v1/occasions & /bff/v1/storefront/bootstrap (24/24 items)
    // =========================================================================
    const [occApiRes, bootApiRes] = await Promise.all([
      httpRequest(`${BFF_BASE}/bff/v1/occasions`, { timeoutMs: 15_000 }),
      httpRequest(`${BFF_BASE}/bff/v1/storefront/bootstrap`, { timeoutMs: 15_000 }),
    ]);

    const occApiList = unwrap(occApiRes.json);
    const bootApiData = unwrap(bootApiRes.json) ?? {};
    const bootOccList = Array.isArray(bootApiData.occasionLookbooks)
      ? bootApiData.occasionLookbooks
      : [];

    const countCutoutItems = (list) => {
      if (!Array.isArray(list)) return { occasions: 0, total: 0, withCutout: 0, withLookbook: 0, sameUrl: 0 };
      let total = 0;
      let withCutout = 0;
      let withLookbook = 0;
      let sameUrl = 0;
      for (const occ of list) {
        const items = Array.isArray(occ.items) ? occ.items : [];
        for (const it of items) {
          total += 1;
          if (it.heroCutoutUrl && typeof it.heroCutoutUrl === 'string') withCutout += 1;
          if (it.lookbookMainUrl && typeof it.lookbookMainUrl === 'string') withLookbook += 1;
          if (it.heroCutoutUrl && it.lookbookMainUrl && it.heroCutoutUrl === it.lookbookMainUrl) sameUrl += 1;
        }
      }
      return { occasions: list.length, total, withCutout, withLookbook, sameUrl };
    };

    const occStats = countCutoutItems(occApiList);
    const bootStats = countCutoutItems(bootOccList);

    // Also probe live :4000 after Redis population to report its status accurately
    let live4000Stats = null;
    if (preExistingPorts[4000] && BFF_PORT !== 4000) {
      try {
        const [liveOcc, liveBoot] = await Promise.all([
          httpRequest('http://127.0.0.1:4000/bff/v1/occasions', { timeoutMs: 8000 }),
          httpRequest('http://127.0.0.1:4000/bff/v1/storefront/bootstrap', { timeoutMs: 8000 }),
        ]);
        live4000Stats = {
          occasions: countCutoutItems(unwrap(liveOcc.json)),
          bootstrap: countCutoutItems(unwrap(liveBoot.json)?.occasionLookbooks),
        };
      } catch {
        live4000Stats = null;
      }
    }

    // Verify all unique heroCutoutUrl & lookbookMainUrl resolve HTTP 200
    const uniqueCutoutUrls = new Set();
    const uniqueLookbookUrls = new Set();
    for (const occ of Array.isArray(occApiList) ? occApiList : []) {
      for (const it of occ.items ?? []) {
        if (it.heroCutoutUrl) uniqueCutoutUrls.add(normalizeUrl(it.heroCutoutUrl, STOREFRONT_BASE));
        if (it.lookbookMainUrl) uniqueLookbookUrls.add(normalizeUrl(it.lookbookMainUrl, STOREFRONT_BASE));
      }
    }
    const urlFailures = [];
    for (const u of [...uniqueCutoutUrls, ...uniqueLookbookUrls]) {
      if (!u) continue;
      const r = await httpRequest(u, { timeoutMs: 10_000 });
      if (r.status !== 200 || r.buffer.length < 1000) {
        urlFailures.push(`${u} -> HTTP ${r.status} (${r.buffer.length}B)`);
      }
    }

    const apiOk =
      reseedRes.status >= 200 &&
      reseedRes.status < 300 &&
      revalRes.status >= 200 &&
      revalRes.status < 300 &&
      occApiRes.status === 200 &&
      bootApiRes.status === 200 &&
      occStats.occasions === 6 &&
      occStats.total === 24 &&
      occStats.withCutout === 24 &&
      occStats.withLookbook === 24 &&
      occStats.sameUrl === 0 &&
      bootStats.occasions === 6 &&
      bootStats.total === 24 &&
      bootStats.withCutout === 24 &&
      bootStats.withLookbook === 24 &&
      bootStats.sameUrl === 0 &&
      urlFailures.length === 0;

    recordCheck(
      'API_SYNC',
      `Reseed + Redis Flush + Revalidate + 24/24 heroCutoutUrl & lookbookMainUrl (${stackMode})`,
      apiOk,
      [
        `reseed=${reseedRes.status} revalidate=${revalRes.status} BFF=${BFF_BASE} SF=${STOREFRONT_BASE}`,
        `/bff/v1/occasions: occasions=${occStats.occasions} items=${occStats.total} heroCutoutUrl=${occStats.withCutout}/24 lookbookMainUrl=${occStats.withLookbook}/24 distinct=${occStats.sameUrl === 0}`,
        `/bff/v1/storefront/bootstrap: occasions=${bootStats.occasions} items=${bootStats.total} heroCutoutUrl=${bootStats.withCutout}/24 lookbookMainUrl=${bootStats.withLookbook}/24 distinct=${bootStats.sameUrl === 0}`,
        live4000Stats
          ? `live :4000 (shared Redis): occasions=${live4000Stats.occasions.withCutout}/24 bootstrap=${live4000Stats.bootstrap.withCutout}/24`
          : 'live :4000 tested directly',
        `HTTP 200 media check: cutouts=${uniqueCutoutUrls.size} lookbooks=${uniqueLookbookUrls.size} failures=${urlFailures.length}`,
        ...urlFailures,
      ],
    );

    // =========================================================================
    // PLAYWRIGHT REAL CHROME AUDIT (1440x900)
    // =========================================================================
    browser = await chromium.launch({
      executablePath: chromePath,
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--use-gl=angle',
        '--use-angle=swiftshader',
        '--enable-webgl',
        '--ignore-gpu-blocklist',
        '--window-size=1440,900',
      ],
    });

    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();

    const consoleErrors = [];
    const pageErrors = [];
    const failedHttp = [];

    if (stackMode === 'SHADOW_REBUILT_OVERLAY') {
      // Transparently route client-side baked `localhost:4000/bff/**` calls to isolated rebuilt BFF (`:4100`)
      await context.route(/^http:\/\/(localhost|127\.0\.0\.1):4000\/bff\/.*/, async (route) => {
        const targetUrl = route
          .request()
          .url()
          .replace(/^http:\/\/(localhost|127\.0\.0\.1):4000/, BFF_BASE);
        try {
          const response = await route.fetch({ url: targetUrl });
          await route.fulfill({ response });
        } catch (err) {
          await route.abort();
          failedHttp.push(`ROUTE_ERR ${targetUrl}: ${err instanceof Error ? err.message : String(err)}`);
        }
      });
    }

    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
    });
    page.on('pageerror', (err) => {
      pageErrors.push(err.message || String(err));
    });
    page.on('response', (res) => {
      if (res.status() >= 400) {
        failedHttp.push(`${res.status()} ${res.url()}`);
      }
    });

    console.log(`\n[NAV] Navigating to ${STOREFRONT_BASE}/#occasion ...`);
    await page.goto(`${STOREFRONT_BASE}/#occasion`, { waitUntil: 'networkidle', timeout: 45_000 });
    await page.waitForSelector('#occasion', { timeout: 20_000 });
    await page.waitForSelector('#occTabs button', { timeout: 20_000 });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(800);

    // Select WEEKEND EASE · CUỐI TUẦN THƯ THÁI
    await selectOccasionByBadge(page, 'WEEKEND EASE');

    const weekendState = await inspectCurrentOccasionState(page);
    await page.screenshot({
      path: path.join(AUDIT_DIR, '01-frameless-weekend-1440.png'),
      fullPage: false,
    });

    // Check 1: No Arch Box
    const containerChecks = ['bouquet', 'subjectStage', 'centerColumn', 'subjectLink'].map((k) => {
      const b = weekendState.boxes[k];
      if (!b) return { k, ok: false, detail: 'missing' };
      const noRadius = b.borderRadius === '0px' || b.borderRadius === '0px 0px 0px 0px';
      const visOverflow = b.overflow === 'visible';
      const noBorder = b.borderWidth === '0px/0px/0px/0px' || b.borderStyle === 'none';
      const noShadow = b.boxShadow === 'none';
      const transparentBg = b.backgroundColor === 'rgba(0, 0, 0, 0)' || b.backgroundColor === 'transparent';
      return {
        k,
        ok: noRadius && visOverflow && noBorder && noShadow && transparentBg,
        detail: `${k}: radius=${b.borderRadius} overflow=${b.overflow} border=${b.borderWidth}/${b.borderStyle} shadow=${b.boxShadow} bg=${b.backgroundColor}`,
      };
    });
    const check1Ok = weekendState.archEls === 0 && containerChecks.every((c) => c.ok);
    recordCheck(
      'CHECK_1',
      'No Arch Box — overflow:visible, zero border-radius/border/box-shadow on central stage',
      check1Ok,
      [
        `.occ__arch count=${weekendState.archEls}`,
        ...containerChecks.map((c) => `${c.ok ? 'OK' : 'BAD'} ${c.detail}`),
      ],
    );

    // Check 2: 3 Optical Layers & Magazine Overlap
    const overlap = weekendState.overlapPx;
    const overlapOk = typeof overlap === 'number' && overlap >= 8 && overlap <= 30;
    const auraOk =
      Boolean(weekendState.aura) &&
      weekendState.auraZ === 10 &&
      weekendState.aura.filter.includes('blur');
    const haloOk =
      Boolean(weekendState.wireHalo) &&
      weekendState.haloZ === 10 &&
      weekendState.wireHalo.circles >= 2 &&
      weekendState.wireHalo.maskImage.includes('linear-gradient');
    const zStackOk =
      weekendState.bouquetZ === 24 &&
      weekendState.headingZ === 18 &&
      weekendState.bouquetZ > weekendState.headingZ &&
      weekendState.mainGridZ === 'auto';
    const subjectImgOk =
      Boolean(weekendState.subjectImg) &&
      weekendState.subjectImg.complete &&
      weekendState.subjectImg.src.includes('/occasion-cutouts/') &&
      weekendState.subjectImg.naturalWidth >= 1080 &&
      weekendState.subjectImg.naturalHeight >= 1440 &&
      weekendState.subjectImg.maskImage.includes('linear-gradient') &&
      weekendState.subjectImg.maskImage.includes('radial-gradient');

    const check2Ok = auraOk && haloOk && zStackOk && overlapOk && subjectImgOk;
    recordCheck(
      'CHECK_2',
      '3 Optical Layers, Magazine Overlap (8..30px), Pure Alpha Cutout & Multi-Point CSS Mask',
      check2Ok,
      [
        `aura: z=${weekendState.auraZ} size=${weekendState.aura?.width}x${weekendState.aura?.height} filter=${weekendState.aura?.filter}`,
        `wireHalo: z=${weekendState.haloZ} circles=${weekendState.wireHalo?.circles} mask=${weekendState.wireHalo?.maskImage?.slice(0, 80)}`,
        `stacking: subjectZ=${weekendState.bouquetZ} > headingZ=${weekendState.headingZ} mainGridZ=${weekendState.mainGridZ}`,
        `overlap: wordBottom=${weekendState.wordRect?.bottom} imgTop=${weekendState.subjectImg?.rect?.top} overlap=${overlap}px (target 8..30px)`,
        `subjectImg: src=${weekendState.subjectImg?.src} natural=${weekendState.subjectImg?.naturalWidth}x${weekendState.subjectImg?.naturalHeight}`,
        `subjectMask: ${weekendState.subjectImg?.maskImage}`,
      ],
    );

    // Check 3: CircularFabricLens & Floating ✦ THỬ ĐỒ AI
    const lens = weekendState.lens;
    const lensRadiusNum = Number.parseFloat(lens?.borderRadius || '0');
    const lensIsCircle =
      Boolean(lens) &&
      Math.abs(lens.width - lens.height) <= 2 &&
      (lens.borderRadius === '50%' || lensRadiusNum >= lens.width * 0.48) &&
      Number.parseFloat(lens.borderWidth || '99') <= 2 &&
      lens.imgLoaded;
    const pointerOk = Boolean(weekendState.lensPointer?.visible);
    const pill = weekendState.tryOnPill;
    const pillOk =
      Boolean(pill) &&
      pill.text.includes('THỬ ĐỒ AI') &&
      pill.zIndex >= 30 &&
      typeof pill.relTopInSubject === 'number' &&
      pill.relTopInSubject >= 0.65 &&
      pill.relTopInSubject <= 1.05;

    const check3Ok = lensIsCircle && pointerOk && pillOk;
    recordCheck(
      'CHECK_3',
      'CircularFabricLens (true circle + thin gold border + pointer) & Floating ✦ THỬ ĐỒ AI Pill',
      check3Ok,
      [
        `lens: ${lens?.width}x${lens?.height} radius=${lens?.borderRadius} border=${lens?.borderWidth} ${lens?.borderColor} imgLoaded=${lens?.imgLoaded} src=${lens?.imgSrc}`,
        `pointer: visible=${weekendState.lensPointer?.visible} ${weekendState.lensPointer?.width}x${weekendState.lensPointer?.height}`,
        `tryOnPill: "${pill?.text}" z=${pill?.zIndex} relTopInSubject=${pill?.relTopInSubject} (target >=0.65 lower mist) bg=${pill?.backgroundColor} color=${pill?.color}`,
      ],
    );

    // Check 4: Preserved 5 Regions & Exact Spelling
    const navLightOk =
      weekendState.navIsLight === true &&
      weekendState.navColor === 'rgb(28, 20, 16)' &&
      weekendState.navBeforeOpacity === '0';
    const spellingOk =
      weekendState.tabBadges.length === EXPECTED_BADGES.length &&
      EXPECTED_BADGES.every((b, idx) => weekendState.tabBadges[idx] === b);
    const thumbsOk =
      weekendState.thumbs.length === 4 &&
      weekendState.thumbs.every(
        (t) =>
          t.borderRadius === '8px' &&
          t.aspect >= 0.7 &&
          t.aspect <= 0.8 &&
          t.complete &&
          t.naturalWidth > 0 &&
          !t.src.includes('/occasion-cutouts/'),
      );
    const check4Ok = navLightOk && spellingOk && thumbsOk && weekendState.copyVisible;
    recordCheck(
      'CHECK_4',
      'Preserved 5 Regions, Light Header Sync, Exact 6-Occasion Spelling & 4 Framed 3:4 Thumbnails',
      check4Ok,
      [
        `nav: isLight=${weekendState.navIsLight} color=${weekendState.navColor} ::before.opacity=${weekendState.navBeforeOpacity} data-nav-theme=${weekendState.navThemeAttr}`,
        `badges (${weekendState.tabBadges.length}): ${weekendState.tabBadges.join(' | ')}`,
        `copyVisible=${weekendState.copyVisible} | thumbs (${weekendState.thumbs.length}): ${weekendState.thumbs.map((t) => `${t.width}x${t.height}(r=${t.borderRadius},ar=${t.aspect},nat=${t.naturalWidth}x${t.naturalHeight})`).join(', ')}`,
      ],
    );

    // =========================================================================
    // CHECK 5: Click through Cards 2, 3, 4 in WEEKEND EASE
    // =========================================================================
    const cardSwapLog = [];
    const seenCardSrcs = new Set([weekendState.subjectImg?.src]);
    let allCardSwapsOk = true;
    for (const cardIdx of [1, 2, 3]) {
      const prevMeta = (await page.locator('#occMeta').textContent())?.trim() || '';
      await page.locator('[data-testid="occasion-set-thumbnails"] button').nth(cardIdx).click();
      await page
        .waitForFunction(
          (oldMeta) => {
            const cur = (document.querySelector('#occMeta')?.textContent || '').trim();
            return cur && cur !== oldMeta;
          },
          prevMeta,
          { timeout: 6000 },
        )
        .catch(() => {});
      await waitForOccasionSettle(page);
      const st = await inspectCurrentOccasionState(page);
      const ok =
        Boolean(st.subjectImg?.complete) &&
        st.subjectImg.src.includes('/occasion-cutouts/') &&
        st.subjectImg.naturalWidth >= 1080 &&
        st.subjectImg.naturalHeight >= 1440 &&
        !seenCardSrcs.has(st.subjectImg.src);
      seenCardSrcs.add(st.subjectImg?.src);
      if (!ok) allCardSwapsOk = false;
      cardSwapLog.push(
        `card #${cardIdx + 1}: ok=${ok} meta="${st.metaText}" src=${st.subjectImg?.src} nat=${st.subjectImg?.naturalWidth}x${st.subjectImg?.naturalHeight}`,
      );
      if (cardIdx === 1) {
        await page.screenshot({
          path: path.join(AUDIT_DIR, '02-frameless-weekend-card2-1440.png'),
          fullPage: false,
        });
      }
    }
    recordCheck('CHECK_5', 'WEEKEND EASE cards 2, 3, 4 smooth frameless cutout swaps', allCardSwapsOk, cardSwapLog);

    // =========================================================================
    // CHECK 6: Sweep ALL 6 Occasions (EVENING COUTURE dark, MODERN TAILORING, BRIDAL GUEST, etc.)
    // =========================================================================
    const sweepOrder = [
      { badge: 'EVENING COUTURE', expectDark: true, expectBg: 'rgb(28, 20, 16)', shot: '03-frameless-evening-dark-1440.png' },
      { badge: 'MODERN TAILORING', expectDark: false, expectBg: null, shot: '04-frameless-modern-tailoring-1440.png' },
      { badge: 'WEEKEND EASE', expectDark: false, expectBg: null, shot: null },
      { badge: 'RESORT CAPSULE', expectDark: false, expectBg: null, shot: null },
      { badge: 'GALLERY EDIT', expectDark: true, expectBg: 'rgb(38, 33, 29)', shot: null },
      { badge: 'BRIDAL GUEST', expectDark: false, expectBg: null, shot: '05-frameless-bridal-1440.png' },
    ];

    const sweepDetails = [];
    let sweepOk = true;
    let lastActiveMetaForTryOn = '';

    for (const step of sweepOrder) {
      await selectOccasionByBadge(page, step.badge);
      const st = await inspectCurrentOccasionState(page);
      const bgMatch = step.expectBg ? st.bgColor === step.expectBg : true;
      const darkHeaderOk = step.expectDark
        ? st.navIsLight === false && st.navThemeAttr === 'dark' && bgMatch
        : st.navIsLight === true && st.navThemeAttr === 'light';
      const imgOk =
        Boolean(st.subjectImg?.complete) &&
        st.subjectImg.src.includes('/occasion-cutouts/') &&
        st.subjectImg.naturalWidth >= 1080 &&
        st.subjectImg.naturalHeight >= 1440 &&
        st.subjectImg.maskImage.includes('linear-gradient') &&
        st.subjectImg.maskImage.includes('radial-gradient');
      const lensOk =
        Boolean(st.lens?.imgLoaded) && Math.abs((st.lens?.width ?? 0) - (st.lens?.height ?? 0)) <= 2;
      const thumbsLoaded =
        st.thumbs.length === 4 && st.thumbs.every((t) => t.complete && t.naturalWidth > 0);
      const stepOk = darkHeaderOk && imgOk && lensOk && thumbsLoaded && st.archEls === 0;
      if (!stepOk) sweepOk = false;

      sweepDetails.push(
        `${step.badge}: ok=${stepOk} word="${st.wordText}" dark=${step.expectDark} navIsLight=${st.navIsLight} bg=${st.bgColor} overlap=${st.overlapPx}px img=${st.subjectImg?.naturalWidth}x${st.subjectImg?.naturalHeight}`,
      );

      if (step.shot) {
        await page.screenshot({
          path: path.join(AUDIT_DIR, step.shot),
          fullPage: false,
        });
      }
      lastActiveMetaForTryOn = st.metaText;
    }

    recordCheck(
      'CHECK_6',
      'All 6 Occasions Sweep (incl. EVENING COUTURE dark mode, MODERN TAILORING, BRIDAL GUEST)',
      sweepOk,
      sweepDetails,
    );

    // =========================================================================
    // CHECK 7: Click ✦ THỬ ĐỒ AI Pill -> VirtualTryOnModal opens (z=120) with active product
    // =========================================================================
    const activeProductName = lastActiveMetaForTryOn.split('·')[0].trim();
    await page.locator('[data-testid="occasion-tryon-pill"]').click();
    await page.waitForSelector('[data-testid="virtual-tryon-modal"]', { state: 'visible', timeout: 10_000 });
    await page.waitForTimeout(450);

    const tryOnAudit = await page.evaluate((expectedProd) => {
      const modal = document.querySelector('[data-testid="virtual-tryon-modal"]');
      if (!modal) return { open: false };
      const st = window.getComputedStyle(modal);
      const text = (modal.textContent || '').replace(/\s+/g, ' ');
      const imgs = Array.from(modal.querySelectorAll('img')).map((im) => ({
        src: im.currentSrc || im.getAttribute('src') || '',
        alt: im.alt || '',
        complete: im.complete,
        naturalWidth: im.naturalWidth,
      }));
      return {
        open: true,
        zIndex: Number.parseInt(st.zIndex || '0', 10),
        containsProductName: expectedProd ? text.includes(expectedProd) : false,
        imgCount: imgs.length,
        excerpt: text.slice(0, 180),
      };
    }, activeProductName);

    // Close modal cleanly via Escape
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);

    const check7Ok =
      tryOnAudit.open === true &&
      tryOnAudit.zIndex >= 120 &&
      tryOnAudit.containsProductName === true;

    recordCheck(
      'CHECK_7',
      'Floating ✦ THỬ ĐỒ AI pill opens [data-testid="virtual-tryon-modal"] (z=120) with active product',
      check7Ok,
      [
        `expectedProduct="${activeProductName}"`,
        `modal: open=${tryOnAudit.open} zIndex=${tryOnAudit.zIndex} containsProductName=${tryOnAudit.containsProductName} imgs=${tryOnAudit.imgCount}`,
      ],
    );

    // =========================================================================
    // CHECK 8: Zero consoleErrors, pageErrors, failedHttp, brokenImgs
    // =========================================================================
    const brokenImgs = await page.evaluate(() => {
      const sec = document.querySelector('#occasion');
      if (!sec) return ['Missing #occasion section'];
      return Array.from(sec.querySelectorAll('img'))
        .filter((im) => {
          const st = window.getComputedStyle(im);
          if (st.display === 'none' || st.visibility === 'hidden') return false;
          return !im.complete || im.naturalWidth === 0;
        })
        .map((im) => im.currentSrc || im.getAttribute('src') || '(no-src)');
    });

    const check8Ok =
      consoleErrors.length === 0 &&
      pageErrors.length === 0 &&
      failedHttp.length === 0 &&
      brokenImgs.length === 0;

    recordCheck(
      'CHECK_8',
      'Zero consoleErrors, pageErrors, failedHttp, and brokenImgs',
      check8Ok,
      [
        `consoleErrors=${consoleErrors.length} pageErrors=${pageErrors.length} failedHttp=${failedHttp.length} brokenImgs=${brokenImgs.length}`,
        ...consoleErrors.slice(0, 5).map((e) => `console: ${e}`),
        ...pageErrors.slice(0, 5).map((e) => `pageerror: ${e}`),
        ...failedHttp.slice(0, 5).map((e) => `http: ${e}`),
        ...brokenImgs.slice(0, 5).map((e) => `brokenImg: ${e}`),
      ],
    );
  } finally {
    await cleanupAll();
  }

  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;
  const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);

  console.log('\n============================================================================');
  console.log(` FRAMELESS AUDIT SUMMARY: PASS=${passed}/${results.length} | FAIL=${failed} | ${elapsedSec}s`);
  console.log(` SCREENSHOTS DIR: ${AUDIT_DIR}`);
  console.log('============================================================================');

  if (failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('\n[FATAL]', err);
  process.exit(1);
});
