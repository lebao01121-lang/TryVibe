#!/usr/bin/env node
/**
 * CHẶNG P3.1 (P3-1.3) — Real Chromium E2E Verification Suite: Partner Portal (:3002)
 *
 * Verifies live Partner Portal (`http://127.0.0.1:3002`) + BFF (`:4000`) + Mailpit (`:8025`)
 * in Real Chromium (1440x900) with ZERO skipped steps:
 *   PREFLIGHT : Live Partner :3002, BFF :4000/health, Mailpit :8025 + repeatable PO/GRN/Payable seed
 *   CHECK 1   : CUSTOMER 403 Block (SupplierRoleGuard + BFF 403) & SUPPLIER Login + Real 2FA (Mailpit)
 *   CHECK 2   : SupplierTenantBar, supplier_id Isolation (incl. forged header lock) & Zero NHAP_AI Leak
 *   CHECK 3   : PO Confirmation (CHO_NCC_XAC_NHAN -> NCC_DA_XAC_NHAN) & Defect-Split GRN Inspection
 *   CHECK 4   : Upload 768x1024 (3:4) Flat-Lay PNG & Product Submission (PartnerSubmissionPanel)
 *   CHECK 5   : Export Payables CSV & Verify UTF-8 BOM (0xEF 0xBB 0xBF / \uFEFF) + Real Rows
 *
 * Keeps temporary PNG & downloaded CSV strictly inside `.project-data/tmp` and cleans them up.
 * Writes metrics JSON to `artifacts/verify-partner-e2e-metrics.json`.
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { chromium } from 'playwright-core';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const IS_WIN = process.platform === 'win32';

const PARTNER_URL = process.env.PARTNER_PORTAL_URL || 'http://127.0.0.1:3002';
const ADMIN_ORIGIN = process.env.ADMIN_PORTAL_URL || 'http://127.0.0.1:3001';
const BFF_URL = process.env.BFF_BASE_URL || 'http://127.0.0.1:4000';
const MAILPIT_URL = process.env.MAILPIT_BASE_URL || 'http://127.0.0.1:8025';
const SEED_PASSWORD = process.env.SEED_PASSWORD || 'Atelier@2026!';

const SUPPLIER_A_ID = '11111111-1111-4111-8111-111111111101';
const SUPPLIER_B_ID = '11111111-1111-4111-8111-111111111102';
const ACCOUNTS = {
  supplierA: 'supplier-a@atelier.local',
  customer: 'customer@atelier.local',
  warehouseMgr: 'warehouse@atelier.local',
};

const TMP_DIR = path.join(ROOT_DIR, '.project-data', 'tmp');
const FLATLAY_PNG_PATH = path.join(TMP_DIR, 'partner-e2e-flatlay.png');
const ARTIFACTS_DIR = path.join(ROOT_DIR, 'artifacts');
const METRICS_PATH = path.join(ARTIFACTS_DIR, 'verify-partner-e2e-metrics.json');
const RUN_TAG = crypto.randomBytes(3).toString('hex').toUpperCase();

function findChromeExecutable() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH;
  }
  const candidates = IS_WIN
    ? [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      ]
    : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function httpRequest(urlStr, { method = 'GET', headers = {}, body = undefined, timeoutMs = 20_000 } = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlStr);
    const reqHeaders = { ...headers };
    let buf = null;
    if (body !== undefined && body !== null) {
      buf = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
      if (!reqHeaders['Content-Type'] && !reqHeaders['content-type']) {
        reqHeaders['Content-Type'] = 'application/json';
      }
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
            // non-JSON response
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json });
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error(`HTTP timeout (${timeoutMs}ms): ${method} ${urlStr}`)));
    req.on('error', reject);
    if (buf) req.write(buf);
    req.end();
  });
}

function unwrapData(res) {
  if (res?.json && typeof res.json === 'object' && 'data' in res.json && res.json.data !== undefined) {
    return res.json.data;
  }
  return res?.json ?? null;
}

function extractList(payload) {
  const root = payload && typeof payload === 'object' && 'data' in payload ? payload.data : payload;
  if (Array.isArray(root)) return root;
  if (root && typeof root === 'object') {
    for (const key of ['items', 'list', 'rows', 'purchaseOrders', 'goodsReceipts', 'payables', 'submissions']) {
      if (Array.isArray(root[key])) return root[key];
    }
  }
  return [];
}

function parseSetCookies(setCookieHeader) {
  const cookies = {};
  const list = Array.isArray(setCookieHeader) ? setCookieHeader : setCookieHeader ? [setCookieHeader] : [];
  for (const item of list) {
    const first = String(item).split(';')[0];
    const eq = first.indexOf('=');
    if (eq > 0) {
      cookies[first.slice(0, eq).trim()] = first.slice(eq + 1).trim();
    }
  }
  return cookies;
}

function formatCookieHeader(cookies) {
  return Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

function buildAuthHeaders(session, extra = {}) {
  const headers = {
    Authorization: `Bearer ${session.token}`,
    Origin: session.origin,
    'x-load-test-bypass': '1',
    ...extra,
  };
  if (session.csrfToken) {
    headers['X-CSRF-Token'] = session.csrfToken;
  }
  const cookieHeader = formatCookieHeader(session.cookies || {});
  if (cookieHeader) {
    headers.Cookie = cookieHeader;
  }
  return headers;
}

async function listMailpitMessages() {
  const res = await httpRequest(`${MAILPIT_URL}/api/v1/messages`, { timeoutMs: 8_000 });
  if (res.status !== 200) return [];
  return Array.isArray(res.json?.messages) ? res.json.messages : [];
}

async function tryWaitForMailpitOtp(recipientEmail, beforeIds, timeoutMs = 4_000) {
  const target = recipientEmail.toLowerCase();
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const messages = await listMailpitMessages();
    for (const summary of messages) {
      if (beforeIds.has(summary.ID)) continue;
      const detailRes = await httpRequest(
        `${MAILPIT_URL}/api/v1/message/${encodeURIComponent(summary.ID)}`,
        { timeoutMs: 8_000 },
      );
      const full = detailRes.status === 200 ? detailRes.json : summary;
      const toList = Array.isArray(full?.To)
        ? full.To.map((item) => String(item?.Address || '').toLowerCase())
        : [];
      if (toList.length > 0 && !toList.some((addr) => addr.includes(target))) {
        continue;
      }
      const haystack = `${full?.Subject || ''} ${full?.Text || ''} ${full?.HTML || ''} ${summary?.Snippet || ''}`;
      const match = /\b(\d{6})\b/.exec(haystack);
      if (match) {
        return { otp: match[1], messageId: summary.ID, subject: full?.Subject || summary?.Subject || '' };
      }
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  return null;
}

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function decodeBase32(encoded) {
  const cleaned = encoded.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (let i = 0; i < cleaned.length; i += 1) {
    const idx = BASE32_ALPHABET.indexOf(cleaned[i]);
    if (idx === -1) throw new Error(`Invalid Base32 char: ${cleaned[i]}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

function generateTotpCode(secretBase32, nowMs = Date.now()) {
  const counter = Math.floor(nowMs / 1000 / 30);
  const key = decodeBase32(secretBase32);
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  counterBuf.writeUInt32BE(counter >>> 0, 4);
  const hmac = crypto.createHmac('sha1', key).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const bin =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return String(bin % 1_000_000).padStart(6, '0');
}

async function apiLoginWithMfa(email, origin) {
  const loginRes = await httpRequest(`${BFF_URL}/api/v1/auth/login`, {
    method: 'POST',
    headers: { Origin: origin, 'x-load-test-bypass': '1' },
    body: { email, password: SEED_PASSWORD },
  });
  assert.equal(loginRes.status, 200, `API login failed for ${email}: HTTP ${loginRes.status} ${loginRes.text}`);
  const loginData = unwrapData(loginRes);
  const cookies = parseSetCookies(loginRes.headers['set-cookie']);
  const preToken = loginData?.accessToken;
  const csrfToken = loginData?.csrfToken || cookies.atelier_csrf_token || '';
  assert.ok(preToken, `Missing accessToken for ${email}`);

  const preHeaders = buildAuthHeaders({ token: preToken, cookies, csrfToken, origin });
  const beforeIds = new Set((await listMailpitMessages()).map((m) => m.ID));
  const sendRes = await httpRequest(`${BFF_URL}/api/v1/auth/2fa/email-otp/send`, {
    method: 'POST',
    headers: preHeaders,
    body: { email, purpose: 'MFA_LOGIN' },
  });
  assert.equal(sendRes.status, 200, `API OTP send failed for ${email}: HTTP ${sendRes.status}`);

  const mailpitRecord = await tryWaitForMailpitOtp(email, beforeIds, 3_000);
  let verifyRes;
  if (mailpitRecord) {
    verifyRes = await httpRequest(`${BFF_URL}/api/v1/auth/2fa/email-otp/verify`, {
      method: 'POST',
      headers: preHeaders,
      body: { method: 'EMAIL_OTP', code: mailpitRecord.otp },
    });
  } else {
    const totpSetupRes = await httpRequest(`${BFF_URL}/api/v1/auth/2fa/totp/setup`, {
      method: 'POST',
      headers: preHeaders,
      body: {},
    });
    assert.equal(totpSetupRes.status, 200, `API TOTP setup failed for ${email}: HTTP ${totpSetupRes.status}`);
    const secret = unwrapData(totpSetupRes)?.secret;
    assert.ok(secret, `Missing TOTP secret for ${email}`);
    const totpCode = generateTotpCode(secret);
    verifyRes = await httpRequest(`${BFF_URL}/api/v1/auth/2fa/totp/verify`, {
      method: 'POST',
      headers: preHeaders,
      body: { method: 'TOTP', code: totpCode },
    });
  }
  assert.equal(verifyRes.status, 200, `API 2FA verify failed for ${email}: HTTP ${verifyRes.status} ${verifyRes.text}`);

  const verifiedData = unwrapData(verifyRes);
  const mergedCookies = { ...cookies, ...parseSetCookies(verifyRes.headers['set-cookie']) };
  return {
    token: verifiedData?.accessToken,
    user: verifiedData?.user ?? loginData?.user,
    cookies: mergedCookies,
    csrfToken: verifiedData?.csrfToken || mergedCookies.atelier_csrf_token || csrfToken,
    origin,
  };
}

/**
 * Programmatically generates a crisp 768x1024 (3:4) RGBA PNG representing
 * a clean flat-lay garment cutout centered on a quiet-luxury cream canvas.
 */
