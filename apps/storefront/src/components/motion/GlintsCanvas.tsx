'use client';

import { usePathname } from 'next/navigation';
import { useEffect, useRef } from 'react';
import { useMotionState } from '@atelier/motion-kit';

interface GlintSpark {
  x: number;
  y: number;
  t: number;
  d: number;
  s: number;
  angle0: number;
  spin: number;
}

export function GlintsCanvas() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const pathname = usePathname();
  const { cameraActive, reducedMotion } = useMotionState();

  const isDisabledRoute =
    pathname.startsWith('/thanh-toan') || pathname.startsWith('/tai-khoan');

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const isCoarsePointer =
      typeof window !== 'undefined' &&
      window.matchMedia('(pointer: coarse)').matches;

    if (cameraActive || reducedMotion || isDisabledRoute || isCoarsePointer) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      canvas.dataset.paused = 'true';
      return;
    }

    canvas.dataset.paused = 'false';

    let width = window.innerWidth;
    let height = window.innerHeight;
    let dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    let rafId = 0;
    let lastTime = performance.now();
    let spawnAccumulator = 0;
    const sparks: GlintSpark[] = [];

    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      width = window.innerWidth;
      height = window.innerHeight;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
    };
    resize();

    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(document.documentElement);

    const collectVisibleTargets = (): DOMRect[] => {
      const nodes = Array.from(
        document.querySelectorAll<HTMLElement>('[data-glint]'),
      );
      const rects: DOMRect[] = [];
      for (const node of nodes) {
        const rect = node.getBoundingClientRect();
        if (
          rect.bottom > 0 &&
          rect.top < height &&
          rect.width > 0 &&
          rect.height > 0
        ) {
          rects.push(rect);
        }
      }
      return rects;
    };

    const drawFrame = (now: number) => {
      if (
        document.hidden ||
        document.body.dataset.cameraActive === 'true'
      ) {
        rafId = 0;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        canvas.dataset.paused = 'true';
        return;
      }

      const dt = Math.min((now - lastTime) / 1000, 0.05);
      lastTime = now;
      spawnAccumulator += dt;

      if (spawnAccumulator > 0.28) {
        spawnAccumulator = 0;
        const targets = collectVisibleTargets();
        if (targets.length > 0 && sparks.length < 14) {
          const picked = targets[Math.floor(Math.random() * targets.length)]!;
          sparks.push({
            x: picked.left + (0.12 + Math.random() * 0.76) * picked.width,
            y: picked.top + (0.14 + Math.random() * 0.68) * picked.height,
            t: 0,
            d: 0.9 + Math.random() * 0.65,
            s: 2.2 + Math.random() * 3.4,
            angle0: Math.random() * Math.PI * 0.5,
            spin: (Math.random() > 0.5 ? 1 : -1) * (0.6 + Math.random() * 0.5),
          });
        }
      }

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);

      for (let i = sparks.length - 1; i >= 0; i -= 1) {
        const spark = sparks[i]!;
        spark.t += dt;
        const progress = spark.t / spark.d;
        if (progress >= 1) {
          sparks.splice(i, 1);
          continue;
        }

        const pulse = Math.pow(Math.sin(progress * Math.PI), 1.35);
        const radius = spark.s * pulse;
        if (radius < 0.25) continue;

        ctx.save();
        ctx.translate(spark.x, spark.y);
        ctx.rotate(spark.angle0 + progress * spark.spin);

        // Soft warm champagne core bloom
        const haloR = radius * 1.65;
        const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, haloR);
        grad.addColorStop(0, `rgba(255, 250, 232, ${0.78 * pulse})`);
        grad.addColorStop(0.35, `rgba(235, 207, 143, ${0.34 * pulse})`);
        grad.addColorStop(1, 'rgba(235, 207, 143, 0)');
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(0, 0, haloR, 0, Math.PI * 2);
        ctx.fill();

        // Delicate tapered 4-point couture star glint (never a crude static '+')
        const arm = radius * 2.05;
        const waist = Math.max(0.35, radius * 0.2);
        ctx.beginPath();
        ctx.moveTo(0, -arm);
        ctx.quadraticCurveTo(waist * 0.35, -waist * 0.35, arm, 0);
        ctx.quadraticCurveTo(waist * 0.35, waist * 0.35, 0, arm);
        ctx.quadraticCurveTo(-waist * 0.35, waist * 0.35, -arm, 0);
        ctx.quadraticCurveTo(-waist * 0.35, -waist * 0.35, 0, -arm);
        ctx.closePath();
        ctx.fillStyle = `rgba(255, 248, 226, ${0.75 * pulse})`;
        ctx.fill();

        ctx.restore();
      }

      rafId = window.requestAnimationFrame(drawFrame);
    };

    const startLoop = () => {
      if (!rafId && !document.hidden) {
        lastTime = performance.now();
        canvas.dataset.paused = 'false';
        rafId = window.requestAnimationFrame(drawFrame);
      }
    };

    const onVisibility = () => {
      if (document.hidden) {
        if (rafId) {
          window.cancelAnimationFrame(rafId);
          rafId = 0;
        }
        canvas.dataset.paused = 'true';
      } else {
        startLoop();
      }
    };

    document.addEventListener('visibilitychange', onVisibility);
    startLoop();

    return () => {
      if (rafId) window.cancelAnimationFrame(rafId);
      resizeObserver.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    };
  }, [cameraActive, reducedMotion, isDisabledRoute]);

  return (
    <canvas
      ref={canvasRef}
      className="glints"
      id="glints"
      aria-hidden="true"
    />
  );
}
