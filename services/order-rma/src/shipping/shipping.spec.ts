import * as crypto from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OrderStatus, RmaStatus, ShipmentStatus, ShippingMethod } from '@atelier/contracts';
import type { OrderRmaConfig } from '../config/env';
import { AhaMoveAdapter } from './ahamove.adapter';
import { GhnAdapter } from './ghn.adapter';
import { GhtkAdapter } from './ghtk.adapter';
import { ShippingProviderRegistry } from './shipping-provider.registry';
import {
  buildDeterministicEventId,
  fetchCarrierJsonWithRetry,
  normalizeGsoCode,
  resolveGhnDistrictId,
  resolveVnLocation,
  verifyCarrierWebhookSignature,
} from './vn-location.helper';

function createShippingConfig(overrides?: {
  ghnLive?: boolean;
  ghtkLive?: boolean;
  ahamoveLive?: boolean;
}): OrderRmaConfig {
  return {
    serviceName: '@atelier/order-rma',
    boundedContext: 'order-rma',
    port: 4006,
    nodeEnv: 'test',
    internalServiceSecret: 'test-internal',
    corsAllowedOrigins: [],
    reservationTtlSeconds: 900,
    sweeperIntervalMs: 20_000,
    database: {
      envVar: 'ORDER_DATABASE_URL',
      configured: false,
      url: 'postgresql://localhost/order_db',
      targetDatabase: 'order_db',
      host: '127.0.0.1',
      port: 5432,
    },
    rabbitmq: { configured: false, url: 'amqp://localhost:5672' },
    upstreams: {
      authCustomerServiceUrl: 'http://127.0.0.1:4001',
      catalogLookbookServiceUrl: 'http://127.0.0.1:4002',
      inventoryServiceUrl: 'http://127.0.0.1:4004',
      cartOutfitServiceUrl: 'http://127.0.0.1:4005',
      paymentPromoServiceUrl: 'http://127.0.0.1:4007',
      notifyReviewServiceUrl: 'http://127.0.0.1:4008',
      bffUrl: 'http://127.0.0.1:4000',
    },
    infra: { rabbitmqConfigured: false },
    shipping: {
      originProvinceCode: '01',
      originProvinceName: 'Thành phố Hà Nội',
      originDistrictCode: '001',
      originDistrictName: 'Quận Ba Đình',
      originWardCode: '00013',
      originWardName: 'Phường Quán Thánh',
      originAddress: '18 Phan Đình Phùng, Ba Đình, Hà Nội',
      originPhone: '02438882026',
      originName: 'TryVibe Fashion Atelier',
      ghn: {
        token: overrides?.ghnLive ? 'ghn-live-token' : null,
        shopId: overrides?.ghnLive ? '123456' : null,
        apiUrl: 'https://dev-online-gateway.ghn.vn/shiip/public-api',
        webhookSecret: 'ghn-webhook-secret-2026',
        fromDistrictId: 1482,
        fromWardCode: '1A0107',
      },
      ghtk: {
        token: overrides?.ghtkLive ? 'ghtk-live-token' : null,
        apiUrl: 'https://services.giaohangtietkiem.vn',
        webhookSecret: 'ghtk-webhook-secret-2026',
      },
      ahamove: {
        token: overrides?.ahamoveLive ? 'ahamove-live-token' : null,
        apiUrl: 'https://apistg.ahamove.com',
        webhookSecret: 'ahamove-webhook-secret-2026',
      },
    },
  };
}

function hmacHex(body: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(body, 'utf8').digest('hex');
}

