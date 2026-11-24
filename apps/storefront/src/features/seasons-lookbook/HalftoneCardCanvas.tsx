'use client';

import { useEffect, useRef, useState } from 'react';
import { useMotionState, usePrefersReducedMotion } from '@atelier/motion-kit';
import type { HalftoneWorkerResponse } from './halftone.worker';

export interface HalftoneCardCanvasProps {
  imageUrl: string | null | undefined;
  alt: string;
  title: string;
  months: string;
  registerSync?: (fn: () => void) => () => void;
}

interface MainThreadDotBuffers {
  xs: Float32Array;
  ys: Float32Array;
  radii: Float32Array;
  colors: Uint8Array;
  cell: number;
  box: [number, number, number, number];
}

function createSeasonalFallbackSvg(title: string, months: string): string {
  const safeTitle = title.replace(/[<>&"']/g, '').slice(0, 26);
  const safeMonths = months.replace(/[<>&"']/g, '').slice(0, 22);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="800" viewBox="0 0 600 800">
    <defs>
      <radialGradient id="bg" cx="50%" cy="32%" r="72%">
        <stop offset="0%" stop-color="#FFFDF7"/>
        <stop offset="100%" stop-color="#E7D4B1"/>
      </radialGradient>
    </defs>
    <rect width="600" height="800" fill="url(#bg)"/>
    <path d="M210 198 L264 164 L336 164 L390 198 L434 328 L382 352 L362 278 L374 612 L226 612 L238 278 L218 352 L166 328 Z" fill="#8A672C" fill-opacity="0.72" stroke="#2B2019" stroke-opacity="0.28" stroke-width="2"/>
    <text x="300" y="114" text-anchor="middle" fill="#8A672C" font-size="16" letter-spacing="4" font-family="sans-serif">${safeMonths.toUpperCase()}</text>
    <text x="300" y="692" text-anchor="middle" fill="#2B2019" font-size="28" font-family="Georgia, serif">${safeTitle}</text>
  </svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function computeCoverBox(
  targetW: number,
  targetH: number,
  srcW: number,
  srcH: number,
): [number, number, number, number] {
  if (srcW <= 0 || srcH <= 0) {
    const drawH = targetH * 0.92;
    const drawW = (drawH * 2) / 3;
    return [(targetW - drawW) / 2, targetH - drawH - targetH * 0.02, drawW, drawH];
  }
  const scale = Math.max(targetW / srcW, targetH / srcH);
  const drawW = srcW * scale;
  const drawH = srcH * scale;
  return [(targetW - drawW) / 2, (targetH - drawH) / 2, drawW, drawH];
}

function loadHtmlImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Image load failed'));
    img.src = src;
  });
}

function computeFallbackDotsOnMainThread(
  img: HTMLImageElement,
  width: number,
  height: number,
  dpr: number,
): MainThreadDotBuffers | null {
  const cell = Math.max(4, Math.round(5.5 * dpr));
  const cols = Math.max(1, Math.floor(width / cell));
  const rows = Math.max(1, Math.floor(height / cell));
  const box = computeCoverBox(width, height, img.naturalWidth, img.naturalHeight);

  const sampleCanvas = document.createElement('canvas');
  sampleCanvas.width = cols;
  sampleCanvas.height = rows;
  const sCtx = sampleCanvas.getContext('2d', { willReadFrequently: true });
  if (!sCtx) return null;

  sCtx.drawImage(img, box[0] / cell, box[1] / cell, box[2] / cell, box[3] / cell);
  const data = sCtx.getImageData(0, 0, cols, rows).data;

  let activeCount = 0;
  for (let i = 0; i < cols * rows; i += 1) {
    if ((data[i * 4 + 3] ?? 0) / 255 >= 0.15) activeCount += 1;
  }

  const xs = new Float32Array(activeCount);
  const ys = new Float32Array(activeCount);
  const radii = new Float32Array(activeCount);
  const colors = new Uint8Array(activeCount * 3);

  let writeIdx = 0;
  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < cols; x += 1) {
      const idx = y * cols + x;
      const offset = idx * 4;
      const alpha = (data[offset + 3] ?? 0) / 255;
      if (alpha < 0.15) continue;
      const lum =
        ((data[offset] ?? 0) * 0.3 +
          (data[offset + 1] ?? 0) * 0.59 +
          (data[offset + 2] ?? 0) * 0.11) /
        255;
      xs[writeIdx] = x * cell + cell * 0.5;
      ys[writeIdx] = y * cell + cell * 0.5;
      radii[writeIdx] = (0.35 + (1 - lum) * 0.65) * alpha;
      colors[writeIdx * 3] = Math.min(255, ((data[offset] ?? 0) * 0.7 + 60) | 0);
      colors[writeIdx * 3 + 1] = Math.min(255, ((data[offset + 1] ?? 0) * 0.7 + 50) | 0);
      colors[writeIdx * 3 + 2] = Math.min(255, ((data[offset + 2] ?? 0) * 0.7 + 30) | 0);
      writeIdx += 1;
    }
  }

  return { xs, ys, radii, colors, cell, box };
}

