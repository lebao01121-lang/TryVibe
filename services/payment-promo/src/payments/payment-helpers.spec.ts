import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ErrorCode,
  PaymentProvider,
  PaymentTransactionStatus,
  PromoStatus,
  PromoType,
} from '@atelier/contracts';
import type { AtelierDbExecutor } from '@atelier/db-client';
import type { PaymentRedisService } from '../cache/payment-redis.service';
import type { PaymentPromoConfig } from '../config/env';
import type { PaymentDbService } from '../db/payment-db.service';
import type { PaymentEventPublisherService } from '../messaging/payment-event-publisher.service';
import { PromotionsService } from '../promotions/promotions.service';
import {
  MomoAdapter,
  buildMomoCreateRawSignature,
  buildMomoIpnRawSignature,
  createMomoPayment,
  refundMomoTransaction,
  signMomoIpnPayload,
  verifyMomoIpnSignature,
} from './adapters/momo.adapter';
import {
  PayOsAdapter,
  buildPayOsCreateSignature,
  buildPayOsWebhookDataString,
  derivePayOsNumericOrderCode,
  signPayOsWebhookData,
  verifyPayOsWebhookSignature,
} from './adapters/payos.adapter';
import {
  VnpayAdapter,
  buildVnpayPaymentUrl,
  buildVnpaySignData,
  computeVnpayHmacSha512,
  formatVnpayDateUtc7,
  refundVnpayTransaction,
  verifyVnpaySignature,
  vnpayEncodeValue,
} from './adapters/vnpay.adapter';
import {
  VIETQR_QUIET_ZONE_MODULES,
  VIETQR_STANDARD,
  buildRawVietQrPngDataUrl,
  buildRawVietQrSvgDataUrl,
  buildVietQrPayload,
  buildVietQrSvgDataUrl,
  computeHmacSha256Hex,
  crc16Ccitt,
  normalizeWebhookProviderParam,
  renderVietQrArtifacts,
  verifyHmacSha256Signature,
  verifyVietQrEmvCoCrc16,
} from './payment-helpers';
import { PaymentsService } from './payments.service';

const ORDER_ID_1 = '60000000-0000-4000-8000-000000000001';
const ORDER_ID_2 = '60000000-0000-4000-8000-000000000002';
const ORDER_ID_3 = '60000000-0000-4000-8000-000000000003';
const ORDER_ID_4 = '60000000-0000-4000-8000-000000000004';

function createPaymentConfig(overrides?: {
  payosLive?: boolean;
  vnpayLive?: boolean;
  momoLive?: boolean;
  nodeEnv?: string;
}): PaymentPromoConfig {
  return {
    serviceName: '@atelier/payment-promo',
    boundedContext: 'payment-promo',
    port: 4007,
    nodeEnv: overrides?.nodeEnv ?? 'test',
    corsAllowedOrigins: ['http://localhost:3000'],
    internalServiceSecret: 'test-internal',
    storefrontPublicUrl: 'http://localhost:3000',
    bffPublicUrl: 'http://localhost:4000',
    database: {
      envVar: 'PAYMENT_DATABASE_URL',
      url: 'postgresql://localhost/payment_db',
      configured: false,
      targetDatabase: 'payment_db',
      host: '127.0.0.1',
      port: 5432,
    },
    infra: {
      redisUrl: 'redis://127.0.0.1:6379',
      redisConfigured: false,
      rabbitmqUrl: 'amqp://127.0.0.1:5672',
      rabbitmqConfigured: false,
    },
    upstreams: { orderRmaServiceUrl: 'http://127.0.0.1:4006' },
    webhookSecrets: {
      VIETQR: 'vietqr-secret-2026',
      VNPAY: 'vnpay-secret-2026',
      MOMO: 'momo-secret-2026',
    },
    vietqr: {
      bankBin: '970422',
      accountNo: '088820269999',
      accountName: 'TAM XUAN ATELIER',
    },
    payos: {
      clientId: overrides?.payosLive ? 'payos-client' : '',
      apiKey: overrides?.payosLive ? 'payos-key' : '',
      checksumKey: 'payos-checksum-2026',
      baseUrl: 'https://api-merchant.payos.vn',
      isLiveConfigured: Boolean(overrides?.payosLive),
    },
    vnpay: {
      tmnCode: 'ATELIER01',
      hashSecret: 'vnpay-secret-2026',
      paymentUrl: 'https://sandbox.vnpayment.vn/paymentv2/vpcpay.html',
      apiUrl: 'https://sandbox.vnpayment.vn/merchant_webapi/api/transaction',
      returnUrl: 'http://localhost:3000/thanh-toan/ket-qua',
      isLiveConfigured: Boolean(overrides?.vnpayLive),
      liveApiEnabled: Boolean(overrides?.vnpayLive),
    },
    momo: {
      partnerCode: 'ATELIER_MOMO',
      accessKey: 'ATELIER_ACCESS',
      secretKey: 'momo-secret-2026',
      apiUrl: 'https://test-payment.momo.vn',
      redirectUrl: 'http://localhost:3000/thanh-toan/ket-qua',
      ipnUrl: 'http://localhost:4000/bff/v1/payments/momo/ipn',
      isLiveConfigured: Boolean(overrides?.momoLive),
    },
  };
}

describe('VietQR EMVCo NAPAS 247, CRC16-CCITT & ISO/IEC 18004 QR Artifacts', () => {
  it('computes CRC16-CCITT (0xFFFF, poly 0x1021) matching standard vector and validates VietQR EMVCo structure', () => {
    // Standard CRC16-CCITT-FALSE check value for ASCII "123456789" is 0x29B1
    expect(crc16Ccitt('123456789')).toBe('29B1');

    const payload = buildVietQrPayload('TX-2026QR01', 1_850_000, {
      bankBin: '970422',
      accountNo: '088820269999',
      accountName: 'Tầm Xuân Atelier',
    });

    expect(payload.startsWith('000201010212')).toBe(true);
    expect(payload).toContain('A000000727'); // NAPAS 247 AID
    expect(payload).toContain('QRIBFTTA');
    expect(payload).toContain('5303704'); // VND ISO 4217 currency code
    expect(payload).toContain('54071850000'); // Exact integer amount
    expect(payload).toContain('5802VN');
    expect(payload).toContain('TAM XUAN ATELIER');
    expect(verifyVietQrEmvCoCrc16(payload)).toBe(true);

    // Tamper detection: changing a single digit in amount OR CRC fails validation
    const tamperedAmount = payload.replace('1850000', '1850001');
    expect(verifyVietQrEmvCoCrc16(tamperedAmount)).toBe(false);
    const tamperedCrc = `${payload.slice(0, -1)}${payload.endsWith('0') ? '1' : '0'}`;
    expect(verifyVietQrEmvCoCrc16(tamperedCrc)).toBe(false);

    // Structural rejection checks
    expect(verifyVietQrEmvCoCrc16('short')).toBe(false);
    expect(verifyVietQrEmvCoCrc16('9902010102126304ABCD')).toBe(false);
    expect(verifyVietQrEmvCoCrc16('00020199996304ABCD')).toBe(false);
  });

  it('generates genuine ISO/IEC 18004 QR SVG and PNG artifacts with quiet zone >= 4 modules', async () => {
    const payload = buildVietQrPayload('TX-2026QR02', 2_490_000);
    const artifacts = await renderVietQrArtifacts('TX-2026QR02', 2_490_000, payload);

    expect(artifacts.qrStandard).toBe(VIETQR_STANDARD);
    expect(artifacts.qrQuietZoneModules).toBe(VIETQR_QUIET_ZONE_MODULES);
    expect(artifacts.qrModuleCount).toBeGreaterThanOrEqual(21);
    expect(artifacts.qrSvgDataUrl).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(artifacts.rawQrSvgDataUrl).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(artifacts.rawQrPngDataUrl).toMatch(/^data:image\/png;base64,/);

    const decodedSvg = Buffer.from(artifacts.qrSvgDataUrl.split(',')[1]!, 'base64').toString('utf8');
    expect(decodedSvg).toContain('<svg');
    expect(decodedSvg).toContain('TX-2026QR02');
    expect(buildVietQrSvgDataUrl('TX-1', 500_000, payload)).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(buildRawVietQrSvgDataUrl(payload)).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(await buildRawVietQrPngDataUrl(payload)).toMatch(/^data:image\/png;base64,/);
  });

  it('verifies HMAC-SHA256 webhook signatures with timingSafeEqual and normalizes providers', () => {
    const raw = JSON.stringify({ orderCode: 'TX-1', amountVnd: 1_000_000 });
    const sig = computeHmacSha256Hex(raw, 'secret-1');
    expect(verifyHmacSha256Signature(raw, sig, 'secret-1')).toBe(true);
    expect(verifyHmacSha256Signature(raw, `sha256=${sig.toUpperCase()}`, 'secret-1')).toBe(true);
    expect(verifyHmacSha256Signature(`${raw} `, sig, 'secret-1')).toBe(false);
    expect(verifyHmacSha256Signature(raw, 'invalid', 'secret-1')).toBe(false);
    expect(verifyHmacSha256Signature(raw, null, 'secret-1')).toBe(false);

    expect(normalizeWebhookProviderParam('payos')).toBe(PaymentProvider.VIETQR);
    expect(normalizeWebhookProviderParam('vietqr')).toBe(PaymentProvider.VIETQR);
    expect(normalizeWebhookProviderParam('vnpay')).toBe(PaymentProvider.VNPAY);
    expect(normalizeWebhookProviderParam('momo')).toBe(PaymentProvider.MOMO);
    expect(normalizeWebhookProviderParam('stripe')).toBeNull();
  });
});

