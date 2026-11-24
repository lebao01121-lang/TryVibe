'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { OutfitSlot } from '@atelier/contracts';
import {
  calibrateGarment,
  drawCalibratedGarment,
  drawInnerNecklineBackWrapShadow,
  drawStagePedestalContactShadow,
  type CalibratedGarment,
  type FittedGarmentBounds,
} from './autoCalibrateGarment';
import type { OutfitSlotSelection } from './compositor';
import type { CoveredTorsoRange } from './GhostMannequinSvg';
import { MANNEQUIN_METRICS } from './mannequinMetrics';

export interface StageFittedLayout {
  boundsBySlot: Partial<Record<OutfitSlot, FittedGarmentBounds>>;
  maxGarmentBottomY: number;
  coveredTorsoRange: CoveredTorsoRange | null;
  occludeTorsoCage: boolean;
}

export interface AutoFittedGarmentCanvasProps {
  ordered: readonly OutfitSlotSelection[];
  face: 'front' | 'back';
  isActiveFace: boolean;
  hasOnePiece: boolean;
  hasPairedBottom: boolean;
  lightingMode: 'morning' | 'evening';
  reducedMotion?: boolean;
  onLayoutComputed?: (layout: StageFittedLayout) => void;
  canvasElementRef?: React.RefObject<HTMLCanvasElement | null>;
}

const STAGE_W = MANNEQUIN_METRICS.width;
const STAGE_H = MANNEQUIN_METRICS.height;

const EMPTY_LAYOUT: StageFittedLayout = {
  boundsBySlot: {},
  maxGarmentBottomY: 0,
  coveredTorsoRange: null,
  occludeTorsoCage: false,
};

function drawFallbackSilhouette(
  ctx: CanvasRenderingContext2D,
  item: OutfitSlotSelection,
): FittedGarmentBounds {
  const safeHex = /^#[0-9a-fA-F]{3,8}$/.test(item.colorHex)
    ? item.colorHex
    : '#EBD9B4';

  let topY: number = MANNEQUIN_METRICS.yUpperBust;
  let bottomY: number = MANNEQUIN_METRICS.yMidi;
  let widthNorm: number = MANNEQUIN_METRICS.wHip * 1.1;
  let centerX: number = MANNEQUIN_METRICS.centerX;

  if (item.slot === OutfitSlot.TOP) {
    topY = MANNEQUIN_METRICS.yNeckBase;
    bottomY = MANNEQUIN_METRICS.yHip;
    widthNorm = MANNEQUIN_METRICS.wShoulder * 1.1;
  } else if (item.slot === OutfitSlot.BOTTOM) {
    topY = 0.41;
    bottomY = MANNEQUIN_METRICS.yMaxi;
    widthNorm = MANNEQUIN_METRICS.wHip * 1.12;
  } else if (item.slot === OutfitSlot.OUTERWEAR) {
    topY = 0.194;
    bottomY = MANNEQUIN_METRICS.yTorsoEnd;
    widthNorm = MANNEQUIN_METRICS.wShoulder * 1.16;
  } else if (item.slot === OutfitSlot.ACCESSORY) {
    topY = 0.47;
    bottomY = 0.58;
    widthNorm = 0.165;
    centerX = 0.655;
  }

  const wPx = widthNorm * STAGE_W;
  const xPx = centerX * STAGE_W - wPx * 0.5;
  const yPx = topY * STAGE_H;
  const hPx = (bottomY - topY) * STAGE_H;

  ctx.save();
  ctx.fillStyle = safeHex;
  ctx.globalAlpha = 0.85;
  ctx.beginPath();
  ctx.roundRect(xPx, yPx, wPx, hPx, 18);
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.strokeStyle = 'rgba(176, 138, 74, 0.55)';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.restore();

  const leftX = xPx / STAGE_W;
  const rightX = (xPx + wPx) / STAGE_W;
  return {
    slot: item.slot,
    topY,
    bottomY,
    leftX,
    rightX,
    shoulderLeftX: leftX,
    shoulderRightX: rightX,
    waistLeftX: leftX,
    waistRightX: rightX,
    hipLeftX: leftX,
    hipRightX: rightX,
    midY: (topY + bottomY) * 0.5,
    coveredTopY: topY,
    coveredBottomY: bottomY,
  };
}

