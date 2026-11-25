#!/usr/bin/env node
/**
 * CHẶNG P2.1 — Live End-to-End Integration & RBAC/Redaction Verification Suite
 * Tests ALL DoD 2 scenarios against live BFF (:4000) with real JWT + 2FA + CSRF tokens.
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

const BFF_BASE = 'http://127.0.0.1:4000';
const MAILPIT_BASE = 'http://127.0.0.1:8025';
const SEED_PASSWORD = 'Atelier@2026!';
const SUPPLIER_A_ID = '11111111-1111-4111-8111-111111111101';

const RUN_TAG = crypto.randomBytes(3).toString('hex').toUpperCase();
const summary = {
  runTag: RUN_TAG,
  startedAt: new Date().toISOString(),
  checks: {},
  passed: 0,
  failed: 0,
};

function apiRequest(urlStr, options = {}) {
  const { method = 'GET', headers = {}, body, timeoutMs = 25_000 } = options;
  const startedAt = performance.now();
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlStr);
    let payloadBuf = null;
    const reqHeaders = { ...headers };

    if (body !== undefined && body !== null) {
      if (Buffer.isBuffer(body)) {
        payloadBuf = body;
      } else if (typeof body === 'string') {
        payloadBuf = Buffer.from(body, 'utf8');
      } else {
        payloadBuf = Buffer.from(JSON.stringify(body), 'utf8');
        if (!reqHeaders['Content-Type'] && !reqHeaders['content-type']) {
          reqHeaders['Content-Type'] = 'application/json';
        }
      }
      reqHeaders['Content-Length'] = String(payloadBuf.length);
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
          const buf = Buffer.concat(chunks);
          const text = buf.toString('utf8');
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            // non-JSON
          }
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            buffer: buf,
            text,
            json,
            elapsedMs: Number((performance.now() - startedAt).toFixed(1)),
          });
        });
      },
    );

    req.on('timeout', () => req.destroy(new Error(`HTTP timeout after ${timeoutMs}ms: ${method} ${urlStr}`)));
    req.on('error', reject);
    if (payloadBuf) req.write(payloadBuf);
    req.end();
  });
}

function unwrapData(res) {
  if (res?.json && typeof res.json === 'object' && 'data' in res.json && res.json.data !== undefined) {
    return res.json.data;
  }
  return res?.json ?? null;
}

function unwrapList(res) {
  const d = unwrapData(res);
  if (Array.isArray(d)) return d;
  if (d && typeof d === 'object') {
    for (const k of ['items', 'reviews', 'customers', 'transactions', 'webhooks', 'users', 'roles']) {
      if (Array.isArray(d[k])) return d[k];
    }
  }
  return [];
}

function unwrapErrorCode(res) {
  return String(res?.json?.error?.code || res?.json?.code || '').trim();
}

function parseSetCookies(setCookieHeader) {
  const cookies = {};
  const arr = Array.isArray(setCookieHeader) ? setCookieHeader : setCookieHeader ? [setCookieHeader] : [];
  for (const item of arr) {
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

function authHeaders(session, extra = {}) {
  const h = {
    Authorization: `Bearer ${session.token}`,
    Origin: session.origin,
    'x-load-test-bypass': '1',
    ...extra,
  };
  if (session.csrfToken) {
    h['X-CSRF-Token'] = session.csrfToken;
  }
  const cookieStr = formatCookieHeader(session.cookies || {});
  if (cookieStr) {
    h.Cookie = cookieStr;
  }
  return h;
}

async function listMailpitMessages() {
  const res = await apiRequest(`${MAILPIT_BASE}/api/v1/messages`, { timeoutMs: 5000 });
  if (res.status !== 200) return [];
  return Array.isArray(res.json?.messages) ? res.json.messages : [];
}

async function waitForMailpitMatch(predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const msgs = await listMailpitMessages();
    for (const m of msgs) {
      const fullRes = await apiRequest(`${MAILPIT_BASE}/api/v1/message/${encodeURIComponent(m.ID)}`);
      const full = fullRes.status === 200 ? fullRes.json : m;
      if (predicate(full, m)) return full;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
}

async function loginPortalUser(email, { password = SEED_PASSWORD, requireMfa = false, origin = 'http://localhost:3001' } = {}) {
  const loginRes = await apiRequest(`${BFF_BASE}/api/v1/auth/login`, {
    method: 'POST',
    headers: { Origin: origin, 'x-load-test-bypass': '1' },
    body: { email, password },
  });
  assert.equal(loginRes.status, 200, `Login failed for ${email} (${loginRes.status}): ${loginRes.text}`);
  const loginData = unwrapData(loginRes);
  const cookies = parseSetCookies(loginRes.headers['set-cookie']);
  const preToken = loginData?.accessToken;
  assert.ok(preToken, `Missing accessToken for ${email}`);

  const csrfToken = loginData?.csrfToken || cookies.atelier_csrf_token || '';
  if (!requireMfa) {
    return { token: preToken, preToken, user: loginData?.user, cookies, csrfToken, origin };
  }

  const beforeIds = new Set((await listMailpitMessages()).map((m) => m.ID));
  const sendRes = await apiRequest(`${BFF_BASE}/api/v1/auth/2fa/email-otp/send`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${preToken}`,
      Origin: origin,
      'x-load-test-bypass': '1',
      ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
      ...(formatCookieHeader(cookies) ? { Cookie: formatCookieHeader(cookies) } : {}),
    },
    body: { email, purpose: 'MFA_LOGIN' },
  });
  assert.equal(sendRes.status, 200, `OTP send failed for ${email} (${sendRes.status}): ${sendRes.text}`);

  let otp = null;
  const otpMsg = await waitForMailpitMatch((full, sum) => {
    if (beforeIds.has(sum.ID)) return false;
    const toList = Array.isArray(full?.To) ? full.To.map((t) => String(t?.Address || '').toLowerCase()) : [];
    if (toList.length > 0 && !toList.some((a) => a.includes(email.toLowerCase()))) return false;
    const combined = `${full?.Subject || ''} ${full?.Text || ''} ${full?.HTML || ''} ${sum?.Snippet || ''}`;
    const m = /\b(\d{6})\b/.exec(combined);
    if (m) {
      otp = m[1];
      return true;
    }
    return false;
  }, 10_000);
  assert.ok(otpMsg && otp, `Could not find 6-digit MFA OTP in Mailpit for ${email}`);

  const verifyRes = await apiRequest(`${BFF_BASE}/api/v1/auth/2fa/email-otp/verify`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${preToken}`,
      Origin: origin,
      'x-load-test-bypass': '1',
      ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
      ...(formatCookieHeader(cookies) ? { Cookie: formatCookieHeader(cookies) } : {}),
    },
    body: { method: 'EMAIL_OTP', code: otp },
  });
  assert.equal(verifyRes.status, 200, `OTP verify failed for ${email} (${verifyRes.status}): ${verifyRes.text}`);
  const verifiedData = unwrapData(verifyRes);
  const mergedCookies = { ...cookies, ...parseSetCookies(verifyRes.headers['set-cookie']) };
  return {
    token: verifiedData?.accessToken,
    preToken,
    user: verifiedData?.user ?? loginData?.user,
    cookies: mergedCookies,
    csrfToken: verifiedData?.csrfToken || mergedCookies.atelier_csrf_token || csrfToken,
    origin,
  };
}

/**
 * Generates an RGBA PNG with transparent borders and an opaque garment box inside
 * so sharp pixel scanning produces an exact non-trivial boundingBoxJsonb.
 */
