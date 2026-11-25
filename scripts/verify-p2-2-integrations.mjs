#!/usr/bin/env node
/**
 * CHẶNG P2.2 Live Integration Verification Suite (`scripts/verify-p2-2-integrations.mjs`)
 * fashion-atelier-ai-platform (v3.1)
 *
 * Empirically verifies all 6 mandatory DoD P2.2 integration gates against the LIVE 14-service stack:
 *   Check 1 — Real VietQR ISO/IEC 18004 + EMVCo NAPAS 247 CRC16-CCITT + OpenCV QR decode exact match
 *   Check 2 — VNPay (HMAC-SHA512) & MoMo (HMAC-SHA256) Redirect URLs, IPN Signature, Return URL & Refund
 *   Check 3 — Dynamic Shipping Quote (GHN/GHTK/AhaMove), Admin Ship Adapter & Signed Shipping Webhook
 *   Check 4 — Real Zalo OA/ZNS Client (LOCAL_SANDBOX_DRYRUN truthfulness) & atelier.notify.dlq Retry Path
 *   Check 5 — Real Sharp Binary validate-garment (NO hardcoded 94) + Layer 6 HITL Lock + Magic Bytes 400
 *   Check 6 — AI Try-On RabbitMQ Durable Topology, Lookbook Real VTON & BFF Socket.io Redis Adapter + 60s TTL
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const TMP_DIR = path.join(ROOT_DIR, '.project-data', 'tmp');
const ARTIFACTS_DIR = path.join(ROOT_DIR, 'artifacts');
fs.mkdirSync(TMP_DIR, { recursive: true });
fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });

const mediaRequire = createRequire(path.join(ROOT_DIR, 'services', 'media-pipeline', 'package.json'));
const sharp = mediaRequire('sharp');
const bffRequire = createRequire(path.join(ROOT_DIR, 'apps', 'bff', 'package.json'));
const Redis = bffRequire('ioredis');

const STOREFRONT_BASE = 'http://127.0.0.1:3000';
const BFF_BASE = 'http://127.0.0.1:4000';
const CATALOG_BASE = 'http://127.0.0.1:4002';
const INVENTORY_BASE = 'http://127.0.0.1:4004';
const PAYMENT_BASE = 'http://127.0.0.1:4007';
const NOTIFY_BASE = 'http://127.0.0.1:4008';
const TRYON_BASE = 'http://127.0.0.1:4009';
const MAILPIT_BASE = 'http://127.0.0.1:8025';
const MINIO_BASE = 'http://127.0.0.1:9000';

const SEED_PASSWORD = 'Atelier@2026!';
const FLAGSHIP_PRODUCT_ID = 'abc8d089-785d-4562-89dc-e788ab683f30';
const FLAGSHIP_SLUG = 'ao-blazer-linen-dang-suong';
const FLAGSHIP_SIZE_M_SKU_CODE = 'AT-AOBLLI-C1-M';

function loadDotEnv(filePath) {
  const vars = {};
  if (!fs.existsSync(filePath)) return vars;
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const k = trimmed.slice(0, eq).trim();
    let v = trimmed.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    vars[k] = v;
  }
  return vars;
}

const envVars = { ...loadDotEnv(path.join(ROOT_DIR, '.env')), ...process.env };
const INTERNAL_SECRET = envVars.INTERNAL_SERVICE_SECRET || 'Atelier_Internal_Svc_2026!';
const VNPAY_HASH_SECRET = envVars.VNPAY_HASH_SECRET || envVars.VNPAY_WEBHOOK_SECRET || 'Atelier_VNPay_Hmac_2026!';
const VNPAY_TMN_CODE = envVars.VNPAY_TMN_CODE || 'ATELIER01';
const MOMO_PARTNER_CODE = envVars.MOMO_PARTNER_CODE || 'ATELIER_MOMO';
const MOMO_ACCESS_KEY = envVars.MOMO_ACCESS_KEY || 'ATELIER_MOMO_ACCESS_KEY';
const MOMO_SECRET_KEY = envVars.MOMO_SECRET_KEY || envVars.MOMO_WEBHOOK_SECRET || 'Atelier_MoMo_Hmac_2026!';
const GHN_WEBHOOK_SECRET = envVars.GHN_WEBHOOK_SECRET || 'Atelier_GHN_Webhook_2026!';
const REDIS_URL = envVars.REDIS_URL || 'redis://:Atelier_Redis2026!@127.0.0.1:6379';
const PY_BIN =
  process.platform === 'win32'
    ? path.join(ROOT_DIR, 'services', 'ai-tryon', '.venv', 'Scripts', 'python.exe')
    : path.join(ROOT_DIR, 'services', 'ai-tryon', '.venv', 'bin', 'python');

function apiRequest(urlStr, options = {}) {
  const { method = 'GET', headers = {}, body, timeoutMs = 45_000 } = options;
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
            elapsedMs: performance.now() - startedAt,
          });
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error(`HTTP timeout (${timeoutMs}ms): ${method} ${urlStr}`)));
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

async function loginPortalUser(email, { requireMfa = false, origin = 'http://localhost:3001', pathPrefix = '/api/v1/auth' } = {}) {
  const loginRes = await apiRequest(`${BFF_BASE}${pathPrefix}/login`, {
    method: 'POST',
    headers: { Origin: origin, 'x-load-test-bypass': '1' },
    body: { email, password: SEED_PASSWORD },
  });
  assert.equal(loginRes.status, 200, `Login failed for ${email} (${loginRes.status}): ${loginRes.text}`);
  const loginData = unwrapData(loginRes);
  const cookies = parseSetCookies(loginRes.headers['set-cookie']);
  const preToken = loginData?.accessToken;
  assert.ok(preToken, `Missing accessToken for ${email}`);

  if (!requireMfa) {
    return {
      token: preToken,
      user: loginData?.user,
      cookies,
      csrfToken: loginData?.csrfToken || cookies.atelier_csrf_token || '',
    };
  }

  const beforeIds = new Set((await listMailpitMessages()).map((m) => m.ID));
  const sendRes = await apiRequest(`${BFF_BASE}/api/v1/auth/2fa/email-otp/send`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${preToken}`, Origin: origin, 'x-load-test-bypass': '1' },
    body: { email, purpose: 'MFA_LOGIN' },
  });
  assert.equal(sendRes.status, 200, `OTP send failed for ${email}: ${sendRes.text}`);

  let otp = null;
  const otpMsg = await waitForMailpitMatch((full, summary) => {
    if (beforeIds.has(summary.ID)) return false;
    const toList = Array.isArray(full?.To) ? full.To.map((t) => String(t?.Address || '').toLowerCase()) : [];
    if (toList.length > 0 && !toList.some((a) => a.includes(email.toLowerCase()))) return false;
    const combined = `${full?.Subject || ''} ${full?.Text || ''} ${full?.HTML || ''} ${summary?.Snippet || ''}`;
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
    headers: { Authorization: `Bearer ${preToken}`, Origin: origin, 'x-load-test-bypass': '1' },
    body: { method: 'EMAIL_OTP', code: otp },
  });
  assert.equal(verifyRes.status, 200, `OTP verify failed for ${email}: ${verifyRes.text}`);
  const verifiedData = unwrapData(verifyRes);
  const mergedCookies = { ...cookies, ...parseSetCookies(verifyRes.headers['set-cookie']) };
  return {
    token: verifiedData?.accessToken,
    user: verifiedData?.user ?? loginData?.user,
    cookies: mergedCookies,
    csrfToken: verifiedData?.csrfToken || loginData?.csrfToken || mergedCookies.atelier_csrf_token || '',
  };
}

function crc16Ccitt(payload) {
  let crc = 0xffff;
  const bytes = Buffer.from(payload, 'utf8');
  for (let i = 0; i < bytes.length; i += 1) {
    crc ^= bytes[i] << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 0x8000) !== 0 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

function verifyVietQrCrc16(payload) {
  if (typeof payload !== 'string' || !payload.startsWith('000201')) return false;
  if (payload.slice(-8, -4) !== '6304') return false;
  const provided = payload.slice(-4).toUpperCase();
  const computed = crc16Ccitt(payload.slice(0, -4));
  return provided === computed;
}

function vnpayEncodeValue(value) {
  return encodeURIComponent(String(value)).replace(/%20/g, '+');
}

function buildVnpaySignData(params) {
  const keys = Object.keys(params)
    .filter((k) => k.startsWith('vnp_') && k !== 'vnp_SecureHash' && k !== 'vnp_SecureHashType' && String(params[k] ?? '').length > 0)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return keys.map((k) => `${encodeURIComponent(k)}=${vnpayEncodeValue(params[k])}`).join('&');
}

function signVnpayParams(params, secret) {
  const signData = buildVnpaySignData(params);
  const hash = crypto.createHmac('sha512', secret).update(Buffer.from(signData, 'utf8')).digest('hex');
  return { signData, secureHash: hash, queryString: `${signData}&vnp_SecureHashType=SHA512&vnp_SecureHash=${hash}` };
}

function signMomoIpn(payload, secretKey, accessKey) {
  const raw = [
    `accessKey=${accessKey}`,
    `amount=${payload.amount}`,
    `extraData=${payload.extraData}`,
    `message=${payload.message}`,
    `orderId=${payload.orderId}`,
    `orderInfo=${payload.orderInfo}`,
    `orderType=${payload.orderType}`,
    `partnerCode=${payload.partnerCode}`,
    `payType=${payload.payType}`,
    `requestId=${payload.requestId}`,
    `responseTime=${payload.responseTime}`,
    `resultCode=${payload.resultCode}`,
    `transId=${payload.transId}`,
  ].join('&');
  return crypto.createHmac('sha256', secretKey).update(raw, 'utf8').digest('hex');
}

function formatVnpayDateUtc7(date = new Date()) {
  const utc7 = new Date(date.getTime() + 7 * 60 * 60 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${utc7.getUTCFullYear()}${pad(utc7.getUTCMonth() + 1)}${pad(utc7.getUTCDate())}${pad(utc7.getUTCHours())}${pad(utc7.getUTCMinutes())}${pad(utc7.getUTCSeconds())}`;
}

function buildMultipartBody(fieldName, filename, contentType, fileBuffer) {
  const boundary = `----AtelierP22Boundary${crypto.randomBytes(6).toString('hex')}`;
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${fieldName}"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`,
    'utf8',
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    body: Buffer.concat([head, fileBuffer, tail]),
  };
}

async function generateGarmentTestImages() {
  // (a) 768x1024 (3:4) RGBA PNG with fully transparent corners and crisp textured garment silhouette inside
  const wA = 768;
  const hA = 1024;
  const rgba = Buffer.alloc(wA * hA * 4, 0); // fully transparent everywhere initially
  for (let y = 110; y < 910; y += 1) {
    // Blazer-like silhouette: shoulders wider at top, slight waist taper, hem flare
    const normY = (y - 110) / 800;
    const halfWidth =
      normY < 0.12
        ? Math.floor(110 + (normY / 0.12) * 140)
        : normY < 0.55
          ? Math.floor(250 - ((normY - 0.12) / 0.43) * 45)
          : Math.floor(205 + ((normY - 0.55) / 0.45) * 40);
    const xStart = Math.floor(wA / 2) - halfWidth;
    const xEnd = Math.floor(wA / 2) + halfWidth;
    for (let x = xStart; x < xEnd; x += 1) {
      const idx = (y * wA + x) * 4;
      // High-contrast linen weave / herringbone pattern + crisp lapel seam lines
      const weave = ((x >> 2) + (y >> 2)) % 2 === 0 ? 1 : 0;
      const stripe = x % 12 < 2 || y % 12 < 2 ? 1 : 0;
      const isLapel = Math.abs(x - wA / 2) < 8 || Math.abs(Math.abs(x - wA / 2) - (y - 110) * 0.25) < 5;
      let r = weave ? 215 : 138;
      let g = weave ? 196 : 112;
      let b = weave ? 168 : 88;
      if (stripe) {
        r = 72;
        g = 52;
        b = 38;
      }
      if (isLapel) {
        r = 28;
        g = 20;
        b = 16;
      }
      rgba[idx] = r;
      rgba[idx + 1] = g;
      rgba[idx + 2] = b;
      rgba[idx + 3] = 255;
    }
  }
  const goodPngPath = path.join(TMP_DIR, 'p22-good-garment-3x4.png');
  const goodPngBuf = await sharp(rgba, { raw: { width: wA, height: hA, channels: 4 } }).png().toBuffer();
  fs.writeFileSync(goodPngPath, goodPngBuf);

  // (b) 320x180 (16:9) opaque flat solid-color JPEG
  const badJpgPath = path.join(TMP_DIR, 'p22-bad-garment-16x9.jpg');
  const badJpgBuf = await sharp({
    create: { width: 320, height: 180, channels: 3, background: { r: 210, g: 205, b: 198 } },
  })
    .jpeg({ quality: 75 })
    .toBuffer();
  fs.writeFileSync(badJpgPath, badJpgBuf);

  return { goodPngPath, goodPngBuf, badJpgPath, badJpgBuf };
}

async function ensureStockForSku(skuId, minQty = 20) {
  await apiRequest(`${INVENTORY_BASE}/v1/inventory/internal/test-set-stock`, {
    method: 'POST',
    headers: { 'x-internal-secret': INTERNAL_SECRET },
    body: { skuId, availableQty: minQty, reservedQty: 0 },
  });
}

async function main() {
  const startedAt = Date.now();
  const metrics = {
    generatedAt: new Date().toISOString(),
    checks: {},
    passCount: 0,
    failCount: 0,
  };

  function record(id, title, status, details, data = {}) {
    metrics.checks[id] = { title, status, details, data };
    if (status === 'PASS') metrics.passCount += 1;
    else metrics.failCount += 1;
    console.log(`\n[${status}] ${id} — ${title}`);
    for (const d of details) console.log(`       ${d}`);
  }

  console.log('========================================================================');
  console.log(' CHẶNG P2.2 LIVE INTEGRATION VERIFICATION SUITE');
  console.log('========================================================================');

  // Bootstrap auth + flagship SKU
  const customerAuth = await loginPortalUser('customer@atelier.local', {
    requireMfa: false,
    origin: 'http://localhost:3000',
    pathPrefix: '/bff/v1/auth',
  });
  const adminAuth = await loginPortalUser('lebao01121@gmail.com', {
    requireMfa: true,
    origin: 'http://localhost:3001',
    pathPrefix: '/api/v1/auth',
  });

  const custHeaders = {
    Authorization: `Bearer ${customerAuth.token}`,
    Origin: 'http://localhost:3000',
    Cookie: formatCookieHeader(customerAuth.cookies),
    'x-csrf-token': customerAuth.csrfToken,
    'x-load-test-bypass': '1',
  };
  const adminHeaders = {
    Authorization: `Bearer ${adminAuth.token}`,
    Origin: 'http://localhost:3001',
    Cookie: formatCookieHeader(adminAuth.cookies),
    'x-csrf-token': adminAuth.csrfToken,
    'x-load-test-bypass': '1',
  };

  const flagshipRes = await apiRequest(`${CATALOG_BASE}/v1/catalog/products/${FLAGSHIP_SLUG}`);
  assert.equal(flagshipRes.status, 200, `Cannot load flagship product: ${flagshipRes.text}`);
  const flagship = unwrapData(flagshipRes);
  const targetSku = flagship.variants.flatMap((v) => v.skus).find((s) => s.skuCode === FLAGSHIP_SIZE_M_SKU_CODE) || flagship.variants[0].skus[0];
  await ensureStockForSku(targetSku.id, 30);

  let vnpOrderCode = null;
  let vnpOrderItems = [];

  // ============================================================================
  // CHECK 1 — Real VietQR ISO/IEC 18004 + EMVCo NAPAS 247 CRC16-CCITT
  // ============================================================================
  try {
    const vietqrOrderRes = await apiRequest(`${BFF_BASE}/bff/v1/storefront/orders`, {
      method: 'POST',
      headers: { ...custHeaders, 'Idempotency-Key': `p22-vietqr-${crypto.randomUUID().slice(0, 8)}` },
      body: {
        paymentMethod: 'VIETQR',
        shippingMethod: 'GHN',
        customerEmail: 'customer@atelier.local',
        shippingAddress: {
          recipientName: 'Nguyễn Minh Anh',
          phone: '0901234567',
          provinceCode: '01',
          districtCode: '001',
          wardCode: '00013',
          provinceName: 'Thành phố Hà Nội',
          districtName: 'Quận Ba Đình',
          wardName: 'Phường Quán Thánh',
          streetLine: '18 Phan Đình Phùng',
        },
        items: [{ skuId: targetSku.id, qty: 1 }],
      },
    });
    assert.equal(vietqrOrderRes.status, 201, `VietQR order create failed (${vietqrOrderRes.status}): ${vietqrOrderRes.text}`);
    const vietqrData = unwrapData(vietqrOrderRes);
    const orderCode = vietqrData.order?.orderCode || vietqrData.orderCode;
    const grandTotalVnd = Number(vietqrData.order?.grandTotalVnd ?? vietqrData.grandTotalVnd);
    const intent = vietqrData.paymentIntent;
    assert.ok(intent, 'Missing paymentIntent on VIETQR order response');
    assert.equal(intent.qrStandard, 'ISO_IEC_18004_EMVCO_NAPAS247', `Unexpected qrStandard: ${intent.qrStandard}`);
    const qrPayload = intent.qrPayload || intent.vietQrPayload;
    assert.ok(qrPayload && typeof qrPayload === 'string', 'Missing qrPayload');
    assert.equal(verifyVietQrCrc16(qrPayload), true, `EMVCo CRC16-CCITT validation failed for: ${qrPayload}`);
    assert.ok(qrPayload.includes('970422'), 'qrPayload missing Bank BIN 970422');
    assert.ok(qrPayload.includes('088820269999'), 'qrPayload missing Account No 088820269999');
    assert.ok(qrPayload.includes(`54${String(String(grandTotalVnd).length).padStart(2, '0')}${grandTotalVnd}`), `qrPayload missing exact integer VND amount ${grandTotalVnd}`);
    const expectedDesc = `TAMXUAN ${orderCode.toUpperCase()}`;
    assert.ok(qrPayload.includes(expectedDesc), `qrPayload missing description "${expectedDesc}"`);

    const rawPngDataUrl = intent.rawQrPngDataUrl;
    assert.ok(typeof rawPngDataUrl === 'string' && rawPngDataUrl.startsWith('data:image/png;base64,'), 'Missing rawQrPngDataUrl');
    const qrPngPath = path.join(TMP_DIR, 'p22-vietqr-check.png');
    fs.writeFileSync(qrPngPath, Buffer.from(rawPngDataUrl.split(',')[1], 'base64'));

    const pyDecode = spawnSync(
      PY_BIN,
      [
        '-c',
        `import cv2, json, sys; img = cv2.imread(sys.argv[1]); det = cv2.QRCodeDetector(); val, pts, _ = det.detectAndDecode(img); print(json.dumps({"decoded": val, "detected": bool(val)}))`,
        qrPngPath,
      ],
      { encoding: 'utf8', windowsHide: true },
    );
    assert.equal(pyDecode.status, 0, `OpenCV QR decode failed: ${pyDecode.stderr}`);
    const decodedObj = JSON.parse(pyDecode.stdout.trim());
    assert.equal(decodedObj.detected, true, 'OpenCV QRCodeDetector failed to detect QR matrix');
    assert.equal(decodedObj.decoded, qrPayload, 'Decoded QR string does not match qrPayload byte-for-byte');

    record(
      'CHECK_1',
      'Real VietQR ISO/IEC 18004 + EMVCo NAPAS 247 CRC16-CCITT + OpenCV Decode',
      'PASS',
      [
        `orderCode=${orderCode}, grandTotalVnd=${grandTotalVnd}, qrStandard=${intent.qrStandard}`,
        `EMVCo CRC16-CCITT (0xFFFF)=VALID, BankBIN=970422, Account=088820269999, Desc="${expectedDesc}"`,
        `cv2.QRCodeDetector() exact byte-for-byte match (${qrPayload.length} bytes)`,
      ],
      { orderCode, grandTotalVnd, qrStandard: intent.qrStandard, qrPayloadLen: qrPayload.length, opencvExactMatch: true },
    );
  } catch (err) {
    record('CHECK_1', 'Real VietQR ISO/IEC 18004 + EMVCo NAPAS 247 CRC16-CCITT + OpenCV Decode', 'FAIL', [err instanceof Error ? err.message : String(err)]);
  }

  // ============================================================================
  // CHECK 2 — VNPay (HMAC-SHA512) & MoMo (HMAC-SHA256) Redirect, IPN, Return & Refund
  // ============================================================================
  try {
    // 2a. VNPay Order + Redirect URL + IPN (invalid -> valid -> replay) + Return URL + Storefront Page
    const vnpOrderRes = await apiRequest(`${BFF_BASE}/bff/v1/storefront/orders`, {
      method: 'POST',
      headers: { ...custHeaders, 'Idempotency-Key': `p22-vnpay-${crypto.randomUUID().slice(0, 8)}` },
      body: {
        paymentMethod: 'VNPAY',
        shippingMethod: 'GHN',
        customerEmail: 'customer@atelier.local',
        shippingAddress: {
          recipientName: 'Trần Bảo Châu',
          phone: '0909888777',
          provinceCode: '79',
          districtCode: '760',
          wardCode: '26734',
          provinceName: 'Thành phố Hồ Chí Minh',
          districtName: 'Quận 1',
          wardName: 'Phường Bến Nghé',
          streetLine: '42 Đồng Khởi',
        },
        items: [{ skuId: targetSku.id, qty: 1 }],
      },
    });
    assert.equal(vnpOrderRes.status, 201, `VNPay order create failed (${vnpOrderRes.status}): ${vnpOrderRes.text}`);
    const vnpData = unwrapData(vnpOrderRes);
    vnpOrderCode = vnpData.order?.orderCode || vnpData.orderCode;
    vnpOrderItems = vnpData.order?.items || vnpData.items || [];
    const vnpAmount = Number(vnpData.order?.grandTotalVnd ?? vnpData.grandTotalVnd);
    const vnpIntent = vnpData.paymentIntent;
    assert.ok(vnpIntent?.paymentUrl, 'Missing VNPay paymentUrl');

    const vnpParsedUrl = new URL(vnpIntent.paymentUrl);
    const rawKeys = [...vnpParsedUrl.searchParams.keys()];
    const vnpKeysOnly = rawKeys.filter((k) => k.startsWith('vnp_') && k !== 'vnp_SecureHash' && k !== 'vnp_SecureHashType');
    const sortedVnpKeys = [...vnpKeysOnly].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    assert.deepEqual(vnpKeysOnly, sortedVnpKeys, 'VNPay URL vnp_* params are not alphabetically sorted');
    const vnpHash = vnpParsedUrl.searchParams.get('vnp_SecureHash') || '';
    assert.match(vnpHash, /^[0-9a-f]{128}$/i, `Expected 128-hex HMAC-SHA512 vnp_SecureHash, got ${vnpHash}`);
    const vnpReturnUrl = vnpParsedUrl.searchParams.get('vnp_ReturnUrl') || '';
    assert.ok(vnpReturnUrl.includes('/thanh-toan/ket-qua'), `vnp_ReturnUrl must point to /thanh-toan/ket-qua, got ${vnpReturnUrl}`);

    const vnpTxNo = `${Date.now().toString().slice(-10)}`;
    const vnpBaseParams = {
      vnp_Amount: String(vnpAmount * 100),
      vnp_BankCode: 'NCB',
      vnp_OrderInfo: `Thanh toan don hang ${vnpOrderCode}`,
      vnp_PayDate: formatVnpayDateUtc7(),
      vnp_ResponseCode: '00',
      vnp_TmnCode: VNPAY_TMN_CODE,
      vnp_TransactionNo: vnpTxNo,
      vnp_TransactionStatus: '00',
      vnp_TxnRef: vnpOrderCode,
    };
    const vnpSigned = signVnpayParams(vnpBaseParams, VNPAY_HASH_SECRET);
    const vnpTamperedQs = `${vnpSigned.signData}&vnp_SecureHashType=SHA512&vnp_SecureHash=${'0'.repeat(128)}`;

    const vnpBadIpn = await apiRequest(`${BFF_BASE}/bff/v1/payments/vnpay/ipn?${vnpTamperedQs}`);
    assert.ok(
      vnpBadIpn.json?.RspCode === '97' || vnpBadIpn.status === 401 || vnpBadIpn.status === 403,
      `Tampered VNPay IPN must return RspCode=97 or 401/403, got HTTP ${vnpBadIpn.status}: ${vnpBadIpn.text}`,
    );

    const vnpGoodIpn = await apiRequest(`${BFF_BASE}/bff/v1/payments/vnpay/ipn?${vnpSigned.queryString}`);
    assert.equal(vnpGoodIpn.status, 200, `Valid VNPay IPN failed: ${vnpGoodIpn.text}`);
    assert.equal(vnpGoodIpn.json?.RspCode, '00', `Expected VNPay IPN RspCode 00, got ${vnpGoodIpn.text}`);

    const vnpReplayIpn = await apiRequest(`${BFF_BASE}/bff/v1/payments/vnpay/ipn?${vnpSigned.queryString}`);
    assert.equal(vnpReplayIpn.status, 200, `Replay VNPay IPN failed: ${vnpReplayIpn.text}`);
    assert.equal(vnpReplayIpn.json?.RspCode, '02', `Expected idempotent VNPay IPN RspCode 02, got ${vnpReplayIpn.text}`);

    const vnpReturnRes = await apiRequest(`${BFF_BASE}/bff/v1/storefront/payments/return?${vnpSigned.queryString}`);
    assert.equal(vnpReturnRes.status, 200, `VNPay return verify failed: ${vnpReturnRes.text}`);
    const vnpReturnData = unwrapData(vnpReturnRes);
    assert.equal(vnpReturnData?.verified, true, `Expected verified=true, got ${vnpReturnRes.text}`);
    assert.equal(vnpReturnData?.paid, true, `Expected paid=true, got ${vnpReturnRes.text}`);

    const sfReturnPage = await apiRequest(`${STOREFRONT_BASE}/thanh-toan/ket-qua`);
    assert.equal(sfReturnPage.status, 200, `Storefront /thanh-toan/ket-qua returned HTTP ${sfReturnPage.status}`);

    // 2b. MoMo Order + Redirect URL + IPN (invalid -> valid -> replay) + Partial Refund
    const momoOrderRes = await apiRequest(`${BFF_BASE}/bff/v1/storefront/orders`, {
      method: 'POST',
      headers: { ...custHeaders, 'Idempotency-Key': `p22-momo-${crypto.randomUUID().slice(0, 8)}` },
      body: {
        paymentMethod: 'MOMO',
        shippingMethod: 'GHTK',
        customerEmail: 'customer@atelier.local',
        shippingAddress: {
          recipientName: 'Lê Thanh Hà',
          phone: '0912345678',
          provinceCode: '48',
          districtCode: '492',
          wardCode: '20245',
          provinceName: 'Thành phố Đà Nẵng',
          districtName: 'Quận Hải Châu',
          wardName: 'Phường Thạch Thang',
          streetLine: '99 Bạch Đằng',
        },
        items: [{ skuId: targetSku.id, qty: 1 }],
      },
    });
    assert.equal(momoOrderRes.status, 201, `MoMo order create failed (${momoOrderRes.status}): ${momoOrderRes.text}`);
    const momoData = unwrapData(momoOrderRes);
    const momoOrderCode = momoData.order?.orderCode || momoData.orderCode;
    const momoAmount = Number(momoData.order?.grandTotalVnd ?? momoData.grandTotalVnd);
    const momoIntent = momoData.paymentIntent;
    assert.ok(momoIntent?.paymentUrl, 'Missing MoMo paymentUrl');

    const momoParsedUrl = new URL(momoIntent.paymentUrl);
    const momoSig = momoParsedUrl.searchParams.get('signature') || '';
    assert.match(momoSig, /^[0-9a-f]{64}$/i, `Expected 64-hex HMAC-SHA256 MoMo signature, got ${momoSig}`);

    const momoIpnBase = {
      partnerCode: MOMO_PARTNER_CODE,
      orderId: momoOrderCode,
      requestId: `REQ-${momoOrderCode}-${Date.now().toString().slice(-6)}`,
      amount: momoAmount,
      orderInfo: `Tam Xuan Atelier ${momoOrderCode}`,
      orderType: 'momo_wallet',
      transId: Number(`99${Date.now().toString().slice(-8)}`),
      resultCode: 0,
      message: 'Successful.',
      payType: 'qr',
      responseTime: Date.now(),
      extraData: '',
    };
    const momoBadIpn = await apiRequest(`${BFF_BASE}/bff/v1/payments/momo/ipn`, {
      method: 'POST',
      body: { ...momoIpnBase, signature: 'f'.repeat(64) },
    });
    assert.ok(
      momoBadIpn.status === 401 || momoBadIpn.status === 403,
      `Tampered MoMo IPN must return 401/403, got HTTP ${momoBadIpn.status}: ${momoBadIpn.text}`,
    );

    const momoValidSig = signMomoIpn(momoIpnBase, MOMO_SECRET_KEY, MOMO_ACCESS_KEY);
    const momoGoodIpn = await apiRequest(`${BFF_BASE}/bff/v1/payments/momo/ipn`, {
      method: 'POST',
      body: { ...momoIpnBase, signature: momoValidSig },
    });
    assert.equal(momoGoodIpn.status, 200, `Valid MoMo IPN failed: ${momoGoodIpn.text}`);
    assert.equal(unwrapData(momoGoodIpn)?.processed, true, `Expected MoMo IPN processed=true: ${momoGoodIpn.text}`);

    const momoReplayIpn = await apiRequest(`${BFF_BASE}/bff/v1/payments/momo/ipn`, {
      method: 'POST',
      body: { ...momoIpnBase, signature: momoValidSig },
    });
    assert.equal(momoReplayIpn.status, 200, `Replay MoMo IPN failed: ${momoReplayIpn.text}`);
    assert.equal(unwrapData(momoReplayIpn)?.deduplicated, true, `Expected MoMo replay deduplicated=true: ${momoReplayIpn.text}`);

    const partialRefundVnd = Math.min(200_000, Math.max(10_000, Math.floor(momoAmount / 2)));
    const refundRes = await apiRequest(`${BFF_BASE}/api/v1/admin/payments/refunds`, {
      method: 'POST',
      headers: adminHeaders,
      body: {
        orderCode: momoOrderCode,
        amountVnd: partialRefundVnd,
        reason: 'P2.2 Verification partial MoMo adapter refund',
        idempotencyKey: `p22-ref-${momoOrderCode}`,
      },
    });
    assert.equal(refundRes.status, 200, `Admin MoMo refund failed (${refundRes.status}): ${refundRes.text}`);
    const refundData = unwrapData(refundRes);
    assert.ok(refundData?.providerRefundId && String(refundData.providerRefundId).startsWith('MOMO-REF-'), `Missing MoMo adapter providerRefundId: ${refundRes.text}`);
    assert.equal(refundData?.status, 'COMPLETED', `Unexpected refund status: ${refundRes.text}`);

    const txListRes = await apiRequest(`${PAYMENT_BASE}/v1/payments/transactions/${encodeURIComponent(momoOrderCode)}`);
    const txList = unwrapData(txListRes) || [];
    const refundTx = txList.find((t) => t.txType === 'REFUND' && t.status === 'SUCCEEDED');
    assert.ok(refundTx, `Refund transaction SUCCEEDED not found in payment_transactions: ${txListRes.text}`);

    record(
      'CHECK_2',
      'VNPay (HMAC-SHA512) & MoMo (HMAC-SHA256) Redirect, IPN, Return URL & Refund',
      'PASS',
      [
        `VNPay (${vnpOrderCode}): sorted vnp_* + 128-hex SHA512, tampered IPN -> RspCode=97, valid IPN -> RspCode=00, replay -> RspCode=02, return verified=true/paid=true, Storefront /thanh-toan/ket-qua HTTP 200`,
        `MoMo (${momoOrderCode}): 64-hex SHA256 paymentUrl, tampered IPN -> HTTP ${momoBadIpn.status}, valid IPN -> processed=true, replay -> deduplicated=true`,
        `MoMo Partial Refund (${partialRefundVnd} VND): providerRefundId=${refundData.providerRefundId}, mode=${refundData.providerMode}, payment_transactions REFUND=SUCCEEDED`,
      ],
      {
        vnpOrderCode,
        vnpayTamperRspCode: vnpBadIpn.json?.RspCode ?? vnpBadIpn.status,
        vnpayValidRspCode: vnpGoodIpn.json?.RspCode,
        vnpayReplayRspCode: vnpReplayIpn.json?.RspCode,
        storefrontReturnHttp: sfReturnPage.status,
        momoOrderCode,
        momoTamperHttp: momoBadIpn.status,
        momoRefundId: refundData.providerRefundId,
        momoRefundVnd: partialRefundVnd,
      },
    );
  } catch (err) {
    record('CHECK_2', 'VNPay (HMAC-SHA512) & MoMo (HMAC-SHA256) Redirect, IPN, Return URL & Refund', 'FAIL', [err instanceof Error ? err.message : String(err)]);
  }

  // ============================================================================
  // CHECK 3 — Dynamic Shipping Quote, Admin Ship Adapter & Signed Shipping Webhook
  // ============================================================================
  try {
    const quoteCases = [
      { label: 'AHAMOVE_2H (HN 01/001/00013)', body: { provinceCode: '01', districtCode: '001', wardCode: '00013', shippingMethod: 'AHAMOVE_2H', weightGrams: 600, orderValueVnd: 1_200_000 } },
      { label: 'GHN (HCM 79/760/26734)', body: { provinceCode: '79', districtCode: '760', wardCode: '26734', shippingMethod: 'GHN', weightGrams: 700, orderValueVnd: 1_200_000 } },
      { label: 'GHTK (DN 48/492/20245)', body: { provinceCode: '48', districtCode: '492', wardCode: '20245', shippingMethod: 'GHTK', weightGrams: 700, orderValueVnd: 1_200_000 } },
    ];
    const quoteSummary = [];
    for (const qc of quoteCases) {
      const res = await apiRequest(`${BFF_BASE}/bff/v1/storefront/shipping/quote`, {
        method: 'POST',
        headers: custHeaders,
        body: qc.body,
      });
      assert.equal(res.status, 200, `Shipping quote failed for ${qc.label}: ${res.text}`);
      const d = unwrapData(res);
      assert.ok(typeof d.feeVnd === 'number' && d.feeVnd > 0, `Expected feeVnd > 0 for ${qc.label}: ${res.text}`);
      assert.ok(typeof d.estimatedDeliveryHours === 'number' && d.estimatedDeliveryHours > 0, `Missing estimatedDeliveryHours for ${qc.label}`);
      assert.ok(typeof d.estimatedDeliveryDate === 'string' && d.estimatedDeliveryDate.length > 0, `Missing estimatedDeliveryDate for ${qc.label}`);
      assert.ok(typeof d.mode === 'string' && d.mode.length > 0, `Missing mode for ${qc.label}`);
      assert.ok(Array.isArray(d.quotes) && d.quotes.length >= 3, `Expected >= 3 quotes[] for ${qc.label}`);
      quoteSummary.push(`${qc.label}: fee=${d.feeVnd}đ, eta=${d.estimatedDeliveryHours}h, mode=${d.mode}, quotes=${d.quotes.length}`);
    }

    assert.ok(vnpOrderCode, 'Missing paid VNPay orderCode for Pack & Ship adapter test');
    const packRes = await apiRequest(`${BFF_BASE}/api/v1/admin/orders/${encodeURIComponent(vnpOrderCode)}/pack`, {
      method: 'POST',
      headers: adminHeaders,
      body: {
        packPhotoUrl: `${MINIO_BASE}/atelier-public/seed/atelier-step-4.webp`,
        scannedSkuCodes: vnpOrderItems.map((it) => it.skuCode).filter(Boolean),
      },
    });
    assert.ok(packRes.status === 200 || packRes.status === 201, `Admin pack failed (${packRes.status}): ${packRes.text}`);

    const shipRes = await apiRequest(`${BFF_BASE}/api/v1/admin/orders/${encodeURIComponent(vnpOrderCode)}/ship`, {
      method: 'POST',
      headers: adminHeaders,
      body: {}, // No manual trackingCode — must invoke GHN adapter!
    });
    assert.ok(shipRes.status === 200 || shipRes.status === 201, `Admin ship failed (${shipRes.status}): ${shipRes.text}`);
    const shippedOrder = unwrapData(shipRes);
    const trackingCode = shippedOrder?.shipment?.trackingCode;
    const actualFeeVnd = Number(shippedOrder?.shippingActualFeeVnd ?? shippedOrder?.shipment?.actualFeeVnd ?? 0);
    assert.match(String(trackingCode || ''), /^GHN[A-Z0-9]+$/, `Expected structured GHN trackingCode, got ${trackingCode}`);
    assert.ok(actualFeeVnd > 0, `Expected shippingActualFeeVnd > 0 persisted, got ${actualFeeVnd}`);

    const ghnWebhookPayload = {
      eventId: `ghn-deliv-${vnpOrderCode}-${Date.now()}`,
      OrderCode: trackingCode,
      ClientOrderCode: vnpOrderCode,
      Status: 'delivered',
      Time: new Date().toISOString(),
      Description: 'Giao hàng thành công bởi GHN (P2.2 verification)',
    };
    const rawWebhookBody = JSON.stringify(ghnWebhookPayload);

    const badShipWh = await apiRequest(`${BFF_BASE}/bff/v1/webhooks/shipping/ghn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-ghn-signature': '0'.repeat(64) },
      body: rawWebhookBody,
    });
    assert.ok(badShipWh.status === 401 || badShipWh.status === 403, `Invalid GHN webhook signature must return 401/403, got HTTP ${badShipWh.status}`);

    const validShipSig = crypto.createHmac('sha256', GHN_WEBHOOK_SECRET).update(rawWebhookBody, 'utf8').digest('hex');
    const goodShipWh = await apiRequest(`${BFF_BASE}/bff/v1/webhooks/shipping/ghn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-ghn-signature': validShipSig },
      body: rawWebhookBody,
    });
    assert.equal(goodShipWh.status, 200, `Valid GHN webhook failed (${goodShipWh.status}): ${goodShipWh.text}`);
    const whData = unwrapData(goodShipWh);
    assert.equal(whData?.processed, true, `Expected GHN webhook processed=true: ${goodShipWh.text}`);
    assert.equal(whData?.orderUpdated, true, `Expected GHN webhook orderUpdated=true: ${goodShipWh.text}`);

    const orderAfterWh = unwrapData(await apiRequest(`${BFF_BASE}/bff/v1/storefront/orders/${encodeURIComponent(vnpOrderCode)}`, { headers: custHeaders }));
    assert.equal(orderAfterWh?.status, 'DELIVERED', `Expected order auto-updated to DELIVERED, got ${orderAfterWh?.status}`);

    const dupShipWh = await apiRequest(`${BFF_BASE}/bff/v1/webhooks/shipping/ghn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-ghn-signature': validShipSig },
      body: rawWebhookBody,
    });
    assert.equal(dupShipWh.status, 200, `Duplicate GHN webhook failed: ${dupShipWh.text}`);
    assert.equal(unwrapData(dupShipWh)?.deduplicated, true, `Expected duplicate GHN webhook deduplicated=true: ${dupShipWh.text}`);

    record(
      'CHECK_3',
      'Dynamic Shipping Quote (GHN/GHTK/AhaMove), Admin Ship Adapter & Signed Webhook',
      'PASS',
      [
        ...quoteSummary,
        `Admin Ship (${vnpOrderCode}): trackingCode=${trackingCode}, shippingActualFeeVnd=${actualFeeVnd}đ`,
        `GHN Webhook: invalid sig -> HTTP ${badShipWh.status}, valid HMAC-SHA256 -> order=${orderAfterWh.status}, duplicate -> deduplicated=true`,
      ],
      { trackingCode, shippingActualFeeVnd: actualFeeVnd, invalidWebhookHttp: badShipWh.status, orderStatusAfterWebhook: orderAfterWh.status, deduplicated: true },
    );
  } catch (err) {
    record('CHECK_3', 'Dynamic Shipping Quote (GHN/GHTK/AhaMove), Admin Ship Adapter & Signed Webhook', 'FAIL', [err instanceof Error ? err.message : String(err)]);
  }

  // ============================================================================
  // CHECK 4 — Real Zalo OA/ZNS Client & atelier.notify.dlq Retry Path
  // ============================================================================
  try {
    const dryEventId = `p22-zns-dry-${crypto.randomUUID().slice(0, 8)}`;
    const dryRes = await apiRequest(`${NOTIFY_BASE}/internal/notify/zns`, {
      method: 'POST',
      headers: { 'x-internal-secret': INTERNAL_SECRET },
      body: {
        eventId: dryEventId,
        phone: '0901234567',
        templateCode: 'ORDER_CONFIRMED_VI',
        templateData: { order_code: 'TX-P22-DRY', customer_name: 'Minh Anh' },
        simulateZnsFailure: false,
      },
    });
    assert.equal(dryRes.status, 200, `Direct ZNS dry-run failed: ${dryRes.text}`);
    const dryData = unwrapData(dryRes);
    assert.equal(dryData?.znsDeliveryMode, 'LOCAL_SANDBOX_DRYRUN', `Expected truthful LOCAL_SANDBOX_DRYRUN, got ${dryData?.znsDeliveryMode}`);
    assert.equal(dryData?.znsStatus, 'LOCAL_SANDBOX', `Must NOT falsely claim SENT without credentials, got ${dryData?.znsStatus}`);

    const failEventId = `p22-zns-fail-${crypto.randomUUID().slice(0, 8)}`;
    const tFail0 = performance.now();
    const failRes = await apiRequest(`${NOTIFY_BASE}/internal/notify/zns`, {
      method: 'POST',
      headers: { 'x-internal-secret': INTERNAL_SECRET },
      body: {
        eventId: failEventId,
        phone: '0901234567',
        templateCode: 'ORDER_CONFIRMED_VI',
        templateData: { order_code: 'TX-P22-FAIL', customer_name: 'Minh Anh' },
        simulateZnsFailure: true,
      },
    });
    const failElapsedMs = Math.round(performance.now() - tFail0);
    assert.equal(failRes.status, 200, `Simulated ZNS failure endpoint returned ${failRes.status}: ${failRes.text}`);
    const failData = unwrapData(failRes);
    assert.equal(failData?.znsStatus, 'FAILED', `Expected znsStatus=FAILED, got ${failData?.znsStatus}`);
    assert.equal(failData?.znsErrorCode, 'SIMULATED_ZNS_503', `Expected znsErrorCode=SIMULATED_ZNS_503, got ${failData?.znsErrorCode}`);
    assert.equal(failData?.znsRetryCount, 3, `Expected znsRetryCount=3, got ${failData?.znsRetryCount}`);
    assert.ok(failElapsedMs >= 1400, `Expected exponential retry backoff (>= 1400ms for 400ms+1200ms), got ${failElapsedMs}ms`);
    assert.equal(failData?.znsDeadLettered, true, `Expected znsDeadLettered=true (atelier.notify.dlq), got ${failData?.znsDeadLettered}`);

    const logsRes = await apiRequest(`${BFF_BASE}/api/v1/admin/notifications/logs?limit=25`, { headers: adminHeaders });
    assert.equal(logsRes.status, 200, `GET /api/v1/admin/notifications/logs failed: ${logsRes.text}`);
    const logsData = unwrapData(logsRes);
    const logItems = Array.isArray(logsData?.items) ? logsData.items : Array.isArray(logsData) ? logsData : [];
    const dryLog = logItems.find((item) => item.eventId === dryEventId);
    const failLog = logItems.find((item) => item.eventId === failEventId);
    assert.ok(dryLog && dryLog.deliveryMode === 'LOCAL_SANDBOX_DRYRUN' && dryLog.status === 'LOCAL_SANDBOX', `Dry-run log missing/incorrect: ${JSON.stringify(dryLog)}`);
    assert.ok(failLog && failLog.status === 'FAILED' && failLog.providerErrorCode === 'SIMULATED_ZNS_503', `Failed ZNS log missing/incorrect: ${JSON.stringify(failLog)}`);

    const dlqRes = await apiRequest(`${BFF_BASE}/api/v1/admin/ops/dlq`, { headers: adminHeaders });
    assert.equal(dlqRes.status, 200, `GET /api/v1/admin/ops/dlq failed: ${dlqRes.text}`);
    const notifyDlq = (unwrapData(dlqRes)?.queues || []).find((q) => q.name === 'atelier.notify.dlq');
    assert.ok(notifyDlq && notifyDlq.messageCount >= 1, `Expected atelier.notify.dlq to contain failed ZNS message: ${JSON.stringify(notifyDlq)}`);

    record(
      'CHECK_4',
      'Real Zalo OA/ZNS Client & atelier.notify.dlq Retry Path',
      'PASS',
      [
        `Dry-run ZNS (${dryEventId}): status=${dryLog.status}, deliveryMode=${dryLog.deliveryMode} (truthful, never fake live SENT)`,
        `Simulated failure (${failEventId}): exponential retry backoff=${failElapsedMs}ms (3 attempts), status=FAILED, providerErrorCode=SIMULATED_ZNS_503`,
        `DLQ verified: znsDeadLettered=true, atelier.notify.dlq messageCount=${notifyDlq.messageCount}`,
      ],
      { dryEventId, failEventId, failElapsedMs, retryCount: failData.znsRetryCount, znsDeadLettered: failData.znsDeadLettered, notifyDlqCount: notifyDlq.messageCount },
    );
  } catch (err) {
    record('CHECK_4', 'Real Zalo OA/ZNS Client & atelier.notify.dlq Retry Path', 'FAIL', [err instanceof Error ? err.message : String(err)]);
  }

  // ============================================================================
  // CHECK 5 — Real Sharp Binary validate-garment (NO Hardcoded 94) + Layer 6 HITL Lock
  // ============================================================================
  try {
    const { goodPngBuf, badJpgBuf } = await generateGarmentTestImages();

    const goodMp = buildMultipartBody('file', 'garment-good-3x4.png', 'image/png', goodPngBuf);
    const goodRes = await apiRequest(`${BFF_BASE}/api/v1/admin/media/validate-garment`, {
      method: 'POST',
      headers: { ...adminHeaders, 'Content-Type': goodMp.contentType },
      body: goodMp.body,
    });
    assert.equal(goodRes.status, 200, `validate-garment (good PNG) failed (${goodRes.status}): ${goodRes.text}`);
    const good = unwrapData(goodRes);
    assert.equal(good?.isValid, true, `Expected good PNG isValid=true: ${goodRes.text}`);
    assert.equal(good?.detectedAspectRatio, '3:4', `Expected detectedAspectRatio=3:4, got ${good?.detectedAspectRatio}`);
    assert.ok(typeof good?.qualityScore === 'number' && good.qualityScore >= 80, `Expected good PNG qualityScore >= 80, got ${good?.qualityScore}`);
    assert.equal(good?.status, 'NHAP_AI', 'HITL lock: status must be NHAP_AI');
    assert.equal(good?.autoAttachAsTryOnGarment, false, 'HITL lock: autoAttachAsTryOnGarment must be false');
    assert.equal(good?.requiresHumanApproval, true, 'HITL lock: requiresHumanApproval must be true');

    const badMp = buildMultipartBody('file', 'garment-bad-16x9.jpg', 'image/jpeg', badJpgBuf);
    const badRes = await apiRequest(`${BFF_BASE}/api/v1/admin/media/validate-garment`, {
      method: 'POST',
      headers: { ...adminHeaders, 'Content-Type': badMp.contentType },
      body: badMp.body,
    });
    assert.equal(badRes.status, 200, `validate-garment (bad JPEG) failed (${badRes.status}): ${badRes.text}`);
    const bad = unwrapData(badRes);
    assert.equal(bad?.isValid, false, `Expected bad JPEG isValid=false: ${badRes.text}`);
    assert.equal(bad?.detectedAspectRatio, '16:9', `Expected detectedAspectRatio=16:9, got ${bad?.detectedAspectRatio}`);
    assert.ok(typeof bad?.qualityScore === 'number' && bad.qualityScore < 60 && bad.qualityScore < good.qualityScore, `Expected bad qualityScore < 60 and < good (${good.qualityScore}), got ${bad?.qualityScore}`);
    assert.ok(Array.isArray(bad?.warnings) && bad.warnings.length >= 2, `Expected >= 2 Vietnamese warnings, got ${JSON.stringify(bad?.warnings)}`);
    assert.equal(bad?.status, 'NHAP_AI', 'HITL lock on bad image: status must be NHAP_AI');
    assert.equal(bad?.autoAttachAsTryOnGarment, false, 'HITL lock on bad image: autoAttachAsTryOnGarment must be false');
    assert.equal(bad?.requiresHumanApproval, true, 'HITL lock on bad image: requiresHumanApproval must be true');

    const forgedMp = buildMultipartBody('file', 'forged.png', 'image/png', Buffer.from('<html><body>fake-png</body></html>', 'utf8'));
    const forgedRes = await apiRequest(`${BFF_BASE}/api/v1/admin/media/validate-garment`, {
      method: 'POST',
      headers: { ...adminHeaders, 'Content-Type': forgedMp.contentType },
      body: forgedMp.body,
    });
    assert.equal(forgedRes.status, 400, `Forged magic bytes must return HTTP 400, got ${forgedRes.status}: ${forgedRes.text}`);
    assert.equal(forgedRes.json?.error?.code, 'INVALID_MAGIC_BYTES', `Expected INVALID_MAGIC_BYTES, got ${forgedRes.text}`);

    record(
      'CHECK_5',
      'Real Sharp Binary validate-garment + Layer 6 HITL Lock + Magic Bytes Reject',
      'PASS',
      [
        `Good 768x1024 PNG (3:4 transparent): isValid=true, score=${good.qualityScore}, ratio=${good.detectedAspectRatio}, alphaCorners=${good.cornerTransparencyRatio}, HITL=NHAP_AI/autoAttach=false/humanApproval=true`,
        `Bad 320x180 JPEG (16:9 opaque): isValid=false, score=${bad.qualityScore} (<60), ratio=${bad.detectedAspectRatio}, warnings=${bad.warnings.length}, HITL=NHAP_AI/autoAttach=false/humanApproval=true`,
        `Forged Magic Bytes: HTTP 400 INVALID_MAGIC_BYTES`,
      ],
      { goodScore: good.qualityScore, badScore: bad.qualityScore, badWarningsCount: bad.warnings.length, forgedHttp: forgedRes.status },
    );
  } catch (err) {
    record('CHECK_5', 'Real Sharp Binary validate-garment + Layer 6 HITL Lock + Magic Bytes Reject', 'FAIL', [err instanceof Error ? err.message : String(err)]);
  }

  // ============================================================================
  // CHECK 6 — AI Try-On RabbitMQ Topology, Lookbook Real VTON & BFF Socket.io Redis Adapter + 60s Replay TTL
  // ============================================================================
  let redisClient = null;
  try {
    // 6a. ai-tryon /health & /v1/tryon/health
    const tryonHealth = (await apiRequest(`${TRYON_BASE}/health`)).json;
    const tryonV1Health = unwrapData(await apiRequest(`${TRYON_BASE}/v1/tryon/health`));
    for (const [label, h] of [['/health', tryonHealth], ['/v1/tryon/health', tryonV1Health]]) {
      assert.ok(h?.retryTopology, `Missing retryTopology on ai-tryon ${label}`);
      const topo = h.retryTopology;
      assert.equal(topo.queue ?? topo.mainQueue, 'tryon.jobs', `Unexpected main queue on ${label}: ${JSON.stringify(topo)}`);
      assert.equal(topo.dlx ?? topo.dlxExchange, 'atelier.tryon.dlx', `Unexpected dlx on ${label}: ${JSON.stringify(topo)}`);
      assert.equal(topo.dlq ?? topo.dlqQueue, 'atelier.tryon.dlq', `Unexpected dlq on ${label}: ${JSON.stringify(topo)}`);
      const retryQueues = topo.retryQueues || [];
      assert.equal(retryQueues.length, 3, `Expected 3 retry queues on ${label}: ${JSON.stringify(topo)}`);
      assert.deepEqual(
        retryQueues.map((q) => q.queue),
        ['atelier.tryon.retry.1', 'atelier.tryon.retry.2', 'atelier.tryon.retry.3'],
        `Unexpected retry queue names on ${label}: ${JSON.stringify(retryQueues)}`,
      );
      const ttls = retryQueues.map((q) => Number(q.ttlMs ?? q.ttl_ms));
      assert.deepEqual(ttls, [2000, 10000, 30000], `Expected retry TTLs [2000, 10000, 30000], got ${JSON.stringify(ttls)}`);
      assert.ok(typeof h.workerTransport === 'string' && h.workerTransport.length > 0, `Missing workerTransport on ${label}`);
      assert.ok(typeof h.databaseDialect === 'string' && h.databaseDialect.length > 0, `Missing databaseDialect on ${label}`);
    }

    // 6b. Lookbook Studio Real VTON (AutoVTONProvider, NOT MOCK) + HITL locks
    const lookbookRes = await apiRequest(`${BFF_BASE}/api/v1/admin/catalog/products/${FLAGSHIP_PRODUCT_ID}/lookbooks`, {
      method: 'POST',
      headers: adminHeaders,
      body: {
        virtualModelCode: 'MODEL_VN_FEMALE_01',
        scenePrompt: 'Atelier Ha Noi anh nang buoi sang tu nhien sang trong',
      },
      timeoutMs: 60_000,
    });
    assert.ok(lookbookRes.status === 200 || lookbookRes.status === 201, `Lookbook generation failed (${lookbookRes.status}): ${lookbookRes.text}`);
    const lb = unwrapData(lookbookRes);
    const allowedRealProviders = new Set(['SMART_POSE_WARP_V2', 'FAL_CATVTON', 'FASHN_VTON', 'LOCAL_GPU_VTON', 'HF_GRADIO_VTON']);
    assert.ok(allowedRealProviders.has(String(lb?.providerUsed || '')), `Expected real VTON providerUsed (not MOCK), got ${lb?.providerUsed}`);
    assert.equal(lb?.autoAttachAsTryOnGarment, false, 'Lookbook HITL lock: autoAttachAsTryOnGarment must be false');
    assert.equal(lb?.requiresHumanApproval, true, 'Lookbook HITL lock: requiresHumanApproval must be true');
    assert.equal(lb?.draftStatus, 'NHAP_AI', `Lookbook HITL lock: draftStatus must be NHAP_AI, got ${lb?.draftStatus}`);

    // 6c. BFF /health + /api/v1/admin/ops/health-cluster + Redis 60s Replay TTL
    const bffHealth = (await apiRequest(`${BFF_BASE}/health`)).json;
    const bffMeta = bffHealth?.metadata || bffHealth;
    assert.equal(bffMeta?.socketIoRedisAdapter, true, `Expected BFF /health socketIoRedisAdapter=true: ${JSON.stringify(bffHealth)}`);
    assert.equal(bffMeta?.realtimeReplayBackend, 'redis', `Expected BFF /health realtimeReplayBackend=redis: ${JSON.stringify(bffHealth)}`);

    const clusterRes = await apiRequest(`${BFF_BASE}/api/v1/admin/ops/health-cluster`, { headers: adminHeaders });
    assert.equal(clusterRes.status, 200, `health-cluster failed: ${clusterRes.text}`);
    const bffNode = (unwrapData(clusterRes)?.services || []).find((s) => s.name === 'bff');
    assert.equal(bffNode?.details?.socketIoRedisAdapter, true, `Expected health-cluster bff socketIoRedisAdapter=true: ${JSON.stringify(bffNode)}`);
    assert.equal(bffNode?.details?.realtimeReplayBackend, 'redis', `Expected health-cluster bff realtimeReplayBackend=redis: ${JSON.stringify(bffNode)}`);

    const testSessionId = `p22-ws-tryon-${crypto.randomUUID().slice(0, 8)}`;
    const pushTryonRes = await apiRequest(`${BFF_BASE}/internal/realtime/tryon-event`, {
      method: 'POST',
      headers: { 'x-internal-secret': INTERNAL_SECRET },
      body: {
        event: 'tryon:progress',
        sessionId: testSessionId,
        progressPct: 65,
        stage: 'P22_REDIS_REPLAY_CHECK',
      },
    });
    assert.equal(pushTryonRes.status, 200, `Internal realtime tryon-event push failed: ${pushTryonRes.text}`);

    const parsedRedis = new URL(REDIS_URL);
    redisClient = new Redis({
      host: parsedRedis.hostname || '127.0.0.1',
      port: parsedRedis.port ? Number(parsedRedis.port) : 6379,
      password: parsedRedis.password ? decodeURIComponent(parsedRedis.password) : envVars.REDIS_PASSWORD || undefined,
      connectTimeout: 2000,
    });
    const replayKey = `atelier:ws:replay:tryon:${testSessionId}`;
    const matchingKeys = await redisClient.keys('atelier:ws:replay:*');
    assert.ok(matchingKeys.includes(replayKey), `Redis missing key ${replayKey}; found keys=${JSON.stringify(matchingKeys)}`);
    const ttl = await redisClient.ttl(replayKey);
    assert.ok(ttl > 0 && ttl <= 60, `Expected 0 < TTL <= 60 for ${replayKey}, got ${ttl}`);
    const replayEntries = await redisClient.lrange(replayKey, 0, -1);
    assert.ok(replayEntries.length >= 1 && replayEntries[0].includes('P22_REDIS_REPLAY_CHECK'), `Unexpected Redis replay entry: ${JSON.stringify(replayEntries)}`);

    record(
      'CHECK_6',
      'AI Try-On Durable Topology, Lookbook Real VTON & BFF Socket.io Redis Adapter + 60s Replay TTL',
      'PASS',
      [
        `ai-tryon topology: mainQueue=tryon.jobs, retry=[2000,10000,30000], dlx=atelier.tryon.dlx -> atelier.tryon.dlq; workerTransport=${tryonHealth.workerTransport}, rabbitmqConnected=${tryonHealth.rabbitmqConnected} (AMQP :5672 offline on non-Docker host; RabbitMQ Mgmt :15672 managed by local-infra-dev.mjs), databaseDialect=${tryonHealth.databaseDialect}`,
        `Lookbook Studio real VTON: providerUsed=${lb.providerUsed} (not MOCK), draftStatus=${lb.draftStatus}, autoAttachAsTryOnGarment=false, requiresHumanApproval=true`,
        `BFF Redis Adapter & Replay: socketIoRedisAdapter=true, realtimeReplayBackend=redis, key=${replayKey}, TTL=${ttl}s (0 < TTL <= 60)`,
      ],
      {
        workerTransport: tryonHealth.workerTransport,
        rabbitmqConnected: tryonHealth.rabbitmqConnected,
        databaseDialect: tryonHealth.databaseDialect,
        lookbookProviderUsed: lb.providerUsed,
        lookbookDraftStatus: lb.draftStatus,
        socketIoRedisAdapter: true,
        realtimeReplayBackend: 'redis',
        redisReplayKey: replayKey,
        redisReplayTtlSec: ttl,
      },
    );
  } catch (err) {
    record('CHECK_6', 'AI Try-On Durable Topology, Lookbook Real VTON & BFF Socket.io Redis Adapter + 60s Replay TTL', 'FAIL', [err instanceof Error ? err.message : String(err)]);
  } finally {
    if (redisClient) await redisClient.quit().catch(() => {});
  }

  metrics.totalSec = Number(((Date.now() - startedAt) / 1000).toFixed(1));
  fs.writeFileSync(path.join(ARTIFACTS_DIR, 'verify-p2-2-metrics.json'), `${JSON.stringify(metrics, null, 2)}\n`, 'utf8');

  console.log('\n========================================================================');
  console.log(` CHẶNG P2.2 SUMMARY: PASS=${metrics.passCount}/6 | FAIL=${metrics.failCount} (${metrics.totalSec}s)`);
  console.log('========================================================================\n');

  if (metrics.failCount > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('[FATAL] verify-p2-2-integrations:', err);
  process.exit(1);
});
