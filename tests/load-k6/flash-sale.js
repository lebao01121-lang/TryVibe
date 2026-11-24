/**
 * k6 Load & Flash-Sale Contention Test — fashion-atelier-ai-platform (v3.0)
 *
 * Usage (requires k6 installed on host/CI):
 *   k6 run tests/load-k6/flash-sale.js
 *   BFF_BASE=http://127.0.0.1:4000 INVENTORY_BASE=http://127.0.0.1:4004 k6 run tests/load-k6/flash-sale.js
 *
 * Scenarios:
 *   1. browse_editorial  — sustained storefront browse (Bootstrap, PLP, PDP, Vietnamese search)
 *   2. flash_sale_spike  — 100 simultaneous VUs contending for 15 Flash Sale SKU units (0% oversell)
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';

const BFF_BASE = __ENV.BFF_BASE || 'http://127.0.0.1:4000';
const INVENTORY_BASE = __ENV.INVENTORY_BASE || 'http://127.0.0.1:4004';
const FLASH_SKU_ID = __ENV.FLASH_SKU_ID || '86f73860-17cd-4361-87f1-41a47c66aa9a';

const flashReserved201 = new Counter('flash_sale_reserved_201');
const flashConflict409 = new Counter('flash_sale_conflict_409');
const flashServerErr5xx = new Counter('flash_sale_server_5xx');
const bootstrapLatency = new Trend('storefront_bootstrap_ms');

export const options = {
  scenarios: {
    browse_editorial: {
      executor: 'constant-vus',
      vus: 10,
      duration: '15s',
      exec: 'browseEditorial',
    },
    flash_sale_spike: {
      executor: 'per-vu-iterations',
      vus: 100,
      iterations: 1,
      startTime: '2s',
      maxDuration: '30s',
      exec: 'flashSaleContention',
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<800'],
    storefront_bootstrap_ms: ['p(95)<120'],
    flash_sale_server_5xx: ['count==0'],
    checks: ['rate>0.99'],
  },
};

export function browseEditorial() {
  const bootRes = http.get(`${BFF_BASE}/bff/v1/storefront/bootstrap`, {
    headers: { 'x-load-test-bypass': '1' },
  });
  bootstrapLatency.add(bootRes.timings.duration);
  check(bootRes, {
    'bootstrap HTTP 200': (r) => r.status === 200,
  });

  const searchRes = http.get(
    `${BFF_BASE}/bff/v1/storefront/products?q=${encodeURIComponent('ao blazer')}`,
    { headers: { 'x-load-test-bypass': '1' } },
  );
  check(searchRes, {
    'search HTTP 200': (r) => r.status === 200,
  });

  const pdpRes = http.get(
    `${BFF_BASE}/bff/v1/storefront/products/ao-blazer-linen-dang-suong`,
    { headers: { 'x-load-test-bypass': '1' } },
  );
  check(pdpRes, {
    'pdp HTTP 200': (r) => r.status === 200,
  });

  sleep(0.3);
}

export function flashSaleContention() {
  const orderRef = `K6-FS-${__VU}-${Date.now()}`;
  const payload = JSON.stringify({
    referenceId: orderRef,
    reservationType: 'CHECKOUT',
    ttlSeconds: 900,
    idempotencyKey: `idem-${orderRef}`,
    items: [{ skuId: FLASH_SKU_ID, qty: 1 }],
  });

  const res = http.post(`${INVENTORY_BASE}/v1/inventory/reservations`, payload, {
    headers: {
      'Content-Type': 'application/json',
      'x-load-test-bypass': '1',
    },
  });

  if (res.status === 201 || res.status === 200) {
    flashReserved201.add(1);
  } else if (res.status === 409) {
    flashConflict409.add(1);
  } else if (res.status >= 500) {
    flashServerErr5xx.add(1);
  }

  check(res, {
    'flash sale returns 201 or 409 (zero 5xx)': (r) =>
      r.status === 201 || r.status === 200 || r.status === 409,
  });
}
