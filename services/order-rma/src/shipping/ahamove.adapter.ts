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

export class AhaMoveAdapter implements IShippingProviderAdapter {
  readonly slug = 'ahamove' as const;
  readonly shippingMethod = ShippingMethod.AHAMOVE_2H;
  private readonly logger = createLogger(`${SERVICE_NAME}:shipping:ahamove`);

  constructor(private readonly config: OrderRmaConfig) {}

  isLiveConfigured(): boolean {
    return Boolean(this.config.shipping.ahamove.token);
  }

  private computeLocalQuote(request: ShippingQuoteRequest): ShippingQuoteResult {
    const location = resolveVnLocation(request);
    const weightGrams = Math.max(100, Math.round(request.weightGrams ?? 500));
    const codAmountVnd = Math.max(0, Math.round(request.codAmountVnd ?? 0));

    if (!location.isAhaMoveEligible) {
      return {
        provider: this.slug,
        shippingMethod: this.shippingMethod,
        feeVnd: 0,
        estimatedDeliveryHours: 2,
        estimatedDeliveryDate: addHoursIso(2),
        serviceName: 'AhaMove Hỏa Tốc 2 Giờ (Nội thành Hà Nội / TP.HCM)',
        mode: 'SANDBOX_LOCAL',
        available: false,
        unavailableReason:
          'Dịch vụ AhaMove Hỏa Tốc 2 Giờ chỉ hỗ trợ địa chỉ nội thành Hà Nội (01) và TP. Hồ Chí Minh (79).',
        breakdown: {
          baseFeeVnd: 0,
          weightSurchargeVnd: 0,
          insuranceFeeVnd: 0,
          codFeeVnd: 0,
          remoteAreaFeeVnd: 0,
          zone: location.zone,
          weightGrams,
          provinceCode: location.provinceCode,
          districtCode: location.districtCode,
          wardCode: location.wardCode,
        },
      };
    }

    const baseFeeVnd = location.isInnerDistrict ? 42_000 : 58_000;
    const weightSurchargeVnd = weightGrams > 2_000 ? Math.ceil((weightGrams - 2_000) / 1_000) * 5_000 : 0;
    const codFeeVnd = codAmountVnd > 2_000_000 ? 6_000 : 0;
    const feeVnd = baseFeeVnd + weightSurchargeVnd + codFeeVnd;

    return {
      provider: this.slug,
      shippingMethod: this.shippingMethod,
      feeVnd,
      estimatedDeliveryHours: 2,
      estimatedDeliveryDate: addHoursIso(2),
      serviceName: location.isHcm
        ? 'AhaMove Hỏa Tốc 2H · Xuất kho Showroom TP.HCM'
        : 'AhaMove Hỏa Tốc 2H · Xuất kho Atelier Hà Nội',
      mode: 'SANDBOX_LOCAL',
      available: true,
      breakdown: {
        baseFeeVnd,
        weightSurchargeVnd,
        insuranceFeeVnd: 0,
        codFeeVnd,
        remoteAreaFeeVnd: 0,
        zone: 'INTRA_CITY',
        weightGrams,
        provinceCode: location.provinceCode,
        districtCode: location.districtCode,
        wardCode: location.wardCode,
      },
    };
  }

  private buildAhaMovePath(
    location: ReturnType<typeof resolveVnLocation>,
    dropoff: { address: string; name?: string; mobile?: string; cod?: number },
  ): Array<Record<string, unknown>> {
    const pickupAddress = location.isHcm
      ? '68 Đồng Khởi, Phường Bến Nghé, Quận 1, Thành phố Hồ Chí Minh'
      : this.config.shipping.originAddress;
    const pickupName = location.isHcm
      ? 'TryVibe Atelier · Showroom TP.HCM'
      : this.config.shipping.originName;

    return [
      {
        address: pickupAddress,
        name: pickupName,
        mobile: this.config.shipping.originPhone,
      },
      {
        address: `${dropoff.address}, ${location.wardName}, ${location.districtName}, ${location.provinceName}`,
        ...(dropoff.name ? { name: dropoff.name } : {}),
        ...(dropoff.mobile ? { mobile: dropoff.mobile } : {}),
        ...(typeof dropoff.cod === 'number' && dropoff.cod > 0 ? { cod: Math.round(dropoff.cod) } : {}),
      },
    ];
  }

