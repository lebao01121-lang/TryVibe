'use client';

import type { CSSProperties, MouseEvent, ReactNode } from 'react';
import { useId } from 'react';
import {
  AnimatedTelemetryNumber,
  type TelemetryNumberFormat,
} from './AnimatedTelemetryNumber.js';
import { useViewportAnimationPause } from './LiveMotionProvider.js';

export interface KpiSparkBarsConfig {
  values: number[];
  badgePercent?: number;
  tone?: 'gold' | 'emerald';
}

export interface KpiLaserCurveConfig {
  values: number[];
  tone?: 'gold' | 'emerald';
}

export interface KpiRadialGaugeLegend {
  label: string;
  value: number;
  tone: 'crimson' | 'amber' | 'emerald' | 'gold';
}

export interface KpiRadialGaugeConfig {
  current: number;
  total: number;
  centerText?: string;
  legendItems?: KpiRadialGaugeLegend[];
}

export interface KpiDualStreamBarItem {
  label: string;
  value: number;
  max?: number;
  displayValue?: string | number;
  tone?: 'gold' | 'emerald' | 'amber' | 'crimson';
}

export interface LiveKpiSparkCardProps {
  title: string;
  value: number;
  valueFormat?: TelemetryNumberFormat;
  valueDecimals?: number;
  valuePrefix?: string;
  valueSuffix?: string;
  valueFormatter?: (val: number) => string;
  unitLabel?: string;
  subtitle?: ReactNode;
  footerLeft?: ReactNode;
  footerRight?: ReactNode;
  icon?: ReactNode;
  variant?: 'sparkBars' | 'laserCurve' | 'radialGauge' | 'dualStreamBars' | 'none';
  sparkBars?: KpiSparkBarsConfig;
  laserCurve?: KpiLaserCurveConfig;
  radialGauge?: KpiRadialGaugeConfig;
  dualStreamBars?: KpiDualStreamBarItem[];
  cardIndex?: number;
  isDark?: boolean;
  onClick?: () => void;
  className?: string;
  testId?: string;
}

const DOT_TONES: Record<KpiRadialGaugeLegend['tone'], string> = {
  crimson: '#F87171',
  amber: '#FBBF24',
  emerald: '#34D399',
  gold: '#EBCF8F',
};

const BAR_GRADIENTS: Record<NonNullable<KpiDualStreamBarItem['tone']>, string> = {
  gold: 'linear-gradient(90deg, #B08A4A, #EBCF8F)',
  emerald: 'linear-gradient(90deg, #10B981, #34D399)',
  amber: 'linear-gradient(90deg, #D97706, #FBBF24)',
  crimson: 'linear-gradient(90deg, #DC2626, #F87171)',
};

