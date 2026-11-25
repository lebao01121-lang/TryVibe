import * as crypto from 'node:crypto';
import { OrderStatus, RmaStatus, ShipmentStatus, ShippingMethod } from '@atelier/contracts';
import { createLogger, type HeaderBag } from '@atelier/observability';
import { SERVICE_NAME, type OrderRmaConfig } from '../config/env';
import type {
  CreateShipmentRequest,
  CreateShipmentResult,
  IShippingProviderAdapter,
  ParsedShippingWebhook,
  ShippingQuoteRequest,
  ShippingQuoteResult,
} from './shipping-provider.interface';
import {
  addHoursIso,
  buildDeterministicEventId,
  fetchCarrierJsonWithRetry,
  resolveGhnDistrictId,
  resolveVnLocation,
  verifyCarrierWebhookSignature,
} from './vn-location.helper';

export class GhnAdapter implements IShippingProviderAdapter {
  readonly slug = 'ghn' as const;
  readonly shippingMethod = ShippingMethod.GHN;
  private readonly logger = createLogger(`${SERVICE_NAME}:shipping:ghn`);

  constructor(private readonly config: OrderRmaConfig) {}

  isLiveConfigured(): boolean {
    return Boolean(this.config.shipping.ghn.token && this.config.shipping.ghn.shopId);
  }

  private computeLocalQuote(request: ShippingQuoteRequest): ShippingQuoteResult {
    const location = resolveVnLocation(request);
    const weightGrams = Math.max(100, Math.round(request.weightGrams ?? 500));
    const orderValueVnd = Math.max(0, Math.round(request.orderValueVnd ?? 0));
    const codAmountVnd = Math.max(0, Math.round(request.codAmountVnd ?? 0));

    let baseFeeVnd = 22_000;
    let estimatedDeliveryHours = 24;
    if (location.zone === 'INTRA_CITY') {
      baseFeeVnd = location.isInnerDistrict ? 22_000 : 25_000;
      estimatedDeliveryHours = 24;
    } else if (location.zone === 'INTRA_REGION') {
      baseFeeVnd = 28_000;
      estimatedDeliveryHours = 36;
    } else if (location.region === 'CENTRAL') {
      baseFeeVnd = 34_000;
      estimatedDeliveryHours = 48;
    } else {
      baseFeeVnd = 38_000;
      estimatedDeliveryHours = 72;
    }

    const extraWeightUnits = Math.max(0, Math.ceil((weightGrams - 500) / 500));
    const weightSurchargeVnd = extraWeightUnits * 5_000;
    const insuranceFeeVnd =
      orderValueVnd > 3_000_000 ? Math.min(45_000, Math.round(orderValueVnd * 0.005)) : 0;
    const codFeeVnd = codAmountVnd > 2_000_000 ? 5_000 : 0;
    const remoteAreaFeeVnd = location.zone === 'INTER_REGION' && !location.isInnerDistrict ? 4_000 : 0;

    const feeVnd =
      baseFeeVnd + weightSurchargeVnd + insuranceFeeVnd + codFeeVnd + remoteAreaFeeVnd;

    return {
      provider: this.slug,
      shippingMethod: this.shippingMethod,
      feeVnd,
      estimatedDeliveryHours,
      estimatedDeliveryDate: addHoursIso(estimatedDeliveryHours),
      serviceName: 'Giao Hàng Nhanh (GHN Chuẩn Thương mại Điện tử)',
      mode: 'SANDBOX_LOCAL',
      available: true,
      breakdown: {
        baseFeeVnd,
        weightSurchargeVnd,
        insuranceFeeVnd,
        codFeeVnd,
        remoteAreaFeeVnd,
        zone: location.zone,
        weightGrams,
        provinceCode: location.provinceCode,
        districtCode: location.districtCode,
        wardCode: location.wardCode,
      },
    };
  }

  async quote(request: ShippingQuoteRequest): Promise<ShippingQuoteResult> {
    const fallback = this.computeLocalQuote(request);
    if (!this.isLiveConfigured()) {
      return fallback;
    }

    const location = resolveVnLocation(request);
    const ghn = this.config.shipping.ghn;
    const toDistrictId = resolveGhnDistrictId(location);
    const toWardCode = location.wardCode || '20308';
    const weightGrams = Math.max(100, Math.round(request.weightGrams ?? 500));
    const orderValueVnd = Math.max(0, Math.round(request.orderValueVnd ?? 0));

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Token: ghn.token!,
      ShopId: ghn.shopId!,
    };

