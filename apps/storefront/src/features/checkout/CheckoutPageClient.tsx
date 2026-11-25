'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import {
  ErrorCode,
  HTTP_HEADERS,
  OrderStatus,
  PaymentMethod,
  PaymentProvider,
  PromoStatus,
  PromoType,
  ShippingMethod,
  type CartDto,
  type CustomerAddressDto,
  type EvaluatePromotionResultDTO,
  type OrderDTO,
  type PackagingOptionDto,
  type PromotionDTO,
  type StorefrontBootstrapDto,
} from '@atelier/contracts';
import { GiftCardPreview } from '@/features/drawer-bag/GiftCardPreview';
import { apiFetch, getBffBaseUrl, getStoredSession } from '@/lib/api-client';
import { FORMAT_VND, PACKAGING_TIERS } from '@/lib/catalog-data';
import { getOrCreateGuestSessionId } from '@/lib/guest-session';
import { emitCartUpdated, refreshCartCount } from '@/lib/storefront-actions';
import {
  VN_PROVINCES,
  getDefaultDivisionSelection,
  getDistrictsByProvinceCode,
  getWardsByDistrictCode,
  resolveDivisionSelection,
  selectDistrictCascade,
  selectProvinceCascade,
  selectWardCascade,
  type VnDivisionSelection,
} from '@/lib/vn-admin-divisions';

const DAY_NAMES_VI = [
  'Chủ nhật',
  'Thứ hai',
  'Thứ ba',
  'Thứ tư',
  'Thứ năm',
  'Thứ sáu',
  'Thứ bảy',
] as const;

const TWO_HOUR_SLOTS = [
  '09:00–11:00',
  '11:00–13:00',
  '13:00–15:00',
  '15:00–17:00',
  '17:00–19:00',
] as const;

function formatPromotionHint(promo: PromotionDTO): string {
  if (promo.type === PromoType.FREESHIP) {
    return promo.minOrderVnd > 0
      ? `Miễn phí vận chuyển (đơn từ ${FORMAT_VND(promo.minOrderVnd)})`
      : 'Miễn phí vận chuyển';
  }
  if (promo.discountPercent != null && promo.discountPercent > 0) {
    return promo.maxDiscountVnd
      ? `Giảm ${promo.discountPercent}% (tối đa ${FORMAT_VND(promo.maxDiscountVnd)})`
      : `Giảm ${promo.discountPercent}%`;
  }
  if (promo.discountAmountVnd != null && promo.discountAmountVnd > 0) {
    return `Giảm ngay ${FORMAT_VND(promo.discountAmountVnd)}`;
  }
  return promo.description || promo.name;
}

function extractPromotionsList(payload: unknown): PromotionDTO[] {
  if (Array.isArray(payload)) {
    return payload as PromotionDTO[];
  }
  if (payload && typeof payload === 'object') {
    const rec = payload as Record<string, unknown>;
    if (Array.isArray(rec.promotions)) {
      return rec.promotions as PromotionDTO[];
    }
    if (Array.isArray(rec.items)) {
      return rec.items as PromotionDTO[];
    }
  }
  return [];
}

const FALLBACK_PACKAGING: PackagingOptionDto[] = PACKAGING_TIERS.map((p, idx) => ({
  id: p.id,
  code: p.id,
  name: p.name,
  description: p.description,
  swatchHex: p.swatchHex,
  priceVnd: p.priceVnd,
  backAssetUrl: null,
  frontAssetUrl: null,
  isDefault: idx === 0,
  sortOrder: idx + 1,
}));

interface DeliveryDayOption {
  isoDate: string;
  label: string;
  dm: string;
}

function buildNextThreeDays(): DeliveryDayOption[] {
  const now = Date.now();
  return [0, 1, 2].map((offset) => {
    const d = new Date(now + offset * 86_400_000);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return {
      isoDate: `${yyyy}-${mm}-${dd}`,
      label: offset === 0 ? 'Hôm nay' : offset === 1 ? 'Ngày mai' : DAY_NAMES_VI[d.getDay()] ?? 'Ngày kia',
      dm: `${d.getDate()}/${d.getMonth() + 1}`,
    };
  });
}

function createIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `chk-${crypto.randomUUID()}`;
  }
  return `chk-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function computeEstimatedShippingFee(
  method: ShippingMethod,
  subtotalAfterCombo: number,
  freeShipThreshold: number,
): number {
  if (method === ShippingMethod.PICKUP) return 0;
  if (method === ShippingMethod.AHAMOVE_2H) return 45_000;
  if (subtotalAfterCombo >= freeShipThreshold) return 0;
  return method === ShippingMethod.GHN ? 35_000 : 30_000;
}

function formatMmSs(totalSec: number): string {
  const safe = Math.max(0, Math.floor(totalSec));
  const m = Math.floor(safe / 60);
  const s = safe % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function CheckoutPageClient() {
  const router = useRouter();
  const deliveryDays = useMemo(() => buildNextThreeDays(), []);
  const idempotencyKeyRef = useRef<string>(createIdempotencyKey());
  const socketRef = useRef<Socket | null>(null);
  const pollRef = useRef<number | null>(null);

  const [loading, setLoading] = useState(true);
  const [cart, setCart] = useState<CartDto | null>(null);
  const [packagingOptions, setPackagingOptions] = useState<PackagingOptionDto[]>(
    FALLBACK_PACKAGING,
  );
  const [savedAddresses, setSavedAddresses] = useState<CustomerAddressDto[]>([]);
  const [selectedAddressId, setSelectedAddressId] = useState<string>('custom');

  // Step 1: Shipping Address & Smart Logistics
  const [recipientName, setRecipientName] = useState('');
  const [phone, setPhone] = useState('');
  const [customerEmail, setCustomerEmail] = useState('');
  const [division, setDivision] = useState<VnDivisionSelection>(() =>
    getDefaultDivisionSelection(),
  );
  const [streetLine, setStreetLine] = useState('');
  const [shippingMethod, setShippingMethod] = useState<ShippingMethod>(
    ShippingMethod.AHAMOVE_2H,
  );
  const [deliveryDayIdx, setDeliveryDayIdx] = useState(0);
  const [deliverySlotIdx, setDeliverySlotIdx] = useState(1);

  // Step 2: Combo, Voucher & Gift Card
  const [selectedPkgId, setSelectedPkgId] = useState<string>(FALLBACK_PACKAGING[0]!.id);
  const [giftNote, setGiftNote] = useState('');
  const [voucherInput, setVoucherInput] = useState('');
  const [activePromotions, setActivePromotions] = useState<PromotionDTO[]>([]);
  const [promotionsLoading, setPromotionsLoading] = useState(true);
  const [voucherEval, setVoucherEval] = useState<EvaluatePromotionResultDTO | null>(null);
  const [evaluatingVoucher, setEvaluatingVoucher] = useState(false);

  // Step 3: Payment & Order Submission
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>(
    PaymentMethod.VIETQR,
  );
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [codDepositNotice, setCodDepositNotice] = useState<string | null>(null);

  // VietQR Awaiting Payment State
  const [createdOrder, setCreatedOrder] = useState<OrderDTO | null>(null);
  const [countdownSec, setCountdownSec] = useState(15 * 60);
  const [simulatingPayment, setSimulatingPayment] = useState(false);
  const [copiedPayload, setCopiedPayload] = useState(false);

  const applySavedAddress = useCallback((addr: CustomerAddressDto) => {
    setSelectedAddressId(addr.id);
    setRecipientName(addr.recipientName);
    setPhone(addr.phone);
    const resolved = resolveDivisionSelection({
      provinceCode: addr.provinceCode,
      provinceName: addr.provinceName,
      districtCode: addr.districtCode,
      districtName: addr.districtName,
      wardCode: addr.wardCode,
      wardName: addr.wardName,
    });
    if (resolved) {
      setDivision(resolved);
    } else {
      setDivision({
        provinceCode: addr.provinceCode || '',
        provinceName: addr.provinceName,
        districtCode: addr.districtCode || '',
        districtName: addr.districtName,
        wardCode: addr.wardCode || '',
        wardName: addr.wardName,
      });
    }
    setStreetLine(addr.streetLine);
  }, []);

  // Load live cart, packaging options, active promotions, and logged-in saved addresses
  useEffect(() => {
    let cancelled = false;

    const loadInitial = async () => {
      setLoading(true);
      setPromotionsLoading(true);
      const session = getStoredSession();
      if (session?.user?.email) {
        setCustomerEmail(session.user.email);
      }
      if (session?.user?.fullName && !recipientName) {
        setRecipientName(session.user.fullName);
      }

      const [cartRes, bootRes, promosRes, addrRes] = await Promise.all([
        apiFetch<CartDto>('/bff/v1/storefront/cart', { skipAuthRefresh: true }),
        apiFetch<StorefrontBootstrapDto>('/bff/v1/storefront/bootstrap', {
          skipAuthRefresh: true,
        }),
        apiFetch<PromotionDTO[] | { items?: PromotionDTO[]; promotions?: PromotionDTO[] }>(
          '/bff/v1/storefront/promotions',
          { skipAuthRefresh: true },
        ),
        session?.accessToken
          ? apiFetch<CustomerAddressDto[]>('/bff/v1/customers/me/addresses')
          : Promise.resolve({ ok: false, status: 401, data: null, error: null, headers: null }),
      ]);

      if (cancelled) return;

      if (bootRes.ok && bootRes.data?.packagingOptions?.length) {
        setPackagingOptions(bootRes.data.packagingOptions);
        const defPkg =
          bootRes.data.packagingOptions.find((p) => p.isDefault) ??
          bootRes.data.packagingOptions[0];
        if (defPkg) setSelectedPkgId(defPkg.id);
      }

      if (cartRes.ok && cartRes.data) {
        setCart(cartRes.data);
        if (cartRes.data.packagingOptionId) {
          setSelectedPkgId(cartRes.data.packagingOptionId);
        }
        if (cartRes.data.giftNote) {
          setGiftNote(cartRes.data.giftNote);
        }
      }

      if (promosRes.ok && promosRes.data) {
        const nowMs = Date.now();
        const rawList = extractPromotionsList(promosRes.data);
        const liveActive = rawList.filter((promo) => {
          if (promo.status && promo.status !== PromoStatus.ACTIVE) return false;
          if (promo.startsAt && new Date(promo.startsAt).getTime() > nowMs) return false;
          if (promo.endsAt && new Date(promo.endsAt).getTime() < nowMs) return false;
          if (promo.maxUses != null && promo.usedCount >= promo.maxUses) return false;
          return Boolean(promo.code);
        });
        setActivePromotions(liveActive);
      } else {
        setActivePromotions([]);
      }
      setPromotionsLoading(false);

      if (addrRes.ok && Array.isArray(addrRes.data) && addrRes.data.length > 0) {
        setSavedAddresses(addrRes.data);
        const defaultAddr = addrRes.data.find((a) => a.isDefault) ?? addrRes.data[0]!;
        applySavedAddress(defaultAddr);
      }

      setLoading(false);
    };

    void loadInitial();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Regenerate idempotency key if user changes core checkout payload before submitting
  useEffect(() => {
    if (!createdOrder) {
      idempotencyKeyRef.current = createIdempotencyKey();
    }
  }, [
    cart?.totalQty,
    createdOrder,
    paymentMethod,
    selectedPkgId,
    shippingMethod,
    voucherEval?.voucherCode,
  ]);

  const activePackaging = useMemo(
    () =>
      packagingOptions.find((p) => p.id === selectedPkgId) ??
      packagingOptions[0] ??
      null,
    [packagingOptions, selectedPkgId],
  );

  const subtotalVnd = cart?.subtotalVnd ?? 0;
  const comboDiscountPct = cart?.comboDiscountPct ?? 0;
  const comboDiscountVnd = cart?.comboDiscountVnd ?? 0;
  const freeShipThreshold = cart?.freeShipThresholdVnd ?? 2_000_000;
  const rawShippingFeeVnd = computeEstimatedShippingFee(
    shippingMethod,
    Math.max(0, subtotalVnd - comboDiscountVnd),
    freeShipThreshold,
  );
  const packagingPriceVnd = activePackaging?.priceVnd ?? 0;
  const voucherDiscountVnd = voucherEval?.valid ? voucherEval.discountVnd : 0;
  const shippingDiscountVnd = voucherEval?.valid ? voucherEval.shippingDiscountVnd : 0;
  const effectiveShippingFee = Math.max(0, rawShippingFeeVnd - shippingDiscountVnd);
  const estimatedTotalVnd = Math.max(
    0,
    subtotalVnd - comboDiscountVnd - voucherDiscountVnd + packagingPriceVnd + effectiveShippingFee,
  );

  const handleEvaluateVoucher = useCallback(
    async (explicitCode?: string) => {
      const code = (explicitCode ?? voucherInput).trim().toUpperCase();
      if (!code || !cart || cart.items.length === 0) {
        setVoucherEval(null);
        return;
      }

      setVoucherInput(code);
      setEvaluatingVoucher(true);
      setErrorMessage(null);

      const distinctSlots = new Set(
        cart.items.map((item) => item.slot).filter(Boolean),
      ).size;

      const res = await apiFetch<EvaluatePromotionResultDTO>(
        '/bff/v1/storefront/promotions/evaluate',
        {
          method: 'POST',
          skipAuthRefresh: true,
          body: JSON.stringify({
            voucherCode: code,
            items: cart.items.map((item) => ({
              skuId: item.skuId,
              productId: item.productId,
              unitPriceVnd: item.unitPriceVnd,
              qty: item.qty,
              slot: item.slot,
            })),
            subtotalVnd: cart.subtotalVnd,
            shippingFeeVnd: rawShippingFeeVnd,
            comboDistinctSlots: distinctSlots,
          }),
        },
      );

      setEvaluatingVoucher(false);
      if (res.ok && res.data) {
        setVoucherEval(res.data);
      } else {
        setVoucherEval({
          valid: false,
          voucherCode: code,
          promotionId: null,
          promoType: null,
          discountVnd: 0,
          shippingDiscountVnd: 0,
          totalDiscountVnd: 0,
          allocatedItems: [],
          reason: res.error?.message || 'Mã ưu đãi không hợp lệ hoặc đã hết lượt.',
        });
      }
    },
    [cart, rawShippingFeeVnd, voucherInput],
  );

  const cleanupOrderTracking = useCallback(() => {
    if (pollRef.current !== null) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
    if (socketRef.current) {
      socketRef.current.disconnect();
      socketRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      cleanupOrderTracking();
    };
  }, [cleanupOrderTracking]);

  // Live 15:00 countdown & Socket.io `order:subscribe` + HTTP polling when VietQR order is awaiting payment
  useEffect(() => {
    if (!createdOrder || createdOrder.status !== OrderStatus.AWAITING_PAYMENT) {
      return undefined;
    }

    const orderCode = createdOrder.orderCode;
    const expiresIso =
      createdOrder.reservationExpiresAt ?? createdOrder.paymentIntent?.expiresAt ?? null;
    const targetMs = expiresIso
      ? new Date(expiresIso).getTime()
      : Date.now() + 15 * 60 * 1000;

    const tickCountdown = () => {
      setCountdownSec(Math.max(0, Math.floor((targetMs - Date.now()) / 1000)));
    };
    tickCountdown();
    const countdownTimer = window.setInterval(tickCountdown, 1000);

    const handlePaidRedirect = () => {
      cleanupOrderTracking();
      refreshCartCount();
      router.push(`/don-hang/${encodeURIComponent(orderCode)}`);
    };

    try {
      const session = getStoredSession();
      const guestSessionId = getOrCreateGuestSessionId();
      const explicitRealtimeUrl = process.env.NEXT_PUBLIC_REALTIME_URL?.trim();
      const realtimeSocketUrl = explicitRealtimeUrl
        ? `${explicitRealtimeUrl.replace(/\/+$/, '')}/realtime`
        : typeof window !== 'undefined' &&
            window.location.port === '3000' &&
            (window.location.hostname === '127.0.0.1' ||
              window.location.hostname === 'localhost')
          ? `${window.location.protocol}//${window.location.hostname}:4000/realtime`
          : `${getBffBaseUrl()}/realtime`;

      const socket = io(realtimeSocketUrl, {
        path: '/socket.io/',
        transports: ['websocket', 'polling'],
        withCredentials: true,
        auth: {
          ...(session?.accessToken ? { token: session.accessToken } : {}),
          guestSessionId,
        },
        reconnectionAttempts: 3,
        timeout: 5000,
      });
      socketRef.current = socket;

      socket.on('connect', () => {
        socket.emit('order:subscribe', { orderId: orderCode, orderCode });
      });

      socket.on('order:paid', () => {
        handlePaidRedirect();
      });

      socket.on('order:updated', (payload: { status?: OrderStatus }) => {
        if (
          payload?.status === OrderStatus.CONFIRMED ||
          payload?.status === OrderStatus.PACKING
        ) {
          handlePaidRedirect();
        }
      });
    } catch {
      // Fall back cleanly to polling below
    }

    pollRef.current = window.setInterval(async () => {
      const statusRes = await apiFetch<OrderDTO>(
        `/bff/v1/storefront/orders/${encodeURIComponent(orderCode)}`,
        { skipAuthRefresh: true },
      );
      if (statusRes.ok && statusRes.data) {
        if (
          statusRes.data.status === OrderStatus.CONFIRMED ||
          statusRes.data.status === OrderStatus.PACKING ||
          statusRes.data.status === OrderStatus.SHIPPED ||
          statusRes.data.status === OrderStatus.DELIVERED
        ) {
          handlePaidRedirect();
        }
      }
    }, 2500);

    return () => {
      window.clearInterval(countdownTimer);
      cleanupOrderTracking();
    };
  }, [cleanupOrderTracking, createdOrder, router]);

  const handleSubmitOrder = async () => {
    setErrorMessage(null);
    setCodDepositNotice(null);

    if (!cart || cart.items.length === 0) {
      setErrorMessage('Giỏ hàng của bạn đang trống. Hãy chọn ít nhất 1 thiết kế.');
      return;
    }

    if (
      !recipientName.trim() ||
      phone.trim().length < 8 ||
      !streetLine.trim() ||
      !division.provinceName.trim() ||
      !division.districtName.trim() ||
      !division.wardName.trim()
    ) {
      setErrorMessage('Vui lòng điền đầy đủ họ tên, số điện thoại và địa chỉ giao hàng.');
      return;
    }

    setSubmitting(true);

    const chosenDay = deliveryDays[deliveryDayIdx];
    const chosenSlot = TWO_HOUR_SLOTS[deliverySlotIdx];
    const returnUrl =
      typeof window !== 'undefined'
        ? `${window.location.origin}/thanh-toan/ket-qua`
        : undefined;

    // Intentionally send ZERO price fields — order-rma resolves authoritative prices server-side
    const res = await apiFetch<OrderDTO>('/bff/v1/storefront/orders', {
      method: 'POST',
      headers: {
        [HTTP_HEADERS.IDEMPOTENCY_KEY]: idempotencyKeyRef.current,
      },
      body: JSON.stringify({
        shippingAddress: {
          recipientName: recipientName.trim(),
          phone: phone.trim(),
          provinceCode: division.provinceCode || undefined,
          provinceName: division.provinceName.trim(),
          districtCode: division.districtCode || undefined,
          districtName: division.districtName.trim(),
          wardCode: division.wardCode || undefined,
          wardName: division.wardName.trim(),
          streetLine: streetLine.trim(),
        },
        shippingMethod,
        deliveryDate:
          shippingMethod === ShippingMethod.AHAMOVE_2H ? chosenDay?.isoDate ?? null : null,
        deliverySlot:
          shippingMethod === ShippingMethod.AHAMOVE_2H ? chosenSlot ?? null : null,
        paymentMethod,
        ...(returnUrl ? { returnUrl } : {}),
        voucherCode: voucherEval?.valid ? voucherEval.voucherCode : null,
        packagingOptionId: activePackaging?.id ?? null,
        giftNote: giftNote.trim() ? giftNote.trim().slice(0, 140) : null,
        customerEmail: customerEmail.trim() || null,
        items: cart.items.map((item) => ({
          skuId: item.skuId,
          qty: item.qty,
          bundleGroupId: item.bundleGroupId,
          fromAiTryon: item.fromAiTryon,
        })),
      }),
    });

    setSubmitting(false);

    if (!res.ok || !res.data) {
      if (res.error?.code === ErrorCode.COD_RISK_DEPOSIT_REQUIRED) {
        setCodDepositNotice(
          res.error.message ||
            'Đơn hàng giá trị cao hoặc điểm tin cậy COD thấp yêu cầu thanh toán VietQR/VNPay hoặc cọc trước.',
        );
        setPaymentMethod(PaymentMethod.VIETQR);
      } else {
        setErrorMessage(
          res.error?.message || 'Không thể khởi tạo đơn hàng lúc này. Vui lòng thử lại.',
        );
      }
      return;
    }

    const order = res.data;
    emitCartUpdated(null);
    refreshCartCount();

    const externalPaymentUrl = order.paymentIntent?.paymentUrl;
    if (
      (order.paymentMethod === PaymentMethod.VNPAY ||
        order.paymentMethod === PaymentMethod.MOMO) &&
      typeof externalPaymentUrl === 'string' &&
      /^https?:\/\//i.test(externalPaymentUrl)
    ) {
      if (typeof window !== 'undefined') {
        try {
          window.sessionStorage.setItem(
            'atelier_pending_payment_v1',
            JSON.stringify({
              orderId: order.id,
              orderCode: order.orderCode,
              provider: order.paymentMethod,
              amountVnd: order.totalAmountVnd,
              createdAt: new Date().toISOString(),
            }),
          );
        } catch {
          // Ignore private-mode storage restrictions
        }
        window.location.assign(externalPaymentUrl);
      }
      return;
    }

    if (
      order.paymentMethod === PaymentMethod.VIETQR &&
      order.status === OrderStatus.AWAITING_PAYMENT
    ) {
      setCreatedOrder(order);
      return;
    }

    router.push(`/don-hang/${encodeURIComponent(order.orderCode)}`);
  };

  const handleSimulateDevWebhook = async () => {
    if (!createdOrder) return;
    setSimulatingPayment(true);
    setErrorMessage(null);

    const res = await apiFetch<unknown>(
      '/bff/v1/storefront/payments/dev-simulate-webhook',
      {
        method: 'POST',
        skipAuthRefresh: true,
        body: JSON.stringify({
          orderId: createdOrder.id,
          orderCode: createdOrder.orderCode,
          provider: PaymentProvider.VIETQR,
          amountVnd: createdOrder.totalAmountVnd,
          simulateLate: false,
        }),
      },
    );

    setSimulatingPayment(false);
    if (!res.ok) {
      setErrorMessage(
        res.error?.message || 'Không thể giả lập webhook thanh toán lúc này.',
      );
    }
  };

  const showDevSimulateButton =
    process.env.NEXT_PUBLIC_PAYMENT_MODE !== 'live';

  // VIETQR LIVE PAYMENT STAGE
  if (createdOrder && createdOrder.status === OrderStatus.AWAITING_PAYMENT) {
    const intent = createdOrder.paymentIntent;
    const qrPayload =
      intent?.vietQrPayload ||
      `VIETQR|TAMXUAN|${createdOrder.orderCode}|${createdOrder.totalAmountVnd}`;

    return (
      <div className="mx-auto max-w-3xl px-6 py-12 lg:px-10">
        <div className="rounded-[28px] border border-[#B08A4A]/40 bg-[#FBF7EF] p-7 shadow-xl sm:p-10">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#B08A4A]/25 pb-5">
            <div>
              <p className="eyebrow text-[#8A672C]">
                Thanh toán tự động VietQR · Giữ kho 15 phút
              </p>
              <h1 className="mt-1 font-editorial text-4xl font-light text-[#1C1410]">
                Đơn hàng #{createdOrder.orderCode}
              </h1>
            </div>
            <div className="rounded-full border border-[#B08A4A]/50 bg-[#1C1410] px-4 py-2 font-mono text-sm text-[#EBCF8F]">
              Còn {formatMmSs(countdownSec)}
            </div>
          </div>

          <div className="mt-7 grid items-center gap-8 md:grid-cols-[260px_1fr]">
            {/* VietQR Code Image or Styled Fallback */}
            <div className="mx-auto flex w-full max-w-[260px] flex-col items-center rounded-3xl border border-[#B08A4A]/35 bg-white p-5 shadow-md">
              {intent?.vietQrImageUrl ? (
                <img
                  src={intent.vietQrImageUrl}
                  alt={`Mã VietQR đơn hàng ${createdOrder.orderCode}`}
                  className="aspect-square w-full rounded-xl object-contain"
                />
              ) : (
                <div className="flex aspect-square w-full flex-col items-center justify-center rounded-xl border-2 border-dashed border-[#B08A4A]/45 bg-[#FBF7EF] p-4 text-center">
                  <span className="font-editorial text-2xl text-[#8A672C]">VietQR</span>
                  <span className="mt-2 font-mono text-[11px] break-all text-[#2B2019]">
                    {createdOrder.orderCode}
                  </span>
                </div>
              )}
              <p className="mt-3 text-center text-[11px] text-[#7A6A5B]">
                Mở ứng dụng ngân hàng để quét mã
              </p>
            </div>

            <div className="space-y-4">
              <div className="rounded-2xl border border-[#B08A4A]/25 bg-[#F4EBDA]/65 p-4 text-sm">
                <div className="flex items-baseline justify-between">
                  <span className="text-xs uppercase tracking-[0.18em] text-[#7A6A5B]">
                    Số tiền chuyển khoản
                  </span>
                  <b className="font-editorial text-3xl text-[#1C1410]">
                    {FORMAT_VND(createdOrder.totalAmountVnd)}
                  </b>
                </div>
                <div className="mt-3 flex items-center justify-between gap-2 border-t border-[#B08A4A]/20 pt-3 text-xs">
                  <span className="text-[#7A6A5B]">Nội dung chuyển khoản</span>
                  <code className="rounded bg-white px-2.5 py-1 font-mono font-medium text-[#1C1410]">
                    {createdOrder.orderCode}
                  </code>
                </div>
              </div>

              <div className="rounded-xl border border-[#B08A4A]/25 bg-white p-3 text-xs">
                <p className="text-[10px] uppercase tracking-[0.18em] text-[#8A672C]">
                  Chuỗi VietQR Payload
                </p>
                <div className="mt-1.5 flex items-center gap-2">
                  <input
                    type="text"
                    readOnly
                    value={qrPayload}
                    aria-label="VietQR Payload"
                    className="min-w-0 flex-1 rounded-lg bg-[#FBF7EF] px-2.5 py-1.5 font-mono text-[11px] text-[#2B2019]"
                  />
                  <button
                    type="button"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(qrPayload);
                        setCopiedPayload(true);
                      } catch {
                        // ignore clipboard restrictions
                      }
                    }}
                    className="shrink-0 rounded-lg bg-[#1C1410] px-3 py-1.5 text-[10px] uppercase tracking-[0.14em] text-[#EBCF8F]"
                  >
                    {copiedPayload ? 'Đã chép' : 'Sao chép'}
                  </button>
                </div>
              </div>

              <p className="text-xs leading-relaxed text-[#6B5B4C]">
                Trang đang lắng nghe tín hiệu đối soát thời gian thực qua Socket.io — sẽ tự
                động chuyển sang trang theo dõi đơn hàng ngay khi giao dịch hoàn tất.
              </p>

              {errorMessage ? (
                <p className="rounded-xl border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-900">
                  {errorMessage}
                </p>
              ) : null}

              <div className="flex flex-wrap items-center gap-3 pt-1">
                <Link
                  href={`/don-hang/${encodeURIComponent(createdOrder.orderCode)}`}
                  className="btn btn--line !px-5 !py-2.5 !text-xs"
                >
                  Theo dõi đơn #{createdOrder.orderCode}
                </Link>

                {showDevSimulateButton ? (
                  <button
                    type="button"
                    disabled={simulatingPayment}
                    onClick={() => void handleSimulateDevWebhook()}
                    className="rounded-full border border-[#8A672C]/50 bg-[#F4EBDA] px-4 py-2.5 text-[11px] font-medium tracking-[0.12em] text-[#5C431C] transition-colors hover:bg-[#EBCF8F] disabled:opacity-50"
                  >
                    {simulatingPayment
                      ? 'Đang gửi webhook đối soát...'
                      : 'Giả lập thanh toán thành công (Dev)'}
                  </button>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-7xl px-4 py-10 sm:px-6 lg:px-10 lg:py-14">
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-[#B08A4A]/25 pb-7">
        <div>
          <p className="eyebrow text-[#8A672C]">Thanh toán Một trang · Quiet Luxury</p>
          <h1 className="mt-2 font-editorial text-4xl font-light text-[#1C1410] sm:text-5xl">
            Hoàn tất đơn hàng Tầm Xuân
          </h1>
        </div>
        <Link
          href="/bo-suu-tap"
          className="text-xs uppercase tracking-[0.18em] text-[#8A672C] underline underline-offset-4"
        >
          ← Tiếp tục chọn thiết kế
        </Link>
      </div>

      {loading ? (
        <div className="py-16 text-center text-sm text-[#7A6A5B]">
          Đang đồng bộ túi đồ và sổ địa chỉ từ Atelier...
        </div>
      ) : !cart || cart.items.length === 0 ? (
        <div className="mx-auto my-14 max-w-lg rounded-[28px] border border-[#B08A4A]/30 bg-[#FBF7EF] p-10 text-center">
          <p className="eyebrow">Túi đồ đang trống</p>
          <h2 className="mt-2 font-editorial text-3xl text-[#1C1410]">
            Chưa có thiết kế nào sẵn sàng thanh toán
          </h2>
          <p className="mt-3 text-sm text-[#7A6A5B]">
            Chọn sản phẩm trên giá treo 3D hoặc phối trọn bộ tại Outfit Studio để nhận
            ưu đãi Combo −5% / −10%.
          </p>
          <div className="mt-6 flex flex-wrap justify-center gap-3">
            <Link href="/bo-suu-tap" className="btn btn--gold !py-3">
              Khám phá Bộ sưu tập
            </Link>
            <Link href="/phoi-do" className="btn btn--line !py-3">
              Mở Outfit Studio
            </Link>
          </div>
        </div>
      ) : (
        <div className="mt-9 grid items-start gap-8 lg:grid-cols-[1.28fr_0.92fr]">
          {/* LEFT: 3 STREAMLINED EDITORIAL STEPS */}
          <div className="space-y-8">
            {/* BƯỚC 1: ĐỊA CHỈ & GIAO VẬN THÔNG MINH */}
            <section className="rounded-[28px] border border-[#B08A4A]/28 bg-white/90 p-6 shadow-sm sm:p-7">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="eyebrow text-[#8A672C]">Bước 1 / 3</p>
                  <h2 className="mt-1 font-editorial text-3xl font-light text-[#1C1410]">
                    Địa chỉ &amp; Giao vận Thông minh
                  </h2>
                </div>
                {savedAddresses.length > 0 ? (
                  <span className="rounded-full bg-[#F4EBDA] px-3 py-1 text-[11px] text-[#8A672C]">
                    {savedAddresses.length} địa chỉ đã lưu
                  </span>
                ) : null}
              </div>

              {/* Saved Addresses quick picker when logged in */}
              {savedAddresses.length > 0 ? (
                <div className="mt-4 grid gap-2.5 sm:grid-cols-2">
                  {savedAddresses.map((addr) => {
                    const active = selectedAddressId === addr.id;
                    return (
                      <button
                        key={addr.id}
                        type="button"
                        onClick={() => applySavedAddress(addr)}
                        className={`rounded-2xl border p-3.5 text-left text-xs transition-colors ${
                          active
                            ? 'border-[#1C1410] bg-[#1C1410] text-[#FBF7EF]'
                            : 'border-[#B08A4A]/30 bg-[#FBF7EF] text-[#2B2019] hover:border-[#8A672C]'
                        }`}
                      >
                        <p className="font-medium">
                          {addr.recipientName} · {addr.phone}
                        </p>
                        <p className="mt-1 opacity-80">
                          {addr.streetLine}, {addr.wardName}, {addr.districtName},{' '}
                          {addr.provinceName}
                        </p>
                      </button>
                    );
                  })}
                </div>
              ) : null}

              {/* Inline Vietnamese Address Form */}
              <div className="mt-5 grid gap-3 sm:grid-cols-2">
                <label className="text-xs">
                  <span className="text-[#6B5B4C]">Họ tên người nhận *</span>
                  <input
                    type="text"
                    required
                    value={recipientName}
                    onChange={(e) => {
                      setSelectedAddressId('custom');
                      setRecipientName(e.target.value);
                    }}
                    placeholder="Nguyễn Minh Anh"
                    className="mt-1 w-full rounded-xl border border-[#B08A4A]/35 bg-[#FBF7EF]/60 px-3.5 py-2.5 text-sm text-[#1C1410] outline-none focus:border-[#8A672C]"
                  />
                </label>

                <label className="text-xs">
                  <span className="text-[#6B5B4C]">Số điện thoại *</span>
                  <input
                    type="tel"
                    required
                    value={phone}
                    onChange={(e) => {
                      setSelectedAddressId('custom');
                      setPhone(e.target.value);
                    }}
                    placeholder="0912345678"
                    className="mt-1 w-full rounded-xl border border-[#B08A4A]/35 bg-[#FBF7EF]/60 px-3.5 py-2.5 text-sm text-[#1C1410] outline-none focus:border-[#8A672C]"
                  />
                </label>

                <label className="text-xs sm:col-span-2">
                  <span className="text-[#6B5B4C]">Email nhận xác nhận &amp; ảnh đóng gói</span>
                  <input
                    type="email"
                    value={customerEmail}
                    onChange={(e) => setCustomerEmail(e.target.value)}
                    placeholder="ban@example.com"
                    className="mt-1 w-full rounded-xl border border-[#B08A4A]/35 bg-[#FBF7EF]/60 px-3.5 py-2.5 text-sm text-[#1C1410] outline-none focus:border-[#8A672C]"
                  />
                </label>

                <label className="text-xs">
                  <span className="text-[#6B5B4C]">Tỉnh / Thành phố *</span>
                  <select
                    required
                    value={division.provinceCode}
                    onChange={(e) => {
                      setSelectedAddressId('custom');
                      setDivision(selectProvinceCascade(e.target.value));
                    }}
                    data-testid="checkout-province-select"
                    className="mt-1 w-full rounded-xl border border-[#B08A4A]/35 bg-[#FBF7EF]/60 px-3.5 py-2.5 text-sm text-[#1C1410] outline-none focus:border-[#8A672C]"
                  >
                    {!VN_PROVINCES.some((p) => p.code === division.provinceCode) &&
                    division.provinceName ? (
                      <option value={division.provinceCode}>{division.provinceName}</option>
                    ) : null}
                    {VN_PROVINCES.map((p) => (
                      <option key={p.code} value={p.code}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="text-xs">
                  <span className="text-[#6B5B4C]">Quận / Huyện *</span>
                  <select
                    required
                    value={division.districtCode}
                    onChange={(e) => {
                      setSelectedAddressId('custom');
                      setDivision(
                        selectDistrictCascade(division.provinceCode, e.target.value),
                      );
                    }}
                    data-testid="checkout-district-select"
                    className="mt-1 w-full rounded-xl border border-[#B08A4A]/35 bg-[#FBF7EF]/60 px-3.5 py-2.5 text-sm text-[#1C1410] outline-none focus:border-[#8A672C]"
                  >
                    {(() => {
                      const districts = getDistrictsByProvinceCode(division.provinceCode);
                      const hasCurrent = districts.some(
                        (d) => d.code === division.districtCode,
                      );
                      return (
                        <>
                          {!hasCurrent && division.districtName ? (
                            <option value={division.districtCode}>
                              {division.districtName}
                            </option>
                          ) : null}
                          {districts.map((d) => (
                            <option key={d.code} value={d.code}>
                              {d.name}
                            </option>
                          ))}
                        </>
                      );
                    })()}
                  </select>
                </label>

                <label className="text-xs">
                  <span className="text-[#6B5B4C]">Phường / Xã *</span>
                  <select
                    required
                    value={division.wardCode}
                    onChange={(e) => {
                      setSelectedAddressId('custom');
                      setDivision(
                        selectWardCascade(
                          division.provinceCode,
                          division.districtCode,
                          e.target.value,
                        ),
                      );
                    }}
                    data-testid="checkout-ward-select"
                    className="mt-1 w-full rounded-xl border border-[#B08A4A]/35 bg-[#FBF7EF]/60 px-3.5 py-2.5 text-sm text-[#1C1410] outline-none focus:border-[#8A672C]"
                  >
                    {(() => {
                      const wards = getWardsByDistrictCode(
                        division.provinceCode,
                        division.districtCode,
                      );
                      const hasCurrent = wards.some((w) => w.code === division.wardCode);
                      return (
                        <>
                          {!hasCurrent && division.wardName ? (
                            <option value={division.wardCode}>{division.wardName}</option>
                          ) : null}
                          {wards.map((w) => (
                            <option key={w.code} value={w.code}>
                              {w.name}
                            </option>
                          ))}
                        </>
                      );
                    })()}
                  </select>
                </label>

                <label className="text-xs">
                  <span className="text-[#6B5B4C]">Số nhà, tên đường *</span>
                  <input
                    type="text"
                    required
                    value={streetLine}
                    onChange={(e) => {
                      setSelectedAddressId('custom');
                      setStreetLine(e.target.value);
                    }}
                    placeholder="18 Hàng Trống"
                    className="mt-1 w-full rounded-xl border border-[#B08A4A]/35 bg-[#FBF7EF]/60 px-3.5 py-2.5 text-sm text-[#1C1410] outline-none focus:border-[#8A672C]"
                  />
                </label>
              </div>

              {/* 4 Smart Shipping Methods */}
              <div className="mt-6 space-y-2.5 border-t border-[#B08A4A]/20 pt-5">
                <p className="text-[11px] font-medium uppercase tracking-[0.2em] text-[#8A672C]">
                  Chọn phương thức giao vận
                </p>

                <div className="grid gap-2.5 sm:grid-cols-2">
                  {[
                    {
                      method: ShippingMethod.AHAMOVE_2H,
                      title: 'Giao hỏa tốc 2 giờ (AHAMOVE_2H)',
                      desc: 'Chọn chính xác khung 2 giờ giao nội thành Hà Nội & TP.HCM.',
                      feeLabel: '45.000₫',
                    },
                    {
                      method: ShippingMethod.GHN,
                      title: 'GHN Tiêu chuẩn (1–3 ngày)',
                      desc: 'Hộp chống nhăn, đồng kiểm khi nhận hàng.',
                      feeLabel:
                        subtotalVnd - comboDiscountVnd >= freeShipThreshold
                          ? 'Miễn phí'
                          : '35.000₫',
                    },
                    {
                      method: ShippingMethod.GHTK,
                      title: 'GHTK Toàn quốc',
                      desc: 'Tiết kiệm, giao tận cửa khắp 63 tỉnh thành.',
                      feeLabel:
                        subtotalVnd - comboDiscountVnd >= freeShipThreshold
                          ? 'Miễn phí'
                          : '30.000₫',
                    },
                    {
                      method: ShippingMethod.PICKUP,
                      title: 'Nhận tại Showroom (PICKUP)',
                      desc: '18 Hàng Trống, Hoàn Kiếm — ướm thử và chỉnh gấu miễn phí.',
                      feeLabel: 'Miễn phí',
                    },
                  ].map((opt) => {
                    const selected = shippingMethod === opt.method;
                    return (
                      <button
                        key={opt.method}
                        type="button"
                        onClick={() => setShippingMethod(opt.method)}
                        className={`flex flex-col justify-between rounded-2xl border p-4 text-left transition-all ${
                          selected
                            ? 'border-[#1C1410] bg-[#1C1410] text-[#FBF7EF] shadow-md'
                            : 'border-[#B08A4A]/30 bg-[#FBF7EF]/70 text-[#2B2019] hover:border-[#8A672C]'
                        }`}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <span className="text-sm font-medium">{opt.title}</span>
                          <span
                            className={`shrink-0 text-xs font-medium ${
                              selected ? 'text-[#EBCF8F]' : 'text-[#8A672C]'
                            }`}
                          >
                            {opt.feeLabel}
                          </span>
                        </div>
                        <p className="mt-1.5 text-[11px] opacity-75">{opt.desc}</p>
                      </button>
                    );
                  })}
                </div>

                {/* Express 2H Day & 5 Two-Hour Slot Picker (#odDays & #odSlots) */}
                {shippingMethod === ShippingMethod.AHAMOVE_2H ? (
                  <div className="mt-4 space-y-3 rounded-2xl border border-[#B08A4A]/35 bg-[#F4EBDA]/60 p-4">
                    <p className="text-[11px] font-medium uppercase tracking-[0.2em] text-[#8A672C]">
                      Chọn ngày &amp; khung giờ giao hỏa tốc 2 giờ
                    </p>

                    <div id="odDays" className="seg grid grid-cols-3 gap-2">
                      {deliveryDays.map((day, idx) => {
                        const active = idx === deliveryDayIdx;
                        return (
                          <button
                            key={day.isoDate}
                            type="button"
                            aria-pressed={active}
                            onClick={() => setDeliveryDayIdx(idx)}
                            className={`flex flex-col items-center rounded-xl border px-3 py-2 text-center transition-colors ${
                              active
                                ? 'on border-[#1C1410] bg-[#1C1410] text-[#EBCF8F]'
                                : 'border-[#8A672C]/30 bg-white text-[#2B2019]'
                            }`}
                          >
                            <b className="font-editorial text-lg font-medium">{day.label}</b>
                            <small className="text-[11px] opacity-75">{day.dm}</small>
                          </button>
                        );
                      })}
                    </div>

                    <div id="odSlots" className="chips flex flex-wrap gap-2">
                      {TWO_HOUR_SLOTS.map((slot, idx) => {
                        const active = idx === deliverySlotIdx;
                        return (
                          <button
                            key={slot}
                            type="button"
                            aria-pressed={active}
                            onClick={() => setDeliverySlotIdx(idx)}
                            className={`rounded-full border px-3.5 py-1.5 text-xs transition-colors ${
                              active
                                ? 'on border-[#1C1410] bg-[#1C1410] text-[#EBCF8F]'
                                : 'border-[#8A672C]/30 bg-white text-[#2B2019]'
                            }`}
                          >
                            {slot}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ) : null}
              </div>
            </section>

            {/* BƯỚC 2: ƯU ĐÃI COMBO, VOUCHER & THIỆP QUÀ */}
            <section className="rounded-[28px] border border-[#B08A4A]/28 bg-white/90 p-6 shadow-sm sm:p-7">
              <p className="eyebrow text-[#8A672C]">Bước 2 / 3</p>
              <h2 className="mt-1 font-editorial text-3xl font-light text-[#1C1410]">
                Ưu đãi Combo, Mã Voucher &amp; Thiệp quà
              </h2>

              {/* Voucher Evaluation */}
              <div className="mt-5 space-y-2.5">
                <label
                  htmlFor="checkout-voucher"
                  className="block text-[11px] font-medium uppercase tracking-[0.2em] text-[#8A672C]"
                >
                  Mã ưu đãi Atelier
                </label>
                <div className="flex flex-wrap gap-2">
                  <input
                    id="checkout-voucher"
                    type="text"
                    value={voucherInput}
                    onChange={(e) => setVoucherInput(e.target.value.toUpperCase())}
                    placeholder="Nhập mã ưu đãi của bạn"
                    className="min-w-[200px] flex-1 rounded-full border border-[#B08A4A]/40 bg-[#FBF7EF] px-4 py-2.5 font-mono text-sm uppercase text-[#1C1410] outline-none focus:border-[#8A672C]"
                  />
                  <button
                    type="button"
                    disabled={evaluatingVoucher}
                    onClick={() => void handleEvaluateVoucher()}
                    className="rounded-full bg-[#1C1410] px-6 py-2.5 text-xs uppercase tracking-[0.16em] text-[#EBCF8F] disabled:opacity-50"
                  >
                    {evaluatingVoucher ? 'Đang kiểm tra...' : 'Áp dụng'}
                  </button>
                </div>

                <div
                  data-testid="checkout-live-promotions"
                  className="flex flex-wrap items-center gap-1.5"
                >
                  {promotionsLoading ? (
                    <span className="text-[11px] text-[#7A6A5B]">
                      Đang tải các chương trình ưu đãi đang mở...
                    </span>
                  ) : activePromotions.length > 0 ? (
                    activePromotions.map((promo) => {
                      const isApplied =
                        voucherEval?.valid &&
                        voucherEval.voucherCode?.toUpperCase() ===
                          promo.code.toUpperCase();
                      return (
                        <button
                          key={promo.id}
                          type="button"
                          data-testid="checkout-promo-chip"
                          onClick={() => void handleEvaluateVoucher(promo.code)}
                          className={`rounded-full border px-3 py-1 text-[11px] transition-colors ${
                            isApplied
                              ? 'border-[#1C1410] bg-[#1C1410] text-[#EBCF8F]'
                              : 'border-[#B08A4A]/35 bg-[#F4EBDA]/70 text-[#5C431C] hover:bg-[#EBCF8F]'
                          }`}
                        >
                          <strong>{promo.code}</strong> · {formatPromotionHint(promo)}
                        </button>
                      );
                    })
                  ) : (
                    <span className="text-[11px] text-[#7A6A5B]">
                      Hiện chưa có mã ưu đãi công khai nào đang mở — bạn vẫn có thể nhập mã
                      riêng nếu có.
                    </span>
                  )}
                </div>

                {voucherEval ? (
                  <p
                    role="status"
                    className={`rounded-xl px-3.5 py-2 text-xs ${
                      voucherEval.valid
                        ? 'border border-emerald-300 bg-emerald-50 text-emerald-900'
                        : 'border border-amber-300 bg-amber-50 text-amber-900'
                    }`}
                  >
                    {voucherEval.valid
                      ? `Đã áp dụng mã ${voucherEval.voucherCode}: tiết kiệm ${FORMAT_VND(voucherEval.totalDiscountVnd)} (phân bổ theo từng thiết kế).`
                      : voucherEval.reason || 'Mã ưu đãi chưa đủ điều kiện áp dụng.'}
                  </p>
                ) : null}
              </div>

              {/* Packaging + Live Slanted -4deg Dancing Script <GiftCardPreview /> */}
              <div className="mt-6 grid items-center gap-6 border-t border-[#B08A4A]/20 pt-5 md:grid-cols-2">
                <div className="space-y-4">
                  <div>
                    <p className="mb-2 text-[11px] font-medium uppercase tracking-[0.2em] text-[#8A672C]">
                      Hộp đóng gói Signature
                    </p>
                    <div className="space-y-2">
                      {packagingOptions.map((pkg) => {
                        const selected = pkg.id === activePackaging?.id;
                        return (
                          <button
                            key={pkg.id}
                            type="button"
                            onClick={() => setSelectedPkgId(pkg.id)}
                            className={`flex w-full items-center justify-between gap-2 rounded-xl border px-3 py-2 text-left text-xs transition-colors ${
                              selected
                                ? 'border-[#1C1410] bg-[#1C1410] text-[#EBCF8F]'
                                : 'border-[#B08A4A]/30 bg-[#FBF7EF] text-[#2B2019]'
                            }`}
                          >
                            <span className="flex items-center gap-2">
                              <span
                                className="h-3.5 w-3.5 shrink-0 rounded-full border border-black/15"
                                style={{ backgroundColor: pkg.swatchHex }}
                              />
                              <span>{pkg.name}</span>
                            </span>
                            <span className="shrink-0">
                              {pkg.priceVnd > 0 ? `+${FORMAT_VND(pkg.priceVnd)}` : 'Miễn phí'}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  <label className="block space-y-1.5">
                    <div className="flex items-center justify-between text-[11px] font-medium uppercase tracking-[0.2em] text-[#8A672C]">
                      <span>Lời nhắn thiệp viết tay</span>
                      <span className="font-mono text-[10px] text-[#7A6A5B]">
                        {giftNote.length}/140
                      </span>
                    </div>
                    <textarea
                      rows={3}
                      maxLength={140}
                      value={giftNote}
                      onChange={(e) => setGiftNote(e.target.value.slice(0, 140))}
                      placeholder="Viết vài dòng cho người nhận…"
                      className="w-full resize-none rounded-xl border border-[#B08A4A]/35 bg-[#FBF7EF] px-3.5 py-2.5 font-editorial text-lg text-[#1C1410] outline-none focus:border-[#8A672C]"
                    />
                  </label>
                </div>

                <div className="py-3">
                  <GiftCardPreview note={giftNote} visible inline />
                </div>
              </div>
            </section>

            {/* BƯỚC 3: THANH TOÁN & XÁC NHẬN */}
            <section className="rounded-[28px] border border-[#B08A4A]/28 bg-white/90 p-6 shadow-sm sm:p-7">
              <p className="eyebrow text-[#8A672C]">Bước 3 / 3</p>
              <h2 className="mt-1 font-editorial text-3xl font-light text-[#1C1410]">
                Cổng Thanh toán &amp; Bảo vệ Idempotency
              </h2>

              {codDepositNotice ? (
                <div className="mt-4 rounded-2xl border border-amber-400 bg-amber-50 p-4 text-xs text-amber-950">
                  <strong>Yêu cầu xác thực thanh toán trước (COD Risk Shield):</strong>{' '}
                  {codDepositNotice}
                </div>
              ) : null}

              <div className="mt-5 grid gap-3 sm:grid-cols-2">
                {[
                  {
                    method: PaymentMethod.VIETQR,
                    title: 'VietQR PayOS (Khuyên dùng)',
                    desc: 'Quét mã đối soát tự động 24/7, giữ kho 15 phút an toàn.',
                  },
                  {
                    method: PaymentMethod.VNPAY,
                    title: 'VNPay QR / Thẻ Quốc tế',
                    desc: 'Hỗ trợ ATM nội địa, Visa, Mastercard, JCB.',
                  },
                  {
                    method: PaymentMethod.MOMO,
                    title: 'Ví điện tử MoMo',
                    desc: 'Xác nhận nhanh trong 1 chạm trên ứng dụng MoMo.',
                  },
                  {
                    method: PaymentMethod.COD,
                    title: 'Thanh toán khi nhận hàng (COD)',
                    desc: 'Đồng kiểm trước khi thanh toán (áp dụng đánh giá điểm tin cậy).',
                  },
                ].map((opt) => {
                  const selected = paymentMethod === opt.method;
                  return (
                    <button
                      key={opt.method}
                      type="button"
                      onClick={() => setPaymentMethod(opt.method)}
                      className={`rounded-2xl border p-4 text-left transition-all ${
                        selected
                          ? 'border-[#1C1410] bg-[#1C1410] text-[#FBF7EF] shadow-md'
                          : 'border-[#B08A4A]/30 bg-[#FBF7EF]/70 text-[#2B2019] hover:border-[#8A672C]'
                      }`}
                    >
                      <p className="text-sm font-medium">{opt.title}</p>
                      <p className="mt-1 text-[11px] opacity-75">{opt.desc}</p>
                    </button>
                  );
                })}
              </div>
            </section>
          </div>

          {/* RIGHT STICKY: ORDER SUMMARY & SUBMIT CTA */}
          <aside className="space-y-5 lg:sticky lg:top-28">
            <div className="rounded-[28px] border border-[#B08A4A]/35 bg-[#F4EBDA]/75 p-6 shadow-md">
              <p className="eyebrow text-[#8A672C]">
                Tóm tắt đơn hàng · {cart.totalQty} sản phẩm
              </p>

              <ul className="mt-4 max-h-[300px] space-y-3 overflow-y-auto border-b border-[#B08A4A]/20 pb-4 pr-1">
                {cart.items.map((item) => (
                  <li key={item.id} className="flex items-center gap-3">
                    <div className="h-16 w-12 shrink-0 overflow-hidden rounded-xl border border-[#B08A4A]/25 bg-white p-1">
                      {item.imageUrl ? (
                        <img
                          src={item.imageUrl}
                          alt={item.productName}
                          className="h-full w-full object-contain"
                        />
                      ) : (
                        <div
                          className="h-full w-full rounded"
                          style={{ backgroundColor: item.colorHex }}
                        />
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-editorial text-lg leading-tight text-[#1C1410]">
                        {item.productName}
                      </p>
                      <p className="text-[11px] text-[#6B5B4C]">
                        {item.colorName} · Size {item.sizeCode} · SL {item.qty}
                      </p>
                    </div>
                    <span className="shrink-0 font-editorial text-base text-[#2B2019]">
                      {FORMAT_VND(item.lineTotalVnd)}
                    </span>
                  </li>
                ))}
              </ul>

              <div className="mt-4 space-y-2 text-xs text-[#5C4B41]">
                <div className="flex justify-between">
                  <span>Tạm tính trang phục</span>
                  <span>{FORMAT_VND(subtotalVnd)}</span>
                </div>
                {comboDiscountVnd > 0 ? (
                  <div className="flex justify-between font-medium text-[#8A672C]">
                    <span>Ưu đãi Combo Set (−{comboDiscountPct}%)</span>
                    <span>−{FORMAT_VND(comboDiscountVnd)}</span>
                  </div>
                ) : null}
                {voucherDiscountVnd > 0 ? (
                  <div className="flex justify-between font-medium text-emerald-800">
                    <span>Mã ưu đãi ({voucherEval?.voucherCode})</span>
                    <span>−{FORMAT_VND(voucherDiscountVnd)}</span>
                  </div>
                ) : null}
                <div className="flex justify-between">
                  <span>Đóng gói ({activePackaging?.name || 'Tiêu chuẩn'})</span>
                  <span>
                    {packagingPriceVnd > 0 ? `+${FORMAT_VND(packagingPriceVnd)}` : 'Miễn phí'}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span>Phí giao vận ({shippingMethod})</span>
                  <span>
                    {effectiveShippingFee > 0
                      ? `+${FORMAT_VND(effectiveShippingFee)}`
                      : 'Miễn phí'}
                  </span>
                </div>
              </div>

              <div className="mt-5 flex items-baseline justify-between border-t border-[#B08A4A]/25 pt-4">
                <span className="text-[11px] uppercase tracking-[0.2em] text-[#6B5B4C]">
                  Tổng thanh toán
                </span>
                <b className="font-editorial text-4xl font-medium text-[#1C1410]">
                  {FORMAT_VND(estimatedTotalVnd)}
                </b>
              </div>

              {errorMessage ? (
                <p
                  role="alert"
                  className="mt-4 rounded-xl border border-red-300 bg-red-50 px-3.5 py-2.5 text-xs text-red-900"
                >
                  {errorMessage}
                </p>
              ) : null}

              <button
                type="button"
                disabled={submitting}
                onClick={() => void handleSubmitOrder()}
                className="btn btn--gold mt-5 w-full !py-4 disabled:opacity-50"
              >
                {submitting
                  ? 'Đang giữ tồn kho & tạo đơn...'
                  : paymentMethod === PaymentMethod.VIETQR
                    ? 'Tạo mã VietQR & Đặt hàng'
                    : paymentMethod === PaymentMethod.VNPAY
                      ? 'Tiếp tục thanh toán VNPay'
                      : paymentMethod === PaymentMethod.MOMO
                        ? 'Tiếp tục thanh toán ví MoMo'
                        : 'Xác nhận đặt hàng Atelier'}
              </button>

              <p className="mt-3 text-center text-[11px] text-[#7A6A5B]">
                Bảo vệ chống trùng đơn bằng Idempotency-Key · Tồn kho giữ an toàn 15 phút.
              </p>
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}
