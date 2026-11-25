'use client';

import { useGSAP } from '@gsap/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { OutfitSlot, type PackagingOptionDto } from '@atelier/contracts';
import { usePrefersReducedMotion } from '@atelier/motion-kit';
import { ensureGsapRegistered, gsap } from '@/lib/gsap-setup';
import type { FittedGarmentBounds } from './autoCalibrateGarment';
import {
  AutoFittedGarmentCanvas,
  type StageFittedLayout,
} from './AutoFittedGarmentCanvas';
import {
  getOrderedOutfitSelections,
  OUTFIT_LAYER_Z_INDEX,
  type OutfitSlotSelection,
  type OutfitSlotsMap,
} from './compositor';
import { GhostMannequinSvg, type CoveredTorsoRange } from './GhostMannequinSvg';
import { MANNEQUIN_METRICS } from './mannequinMetrics';
import { OpticalFabricLoupe } from './OpticalFabricLoupe';
import { OUTFIT_PRESETS, type OutfitPresetId } from './presets';

export interface FlyInOrigin {
  slot: OutfitSlot;
  key: number;
  clientX: number;
  clientY: number;
}

export interface GarmentLayerStageProps {
  slots: OutfitSlotsMap;
  activePackaging: PackagingOptionDto | null;
  isFinalized: boolean;
  flyOrigin: FlyInOrigin | null;
  snapshotDataUrl: string | null;
  activePresetId: OutfitPresetId | null;
  lightingMode: 'morning' | 'evening';
  viewSide: 'front' | 'back';
  loupeEnabled: boolean;
  isDragOver?: boolean;
  onSelectPreset: (presetId: OutfitPresetId) => void;
  onChangeLighting: (mode: 'morning' | 'evening') => void;
  onToggleViewSide: () => void;
  onToggleLoupe: () => void;
  onTriggerTryOn: () => void;
  onPinClick?: (slot: OutfitSlot) => void;
  onToggleOuterwearDrape?: () => void;
  onRemoveSlot: (slot: OutfitSlot) => void;
  onDropProduct?: (productId: string, clientX: number, clientY: number) => void;
  stageContainerRef?: React.RefObject<HTMLDivElement | null>;
}

interface ComputedPinPlacement {
  item: OutfitSlotSelection;
  side: 'left' | 'right';
  /** Anchor coordinate on fitted garment edge inside frameBox (pixels) */
  dotX: number;
  dotY: number;
  /** Anti-overlapped vertical pill position inside frameBox (pixels) */
  pinY: number;
  /** Total span width from frame outer edge to garment edge dot (pixels) */
  connectorSpanPx: number;
}

function formatPinLabel(
  item: OutfitSlotSelection,
  hasOnePiece: boolean,
): string {
  if (item.slot === OutfitSlot.OUTERWEAR) {
    const effectiveDrape = item.drapeStyle ?? (hasOnePiece ? 'shoulder' : 'front');
    return effectiveDrape === 'shoulder'
      ? 'Áo khoác · Khoác vai'
      : `Áo khoác · Size ${item.sizeCode}`;
  }
  if (item.slot === OutfitSlot.ONE_PIECE) {
    const lower = item.productName.toLowerCase();
    if (lower.includes('áo dài')) {
      return `Áo dài · Size ${item.sizeCode}`;
    }
    const isSilk = lower.includes('lụa');
    return `${isSilk ? 'Đầm lụa' : 'Đầm liền'} · Size ${item.sizeCode}`;
  }
  if (item.slot === OutfitSlot.TOP) {
    return `Áo · Size ${item.sizeCode}`;
  }
  if (item.slot === OutfitSlot.BOTTOM) {
    const lower = item.productName.toLowerCase();
    return `${lower.includes('váy') ? 'Chân váy' : 'Quần tây'} · Size ${item.sizeCode}`;
  }
  const accLower = `${item.slug} ${item.productName}`.toLowerCase();
  if (accLower.includes('clutch') || accLower.includes('ví')) {
    return 'Ví Clutch';
  }
  if (accLower.includes('khăn') || accLower.includes('khan')) {
    return 'Khăn lụa';
  }
  if (accLower.includes('thắt lưng') || accLower.includes('that-lung')) {
    return 'Thắt lưng';
  }
  return 'Phụ kiện';
}

function getDefaultSlotAnchor(
  item: OutfitSlotSelection,
  viewSide: 'front' | 'back',
): { side: 'left' | 'right'; normX: number; normY: number } {
  if (item.slot === OutfitSlot.OUTERWEAR) {
    return { side: 'left', normX: 0.30, normY: 0.255 };
  }
  if (item.slot === OutfitSlot.TOP) {
    return { side: 'right', normX: 0.64, normY: 0.285 };
  }
  if (item.slot === OutfitSlot.ONE_PIECE) {
    return { side: 'right', normX: 0.635, normY: 0.44 };
  }
  if (item.slot === OutfitSlot.BOTTOM) {
    return { side: 'left', normX: 0.35, normY: 0.60 };
  }
  const hay = `${item.slug} ${item.productName}`.toLowerCase();
  if (hay.includes('khăn') || hay.includes('khan')) {
    return { side: 'right', normX: 0.61, normY: 0.235 };
  }
  if (hay.includes('thắt lưng') || hay.includes('that-lung')) {
    return { side: 'right', normX: 0.60, normY: MANNEQUIN_METRICS.yWaist };
  }
  return viewSide === 'back'
    ? { side: 'left', normX: 0.27, normY: 0.545 }
    : { side: 'right', normX: 0.73, normY: 0.545 };
}

