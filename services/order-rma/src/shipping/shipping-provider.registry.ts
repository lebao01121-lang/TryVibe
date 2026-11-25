import * as crypto from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ShippingMethod } from '@atelier/contracts';
import { ORDER_CONFIG_TOKEN, type OrderRmaConfig } from '../config/env';
import { AhaMoveAdapter } from './ahamove.adapter';
import { GhnAdapter } from './ghn.adapter';
import { GhtkAdapter } from './ghtk.adapter';
import type {
  CreateShipmentRequest,
  CreateShipmentResult,
  IShippingProviderAdapter,
  ShippingProviderSlug,
  ShippingQuoteRequest,
  ShippingQuoteResult,
} from './shipping-provider.interface';
import { addHoursIso, resolveVnLocation } from './vn-location.helper';

@Injectable()
export class ShippingProviderRegistry {
  private readonly ghnAdapter: GhnAdapter;
  private readonly ghtkAdapter: GhtkAdapter;
  private readonly ahamoveAdapter: AhaMoveAdapter;

  private readonly bySlug: Map<ShippingProviderSlug, IShippingProviderAdapter>;
  private readonly byMethod: Map<ShippingMethod, IShippingProviderAdapter>;

  constructor(@Inject(ORDER_CONFIG_TOKEN) private readonly config: OrderRmaConfig) {
    this.ghnAdapter = new GhnAdapter(this.config);
    this.ghtkAdapter = new GhtkAdapter(this.config);
    this.ahamoveAdapter = new AhaMoveAdapter(this.config);

    this.bySlug = new Map<ShippingProviderSlug, IShippingProviderAdapter>([
      ['ghn', this.ghnAdapter],
      ['ghtk', this.ghtkAdapter],
      ['ahamove', this.ahamoveAdapter],
    ]);

    this.byMethod = new Map<ShippingMethod, IShippingProviderAdapter>([
      [ShippingMethod.GHN, this.ghnAdapter],
      [ShippingMethod.GHTK, this.ghtkAdapter],
      [ShippingMethod.AHAMOVE_2H, this.ahamoveAdapter],
    ]);
  }

  getAdapterBySlug(slug: string): IShippingProviderAdapter | null {
    const normalized = slug.trim().toLowerCase() as ShippingProviderSlug;
    return this.bySlug.get(normalized) ?? null;
  }

  getAdapterByMethod(method: ShippingMethod): IShippingProviderAdapter | null {
    return this.byMethod.get(method) ?? null;
  }

  getProviderStatuses(): Record<'ghn' | 'ghtk' | 'ahamove', { mode: 'LIVE' | 'SANDBOX_LOCAL'; configured: boolean }> {
    return {
      ghn: {
        mode: this.ghnAdapter.isLiveConfigured() ? 'LIVE' : 'SANDBOX_LOCAL',
        configured: this.ghnAdapter.isLiveConfigured(),
      },
      ghtk: {
        mode: this.ghtkAdapter.isLiveConfigured() ? 'LIVE' : 'SANDBOX_LOCAL',
        configured: this.ghtkAdapter.isLiveConfigured(),
      },
      ahamove: {
        mode: this.ahamoveAdapter.isLiveConfigured() ? 'LIVE' : 'SANDBOX_LOCAL',
        configured: this.ahamoveAdapter.isLiveConfigured(),
      },
    };
  }

  private buildPickupQuote(request: ShippingQuoteRequest): ShippingQuoteResult {
    const location = resolveVnLocation(request);
    return {
      provider: 'pickup',
      shippingMethod: ShippingMethod.PICKUP,
      feeVnd: 0,
      estimatedDeliveryHours: 2,
      estimatedDeliveryDate: addHoursIso(2),
      serviceName: location.isHcm
        ? 'Nhận tại Showroom TryVibe Atelier · Quận 1, TP.HCM'
        : 'Nhận tại Showroom TryVibe Atelier · Ba Đình, Hà Nội',
      mode: 'SANDBOX_LOCAL',
      available: true,
      breakdown: {
        baseFeeVnd: 0,
        weightSurchargeVnd: 0,
        insuranceFeeVnd: 0,
        codFeeVnd: 0,
        remoteAreaFeeVnd: 0,
        zone: 'SHOWROOM_PICKUP',
        weightGrams: Math.max(100, Math.round(request.weightGrams ?? 500)),
        provinceCode: location.provinceCode,
        districtCode: location.districtCode,
        wardCode: location.wardCode,
      },
    };
  }

  async quote(request: ShippingQuoteRequest): Promise<ShippingQuoteResult> {
    const method = request.shippingMethod ?? ShippingMethod.GHN;
    if (method === ShippingMethod.PICKUP) {
      return this.buildPickupQuote(request);
    }
    const adapter = this.byMethod.get(method) ?? this.ghnAdapter;
    return adapter.quote({ ...request, shippingMethod: method });
  }

  async quoteAll(request: ShippingQuoteRequest): Promise<ShippingQuoteResult[]> {
    const [ghn, ghtk, ahamove] = await Promise.all([
      this.ghnAdapter.quote({ ...request, shippingMethod: ShippingMethod.GHN }),
      this.ghtkAdapter.quote({ ...request, shippingMethod: ShippingMethod.GHTK }),
      this.ahamoveAdapter.quote({ ...request, shippingMethod: ShippingMethod.AHAMOVE_2H }),
    ]);
    const pickup = this.buildPickupQuote(request);
    return [ghn, ghtk, ahamove, pickup];
  }

  async createShipment(request: CreateShipmentRequest): Promise<CreateShipmentResult> {
    if (request.shippingMethod === ShippingMethod.PICKUP) {
      const cleanOrder = request.orderCode
        .replace(/^TX-/, '')
        .replace(/[^A-Z0-9]/gi, '')
        .toUpperCase()
        .slice(-6);
      const suffix = crypto.randomBytes(2).toString('hex').toUpperCase();
      const trackingCode = `PKP-${cleanOrder}-${suffix}`;
      return {
        provider: 'pickup',
        trackingCode,
        actualFeeVnd: 0,
        expectedDeliveryTime: addHoursIso(2),
        mode: 'SANDBOX_LOCAL',
        rawProviderResponse: {
          sandbox: true,
          carrier: 'SHOWROOM_PICKUP',
          pickupCode: trackingCode,
        },
      };
    }

    const adapter = this.byMethod.get(request.shippingMethod) ?? this.ghnAdapter;
    return adapter.createShipment(request);
  }
}