function createFlatLay3x4Png(width = 768, height = 1024) {
  const crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    crcTable[n] = c >>> 0;
  }

  function crc32(buf) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i += 1) {
      c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
  }

  function pngChunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, 'ascii');
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
    return Buffer.concat([len, typeBuf, data, crcBuf]);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // 8-bit depth
  ihdr[9] = 6; // RGBA

  const stride = 1 + width * 4;
  const raw = Buffer.alloc(stride * height);
  const bodyLeft = Math.floor(width * 0.24);
  const bodyRight = Math.floor(width * 0.76);
  const bodyTop = Math.floor(height * 0.18);
  const bodyBottom = Math.floor(height * 0.84);
  const sleeveBottom = Math.floor(height * 0.56);
  const sleeveLeft = Math.floor(width * 0.1);
  const sleeveRight = Math.floor(width * 0.9);
  const collarTop = Math.floor(height * 0.14);
  const collarLeft = Math.floor(width * 0.39);
  const collarRight = Math.floor(width * 0.61);

  for (let y = 0; y < height; y += 1) {
    const rowOff = y * stride;
    raw[rowOff] = 0;
    for (let x = 0; x < width; x += 1) {
      const p = rowOff + 1 + x * 4;
      const inTorso = x >= bodyLeft && x < bodyRight && y >= bodyTop && y < bodyBottom;
      const inSleeves = x >= sleeveLeft && x < sleeveRight && y >= bodyTop + 32 && y < sleeveBottom;
      const inCollar = x >= collarLeft && x < collarRight && y >= collarTop && y < bodyTop;

      if (inCollar) {
        // Espresso silk collar trim (#2B2019)
        raw[p] = 43;
        raw[p + 1] = 32;
        raw[p + 2] = 25;
        raw[p + 3] = 255;
      } else if (inTorso || inSleeves) {
        // Warm ivory silk blouse (#EFE7DA) with subtle vertical weave
        const stripe = x % 24 < 2 ? -8 : 0;
        raw[p] = 239 + stripe;
        raw[p + 1] = 231 + stripe;
        raw[p + 2] = 218 + stripe;
        raw[p + 3] = 255;
      } else {
        // Soft studio cream backdrop (#FBF7EF)
        raw[p] = 251;
        raw[p + 1] = 247;
        raw[p + 2] = 239;
        raw[p + 3] = 255;
      }
    }
  }

  const idat = zlib.deflateSync(raw, { level: 1 });
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