describe('VNPay v2.1.0, MoMo v2 & PayOS Signature Adapters', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('signs sorted vnp_* params with HMAC-SHA512 and verifies via timingSafeEqual (rejecting tampered params)', async () => {
    const cfg = createPaymentConfig();
    expect(formatVnpayDateUtc7(new Date('2026-11-25T00:00:00.000Z'))).toBe('20261125070000');
    expect(vnpayEncodeValue('Thanh toan don hang')).toBe('Thanh+toan+don+hang');

    const created = buildVnpayPaymentUrl(
      { orderCode: 'TX-VNP-01', amountVnd: 1_500_000, clientIp: '::ffff:127.0.0.1' },
      cfg.vnpay,
    );
    expect(created.mode).toBe('SANDBOX_LOCAL');
    expect(created.paymentUrl).toContain('vnp_SecureHashType=SHA512');

    // Parse URL back into query params and verify signature
    const urlObj = new URL(created.paymentUrl);
    const queryParams: Record<string, string> = {};
    urlObj.searchParams.forEach((val, key) => {
      queryParams[key] = val;
    });

    expect(verifyVnpaySignature(queryParams, cfg.vnpay.hashSecret)).toBe(true);

    // Tampering amount MUST fail verification
    expect(verifyVnpaySignature({ ...queryParams, vnp_Amount: '100' }, cfg.vnpay.hashSecret)).toBe(false);
    expect(verifyVnpaySignature({ ...queryParams, vnp_SecureHash: 'bad' }, cfg.vnpay.hashSecret)).toBe(false);
    expect(buildVnpaySignData({ non_vnp: '1', vnp_SecureHash: 'abc' })).toBe('');

    const adapter = new VnpayAdapter(cfg);
    expect(adapter.verifySignature(queryParams)).toBe(true);
    const refundRes = await refundVnpayTransaction(
      { orderCode: 'TX-VNP-01', amountVnd: 500_000, isFullRefund: false, reason: 'RMA' },
      cfg.vnpay,
    );
    expect(refundRes.ok).toBe(true);
    expect(refundRes.mode).toBe('SANDBOX_LOCAL');

    // Live refund branch
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ vnp_ResponseCode: '00', vnp_TransactionNo: '998877', vnp_Message: 'OK' }), { status: 200 }),
    );
    const liveRefund = await refundVnpayTransaction(
      { orderCode: 'TX-VNP-01', amountVnd: 500_000, isFullRefund: true, reason: 'Cancel' },
      createPaymentConfig({ vnpayLive: true }).vnpay,
    );
    expect(liveRefund.ok).toBe(true);
    expect(liveRefund.providerRefundId).toBe('998877');
  });

  it('signs and verifies MoMo v2 HMAC-SHA256 payloads (valid vs tampered)', async () => {
    const cfg = createPaymentConfig();
    const rawCreate = buildMomoCreateRawSignature({
      accessKey: cfg.momo.accessKey,
      amount: 1_200_000,
      extraData: '',
      ipnUrl: cfg.momo.ipnUrl,
      orderId: 'TX-MOMO-01',
      orderInfo: 'Tam Xuan',
      partnerCode: cfg.momo.partnerCode,
      redirectUrl: cfg.momo.redirectUrl,
      requestId: 'req-1',
      requestType: 'captureWallet',
    });
    expect(rawCreate).toContain('accessKey=ATELIER_ACCESS&amount=1200000');

    const created = await createMomoPayment({ orderCode: 'TX-MOMO-01', amountVnd: 1_200_000 }, cfg.momo);
    expect(created.mode).toBe('SANDBOX_LOCAL');
    expect(created.paymentUrl).toContain('signature=');

    const ipnPayload: Record<string, unknown> = {
      partnerCode: cfg.momo.partnerCode,
      orderId: 'TX-MOMO-01',
      requestId: 'req-1',
      amount: 1_200_000,
      orderInfo: 'Tam Xuan',
      orderType: 'momo_wallet',
      transId: 90012345,
      resultCode: 0,
      message: 'Successful.',
      payType: 'qr',
      responseTime: 1764000000000,
      extraData: '',
    };
    const signature = signMomoIpnPayload(ipnPayload, cfg.momo.secretKey, cfg.momo.accessKey);
    expect(buildMomoIpnRawSignature({ accessKey: cfg.momo.accessKey, amount: 1200000, extraData: '', message: 'Successful.', orderId: 'TX-MOMO-01', orderInfo: 'Tam Xuan', orderType: 'momo_wallet', partnerCode: cfg.momo.partnerCode, payType: 'qr', requestId: 'req-1', responseTime: 1764000000000, resultCode: 0, transId: 90012345 })).toContain('transId=90012345');

    expect(verifyMomoIpnSignature({ ...ipnPayload, signature }, cfg.momo.secretKey, cfg.momo.accessKey)).toBe(true);
    // Tampered amount or missing fields MUST fail
    expect(verifyMomoIpnSignature({ ...ipnPayload, amount: 100, signature }, cfg.momo.secretKey, cfg.momo.accessKey)).toBe(false);
    expect(verifyMomoIpnSignature({ ...ipnPayload, signature: 'bad' }, cfg.momo.secretKey, cfg.momo.accessKey)).toBe(false);
    expect(verifyMomoIpnSignature({ signature }, cfg.momo.secretKey, cfg.momo.accessKey)).toBe(false);

    const adapter = new MomoAdapter(cfg);
    expect(adapter.verifyIpnSignature({ ...ipnPayload, signature })).toBe(true);
    const ref = await refundMomoTransaction(
      { orderCode: 'TX-MOMO-01', amountVnd: 300_000, transId: '90012345', reason: 'Partial' },
      cfg.momo,
    );
    expect(ref.ok).toBe(true);
  });

  it('signs and verifies PayOS sorted payload HMAC-SHA256 webhooks and numeric order codes', async () => {
    const cfg = createPaymentConfig();
    const numericCode = derivePayOsNumericOrderCode('TX-PAYOS-01');
    expect(numericCode).toBe(derivePayOsNumericOrderCode('TX-PAYOS-01'));
    expect(numericCode).toBeGreaterThanOrEqual(100_000);

    const createSig = buildPayOsCreateSignature(
      { amount: 1_000_000, cancelUrl: 'http://a/cancel', description: 'TAMXUAN', orderCode: numericCode, returnUrl: 'http://a/ret' },
      cfg.payos.checksumKey,
    );
    expect(createSig).toMatch(/^[0-9a-f]{64}$/);

    const data = {
      orderCode: numericCode,
      amount: 1_000_000,
      description: 'TAMXUAN TX-PAYOS-01',
      reference: 'FT123456',
      code: '00',
      emptyField: null,
      meta: { b: 2, a: 1 },
      items: [{ z: 9, a: 1 }],
    };
    const serialized = buildPayOsWebhookDataString(data);
    expect(serialized.startsWith('amount=1000000&code=00&description=TAMXUAN TX-PAYOS-01&emptyField=&items=[{"a":1,"z":9}]&meta={"a":1,"b":2}')).toBe(true);

    const sig = signPayOsWebhookData(data, cfg.payos.checksumKey);
    const body = { code: '00', success: true, data, signature: sig };

    expect(verifyPayOsWebhookSignature(body, cfg.payos.checksumKey)).toBe(true);
    // Tampered data MUST fail
    expect(
      verifyPayOsWebhookSignature({ ...body, data: { ...data, amount: 999_999 } }, cfg.payos.checksumKey),
    ).toBe(false);
    expect(verifyPayOsWebhookSignature({ data: 'not-object', signature: sig }, cfg.payos.checksumKey)).toBe(false);

    const adapter = new PayOsAdapter(cfg);
    expect(adapter.isLiveConfigured).toBe(false);
    expect((await adapter.fetchLivePaymentStatus('pl-1')).ok).toBe(false);
    const intent = await adapter.createPaymentIntent({
      orderCode: 'TX-PAYOS-01',
      amountVnd: 1_000_000,
      returnUrl: 'http://localhost:3000/thanh-toan/ket-qua',
    });
    expect(intent.mode).toBe('SANDBOX_LOCAL');
    expect(intent.qrStandard).toBe(VIETQR_STANDARD);
    expect(verifyVietQrEmvCoCrc16(intent.qrPayload)).toBe(true);

    // Live PayOS adapter paths: createPaymentIntent, fetchLivePaymentStatus & PENDING link cancel
    const liveCfg = createPaymentConfig({ payosLive: true });
    const liveAdapter = new PayOsAdapter(liveCfg);
    expect(liveAdapter.isLiveConfigured).toBe(true);

    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          code: '00',
          desc: 'success',
          data: {
            checkoutUrl: 'https://pay.payos.vn/web/abc123',
            qrCode: intent.qrPayload,
            paymentLinkId: 'pl_live_001',
            bin: '970422',
            accountNumber: '088820269999',
            accountName: 'TAM XUAN ATELIER',
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const liveIntent = await liveAdapter.createPaymentIntent({
      orderCode: 'TX-PAYOS-LIVE',
      amountVnd: 1_200_000,
      returnUrl: 'http://localhost:3000/thanh-toan/ket-qua',
    });
    expect(liveIntent.mode).toBe('LIVE');
    expect(liveIntent.checkoutUrl).toBe('https://pay.payos.vn/web/abc123');
    expect(liveIntent.providerTxId).toBe('pl_live_001');

    // Live error from PayOS rejects with DEPENDENCY_UNAVAILABLE
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ code: '231', desc: 'Duplicate orderCode' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    await expect(
      liveAdapter.createPaymentIntent({
        orderCode: 'TX-PAYOS-ERR',
        amountVnd: 500_000,
        returnUrl: 'http://localhost:3000/thanh-toan/ket-qua',
      }),
    ).rejects.toMatchObject({ errorCode: ErrorCode.DEPENDENCY_UNAVAILABLE });

    // Live status check
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ code: '00', data: { status: 'PAID', amountPaid: 1_200_000 } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const liveStatus = await liveAdapter.fetchLivePaymentStatus('pl_live_001');
    expect(liveStatus.ok).toBe(true);
    expect(liveStatus.status).toBe('PAID');
    expect(liveStatus.amountPaid).toBe(1_200_000);

    // Live cancel pending link success & failure
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ code: '00', desc: 'cancelled' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const cancelOk = await liveAdapter.refundTransaction({
      orderCode: 'TX-PAYOS-LIVE',
      amountVnd: 1_200_000,
      reason: 'Customer cancelled',
      chargeStatus: 'PENDING',
      paymentLinkId: 'pl_live_001',
    });
    expect(cancelOk.ok).toBe(true);
    expect(cancelOk.providerRefundId).toBe('PAYOS-CANCEL-pl_live_001');

    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ code: '99', desc: 'Already paid' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const cancelFail = await liveAdapter.refundTransaction({
      orderCode: 'TX-PAYOS-LIVE',
      amountVnd: 1_200_000,
      reason: 'Too late',
      chargeStatus: 'PENDING',
      paymentLinkId: 'pl_live_001',
    });
    expect(cancelFail.ok).toBe(false);
    expect(cancelFail.providerCode).toBe('99');
  });
});

