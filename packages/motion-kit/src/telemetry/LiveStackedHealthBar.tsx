'use client';

import { AnimatedTelemetryNumber } from './AnimatedTelemetryNumber.js';
import { useViewportAnimationPause } from './LiveMotionProvider.js';

export interface LiveEcgIconProps {
  className?: string;
  color?: string;
  size?: number;
}

/**
 * Continuous GPU ECG Heartbeat Pulse Icon (stroke-dashoffset 2.4s linear infinite).
 */
export function LiveEcgIcon({
  className = '',
  color = 'var(--telemetry-emerald-comet)',
  size = 20,
}: LiveEcgIconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 28 20"
      fill="none"
      aria-hidden="true"
      className={className}
    >
      {/* Dim ECG baseline */}
      <path
        d="M1 11 H7 L10 4 L13.5 16.5 L16.5 8 L19 11 H27"
        stroke={color}
        strokeOpacity="0.28"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* Travelling bright ECG pulse */}
      <path
        d="M1 11 H7 L10 4 L13.5 16.5 L16.5 8 L19 11 H27"
        pathLength={100}
        stroke={color}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="telemetry-anim telemetry-ecg-path"
      />
    </svg>
  );
}

export type HealthSegmentTone = 'emerald' | 'amber' | 'crimson' | 'gold' | 'slate';

export interface LiveStackedHealthSegment {
  id: string;
  label: string;
  value: number;
  tone: HealthSegmentTone;
}

export interface LiveStackedHealthBarProps {
  segments: LiveStackedHealthSegment[];
  isDark?: boolean;
  showLegend?: boolean;
  heightClass?: string;
  className?: string;
}

const SEGMENT_STYLES: Record<
  HealthSegmentTone,
  { fill: string; textDark: string; textLight: string; dot: string }
> = {
  emerald: {
    fill: 'linear-gradient(90deg, #059669, #34D399)',
    textDark: 'text-emerald-300',
    textLight: 'text-[#1E4B32]',
    dot: '#34D399',
  },
  amber: {
    fill: 'linear-gradient(90deg, #D97706, #FBBF24)',
    textDark: 'text-amber-300',
    textLight: 'text-[#9A5B13]',
    dot: '#FBBF24',
  },
  crimson: {
    fill: 'linear-gradient(90deg, #DC2626, #F87171)',
    textDark: 'text-rose-300',
    textLight: 'text-[#8B2E2E]',
    dot: '#F87171',
  },
  gold: {
    fill: 'linear-gradient(90deg, #B08A4A, #EBCF8F)',
    textDark: 'text-[#EBCF8F]',
    textLight: 'text-[#8A672C]',
    dot: '#EBCF8F',
  },
  slate: {
    fill: 'linear-gradient(90deg, #64748B, #94A3B8)',
    textDark: 'text-slate-300',
    textLight: 'text-slate-600',
    dot: '#94A3B8',
  },
};

/**
 * Multi-segment Stacked Health / Order Status Bar:
 * - Emerald segments: smooth Liquid Shimmer glide
 * - Amber segments: soft warm shimmer pulse
 * - Crimson segments: calm breathing alert opacity
 */