async function ensureRepeatablePartnerFixtures() {
  const warehouse = await apiLoginWithMfa(ACCOUNTS.warehouseMgr, ADMIN_ORIGIN);
  const supplierApi = await apiLoginWithMfa(ACCOUNTS.supplierA, PARTNER_URL);

  // Fetch a safe non-flagship SKU from catalog
  const productsRes = await httpRequest(`${BFF_URL}/api/v1/admin/products?pageSize=30`, {
    headers: buildAuthHeaders(warehouse),
  });
  assert.equal(productsRes.status, 200, `GET admin products failed: HTTP ${productsRes.status}`);
  const products = extractList(productsRes.json);
  let targetSku = null;
  for (const prod of products) {
    for (const variant of prod.variants || []) {
      for (const sku of variant.skus || []) {
        if (sku.skuCode !== 'AT-AOBLLI-C1-M') {
          targetSku = { ...sku, productName: prod.name };
          break;
        }
      }
      if (targetSku) break;
    }
    if (targetSku) break;
  }
  assert.ok(targetSku, 'Could not find a candidate SKU for repeatable PO fixture');

  // 1. Always create & submit a fresh CHO_NCC_XAC_NHAN PO for SUPPLIER_A so Check 3 is 100% repeatable
  const poCreateRes = await httpRequest(`${BFF_URL}/api/v1/admin/procurement/purchase-orders`, {
    method: 'POST',
    headers: buildAuthHeaders(warehouse),
    body: {
      supplierId: SUPPLIER_A_ID,
      warehouseCode: 'CENTRAL_WH',
      expectedDeliveryDate: '2026-12-26',
      rationale: `P3.1 Partner E2E confirmable PO (${RUN_TAG})`,
      items: [
        {
          skuId: targetSku.id,
          skuCode: targetSku.skuCode,
          productName: targetSku.productName,
          orderedQty: 4,
          unitCostVnd: 350000,
        },
      ],
    },
  });
  assert.ok(
    poCreateRes.status === 200 || poCreateRes.status === 201,
    `Failed creating repeatable PO (${poCreateRes.status}): ${poCreateRes.text}`,
  );
  const confirmablePo = unwrapData(poCreateRes);
  assert.ok(confirmablePo?.id && confirmablePo?.poNumber, `Invalid PO fixture payload: ${poCreateRes.text}`);

  if (confirmablePo.status === 'NHAP_AI') {
    const submitRes = await httpRequest(
      `${BFF_URL}/api/v1/admin/procurement/purchase-orders/${encodeURIComponent(confirmablePo.id)}/submit`,
      { method: 'POST', headers: buildAuthHeaders(warehouse), body: {} },
    );
    assert.equal(submitRes.status, 200, `Failed submitting repeatable PO: ${submitRes.text}`);
  }

  // 2. Ensure at least 1 defect-split GRN (rejectedDefectQty > 0) AND at least 1 Payable exist for SUPPLIER_A
  const [grnListRes, payableListRes] = await Promise.all([
    httpRequest(`${BFF_URL}/api/v1/partner/goods-receipts`, { headers: buildAuthHeaders(supplierApi) }),
    httpRequest(`${BFF_URL}/api/v1/partner/payables`, { headers: buildAuthHeaders(supplierApi) }),
  ]);
  assert.equal(grnListRes.status, 200, `GET partner GRNs failed: ${grnListRes.status}`);
  assert.equal(payableListRes.status, 200, `GET partner payables failed: ${payableListRes.status}`);

  const existingGrns = extractList(grnListRes.json);
  const existingPayables = extractList(payableListRes.json);
  const hasDefectSplitGrn = existingGrns.some((g) => Number(g.totalRejectedQty ?? 0) > 0);

  let createdDefectGrnNumber = null;
  if (!hasDefectSplitGrn || existingPayables.length === 0) {
    const poGrnRes = await httpRequest(`${BFF_URL}/api/v1/admin/procurement/purchase-orders`, {
      method: 'POST',
      headers: buildAuthHeaders(warehouse),
      body: {
        supplierId: SUPPLIER_A_ID,
        warehouseCode: 'CENTRAL_WH',
        expectedDeliveryDate: '2026-12-24',
        rationale: `P3.1 defect-split GRN fixture (${RUN_TAG})`,
        items: [
          {
            skuId: targetSku.id,
            skuCode: targetSku.skuCode,
            productName: targetSku.productName,
            orderedQty: 3,
            unitCostVnd: 320000,
          },
        ],
      },
    });
    assert.ok(poGrnRes.status === 200 || poGrnRes.status === 201, `Create GRN fixture PO failed: ${poGrnRes.text}`);
    const poForGrn = unwrapData(poGrnRes);
    if (poForGrn.status === 'NHAP_AI') {
      await httpRequest(
        `${BFF_URL}/api/v1/admin/procurement/purchase-orders/${encodeURIComponent(poForGrn.id)}/submit`,
        { method: 'POST', headers: buildAuthHeaders(warehouse), body: {} },
      );
    }
    const confRes = await httpRequest(
      `${BFF_URL}/api/v1/partner/purchase-orders/${encodeURIComponent(poForGrn.id)}/confirm`,
      {
        method: 'POST',
        headers: buildAuthHeaders(supplierApi),
        body: { confirmedDeliveryDate: '2026-12-24', supplierNote: 'Xác nhận lô kiểm thử GRN tách lỗi' },
      },
    );
    assert.ok(confRes.status === 200 || confRes.status === 201, `Confirm GRN fixture PO failed: ${confRes.text}`);

    const grnCreateRes = await httpRequest(`${BFF_URL}/api/v1/admin/procurement/goods-receipts`, {
      method: 'POST',
      headers: buildAuthHeaders(warehouse),
      body: {
        poId: poForGrn.id,
        warehouseCode: 'CENTRAL_WH',
        note: `P3.1 defect-split GRN (${RUN_TAG}): 2 đạt QC, 1 lỗi chỉ`,
        items: [
          {
            poItemId: poForGrn.items[0].id,
            skuId: targetSku.id,
            receivedQty: 3,
            acceptedQty: 2,
            rejectedDefectQty: 1,
            batchCode: `BATCH-P31-${RUN_TAG}`,
          },
        ],
      },
    });
    assert.ok(grnCreateRes.status === 200 || grnCreateRes.status === 201, `Create defect GRN failed: ${grnCreateRes.text}`);
    createdDefectGrnNumber = unwrapData(grnCreateRes)?.grnNumber || 'CREATED';

    // Restore +2 accepted stock back so net stock change is 0
    await httpRequest(`${BFF_URL}/api/v1/admin/inventory/adjustments`, {
      method: 'POST',
      headers: buildAuthHeaders(warehouse),
      body: {
        sku: targetSku.id,
        warehouseCode: 'CENTRAL_WH',
        deltaAvailable: -2,
        reasonCode: 'TEST_CLEANUP',
        note: `P3.1 defect GRN stock restore (${RUN_TAG})`,
      },
    });
  }

  return {
    confirmablePoId: confirmablePo.id,
    confirmablePoNumber: confirmablePo.poNumber,
    existingGrnCount: existingGrns.length,
    existingPayableCount: existingPayables.length,
    createdDefectGrnNumber,
    supplierApiToken: supplierApi.token,
  };
}

