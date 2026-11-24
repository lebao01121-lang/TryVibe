'use client';

import { useGSAP } from '@gsap/react';
import { useEffect, useRef, useState } from 'react';
import { ensureGsapRegistered, gsap } from '@/lib/gsap-setup';
import styles from './occasion.module.css';

export interface CircularFabricLensProps {
  macroImageUrl?: string | null;
  fallbackImageUrl: string;
  alt: string;
  isDark: boolean;
  transitionKey: string;
  reducedMotion: boolean;
}

export function CircularFabricLens({
  macroImageUrl,
  fallbackImageUrl,
  alt,
  isDark,
  transitionKey,
  reducedMotion,
}: CircularFabricLensProps) {
  const groupRef = useRef<HTMLDivElement | null>(null);
  const prevKeyRef = useRef<string | null>(null);
  const [macroErrored, setMacroErrored] = useState(false);

  useEffect(() => {
    setMacroErrored(false);
  }, [macroImageUrl, fallbackImageUrl]);

  useGSAP(
    () => {
      ensureGsapRegistered();
      const el = groupRef.current;
      if (!el) return;

      const isInitial = prevKeyRef.current === null;
      const unchanged = prevKeyRef.current === transitionKey;
      prevKeyRef.current = transitionKey;

      if (isInitial || unchanged || reducedMotion) {
        gsap.set(el, { opacity: 1, y: 0, scale: 1 });
        return;
      }

      gsap.fromTo(
        el,
        { opacity: 0, y: 12, scale: 0.92 },
        {
          opacity: 1,
          y: 0,
          scale: 1,
          duration: 0.58,
          delay: 0.08,
          ease: 'power3.out',
          overwrite: 'auto',
        },
      );
    },
    { scope: groupRef, dependencies: [transitionKey, reducedMotion] },
  );

  const hasDedicatedMacro = Boolean(macroImageUrl && !macroErrored);
  const resolvedSrc = hasDedicatedMacro ? macroImageUrl! : fallbackImageUrl;

  return (
    <div
      ref={groupRef}
      className={`${styles.fabricLensGroup} ${
        isDark ? styles.fabricLensGroupDark : ''
      }`}
      aria-hidden="true"
    >
      <div
        data-testid="occasion-fabric-lens"
        className={`${styles.fabricLens} ${
          isDark ? styles.fabricLensDark : ''
        }`}
      >
        <span className={styles.fabricLensInner}>
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
              hasDedicatedMacro
                ? styles.fabricLensImg
                : styles.fabricLensImgZoomFallback
            }
          />
        </span>
      </div>

      <div
        data-testid="occasion-lens-pointer"
        className={styles.lensPointer}
        aria-hidden="true"
      >
        <span className={styles.lensPointerLine} />
        <span className={styles.lensPointerDot} />
      </div>
    </div>
  );
}
