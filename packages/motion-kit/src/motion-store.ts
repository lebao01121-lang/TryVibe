'use client';

import { useEffect, useSyncExternalStore } from 'react';

export interface MotionState {
  readonly scrollLockCount: number;
  readonly introActive: boolean;
  readonly cameraActive: boolean;
  readonly autoTourActive: boolean;
  readonly particleRainActive: boolean;
  readonly reducedMotion: boolean;
}

export interface ParticleBurstEvent {
  readonly x: number;
  readonly y: number;
  readonly count: number;
  readonly timestamp: number;
}

export type MotionStoreListener = () => void;
export type ParticleBurstListener = (burst: ParticleBurstEvent) => void;

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

const SERVER_SNAPSHOT: MotionState = Object.freeze({
  scrollLockCount: 0,
  introActive: false,
  cameraActive: false,
  autoTourActive: false,
  particleRainActive: false,
  reducedMotion: false,
});

let currentState: MotionState = SERVER_SNAPSHOT;
const storeListeners = new Set<MotionStoreListener>();
const burstListeners = new Set<ParticleBurstListener>();

let watchersInitialized = false;

function emitStoreChange(): void {
  for (const listener of storeListeners) {
    try {
      listener();
    } catch {
      // Isolate listener errors so motion state remains consistent
    }
  }
}

function updateState(patch: Partial<MotionState>): void {
  const next: MotionState = Object.freeze({
    scrollLockCount: patch.scrollLockCount ?? currentState.scrollLockCount,
    introActive: patch.introActive ?? currentState.introActive,
    cameraActive: patch.cameraActive ?? currentState.cameraActive,
    autoTourActive: patch.autoTourActive ?? currentState.autoTourActive,
    particleRainActive: patch.particleRainActive ?? currentState.particleRainActive,
    reducedMotion: patch.reducedMotion ?? currentState.reducedMotion,
  });

  if (
    next.scrollLockCount === currentState.scrollLockCount &&
    next.introActive === currentState.introActive &&
    next.cameraActive === currentState.cameraActive &&
    next.autoTourActive === currentState.autoTourActive &&
    next.particleRainActive === currentState.particleRainActive &&
    next.reducedMotion === currentState.reducedMotion
  ) {
    return;
  }

  currentState = next;
  emitStoreChange();
}

function syncBodyScrollLockAttr(count: number): void {
  if (typeof document === 'undefined' || !document.body) {
    return;
  }
  if (count > 0) {
    document.body.dataset.scrollLocked = 'true';
  } else {
    delete document.body.dataset.scrollLocked;
  }
}

function syncBodyAutoTourClass(active: boolean): void {
  if (typeof document === 'undefined' || !document.body) {
    return;
  }
  if (active) {
    document.body.classList.add('is-auto');
  } else {
    document.body.classList.remove('is-auto');
  }
}

/**
 * Ensures client-side listeners for `prefers-reduced-motion` and external
 * `document.body.dataset.cameraActive` mutations stay synchronized with the store.
 */
export function ensureMotionWatchers(): void {
  if (watchersInitialized || typeof window === 'undefined') {
    return;
  }
  watchersInitialized = true;

  // 1. Reduced-motion media query listener
  if (typeof window.matchMedia === 'function') {
    const mq = window.matchMedia(REDUCED_MOTION_QUERY);
    if (mq.matches !== currentState.reducedMotion) {
      updateState({ reducedMotion: mq.matches });
    }
    const onMqChange = (event: MediaQueryListEvent): void => {
      updateState({ reducedMotion: event.matches });
    };
    if (typeof mq.addEventListener === 'function') {
      mq.addEventListener('change', onMqChange);
    } else if (typeof mq.addListener === 'function') {
      mq.addListener(onMqChange);
    }
  }

  // 2. Sync initial & external DOM changes to `document.body.dataset.cameraActive`
  if (typeof document !== 'undefined' && document.body) {
    const domCameraActive = document.body.dataset.cameraActive === 'true';
    if (domCameraActive !== currentState.cameraActive) {
      applyCameraActiveState(domCameraActive);
    }

    if (typeof MutationObserver !== 'undefined') {
      const observer = new MutationObserver(() => {
        const isActive = document.body.dataset.cameraActive === 'true';
        if (isActive !== currentState.cameraActive) {
          applyCameraActiveState(isActive);
        }
      });
      observer.observe(document.body, {
        attributes: true,
        attributeFilter: ['data-camera-active'],
      });
    }
  }
}

