'use client';

import { useGSAP } from '@gsap/react';
import { useEffect, useRef, useState } from 'react';
import { ensureGsapRegistered, gsap } from '@/lib/gsap-setup';
import styles from './occasion.module.css';

export interface MacroFabricInsetProps {
  macroImageUrl?: string | null;
  fallbackImageUrl: string;
  alt: string;
  isDark: boolean;
  transitionKey: string;
  reducedMotion: boolean;
}

export function MacroFabricInset({
  macroImageUrl,
  fallbackImageUrl,
  alt,
  isDark,
  transitionKey,
  reducedMotion,
}: MacroFabricInsetProps) {
  const insetRef = useRef<HTMLDivElement | null>(null);
  const prevKeyRef = useRef<string | null>(null);
  const [macroErrored, setMacroErrored] = useState(false);

  useEffect(() => {
    setMacroErrored(false);
  }, [macroImageUrl, fallbackImageUrl]);

  useGSAP(
    () => {
      ensureGsapRegistered();
      const el = insetRef.current;
      if (!el) return;

      const isInitial = prevKeyRef.current === null;
      const unchanged = prevKeyRef.current === transitionKey;
      prevKeyRef.current = transitionKey;

      if (isInitial || unchanged || reducedMotion) {
        gsap.set(el, { y: 0, opacity: 1 });
        return;
      }

      gsap.fromTo(
        el,
        { y: 14, opacity: 0 },
        {
          y: 0,
          opacity: 1,
          duration: 0.55,
          delay: 0.08,
          ease: 'power3.out',
          overwrite: 'auto',
        },
      );
    },
    { scope: insetRef, dependencies: [transitionKey, reducedMotion] },
  );

  const hasDedicatedMacro = Boolean(macroImageUrl && !macroErrored);
  const resolvedSrc = hasDedicatedMacro ? macroImageUrl! : fallbackImageUrl;

  return (
    <div
      ref={insetRef}
      data-testid="occasion-macro-inset"
      className={`${styles.macroInset} ${isDark ? styles.macroInsetDark : ''}`}
      aria-hidden="true"
    >
      <img
        src={resolvedSrc}
        alt={alt}
        loading="eager"
        decoding="async"
        onError={() => {
          if (hasDedicatedMacro) {
            setMacroErrored(true);
          }
        }}
        className={
          hasDedicatedMacro ? styles.macroImg : styles.macroImgZoomFallback
        }
      />
    </div>
  );
}
