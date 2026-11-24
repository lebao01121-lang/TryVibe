'use client';

import { useGSAP } from '@gsap/react';
import { useLenis } from 'lenis/react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import {
  Component,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ErrorInfo,
  type ReactNode,
} from 'react';
import type { RackGarmentItemDto } from '@atelier/contracts';
import { useMotionState, usePrefersReducedMotion } from '@atelier/motion-kit';
import { FORMAT_VND } from '@/lib/catalog-data';
import { ensureGsapRegistered, gsap, ScrollTrigger } from '@/lib/gsap-setup';
import { FlatRackFallback } from './FlatRackFallback';
import { plateau } from './physics/springPendulum';

const ALL_STANDARD_SIZES = ['XS', 'S', 'M', 'L', 'XL'] as const;

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

export function ClothingRack3D({ items }: ClothingRack3DProps) {
  const sectionRef = useRef<HTMLElement | null>(null);
  const cardRef = useRef<HTMLElement | null>(null);
  const focusRef = useRef(0);
  const scrollTriggerRef = useRef<ScrollTrigger | null>(null);

  const lenis = useLenis();
  const motionState = useMotionState();
  const reducedMotion = usePrefersReducedMotion();

  const [isInView, setIsInView] = useState(false);
  const [isHidden, setIsHidden] = useState(false);
  const [isNarrow, setIsNarrow] = useState(false);
  const [webglReady, setWebglReady] = useState<boolean | null>(null);
  const [contextLost, setContextLost] = useState(false);

  // Only updates when the presented garment index actually changes (NEVER 60Hz!)
  const [presentedIndex, setPresentedIndex] = useState(0);
  const [isPresenting, setIsPresenting] = useState(true);
  const [activeVariants, setActiveVariants] = useState<Record<string, number>>({});
  const [showBackMap, setShowBackMap] = useState<Record<string, boolean>>({});

  // Detect WebGL support & narrow viewport (< 768px) on client mount
  useEffect(() => {
    setWebglReady(detectWebGLSupport());

    const mq = window.matchMedia('(max-width: 767px)');
    setIsNarrow(mq.matches);
    const onMqChange = (event: MediaQueryListEvent) => setIsNarrow(event.matches);
    mq.addEventListener('change', onMqChange);

    const onVisibility = () => {
      setIsHidden(document.hidden);
    };
    setIsHidden(document.hidden);
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      mq.removeEventListener('change', onMqChange);
      document.removeEventListener('visibilitychange', onVisibility);
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

  const useFallback =
    reducedMotion || isNarrow || contextLost || webglReady === false;
  const shouldRender =
    !useFallback &&
    webglReady === true &&
    isInView &&
    !isHidden &&
    !motionState.cameraActive &&
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

  const handleSelectVariant = useCallback((productId: string, variantIndex: number) => {
    setActiveVariants((prev) => ({ ...prev, [productId]: variantIndex }));
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

  if (!items || items.length === 0) {
    return null;
  }

  const safeIdx = Math.max(0, Math.min(presentedIndex, items.length - 1));
  const activeItem = items[safeIdx] ?? items[0];
  const activeVarIdx = activeVariants[activeItem.productId] ?? 0;
  const activeVariant = activeItem.variants[activeVarIdx] ?? activeItem.variants[0];
  const isBack = Boolean(showBackMap[activeItem.productId]);
  const inStockSet = new Set<string>(activeVariant?.inStockSizes ?? []);
  const sizeList =
    activeVariant && activeVariant.inStockSizes.length > 0
      ? Array.from(
          new Set<string>([...ALL_STANDARD_SIZES, ...activeVariant.inStockSizes]),
        )
      : [...ALL_STANDARD_SIZES];

  return (
    <section
      ref={sectionRef}
      className="rack relative min-h-[100svh] bg-[#1C1410] text-[#FBF7EF]"
      id="rack"
      data-nav-theme="dark"
    >
      <div className="rack__wall" aria-hidden="true" />

      {useFallback ? (
        <FlatRackFallback
          items={items}
          activeIndex={safeIdx}
          activeVariants={activeVariants}
          showBackMap={showBackMap}
          reasonLabel={
            contextLost
              ? 'Chế độ 2D ổn định · Đã chuyển từ WebGL'
              : reducedMotion
                ? 'Chế độ giảm chuyển động'
                : undefined
          }
          onSelectIndex={handlePickGarment}
          onSelectVariant={handleSelectVariant}
          onToggleBack={handleToggleBack}
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
            className={`rack__card absolute right-[clamp(16px,5vw,72px)] bottom-[clamp(40px,10vh,110px)] z-[3] w-[min(368px,88vw)] transition-opacity duration-500 ${
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
                onClick={() => handleToggleBack(activeItem.productId)}
                aria-pressed={isBack}
                className="rounded-full border border-[#EBCF8F]/45 bg-[#1C1410]/70 px-3 py-1 text-[10px] tracking-[0.16em] uppercase text-[#EBCF8F] transition-colors hover:border-[#EBCF8F] hover:bg-[#EBCF8F]/15"
              >
                {isBack ? 'Mặt sau · Lật trước' : 'Mặt trước / Mặt sau'}
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

            {/* In-Stock Size Pills */}
            <div className="mt-3.5 flex flex-wrap items-center gap-1.5">
              {sizeList.map((sz) => {
                const available = inStockSet.has(sz);
                return (
                  <span
                    key={sz}
                    className={`inline-flex min-w-[32px] items-center justify-center rounded-full border px-2 py-0.5 text-[10px] tracking-[0.12em] ${
                      available
                        ? 'border-[#EBCF8F]/50 bg-[#EBCF8F]/10 text-[#FBF7EF]'
                        : 'border-[#FBF7EF]/15 text-[#FBF7EF]/35 line-through'
                    }`}
                  >
                    {sz}
                  </span>
                );
              })}
            </div>

            <p className="rack__price" id="rcPrice">
              <small>Từ</small>
              {FORMAT_VND(activeItem.minPriceVnd)}
            </p>

            <div className="flex flex-wrap items-center gap-2.5">
              <Link
                href={`/san-pham/${activeItem.slug}`}
                className="btn btn--line !px-5 !py-2.5 !text-xs text-[#EBCF8F]"
                data-cursor="view"
                data-cursor-label="Xem"
              >
                Xem thiết kế
              </Link>
              {activeItem.isTryonEnabled ? (
                <Link
                  href={`/thu-do-ai?slug=${encodeURIComponent(activeItem.slug)}`}
                  className="inline-flex items-center rounded-full border border-[#FBF7EF]/35 px-4 py-2.5 text-[11px] tracking-[0.16em] uppercase text-[#FBF7EF]/90 transition-colors hover:border-[#EBCF8F] hover:text-[#EBCF8F]"
                  data-cursor="view"
                  data-cursor-label="Thử AI"
                >
                  Ướm thử AI
                </Link>
              ) : null}
            </div>
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
