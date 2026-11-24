'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';

export interface BeforeAfterSliderProps {
  /** Base original photo URL (used in standalone 2-image comparison mode). */
  beforeUrl?: string;
  /** Dressed result image URL (used in standalone 2-image comparison mode). */
  afterUrl?: string;
  beforeLabel?: string;
  afterLabel?: string;
  topBadge?: ReactNode;
  /**
   * When true, renders as a transparent interactive drag divider overlaid
   * directly on top of the live 3D WebGL Photo stage (`beforeAfterSplitPct`).
   */
  overlayOnly?: boolean;
  /** Controlled split percentage (0..100) for live 3D overlay mode. */
  valuePct?: number;
  /** Callback invoked when the user drags or adjusts the split divider. */
  onChangePct?: (pct: number) => void;
  /** Optional key to trigger a smooth reveal sweep when switching photos. */
  revealKey?: string | number;
  /** Whether to show the accessible range input footer below the frame. */
  showRangeBar?: boolean;
}

const REVEAL_TARGET_PCT = 78;
const REVEAL_DURATION_MS = 780;

export function BeforeAfterSlider({
  beforeUrl,
  afterUrl,
  beforeLabel = 'Ảnh gốc',
  afterLabel = 'Ướm 3D Atelier',
  topBadge,
  overlayOnly = false,
  valuePct,
  onChangePct,
  revealKey,
  showRangeBar = true,
}: BeforeAfterSliderProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const userInteractedRef = useRef(false);
  const onChangePctRef = useRef(onChangePct);
  onChangePctRef.current = onChangePct;

  const isControlled = typeof valuePct === 'number' && typeof onChangePct === 'function';
  const [internalPct, setInternalPct] = useState(
    typeof valuePct === 'number' ? valuePct : REVEAL_TARGET_PCT,
  );
  const [dragging, setDragging] = useState(false);

  const activePct = isControlled ? valuePct : internalPct;
  const clampedPct = Math.max(0, Math.min(100, activePct));
  const roundedPct = Math.round(clampedPct);

  const commitPct = (next: number) => {
    const safe = Math.max(0, Math.min(100, next));
    if (!isControlled) {
      setInternalPct(safe);
    }
    onChangePctRef.current?.(safe);
  };

  // Smooth cubic ease-out reveal sweep when a new photo/result enters comparison mode
  const sweepToken = revealKey ?? afterUrl ?? '';
  useEffect(() => {
    if (!sweepToken) return undefined;

    userInteractedRef.current = false;

    const prefersReduced =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    if (prefersReduced) {
      commitPct(REVEAL_TARGET_PCT);
      return undefined;
    }

    let rafId = 0;
    let cancelled = false;
    commitPct(12);
    const startTime = performance.now();

    const animate = (now: number) => {
      if (cancelled || userInteractedRef.current) return;
      const elapsed = now - startTime;
      const progress = Math.min(1, Math.max(0, elapsed / REVEAL_DURATION_MS));
      const eased = 1 - Math.pow(1 - progress, 3);
      commitPct(12 + eased * (REVEAL_TARGET_PCT - 12));

      if (progress < 1) {
        rafId = window.requestAnimationFrame(animate);
      } else {
        commitPct(REVEAL_TARGET_PCT);
      }
    };

    rafId = window.requestAnimationFrame(animate);

    return () => {
      cancelled = true;
      if (rafId) {
        window.cancelAnimationFrame(rafId);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sweepToken]);

  const updateFromClientX = (clientX: number) => {
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0) return;
    userInteractedRef.current = true;
    const pct = ((clientX - rect.left) / rect.width) * 100;
    commitPct(pct);
  };

  if (overlayOnly) {
    return (
      <div
        ref={containerRef}
        data-testid="before-after-slider"
        role="slider"
        tabIndex={0}
        aria-label="So sánh trước và sau khi ướm thử 3D"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={roundedPct}
        onKeyDown={(event) => {
          if (event.key === 'ArrowLeft') {
            event.preventDefault();
            userInteractedRef.current = true;
            commitPct(clampedPct - 5);
          } else if (event.key === 'ArrowRight') {
            event.preventDefault();
            userInteractedRef.current = true;
            commitPct(clampedPct + 5);
          }
        }}
        onPointerDown={(event) => {
          setDragging(true);
          event.currentTarget.setPointerCapture(event.pointerId);
          updateFromClientX(event.clientX);
        }}
        onPointerMove={(event) => {
          if (!dragging) return;
          updateFromClientX(event.clientX);
        }}
        onPointerUp={() => setDragging(false)}
        onPointerCancel={() => setDragging(false)}
        className="absolute inset-0 z-20 cursor-ew-resize select-none touch-none focus:outline-none focus-visible:ring-2 focus-visible:ring-[#EBCF8F]/70"
      >
        {/* Champagne-gold vertical divider & couture drag medallion */}
        <div
          className="pointer-events-none absolute inset-y-0 w-px bg-[#EBCF8F]/95 shadow-[0_0_16px_rgba(235,207,143,0.85)]"
          style={{ left: `${clampedPct}%` }}
        >
          <div className="absolute top-1/2 left-1/2 flex h-9 w-9 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-[#EBCF8F] bg-[#1C1410]/90 text-xs font-medium text-[#EBCF8F] shadow-xl backdrop-blur-md">
            ↔
          </div>
        </div>

        {/* Minimal bottom corner indicators */}
        <span className="pointer-events-none absolute bottom-3 left-3 rounded-full border border-[#EBCF8F]/50 bg-[#1C1410]/82 px-2.5 py-0.5 text-[10px] tracking-[0.14em] uppercase text-[#EBCF8F] backdrop-blur-sm">
          {afterLabel} · {roundedPct}%
        </span>
        <span className="pointer-events-none absolute right-3 bottom-3 rounded-full border border-[#FBF7EF]/25 bg-[#1C1410]/76 px-2.5 py-0.5 text-[10px] tracking-[0.14em] uppercase text-[#FBF7EF]/90 backdrop-blur-sm">
          {beforeLabel}
        </span>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div
        ref={containerRef}
        data-testid="before-after-slider"
        role="slider"
        tabIndex={0}
        aria-label="So sánh trước và sau khi thử đồ 3D"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={roundedPct}
        onKeyDown={(event) => {
          if (event.key === 'ArrowLeft') {
            event.preventDefault();
            userInteractedRef.current = true;
            commitPct(clampedPct - 5);
          } else if (event.key === 'ArrowRight') {
            event.preventDefault();
            userInteractedRef.current = true;
            commitPct(clampedPct + 5);
          }
        }}
        onPointerDown={(event) => {
          setDragging(true);
          event.currentTarget.setPointerCapture(event.pointerId);
          updateFromClientX(event.clientX);
        }}
        onPointerMove={(event) => {
          if (!dragging) return;
          updateFromClientX(event.clientX);
        }}
        onPointerUp={() => setDragging(false)}
        onPointerCancel={() => setDragging(false)}
        className="relative aspect-[3/4] w-full cursor-ew-resize select-none overflow-hidden rounded-2xl border border-[#B08A4A]/45 bg-[#1C1410] shadow-2xl touch-none focus:outline-none focus:ring-2 focus:ring-[#EBCF8F]/70"
      >
        {beforeUrl ? (
          <img
            src={beforeUrl}
            alt={beforeLabel}
            draggable={false}
            className="absolute inset-0 h-full w-full object-cover"
          />
        ) : null}

        {afterUrl ? (
          <div
            className="absolute inset-0 overflow-hidden"
            style={{ clipPath: `inset(0 ${100 - clampedPct}% 0 0)` }}
          >
            <img
              src={afterUrl}
              alt={afterLabel}
              draggable={false}
              className="h-full w-full object-cover"
            />
          </div>
        ) : null}

        {topBadge ? (
          <div className="pointer-events-none absolute top-3 left-3 z-20">
            {topBadge}
          </div>
        ) : null}

        <div
          className="pointer-events-none absolute inset-y-0 z-10 w-px bg-[#EBCF8F] shadow-[0_0_14px_rgba(235,207,143,0.9)]"
          style={{ left: `${clampedPct}%` }}
        >
          <div className="absolute top-1/2 left-1/2 flex h-9 w-9 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-[#EBCF8F] bg-[#1C1410]/90 text-xs font-medium text-[#EBCF8F] shadow-xl backdrop-blur-md">
            ↔
          </div>
        </div>

        <span className="pointer-events-none absolute bottom-3 left-3 z-10 rounded-full border border-[#EBCF8F]/55 bg-[#1C1410]/82 px-2.5 py-0.5 text-[10px] tracking-[0.14em] uppercase text-[#EBCF8F] backdrop-blur-sm">
          {afterLabel}
        </span>
        <span className="pointer-events-none absolute right-3 bottom-3 z-10 rounded-full border border-[#FBF7EF]/30 bg-[#1C1410]/75 px-2.5 py-0.5 text-[10px] tracking-[0.14em] uppercase text-[#FBF7EF] backdrop-blur-sm">
          {beforeLabel}
        </span>
      </div>

      {showRangeBar ? (
        <div className="flex items-center gap-3 px-1">
          <span className="text-[10px] tracking-[0.14em] uppercase text-[#FBF7EF]/60">
            {beforeLabel}
          </span>
          <input
            type="range"
            min={0}
            max={100}
            value={roundedPct}
            aria-label="Thanh trượt so sánh trước và sau"
            onChange={(event) => {
              userInteractedRef.current = true;
              commitPct(Number(event.target.value));
            }}
            className="h-1 flex-1 accent-[#EBCF8F]"
          />
          <span className="min-w-[64px] text-right text-[10px] tracking-[0.14em] uppercase text-[#EBCF8F]">
            3D · {roundedPct}%
          </span>
        </div>
      ) : null}
    </div>
  );
}
