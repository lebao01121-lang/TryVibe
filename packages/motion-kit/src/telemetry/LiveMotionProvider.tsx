'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';

const LIVE_MOTION_STORAGE_KEY = 'tryvibe_live_telemetry_motion_v1';

export interface LiveMotionContextValue {
  /** User preference for continuous GPU telemetry motion (persisted in localStorage) */
  liveMotionEnabled: boolean;
  /** Toggle or explicitly set live telemetry motion */
  setLiveMotionEnabled: (enabled: boolean) => void;
  toggleLiveMotion: () => void;
  /** True while browser tab is hidden via visibilitychange */
  tabHidden: boolean;
  /** True when OS/browser requests prefers-reduced-motion: reduce */
  reducedMotion: boolean;
  /** True when animations should be treated as paused */
  isEffectivelyPaused: boolean;
}

const DEFAULT_CONTEXT: LiveMotionContextValue = {
  liveMotionEnabled: true,
  setLiveMotionEnabled: () => {},
  toggleLiveMotion: () => {},
  tabHidden: false,
  reducedMotion: false,
  isEffectivelyPaused: false,
};

const LiveMotionContext = createContext<LiveMotionContextValue>(DEFAULT_CONTEXT);

export interface LiveMotionProviderProps {
  children: ReactNode;
  defaultEnabled?: boolean;
}

export function LiveMotionProvider({
  children,
  defaultEnabled = true,
}: LiveMotionProviderProps) {
  const [liveMotionEnabled, setLiveMotionEnabledState] =
    useState<boolean>(defaultEnabled);
  const [tabHidden, setTabHidden] = useState<boolean>(false);
  const [reducedMotion, setReducedMotion] = useState<boolean>(false);

  // Hydrate persisted user toggle from localStorage (SSR-safe, post-mount)
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const saved = window.localStorage.getItem(LIVE_MOTION_STORAGE_KEY);
      if (saved === 'paused' || saved === 'false') {
        setLiveMotionEnabledState(false);
      } else if (saved === 'active' || saved === 'true') {
        setLiveMotionEnabledState(true);
      }
    } catch {
      // Ignore storage access errors in restricted frames
    }
  }, []);

  // Keep <html data-live-motion="active|paused"> synchronized
  useEffect(() => {
    if (typeof document === 'undefined') return;
    document.documentElement.dataset.liveMotion = liveMotionEnabled
      ? 'active'
      : 'paused';
  }, [liveMotionEnabled]);

  // Listen to document.visibilitychange -> <html data-tab-hidden="true|false">
  useEffect(() => {
    if (typeof document === 'undefined') return undefined;

    const syncVisibility = () => {
      const hidden = Boolean(document.hidden);
      document.documentElement.dataset.tabHidden = hidden ? 'true' : 'false';
      setTabHidden(hidden);
    };

    syncVisibility();
    document.addEventListener('visibilitychange', syncVisibility);
    return () => {
      document.removeEventListener('visibilitychange', syncVisibility);
    };
  }, []);

  // Listen to prefers-reduced-motion: reduce
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return undefined;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const syncReduced = () => setReducedMotion(mq.matches);
    syncReduced();
    mq.addEventListener('change', syncReduced);
    return () => mq.removeEventListener('change', syncReduced);
  }, []);

  const setLiveMotionEnabled = useCallback((enabled: boolean) => {
    setLiveMotionEnabledState(enabled);
    if (typeof document !== 'undefined') {
      document.documentElement.dataset.liveMotion = enabled
        ? 'active'
        : 'paused';
    }
    if (typeof window !== 'undefined') {
      try {
        window.localStorage.setItem(
          LIVE_MOTION_STORAGE_KEY,
          enabled ? 'active' : 'paused',
        );
      } catch {
        // Ignore quota errors
      }
    }
  }, []);

  const toggleLiveMotion = useCallback(() => {
    setLiveMotionEnabled(!liveMotionEnabled);
  }, [liveMotionEnabled, setLiveMotionEnabled]);

  const value = useMemo<LiveMotionContextValue>(
    () => ({
      liveMotionEnabled,
      setLiveMotionEnabled,
      toggleLiveMotion,
      tabHidden,
      reducedMotion,
      isEffectivelyPaused: !liveMotionEnabled || tabHidden || reducedMotion,
    }),
    [
      liveMotionEnabled,
      setLiveMotionEnabled,
      toggleLiveMotion,
      tabHidden,
      reducedMotion,
    ],
  );

  return (
    <LiveMotionContext.Provider value={value}>
      {children}
    </LiveMotionContext.Provider>
  );
}

