'use client';

import { useMemo, useState } from 'react';
import { AnimatedTelemetryNumber } from './AnimatedTelemetryNumber.js';
import { useViewportAnimationPause } from './LiveMotionProvider.js';

export interface LiveDonutSegment {
  id: string;
  label: string;
  value: number;
  sharePct?: number;
  color: string;
  unitLabel?: string;
}

export interface LiveDonutBreakdownChartProps {
  segments: LiveDonutSegment[];
  centerLabel?: string;
  centerUnit?: string;
  totalOverride?: number;
  size?: number;
  isDark?: boolean;
  onSelectSegment?: (segment: LiveDonutSegment) => void;
  emptyText?: string;
  className?: string;
}

/**
 * Multi-arc SVG Donut Chart with:
 * - Inner dashed golden orbital ring (telemetryOrbitalSpin 18s GPU)
 * - Rotating specular sheen sweep across arcs
 * - Centered AnimatedTelemetryNumber
 * - Synchronized 2-way hover highlight (scale(1.04) on hovered arc + row)
 * - Right-side breakdown progress bars with continuous Liquid Shimmer
 */
export function LiveDonutBreakdownChart({
  segments,
  centerLabel = 'TỔNG',
  centerUnit = 'mục',
  totalOverride,
  size = 176,
  isDark = false,
  onSelectSegment,
  emptyText = 'Chưa có dữ liệu phân bổ.',
  className = '',
}: LiveDonutBreakdownChartProps) {
  const containerRef = useViewportAnimationPause<HTMLDivElement>();
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  const radius = 64;
  const strokeWidth = 18;
  const circumference = 2 * Math.PI * radius;

  const computed = useMemo(() => {
    const valid = segments.filter((s) => s.value >= 0);
    const sum = valid.reduce((acc, item) => acc + item.value, 0);
    const total = totalOverride ?? sum;
    const denom = Math.max(1, sum);

    let cursor = 0;
    const arcs = valid.map((seg) => {
      const ratio = seg.value / denom;
      const pct = seg.sharePct ?? Math.round(ratio * 100);
      const rawLen = ratio * circumference;
      const gap = valid.length > 1 && rawLen > 5 ? 3 : 0;
      const dashLen = Math.max(0, rawLen - gap);
      const dashOffset = -cursor;
      cursor += rawLen;
      return {
        ...seg,
        pct,
        dashArray: `${dashLen.toFixed(2)} ${(circumference - dashLen).toFixed(2)}`,
        dashOffset,
      };
    });

    return { total, arcs };
  }, [segments, totalOverride, circumference]);

  const activeSeg = hoveredId
    ? computed.arcs.find((a) => a.id === hoveredId) ?? null
    : null;

  const mutedText = isDark ? 'text-[#B5A18D]' : 'text-[#7A6A5B]';
  const rowIdleClass = isDark
    ? 'border-[#33261D] bg-[#1A130F]/80 hover:border-[#EBCF8F]/45'
    : 'border-[#B08A4A]/20 bg-[#FBF7EF]/85 hover:border-[#8A672C]/45';
  const rowActiveClass = isDark
    ? 'border-[#EBCF8F]/70 bg-[#261B14] shadow-[0_0_24px_-10px_rgba(243,210,153,0.4)]'
    : 'border-[#8A672C]/65 bg-[#F4EBDA]/80 shadow-sm';

  if (computed.arcs.length === 0) {
    return (
      <div
        className={`flex h-44 items-center justify-center rounded-2xl border border-dashed text-xs ${
          isDark
            ? 'border-[#3A2B21] text-[#9E8B78]'
            : 'border-[#B08A4A]/30 text-[#7A6A5B]'
        }`}
      >
        {emptyText}
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      data-telemetry-surface="donut-chart"
      className={`grid items-center gap-5 sm:grid-cols-[auto_minmax(0,1fr)] ${className}`}
    >
      {/* Left: Orbital SVG Donut */}
      <div
        className="relative mx-auto flex shrink-0 items-center justify-center"
        style={{ width: size, height: size }}
      >
        <svg
          viewBox="0 0 180 180"
          className="h-full w-full overflow-visible"
          role="img"
          aria-label={`Biểu đồ Donut ${centerLabel}: ${computed.total} ${centerUnit}`}
        >
          {/* Base Track */}
          <circle
            cx="90"
            cy="90"
            r={radius}
            fill="none"
            stroke={isDark ? 'rgba(243,210,153,0.1)' : 'rgba(176,138,74,0.14)'}
            strokeWidth={strokeWidth}
          />

          {/* Inner Rotating Dashed Golden Orbital Ring (18s GPU) */}
          <circle
            cx="90"
            cy="90"
            r={radius - 17}
            fill="none"
            stroke="var(--telemetry-orbital-stroke)"
            strokeWidth="1.2"
            strokeDasharray="3.5 5.5"
            className="telemetry-anim telemetry-orbital"
          />

          {/* Multi-Segment Arcs */}
          <g transform="rotate(-90 90 90)">
            {computed.arcs.map((arc) => {
              const isHovered = hoveredId === arc.id;
              const isDimmed = hoveredId !== null && !isHovered;
              return (
                <circle
                  key={arc.id}
                  cx="90"
                  cy="90"
                  r={radius}
                  fill="none"
                  stroke={arc.color}
                  strokeWidth={isHovered ? strokeWidth + 3 : strokeWidth}
                  strokeDasharray={arc.dashArray}
                  strokeDashoffset={arc.dashOffset}
                  strokeLinecap="butt"
                  opacity={isDimmed ? 0.42 : 1}
                  style={{
                    transformOrigin: '90px 90px',
                    transform: isHovered ? 'scale(1.04)' : 'scale(1)',
                    transition:
                      'transform 220ms cubic-bezier(0.22,1,0.36,1), stroke-width 220ms ease, opacity 220ms ease, stroke-dasharray 500ms ease, stroke-dashoffset 500ms ease',
                  }}
                  className="cursor-pointer"
                  onMouseEnter={() => setHoveredId(arc.id)}
                  onMouseLeave={() => setHoveredId(null)}
                  onClick={() => onSelectSegment?.(arc)}
                />
              );
            })}

            {/* Rotating Specular Sheen Highlight Sweep */}
            <circle
              cx="90"
              cy="90"
              r={radius}
              fill="none"
              pathLength={100}
              stroke="rgba(255, 250, 236, 0.36)"
              strokeWidth={strokeWidth - 4}
              strokeDasharray="7 93"
              strokeLinecap="round"
              pointerEvents="none"
              className="telemetry-anim telemetry-orbital-fast"
            />
          </g>
        </svg>

        {/* Center Live Total / Hovered Segment Readout */}
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
          <span
            className={`font-mono text-[9.5px] uppercase tracking-[0.16em] ${mutedText}`}
          >
            {activeSeg ? activeSeg.label.slice(0, 14) : centerLabel}
          </span>
          <span className="font-editorial mt-0.5 text-3xl font-semibold leading-none">
            <AnimatedTelemetryNumber
              value={activeSeg ? activeSeg.value : computed.total}
              format="integer"
            />
          </span>
          <span className={`mt-0.5 text-[10px] ${mutedText}`}>
            {activeSeg ? `${activeSeg.pct}%` : centerUnit}
          </span>
        </div>
      </div>

      {/* Right: Interactive Breakdown Rows with Liquid Shimmer */}
      <div className="min-w-0 space-y-2.5">
        {computed.arcs.map((arc) => {
          const isHovered = hoveredId === arc.id;
          return (
            <div
              key={arc.id}
              onMouseEnter={() => setHoveredId(arc.id)}
              onMouseLeave={() => setHoveredId(null)}
              onClick={() => onSelectSegment?.(arc)}
              role={onSelectSegment ? 'button' : undefined}
              tabIndex={onSelectSegment ? 0 : undefined}
              onKeyDown={
                onSelectSegment
                  ? (e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        onSelectSegment(arc);
                      }
                    }
                  : undefined
              }
              className={`rounded-xl border px-3 py-2 transition-all duration-200 ${
                onSelectSegment ? 'cursor-pointer' : ''
              } ${isHovered ? rowActiveClass : rowIdleClass}`}
            >
              <div className="flex items-center justify-between gap-2 text-xs">
                <div className="flex min-w-0 items-center gap-2">
                  <span
                    className="h-2.5 w-2.5 shrink-0 rounded-full transition-transform duration-200"
                    style={{
                      backgroundColor: arc.color,
                      transform: isHovered ? 'scale(1.25)' : 'scale(1)',
                    }}
                  />
                  <span className="truncate font-medium">{arc.label}</span>
                </div>
                <div className="flex shrink-0 items-baseline gap-1 font-mono text-[11px]">
                  <strong className="font-semibold">
                    <AnimatedTelemetryNumber value={arc.value} format="integer" />
                  </strong>
                  <span className={mutedText}>
                    {arc.unitLabel ?? centerUnit} ({arc.pct}%)
                  </span>
                </div>
              </div>

              <div
                className={`relative mt-1.5 h-1.5 w-full overflow-hidden rounded-full ${
                  isDark ? 'bg-[#2C2018]' : 'bg-[#EBD9B4]/55'
                }`}
              >
                <div
                  className="relative h-full overflow-hidden rounded-full transition-all duration-500"
                  style={{
                    width: `${Math.max(arc.value > 0 ? 6 : 0, Math.min(100, arc.pct))}%`,
                    backgroundColor: arc.color,
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
    </div>
  );
}
