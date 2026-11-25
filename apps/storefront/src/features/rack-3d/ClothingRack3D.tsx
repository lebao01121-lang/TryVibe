'use client';

import { useGSAP } from '@gsap/react';
import { useLenis } from 'lenis/react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import {
  Component,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ErrorInfo,
  type ReactNode,
} from 'react';
import {
  TryOnGarmentCategory,
  TryOnMode,
  type CartDto,
  type RackGarmentItemDto,
  type RackGarmentVariantDto,
} from '@atelier/contracts';
import {
  useCameraGpuPaused,
  useMotionState,
  usePrefersReducedMotion,
} from '@atelier/motion-kit';
import { showAtelierToast } from '@/components/AtelierToastProvider';
import { apiFetch } from '@/lib/api-client';
import { FORMAT_VND } from '@/lib/catalog-data';
import { ensureGsapRegistered, gsap, ScrollTrigger } from '@/lib/gsap-setup';
import { useAdaptivePerformance } from '@/lib/performance/AdaptivePerformanceProvider';
import {
  emitCartUpdated,
  openQuickBagDrawer,
  openVirtualTryOnModal,
  type OpenTryOnOptions,
  type TryOnGarmentRef,
} from '@/lib/storefront-actions';
import { FlatRackFallback, type RackBagFeedback } from './FlatRackFallback';
import { plateau } from './physics/springPendulum';

const ALL_STANDARD_SIZES = ['XS', 'S', 'M', 'L', 'XL'] as const;
const BODY_PROFILE_STORAGE_KEY = 'atelier_body_profile_v1';

const RackCanvasR3F = dynamic(() => import('./RackCanvasR3F'), {
  ssr: false,
  loading: () => (
    <div
      className="pointer-events-none absolute inset-0 flex items-center justify-center"
      aria-hidden="true"
    >
      <div className="aspect-[2/3] w-56 rounded-3xl border border-[#EBCF8F]/25 bg-[#F4EBDA]/10 shadow-inner" />
    </div>
  ),
});

export interface ClothingRack3DProps {
  items: RackGarmentItemDto[];
}

interface WebGLBoundaryProps {
  onError: () => void;
  children: ReactNode;
}

interface WebGLBoundaryState {
  hasError: boolean;
}

class RackWebGLErrorBoundary extends Component<WebGLBoundaryProps, WebGLBoundaryState> {
  override state: WebGLBoundaryState = { hasError: false };

  static getDerivedStateFromError(): WebGLBoundaryState {
    return { hasError: true };
  }

  override componentDidCatch(_error: Error, _info: ErrorInfo): void {
    this.props.onError();
  }

  override render(): ReactNode {
    if (this.state.hasError) {
      return null;
    }
    return this.props.children;
  }
}

function detectWebGLSupport(): boolean {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return false;
  }
  try {
    const probe = document.createElement('canvas');
    const gl =
      probe.getContext('webgl2') ||
      probe.getContext('webgl') ||
      probe.getContext('experimental-webgl');
    if (!gl) {
      return false;
    }
    const loseExt = (gl as WebGLRenderingContext).getExtension('WEBGL_lose_context');
    loseExt?.loseContext();
    return true;
  } catch {
    return false;
  }
}

function readStoredRecommendedSize(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(BODY_PROFILE_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as { recommendedSize?: unknown } | null;
      if (
        parsed &&
        typeof parsed.recommendedSize === 'string' &&
        parsed.recommendedSize.trim()
      ) {
        return parsed.recommendedSize.trim().toUpperCase();
      }
    }
    const fallbackSession = window.sessionStorage.getItem(
      'atelier_last_recommended_size',
    );
    return fallbackSession ? fallbackSession.trim().toUpperCase() : null;
  } catch {
    return null;
  }
}

function isOuterwearRackItem(item: RackGarmentItemDto): boolean {
  const text = `${item.slug} ${item.name}`.toLowerCase();
  return (
    text.includes('blazer') ||
    text.includes('trench') ||
    text.includes('coat') ||
    text.includes('jacket') ||
    text.includes('ao-khoac') ||
    text.includes('áo khoác') ||
    text.includes('măng tô') ||
    text.includes('mang-to') ||
    text.includes('tweed') ||
    text.includes('cardigan')
  );
}

