'use client';

import { useEffect, useState } from 'react';
import {
  applyCameraActiveState,
  ensureMotionWatchers,
  getMotionState,
  subscribeMotionStore,
} from './motion-store.js';

export const CAMERA_GPU_GUARD_EVENT = 'atelier:camera-gpu-guard' as const;

export interface CameraGpuGuardEventDetail {
  paused: boolean;
  activeCount: number;
}

export type CameraGpuGuardSubscriber = (paused: boolean) => void;

let activeGuardCount = 0;
let isDispatchingInternal = false;

function syncDomAndNotify(paused: boolean): void {
  if (typeof document !== 'undefined' && document.body) {
    if (paused) {
      document.body.dataset.cameraActive = 'true';
    } else {
      delete document.body.dataset.cameraActive;
    }
  }

  // Wire directly into centralized motion store:
  // forces autoTourActive=false, removes body.is-auto, freezes particleRainActive
  applyCameraActiveState(paused);

  if (typeof window !== 'undefined' && typeof CustomEvent !== 'undefined') {
    isDispatchingInternal = true;
    try {
      window.dispatchEvent(
        new CustomEvent<CameraGpuGuardEventDetail>(CAMERA_GPU_GUARD_EVENT, {
          detail: { paused, activeCount: activeGuardCount },
        }),
      );
    } finally {
      isDispatchingInternal = false;
    }
  }
}

/**
 * Returns true whenever any Try-On camera session holds the GPU guard,
 * the motion store marks `cameraActive: true`, or
 * `document.body.dataset.cameraActive === 'true'`.
 */
export function isCameraGpuPaused(): boolean {
  if (activeGuardCount > 0 || getMotionState().cameraActive) {
    return true;
  }
  if (typeof document !== 'undefined' && document.body) {
    return document.body.dataset.cameraActive === 'true';
  }
  return false;
}

/**
 * Imperatively acquires a ref-counted Camera GPU Guard lock.
 * Returns an idempotent release function.
 */
export function acquireCameraGpuGuard(): () => void {
  let released = false;
  activeGuardCount += 1;
  if (activeGuardCount === 1) {
    syncDomAndNotify(true);
  }

  return () => {
    if (released) {
      return;
    }
    released = true;
    activeGuardCount = Math.max(0, activeGuardCount - 1);
    if (activeGuardCount === 0) {
      syncDomAndNotify(false);
    }
  };
}

/**
 * Subscribes WebGL / Canvas animation loops to Camera GPU Guard transitions.
 * Deduplicated via the centralized motion store (covering imperative guards,
 * `useCameraGpuGuard`, external custom events, and direct DOM
 * `document.body.dataset.cameraActive` toggles).
 */
export function subscribeCameraGpuGuard(callback: CameraGpuGuardSubscriber): () => void {
  ensureMotionWatchers();
  let lastPaused = isCameraGpuPaused();

  const unsubscribeStore = subscribeMotionStore(() => {
    const nextPaused = isCameraGpuPaused();
    if (nextPaused !== lastPaused) {
      lastPaused = nextPaused;
      try {
        callback(nextPaused);
      } catch {
        // Isolate subscriber failures so GPU pause state always propagates
      }
    }
  });

  const onDomEvent = (event: Event): void => {
    if (isDispatchingInternal) {
      return;
    }
    const customEvent = event as CustomEvent<CameraGpuGuardEventDetail>;
    if (customEvent.detail && typeof customEvent.detail.paused === 'boolean') {
      applyCameraActiveState(customEvent.detail.paused);
    }
  };

  if (typeof window !== 'undefined') {
    window.addEventListener(CAMERA_GPU_GUARD_EVENT, onDomEvent);
  }

  return () => {
    unsubscribeStore();
    if (typeof window !== 'undefined') {
      window.removeEventListener(CAMERA_GPU_GUARD_EVENT, onDomEvent);
    }
  };
}

/**
 * React hook for AI Try-On camera capture surfaces.
 * When `active` is true, acquires a ref-counted lock that sets
 * `document.body.dataset.cameraActive = 'true'`, forces `autoTourActive = false`,
 * freezes `particleRainActive`, and notifies WebGL/Canvas loops to pause.
 * Safe under React 19 StrictMode double-effects and multiple simultaneous consumers.
 */
export function useCameraGpuGuard(active: boolean): boolean {
  const [paused, setPaused] = useState<boolean>(() => active || isCameraGpuPaused());

  useEffect(() => {
    ensureMotionWatchers();
    const unsubscribe = subscribeCameraGpuGuard(setPaused);
    setPaused(isCameraGpuPaused());
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (!active) {
      setPaused(isCameraGpuPaused());
      return undefined;
    }

    const release = acquireCameraGpuGuard();
    setPaused(true);

    return () => {
      release();
      setPaused(isCameraGpuPaused());
    };
  }, [active]);

  return paused;
}

/**
 * Reactive reader hook for WebGL / Canvas render loops to pause automatically
 * whenever any Camera GPU Guard is active.
 */
export function useCameraGpuPaused(): boolean {
  const [paused, setPaused] = useState<boolean>(() => isCameraGpuPaused());

  useEffect(() => {
    ensureMotionWatchers();
    setPaused(isCameraGpuPaused());
    return subscribeCameraGpuGuard(setPaused);
  }, []);

  return paused;
}
