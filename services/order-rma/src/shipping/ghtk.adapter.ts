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
  resolveVnLocation,
  verifyCarrierWebhookSignature,
} from './vn-location.helper';

export class GhtkAdapter implements IShippingProviderAdapter {
  readonly slug = 'ghtk' as const;
  readonly shippingMethod = ShippingMethod.GHTK;
  private readonly logger = createLogger(`${SERVICE_NAME}:shipping:ghtk`);

  constructor(private readonly config: OrderRmaConfig) {}

  isLiveConfigured(): boolean {
    return Boolean(this.config.shipping.ghtk.token);
  }

  private computeLocalQuote(request: ShippingQuoteRequest): ShippingQuoteResult {
    const location = resolveVnLocation(request);
    const weightGrams = Math.max(100, Math.round(request.weightGrams ?? 500));
    const orderValueVnd = Math.max(0, Math.round(request.orderValueVnd ?? 0));
    const codAmountVnd = Math.max(0, Math.round(request.codAmountVnd ?? 0));

    let baseFeeVnd = 20_000;
    let estimatedDeliveryHours = 24;
    if (location.zone === 'INTRA_CITY') {
      baseFeeVnd = location.isInnerDistrict ? 20_000 : 23_000;
      estimatedDeliveryHours = 24;
    } else if (location.zone === 'INTRA_REGION') {
      baseFeeVnd = 25_000;
      estimatedDeliveryHours = 36;
    } else if (location.region === 'CENTRAL') {
      baseFeeVnd = 30_000;
      estimatedDeliveryHours = 54;
    } else {
      baseFeeVnd = 33_000;
      estimatedDeliveryHours = 78;
    }

    const extraWeightUnits = Math.max(0, Math.ceil((weightGrams - 500) / 500));
    const weightSurchargeVnd = extraWeightUnits * 4_000;
    const insuranceFeeVnd =
      orderValueVnd > 3_000_000 ? Math.min(40_000, Math.round(orderValueVnd * 0.005)) : 0;
    const codFeeVnd = codAmountVnd > 3_000_000 ? 4_000 : 0;
    const remoteAreaFeeVnd = location.zone === 'INTER_REGION' && !location.isInnerDistrict ? 3_000 : 0;

    const feeVnd =
      baseFeeVnd + weightSurchargeVnd + insuranceFeeVnd + codFeeVnd + remoteAreaFeeVnd;

    return {
      provider: this.slug,
      shippingMethod: this.shippingMethod,
      feeVnd,
      estimatedDeliveryHours,
      estimatedDeliveryDate: addHoursIso(estimatedDeliveryHours),
      serviceName: 'Giao Hàng Tiết Kiệm (GHTK Tiêu Chuẩn)',
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
    const ghtk = this.config.shipping.ghtk;
    const weightGrams = Math.max(100, Math.round(request.weightGrams ?? 500));
    const orderValueVnd = Math.max(0, Math.round(request.orderValueVnd ?? 0));

    const qs = new URLSearchParams({
      pick_province: this.config.shipping.originProvinceName,
      pick_district: this.config.shipping.originDistrictName,
      province: location.provinceName,
      district: location.districtName,
      weight: String(weightGrams),
      value: String(orderValueVnd),
      transport: 'road',
    });
    if (request.streetLine?.trim()) {
      qs.set('address', request.streetLine.trim());
    }

    try {
      const res = await fetchCarrierJsonWithRetry(
        `${ghtk.apiUrl}/services/shipment/fee?${qs.toString()}`,
        {
          method: 'GET',
          headers: {
            Token: ghtk.token!,
            Accept: 'application/json',
          },
        },
        { timeoutMs: 8_000, maxRetries: 1 },
      );

      const feeObj = res.json?.fee as Record<string, unknown> | undefined;
      if (!res.ok || res.json?.success === false || !feeObj) {
        this.logger.warn(
          { status: res.status, body: res.rawText.slice(0, 300) },
          'GHTK live fee API returned non-success; falling back to local zone estimate',
        );
        return fallback;
      }

      const mainFee = Math.max(0, Math.round(Number(feeObj.fee ?? fallback.feeVnd)));
      const insuranceFee = Math.max(0, Math.round(Number(feeObj.insurance_fee ?? 0)));
      const totalFee = mainFee + insuranceFee;

      return {
        ...fallback,
        feeVnd: totalFee,
        mode: 'LIVE',
        breakdown: {
          ...fallback.breakdown,
          baseFeeVnd: mainFee,
          weightSurchargeVnd: 0,
          insuranceFeeVnd: insuranceFee,
          codFeeVnd: 0,
          remoteAreaFeeVnd: 0,
        },
      };
    } catch (error: unknown) {
      this.logger.warn(
        { err: error instanceof Error ? error.message : String(error) },
        'GHTK live quote failed after retry; falling back to local zone quote',
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
    return `S1.GHTK.${dateTag}.${cleanOrder}${suffix}`;
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
          carrier: 'GHTK',
          label: trackingCode,
          fee: quoteRes.feeVnd,
          estimated_deliver_time: quoteRes.estimatedDeliveryDate,
          zone: quoteRes.breakdown.zone,
        },
      };
    }

    const location = resolveVnLocation(request);
    const ghtk = this.config.shipping.ghtk;

    const payload = {
      products: request.items.map((item) => ({
        name: item.name,
        weight: Math.max(0.1, Number(((item.weightGrams ?? 350) / 1000).toFixed(2))),
        quantity: item.qty,
        product_code: item.skuCode,
      })),
      order: {
        id: request.orderCode,
        pick_name: this.config.shipping.originName,
        pick_address: this.config.shipping.originAddress,
        pick_province: this.config.shipping.originProvinceName,
        pick_district: this.config.shipping.originDistrictName,
        pick_ward: this.config.shipping.originWardName,
        pick_tel: this.config.shipping.originPhone,
        tel: request.recipientPhone,
        name: request.recipientName,
        address: request.streetLine,
        province: location.provinceName,
        district: location.districtName,
        ward: location.wardName,
        hamlet: 'Khác',
        is_freeship: request.codAmountVnd > 0 ? '0' : '1',
        pick_money: Math.max(0, Math.round(request.codAmountVnd)),
        note: request.note || `Đơn hàng Tầm Xuân Atelier ${request.orderCode}`,
        value: Math.max(0, Math.round(request.orderValueVnd)),
        transport: 'road',
      },
    };

    try {
      const res = await fetchCarrierJsonWithRetry(
        `${ghtk.apiUrl}/services/shipment/order`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Token: ghtk.token!,
          },
          body: JSON.stringify(payload),
        },
        { timeoutMs: 8_000, maxRetries: 1 },
      );

