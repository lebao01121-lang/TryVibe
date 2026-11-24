'use client';

import { useGSAP } from '@gsap/react';
import Link from 'next/link';
import { useRef, type ReactNode } from 'react';
import { useMotionState } from '@atelier/motion-kit';
import { ensureGsapRegistered, gsap } from '@/lib/gsap-setup';

export interface MagneticButtonProps {
  href?: string;
  onClick?: () => void;
  type?: 'button' | 'submit' | 'reset';
  disabled?: boolean;
  className?: string;
  ariaLabel?: string;
  cursorLabel?: string;
  children: ReactNode;
}

export function MagneticButton({
  href,
  onClick,
  type = 'button',
  disabled = false,
  className = 'btn btn--gold',
  ariaLabel,
  cursorLabel,
  children,
}: MagneticButtonProps) {
  const wrapperRef = useRef<HTMLSpanElement | null>(null);
  const { cameraActive, reducedMotion } = useMotionState();

  useGSAP(
    () => {
      ensureGsapRegistered();
      const el = wrapperRef.current;
      if (!el || cameraActive || reducedMotion) return;
      if (
        typeof window !== 'undefined' &&
        window.matchMedia('(hover: none), (pointer: coarse)').matches
      ) {
        return;
      }

      const moveX = gsap.quickTo(el, 'x', { duration: 0.5, ease: 'power3.out' });
      const moveY = gsap.quickTo(el, 'y', { duration: 0.5, ease: 'power3.out' });

      const onMove = (event: MouseEvent) => {
        const rect = el.getBoundingClientRect();
        moveX((event.clientX - rect.left - rect.width / 2) * 0.3);
        moveY((event.clientY - rect.top - rect.height / 2) * 0.4);
      };

      const onLeave = () => {
        moveX(0);
        moveY(0);
      };

      el.addEventListener('mousemove', onMove);
      el.addEventListener('mouseleave', onLeave);

      return () => {
        el.removeEventListener('mousemove', onMove);
        el.removeEventListener('mouseleave', onLeave);
        gsap.set(el, { x: 0, y: 0 });
      };
    },
    { scope: wrapperRef, dependencies: [cameraActive, reducedMotion] },
  );

  const cursorAttrs = cursorLabel
    ? { 'data-cursor': 'view', 'data-cursor-label': cursorLabel }
    : {};

  return (
    <span ref={wrapperRef} className="magnetic inline-flex will-change-transform">
      {href ? (
        <Link
          href={href}
          className={className}
          aria-label={ariaLabel}
          {...cursorAttrs}
        >
          {children}
        </Link>
      ) : (
        <button
          type={type}
          disabled={disabled}
          onClick={onClick}
          className={className}
          aria-label={ariaLabel}
          {...cursorAttrs}
        >
          {children}
        </button>
      )}
    </span>
  );
}
