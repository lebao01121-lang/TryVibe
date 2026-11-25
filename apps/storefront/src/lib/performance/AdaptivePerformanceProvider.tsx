'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from 'react';

export type PerformanceTier = 'HIGH' | 'MEDIUM' | 'LOW';

export interface AdaptivePerformanceContextValue {
  tier: PerformanceTier;
  detectedTier: PerformanceTier;
  override: PerformanceTier | null;
  avgFps: number | null;
  isLowPower: boolean;
  setOverride: (next: PerformanceTier | null) => void;
  toggleLowPower: () => void;
}

export const PERF_TIER_STORAGE_KEY = 'atelier_perf_tier_override';
export const PERF_TIER_EVENT_NAME = 'atelier:set-perf-tier';

const FPS_SAMPLE_FRAMES = 40;
const FPS_WARMUP_DELAY_MS = 2800;
const FPS_WARMUP_FRAMES = 15;
const FPS_LOW_THRESHOLD = 38;
const FPS_SEVERE_LOW_THRESHOLD = 22;
const FPS_REQUIRED_LOW_WINDOWS = 2;

const LOW_POWER_GPU_REGEX =
  /swiftshader|llvmpipe|softpipe|microsoft basic render driver|mali-400|mali-450/i;

const DEFAULT_CONTEXT_VALUE: AdaptivePerformanceContextValue = {
  tier: 'HIGH',
  detectedTier: 'HIGH',
  override: null,
  avgFps: null,
  isLowPower: false,
  setOverride: () => {},
  toggleLowPower: () => {},
};

const AdaptivePerformanceContext =
  createContext<AdaptivePerformanceContextValue>(DEFAULT_CONTEXT_VALUE);

function parsePerformanceTier(raw: unknown): PerformanceTier | null {
  if (typeof raw !== 'string') return null;
  const normalized = raw.trim().toUpperCase();
  if (normalized === 'HIGH' || normalized === 'MEDIUM' || normalized === 'LOW') {
    return normalized;
  }
  return null;
}

function readQueryTierOverride(): PerformanceTier | null {
  if (typeof window === 'undefined') return null;
  try {
    const params = new URLSearchParams(window.location.search);
    const direct = params.get('perfTier') ?? params.get('perftier');
    if (direct) return parsePerformanceTier(direct);
    for (const [key, value] of params.entries()) {
      if (key.toLowerCase() === 'perftier') {
        return parsePerformanceTier(value);
      }
    }
  } catch {
    // Ignore malformed query string
  }
  return null;
}

function readStoredTierOverride(): PerformanceTier | null {
  if (typeof window === 'undefined') return null;
  try {
    return parsePerformanceTier(window.localStorage.getItem(PERF_TIER_STORAGE_KEY));
  } catch {
    return null;
  }
}

function writeStoredTierOverride(next: PerformanceTier | null): void {
  if (typeof window === 'undefined') return;
  try {
    if (next === null) {
      window.localStorage.removeItem(PERF_TIER_STORAGE_KEY);
    } else {
      window.localStorage.setItem(PERF_TIER_STORAGE_KEY, next);
    }
  } catch {
    // Ignore restricted storage environments (private browsing / quota)
  }
}

function probeWebglRendererIsLowPower(): boolean {
  if (typeof document === 'undefined') return false;

  const probeCanvas = document.createElement('canvas');
  probeCanvas.width = 1;
  probeCanvas.height = 1;

  let gl: WebGLRenderingContext | WebGL2RenderingContext | null = null;
  try {
    gl =
      (probeCanvas.getContext('webgl2', {
        failIfMajorPerformanceCaveat: false,
        powerPreference: 'default',
      }) as WebGL2RenderingContext | null) ||
      (probeCanvas.getContext('webgl', {
        failIfMajorPerformanceCaveat: false,
      }) as WebGLRenderingContext | null) ||
      (probeCanvas.getContext('experimental-webgl') as WebGLRenderingContext | null);

    if (!gl) {
      return true;
    }

    const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
    const rendererRaw = debugInfo
      ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL)
      : gl.getParameter(gl.RENDERER);
    const renderer = typeof rendererRaw === 'string' ? rendererRaw : '';

    return LOW_POWER_GPU_REGEX.test(renderer);
  } catch {
    return false;
  } finally {
    if (gl) {
      try {
        const loseContextExt = gl.getExtension('WEBGL_lose_context');
        loseContextExt?.loseContext();
      } catch {
        // Ignore loseContext failure
      }
    }
    probeCanvas.width = 0;
    probeCanvas.height = 0;
  }
}