      const orderObj = res.json?.order as Record<string, unknown> | undefined;
      if (res.ok && res.json?.success !== false && orderObj && typeof orderObj.label === 'string') {
        const actualFeeVnd = Math.max(0, Math.round(Number(orderObj.fee ?? quoteRes.feeVnd)));
        const rawEta = orderObj.estimated_deliver_time;
        const expectedDeliveryTime =
          typeof rawEta === 'string' && !Number.isNaN(Date.parse(rawEta))
            ? new Date(rawEta).toISOString()
            : quoteRes.estimatedDeliveryDate;

        return {
          provider: this.slug,
          trackingCode: orderObj.label,
          actualFeeVnd,
          expectedDeliveryTime,
          mode: 'LIVE',
          rawProviderResponse: res.json ?? {},
        };
      }

      this.logger.warn(
        { status: res.status, orderCode: request.orderCode, body: res.rawText.slice(0, 300) },
        'GHTK live createShipment returned non-success; falling back to SANDBOX_LOCAL tracking',
      );
    } catch (error: unknown) {
      this.logger.warn(
        { err: error instanceof Error ? error.message : String(error), orderCode: request.orderCode },
        'GHTK live createShipment failed after retry; falling back to SANDBOX_LOCAL tracking',
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
        carrier: 'GHTK',
        label: trackingCode,
        fee: quoteRes.feeVnd,
      },
    };
  }

  verifyWebhook(headers: HeaderBag, rawBody: string | Buffer): boolean {
    return verifyCarrierWebhookSignature(
      headers,
      rawBody,
      ['x-ghtk-signature', 'x-signature'],
      this.config.shipping.ghtk.webhookSecret,
    );
  }

  parseWebhook(payload: Record<string, unknown>, _headers: HeaderBag): ParsedShippingWebhook {
    const trackingCode = String(
      payload.label_id ?? payload.trackingCode ?? payload.tracking_code ?? payload.label ?? '',
    ).trim() || null;
    const orderCode = String(
      payload.partner_id ?? payload.orderCode ?? payload.order_code ?? '',
    ).trim() || null;

    const statusId = payload.status_id !== undefined ? String(payload.status_id).trim() : '';
    const statusText = String(payload.status ?? payload.providerStatus ?? statusId ?? 'unknown').trim();
    const statusLower = statusText.toLowerCase();

    const occurredAt =
      typeof payload.action_time === 'string' && !Number.isNaN(Date.parse(payload.action_time))
        ? new Date(payload.action_time).toISOString()
        : typeof payload.occurredAt === 'string' && !Number.isNaN(Date.parse(payload.occurredAt))
          ? new Date(payload.occurredAt).toISOString()
          : new Date().toISOString();

    const explicitEventId = String(payload.eventId ?? payload.event_id ?? payload.hash ?? '').trim();
    const eventId =
      explicitEventId ||
      buildDeterministicEventId('ghtk', [trackingCode ?? orderCode, statusId || statusLower, occurredAt]);

    let mappedOrderStatus: ParsedShippingWebhook['mappedOrderStatus'] = null;
    let mappedShipmentStatus: ShipmentStatus | null = null;
    let mappedRmaStatus: RmaStatus | null = null;

    if (
      ['2', '3', '4', '12', '123', '127'].includes(statusId) ||
      ['picking', 'picked', 'delivering', 'in_transit', 'shipped'].includes(statusLower)
    ) {
      mappedOrderStatus = OrderStatus.SHIPPED;
      mappedShipmentStatus =
        statusId === '3' || statusLower === 'picked'
          ? ShipmentStatus.PICKED
          : ShipmentStatus.IN_TRANSIT;
      mappedRmaStatus = RmaStatus.RETURN_IN_TRANSIT;
    } else if (
      ['5', '6', '45'].includes(statusId) ||
      ['delivered', 'reconciled', 'completed'].includes(statusLower)
    ) {
      mappedOrderStatus = OrderStatus.DELIVERED;
      mappedShipmentStatus = ShipmentStatus.DELIVERED;
      mappedRmaStatus = RmaStatus.QC_INSPECTING;
    } else if (
      ['-1', '7', '8', '9', '10', '11', '13', '20', '21', '49', '410'].includes(statusId) ||
      ['delivery_fail', 'returned', 'returning', 'failed', 'cancelled', 'cancel'].includes(
        statusLower,
      )
    ) {
      mappedOrderStatus = 'DELIVERY_FAILED';
      mappedShipmentStatus = ShipmentStatus.DELIVERY_FAILED;
      mappedRmaStatus = null;
    }

    const note = String(
      payload.reason ?? payload.note ?? `GHTK status update: ${statusText}`,
    ).trim();

    return {
      eventId,
      provider: this.slug,
      trackingCode,
      orderCode,
      providerStatus: statusText || statusId,
      mappedOrderStatus,
      mappedShipmentStatus,
      mappedRmaStatus,
      note,
      occurredAt,
    };
  }
}
