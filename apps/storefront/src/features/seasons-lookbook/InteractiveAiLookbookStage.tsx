'use client';

import { useGSAP } from '@gsap/react';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { useMotionState, usePrefersReducedMotion } from '@atelier/motion-kit';
import { ensureGsapRegistered, gsap } from '@/lib/gsap-setup';
import {
  renderPhotometricSceneToCanvas,
  type HydratedSeasonScene,
  type MaterialOpticalProfile,
  type PhotometricLookbookCache,
  type PhotometricRecolorSlotRequest,
} from './photometric-recolor';
import styles from './seasons-vitrine.module.css';

export type WearableSlotKey =
  | 'TOP'
  | 'BOTTOM'
  | 'ONE_PIECE'
  | 'OUTERWEAR'
  | 'ACCESSORY';

export interface SeasonWearableVariantView {
  variantId: string;
  skuDefaultId: string;
  colorKey: string;
  colorName: string;
  colorHex: string;
  inStockSizes: string[];
  /** Optional map of sizeCode -> exact skuId for live cart checkout */
  skuBySize?: Record<string, string>;
  studioCutoutUrl: string;
  macroSwatchUrl: string;
  fabricSpecText: string;
  prebakedSceneUrl?: string | null;
}

export interface SeasonWearableSlotView {
  slotKey: WearableSlotKey;
  productId: string;
  productSlug: string;
  productName: string;
  basePriceVnd: number;
  pinPosition: { xPercent: number; yPercent: number };
  garmentRegionMask: string;
  maskBbox?: { x: number; y: number; w: number; h: number };
  materialOpticalProfile: MaterialOpticalProfile;
  variants: SeasonWearableVariantView[];
}

export interface SeasonChapterView {
  id: string;
  slug: string;
  order: number;
  orderLabel: string;
  months: string;
  name: string;
  shortName: string;
  materialHeadline: string;
  note: string;
  isCurrent: boolean;
  totalDesigns: number;
  baseEditorialImageUrl: string;
  wearableSlots: SeasonWearableSlotView[];
  restyleCacheMap: Record<string, string>;
}

export interface ScanBeamTrigger {
  slotKey: WearableSlotKey;
  maskBbox?: { x: number; y: number; w: number; h: number };
  seq: number;
}

export interface InteractiveAiLookbookStageProps {
  season: SeasonChapterView;
  transitionDirection: 1 | -1;
  cache: PhotometricLookbookCache;
  selectedColorBySlot: Record<string, string>;
  hoveredSlotKey: WearableSlotKey | null;
  openPopoverSlotKey: WearableSlotKey | null;
  scanTrigger: ScanBeamTrigger | null;
  serverSceneUrl: string | null;
  serverCacheHit: boolean;
  isRestylingServer: boolean;
  onHoverSlot: (slotKey: WearableSlotKey | null) => void;
  onTogglePopover: (slotKey: WearableSlotKey | null) => void;
  onSelectSlotVariant: (
    slot: SeasonWearableSlotView,
    variant: SeasonWearableVariantView,
  ) => void;
  onOpenSetTryOn: () => void;
}

const SLOT_SHORT_LABEL_VI: Record<WearableSlotKey, string> = {
  TOP: 'Áo thân trên',
  BOTTOM: 'Chân váy / Quần',
  ONE_PIECE: 'Đầm liền thân',
  OUTERWEAR: 'Áo khoác',
  ACCESSORY: 'Phụ kiện',
};

function resolvePinLabel(slot: SeasonWearableSlotView): string {
  const nameLower = slot.productName.toLowerCase();
  let shortNoun = SLOT_SHORT_LABEL_VI[slot.slotKey];
  if (slot.slotKey === 'TOP') {
    if (nameLower.includes('lụa')) shortNoun = 'Áo lụa';
    else if (nameLower.includes('len') || nameLower.includes('cashmere')) shortNoun = 'Áo len';
    else if (nameLower.includes('sơ mi')) shortNoun = 'Áo sơ mi';
  } else if (slot.slotKey === 'BOTTOM') {
    if (nameLower.includes('chân váy')) shortNoun = 'Chân váy';
    else if (nameLower.includes('quần')) shortNoun = 'Quần âu';
  } else if (slot.slotKey === 'ONE_PIECE') {
    shortNoun = 'Đầm liền';
  } else if (slot.slotKey === 'OUTERWEAR') {
    if (nameLower.includes('blazer')) shortNoun = 'Blazer';
    else if (nameLower.includes('tweed')) shortNoun = 'Áo Tweed';
    else if (nameLower.includes('cardigan')) shortNoun = 'Cardigan';
    else shortNoun = 'Áo khoác';
  } else if (slot.slotKey === 'ACCESSORY') {
    shortNoun = 'Phụ kiện';
  }
  const colorCount = Math.max(1, slot.variants.length);
  return `${shortNoun} · ${colorCount} màu`;
}