export function useLiveMotion(): LiveMotionContextValue {
  return useContext(LiveMotionContext);
}

/**
 * Zero-React-Rerender Viewport Pause Hook:
 * Uses IntersectionObserver to toggle `data-telemetry-offscreen="true|false"`
 * directly on the target DOM container so offscreen GPU animations pause
 * automatically without causing a single React re-render during scroll.
 */
export function useViewportAnimationPause<
  T extends HTMLElement = HTMLDivElement,
>(rootMargin = '80px 0px'): RefObject<T | null> {
  const ref = useRef<T | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof window === 'undefined') return undefined;

    if (typeof IntersectionObserver === 'undefined') {
      el.dataset.telemetryOffscreen = 'false';
      return undefined;
    }

    el.dataset.telemetryOffscreen = 'false';

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const target = entry.target as HTMLElement;
          target.dataset.telemetryOffscreen = entry.isIntersecting
            ? 'false'
            : 'true';
        }
      },
      { rootMargin, threshold: 0.01 },
    );

    observer.observe(el);
    return () => {
      observer.disconnect();
    };
  }, [rootMargin]);

  return ref;
}

export interface LiveMotionTogglePillProps {
  className?: string;
  compact?: boolean;
  tone?: 'auto' | 'dark' | 'light';
}

/**
 * Header control pill (`⚡ Live` / `⚡ Live: Tĩnh`) allowing operators to freeze
 * GPU motion cleanly when capturing screenshots/reports.
 */
export function LiveMotionTogglePill({
  className = '',
  compact = false,
  tone = 'auto',
}: LiveMotionTogglePillProps) {
  const { liveMotionEnabled, toggleLiveMotion, reducedMotion } =
    useLiveMotion();

  const isLive = liveMotionEnabled && !reducedMotion;

  const baseToneClass =
    tone === 'dark'
      ? isLive
        ? 'border-[#34D399]/40 bg-[#1A2A22]/85 text-[#A7F3D0] hover:border-[#34D399]/75'
        : 'border-[#B08A4A]/35 bg-[#241A14] text-[#D8C7AF] hover:border-[#EBCF8F]/60'
      : tone === 'light'
        ? isLive
          ? 'border-[#2E6B47]/35 bg-[#F2FBF6] text-[#1E4B32] hover:border-[#2E6B47]/65'
          : 'border-[#B08A4A]/35 bg-white text-[#6A5A4D] hover:border-[#8A672C]/65'
        : isLive
          ? 'border-emerald-600/35 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
          : 'border-[#B08A4A]/35 bg-[#F4EBDA]/60 text-[#6A5A4D]';

  return (
    <button
      type="button"
      data-testid="live-motion-toggle"
      aria-pressed={isLive}
      onClick={toggleLiveMotion}
      title={
        reducedMotion
          ? 'Trình duyệt đang bật Giảm chuyển động (prefers-reduced-motion)'
          : isLive
            ? 'Đang phát sóng chuyển động Live 60 FPS — bấm để chuyển Tĩnh khi chụp báo cáo'
            : 'Chế độ Tĩnh (đã tạm dừng chuyển động GPU) — bấm để bật lại Live'
      }
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors ${baseToneClass} ${className}`}
    >
      <span className="relative flex h-2 w-2 shrink-0 items-center justify-center">
        {isLive ? (
          <span
            aria-hidden="true"
            className="telemetry-anim telemetry-beacon-ring absolute inset-0 rounded-full bg-emerald-400/75"
          />
        ) : null}
        <span
          aria-hidden="true"
          className={`relative h-1.5 w-1.5 rounded-full ${
            isLive ? 'bg-emerald-500' : 'bg-[#9E8B78]'
          }`}
        />
      </span>
      <span className="whitespace-nowrap">
        {compact
          ? isLive
            ? '⚡ Live'
            : '⚡ Tĩnh'
          : isLive
            ? '⚡ Live'
            : '⚡ Live: Tĩnh'}
      </span>
    </button>
  );
}