interface FakeTxRow {
  id: string;
  order_id: string;
  order_code: string;
  provider: PaymentProvider;
  tx_type: 'CHARGE' | 'REFUND';
  amount_vnd: number;
  status: PaymentTransactionStatus;
  provider_tx_id: string | null;
  idempotency_key: string;
  qr_payload: string | null;
  payment_url: string | null;
  signature_verified: boolean;
  raw_payload_jsonb: string | null;
  expires_at: string | null;
  created_at: string;
  paid_at: string | null;
}

interface FakeWebhookRow {
  provider: PaymentProvider;
  provider_event_id: string;
  order_code: string | null;
  signature_valid: boolean;
  signature_header: string | null;
  status: string;
  payload_summary: string;
  raw_payload_jsonb: string;
  received_at: string;
}

interface FakePromoRow {
  id: string;
  code: string;
  name: string;
  description: string | null;
  promo_type: PromoType;
  discount_value: number;
  max_discount_vnd: number;
  min_order_vnd: number;
  target_sizes_jsonb: string[];
  target_product_ids_jsonb: string[];
  target_sku_codes_jsonb: string[];
  bonus_tryon_credits: number;
  usage_limit: number;
  used_count: number;
  per_user_limit: number;
  status: PromoStatus;
  created_by_actor_type: 'USER' | 'AI_COPILOT' | 'SYSTEM';
  approved_by: string | null;
  approved_at: string | null;
  start_at: string;
  end_at: string;
  created_at: string;
  updated_at: string;
}

class InMemoryPaymentPromoDb {
  public txs: FakeTxRow[] = [];
  public webhooks: FakeWebhookRow[] = [];
  public promos: FakePromoRow[] = [];
  public redemptions: Array<{ id: string; promotion_id: string; user_id: string | null; order_id: string; status: string; expires_at: string }> = [];