function computePinAnchorFromBounds(
  item: OutfitSlotSelection,
  bounds: FittedGarmentBounds | undefined,
  viewSide: 'front' | 'back',
): { side: 'left' | 'right'; normX: number; normY: number } {
  const fallback = getDefaultSlotAnchor(item, viewSide);
  if (!bounds) return fallback;

  if (item.slot === OutfitSlot.OUTERWEAR) {
    return {
      side: 'left',
      normX: Math.max(0.14, Math.min(0.42, bounds.shoulderLeftX + 0.012)),
      normY: Math.max(0.22, Math.min(0.30, bounds.topY + 0.065)),
    };
  }
  if (item.slot === OutfitSlot.TOP) {
    return {
      side: 'right',
      normX: Math.max(0.58, Math.min(0.84, bounds.shoulderRightX - 0.012)),
      normY: 0.285,
    };
  }
  if (item.slot === OutfitSlot.ONE_PIECE) {
    const edgeX = Math.max(bounds.waistRightX, bounds.hipRightX * 0.985);
    return {
      side: 'right',
      normX: Math.max(0.58, Math.min(0.82, edgeX - 0.01)),
      normY: 0.44,
    };
  }
  if (item.slot === OutfitSlot.BOTTOM) {
    return {
      side: 'left',
      normX: Math.max(0.16, Math.min(0.42, bounds.hipLeftX + 0.012)),
      normY: 0.60,
    };
  }

  // ACCESSORY
  const hay = `${item.slug} ${item.productName}`.toLowerCase();
  if (hay.includes('khăn') || hay.includes('khan')) {
    return {
      side: 'right',
      normX: Math.max(0.56, Math.min(0.80, bounds.rightX - 0.01)),
      normY: bounds.midY,
    };
  }
  if (hay.includes('thắt lưng') || hay.includes('that-lung')) {
    if (viewSide === 'back' && bounds.rightX < 0.52) {
      return {
        side: 'left',
        normX: Math.max(0.16, Math.min(0.44, bounds.leftX + 0.01)),
        normY: bounds.midY,
      };
    }
    return {
      side: 'right',
      normX: Math.max(0.56, Math.min(0.84, bounds.rightX - 0.008)),
      normY: bounds.midY,
    };
  }
  if (viewSide === 'back') {
    return {
      side: 'left',
      normX: Math.max(0.16, Math.min(0.44, bounds.leftX + 0.012)),
      normY: bounds.midY,
    };
  }
  return {
    side: 'right',
    normX: Math.max(0.60, Math.min(0.86, bounds.rightX - 0.012)),
    normY: bounds.midY,
  };
}

