'use client';

import { useGSAP } from '@gsap/react';
import { useRef } from 'react';
import type { AtelierStep } from '@atelier/contracts';
import { useMotionState } from '@atelier/motion-kit';
import { ensureGsapRegistered, gsap } from '@/lib/gsap-setup';
import { GoldenThreadSvg } from './GoldenThreadSvg';

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
  const { reducedMotion, cameraActive } = useMotionState();

  useGSAP(
    () => {
      ensureGsapRegistered();
      const body = bodyRef.current;
      if (!body || reducedMotion || cameraActive) return;

      const timeNodes = Array.from(
        body.querySelectorAll<HTMLElement>('.step__time'),
      );
      timeNodes.forEach((node) => {
        const targetText = node.dataset.time || node.textContent || '08:00';
        const targetMinutes = parseMinutes(targetText);
        if (targetMinutes <= 0) return;

        const counter = { val: 0 };
        gsap.to(counter, {
          val: targetMinutes,
          duration: 1.1,
          ease: 'power2.out',
          scrollTrigger: {
            trigger: node,
            start: 'top 85%',
            once: true,
          },
          onUpdate: () => {
            node.textContent = formatMinutes(counter.val);
          },
          onComplete: () => {
            node.textContent = targetText;
          },
        });
      });
    },
    { scope: sectionRef, dependencies: [steps, reducedMotion, cameraActive] },
  );

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

      <div ref={bodyRef} className="atelier__body">
        <GoldenThreadSvg bodyRef={bodyRef} stepCount={steps.length} />

        <ol className="steps">
          {steps.map((step) => (
            <li key={`${step.stepOrder}-${step.title}`} className="step">
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
                <span className="step__time" data-time={step.timeTarget}>
                  {step.timeTarget}
                </span>
                <h3>{step.title}</h3>
                <p>{step.description}</p>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
