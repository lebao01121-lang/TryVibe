'use client';

import { useEffect, useRef, useState } from 'react';
import type { LightingPresetId } from './vton/types';

export interface BeforeAfterSliderProps {
  beforeImageUrl: string;
  afterImageUrl: string;
  lightingPreset: LightingPresetId;
  onLightingPresetChange: (preset: LightingPresetId) => void;
  remainingSeconds?: number;
  providerBadge?: string;
  garmentSummary?: string;
}

const LIGHTING_PRESET_OPTIONS: ReadonlyArray<{
  id: LightingPresetId;
  label: string;
  testId: string;
}> = [
  { id: 'morning', label: 'Nắng Sớm', testId: 'tryon-light-morning' },
  { id: 'atelier', label: 'Showroom Atelier', testId: 'tryon-light-atelier' },
  { id: 'evening', label: 'Đèn Tiệc Tối', testId: 'tryon-light-evening' },
];

const REVEAL_START_PCT = 15;
const REVEAL_END_PCT = 88;
const SWEEP_DURATION_MS = 850;

/**
 * Evaluates cubic-bezier(0.22, 1, 0.36, 1) ease-out curve for crisp luxury curtain reveal.
 */
function easeOutQuinticCubic(t: number): number {
  const clamped = Math.max(0, Math.min(1, t));
  return 1 - Math.pow(1 - clamped, 3.2);
}

