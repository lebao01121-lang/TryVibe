'use client';

import { usePathname } from 'next/navigation';
import { useEffect, useRef } from 'react';
import {
  subscribeParticleBurst,
  useMotionState,
} from '@atelier/motion-kit';

interface SilkParticle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  rotation: number;
  vr: number;
  size: number;
  life: number;
  maxLife: number;
  phase: number;
  hue: string;
}

const SILK_PALETTE = [
  'rgba(235, 207, 143, 0.9)',
  'rgba(255, 243, 214, 0.85)',
  'rgba(176, 138, 74, 0.8)',
  'rgba(235, 217, 180, 0.85)',
] as const;

export function FabricParticleCanvas() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const pathname = usePathname();
  const { cameraActive, reducedMotion, particleRainActive } = useMotionState();

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
    let rainInterval = 0;
    let lastTime = performance.now();
    const particles: SilkParticle[] = [];

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

    const addParticle = (
      x: number,
      y: number,
      vx: number,
      vy: number,
      scale = 1,
    ) => {
      if (particles.length > 160) return;
      particles.push({
        x,
        y,
        vx,
        vy,
        rotation: Math.random() * Math.PI * 2,
        vr: (Math.random() - 0.5) * 5,
        size: (6 + Math.random() * 11) * scale,
        life: 0,
        maxLife: 2.6 + Math.random() * 2.2,
        phase: Math.random() * Math.PI * 2,
        hue: SILK_PALETTE[Math.floor(Math.random() * SILK_PALETTE.length)]!,
      });
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

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);

      for (let i = particles.length - 1; i >= 0; i -= 1) {
        const p = particles[i]!;
        p.life += dt;
        p.vx *= Math.pow(0.28, dt);
        p.vy = p.vy * Math.pow(0.38, dt) + 110 * dt;
        p.x += (p.vx + Math.sin(p.life * 2.2 + p.phase) * 32) * dt;
        p.y += p.vy * dt;
        p.rotation += p.vr * dt;

        const alpha =
          Math.min(1, p.life * 4) * Math.max(0, 1 - p.life / p.maxLife);
        if (alpha <= 0 || p.y > height + 40) {
          particles.splice(i, 1);
          continue;
        }

        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rotation);
        ctx.scale(1, 0.55 + 0.45 * Math.sin(p.life * 3 + p.phase));

        // Champagne gold silk thread / petal flake
        ctx.fillStyle = p.hue;
        ctx.beginPath();
        ctx.ellipse(0, 0, p.size * 0.65, p.size * 0.28, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }

      if (particles.length > 0) {
        rafId = window.requestAnimationFrame(drawFrame);
      } else {
        rafId = 0;
      }
    };

    const ensureRunning = () => {
      if (!rafId && !document.hidden) {
        lastTime = performance.now();
        canvas.dataset.paused = 'false';
        rafId = window.requestAnimationFrame(drawFrame);
      }
    };

    const unsubscribeBurst = subscribeParticleBurst((burst) => {
      if (document.hidden || document.body.dataset.cameraActive === 'true') {
        return;
      }
      for (let i = 0; i < burst.count; i += 1) {
        const angle = Math.random() * Math.PI * 2;
        const speed = 160 + Math.random() * 420;
        addParticle(
          burst.x,
          burst.y,
          Math.cos(angle) * speed,
          Math.sin(angle) * speed - 140,
          1.05,
        );
      }
      ensureRunning();
    });

    if (particleRainActive) {
      rainInterval = window.setInterval(() => {
        if (document.hidden || document.body.dataset.cameraActive === 'true') {
          return;
        }
        addParticle(
          Math.random() * width,
          -18,
          (Math.random() - 0.35) * 36,
          42 + Math.random() * 52,
          0.8,
        );
        ensureRunning();
      }, 260);
    }

    const onVisibility = () => {
      if (document.hidden && rafId) {
        window.cancelAnimationFrame(rafId);
        rafId = 0;
        canvas.dataset.paused = 'true';
      } else if (!document.hidden && particles.length > 0) {
        ensureRunning();
      }
    };

    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      unsubscribeBurst();
      if (rainInterval) window.clearInterval(rainInterval);
      if (rafId) window.cancelAnimationFrame(rafId);
      resizeObserver.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    };
  }, [cameraActive, reducedMotion, particleRainActive, isDisabledRoute]);

  return (
    <canvas
      ref={canvasRef}
      className="petalfx"
      id="petalfx"
      aria-hidden="true"
    />
  );
}