/**
 * Internal bridge invoked by `camera-gpu-guard` and the DOM MutationObserver.
 * Enforces immediate autoTour stop, `is-auto` removal, and particleRain freeze
 * whenever `cameraActive` becomes `true`.
 */
export function applyCameraActiveState(active: boolean): void {
  if (active) {
    syncBodyAutoTourClass(false);
    updateState({
      cameraActive: true,
      autoTourActive: false,
      particleRainActive: false,
    });
  } else {
    updateState({ cameraActive: false });
  }
}

export function getMotionState(): MotionState {
  return currentState;
}

export function getServerMotionState(): MotionState {
  return SERVER_SNAPSHOT;
}

export function subscribeMotionStore(listener: MotionStoreListener): () => void {
  storeListeners.add(listener);
  return () => {
    storeListeners.delete(listener);
  };
}

/**
 * React 19 StrictMode-safe hook subscribed to the centralized Atelier motion store.
 */
export function useMotionState(): MotionState {
  const snapshot = useSyncExternalStore(
    subscribeMotionStore,
    getMotionState,
    getServerMotionState,
  );

  useEffect(() => {
    ensureMotionWatchers();
  }, []);

  return snapshot;
}

/**
 * Ref-counted scroll lock acquisition. Returns an idempotent release function.
 */
export function acquireScrollLock(): () => void {
  let released = false;
  const nextCount = currentState.scrollLockCount + 1;
  syncBodyScrollLockAttr(nextCount);
  updateState({ scrollLockCount: nextCount });

  return () => {
    if (released) {
      return;
    }
    released = true;
    const decremented = Math.max(0, currentState.scrollLockCount - 1);
    syncBodyScrollLockAttr(decremented);
    updateState({ scrollLockCount: decremented });
  };
}

/**
 * Resets all active scroll locks cleanly (e.g., on client-side route transitions).
 */
export function resetScrollLocks(): void {
  syncBodyScrollLockAttr(0);
  updateState({ scrollLockCount: 0 });
}

/**
 * React 19 StrictMode-safe scroll lock hook.
 */
export function useScrollLock(active: boolean): void {
  useEffect(() => {
    if (!active) {
      return undefined;
    }
    const release = acquireScrollLock();
    return () => {
      release();
    };
  }, [active]);
}

export function setIntroActive(active: boolean): void {
  updateState({ introActive: active });
}

export function setAutoTourActive(active: boolean): void {
  const effective = currentState.cameraActive ? false : active;
  syncBodyAutoTourClass(effective);
  updateState({ autoTourActive: effective });
}

export function setParticleRainActive(active: boolean): void {
  const effective = currentState.cameraActive ? false : active;
  updateState({ particleRainActive: effective });
}

export function triggerParticleBurst(x: number, y: number, count: number = 36): void {
  if (currentState.cameraActive || currentState.reducedMotion) {
    return;
  }
  const safeCount = Math.max(1, Math.min(160, Math.round(count)));
  const payload: ParticleBurstEvent = Object.freeze({
    x,
    y,
    count: safeCount,
    timestamp: Date.now(),
  });
  for (const listener of burstListeners) {
    try {
      listener(payload);
    } catch {
      // Isolate burst subscriber failures
    }
  }
}

export function subscribeParticleBurst(listener: ParticleBurstListener): () => void {
  burstListeners.add(listener);
  return () => {
    burstListeners.delete(listener);
  };
}
