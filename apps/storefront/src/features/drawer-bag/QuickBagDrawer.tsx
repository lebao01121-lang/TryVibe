'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  HTTP_HEADERS,
  type CartDto,
  type CartItemDto,
  type PackagingOptionDto,
  type ProductSpuDto,
} from '@atelier/contracts';
import { useScrollLock } from '@atelier/motion-kit';
import { apiFetch } from '@/lib/api-client';
import { FORMAT_VND, getPrimaryVariantImage } from '@/lib/catalog-data';
import { GiftCardPreview } from './GiftCardPreview';

export interface QuickBagDrawerProps {
  open: boolean;
  onClose: () => void;
  quickProduct?: ProductSpuDto | null;
  packagingOptions: PackagingOptionDto[];
  onCartChange?: (cart: CartDto | null) => void;
}

const DEFAULT_FREESHIP_THRESHOLD = 2_000_000;
const GUEST_STORAGE_KEY = 'atelier_guest_session_id';

function getGuestHeader(): Record<string, string> {
  if (typeof window === 'undefined') return {};
  try {
    let guestId = window.localStorage.getItem(GUEST_STORAGE_KEY);
    if (!guestId) {
      guestId =
        typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? `guest-${crypto.randomUUID()}`
          : `guest-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      window.localStorage.setItem(GUEST_STORAGE_KEY, guestId);
    }
    return { [HTTP_HEADERS.GUEST_SESSION_ID]: guestId };
  } catch {
    return {};
  }
}

interface CartGroup {
  type: 'bundle' | 'single';
  bundleGroupId: string | null;
  items: CartItemDto[];
}

function groupCartItems(items: CartItemDto[]): CartGroup[] {
  const bundleBuckets = new Map<string, CartItemDto[]>();
  const orderedGroups: CartGroup[] = [];

  for (const item of items) {
    if (item.bundleGroupId) {
      let bucket = bundleBuckets.get(item.bundleGroupId);
      if (!bucket) {
        bucket = [];
        bundleBuckets.set(item.bundleGroupId, bucket);
        orderedGroups.push({
          type: 'bundle',
          bundleGroupId: item.bundleGroupId,
          items: bucket,
        });
      }
      bucket.push(item);
    } else {
      orderedGroups.push({
        type: 'single',
        bundleGroupId: null,
        items: [item],
      });
    }
  }

  return orderedGroups;
}

export function QuickBagDrawer({
  open,
  onClose,
  quickProduct,
  packagingOptions,
  onCartChange,
}: QuickBagDrawerProps) {
  useScrollLock(open);

  const [mode, setMode] = useState<'quick' | 'cart'>(quickProduct ? 'quick' : 'cart');
  const [cart, setCart] = useState<CartDto | null>(null);
  const [loadingCart, setLoadingCart] = useState(false);
  const [mutatingItemId, setMutatingItemId] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [toastMsg, setToastMsg] = useState<string | null>(null);

  // Quick Config state when opened with `quickProduct`
  const [quickVariantIdx, setQuickVariantIdx] = useState(0);
  const [quickSkuId, setQuickSkuId] = useState<string>('');
  const [addingQuick, setAddingQuick] = useState(false);

  // Shared packaging & 140-char calligraphic gift note synced with <GiftCardPreview />
  const defaultPkgId =
    packagingOptions.find((p) => p.isDefault)?.id ?? packagingOptions[0]?.id ?? '';
  const [selectedPkgId, setSelectedPkgId] = useState<string>(defaultPkgId);
  const [giftNote, setGiftNote] = useState<string>('');
  const [savingPkg, setSavingPkg] = useState(false);
  const noteDebounceRef = useRef<number | null>(null);

  const syncQuickProductDefaults = useCallback((product: ProductSpuDto | null | undefined) => {
    if (!product) return;
    setQuickVariantIdx(0);
    const firstVar = product.variants[0];
    const firstSku = firstVar?.skus.find((s) => s.inStock) ?? firstVar?.skus[0];
    setQuickSkuId(firstSku?.id ?? '');
  }, []);

  useEffect(() => {
    if (open) {
      setErrorMsg(null);
      setToastMsg(null);
      if (quickProduct) {
        setMode('quick');
        syncQuickProductDefaults(quickProduct);
      } else {
        setMode('cart');
      }
    }
  }, [open, quickProduct, syncQuickProductDefaults]);

  // Escape key closes drawer cleanly
  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  const fetchActiveCart = useCallback(async () => {
    setLoadingCart(true);
    setErrorMsg(null);
    const res = await apiFetch<CartDto>('/bff/v1/storefront/cart', {
      headers: getGuestHeader(),
      skipAuthRefresh: true,
    });
    setLoadingCart(false);

    if (res.ok && res.data) {
      setCart(res.data);
      if (res.data.packagingOptionId) {
        setSelectedPkgId(res.data.packagingOptionId);
      }
      if (res.data.giftNote != null) {
        setGiftNote(res.data.giftNote);
      }
      onCartChange?.(res.data);
    } else if (!res.ok) {
      setErrorMsg(res.error?.message || 'Chưa thể tải giỏ hàng từ BFF.');
    }
  }, [onCartChange]);

  useEffect(() => {
    if (open) {
      void fetchActiveCart();
    }
  }, [open, fetchActiveCart]);

  const persistPackaging = useCallback(
    async (pkgId: string, note: string) => {
      setSavingPkg(true);
      const res = await apiFetch<CartDto>('/bff/v1/storefront/cart/packaging', {
        method: 'PUT',
        headers: getGuestHeader(),
        body: JSON.stringify({
          packagingOptionId: pkgId || null,
          giftNote: note.slice(0, 140),
        }),
      });
      setSavingPkg(false);
      if (res.ok && res.data) {
        setCart(res.data);
        onCartChange?.(res.data);
      }
    },
    [onCartChange],
  );

  const handleSelectPackaging = (pkgId: string) => {
    setSelectedPkgId(pkgId);
    if (mode === 'cart' && cart && cart.items.length > 0) {
      void persistPackaging(pkgId, giftNote);
    }
  };

  const handleGiftNoteChange = (nextNote: string) => {
    const trimmedMax = nextNote.slice(0, 140);
    setGiftNote(trimmedMax);

    if (mode === 'cart' && cart && cart.items.length > 0) {
      if (noteDebounceRef.current !== null) {
        window.clearTimeout(noteDebounceRef.current);
      }
      noteDebounceRef.current = window.setTimeout(() => {
        void persistPackaging(selectedPkgId, trimmedMax);
      }, 450);
    }
  };

  useEffect(() => {
    return () => {
      if (noteDebounceRef.current !== null) {
        window.clearTimeout(noteDebounceRef.current);
      }
    };
  }, []);

  const handleQuickAddToCart = async () => {
    if (!quickProduct) return;
    const variant = quickProduct.variants[quickVariantIdx] ?? quickProduct.variants[0];
    const sku =
      variant?.skus.find((s) => s.id === quickSkuId) ??
      variant?.skus.find((s) => s.inStock) ??
      variant?.skus[0];
    if (!sku) {
      setErrorMsg('Vui lòng chọn cỡ trang phục còn hàng.');
      return;
    }

    setAddingQuick(true);
    setErrorMsg(null);

    const addRes = await apiFetch<CartDto>('/bff/v1/storefront/cart/items', {
      method: 'POST',
      headers: getGuestHeader(),
      body: JSON.stringify({
        skuId: sku.id,
        productId: quickProduct.id,
        variantId: variant?.id,
        qty: 1,
        fromAiTryon: false,
      }),
    });

    if (!addRes.ok) {
      setAddingQuick(false);
      setErrorMsg(addRes.error?.message || 'Không thể thêm sản phẩm vào giỏ hàng.');
      return;
    }

    let finalCart = addRes.data;
    if (selectedPkgId || giftNote.trim()) {
      const pkgRes = await apiFetch<CartDto>('/bff/v1/storefront/cart/packaging', {
        method: 'PUT',
        headers: getGuestHeader(),
        body: JSON.stringify({
          packagingOptionId: selectedPkgId || null,
          giftNote: giftNote.trim() || null,
        }),
      });
      if (pkgRes.ok && pkgRes.data) {
        finalCart = pkgRes.data;
      }
    }

    setAddingQuick(false);
    if (finalCart) {
      setCart(finalCart);
      onCartChange?.(finalCart);
    }
    setToastMsg(`Đã thêm ${quickProduct.name} (${sku.sizeCode}) vào giỏ hàng.`);
    setMode('cart');
  };

  const handleUpdateQty = async (itemId: string, nextQty: number) => {
    setMutatingItemId(itemId);
    setErrorMsg(null);

    if (nextQty <= 0) {
      const res = await apiFetch<CartDto>(
        `/bff/v1/storefront/cart/items/${encodeURIComponent(itemId)}`,
        {
          method: 'DELETE',
          headers: getGuestHeader(),
        },
      );
      setMutatingItemId(null);
      if (res.ok && res.data) {
        setCart(res.data);
        onCartChange?.(res.data);
      } else {
        setErrorMsg(res.error?.message || 'Không thể xóa sản phẩm khỏi giỏ.');
      }
      return;
    }

    const res = await apiFetch<CartDto>(
      `/bff/v1/storefront/cart/items/${encodeURIComponent(itemId)}`,
      {
        method: 'PATCH',
        headers: getGuestHeader(),
        body: JSON.stringify({ qty: nextQty }),
      },
    );
    setMutatingItemId(null);
    if (res.ok && res.data) {
      setCart(res.data);
      onCartChange?.(res.data);
    } else {
      setErrorMsg(res.error?.message || 'Không thể cập nhật số lượng.');
    }
  };

  const groupedCart = useMemo(
    () => groupCartItems(cart?.items ?? []),
    [cart?.items],
  );

  const activeQuickVariant = quickProduct
    ? quickProduct.variants[quickVariantIdx] ?? quickProduct.variants[0]
    : null;
  const activeQuickSku = activeQuickVariant
    ? activeQuickVariant.skus.find((s) => s.id === quickSkuId) ??
      activeQuickVariant.skus[0]
    : null;
  const activePkgObj =
    packagingOptions.find((p) => p.id === selectedPkgId) ?? packagingOptions[0] ?? null;

  const freeShipThreshold =
    cart?.freeShipThresholdVnd ?? DEFAULT_FREESHIP_THRESHOLD;
  const subtotalForShip = cart?.subtotalVnd ?? 0;
  const remainingShip =
    cart?.remainingForFreeShipVnd ??
    Math.max(0, freeShipThreshold - subtotalForShip);
  const shipProgressPct = Math.min(
    100,
    Math.round((subtotalForShip / Math.max(1, freeShipThreshold)) * 100),
  );

  return (
    <aside
      id="order"
      className={`order fixed inset-0 z-[85] ${
        open
          ? 'on pointer-events-auto visible'
          : 'pointer-events-none invisible'
      }`}
      aria-hidden={!open}
      data-lenis-prevent=""
      style={{
        transition: open ? 'none' : 'visibility 0s 0.65s',
      }}
    >
      {/* Translucent Backdrop Scrim (.order__scrim) */}
      <div
        className="order__scrim absolute inset-0 bg-[#140E0A]/60 backdrop-blur-[3px] transition-opacity duration-500"
        style={{ opacity: open ? 1 : 0 }}
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Floating Slanted Ivory Gift Card (.order__card) on Desktop */}
      <GiftCardPreview note={giftNote} visible={open} />

      {/* Right Slide-Over Drawer Panel (.order__panel) */}
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="odDrawerTitle"
        className="order__panel absolute inset-y-0 right-0 flex w-[min(470px,92vw)] flex-col overflow-hidden bg-[#FBF7EF] text-[#2B2019] shadow-[-30px_0_80px_-20px_rgba(0,0,0,0.45)]"
        style={{
          transform: open ? 'translateX(0)' : 'translateX(102%)',
          transition: 'transform 0.65s cubic-bezier(0.22, 0.8, 0.22, 1)',
        }}
      >
        {/* Header */}
        <header className="order__head flex items-center justify-between border-b border-[#8A672C]/20 px-6 py-4">
          <div>
            <p className="eyebrow">Túi đồ · Tầm Xuân Atelier</p>
            <h2 id="odDrawerTitle" className="font-editorial text-2xl text-[#1C1410]">
              {mode === 'quick' && quickProduct
                ? 'Chọn nhanh thiết kế'
                : `Giỏ hàng (${cart?.totalQty ?? 0})`}
            </h2>
          </div>

          <button
            type="button"
            onClick={onClose}
            aria-label="Đóng ngăn kéo giỏ hàng"
            className="order__x flex h-9 w-9 items-center justify-center rounded-full border border-[#8A672C]/35 text-xl leading-none text-[#8A672C] transition-colors hover:bg-[#F4EBDA]"
          >
            ×
          </button>
        </header>

        {/* Mode Switcher when opened with `quickProduct` */}
        {quickProduct ? (
          <div className="flex gap-2 border-b border-[#8A672C]/15 bg-[#F4EBDA]/55 px-6 py-2.5">
            <button
              type="button"
              onClick={() => setMode('quick')}
              className={`rounded-full px-3.5 py-1 text-[11px] tracking-[0.14em] uppercase transition-colors ${
                mode === 'quick'
                  ? 'bg-[#1C1410] text-[#EBCF8F]'
                  : 'text-[#6B5B4C] hover:text-[#1C1410]'
              }`}
            >
              Chọn nhanh
            </button>
            <button
              type="button"
              onClick={() => setMode('cart')}
              className={`rounded-full px-3.5 py-1 text-[11px] tracking-[0.14em] uppercase transition-colors ${
                mode === 'cart'
                  ? 'bg-[#1C1410] text-[#EBCF8F]'
                  : 'text-[#6B5B4C] hover:text-[#1C1410]'
              }`}
            >
              Giỏ hàng ({cart?.totalQty ?? 0})
            </button>
          </div>
        ) : null}

        {/* Scrollable Body */}
        <div className="flex-1 space-y-5 overflow-y-auto px-6 py-5" data-lenis-prevent="">
          {errorMsg ? (
            <p className="rounded-xl border border-red-300 bg-red-50 px-3.5 py-2.5 text-xs text-red-900">
              {errorMsg}
            </p>
          ) : null}

          {toastMsg ? (
            <p
              role="status"
              className="rounded-xl border border-[#B08A4A]/45 bg-[#F4EBDA] px-3.5 py-2.5 text-xs text-[#2B2019]"
            >
              {toastMsg}
            </p>
          ) : null}

          {/* MODE 1: QUICK CONFIG */}
          {mode === 'quick' && quickProduct ? (
            <div className="space-y-5">
              <div className="order__item flex items-center gap-4 rounded-2xl bg-gradient-to-br from-[#F6EEDF] to-[#FBF7EF] p-3.5 border border-[#B08A4A]/20">
                <span className="order__thumb h-24 w-16 shrink-0 overflow-hidden rounded-xl bg-white p-1">
                  <img
                    src={getPrimaryVariantImage(quickProduct, quickVariantIdx).lookbookUrl}
                    alt={quickProduct.name}
                    className="h-full w-full object-contain"
                  />
                </span>
                <div className="min-w-0 flex-1">
                  <h3 className="font-editorial text-2xl leading-tight text-[#1C1410]">
                    {quickProduct.name}
                  </h3>
                  <p className="mt-1 text-xs text-[#6B5B4C]">
                    {quickProduct.fabricComposition}
                  </p>
                  <p className="mt-1.5 font-editorial text-xl text-[#8A672C]">
                    {FORMAT_VND(activeQuickSku?.salePriceVnd ?? quickProduct.minPriceVnd)}
                  </p>
                </div>
              </div>

              {/* Color Swatches */}
              <div className="space-y-2">
                <p className="text-[11px] font-medium tracking-[0.22em] uppercase text-[#8A672C]">
                  Màu sắc · {activeQuickVariant?.colorName}
                </p>
                <div className="flex flex-wrap gap-2">
                  {quickProduct.variants.map((variant, idx) => {
                    const selected = idx === quickVariantIdx;
                    return (
                      <button
                        key={variant.id}
                        type="button"
                        onClick={() => {
                          setQuickVariantIdx(idx);
                          const nextSku =
                            variant.skus.find((s) => s.inStock) ?? variant.skus[0];
                          setQuickSkuId(nextSku?.id ?? '');
                        }}
                        className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs transition-colors ${
                          selected
                            ? 'border-[#1C1410] bg-[#1C1410] text-[#EBCF8F]'
                            : 'border-[#8A672C]/30 bg-white text-[#2B2019]'
                        }`}
                      >
                        <span
                          className="h-3.5 w-3.5 rounded-full border border-black/20"
                          style={{ backgroundColor: variant.colorHex }}
                        />
                        {variant.colorName}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Size Pills */}
              <div className="space-y-2">
                <p className="text-[11px] font-medium tracking-[0.22em] uppercase text-[#8A672C]">
                  Kích cỡ
                </p>
                <div className="flex flex-wrap gap-2">
                  {(activeQuickVariant?.skus ?? []).map((sku) => {
                    const selected = sku.id === activeQuickSku?.id;
                    return (
                      <button
                        key={sku.id}
                        type="button"
                        disabled={!sku.inStock}
                        onClick={() => setQuickSkuId(sku.id)}
                        className={`min-w-[44px] rounded-xl border px-3 py-2 text-xs font-medium transition-colors ${
                          selected
                            ? 'border-[#1C1410] bg-[#1C1410] text-[#EBCF8F]'
                            : !sku.inStock
                              ? 'cursor-not-allowed border-black/10 text-[#9B8C7D] line-through opacity-50'
                              : 'border-[#8A672C]/30 bg-white text-[#2B2019] hover:border-[#8A672C]'
                        }`}
                      >
                        {sku.sizeCode}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          ) : (
            /* MODE 2: ACTIVE CART */
            <div className="space-y-4">
              {/* Freeship Progress Bar (2.000.000₫) */}
              <div className="rounded-2xl border border-[#B08A4A]/25 bg-[#F4EBDA]/60 p-3.5">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-medium text-[#2B2019]">
                    {remainingShip === 0 && subtotalForShip > 0
                      ? 'Đạt Miễn phí giao hỏa tốc Atelier!'
                      : `Thêm ${FORMAT_VND(remainingShip)} để Freeship`}
                  </span>
                  <span className="font-mono text-[11px] text-[#8A672C]">
                    {shipProgressPct}%
                  </span>
                </div>
                <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-[#E5D7BF]">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-[#8A672C] to-[#EBCF8F] transition-all duration-500"
                    style={{ width: `${shipProgressPct}%` }}
                  />
                </div>
              </div>

              {loadingCart && !cart ? (
                <p className="py-10 text-center text-sm text-[#7A6A5B]">
                  Đang đồng bộ túi đồ từ xưởng...
                </p>
              ) : groupedCart.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-[#B08A4A]/35 px-4 py-10 text-center">
                  <p className="font-editorial text-2xl italic text-[#7A6A5B]">
                    Túi đồ của bạn đang trống
                  </p>
                  <p className="mt-1.5 text-xs text-[#7A6A5B]">
                    Khám phá giá treo 3D hoặc phối ngay 1 bộ trang phục để nhận ưu đãi Combo.
                  </p>
                  <Link
                    href="/bo-suu-tap"
                    onClick={onClose}
                    className="btn btn--line mt-5 !px-5 !py-2.5 !text-xs"
                  >
                    Khám phá Bộ sưu tập
                  </Link>
                </div>
              ) : (
                <div className="space-y-3.5">
                  {groupedCart.map((group) => {
                    const isBundle = group.type === 'bundle' && group.items.length >= 2;
                    const bundlePct =
                      cart?.comboDiscountPct && cart.comboDiscountPct > 0
                        ? cart.comboDiscountPct
                        : group.items.length >= 3
                          ? 10
                          : 5;

                    return (
                      <div
                        key={group.bundleGroupId ?? group.items[0]!.id}
                        className={`rounded-2xl border p-3.5 ${
                          isBundle
                            ? 'border-[#B08A4A]/55 bg-gradient-to-br from-[#FBF7EF] to-[#F4EBDA]/65'
                            : 'border-[#B08A4A]/20 bg-white'
                        }`}
                      >
                        {isBundle ? (
                          <div className="mb-2.5 flex items-center justify-between border-b border-[#B08A4A]/20 pb-2">
                            <span className="text-[10px] font-medium tracking-[0.2em] uppercase text-[#8A672C]">
                              Outfit Bundle · {group.items.length} thiết kế
                            </span>
                            <span className="rounded-full bg-[#1C1410] px-2.5 py-0.5 text-[10px] font-medium tracking-[0.12em] text-[#EBCF8F]">
                              Combo −{bundlePct}%
                            </span>
                          </div>
                        ) : null}

                        <ul className="space-y-3">
                          {group.items.map((item) => {
                            const busy = mutatingItemId === item.id;
                            return (
                              <li
                                key={item.id}
                                className="flex items-start gap-3"
                              >
                                <Link
                                  href={`/san-pham/${item.slug}`}
                                  onClick={onClose}
                                  className="h-20 w-14 shrink-0 overflow-hidden rounded-xl border border-[#B08A4A]/20 bg-[#F8F4EC] p-1"
                                >
                                  {item.imageUrl ? (
                                    <img
                                      src={item.imageUrl}
                                      alt={item.productName}
                                      className="h-full w-full object-contain"
                                    />
                                  ) : (
                                    <div
                                      className="h-full w-full rounded-lg"
                                      style={{ backgroundColor: item.colorHex }}
                                    />
                                  )}
                                </Link>

                                <div className="min-w-0 flex-1">
                                  <div className="flex items-start justify-between gap-2">
                                    <Link
                                      href={`/san-pham/${item.slug}`}
                                      onClick={onClose}
                                      className="truncate font-editorial text-lg leading-tight text-[#1C1410] hover:text-[#8A672C]"
                                    >
                                      {item.productName}
                                    </Link>
                                    <button
                                      type="button"
                                      disabled={busy}
                                      onClick={() => void handleUpdateQty(item.id, 0)}
                                      aria-label={`Xóa ${item.productName}`}
                                      className="text-xs text-[#7A6A5B] hover:text-red-700"
                                    >
                                      ×
                                    </button>
                                  </div>

                                  <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-[#6B5B4C]">
                                    <span
                                      className="inline-block h-2.5 w-2.5 rounded-full border border-black/15"
                                      style={{ backgroundColor: item.colorHex }}
                                    />
                                    <span>{item.colorName}</span>
                                    <span>·</span>
                                    <span>Size {item.sizeCode}</span>
                                    {item.fromAiTryon ? (
                                      <span className="rounded-full border border-[#B08A4A]/50 bg-[#F4EBDA] px-2 py-0.5 text-[9px] tracking-[0.12em] uppercase text-[#8A672C]">
                                        Đã ướm thử AI
                                      </span>
                                    ) : null}
                                  </div>

                                  {item.lowStockWarning ? (
                                    <p className="mt-1 text-[10px] font-medium text-amber-800">
                                      Chỉ còn {item.availableQty} chiếc tại xưởng
                                    </p>
                                  ) : null}

                                  <div className="mt-2 flex items-center justify-between">
                                    <div className="inline-flex items-center rounded-full border border-[#8A672C]/35 bg-[#FBF7EF]">
                                      <button
                                        type="button"
                                        disabled={busy}
                                        onClick={() =>
                                          void handleUpdateQty(item.id, item.qty - 1)
                                        }
                                        aria-label="Giảm số lượng"
                                        className="px-2.5 py-0.5 text-sm text-[#2B2019] hover:text-[#8A672C] disabled:opacity-40"
                                      >
                                        −
                                      </button>
                                      <span className="min-w-[22px] text-center font-mono text-xs">
                                        {item.qty}
                                      </span>
                                      <button
                                        type="button"
                                        disabled={busy || item.qty >= item.availableQty}
                                        onClick={() =>
                                          void handleUpdateQty(item.id, item.qty + 1)
                                        }
                                        aria-label="Tăng số lượng"
                                        className="px-2.5 py-0.5 text-sm text-[#2B2019] hover:text-[#8A672C] disabled:opacity-40"
                                      >
                                        +
                                      </button>
                                    </div>

                                    <span className="font-editorial text-base font-medium text-[#1C1410]">
                                      {FORMAT_VND(item.lineTotalVnd)}
                                    </span>
                                  </div>
                                </div>
                              </li>
                            );
                          })}
                        </ul>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* Shared Packaging Selector & 140-char Calligraphic Gift Note (synced live with <GiftCardPreview />) */}
          {(mode === 'quick' && quickProduct) || groupedCart.length > 0 ? (
            <div className="space-y-4 border-t border-[#8A672C]/20 pt-4">
              <div>
                <div className="mb-2 flex items-center justify-between">
                  <p className="text-[11px] font-medium tracking-[0.22em] uppercase text-[#8A672C]">
                    Đóng gói quà tặng
                  </p>
                  {savingPkg ? (
                    <span className="text-[10px] text-[#7A6A5B]">Đang lưu...</span>
                  ) : null}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {packagingOptions.map((pkg) => {
                    const selected = pkg.id === activePkgObj?.id;
                    return (
                      <button
                        key={pkg.id}
                        type="button"
                        onClick={() => handleSelectPackaging(pkg.id)}
                        className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs transition-colors ${
                          selected
                            ? 'border-[#1C1410] bg-[#1C1410] text-[#EBCF8F]'
                            : 'border-[#8A672C]/30 bg-white text-[#2B2019]'
                        }`}
                      >
                        <span
                          className="h-3.5 w-3.5 rounded-full border border-black/20"
                          style={{ backgroundColor: pkg.swatchHex }}
                        />
                        <span>{pkg.name}</span>
                        {pkg.priceVnd > 0 ? (
                          <small className="opacity-75">
                            +{FORMAT_VND(pkg.priceVnd)}
                          </small>
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              </div>

              <label className="block space-y-1.5">
                <div className="flex items-center justify-between text-[11px] font-medium tracking-[0.22em] uppercase text-[#8A672C]">
                  <span>Lời nhắn trên thiệp viết tay</span>
                  <span className="font-mono text-[10px] text-[#7A6A5B]">
                    {giftNote.length}/140
                  </span>
                </div>
                <textarea
                  id="odMsg"
                  rows={2}
                  maxLength={140}
                  value={giftNote}
                  onChange={(e) => handleGiftNoteChange(e.target.value)}
                  placeholder="Viết vài dòng cho người nhận…"
                  className="w-full resize-none border-0 border-b border-[#8A672C]/45 bg-transparent py-1.5 font-editorial text-lg leading-snug text-[#2B2019] outline-none focus:border-[#8A672C]"
                />
              </label>
            </div>
          ) : null}
        </div>

        {/* Sticky Footer Summary + Primary CTA */}
        <footer className="order__foot border-t border-[#8A672C]/20 bg-gradient-to-b from-[#FBF7EF]/90 to-[#FBF7EF] px-6 py-4">
          {mode === 'quick' && quickProduct ? (
            <div className="flex items-center justify-between gap-4">
              <div>
                <small className="block text-[10px] tracking-[0.22em] uppercase text-[#6B5B4C]">
                  Tạm tính
                </small>
                <b className="font-editorial text-3xl font-medium text-[#1C1410]">
                  {FORMAT_VND(
                    (activeQuickSku?.salePriceVnd ?? quickProduct.minPriceVnd) +
                      (activePkgObj?.priceVnd ?? 0),
                  )}
                </b>
              </div>
              <button
                type="button"
                disabled={addingQuick}
                onClick={() => void handleQuickAddToCart()}
                className="btn btn--gold !px-6 !py-3.5 disabled:opacity-50"
              >
                {addingQuick ? 'Đang thêm...' : 'Thêm vào giỏ hàng'}
              </button>
            </div>
          ) : (
            <div className="space-y-3">
              {cart && cart.items.length > 0 ? (
                <div className="space-y-1 text-xs text-[#6B5B4C]">
                  <div className="flex justify-between">
                    <span>Tạm tính ({cart.totalQty} sản phẩm)</span>
                    <span>{FORMAT_VND(cart.subtotalVnd)}</span>
                  </div>
                  {cart.comboDiscountVnd > 0 ? (
                    <div className="flex justify-between font-medium text-[#8A672C]">
                      <span>Ưu đãi Combo (−{cart.comboDiscountPct}%)</span>
                      <span>−{FORMAT_VND(cart.comboDiscountVnd)}</span>
                    </div>
                  ) : null}
                  {cart.packagingPriceVnd > 0 ? (
                    <div className="flex justify-between">
                      <span>{cart.packagingName || 'Đóng gói Signature'}</span>
                      <span>+{FORMAT_VND(cart.packagingPriceVnd)}</span>
                    </div>
                  ) : null}
                </div>
              ) : null}

              <div className="flex items-center justify-between gap-4 pt-1">
                <div>
                  <small className="block text-[10px] tracking-[0.22em] uppercase text-[#6B5B4C]">
                    Tổng thanh toán
                  </small>
                  <b className="font-editorial text-3xl font-medium text-[#1C1410]">
                    {cart && cart.items.length > 0 ? FORMAT_VND(cart.totalVnd) : '—'}
                  </b>
                </div>

                <Link
                  href="/thanh-toan"
                  onClick={onClose}
                  className={`btn btn--gold !px-6 !py-3.5 ${
                    !cart || cart.items.length === 0
                      ? 'pointer-events-none opacity-45'
                      : ''
                  }`}
                >
                  Tiến hành thanh toán
                </Link>
              </div>
            </div>
          )}
        </footer>
      </div>
    </aside>
  );
}