function buildSparkCurvePath(values: number[], width: number, height: number): {
  linePath: string;
  areaPath: string;
  lastX: number;
  lastY: number;
} {
  const safe = values.length >= 2 ? values : [0, ...(values.length === 1 ? values : [0])];
  const maxVal = Math.max(1, ...safe);
  const padX = 5;
  const padY = 6;
  const innerW = width - padX * 2;
  const innerH = height - padY * 2;
  const stepX = innerW / Math.max(1, safe.length - 1);

  const pts = safe.map((v, i) => ({
    x: padX + i * stepX,
    y: padY + innerH - (Math.max(0, v) / maxVal) * innerH,
  }));

  let linePath = `M ${pts[0]!.x.toFixed(1)} ${pts[0]!.y.toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i += 1) {
    const p0 = pts[i]!;
    const p1 = pts[i + 1]!;
    const cx = ((p0.x + p1.x) / 2).toFixed(1);
    linePath += ` C ${cx} ${p0.y.toFixed(1)}, ${cx} ${p1.y.toFixed(1)}, ${p1.x.toFixed(1)} ${p1.y.toFixed(1)}`;
  }

  const last = pts[pts.length - 1]!;
  const areaPath = `${linePath} L ${last.x.toFixed(1)} ${height} L ${pts[0]!.x.toFixed(1)} ${height} Z`;

  return { linePath, areaPath, lastX: last.x, lastY: last.y };
}

/**
 * Unified KPI Card with cursor border spotlight (DOM style ref, zero React rerenders),
 * top scanline, AnimatedTelemetryNumber, and 4 GPU-composited mini-chart variants.
 */
export function LiveKpiSparkCard({
  title,
  value,
  valueFormat = 'integer',
  valueDecimals = 0,
  valuePrefix = '',
  valueSuffix = '',
  valueFormatter,
  unitLabel,
  subtitle,
  footerLeft,
  footerRight,
  icon,
  variant = 'none',
  sparkBars,
  laserCurve,
  radialGauge,
  dualStreamBars,
  cardIndex = 0,
  isDark = false,
  onClick,
  className = '',
  testId,
}: LiveKpiSparkCardProps) {
  const uid = useId().replace(/:/g, '');
  const containerRef = useViewportAnimationPause<HTMLDivElement>();

  const handleMouseMove = (event: MouseEvent<HTMLDivElement>) => {
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    el.style.setProperty('--spot-x', `${(event.clientX - rect.left).toFixed(1)}px`);
    el.style.setProperty('--spot-y', `${(event.clientY - rect.top).toFixed(1)}px`);
    el.style.setProperty('--spot-opacity', '1');
  };

  const handleMouseLeave = () => {
    const el = containerRef.current;
    if (!el) return;
    el.style.setProperty('--spot-opacity', '0');
  };

  const cardSurface = isDark
    ? 'border-[#3A2B21] bg-gradient-to-br from-[#1C1410] via-[#18110D] to-[#140E0B] text-[#FBF7EF]'
    : 'border-[#B08A4A]/28 bg-gradient-to-br from-white via-[#FFFDF9] to-[#FBF7EF] text-[#1C1410]';

  const mutedText = isDark ? 'text-[#B5A18D]' : 'text-[#7A6A5B]';
  const dividerClass = isDark ? 'border-[#2E2119]' : 'border-[#B08A4A]/18';

  const renderMiniChart = () => {
    if (variant === 'sparkBars' && sparkBars) {
      const vals = sparkBars.values.length > 0 ? sparkBars.values : [0, 0, 0, 0, 0, 0, 0];
      const maxVal = Math.max(1, ...vals);
      const pct = sparkBars.badgePercent ?? 100;
      const clampedPct = Math.max(0, Math.min(100, pct));
      const ringR = 16;
      const ringC = 2 * Math.PI * ringR;
      const dashOffset = ringC * (1 - clampedPct / 100);

      return (
        <div className="flex shrink-0 items-end gap-2.5">
          <div className="flex h-11 items-end gap-1" aria-hidden="true">
            {vals.map((v, idx) => {
              const heightPct = Math.max(14, Math.round((Math.max(0, v) / maxVal) * 100));
              return (
                <div
                  key={idx}
                  className="telemetry-anim telemetry-spark-bar relative w-1.5 overflow-hidden rounded-t-sm transition-all duration-500"
                  style={
                    {
                      height: `${heightPct}%`,
                      '--bar-idx': idx,
                      background:
                        sparkBars.tone === 'emerald'
                          ? 'linear-gradient(180deg, #34D399, #059669)'
                          : 'linear-gradient(180deg, #F3D299, #B08A4A)',
                    } as CSSProperties
                  }
                />
              );
            })}
          </div>

          {typeof sparkBars.badgePercent === 'number' ? (
            <div className="relative flex h-10 w-10 shrink-0 items-center justify-center">
              <svg viewBox="0 0 40 40" className="h-10 w-10 -rotate-90" aria-hidden="true">
                <circle
                  cx="20"
                  cy="20"
                  r={ringR}
                  fill="none"
                  stroke={isDark ? 'rgba(243,210,153,0.15)' : 'rgba(176,138,74,0.18)'}
                  strokeWidth="2.4"
                />
                <circle
                  cx="20"
                  cy="20"
                  r={ringR}
                  fill="none"
                  stroke="var(--telemetry-gold-bright)"
                  strokeWidth="2.4"
                  strokeLinecap="round"
                  strokeDasharray={ringC}
                  strokeDashoffset={dashOffset}
                  className="transition-all duration-500"
                />
                <g className="telemetry-anim telemetry-orbital-fast">
                  <circle
                    cx="36"
                    cy="20"
                    r="2.1"
                    fill="var(--telemetry-emerald-comet)"
                  />
                </g>
              </svg>
              <span className="absolute font-mono text-[9px] font-semibold">
                {Math.round(clampedPct)}%
              </span>
            </div>
          ) : null}
        </div>
      );
    }

    if (variant === 'laserCurve' && laserCurve) {
      const { linePath, areaPath, lastX, lastY } = buildSparkCurvePath(
        laserCurve.values,
        92,
        44,
      );
      const strokeColor =
        laserCurve.tone === 'emerald'
          ? 'var(--telemetry-emerald-comet)'
          : 'var(--telemetry-gold-bright)';

      return (
        <div className="shrink-0">
          <svg
            viewBox="0 0 92 44"
            className="h-11 w-[92px] overflow-visible"
            aria-hidden="true"
          >
            <defs>
              <linearGradient id={`lc-grad-${uid}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={strokeColor} stopOpacity="0.32" />
                <stop offset="100%" stopColor={strokeColor} stopOpacity="0" />
              </linearGradient>
            </defs>
            <path
              d={areaPath}
              fill={`url(#lc-grad-${uid})`}
              className="telemetry-anim telemetry-breathing"
            />
            <path
              d={linePath}
              fill="none"
              stroke={strokeColor}
              strokeOpacity="0.48"
              strokeWidth="1.6"
              strokeLinecap="round"
            />
            <path
              d={linePath}
              fill="none"
              pathLength={100}
              stroke={strokeColor}
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeDasharray="24 76"
              className="telemetry-anim telemetry-comet-fast"
            />
            <circle
              cx={lastX}
              cy={lastY}
              r="3.2"
              fill={strokeColor}
              fillOpacity="0.45"
              className="telemetry-anim telemetry-beacon-ring"
            />
            <circle cx={lastX} cy={lastY} r="2.4" fill={strokeColor} />
          </svg>
        </div>
      );
    }

    if (variant === 'radialGauge' && radialGauge) {
      const total = Math.max(1, radialGauge.total);
      const ratio = Math.max(0, Math.min(1, radialGauge.current / total));
      const r = 18;
      const circ = 2 * Math.PI * r;
      const offset = circ * (1 - ratio);

      return (
        <div className="flex shrink-0 items-center gap-2.5">
          <div className="relative flex h-12 w-12 shrink-0 items-center justify-center">
            <svg viewBox="0 0 44 44" className="h-12 w-12 -rotate-90" aria-hidden="true">
              <circle
                cx="22"
                cy="22"
                r={r}
                fill="none"
                stroke={isDark ? 'rgba(243,210,153,0.14)' : 'rgba(176,138,74,0.18)'}
                strokeWidth="3.2"
              />
              <circle
                cx="22"
                cy="22"
                r={r}
                fill="none"
                stroke="var(--telemetry-gold-bright)"
                strokeWidth="3.2"
                strokeLinecap="round"
                strokeDasharray={circ}
                strokeDashoffset={offset}
                className="transition-all duration-500"
              />
              <circle
                cx="22"
                cy="22"
                r={r}
                fill="none"
                pathLength={100}
                stroke="var(--telemetry-emerald-comet)"
                strokeWidth="2.6"
                strokeLinecap="round"
                strokeDasharray="16 84"
                className="telemetry-anim telemetry-comet"
              />
            </svg>
            <span className="absolute font-mono text-[8.5px] font-semibold">
              {radialGauge.centerText ?? `${radialGauge.current}/${radialGauge.total}`}
            </span>
          </div>

          {radialGauge.legendItems && radialGauge.legendItems.length > 0 ? (
            <div className="space-y-0.5 text-[10px] leading-tight">
              {radialGauge.legendItems.map((item) => (
                <div key={item.label} className="flex items-center gap-1.5">
                  <span className="relative flex h-2 w-2 items-center justify-center">
                    {item.tone === 'amber' || item.tone === 'crimson' ? (
                      <span
                        className="telemetry-anim telemetry-beacon-ring absolute inset-0 rounded-full"
                        style={{ backgroundColor: DOT_TONES[item.tone] }}
                      />
                    ) : null}
                    <span
                      className="relative h-1.5 w-1.5 rounded-full"
                      style={{ backgroundColor: DOT_TONES[item.tone] }}
                    />
                  </span>
                  <span className={mutedText}>{item.label}:</span>
                  <span className="font-mono font-semibold">{item.value}</span>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      );
    }

    if (variant === 'dualStreamBars' && dualStreamBars) {
      return (
        <div className="w-[104px] shrink-0 space-y-2">
          {dualStreamBars.map((bar) => {
            const max = Math.max(1, bar.max ?? Math.max(bar.value, 1));
            const pct = Math.max(bar.value > 0 ? 12 : 6, Math.min(100, Math.round((bar.value / max) * 100)));
            return (
              <div key={bar.label} className="space-y-0.5">
                <div className="flex items-center justify-between font-mono text-[9.5px]">
                  <span className={mutedText}>{bar.label}</span>
                  <span className="font-semibold">{bar.displayValue ?? bar.value}</span>
                </div>
                <div
                  className={`relative h-1.5 w-full overflow-hidden rounded-full ${
                    isDark ? 'bg-[#2C2018]' : 'bg-[#EBD9B4]/55'
                  }`}
                >
                  <div
                    className="relative h-full overflow-hidden rounded-full transition-all duration-500"
                    style={{
                      width: `${pct}%`,
                      background: BAR_GRADIENTS[bar.tone ?? 'gold'],
                    }}
                  >
                    <span
                      aria-hidden="true"
                      className="telemetry-anim telemetry-sheen"
                    />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      );
    }

    return null;
  };

  return (
    <div
      ref={containerRef}
      data-testid={testId}
      data-telemetry-surface="kpi-card"
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={
        onClick
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onClick();
              }
            }
          : undefined
      }
      style={{ '--card-idx': cardIndex } as CSSProperties}
      className={`telemetry-spotlight-card rounded-2xl border p-4 shadow-sm transition-transform duration-200 ${
        onClick ? 'cursor-pointer hover:-translate-y-0.5' : ''
      } ${cardSurface} ${className}`}
    >
      {/* Top optical scanline */}
      <span
        aria-hidden="true"
        className="telemetry-anim telemetry-top-scanline"
      />

      {/* Eyebrow + Icon */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          {icon ? (
            <span
              className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-lg border ${
                isDark
                  ? 'border-[#B08A4A]/30 bg-[#251B15] text-[#EBCF8F]'
                  : 'border-[#B08A4A]/25 bg-[#FBF7EF] text-[#8A672C]'
              }`}
            >
              {icon}
            </span>
          ) : null}
          <p className={`truncate text-xs font-medium ${mutedText}`}>{title}</p>
        </div>
      </div>

      {/* Main Value + Mini-Chart */}
      <div className="mt-3 flex items-end justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-baseline gap-1.5">
            <span className="font-editorial text-3xl font-semibold leading-none tracking-tight sm:text-[34px]">
              <AnimatedTelemetryNumber
                value={value}
                format={valueFormat}
                decimals={valueDecimals}
                prefix={valuePrefix}
                suffix={valueSuffix}
                formatter={valueFormatter}
              />
            </span>
            {unitLabel ? (
              <span className={`font-mono text-xs ${mutedText}`}>
                {unitLabel}
              </span>
            ) : null}
          </div>
          {subtitle ? (
            <div className={`mt-1.5 text-xs ${mutedText}`}>{subtitle}</div>
          ) : null}
        </div>

        {renderMiniChart()}
      </div>

      {/* Footer Strip */}
      {footerLeft || footerRight ? (
        <div
          className={`mt-3.5 flex items-center justify-between gap-2 border-t pt-2.5 text-[11px] ${dividerClass}`}
        >
          <div className={`min-w-0 truncate ${mutedText}`}>{footerLeft}</div>
          {footerRight ? <div className="shrink-0">{footerRight}</div> : null}
        </div>
      ) : null}
    </div>
  );
}
