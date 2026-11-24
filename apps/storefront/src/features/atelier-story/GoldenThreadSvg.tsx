'use client';

import { useGSAP } from '@gsap/react';
import { useEffect, useRef, type RefObject } from 'react';
import { useMotionState } from '@atelier/motion-kit';
import { ensureGsapRegistered, ScrollTrigger } from '@/lib/gsap-setup';

export interface GoldenThreadSvgProps {
  bodyRef: RefObject<HTMLDivElement | null>;
  stepCount: number;
}

export function GoldenThreadSvg({ bodyRef, stepCount }: GoldenThreadSvgProps) {
  const pathRef = useRef<SVGPathElement | null>(null);
  const glowRef = useRef<SVGPathElement | null>(null);
  const pearlRef = useRef<HTMLDivElement | null>(null);
  const totalLengthRef = useRef<number>(1);
  const progressRef = useRef<number>(0);
  const { reducedMotion, cameraActive } = useMotionState();

  const applyThreadProgress = (progress: number) => {
    const path = pathRef.current;
    const glow = glowRef.current;
    const pearl = pearlRef.current;
    const len = totalLengthRef.current;
    if (!path || !glow || len <= 0) return;

    const clamped = Math.max(0, Math.min(1, progress));
    const offset = len * (1 - clamped);
    path.style.strokeDashoffset = `${offset}`;
    glow.style.strokeDashoffset = `${offset}`;

    if (pearl) {
      const point = path.getPointAtLength(clamped * len);
      pearl.style.transform = `translate3d(${point.x}px, ${point.y}px, 0)`;
    }
  };

  useEffect(() => {
    const body = bodyRef.current;
    const path = pathRef.current;
    const glow = glowRef.current;
    if (!body || !path || !glow) return;

    const recomputePath = () => {
      const bodyRect = body.getBoundingClientRect();
      const width = bodyRect.width;
      const height = bodyRect.height;
      if (width <= 0 || height <= 0) return;

      const mediaNodes = Array.from(
        body.querySelectorAll<HTMLElement>('.step__media'),
      );
      if (mediaNodes.length === 0) return;

      const waypoints: Array<{ x: number; y: number }> = [
        { x: width * 0.5, y: -24 },
      ];

      mediaNodes.forEach((media, idx) => {
        const rect = media.getBoundingClientRect();
        const isLeftColumn = idx % 2 === 0;
        const innerEdgeX = isLeftColumn
          ? rect.right - bodyRect.left + 20
          : rect.left - bodyRect.left - 20;
        const midY = rect.top - bodyRect.top + media.offsetHeight * 0.5;
        waypoints.push({ x: innerEdgeX, y: midY });
      });

      waypoints.push({ x: width * 0.5, y: height + 24 });

      let d = `M ${waypoints[0]!.x.toFixed(1)} ${waypoints[0]!.y.toFixed(1)}`;
      for (let i = 1; i < waypoints.length; i += 1) {
        const prev = waypoints[i - 1]!;
        const curr = waypoints[i]!;
        const midY = (prev.y + curr.y) / 2;
        d += ` C ${prev.x.toFixed(1)} ${midY.toFixed(1)}, ${curr.x.toFixed(1)} ${midY.toFixed(1)}, ${curr.x.toFixed(1)} ${curr.y.toFixed(1)}`;
      }

      path.setAttribute('d', d);
      glow.setAttribute('d', d);

      const len = path.getTotalLength();
      totalLengthRef.current = len > 0 ? len : 1;
      path.style.strokeDasharray = `${totalLengthRef.current}`;
      glow.style.strokeDasharray = `${totalLengthRef.current}`;

      applyThreadProgress(reducedMotion ? 1 : progressRef.current);
      ScrollTrigger.refresh();
    };

    recomputePath();

    const resizeObserver = new ResizeObserver(() => {
      recomputePath();
    });
    resizeObserver.observe(body);

    return () => {
      resizeObserver.disconnect();
    };
  }, [bodyRef, stepCount, reducedMotion]);

  useGSAP(
    () => {
      ensureGsapRegistered();
      const body = bodyRef.current;
      if (!body) return;

      if (reducedMotion || cameraActive) {
        progressRef.current = 1;
        applyThreadProgress(1);
        return;
      }

      ScrollTrigger.create({
        trigger: body,
        start: 'top 72%',
        end: 'bottom 68%',
        scrub: 0.6,
        onUpdate: (self: { progress: number }) => {
          progressRef.current = self.progress;
          applyThreadProgress(self.progress);
        },
      });
    },
    { scope: bodyRef, dependencies: [stepCount, reducedMotion, cameraActive] },
  );

  return (
    <>
      <svg
        className="thread"
        id="thread"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <path ref={pathRef} id="threadPath" />
        <path ref={glowRef} id="threadGlow" />
      </svg>
      <div
        ref={pearlRef}
        className="thread__pearl"
        id="pearl"
        aria-hidden="true"
      />
    </>
  );
}