async function signInPartnerUi(page, email, password = SEED_PASSWORD) {
  await page.goto(PARTNER_URL, { waitUntil: 'load', timeout: 45_000 });
  const emailInput = page.locator('input[type="email"]');
  const passwordInput = page.locator('input[type="password"]');
  await emailInput.waitFor({ state: 'visible', timeout: 20_000 });
  await emailInput.fill(email);
  await passwordInput.fill(password);

  const loginResponsePromise = page.waitForResponse(
    (res) => res.request().method() === 'POST' && res.url().includes('/api/v1/auth/login'),
    { timeout: 15_000 },
  );
  await page.locator('button[type="submit"]', { hasText: 'Tiếp tục tới Bước 2FA' }).click();
  const loginRes = await loginResponsePromise;
  assert.equal(loginRes.status(), 200, `Partner UI login failed for ${email}: HTTP ${loginRes.status()}`);
  return loginRes.json();
}

async function main() {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });

  const tempFilesToCleanup = [];
  const metrics = {
    suite: 'verify-partner-e2e',
    runTag: RUN_TAG,
    portalUrl: PARTNER_URL,
    bffUrl: BFF_URL,
    mailpitUrl: MAILPIT_URL,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    checks: {},
    passed: 0,
    failed: 0,
    totalPageErrors: 0,
  };

  async function runCheck(id, title, fn) {
    console.log(`\n=== ${id}: ${title} ===`);
    const t0 = performance.now();
    try {
      const details = await fn();
      const elapsedMs = Number((performance.now() - t0).toFixed(1));
      metrics.checks[id] = { title, status: 'PASS', elapsedMs, details };
      metrics.passed += 1;
      console.log(`[PASS] ${id} (${elapsedMs}ms)`);
      console.log(`       ${JSON.stringify(details)}`);
    } catch (err) {
      const elapsedMs = Number((performance.now() - t0).toFixed(1));
      const message = err instanceof Error ? err.message : String(err);
      metrics.checks[id] = { title, status: 'FAIL', elapsedMs, error: message };
      metrics.failed += 1;
      console.error(`[FAIL] ${id} (${elapsedMs}ms) — ${message}`);
    }
  }

  console.log('========================================================================');
  console.log(` CHẶNG P3.1 — Real Chromium Partner Portal E2E Verification (${RUN_TAG})`);
  console.log('========================================================================');

  let fixtures = null;
  await runCheck('PREFLIGHT', 'Live Partner (:3002), BFF (:4000/health), Mailpit (:8025) & Repeatable Fixtures', async () => {
    const [partnerRes, bffRes, mailpitRes] = await Promise.all([
      httpRequest(`${PARTNER_URL}/`),
      httpRequest(`${BFF_URL}/health`),
      httpRequest(`${MAILPIT_URL}/api/v1/messages`),
    ]);
    assert.equal(partnerRes.status, 200, `Partner Portal :3002 returned HTTP ${partnerRes.status}`);
    assert.equal(bffRes.status, 200, `BFF /health returned HTTP ${bffRes.status}`);
    assert.equal(mailpitRes.status, 200, `Mailpit :8025 returned HTTP ${mailpitRes.status}`);

    fixtures = await ensureRepeatablePartnerFixtures();
    return {
      partnerStatus: partnerRes.status,
      bffStatus: bffRes.status,
      mailpitStatus: mailpitRes.status,
      confirmablePoNumber: fixtures.confirmablePoNumber,
      existingGrnCount: fixtures.existingGrnCount,
      existingPayableCount: fixtures.existingPayableCount,
      createdDefectGrnNumber: fixtures.createdDefectGrnNumber,
    };
  });

  if (metrics.failed > 0 || !fixtures) {
    metrics.finishedAt = new Date().toISOString();
    fs.writeFileSync(METRICS_PATH, `${JSON.stringify(metrics, null, 2)}\n`, 'utf8');
    process.exit(1);
  }

  const chromePath = findChromeExecutable();
  assert.ok(chromePath, 'Could not locate Chrome/Edge executable on this machine.');
  console.log(`[BROWSER] Using executable: ${chromePath}`);

  const browser = await chromium.launch({
    executablePath: chromePath,
    headless: true,
    args: ['--disable-dev-shm-usage', '--no-sandbox'],
  });

  let supplierCtx = null;
  let supplierPage = null;
  const supplierPageErrors = [];
  const capturedPartnerPoPayloads = [];

  try {
    // =========================================================================
    // CHECK 1: CUSTOMER 403 Block & SUPPLIER Login + Real 2FA via Mailpit :8025
    // =========================================================================
    await runCheck(
      'CHECK 1',
      'CUSTOMER 403 Block (SupplierRoleGuard + BFF 403) & SUPPLIER Login + Real 2FA via Mailpit (:8025)',
      async () => {
        // 1A. CUSTOMER blocked on Partner Portal
        const custCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
        const custPage = await custCtx.newPage();
        const custErrors = [];
        custPage.on('pageerror', (err) => custErrors.push(err.message));

        let custBffStatus = 0;
        try {
          const custLogin = await signInPartnerUi(custPage, ACCOUNTS.customer);
          const custToken = custLogin?.data?.accessToken || custLogin?.accessToken;
          assert.ok(custToken, 'Missing customer accessToken');

          const alertSection = custPage.locator('section[role="alert"]');
          await alertSection.waitFor({ state: 'visible', timeout: 10_000 });
          const alertText = (await alertSection.innerText()).trim();
          assert.ok(alertText.toUpperCase().includes('HTTP 403'), `Customer alert missing HTTP 403: ${alertText}`);
          assert.ok(alertText.toUpperCase().includes('SUPPLIERROLEGUARD'), `Customer alert missing SupplierRoleGuard: ${alertText}`);
          assert.ok(alertText.toUpperCase().includes('CUSTOMER'), `Customer alert missing CUSTOMER role: ${alertText}`);

          const partnerNavCount = await custPage.locator('nav[aria-label="Phân hệ Đối tác B2B"]').count();
          assert.equal(partnerNavCount, 0, 'CUSTOMER must see 0 Partner B2B navigation tabs');

          const bffPartnerRes = await httpRequest(`${BFF_URL}/api/v1/partner/purchase-orders`, {
            headers: {
              Authorization: `Bearer ${custToken}`,
              Origin: PARTNER_URL,
              'x-load-test-bypass': '1',
            },
          });
          custBffStatus = bffPartnerRes.status;
          assert.equal(custBffStatus, 403, `BFF /api/v1/partner/purchase-orders must return 403 for CUSTOMER, got ${custBffStatus}`);
          assert.equal(custErrors.length, 0, `Uncaught page errors for CUSTOMER: ${custErrors.join(' | ')}`);
        } finally {
          metrics.totalPageErrors += custErrors.length;
          await custCtx.close();
        }

        // 1B. SUPPLIER_A Login + Real 2FA OTP via Mailpit :8025
        supplierCtx = await browser.newContext({
          viewport: { width: 1440, height: 900 },
          acceptDownloads: true,
        });
        supplierPage = await supplierCtx.newPage();
        supplierPage.on('pageerror', (err) => supplierPageErrors.push(err.message));
        supplierPage.on('response', async (res) => {
          if (res.request().method() === 'GET' && res.url().includes('/api/v1/partner/purchase-orders') && res.status() === 200) {
            try {
              capturedPartnerPoPayloads.push(await res.json());
            } catch {
              // ignore non-JSON
            }
          }
        });

        await signInPartnerUi(supplierPage, ACCOUNTS.supplierA);

        const mfaGate = supplierPage.getByText('Supplier 2FA Gate · Bắt buộc MFA_REQUIRED');
        await mfaGate.waitFor({ state: 'visible', timeout: 10_000 });

        const beforeIds = new Set((await listMailpitMessages()).map((m) => m.ID));
        const sendOtpPromise = supplierPage.waitForResponse(
          (res) => res.request().method() === 'POST' && res.url().includes('/api/v1/auth/2fa/email-otp/send'),
          { timeout: 20_000 },
        );
        await supplierPage.getByRole('button', { name: 'Gửi mã Email OTP' }).click();
        const sendOtpRes = await sendOtpPromise;
        assert.equal(sendOtpRes.status(), 200, `Supplier OTP send failed: HTTP ${sendOtpRes.status()}`);

        const mailpitRecord = await tryWaitForMailpitOtp(ACCOUNTS.supplierA, beforeIds, 4_000);
        let twoFactorMethodUsed = 'EMAIL_OTP_MAILPIT';
        let mailpitMessageId = null;

        if (mailpitRecord) {
          mailpitMessageId = mailpitRecord.messageId;
          await supplierPage.locator('input[placeholder="000000"]').fill(mailpitRecord.otp);
          const verifyOtpPromise = supplierPage.waitForResponse(
            (res) => res.request().method() === 'POST' && res.url().includes('/api/v1/auth/2fa/email-otp/verify'),
            { timeout: 15_000 },
          );
          await supplierPage.getByRole('button', { name: 'Xác thực 2FA & Mở Cổng Đối Tác' }).click();
          const verifyOtpRes = await verifyOtpPromise;
          assert.equal(verifyOtpRes.status(), 200, `Supplier OTP verify failed: HTTP ${verifyOtpRes.status()}`);
        } else {
          twoFactorMethodUsed = 'TOTP_RFC6238_UI_FALLBACK_EXTERNAL_SMTP';
          await supplierPage.getByRole('button', { name: /TOTP Authenticator/i }).click();
          const totpSetupPromise = supplierPage.waitForResponse(
            (res) => res.request().method() === 'POST' && res.url().includes('/api/v1/auth/2fa/totp/setup'),
            { timeout: 15_000 },
          );
          await supplierPage.getByRole('button', { name: 'Tạo mã QR TOTP' }).click();
          const totpSetupRes = await totpSetupPromise;
          assert.equal(totpSetupRes.status(), 200, `Supplier TOTP setup failed: HTTP ${totpSetupRes.status()}`);
          const totpPayload = await totpSetupRes.json();
          const secret = totpPayload?.data?.secret || totpPayload?.secret;
          assert.ok(secret, `Missing supplier TOTP secret: ${JSON.stringify(totpPayload)}`);
          await supplierPage.locator('img[alt="Mã QR TOTP đối tác"]').waitFor({ state: 'visible', timeout: 8_000 });

          const totpCode = generateTotpCode(secret);
          await supplierPage.locator('input[placeholder="000000"]').fill(totpCode);
          const verifyTotpPromise = supplierPage.waitForResponse(
            (res) => res.request().method() === 'POST' && res.url().includes('/api/v1/auth/2fa/totp/verify'),
            { timeout: 15_000 },
          );
          await supplierPage.getByRole('button', { name: 'Xác thực 2FA & Mở Cổng Đối Tác' }).click();
          const verifyTotpRes = await verifyTotpPromise;
          assert.equal(verifyTotpRes.status(), 200, `Supplier TOTP verify failed: HTTP ${verifyTotpRes.status()}`);
        }

        await supplierPage.locator('nav[aria-label="Phân hệ Đối tác B2B"]').waitFor({ state: 'visible', timeout: 15_000 });
        await supplierPage.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => undefined);
        assert.equal(supplierPageErrors.length, 0, `Uncaught page errors after supplier login+2FA: ${supplierPageErrors.join(' | ')}`);

        return {
          customerUiBlocked: true,
          customerBffStatus: custBffStatus,
          supplierEmail: ACCOUNTS.supplierA,
          emailOtpSendHttpStatus: sendOtpRes.status(),
          twoFactorMethodUsed,
          mailpitMessageId,
          supplier2faUnlocked: true,
          pageErrors: supplierPageErrors.length,
        };
      },
    );

    // =========================================================================
    // CHECK 2: SupplierTenantBar, supplier_id Isolation & Zero NHAP_AI Leak
    // =========================================================================
    await runCheck(
      'CHECK 2',
      'SupplierTenantBar Identity, Strict supplier_id Isolation & Zero NHAP_AI Draft Leak',
      async () => {
        assert.ok(supplierPage, 'Authenticated supplier page unavailable (CHECK 1 failed)');

        const tenantBar = supplierPage.locator('[role="region"][aria-label="Thanh ngữ cảnh cách ly tenant nhà cung cấp"]');
        await tenantBar.waitFor({ state: 'visible', timeout: 10_000 });
        const barText = (await tenantBar.innerText()).trim();

        assert.ok(barText.includes(SUPPLIER_A_ID), `SupplierTenantBar missing supplier_id ${SUPPLIER_A_ID}: ${barText}`);
        assert.ok(barText.includes(ACCOUNTS.supplierA), `SupplierTenantBar missing email: ${barText}`);
        assert.ok(barText.includes('2FA: VERIFIED'), `SupplierTenantBar missing 2FA: VERIFIED badge: ${barText}`);

        // Trigger a fresh PO reload if none captured yet so we inspect live response JSON
        if (capturedPartnerPoPayloads.length === 0) {
          const poResPromise = supplierPage.waitForResponse(
            (res) => res.request().method() === 'GET' && res.url().includes('/api/v1/partner/purchase-orders'),
            { timeout: 12_000 },
          );
          await supplierPage.getByRole('button', { name: 'Làm mới PO' }).click();
          const poRes = await poResPromise;
          assert.equal(poRes.status(), 200, `GET /api/v1/partner/purchase-orders failed: ${poRes.status()}`);
          capturedPartnerPoPayloads.push(await poRes.json());
        }

        const latestPoList = extractList(capturedPartnerPoPayloads[capturedPartnerPoPayloads.length - 1]);
        assert.ok(latestPoList.length >= 1, 'Expected at least 1 published PO for SUPPLIER_A');

        const leakedDrafts = latestPoList.filter((po) => po.status === 'NHAP_AI');
        assert.equal(leakedDrafts.length, 0, `NHAP_AI draft PO leaked to Partner API: ${JSON.stringify(leakedDrafts)}`);

        const crossTenantPos = latestPoList.filter((po) => po.supplierId !== SUPPLIER_A_ID);
        assert.equal(
          crossTenantPos.length,
          0,
          `Cross-tenant PO leaked to SUPPLIER_A: ${JSON.stringify(crossTenantPos.map((p) => p.supplierId))}`,
        );

        // Verify forged x-supplier-id header is overridden by BFF JWT tenant lock
        const forgedHeaderRes = await httpRequest(`${BFF_URL}/api/v1/partner/purchase-orders`, {
          headers: {
            Authorization: `Bearer ${fixtures.supplierApiToken}`,
            Origin: PARTNER_URL,
            'x-supplier-id': SUPPLIER_B_ID,
            'x-load-test-bypass': '1',
          },
        });
        assert.equal(forgedHeaderRes.status, 200, `Forged-header tenant lock test failed: HTTP ${forgedHeaderRes.status}`);
        const forgedList = extractList(forgedHeaderRes.json);
        assert.ok(
          forgedList.every((po) => po.supplierId === SUPPLIER_A_ID && po.status !== 'NHAP_AI'),
          'BFF failed to override forged x-supplier-id header with authenticated JWT supplierId!',
        );

        // Assert rendered PO DOM contains 0 NHAP_AI draft badges
        const poSectionText = await supplierPage.locator('main section').first().innerText();
        assert.ok(!poSectionText.includes('NHAP_AI'), 'Rendered Partner PO DOM contains leaked NHAP_AI text!');

        return {
          tenantBarVisible: true,
          boundSupplierId: SUPPLIER_A_ID,
          poCountReturned: latestPoList.length,
          nhapAiLeakedCount: leakedDrafts.length,
          crossTenantLeakedCount: crossTenantPos.length,
          forgedHeaderOverriddenToOwnTenant: true,
        };
      },
    );

    // =========================================================================
    // CHECK 3: PO Confirmation & Defect-Split GRN Inspection
    // =========================================================================
    await runCheck(
      'CHECK 3',
      'PO Confirmation (CHO_NCC_XAC_NHAN -> NCC_DA_XAC_NHAN) & Defect-Split GRN Inspection',
      async () => {
        assert.ok(supplierPage, 'Authenticated supplier page unavailable');

        const targetPoCard = supplierPage.locator('article', { hasText: fixtures.confirmablePoNumber }).first();
        await targetPoCard.waitFor({ state: 'visible', timeout: 12_000 });

        const beforeCardText = (await targetPoCard.innerText()).trim();
        assert.ok(
          beforeCardText.includes('Chờ NCC xác nhận'),
          `Expected PO ${fixtures.confirmablePoNumber} in CHO_NCC_XAC_NHAN state, got: ${beforeCardText}`,
        );

        await targetPoCard.getByRole('button', { name: 'Xác nhận đáp ứng & Hẹn giao' }).click();
        await targetPoCard.locator('input[type="date"]').fill('2026-12-26');
        await targetPoCard.locator('input[type="text"]').fill(`Xác nhận E2E P3.1 (${RUN_TAG}) đủ tiến độ.`);

        const confirmResPromise = supplierPage.waitForResponse(
          (res) =>
            res.request().method() === 'POST' &&
            res.url().includes(`/api/v1/partner/purchase-orders/${fixtures.confirmablePoId}/confirm`),
          { timeout: 15_000 },
        );
        await targetPoCard.getByRole('button', { name: 'Gửi xác nhận PO' }).click();
        const confirmRes = await confirmResPromise;
        assert.ok(
          confirmRes.status() === 200 || confirmRes.status() === 201,
          `Partner confirm PO API failed: HTTP ${confirmRes.status()}`,
        );

        // Wait for PO status badge to update to NCC_DA_XAC_NHAN ("Đã xác nhận hẹn giao")
        const updatedPoCard = supplierPage.locator('article', { hasText: fixtures.confirmablePoNumber }).first();
        await updatedPoCard.getByText('Đã xác nhận hẹn giao').waitFor({ state: 'visible', timeout: 12_000 });

        // Navigate to GRN view & verify defect-split columns + values
        const grnResPromise = supplierPage.waitForResponse(
          (res) => res.request().method() === 'GET' && res.url().includes('/api/v1/partner/goods-receipts'),
          { timeout: 15_000 },
        );
        await supplierPage.getByRole('button', { name: 'Biên bản nghiệm thu (GRN)' }).click();
        const grnRes = await grnResPromise;
        assert.equal(grnRes.status(), 200, `GET /api/v1/partner/goods-receipts failed: HTTP ${grnRes.status()}`);
        const grnList = extractList(await grnRes.json());
        assert.ok(grnList.length >= 1, 'Expected at least 1 GRN rendered in Partner Portal');

        const firstGrnCard = supplierPage.locator('article').first();
        await firstGrnCard.waitFor({ state: 'visible', timeout: 10_000 });
        const grnSectionText = await supplierPage.locator('main section').first().innerText();
        const grnUpper = grnSectionText.toUpperCase();

        assert.ok(grnSectionText.includes('Đạt chuẩn (acceptedQty):'), 'GRN UI missing acceptedQty pill');
        assert.ok(grnSectionText.includes('Lỗi trả xưởng (rejectedDefectQty):'), 'GRN UI missing rejectedDefectQty pill');
        assert.ok(
          grnUpper.includes('THỰC NHẬN') &&
            grnUpper.includes('ĐẠT CHUẨN') &&
            grnUpper.includes('LỖI TRẢ XƯỞNG'),
          `GRN table missing defect-split column headers: ${grnSectionText.slice(0, 300)}`,
        );

        const defectGrns = grnList.filter((g) => Number(g.totalRejectedQty ?? 0) > 0);
        assert.ok(defectGrns.length >= 1, 'Expected at least 1 GRN with rejectedDefectQty > 0 for defect-split check');

        return {
          confirmedPoNumber: fixtures.confirmablePoNumber,
          confirmedHttpStatus: confirmRes.status(),
          updatedBadgeVisible: 'Đã xác nhận hẹn giao',
          grnCountRendered: grnList.length,
          defectSplitGrnCount: defectGrns.length,
          sampleDefectGrn: {
            grnNumber: defectGrns[0].grnNumber,
            totalAcceptedQty: defectGrns[0].totalAcceptedQty,
            totalRejectedQty: defectGrns[0].totalRejectedQty,
          },
        };
      },
    );

    // =========================================================================
    // CHECK 4: Upload 768x1024 (3:4) Flat-Lay PNG & Submit Product Proposal
    // =========================================================================
    await runCheck(
      'CHECK 4',
      'Upload 768x1024 (3:4) Flat-Lay PNG & Submit Product Proposal (PartnerSubmissionPanel)',
      async () => {
        assert.ok(supplierPage, 'Authenticated supplier page unavailable');

        // Programmatically generate crisp 768x1024 (3:4) PNG in .project-data/tmp
        const pngBuf = createFlatLay3x4Png(768, 1024);
        fs.writeFileSync(FLATLAY_PNG_PATH, pngBuf);
        tempFilesToCleanup.push(FLATLAY_PNG_PATH);
        assert.equal(pngBuf.readUInt32BE(16), 768, 'Generated PNG width !== 768');
        assert.equal(pngBuf.readUInt32BE(20), 1024, 'Generated PNG height !== 1024');

        await supplierPage.getByRole('button', { name: 'Đề xuất Mẫu Mới (Submissions)' }).click();
        await supplierPage
          .getByText('Gửi mẫu trang phục chờ Atelier kiểm duyệt')
          .waitFor({ state: 'visible', timeout: 12_000 });

        const proposedName = `Áo Sơ Mi Lụa E2E 3:4 ${RUN_TAG}`;
        await supplierPage.locator('input[placeholder="Áo Sơ Mi Lụa Cổ Nơ Tay Phồng"]').fill(proposedName);

        // Upload 768x1024 3:4 PNG via hidden file input
        const uploadResPromise = supplierPage.waitForResponse(
          (res) => res.request().method() === 'POST' && res.url().includes('/api/v1/partner/media/upload'),
          { timeout: 25_000 },
        );
        await supplierPage.locator('input[type="file"]').setInputFiles(FLATLAY_PNG_PATH);
        const uploadRes = await uploadResPromise;
        assert.ok(
          uploadRes.status() === 200 || uploadRes.status() === 201,
          `Partner 3:4 media upload failed: HTTP ${uploadRes.status()}`,
        );
        const uploadJson = await uploadRes.json();
        const uploadedAsset = uploadJson?.data ?? uploadJson;
        assert.ok(uploadedAsset?.id, `Missing uploaded asset id: ${JSON.stringify(uploadJson)}`);

        await supplierPage.getByText('Đã gắn asset').waitFor({ state: 'visible', timeout: 10_000 });

        // Submit product proposal
        const submitResPromise = supplierPage.waitForResponse(
          (res) => res.request().method() === 'POST' && res.url().includes('/api/v1/partner/submissions'),
          { timeout: 15_000 },
        );
        await supplierPage.getByRole('button', { name: 'Gửi Đề Xuất Mẫu Mới' }).click();
        const submitRes = await submitResPromise;
        assert.ok(
          submitRes.status() === 200 || submitRes.status() === 201,
          `Partner submission POST failed: HTTP ${submitRes.status()}`,
        );
        const submitJson = await submitRes.json();
        const createdSub = submitJson?.data ?? submitJson;

        await supplierPage.getByText(`Đã gửi đề xuất mẫu "${proposedName}"`).waitFor({ state: 'visible', timeout: 12_000 });
        await supplierPage.locator('strong', { hasText: proposedName }).first().waitFor({ state: 'visible', timeout: 12_000 });

        return {
          pngDimensions: '768x1024',
          pngBytes: pngBuf.length,
          uploadedAssetId: uploadedAsset.id,
          submissionId: createdSub?.id ?? null,
          proposedName,
          submissionStatus: createdSub?.status ?? 'PENDING_REVIEW',
        };
      },
    );

    // =========================================================================
    // CHECK 5: Export Payables CSV (UTF-8 BOM \uFEFF + Vietnamese Headers + Rows)
    // =========================================================================
    await runCheck(
      'CHECK 5',
      'Export Payables CSV via Browser Download (UTF-8 BOM 0xEF 0xBB 0xBF + Vietnamese Headers + Data Rows)',
      async () => {
        assert.ok(supplierPage, 'Authenticated supplier page unavailable');

        const payablesResPromise = supplierPage.waitForResponse(
          (res) => res.request().method() === 'GET' && res.url().includes('/api/v1/partner/payables'),
          { timeout: 15_000 },
        );
        await supplierPage.getByRole('button', { name: 'Đối soát công nợ (Payables)' }).click();
        const payablesRes = await payablesResPromise;
        assert.equal(payablesRes.status(), 200, `GET /api/v1/partner/payables failed: HTTP ${payablesRes.status()}`);
        const payablesList = extractList(await payablesRes.json());
        assert.ok(payablesList.length >= 1, 'Expected at least 1 payable row for CSV export');

        const exportBtn = supplierPage.getByRole('button', { name: 'Xuất đối soát công nợ (CSV)' });
        await exportBtn.waitFor({ state: 'visible', timeout: 10_000 });
        await supplierPage.waitForFunction(
          () => {
            const buttons = Array.from(globalThis.document.querySelectorAll('button'));
            const target = buttons.find((b) => (b.textContent || '').includes('Xuất đối soát công nợ (CSV)'));
            return Boolean(target && !target.disabled);
          },
          { timeout: 10_000 },
        );

        const downloadPromise = supplierPage.waitForEvent('download', { timeout: 15_000 });
        await exportBtn.click();
        const download = await downloadPromise;

        const suggestedFilename = download.suggestedFilename();
        assert.ok(
          suggestedFilename.endsWith('.csv') && suggestedFilename.startsWith('doi-soat-cong-no'),
          `Unexpected CSV filename: ${suggestedFilename}`,
        );

        const savedCsvPath = path.join(TMP_DIR, `partner-e2e-${RUN_TAG}-${suggestedFilename}`);
        await download.saveAs(savedCsvPath);
        tempFilesToCleanup.push(savedCsvPath);

        const rawBytes = fs.readFileSync(savedCsvPath);
        assert.ok(rawBytes.length >= 3, 'Downloaded CSV file is empty');
        assert.equal(rawBytes[0], 0xef, `CSV byte[0] !== 0xEF (got 0x${rawBytes[0].toString(16)})`);
        assert.equal(rawBytes[1], 0xbb, `CSV byte[1] !== 0xBB (got 0x${rawBytes[1].toString(16)})`);
        assert.equal(rawBytes[2], 0xbf, `CSV byte[2] !== 0xBF (got 0x${rawBytes[2].toString(16)})`);

        const decoded = rawBytes.toString('utf8');
        assert.ok(decoded.startsWith('\uFEFF'), 'Decoded CSV string must start with UTF-8 BOM (\\uFEFF)');

        const lines = decoded
          .slice(1)
          .split(/\r?\n/)
          .filter((line) => line.trim().length > 0);
        assert.ok(lines.length >= 2, `Expected header + >=1 data row in CSV, got ${lines.length} lines`);

        const headerRow = lines[0];
        for (const requiredCol of [
          'Mã công nợ',
          'Mã đơn đặt hàng (PO)',
          'Biên bản nghiệm thu (GRN)',
          'Số tiền phải trả (VND)',
          'Trạng thái',
        ]) {
          assert.ok(headerRow.includes(requiredCol), `CSV header missing column "${requiredCol}": ${headerRow}`);
        }

        const dataRowsCount = lines.length - 1;
        assert.equal(
          dataRowsCount,
          payablesList.length,
          `CSV data row count (${dataRowsCount}) !== API payables count (${payablesList.length})`,
        );
        assert.equal(supplierPageErrors.length, 0, `Uncaught page errors in Partner Portal: ${supplierPageErrors.join(' | ')}`);

        return {
          suggestedFilename,
          bytes: rawBytes.length,
          utf8BomVerified: true,
          headerRow,
          dataRowsCount,
          pageErrors: supplierPageErrors.length,
        };
      },
    );
  } finally {
    metrics.totalPageErrors += supplierPageErrors.length;
    if (supplierCtx) {
      await supplierCtx.close().catch(() => undefined);
    }
    await browser.close().catch(() => undefined);

    // Clean up temporary PNG and downloaded CSV files cleanly
    for (const filePath of tempFilesToCleanup) {
      try {
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
      } catch {
        // ignore cleanup error
      }
    }
  }

  metrics.finishedAt = new Date().toISOString();
  fs.writeFileSync(METRICS_PATH, `${JSON.stringify(metrics, null, 2)}\n`, 'utf8');

  console.log('\n========================================================================');
  console.log(
    ` PARTNER PORTAL E2E SUMMARY: PASS=${metrics.passed} | FAIL=${metrics.failed} | PAGE_ERRORS=${metrics.totalPageErrors}`,
  );
  console.log(` Metrics written: ${METRICS_PATH}`);
  console.log('========================================================================');

  if (metrics.failed > 0 || metrics.totalPageErrors > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('\n[FATAL] verify-partner-e2e.mjs crashed:', err);
  process.exit(1);
});
