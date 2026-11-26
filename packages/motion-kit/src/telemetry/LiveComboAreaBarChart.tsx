'use client';

import type { CSSProperties, ReactNode } from 'react';
import { useId, useMemo, useState } from 'react';
import { useViewportAnimationPause } from './LiveMotionProvider.js';

export interface LiveComboChartPoint {
  label: string;
  tooltipLabel?: string;
  barValue: number;
  lineValue: number;
  secondaryValue?: number;
  metaLabel?: string;
}

export interface LiveComboTimeframeOption {
  id: string;
  label: string;
}

export interface LiveComboAreaBarChartProps {
  points: LiveComboChartPoint[];
  barLabel?: string;
  lineLabel?: string;
  formatBarValue?: (val: number) => string;
  formatLineValue?: (val: number) => string;
  timeframes?: LiveComboTimeframeOption[];
  activeTimeframe?: string;
  onTimeframeChange?: (id: string) => void;
  summaryRight?: ReactNode;
  height?: number;
  isDark?: boolean;
  emptyText?: string;
  className?: string;
}

interface CoordPoint {
  x: number;
  y: number;
}

/**
 * Monotone Cubic Hermite (Fritsch-Carlson) spline — smooth luxury curve without
 * artificial overshoot below zero or past peaks.
 */
function buildMonotoneSplinePath(pts: CoordPoint[]): string {
  if (pts.length === 0) return '';
  if (pts.length === 1) return `M ${pts[0]!.x.toFixed(1)} ${pts[0]!.y.toFixed(1)}`;
  if (pts.length === 2) {
    const [a, b] = pts;
    return `M ${a!.x.toFixed(1)} ${a!.y.toFixed(1)} L ${b!.x.toFixed(1)} ${b!.y.toFixed(1)}`;
  }

  const n = pts.length;
  const dx: number[] = [];
  const dy: number[] = [];
  const m: number[] = [];

  for (let i = 0; i < n - 1; i += 1) {
    const dxi = pts[i + 1]!.x - pts[i]!.x || 1;
    const dyi = pts[i + 1]!.y - pts[i]!.y;
    dx.push(dxi);
    dy.push(dyi);
    m.push(dyi / dxi);
  }

  const t: number[] = new Array<number>(n).fill(0);
  t[0] = m[0]!;
  t[n - 1] = m[n - 2]!;

  for (let i = 1; i < n - 1; i += 1) {
    const mPrev = m[i - 1]!;
    const mCurr = m[i]!;
    if (mPrev * mCurr <= 0) {
      t[i] = 0;
    } else {
      t[i] = (mPrev + mCurr) / 2;
    }
  }

  // Enforce monotonicity constraints
  for (let i = 0; i < n - 1; i += 1) {
    const mi = m[i]!;
    if (Math.abs(mi) < 1e-6) {
      t[i] = 0;
      t[i + 1] = 0;
    } else {
      const a = t[i]! / mi;
      const b = t[i + 1]! / mi;
      const h = Math.hypot(a, b);
      if (h > 3) {
        const scale = 3 / h;
        t[i] = scale * a * mi;
        t[i + 1] = scale * b * mi;
      }
    }
  }

  let path = `M ${pts[0]!.x.toFixed(1)} ${pts[0]!.y.toFixed(1)}`;
  for (let i = 0; i < n - 1; i += 1) {
    const p0 = pts[i]!;
    const p1 = pts[i + 1]!;
    const d = dx[i]! / 3;
    const cp1x = p0.x + d;
    const cp1y = p0.y + t[i]! * d;
    const cp2x = p1.x - d;
    const cp2y = p1.y - t[i + 1]! * d;
    path += ` C ${cp1x.toFixed(1)} ${cp1y.toFixed(1)}, ${cp2x.toFixed(1)} ${cp2y.toFixed(1)}, ${p1.x.toFixed(1)} ${p1.y.toFixed(1)}`;
  }

  return path;
}

/**
 * Continuous Live Combo Area + Bar Telemetry Chart:
 * - Layer 1: Dashed Grid + Vertical Radar Sweep (5.5s GPU)
 * - Layer 2: Breathing Emerald Area + Staggered Shimmering Champagne Bars
 * - Layer 3: Monotone Cubic Spline + Comet Laser Flow (3.2s) + Dual Live Beacon Ping
 */
