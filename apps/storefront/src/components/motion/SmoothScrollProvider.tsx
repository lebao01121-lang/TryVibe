'use client';

import { useGSAP } from '@gsap/react';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, type ReactNode } from 'react';
import { ReactLenis, useLenis, type LenisRef } from 'lenis/react';
import {
  resetScrollLocks,
  setAutoTourActive,
  setIntroActive,
  setParticleRainActive,
  useMotionState,
} from '@atelier/motion-kit';
import { ensureGsapRegistered, gsap, ScrollTrigger } from '@/lib/gsap-setup';

function LenisScrollSync() {
  const pathname = usePathname();
  const { introActive, scrollLockCount, reducedMotion } = useMotionState();

  const lenis = useLenis(() => {
    ScrollTrigger.update();
  });

  useEffect(() => {
    ensureGsapRegistered();
    if (!lenis) return;

    if (introActive || scrollLockCount > 0) {
      lenis.stop();
    } else {
      lenis.start();
      ScrollTrigger.refresh();
    }
  }, [lenis, introActive, scrollLockCount, reducedMotion]);

  useEffect(() => {
    ensureGsapRegistered();
    resetScrollLocks();
    setIntroActive(false);
    setAutoTourActive(false);
    setParticleRainActive(false);

    if (typeof document !== 'undefined' && document.body) {
      document.body.classList.remove('is-loading', 'is-auto');
    }

    lenis?.start();
    lenis?.scrollTo(0, { immediate: true });
    if (typeof window !== 'undefined') {
      window.scrollTo(0, 0);
    }

    const rafId = window.requestAnimationFrame(() => {
      ScrollTrigger.refresh();
    });

    return () => {
      window.cancelAnimationFrame(rafId);
    };
  }, [pathname, lenis]);

  return null;
}

export interface SmoothScrollProviderProps {
  children: ReactNode;
}

export function SmoothScrollProvider({ children }: SmoothScrollProviderProps) {
  const lenisRef = useRef<LenisRef | null>(null);
  const { reducedMotion } = useMotionState();

  useGSAP(() => {
    ensureGsapRegistered();
    ScrollTrigger.config({ ignoreMobileResize: true });

    const update = (time: number) => {
      lenisRef.current?.lenis?.raf(time * 1000);
    };

    gsap.ticker.add(update);
    gsap.ticker.lagSmoothing(0);

    return () => {
      gsap.ticker.remove(update);
    };
  }, []);

  return (
    <ReactLenis
      root
      ref={lenisRef}
      options={{
        autoRaf: false,
        duration: 1.15,
        wheelMultiplier: 0.9,
        smoothWheel: !reducedMotion,
      }}
    >
      <LenisScrollSync />
      {children}
    </ReactLenis>
  );
}
