'use client';

import { useId } from 'react';
import styles from './SiteHeader.module.css';

export type NavJourneyVisualState = 'active' | 'passed' | 'upcoming';

export interface DiagonalSlashSvgProps {
  itemId: string;
  state: NavJourneyVisualState;
  isLight: boolean;
}

/**
 * 3-state couture gold diagonal needle slash rendered behind each navigation label.
 * Uses pure vector gradients + geometric needle-tip dot (zero CSS blur filters)
 * for crisp 60 FPS GPU rendering on all devices.
 */
export function DiagonalSlashSvg({
  itemId,
  state,
  isLight,
}: DiagonalSlashSvgProps) {
  const reactId = useId().replace(/:/g, '');
  const gradientId = `nav-slash-grad-${itemId}-${reactId}`;

  const strokeValue =
    state === 'active'
      ? `url(#${gradientId})`
      : isLight
        ? '#9A7232'
        : '#B08A4A';

  const tipCoreFill = isLight ? '#C89D54' : '#FFF3D1';
  const tipHaloFill = isLight ? '#B08A4A' : '#EBCF8F';

  return (
    <svg
      className={styles.slashSvg}
      viewBox="0 0 120 32"
      preserveAspectRatio="none"
      aria-hidden="true"
      focusable="false"
      data-slash-state={state}
    >
      <defs>
        <linearGradient
          id={gradientId}
          x1="6"
          y1="27"
          x2="114"
          y2="5"
          gradientUnits="userSpaceOnUse"
        >
          {isLight ? (
            <>
              <stop offset="0%" stopColor="#7A5821" />
              <stop offset="52%" stopColor="#B08A4A" />
              <stop offset="100%" stopColor="#C89D54" />
            </>
          ) : (
            <>
              <stop offset="0%" stopColor="#B08A4A" />
              <stop offset="55%" stopColor="#EBCF8F" />
              <stop offset="100%" stopColor="#FFF3D1" />
            </>
          )}
        </linearGradient>
      </defs>

      <line
        className={styles.slashLine}
        x1="6"
        y1="27"
        x2="114"
        y2="5"
        pathLength={1}
        stroke={strokeValue}
        strokeLinecap="round"
      />

      {/* Luminous needle-tip dot with translucent vector halo (zero blur filters) */}
      <circle
        className={styles.slashTip}
        cx="114"
        cy="5"
        r="1.8"
        fill={tipCoreFill}
        stroke={tipHaloFill}
        strokeOpacity="0.45"
        strokeWidth="1.6"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