function buildRackTryOnOptions(
  item: RackGarmentItemDto,
  variant: RackGarmentVariantDto | undefined,
  skuId: string | undefined,
): OpenTryOnOptions {
  const garmentRef: TryOnGarmentRef & { colorHex?: string } = {
    productId: item.productId,
    variantId: variant?.id,
    skuId,
    slug: item.slug,
    productName: item.name,
    imageUrl:
      variant?.tryonFlatPreviewUrl ||
      variant?.frontCutoutUrl ||
      variant?.lookbookMainUrl ||
      null,
    colorHex: variant?.colorHex,
  };

  if (item.tryonGarmentCategory === TryOnGarmentCategory.OVERALL) {
    return { mode: TryOnMode.SINGLE, onePiece: garmentRef };
  }
  if (item.tryonGarmentCategory === TryOnGarmentCategory.LOWER) {
    return { mode: TryOnMode.SINGLE, lower: garmentRef };
  }
  if (isOuterwearRackItem(item)) {
    return { mode: TryOnMode.SINGLE, outerwear: garmentRef };
  }
  return { mode: TryOnMode.SINGLE, upper: garmentRef };
}

function isAccessoryRackItem(item: RackGarmentItemDto): boolean {
  const text = `${item.slug} ${item.name}`.toLowerCase();
  return (
    text.includes('that-lung') ||
    text.includes('thắt lưng') ||
    text.includes('khan-lua') ||
    text.includes('khăn lụa') ||
    text.includes('vi-cam-tay') ||
    text.includes('ví cầm tay') ||
    text.includes('clutch') ||
    text.includes('belt') ||
    text.includes('scarf') ||
    text.includes('phu-kien') ||
    text.includes('phụ kiện')
  );
}

