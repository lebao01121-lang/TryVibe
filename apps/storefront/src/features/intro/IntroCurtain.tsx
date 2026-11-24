'use client';

import { useGSAP } from '@gsap/react';
import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { CampaignIntro } from '@atelier/contracts';
import {
  acquireScrollLock,
  setIntroActive,
  triggerParticleBurst,
  useMotionState,
} from '@atelier/motion-kit';
import { ensureGsapRegistered, gsap, ScrollTrigger } from '@/lib/gsap-setup';

const INTRO_SESSION_KEY = 'atelier_intro_seen';

export interface IntroCurtainProps {
  intro: CampaignIntro;
}

export function IntroCurtain({ intro }: IntroCurtainProps) {
  const pathname = usePathname();
  const [visible, setVisible] = useState(false);
  const curtainRef = useRef<HTMLDivElement | null>(null);
  const releaseLockRef = useRef<(() => void) | null>(null);
  const finishedRef = useRef(false);
  const { reducedMotion } = useMotionState();

  const finishIntro = useCallback(() => {
    if (finishedRef.current) return;
    finishedRef.current = true;
    try {
      window.sessionStorage.setItem(INTRO_SESSION_KEY, '1');
    } catch {
      // Ignore private browsing sessionStorage restrictions
    }
    releaseLockRef.current?.();
    releaseLockRef.current = null;
    setIntroActive(false);
    document.body.classList.remove('is-loading');
    setVisible(false);
    ScrollTrigger.refresh();
  }, []);

  useEffect(() => {
    if (pathname !== '/') {
      return;
    }
    try {
      if (window.sessionStorage.getItem(INTRO_SESSION_KEY) === '1') {
        return;
      }
      window.sessionStorage.setItem(INTRO_SESSION_KEY, '1');
    } catch {
      return;
    }

    finishedRef.current = false;
    setVisible(true);
    setIntroActive(true);
    document.body.classList.add('is-loading');
    releaseLockRef.current = acquireScrollLock();

    // 5500ms hard safety net ensuring scroll is NEVER permanently stuck
    const safetyTimer = window.setTimeout(() => {
      finishIntro();
    }, 5500);

    return () => {
      window.clearTimeout(safetyTimer);
      releaseLockRef.current?.();
      releaseLockRef.current = null;
      setIntroActive(false);
      document.body.classList.remove('is-loading');
    };
  }, [pathname, finishIntro]);

  useGSAP(
    () => {
      if (!visible || !curtainRef.current) return;
      ensureGsapRegistered();

      const el = curtainRef.current;
      const maskState = { r: 0 };
      const maxRadius =
        Math.hypot(window.innerWidth, window.innerHeight) * 0.62;

      const tl = gsap.timeline({
        onComplete: finishIntro,
      });

      if (reducedMotion) {
        tl.to(el, { opacity: 0, duration: 0.25, ease: 'power2.out' });
        return;
      }

      tl.to('.intro__ring circle', {
        strokeDashoffset: 0,
        duration: 0.65,
        ease: 'power2.inOut',
      })
        .to(
          '.intro__mono span, .intro__mono i',
          {
            opacity: 1,
            y: 0,
            filter: 'blur(0px)',
            duration: 0.45,
            stagger: 0.06,
            ease: 'power3.out',
          },
          '-=0.35',
        )
        .to('.intro__line', { opacity: 1, duration: 0.35 }, '-=0.25')
        .to(
          '.intro__mono, .intro__line',
          { opacity: 0, scale: 0.92, duration: 0.28, ease: 'power2.in' },
          '+=0.15',
        )
        .add(() => {
          triggerParticleBurst(
            window.innerWidth / 2,
            window.innerHeight / 2,
            46,
          );
        })
        .to(
          maskState,
          {
            r: maxRadius,
            duration: 0.68,
            ease: 'expo.inOut',
            onUpdate: () => {
              const mask = `radial-gradient(circle at 50% 50%, transparent ${maskState.r}px, #000 ${maskState.r + 1.5}px)`;
              el.style.maskImage = mask;
              el.style.webkitMaskImage = mask;
            },
          },
          '-=0.05',
        )
        .to(
          '.intro__ring',
          { scale: 5, opacity: 0, duration: 0.68, ease: 'expo.inOut' },
          '<',
        );
    },
    { scope: curtainRef, dependencies: [visible, reducedMotion, finishIntro] },
  );

  if (!visible || pathname !== '/') {
    return null;
  }

  return (
    <div
      ref={curtainRef}
      className="intro"
      id="intro"
      role="presentation"
    >
      <svg className="intro__ring" viewBox="0 0 200 200" aria-hidden="true">
        <circle cx="100" cy="100" r="92" />
      </svg>
      <div className="intro__mono">
        <span>{intro.monogramLeft}</span>
        <i>{intro.monogramAmp}</i>
        <span>{intro.monogramRight}</span>
      </div>
      <p className="intro__line">{intro.tagline}</p>

      <button
        type="button"
        onClick={finishIntro}
        className="intro__skip"
      >
        Bỏ qua
      </button>
    </div>
  );
}
