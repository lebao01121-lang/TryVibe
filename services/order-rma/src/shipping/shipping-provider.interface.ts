import type { OrderStatus, RmaStatus, ShipmentStatus, ShippingMethod } from '@atelier/contracts';
import type { HeaderBag } from '@atelier/observability';

export type ShippingProviderSlug = 'ghn' | 'ghtk' | 'ahamove' | 'pickup';
export type ShippingAdapterMode = 'LIVE' | 'SANDBOX_LOCAL';
export type ShippingZoneType =
  | 'INTRA_CITY'
  | 'INTRA_REGION'
  | 'INTER_REGION'
  | 'SHOWROOM_PICKUP';

export interface ShippingQuoteRequest {
  provinceCode?: string;
  districtCode?: string;
  wardCode?: string;
  provinceName?: string;
  districtName?: string;
  wardName?: string;
  streetLine?: string;
  shippingMethod?: ShippingMethod;
  weightGrams?: number;
  orderValueVnd?: number;
  codAmountVnd?: number;
}

export interface ShippingQuoteBreakdown {
  baseFeeVnd: number;
  weightSurchargeVnd: number;
  insuranceFeeVnd: number;
  codFeeVnd: number;
  remoteAreaFeeVnd: number;
  zone: ShippingZoneType;
  weightGrams: number;
  provinceCode: string | null;
  districtCode: string | null;
  wardCode: string | null;
}

export interface ShippingQuoteResult {
  provider: ShippingProviderSlug;
  shippingMethod: ShippingMethod;
  feeVnd: number;
  estimatedDeliveryHours: number;
  estimatedDeliveryDate: string;
  serviceName: string;
  mode: ShippingAdapterMode;
  available: boolean;
  unavailableReason?: string;
  breakdown: ShippingQuoteBreakdown;
}

export interface CreateShipmentItemInput {
  name: string;
  skuCode: string;
  qty: number;
  priceVnd: number;
  weightGrams?: number;
}

export interface CreateShipmentRequest {
  orderId: string;
  orderCode: string;
  shippingMethod: ShippingMethod;
  recipientName: string;
  recipientPhone: string;
  provinceCode?: string;
  districtCode?: string;
  wardCode?: string;
  provinceName: string;
  districtName: string;
  wardName: string;
  streetLine: string;
  weightGrams: number;
  orderValueVnd: number;
  codAmountVnd: number;
  items: CreateShipmentItemInput[];
  note?: string;
  warehouseCode?: string;
}

export interface CreateShipmentResult {
  provider: ShippingProviderSlug;
  trackingCode: string;
  actualFeeVnd: number;
  expectedDeliveryTime: string;
  mode: ShippingAdapterMode;
  rawProviderResponse: Record<string, unknown>;
}

export type MappedWebhookOrderStatus = OrderStatus | 'DELIVERY_FAILED' | null;

export interface ParsedShippingWebhook {
  eventId: string;
  provider: ShippingProviderSlug;
  trackingCode: string | null;
  orderCode: string | null;
  providerStatus: string;
  mappedOrderStatus: MappedWebhookOrderStatus;
  mappedShipmentStatus: ShipmentStatus | null;
  mappedRmaStatus: RmaStatus | null;
  note: string;
  occurredAt: string;
}

export interface ShippingTrackingEventRecord {
  eventId: string;
  provider: string;
  trackingCode: string | null;
  providerStatus: string;
  mappedOrderStatus: string | null;
  mappedRmaStatus: string | null;
  note: string;
  occurredAt: string;
  recordedAt: string;
}

export interface IShippingProviderAdapter {
  readonly slug: ShippingProviderSlug;
  readonly shippingMethod: ShippingMethod;
  isLiveConfigured(): boolean;
  quote(request: ShippingQuoteRequest): Promise<ShippingQuoteResult>;
  createShipment(request: CreateShipmentRequest): Promise<CreateShipmentResult>;
  verifyWebhook(headers: HeaderBag, rawBody: string | Buffer): boolean;
  parseWebhook(payload: Record<string, unknown>, headers: HeaderBag): ParsedShippingWebhook;
}