export function ClothingRack3D({ items: rawItems }: ClothingRack3DProps) {
  // Prioritize hanging couture garments (blazers, dresses, silk blouses, trousers, coats)
  // first on the brass rail so accessories (belts, scarves, clutches) don't open at slot 01.
  const items = useMemo(() => {
    if (!rawItems || rawItems.length <= 1) return rawItems;
    const hanging = rawItems.filter((it) => !isAccessoryRackItem(it));
    const accessories = rawItems.filter((it) => isAccessoryRackItem(it));
    return [...hanging, ...accessories];
  }, [rawItems]);

  const sectionRef = useRef<HTMLElement | null>(null);
  const cardRef = useRef<HTMLElement | null>(null);
  const focusRef = useRef(0);
  const scrollTriggerRef = useRef<ScrollTrigger | null>(null);

  const lenis = useLenis();
  const motionState = useMotionState();
  const cameraGpuPaused = useCameraGpuPaused();
  const reducedMotion = usePrefersReducedMotion();
  const { tier, isLowPower, setOverride } = useAdaptivePerformance();

  const [isInView, setIsInView] = useState(false);
  const [isHidden, setIsHidden] = useState(false);
  const [isNarrow, setIsNarrow] = useState(false);
  const [webglReady, setWebglReady] = useState<boolean | null>(null);
  const [contextLost, setContextLost] = useState(false);
  const [domCameraActive, setDomCameraActive] = useState(false);
  const [domPerfLow, setDomPerfLow] = useState(false);

  // Only updates when the presented garment index actually changes (NEVER 60Hz!)
  const [presentedIndex, setPresentedIndex] = useState(0);
  const [isPresenting, setIsPresenting] = useState(true);
  const [activeVariants, setActiveVariants] = useState<Record<string, number>>({});
  const [selectedSizes, setSelectedSizes] = useState<Record<string, string>>({});
  const [showBackMap, setShowBackMap] = useState<Record<string, boolean>>({});
  const [recommendedSize, setRecommendedSize] = useState<string | null>(null);
  const [addingProductId, setAddingProductId] = useState<string | null>(null);
  const [bagFeedback, setBagFeedback] = useState<RackBagFeedback | null>(null);

  // Detect WebGL support, narrow viewport, visibility, cameraActive DOM flag & perfTier DOM flag
  useEffect(() => {
    setWebglReady(detectWebGLSupport());
    setRecommendedSize(readStoredRecommendedSize());

    const mq = window.matchMedia('(max-width: 767px)');
    setIsNarrow(mq.matches);
    const onMqChange = (event: MediaQueryListEvent) => setIsNarrow(event.matches);
    mq.addEventListener('change', onMqChange);

    const onVisibility = () => {
      setIsHidden(document.hidden);
    };
    setIsHidden(document.hidden);
    document.addEventListener('visibilitychange', onVisibility);

    const syncDomFlags = () => {
      setDomCameraActive(document.body?.dataset?.cameraActive === 'true');
      setDomPerfLow(
        (document.documentElement?.dataset?.perfTier || '').toUpperCase() === 'LOW',
      );
    };
    syncDomFlags();

    const bodyObserver = new MutationObserver(syncDomFlags);
    if (document.body) {
      bodyObserver.observe(document.body, {
        attributes: true,
        attributeFilter: ['data-camera-active'],
      });
    }
    const htmlObserver = new MutationObserver(syncDomFlags);
    if (document.documentElement) {
      htmlObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['data-perf-tier'],
      });
    }

    const onProfileUpdated = (event: Event) => {
      const custom = event as CustomEvent<{ recommendedSize?: string }>;
      if (custom.detail && typeof custom.detail.recommendedSize === 'string') {
        setRecommendedSize(custom.detail.recommendedSize.trim().toUpperCase());
      } else {
        setRecommendedSize(readStoredRecommendedSize());
      }
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === BODY_PROFILE_STORAGE_KEY) {
        setRecommendedSize(readStoredRecommendedSize());
      }
    };
    window.addEventListener('atelier:body-profile-updated', onProfileUpdated);
    window.addEventListener('storage', onStorage);

    return () => {
      mq.removeEventListener('change', onMqChange);
      document.removeEventListener('visibilitychange', onVisibility);
      bodyObserver.disconnect();
      htmlObserver.disconnect();
      window.removeEventListener('atelier:body-profile-updated', onProfileUpdated);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  // Track #rack viewport visibility via IntersectionObserver
  useEffect(() => {
    const el = sectionRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') {
      setIsInView(true);
      return undefined;
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        setIsInView(Boolean(entry?.isIntersecting));
      },
      { threshold: 0 },
    );
    observer.observe(el);

    return () => {
      observer.disconnect();
    };
  }, []);

  const effectiveLowPower = isLowPower || tier === 'LOW' || domPerfLow;
  const effectiveCameraActive =
    motionState.cameraActive || cameraGpuPaused || domCameraActive;

  const useFallback =
    effectiveLowPower ||
    reducedMotion ||
    isNarrow ||
    contextLost ||
    webglReady === false;

  const shouldRender =
    !useFallback &&
    webglReady === true &&
    isInView &&
    !isHidden &&
    !effectiveCameraActive &&
    !reducedMotion;

  // Pinned ScrollTrigger writing directly to focusRef.current (zero 60Hz setState)
  useGSAP(
    () => {
      ensureGsapRegistered();
      scrollTriggerRef.current = null;

      if (useFallback || items.length <= 1 || !sectionRef.current) {
        return;
      }

      const st = ScrollTrigger.create({
        trigger: sectionRef.current,
        start: 'top top',
        end: () =>
          `+=${Math.round(window.innerHeight * 0.62 * Math.max(1, items.length - 1))}`,
        pin: true,
        anticipatePin: 1,
        invalidateOnRefresh: true,
        onUpdate: (self) => {
          const maxIdx = Math.max(0, items.length - 1);
          focusRef.current = plateau(self.progress * maxIdx);
        },
      });
      scrollTriggerRef.current = st;

      return () => {
        scrollTriggerRef.current = null;
      };
    },
    { scope: sectionRef, dependencies: [items.length, useFallback] },
  );

  // Subtle entrance micro-animation on frosted card when presented garment changes
  useGSAP(
    () => {
      ensureGsapRegistered();
      if (useFallback || !cardRef.current || reducedMotion) return;
      gsap.fromTo(
        cardRef.current,
        { opacity: 0.78, y: 10 },
        { opacity: 1, y: 0, duration: 0.45, ease: 'power3.out', overwrite: 'auto' },
      );
    },
    { scope: sectionRef, dependencies: [presentedIndex, useFallback, reducedMotion] },
  );

  const handlePresentChange = useCallback((nextIndex: number) => {
    if (nextIndex < 0) {
      setIsPresenting(false);
      return;
    }
    setIsPresenting(true);
    setPresentedIndex((prev) => (prev === nextIndex ? prev : nextIndex));
  }, []);

  const handlePickGarment = useCallback(
    (targetIdx: number) => {
      if (items.length === 0) return;
      const clamped = Math.max(0, Math.min(targetIdx, items.length - 1));
      const st = scrollTriggerRef.current;

      if (!useFallback && st && items.length > 1) {
        const targetScroll =
          st.start + (clamped / (items.length - 1)) * (st.end - st.start);
        if (lenis) {
          lenis.scrollTo(targetScroll, { duration: 1.25 });
        } else {
          window.scrollTo({ top: targetScroll, behavior: 'smooth' });
        }
      } else {
        focusRef.current = clamped;
        setPresentedIndex(clamped);
        setIsPresenting(true);
      }
    },
    [items.length, lenis, useFallback],
  );

  const handleSelectVariant = useCallback(
    (productId: string, variantIndex: number) => {
      setActiveVariants((prev) => ({ ...prev, [productId]: variantIndex }));
      setBagFeedback(null);
      const item = items.find((it) => it.productId === productId);
      const nextVariant = item?.variants[variantIndex] ?? item?.variants[0];
      if (nextVariant) {
        setSelectedSizes((prev) => {
          const currentSize = prev[productId];
          const inStockSizes = new Set<string>(
            nextVariant.inStockSizes.length > 0
              ? nextVariant.inStockSizes
              : nextVariant.skus.filter((s) => s.inStock).map((s) => s.sizeCode),
          );
          if (currentSize && inStockSizes.has(currentSize)) {
            return prev;
          }
          const nextSize =
            (recommendedSize && inStockSizes.has(recommendedSize)
              ? recommendedSize
              : null) ||
            nextVariant.skus.find((s) => s.inStock)?.sizeCode ||
            nextVariant.inStockSizes[0];
          return nextSize ? { ...prev, [productId]: nextSize } : prev;
        });
      }
    },
    [items, recommendedSize],
  );

  const handleSelectSize = useCallback((productId: string, sizeCode: string) => {
    setSelectedSizes((prev) => ({ ...prev, [productId]: sizeCode }));
    setBagFeedback(null);
  }, []);

  const handleToggleBack = useCallback((productId: string) => {
    setShowBackMap((prev) => ({ ...prev, [productId]: !prev[productId] }));
  }, []);

  const handleTogglePresentedBack = useCallback(
    (idx: number) => {
      const target = items[idx];
      if (!target) return;
      handleToggleBack(target.productId);
    },
    [handleToggleBack, items],
  );

  const handleContextLost = useCallback(() => {
    setContextLost(true);
  }, []);

  const resolveActiveSkuForItem = useCallback(
    (item: RackGarmentItemDto) => {
      const varIdx = activeVariants[item.productId] ?? 0;
      const variant = item.variants[varIdx] ?? item.variants[0];
      const inStockSet = new Set<string>(
        variant?.inStockSizes?.length
          ? variant.inStockSizes
          : (variant?.skus ?? []).filter((s) => s.inStock).map((s) => s.sizeCode),
      );
      const chosenSize =
        selectedSizes[item.productId] ||
        (recommendedSize && inStockSet.has(recommendedSize)
          ? recommendedSize
          : '') ||
        variant?.skus.find((s) => s.inStock)?.sizeCode ||
        variant?.inStockSizes[0] ||
        'M';
      const sku =
        variant?.skus.find((s) => s.sizeCode === chosenSize && s.inStock) ??
        variant?.skus.find((s) => s.sizeCode === chosenSize) ??
        variant?.skus.find((s) => s.inStock) ??
        variant?.skus[0];
      return { variant, chosenSize, sku };
    },
    [activeVariants, recommendedSize, selectedSizes],
  );

  const handleOpenTryOn = useCallback(
    (item: RackGarmentItemDto) => {
      const { variant, sku } = resolveActiveSkuForItem(item);
      openVirtualTryOnModal(buildRackTryOnOptions(item, variant, sku?.id));
    },
    [resolveActiveSkuForItem],
  );

  const handleAddToBag = useCallback(
    async (item: RackGarmentItemDto) => {
      const { variant, chosenSize, sku } = resolveActiveSkuForItem(item);
      if (!variant || !sku || !sku.inStock) {
        const message = `Kích cỡ ${chosenSize} tạm hết hàng. Vui lòng chọn cỡ khác.`;
        setBagFeedback({ productId: item.productId, kind: 'error', message });
        showAtelierToast(message, 'warning');
        return;
      }

      setAddingProductId(item.productId);
      setBagFeedback(null);

      const res = await apiFetch<CartDto>('/bff/v1/storefront/cart/items', {
        method: 'POST',
        skipAuthRefresh: true,
        body: JSON.stringify({
          skuId: sku.id,
          productId: item.productId,
          variantId: variant.id,
          qty: 1,
          fromAiTryon: false,
        }),
      });

      if (res.ok && res.data) {
        emitCartUpdated(res.data);
        const message = `Đã thêm ${item.name} (${variant.colorName} · Size ${sku.sizeCode}) vào giỏ.`;
        setBagFeedback({ productId: item.productId, kind: 'success', message });
        showAtelierToast(message, 'success');
        openQuickBagDrawer(null);
      } else {
        const message =
          res.error?.message ||
          'Chưa thể thêm vào giỏ lúc này. Vui lòng thử lại.';
        setBagFeedback({ productId: item.productId, kind: 'error', message });
        showAtelierToast(message, 'error');
      }

      setAddingProductId(null);
    },
    [resolveActiveSkuForItem],
  );

  if (!items || items.length === 0) {
    return null;
  }

  const safeIdx = Math.max(0, Math.min(presentedIndex, items.length - 1));
  const activeItem = items[safeIdx] ?? items[0];
  const activeVarIdx = activeVariants[activeItem.productId] ?? 0;
  const activeVariant = activeItem.variants[activeVarIdx] ?? activeItem.variants[0];
  const isBack = Boolean(showBackMap[activeItem.productId]);
  const inStockSet = new Set<string>(
    activeVariant?.inStockSizes?.length
      ? activeVariant.inStockSizes
      : (activeVariant?.skus ?? []).filter((s) => s.inStock).map((s) => s.sizeCode),
  );
  const sizeList =
    activeVariant && activeVariant.inStockSizes.length > 0
      ? Array.from(
          new Set<string>([...ALL_STANDARD_SIZES, ...activeVariant.inStockSizes]),
        )
      : [...ALL_STANDARD_SIZES];

  const { chosenSize: activeSize, sku: activeSku } =
    resolveActiveSkuForItem(activeItem);
  const activePriceVnd =
    activeSku?.salePriceVnd ?? activeSku?.basePriceVnd ?? activeItem.minPriceVnd;
  const isAddingActive = addingProductId === activeItem.productId;
  const activeFeedback =
    bagFeedback && bagFeedback.productId === activeItem.productId
      ? bagFeedback
      : null;

  return (
    <section
      ref={sectionRef}
      className="rack relative min-h-[100svh] bg-[#1C1410] text-[#FBF7EF]"
      id="rack"
      data-nav-theme="dark"
      data-rack-mode={useFallback ? 'flat' : 'webgl'}
      data-frameloop={shouldRender ? 'always' : 'never'}
    >
      <div className="rack__wall" aria-hidden="true" />

      {useFallback ? (
        <FlatRackFallback
          items={items}
          activeIndex={safeIdx}
          activeVariants={activeVariants}
          selectedSizes={selectedSizes}
          showBackMap={showBackMap}
          recommendedSize={recommendedSize}
          addingProductId={addingProductId}
          bagFeedback={bagFeedback}
          reasonLabel={
            contextLost
              ? 'Chế độ 2D ổn định · Đã chuyển từ WebGL'
              : effectiveLowPower
                ? 'Chế độ tiết kiệm pin · Hiển thị 2D mượt mà'
                : reducedMotion
                  ? 'Chế độ giảm chuyển động'
                  : undefined
          }
          onSelectIndex={handlePickGarment}
          onSelectVariant={handleSelectVariant}
          onSelectSize={handleSelectSize}
          onToggleBack={handleToggleBack}
          onAddToBag={(item) => void handleAddToBag(item)}
          onOpenTryOn={handleOpenTryOn}
          onEnable3DRack={
            effectiveLowPower && webglReady !== false && !contextLost && !isNarrow
              ? () => {
                  setOverride('HIGH');
                  setDomPerfLow(false);
                }
              : undefined
          }
        />
      ) : (
        <div
          className="rack__stage relative h-[100svh] min-h-[680px] w-full overflow-hidden"
          data-cursor="view"
          data-cursor-label="XEM"
        >
          {webglReady === true ? (
            <RackWebGLErrorBoundary onError={handleContextLost}>
              <RackCanvasR3F
                items={items}
                focusRef={focusRef}
                shouldRender={shouldRender}
                maxDpr={tier === 'MEDIUM' ? 1.25 : 1.5}
                activeVariants={activeVariants}
                showBackMap={showBackMap}
                onPresentChange={handlePresentChange}
                onPick={handlePickGarment}
                onTogglePresentedBack={handleTogglePresentedBack}
                onContextLost={handleContextLost}
              />
            </RackWebGLErrorBoundary>
          ) : null}

          {/* Editorial Title Overlay (.rack__head) */}
          <div className="rack__head pointer-events-none absolute bottom-[calc(clamp(40px,10vh,110px)+46px)] left-[clamp(16px,5vw,72px)] z-[2] drop-shadow-[0_2px_24px_rgba(20,14,10,0.85)]">
            <p className="eyebrow">Bộ sưu tập · Giá treo thanh đồng 3D</p>
            <h2 className="h2 !text-[clamp(30px,3.4vw,52px)]">
              Chọn một dáng,
              <br />
              <em className="text-[#EBCF8F]">thiết kế sẽ bước ra.</em>
            </h2>
          </div>

          {/* Interactive Frosted Commerce Card (.rack__card) */}
          <aside
            ref={cardRef}
            id="rackCard"
            data-cursor="default"
            className={`rack__card absolute right-[clamp(16px,5vw,72px)] bottom-[clamp(40px,10vh,110px)] z-[3] w-[min(380px,88vw)] transition-opacity duration-500 ${
              isPresenting ? 'opacity-100' : 'opacity-60'
            }`}
          >
            <div className="flex items-center justify-between gap-2">
              <p className="rack__idx">
                <b id="rcIdx">{String(safeIdx + 1).padStart(2, '0')}</b> /{' '}
                <span id="rcTotal">{String(items.length).padStart(2, '0')}</span>
              </p>
              <button
                type="button"
                data-testid="rack-flip-btn"
                onClick={() => handleToggleBack(activeItem.productId)}
                aria-pressed={isBack}
                className="rounded-full border border-[#EBCF8F]/45 bg-[#1C1410]/70 px-3 py-1 text-[10px] tracking-[0.16em] uppercase text-[#EBCF8F] transition-colors hover:border-[#EBCF8F] hover:bg-[#EBCF8F]/15"
              >
                {isBack ? '↻ Mặt sau · Lật trước' : '↻ Mặt trước / sau'}
              </button>
            </div>

            <h3 className="rack__name" id="rcName">
              {activeItem.name}
            </h3>
            <p className="rack__flowers" id="rcFlowers">
              {activeItem.fabricComposition}
            </p>

            {/* Color Swatches driving shader uMix crossfade */}
            {activeItem.variants.length > 0 ? (
              <div className="mt-3.5 flex flex-wrap items-center gap-2">
                {activeItem.variants.map((variant, vIdx) => {
                  const selected = vIdx === activeVarIdx;
                  return (
                    <button
                      key={variant.id}
                      type="button"
                      data-testid="rack-swatch-btn"
                      title={variant.colorName}
                      aria-label={`Màu ${variant.colorName}`}
                      aria-pressed={selected}
                      onClick={() => handleSelectVariant(activeItem.productId, vIdx)}
                      className={`h-5 w-5 rounded-full border transition-transform ${
                        selected
                          ? 'scale-110 border-[#EBCF8F] ring-2 ring-[#B08A4A]'
                          : 'border-[#FBF7EF]/35 hover:scale-105'
                      }`}
                      style={{ backgroundColor: variant.colorHex }}
                    />
                  );
                })}
                <span className="ml-1 text-xs text-[#EBCF8F]/85">
                  {activeVariant?.colorName}
                </span>
              </div>
            ) : null}

            {/* Interactive In-Stock Size Buttons */}
            <div className="mt-3.5 flex flex-wrap items-center gap-1.5">
              {sizeList.map((sz) => {
                const available = inStockSet.has(sz);
                const selected = activeSize === sz;
                return (
                  <button
                    key={sz}
                    type="button"
                    data-testid="rack-size-btn"
                    disabled={!available}
                    aria-pressed={selected}
                    onClick={() => handleSelectSize(activeItem.productId, sz)}
                    className={`inline-flex min-w-[34px] items-center justify-center rounded-full border px-2 py-0.5 text-[10px] tracking-[0.12em] transition-colors ${
                      selected
                        ? 'border-[#EBCF8F] bg-[#EBCF8F] font-medium text-[#1C1410]'
                        : available
                          ? 'border-[#EBCF8F]/50 bg-[#EBCF8F]/10 text-[#FBF7EF] hover:border-[#EBCF8F]'
                          : 'cursor-not-allowed border-[#FBF7EF]/15 text-[#FBF7EF]/35 line-through'
                    }`}
                  >
                    {sz}
                  </button>
                );
              })}
            </div>

            <p className="rack__price" id="rcPrice">
              <small>Từ</small>
              {FORMAT_VND(activePriceVnd)}
            </p>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                data-testid="rack-add-to-bag-btn"
                disabled={isAddingActive || !activeSku?.inStock}
                onClick={() => void handleAddToBag(activeItem)}
                className="inline-flex flex-1 items-center justify-center rounded-full bg-[#EBCF8F] px-4 py-2.5 text-[11px] font-medium tracking-[0.16em] uppercase text-[#1C1410] transition-opacity hover:opacity-90 disabled:opacity-45"
              >
                {isAddingActive ? 'Đang thêm...' : '+ Thêm vào giỏ'}
              </button>
              {activeItem.isTryonEnabled ? (
                <button
                  type="button"
                  data-testid="rack-tryon-btn"
                  onClick={() => handleOpenTryOn(activeItem)}
                  className="inline-flex items-center justify-center rounded-full border border-[#EBCF8F]/60 bg-[#2A1E17]/85 px-4 py-2.5 text-[11px] font-medium tracking-[0.14em] uppercase text-[#EBCF8F] transition-colors hover:border-[#EBCF8F] hover:bg-[#EBCF8F]/15"
                  data-cursor="view"
                  data-cursor-label="Thử AI"
                >
                  ✦ Ướm thử AI
                </button>
              ) : null}
            </div>

            <div className="mt-2.5 flex items-center justify-between gap-2">
              <Link
                href={`/san-pham/${activeItem.slug}`}
                className="text-[11px] tracking-[0.16em] uppercase text-[#EBCF8F]/85 underline underline-offset-4 transition-colors hover:text-[#EBCF8F]"
                data-cursor="view"
                data-cursor-label="Xem"
              >
                Xem thiết kế →
              </Link>
              {recommendedSize && inStockSet.has(recommendedSize) ? (
                <span className="text-[10px] text-[#EBCF8F]/80">
                  Hồ sơ: Size {recommendedSize}
                </span>
              ) : null}
            </div>

            {activeFeedback ? (
              <p
                role="status"
                className={`mt-2.5 rounded-xl border px-3 py-1.5 text-[11px] ${
                  activeFeedback.kind === 'success'
                    ? 'border-[#EBCF8F]/45 bg-[#2A1E17]/85 text-[#EBCF8F]'
                    : 'border-[#C96B5B]/55 bg-[#2A1815]/90 text-[#F4B8AE]'
                }`}
              >
                {activeFeedback.message}
              </p>
            ) : null}
          </aside>

          {/* Subtle Gesture Hint (.rack__hint) */}
          <div className="rack__hint pointer-events-none absolute bottom-[clamp(40px,10vh,110px)] left-[clamp(16px,5vw,72px)] z-[2] hidden items-center gap-3 text-[11px] tracking-[0.18em] uppercase text-[#FBF7EF]/55 md:flex">
            <span className="inline-block h-px w-8 bg-[#B08A4A]" />
            Rê chuột để gió lay · Cuộn để xem thiết kế kế tiếp
          </div>

          {/* Clickable Pagination Dots (.rack__dots) */}
          <div
            className="rack__dots absolute bottom-6 left-1/2 z-[3] flex -translate-x-1/2 items-center gap-2"
            id="rackDots"
            data-cursor="default"
            role="tablist"
            aria-label="Chọn mẫu trên giá treo"
          >
            {items.map((item, idx) => {
              const selected = idx === safeIdx;
              return (
                <button
                  key={item.productId}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  aria-label={`Mẫu ${idx + 1}: ${item.name}`}
                  onClick={() => handlePickGarment(idx)}
                  className={`h-1.5 rounded-full transition-all duration-300 ${
                    selected
                      ? 'w-6 bg-[#B08A4A]'
                      : 'w-1.5 bg-[#EBCF8F]/35 hover:bg-[#EBCF8F]/70'
                  }`}
                />
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}