  async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<{ rows: T[]; rowCount: number }> {
    const norm = sql.replace(/\s+/g, ' ').trim();
    const now = new Date().toISOString();

    // payment_transactions
    if (norm.startsWith("SELECT * FROM payment_transactions WHERE idempotency_key = $1 AND tx_type = 'REFUND'")) {
      const rows = this.txs.filter(
        (t) => t.idempotency_key === params[0] && t.tx_type === 'REFUND' && t.status === PaymentTransactionStatus.SUCCEEDED,
      );
      return { rows: rows as unknown as T[], rowCount: rows.length };
    }
    if (norm.startsWith('SELECT * FROM payment_transactions WHERE idempotency_key = $1')) {
      const rows = this.txs.filter((t) => t.idempotency_key === params[0]).slice(0, 1);
      return { rows: rows as unknown as T[], rowCount: rows.length };
    }
    if (norm.startsWith("SELECT * FROM payment_transactions WHERE id = $1::uuid AND tx_type = 'CHARGE'")) {
      const rows = this.txs.filter((t) => t.id === params[0] && t.tx_type === 'CHARGE');
      return { rows: rows as unknown as T[], rowCount: rows.length };
    }
    if (norm.startsWith("SELECT * FROM payment_transactions WHERE (order_id = $1::uuid OR order_code = $2) AND tx_type = 'CHARGE'")) {
      const rows = this.txs.filter((t) => (t.order_id === params[0] || t.order_code === params[1]) && t.tx_type === 'CHARGE');
      return { rows: rows as unknown as T[], rowCount: rows.length };
    }
    if (norm.startsWith("SELECT * FROM payment_transactions WHERE order_id = $1::uuid AND tx_type = 'CHARGE'") || norm.startsWith("SELECT * FROM payment_transactions WHERE order_id = $1 AND tx_type = 'CHARGE'")) {
      const rows = this.txs.filter((t) => t.order_id === params[0] && t.tx_type === 'CHARGE');
      return { rows: rows as unknown as T[], rowCount: rows.length };
    }
    if (norm.startsWith("SELECT * FROM payment_transactions WHERE order_code = $1 AND tx_type = 'CHARGE'")) {
      const rows = this.txs.filter((t) => t.order_code === params[0] && t.tx_type === 'CHARGE');
      return { rows: rows as unknown as T[], rowCount: rows.length };
    }
    if (norm.startsWith("SELECT * FROM payment_transactions WHERE order_id = $1 ORDER BY")) {
      const rows = this.txs.filter((t) => t.order_id === params[0]);
      return { rows: rows as unknown as T[], rowCount: rows.length };
    }
    if (norm.startsWith("SELECT * FROM payment_transactions WHERE order_code = $1 ORDER BY")) {
      const rows = this.txs.filter((t) => t.order_code === params[0]);
      return { rows: rows as unknown as T[], rowCount: rows.length };
    }
    if (norm.startsWith("SELECT COALESCE(SUM(amount_vnd), 0) AS refunded_total FROM payment_transactions")) {
      const refunded_total = this.txs
        .filter((t) => t.order_id === params[0] && t.tx_type === 'REFUND' && t.status === PaymentTransactionStatus.SUCCEEDED)
        .reduce((s, t) => s + t.amount_vnd, 0);
      return { rows: [{ refunded_total }] as unknown as T[], rowCount: 1 };
    }
    if (norm.startsWith("SELECT * FROM payment_transactions WHERE order_id = ANY($1::uuid[]) AND tx_type = 'REFUND'")) {
      const ids = params[0] as string[];
      const rows = this.txs.filter((t) => ids.includes(t.order_id) && t.tx_type === 'REFUND');
      return { rows: rows as unknown as T[], rowCount: rows.length };
    }
    if (norm.startsWith('SELECT COUNT(*)::int AS total FROM payment_transactions')) {
      const charges = this.txs.filter((t) => t.tx_type === 'CHARGE');
      return { rows: [{ total: charges.length }] as unknown as T[], rowCount: 1 };
    }
    if (norm.includes('AS total_charged_vnd')) {
      return {
        rows: [
          {
            total_count: this.txs.filter((t) => t.tx_type === 'CHARGE').length,
            total_charged_vnd: this.txs.filter((t) => t.tx_type === 'CHARGE').reduce((s, t) => s + t.amount_vnd, 0),
            total_refunded_vnd: this.txs.filter((t) => t.tx_type === 'REFUND' && t.status === PaymentTransactionStatus.SUCCEEDED).reduce((s, t) => s + t.amount_vnd, 0),
          },
        ] as unknown as T[],
        rowCount: 1,
      };
    }
    if (norm.includes('AS total_charge_transactions')) {
      return {
        rows: [
          {
            total_charge_transactions: this.txs.filter((t) => t.tx_type === 'CHARGE').length,
            succeeded_charges: this.txs.filter((t) => t.tx_type === 'CHARGE' && t.status === PaymentTransactionStatus.SUCCEEDED).length,
            refunded_transactions: this.txs.filter((t) => t.tx_type === 'REFUND').length,
            total_paid_vnd: this.txs.filter((t) => t.tx_type === 'CHARGE').reduce((s, t) => s + t.amount_vnd, 0),
            total_refunded_vnd: this.txs.filter((t) => t.tx_type === 'REFUND').reduce((s, t) => s + t.amount_vnd, 0),
          },
        ] as unknown as T[],
        rowCount: 1,
      };
    }
    if (norm.startsWith("SELECT * FROM payment_transactions WHERE tx_type = 'CHARGE'")) {
      const rows = this.txs.filter((t) => t.tx_type === 'CHARGE');
      return { rows: rows as unknown as T[], rowCount: rows.length };
    }
    if (norm.startsWith('INSERT INTO payment_transactions')) {
      const isRefund = norm.includes("'REFUND'");
      const row: FakeTxRow = isRefund
        ? {
            id: String(params[0]),
            order_id: String(params[1]),
            order_code: String(params[2]),
            provider: params[3] as PaymentProvider,
            tx_type: 'REFUND',
            amount_vnd: Number(params[4]),
            status: norm.includes("'FAILED'") ? PaymentTransactionStatus.FAILED : PaymentTransactionStatus.SUCCEEDED,
            provider_tx_id: norm.includes("'FAILED'") ? null : String(params[5]),
            idempotency_key: norm.includes("'FAILED'") ? String(params[5]) : String(params[6]),
            qr_payload: null,
            payment_url: null,
            signature_verified: !norm.includes("'FAILED'"),
            raw_payload_jsonb: norm.includes("'FAILED'") ? String(params[6]) : String(params[7]),
            expires_at: null,
            created_at: now,
            paid_at: norm.includes("'FAILED'") ? null : String(params[8]),
          }
        : {
            id: String(params[0]),
            order_id: String(params[1]),
            order_code: String(params[2]),
            provider: params[3] as PaymentProvider,
            tx_type: 'CHARGE',
            amount_vnd: Number(params[4]),
            status: PaymentTransactionStatus.PENDING,
            provider_tx_id: (params[5] as string | null) ?? null,
            idempotency_key: String(params[6]),
            qr_payload: (params[7] as string | null) ?? null,
            payment_url: (params[8] as string | null) ?? null,
            signature_verified: false,
            raw_payload_jsonb: String(params[9]),
            expires_at: String(params[10]),
            created_at: now,
            paid_at: null,
          };
      if (this.txs.some((t) => t.idempotency_key === row.idempotency_key)) {
        return { rows: [], rowCount: 0 };
      }
      this.txs.push(row);
      return { rows: [row] as unknown as T[], rowCount: 1 };
    }
    if (norm.startsWith('UPDATE payment_transactions SET')) {
      const tx = this.txs.find((t) => t.id === params[0]);
      if (tx) {
        if (norm.includes("status = 'REFUNDED'")) tx.status = PaymentTransactionStatus.REFUNDED;
        else if (norm.includes("status = 'LATE_SUCCEEDED'")) tx.status = PaymentTransactionStatus.LATE_SUCCEEDED;
        else {
          tx.status = params[1] as PaymentTransactionStatus;
          tx.signature_verified = true;
          tx.provider_tx_id = (params[2] as string | null) ?? tx.provider_tx_id;
          tx.paid_at = (params[4] as string | null) ?? tx.paid_at;
        }
      }
      return { rows: [], rowCount: tx ? 1 : 0 };
    }

    // processed_webhooks
    if (norm.startsWith('INSERT INTO processed_webhooks')) {
      const provider = params[0] as PaymentProvider;
      const eventId = String(params[1]);
      if (this.webhooks.some((w) => w.provider === provider && w.provider_event_id === eventId)) {
        return { rows: [], rowCount: 0 };
      }
      const isInvalid = norm.includes('SIGNATURE_INVALID');
      this.webhooks.push({
        provider,
        provider_event_id: eventId,
        order_code: (params[2] as string | null) ?? null,
        signature_valid: !isInvalid,
        signature_header: (params[3] as string | null) ?? null,
        status: isInvalid ? 'SIGNATURE_INVALID' : String(params[4]),
        payload_summary: isInvalid ? String(params[4]) : String(params[5]),
        raw_payload_jsonb: isInvalid ? String(params[5]) : String(params[6]),
        received_at: now,
      });
      return { rows: [{ provider_event_id: eventId }] as unknown as T[], rowCount: 1 };
    }
    if (norm.startsWith('SELECT COUNT(*)::int AS cnt FROM processed_webhooks') || norm.startsWith('SELECT COUNT(*)::int AS total FROM processed_webhooks')) {
      return { rows: [{ cnt: this.webhooks.length, total: this.webhooks.length }] as unknown as T[], rowCount: 1 };
    }
    if (norm.startsWith('SELECT w.provider, w.provider_event_id')) {
      return { rows: [...this.webhooks] as unknown as T[], rowCount: this.webhooks.length };
    }

    // promotions
    if (norm.startsWith("SELECT COUNT(*)::int AS cnt FROM promotions WHERE status = 'ACTIVE'")) {
      return { rows: [{ cnt: this.promos.filter((p) => p.status === PromoStatus.ACTIVE).length }] as unknown as T[], rowCount: 1 };
    }
    if (norm.startsWith('SELECT * FROM promotions WHERE UPPER(code) = $1')) {
      const code = String(params[0]).toUpperCase();
      const rows = this.promos.filter((p) => p.code.toUpperCase() === code).slice(0, 1);
      return { rows: rows as unknown as T[], rowCount: rows.length };
    }
    if (norm.startsWith('SELECT * FROM promotions WHERE id = $1')) {
      const rows = this.promos.filter((p) => p.id === params[0]).slice(0, 1);
      return { rows: rows as unknown as T[], rowCount: rows.length };
    }
    if (norm.startsWith('SELECT COUNT(*)::int AS total FROM promotions')) {
      return { rows: [{ total: this.promos.length }] as unknown as T[], rowCount: 1 };
    }
    if (norm.includes('AS nhap_ai')) {
      return {
        rows: [
          {
            total: this.promos.length,
            active: this.promos.filter((p) => p.status === PromoStatus.ACTIVE).length,
            nhap_ai: this.promos.filter((p) => p.status === PromoStatus.NHAP_AI).length,
            inactive: 0,
            archived: this.promos.filter((p) => p.status === PromoStatus.ARCHIVED).length,
          },
        ] as unknown as T[],
        rowCount: 1,
      };
    }
    if (norm.startsWith('SELECT * FROM promotions')) {
      return { rows: [...this.promos] as unknown as T[], rowCount: this.promos.length };
    }
    if (norm.startsWith('INSERT INTO promotions')) {
      const isClearance = norm.includes("'CLEARANCE_ODD_SIZE'");
      const code = String(params[1]);
      if (this.promos.some((p) => p.code === code)) {
        throw new Error('duplicate key value violates unique constraint');
      }
      const row: FakePromoRow = isClearance
        ? {
            id: String(params[0]),
            code,
            name: String(params[2]),
            description: (params[3] as string | null) ?? null,
            promo_type: PromoType.CLEARANCE_ODD_SIZE,
            discount_value: Number(params[4]),
            max_discount_vnd: Number(params[5]),
            min_order_vnd: Number(params[6]),
            target_sizes_jsonb: JSON.parse(String(params[7])) as string[],
            target_product_ids_jsonb: JSON.parse(String(params[8])) as string[],
            target_sku_codes_jsonb: JSON.parse(String(params[9])) as string[],
            bonus_tryon_credits: 0,
            usage_limit: Number(params[10]),
            used_count: 0,
            per_user_limit: 5,
            status: PromoStatus.NHAP_AI,
            created_by_actor_type: 'AI_COPILOT',
            approved_by: null,
            approved_at: null,
            start_at: String(params[11]),
            end_at: String(params[12]),
            created_at: now,
            updated_at: now,
          }
        : {
            id: String(params[0]),
            code,
            name: String(params[2]),
            description: (params[3] as string | null) ?? null,
            promo_type: params[4] as PromoType,
            discount_value: Number(params[5]),
            max_discount_vnd: Number(params[6]),
            min_order_vnd: Number(params[7]),
            target_sizes_jsonb: JSON.parse(String(params[8])) as string[],
            target_product_ids_jsonb: JSON.parse(String(params[9])) as string[],
            target_sku_codes_jsonb: JSON.parse(String(params[10])) as string[],
            bonus_tryon_credits: Number(params[11]),
            usage_limit: Number(params[12]),
            used_count: 0,
            per_user_limit: Number(params[13]),
            status: params[14] as PromoStatus,
            created_by_actor_type: params[15] as 'USER' | 'AI_COPILOT' | 'SYSTEM',
            approved_by: null,
            approved_at: null,
            start_at: String(params[16]),
            end_at: String(params[17]),
            created_at: now,
            updated_at: now,
          };
      this.promos.push(row);
      return { rows: [row] as unknown as T[], rowCount: 1 };
    }
    if (norm.startsWith('UPDATE promotions SET used_count = used_count + 1')) {
      const p = this.promos.find((x) => x.id === params[0] && x.used_count < x.usage_limit);
      if (!p) return { rows: [], rowCount: 0 };
      p.used_count += 1;
      return { rows: [{ used_count: p.used_count }] as unknown as T[], rowCount: 1 };
    }
    if (norm.startsWith('UPDATE promotions SET used_count = GREATEST(0, used_count - 1)')) {
      const p = this.promos.find((x) => x.id === params[0]);
      if (p) p.used_count = Math.max(0, p.used_count - 1);
      return { rows: [], rowCount: p ? 1 : 0 };
    }
    if (norm.startsWith('UPDATE promotions SET status = $2, approved_by = $3')) {
      const p = this.promos.find((x) => x.id === params[0]);
      if (!p) return { rows: [], rowCount: 0 };
      p.status = params[1] as PromoStatus;
      p.approved_by = String(params[2]);
      p.approved_at = now;
      p.start_at = String(params[3]);
      p.end_at = String(params[4]);
      return { rows: [p] as unknown as T[], rowCount: 1 };
    }
    if (norm.startsWith('UPDATE promotions SET status = $2, updated_at = NOW()')) {
      const p = this.promos.find((x) => x.id === params[0]);
      if (!p) return { rows: [], rowCount: 0 };
      p.status = params[1] as PromoStatus;
      return { rows: [p] as unknown as T[], rowCount: 1 };
    }
    if (norm.startsWith('UPDATE promotions SET code = $2')) {
      const p = this.promos.find((x) => x.id === params[0]);
      if (!p) return { rows: [], rowCount: 0 };
      p.code = String(params[1]);
      p.name = String(params[2]);
      p.discount_value = Number(params[5]);
      p.status = params[14] as PromoStatus;
      return { rows: [p] as unknown as T[], rowCount: 1 };
    }

    // voucher_redemptions
    if (norm.startsWith('SELECT id, promotion_id, user_id, order_id, status, expires_at FROM voucher_redemptions')) {
      const rows = this.redemptions.filter(
        (r) => r.promotion_id === params[0] && r.order_id === params[1] && ['LOCKED', 'REDEEMED'].includes(r.status),
      );
      return { rows: rows as unknown as T[], rowCount: rows.length };
    }
    if (norm.startsWith('INSERT INTO voucher_redemptions')) {
      this.redemptions.push({
        id: String(params[0]),
        promotion_id: String(params[1]),
        user_id: (params[2] as string | null) ?? null,
        order_id: String(params[3]),
        status: 'LOCKED',
        expires_at: String(params[4]),
      });
      return { rows: [], rowCount: 1 };
    }
    if (norm.startsWith('SELECT r.id, r.promotion_id, p.code FROM voucher_redemptions')) {
      const rows = this.redemptions
        .filter((r) => r.order_id === params[0] && ['LOCKED', 'REDEEMED'].includes(r.status))
        .map((r) => ({ id: r.id, promotion_id: r.promotion_id, code: this.promos.find((p) => p.id === r.promotion_id)?.code ?? '' }));
      return { rows: rows as unknown as T[], rowCount: rows.length };
    }
    if (norm.startsWith("UPDATE voucher_redemptions SET status = 'RELEASED'")) {
      const r = this.redemptions.find((x) => x.id === params[0] && ['LOCKED', 'REDEEMED'].includes(x.status));
      if (!r) return { rows: [], rowCount: 0 };
      r.status = 'RELEASED';
      return { rows: [{ id: r.id }] as unknown as T[], rowCount: 1 };
    }

    return { rows: [], rowCount: 0 };
  }