function formatCountdown(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const mins = Math.floor(safe / 60);
  const secs = safe % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

/**
 * Interactive 3:4 Before / After comparison slider with smooth 15% -> 88% (0.85s) curtain reveal
 * wiping the old garment into the newly synthesized AI VTON garment, transparent provider badge,
 * live 15-minute auto-purge countdown (`🔒 Tự xóa sau MM:SS`), and 3 Atelier lighting presets.
 */
export function BeforeAfterSlider({
  beforeImageUrl,
  afterImageUrl,
  lightingPreset,
  onLightingPresetChange,
  remainingSeconds,
  providerBadge,
  garmentSummary,
}: BeforeAfterSliderProps) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const userInteractedRef = useRef(false);
  const [splitPct, setSplitPct] = useState(REVEAL_END_PCT);
  const [dragging, setDragging] = useState(false);

  const clampedPct = Math.max(0, Math.min(100, splitPct));
  const roundedPct = Math.round(clampedPct);

  // Smooth one-shot 15% -> 88% (0.85s) curtain reveal whenever a newly synthesized result arrives
  useEffect(() => {
    if (!afterImageUrl) return undefined;
    userInteractedRef.current = false;

    const isFreshSynthesis =
      Boolean(beforeImageUrl) && afterImageUrl !== beforeImageUrl;

    const prefersReduced =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    if (!isFreshSynthesis || prefersReduced) {
      setSplitPct(REVEAL_END_PCT);
      return undefined;
    }

    let rafId = 0;
    let cancelled = false;
    setSplitPct(REVEAL_START_PCT);
    const startedAt = performance.now();

    const tick = (now: number) => {
      if (cancelled || userInteractedRef.current) return;
      const progress = Math.min(
        1,
        Math.max(0, (now - startedAt) / SWEEP_DURATION_MS),
      );
      const eased = easeOutQuinticCubic(progress);
      setSplitPct(
        REVEAL_START_PCT + (REVEAL_END_PCT - REVEAL_START_PCT) * eased,
      );
      if (progress < 1) {
        rafId = window.requestAnimationFrame(tick);
      } else {
        setSplitPct(REVEAL_END_PCT);
      }
    };

    rafId = window.requestAnimationFrame(tick);
    return () => {
      cancelled = true;
      if (rafId) {
        window.cancelAnimationFrame(rafId);
      }
    };
  }, [afterImageUrl, beforeImageUrl]);

  const updateFromClientX = (clientX: number) => {
    const el = stageRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0) return;
    userInteractedRef.current = true;
    const pct = ((clientX - rect.left) / rect.width) * 100;
    setSplitPct(Math.max(0, Math.min(100, pct)));
  };

  const isInstantCacheBadge = Boolean(providerBadge?.includes('⚡'));

  return (
    <div className="flex h-full w-full flex-col items-center justify-center">
      <div
        ref={stageRef}
        data-testid="before-after-slider"
        role="slider"
        tabIndex={0}
        aria-label="Kéo thanh so sánh Trước và Sau khi thử đồ"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={roundedPct}
        onKeyDown={(event) => {
          if (event.key === 'ArrowLeft') {
            event.preventDefault();
            userInteractedRef.current = true;
            setSplitPct((prev) => Math.max(0, prev - 5));
          } else if (event.key === 'ArrowRight') {
            event.preventDefault();
            userInteractedRef.current = true;
            setSplitPct((prev) => Math.min(100, prev + 5));
          } else if (event.key === 'Home') {
            event.preventDefault();
            userInteractedRef.current = true;
            setSplitPct(0);
          } else if (event.key === 'End') {
            event.preventDefault();
            userInteractedRef.current = true;
            setSplitPct(100);
          }
        }}
        onPointerDown={(event) => {
          const target = event.target as HTMLElement | null;
          if (target?.closest('[data-slider-control="true"]')) {
            return;
          }
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
        className="relative aspect-[3/4] h-full max-h-full max-w-full cursor-ew-resize select-none overflow-hidden rounded-2xl border border-[#B08A4A]/45 bg-[#1C1410] shadow-[0_24px_64px_-24px_rgba(0,0,0,0.9)] touch-none focus:outline-none focus-visible:ring-2 focus-visible:ring-[#EBCF8F]/75"
      >
        {/* Base Layer (Right side = Trước / Original Locked Session Person Frame) */}
        <img
          src={beforeImageUrl}
          alt="Ảnh gốc trước khi thử đồ"
          data-testid="before-after-before-img"
          draggable={false}
          className="block h-full w-full object-cover"
        />

        {/* Curtain Reveal Layer (Left side 0..splitPct% = Sau / Newly Synthesized Try-On Result) */}
        <div
          className="pointer-events-none absolute inset-0 overflow-hidden"
          style={{ clipPath: `inset(0 ${100 - clampedPct}% 0 0)` }}
        >
          <img
            src={afterImageUrl}
            alt="Sau khi thử đồ Atelier"
            data-testid="before-after-after-img"
            draggable={false}
            className="h-full w-full object-cover"
          />
        </div>

        {/* Top transparent status strip: Live 15-min auto-purge countdown + Provider Badge */}
        <div className="pointer-events-none absolute inset-x-3 top-3 z-20 flex items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-1.5">
            {typeof remainingSeconds === 'number' ? (
              <span
                data-testid="tryon-privacy-countdown"
                className="inline-flex items-center gap-1 rounded-full border border-[#EBCF8F]/40 bg-[#1C1410]/76 px-2.5 py-1 font-mono text-[10px] tracking-[0.04em] text-[#EBCF8F] backdrop-blur-md"
              >
                <span aria-hidden="true">🔒</span>
                <span>Tự xóa sau {formatCountdown(remainingSeconds)}</span>
              </span>
            ) : null}
          </div>

          {providerBadge ? (
            <span
              data-testid="tryon-provider-badge"
              className={`rounded-full border px-2.5 py-1 text-[10px] font-medium tracking-[0.04em] backdrop-blur-md ${
                isInstantCacheBadge
                  ? 'border-[#EBCF8F]/65 bg-[#1C1410]/80 text-[#EBCF8F]'
                  : 'border-[#FBF7EF]/25 bg-[#1C1410]/72 text-[#F4EBDA]'
              }`}
            >
              {providerBadge}
            </span>
          ) : null}
        </div>

        {/* Vertical Champagne-Gold Curtain Divider + Interactive ◀ Sau | Trước ▶ Medallion */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 z-10 w-[1.5px] bg-[#EBCF8F]/95 shadow-[0_0_16px_rgba(235,207,143,0.9)]"
          style={{ left: `${clampedPct}%` }}
        >
          <div className="absolute top-1/2 left-1/2 flex -translate-x-1/2 -translate-y-1/2 items-center gap-1 whitespace-nowrap rounded-full border border-[#EBCF8F]/90 bg-[#1C1410]/92 px-2.5 py-1 text-[10px] font-medium tracking-[0.06em] text-[#EBCF8F] shadow-[0_8px_24px_rgba(0,0,0,0.75)] backdrop-blur-md">
            <span>◀ Sau</span>
            <span className="text-[#B08A4A]">|</span>
            <span>Trước ▶</span>
          </div>
        </div>

        {/* Corner Sau / Trước cues above lighting bar */}
        <span
          className={`pointer-events-none absolute bottom-14 left-3 z-10 rounded-full border border-[#EBCF8F]/50 bg-[#1C1410]/82 px-2.5 py-0.5 text-[10px] tracking-[0.14em] uppercase text-[#EBCF8F] backdrop-blur-sm transition-opacity ${
            clampedPct < 10 ? 'opacity-35' : 'opacity-100'
          }`}
        >
          Sau
        </span>
        <span
          className={`pointer-events-none absolute right-3 bottom-14 z-10 rounded-full border border-[#FBF7EF]/25 bg-[#1C1410]/76 px-2.5 py-0.5 text-[10px] tracking-[0.14em] uppercase text-[#FBF7EF]/92 backdrop-blur-sm transition-opacity ${
            clampedPct > 90 ? 'opacity-35' : 'opacity-100'
          }`}
        >
          Trước
        </span>

        {/* Bottom Dock: Optional Garment Summary + 3 Lighting Preset Pills */}
        <div
          data-slider-control="true"
          onPointerDown={(e) => e.stopPropagation()}
          className="absolute inset-x-2.5 bottom-2.5 z-20 flex flex-col items-center gap-1.5"
        >
          {garmentSummary ? (
            <p className="max-w-full truncate rounded-full border border-[#B08A4A]/25 bg-[#1C1410]/76 px-3 py-0.5 text-[10px] text-[#F4EBDA]/88 backdrop-blur-md">
              {garmentSummary}
            </p>
          ) : null}

          <div
            role="group"
            aria-label="Chọn ánh sáng phòng thử"
            className="inline-flex max-w-full flex-wrap items-center justify-center gap-1 rounded-full border border-[#B08A4A]/35 bg-[#1C1410]/86 p-1 shadow-xl backdrop-blur-md"
          >
            {LIGHTING_PRESET_OPTIONS.map((option) => {
              const isActive = lightingPreset === option.id;
              return (
                <button
                  key={option.id}
                  type="button"
                  data-testid={option.testId}
                  aria-pressed={isActive}
                  onClick={() => onLightingPresetChange(option.id)}
                  className={`cursor-pointer rounded-full px-2.5 py-1 text-[10px] font-medium tracking-[0.06em] transition-all ${
                    isActive
                      ? 'bg-gradient-to-r from-[#EBCF8F] to-[#C8A25D] text-[#1C1410] shadow-[0_4px_14px_-4px_rgba(235,207,143,0.75)]'
                      : 'text-[#FBF7EF]/78 hover:bg-[#2B2019] hover:text-[#EBCF8F]'
                  }`}
                >
                  {option.label}
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