describe('vn-location.helper — GSO Mapping, HMAC timingSafeEqual & Retry', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('normalizes GSO codes and resolves Vietnam regions, zones, inner districts, and GHN district IDs', () => {
    expect(normalizeGsoCode('1', 2)).toBe('01');
    expect(normalizeGsoCode('2', 3)).toBe('002');
    expect(normalizeGsoCode('  ', 2)).toBeNull();

    const hnInner = resolveVnLocation({ provinceCode: '01', districtCode: '001', wardCode: '00013' });
    expect(hnInner.zone).toBe('INTRA_CITY');
    expect(hnInner.isHanoi).toBe(true);
    expect(hnInner.isInnerDistrict).toBe(true);
    expect(hnInner.isAhaMoveEligible).toBe(true);
    expect(resolveGhnDistrictId(hnInner)).toBe(1482);

    const hcmInner = resolveVnLocation({ provinceName: 'TP.HCM', districtCode: '760' });
    expect(hcmInner.zone).toBe('INTER_REGION');
    expect(hcmInner.isHcm).toBe(true);
    expect(hcmInner.isAhaMoveEligible).toBe(true);
    expect(hcmInner.isInnerDistrict).toBe(true);
    expect(resolveGhnDistrictId(hcmInner)).toBe(1442);

    const daNang = resolveVnLocation({ provinceCode: '48', districtName: 'Huyện Hòa Vang' });
    expect(daNang.region).toBe('CENTRAL');
    expect(daNang.zone).toBe('INTER_REGION');
    expect(daNang.isAhaMoveEligible).toBe(false);
    expect(daNang.isInnerDistrict).toBe(false);
    expect(resolveGhnDistrictId(daNang)).toBe(1528);

    const haiPhong = resolveVnLocation({ provinceCode: '31' });
    expect(haiPhong.zone).toBe('INTRA_REGION');

    const unknownSouth = resolveVnLocation({ provinceCode: '89', districtName: 'TP Long Xuyên' });
    expect(unknownSouth.region).toBe('SOUTH');
    expect(resolveGhnDistrictId(unknownSouth)).toBe(1482);
  });

  it('verifies carrier webhook signatures using HMAC-SHA256 timingSafeEqual and rejects tampered payloads', () => {
    const secret = 'carrier-secret-2026';
    const rawBody = JSON.stringify({ OrderCode: 'GHN123', Status: 'delivered' });
    const validSig = hmacHex(rawBody, secret);

    expect(verifyCarrierWebhookSignature({ 'x-ghn-signature': validSig }, rawBody, ['x-ghn-signature'], secret)).toBe(true);
    expect(verifyCarrierWebhookSignature({ 'x-ghn-signature': `sha256=${validSig}` }, rawBody, ['x-ghn-signature'], secret)).toBe(true);
    expect(verifyCarrierWebhookSignature({ 'x-webhook-token': secret }, rawBody, ['x-ghn-signature'], secret)).toBe(true);

    // Tampered payload MUST fail
    expect(verifyCarrierWebhookSignature({ 'x-ghn-signature': validSig }, `${rawBody} `, ['x-ghn-signature'], secret)).toBe(false);
    // Tampered signature MUST fail
    expect(verifyCarrierWebhookSignature({ 'x-ghn-signature': '0'.repeat(64) }, rawBody, ['x-ghn-signature'], secret)).toBe(false);
    // Missing header or empty secret MUST fail
    expect(verifyCarrierWebhookSignature({}, rawBody, ['x-ghn-signature'], secret)).toBe(false);
    expect(verifyCarrierWebhookSignature({ 'x-ghn-signature': validSig }, rawBody, ['x-ghn-signature'], '')).toBe(false);

    expect(buildDeterministicEventId('ghn', ['GHN1', 'delivered'])).toBe('ghn:GHN1:delivered');
    expect(buildDeterministicEventId('ghn', ['x'.repeat(200)])).toMatch(/^ghn:[0-9a-f]{24}$/);
  });

  it('retries once on HTTP 5xx inside fetchCarrierJsonWithRetry', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('upstream error', { status: 502 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 200, data: { total: 30000 } }), { status: 200 }));

    const result = await fetchCarrierJsonWithRetry(
      'https://carrier.test/fee',
      { method: 'POST' },
      { maxRetries: 1, retryDelayMs: 1 },
    );
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(2);
    expect(result.json?.code).toBe(200);
  });
});