  async transaction<T>(fn: (tx: AtelierDbExecutor) => Promise<T>): Promise<T> {
    return fn({ query: this.query.bind(this) } as unknown as AtelierDbExecutor);
  }
}

describe('PaymentsService — Intents, Webhooks/IPNs & netRefundableVnd REFUND_EXCEEDS_BALANCE Guard', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function createPaymentsHarness() {
    const config = createPaymentConfig();
    const db = new InMemoryPaymentPromoDb();
    const publisher = {
      publishPaymentSucceeded: vi.fn(async () => undefined),
      publishPaymentLateDetected: vi.fn(async () => undefined),
    } as unknown as PaymentEventPublisherService;

    const service = new PaymentsService(
      config,
      db as unknown as PaymentDbService,
      publisher,
      new PayOsAdapter(config),
      new VnpayAdapter(config),
      new MomoAdapter(config),
    );
    return { service, db, config, publisher };
  }

  it('enforces netRefundableVnd guard (REFUND_EXCEEDS_BALANCE) across partial, excessive, and final full refunds', async () => {
    const { service, db } = createPaymentsHarness();

    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
        new Response(JSON.stringify({ data: { status: 'CONFIRMED' } }), { status: 200 }),
    );

    // 1. Create VietQR intent (1,000,000 VND) and settle via devSimulateWebhook
    const intent = await service.createPaymentIntent(
      { orderId: ORDER_ID_1, orderCode: 'TX-REF-01', provider: PaymentProvider.VIETQR, amountVnd: 1_000_000 },
      'idem-intent-1',
    );
    expect(intent.qrStandard).toBe(VIETQR_STANDARD);
    expect(verifyVietQrEmvCoCrc16(intent.qrPayload!)).toBe(true);

    // Idempotent replay of intent
    const intentReplay = await service.createPaymentIntent(
      { orderId: ORDER_ID_1, orderCode: 'TX-REF-01', provider: PaymentProvider.VIETQR, amountVnd: 1_000_000 },
      'idem-intent-1',
    );
    expect(intentReplay.transactionId).toBe(intent.transactionId);

    const settled = await service.devSimulateWebhook({ orderCode: 'TX-REF-01' }, 'corr-sim');
    expect(settled.processed).toBe(true);
    expect(settled.status).toBe(PaymentTransactionStatus.SUCCEEDED);

    // 2. Partial refund 400,000 -> netRefundableVnd drops from 1,000,000 to 600,000
    const ref1 = await service.createRefund(
      { orderId: ORDER_ID_1, amountVnd: 400_000, reason: 'RMA partial 1', idempotencyKey: 'ref-key-1' },
      null,
    );
    expect(ref1.refundedAmountVnd).toBe(400_000);
    expect(ref1.netRefundableVnd).toBe(600_000);
    expect(ref1.after.status).toBe(PaymentTransactionStatus.SUCCEEDED);

    // Idempotent replay by key
    const ref1Replay = await service.createRefund(
      { orderId: ORDER_ID_1, amountVnd: 400_000, reason: 'RMA partial 1', idempotencyKey: 'ref-key-1' },
      null,
    );
    expect(ref1Replay.idempotentReplay).toBe(true);

    // 3. Refund exceeding remaining balance (650,000 > 600,000) MUST reject with REFUND_EXCEEDS_BALANCE!
    await expect(
      service.createRefund({ orderId: ORDER_ID_1, amountVnd: 650_000, reason: 'Over-refund attempt' }, null),
    ).rejects.toMatchObject({ errorCode: ErrorCode.REFUND_EXCEEDS_BALANCE });

    // 4. Final refund of exact remaining 600,000 -> netRefundableVnd = 0 & original charge status = REFUNDED
    const ref2 = await service.createRefund(
      { orderId: ORDER_ID_1, amountVnd: 600_000, reason: 'RMA remaining balance' },
      null,
    );
    expect(ref2.netRefundableVnd).toBe(0);
    expect(ref2.after.status).toBe(PaymentTransactionStatus.REFUNDED);
    expect(db.txs.find((t) => t.id === intent.transactionId)?.status).toBe(PaymentTransactionStatus.REFUNDED);

    // 5. Any further refund (even 1 VND) MUST reject with REFUND_EXCEEDS_BALANCE
    await expect(
      service.createRefund({ orderId: ORDER_ID_1, amountVnd: 1, reason: 'Zero balance' }, null),
    ).rejects.toMatchObject({ errorCode: ErrorCode.REFUND_EXCEEDS_BALANCE });
  });

  it('handles VNPay IPN, MoMo IPN, PayOS webhook, Return URL verification, and admin transaction/webhook queries', async () => {
    const { service, config } = createPaymentsHarness();
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
        new Response(JSON.stringify({ data: { status: 'CONFIRMED' } }), { status: 200 }),
    );

    // VNPay intent + IPN (invalid checksum 97 -> wrong amount 04 -> valid 00 -> duplicate 02)
    await service.createPaymentIntent(
      { orderId: ORDER_ID_2, orderCode: 'TX-VNP-IPN', provider: PaymentProvider.VNPAY, amountVnd: 500_000 },
      null,
    );
    expect(await service.handleVnpayIpn({ vnp_TxnRef: 'TX-VNP-IPN', vnp_SecureHash: 'bad' }, 'c1')).toEqual({
      RspCode: '97',
      Message: 'Invalid Checksum',
    });

    const vnpBase = {
      vnp_Amount: '50000000',
      vnp_ResponseCode: '00',
      vnp_TransactionStatus: '00',
      vnp_TransactionNo: '14000001',
      vnp_TxnRef: 'TX-VNP-IPN',
      vnp_PayDate: '20261125101500',
    };
    const vnpHash = computeVnpayHmacSha512(buildVnpaySignData(vnpBase), config.vnpay.hashSecret);
    expect(await service.handleVnpayIpn({ ...vnpBase, vnp_SecureHash: vnpHash }, 'c2')).toEqual({
      RspCode: '00',
      Message: 'Confirm Success',
    });
    expect(await service.handleVnpayIpn({ ...vnpBase, vnp_SecureHash: vnpHash }, 'c3')).toEqual({
      RspCode: '02',
      Message: 'Order already confirmed',
    });

    // Return URL verification (VNPay valid, missing params)
    const vnpReturn = await service.handlePaymentReturn({ ...vnpBase, vnp_SecureHash: vnpHash }, 'c4');
    expect(vnpReturn.verified).toBe(true);
    expect(vnpReturn.paid).toBe(true);
    expect((await service.handlePaymentReturn({}, 'c5')).status).toBe('INVALID_REQUEST');

    // MoMo intent + IPN
    await service.createPaymentIntent(
      { orderId: ORDER_ID_3, orderCode: 'TX-MOMO-IPN', provider: PaymentProvider.MOMO, amountVnd: 750_000 },
      null,
    );
    const momoPayload: Record<string, unknown> = {
      partnerCode: config.momo.partnerCode,
      orderId: 'TX-MOMO-IPN',
      requestId: 'req-momo-1',
      amount: 750_000,
      orderInfo: 'Atelier',
      orderType: 'momo_wallet',
      transId: '777888',
      resultCode: 0,
      message: 'Success',
      payType: 'qr',
      responseTime: 1764000000000,
      extraData: '',
    };
    momoPayload.signature = signMomoIpnPayload(momoPayload, config.momo.secretKey, config.momo.accessKey);
    const momoRes = await service.handleMomoIpn(momoPayload, 'c6');
    expect(momoRes.resultCode).toBe(0);
    expect(momoRes.processed).toBe(true);

    // PayOS webhook valid & invalid
    await service.createPaymentIntent(
      { orderId: ORDER_ID_4, orderCode: 'TX-PAYOS-WH', provider: PaymentProvider.VIETQR, amountVnd: 880_000 },
      null,
    );
    const payosData = {
      orderCode: 'TX-PAYOS-WH',
      amount: 880_000,
      description: 'TAMXUAN TX-PAYOS-WH',
      reference: 'FT-PAYOS-99',
      code: '00',
    };
    const payosSig = signPayOsWebhookData(payosData, config.payos.checksumKey);
    const payosRes = await service.handlePayOsWebhook({ code: '00', success: true, data: payosData, signature: payosSig }, 'c7');
    expect(payosRes.processed).toBe(true);

    await expect(
      service.handlePayOsWebhook({ code: '00', data: payosData, signature: '0'.repeat(64) }, 'c8'),
    ).rejects.toMatchObject({ errorCode: ErrorCode.PAYMENT_SIGNATURE_INVALID });

    // Admin listings & metrics
    const adminTxs = await service.listAdminTransactions({ page: 1, limit: 20 });
    expect(adminTxs.items).toHaveLength(3);
    expect((await service.listWebhookLogs({ page: 1, limit: 20 })).items.length).toBeGreaterThanOrEqual(3);
    expect((await service.getTransactionsByOrderCode('TX-VNP-IPN')).length).toBe(1);
    expect((await service.getOpsMetrics()).totalChargeTransactions).toBe(3);

    // MoMo & PayOS Return URL verification
    const momoRetOk = await service.handlePaymentReturn(momoPayload, 'c9');
    expect(momoRetOk.verified).toBe(true);
    expect(momoRetOk.paid).toBe(true);
    const momoRetBad = await service.handlePaymentReturn({ ...momoPayload, signature: '0'.repeat(64) }, 'c10');
    expect(momoRetBad.status).toBe('SIGNATURE_INVALID');

    const payosRet = await service.handlePaymentReturn({ orderCode: 'TX-PAYOS-WH', status: 'PAID' }, 'c11');
    expect(payosRet.orderCode).toBe('TX-PAYOS-WH');
    expect(payosRet.paid).toBe(true);
  });

  it('verifies generic processPaymentWebhook HMAC/amount guards, late-payment detection, and production dev-simulate lock', async () => {
    const { service, config, publisher } = createPaymentsHarness();

    await service.createPaymentIntent(
      { orderId: ORDER_ID_1, orderCode: 'TX-GEN-WH', provider: PaymentProvider.VIETQR, amountVnd: 950_000 },
      null,
    );

    const payload = {
      eventId: 'evt-gen-1',
      orderCode: 'TX-GEN-WH',
      amountVnd: 950_000,
      status: 'SUCCEEDED',
    };
    const raw = JSON.stringify(payload);
    const validSig = computeHmacSha256Hex(raw, config.webhookSecrets.VIETQR);

    // Unsupported provider rejected
    await expect(
      service.processPaymentWebhook('unknown_gw', raw, validSig, payload, 'c-bad-gw'),
    ).rejects.toMatchObject({ errorCode: ErrorCode.VALIDATION_ERROR });

    // Invalid HMAC rejected with PAYMENT_SIGNATURE_INVALID
    await expect(
      service.processPaymentWebhook('vietqr', raw, '0'.repeat(64), payload, 'c-bad-sig'),
    ).rejects.toMatchObject({ errorCode: ErrorCode.PAYMENT_SIGNATURE_INVALID });

    // Amount mismatch rejected with PAYMENT_AMOUNT_MISMATCH
    const badAmt = { ...payload, amountVnd: 100_000 };
    const badAmtRaw = JSON.stringify(badAmt);
    const badAmtSig = computeHmacSha256Hex(badAmtRaw, config.webhookSecrets.VIETQR);
    await expect(
      service.processPaymentWebhook('vietqr', badAmtRaw, badAmtSig, badAmt, 'c-bad-amt'),
    ).rejects.toMatchObject({ errorCode: ErrorCode.PAYMENT_AMOUNT_MISMATCH });

    // Late payment: order-rma responds LATE_PAYMENT_NEEDS_REFUND -> marks LATE_SUCCEEDED & emits late event
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
        new Response(
          JSON.stringify({ data: { status: 'LATE_PAYMENT_NEEDS_REFUND', latePayment: true } }),
          { status: 200 },
        ),
    );
    const lateRes = await service.processPaymentWebhook('vietqr', raw, validSig, payload, 'c-late');
    expect(lateRes.processed).toBe(true);
    expect(lateRes.status).toBe(PaymentTransactionStatus.LATE_SUCCEEDED);
    expect(publisher.publishPaymentLateDetected).toHaveBeenCalledTimes(1);

    // Production guard on devSimulateWebhook
    const prodConfig = createPaymentConfig({ nodeEnv: 'production' });
    const prodService = new PaymentsService(
      prodConfig,
      new InMemoryPaymentPromoDb() as unknown as PaymentDbService,
      publisher,
      new PayOsAdapter(prodConfig),
      new VnpayAdapter(prodConfig),
      new MomoAdapter(prodConfig),
    );
    await expect(
      prodService.devSimulateWebhook({ orderCode: 'TX-GEN-WH' }, 'c-prod'),
    ).rejects.toMatchObject({ errorCode: ErrorCode.FORBIDDEN });
  });
});