  async quote(request: ShippingQuoteRequest): Promise<ShippingQuoteResult> {
    const fallback = this.computeLocalQuote(request);
    if (!fallback.available || !this.isLiveConfigured()) {
      return fallback;
    }

    const location = resolveVnLocation(request);
    const ahamove = this.config.shipping.ahamove;
    const serviceId = location.isHcm ? 'SGN-EXPRESS' : 'HAN-EXPRESS';

    try {
      const res = await fetchCarrierJsonWithRetry(
        `${ahamove.apiUrl}/v1/order/estimated_fee`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${ahamove.token!}`,
          },
          body: JSON.stringify({
            token: ahamove.token!,
            service_id: serviceId,
            order_time: 0,
            path: this.buildAhaMovePath(location, {
              address: request.streetLine?.trim() || location.wardName,
              cod: request.codAmountVnd,
            }),
          }),
        },
        { timeoutMs: 8_000, maxRetries: 1 },
      );

      if (!res.ok || !res.json) {
        this.logger.warn(
          { status: res.status, body: res.rawText.slice(0, 300) },
          'AhaMove live estimated_fee API returned non-success; falling back to local 2H quote',
        );
        return fallback;
      }

      const totalFee = Math.max(
        0,
        Math.round(Number(res.json.total_price ?? res.json.total_fee ?? fallback.feeVnd)),
      );
      const distanceFee = Math.max(0, Math.round(Number(res.json.distance_fee ?? totalFee)));
      const durationSec = Number(res.json.duration ?? 7200);
      const estimatedHours = Math.max(1, Math.min(4, Math.ceil(durationSec / 3600)));

      return {
        ...fallback,
        feeVnd: totalFee,
        estimatedDeliveryHours: estimatedHours,
        estimatedDeliveryDate: addHoursIso(estimatedHours),
        mode: 'LIVE',
        breakdown: {
          ...fallback.breakdown,
          baseFeeVnd: distanceFee,
          weightSurchargeVnd: Math.max(0, totalFee - distanceFee),
        },
      };
    } catch (error: unknown) {
      this.logger.warn(
        { err: error instanceof Error ? error.message : String(error) },
        'AhaMove live quote failed after retry; falling back to local 2H quote',
      );
      return fallback;
    }
  }

  private generateLocalTrackingCode(orderCode: string, isHcm: boolean): string {
    const cityTag = isHcm ? 'HCM' : 'HN';
    const cleanOrder = orderCode
      .replace(/^TX-/, '')
      .replace(/[^A-Z0-9]/gi, '')
      .toUpperCase()
      .slice(-6);
    const suffix = crypto.randomBytes(2).toString('hex').toUpperCase();
    return `AHA2H${cityTag}${cleanOrder}${suffix}`;
  }

  async createShipment(request: CreateShipmentRequest): Promise<CreateShipmentResult> {
    const location = resolveVnLocation(request);
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

    const fallbackFee = quoteRes.feeVnd > 0 ? quoteRes.feeVnd : 55_000;

    if (!this.isLiveConfigured() || !location.isAhaMoveEligible) {
      const trackingCode = this.generateLocalTrackingCode(request.orderCode, location.isHcm);
      return {
        provider: this.slug,
        trackingCode,
        actualFeeVnd: fallbackFee,
        expectedDeliveryTime: addHoursIso(2),
        mode: 'SANDBOX_LOCAL',
        rawProviderResponse: {
          sandbox: true,
          carrier: 'AHAMOVE',
          order_id: trackingCode,
          service_id: location.isHcm ? 'SGN-EXPRESS' : 'HAN-EXPRESS',
          total_fee: fallbackFee,
        },
      };
    }

    const ahamove = this.config.shipping.ahamove;
    const serviceId = location.isHcm ? 'SGN-EXPRESS' : 'HAN-EXPRESS';

    try {
      const res = await fetchCarrierJsonWithRetry(
        `${ahamove.apiUrl}/v1/order/create`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${ahamove.token!}`,
          },
          body: JSON.stringify({
            token: ahamove.token!,
            service_id: serviceId,
            order_time: 0,
            payment_method: 'BALANCE',
            remarks: request.note || `Đơn hàng hỏa tốc 2H TryVibe Atelier (${request.orderCode})`,
            path: this.buildAhaMovePath(location, {
              address: request.streetLine,
              name: request.recipientName,
              mobile: request.recipientPhone,
              cod: request.codAmountVnd,
            }),
            items: request.items.map((item) => ({
              _id: item.skuCode,
              name: item.name,
              num: item.qty,
              price: item.priceVnd,
            })),
          }),
        },
        { timeoutMs: 8_000, maxRetries: 1 },
      );

