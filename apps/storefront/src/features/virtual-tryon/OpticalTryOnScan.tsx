'use client';

import { useEffect, useState } from 'react';
import type { TryOnSynthesisProgress } from './vton/types';

export interface OpticalTryOnScanProps {
  visible: boolean;
  stepIndex?: number;
  progress?: TryOnSynthesisProgress | null;
  onCancel?: () => void;
}

const SCAN_STEPS = [
  '1. Phân tích dáng & tách nền cũ',
  '2. Ướm phom vải & xử lý cổ áo',
  '3. Dệt nếp gấp & hòa ánh sáng',
  '4. Hoàn thiện chân dung 768×1024',
] as const;

const STEP_DEFAULT_PCT = [15, 45, 78, 96] as const;

/**
 * Champagne-Gold optical scan beam + realtime Stage 2 progress bar, Vietnamese stage rail,
 * Outfit multi-step indicator (`Bước 1/2` -> `Bước 2/2`), and non-blocking `Hủy tác vụ` button.
 * Keeps the locked 768×1024 customer portrait clearly visible underneath during synthesis.
 */
export function OpticalTryOnScan({
  visible,
  stepIndex,
  progress,
  onCancel,
}: OpticalTryOnScanProps) {
  const [autoStep, setAutoStep] = useState(0);

  useEffect(() => {
    if (!visible) {
      setAutoStep(0);
      return undefined;
    }
    if (typeof stepIndex === 'number' || progress) {
      return undefined;
    }

    setAutoStep(0);
    const timer = window.setInterval(() => {
      setAutoStep((prev) => (prev < SCAN_STEPS.length - 1 ? prev + 1 : prev));
    }, 350);

    return () => {
      window.clearInterval(timer);
    };
  }, [visible, stepIndex, progress]);

  if (!visible) {
    return null;
  }

  const derivedStepFromProgress = progress
    ? progress.progressPct >= 90
      ? 3
      : progress.progressPct >= 62
        ? 2
        : progress.progressPct >= 28
          ? 1
          : 0
    : undefined;

  const activeStep =
    typeof derivedStepFromProgress === 'number'
      ? derivedStepFromProgress
      : typeof stepIndex === 'number'
        ? Math.max(0, Math.min(SCAN_STEPS.length - 1, Math.floor(stepIndex)))
        : autoStep;

  const progressPct = progress
    ? Math.max(2, Math.min(100, Math.round(progress.progressPct)))
    : STEP_DEFAULT_PCT[activeStep] ?? 15;

  const stepTotal = progress?.stepTotal && progress.stepTotal > 1 ? progress.stepTotal : 1;
  const stepCurrent = progress?.stepCurrent
    ? Math.max(1, Math.min(stepTotal, progress.stepCurrent))
    : 1;

  const rawStageLabel = progress?.stageLabel?.trim();
  const stageLabel = rawStageLabel && rawStageLabel.length > 0
    ? rawStageLabel
    : SCAN_STEPS[activeStep] ?? 'Đang hoàn thiện chân dung thử đồ Atelier...';

  return (
    <div
      data-testid="optical-tryon-scan"
      role="status"
      aria-live="polite"
      aria-label="Đang hoàn thiện chân dung thử đồ AI Atelier"
      className="pointer-events-auto absolute inset-0 z-30 flex flex-col items-center justify-between overflow-hidden rounded-2xl bg-gradient-to-b from-[#1C1410]/70 via-[#1C1410]/26 to-[#1C1410]/84 px-4 py-4 text-[#FBF7EF] backdrop-blur-[1px]"
    >
      <style>{`
        @keyframes atelierOpticalBeamSweep {
          0% { transform: translateY(-10%); opacity: 0.28; }
          18% { opacity: 0.98; }
          82% { opacity: 0.98; }
          100% { transform: translateY(1080%); opacity: 0.28; }
        }
        .atelier-optical-beam {
          animation: atelierOpticalBeamSweep 2.1s cubic-bezier(0.45, 0.05, 0.55, 0.95) infinite;
        }
        @media (prefers-reduced-motion: reduce) {
          .atelier-optical-beam {
            animation: none;
            top: 46%;
            opacity: 0.72;
          }
        }
      `}</style>

      {/* Precision Atelier corner reticles */}
      <div className="pointer-events-none absolute inset-3.5">
        <span className="absolute top-0 left-0 h-5 w-5 border-t border-l border-[#EBCF8F]/80" />
        <span className="absolute top-0 right-0 h-5 w-5 border-t border-r border-[#EBCF8F]/80" />
        <span className="absolute bottom-0 left-0 h-5 w-5 border-b border-l border-[#EBCF8F]/80" />
        <span className="absolute right-0 bottom-0 h-5 w-5 border-r border-b border-[#EBCF8F]/80" />
      </div>

      {/* Sweeping Champagne-Gold Optical Scan Beam */}
      <div
        aria-hidden="true"
        className="atelier-optical-beam pointer-events-none absolute inset-x-0 top-0 h-[9%]"
      >
        <div className="h-[2px] w-full bg-gradient-to-r from-transparent via-[#EBCF8F] to-transparent shadow-[0_0_24px_4px_rgba(235,207,143,0.9)]" />
        <div className="h-full w-full bg-gradient-to-b from-[#EBCF8F]/30 via-[#B08A4A]/12 to-transparent" />
      </div>

      {/* Top status bar: Atelier AI VTON badge + Multi-step indicator + Live % */}
      <div className="relative z-10 flex w-full items-center justify-between gap-2">
        <div className="inline-flex items-center gap-2 rounded-full border border-[#EBCF8F]/50 bg-[#1C1410]/86 px-3 py-1 text-[10px] font-medium tracking-[0.14em] uppercase text-[#EBCF8F] shadow-lg backdrop-blur-md">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#EBCF8F]" />
          <span>Atelier AI VTON</span>
        </div>

        <div className="flex items-center gap-1.5">
          {stepTotal > 1 ? (
            <span
              data-testid="optical-scan-step-badge"
              className="rounded-full border border-[#EBCF8F]/55 bg-[#2B2019]/92 px-2.5 py-1 font-mono text-[10px] font-semibold text-[#EBCF8F] shadow-md backdrop-blur-md"
            >
              Bước {stepCurrent}/{stepTotal}
            </span>
          ) : null}

          <span
            data-testid="optical-scan-progress-pct"
            className="rounded-full border border-[#B08A4A]/45 bg-[#1C1410]/88 px-2.5 py-1 font-mono text-[10.5px] font-semibold text-[#F4EBDA] shadow-md backdrop-blur-md"
          >
            {progressPct}%
          </span>
        </div>
      </div>

      {/* Center breathing space: keeps the locked 768×1024 customer portrait clearly visible underneath */}
      <div className="pointer-events-none relative z-10 flex flex-col items-center">
        <div className="flex h-10 w-10 items-center justify-center rounded-full border border-[#EBCF8F]/55 bg-[#1C1410]/65 shadow-[0_0_28px_rgba(235,207,143,0.32)] backdrop-blur-xs">
          <span className="font-editorial text-base tracking-wider text-[#EBCF8F]">
            ✦
          </span>
        </div>
      </div>

      {/* Bottom Realtime Progress Dock + Stage Rail + Cancel Action */}
      <div className="relative z-10 w-full max-w-[356px] rounded-xl border border-[#B08A4A]/45 bg-[#1C1410]/90 p-3 text-left shadow-2xl backdrop-blur-md">
        {/* Live Vietnamese stageLabel */}
        <div className="flex items-center justify-between gap-2">
          <p
            data-testid="optical-scan-stage-label"
            className="line-clamp-2 text-[11.5px] leading-snug font-medium text-[#FBF7EF]"
          >
            {stageLabel}
          </p>
          <span className="shrink-0 font-mono text-[10.5px] font-semibold text-[#EBCF8F]">
            {progressPct}%
          </span>
        </div>

        {/* Smooth Champagne-Gold Progress Bar */}
        <div
          role="progressbar"
          data-testid="optical-scan-progress-bar"
          aria-label="Tiến độ xử lý thử đồ AI"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progressPct}
          className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-[#2B2019]"
        >
          <div
            className="h-full rounded-full bg-gradient-to-r from-[#B08A4A] via-[#EBCF8F] to-[#F4EBDA] shadow-[0_0_12px_rgba(235,207,143,0.75)] transition-[width] duration-500 ease-out"
            style={{ width: `${progressPct}%` }}
          />
        </div>

        {/* Compact 4-Step Vietnamese Status Rail */}
        <ol
          data-testid="optical-scan-steps"
          className="mt-2.5 grid grid-cols-2 gap-1"
        >
          {SCAN_STEPS.map((label, idx) => {
            const isCompleted = idx < activeStep;
            const isCurrent = idx === activeStep;

            return (
              <li
                key={label}
                data-step-status={
                  isCompleted ? 'done' : isCurrent ? 'active' : 'pending'
                }
                className={`flex items-center justify-between gap-1.5 rounded-lg px-2 py-1 text-[9.5px] transition-colors ${
                  isCurrent
                    ? 'border border-[#EBCF8F]/50 bg-[#2B2019]/95 font-medium text-[#F4EBDA]'
                    : isCompleted
                      ? 'text-[#EBCF8F]/90'
                      : 'text-[#FBF7EF]/42'
                }`}
              >
                <span className="truncate">{label}</span>
                <span className="shrink-0 font-mono text-[9px]">
                  {isCompleted ? '✓' : isCurrent ? '●' : '○'}
                </span>
              </li>
            );
          })}
        </ol>

        {/* Crisp non-blocking Cancel CTA */}
        {onCancel ? (
          <div className="mt-2.5 flex items-center justify-between gap-2 border-t border-[#B08A4A]/22 pt-2">
            <span className="text-[9.5px] text-[#EBD9B4]/72">
              Có thể đổi món khác bất kỳ lúc nào
            </span>
            <button
              type="button"
              data-testid="tryon-cancel-synthesis-btn"
              onClick={onCancel}
              className="inline-flex shrink-0 cursor-pointer items-center gap-1 rounded-full border border-[#EBCF8F]/50 bg-[#2B2019] px-3 py-1 text-[10.5px] font-medium text-[#F4EBDA] transition-colors hover:border-[#EBCF8F] hover:bg-[#3A2B21] hover:text-[#EBCF8F]"
            >
              <span aria-hidden="true">✕</span>
              <span>Hủy tác vụ</span>
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
