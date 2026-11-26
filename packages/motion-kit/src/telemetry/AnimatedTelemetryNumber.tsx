'use client';

import { useEffect, useRef, useState } from 'react';
import { useLiveMotion } from './LiveMotionProvider.js';

export type TelemetryNumberFormat =
  | 'integer'
  | 'decimal'
  | 'percent'
  | 'vnd'
  | 'compactVnd'
  | 'millionsVnd';

export interface AnimatedTelemetryNumberProps {
  value: number;
  format?: TelemetryNumberFormat;
  decimals?: number;
  prefix?: string;
  suffix?: string;
  formatter?: (val: number) => string;
  durationMs?: number;
  flashOnChange?: boolean;
  className?: string;
}

const VI_INT = new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 0 });
const VI_VND = new Intl.NumberFormat('vi-VN', {
  style: 'currency',
  currency: 'VND',
  maximumFractionDigits: 0,
});

function formatTelemetryValue(
  val: number,
  format: TelemetryNumberFormat,
  decimals: number,
  formatter?: (n: number) => string,
): string {
  const safe = Number.isFinite(val) ? val : 0;
  if (formatter) return formatter(safe);

  switch (format) {
    case 'vnd':
      return VI_VND.format(Math.round(safe));
    case 'compactVnd': {
      const abs = Math.abs(safe);
      if (abs >= 1_000_000_000) {
        return `${(safe / 1_000_000_000).toFixed(1)} tỷ₫`;
      }
      if (abs >= 1_000_000) {
        return `${(safe / 1_000_000).toFixed(1)} tr₫`;
      }
      if (abs >= 1_000) {
        return `${Math.round(safe / 1_000)}k₫`;
      }
      return `${VI_INT.format(Math.round(safe))}₫`;
    }
    case 'millionsVnd': {
      const m = safe / 1_000_000;
      return `${m.toFixed(decimals)} tr₫`;
    }
    case 'percent':
      return `${safe.toFixed(decimals)}%`;
    case 'decimal':
      return safe.toFixed(decimals);
    case 'integer':
    default:
      return VI_INT.format(Math.round(safe));
  }
}

function easeOutExpo(t: number): number {
  return t >= 1 ? 1 : 1 - Math.pow(2, -10 * t);
}

/**
 * Smooth numeric interpolator (650ms easeOutExpo) that runs ONLY when the real
 * backend metric changes — zero continuous intervals, zero fake random jitter,
 * and SSR-safe initial output for zero hydration mismatch.
 */
export function AnimatedTelemetryNumber({
  value,
  format = 'integer',
  decimals = 0,
  prefix = '',
  suffix = '',
  formatter,
  durationMs = 650,
  flashOnChange = true,
  className = '',
}: AnimatedTelemetryNumberProps) {
  const safeTarget = Number.isFinite(value) ? value : 0;
  const { isEffectivelyPaused } = useLiveMotion();
  const [displayValue, setDisplayValue] = useState<number>(safeTarget);
  const [flashKey, setFlashKey] = useState<number>(0);

  const prevValueRef = useRef<number>(safeTarget);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    const startVal = prevValueRef.current;
    if (Object.is(startVal, safeTarget)) {
      return undefined;
    }

    prevValueRef.current = safeTarget;

    if (flashOnChange && !isEffectivelyPaused) {
      setFlashKey((k) => k + 1);
    }

    if (
      isEffectivelyPaused ||
      durationMs <= 0 ||
      typeof window === 'undefined' ||
      typeof window.requestAnimationFrame !== 'function'
    ) {
      setDisplayValue(safeTarget);
      return undefined;
    }

    const startTime = performance.now();
    const delta = safeTarget - startVal;

    const step = (now: number) => {
      const elapsed = now - startTime;
      const progress = Math.min(1, Math.max(0, elapsed / durationMs));
      const eased = easeOutExpo(progress);
      setDisplayValue(startVal + delta * eased);

      if (progress < 1) {
        rafRef.current = window.requestAnimationFrame(step);
      } else {
        setDisplayValue(safeTarget);
        rafRef.current = null;
      }
    };

    rafRef.current = window.requestAnimationFrame(step);
    return () => {
      if (rafRef.current !== null) {
        window.cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [safeTarget, durationMs, isEffectivelyPaused, flashOnChange]);

  const formatted = formatTelemetryValue(
    displayValue,
    format,
    decimals,
    formatter,
  );

  return (
    <span
      key={flashKey > 0 ? `f-${flashKey}` : 'f-init'}
      className={`inline-block tabular-nums ${
        flashKey > 0 ? 'telemetry-anim telemetry-value-flash' : ''
      } ${className}`}
    >
      {prefix}
      {formatted}
      {suffix}
    </span>
  );
}
