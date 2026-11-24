'use client';

import { useGSAP } from '@gsap/react';
import { useEffect, useRef, useState } from 'react';
import type { CampaignHero } from '@atelier/contracts';
import { useMotionState } from '@atelier/motion-kit';
import { MagneticButton } from '@/components/motion/MagneticButton';
import { SplitShimmerText } from '@/components/motion/SplitShimmerText';
import { ensureGsapRegistered, gsap } from '@/lib/gsap-setup';

export interface HeroEditorialProps {
  hero: CampaignHero;
  tagline?: string;
}

const DEFAULT_HERO_POSTER = '/media/atelier-hero-poster.webp';

function normalizeMediaUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const trimmed = url.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function HeroEditorial({ hero }: HeroEditorialProps) {
  const sectionRef = useRef<HTMLElement | null>(null);
  const [videoReady, setVideoReady] = useState(false);
  const [videoFailed, setVideoFailed] = useState(false);
  const { cameraActive, reducedMotion } = useMotionState();

  const videoWebmSrc = normalizeMediaUrl(hero.videoWebmUrl);
  const videoMp4Src = normalizeMediaUrl(hero.videoMp4Url);
  const hasFashionVideo = Boolean(videoWebmSrc || videoMp4Src);

  // Defer optional ambient video hydration until browser idle post-LCP
  useEffect(() => {
    if (!hasFashionVideo || typeof window === 'undefined') return undefined;
    const win = window as Window & {
      requestIdleCallback?: (
        callback: () => void,
        options?: { timeout: number },
      ) => number;
      cancelIdleCallback?: (id: number) => void;
    };

    if (typeof win.requestIdleCallback === 'function') {
      const idleId = win.requestIdleCallback(() => setVideoReady(true), {
        timeout: 400,
      });
      return () => {
        win.cancelIdleCallback?.(idleId);
      };
    }

    const timerId = window.setTimeout(() => setVideoReady(true), 180);
    return () => {
      window.clearTimeout(timerId);
    };
  }, [hasFashionVideo]);

  useGSAP(
    () => {
      ensureGsapRegistered();
      if (reducedMotion || cameraActive) return;

      const tl = gsap.timeline({
        scrollTrigger: {
          trigger: sectionRef.current,
          start: 'top top',
          end: 'bottom top',
          scrub: true,
        },
      });

      tl.to('.hero__film', { scale: 1.18, yPercent: 8, ease: 'none' }, 0)
        .to(
          '.hero__lead, .hero__actions',
          { yPercent: -24, opacity: 0, ease: 'none' },
          0,
        )
        .to(
          '.hero__title .ch',
          {
            yPercent: (index: number) => -36 - index * 10,
            opacity: 0,
            stagger: 0.02,
            ease: 'none',
          },
          0,
        );
    },
    { scope: sectionRef, dependencies: [reducedMotion, cameraActive] },
  );

  const posterSrc = normalizeMediaUrl(hero.posterUrl) ?? DEFAULT_HERO_POSTER;
  const safeTitle = hero.title.normalize('NFC');
  const safeEyebrow = hero.eyebrow.normalize('NFC');

  const shouldShowVideo =
    hasFashionVideo &&
    videoReady &&
    !videoFailed &&
    !reducedMotion &&
    !cameraActive;

  return (
    <section
      ref={sectionRef}
      className="hero"
      id="top"
      data-nav-theme="dark"
    >
      <div className="hero__window">
        <div className="hero__film">
          <img
            src={posterSrc}
            alt={`${safeTitle} — ${safeEyebrow}`}
            width={1920}
            height={1080}
            fetchPriority="high"
            decoding="async"
            className="hero__kenburns h-full w-full object-cover object-[68%_32%]"
          />
        </div>

        {shouldShowVideo ? (
          <video
            className="hero__film"
            id="heroFilm"
            autoPlay
            muted
            playsInline
            loop
            preload="none"
            poster={posterSrc}
            onError={() => setVideoFailed(true)}
          >
            {videoWebmSrc ? (
              <source src={videoWebmSrc} type="video/webm" />
            ) : null}
            {videoMp4Src ? (
              <source src={videoMp4Src} type="video/mp4" />
            ) : null}
          </video>
        ) : null}

        <div className="hero__veil" />
      </div>

      <div className="hero__copy">
        <p className="eyebrow">{safeEyebrow}</p>

        <SplitShimmerText
          text={safeTitle}
          as="h1"
          className="hero__title shimmer"
        />

        <p className="hero__lead">{hero.lead}</p>

        <div className="hero__actions">
          <MagneticButton
            href="#rack"
            className="btn btn--gold"
            cursorLabel="Khám phá"
          >
            {hero.primaryCtaLabel}
          </MagneticButton>
          <span className="hero__note">{hero.serviceNote}</span>
        </div>
      </div>

      <div className="hero__scroll" aria-hidden="true">
        <span />
        Cuộn xuống
      </div>
    </section>
  );
}