describe('PromotionsService — PERCENTAGE, FIXED_AMOUNT, FREESHIP, minOrderVnd & Lock/Release', () => {
  function createPromosHarness() {
    const db = new InMemoryPaymentPromoDb();
    const redis = {
      clearPromotionCaches: vi.fn(async () => undefined),
      tryAcquireFlashCounter: vi.fn(async (_code: string, limit: number, used: number) => ({
        allowed: used < limit,
        available: true,
      })),
      releaseFlashCounter: vi.fn(async () => undefined),
    } as unknown as PaymentRedisService;
    const service = new PromotionsService(db as unknown as PaymentDbService, redis);
    return { service, db, redis };
  }

  it('computes PERCENTAGE, FIXED_AMOUNT, FREESHIP discounts, enforces minOrderVnd, and preserves exact proportional sum', async () => {
    const { service } = createPromosHarness();

    await service.createPromotion({
      code: 'SALE20',
      name: 'Giảm 20% tối đa 300K',
      discountType: 'PERCENTAGE',
      discountValue: 20,
      maxDiscountVnd: 300_000,
      minOrderVnd: 1_000_000,
      usageLimit: 100,
    });
    await service.createPromotion({
      code: 'FLAT150K',
      name: 'Giảm thẳng 150K',
      discountType: 'FIXED_AMOUNT',
      discountValue: 150_000,
      minOrderVnd: 500_000,
      usageLimit: 50,
    });
    await service.createPromotion({
      code: 'FREESHIPVN',
      name: 'Miễn phí giao hàng',
      discountType: 'FREESHIP',
      minOrderVnd: 300_000,
      usageLimit: 100,
    });

    // 1. minOrderVnd rejection (subtotal 800k < 1M)
    const belowMin = await service.evaluatePromotion({
      voucherCode: 'SALE20',
      items: [{ skuId: 'sku-1', unitPriceVnd: 800_000, qty: 1 }],
      shippingMethod: 'GHN',
    });
    expect(belowMin.valid).toBe(false);
    expect(belowMin.voucherDiscountVnd).toBe(0);
    expect(belowMin.reason).toContain('tối thiểu');

    // 2. PERCENTAGE capped by maxDiscountVnd (20% of 2,000,000 = 400k -> capped at 300k)
    const pctRes = await service.evaluatePromotion({
      voucherCode: 'SALE20',
      items: [
        { skuId: 'sku-1', unitPriceVnd: 1_333_333, qty: 1, slot: 'TOP' },
        { skuId: 'sku-2', unitPriceVnd: 666_667, qty: 1, slot: 'BOTTOM' },
      ],
      shippingMethod: 'GHN',
    });
    expect(pctRes.valid).toBe(true);
    expect(pctRes.comboDiscountPct).toBe(5); // 2 distinct slots -> 5% = 100,000
    expect(pctRes.comboDiscountVnd).toBe(100_000);
    expect(pctRes.voucherDiscountVnd).toBe(300_000);
    expect(pctRes.allocatedItems.reduce((s, i) => s + i.allocatedDiscountVnd, 0)).toBe(400_000);

    // 3. FIXED_AMOUNT discount
    const fixedRes = await service.evaluatePromotion({
      voucherCode: 'FLAT150K',
      items: [{ skuId: 'sku-1', unitPriceVnd: 900_000, qty: 1 }],
      shippingMethod: 'GHN',
    });
    expect(fixedRes.valid).toBe(true);
    expect(fixedRes.voucherDiscountVnd).toBe(150_000);
    expect(fixedRes.shippingFeeVnd).toBe(35_000);

    // 4. FREESHIP discount zeroes shipping fee
    const freeshipRes = await service.evaluatePromotion({
      voucherCode: 'FREESHIPVN',
      items: [{ skuId: 'sku-1', unitPriceVnd: 600_000, qty: 1 }],
      shippingMethod: 'AHAMOVE_2H',
    });
    expect(freeshipRes.valid).toBe(true);
    expect(freeshipRes.shippingDiscountVnd).toBe(55_000);
    expect(freeshipRes.shippingFeeVnd).toBe(0);
    expect(freeshipRes.voucherDiscountVnd).toBe(0);

    // 5. Lock, idempotent replay & Release promotion
    const locked = await service.lockPromotion({ voucherCode: 'FLAT150K', orderId: ORDER_ID_1 });
    expect(locked.status).toBe('LOCKED');
    expect(locked.idempotentReplay).toBe(false);

    const lockedReplay = await service.lockPromotion({ voucherCode: 'FLAT150K', orderId: ORDER_ID_1 });
    expect(lockedReplay.idempotentReplay).toBe(true);

    const released = await service.releasePromotion({ voucherCode: 'FLAT150K', orderId: ORDER_ID_1 });
    expect(released.releasedCount).toBe(1);

    // 6. AI Clearance Draft strictly locked to NHAP_AI -> Human approve -> Update -> Archive
    const draft = await service.createAiClearanceDraft({
      code: 'ODD25',
      name: 'Xả lẻ size XS/XL',
      discountPercent: 25,
      targetSizes: ['XS', 'XL'],
      maxUses: 30,
    });
    expect(draft.status).toBe(PromoStatus.NHAP_AI);
    expect(draft.createdByActorType).toBe('AI_COPILOT');

    // Inactive/NHAP_AI voucher cannot be applied at checkout
    const draftEval = await service.evaluatePromotion({
      voucherCode: 'ODD25',
      items: [{ skuId: 's1', unitPriceVnd: 1_000_000, qty: 1, sizeCode: 'XS' }],
    });
    expect(draftEval.valid).toBe(false);

    // Approve draft -> ACTIVE -> targetSizes check works
    const approved = await service.approveDraftPromotion(draft.id, { approvedBy: 'admin@atelier.vn' });
    expect(approved.after.status).toBe(PromoStatus.ACTIVE);

    const sizeMismatch = await service.evaluatePromotion({
      voucherCode: 'ODD25',
      items: [{ skuId: 's1', unitPriceVnd: 1_000_000, qty: 1, sizeCode: 'M' }],
    });
    expect(sizeMismatch.valid).toBe(false);

    const sizeMatch = await service.evaluatePromotion({
      voucherCode: 'ODD25',
      items: [{ skuId: 's1', unitPriceVnd: 1_000_000, qty: 1, sizeCode: 'XS' }],
    });
    expect(sizeMatch.valid).toBe(true);
    expect(sizeMatch.voucherDiscountVnd).toBe(250_000);

    const updated = await service.updatePromotion(draft.id, { discountPercent: 30 });
    expect(updated.after.discountValue).toBe(30);

    const archived = await service.archivePromotion(draft.id);
    expect(archived.after.status).toBe(PromoStatus.ARCHIVED);

    expect((await service.listAdminPromotions({ page: 1, limit: 20 })).items.length).toBe(4);
    expect((await service.listPromotions()).length).toBe(4);
    expect((await service.listActivePromotions()).length).toBeGreaterThanOrEqual(3);
    expect((await service.getPromotionById('SALE20')).code).toBe('SALE20');
  });
});