      const orderObj = (res.json?.order as Record<string, unknown> | undefined) ?? {};
      const orderId = String(res.json?.order_id ?? orderObj._id ?? '').trim();
      if (res.ok && orderId) {
        const actualFeeVnd = Math.max(
          0,
          Math.round(Number(orderObj.total_fee ?? res.json?.total_fee ?? fallbackFee)),
        );
        return {
          provider: this.slug,
          trackingCode: orderId,
          actualFeeVnd,
          expectedDeliveryTime: addHoursIso(2),
          mode: 'LIVE',
          rawProviderResponse: res.json ?? {},
        };
      }

      this.logger.warn(
        { status: res.status, orderCode: request.orderCode, body: res.rawText.slice(0, 300) },
        'AhaMove live createShipment returned non-success; falling back to SANDBOX_LOCAL tracking',
      );
    } catch (error: unknown) {
      this.logger.warn(
        { err: error instanceof Error ? error.message : String(error), orderCode: request.orderCode },
        'AhaMove live createShipment failed after retry; falling back to SANDBOX_LOCAL tracking',
      );
    }

    const trackingCode = this.generateLocalTrackingCode(request.orderCode, location.isHcm);
    return {
      provider: this.slug,
      trackingCode,
      actualFeeVnd: fallbackFee,
      expectedDeliveryTime: addHoursIso(2),
      mode: 'SANDBOX_LOCAL',
      rawProviderResponse: {
        sandbox: true,
        fallbackFromLiveError: true,
        carrier: 'AHAMOVE',
        order_id: trackingCode,
        total_fee: fallbackFee,
      },
    };
  }

  verifyWebhook(headers: HeaderBag, rawBody: string | Buffer): boolean {
    return verifyCarrierWebhookSignature(
      headers,
      rawBody,
      ['x-ahamove-signature', 'x-signature'],
      this.config.shipping.ahamove.webhookSecret,
    );
  }

  parseWebhook(payload: Record<string, unknown>, _headers: HeaderBag): ParsedShippingWebhook {
    const trackingCode = String(
      payload._id ?? payload.order_id ?? payload.tracking_number ?? payload.trackingCode ?? '',
    ).trim() || null;
    const orderCode = String(
      payload.client_order_code ?? payload.orderCode ?? payload.partner_order_id ?? '',
    ).trim() || null;
    const rawStatus = String(payload.status ?? payload.Status ?? 'unknown').trim();
    const statusNorm = rawStatus.toUpperCase().replace(/\s+/g, '_');

    const completeEpoch = Number(payload.complete_time ?? payload.event_time ?? 0);
    const occurredAt =
      Number.isFinite(completeEpoch) && completeEpoch > 0
        ? new Date(completeEpoch > 1e12 ? completeEpoch : completeEpoch * 1000).toISOString()
        : typeof payload.occurredAt === 'string' && !Number.isNaN(Date.parse(payload.occurredAt))
          ? new Date(payload.occurredAt).toISOString()
          : new Date().toISOString();

    const explicitEventId = String(payload.eventId ?? payload.event_id ?? '').trim();
    const eventId =
      explicitEventId ||
      buildDeterministicEventId('ahamove', [trackingCode ?? orderCode, statusNorm, occurredAt]);

    let mappedOrderStatus: ParsedShippingWebhook['mappedOrderStatus'] = null;
    let mappedShipmentStatus: ShipmentStatus | null = null;
    let mappedRmaStatus: RmaStatus | null = null;

    if (
      ['ASSIGNING', 'ACCEPTED', 'IN_PROCESS', 'PICKING', 'DELIVERING', 'IN_TRANSIT'].includes(
        statusNorm,
      )
    ) {
      mappedOrderStatus = OrderStatus.SHIPPED;
      mappedShipmentStatus =
        statusNorm === 'ACCEPTED' ? ShipmentStatus.PICKED : ShipmentStatus.IN_TRANSIT;
      mappedRmaStatus = RmaStatus.RETURN_IN_TRANSIT;
    } else if (['COMPLETED', 'DELIVERED'].includes(statusNorm)) {
      mappedOrderStatus = OrderStatus.DELIVERED;
      mappedShipmentStatus = ShipmentStatus.DELIVERED;
      mappedRmaStatus = RmaStatus.QC_INSPECTING;
    } else if (
      ['CANCELLED', 'FAILED', 'RETURNED', 'DELIVERY_FAIL', 'DELIVERY_FAILED'].includes(statusNorm)
    ) {
      mappedOrderStatus = 'DELIVERY_FAILED';
      mappedShipmentStatus = ShipmentStatus.DELIVERY_FAILED;
      mappedRmaStatus = null;
    }

    const note = String(
      payload.cancel_comment ??
        payload.substatus ??
        payload.note ??
        `AhaMove status update: ${rawStatus}`,
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
