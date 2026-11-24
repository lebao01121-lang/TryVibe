'use client';

import { useEffect, useRef } from 'react';
import { useMotionState } from '@atelier/motion-kit';

interface CursorUpdateDetail {
  active?: boolean;
  label?: string;
}

export function CustomCursor() {
  const cursorRef = useRef<HTMLDivElement | null>(null);
  const labelRef = useRef<HTMLSpanElement | null>(null);
  const { cameraActive, reducedMotion } = useMotionState();

  useEffect(() => {
    const el = cursorRef.current;
    const labelEl = labelRef.current;
    if (!el || !labelEl) return;

    if (
      cameraActive ||
      reducedMotion ||
      window.matchMedia('(hover: none), (pointer: coarse)').matches
    ) {
      el.classList.remove('is-on', 'is-view');
      return;
    }

    let targetX = window.innerWidth / 2;
    let targetY = window.innerHeight / 2;
    let currentX = targetX;
    let currentY = targetY;
    let visible = false;
    let rafId = 0;

    const evaluateTarget = (target: EventTarget | null) => {
      const node = target instanceof Element ? (target as HTMLElement) : null;
      const cursorHost = node?.closest<HTMLElement>(
        '[data-cursor], [data-cursor-label]',
      );
      if (
        cursorHost &&
        cursorHost.dataset.cursor !== 'default' &&
        (cursorHost.dataset.cursor === 'view' ||
          Boolean(cursorHost.dataset.cursorLabel))
      ) {
        const nextLabel = cursorHost.dataset.cursorLabel || 'XEM';
        if (labelEl.textContent !== nextLabel) {
          labelEl.textContent = nextLabel;
        }
        el.classList.add('is-view');
      } else {
        el.classList.remove('is-view');
      }
    };

    const onMove = (event: MouseEvent | PointerEvent) => {
      targetX = event.clientX;
      targetY = event.clientY;
      if (!visible) {
        currentX = targetX;
        currentY = targetY;
        visible = true;
        el.classList.add('is-on');
      }
      evaluateTarget(event.target);
    };

    const onCursorUpdate = (event: Event) => {
      if (!visible) return;
      const custom = event as CustomEvent<CursorUpdateDetail>;
      const hovered = document.elementFromPoint(targetX, targetY);
      if (hovered) {
        evaluateTarget(hovered);
        return;
      }
      if (custom.detail?.active) {
        if (custom.detail.label && labelEl.textContent !== custom.detail.label) {
          labelEl.textContent = custom.detail.label;
        }
        el.classList.add('is-view');
      }
    };

    const onMouseLeave = () => {
      visible = false;
      el.classList.remove('is-on', 'is-view');
    };

    const tick = () => {
      if (document.hidden || document.body.dataset.cameraActive === 'true') {
        rafId = 0;
        return;
      }
      currentX += (targetX - currentX) * 0.2;
      currentY += (targetY - currentY) * 0.2;
      el.style.transform = `translate3d(${currentX}px, ${currentY}px, 0)`;
      rafId = window.requestAnimationFrame(tick);
    };

    const startLoop = () => {
      if (!rafId && !document.hidden) {
        rafId = window.requestAnimationFrame(tick);
      }
    };

    const onVisibility = () => {
      if (document.hidden) {
        if (rafId) {
          window.cancelAnimationFrame(rafId);
          rafId = 0;
        }
      } else {
        startLoop();
      }
    };

    window.addEventListener('mousemove', onMove, { passive: true });
    window.addEventListener('pointermove', onMove, { passive: true });
    window.addEventListener('atelier:cursor-update', onCursorUpdate);
    document.addEventListener('mouseleave', onMouseLeave);
    document.addEventListener('visibilitychange', onVisibility);
    startLoop();

    return () => {
      if (rafId) window.cancelAnimationFrame(rafId);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('atelier:cursor-update', onCursorUpdate);
      document.removeEventListener('mouseleave', onMouseLeave);
      document.removeEventListener('visibilitychange', onVisibility);
      el.classList.remove('is-on', 'is-view');
    };
  }, [cameraActive, reducedMotion]);

  return (
    <div ref={cursorRef} className="cursor" id="cursor" aria-hidden="true">
      <span ref={labelRef} className="cursor__label">
        XEM
      </span>
    </div>
  );
}
