'use client';

import { useLenis } from 'lenis/react';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from 'react';
import { useMotionState } from '@atelier/motion-kit';
import { ensureGsapRegistered, gsap, ScrollTrigger } from '@/lib/gsap-setup';
import styles from './atelier-story.module.css';

export interface ThreadStepLabel {
  order: string;
  time: string;
  title: string;
}

export interface GoldenThreadSvgProps {
  bodyRef: RefObject<HTMLDivElement | null>;
  stepCount: number;
  activeStepIndex: number;
  stepLabels?: ThreadStepLabel[];
  onWaypointSelect?: (index: number) => void;
  onProgressChange?: (progress: number) => void;
}

interface WaypointMetric {
  index: number;
  x: number;
  y: number;
  threshold: number;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

/**
 * Computes real-time scroll progress directly from `.atelier__body` viewport
 * geometry, mirroring `start: 'top 72%'` -> `end: 'bottom 58%'`. Immune to
 * upstream GSAP `pin-spacer` timing drift or stale ScrollTrigger caches.
 */
function computeViewportProgress(body: HTMLElement): number {
  const rect = body.getBoundingClientRect();
  const vh = window.innerHeight || 1;
  if (rect.height <= 0) return 0;
  const startY = vh * 0.72;
  const endY = vh * 0.58;
  const span = Math.max(1, rect.height + (startY - endY));
  const traveled = startY - rect.top;
  return clamp01(traveled / span);
}

function getRelativeLayoutBox(
  el: HTMLElement,
  ancestor: HTMLElement,
): { left: number; top: number; width: number; height: number } {
  let left = 0;
  let top = 0;
  let curr: HTMLElement | null = el;
  while (curr && curr !== ancestor) {
    left += curr.offsetLeft;
    top += curr.offsetTop;
    curr = curr.offsetParent as HTMLElement | null;
  }
  if (curr !== ancestor) {
    const aRect = ancestor.getBoundingClientRect();
    const eRect = el.getBoundingClientRect();
    return {
      left: eRect.left - aRect.left,
      top: eRect.top - aRect.top,
      width: eRect.width,
      height: eRect.height,
    };
  }
  return {
    left,
    top,
    width: el.offsetWidth,
    height: el.offsetHeight,
  };
}

/**
 * Since the S-curve Y coordinate strictly increases from start to end, binary
 * search locates the exact arc-length fraction for each waypoint in ~12 steps.
 */
function findArcThresholdForY(
  path: SVGPathElement,
  totalLength: number,
  targetY: number,
): number {
  if (totalLength <= 0) return 0;
  let lo = 0;
  let hi = totalLength;
  for (let i = 0; i < 12; i += 1) {
    const mid = (lo + hi) * 0.5;
    const pt = path.getPointAtLength(mid);
    if (pt.y < targetY) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return clamp01(((lo + hi) * 0.5) / totalLength);
}

export function GoldenThreadSvg({
  bodyRef,
  stepCount,
  activeStepIndex,
  stepLabels,
  onWaypointSelect,
  onProgressChange,
}: GoldenThreadSvgProps) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const trackRef = useRef<SVGPathElement | null>(null);
  const pathRef = useRef<SVGPathElement | null>(null);
  const glowRef = useRef<SVGPathElement | null>(null);
  const pearlRef = useRef<HTMLDivElement | null>(null);

  const totalLengthRef = useRef<number>(1);
  const currentProgressRef = useRef<number>(0);
  const targetProgressRef = useRef<number>(0);
  const waypointsRef = useRef<WaypointMetric[]>([]);
  const reachedCountRef = useRef<number>(0);
  const geoSyncFnRef = useRef<(() => void) | null>(null);
  const onProgressChangeRef = useRef(onProgressChange);
  onProgressChangeRef.current = onProgressChange;

  const [svgSize, setSvgSize] = useState<{ width: number; height: number }>({
    width: 1100,
    height: 2200,
  });
  const [waypoints, setWaypoints] = useState<WaypointMetric[]>([]);
  const [reachedCount, setReachedCount] = useState<number>(0);

  const { reducedMotion, cameraActive } = useMotionState();
  const isStaticComplete = reducedMotion || cameraActive;

  const applyThreadProgress = useCallback((progress: number) => {
    const svg = svgRef.current;
    const path = pathRef.current;
    const glow = glowRef.current;
    const pearl = pearlRef.current;
    const len = totalLengthRef.current;
    if (!path || !glow || len <= 0) return;

    const clamped = clamp01(progress);
    currentProgressRef.current = clamped;

    const offset = len * (1 - clamped);
    const offsetStr = offset.toFixed(2);
    path.style.strokeDashoffset = offsetStr;
    glow.style.strokeDashoffset = offsetStr;

    if (svg) {
      svg.dataset.threadProgress = clamped.toFixed(4);
    }

    if (pearl) {
      const point = path.getPointAtLength(clamped * len);
      pearl.style.transform = `translate3d(${point.x.toFixed(2)}px, ${point.y.toFixed(2)}px, 0)`;
      pearl.dataset.pearlY = point.y.toFixed(1);
    }

    // Update reached waypoint count only when crossing a threshold (max N updates)
    const wps = waypointsRef.current;
    let nextReached = 0;
    for (let i = 0; i < wps.length; i += 1) {
      if (clamped >= wps[i]!.threshold - 0.018) {
        nextReached = i + 1;
      }
    }
    if (nextReached !== reachedCountRef.current) {
      reachedCountRef.current = nextReached;
      setReachedCount(nextReached);
    }

    onProgressChangeRef.current?.(clamped);
  }, []);

  // Hook into Lenis smooth scroll ticks for immediate 60 FPS geometry sync
  useLenis(() => {
    geoSyncFnRef.current?.();
  });

  // Runs in passive useEffect (AFTER parent `<div ref={bodyRef}>` has attached!)
  useEffect(() => {
    ensureGsapRegistered();
    const body = bodyRef.current;
    const svg = svgRef.current;
    const track = trackRef.current;
    const path = pathRef.current;
    const glow = glowRef.current;
    if (!body || !svg || !track || !path || !glow) return;

    let animRafId: number | null = null;
    let resizeRafId: number | null = null;
    let scrollTriggerInstance: ScrollTrigger | null = null;
    let scrubTween: gsap.core.Tween | null = null;

    const tickSmoothProgress = () => {
      animRafId = null;
      const target = targetProgressRef.current;
      const current = currentProgressRef.current;
      const delta = target - current;

      if (Math.abs(delta) <= 0.0012 || isStaticComplete) {
        applyThreadProgress(target);
        return;
      }

      applyThreadProgress(current + delta * 0.34);
      animRafId = window.requestAnimationFrame(tickSmoothProgress);
    };

    const pushTargetProgress = (nextTarget: number, immediate = false) => {
      const clamped = clamp01(nextTarget);
      targetProgressRef.current = clamped;

      if (immediate || isStaticComplete) {
        if (animRafId !== null) {
          window.cancelAnimationFrame(animRafId);
          animRafId = null;
        }
        applyThreadProgress(clamped);
        return;
      }

      if (animRafId === null) {
        animRafId = window.requestAnimationFrame(tickSmoothProgress);
      }
    };

    const syncFromViewport = (immediate = false) => {
      if (isStaticComplete) {
        pushTargetProgress(1, true);
        return;
      }
      const geoProgress = computeViewportProgress(body);
      pushTargetProgress(geoProgress, immediate);
    };

    geoSyncFnRef.current = () => syncFromViewport(false);

    const recomputePath = (shouldRefreshTrigger = false) => {
      const bodyRect = body.getBoundingClientRect();
      const width = Math.round(bodyRect.width);
      const height = Math.round(bodyRect.height);
      if (width <= 0 || height <= 0) return;

      setSvgSize((prev) =>
        prev.width === width && prev.height === height
          ? prev
          : { width, height },
      );

      // Update SVG attributes imperatively immediately so viewBox & length are synchronous
      svg.setAttribute('width', String(width));
      svg.setAttribute('height', String(height));
      svg.setAttribute('viewBox', `0 0 ${width} ${height}`);

      const mediaNodes = Array.from(
        body.querySelectorAll<HTMLElement>('.step__media'),
      );
      if (mediaNodes.length === 0) return;

      const isMobileRail = window.innerWidth <= 820;
      const anchors: Array<{ x: number; y: number }> = [];
      const rawStepPoints: Array<{ index: number; x: number; y: number }> = [];

      if (isMobileRail) {
        const railX = 18;
        anchors.push({ x: railX, y: 10 });
        mediaNodes.forEach((media, idx) => {
          const box = getRelativeLayoutBox(media, body);
          const midY = box.top + box.height * 0.5;
          const x = idx % 2 === 0 ? railX + 4 : railX - 2;
          anchors.push({ x, y: midY });
          rawStepPoints.push({ index: idx, x, y: midY });
        });
        anchors.push({ x: railX, y: Math.max(20, height - 10) });
      } else {
        anchors.push({ x: width * 0.5, y: 12 });
        mediaNodes.forEach((media, idx) => {
          const box = getRelativeLayoutBox(media, body);
          const isLeftColumn = idx % 2 === 0;
          const rawX = isLeftColumn
            ? box.left + box.width + 34
            : box.left - 34;
          const clampedX = Math.max(
            width * 0.36,
            Math.min(width * 0.64, rawX),
          );
          const midY = box.top + box.height * 0.5;
          anchors.push({ x: clampedX, y: midY });
          rawStepPoints.push({ index: idx, x: clampedX, y: midY });
        });
        anchors.push({ x: width * 0.5, y: Math.max(24, height - 12) });
      }

      let d = `M ${anchors[0]!.x.toFixed(1)} ${anchors[0]!.y.toFixed(1)}`;
      for (let i = 1; i < anchors.length; i += 1) {
        const prev = anchors[i - 1]!;
        const curr = anchors[i]!;
        const midY = (prev.y + curr.y) * 0.5;
        d += ` C ${prev.x.toFixed(1)} ${midY.toFixed(1)}, ${curr.x.toFixed(1)} ${midY.toFixed(1)}, ${curr.x.toFixed(1)} ${curr.y.toFixed(1)}`;
      }

      track.setAttribute('d', d);
      path.setAttribute('d', d);
      glow.setAttribute('d', d);

      const len = path.getTotalLength();
      totalLengthRef.current = len > 0 ? len : 1;
      const lenStr = totalLengthRef.current.toFixed(2);
      path.style.strokeDasharray = lenStr;
      glow.style.strokeDasharray = lenStr;
      svg.dataset.threadLength = lenStr;

      const computedWaypoints: WaypointMetric[] = rawStepPoints.map((pt) => ({
        ...pt,
        threshold: findArcThresholdForY(path, totalLengthRef.current, pt.y),
      }));
      waypointsRef.current = computedWaypoints;
      setWaypoints(computedWaypoints);

      syncFromViewport(true);

      if (shouldRefreshTrigger && scrollTriggerInstance) {
        scrollTriggerInstance.refresh();
      }
    };

    recomputePath(false);

    if (!isStaticComplete) {
      const proxy = { p: computeViewportProgress(body) };
      scrubTween = gsap.to(proxy, {
        p: 1,
        ease: 'none',
        paused: true,
      });

      scrollTriggerInstance = ScrollTrigger.create({
        trigger: body,
        start: 'top 72%',
        end: 'bottom 58%',
        scrub: 0.55,
        invalidateOnRefresh: true,
        refreshPriority: -2,
        animation: scrubTween,
        onUpdate: () => {
          // Cross-validate against live viewport geometry so upstream pin offsets never stall progress at 0
          const liveGeo = computeViewportProgress(body);
          const candidate =
            Math.abs(proxy.p - liveGeo) > 0.08 ? liveGeo : proxy.p;
          pushTargetProgress(candidate, false);
        },
        onRefresh: () => {
          syncFromViewport(true);
        },
      });
    } else {
      pushTargetProgress(1, true);
    }

    const scheduleRecompute = () => {
      if (resizeRafId !== null) return;
      resizeRafId = window.requestAnimationFrame(() => {
        resizeRafId = null;
        recomputePath(true);
      });
    };

    const handleScroll = () => {
      syncFromViewport(false);
    };

    const handleScrollTriggerRefresh = () => {
      syncFromViewport(true);
    };

    const resizeObserver =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(() => {
            scheduleRecompute();
          })
        : null;
    resizeObserver?.observe(body);

    const mediaImages = Array.from(
      body.querySelectorAll<HTMLImageElement>('.step__media img'),
    );
    const onMediaLoad = () => scheduleRecompute();
    mediaImages.forEach((img) => {
      if (!img.complete) {
        img.addEventListener('load', onMediaLoad, { once: true });
      }
    });

    let fontsDisposed = false;
    if (typeof document !== 'undefined' && document.fonts?.ready) {
      void document.fonts.ready.then(() => {
        if (!fontsDisposed) {
          scheduleRecompute();
        }
      });
    }

    window.addEventListener('scroll', handleScroll, { passive: true });
    window.addEventListener('resize', scheduleRecompute, { passive: true });
    ScrollTrigger.addEventListener('refresh', handleScrollTriggerRefresh);

    // Follow-up sync after upstream GSAP pins settle
    const settleTimer = window.setTimeout(() => {
      recomputePath(true);
    }, 260);

    return () => {
      fontsDisposed = true;
      geoSyncFnRef.current = null;
      window.clearTimeout(settleTimer);
      if (animRafId !== null) {
        window.cancelAnimationFrame(animRafId);
      }
      if (resizeRafId !== null) {
        window.cancelAnimationFrame(resizeRafId);
      }
      resizeObserver?.disconnect();
      mediaImages.forEach((img) => {
        img.removeEventListener('load', onMediaLoad);
      });
      window.removeEventListener('scroll', handleScroll);
      window.removeEventListener('resize', scheduleRecompute);
      ScrollTrigger.removeEventListener('refresh', handleScrollTriggerRefresh);
      scrollTriggerInstance?.kill();
      scrubTween?.kill();
    };
  }, [bodyRef, stepCount, isStaticComplete, applyThreadProgress]);

  return (
    <>
      <svg
        ref={svgRef}
        className="thread"
        id="thread"
        width={svgSize.width}
        height={svgSize.height}
        viewBox={`0 0 ${svgSize.width} ${svgSize.height}`}
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        {/* Subtle dashed champagne-gold tailoring guide stitch ahead of the pearl */}
        <path ref={trackRef} id="threadTrack" className="thread__track" />

        {/* Warm glowing golden aura behind the live drawn thread */}
        <path ref={glowRef} id="threadGlow" className="thread__glow" />

        {/* Crisp luminous solid golden thread */}
        <path ref={pathRef} id="threadPath" className="thread__path" />

        {/* SVG stitch waypoint halos for each craft step */}
        <g data-testid="thread-waypoints">
          {waypoints.map((wp) => {
            const isActive = wp.index === activeStepIndex;
            const isCompleted =
              isStaticComplete ||
              wp.index < reachedCount ||
              wp.index < activeStepIndex;
            const state = isActive
              ? 'active'
              : isCompleted
                ? 'completed'
                : 'upcoming';

            return (
              <g
                key={`svg-wp-${wp.index}`}
                className="thread__waypoint"
                data-thread-waypoint={wp.index}
                data-waypoint-state={state}
                transform={`translate(${wp.x.toFixed(1)}, ${wp.y.toFixed(1)})`}
              >
                <circle
                  className="thread__waypoint-halo"
                  r={isActive ? 21 : 16}
                  fill="none"
                  stroke="#EBCF8F"
                  strokeWidth={isActive ? 1.1 : 0.7}
                  opacity={isActive ? 0.55 : isCompleted ? 0.34 : 0.2}
                />
                <circle
                  className="thread__waypoint-dot"
                  r={isActive ? 5.5 : 4}
                  fill={isActive || isCompleted ? '#F2D898' : '#B08A4A'}
                  opacity={isActive ? 1 : isCompleted ? 0.85 : 0.45}
                />
              </g>
            );
          })}
        </g>
      </svg>

      {/* Interactive stitch waypoint medallions aligned 1:1 with curve waypoints */}
      {waypoints.length > 0 ? (
        <div className={styles.medallionLayer} aria-hidden={false}>
          {waypoints.map((wp) => {
            const meta = stepLabels?.[wp.index];
            const orderText =
              meta?.order ?? String(wp.index + 1).padStart(2, '0');
            const isActive = wp.index === activeStepIndex;
            const isCompleted =
              isStaticComplete ||
              wp.index < reachedCount ||
              wp.index < activeStepIndex;
            const state = isActive
              ? 'active'
              : isCompleted
                ? 'completed'
                : 'upcoming';

            return (
              <button
                key={`medallion-${wp.index}`}
                type="button"
                className={styles.waypointMedallion}
                data-waypoint-button={wp.index}
                data-waypoint-state={state}
                style={{
                  left: `${wp.x.toFixed(1)}px`,
                  top: `${wp.y.toFixed(1)}px`,
                }}
                onClick={() => onWaypointSelect?.(wp.index)}
                aria-label={
                  meta
                    ? `Đi tới bước ${orderText} (${meta.time}): ${meta.title}`
                    : `Đi tới bước ${orderText}`
                }
                aria-current={isActive ? 'step' : undefined}
              >
                <span className={styles.waypointPulse} aria-hidden="true" />
                <span>{orderText}</span>
              </button>
            );
          })}
        </div>
      ) : null}

      <div
        ref={pearlRef}
        className="thread__pearl"
        id="pearl"
        aria-hidden="true"
      />
    </>
  );
}