export function GarmentLayerStage({
  slots,
  activePackaging,
  isFinalized,
  flyOrigin,
  snapshotDataUrl,
  activePresetId,
  lightingMode,
  viewSide,
  loupeEnabled,
  isDragOver = false,
  onSelectPreset,
  onChangeLighting,
  onToggleViewSide,
  onToggleLoupe,
  onTriggerTryOn,
  onPinClick,
  onToggleOuterwearDrape,
  onRemoveSlot,
  onDropProduct,
  stageContainerRef,
}: GarmentLayerStageProps) {
  const internalRef = useRef<HTMLDivElement | null>(null);
  const stageRef = stageContainerRef ?? internalRef;
  const frameBoxRef = useRef<HTMLDivElement | null>(null);
  const canvasPlaneRef = useRef<HTMLDivElement | null>(null);
  const reducedMotion = usePrefersReducedMotion();

  const wasFinalizedRef = useRef(false);
  const prevPresetRef = useRef<OutfitPresetId | null>(activePresetId);
  const [internalDragOver, setInternalDragOver] = useState(false);

  const [frameSize, setFrameSize] = useState({ width: 460, height: 500 });
  const [fittedLayout, setFittedLayout] = useState<StageFittedLayout>({
    boundsBySlot: {},
    maxGarmentBottomY: 0,
    coveredTorsoRange: null,
    occludeTorsoCage: false,
  });

  const ordered = useMemo(() => getOrderedOutfitSelections(slots), [slots]);
  const hasOnePiece = Boolean(slots[OutfitSlot.ONE_PIECE]);
  const hasPairedBottom = Boolean(slots[OutfitSlot.BOTTOM]);
  const pkgSwatch = activePackaging?.swatchHex ?? '#E8DEC8';
  const showDropHighlight = isDragOver || internalDragOver;

  // Measure center mannequin frame box for exact dynamic pin leader lines
  useEffect(() => {
    const el = frameBoxRef.current;
    if (!el) return;

    const update = () => {
      const rect = el.getBoundingClientRect();
      if (rect.width > 40 && rect.height > 40) {
        setFrameSize((prev) =>
          Math.abs(prev.width - rect.width) < 1 &&
          Math.abs(prev.height - rect.height) < 1
            ? prev
            : { width: rect.width, height: rect.height },
        );
      }
    };

    update();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Optimistic SSR/initial-frame occlusion before async calibration resolves (~25ms)
  const effectiveOcclusion = useMemo<{
    occludeTorsoCage: boolean;
    coveredTorsoRange: CoveredTorsoRange | null;
    maxGarmentBottomY: number;
  }>(() => {
    if (ordered.length === 0) {
      return {
        occludeTorsoCage: false,
        coveredTorsoRange: null,
        maxGarmentBottomY: 0,
      };
    }

    const activeSlotSet = new Set(ordered.map((s) => s.slot));
    const hasCalibratedWearable = ordered.some(
      (s) =>
        s.slot !== OutfitSlot.ACCESSORY &&
        Boolean(fittedLayout.boundsBySlot[s.slot]),
    );

    if (hasCalibratedWearable) {
      return {
        occludeTorsoCage: fittedLayout.occludeTorsoCage,
        coveredTorsoRange: fittedLayout.coveredTorsoRange,
        maxGarmentBottomY: fittedLayout.maxGarmentBottomY,
      };
    }

    const hasFull =
      activeSlotSet.has(OutfitSlot.ONE_PIECE) ||
      (activeSlotSet.has(OutfitSlot.TOP) && activeSlotSet.has(OutfitSlot.BOTTOM));
    const hasTopOrOuter =
      activeSlotSet.has(OutfitSlot.TOP) || activeSlotSet.has(OutfitSlot.OUTERWEAR);
    const hasLowerOrDress =
      activeSlotSet.has(OutfitSlot.ONE_PIECE) || activeSlotSet.has(OutfitSlot.BOTTOM);

    if (!hasTopOrOuter && !hasLowerOrDress) {
      return {
        occludeTorsoCage: false,
        coveredTorsoRange: null,
        maxGarmentBottomY: 0,
      };
    }

    const topY = hasTopOrOuter
      ? MANNEQUIN_METRICS.yShoulder
      : activeSlotSet.has(OutfitSlot.ONE_PIECE)
        ? MANNEQUIN_METRICS.yUpperBust
        : 0.41;
    const bottomY = hasLowerOrDress
      ? MANNEQUIN_METRICS.yMaxi - 0.04
      : MANNEQUIN_METRICS.yHip;

    return {
      occludeTorsoCage: hasFull,
      coveredTorsoRange: { topY, bottomY },
      maxGarmentBottomY: bottomY,
    };
  }, [fittedLayout, ordered]);

  // Primary garment metadata for 3x Optical Fabric Loupe aria-label & fallback URL
  const primaryGarment = useMemo(
    () =>
      slots[OutfitSlot.ONE_PIECE] ??
      slots[OutfitSlot.TOP] ??
      slots[OutfitSlot.OUTERWEAR] ??
      slots[OutfitSlot.BOTTOM] ??
      slots[OutfitSlot.ACCESSORY] ??
      null,
    [slots],
  );

  const primaryLoupeImageUrl = useMemo(() => {
    if (!primaryGarment) return null;
    return viewSide === 'back'
      ? primaryGarment.backImageUrl || primaryGarment.imageUrl
      : primaryGarment.imageUrl;
  }, [primaryGarment, viewSide]);

  // Dynamic pin placements + anti-overlap resolution relative to the 2:3 mannequin box
  const computedPins = useMemo<ComputedPinPlacement[]>(() => {
    if (ordered.length === 0) return [];

    const frameW = Math.max(240, frameSize.width);
    const frameH = Math.max(320, frameSize.height);
    const boxW = Math.min(frameW, frameH * (MANNEQUIN_METRICS.width / MANNEQUIN_METRICS.height));
    const boxLeft = (frameW - boxW) * 0.5;

    const raw = ordered.map((item) => {
      const bounds = fittedLayout.boundsBySlot[item.slot];
      const anchor = computePinAnchorFromBounds(item, bounds, viewSide);
      return {
        item,
        side: anchor.side,
        dotX: boxLeft + anchor.normX * boxW,
        dotY: anchor.normY * frameH,
        pinY: anchor.normY * frameH,
      };
    });

    const resolveSide = (side: 'left' | 'right') => {
      const list = raw
        .filter((p) => p.side === side)
        .sort((a, b) => a.dotY - b.dotY);

      const minGapPx = 56;
      const minY = frameH * 0.14;
      const maxY = frameH * 0.84;

      for (let i = 0; i < list.length; i += 1) {
        const cur = list[i]!;
        cur.pinY = Math.max(minY, Math.min(maxY, cur.dotY));
        if (i > 0) {
          const prev = list[i - 1]!;
          if (cur.pinY - prev.pinY < minGapPx) {
            cur.pinY = Math.min(maxY, prev.pinY + minGapPx);
          }
        }
      }
      // Backward pass if pushed against bottom bound
      for (let i = list.length - 2; i >= 0; i -= 1) {
        const cur = list[i]!;
        const next = list[i + 1]!;
        if (next.pinY - cur.pinY < minGapPx) {
          cur.pinY = Math.max(minY, next.pinY - minGapPx);
        }
      }
    };

    resolveSide('left');
    resolveSide('right');

    const outerPad = 6;
    return raw.map((p) => ({
      ...p,
      connectorSpanPx:
        p.side === 'left'
          ? Math.max(120, p.dotX - outerPad)
          : Math.max(120, frameW - p.dotX - outerPad),
    }));
  }, [fittedLayout.boundsBySlot, frameSize.height, frameSize.width, ordered, viewSide]);

  // Subtle GSAP bounce on single garment addition (respects reducedMotion)
  useGSAP(
    () => {
      ensureGsapRegistered();
      if (!flyOrigin || !canvasPlaneRef.current) return;
      gsap.fromTo(
        canvasPlaneRef.current,
        {
          scale: reducedMotion ? 0.99 : 0.955,
          opacity: reducedMotion ? 0.85 : 0.72,
        },
        {
          scale: 1,
          opacity: 1,
          duration: reducedMotion ? 0.2 : 0.45,
          ease: 'back.out(1.25)',
          overwrite: 'auto',
        },
      );
    },
    { scope: stageRef, dependencies: [flyOrigin?.key, reducedMotion] },
  );

  // Subtle GSAP entrance when switching curated presets
  useGSAP(
    () => {
      ensureGsapRegistered();
      if (!canvasPlaneRef.current) return;
      if (!activePresetId || activePresetId === prevPresetRef.current) {
        prevPresetRef.current = activePresetId;
        return;
      }
      prevPresetRef.current = activePresetId;

      gsap.fromTo(
        canvasPlaneRef.current,
        {
          y: reducedMotion ? 0 : 12,
          scale: reducedMotion ? 1 : 0.96,
          opacity: 0.65,
        },
        {
          y: 0,
          scale: 1,
          opacity: 1,
          duration: reducedMotion ? 0.2 : 0.45,
          ease: 'power2.out',
          overwrite: 'auto',
        },
      );
    },
    { scope: stageRef, dependencies: [activePresetId, reducedMotion] },
  );

  // Gift box (.outfit__pkg-back, .outfit__pkg-front) & wax seal (.outfit__seal) 0.9s closing ritual.
  // Strictly hidden (opacity: 0; visibility: hidden; pointerEvents: none) whenever !isFinalized!
  useGSAP(
    () => {
      ensureGsapRegistered();
      if (!stageRef.current) return;
      const pkgBack = stageRef.current.querySelector<HTMLElement>('.outfit__pkg-back');
      const pkgFront = stageRef.current.querySelector<HTMLElement>('.outfit__pkg-front');
      const seal = stageRef.current.querySelector<HTMLElement>('.outfit__seal');

      if (!pkgBack || !pkgFront || !seal) return;

      if (isFinalized) {
        wasFinalizedRef.current = true;
        const tl = gsap.timeline();
        if (reducedMotion) {
          tl.to([pkgBack, pkgFront, seal], {
            autoAlpha: 1,
            scale: 1,
            yPercent: 0,
            rotation: 0,
            duration: 0.18,
            ease: 'power2.out',
          });
        } else {
          tl.fromTo(
            pkgBack,
            { autoAlpha: 0, scale: 0.96 },
            { autoAlpha: 1, scale: 1, duration: 0.45, ease: 'power3.out' },
            0,
          )
            .fromTo(
              pkgFront,
              { yPercent: 28, autoAlpha: 0 },
              { yPercent: 0, autoAlpha: 1, duration: 0.56, ease: 'power3.out' },
              0.12,
            )
            .fromTo(
              seal,
              { scale: 0.45, autoAlpha: 0, rotation: -18 },
              {
                scale: 1,
                autoAlpha: 1,
                rotation: 0,
                duration: 0.55,
                ease: 'back.out(1.6)',
              },
              0.35,
            );
        }
      } else if (wasFinalizedRef.current) {
        wasFinalizedRef.current = false;
        gsap.to([pkgBack, pkgFront, seal], {
          autoAlpha: 0,
          pointerEvents: 'none',
          duration: reducedMotion ? 0.1 : 0.28,
          ease: 'power2.out',
          overwrite: 'auto',
        });
      } else {
        gsap.set([pkgBack, pkgFront, seal], {
          autoAlpha: 0,
          pointerEvents: 'none',
        });
      }
    },
    { scope: stageRef, dependencies: [isFinalized, reducedMotion] },
  );

  // HTML5 Drag & Drop handlers on stage dropzone
  const handleDragEnter = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setInternalDragOver(true);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    setInternalDragOver((prev) => (prev ? prev : true));
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    const related = e.relatedTarget as Node | null;
    if (related && e.currentTarget.contains(related)) {
      return;
    }
    setInternalDragOver(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setInternalDragOver(false);
      const productId =
        e.dataTransfer.getData('text/plain') ||
        e.dataTransfer.getData('application/x-atelier-product-id');
      if (productId && onDropProduct) {
        onDropProduct(productId, e.clientX, e.clientY);
      }
    },
    [onDropProduct],
  );

  const stageBackdrop =
    lightingMode === 'evening'
      ? 'radial-gradient(circle at 50% 35%, #FAF0DF 0%, #E5D4B7 68%, #D4BE98 100%)'
      : 'radial-gradient(circle at 50% 38%, #FFFDF9 0%, #F3EBDD 100%)';

  const renderMannequinFace = (face: 'front' | 'back') => {
    const isActiveFace = face === viewSide;
    return (
      <div
        className="absolute inset-0 flex items-center justify-center"
        style={{
          backfaceVisibility: 'hidden',
          WebkitBackfaceVisibility: 'hidden',
          transform: face === 'back' ? 'rotateY(180deg)' : 'rotateY(0deg)',
          pointerEvents: isActiveFace ? 'auto' : 'none',
        }}
        aria-hidden={!isActiveFace}
      >
        {/* Exact 1:1 unified 2:3 (600×900) stack: 2-Layer Occlusion Mannequin + HiDPI Garment Canvas */}
        <div className="relative mx-auto aspect-[2/3] h-full max-w-full">
          <div className="pointer-events-none absolute inset-0 z-10">
            <GhostMannequinSvg
              viewSide={face}
              className="h-full w-full"
              coveredTorsoRange={effectiveOcclusion.coveredTorsoRange}
              coveredMaxBottomY={effectiveOcclusion.maxGarmentBottomY}
              occludeTorsoCage={effectiveOcclusion.occludeTorsoCage}
            />
          </div>

          <div className="absolute inset-0 z-20">
            <AutoFittedGarmentCanvas
              ordered={ordered}
              face={face}
              isActiveFace={isActiveFace}
              hasOnePiece={hasOnePiece}
              hasPairedBottom={hasPairedBottom}
              lightingMode={lightingMode}
              reducedMotion={reducedMotion}
              onLayoutComputed={isActiveFace ? setFittedLayout : undefined}
            />
          </div>
        </div>
      </div>
    );
  };

  return (
    <div
      ref={stageRef}
      id="bStage"
      data-lighting-mode={lightingMode}
      data-view-side={viewSide}
      data-loupe-enabled={loupeEnabled ? 'true' : 'false'}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={`build__stage relative flex min-h-[620px] w-full flex-col justify-between overflow-hidden rounded-[28px] border transition-all duration-500 lg:min-h-[680px] ${
        showDropHighlight
          ? 'border-[#B08A4A] ring-2 ring-[#B08A4A]/60 shadow-[0_24px_60px_-20px_rgba(176,138,74,0.42)]'
          : 'border-[#B08A4A]/32 shadow-[inset_0_1px_0_rgba(255,255,255,0.85),0_20px_50px_-28px_rgba(43,32,25,0.22)]'
      } ${loupeEnabled ? 'cursor-none' : ''}`}
      style={{
        background: stageBackdrop,
      }}
    >
      {/* Subtle architectural atelier inner frame & evening champagne spotlight */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-3 rounded-[22px] border border-[#B08A4A]/18 transition-opacity duration-500"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 transition-opacity duration-700"
        style={{
          opacity: lightingMode === 'evening' ? 1 : 0,
          background:
            'radial-gradient(ellipse 68% 45% at 50% 8%, rgba(255, 241, 206, 0.52) 0%, rgba(176, 138, 74, 0.08) 55%, rgba(28, 20, 16, 0.14) 100%)',
        }}
      />

      {/* Drag & drop overlay cue */}
      {showDropHighlight ? (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-4 z-50 flex items-center justify-center rounded-[22px] border-2 border-dashed border-[#B08A4A] bg-[#FBF7EF]/35 backdrop-blur-[2px]"
        >
          <span className="rounded-full border border-[#B08A4A]/60 bg-[#1C1410]/90 px-4 py-1.5 text-[11px] font-medium tracking-[0.18em] uppercase text-[#EBCF8F] shadow-lg">
            Thả thiết kế lên manocanh
          </span>
        </div>
      ) : null}

      {/* Layer 0: PKG_BACK (z-index: 0) — strictly hidden when !isFinalized */}
      <div
        className="outfit__pkg-back pointer-events-none absolute inset-5 rounded-[24px] border border-[#B08A4A]/45 transition-colors duration-500"
        style={{
          zIndex: OUTFIT_LAYER_Z_INDEX.PKG_BACK,
          background: `radial-gradient(ellipse at 50% 25%, #fffdf8 0%, ${pkgSwatch} 145%)`,
          opacity: 0,
          visibility: 'hidden',
          pointerEvents: 'none',
        }}
        aria-hidden="true"
      />

      {/* TOP BAR: Atelier Stage Header, Lighting Toggle & 3 Curated Preset Pills */}
      <div className="relative z-30 flex flex-col gap-2.5 px-4 pt-4 sm:px-5 sm:pt-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-[10px] font-medium tracking-[0.26em] uppercase text-[#8A672C]">
            Interactive Atelier Stage
          </span>

          {/* Lighting Mode Segmented Toggle (Nắng Sớm / Đèn Tiệc) */}
          <div
            role="group"
            aria-label="Chế độ ánh sáng sân khấu"
            className="inline-flex items-center rounded-full border border-[#B08A4A]/35 bg-[#FBF7EF]/85 p-0.5 backdrop-blur-sm"
          >
            <button
              type="button"
              data-testid="lighting-toggle-morning"
              aria-pressed={lightingMode === 'morning'}
              onClick={() => onChangeLighting('morning')}
              className={`rounded-full px-2.5 py-1 text-[10.5px] font-medium transition-all ${
                lightingMode === 'morning'
                  ? 'bg-[#1C1410] text-[#FBF7EF] shadow-sm'
                  : 'text-[#6B5B4C] hover:text-[#1C1410]'
              }`}
            >
              ☀ Nắng Sớm
            </button>
            <button
              type="button"
              data-testid="lighting-toggle-evening"
              aria-pressed={lightingMode === 'evening'}
              onClick={() => onChangeLighting('evening')}
              className={`rounded-full px-2.5 py-1 text-[10.5px] font-medium transition-all ${
                lightingMode === 'evening'
                  ? 'bg-[#1C1410] text-[#EBCF8F] shadow-sm'
                  : 'text-[#6B5B4C] hover:text-[#1C1410]'
              }`}
            >
              ◐ Đèn Tiệc
            </button>
          </div>
        </div>

        {/* 3 Curated 1-Click Preset Pills */}
        <div
          role="group"
          aria-label="Bộ phối gợi ý từ Stylist"
          className="flex flex-wrap items-center justify-center gap-1.5"
        >
          {OUTFIT_PRESETS.map((preset) => {
            const isActive = activePresetId === preset.id;
            return (
              <button
                key={preset.id}
                type="button"
                data-testid={`preset-${preset.id}`}
                aria-pressed={isActive}
                title={preset.shortDescription}
                onClick={() => onSelectPreset(preset.id)}
                className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[11px] font-medium transition-all ${
                  isActive
                    ? 'border-[#1C1410] bg-[#1C1410] text-[#FBF7EF] shadow-[0_6px_16px_rgba(28,20,16,0.18)]'
                    : 'border-[#B08A4A]/32 bg-[#FBF7EF]/82 text-[#2B2019] hover:border-[#B08A4A] hover:bg-[#FBF7EF]'
                }`}
              >
                <span
                  className={`h-1.5 w-1.5 rounded-full transition-colors ${
                    isActive ? 'bg-[#EBCF8F]' : 'bg-[#B08A4A]/55'
                  }`}
                />
                <span>{preset.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* CENTER MANNEQUIN & AUTOFIT CANVAS COMPOSITION AREA */}
      <div className="relative z-20 mx-auto flex w-full flex-1 items-center justify-center px-2 py-2 sm:px-3">
        {/* Back View Subtle Indicator Pill */}
        {viewSide === 'back' && ordered.length > 0 ? (
          <div
            data-testid="stage-back-view-indicator"
            className="pointer-events-none absolute top-1 left-1/2 z-40 -translate-x-1/2 rounded-full border border-[#B08A4A]/40 bg-[#FBF7EF]/90 px-3 py-0.5 text-[10px] font-medium tracking-[0.18em] uppercase text-[#8A672C] shadow-sm backdrop-blur-sm"
          >
            Góc nhìn mặt sau
          </div>
        ) : null}

        {/* Proportional Atelier Stage Frame Box (zero CLS) */}
        <div
          ref={frameBoxRef}
          className="relative mx-auto w-full max-w-[490px]"
          style={{
            height: 'clamp(440px, 58vh, 530px)',
            perspective: '1100px',
          }}
        >
          {/* 3D rotateY Front / Back Flip Plane */}
          <div
            ref={canvasPlaneRef}
            className="relative h-full w-full"
            style={{
              transformStyle: 'preserve-3d',
              transition: reducedMotion
                ? 'none'
                : 'transform 650ms cubic-bezier(0.22, 0.8, 0.22, 1)',
              transform: viewSide === 'back' ? 'rotateY(180deg)' : 'rotateY(0deg)',
            }}
          >
            {renderMannequinFace('front')}
            {renderMannequinFace('back')}
          </div>

          {/* Empty Stage Editorial Cue overlaid softly over gold mannequin */}
          {ordered.length === 0 ? (
            <div className="pointer-events-none absolute inset-x-4 bottom-8 z-30 flex justify-center">
              <div className="rounded-2xl border border-[#B08A4A]/35 bg-[#FBF7EF]/90 px-5 py-3.5 text-center shadow-sm backdrop-blur-sm">
                <p className="font-editorial text-lg italic text-[#2B2019]">
                  Chọn thiết kế từ tủ đồ hoặc thử nhanh 1 bộ phối phía trên.
                </p>
                <p className="mt-1 text-[11px] text-[#7A6A5B]">
                  Kéo thả hoặc nhấn + để mặc trực tiếp lên manocanh Atelier
                </p>
              </div>
            </div>
          ) : null}

          {/* Dynamic Interactive Frosted Layer Pins with Embedded × & Gold Leader Lines */}
          {!isFinalized && ordered.length > 0 ? (
            <div className="pointer-events-none absolute inset-0 z-40 hidden sm:block">
              {computedPins.map((pin) => {
                const { item, side, pinY, connectorSpanPx } = pin;
                const isLeft = side === 'left';
                const effectiveDrape =
                  item.slot === OutfitSlot.OUTERWEAR
                    ? item.drapeStyle ?? (hasOnePiece ? 'shoulder' : 'front')
                    : null;

                return (
                  <div
                    key={`pin-${item.slot}`}
                    className={`pointer-events-none absolute flex items-center ${
                      isLeft ? 'left-1.5 flex-row' : 'right-1.5 flex-row-reverse'
                    }`}
                    style={{
                      top: `${pinY.toFixed(1)}px`,
                      width: `${connectorSpanPx.toFixed(1)}px`,
                      transform: 'translateY(-50%)',
                    }}
                  >
                    <div className="pointer-events-auto flex shrink-0 flex-col gap-1">
                      <div
                        data-testid={`stage-pin-${item.slot}`}
                        className="inline-flex items-center gap-1 rounded-full border border-[#B08A4A]/38 bg-[rgba(251,247,239,0.92)] py-0.5 pr-1 pl-2.5 text-[11px] font-medium whitespace-nowrap text-[#2B2019] shadow-[0_6px_18px_rgba(28,20,16,0.08)] backdrop-blur-sm transition-all hover:border-[#B08A4A] hover:bg-[#FBF7EF]"
                      >
                        <button
                          type="button"
                          onClick={() => onPinClick?.(item.slot)}
                          className="inline-flex items-center gap-1.5 py-0.5 text-left focus-visible:outline-none"
                        >
                          <span
                            className="h-2 w-2 shrink-0 rounded-full border border-black/15"
                            style={{ backgroundColor: item.colorHex }}
                          />
                          <span>{formatPinLabel(item, hasOnePiece)}</span>
                        </button>

                        <button
                          type="button"
                          data-testid={`stage-pin-remove-${item.slot}`}
                          aria-label={`Bỏ ${item.productName}`}
                          title={`Bỏ ${item.productName}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            onRemoveSlot(item.slot);
                          }}
                          className="ml-0.5 flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full text-[13px] leading-none text-[#7A6A5B] transition-colors hover:bg-[#1C1410] hover:text-[#EBCF8F] focus-visible:bg-[#1C1410] focus-visible:text-[#EBCF8F]"
                        >
                          ×
                        </button>
                      </div>

                      {item.slot === OutfitSlot.OUTERWEAR && onToggleOuterwearDrape ? (
                        <button
                          type="button"
                          data-testid="stage-outerwear-drape-btn"
                          onClick={(e) => {
                            e.stopPropagation();
                            onToggleOuterwearDrape();
                          }}
                          className="self-start rounded-full border border-[#B08A4A]/32 bg-[#FBF7EF]/90 px-2 py-0.5 text-[10px] font-medium text-[#8A672C] backdrop-blur-sm transition-colors hover:border-[#B08A4A] hover:bg-[#1C1410] hover:text-[#EBCF8F]"
                        >
                          {effectiveDrape === 'shoulder'
                            ? '↻ Đổi mặc chuẩn'
                            : '↻ Đổi khoác vai'}
                        </button>
                      ) : null}
                    </div>

                    {/* Dynamic thin warm-gold leader line stretching cleanly to fitted garment edge */}
                    <span
                      aria-hidden="true"
                      className="flex min-w-[10px] flex-1 items-center"
                    >
                      {isLeft ? (
                        <>
                          <span className="h-px flex-1 bg-gradient-to-r from-[#B08A4A]/50 to-[#B08A4A]/90" />
                          <span className="h-1.5 w-1.5 shrink-0 rounded-full border border-[#FBF7EF] bg-[#B08A4A] shadow-sm" />
                        </>
                      ) : (
                        <>
                          <span className="h-1.5 w-1.5 shrink-0 rounded-full border border-[#FBF7EF] bg-[#B08A4A] shadow-sm" />
                          <span className="h-px flex-1 bg-gradient-to-l from-[#B08A4A]/50 to-[#B08A4A]/90" />
                        </>
                      )}
                    </span>
                  </div>
                );
              })}
            </div>
          ) : null}
        </div>
      </div>

      {/* 3x Optical Fabric Loupe (tracks stageContainerRef at 60fps via rAF) */}
      <OpticalFabricLoupe
        enabled={loupeEnabled && !isFinalized && ordered.length > 0}
        imageUrl={primaryLoupeImageUrl}
        productName={primaryGarment?.productName}
        colorName={primaryGarment?.colorName}
        stageContainerRef={stageRef}
      />

      {/* BOTTOM FLOATING StageControlDock */}
      <div className="relative z-30 flex justify-center px-3 pb-4 sm:px-4 sm:pb-5">
        <div
          role="toolbar"
          aria-label="Công cụ tương tác sân khấu"
          className="inline-flex flex-wrap items-center justify-center gap-1.5 rounded-full border border-[#B08A4A]/35 bg-[#FBF7EF]/92 p-1.5 shadow-[0_12px_32px_rgba(28,20,16,0.12)] backdrop-blur-md"
        >
          <button
            type="button"
            data-testid="stage-flip-btn"
            aria-pressed={viewSide === 'back'}
            disabled={ordered.length === 0}
            onClick={onToggleViewSide}
            className={`inline-flex items-center gap-1.5 rounded-full px-3.5 py-2 text-[11.5px] font-medium transition-all disabled:cursor-not-allowed disabled:opacity-45 ${
              viewSide === 'back'
                ? 'bg-[#EBD9B4] text-[#1C1410] ring-1 ring-[#B08A4A]/60'
                : 'text-[#2B2019] hover:bg-[#F4EBDA]'
            }`}
          >
            <span aria-hidden="true">↻</span>
            <span>Mặt trước / sau</span>
          </button>

          <button
            type="button"
            data-testid="stage-loupe-btn"
            aria-pressed={loupeEnabled}
            disabled={ordered.length === 0}
            onClick={onToggleLoupe}
            className={`inline-flex items-center gap-1.5 rounded-full px-3.5 py-2 text-[11.5px] font-medium transition-all disabled:cursor-not-allowed disabled:opacity-45 ${
              loupeEnabled
                ? 'bg-[#EBD9B4] text-[#1C1410] ring-1 ring-[#B08A4A]/60'
                : 'text-[#2B2019] hover:bg-[#F4EBDA]'
            }`}
          >
            <span aria-hidden="true">◎</span>
            <span>Soi chất liệu</span>
          </button>

          <button
            type="button"
            data-testid="stage-tryon-btn"
            disabled={ordered.length === 0}
            onClick={onTriggerTryOn}
            className="inline-flex items-center gap-1.5 rounded-full bg-[#1C1410] px-4 py-2 text-[11.5px] font-medium text-[#FBF7EF] shadow-sm transition-colors hover:bg-[#B08A4A] hover:text-[#1C1410] disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-[#1C1410] disabled:hover:text-[#FBF7EF]"
          >
            <span aria-hidden="true">✦</span>
            <span>Ướm thử cả bộ AI</span>
          </button>
        </div>
      </div>

      {/* Layer 150: RIBBON_SEAL (z-index: 150) — strictly hidden when !isFinalized */}
      <div
        className="outfit__seal pointer-events-none absolute bottom-[92px] left-1/2 flex h-12 w-12 -translate-x-1/2 items-center justify-center rounded-full border-2 border-[#FBF7EF] bg-gradient-to-br from-[#EBCF8F] via-[#B08A4A] to-[#8A672C] font-editorial text-sm font-semibold tracking-wider text-[#1C1410] shadow-[0_8px_24px_rgba(28,20,16,0.38)]"
        style={{
          zIndex: OUTFIT_LAYER_Z_INDEX.RIBBON_SEAL,
          opacity: 0,
          visibility: 'hidden',
          pointerEvents: 'none',
        }}
        aria-hidden="true"
      >
        T&amp;V
      </div>

      {/* Layer 200: PKG_FRONT animated gift box lid (z-index: 200) — strictly hidden when !isFinalized */}
      <div
        className="outfit__pkg-front pointer-events-none absolute inset-x-6 bottom-5 rounded-2xl border border-[#EBCF8F]/55 bg-[#1C1410]/94 px-5 py-4 text-center text-[#FBF7EF] shadow-2xl backdrop-blur-md"
        style={{
          zIndex: OUTFIT_LAYER_Z_INDEX.PKG_FRONT,
          opacity: 0,
          visibility: 'hidden',
          pointerEvents: 'none',
        }}
        aria-hidden={!isFinalized}
      >
        <p className="text-[10px] tracking-[0.28em] uppercase text-[#EBCF8F]">
          Set đồ đã hoàn thiện · {ordered.length} món
        </p>
        <p className="mt-1 font-editorial text-lg text-[#FBF7EF]">
          {activePackaging?.name || 'Đóng gói Signature TryVibe'}
        </p>
      </div>

      {/* OffscreenCanvas Composite Snapshot Thumbnail Badge */}
      {isFinalized && snapshotDataUrl ? (
        <div
          className="absolute top-4 right-4 flex items-center gap-2 rounded-2xl border border-[#B08A4A]/45 bg-[#FBF7EF]/95 p-1.5 pr-3 shadow-lg"
          style={{ zIndex: OUTFIT_LAYER_Z_INDEX.PKG_FRONT + 5 }}
        >
          <img
            src={snapshotDataUrl}
            alt="Ảnh xem trước bộ phối 600×900"
            className="h-12 w-8 rounded-lg border border-[#B08A4A]/30 object-cover"
          />
          <div className="text-left">
            <p className="text-[9px] tracking-[0.18em] uppercase text-[#8A672C]">
              Ảnh phối 600×900
            </p>
            <p className="text-[11px] font-medium text-[#1C1410]">Sẵn sàng chia sẻ</p>
          </div>
        </div>
      ) : null}
    </div>
  );
}