function resolveDefaultMaskBbox(
  slotKey: WearableSlotKey,
  pin: { xPercent: number; yPercent: number },
): { x: number; y: number; w: number; h: number } {
  if (slotKey === 'TOP' || slotKey === 'OUTERWEAR') {
    return { x: 0.2, y: 0.24, w: 0.6, h: 0.34 };
  }
  if (slotKey === 'BOTTOM') {
    return { x: 0.16, y: 0.5, w: 0.68, h: 0.44 };
  }
  if (slotKey === 'ONE_PIECE') {
    return { x: 0.18, y: 0.24, w: 0.64, h: 0.68 };
  }
  const cx = Math.max(0.18, Math.min(0.82, pin.xPercent / 100));
  const cy = Math.max(0.2, Math.min(0.84, pin.yPercent / 100));
  return {
    x: Math.max(0.05, cx - 0.16),
    y: Math.max(0.05, cy - 0.14),
    w: 0.32,
    h: 0.28,
  };
}

export function InteractiveAiLookbookStage({
  season,
  transitionDirection,
  cache,
  selectedColorBySlot,
  hoveredSlotKey,
  openPopoverSlotKey,
  scanTrigger,
  serverSceneUrl,
  serverCacheHit,
  isRestylingServer,
  onHoverSlot,
  onTogglePopover,
  onSelectSlotVariant,
  onOpenSetTryOn,
}: InteractiveAiLookbookStageProps) {
  const stageContainerRef = useRef<HTMLDivElement | null>(null);
  const curtainLayerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const prevSeasonSlugRef = useRef<string | null>(null);

  const { cameraActive } = useMotionState();
  const reducedMotion = usePrefersReducedMotion();

  const [hydratedScene, setHydratedScene] = useState<HydratedSeasonScene | null>(
    () => cache.getCached(season.slug),
  );
  const [verifiedServerOverlayUrl, setVerifiedServerOverlayUrl] = useState<string | null>(
    null,
  );
  const [scanActiveKey, setScanActiveKey] = useState<number>(0);

  // Hydrate base photograph & all slot masks for active season into PhotometricLookbookCache
  useEffect(() => {
    let cancelled = false;
    const cached = cache.getCached(season.slug);
    if (cached && cached.baseUrl === season.baseEditorialImageUrl) {
      setHydratedScene(cached);
      return;
    }

    const maskInputs = season.wearableSlots.map((slot) => ({
      slotKey: slot.slotKey,
      garmentRegionMask: slot.garmentRegionMask,
      materialOpticalProfile: slot.materialOpticalProfile,
    }));

    void cache
      .hydrateSeason(season.slug, season.baseEditorialImageUrl, maskInputs)
      .then((scene) => {
        if (!cancelled && scene) {
          setHydratedScene(scene);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [cache, season.baseEditorialImageUrl, season.slug, season.wearableSlots]);

  // Build cumulative photometric slot recolor requests (TOP + BOTTOM + ACCESSORY simultaneously)
  const slotRequests = useMemo<PhotometricRecolorSlotRequest[]>(() => {
    return season.wearableSlots.map((slot) => {
      const defaultVariant = slot.variants[0];
      const activeKey =
        selectedColorBySlot[slot.slotKey] ?? defaultVariant?.colorKey ?? '';
      const activeVariant =
        slot.variants.find((v) => v.colorKey === activeKey) ?? defaultVariant;
      const isDefaultColor =
        !activeVariant ||
        (defaultVariant != null && activeVariant.colorKey === defaultVariant.colorKey);

      return {
        slotKey: slot.slotKey,
        targetHex: activeVariant?.colorHex ?? '#F4EFE6',
        isDefaultColor,
        materialOpticalProfile: slot.materialOpticalProfile,
      };
    });
  }, [season.wearableSlots, selectedColorBySlot]);

  const hasAnyCustomColor = useMemo(
    () => slotRequests.some((r) => !r.isDefaultColor),
    [slotRequests],
  );

  // Render HiDPI photometric scene immediately (0ms lag) whenever scene, colors, or hover changes
  const paintCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !hydratedScene || hydratedScene.seasonSlug !== season.slug) {
      return;
    }
    renderPhotometricSceneToCanvas(canvas, hydratedScene, slotRequests, {
      hoveredSlotKey,
      maxDpr: 2,
    });
  }, [hydratedScene, hoveredSlotKey, season.slug, slotRequests]);

  useEffect(() => {
    paintCanvas();
  }, [paintCanvas]);

  // Keep canvas crisp on container resize
  useEffect(() => {
    const el = stageContainerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(() => {
      paintCanvas();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [paintCanvas]);

  // Safely preload distinct server-cached AI restyle image before crossfading (guarantees 0 brokenImgs)
  useEffect(() => {
    if (!serverSceneUrl || !hasAnyCustomColor) {
      setVerifiedServerOverlayUrl(null);
      return;
    }
    if (serverSceneUrl === season.baseEditorialImageUrl) {
      setVerifiedServerOverlayUrl(null);
      return;
    }

    let cancelled = false;
    const preloader = new Image();
    preloader.decoding = 'async';
    if (serverSceneUrl.startsWith('http://') || serverSceneUrl.startsWith('https://')) {
      preloader.crossOrigin = 'anonymous';
    }
    preloader.onload = () => {
      if (!cancelled && preloader.naturalWidth > 0) {
        setVerifiedServerOverlayUrl(serverSceneUrl);
      }
    };
    preloader.onerror = () => {
      if (!cancelled) {
        setVerifiedServerOverlayUrl(null);
      }
    };
    preloader.src = serverSceneUrl;

    return () => {
      cancelled = true;
    };
  }, [hasAnyCustomColor, season.baseEditorialImageUrl, serverSceneUrl]);

  // Trigger 0.48s AiOpticalScanBeam on color selection (auto-paused when cameraActive === true)
  useEffect(() => {
    if (!scanTrigger || cameraActive || reducedMotion) {
      setScanActiveKey(0);
      return;
    }
    setScanActiveKey(scanTrigger.seq);
    const timer = window.setTimeout(() => {
      setScanActiveKey((prev) => (prev === scanTrigger.seq ? 0 : prev));
    }, 520);
    return () => window.clearTimeout(timer);
  }, [scanTrigger, cameraActive, reducedMotion]);

  // Vertical silk curtain reveal on season chapter switch (`0.65s power3.out`)
  useGSAP(
    () => {
      ensureGsapRegistered();
      const curtainEl = curtainLayerRef.current;
      if (!curtainEl) return;

      const prevSlug = prevSeasonSlugRef.current;
      prevSeasonSlugRef.current = season.slug;

      if (!prevSlug || prevSlug === season.slug || reducedMotion) {
        gsap.set(curtainEl, { clipPath: 'inset(0% 0% 0% 0% round 12px)' });
        return;
      }

      const startInset =
        transitionDirection >= 0
          ? 'inset(100% 0% 0% 0% round 12px)'
          : 'inset(0% 0% 100% 0% round 12px)';

      gsap.fromTo(
        curtainEl,
        { clipPath: startInset },
        {
          clipPath: 'inset(0% 0% 0% 0% round 12px)',
          duration: 0.65,
          ease: 'power3.out',
          overwrite: 'auto',
        },
      );
    },
    {
      scope: stageContainerRef,
      dependencies: [season.slug, transitionDirection, reducedMotion],
    },
  );

  // Close swatch popover on Escape or outside click
  useEffect(() => {
    if (!openPopoverSlotKey) return undefined;

    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onTogglePopover(null);
      }
    };

    const handlePointerDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      if (
        target.closest('[data-testid="season-swatch-popover"]') ||
        target.closest('[data-hotspot-pin="true"]')
      ) {
        return;
      }
      onTogglePopover(null);
    };

    window.addEventListener('keydown', handleKey);
    document.addEventListener('mousedown', handlePointerDown);
    return () => {
      window.removeEventListener('keydown', handleKey);
      document.removeEventListener('mousedown', handlePointerDown);
    };
  }, [openPopoverSlotKey, onTogglePopover]);

  const activePopoverSlot = useMemo(
    () =>
      openPopoverSlotKey
        ? season.wearableSlots.find((s) => s.slotKey === openPopoverSlotKey) ?? null
        : null,
    [openPopoverSlotKey, season.wearableSlots],
  );

  const activeScanStyle = useMemo<CSSProperties | null>(() => {
    if (!scanTrigger || scanActiveKey === 0) return null;
    const matchedSlot = season.wearableSlots.find(
      (s) => s.slotKey === scanTrigger.slotKey,
    );
    const bbox =
      scanTrigger.maskBbox ??
      matchedSlot?.maskBbox ??
      resolveDefaultMaskBbox(
        scanTrigger.slotKey,
        matchedSlot?.pinPosition ?? { xPercent: 50, yPercent: 45 },
      );

    return {
      left: `${(Math.max(0, Math.min(0.92, bbox.x)) * 100).toFixed(2)}%`,
      top: `${(Math.max(0, Math.min(0.92, bbox.y)) * 100).toFixed(2)}%`,
      width: `${(Math.max(0.12, Math.min(1 - bbox.x, bbox.w)) * 100).toFixed(2)}%`,
      height: `${(Math.max(0.12, Math.min(1 - bbox.y, bbox.h)) * 100).toFixed(2)}%`,
    };
  }, [scanActiveKey, scanTrigger, season.wearableSlots]);

  const popoverAnchorStyle = useMemo<CSSProperties>(() => {
    if (!activePopoverSlot) return {};
    const { xPercent, yPercent } = activePopoverSlot.pinPosition;
    // Keep popover cleanly inside the 4:5 editorial frame
    const placeLeft = xPercent > 54;
    const clampedTop = Math.max(10, Math.min(62, yPercent - 12));
    if (placeLeft) {
      return {
        right: `${Math.max(4, Math.min(48, 100 - xPercent + 5)).toFixed(1)}%`,
        top: `${clampedTop.toFixed(1)}%`,
      };
    }
    return {
      left: `${Math.max(4, Math.min(46, xPercent + 5)).toFixed(1)}%`,
      top: `${clampedTop.toFixed(1)}%`,
    };
  }, [activePopoverSlot]);

  const sceneReady =
    hydratedScene !== null && hydratedScene.seasonSlug === season.slug;

  return (
    <div
      ref={stageContainerRef}
      className={styles.aiStageFrame}
      data-season-slug={season.slug}
      data-restyle-ready={sceneReady ? 'true' : 'false'}
      data-restyle-cache-hit={serverCacheHit ? 'true' : 'false'}
      data-restyle-loading={isRestylingServer ? 'true' : 'false'}
      data-restyle-server-url={verifiedServerOverlayUrl ?? ''}
    >
      <div ref={curtainLayerRef} className={styles.aiStageCurtain}>
        {/* Instant editorial base fallback visible only until canvas finishes pixel hydration */}
        {!sceneReady ? (
          <img
            src={season.baseEditorialImageUrl}
            alt={`${season.name} — ${season.materialHeadline}`}
            className={styles.aiFallbackImg}
            loading="eager"
            decoding="async"
          />
        ) : null}

        {/* Primary HiDPI Photometric Multi-Layer Recoloring Canvas */}
        <canvas
          ref={canvasRef}
          data-testid="season-ai-canvas"
          className={styles.aiCanvas}
          aria-label={`Lookbook AI tương tác mùa ${season.name}`}
        />

        {/* Optional crossfaded server/Redis cached photometric render (paused on hover so golden mask glow stays crisp) */}
        {verifiedServerOverlayUrl && !hoveredSlotKey ? (
          <img
            src={verifiedServerOverlayUrl}
            alt=""
            aria-hidden="true"
            className={styles.aiServerOverlay}
          />
        ) : null}

        {/* Subtle warm bottom vignette for legibility of bottom-right Try-On pill */}
        <div className={styles.aiStageBottomGradient} aria-hidden="true" />

        {/* AiOpticalScanBeam: 0.48s golden vertical light beam strictly over garment maskBbox */}
        {activeScanStyle && !cameraActive ? (
          <div
            key={`scan-${scanActiveKey}`}
            className={styles.scanBeamRegion}
            style={activeScanStyle}
            data-testid="season-ai-scan-beam"
            aria-hidden="true"
          >
            <div className={styles.scanBeamBar} />
            <div className={styles.scanBeamShimmer} />
          </div>
        ) : null}

        {/* Interactive WearableHotspotPins on ALL wearable slots */}
        {season.wearableSlots.map((slot) => {
          const isOpen = openPopoverSlotKey === slot.slotKey;
          const isHovered = hoveredSlotKey === slot.slotKey;
          const clampedX = Math.max(10, Math.min(84, slot.pinPosition.xPercent));
          const clampedY = Math.max(14, Math.min(82, slot.pinPosition.yPercent));
          const labelToLeft = clampedX > 66;
          const pinLabel = resolvePinLabel(slot);
          const activeColorKey =
            selectedColorBySlot[slot.slotKey] ?? slot.variants[0]?.colorKey;
          const activeVariant =
            slot.variants.find((v) => v.colorKey === activeColorKey) ??
            slot.variants[0];

          return (
            <button
              key={`${season.slug}-${slot.slotKey}`}
              type="button"
              data-hotspot-pin="true"
              data-testid={`season-hotspot-${slot.slotKey.toLowerCase()}`}
              data-slot-key={slot.slotKey}
              aria-expanded={isOpen}
              aria-label={`Tùy chỉnh màu ${slot.productName} (${activeVariant?.colorName ?? ''})`}
              className={`${styles.hotspotPin} ${isOpen ? styles.hotspotPinActive : ''} ${
                isHovered ? styles.hotspotPinHovered : ''
              } ${labelToLeft ? styles.hotspotPinReverse : ''}`}
              style={{
                left: `${clampedX}%`,
                top: `${clampedY}%`,
              }}
              onMouseEnter={() => onHoverSlot(slot.slotKey)}
              onMouseLeave={() => onHoverSlot(null)}
              onFocus={() => onHoverSlot(slot.slotKey)}
              onBlur={() => onHoverSlot(null)}
              onClick={() => onTogglePopover(isOpen ? null : slot.slotKey)}
            >
              <span className={styles.hotspotDot} aria-hidden="true">
                <span className={styles.hotspotPlus}>+</span>
              </span>
              <span className={styles.hotspotPill}>{pinLabel}</span>
            </button>
          );
        })}

        {/* Floating AiContextSwatchPopover anchored beside active garment hotspot */}
        {activePopoverSlot ? (
          <div
            data-testid="season-swatch-popover"
            data-slot-key={activePopoverSlot.slotKey}
            role="dialog"
            aria-label={`Chọn màu AI cho ${activePopoverSlot.productName}`}
            className={styles.swatchPopover}
            style={popoverAnchorStyle}
          >
            <div className={styles.swatchPopoverHead}>
              <div className={styles.swatchPopoverTitles}>
                <p className={styles.swatchPopoverName}>
                  {activePopoverSlot.productName}
                </p>
                <p className={styles.swatchPopoverSub}>
                  {scanActiveKey > 0 || isRestylingServer
                    ? 'Đang đổi ngữ cảnh AI'
                    : 'Đang đổi ngữ cảnh AI · Chọn sắc độ vải'}
                </p>
              </div>
              <button
                type="button"
                className={styles.swatchPopoverClose}
                aria-label="Đóng bảng màu"
                onClick={() => onTogglePopover(null)}
              >
                ×
              </button>
            </div>

            <div className={styles.swatchPopoverGrid}>
              {activePopoverSlot.variants.map((variant) => {
                const activeColorKey =
                  selectedColorBySlot[activePopoverSlot.slotKey] ??
                  activePopoverSlot.variants[0]?.colorKey;
                const isSelected = variant.colorKey === activeColorKey;
                return (
                  <button
                    key={variant.colorKey}
                    type="button"
                    data-testid={`season-popover-swatch-${activePopoverSlot.slotKey.toLowerCase()}-${variant.colorKey}`}
                    data-color-hex={variant.colorHex}
                    data-color-key={variant.colorKey}
                    aria-pressed={isSelected}
                    aria-label={`${variant.colorName} (${variant.colorHex})`}
                    title={variant.colorName}
                    className={`${styles.popoverSwatchBtn} ${
                      isSelected ? styles.popoverSwatchBtnActive : ''
                    }`}
                    onClick={() => onSelectSlotVariant(activePopoverSlot, variant)}
                  >
                    <span
                      className={styles.popoverSwatchCircle}
                      style={{ backgroundColor: variant.colorHex }}
                    />
                  </button>
                );
              })}
            </div>

            <p className={styles.swatchPopoverColorLabel}>
              {(
                activePopoverSlot.variants.find(
                  (v) =>
                    v.colorKey ===
                    (selectedColorBySlot[activePopoverSlot.slotKey] ??
                      activePopoverSlot.variants[0]?.colorKey),
                ) ?? activePopoverSlot.variants[0]
              )?.colorName ?? ''}
            </p>
          </div>
        ) : null}

        {/* Bottom-right Espresso CTA Pill: ✦ Ướm thử set này AI */}
        <button
          type="button"
          data-testid="season-tryon-set-btn"
          className={styles.tryOnSetPill}
          onClick={onOpenSetTryOn}
        >
          <span className={styles.tryOnSparkle} aria-hidden="true">
            ✦
          </span>
          <span>Ướm thử set này AI</span>
        </button>
      </div>
    </div>
  );
}