function detectHardwarePerformanceTier(): PerformanceTier {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') {
    return 'HIGH';
  }

  const prefersReducedMotion = window.matchMedia(
    '(prefers-reduced-motion: reduce)',
  ).matches;
  if (prefersReducedMotion) {
    return 'LOW';
  }

  const cores =
    typeof navigator.hardwareConcurrency === 'number' &&
    Number.isFinite(navigator.hardwareConcurrency)
      ? navigator.hardwareConcurrency
      : 8;

  const navWithMemory = navigator as Navigator & { deviceMemory?: number };
  const deviceMemory =
    typeof navWithMemory.deviceMemory === 'number' &&
    Number.isFinite(navWithMemory.deviceMemory)
      ? navWithMemory.deviceMemory
      : 8;

  const isCoarsePointer = window.matchMedia('(pointer: coarse)').matches;
  const isMobileUa = /Mobi|Android|iPhone|iPad|iPod/i.test(
    navigator.userAgent || '',
  );
  const isMobile = isCoarsePointer || isMobileUa;

  const lowCores = cores <= 4;
  const lowMemory = deviceMemory <= 4;

  // Normal 4-core/4GB desktops with real WebGL GPUs get MEDIUM (keeps full 3D Brass Rack smooth at 1.25 DPR).
  // Reserve automatic LOW strictly for software rasterizers, reduced-motion, or low-end mobile devices.
  let tier: PerformanceTier = 'HIGH';
  if ((lowCores && lowMemory && isMobile) || (cores <= 2 && lowMemory)) {
    tier = 'LOW';
  } else if (lowCores || lowMemory) {
    tier = 'MEDIUM';
  }

  if (tier !== 'LOW' && probeWebglRendererIsLowPower()) {
    tier = 'LOW';
  }

  return tier;
}