export function LiveComboAreaBarChart({
  points,
  barLabel = 'Số đơn hàng (Cột)',
  lineLabel = 'Lượt thử AI & Doanh thu (Miền)',
  formatBarValue = (v) => `${Math.round(v)}`,
  formatLineValue = (v) => `${Math.round(v)}`,
  timeframes,
  activeTimeframe,
  onTimeframeChange,
  summaryRight,
  height = 248,
  isDark = false,
  emptyText = 'Chưa có chuỗi dữ liệu trong kỳ thống kê.',
  className = '',
}: LiveComboAreaBarChartProps) {
  const uid = useId().replace(/:/g, '');
  const containerRef = useViewportAnimationPause<HTMLDivElement>();
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);

  const viewW = 720;
  const viewH = height;
  const padLeft = 36;
  const padRight = 40;
  const padTop = 20;
  const padBottom = 30;
  const plotW = viewW - padLeft - padRight;
  const plotH = viewH - padTop - padBottom;
  const baseLineY = padTop + plotH;

  const computed = useMemo(() => {
    const safePts = points.length > 0 ? points : [];
    const maxBar = Math.max(4, ...safePts.map((p) => Math.max(0, p.barValue)));
    const maxLine = Math.max(
      10,
      ...safePts.map((p) => Math.max(0, p.lineValue)),
    );
    const barCeiling = Math.ceil(maxBar / 4) * 4;
    const lineCeiling =
      maxLine <= 100
        ? Math.max(100, Math.ceil(maxLine / 25) * 25)
        : Math.ceil(maxLine / 4) * 4;

    const count = safePts.length;
    const slotW = count > 0 ? plotW / count : plotW;
    const barW = Math.min(26, Math.max(10, slotW * 0.32));

    const coords: Array<
      CoordPoint & {
        barX: number;
        barY: number;
        barH: number;
        point: LiveComboChartPoint;
      }
    > = safePts.map((pt, idx) => {
      const cx = padLeft + slotW * (idx + 0.5);
      const barRatio = Math.max(0, Math.min(1, pt.barValue / barCeiling));
      const lineRatio = Math.max(0, Math.min(1, pt.lineValue / lineCeiling));
      const barH = pt.barValue > 0 ? Math.max(8, barRatio * plotH) : 0;
      const barY = baseLineY - barH;
      const lineY = baseLineY - lineRatio * (plotH - 6);
      return {
        x: cx,
        y: lineY,
        barX: cx - barW / 2,
        barY,
        barH,
        point: pt,
      };
    });

    const linePath = buildMonotoneSplinePath(coords);
    const areaPath =
      coords.length >= 2
        ? `${linePath} L ${coords[coords.length - 1]!.x.toFixed(1)} ${baseLineY} L ${coords[0]!.x.toFixed(1)} ${baseLineY} Z`
        : '';

    const yTicks = [0, 0.25, 0.5, 0.75, 1].map((r) => ({
      y: baseLineY - r * plotH,
      leftVal: Math.round(barCeiling * r),
      rightVal: Math.round(lineCeiling * r),
    }));

    return { coords, barW, linePath, areaPath, yTicks, barCeiling, lineCeiling };
  }, [points, plotW, plotH, baseLineY]);

  const activeIndex =
    timeframes && activeTimeframe
      ? Math.max(
          0,
          timeframes.findIndex((t) => t.id === activeTimeframe),
        )
      : 0;

  const hoveredItem =
    hoveredIdx !== null && computed.coords[hoveredIdx]
      ? computed.coords[hoveredIdx]!
      : null;

  const latestItem =
    computed.coords.length > 0
      ? computed.coords[computed.coords.length - 1]!
      : null;

  const gridStroke = isDark
    ? 'rgba(243, 210, 153, 0.11)'
    : 'rgba(176, 138, 74, 0.18)';
  const axisLabelColor = isDark ? '#9E8B78' : '#7A6A5B';

  return (
    <div
      ref={containerRef}
      data-telemetry-surface="combo-chart"
      className={`space-y-3 ${className}`}
    >
      {/* Timeframe Sliding Pill + Summary Row */}
      {timeframes || summaryRight ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          {timeframes && timeframes.length > 0 ? (
            <div
              role="tablist"
              aria-label="Chọn khung thời gian biểu đồ"
              className={`relative inline-grid rounded-xl border p-0.5 ${
                isDark
                  ? 'border-[#3A2B21] bg-[#140E0B]'
                  : 'border-[#B08A4A]/28 bg-[#F4EBDA]/65'
              }`}
              style={{
                gridTemplateColumns: `repeat(${timeframes.length}, minmax(64px, 1fr))`,
              }}
            >
              <span
                aria-hidden="true"
                className="pointer-events-none absolute top-0.5 bottom-0.5 left-0.5 rounded-lg transition-transform duration-300 ease-out"
                style={{
                  width: `calc((100% - 4px) / ${timeframes.length})`,
                  transform: `translateX(${activeIndex * 100}%)`,
                  background: isDark
                    ? 'linear-gradient(135deg, #EBCF8F, #C9A462)'
                    : '#1C1410',
                }}
              />
              {timeframes.map((tf) => {
                const isSelected = tf.id === activeTimeframe;
                return (
                  <button
                    key={tf.id}
                    type="button"
                    role="tab"
                    aria-selected={isSelected}
                    onClick={() => onTimeframeChange?.(tf.id)}
                    className={`relative z-10 rounded-lg px-3 py-1 text-[11px] font-semibold transition-colors ${
                      isSelected
                        ? isDark
                          ? 'text-[#1C1410]'
                          : 'text-[#EBCF8F]'
                        : isDark
                          ? 'text-[#B5A18D] hover:text-[#FBF7EF]'
                          : 'text-[#6A5A4D] hover:text-[#1C1410]'
                    }`}
                  >
                    {tf.label}
                  </button>
                );
              })}
            </div>
          ) : (
            <div />
          )}

          {summaryRight ? (
            <div className="flex flex-wrap items-center gap-3 text-xs">
              {summaryRight}
            </div>
          ) : null}
        </div>
      ) : null}

      {points.length === 0 ? (
        <div
          className={`flex h-48 items-center justify-center rounded-2xl border border-dashed text-xs ${
            isDark
              ? 'border-[#3A2B21] text-[#9E8B78]'
              : 'border-[#B08A4A]/30 text-[#7A6A5B]'
          }`}
        >
          {emptyText}
        </div>
      ) : (
        <div
          className="relative w-full select-none overflow-hidden rounded-2xl"
          onMouseLeave={() => setHoveredIdx(null)}
        >
          {/* Layer 1 Overlay: Vertical Optical Radar Sweep */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-4 right-9 left-8 overflow-hidden"
          >
            <div className="telemetry-anim telemetry-radar" />
          </div>

          <svg
            viewBox={`0 0 ${viewW} ${viewH}`}
            className="block h-auto w-full"
            role="img"
            aria-label={`${barLabel} & ${lineLabel}`}
          >
            <defs>
              <linearGradient
                id={`combo-area-${uid}`}
                x1="0"
                y1="0"
                x2="0"
                y2="1"
              >
                <stop
                  offset="0%"
                  stopColor="var(--telemetry-emerald-comet)"
                  stopOpacity={isDark ? '0.36' : '0.26'}
                />
                <stop
                  offset="85%"
                  stopColor="var(--telemetry-emerald-comet)"
                  stopOpacity="0.03"
                />
                <stop
                  offset="100%"
                  stopColor="var(--telemetry-emerald-comet)"
                  stopOpacity="0"
                />
              </linearGradient>

              <linearGradient
                id={`combo-bar-${uid}`}
                x1="0"
                y1="0"
                x2="0"
                y2="1"
              >
                <stop offset="0%" stopColor="#F3D299" />
                <stop offset="55%" stopColor="#C9A25B" />
                <stop offset="100%" stopColor="#8A672C" />
              </linearGradient>

              <filter
                id={`combo-glow-${uid}`}
                x="-20%"
                y="-20%"
                width="140%"
                height="140%"
              >
                <feGaussianBlur stdDeviation="2.2" result="blur" />
                <feMerge>
                  <feMergeNode in="blur" />
                  <feMergeNode in="SourceGraphic" />
                </feMerge>
              </filter>

              <clipPath id={`combo-plot-clip-${uid}`}>
                <rect
                  x={padLeft}
                  y={padTop}
                  width={plotW}
                  height={plotH}
                  rx="4"
                />
              </clipPath>
            </defs>

            {/* Layer 1: Horizontal Dashed Grid + Left/Right Axis Ticks */}
            {computed.yTicks.map((tick, idx) => (
              <g key={idx}>
                <line
                  x1={padLeft}
                  y1={tick.y}
                  x2={viewW - padRight}
                  y2={tick.y}
                  stroke={gridStroke}
                  strokeWidth="1"
                  strokeDasharray={idx === 0 ? undefined : '3 4'}
                />
                <text
                  x={padLeft - 8}
                  y={tick.y + 3}
                  textAnchor="end"
                  fill={axisLabelColor}
                  fontSize="10"
                  fontFamily="ui-monospace, SFMono-Regular, monospace"
                >
                  {tick.leftVal}
                </text>
                <text
                  x={viewW - padRight + 8}
                  y={tick.y + 3}
                  textAnchor="start"
                  fill={axisLabelColor}
                  fontSize="10"
                  fontFamily="ui-monospace, SFMono-Regular, monospace"
                >
                  {tick.rightVal}
                </text>
              </g>
            ))}

            {/* Layer 2A: Breathing Emerald Area */}
            {computed.areaPath ? (
              <path
                d={computed.areaPath}
                fill={`url(#combo-area-${uid})`}
                className="telemetry-anim telemetry-breathing transition-all duration-500"
              />
            ) : null}

            {/* Layer 2B: Rounded-Top Champagne Gold Bars with Vertical Energy Wave */}
            {computed.coords.map((item, idx) => {
              if (item.barH <= 0) return null;
              const isHover = hoveredIdx === idx;
              const barClipId = `bar-clip-${uid}-${idx}`;
              return (
                <g key={`bar-${item.point.label}-${idx}`}>
                  <defs>
                    <clipPath id={barClipId}>
                      <rect
                        x={item.barX}
                        y={item.barY}
                        width={computed.barW}
                        height={item.barH}
                        rx="5"
                      />
                    </clipPath>
                  </defs>
                  <rect
                    x={item.barX}
                    y={item.barY}
                    width={computed.barW}
                    height={item.barH}
                    rx="5"
                    fill={`url(#combo-bar-${uid})`}
                    fillOpacity={isHover ? 1 : 0.88}
                    className="transition-all duration-500"
                  />
                  {/* GPU Vertical Wave inside bar */}
                  <g clipPath={`url(#${barClipId})`}>
                    <rect
                      x={item.barX}
                      y={item.barY}
                      width={computed.barW}
                      height={item.barH}
                      fill="rgba(255, 248, 224, 0.34)"
                      className="telemetry-anim telemetry-bar-wave"
                      style={{ '--bar-idx': idx } as CSSProperties}
                    />
                  </g>
                </g>
              );
            })}

            {/* Layer 3A: Base Smooth Spline Line */}
            {computed.linePath ? (
              <path
                d={computed.linePath}
                fill="none"
                stroke="var(--telemetry-emerald-comet)"
                strokeWidth="2.1"
                strokeOpacity="0.65"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="transition-all duration-500"
              />
            ) : null}

            {/* Layer 3B: Comet Laser Trail (stroke-dashoffset 3.2s infinite GPU) */}
            {computed.linePath ? (
              <path
                d={computed.linePath}
                fill="none"
                pathLength={100}
                stroke="var(--telemetry-emerald-comet)"
                strokeWidth="2.8"
                strokeLinecap="round"
                strokeDasharray="18 82"
                filter={`url(#combo-glow-${uid})`}
                className="telemetry-anim telemetry-comet"
              />
            ) : null}

            {/* Vertical Hover Guideline */}
            {hoveredItem ? (
              <line
                x1={hoveredItem.x}
                y1={padTop}
                x2={hoveredItem.x}
                y2={baseLineY}
                stroke="var(--telemetry-gold-beam)"
                strokeWidth="1"
                strokeDasharray="3 3"
              />
            ) : null}

            {/* Interactive Nodes + X-Axis Labels */}
            {computed.coords.map((item, idx) => {
              const isLatest = idx === computed.coords.length - 1;
              const isHover = hoveredIdx === idx;
              const showXLabel =
                computed.coords.length <= 10 ||
                idx === 0 ||
                idx === computed.coords.length - 1 ||
                idx % Math.ceil(computed.coords.length / 7) === 0;

              return (
                <g key={`pt-${item.point.label}-${idx}`}>
                  {/* Latest Point Dual Concentric Live Beacon Ping */}
                  {isLatest && latestItem ? (
                    <>
                      <circle
                        cx={item.x}
                        cy={item.y}
                        r="4.5"
                        fill="var(--telemetry-emerald-comet)"
                        fillOpacity="0.5"
                        className="telemetry-anim telemetry-beacon-ring"
                      />
                      <circle
                        cx={item.x}
                        cy={item.y}
                        r="4.5"
                        fill="var(--telemetry-emerald-comet)"
                        fillOpacity="0.45"
                        className="telemetry-anim telemetry-beacon-ring-delay"
                      />
                    </>
                  ) : null}

                  <circle
                    cx={item.x}
                    cy={item.y}
                    r={isHover ? 5.2 : isLatest ? 4 : 3}
                    fill={isDark ? '#18110D' : '#FFFFFF'}
                    stroke="var(--telemetry-emerald-comet)"
                    strokeWidth={isHover ? 2.4 : 1.9}
                    className="transition-all duration-200"
                  />

                  {showXLabel ? (
                    <text
                      x={item.x}
                      y={viewH - 8}
                      textAnchor="middle"
                      fill={isHover ? 'var(--telemetry-gold-bright)' : axisLabelColor}
                      fontSize="10"
                      fontWeight={isHover ? '600' : '400'}
                      fontFamily="ui-monospace, SFMono-Regular, monospace"
                    >
                      {item.point.label}
                    </text>
                  ) : null}

                  {/* Wide invisible hit target for effortless tooltip hover */}
                  <rect
                    x={item.x - Math.max(14, plotW / Math.max(1, computed.coords.length * 2))}
                    y={padTop}
                    width={Math.max(28, plotW / Math.max(1, computed.coords.length))}
                    height={plotH + padBottom}
                    fill="transparent"
                    className="cursor-crosshair"
                    onMouseEnter={() => setHoveredIdx(idx)}
                  />
                </g>
              );
            })}
          </svg>

          {/* Frosted-Glass Hover Tooltip */}
          {hoveredItem ? (
            <div
              role="status"
              className="pointer-events-none absolute top-3 z-20 min-w-[168px] rounded-xl border px-3 py-2 text-[11px] shadow-xl backdrop-blur-md transition-all duration-150"
              style={{
                backgroundColor: 'var(--telemetry-tooltip-bg)',
                borderColor: 'var(--telemetry-tooltip-border)',
                color: 'var(--telemetry-tooltip-fg)',
                left:
                  hoveredItem.x > viewW * 0.62
                    ? undefined
                    : `${Math.min(72, Math.max(6, (hoveredItem.x / viewW) * 100 + 2))}%`,
                right:
                  hoveredItem.x > viewW * 0.62
                    ? `${Math.min(72, Math.max(6, ((viewW - hoveredItem.x) / viewW) * 100 + 2))}%`
                    : undefined,
              }}
            >
              <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-[#EBCF8F]">
                {hoveredItem.point.tooltipLabel ?? hoveredItem.point.label}
              </p>
              <div className="mt-1.5 space-y-1 font-mono text-[11px]">
                <div className="flex items-center justify-between gap-3">
                  <span className="flex items-center gap-1.5 text-[#FBF7EF]/75">
                    <span className="h-2 w-2 rounded-full bg-[#EBCF8F]" />
                    {barLabel.split('(')[0]?.trim() || 'Cột'}
                  </span>
                  <span className="font-semibold text-[#FBF7EF]">
                    {formatBarValue(hoveredItem.point.barValue)}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="flex items-center gap-1.5 text-[#FBF7EF]/75">
                    <span className="h-2 w-2 rounded-full bg-[#34D399]" />
                    {lineLabel.split('(')[0]?.trim() || 'Miền'}
                  </span>
                  <span className="font-semibold text-[#34D399]">
                    {formatLineValue(hoveredItem.point.lineValue)}
                  </span>
                </div>
                {hoveredItem.point.metaLabel ? (
                  <p className="border-t border-white/10 pt-1 text-[10px] text-[#EBCF8F]/85">
                    {hoveredItem.point.metaLabel}
                  </p>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