export function LiveStackedHealthBar({
  segments,
  isDark = false,
  showLegend = true,
  heightClass = 'h-3',
  className = '',
}: LiveStackedHealthBarProps) {
  const containerRef = useViewportAnimationPause<HTMLDivElement>();
  const total = segments.reduce((sum, s) => sum + Math.max(0, s.value), 0);
  const denom = Math.max(1, total);

  return (
    <div
      ref={containerRef}
      data-telemetry-surface="stacked-health-bar"
      className={`space-y-2.5 ${className}`}
    >
      {showLegend ? (
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
          {segments.map((seg) => {
            const style = SEGMENT_STYLES[seg.tone];
            return (
              <div
                key={seg.id}
                className={`inline-flex items-center gap-1.5 font-medium ${
                  isDark ? style.textDark : style.textLight
                }`}
              >
                <span className="relative flex h-2 w-2 items-center justify-center">
                  {seg.value > 0 && (seg.tone === 'crimson' || seg.tone === 'amber') ? (
                    <span
                      aria-hidden="true"
                      className="telemetry-anim telemetry-beacon-ring absolute inset-0 rounded-full"
                      style={{ backgroundColor: style.dot }}
                    />
                  ) : null}
                  <span
                    aria-hidden="true"
                    className="relative h-1.5 w-1.5 rounded-full"
                    style={{ backgroundColor: style.dot }}
                  />
                </span>
                <span>{seg.label}:</span>
                <strong className="font-mono">
                  <AnimatedTelemetryNumber value={seg.value} format="integer" />
                </strong>
              </div>
            );
          })}
        </div>
      ) : null}

      <div
        role="img"
        aria-label={segments.map((s) => `${s.label} ${s.value}`).join(', ')}
        className={`flex w-full overflow-hidden rounded-full ${heightClass} ${
          isDark ? 'bg-[#2A1E17]' : 'bg-[#EBD9B4]/55'
        }`}
      >
        {segments.map((seg) => {
          const pct = total > 0 ? (Math.max(0, seg.value) / denom) * 100 : 0;
          if (pct <= 0) return null;
          const style = SEGMENT_STYLES[seg.tone];
          return (
            <div
              key={seg.id}
              title={`${seg.label}: ${seg.value} (${Math.round(pct)}%)`}
              style={{
                width: `${pct}%`,
                background: style.fill,
              }}
              className={`relative h-full overflow-hidden transition-all duration-500 ${
                seg.tone === 'crimson'
                  ? 'telemetry-anim telemetry-breathing'
                  : ''
              }`}
            >
              {seg.tone === 'emerald' || seg.tone === 'gold' || seg.tone === 'amber' ? (
                <span
                  aria-hidden="true"
                  className="telemetry-anim telemetry-sheen"
                />
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export interface LiveServiceNode {
  id: string;
  label: string;
  online: boolean;
  latencyMs?: number | null;
}

export interface LiveServiceClusterStripProps {
  services: LiveServiceNode[];
  isDark?: boolean;
  className?: string;
}

/**
 * Compact live beacon pulse strip representing active microservices cluster.
 */
export function LiveServiceClusterStrip({
  services,
  isDark = false,
  className = '',
}: LiveServiceClusterStripProps) {
  const containerRef = useViewportAnimationPause<HTMLDivElement>();

  if (services.length === 0) return null;

  return (
    <div
      ref={containerRef}
      data-telemetry-surface="service-cluster"
      className={`flex flex-wrap items-center gap-1.5 ${className}`}
    >
      {services.map((svc) => (
        <span
          key={svc.id}
          title={`${svc.label}: ${svc.online ? 'ONLINE' : 'OFFLINE'}${
            svc.latencyMs != null ? ` (${Math.round(svc.latencyMs)}ms)` : ''
          }`}
          className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[9.5px] ${
            svc.online
              ? isDark
                ? 'border-emerald-500/30 bg-emerald-950/45 text-emerald-200'
                : 'border-emerald-700/25 bg-emerald-50 text-emerald-800'
              : isDark
                ? 'border-rose-500/35 bg-rose-950/45 text-rose-200'
                : 'border-rose-700/25 bg-rose-50 text-rose-800'
          }`}
        >
          <span className="relative flex h-1.5 w-1.5 items-center justify-center">
            {svc.online ? (
              <span
                aria-hidden="true"
                className="telemetry-anim telemetry-beacon-ring absolute inset-0 rounded-full bg-emerald-400/75"
              />
            ) : null}
            <span
              className={`relative h-1.5 w-1.5 rounded-full ${
                svc.online ? 'bg-emerald-400' : 'bg-rose-400'
              }`}
            />
          </span>
          <span className="max-w-[78px] truncate">{svc.label}</span>
        </span>
      ))}
    </div>
  );
}