function drawMainThreadHalftone(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  img: HTMLImageElement,
  buffers: MainThreadDotBuffers,
  progress: number,
): void {
  const clamped = Math.max(0, Math.min(1, progress));
  const [bx, by, bw, bh] = buffers.box;

  ctx.clearRect(0, 0, width, height);

  const photoT = Math.max(0, Math.min(1, (clamped - 0.4) / 0.45));
  const photoAlpha = photoT * photoT * (3 - 2 * photoT);
  if (photoAlpha > 0) {
    ctx.globalAlpha = photoAlpha;
    ctx.drawImage(img, bx, by, bw, bh);
  }

  const dotsAlpha = 1 - photoAlpha;
  if (dotsAlpha <= 0.002) {
    ctx.globalAlpha = 1;
    return;
  }

  ctx.globalAlpha = dotsAlpha;
  const scale = 0.8 + clamped * 0.9;
  const { xs, ys, radii, colors, cell } = buffers;
  for (let i = 0; i < xs.length; i += 1) {
    const r = cell * 0.5 * Math.sqrt(radii[i] ?? 0) * scale;
    if (r < 0.4) continue;
    const cOff = i * 3;
    ctx.fillStyle = `rgb(${colors[cOff]},${colors[cOff + 1]},${colors[cOff + 2]})`;
    ctx.beginPath();
    ctx.arc(xs[i] ?? 0, ys[i] ?? 0, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

export function HalftoneCardCanvas({
  imageUrl,
  alt,
  title,
  months,
  registerSync,
}: HalftoneCardCanvasProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const modeRef = useRef<'offscreen' | 'buffer' | 'main2d'>('main2d');
  const ctx2dRef = useRef<CanvasRenderingContext2D | null>(null);
  const canvasSizeRef = useRef({ width: 0, height: 0 });
  const loadedImageRef = useRef<HTMLImageElement | null>(null);
  const mainBuffersRef = useRef<MainThreadDotBuffers | null>(null);
  const lastProgressRef = useRef(-1);
  const pausedRef = useRef(false);

  const { cameraActive } = useMotionState();
  const reducedMotion = usePrefersReducedMotion();
  const [isNearViewport, setIsNearViewport] = useState(false);
  const [isHidden, setIsHidden] = useState(false);
  const [canvasReady, setCanvasReady] = useState(false);

  const fallbackSvg = createSeasonalFallbackSvg(title, months);
  const displaySrc = imageUrl || fallbackSvg;

  // Pause completely whenever cameraActive or document.hidden
  pausedRef.current = cameraActive || isHidden || reducedMotion;

  useEffect(() => {
    const onVisibility = () => setIsHidden(document.hidden);
    setIsHidden(document.hidden);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  // Lazy initialize via IntersectionObserver (rootMargin: '400px')
  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') {
      setIsNearViewport(true);
      return undefined;
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          setIsNearViewport(true);
          observer.disconnect();
        }
      },
      { rootMargin: '400px' },
    );
    observer.observe(el);

    return () => {
      observer.disconnect();
    };
  }, []);

  // Compute progress from card distance to viewport center (0.58 * window.innerWidth)
  const syncProgressRef = useRef<() => void>(() => {});
  syncProgressRef.current = () => {
    if (pausedRef.current) return;
    const container = containerRef.current;
    if (!container) return;

    const vw = window.innerWidth || 1;
    const rect = container.getBoundingClientRect();
    if (rect.right < -50 || rect.left > vw + 50) return;

    const dist = Math.abs(rect.left + rect.width / 2 - vw * 0.58);
    const progress = Math.max(0, Math.min(1, 1 - dist / (vw * 0.5)));

    if (Math.abs(lastProgressRef.current - progress) < 0.004) return;
    lastProgressRef.current = progress;

    if (modeRef.current === 'offscreen' && workerRef.current) {
      workerRef.current.postMessage({ type: 'render', progress });
    } else if (
      ctx2dRef.current &&
      loadedImageRef.current &&
      mainBuffersRef.current
    ) {
      drawMainThreadHalftone(
        ctx2dRef.current,
        canvasSizeRef.current.width,
        canvasSizeRef.current.height,
        loadedImageRef.current,
        mainBuffersRef.current,
        progress,
      );
    }
  };

  // Register imperative progress updater with SeasonLookbookTrack (zero 60Hz setState)
  useEffect(() => {
    if (!registerSync) return undefined;
    return registerSync(() => {
      syncProgressRef.current();
    });
  }, [registerSync]);

  // Mount imperative <canvas> (React 19 StrictMode-safe for transferControlToOffscreen)
  // + initialize dedicated halftone Web Worker with clean 2D fallback & termination on unmount
  useEffect(() => {
    if (!isNearViewport || reducedMotion) return undefined;
    const container = containerRef.current;
    if (!container) return undefined;

    let cancelled = false;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round((container.clientWidth || 300) * dpr));
    const height = Math.max(1, Math.round((container.clientHeight || 400) * dpr));
    canvasSizeRef.current = { width, height };
    lastProgressRef.current = -1;

    // Create fresh canvas element inside effect so React 19 StrictMode double-mount
    // never calls transferControlToOffscreen() twice on the same DOM node.
    const canvas = document.createElement('canvas');
    canvas.className = 'absolute inset-0 h-full w-full block';
    canvas.width = width;
    canvas.height = height;
    container.appendChild(canvas);

    let worker: Worker | null = null;
    const supportsWorker = typeof Worker !== 'undefined';
    const supportsTransfer =
      supportsWorker &&
      typeof OffscreenCanvas !== 'undefined' &&
      typeof canvas.transferControlToOffscreen === 'function';

    if (supportsWorker) {
      try {
        worker = new Worker(new URL('./halftone.worker.ts', import.meta.url), {
          type: 'module',
        });
        workerRef.current = worker;

        if (supportsTransfer) {
          const offscreen = canvas.transferControlToOffscreen();
          modeRef.current = 'offscreen';
          worker.postMessage(
            { type: 'init-offscreen', canvas: offscreen, width, height, dpr },
            [offscreen],
          );
        } else {
          modeRef.current = 'buffer';
          ctx2dRef.current = canvas.getContext('2d');
        }
      } catch {
        worker = null;
        workerRef.current = null;
        modeRef.current = 'main2d';
        ctx2dRef.current = canvas.getContext('2d');
      }
    } else {
      modeRef.current = 'main2d';
      ctx2dRef.current = canvas.getContext('2d');
    }

    if (worker) {
      worker.onerror = (event: ErrorEvent) => {
        event.preventDefault();
        if (workerRef.current) {
          workerRef.current.terminate();
          workerRef.current = null;
        }
        setCanvasReady(false);
      };

      worker.onmessage = (event: MessageEvent<HalftoneWorkerResponse>) => {
        if (cancelled) return;
        const payload = event.data;
        if (payload.type === 'ready') {
          setCanvasReady(true);
          lastProgressRef.current = -1;
          syncProgressRef.current();
        } else if (payload.type === 'buffers') {
          mainBuffersRef.current = {
            xs: payload.xs,
            ys: payload.ys,
            radii: payload.radii,
            colors: payload.colors,
            cell: payload.cell,
            box: payload.box,
          };
          setCanvasReady(true);
          lastProgressRef.current = -1;
          syncProgressRef.current();
        }
      };
    }

    const hydrateImage = async () => {
      let img: HTMLImageElement;
      try {
        img = await loadHtmlImage(displaySrc);
      } catch {
        img = await loadHtmlImage(fallbackSvg);
      }
      if (cancelled) return;
      loadedImageRef.current = img;

      if (worker && typeof createImageBitmap === 'function') {
        try {
          const bitmap = await createImageBitmap(img);
          if (cancelled) {
            bitmap.close();
            return;
          }
          worker.postMessage(
            { type: 'load-image', bitmap, width, height, dpr },
            [bitmap],
          );
          return;
        } catch {
          // Fall through to 2D pixel extraction fallback
        }
      }

      if (ctx2dRef.current) {
        const buffers = computeFallbackDotsOnMainThread(img, width, height, dpr);
        if (buffers && !cancelled) {
          mainBuffersRef.current = buffers;
          setCanvasReady(true);
          lastProgressRef.current = -1;
          syncProgressRef.current();
        }
      }
    };

    void hydrateImage();

    let resizeTimer: number | null = null;
    const handleResize = () => {
      if (resizeTimer !== null) window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        if (cancelled || !containerRef.current) return;
        const nextDpr = Math.min(window.devicePixelRatio || 1, 2);
        const nextW = Math.max(
          1,
          Math.round((containerRef.current.clientWidth || 300) * nextDpr),
        );
        const nextH = Math.max(
          1,
          Math.round((containerRef.current.clientHeight || 400) * nextDpr),
        );
        canvasSizeRef.current = { width: nextW, height: nextH };

        if (modeRef.current === 'offscreen' && workerRef.current) {
          workerRef.current.postMessage({
            type: 'resize',
            width: nextW,
            height: nextH,
            dpr: nextDpr,
          });
        } else if (ctx2dRef.current && loadedImageRef.current) {
          canvas.width = nextW;
          canvas.height = nextH;
          mainBuffersRef.current = computeFallbackDotsOnMainThread(
            loadedImageRef.current,
            nextW,
            nextH,
            nextDpr,
          );
        }
        lastProgressRef.current = -1;
        syncProgressRef.current();
      }, 220);
    };

    window.addEventListener('resize', handleResize, { passive: true });

    return () => {
      cancelled = true;
      window.removeEventListener('resize', handleResize);
      if (resizeTimer !== null) window.clearTimeout(resizeTimer);
      if (workerRef.current) {
        try {
          workerRef.current.postMessage({ type: 'dispose' });
        } catch {
          // Ignore postMessage on closing worker
        }
        workerRef.current.terminate();
        workerRef.current = null;
      }
      ctx2dRef.current = null;
      mainBuffersRef.current = null;
      loadedImageRef.current = null;
      canvas.remove();
    };
  }, [displaySrc, fallbackSvg, isNearViewport, reducedMotion]);

  return (
    <div ref={containerRef} className="relative h-full w-full overflow-hidden">
      {/* Crisp photographic base image visible immediately during SSR, reduced-motion, or before worker hydrate */}
      <img
        src={displaySrc}
        alt={alt}
        loading="lazy"
        className={`h-full w-full object-cover transition-opacity duration-500 ${
          !reducedMotion && canvasReady ? 'opacity-0' : 'opacity-100'
        }`}
      />
    </div>
  );
}