function createCutoutRgbaPng(width = 400, height = 600, box = { x1: 80, y1: 60, x2: 320, y2: 540 }) {
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
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const stride = 1 + width * 4;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const off = y * stride;
    raw[off] = 0;
    const inY = y >= box.y1 && y < box.y2;
    for (let x = 0; x < width; x += 1) {
      const p = off + 1 + x * 4;
      if (inY && x >= box.x1 && x < box.x2) {
        raw[p] = 176;     // R (#B08A4A bronze gold garment)
        raw[p + 1] = 138; // G
        raw[p + 2] = 74;  // B
        raw[p + 3] = 255; // opaque
      } else {
        raw[p] = 0;
        raw[p + 1] = 0;
        raw[p + 2] = 0;
        raw[p + 3] = 0;   // transparent
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

function deepScanForbiddenKeysAndStrings(payload, forbiddenTokens) {
  const hits = [];
  const lowerTokens = forbiddenTokens.map((t) => t.toLowerCase());

  function walk(node, pathStr) {
    if (node === null || node === undefined) return;
    if (Array.isArray(node)) {
      node.forEach((item, idx) => walk(item, `${pathStr}[${idx}]`));
      return;
    }
    if (typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        const lk = k.toLowerCase();
        for (let i = 0; i < forbiddenTokens.length; i += 1) {
          if (lk === lowerTokens[i] || lk.includes(lowerTokens[i])) {
            hits.push({ type: 'key', path: `${pathStr}.${k}`, token: forbiddenTokens[i] });
          }
        }
        walk(v, `${pathStr}.${k}`);
      }
      return;
    }
  }

  walk(payload, '$');
  const serialized = JSON.stringify(payload);
  for (const token of forbiddenTokens) {
    const re = new RegExp(`"${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`, 'i');
    if (re.test(serialized)) {
      hits.push({ type: 'serializedKey', path: '$', token });
    }
  }
  return hits;
}

async function runCheck(id, title, fn) {
  console.log(`\n=== ${id}: ${title} ===`);
  const t0 = performance.now();
  try {
    const details = await fn();
    const elapsedMs = Number((performance.now() - t0).toFixed(1));
    summary.checks[id] = { title, status: 'PASS', elapsedMs, details };
    summary.passed += 1;
    console.log(`[PASS] ${id} (${elapsedMs}ms) — ${JSON.stringify(details)}`);
  } catch (err) {
    const elapsedMs = Number((performance.now() - t0).toFixed(1));
    const message = err instanceof Error ? err.message : String(err);
    summary.checks[id] = { title, status: 'FAIL', elapsedMs, error: message };
    summary.failed += 1;
    console.error(`[FAIL] ${id} (${elapsedMs}ms) — ${message}`);
  }
}

async function main() {
  console.log('========================================================================');
  console.log(` CHẶNG P2.1 Live End-to-End CRUD & RBAC Verification (RUN=${RUN_TAG})`);
  console.log('========================================================================');

  // Verify live portals + BFF health before running suite
  for (const [label, url] of [
    ['BFF /health', `${BFF_BASE}/health`],
    ['Storefront :3000', 'http://127.0.0.1:3000/'],
    ['Admin :3001', 'http://127.0.0.1:3001/'],
    ['Partner :3002', 'http://127.0.0.1:3002/'],
  ]) {
    const r = await apiRequest(url, { timeoutMs: 8000 });
    assert.ok(r.status >= 200 && r.status < 400, `${label} not healthy: HTTP ${r.status}`);
  }

  // Authenticate all required roles with real JWT + 2FA + CSRF tokens
  const superAdmin = await loginPortalUser('lebao01121@gmail.com', { requireMfa: true, origin: 'http://localhost:3001' });
  const warehouseMgr = await loginPortalUser('warehouse@atelier.local', { requireMfa: true, origin: 'http://localhost:3001' });
  const catalogOp = await loginPortalUser('operator@atelier.local', { requireMfa: false, origin: 'http://localhost:3001' });
  const orderStaff = await loginPortalUser('staff@atelier.local', { requireMfa: false, origin: 'http://localhost:3001' });
  const supplierA = await loginPortalUser('supplier-a@atelier.local', { requireMfa: true, origin: 'http://localhost:3002' });
  const supplierB = await loginPortalUser('supplier-b@atelier.local', { requireMfa: true, origin: 'http://localhost:3002' });
  const customer = await loginPortalUser('customer@atelier.local', { requireMfa: false, origin: 'http://localhost:3000' });

  assert.ok(superAdmin.csrfToken, 'SUPER_ADMIN missing CSRF token');
  assert.ok(warehouseMgr.csrfToken, 'WAREHOUSE_MANAGER missing CSRF token');
  assert.ok(supplierA.csrfToken, 'SUPPLIER A missing CSRF token');
  console.log('[AUTH] All 7 test sessions authenticated (JWT + 2FA + CSRF verified).');

  // Fetch live catalog products once for reusable SKU/Product IDs
  const productsRes = await apiRequest(`${BFF_BASE}/api/v1/admin/products?pageSize=50`, {
    headers: authHeaders(superAdmin),
  });
  assert.equal(productsRes.status, 200, `GET /api/v1/admin/products failed: ${productsRes.text}`);
  const allProducts = unwrapList(productsRes);
  assert.ok(allProducts.length >= 3, `Expected >= 3 products, got ${allProducts.length}`);

  const allSkus = [];
  for (const prod of allProducts) {
    for (const variant of prod.variants || []) {
      for (const sku of variant.skus || []) {
        allSkus.push({
          ...sku,
          productId: prod.id,
          productSlug: prod.slug,
          productName: prod.name,
          variantId: variant.id,
        });
      }
    }
  }
  // Pick 3 distinct non-flagship-size-M SKUs so flagship demo stock stays untouched
  const candidateSkus = allSkus.filter((s) => s.skuCode !== 'AT-AOBLLI-C1-M');
  assert.ok(candidateSkus.length >= 4, 'Not enough candidate SKUs');
  const [sku1, sku2, sku3, sku4] = candidateSkus;

  // =========================================================================
  // CHECK 1: Promotions CRUD & HITL Draft Activation -> Storefront Sync
  // =========================================================================
  await runCheck('CHECK 1', 'Promotions CRUD & HITL Draft Activation -> Storefront Sync', async () => {
    const now = Date.now();
    const startsAt = new Date(now - 3600_000).toISOString();
    const endsAt = new Date(now + 7 * 24 * 3600_000).toISOString();
    const activeCode = `P21ACTIVE${RUN_TAG}`;
    const draftCode = `P21DRAFT${RUN_TAG}`;

    // 1a. List admin promotions
    const listRes = await apiRequest(`${BFF_BASE}/api/v1/admin/promotions?limit=50`, {
      headers: authHeaders(superAdmin),
    });
    assert.equal(listRes.status, 200, `GET admin promotions failed: ${listRes.text}`);
    const existingPromos = unwrapList(listRes);
    assert.ok(existingPromos.length >= 4, `Expected >= 4 seeded promos, got ${existingPromos.length}`);

    // 1b. Create active voucher
    const createActiveRes = await apiRequest(`${BFF_BASE}/api/v1/admin/promotions`, {
      method: 'POST',
      headers: authHeaders(superAdmin),
      body: {
        code: activeCode,
        title: `Voucher P2.1 Test ${RUN_TAG}`,
        description: 'Voucher kiểm thử tự động CHẶNG P2.1',
        discountType: 'PERCENTAGE',
        discountValue: 15,
        maxDiscountVnd: 250000,
        minOrderVnd: 300000,
        usageLimit: 100,
        startsAt,
        endsAt,
        status: 'ACTIVE',
      },
    });
    assert.ok(createActiveRes.status === 200 || createActiveRes.status === 201, `Create active promo failed (${createActiveRes.status}): ${createActiveRes.text}`);
    const activePromo = unwrapData(createActiveRes);
    assert.ok(activePromo?.id, `Missing id on created promo: ${createActiveRes.text}`);

    // 1c. Edit active voucher via PATCH
    const patchRes = await apiRequest(`${BFF_BASE}/api/v1/admin/promotions/${encodeURIComponent(activePromo.id)}`, {
      method: 'PATCH',
      headers: authHeaders(superAdmin),
      body: {
        title: `Voucher P2.1 Updated ${RUN_TAG}`,
        discountValue: 18,
      },
    });
    assert.equal(patchRes.status, 200, `PATCH promotion failed (${patchRes.status}): ${patchRes.text}`);
    const patchedPromo = unwrapData(patchRes);
    assert.equal(Number(patchedPromo?.discountPercent ?? patchedPromo?.discountValue), 18, `Expected discount 18, got ${patchRes.text}`);

    // 1d. Create NHAP_AI (CLEARANCE_ODD_SIZE) draft
    const createDraftRes = await apiRequest(`${BFF_BASE}/api/v1/admin/promotions`, {
      method: 'POST',
      headers: authHeaders(superAdmin),
      body: {
        code: draftCode,
        title: `Xả kho lẻ size AI ${RUN_TAG}`,
        description: 'Nháp AI chờ phê duyệt HITL',
        discountType: 'CLEARANCE_ODD_SIZE',
        discountValue: 25,
        maxDiscountVnd: 400000,
        minOrderVnd: 200000,
        usageLimit: 50,
        startsAt,
        endsAt,
        targetSizes: ['XS', 'XL'],
        status: 'NHAP_AI',
      },
    });
    assert.ok(createDraftRes.status === 200 || createDraftRes.status === 201, `Create NHAP_AI draft failed (${createDraftRes.status}): ${createDraftRes.text}`);
    const draftPromo = unwrapData(createDraftRes);
    assert.equal(draftPromo?.status, 'NHAP_AI', `Expected NHAP_AI status, got ${draftPromo?.status}`);

    // Verify Storefront hides NHAP_AI draft BEFORE approval
    const sfBeforeRes = await apiRequest(`${BFF_BASE}/bff/v1/storefront/promotions`, {
      headers: { Origin: 'http://localhost:3000', 'x-load-test-bypass': '1' },
    });
    assert.equal(sfBeforeRes.status, 200, `Storefront promotions GET failed: ${sfBeforeRes.text}`);
    const sfBeforeCodes = unwrapList(sfBeforeRes).map((p) => p.code);
    assert.ok(sfBeforeCodes.includes(activeCode), `Created active voucher ${activeCode} missing from Storefront`);
    assert.ok(!sfBeforeCodes.includes(draftCode), `NHAP_AI draft ${draftCode} leaked to Storefront BEFORE HITL approval!`);

    // 1e. Approve NHAP_AI draft via HITL endpoint
    const approveRes = await apiRequest(
      `${BFF_BASE}/api/v1/admin/promotions/${encodeURIComponent(draftPromo.id)}/approve-draft`,
      {
        method: 'POST',
        headers: authHeaders(superAdmin),
        body: { note: 'Approved by P2.1 E2E verifier' },
      },
    );
    assert.equal(approveRes.status, 200, `Approve draft failed (${approveRes.status}): ${approveRes.text}`);
    const approvedData = unwrapData(approveRes);
    assert.equal(approvedData?.status, 'ACTIVE', `Expected ACTIVE after approve-draft, got ${approveRes.text}`);

    // 1f. Immediately call Storefront promotions -> BOTH must appear immediately!
    const sfAfterRes = await apiRequest(`${BFF_BASE}/bff/v1/storefront/promotions`, {
      headers: { Origin: 'http://localhost:3000', 'x-load-test-bypass': '1' },
    });
    assert.equal(sfAfterRes.status, 200, `Storefront promotions after approval failed: ${sfAfterRes.text}`);
    const sfAfterCodes = unwrapList(sfAfterRes).map((p) => p.code);
    assert.ok(sfAfterCodes.includes(activeCode), `Active voucher ${activeCode} missing on Storefront after approval`);
    assert.ok(sfAfterCodes.includes(draftCode), `Approved clearance draft ${draftCode} NOT synced immediately to Storefront! Got: ${sfAfterCodes.join(', ')}`);

    // 1g. Archive both test promotions cleanly
    const delActiveRes = await apiRequest(`${BFF_BASE}/api/v1/admin/promotions/${encodeURIComponent(activePromo.id)}`, {
      method: 'DELETE',
      headers: authHeaders(superAdmin),
    });
    assert.equal(delActiveRes.status, 200, `Archive active promo failed: ${delActiveRes.text}`);
    const delDraftRes = await apiRequest(`${BFF_BASE}/api/v1/admin/promotions/${encodeURIComponent(draftPromo.id)}`, {
      method: 'DELETE',
      headers: authHeaders(superAdmin),
    });
    assert.equal(delDraftRes.status, 200, `Archive draft promo failed: ${delDraftRes.text}`);

    const sfCleanRes = await apiRequest(`${BFF_BASE}/bff/v1/storefront/promotions`, {
      headers: { Origin: 'http://localhost:3000', 'x-load-test-bypass': '1' },
    });
    const sfCleanCodes = unwrapList(sfCleanRes).map((p) => p.code);
    assert.ok(!sfCleanCodes.includes(activeCode) && !sfCleanCodes.includes(draftCode), 'Archived test vouchers still visible on Storefront');

    return { activeCode, draftCode, storefrontSyncImmediate: true, archivedCleaned: true };
  });

  // =========================================================================
  // CHECK 2: Inventory Adjustment, Transfer, Threshold + RBAC, 3-SKU PO,
  //          Partner Reject PO (+403 lock), Payable Mark Paid & Audit Logs
  // =========================================================================
  await runCheck(
    'CHECK 2',
    'Inventory Ops, 3-SKU PO, Partner Reject (+403 lock), Payable Mark Paid & Audit Logs',
    async () => {
      // 2a. Inventory Adjustment (+5 on sku1 at CENTRAL_WH)
      const adjRes = await apiRequest(`${BFF_BASE}/api/v1/admin/inventory/adjustments`, {
        method: 'POST',
        headers: authHeaders(warehouseMgr),
        body: {
          sku: sku1.id,
          warehouseCode: 'CENTRAL_WH',
          deltaAvailable: 5,
          reasonCode: 'CYCLE_COUNT_SURPLUS',
          note: `P2.1 adjustment +5 (${RUN_TAG})`,
        },
      });
      assert.ok(adjRes.status === 200 || adjRes.status === 201, `Inventory adjustment failed (${adjRes.status}): ${adjRes.text}`);
      const adjData = unwrapData(adjRes);
      assert.equal(Number(adjData?.after?.availableQty), Number(adjData?.before?.availableQty) + 5, `Adjustment delta mismatch: ${adjRes.text}`);

      const adjLedgerRes = await apiRequest(
        `${BFF_BASE}/api/v1/admin/inventory/ledger?sku=${encodeURIComponent(sku1.id)}&movementType=ADJUSTMENT&limit=10`,
        { headers: authHeaders(warehouseMgr) },
      );
      assert.equal(adjLedgerRes.status, 200, `Ledger query failed: ${adjLedgerRes.text}`);
      const adjLedgerItems = unwrapList(adjLedgerRes);
      assert.ok(
        adjLedgerItems.some((e) => (e.movementType === 'ADJUSTMENT' || e.reason === 'ADJUSTMENT') && Number(e.deltaQty ?? e.qtyDelta) === 5),
        `Missing ADJUSTMENT +5 ledger entry: ${adjLedgerRes.text.slice(0, 500)}`,
      );

      // 2b. Inter-warehouse Transfer (CENTRAL_WH -> HN_ATELIER, qty=2)
      const trfRes = await apiRequest(`${BFF_BASE}/api/v1/admin/inventory/transfers`, {
        method: 'POST',
        headers: authHeaders(warehouseMgr),
        body: {
          sku: sku1.id,
          fromWarehouseCode: 'CENTRAL_WH',
          toWarehouseCode: 'HN_ATELIER',
          quantity: 2,
          note: `P2.1 transfer (${RUN_TAG})`,
        },
      });
      assert.ok(trfRes.status === 200 || trfRes.status === 201, `Inventory transfer failed (${trfRes.status}): ${trfRes.text}`);
      const trfData = unwrapData(trfRes);
      const transferRef = trfData?.transferRef || trfData?.referenceCode;
      assert.ok(transferRef, `Missing transferRef on transfer response: ${trfRes.text}`);
      assert.equal(Number(trfData?.fromAfter?.availableQty), Number(trfData?.fromBefore?.availableQty) - 2, 'Source warehouse debit mismatch');
      assert.equal(Number(trfData?.toAfter?.availableQty), Number(trfData?.toBefore?.availableQty) + 2, 'Target warehouse credit mismatch');

      const trfLedgerRes = await apiRequest(
        `${BFF_BASE}/api/v1/admin/inventory/ledger?sku=${encodeURIComponent(sku1.id)}&limit=20`,
        { headers: authHeaders(warehouseMgr) },
      );
      assert.equal(trfLedgerRes.status, 200);
      const trfLedgerItems = unwrapList(trfLedgerRes);
      const hasOut = trfLedgerItems.some(
        (e) => (e.movementType === 'TRANSFER_OUT' || e.reason === 'TRANSFER_OUT') && (e.transferRef === transferRef || e.referenceId === transferRef),
      );
      const hasIn = trfLedgerItems.some(
        (e) => (e.movementType === 'TRANSFER_IN' || e.reason === 'TRANSFER_IN') && (e.transferRef === transferRef || e.referenceId === transferRef),
      );
      assert.ok(hasOut && hasIn, `Expected BOTH TRANSFER_OUT & TRANSFER_IN ledger rows for ${transferRef}`);

      // Restore sku1 stock back cleanly (transfer 2 back + adjust -5)
      await apiRequest(`${BFF_BASE}/api/v1/admin/inventory/transfers`, {
        method: 'POST',
        headers: authHeaders(warehouseMgr),
        body: { sku: sku1.id, fromWarehouseCode: 'HN_ATELIER', toWarehouseCode: 'CENTRAL_WH', quantity: 2, note: `P2.1 restore transfer (${RUN_TAG})` },
      });
      await apiRequest(`${BFF_BASE}/api/v1/admin/inventory/adjustments`, {
        method: 'POST',
        headers: authHeaders(warehouseMgr),
        body: { sku: sku1.id, warehouseCode: 'CENTRAL_WH', deltaAvailable: -5, reasonCode: 'CYCLE_COUNT_CORRECTION', note: `P2.1 restore adjust (${RUN_TAG})` },
      });

      // 2c. Per-SKU safetyThreshold update + ORDER_STAFF read-only check
      const threshRes = await apiRequest(
        `${BFF_BASE}/api/v1/admin/inventory/stock/${encodeURIComponent(sku1.id)}/threshold`,
        {
          method: 'PATCH',
          headers: authHeaders(warehouseMgr),
          body: { safetyThreshold: 7, warehouseCode: 'CENTRAL_WH' },
        },
      );
      assert.equal(threshRes.status, 200, `PATCH safetyThreshold failed (${threshRes.status}): ${threshRes.text}`);
      const threshData = unwrapData(threshRes);
      const origThreshold = Number(threshData?.before?.safetyThreshold ?? 3);
      assert.equal(Number(threshData?.after?.safetyThreshold), 7, `Expected safetyThreshold=7, got ${threshRes.text}`);
      // Restore original threshold
      await apiRequest(`${BFF_BASE}/api/v1/admin/inventory/stock/${encodeURIComponent(sku1.id)}/threshold`, {
        method: 'PATCH',
        headers: authHeaders(warehouseMgr),
        body: { safetyThreshold: origThreshold, warehouseCode: 'CENTRAL_WH' },
      });

      const staffReadRes = await apiRequest(`${BFF_BASE}/api/v1/admin/inventory/stock-levels?limit=10`, {
        headers: authHeaders(orderStaff),
      });
      assert.equal(staffReadRes.status, 200, `ORDER_STAFF GET stock-levels must be 200, got ${staffReadRes.status}: ${staffReadRes.text}`);

      const staffWriteAdjRes = await apiRequest(`${BFF_BASE}/api/v1/admin/inventory/adjustments`, {
        method: 'POST',
        headers: authHeaders(orderStaff),
        body: { sku: sku1.id, warehouseCode: 'CENTRAL_WH', deltaAvailable: 1, reasonCode: 'UNAUTH_TEST' },
      });
      assert.equal(staffWriteAdjRes.status, 403, `ORDER_STAFF write adjustment MUST be 403, got ${staffWriteAdjRes.status}`);

      const staffWriteThreshRes = await apiRequest(
        `${BFF_BASE}/api/v1/admin/inventory/stock/${encodeURIComponent(sku1.id)}/threshold`,
        {
          method: 'PATCH',
          headers: authHeaders(orderStaff),
          body: { safetyThreshold: 9 },
        },
      );
      assert.equal(staffWriteThreshRes.status, 403, `ORDER_STAFF write threshold MUST be 403, got ${staffWriteThreshRes.status}`);

      // 2d. 3-SKU Multi-line PO creation
      const poCreateRes = await apiRequest(`${BFF_BASE}/api/v1/admin/procurement/purchase-orders`, {
        method: 'POST',
        headers: authHeaders(warehouseMgr),
        body: {
          supplierId: SUPPLIER_A_ID,
          warehouseCode: 'CENTRAL_WH',
          expectedDeliveryDate: '2026-12-20',
          rationale: `P2.1 3-SKU multi-line PO (${RUN_TAG})`,
          items: [
            { skuId: sku1.id, skuCode: sku1.skuCode, productName: sku1.productName, orderedQty: 5, unitCostVnd: 320000 },
            { skuId: sku2.id, skuCode: sku2.skuCode, productName: sku2.productName, orderedQty: 6, unitCostVnd: 360000 },
            { skuId: sku3.id, skuCode: sku3.skuCode, productName: sku3.productName, orderedQty: 4, unitCostVnd: 410000 },
          ],
        },
      });
      assert.ok(poCreateRes.status === 200 || poCreateRes.status === 201, `Create 3-SKU PO failed (${poCreateRes.status}): ${poCreateRes.text}`);
      const po3 = unwrapData(poCreateRes);
      assert.ok(po3?.id, `Missing PO id: ${poCreateRes.text}`);
      assert.equal(po3.items?.length, 3, `Expected 3 PO line items, got ${po3.items?.length}`);

      const poFetchRes = await apiRequest(
        `${BFF_BASE}/api/v1/admin/procurement/purchase-orders/${encodeURIComponent(po3.id)}`,
        { headers: authHeaders(warehouseMgr) },
      );
      assert.equal(poFetchRes.status, 200);
      assert.equal(unwrapData(poFetchRes)?.items?.length, 3, 'Persisted PO line items count !== 3');

      if (po3.status === 'NHAP_AI') {
        const subRes = await apiRequest(
          `${BFF_BASE}/api/v1/admin/procurement/purchase-orders/${encodeURIComponent(po3.id)}/submit`,
          { method: 'POST', headers: authHeaders(warehouseMgr), body: {} },
        );
        assert.equal(subRes.status, 200, `PO submit failed: ${subRes.text}`);
      }

      // 2e. Partner Reject PO + Cross-Supplier Ownership Lock (403 for Supplier B)
      const crossRejectRes = await apiRequest(
        `${BFF_BASE}/api/v1/partner/purchase-orders/${encodeURIComponent(po3.id)}/reject`,
        {
          method: 'POST',
          headers: authHeaders(supplierB),
          body: { reason: 'Cross-tenant reject attempt', proposedDeliveryDate: '2026-12-30' },
        },
      );
      assert.equal(crossRejectRes.status, 403, `Cross-supplier PO reject MUST return 403, got ${crossRejectRes.status}: ${crossRejectRes.text}`);

      const rejectRes = await apiRequest(
        `${BFF_BASE}/api/v1/partner/purchase-orders/${encodeURIComponent(po3.id)}/reject`,
        {
          method: 'POST',
          headers: authHeaders(supplierA),
          body: {
            reason: `Xưởng cần thêm 5 ngày nhuộm vải (${RUN_TAG})`,
            proposedDeliveryDate: '2026-12-28',
          },
        },
      );
      assert.equal(rejectRes.status, 200, `Supplier A reject PO failed (${rejectRes.status}): ${rejectRes.text}`);
      const rejectedPo = unwrapData(rejectRes);
      const rejectedAfter = rejectedPo?.after ?? rejectedPo;
      assert.equal(rejectedAfter?.status, 'SUPPLIER_REJECTED', `Expected SUPPLIER_REJECTED, got ${rejectRes.text}`);
      assert.equal(rejectedAfter?.proposedDeliveryDate, '2026-12-28', `proposedDeliveryDate mismatch: ${rejectRes.text}`);

      // 2f. Payable Mark Paid (create fresh 1-SKU PO -> confirm -> GRN -> mark payable PAID)
      const poPayRes = await apiRequest(`${BFF_BASE}/api/v1/admin/procurement/purchase-orders`, {
        method: 'POST',
        headers: authHeaders(warehouseMgr),
        body: {
          supplierId: SUPPLIER_A_ID,
          warehouseCode: 'CENTRAL_WH',
          expectedDeliveryDate: '2026-12-22',
          rationale: `P2.1 payable settlement PO (${RUN_TAG})`,
          items: [
            { skuId: sku4.id, skuCode: sku4.skuCode, productName: sku4.productName, orderedQty: 2, unitCostVnd: 300000 },
          ],
        },
      });
      assert.ok(poPayRes.status === 200 || poPayRes.status === 201, `Create payable PO failed: ${poPayRes.text}`);
      const poPay = unwrapData(poPayRes);
      if (poPay.status === 'NHAP_AI') {
        await apiRequest(`${BFF_BASE}/api/v1/admin/procurement/purchase-orders/${encodeURIComponent(poPay.id)}/submit`, {
          method: 'POST',
          headers: authHeaders(warehouseMgr),
          body: {},
        });
      }
      const confRes = await apiRequest(
        `${BFF_BASE}/api/v1/partner/purchase-orders/${encodeURIComponent(poPay.id)}/confirm`,
        {
          method: 'POST',
          headers: authHeaders(supplierA),
          body: { confirmedDeliveryDate: '2026-12-22', supplierNote: 'Xác nhận giao 2 sp' },
        },
      );
      assert.ok(confRes.status === 200 || confRes.status === 201, `Partner confirm PO failed: ${confRes.text}`);

      const grnRes = await apiRequest(`${BFF_BASE}/api/v1/admin/procurement/goods-receipts`, {
        method: 'POST',
        headers: authHeaders(warehouseMgr),
        body: {
          poId: poPay.id,
          warehouseCode: 'CENTRAL_WH',
          note: `P2.1 GRN for payable test (${RUN_TAG})`,
          items: [
            {
              poItemId: poPay.items[0].id,
              skuId: sku4.id,
              receivedQty: 2,
              acceptedQty: 2,
              rejectedDefectQty: 0,
              batchCode: `BATCH-P21-${RUN_TAG}`,
            },
          ],
        },
      });
      assert.ok(grnRes.status === 200 || grnRes.status === 201, `GRN create failed: ${grnRes.text}`);
      const grnData = unwrapData(grnRes);
      const payableId = grnData?.payableId;
      assert.ok(payableId, `Missing payableId on GRN response: ${grnRes.text}`);

      // Restore sku4 +2 from GRN so inventory delta is net zero
      await apiRequest(`${BFF_BASE}/api/v1/admin/inventory/adjustments`, {
        method: 'POST',
        headers: authHeaders(warehouseMgr),
        body: { sku: sku4.id, warehouseCode: 'CENTRAL_WH', deltaAvailable: -2, reasonCode: 'TEST_CLEANUP', note: `P2.1 GRN stock restore (${RUN_TAG})` },
      });

      const bankRef = `VCB-FT-${RUN_TAG}`;
      const markPaidRes = await apiRequest(
        `${BFF_BASE}/api/v1/admin/procurement/payables/${encodeURIComponent(payableId)}/mark-paid`,
        {
          method: 'POST',
          headers: authHeaders(superAdmin),
          body: { bankReference: bankRef, note: `Thanh toán đối soát P2.1 ${RUN_TAG}` },
        },
      );
      assert.equal(markPaidRes.status, 200, `Mark payable paid failed (${markPaidRes.status}): ${markPaidRes.text}`);
      const paidData = unwrapData(markPaidRes);
      const paidAfter = paidData?.after ?? paidData;
      assert.equal(paidAfter?.status, 'PAID', `Expected payable status=PAID, got ${markPaidRes.text}`);
      assert.equal(paidAfter?.bankReference, bankRef, `bankReference mismatch: ${markPaidRes.text}`);

      // 2g. Audit Logs pagination + beforeJsonb/afterJsonb + filter verification
      const auditRes = await apiRequest(`${BFF_BASE}/api/v1/admin/audit-logs?page=1&limit=30`, {
        headers: authHeaders(superAdmin),
      });
      assert.equal(auditRes.status, 200, `GET audit-logs failed: ${auditRes.text}`);
      const auditData = unwrapData(auditRes);
      const auditItems = unwrapList(auditRes);
      assert.ok(auditData?.pagination && Number(auditData.pagination.page) === 1 && Number(auditData.pagination.limit) === 30, `Missing pagination metadata on audit-logs: ${auditRes.text.slice(0, 400)}`);
      assert.ok(auditItems.length > 0 && auditItems.length <= 30, `Audit log page size invalid: ${auditItems.length}`);

      const withDiff = auditItems.filter((a) => a.beforeJsonb && a.afterJsonb);
      assert.ok(withDiff.length >= 1, `Expected audit logs with BOTH beforeJsonb and afterJsonb, found 0 in latest 30 entries`);

      const auditFilterRes = await apiRequest(
        `${BFF_BASE}/api/v1/admin/audit-logs?page=1&limit=10&action=INVENTORY_STOCK_TRANSFERRED`,
        { headers: authHeaders(superAdmin) },
      );
      assert.equal(auditFilterRes.status, 200);
      const filteredAudits = unwrapList(auditFilterRes);
      assert.ok(filteredAudits.length >= 1, 'Expected >= 1 filtered INVENTORY_STOCK_TRANSFERRED audit entry');
      assert.ok(filteredAudits.every((a) => a.action === 'INVENTORY_STOCK_TRANSFERRED'), 'Audit action filter returned non-matching action');

      return {
        transferRef,
        po3Id: po3.id,
        po3Lines: po3.items.length,
        crossSupplierRejectStatus: crossRejectRes.status,
        supplierRejectStatus: rejectedAfter.status,
        payableId,
        payableStatus: paidAfter.status,
        auditDiffEntries: withDiff.length,
        orderStaffReadStatus: staffReadRes.status,
        orderStaffWriteStatus: staffWriteAdjRes.status,
      };
    },
  );

  // =========================================================================
  // CHECK 3: Layer 5 Redaction (0% Leak Test)
  // =========================================================================
  await runCheck('CHECK 3', 'Layer 5 Redaction (0% Leak Test on BI & Products)', async () => {
    const forbiddenTokens = [
      'costPriceVnd',
      'cost_price_vnd',
      'costPrice',
      'cost_price',
      'cogs',
      'cogsVnd',
      'totalCogsVnd',
      'grossMarginVnd',
      'grossMarginPct',
    ];

    const results = {};
    for (const [roleName, session] of [
      ['CATALOG_AI_OPERATOR', catalogOp],
      ['ORDER_STAFF', orderStaff],
    ]) {
      const biRes = await apiRequest(`${BFF_BASE}/api/v1/admin/analytics/bi?range=30d`, {
        headers: authHeaders(session),
      });
      assert.equal(biRes.status, 200, `${roleName} GET /analytics/bi failed (${biRes.status}): ${biRes.text}`);
      const biData = unwrapData(biRes);
      assert.equal(biData?.costDataRedacted, true, `${roleName} BI must set costDataRedacted === true`);
      const biLeaks = deepScanForbiddenKeysAndStrings(biRes.json, forbiddenTokens);
      assert.equal(biLeaks.length, 0, `${roleName} BI LEAKED restricted fields: ${JSON.stringify(biLeaks)}`);

      const prodRes = await apiRequest(`${BFF_BASE}/api/v1/admin/products?pageSize=50`, {
        headers: authHeaders(session),
      });
      assert.equal(prodRes.status, 200, `${roleName} GET /products failed (${prodRes.status}): ${prodRes.text}`);
      const prodLeaks = deepScanForbiddenKeysAndStrings(prodRes.json, forbiddenTokens);
      assert.equal(prodLeaks.length, 0, `${roleName} Products LEAKED restricted fields: ${JSON.stringify(prodLeaks)}`);

      results[roleName] = { biLeaks: 0, prodLeaks: 0, costDataRedacted: biData.costDataRedacted };
    }

    // SUPER_ADMIN must see live COGS & margin with costDataRedacted === false
    const superBiRes = await apiRequest(`${BFF_BASE}/api/v1/admin/analytics/bi?range=30d`, {
      headers: authHeaders(superAdmin),
    });
    assert.equal(superBiRes.status, 200, `SUPER_ADMIN GET /analytics/bi failed: ${superBiRes.text}`);
    const superBi = unwrapData(superBiRes);
    assert.equal(superBi?.costDataRedacted, false, `SUPER_ADMIN BI must have costDataRedacted === false`);
    assert.equal(typeof superBi?.totalCogsVnd, 'number', `SUPER_ADMIN BI missing numeric totalCogsVnd`);
    assert.equal(typeof superBi?.grossMarginVnd, 'number', `SUPER_ADMIN BI missing numeric grossMarginVnd`);
    assert.equal(typeof superBi?.grossMarginPct, 'number', `SUPER_ADMIN BI missing numeric grossMarginPct`);

    return {
      ...results,
      superAdminBi: {
        costDataRedacted: superBi.costDataRedacted,
        netRevenueVnd: superBi.netRevenueVnd,
        totalCogsVnd: superBi.totalCogsVnd,
        grossMarginVnd: superBi.grossMarginVnd,
        grossMarginPct: superBi.grossMarginPct,
      },
    };
  });

  // =========================================================================
  // CHECK 4: Payment Ledger, Editorial CMS, Categories/SizeCharts, Media Real BBox/Delete,
  //          Orders/RMA Lifecycle, IAM & CRM/Reviews/Notifications
  // =========================================================================
  await runCheck(
    'CHECK 4',
    'Payment Ledger, Editorial CMS, Categories/SizeCharts, Media BBox/Delete, Orders/RMA, IAM & CRM/Moderation',
    async () => {
      const check4Detail = {};

      // 4a. Orders & RMA Lifecycle (create 2 safe synthetic orders first — Order #2 also creates a real Payment Tx + Webhook!)
      const shippingAddress = {
        recipientName: 'P2.1 Verifier Customer',
        phone: '0901234567',
        provinceCode: '01',
        provinceName: 'Hà Nội',
        districtCode: '001',
        districtName: 'Ba Đình',
        wardCode: '00001',
        wardName: 'Phúc Xá',
        streetLine: '12 Tràng Tiền',
      };

      // Order #1 (COD) -> Admin Cancel
      const ord1Res = await apiRequest(`${BFF_BASE}/bff/v1/storefront/orders`, {
        method: 'POST',
        headers: authHeaders(customer, { 'Idempotency-Key': `p21-cancel-${RUN_TAG}` }),
        body: {
          items: [{ skuId: sku2.id, qty: 1 }],
          paymentMethod: 'COD',
          shippingMethod: 'GHN',
          customerEmail: 'customer@atelier.local',
          shippingAddress,
        },
      });
      assert.ok(ord1Res.status === 200 || ord1Res.status === 201, `Create test order #1 failed (${ord1Res.status}): ${ord1Res.text}`);
      const ord1 = unwrapData(ord1Res);
      const ord1Code = ord1?.orderCode || ord1?.order?.orderCode;
      assert.ok(ord1Code, `Missing orderCode on order #1: ${ord1Res.text}`);

      const cancelOrdRes = await apiRequest(
        `${BFF_BASE}/api/v1/admin/orders/${encodeURIComponent(ord1Code)}/cancel`,
        {
          method: 'POST',
          headers: authHeaders(superAdmin),
          body: { reason: `P2.1 E2E cancel order (${RUN_TAG})` },
        },
      );
      assert.equal(cancelOrdRes.status, 200, `Admin cancel order failed (${cancelOrdRes.status}): ${cancelOrdRes.text}`);
      const cancelOrdData = unwrapData(cancelOrdRes);
      assert.equal((cancelOrdData?.after ?? cancelOrdData)?.status, 'CANCELLED', `Expected CANCELLED order: ${cancelOrdRes.text}`);

      // Order #2 (VIETQR) -> Dev Webhook -> Pack -> Ship -> Deliver -> Customer RMA -> Admin Reject RMA -> Admin Complete Order
      const ord2Res = await apiRequest(`${BFF_BASE}/bff/v1/storefront/orders`, {
        method: 'POST',
        headers: authHeaders(customer, { 'Idempotency-Key': `p21-complete-${RUN_TAG}` }),
        body: {
          items: [{ skuId: sku3.id, qty: 1 }],
          paymentMethod: 'VIETQR',
          shippingMethod: 'GHN',
          customerEmail: 'customer@atelier.local',
          shippingAddress,
        },
      });
      assert.ok(ord2Res.status === 200 || ord2Res.status === 201, `Create test order #2 failed (${ord2Res.status}): ${ord2Res.text}`);
      const ord2Root = unwrapData(ord2Res);
      const ord2 = ord2Root?.order ?? ord2Root;
      const ord2Code = ord2?.orderCode;
      const ord2Id = ord2?.id;
      const ord2Total = Number(ord2?.totalVnd ?? ord2?.finalTotalVnd ?? ord2?.grandTotalVnd ?? 500000);
      const ord2ItemId = ord2?.items?.[0]?.id;
      assert.ok(ord2Code && ord2Id && ord2ItemId, `Missing order #2 fields: ${ord2Res.text}`);

      const whSimRes = await apiRequest(`${BFF_BASE}/bff/v1/storefront/payments/dev-simulate-webhook`, {
        method: 'POST',
        headers: authHeaders(customer),
        body: { orderId: ord2Id, orderCode: ord2Code, provider: 'VIETQR', amountVnd: ord2Total, simulateLate: false },
      });
      assert.ok(whSimRes.status === 200 || whSimRes.status === 201, `Dev simulate webhook failed (${whSimRes.status}): ${whSimRes.text}`);

      const packRes = await apiRequest(`${BFF_BASE}/api/v1/admin/orders/${encodeURIComponent(ord2Code)}/pack`, {
        method: 'POST',
        headers: authHeaders(orderStaff),
        body: { packPhotoUrl: 'http://127.0.0.1:4003/v1/media/public/seed/pack-p21.jpg', note: 'Packed P2.1' },
      });
      assert.ok(packRes.status === 200 || packRes.status === 201, `Pack order #2 failed: ${packRes.text}`);
      const shipRes = await apiRequest(`${BFF_BASE}/api/v1/admin/orders/${encodeURIComponent(ord2Code)}/ship`, {
        method: 'POST',
        headers: authHeaders(orderStaff),
        body: { carrier: 'GHN', trackingNumber: `GHN-P21-${RUN_TAG}` },
      });
      assert.ok(shipRes.status === 200 || shipRes.status === 201, `Ship order #2 failed: ${shipRes.text}`);
      const delivRes = await apiRequest(`${BFF_BASE}/api/v1/admin/orders/${encodeURIComponent(ord2Code)}/deliver`, {
        method: 'POST',
        headers: authHeaders(orderStaff),
        body: {},
      });
      assert.ok(delivRes.status === 200 || delivRes.status === 201, `Deliver order #2 failed: ${delivRes.text}`);

      // Customer creates RMA -> Admin rejects RMA
      const rmaCreateRes = await apiRequest(
        `${BFF_BASE}/bff/v1/storefront/orders/${encodeURIComponent(ord2Code)}/rma`,
        {
          method: 'POST',
          headers: authHeaders(customer),
          body: {
            orderItemId: ord2ItemId,
            qty: 1,
            type: 'RETURN_REFUND',
            reasonCode: 'KHAC',
            customerNote: `P2.1 reject RMA test (${RUN_TAG})`,
          },
        },
      );
      assert.ok(rmaCreateRes.status === 200 || rmaCreateRes.status === 201, `Create RMA failed (${rmaCreateRes.status}): ${rmaCreateRes.text}`);
      const rmaId = unwrapData(rmaCreateRes)?.id;
      assert.ok(rmaId, `Missing rmaId: ${rmaCreateRes.text}`);

      const rmaRejectRes = await apiRequest(
        `${BFF_BASE}/api/v1/admin/rma/${encodeURIComponent(rmaId)}/reject`,
        {
          method: 'POST',
          headers: authHeaders(orderStaff),
          body: { reason: 'Sản phẩm đã cắt tem mác không đủ điều kiện hoàn trả' },
        },
      );
      assert.equal(rmaRejectRes.status, 200, `Admin reject RMA failed (${rmaRejectRes.status}): ${rmaRejectRes.text}`);
      const rmaRejectData = unwrapData(rmaRejectRes);
      assert.equal((rmaRejectData?.after ?? rmaRejectData)?.status, 'RMA_REJECTED', `Expected RMA_REJECTED: ${rmaRejectRes.text}`);

      // Admin completes Order #2
      const completeOrdRes = await apiRequest(
        `${BFF_BASE}/api/v1/admin/orders/${encodeURIComponent(ord2Code)}/complete`,
        {
          method: 'POST',
          headers: authHeaders(orderStaff),
          body: { note: 'Completed P2.1' },
        },
      );
      assert.equal(completeOrdRes.status, 200, `Admin complete order failed (${completeOrdRes.status}): ${completeOrdRes.text}`);
      const compData = unwrapData(completeOrdRes);
      assert.equal((compData?.after ?? compData)?.status, 'COMPLETED', `Expected COMPLETED: ${completeOrdRes.text}`);

      // Restore sku3 +1 stock so test order #2 leaves inventory untouched
      await apiRequest(`${BFF_BASE}/api/v1/admin/inventory/adjustments`, {
        method: 'POST',
        headers: authHeaders(warehouseMgr),
        body: { sku: sku3.id, warehouseCode: 'CENTRAL_WH', deltaAvailable: 1, reasonCode: 'TEST_CLEANUP', note: `P2.1 order #2 stock restore (${RUN_TAG})` },
      });

      check4Detail.ordersRma = { cancelledOrder: ord1Code, completedOrder: ord2Code, rejectedRmaId: rmaId };

      // 4b. Payment Ledger & Over-Balance Refund Guard
      const txListRes = await apiRequest(`${BFF_BASE}/api/v1/admin/payments/transactions?page=1&limit=20`, {
        headers: authHeaders(superAdmin),
      });
      assert.equal(txListRes.status, 200, `GET payment transactions failed: ${txListRes.text}`);
      const txItems = unwrapList(txListRes);
      assert.ok(txItems.length >= 1, 'Expected >= 1 payment transaction in ledger');

      const whListRes = await apiRequest(`${BFF_BASE}/api/v1/admin/payments/webhooks?page=1&limit=20`, {
        headers: authHeaders(superAdmin),
      });
      assert.equal(whListRes.status, 200, `GET payment webhooks failed: ${whListRes.text}`);
      const whItems = unwrapList(whListRes);
      assert.ok(whItems.length >= 1, 'Expected >= 1 webhook log entry');

      const overRefundRes = await apiRequest(`${BFF_BASE}/api/v1/admin/payments/refunds`, {
        method: 'POST',
        headers: authHeaders(superAdmin),
        body: {
          orderId: ord2Id,
          orderCode: ord2Code,
          amountVnd: ord2Total + 500_000,
          reason: 'Over-balance refund guard test',
        },
      });
      assert.ok(
        overRefundRes.status === 400 || overRefundRes.status === 422,
        `Over-balance refund MUST fail 400/422, got ${overRefundRes.status}: ${overRefundRes.text}`,
      );
      assert.equal(
        unwrapErrorCode(overRefundRes),
        'REFUND_EXCEEDS_BALANCE',
        `Expected REFUND_EXCEEDS_BALANCE error code, got ${overRefundRes.text}`,
      );
      check4Detail.paymentLedger = {
        txCount: txItems.length,
        webhookCount: whItems.length,
        overBalanceRefundStatus: overRefundRes.status,
        overBalanceCode: unwrapErrorCode(overRefundRes),
      };

      // 4c. Editorial CMS: Occasion & Season CRUD
      const occSlug = `p21-occasion-${RUN_TAG.toLowerCase()}`;
      const createOccRes = await apiRequest(`${BFF_BASE}/api/v1/admin/occasions`, {
        method: 'POST',
        headers: authHeaders(superAdmin),
        body: {
          slug: occSlug,
          name: `Dịp Kiểm Thử ${RUN_TAG}`,
          tagline: 'Tối giản & Tinh tế',
          themeBg: '#FBF7EF',
          themeInk: '#1C1410',
          themeAccent: '#B08A4A',
          isDark: false,
          sortOrder: 99,
          isActive: true,
        },
      });
      assert.ok(createOccRes.status === 200 || createOccRes.status === 201, `Create occasion failed (${createOccRes.status}): ${createOccRes.text}`);
      const occ = unwrapData(createOccRes);
      const patchOccRes = await apiRequest(`${BFF_BASE}/api/v1/admin/occasions/${encodeURIComponent(occ.id)}`, {
        method: 'PATCH',
        headers: authHeaders(superAdmin),
        body: { tagline: 'Cập nhật P2.1' },
      });
      assert.equal(patchOccRes.status, 200, `Patch occasion failed: ${patchOccRes.text}`);
      const delOccRes = await apiRequest(`${BFF_BASE}/api/v1/admin/occasions/${encodeURIComponent(occ.id)}`, {
        method: 'DELETE',
        headers: authHeaders(superAdmin),
      });
      assert.equal(delOccRes.status, 200, `Delete occasion failed: ${delOccRes.text}`);

      const seaSlug = `p21-season-${RUN_TAG.toLowerCase()}`;
      const createSeaRes = await apiRequest(`${BFF_BASE}/api/v1/admin/seasons`, {
        method: 'POST',
        headers: authHeaders(superAdmin),
        body: {
          slug: seaSlug,
          code: `SEA_${RUN_TAG}`,
          name: `Mùa Kiểm Thử ${RUN_TAG}`,
          shortName: `Mùa ${RUN_TAG}`,
          subtitle: 'BST Kiểm Thử',
          months: 'Tháng 11 - 12',
          materialHeadline: 'Linen & Lụa',
          sortOrder: 99,
          isActive: true,
          swatches: [{ name: 'Kem Atelier', hex: '#FBF7EF', fabricNote: 'Linen 220gsm' }],
        },
      });
      assert.ok(createSeaRes.status === 200 || createSeaRes.status === 201, `Create season failed (${createSeaRes.status}): ${createSeaRes.text}`);
      const sea = unwrapData(createSeaRes);
      const patchSeaRes = await apiRequest(`${BFF_BASE}/api/v1/admin/seasons/${encodeURIComponent(sea.id)}`, {
        method: 'PATCH',
        headers: authHeaders(superAdmin),
        body: { materialHeadline: 'Lụa Tằm Xuân Cập Nhật' },
      });
      assert.equal(patchSeaRes.status, 200, `Patch season failed: ${patchSeaRes.text}`);
      const delSeaRes = await apiRequest(`${BFF_BASE}/api/v1/admin/seasons/${encodeURIComponent(sea.id)}`, {
        method: 'DELETE',
        headers: authHeaders(superAdmin),
      });
      assert.equal(delSeaRes.status, 200, `Delete season failed: ${delSeaRes.text}`);
      check4Detail.editorialCms = { occasionCrud: 'PASS', seasonCrud: 'PASS' };

      // 4d. Categories & Size Charts CRUD
      const catSlug = `p21-category-${RUN_TAG.toLowerCase()}`;
      const createCatRes = await apiRequest(`${BFF_BASE}/api/v1/admin/categories`, {
        method: 'POST',
        headers: authHeaders(superAdmin),
        body: { slug: catSlug, name: `Danh Mục Test ${RUN_TAG}`, sortOrder: 99, isActive: true },
      });
      assert.ok(createCatRes.status === 200 || createCatRes.status === 201, `Create category failed (${createCatRes.status}): ${createCatRes.text}`);
      const cat = unwrapData(createCatRes);
      const patchCatRes = await apiRequest(`${BFF_BASE}/api/v1/admin/categories/${encodeURIComponent(cat.id)}`, {
        method: 'PATCH',
        headers: authHeaders(superAdmin),
        body: { name: `Danh Mục Updated ${RUN_TAG}` },
      });
      assert.equal(patchCatRes.status, 200, `Patch category failed: ${patchCatRes.text}`);
      const delCatRes = await apiRequest(`${BFF_BASE}/api/v1/admin/categories/${encodeURIComponent(cat.id)}`, {
        method: 'DELETE',
        headers: authHeaders(superAdmin),
      });
      assert.equal(delCatRes.status, 200, `Delete category failed: ${delCatRes.text}`);

      const createScRes = await apiRequest(`${BFF_BASE}/api/v1/admin/size-charts`, {
        method: 'POST',
        headers: authHeaders(superAdmin),
        body: {
          code: `SC_P21_${RUN_TAG}`,
          name: `Bảng Size Test ${RUN_TAG}`,
          garmentCategory: 'OUTERWEAR',
          gender: 'WOMEN',
          stretchLevel: 'MEDIUM',
          fitNote: 'Form chuẩn Atelier',
          rows: [
            { sizeCode: 'M', heightMinCm: 158, heightMaxCm: 165, weightMinKg: 48, weightMaxKg: 55, bustCm: 86, waistCm: 68, hipCm: 92 },
          ],
        },
      });
      assert.ok(createScRes.status === 200 || createScRes.status === 201, `Create size chart failed (${createScRes.status}): ${createScRes.text}`);
      const sc = unwrapData(createScRes);
      const patchScRes = await apiRequest(`${BFF_BASE}/api/v1/admin/size-charts/${encodeURIComponent(sc.id)}`, {
        method: 'PATCH',
        headers: authHeaders(superAdmin),
        body: { fitNote: 'Form chuẩn cập nhật P2.1' },
      });
      assert.equal(patchScRes.status, 200, `Patch size chart failed: ${patchScRes.text}`);
      const delScRes = await apiRequest(`${BFF_BASE}/api/v1/admin/size-charts/${encodeURIComponent(sc.id)}`, {
        method: 'DELETE',
        headers: authHeaders(superAdmin),
      });
      assert.equal(delScRes.status, 200, `Delete size chart failed: ${delScRes.text}`);
      check4Detail.catalogAdvanced = { categoryCrud: 'PASS', sizeChartCrud: 'PASS' };

      // 4e. Media Real Pixel BBox (`computedFromPixels: true`) & Delete
      const cutoutBuf = createCutoutRgbaPng(400, 600, { x1: 80, y1: 60, x2: 320, y2: 540 });
      const uploadRes = await apiRequest(`${BFF_BASE}/api/v1/admin/media/upload`, {
        method: 'POST',
        headers: authHeaders(catalogOp),
        body: {
          assetType: 'RACK_CUTOUT_2_3',
          fileName: `p21-cutout-${RUN_TAG}.png`,
          mimeType: 'image/png',
          fileBase64: `data:image/png;base64,${cutoutBuf.toString('base64')}`,
        },
        timeoutMs: 30_000,
      });
      assert.ok(uploadRes.status === 200 || uploadRes.status === 201, `Media upload failed (${uploadRes.status}): ${uploadRes.text}`);
      const mediaAsset = unwrapData(uploadRes);
      const assetId = mediaAsset?.id;
      assert.ok(assetId, `Missing media assetId: ${uploadRes.text}`);
      const bbox = mediaAsset?.boundingBoxJsonb || mediaAsset?.spatialMetadata?.boundingBoxJsonb;
      assert.ok(bbox && bbox.computedFromPixels === true, `Expected real pixel boundingBoxJsonb.computedFromPixels===true, got: ${JSON.stringify(bbox)}`);
      assert.ok(Number(bbox.width) > 0 && Number(bbox.height) > 0, `Invalid bbox dimensions: ${JSON.stringify(bbox)}`);

      const delMediaRes = await apiRequest(`${BFF_BASE}/api/v1/admin/media/${encodeURIComponent(assetId)}`, {
        method: 'DELETE',
        headers: authHeaders(catalogOp),
      });
      assert.equal(delMediaRes.status, 200, `Delete media failed (${delMediaRes.status}): ${delMediaRes.text}`);
      assert.equal(unwrapData(delMediaRes)?.deleted, true, `Expected deleted: true on media delete`);
      check4Detail.media = { assetId, computedFromPixels: bbox.computedFromPixels, bboxWidth: bbox.width, bboxHeight: bbox.height, deleted: true };

      // 4f. IAM: roles, create user, reset 2FA (SUPER_ADMIN+2FA), soft-delete + instant token revocation
      const rolesRes = await apiRequest(`${BFF_BASE}/api/v1/admin/roles`, {
        headers: authHeaders(superAdmin),
      });
      assert.equal(rolesRes.status, 200, `GET /admin/roles failed: ${rolesRes.text}`);
      assert.ok(unwrapList(rolesRes).length >= 4, 'Expected >= 4 roles');

      const tempEmail = `p21-temp-${RUN_TAG.toLowerCase()}@atelier.local`;
      const createUserRes = await apiRequest(`${BFF_BASE}/api/v1/admin/users`, {
        method: 'POST',
        headers: authHeaders(superAdmin),
        body: {
          email: tempEmail,
          fullName: `Temp Staff ${RUN_TAG}`,
          password: SEED_PASSWORD,
          roles: ['ORDER_STAFF'],
        },
      });
      assert.ok(createUserRes.status === 200 || createUserRes.status === 201, `Create temp user failed (${createUserRes.status}): ${createUserRes.text}`);
      const tempUser = unwrapData(createUserRes);
      const tempUserId = tempUser?.id;
      assert.ok(tempUserId, `Missing tempUserId: ${createUserRes.text}`);

      const tempSession1 = await loginPortalUser(tempEmail, { requireMfa: false, origin: 'http://localhost:3001' });
      const tempAliveRes = await apiRequest(`${BFF_BASE}/api/v1/admin/orders?limit=5`, {
        headers: authHeaders(tempSession1),
      });
      assert.equal(tempAliveRes.status, 200, `Temp user JWT should work before reset-2fa/delete, got ${tempAliveRes.status}`);

      const reset2faRes = await apiRequest(
        `${BFF_BASE}/api/v1/admin/users/${encodeURIComponent(tempUserId)}/reset-2fa`,
        {
          method: 'POST',
          headers: authHeaders(superAdmin),
          body: {},
        },
      );
      assert.equal(reset2faRes.status, 200, `Reset 2FA failed (${reset2faRes.status}): ${reset2faRes.text}`);
      const reset2faData = unwrapData(reset2faRes);
      assert.equal(reset2faData?.mfaEnabled, false, `Expected mfaEnabled===false after reset-2fa: ${reset2faRes.text}`);

      // Re-login after reset-2fa (which revoked prior sessions), then soft-delete and verify instant token revocation
      const tempSession2 = await loginPortalUser(tempEmail, { requireMfa: false, origin: 'http://localhost:3001' });
      const delUserRes = await apiRequest(`${BFF_BASE}/api/v1/admin/users/${encodeURIComponent(tempUserId)}`, {
        method: 'DELETE',
        headers: authHeaders(superAdmin),
      });
      assert.equal(delUserRes.status, 200, `Soft-delete temp user failed (${delUserRes.status}): ${delUserRes.text}`);

      const revokedCheckRes = await apiRequest(`${BFF_BASE}/api/v1/admin/orders?limit=5`, {
        headers: authHeaders(tempSession2),
      });
      assert.ok(
        revokedCheckRes.status === 401 || revokedCheckRes.status === 403,
        `Deleted user token MUST be immediately revoked (401/403), got ${revokedCheckRes.status}: ${revokedCheckRes.text}`,
      );
      const revokedErrCode = unwrapErrorCode(revokedCheckRes);
      assert.ok(
        ['PERMISSION_REVOKED', 'TOKEN_REVOKED', 'UNAUTHORIZED', 'FORBIDDEN'].includes(revokedErrCode),
        `Expected revocation error code, got ${revokedCheckRes.text}`,
      );
      const deletedLoginRes = await apiRequest(`${BFF_BASE}/api/v1/auth/login`, {
        method: 'POST',
        headers: { Origin: 'http://localhost:3001', 'x-load-test-bypass': '1' },
        body: { email: tempEmail, password: SEED_PASSWORD },
      });
      assert.ok(
        deletedLoginRes.status === 401 || deletedLoginRes.status === 403,
        `Deleted user login MUST be blocked (401/403), got ${deletedLoginRes.status}: ${deletedLoginRes.text}`,
      );
      check4Detail.iam = {
        rolesCount: unwrapList(rolesRes).length,
        tempUserId,
        reset2faOk: true,
        softDeleteRevokedStatus: revokedCheckRes.status,
        softDeleteRevokedCode: revokedErrCode,
        softDeleteLoginBlockedStatus: deletedLoginRes.status,
      };

      // 4g. CRM Customers (`codTrustScore`), Reviews Moderation (Hide -> Storefront excludes -> Restore), Notification Logs
      const custRes = await apiRequest(`${BFF_BASE}/api/v1/admin/customers?limit=20`, {
        headers: authHeaders(superAdmin),
      });
      assert.equal(custRes.status, 200, `GET /admin/customers failed: ${custRes.text}`);
      const customers = unwrapList(custRes);
      assert.ok(customers.length >= 1, 'Expected >= 1 CRM customer');
      assert.ok(
        customers.some((c) => typeof c.codTrustScore === 'number'),
        `Expected numeric codTrustScore on CRM customers: ${JSON.stringify(customers[0])}`,
      );

      const reviewsRes = await apiRequest(`${BFF_BASE}/api/v1/admin/reviews?limit=30`, {
        headers: authHeaders(superAdmin),
      });
      assert.equal(reviewsRes.status, 200, `GET /admin/reviews failed: ${reviewsRes.text}`);
      const reviews = unwrapList(reviewsRes);
      const targetReview = reviews.find((r) => !r.isHidden && r.productId);
      assert.ok(targetReview, `Expected >= 1 visible review for moderation test`);

      const targetProd = allProducts.find((p) => p.id === targetReview.productId);
      assert.ok(targetProd?.slug, `Could not resolve product slug for review productId=${targetReview.productId}`);

      // Hide review
      const hideRes = await apiRequest(
        `${BFF_BASE}/api/v1/admin/reviews/${encodeURIComponent(targetReview.id)}/moderation`,
        {
          method: 'PATCH',
          headers: authHeaders(superAdmin),
          body: { isHidden: true, moderationNote: `P2.1 hide test (${RUN_TAG})` },
        },
      );
      assert.equal(hideRes.status, 200, `Hide review failed (${hideRes.status}): ${hideRes.text}`);

      try {
        // Verify excluded from public Storefront PDP composite!
        const sfPdpHiddenRes = await apiRequest(
          `${BFF_BASE}/bff/v1/storefront/products/${encodeURIComponent(targetProd.slug)}`,
          { headers: { Origin: 'http://localhost:3000', 'x-load-test-bypass': '1' } },
        );
        assert.equal(sfPdpHiddenRes.status, 200, `Storefront PDP failed: ${sfPdpHiddenRes.text}`);
        const sfHiddenReviews = unwrapData(sfPdpHiddenRes)?.reviews || [];
        assert.ok(
          !sfHiddenReviews.some((r) => r.id === targetReview.id),
          `Hidden review ${targetReview.id} STILL appeared on public Storefront PDP!`,
        );
      } finally {
        // Always restore visible!
        const restoreRes = await apiRequest(
          `${BFF_BASE}/api/v1/admin/reviews/${encodeURIComponent(targetReview.id)}/moderation`,
          {
            method: 'PATCH',
            headers: authHeaders(superAdmin),
            body: { isHidden: false, moderationNote: `P2.1 restore visible (${RUN_TAG})` },
          },
        );
        assert.equal(restoreRes.status, 200, `Restore review failed: ${restoreRes.text}`);
      }

      const sfPdpRestoredRes = await apiRequest(
        `${BFF_BASE}/bff/v1/storefront/products/${encodeURIComponent(targetProd.slug)}`,
        { headers: { Origin: 'http://localhost:3000', 'x-load-test-bypass': '1' } },
      );
      const sfRestoredReviews = unwrapData(sfPdpRestoredRes)?.reviews || [];
      assert.ok(
        sfRestoredReviews.some((r) => r.id === targetReview.id),
        `Restored review ${targetReview.id} did not reappear on public Storefront PDP!`,
      );

      const notifRes = await apiRequest(`${BFF_BASE}/api/v1/admin/notifications/logs?page=1&limit=20`, {
        headers: authHeaders(superAdmin),
      });
      assert.equal(notifRes.status, 200, `GET /admin/notifications/logs failed: ${notifRes.text}`);
      const notifItems = unwrapList(notifRes);

      check4Detail.crmModeration = {
        customersCount: customers.length,
        moderatedReviewId: targetReview.id,
        hiddenExcludedFromStorefront: true,
        restoredOnStorefront: true,
        notificationLogsCount: notifItems.length,
      };

      return check4Detail;
    },
  );

  summary.finishedAt = new Date().toISOString();
  const artifactsDir = path.join(ROOT_DIR, 'artifacts');
  fs.mkdirSync(artifactsDir, { recursive: true });
  fs.writeFileSync(
    path.join(artifactsDir, 'verify-p2-1-crud-metrics.json'),
    `${JSON.stringify(summary, null, 2)}\n`,
    'utf8',
  );

  console.log('\n========================================================================');
  console.log(` P2.1 E2E CRUD SUMMARY: PASS=${summary.passed}/4 | FAIL=${summary.failed}`);
  console.log('========================================================================');
  console.log(JSON.stringify(summary, null, 2));

  if (summary.failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('\n[FATAL] verify-p2-1-crud.mjs crashed:', err);
  process.exit(1);
});
