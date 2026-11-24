'use client';

import { useEffect, useId, useRef } from 'react';
import { usePrefersReducedMotion } from '@atelier/motion-kit';

export interface OpticalFabricLoupeProps {
  enabled: boolean;
  imageUrl: string | null;
  productName?: string;
  colorName?: string;
  stageContainerRef: React.RefObject<HTMLDivElement | null>;
  targetImageSelector?: string;
}

const LOUPE_SIZE = 136;
const LOUPE_RADIUS = LOUPE_SIZE / 2;
const ZOOM_FACTOR = 3;

/**
 * Circular 136px 3x Optical Fabric Loupe with double warm-gold rings
 * (#B08A4A / #EBCF8F), curved SVG perimeter text, and silky 60fps
 * requestAnimationFrame tracking over the AutoFittedGarmentCanvas (direct
 * 3x HiDPI canvas optical magnification with image URL fallback).
 */
export function OpticalFabricLoupe({
  enabled,
  imageUrl,
  productName,
  colorName,
  stageContainerRef,
  targetImageSelector = '[data-loupe-target="true"]',
}: OpticalFabricLoupeProps) {
  const pathId = useId();
  const reducedMotion = usePrefersReducedMotion();

  const loupeRef = useRef<HTMLDivElement | null>(null);
  const lensRef = useRef<HTMLDivElement | null>(null);
  const lensCanvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const stageEl = stageContainerRef.current;
    const loupeEl = loupeRef.current;
    const lensEl = lensRef.current;
    const lensCanvas = lensCanvasRef.current;
    if (!stageEl || !loupeEl || !lensEl) return;

    const dpr =
      typeof window !== 'undefined'
        ? Math.min(Math.max(window.devicePixelRatio || 1, 1), 2)
        : 1;

    if (lensCanvas) {
      const targetDim = Math.round(LOUPE_SIZE * dpr);
      if (lensCanvas.width !== targetDim || lensCanvas.height !== targetDim) {
        lensCanvas.width = targetDim;
        lensCanvas.height = targetDim;
      }
    }

    let rafId = 0;
    let hasUserPointer = false;

    const getDefaultAnchor = () => {
      const stageRect = stageEl.getBoundingClientRect();
      const targetEl = stageEl.querySelector<HTMLElement>(targetImageSelector);
      if (targetEl) {
        const rect = targetEl.getBoundingClientRect();
        if (rect.width > 10 && rect.height > 10) {
          return {
            stageX: rect.left - stageRect.left + rect.width * 0.5,
            stageY: rect.top - stageRect.top + rect.height * 0.44,
          };
        }
      }
      return {
        stageX: stageRect.width * 0.52,
        stageY: stageRect.height * 0.5,
      };
    };

    const initial = getDefaultAnchor();
    const current = { x: initial.stageX, y: initial.stageY };
    const target = { x: initial.stageX, y: initial.stageY };

    const applyVisualTransform = (stageX: number, stageY: number) => {
      const stageRect = stageEl.getBoundingClientRect();
      const clampedX = Math.max(
        LOUPE_RADIUS + 8,
        Math.min(stageRect.width - LOUPE_RADIUS - 8, stageX),
      );
      const clampedY = Math.max(
        LOUPE_RADIUS + 8,
        Math.min(stageRect.height - LOUPE_RADIUS - 8, stageY),
      );

      loupeEl.style.transform = `translate3d(${(clampedX - LOUPE_RADIUS).toFixed(1)}px, ${(clampedY - LOUPE_RADIUS).toFixed(1)}px, 0)`;

      const targetEl = stageEl.querySelector<HTMLElement>(targetImageSelector);
      const clientX = stageRect.left + clampedX;
      const clientY = stageRect.top + clampedY;

      // Primary mode: direct 3x optical magnification from live AutoFittedGarmentCanvas
      if (
        targetEl instanceof HTMLCanvasElement &&
        targetEl.width > 0 &&
        targetEl.height > 0 &&
        lensCanvas
      ) {
        const rect = targetEl.getBoundingClientRect();
        const lCtx = lensCanvas.getContext('2d');
        if (lCtx && rect.width > 10 && rect.height > 10) {
          lCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
          lCtx.fillStyle = '#F4EBDA';
          lCtx.fillRect(0, 0, LOUPE_SIZE, LOUPE_SIZE);

          const scaleToSrcX = targetEl.width / rect.width;
          const scaleToSrcY = targetEl.height / rect.height;

          const uNorm = (clientX - rect.left) / rect.width;
          const vNorm = (clientY - rect.top) / rect.height;
          const srcCx = uNorm * targetEl.width;
          const srcCy = vNorm * targetEl.height;

          const sampleW = (LOUPE_SIZE / ZOOM_FACTOR) * scaleToSrcX;
          const sampleH = (LOUPE_SIZE / ZOOM_FACTOR) * scaleToSrcY;
          const rawSx = srcCx - sampleW * 0.5;
          const rawSy = srcCy - sampleH * 0.5;

          // Safe cross-browser source clipping when loupe nears stage edges
          const sx = Math.max(0, rawSx);
          const sy = Math.max(0, rawSy);
          const sx2 = Math.min(targetEl.width, rawSx + sampleW);
          const sy2 = Math.min(targetEl.height, rawSy + sampleH);
          const sw = sx2 - sx;
          const sh = sy2 - sy;

          if (sw > 1 && sh > 1) {
            const dx = ((sx - rawSx) / sampleW) * LOUPE_SIZE;
            const dy = ((sy - rawSy) / sampleH) * LOUPE_SIZE;
            const dw = (sw / sampleW) * LOUPE_SIZE;
            const dh = (sh / sampleH) * LOUPE_SIZE;

            lCtx.imageSmoothingEnabled = true;
            lCtx.imageSmoothingQuality = 'high';
            try {
              lCtx.drawImage(targetEl, sx, sy, sw, sh, dx, dy, dw, dh);
              lensCanvas.style.opacity = '1';
              return;
            } catch {
              // Fall through to CSS background fallback if source is unavailable
            }
          }
        }
      }

      if (lensCanvas) {
        lensCanvas.style.opacity = '0';
      }

      if (targetEl) {
        const rect = targetEl.getBoundingClientRect();
        if (rect.width > 10 && rect.height > 10) {
          const u = clientX - rect.left;
          const v = clientY - rect.top;
          const bgW = rect.width * ZOOM_FACTOR;
          const bgH = rect.height * ZOOM_FACTOR;
          const bgX = LOUPE_RADIUS - u * ZOOM_FACTOR;
          const bgY = LOUPE_RADIUS - v * ZOOM_FACTOR;
          lensEl.style.backgroundSize = `${bgW.toFixed(1)}px ${bgH.toFixed(1)}px`;
          lensEl.style.backgroundPosition = `${bgX.toFixed(1)}px ${bgY.toFixed(1)}px`;
          return;
        }
      }

      // Fallback normalized 300% mapping relative to stage
      const nx = stageRect.width > 0 ? (clampedX / stageRect.width) * 100 : 50;
      const ny = stageRect.height > 0 ? (clampedY / stageRect.height) * 100 : 50;
      lensEl.style.backgroundSize = '300% 300%';
      lensEl.style.backgroundPosition = `${nx.toFixed(2)}% ${ny.toFixed(2)}%`;
    };

    applyVisualTransform(current.x, current.y);

    const tick = () => {
      if (!hasUserPointer) {
        const anchor = getDefaultAnchor();
        target.x = anchor.stageX;
        target.y = anchor.stageY;
      }

      const ease = reducedMotion ? 1 : 0.28;
      const dx = target.x - current.x;
      const dy = target.y - current.y;

      if (Math.abs(dx) > 0.2 || Math.abs(dy) > 0.2) {
        current.x += dx * ease;
        current.y += dy * ease;
        applyVisualTransform(current.x, current.y);
      } else {
        // Keep refreshing canvas magnification in case garment preset/lighting changed
        applyVisualTransform(current.x, current.y);
      }

      rafId = window.requestAnimationFrame(tick);
    };

    const handlePointerMove = (e: PointerEvent | MouseEvent) => {
      const stageRect = stageEl.getBoundingClientRect();
      hasUserPointer = true;
      target.x = e.clientX - stageRect.left;
      target.y = e.clientY - stageRect.top;
    };

    const handlePointerLeave = () => {
      hasUserPointer = false;
      const anchor = getDefaultAnchor();
      target.x = anchor.stageX;
      target.y = anchor.stageY;
    };

    stageEl.addEventListener('pointermove', handlePointerMove, { passive: true });
    stageEl.addEventListener('mousemove', handlePointerMove, { passive: true });
    stageEl.addEventListener('pointerleave', handlePointerLeave, { passive: true });
    rafId = window.requestAnimationFrame(tick);

    return () => {
      window.cancelAnimationFrame(rafId);
      stageEl.removeEventListener('pointermove', handlePointerMove);
      stageEl.removeEventListener('mousemove', handlePointerMove);
      stageEl.removeEventListener('pointerleave', handlePointerLeave);
    };
  }, [enabled, imageUrl, reducedMotion, stageContainerRef, targetImageSelector]);

  if (!enabled) {
    return null;
  }

  return (
    <div
      ref={loupeRef}
      data-testid="optical-fabric-loupe"
      role="img"
      aria-label={
        productName
          ? `Kính lúp soi chất liệu 3x — ${productName}${colorName ? ` (${colorName})` : ''}`
          : 'Kính lúp soi chất liệu 3x Optical Fabric Loupe'
      }
      className="pointer-events-none absolute top-0 left-0 select-none will-change-transform"
      style={{
        width: `${LOUPE_SIZE}px`,
        height: `${LOUPE_SIZE}px`,
        zIndex: 95,
      }}
    >
      {/* Outer circular housing with double warm-gold rings */}
      <div
        className="relative h-full w-full overflow-hidden rounded-full bg-[#FBF7EF]"
        style={{
          border: '2px solid #B08A4A',
          boxShadow:
            '0 18px 40px rgba(28, 20, 16, 0.28), 0 0 0 1px rgba(235, 207, 143, 0.85) inset, 0 0 24px rgba(176, 138, 74, 0.22)',
        }}
      >
        {/* Image URL fallback magnification layer */}
        <div
          ref={lensRef}
          className="absolute inset-0 rounded-full"
          style={{
            backgroundColor: '#F4EBDA',
            backgroundImage: imageUrl ? `url("${imageUrl}")` : undefined,
            backgroundRepeat: 'no-repeat',
            backgroundSize: '300%',
            backgroundPosition: '50% 50%',
          }}
        />

        {/* Primary 3x HiDPI live canvas magnification layer */}
        <canvas
          ref={lensCanvasRef}
          aria-hidden="true"
          className="absolute inset-0 h-full w-full rounded-full"
        />

        {/* Optical glass bevel curvature & subtle specular gloss */}
        <div
          className="absolute inset-0 rounded-full"
          style={{
            background:
              'radial-gradient(circle at 32% 26%, rgba(255, 255, 255, 0.42) 0%, rgba(255, 255, 255, 0.08) 32%, rgba(28, 20, 16, 0) 64%, rgba(28, 20, 16, 0.22) 100%)',
          }}
        />

        {/* Delicate center optical reticle */}
        <div className="absolute top-1/2 left-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2">
          <span className="absolute top-1/2 left-0 h-px w-full -translate-y-1/2 bg-[#EBCF8F]/75" />
          <span className="absolute top-0 left-1/2 h-full w-px -translate-x-1/2 bg-[#EBCF8F]/75" />
          <span className="absolute top-1/2 left-1/2 h-1 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[#B08A4A]" />
        </div>

        {/* Inner shimmer gold ring (#EBCF8F) + Curved SVG perimeter text */}
        <svg
          viewBox="0 0 136 136"
          className="absolute inset-0 h-full w-full"
          aria-hidden="true"
        >
          <defs>
            <path
              id={pathId}
              d="M 12,68 A 56,56 0 1,1 124,68 A 56,56 0 1,1 12,68"
            />
          </defs>

          <circle
            cx="68"
            cy="68"
            r="59"
            fill="none"
            stroke="rgba(251, 247, 239, 0.82)"
            strokeWidth="12"
          />

          <circle
            cx="68"
            cy="68"
            r="52.5"
            fill="none"
            stroke="#EBCF8F"
            strokeWidth="1.25"
          />

          <circle
            cx="68"
            cy="68"
            r="65"
            fill="none"
            stroke="#B08A4A"
            strokeWidth="1"
            strokeOpacity="0.85"
          />

          <text
            fill="#6E4F1D"
            fontSize="7.4"
            fontWeight="600"
            letterSpacing="1.35"
            style={{
              textTransform: 'uppercase',
              fontFamily: 'var(--sans, system-ui, sans-serif)',
            }}
          >
            <textPath href={`#${pathId}`} startOffset="25%" textAnchor="middle">
              ✦ 3x Optical Fabric Loupe ✦
            </textPath>
          </text>
        </svg>
      </div>
    </div>
  );
}