export function AdaptivePerformanceProvider({
  children,
}: {
  children: ReactNode;
}): JSX.Element {
  // SSR-safe initial state: always 'HIGH' during SSR & first client render for zero hydration mismatch
  const [detectedTier, setDetectedTier] = useState<PerformanceTier>('HIGH');
  const [override, setOverrideState] = useState<PerformanceTier | null>(null);
  const [avgFps, setAvgFps] = useState<number | null>(null);

  const tier: PerformanceTier = override ?? detectedTier;
  const isLowPower = tier === 'LOW';

  const tierRef = useRef<PerformanceTier>(tier);
  tierRef.current = tier;

  const hardwareTierRef = useRef<PerformanceTier>('HIGH');
  const fpsDowngradedRef = useRef<boolean>(false);

  const setOverride = useCallback((next: PerformanceTier | null) => {
    setOverrideState(next);
    writeStoredTierOverride(next);
  }, []);

  const toggleLowPower = useCallback(() => {
    const next: PerformanceTier = tierRef.current === 'LOW' ? 'HIGH' : 'LOW';
    setOverrideState(next);
    writeStoredTierOverride(next);
  }, []);

  // 1. Hydrate overrides (URL query ?perfTier=... > localStorage), run zero-blocking hardware heuristic,
  //    and wire reduced-motion + custom event + multi-tab storage listeners
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;

    const queryOverride = readQueryTierOverride();
    const storedOverride = readStoredTierOverride();
    if (queryOverride !== null) {
      setOverrideState(queryOverride);
    } else if (storedOverride !== null) {
      setOverrideState(storedOverride);
    }

    const hwTier = detectHardwarePerformanceTier();
    hardwareTierRef.current = hwTier;
    setDetectedTier((prev) =>
      fpsDowngradedRef.current ? 'LOW' : prev === hwTier ? prev : hwTier,
    );

    const reducedMotionQuery = window.matchMedia(
      '(prefers-reduced-motion: reduce)',
    );
    const handleReducedMotionChange = (event: MediaQueryListEvent) => {
      if (event.matches) {
        setDetectedTier('LOW');
      } else {
        setDetectedTier(
          fpsDowngradedRef.current ? 'LOW' : hardwareTierRef.current,
        );
      }
    };
    reducedMotionQuery.addEventListener('change', handleReducedMotionChange);

    const handleCustomTierEvent = (event: Event) => {
      const customEvent = event as CustomEvent<
        PerformanceTier | 'AUTO' | null | { tier?: PerformanceTier | 'AUTO' | null; persist?: boolean }
      >;
      const detail = customEvent.detail;
      let rawNext: unknown = detail;
      let persist = true;

      if (detail && typeof detail === 'object' && 'tier' in detail) {
        rawNext = detail.tier;
        if (typeof detail.persist === 'boolean') {
          persist = detail.persist;
        }
      }

      if (
        rawNext === null ||
        rawNext === '' ||
        (typeof rawNext === 'string' && rawNext.trim().toUpperCase() === 'AUTO')
      ) {
        setOverrideState(null);
        if (persist) writeStoredTierOverride(null);
        return;
      }

      const parsed = parsePerformanceTier(rawNext);
      if (parsed) {
        setOverrideState(parsed);
        if (persist) writeStoredTierOverride(parsed);
      }
    };

    const handleStorage = (event: StorageEvent) => {
      if (event.key !== PERF_TIER_STORAGE_KEY) return;
      setOverrideState(parsePerformanceTier(event.newValue));
    };

    window.addEventListener(PERF_TIER_EVENT_NAME, handleCustomTierEvent);
    window.addEventListener('storage', handleStorage);

    return () => {
      reducedMotionQuery.removeEventListener('change', handleReducedMotionChange);
      window.removeEventListener(PERF_TIER_EVENT_NAME, handleCustomTierEvent);
      window.removeEventListener('storage', handleStorage);
    };
  }, []);

  // 2. Non-blocking post-hydration live FPS auto-tuner (waits for initial load/hydration to settle
  //    so startup jank never falsely kills WebGL 3D Rack; pauses cleanly when document.hidden)
  useEffect(() => {
    if (typeof window === 'undefined' || typeof document === 'undefined') {
      return undefined;
    }

    let rafId = 0;
    let warmupTimerId = 0;
    let cancelled = false;
    let warmupFramesLeft = FPS_WARMUP_FRAMES;
    let sampledFrames = 0;
    let totalElapsedMs = 0;
    let lowWindowsCount = 0;
    let windowsCompleted = 0;
    let lastTimestamp: number | null = null;

    const sampleFrame = (now: number) => {
      rafId = 0;
      if (cancelled) return;

      if (document.hidden) {
        lastTimestamp = null;
        return;
      }

      if (warmupFramesLeft > 0) {
        warmupFramesLeft -= 1;
        lastTimestamp = now;
        rafId = window.requestAnimationFrame(sampleFrame);
        return;
      }

      if (lastTimestamp !== null) {
        const dt = now - lastTimestamp;
        // Ignore single-frame hydration/GC/tab-switch stalls (> 120ms)
        if (dt > 0 && dt <= 120) {
          totalElapsedMs += dt;
          sampledFrames += 1;
        }
      }
      lastTimestamp = now;

      if (sampledFrames >= FPS_SAMPLE_FRAMES) {
        const measuredFps =
          totalElapsedMs > 0
            ? Math.max(
                1,
                Math.min(240, Math.round((sampledFrames * 1000) / totalElapsedMs)),
              )
            : 60;
        setAvgFps(measuredFps);
        windowsCompleted += 1;

        if (measuredFps < FPS_SEVERE_LOW_THRESHOLD) {
          lowWindowsCount += 1;
          if (lowWindowsCount >= FPS_REQUIRED_LOW_WINDOWS) {
            fpsDowngradedRef.current = true;
            setDetectedTier('LOW');
            return;
          }
        } else if (measuredFps < FPS_LOW_THRESHOLD) {
          // Moderate dip (22..37 FPS): step down gracefully to MEDIUM (keeps 3D Brass Rack active at 1.25 DPR)
          setDetectedTier((prev) => (prev === 'HIGH' ? 'MEDIUM' : prev));
          lowWindowsCount = 0;
        } else {
          lowWindowsCount = 0;
        }

        if (windowsCompleted >= FPS_REQUIRED_LOW_WINDOWS) {
          return;
        }

        // Run second confirmation window only if first window saw severe low FPS
        if (lowWindowsCount > 0) {
          sampledFrames = 0;
          totalElapsedMs = 0;
          lastTimestamp = null;
          rafId = window.requestAnimationFrame(sampleFrame);
        }
        return;
      }

      rafId = window.requestAnimationFrame(sampleFrame);
    };

    const scheduleSampling = () => {
      if (cancelled || document.hidden || windowsCompleted >= FPS_REQUIRED_LOW_WINDOWS) {
        return;
      }
      if (!rafId) {
        lastTimestamp = null;
        rafId = window.requestAnimationFrame(sampleFrame);
      }
    };

    const handleVisibilityChange = () => {
      if (document.hidden) {
        if (rafId) {
          window.cancelAnimationFrame(rafId);
          rafId = 0;
        }
        lastTimestamp = null;
      } else if (!warmupTimerId) {
        scheduleSampling();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    warmupTimerId = window.setTimeout(() => {
      warmupTimerId = 0;
      scheduleSampling();
    }, FPS_WARMUP_DELAY_MS);

    return () => {
      cancelled = true;
      if (warmupTimerId) window.clearTimeout(warmupTimerId);
      if (rafId) window.cancelAnimationFrame(rafId);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);

  // 3. Mirror effective tier onto <html data-perf-tier="..."> and observe direct QA DOM mutations
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    if (root.dataset.perfTier !== tier) {
      root.dataset.perfTier = tier;
    }
  }, [tier]);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    if (avgFps !== null) {
      root.dataset.perfFps = String(avgFps);
    }
  }, [avgFps]);

  useEffect(() => {
    if (
      typeof document === 'undefined' ||
      typeof MutationObserver === 'undefined'
    ) {
      return undefined;
    }

    const root = document.documentElement;
    const observer = new MutationObserver(() => {
      const attrTier = parsePerformanceTier(root.dataset.perfTier);
      if (attrTier && attrTier !== tierRef.current) {
        setOverrideState(attrTier);
      }
    });

    observer.observe(root, {
      attributes: true,
      attributeFilter: ['data-perf-tier'],
    });

    return () => observer.disconnect();
  }, []);

  const value = useMemo<AdaptivePerformanceContextValue>(
    () => ({
      tier,
      detectedTier,
      override,
      avgFps,
      isLowPower,
      setOverride,
      toggleLowPower,
    }),
    [tier, detectedTier, override, avgFps, isLowPower, setOverride, toggleLowPower],
  );

  return (
    <AdaptivePerformanceContext.Provider value={value}>
      {children}
    </AdaptivePerformanceContext.Provider>
  );
}