describe('GhnAdapter, GhtkAdapter, AhaMoveAdapter & ShippingProviderRegistry', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('computes deterministic GSO quotes, structured tracking codes, and webhook parsing for GhnAdapter', async () => {
    const adapter = new GhnAdapter(createShippingConfig());
    expect(adapter.isLiveConfigured()).toBe(false);

    // Inner Hanoi 500g -> base 22_000
    const hnQuote = await adapter.quote({ provinceCode: '01', districtCode: '001', weightGrams: 500 });
    expect(hnQuote.mode).toBe('SANDBOX_LOCAL');
    expect(hnQuote.feeVnd).toBe(22_000);
    expect(hnQuote.estimatedDeliveryHours).toBe(24);

    // Outer HCM 1200g (+2 extra 500g units = +10_000), order 4M (+20_000 insurance), COD 3M (+5_000), remote (+4_000)
    const southQuote = await adapter.quote({
      provinceCode: '79',
      districtName: 'Huyện Củ Chi',
      weightGrams: 1_200,
      orderValueVnd: 4_000_000,
      codAmountVnd: 3_000_000,
    });
    expect(southQuote.feeVnd).toBe(38_000 + 10_000 + 20_000 + 5_000 + 4_000);
    expect(southQuote.estimatedDeliveryHours).toBe(72);

    const shipment = await adapter.createShipment({
      orderId: 'ord-1',
      orderCode: 'TX-2026ABC123',
      shippingMethod: ShippingMethod.GHN,
      recipientName: 'Lan',
      recipientPhone: '0901234567',
      provinceCode: '01',
      districtCode: '001',
      provinceName: 'Hà Nội',
      districtName: 'Ba Đình',
      wardName: 'Quán Thánh',
      streetLine: '18 Phan Đình Phùng',
      weightGrams: 500,
      orderValueVnd: 1_200_000,
      codAmountVnd: 0,
      items: [{ name: 'Blazer', skuCode: 'AT-BLZ-M', qty: 1, priceVnd: 1_200_000 }],
    });
    expect(shipment.trackingCode).toMatch(/^GHN\d{6}ABC123[0-9A-F]{4}$/);
    expect(shipment.mode).toBe('SANDBOX_LOCAL');

    // Webhook HMAC verification (valid vs tampered) & parsing
    const body = JSON.stringify({ OrderCode: shipment.trackingCode, ClientOrderCode: 'TX-2026ABC123', Status: 'delivered' });
    const sig = hmacHex(body, 'ghn-webhook-secret-2026');
    expect(adapter.verifyWebhook({ 'x-ghn-signature': sig }, body)).toBe(true);
    expect(adapter.verifyWebhook({ 'x-ghn-signature': sig }, `${body}!`)).toBe(false);

    expect(adapter.parseWebhook({ OrderCode: 'G1', Status: 'picked' }, {})).toMatchObject({
      mappedOrderStatus: OrderStatus.SHIPPED,
      mappedShipmentStatus: ShipmentStatus.PICKED,
      mappedRmaStatus: RmaStatus.RETURN_IN_TRANSIT,
    });
    expect(adapter.parseWebhook({ OrderCode: 'G1', Status: 'delivered' }, {})).toMatchObject({
      mappedOrderStatus: OrderStatus.DELIVERED,
      mappedShipmentStatus: ShipmentStatus.DELIVERED,
      mappedRmaStatus: RmaStatus.QC_INSPECTING,
    });
    expect(adapter.parseWebhook({ OrderCode: 'G1', Status: 'delivery_fail' }, {})).toMatchObject({
      mappedOrderStatus: 'DELIVERY_FAILED',
      mappedShipmentStatus: ShipmentStatus.DELIVERY_FAILED,
    });

    // Live mode quote & createShipment with mocked fetch
    const liveGhn = new GhnAdapter(createShippingConfig({ ghnLive: true }));
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: 200, data: { total: 29_500, service_fee: 27_000, insurance_fee: 2_500 } }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: 200, data: { leadtime: Math.floor(Date.now() / 1000) + 86400 } }), { status: 200 }),
      );
    const liveQuote = await liveGhn.quote({ provinceCode: '48', weightGrams: 600 });
    expect(liveQuote.mode).toBe('LIVE');
    expect(liveQuote.feeVnd).toBe(29_500);
  });

  it('computes GSO quotes, structured tracking codes, and webhook verification for GhtkAdapter', async () => {
    const adapter = new GhtkAdapter(createShippingConfig());

    const centralQuote = await adapter.quote({
      provinceCode: '48',
      districtName: 'Huyện Hòa Vang',
      weightGrams: 1_000, // +1 unit = +4_000
      orderValueVnd: 5_000_000, // 0.5% = 25_000
      codAmountVnd: 4_000_000, // +4_000
    });
    expect(centralQuote.feeVnd).toBe(30_000 + 4_000 + 25_000 + 4_000 + 3_000);

    const shipment = await adapter.createShipment({
      orderId: 'ord-2',
      orderCode: 'TX-2026GHTK01',
      shippingMethod: ShippingMethod.GHTK,
      recipientName: 'Minh',
      recipientPhone: '0909998888',
      provinceCode: '31',
      provinceName: 'Hải Phòng',
      districtName: 'Hồng Bàng',
      wardName: 'Minh Khai',
      streetLine: '12 Điện Biên Phủ',
      weightGrams: 500,
      orderValueVnd: 900_000,
      codAmountVnd: 900_000,
      items: [{ name: 'Áo sơ mi', skuCode: 'AT-SHIRT-M', qty: 1, priceVnd: 900_000 }],
    });
    expect(shipment.trackingCode).toMatch(/^S1\.GHTK\.\d{6}\.GHTK01[0-9A-F]{4}$/);

    const body = JSON.stringify({ label_id: shipment.trackingCode, status_id: 5 });
    const sig = hmacHex(body, 'ghtk-webhook-secret-2026');
    expect(adapter.verifyWebhook({ 'x-ghtk-signature': sig }, body)).toBe(true);
    expect(adapter.verifyWebhook({ 'x-ghtk-signature': 'deadbeef' }, body)).toBe(false);

    expect(adapter.parseWebhook({ label_id: 'S1', status_id: 3 }, {})).toMatchObject({
      mappedOrderStatus: OrderStatus.SHIPPED,
      mappedShipmentStatus: ShipmentStatus.PICKED,
    });
    expect(adapter.parseWebhook({ label_id: 'S1', status_id: 5 }, {})).toMatchObject({
      mappedOrderStatus: OrderStatus.DELIVERED,
      mappedShipmentStatus: ShipmentStatus.DELIVERED,
    });
    expect(adapter.parseWebhook({ label_id: 'S1', status_id: 9 }, {})).toMatchObject({
      mappedOrderStatus: 'DELIVERY_FAILED',
    });
  });

  it('enforces Hanoi/HCM eligibility, 2H pricing, tracking codes, and HMAC webhooks for AhaMoveAdapter & Registry', async () => {
    const config = createShippingConfig();
    const adapter = new AhaMoveAdapter(config);

    // Ineligible province (Đà Nẵng)
    const dnQuote = await adapter.quote({ provinceCode: '48', weightGrams: 500 });
    expect(dnQuote.available).toBe(false);
    expect(dnQuote.feeVnd).toBe(0);

    // Eligible HCM inner district with 3kg (+5_000) & COD 2.5M (+6_000)
    const hcmQuote = await adapter.quote({
      provinceCode: '79',
      districtCode: '760',
      weightGrams: 3_000,
      codAmountVnd: 2_500_000,
    });
    expect(hcmQuote.available).toBe(true);
    expect(hcmQuote.feeVnd).toBe(42_000 + 5_000 + 6_000);
    expect(hcmQuote.estimatedDeliveryHours).toBe(2);

    const shipment = await adapter.createShipment({
      orderId: 'ord-3',
      orderCode: 'TX-2026AHA001',
      shippingMethod: ShippingMethod.AHAMOVE_2H,
      recipientName: 'Mai',
      recipientPhone: '0911223344',
      provinceCode: '79',
      districtCode: '760',
      provinceName: 'TP. Hồ Chí Minh',
      districtName: 'Quận 1',
      wardName: 'Bến Nghé',
      streetLine: '68 Đồng Khởi',
      weightGrams: 500,
      orderValueVnd: 2_500_000,
      codAmountVnd: 0,
      items: [{ name: 'Đầm lụa', skuCode: 'AT-DRESS-S', qty: 1, priceVnd: 2_500_000 }],
    });
    expect(shipment.trackingCode).toMatch(/^AHA2HHCM/);

    const body = JSON.stringify({ _id: shipment.trackingCode, status: 'COMPLETED' });
    const sig = hmacHex(body, 'ahamove-webhook-secret-2026');
    expect(adapter.verifyWebhook({ 'x-ahamove-signature': sig }, body)).toBe(true);
    expect(adapter.verifyWebhook({ 'x-ahamove-signature': sig }, '{"tampered":true}')).toBe(false);

    expect(adapter.parseWebhook({ _id: 'A1', status: 'ACCEPTED' }, {})).toMatchObject({
      mappedOrderStatus: OrderStatus.SHIPPED,
      mappedShipmentStatus: ShipmentStatus.PICKED,
    });
    expect(adapter.parseWebhook({ _id: 'A1', status: 'COMPLETED' }, {})).toMatchObject({
      mappedOrderStatus: OrderStatus.DELIVERED,
      mappedShipmentStatus: ShipmentStatus.DELIVERED,
    });
    expect(adapter.parseWebhook({ _id: 'A1', status: 'CANCELLED' }, {})).toMatchObject({
      mappedOrderStatus: 'DELIVERY_FAILED',
    });

    // Registry checks
    const registry = new ShippingProviderRegistry(config);
    expect(registry.getAdapterBySlug('GHN')?.slug).toBe('ghn');
    expect(registry.getAdapterBySlug('unknown')).toBeNull();
    expect(registry.getAdapterByMethod(ShippingMethod.GHTK)?.slug).toBe('ghtk');
    expect(registry.getProviderStatuses()).toEqual({
      ghn: { mode: 'SANDBOX_LOCAL', configured: false },
      ghtk: { mode: 'SANDBOX_LOCAL', configured: false },
      ahamove: { mode: 'SANDBOX_LOCAL', configured: false },
    });

    const allQuotes = await registry.quoteAll({ provinceCode: '01', districtCode: '001', weightGrams: 500 });
    expect(allQuotes.map((q) => q.shippingMethod)).toEqual([
      ShippingMethod.GHN,
      ShippingMethod.GHTK,
      ShippingMethod.AHAMOVE_2H,
      ShippingMethod.PICKUP,
    ]);
    expect((await registry.quote({ shippingMethod: ShippingMethod.PICKUP, provinceCode: '79' })).feeVnd).toBe(0);

    const pickupShip = await registry.createShipment({
      orderId: 'ord-p',
      orderCode: 'TX-2026PKP001',
      shippingMethod: ShippingMethod.PICKUP,
      recipientName: 'Lan',
      recipientPhone: '0901234567',
      provinceName: 'Hà Nội',
      districtName: 'Ba Đình',
      wardName: 'Quán Thánh',
      streetLine: '18 Phan Đình Phùng',
      weightGrams: 400,
      orderValueVnd: 1_000_000,
      codAmountVnd: 0,
      items: [],
    });
    expect(pickupShip.trackingCode).toMatch(/^PKP-/);
    expect(pickupShip.actualFeeVnd).toBe(0);
  });
});
