'use client';

import { useLenis } from 'lenis/react';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from 'react';
import type { AtelierStep } from '@atelier/contracts';
import { useMotionState } from '@atelier/motion-kit';
import { ensureGsapRegistered, gsap } from '@/lib/gsap-setup';
import { GoldenThreadSvg, type ThreadStepLabel } from './GoldenThreadSvg';
import styles from './atelier-story.module.css';

export interface AtelierCraftJourneyProps {
  steps: AtelierStep[];
}

function parseMinutes(timeStr: string): number {
  const match = timeStr.match(/(\d{1,2})\s*:\s*(\d{2})/);
  if (!match) return 0;
  return Number(match[1]) * 60 + Number(match[2]);
}

function formatMinutes(totalMinutes: number): string {
  const clamped = Math.max(0, Math.round(totalMinutes));
  const h = Math.floor(clamped / 60);
  const m = clamped % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export function AtelierCraftJourney({ steps }: AtelierCraftJourneyProps) {
  const sectionRef = useRef<HTMLElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const paginationBarRef = useRef<HTMLDivElement | null>(null);
  const progressFillRef = useRef<HTMLDivElement | null>(null);
  const stepRefs = useRef<Array<HTMLLIElement | null>>([]);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const activeStepRef = useRef<number>(0);
  const scrollLockTargetRef = useRef<{ index: number; until: number } | null>(
    null,
  );
  const activeEvalRef = useRef<(() => void) | null>(null);

  const [activeStepIndex, setActiveStepIndex] = useState<number>(0);

  const lenis = useLenis(() => {
    activeEvalRef.current?.();
  });
  const { reducedMotion, cameraActive } = useMotionState();
  const isStaticMode = reducedMotion || cameraActive;

  const stepLabels = useMemo<ThreadStepLabel[]>(
    () =>
      steps.map((step, idx) => ({
        order: String(idx + 1).padStart(2, '0'),
        time: step.timeTarget,
        title: step.title,
      })),
    [steps],
  );

  // Sync GPU golden progress fill inside the pagination bar without React re-renders
  const handleThreadProgressChange = useCallback((progress: number) => {
    const fill = progressFillRef.current;
    if (!fill) return;
    const clamped = Math.max(0, Math.min(1, progress));
    fill.style.transform = `scaleX(${clamped.toFixed(4)})`;
  }, []);

  // Deterministic active-step scroll tracker (nearest step center to 46% viewport)
  useEffect(() => {
    if (steps.length === 0) return;
    let rafId: number | null = null;

    const evaluateActiveStep = () => {
      const lock = scrollLockTargetRef.current;
      if (lock && performance.now() < lock.until) {
        return;
      }
      if (lock) {
        scrollLockTargetRef.current = null;
      }

      const vh = window.innerHeight || 1;
      const probeY = vh * 0.46;

      let bestIdx = 0;
      let bestDist = Number.POSITIVE_INFINITY;

      for (let i = 0; i < steps.length; i += 1) {
        const el = stepRefs.current[i];
        if (!el) continue;
        const rect = el.getBoundingClientRect();
        if (rect.height <= 0) continue;
        const centerY = rect.top + rect.height * 0.5;
        const dist = Math.abs(centerY - probeY);
        if (dist < bestDist) {
          bestDist = dist;
          bestIdx = i;
        }
      }

      if (bestIdx !== activeStepRef.current) {
        activeStepRef.current = bestIdx;
        setActiveStepIndex(bestIdx);
      }
    };

    const scheduleEvaluate = () => {
      if (rafId !== null) return;
      rafId = window.requestAnimationFrame(() => {
        rafId = null;
        evaluateActiveStep();
      });
    };

    activeEvalRef.current = scheduleEvaluate;
    evaluateActiveStep();

    window.addEventListener('scroll', scheduleEvaluate, { passive: true });
    window.addEventListener('resize', scheduleEvaluate, { passive: true });

    return () => {
      activeEvalRef.current = null;
      if (rafId !== null) {
        window.cancelAnimationFrame(rafId);
      }
      window.removeEventListener('scroll', scheduleEvaluate);
      window.removeEventListener('resize', scheduleEvaluate);
    };
  }, [steps.length]);

  // Viewport-gated `.step__time` counter roll-up (fires ONLY when step enters viewport)
  useEffect(() => {
    ensureGsapRegistered();
    const body = bodyRef.current;
    if (!body || isStaticMode || steps.length === 0) return;

    const activeTweens: gsap.core.Tween[] = [];
    const triggered = new WeakSet<Element>();

    const animateTimeForStep = (stepEl: Element) => {
      const timeNode = stepEl.querySelector<HTMLElement>('.step__time');
      if (!timeNode) return;
      const targetText =
        timeNode.dataset.time || timeNode.textContent || '08:00';
      const targetMinutes = parseMinutes(targetText);
      if (targetMinutes <= 0) return;

      const startMinutes = Math.max(0, targetMinutes - 90);
      const counter = { val: startMinutes };
      const tween = gsap.to(counter, {
        val: targetMinutes,
        duration: 0.95,
        ease: 'power2.out',
        onUpdate: () => {
          timeNode.textContent = formatMinutes(counter.val);
        },
        onComplete: () => {
          timeNode.textContent = targetText;
        },
      });
      activeTweens.push(tween);
    };

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting && !triggered.has(entry.target)) {
            triggered.add(entry.target);
            observer.unobserve(entry.target);
            animateTimeForStep(entry.target);
          }
        });
      },
      {
        rootMargin: '-8% 0px -12% 0px',
        threshold: 0.25,
      },
    );

    stepRefs.current.forEach((el) => {
      if (el) observer.observe(el);
    });

    return () => {
      observer.disconnect();
      activeTweens.forEach((tween) => tween.kill());
    };
  }, [steps, isStaticMode]);

  // Smoothly scroll to any craft step cleanly below fixed SiteHeader + sticky pagination bar
  const scrollToStep = useCallback(
    (index: number) => {
      if (steps.length === 0) return;
      const clampedIdx = Math.max(0, Math.min(steps.length - 1, index));
      const targetEl = stepRefs.current[clampedIdx];
      if (!targetEl) return;

      activeStepRef.current = clampedIdx;
      setActiveStepIndex(clampedIdx);

      const prefersReduced =
        isStaticMode ||
        (typeof window !== 'undefined' &&
          window.matchMedia('(prefers-reduced-motion: reduce)').matches);

      // Hold the selected active step cleanly while Lenis glides into position
      scrollLockTargetRef.current = {
        index: clampedIdx,
        until: performance.now() + (prefersReduced ? 120 : 950),
      };

      const barHeight =
        paginationBarRef.current?.getBoundingClientRect().height ?? 68;
      const headerClearance = window.innerWidth <= 820 ? 76 : 84;
      const topOffset = Math.round(
        Math.min(220, Math.max(152, headerClearance + barHeight + 28)),
      );

      if (lenis && !lenis.isStopped) {
        lenis.resize();
        if (prefersReduced) {
          lenis.scrollTo(targetEl, { offset: -topOffset, immediate: true });
        } else {
          lenis.scrollTo(targetEl, { offset: -topOffset, duration: 0.9 });
        }
      } else {
        const targetTop = Math.max(
          0,
          targetEl.getBoundingClientRect().top + window.scrollY - topOffset,
        );
        window.scrollTo({
          top: targetTop,
          behavior: prefersReduced ? 'auto' : 'smooth',
        });
      }
    },
    [steps.length, isStaticMode, lenis],
  );

  const handleTabKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
      if (steps.length <= 1) return;
      let nextIndex: number | null = null;

      if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
        nextIndex = (index + 1) % steps.length;
      } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
        nextIndex = (index - 1 + steps.length) % steps.length;
      } else if (event.key === 'Home') {
        nextIndex = 0;
      } else if (event.key === 'End') {
        nextIndex = steps.length - 1;
      }

      if (nextIndex !== null) {
        event.preventDefault();
        tabRefs.current[nextIndex]?.focus();
        scrollToStep(nextIndex);
      }
    },
    [steps.length, scrollToStep],
  );

  const totalStepsFormatted = String(steps.length).padStart(2, '0');
  const activeStepFormatted = String(
    Math.min(steps.length, activeStepIndex + 1),
  ).padStart(2, '0');

  return (
    <section
      ref={sectionRef}
      className="atelier"
      id="atelier"
      data-nav-theme="dark"
    >
      <div className="atelier__head">
        <p className="eyebrow">Xưởng may đo · Sợi chỉ vàng</p>
        <h2 className="h2">
          Một thiết kế
          <br />
          <em>ra đời thế nào.</em>
        </h2>
      </div>

      {steps.length > 0 ? (
        <nav
          className={styles.paginationDock}
          aria-label="Phân đoạn quy trình xưởng may"
          data-testid="atelier-pagination"
        >
          <div ref={paginationBarRef} className={styles.paginationBar}>
            <div
              className={styles.counterBlock}
              data-testid="atelier-step-counter"
            >
              <span className={styles.counterEyebrow}>Công đoạn</span>
              <span className={styles.counterValue}>
                {activeStepFormatted}
                <span className={styles.counterDivider}>/</span>
                <span className={styles.counterTotal}>
                  {totalStepsFormatted}
                </span>
              </span>
            </div>

            <div
              className={styles.stepTabs}
              style={{ '--step-count': steps.length } as CSSProperties}
            >
              {steps.map((step, index) => {
                const isActive = index === activeStepIndex;
                const isCompleted = index < activeStepIndex;
                const state = isActive
                  ? 'active'
                  : isCompleted
                    ? 'completed'
                    : 'upcoming';
                const orderNum = String(index + 1).padStart(2, '0');

                return (
                  <button
                    key={`page-tab-${step.stepOrder}-${step.title}`}
                    ref={(node) => {
                      tabRefs.current[index] = node;
                    }}
                    type="button"
                    className={styles.stepTab}
                    data-testid={`atelier-page-btn-${index + 1}`}
                    data-step-index={index}
                    data-step-state={state}
                    aria-current={isActive ? 'step' : undefined}
                    onClick={() => scrollToStep(index)}
                    onKeyDown={(event) => handleTabKeyDown(event, index)}
                  >
                    <span className={styles.stepTabMeta}>
                      <span className={styles.stepTabIndex}>{orderNum}</span>
                      <span className={styles.stepTabTime}>
                        {step.timeTarget}
                      </span>
                    </span>
                    <span className={styles.stepTabTitle}>{step.title}</span>
                  </button>
                );
              })}
            </div>

            <div className={styles.navControls}>
              <button
                type="button"
                className={styles.navBtn}
                data-testid="atelier-page-prev"
                aria-label="Bước trước"
                disabled={activeStepIndex <= 0}
                onClick={() => scrollToStep(activeStepIndex - 1)}
              >
                <span aria-hidden="true">←</span>
                <span>Trước</span>
              </button>
              <button
                type="button"
                className={styles.navBtn}
                data-testid="atelier-page-next"
                aria-label="Bước tiếp theo"
                disabled={activeStepIndex >= steps.length - 1}
                onClick={() => scrollToStep(activeStepIndex + 1)}
              >
                <span>Tiếp</span>
                <span aria-hidden="true">→</span>
              </button>
            </div>

            <div className={styles.progressTrack} aria-hidden="true">
              <div
                ref={progressFillRef}
                className={styles.progressFill}
                data-testid="atelier-pagination-progress"
              />
            </div>
          </div>
        </nav>
      ) : null}

      <div ref={bodyRef} className="atelier__body">
        <GoldenThreadSvg
          bodyRef={bodyRef}
          stepCount={steps.length}
          activeStepIndex={activeStepIndex}
          stepLabels={stepLabels}
          onWaypointSelect={scrollToStep}
          onProgressChange={handleThreadProgressChange}
        />

        <ol className="steps">
          {steps.map((step, index) => {
            const isActive = index === activeStepIndex;
            const isCompleted = index < activeStepIndex;
            const state = isActive
              ? 'active'
              : isCompleted
                ? 'completed'
                : 'upcoming';
            const orderNum = String(index + 1).padStart(2, '0');

            return (
              <li
                key={`${step.stepOrder}-${step.title}`}
                id={`atelier-step-${index + 1}`}
                ref={(node) => {
                  stepRefs.current[index] = node;
                }}
                className="step"
                data-step-index={index}
                data-step-state={state}
                aria-current={isActive ? 'step' : undefined}
              >
                <div className="step__media aspect-[4/5]">
                  <img
                    src={step.imageUrl}
                    alt={step.imageAlt}
                    width={400}
                    height={500}
                    loading="lazy"
                    decoding="async"
                  />
                </div>
                <div className="step__txt">
                  <div className={styles.stepChapterRow}>
                    <span className={styles.stepChapterBadge}>
                      <span
                        className={styles.stepChapterDot}
                        aria-hidden="true"
                      />
                      Công đoạn {orderNum} / {totalStepsFormatted}
                    </span>
                  </div>
                  <span className="step__time" data-time={step.timeTarget}>
                    {step.timeTarget}
                  </span>
                  <h3>{step.title}</h3>
                  <p>{step.description}</p>
                </div>
              </li>
            );
          })}
        </ol>
      </div>
    </section>
  );
}
