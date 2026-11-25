'use client';

import Link from 'next/link';
import { useEffect, useRef } from 'react';
import type { CampaignFinale } from '@atelier/contracts';
import {
  setParticleRainActive,
  useMotionState,
} from '@atelier/motion-kit';
import { MagneticButton } from '@/components/motion/MagneticButton';
import {
  PerformanceTierToggle,
  useAdaptivePerformance,
} from '@/lib/performance/AdaptivePerformanceProvider';

export interface FinaleShowcaseProps {
  finale: CampaignFinale;
}

const TRUST_PILLARS = [
  {
    headline: '15 phút',
    label: 'Tự xóa cứng ảnh riêng tư',
  },
  {
    headline: '2 chế độ',
    label: 'Camera căn dáng & Tải ảnh tĩnh',
  },
  {
    headline: 'VietQR',
    label: 'Giữ tồn kho 15 phút tự động',
  },
] as const;

export function FinaleShowcase({ finale }: FinaleShowcaseProps) {
  const sectionRef = useRef<HTMLElement | null>(null);
  const wordRef = useRef<HTMLHeadingElement | null>(null);
  const { cameraActive, reducedMotion } = useMotionState();
  const { isLowPower } = useAdaptivePerformance();

  useEffect(() => {
    const section = sectionRef.current;
    const wordEl = wordRef.current;
    if (!section || !wordEl) return;

    if (cameraActive || reducedMotion || isLowPower) {
      setParticleRainActive(false);
      return;
    }

    let inView = false;
    let rafId = 0;
    let pendingX = 50;
    let pendingY = 50;

    const flushCoords = () => {
      rafId = 0;
      wordEl.style.setProperty('--mx', `${pendingX.toFixed(1)}%`);
      wordEl.style.setProperty('--my', `${pendingY.toFixed(1)}%`);
    };

    const onPointerMove = (event: PointerEvent) => {
      if (!inView || document.body.dataset.cameraActive === 'true') return;
      const rect = wordEl.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      pendingX = ((event.clientX - rect.left) / rect.width) * 100;
      pendingY = ((event.clientY - rect.top) / rect.height) * 100;
      if (!rafId) {
        rafId = window.requestAnimationFrame(flushCoords);
      }
    };

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        const nextInView = Boolean(entry?.isIntersecting);
        if (nextInView === inView) return;
        inView = nextInView;

        if (inView && document.body.dataset.cameraActive !== 'true') {
          setParticleRainActive(true);
          window.addEventListener('pointermove', onPointerMove, { passive: true });
        } else {
          setParticleRainActive(false);
          window.removeEventListener('pointermove', onPointerMove);
        }
      },
      { threshold: 0.15 },
    );

    observer.observe(section);

    return () => {
      observer.disconnect();
      window.removeEventListener('pointermove', onPointerMove);
      if (rafId) window.cancelAnimationFrame(rafId);
      setParticleRainActive(false);
    };
  }, [cameraActive, reducedMotion, isLowPower]);

  return (
    <section
      ref={sectionRef}
      className="finale"
      id="contact"
      data-nav-theme="dark"
    >
      <div className="mx-auto max-w-7xl">
        {/* Verified Fit Reviews (.voices) */}
        <div className="voices">
          <p className="eyebrow">Lời khách · Verified Fit Reviews</p>
          <ul className="voices__list">
            {finale.featuredVoices.map((voice) => (
              <li key={voice.author} className="voice">
                <blockquote>&ldquo;{voice.quote}&rdquo;</blockquote>
                <cite>{voice.author}</cite>
                <p className="mt-1.5 text-xs text-[#FBF7EF]/60">
                  {voice.fitMeta}
                </p>
              </li>
            ))}
          </ul>
        </div>

        {/* 3 Minimalist Trust Pillars */}
        <div className="mb-14 grid gap-4 border-y border-[#B08A4A]/20 py-8 sm:grid-cols-3">
          {TRUST_PILLARS.map((pillar) => (
            <div key={pillar.headline} className="flex items-baseline gap-3">
              <span className="font-editorial text-3xl text-[#EBCF8F]">
                {pillar.headline}
              </span>
              <span className="text-xs text-[#FBF7EF]/75">{pillar.label}</span>
            </div>
          ))}
        </div>

        {/* Finale CTA (.finale__inner) */}
        <div className="finale__inner">
          <div className="finale__intro">
            <p className="eyebrow">{finale.eyebrow}</p>
            <p className="finale__lead">
              {finale.leadMain}
              <br />
              <em>{finale.leadEmphasis}</em>
            </p>
          </div>

          <div className="finale__cta">
            <MagneticButton
              href="/bo-suu-tap"
              className="btn btn--gold"
              cursorLabel="Khám phá"
            >
              {finale.ctaLabel}
            </MagneticButton>
            <span className="finale__info">{finale.showroomInfo}</span>
          </div>
        </div>

        {/* Giant Illuminated Wordmark (#finaleWord, NFC normalized) */}
        <h2 ref={wordRef} className="finale__word" id="finaleWord">
          <span className="finale__base">{finale.wordmark.normalize('NFC')}</span>
          <span className="finale__lit" aria-hidden="true" data-glint="">
            {finale.wordmark.normalize('NFC')}
          </span>
        </h2>

        {/* Clean Customer Footer (.foot) */}
        <footer className="foot">
          <span>
            © 2026 {finale.wordmark.normalize('NFC')} Fashion Atelier · May đo thủ công tại Hà Nội
          </span>
          <div className="flex flex-wrap items-center gap-5">
            <Link href="/bo-suu-tap" className="hover:text-[#EBCF8F]">
              Bộ sưu tập
            </Link>
            <Link href="/phoi-do" className="hover:text-[#EBCF8F]">
              Phối đồ
            </Link>
            <Link href="/thu-do-ai" className="hover:text-[#EBCF8F]">
              Thử đồ AI
            </Link>
            <Link href="/tai-khoan" className="hover:text-[#EBCF8F]">
              Tài khoản
            </Link>
            <Link href="/thanh-toan" className="hover:text-[#EBCF8F]">
              Thanh toán
            </Link>
            <PerformanceTierToggle />
          </div>
        </footer>
      </div>
    </section>
  );
}