/**
 * High-DPI 600 × 900 Canvas Renderer powered by AutoFitMannequinEngine.
 * Replaces raw `<img object-contain>` layers with 72-strip spine-straightened
 * and envelope-matched garment projection, 3D inner neckline back-wrap shadow,
 * and soft pedestal contact shadow.
 */
export function AutoFittedGarmentCanvas({
  ordered,
  face,
  isActiveFace,
  hasOnePiece,
  hasPairedBottom,
  lightingMode,
  reducedMotion = false,
  onLayoutComputed,
  canvasElementRef,
}: AutoFittedGarmentCanvasProps) {
  const internalCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const bufferCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const onLayoutRef = useRef(onLayoutComputed);
  onLayoutRef.current = onLayoutComputed;

  const [renderReady, setRenderReady] = useState(false);
  const [transitionPulse, setTransitionPulse] = useState(false);
  const prevSigRef = useRef<string>('');

  const compositionSignature = useMemo(
    () =>
      ordered
        .map(
          (item) =>
            `${item.slot}:${item.productId}:${item.variantId}:${item.drapeStyle ?? ''}:${
              face === 'back' ? item.backImageUrl ?? item.imageUrl ?? '' : item.imageUrl ?? ''
            }`,
        )
        .join('|'),
    [ordered, face],
  );

  // Clean up reusable offscreen buffer on unmount
  useEffect(() => {
    return () => {
      if (bufferCanvasRef.current) {
        bufferCanvasRef.current.width = 0;
        bufferCanvasRef.current.height = 0;
        bufferCanvasRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    const canvas = internalCanvasRef.current;
    if (!canvas) return;

    if (canvasElementRef && 'current' in canvasElementRef) {
      canvasElementRef.current = canvas;
    }

    const dpr =
      typeof window !== 'undefined'
        ? Math.min(Math.max(window.devicePixelRatio || 1, 1), 2)
        : 1;
    const targetW = Math.round(STAGE_W * dpr);
    const targetH = Math.round(STAGE_H * dpr);

    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW;
      canvas.height = targetH;
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    if (ordered.length === 0) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, STAGE_W, STAGE_H);
      setRenderReady(true);
      if (isActiveFace) {
        onLayoutRef.current?.(EMPTY_LAYOUT);
      }
      prevSigRef.current = '';
      return;
    }

    let cancelled = false;
    const isNewComposition =
      prevSigRef.current !== '' && prevSigRef.current !== compositionSignature;

    const runCalibrationAndRender = async () => {
      // 1. Calibrate wearable garments first (TOP, BOTTOM, ONE_PIECE, OUTERWEAR)
      const wearableItems = ordered.filter(
        (item) => item.slot !== OutfitSlot.ACCESSORY,
      );
      const accessoryItems = ordered.filter(
        (item) => item.slot === OutfitSlot.ACCESSORY,
      );

      const wearableResults = await Promise.all(
        wearableItems.map(async (item) => {
          const url =
            face === 'back' ? item.backImageUrl || item.imageUrl : item.imageUrl;
          if (!url) return { item, calibrated: null as CalibratedGarment | null };
          const calibrated = await calibrateGarment({
            imageUrl: url,
            slot: item.slot,
            slug: item.slug,
            productName: item.productName,
            drapeStyle: item.drapeStyle,
            face,
            hasOnePiece,
            hasPairedBottom,
          });
          return { item, calibrated };
        }),
      );

      if (cancelled) return;

      // Determine fitted waist width so belt accessories wrap cleanly over outer layer
      const calibratedBySlot = new Map<OutfitSlot, CalibratedGarment>();
      for (const entry of wearableResults) {
        if (entry.calibrated) {
          calibratedBySlot.set(entry.item.slot, entry.calibrated);
        }
      }

      const waistAnchorCal =
        (calibratedBySlot.get(OutfitSlot.OUTERWEAR)?.shoulderDrapeSplit
          ? null
          : calibratedBySlot.get(OutfitSlot.OUTERWEAR)) ??
        calibratedBySlot.get(OutfitSlot.ONE_PIECE) ??
        calibratedBySlot.get(OutfitSlot.BOTTOM) ??
        calibratedBySlot.get(OutfitSlot.TOP) ??
        null;

      const outerWaistWidthNorm = waistAnchorCal
        ? Math.max(
            MANNEQUIN_METRICS.wWaist * 1.08,
            waistAnchorCal.bounds.waistRightX - waistAnchorCal.bounds.waistLeftX,
          )
        : undefined;

      // 2. Calibrate accessories with waist hint
      const accessoryResults = await Promise.all(
        accessoryItems.map(async (item) => {
          const url =
            face === 'back' ? item.backImageUrl || item.imageUrl : item.imageUrl;
          if (!url) return { item, calibrated: null as CalibratedGarment | null };
          const calibrated = await calibrateGarment({
            imageUrl: url,
            slot: item.slot,
            slug: item.slug,
            productName: item.productName,
            face,
            hasOnePiece,
            hasPairedBottom,
            outerWaistWidthNorm,
          });
          return { item, calibrated };
        }),
      );

      if (cancelled) return;

      for (const entry of accessoryResults) {
        if (entry.calibrated) {
          calibratedBySlot.set(entry.item.slot, entry.calibrated);
        }
      }

      // Reusable 600 × 900 strip compositing buffer
      if (!bufferCanvasRef.current && typeof document !== 'undefined') {
        const buf = document.createElement('canvas');
        buf.width = STAGE_W;
        buf.height = STAGE_H;
        bufferCanvasRef.current = buf;
      }

      // Compute combined layout metrics
      const boundsBySlot: Partial<Record<OutfitSlot, FittedGarmentBounds>> = {};
      let maxGarmentBottomY = 0;
      let minCoveredTopY = 1;
      let maxCoveredBottomY = 0;
      let wearableCount = 0;

      for (const item of ordered) {
        const cal = calibratedBySlot.get(item.slot);
        if (!cal) continue;
        boundsBySlot[item.slot] = cal.bounds;
        if (item.slot !== OutfitSlot.ACCESSORY) {
          wearableCount += 1;
          if (cal.bounds.bottomY > maxGarmentBottomY) {
            maxGarmentBottomY = cal.bounds.bottomY;
          }
          if (cal.bounds.coveredTopY < minCoveredTopY) {
            minCoveredTopY = cal.bounds.coveredTopY;
          }
          if (cal.bounds.coveredBottomY > maxCoveredBottomY) {
            maxCoveredBottomY = cal.bounds.coveredBottomY;
          }
        }
      }

      // Paint HiDPI stage canvas in exact z-order
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, STAGE_W, STAGE_H);

      // A. Soft Contact Floor & Pedestal Shadow
      if (maxGarmentBottomY > 0) {
        drawStagePedestalContactShadow(ctx, maxGarmentBottomY);
      }

      // B. 3D Inner Neckline Back-Wrap Shadow behind primary upper/dress neckline
      const primaryNecklineCal =
        calibratedBySlot.get(OutfitSlot.ONE_PIECE) ??
        calibratedBySlot.get(OutfitSlot.TOP) ??
        calibratedBySlot.get(OutfitSlot.OUTERWEAR) ??
        null;
      if (primaryNecklineCal) {
        drawInnerNecklineBackWrapShadow(ctx, primaryNecklineCal);
      }

      // C. Garment layers in strict z-order: TOP -> BOTTOM -> ONE_PIECE -> OUTERWEAR -> ACCESSORY
      for (const item of ordered) {
        const cal = calibratedBySlot.get(item.slot);
        if (cal) {
          drawCalibratedGarment(ctx, cal, {
            bufferCanvas: bufferCanvasRef.current,
          });
        } else {
          const fallbackBounds = drawFallbackSilhouette(ctx, item);
          boundsBySlot[item.slot] = fallbackBounds;
          if (item.slot !== OutfitSlot.ACCESSORY) {
            wearableCount += 1;
            maxGarmentBottomY = Math.max(maxGarmentBottomY, fallbackBounds.bottomY);
            minCoveredTopY = Math.min(minCoveredTopY, fallbackBounds.coveredTopY);
            maxCoveredBottomY = Math.max(
              maxCoveredBottomY,
              fallbackBounds.coveredBottomY,
            );
          }
        }
      }

      // D. Subtle warm champagne evening spotlight sheen when lightingMode === 'evening'
      if (lightingMode === 'evening' && ordered.length > 0) {
        ctx.save();
        ctx.globalCompositeOperation = 'source-atop';
        const sheen = ctx.createLinearGradient(0, 120, 0, 760);
        sheen.addColorStop(0, 'rgba(255, 241, 206, 0.09)');
        sheen.addColorStop(0.45, 'rgba(235, 207, 143, 0.03)');
        sheen.addColorStop(1, 'rgba(28, 20, 16, 0.07)');
        ctx.fillStyle = sheen;
        ctx.fillRect(0, 0, STAGE_W, STAGE_H);
        ctx.restore();
      }

      const hasFullOutfit = Boolean(
        boundsBySlot[OutfitSlot.ONE_PIECE] ||
          (boundsBySlot[OutfitSlot.TOP] && boundsBySlot[OutfitSlot.BOTTOM]),
      );

      const layout: StageFittedLayout = {
        boundsBySlot,
        maxGarmentBottomY,
        coveredTorsoRange:
          wearableCount > 0
            ? { topY: minCoveredTopY, bottomY: maxCoveredBottomY }
            : null,
        occludeTorsoCage: hasFullOutfit,
      };

      prevSigRef.current = compositionSignature;
      setRenderReady(true);

      if (isActiveFace) {
        onLayoutRef.current?.(layout);
      }

      if (isNewComposition && !reducedMotion) {
        setTransitionPulse(true);
        window.requestAnimationFrame(() => {
          setTransitionPulse(false);
        });
      }
    };

    void runCalibrationAndRender();

    return () => {
      cancelled = true;
    };
  }, [
    canvasElementRef,
    compositionSignature,
    face,
    hasOnePiece,
    hasPairedBottom,
    isActiveFace,
    lightingMode,
    ordered,
    reducedMotion,
  ]);

  const ariaLabel = useMemo(() => {
    if (ordered.length === 0) {
      return 'Sân khấu phối đồ Atelier trống';
    }
    const names = ordered.map((item) => item.productName).join(', ');
    return `Bộ phối ${ordered.length} món trên ma-nơ-canh (${
      face === 'back' ? 'Mặt sau' : 'Mặt trước'
    }): ${names}`;
  }, [face, ordered]);

  return (
    <canvas
      ref={(el) => {
        internalCanvasRef.current = el;
        if (canvasElementRef && 'current' in canvasElementRef) {
          canvasElementRef.current = el;
        }
      }}
      role="img"
      aria-label={ariaLabel}
      data-testid={
        isActiveFace
          ? 'autofit-garment-canvas'
          : `autofit-garment-canvas-${face}`
      }
      data-face={face}
      data-loupe-target={isActiveFace ? 'true' : undefined}
      data-logical-width={STAGE_W}
      data-logical-height={STAGE_H}
      data-render-ready={renderReady ? 'true' : 'false'}
      data-slots={ordered.map((item) => item.slot).join(',')}
      className="h-full w-full select-none"
      style={{
        transition: reducedMotion
          ? 'none'
          : 'opacity 450ms cubic-bezier(0.22, 0.8, 0.22, 1), transform 450ms cubic-bezier(0.22, 0.8, 0.22, 1)',
        opacity: transitionPulse ? 0.68 : 1,
        transform: transitionPulse ? 'scale(0.985)' : 'scale(1)',
      }}
    />
  );
}
