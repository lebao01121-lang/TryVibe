'use client';

import { usePathname } from 'next/navigation';
import { useEffect, useRef } from 'react';
import { useLenis } from 'lenis/react';
import { setAutoTourActive, useMotionState } from '@atelier/motion-kit';

const TOUR_STOPS = ['#rack', '#occasion', '#build', '#seasons', '#atelier', '#contact'] as const;

export function LookbookAutoTour() {
  const pathname = usePathname();
  const lenis = useLenis();
  const { autoTourActive, cameraActive, reducedMotion, introActive } =
    useMotionState();
  const timersRef = useRef<number[]>([]);

  const stopTour = () => {
    timersRef.current.forEach((id) => window.clearTimeout(id));
    timersRef.current = [];
    setAutoTourActive(false);
  };

  useEffect(() => {
    if (!autoTourActive) return;

    if (cameraActive || reducedMotion || pathname !== '/') {
      stopTour();
      return;
    }

    const cancelOnInput = () => {
      stopTour();
    };
    const cancelOnKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        stopTour();
      }
    };

    window.addEventListener('wheel', cancelOnInput, { passive: true });
    window.addEventListener('touchstart', cancelOnInput, { passive: true });
    window.addEventListener('keydown', cancelOnKey);

    TOUR_STOPS.forEach((selector, index) => {
      const timerId = window.setTimeout(() => {
        const el = document.querySelector<HTMLElement>(selector);
        if (!el) return;
        if (lenis) {
          lenis.scrollTo(el, { duration: 2.2 });
        } else {
          el.scrollIntoView({ behavior: 'smooth' });
        }
      }, index * 3200);
      timersRef.current.push(timerId);
    });

    const endTimer = window.setTimeout(() => {
      stopTour();
    }, TOUR_STOPS.length * 3200 + 1800);
    timersRef.current.push(endTimer);

    return () => {
      timersRef.current.forEach((id) => window.clearTimeout(id));
      timersRef.current = [];
      window.removeEventListener('wheel', cancelOnInput);
      window.removeEventListener('touchstart', cancelOnInput);
      window.removeEventListener('keydown', cancelOnKey);
    };
  }, [autoTourActive, cameraActive, reducedMotion, pathname, lenis]);

  if (pathname !== '/') {
    return null;
  }

  return (
    <>
      <div className="letterbox" aria-hidden="true">
        <i />
        <i />
      </div>

      {!reducedMotion && !cameraActive && !introActive ? (
        <button
          type="button"
          id="autoplay"
          className="autoplay"
          onClick={() => {
            if (autoTourActive) {
              stopTour();
            } else {
              setAutoTourActive(true);
            }
          }}
        >
          <span className="autoplay__dot" />
          <span className="autoplay__txt">
            {autoTourActive ? 'Dừng Tour' : 'Lookbook Tour'}
          </span>
        </button>
      ) : null}
    </>
  );
}