    try {
      const [feeRes, leadRes] = await Promise.all([
        fetchCarrierJsonWithRetry(
          `${ghn.apiUrl}/v2/shipping-order/fee`,
          {
            method: 'POST',
            headers,
            body: JSON.stringify({
              service_type_id: 2,
              from_district_id: ghn.fromDistrictId,
              from_ward_code: ghn.fromWardCode,
              to_district_id: toDistrictId,
              to_ward_code: toWardCode,
              weight: weightGrams,
              insurance_value: Math.min(5_000_000, orderValueVnd),
              cod_failed_amount: 0,
            }),
          },
          { timeoutMs: 8_000, maxRetries: 1 },
        ),
        fetchCarrierJsonWithRetry(
          `${ghn.apiUrl}/v2/shipping-order/leadtime`,
          {
            method: 'POST',
            headers,
            body: JSON.stringify({
              from_district_id: ghn.fromDistrictId,
              from_ward_code: ghn.fromWardCode,
              to_district_id: toDistrictId,
              to_ward_code: toWardCode,
              service_id: 53320,
            }),
          },
          { timeoutMs: 8_000, maxRetries: 1 },
        ).catch(() => null),
      ]);

      const feeData = feeRes.json?.data as Record<string, unknown> | undefined;
      if (!feeRes.ok || Number(feeRes.json?.code ?? 200) !== 200 || !feeData) {
        this.logger.warn(
          { status: feeRes.status, body: feeRes.rawText.slice(0, 300) },
          'GHN live fee API returned non-success; falling back to local zone estimate',
        );
        return fallback;
      }

      const totalFee = Math.max(0, Math.round(Number(feeData.total ?? feeData.service_fee ?? fallback.feeVnd)));
      const serviceFee = Math.max(0, Math.round(Number(feeData.service_fee ?? totalFee)));
      const insuranceFee = Math.max(0, Math.round(Number(feeData.insurance_fee ?? 0)));
      const codFee = Math.max(0, Math.round(Number(feeData.cod_fee ?? 0)));

      let estimatedDeliveryDate = fallback.estimatedDeliveryDate;
      let estimatedDeliveryHours = fallback.estimatedDeliveryHours;
      const leadData = leadRes?.json?.data as Record<string, unknown> | undefined;
      const leadEpochSec = Number(leadData?.leadtime ?? 0);
      if (Number.isFinite(leadEpochSec) && leadEpochSec > 0) {
        const etaMs = leadEpochSec > 1e12 ? leadEpochSec : leadEpochSec * 1000;
        estimatedDeliveryDate = new Date(etaMs).toISOString();
        estimatedDeliveryHours = Math.max(1, Math.round((etaMs - Date.now()) / 3_600_000));
      }

      return {
        ...fallback,
        feeVnd: totalFee,
        estimatedDeliveryHours,
        estimatedDeliveryDate,
        mode: 'LIVE',
        breakdown: {
          ...fallback.breakdown,
          baseFeeVnd: serviceFee,
          weightSurchargeVnd: 0,
          insuranceFeeVnd: insuranceFee,
          codFeeVnd: codFee,
          remoteAreaFeeVnd: Math.max(0, totalFee - serviceFee - insuranceFee - codFee),
        },
      };
    } catch (error: unknown) {
      this.logger.warn(
        { err: error instanceof Error ? error.message : String(error) },
        'GHN live quote failed after retry; falling back to local zone quote',
      );
      return fallback;
    }
  }

  private generateLocalTrackingCode(orderCode: string): string {
    const dateTag = new Date().toISOString().slice(2, 10).replace(/-/g, '');
    const cleanOrder = orderCode
      .replace(/^TX-/, '')
      .replace(/[^A-Z0-9]/gi, '')
      .toUpperCase()
      .slice(-6);
    const suffix = crypto.randomBytes(2).toString('hex').toUpperCase();
    return `GHN${dateTag}${cleanOrder}${suffix}`;
  }

  async createShipment(request: CreateShipmentRequest): Promise<CreateShipmentResult> {
    const quoteRes = await this.quote({
      provinceCode: request.provinceCode,
      districtCode: request.districtCode,
      wardCode: request.wardCode,
      provinceName: request.provinceName,
      districtName: request.districtName,
      wardName: request.wardName,
      streetLine: request.streetLine,
      shippingMethod: this.shippingMethod,
      weightGrams: request.weightGrams,
      orderValueVnd: request.orderValueVnd,
      codAmountVnd: request.codAmountVnd,
    });

    if (!this.isLiveConfigured()) {
      const trackingCode = this.generateLocalTrackingCode(request.orderCode);
      return {
        provider: this.slug,
        trackingCode,
        actualFeeVnd: quoteRes.feeVnd,
        expectedDeliveryTime: quoteRes.estimatedDeliveryDate,
        mode: 'SANDBOX_LOCAL',
        rawProviderResponse: {
          sandbox: true,
          carrier: 'GHN',
          order_code: trackingCode,
          total_fee: quoteRes.feeVnd,
          expected_delivery_time: quoteRes.estimatedDeliveryDate,
          zone: quoteRes.breakdown.zone,
        },
      };
    }

    const location = resolveVnLocation(request);
    const ghn = this.config.shipping.ghn;
    const toDistrictId = resolveGhnDistrictId(location);
    const toWardCode = location.wardCode || '20308';

    const payload = {
      payment_type_id: request.codAmountVnd > 0 ? 2 : 1,
      note: request.note || `Đơn hàng TryVibe Atelier ${request.orderCode}`,
      required_note: 'CHOXEMHANGKHONGTHU',
      from_name: this.config.shipping.originName,
      from_phone: this.config.shipping.originPhone,
      from_address: this.config.shipping.originAddress,
      from_ward_name: this.config.shipping.originWardName,
      from_district_name: this.config.shipping.originDistrictName,
      from_province_name: this.config.shipping.originProvinceName,
      client_order_code: request.orderCode,
      to_name: request.recipientName,
      to_phone: request.recipientPhone,
      to_address: request.streetLine,
      to_ward_code: toWardCode,
      to_ward_name: location.wardName,
      to_district_id: toDistrictId,
      to_district_name: location.districtName,
      to_province_name: location.provinceName,
      cod_amount: Math.max(0, Math.round(request.codAmountVnd)),
      content: `Trang phục TryVibe Atelier (${request.orderCode})`,
      weight: Math.max(100, Math.round(request.weightGrams)),
      length: 35,
      width: 25,
      height: 12,
      insurance_value: Math.min(5_000_000, Math.max(0, Math.round(request.orderValueVnd))),
      service_type_id: 2,
      items: request.items.map((item) => ({
        name: item.name,
        code: item.skuCode,
        quantity: item.qty,
        price: item.priceVnd,
        weight: item.weightGrams ?? 350,
      })),
    };

    try {
      const res = await fetchCarrierJsonWithRetry(
        `${ghn.apiUrl}/v2/shipping-order/create`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Token: ghn.token!,
            ShopId: ghn.shopId!,
          },
          body: JSON.stringify(payload),
        },
        { timeoutMs: 8_000, maxRetries: 1 },
      );

      const data = res.json?.data as Record<string, unknown> | undefined;
      if (res.ok && Number(res.json?.code ?? 200) === 200 && data && typeof data.order_code === 'string') {
        const actualFeeVnd = Math.max(
          0,
          Math.round(Number(data.total_fee ?? quoteRes.feeVnd)),
        );
        const expectedDeliveryTime =
          typeof data.expected_delivery_time === 'string' && data.expected_delivery_time.trim()
            ? new Date(data.expected_delivery_time).toISOString()
            : quoteRes.estimatedDeliveryDate;

        return {
          provider: this.slug,
          trackingCode: data.order_code,
          actualFeeVnd,
          expectedDeliveryTime,
          mode: 'LIVE',
          rawProviderResponse: res.json ?? {},
        };
      }

      this.logger.warn(
        { status: res.status, orderCode: request.orderCode, body: res.rawText.slice(0, 300) },
        'GHN live createShipment returned non-success; falling back to SANDBOX_LOCAL tracking',
      );
    } catch (error: unknown) {
      this.logger.warn(
        { err: error instanceof Error ? error.message : String(error), orderCode: request.orderCode },
        'GHN live createShipment failed after retry; falling back to SANDBOX_LOCAL tracking',
      );
    }

    const trackingCode = this.generateLocalTrackingCode(request.orderCode);
    return {
      provider: this.slug,
      trackingCode,
      actualFeeVnd: quoteRes.feeVnd,
      expectedDeliveryTime: quoteRes.estimatedDeliveryDate,
      mode: 'SANDBOX_LOCAL',
      rawProviderResponse: {
        sandbox: true,
        fallbackFromLiveError: true,
        carrier: 'GHN',
        order_code: trackingCode,
        total_fee: quoteRes.feeVnd,
      },
    };
  }

  verifyWebhook(headers: HeaderBag, rawBody: string | Buffer): boolean {
    return verifyCarrierWebhookSignature(
      headers,
      rawBody,
      ['x-ghn-signature', 'x-signature'],
      this.config.shipping.ghn.webhookSecret,
    );
  }

  parseWebhook(payload: Record<string, unknown>, _headers: HeaderBag): ParsedShippingWebhook {
    const trackingCode = String(
      payload.OrderCode ?? payload.order_code ?? payload.trackingCode ?? payload.tracking_code ?? '',
    ).trim() || null;
    const orderCode = String(
      payload.ClientOrderCode ?? payload.client_order_code ?? payload.orderCode ?? '',
    ).trim() || null;
    const rawStatus = String(
      payload.Status ?? payload.status ?? payload.Type ?? payload.type ?? 'unknown',
    ).trim();
    const statusLower = rawStatus.toLowerCase();
    const occurredAt =
      typeof payload.Time === 'string' && !Number.isNaN(Date.parse(payload.Time))
        ? new Date(payload.Time).toISOString()
        : typeof payload.occurredAt === 'string' && !Number.isNaN(Date.parse(payload.occurredAt))
          ? new Date(payload.occurredAt).toISOString()
          : new Date().toISOString();

    const explicitEventId = String(payload.eventId ?? payload.event_id ?? payload.ID ?? '').trim();
    const eventId =
      explicitEventId ||
      buildDeterministicEventId('ghn', [trackingCode ?? orderCode, statusLower, occurredAt]);

    let mappedOrderStatus: ParsedShippingWebhook['mappedOrderStatus'] = null;
    let mappedShipmentStatus: ShipmentStatus | null = null;
    let mappedRmaStatus: RmaStatus | null = null;

    if (
      [
        'ready_to_pick',
        'picking',
        'picked',
        'storing',
        'transporting',
        'sorting',
        'delivering',
        'money_collect_picking',
        'money_collect_delivering',
        'in_transit',
      ].includes(statusLower)
    ) {
      mappedOrderStatus = OrderStatus.SHIPPED;
      mappedShipmentStatus =
        statusLower === 'picked' ? ShipmentStatus.PICKED : ShipmentStatus.IN_TRANSIT;
      mappedRmaStatus = RmaStatus.RETURN_IN_TRANSIT;
    } else if (statusLower === 'delivered') {
      mappedOrderStatus = OrderStatus.DELIVERED;
      mappedShipmentStatus = ShipmentStatus.DELIVERED;
      mappedRmaStatus = RmaStatus.QC_INSPECTING;
    } else if (
      [
        'delivery_fail',
        'waiting_to_return',
        'return',
        'return_transporting',
        'return_sorting',
        'returning',
        'return_fail',
        'returned',
        'exception',
        'damage',
        'lost',
        'cancel',
      ].includes(statusLower)
    ) {
      mappedOrderStatus = 'DELIVERY_FAILED';
      mappedShipmentStatus = ShipmentStatus.DELIVERY_FAILED;
      mappedRmaStatus = null;
    }

    const note = String(
      payload.Description ?? payload.Reason ?? payload.note ?? `GHN status update: ${rawStatus}`,
    ).trim();

    return {
      eventId,
      provider: this.slug,
      trackingCode,
      orderCode,
      providerStatus: rawStatus,
      mappedOrderStatus,
      mappedShipmentStatus,
      mappedRmaStatus,
      note,
      occurredAt,
    };
  }
}
