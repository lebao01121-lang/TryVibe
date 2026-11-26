'use client';

import type { ReactNode } from 'react';
import { AnimatedTelemetryNumber } from './AnimatedTelemetryNumber.js';
import { useViewportAnimationPause } from './LiveMotionProvider.js';

export type StreamBarTone =
  | 'gold'
  | 'emerald'
  | 'amber'
  | 'crimson'
  | 'espresso'
  | 'slate';

export interface LiveStreamProgressBarProps {
  /** Percentage 0..100 */
  percent: number;
  tone?: StreamBarTone;
  height?: 'xs' | 'sm' | 'md';
  isDark?: boolean;
  label?: ReactNode;
  rightText?: ReactNode;
  targetZone?: { startPct: number; widthPct: number };
  ariaLabel?: string;
  className?: string;
}

const STREAM_GRADIENTS: Record<StreamBarTone, string> = {
  gold: 'linear-gradient(90deg, #9C7838, #D9B675, #EBCF8F)',
  emerald: 'linear-gradient(90deg, #059669, #10B981, #34D399)',
  amber: 'linear-gradient(90deg, #B45309, #D97706, #FBBF24)',
  crimson: 'linear-gradient(90deg, #991B1B, #DC2626, #F87171)',
  espresso: 'linear-gradient(90deg, #1C1410, #4A3528, #8A672C)',
  slate: 'linear-gradient(90deg, #475569, #64748B, #94A3B8)',
};

const HEIGHT_CLASSES: Record<NonNullable<LiveStreamProgressBarProps['height']>, string> = {
  xs: 'h-1.5',
  sm: 'h-2',
  md: 'h-3',
};

/**
 * Unified GPU Liquid-Shimmer Progress Bar across Admin, Partner, and Storefront.
 */
export function LiveStreamProgressBar({
  percent,
  tone = 'gold',
  height = 'sm',
  isDark = false,
  label,
  rightText,
  targetZone,
  ariaLabel,
  className = '',
}: LiveStreamProgressBarProps) {
  const containerRef = useViewportAnimationPause<HTMLDivElement>();
  const clamped = Math.max(0, Math.min(100, Number.isFinite(percent) ? percent : 0));

  return (
    <div
      ref={containerRef}
      data-telemetry-surface="stream-progress"
      className={`w-full ${className}`}
    >
      {label || rightText ? (
        <div className="mb-1.5 flex items-center justify-between gap-2 text-xs">
          <span className="truncate font-medium">{label}</span>
          {rightText ? (
            <span className="shrink-0 font-mono text-[11px] opacity-85">
              {rightText}
            </span>
          ) : null}
        </div>
      ) : null}

      <div
        role="progressbar"
        aria-label={ariaLabel}
        aria-valuenow={Math.round(clamped)}
        aria-valuemin={0}
        aria-valuemax={100}
        className={`relative w-full overflow-hidden rounded-full ${HEIGHT_CLASSES[height]} ${
          isDark ? 'bg-[#2A1E17]' : 'bg-[#EBD9B4]/55'
        }`}
      >
        {targetZone ? (
          <div
            aria-hidden="true"
            className={`absolute top-0 bottom-0 ${
              isDark ? 'bg-emerald-400/22' : 'bg-emerald-600/18'
            }`}
            style={{
              left: `${Math.max(0, Math.min(100, targetZone.startPct))}%`,
              width: `${Math.max(0, Math.min(100, targetZone.widthPct))}%`,
            }}
          />
        ) : null}

        <div
          className="relative h-full overflow-hidden rounded-full transition-[width] duration-500 ease-out"
          style={{
            width: `${clamped}%`,
            background: STREAM_GRADIENTS[tone],
          }}
        >
          {clamped > 0 ? (
            <span
              aria-hidden="true"
              className="telemetry-anim telemetry-sheen"
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}

export interface LiveFunnelStageItem {
  id: string;
  stepNumber?: number;
  label: string;
  count: number;
  ratePct: number;
  subLabel?: string;
  tone?: StreamBarTone;
}

export interface LiveFunnelStageBarProps {
  stages: LiveFunnelStageItem[];
  isDark?: boolean;
  unitLabel?: string;
  className?: string;
}

/**
 * Multi-step AI Conversion Funnel using unified Liquid Shimmer stage bars
 * and AnimatedTelemetryNumber counts.
 */
export function LiveFunnelStageBar({
  stages,
  isDark = false,
  unitLabel = 'lượt',
  className = '',
}: LiveFunnelStageBarProps) {
  const containerRef = useViewportAnimationPause<HTMLDivElement>();
  const maxCount = Math.max(1, ...stages.map((s) => Math.max(0, s.count)));

  return (
    <div
      ref={containerRef}
      data-telemetry-surface="funnel-chart"
      className={`space-y-3 ${className}`}
    >
      {stages.map((stage, idx) => {
        const widthPct =
          stage.count > 0
            ? Math.max(6, Math.min(100, Math.round((stage.count / maxCount) * 100)))
            : 0;
        const tone: StreamBarTone =
          stage.tone ??
          (idx === stages.length - 1
            ? 'emerald'
            : idx === 0
              ? 'gold'
              : 'amber');

        return (
          <div
            key={stage.id}
            className={`rounded-xl border p-3 transition-colors ${
              isDark
                ? 'border-[#33261D] bg-[#1A130F]/85'
                : 'border-[#B08A4A]/22 bg-[#FBF7EF]/90'
            }`}
          >
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs">
              <div className="flex min-w-0 items-center gap-2">
                <span
                  className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full font-mono text-[10px] font-semibold ${
                    isDark
                      ? 'bg-[#2C2018] text-[#EBCF8F]'
                      : 'bg-[#1C1410] text-[#EBCF8F]'
                  }`}
                >
                  {stage.stepNumber ?? idx + 1}
                </span>
                <span className="truncate font-medium">{stage.label}</span>
              </div>
              <div className="flex shrink-0 items-center gap-2 font-mono text-[11px]">
                <strong>
                  <AnimatedTelemetryNumber value={stage.count} format="integer" />
                </strong>
                <span className={isDark ? 'text-[#A6927E]' : 'text-[#7A6A5B]'}>
                  {unitLabel}
                </span>
                <span
                  className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                    isDark
                      ? 'bg-[#2A1E17] text-[#EBCF8F]'
                      : 'bg-[#F4EBDA] text-[#8A672C]'
                  }`}
                >
                  <AnimatedTelemetryNumber
                    value={stage.ratePct}
                    format="percent"
                    decimals={1}
                  />
                </span>
              </div>
            </div>

            <LiveStreamProgressBar
              percent={widthPct}
              tone={tone}
              height="sm"
              isDark={isDark}
              ariaLabel={`${stage.label}: ${stage.count} ${unitLabel} (${stage.ratePct.toFixed(1)}%)`}
            />

            {stage.subLabel ? (
              <p
                className={`mt-1.5 text-[10.5px] ${
                  isDark ? 'text-[#9E8B78]' : 'text-[#7A6A5B]'
                }`}
              >
                {stage.subLabel}
              </p>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