export function useAdaptivePerformance(): AdaptivePerformanceContextValue {
  return useContext(AdaptivePerformanceContext);
}

export function PerformanceTierToggle({
  className = '',
}: {
  className?: string;
}): JSX.Element {
  const { tier, isLowPower, avgFps, toggleLowPower } = useAdaptivePerformance();

  const titleText = isLowPower
    ? `Đang bật chế độ Tiết kiệm pin (${tier}${avgFps ? ` · ${avgFps} FPS` : ''}) — Nhấn để bật hiệu ứng Cao cấp`
    : `Đang bật hiệu ứng Cao cấp (${tier}${avgFps ? ` · ${avgFps} FPS` : ''}) — Nhấn để chuyển Tiết kiệm pin`;

  return (
    <button
      type="button"
      data-testid="perf-tier-toggle"
      data-perf-tier={tier}
      aria-pressed={isLowPower}
      aria-label="Chuyển đổi chế độ hiệu ứng đồ họa Cao cấp hoặc Tiết kiệm pin"
      title={titleText}
      onClick={toggleLowPower}
      className={`inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-[#B08A4A]/35 bg-[#2A1E17]/85 px-3 py-1 text-[11px] leading-none tracking-[0.04em] text-[#FBF7EF]/85 transition-colors hover:border-[#EBCF8F]/70 hover:text-[#FBF7EF] ${className}`.trim()}
    >
      <span
        aria-hidden="true"
        className={`h-1.5 w-1.5 rounded-full transition-colors ${
          isLowPower ? 'bg-[#B08A4A]' : 'bg-[#EBCF8F]'
        }`}
      />
      <span className="text-[#FBF7EF]/65">Hiệu ứng:</span>
      <span
        className={
          !isLowPower
            ? 'font-medium text-[#EBCF8F]'
            : 'text-[#FBF7EF]/45'
        }
      >
        Cao cấp
      </span>
      <span aria-hidden="true" className="text-[#B08A4A]/50">
        |
      </span>
      <span
        className={
          isLowPower
            ? 'font-medium text-[#EBCF8F]'
            : 'text-[#FBF7EF]/45'
        }
      >
        Tiết kiệm pin
      </span>
    </button>
  );
}
