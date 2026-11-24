import * as THREE from 'three';
import type {
  FabricPbrProfile,
  FabricWeightClass,
  Garment3DLayerSpec,
  GarmentAlphaBounds,
  GarmentSlot3D,
  GarmentTextureBundle,
} from './types';

type DrawableImageSource = HTMLImageElement | ImageBitmap;
type CanvasLike = HTMLCanvasElement | OffscreenCanvas;
type Context2DLike =
  | CanvasRenderingContext2D
  | OffscreenCanvasRenderingContext2D;

const MAX_TEXTURE_DIM = 768;
const ALPHA_GRID_W = 64;
const ALPHA_GRID_H = 80;
const ANISOTROPY_LEVEL = 4;

interface LoadedImageAsset {
  source: DrawableImageSource;
  width: number;
  height: number;
  cleanup: () => void;
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function createOffscreenOrDomCanvas(width: number, height: number): CanvasLike {
  const safeW = Math.max(2, Math.round(width));
  const safeH = Math.max(2, Math.round(height));
  if (typeof OffscreenCanvas !== 'undefined') {
    try {
      return new OffscreenCanvas(safeW, safeH);
    } catch {
      // Fall through to HTMLCanvasElement
    }
  }
  const canvas = document.createElement('canvas');
  canvas.width = safeW;
  canvas.height = safeH;
  return canvas;
}

function get2DContext(
  canvas: CanvasLike,
  willReadFrequently = false,
): Context2DLike | null {
  try {
    return canvas.getContext('2d', {
      willReadFrequently,
    }) as Context2DLike | null;
  } catch {
    return null;
  }
}

function toTextureCanvas(source: CanvasLike): HTMLCanvasElement {
  if (typeof HTMLCanvasElement !== 'undefined' && source instanceof HTMLCanvasElement) {
    return source;
  }
  const out = document.createElement('canvas');
  out.width = source.width;
  out.height = source.height;
  const ctx = out.getContext('2d');
  if (ctx) {
    ctx.drawImage(source as CanvasImageSource, 0, 0);
  }
  return out;
}

function loadHtmlImage(
  src: string,
  anonymousCors: boolean,
): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    if (typeof Image === 'undefined') {
      resolve(null);
      return;
    }
    const img = new Image();
    if (anonymousCors) {
      img.crossOrigin = 'anonymous';
    }
    img.decoding = 'async';
    let settled = false;
    const finish = (value: HTMLImageElement | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const timer =
      typeof window !== 'undefined'
        ? window.setTimeout(() => finish(null), 9000)
        : null;
    img.onload = () => {
      if (timer !== null) window.clearTimeout(timer);
      if (img.naturalWidth > 0 && img.naturalHeight > 0) {
        finish(img);
      } else {
        finish(null);
      }
    };
    img.onerror = () => {
      if (timer !== null) window.clearTimeout(timer);
      finish(null);
    };
    img.src = src;
  });
}

/**
 * CORS-safe image loader:
 * 1. `crossOrigin = 'anonymous'` direct load (fast path for same-origin & CORS-enabled CDN/MinIO)
 * 2. `fetch -> Blob -> createImageBitmap` fallback (immune to non-CORS `<img>` cache pollution)
 * 3. Cache-busted `crossOrigin = 'anonymous'` retry
 * Never throws CORS / SecurityError; returns `null` if all attempts fail.
 */
export async function loadImageSafe(url: string): Promise<LoadedImageAsset | null> {
  if (typeof window === 'undefined' || !url || !url.trim()) {
    return null;
  }

  const trimmed = url.trim();

  if (trimmed.startsWith('data:') || trimmed.startsWith('blob:')) {
    const img = await loadHtmlImage(trimmed, false);
    if (!img) return null;
    return {
      source: img,
      width: img.naturalWidth,
      height: img.naturalHeight,
      cleanup: () => {},
    };
  }

  // Path 1: fetch -> Blob -> createImageBitmap (immune to cached non-CORS <img> tainting)
  try {
    const controller =
      typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timeoutId = controller
      ? window.setTimeout(() => controller.abort(), 8500)
      : null;

    const response = await fetch(trimmed, {
      mode: 'cors',
      credentials: 'omit',
      signal: controller?.signal,
    });
    if (timeoutId !== null) window.clearTimeout(timeoutId);

    if (response.ok) {
      const blob = await response.blob();
      if (typeof createImageBitmap === 'function') {
        try {
          const bitmap = await createImageBitmap(blob);
          if (bitmap.width > 0 && bitmap.height > 0) {
            return {
              source: bitmap,
              width: bitmap.width,
              height: bitmap.height,
              cleanup: () => bitmap.close(),
            };
          }
          bitmap.close();
        } catch {
          // Fall through to ObjectURL Image load
        }
      }

      const objectUrl = URL.createObjectURL(blob);
      const img = await loadHtmlImage(objectUrl, false);
      if (img) {
        return {
          source: img,
          width: img.naturalWidth,
          height: img.naturalHeight,
          cleanup: () => URL.revokeObjectURL(objectUrl),
        };
      }
      URL.revokeObjectURL(objectUrl);
    }
  } catch {
    // Fall through to anonymous Image load
  }

  // Path 2: direct crossOrigin='anonymous' Image load
  const direct = await loadHtmlImage(trimmed, true);
  if (direct) {
    return {
      source: direct,
      width: direct.naturalWidth,
      height: direct.naturalHeight,
      cleanup: () => {},
    };
  }

  // Path 3: cache-busted anonymous Image load
  const sep = trimmed.includes('?') ? '&' : '?';
  const busted = await loadHtmlImage(`${trimmed}${sep}atelier_3d=1`, true);
  if (busted) {
    return {
      source: busted,
      width: busted.naturalWidth,
      height: busted.naturalHeight,
      cleanup: () => {},
    };
  }

  return null;
}

/**
 * Resolves physically based rendering parameters from fabric composition and weight class.
 */
export function resolveFabricPbrProfile(
  fabricComposition?: string,
  fabricWeight: FabricWeightClass = 'MEDIUM',
): FabricPbrProfile {
  const text = (fabricComposition ?? '').toLowerCase();

  // Silk / Satin / Organza / Chiffon
  if (
    /silk|satin|organza|chiffon|charmeuse|mulberry|lụa|phi bóng|tơ tằm|voan/.test(
      text,
    )
  ) {
    return {
      roughness: 0.32,
      sheen: 0.85,
      sheenRoughness: 0.28,
      clearcoat: 0.18,
      clearcoatRoughness: 0.3,
      metalness: 0.04,
      normalScale: 0.42,
      weaveFrequency: 28,
      weaveStrength: 0.14,
      swayStiffness: 14,
      swayDamping: 4.2,
      swayAmplitude: 1.0,
    };
  }

  // Cashmere / Merino / Knit / Mohair / Boucle
  if (/cashmere|merino|knit|mohair|alpaca|len|dệt kim|nỉ/.test(text)) {
    return {
      roughness: 0.86,
      sheen: 0.92,
      sheenRoughness: 0.72,
      clearcoat: 0.0,
      clearcoatRoughness: 0.9,
      metalness: 0.0,
      normalScale: 0.78,
      weaveFrequency: 18,
      weaveStrength: 0.38,
      swayStiffness: 20,
      swayDamping: 5.8,
      swayAmplitude: 0.58,
    };
  }

  // Linen / Ramie / Hemp
  if (/linen|ramie|hemp|đũi|lanh|sợi lanh/.test(text)) {
    return {
      roughness: 0.78,
      sheen: 0.35,
      sheenRoughness: 0.65,
      clearcoat: 0.0,
      clearcoatRoughness: 0.8,
      metalness: 0.0,
      normalScale: 0.72,
      weaveFrequency: 22,
      weaveStrength: 0.32,
      swayStiffness: 22,
      swayDamping: 6.2,
      swayAmplitude: 0.68,
    };
  }

  // Tweed / Wool / Trench / Gabardine / Suiting / Velvet
  if (
    /tweed|wool|trench|gabardine|suiting|worsted|dạ|len dạ|kaki|nhung|velvet/.test(
      text,
    )
  ) {
    return {
      roughness: 0.82,
      sheen: 0.42,
      sheenRoughness: 0.58,
      clearcoat: 0.04,
      clearcoatRoughness: 0.65,
      metalness: 0.01,
      normalScale: 0.86,
      weaveFrequency: 16,
      weaveStrength: 0.42,
      swayStiffness: 34,
      swayDamping: 8.2,
      swayAmplitude: 0.32,
    };
  }

  // Weight-class fallback
  if (fabricWeight === 'LIGHT') {
    return {
      roughness: 0.44,
      sheen: 0.76,
      sheenRoughness: 0.36,
      clearcoat: 0.12,
      clearcoatRoughness: 0.36,
      metalness: 0.02,
      normalScale: 0.48,
      weaveFrequency: 26,
      weaveStrength: 0.18,
      swayStiffness: 16,
      swayDamping: 4.6,
      swayAmplitude: 0.92,
    };
  }

  if (fabricWeight === 'HEAVY') {
    return {
      roughness: 0.82,
      sheen: 0.42,
      sheenRoughness: 0.6,
      clearcoat: 0.04,
      clearcoatRoughness: 0.66,
      metalness: 0.01,
      normalScale: 0.82,
      weaveFrequency: 16,
      weaveStrength: 0.38,
      swayStiffness: 32,
      swayDamping: 7.8,
      swayAmplitude: 0.36,
    };
  }

  // MEDIUM tailored crepe / cotton
  return {
    roughness: 0.68,
    sheen: 0.52,
    sheenRoughness: 0.52,
    clearcoat: 0.05,
    clearcoatRoughness: 0.55,
    metalness: 0.01,
    normalScale: 0.62,
    weaveFrequency: 22,
    weaveStrength: 0.26,
    swayStiffness: 24,
    swayDamping: 6.4,
    swayAmplitude: 0.62,
  };
}

function parseHexToRgb(hex: string): [number, number, number] {
  const cleaned = (hex || '#B08A4A').replace('#', '').trim();
  if (cleaned.length === 3) {
    const r = parseInt(cleaned[0]! + cleaned[0]!, 16);
    const g = parseInt(cleaned[1]! + cleaned[1]!, 16);
    const b = parseInt(cleaned[2]! + cleaned[2]!, 16);
    if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) {
      return [r, g, b];
    }
  }
  if (cleaned.length >= 6) {
    const r = parseInt(cleaned.slice(0, 2), 16);
    const g = parseInt(cleaned.slice(2, 4), 16);
    const b = parseInt(cleaned.slice(4, 6), 16);
    if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) {
      return [r, g, b];
    }
  }
  return [176, 138, 74];
}

/**
 * Draws an atelier-grade stylized couture garment fallback ONLY if a garment URL
 * completely fails to load (offline or broken link).
 */
function createStylizedFallbackCanvas(
  slot: GarmentSlot3D,
  colorHex: string,
  darkerBack = false,
): CanvasLike {
  const w = 512;
  const h = 680;
  const canvas = createOffscreenOrDomCanvas(w, h);
  const ctx = get2DContext(canvas, true);
  if (!ctx) return canvas;

  const [baseR, baseG, baseB] = parseHexToRgb(colorHex);
  const factor = darkerBack ? 0.8 : 1.0;
  const r = Math.round(clamp(baseR * factor, 18, 245));
  const g = Math.round(clamp(baseG * factor, 18, 245));
  const b = Math.round(clamp(baseB * factor, 18, 245));
  const hiR = Math.round(clamp(r + 28, 0, 255));
  const hiG = Math.round(clamp(g + 26, 0, 255));
  const hiB = Math.round(clamp(b + 24, 0, 255));
  const loR = Math.round(clamp(r * 0.68, 8, 230));
  const loG = Math.round(clamp(g * 0.68, 8, 230));
  const loB = Math.round(clamp(b * 0.68, 8, 230));

  ctx.clearRect(0, 0, w, h);

  ctx.save();
  ctx.beginPath();

  if (slot === 'BOTTOM') {
    // High-waisted tailored trouser / midi skirt silhouette
    ctx.moveTo(w * 0.28, h * 0.08);
    ctx.quadraticCurveTo(w * 0.5, h * 0.1, w * 0.72, h * 0.08);
    ctx.lineTo(w * 0.82, h * 0.34);
    ctx.lineTo(w * 0.84, h * 0.94);
    ctx.lineTo(w * 0.54, h * 0.94);
    ctx.lineTo(w * 0.5, h * 0.39);
    ctx.lineTo(w * 0.46, h * 0.94);
    ctx.lineTo(w * 0.16, h * 0.94);
    ctx.lineTo(w * 0.18, h * 0.34);
    ctx.closePath();
  } else if (slot === 'ONE_PIECE') {
    // Sculpted couture evening dress silhouette
    ctx.moveTo(w * 0.34, h * 0.06);
    ctx.quadraticCurveTo(w * 0.5, h * 0.15, w * 0.66, h * 0.06);
    ctx.lineTo(w * 0.78, h * 0.14);
    ctx.quadraticCurveTo(w * 0.72, h * 0.28, w * 0.67, h * 0.42);
    ctx.quadraticCurveTo(w * 0.82, h * 0.66, w * 0.88, h * 0.95);
    ctx.quadraticCurveTo(w * 0.5, h * 0.98, w * 0.12, h * 0.95);
    ctx.quadraticCurveTo(w * 0.18, h * 0.66, w * 0.33, h * 0.42);
    ctx.quadraticCurveTo(w * 0.28, h * 0.28, w * 0.22, h * 0.14);
    ctx.closePath();
  } else if (slot === 'OUTERWEAR') {
    // Structured tailored coat / blazer with sleeves
    ctx.moveTo(w * 0.34, h * 0.06);
    ctx.quadraticCurveTo(w * 0.5, h * 0.16, w * 0.66, h * 0.06);
    ctx.lineTo(w * 0.84, h * 0.14);
    ctx.lineTo(w * 0.94, h * 0.62);
    ctx.lineTo(w * 0.81, h * 0.64);
    ctx.lineTo(w * 0.76, h * 0.35);
    ctx.lineTo(w * 0.79, h * 0.94);
    ctx.lineTo(w * 0.21, h * 0.94);
    ctx.lineTo(w * 0.24, h * 0.35);
    ctx.lineTo(w * 0.19, h * 0.64);
    ctx.lineTo(w * 0.06, h * 0.62);
    ctx.lineTo(w * 0.16, h * 0.14);
    ctx.closePath();
  } else {
    // TOP blouse / tailored shirt with soft sleeves
    ctx.moveTo(w * 0.34, h * 0.08);
    ctx.quadraticCurveTo(w * 0.5, h * 0.18, w * 0.66, h * 0.08);
    ctx.lineTo(w * 0.84, h * 0.18);
    ctx.lineTo(w * 0.92, h * 0.52);
    ctx.lineTo(w * 0.78, h * 0.55);
    ctx.lineTo(w * 0.74, h * 0.38);
    ctx.lineTo(w * 0.76, h * 0.92);
    ctx.quadraticCurveTo(w * 0.5, h * 0.95, w * 0.24, h * 0.92);
    ctx.lineTo(w * 0.26, h * 0.38);
    ctx.lineTo(w * 0.22, h * 0.55);
    ctx.lineTo(w * 0.08, h * 0.52);
    ctx.lineTo(w * 0.16, h * 0.18);
    ctx.closePath();
  }

  const grad = ctx.createLinearGradient(w * 0.14, 0, w * 0.86, 0);
  grad.addColorStop(0, `rgb(${loR},${loG},${loB})`);
  grad.addColorStop(0.28, `rgb(${r},${g},${b})`);
  grad.addColorStop(0.5, `rgb(${hiR},${hiG},${hiB})`);
  grad.addColorStop(0.74, `rgb(${r},${g},${b})`);
  grad.addColorStop(1, `rgb(${loR},${loG},${loB})`);
  ctx.fillStyle = grad;
  ctx.fill();

  // Clip interior for subtle atelier seams & fabric folds
  ctx.clip();

  // Soft vertical drape highlights
  const foldCount = slot === 'ONE_PIECE' ? 7 : 5;
  for (let i = 0; i < foldCount; i += 1) {
    const x = w * (0.2 + (i / (foldCount - 1)) * 0.6);
    const foldGrad = ctx.createLinearGradient(x - 24, 0, x + 24, 0);
    foldGrad.addColorStop(0, 'rgba(0,0,0,0)');
    foldGrad.addColorStop(0.45, 'rgba(255,255,255,0.08)');
    foldGrad.addColorStop(0.55, 'rgba(0,0,0,0.09)');
    foldGrad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = foldGrad;
    ctx.fillRect(x - 24, 0, 48, h);
  }

  // Subtle woven grain pattern
  ctx.strokeStyle = 'rgba(255,255,255,0.04)';
  ctx.lineWidth = 1;
  for (let y = 0; y < h; y += 6) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }

  // Couture lapel / princess seam accents
  if (slot === 'OUTERWEAR' && !darkerBack) {
    ctx.strokeStyle = `rgba(${loR},${loG},${loB},0.55)`;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(w * 0.5, h * 0.16);
    ctx.lineTo(w * 0.5, h * 0.94);
    ctx.stroke();
  }

  ctx.restore();
  return canvas;
}

/**
 * Cleans light-background halos, performs edge alpha decontamination, and if an
 * image has an opaque studio white/cream background (all 4 corners opaque & bright),
 * executes fast border flood-fill matting so no rectangular card appears in 3D AR.
 */
function decontaminateAndTrimImage(
  source: DrawableImageSource | CanvasLike,
  srcW: number,
  srcH: number,
): {
  canvas: CanvasLike;
  alphaField: Float32Array;
  bounds: GarmentAlphaBounds;
} {
  const fitScale = Math.min(1, MAX_TEXTURE_DIM / Math.max(srcW, srcH, 1));
  const workW = Math.max(8, Math.round(srcW * fitScale));
  const workH = Math.max(8, Math.round(srcH * fitScale));

  const workCanvas = createOffscreenOrDomCanvas(workW, workH);
  const workCtx = get2DContext(workCanvas, true);
  if (!workCtx) {
    return {
      canvas: workCanvas,
      alphaField: new Float32Array(ALPHA_GRID_W * ALPHA_GRID_H).fill(1),
      bounds: {
        cropTop: 0,
        cropBottom: 1,
        cropLeft: 0,
        cropRight: 1,
        aspectRatio: workW / workH,
        width: workW,
        height: workH,
      },
    };
  }

  workCtx.clearRect(0, 0, workW, workH);
  workCtx.drawImage(source as CanvasImageSource, 0, 0, workW, workH);

  let imageData: ImageData;
  try {
    imageData = workCtx.getImageData(0, 0, workW, workH);
  } catch {
    return {
      canvas: workCanvas,
      alphaField: new Float32Array(ALPHA_GRID_W * ALPHA_GRID_H).fill(1),
      bounds: {
        cropTop: 0,
        cropBottom: 1,
        cropLeft: 0,
        cropRight: 1,
        aspectRatio: workW / workH,
        width: workW,
        height: workH,
      },
    };
  }

  const data = imageData.data;
  const totalPx = workW * workH;

  // Check if the source already has real transparency or has an opaque studio backdrop
  const cornerIdx = [
    0,
    workW - 1,
    (workH - 1) * workW,
    workH * workW - 1,
  ];
  let opaqueLightCorners = 0;
  let bgR = 0;
  let bgG = 0;
  let bgB = 0;
  for (const idx of cornerIdx) {
    const o = idx * 4;
    const r = data[o]!;
    const g = data[o + 1]!;
    const b = data[o + 2]!;
    const a = data[o + 3]!;
    const maxC = Math.max(r, g, b);
    const minC = Math.min(r, g, b);
    const luma = 0.299 * r + 0.587 * g + 0.114 * b;
    if (a > 240 && luma > 214 && maxC - minC < 34) {
      opaqueLightCorners += 1;
      bgR += r;
      bgG += g;
      bgB += b;
    }
  }

  if (opaqueLightCorners >= 3) {
    bgR /= opaqueLightCorners;
    bgG /= opaqueLightCorners;
    bgB /= opaqueLightCorners;

    // Fast BFS flood-fill from edges to strip connected light studio backdrop
    const visited = new Uint8Array(totalPx);
    const bgMask = new Uint8Array(totalPx);
    const queue = new Int32Array(totalPx);
    let head = 0;
    let tail = 0;

    const tryEnqueue = (px: number) => {
      if (visited[px]) return;
      const o = px * 4;
      const r = data[o]!;
      const g = data[o + 1]!;
      const b = data[o + 2]!;
      const dist =
        Math.abs(r - bgR) * 0.35 +
        Math.abs(g - bgG) * 0.4 +
        Math.abs(b - bgB) * 0.25;
      const maxC = Math.max(r, g, b);
      const minC = Math.min(r, g, b);
      if (dist < 28 && maxC - minC < 38) {
        visited[px] = 1;
        bgMask[px] = 1;
        queue[tail++] = px;
      }
    };

    for (let x = 0; x < workW; x += 1) {
      tryEnqueue(x);
      tryEnqueue((workH - 1) * workW + x);
    }
    for (let y = 1; y < workH - 1; y += 1) {
      tryEnqueue(y * workW);
      tryEnqueue(y * workW + (workW - 1));
    }

    while (head < tail) {
      const px = queue[head++]!;
      const x = px % workW;
      const y = (px - x) / workW;
      if (x > 0) tryEnqueue(px - 1);
      if (x < workW - 1) tryEnqueue(px + 1);
      if (y > 0) tryEnqueue(px - workW);
      if (y < workH - 1) tryEnqueue(px + workW);
    }

    // Apply soft feathered transparency along boundary of flood-filled background
    for (let i = 0; i < totalPx; i += 1) {
      if (bgMask[i]) {
        data[i * 4 + 3] = 0;
      }
    }
  }

  // Light-background halo cleanup & alpha decontamination on semi-transparent edges
  // Removes pale white/ivory matte bleed (e.g., #F8F5F0) from cutout boundaries
  const matteR = 246;
  const matteG = 243;
  const matteB = 238;

  for (let i = 0; i < totalPx; i += 1) {
    const o = i * 4;
    const a = data[o + 3]!;
    if (a === 0) continue;

    if (a < 18) {
      data[o + 3] = 0;
      continue;
    }

    if (a < 236) {
      const alpha = a / 255;
      const r = data[o]!;
      const g = data[o + 1]!;
      const b = data[o + 2]!;
      const luma = 0.299 * r + 0.587 * g + 0.114 * b;
      const chroma = Math.max(r, g, b) - Math.min(r, g, b);

      // Strip bright low-chroma white fringe pixels
      if (a < 95 && luma > 224 && chroma < 24) {
        data[o + 3] = Math.round(a * 0.25);
        continue;
      }

      // Un-premultiply light studio halo proportionally on partial edge pixels
      const strength = clamp((1 - alpha) * 0.72, 0, 0.68);
      const denom = Math.max(0.28, 1 - strength);
      data[o] = Math.round(clamp((r - matteR * strength) / denom, 0, 255));
      data[o + 1] = Math.round(clamp((g - matteG * strength) / denom, 0, 255));
      data[o + 2] = Math.round(clamp((b - matteB * strength) / denom, 0, 255));
      // Gently firm up antialiased alpha shoulder so WebGL alphaTest stays crisp
      data[o + 3] = Math.round(clamp((alpha - 0.04) / 0.96, 0, 1) * 255);
    }
  }

  workCtx.putImageData(imageData, 0, 0);

  // Scan active fabric alpha bounds
  let minX = workW;
  let maxX = -1;
  let minY = workH;
  let maxY = -1;

  for (let y = 0; y < workH; y += 1) {
    const rowOff = y * workW;
    for (let x = 0; x < workW; x += 1) {
      if (data[(rowOff + x) * 4 + 3]! >= 28) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX <= minX || maxY <= minY) {
    minX = 0;
    maxX = workW - 1;
    minY = 0;
    maxY = workH - 1;
  }

  // Add subtle 2% safe margin around trimmed fabric so UV edges never clip
  const rawCropW = maxX - minX + 1;
  const rawCropH = maxY - minY + 1;
  const padX = Math.max(2, Math.round(rawCropW * 0.02));
  const padY = Math.max(2, Math.round(rawCropH * 0.02));

  const trimX0 = Math.max(0, minX - padX);
  const trimY0 = Math.max(0, minY - padY);
  const trimX1 = Math.min(workW - 1, maxX + padX);
  const trimY1 = Math.min(workH - 1, maxY + padY);
  const trimW = Math.max(4, trimX1 - trimX0 + 1);
  const trimH = Math.max(4, trimY1 - trimY0 + 1);

  const trimmedCanvas = createOffscreenOrDomCanvas(trimW, trimH);
  const trimmedCtx = get2DContext(trimmedCanvas, true);
  if (trimmedCtx) {
    trimmedCtx.clearRect(0, 0, trimW, trimH);
    trimmedCtx.drawImage(
      workCanvas as CanvasImageSource,
      trimX0,
      trimY0,
      trimW,
      trimH,
      0,
      0,
      trimW,
      trimH,
    );
  }

  // Sample normalized alphaField (ALPHA_GRID_W x ALPHA_GRID_H) top-down (row 0 = top)
  const alphaField = new Float32Array(ALPHA_GRID_W * ALPHA_GRID_H);
  const trimImgData = trimmedCtx?.getImageData(0, 0, trimW, trimH);
  if (trimImgData) {
    const tData = trimImgData.data;
    for (let gy = 0; gy < ALPHA_GRID_H; gy += 1) {
      const sy = Math.min(
        trimH - 1,
        Math.floor(((gy + 0.5) / ALPHA_GRID_H) * trimH),
      );
      for (let gx = 0; gx < ALPHA_GRID_W; gx += 1) {
        const sx = Math.min(
          trimW - 1,
          Math.floor(((gx + 0.5) / ALPHA_GRID_W) * trimW),
        );
        alphaField[gy * ALPHA_GRID_W + gx] =
          tData[(sy * trimW + sx) * 4 + 3]! / 255;
      }
    }
  } else {
    alphaField.fill(1);
  }

  return {
    canvas: trimmedCanvas,
    alphaField,
    bounds: {
      cropTop: minY / workH,
      cropBottom: (maxY + 1) / workH,
      cropLeft: minX / workW,
      cropRight: (maxX + 1) / workW,
      aspectRatio: trimW / trimH,
      width: trimW,
      height: trimH,
    },
  };
}

/**
 * Generates tangent-space Normal Map (via 3x3 Sobel luminance gradient + woven micro-relief)
 * and micro-weave Roughness Map on OffscreenCanvas.
 */
function generateProceduralNormalAndRoughnessMaps(
  colorCanvas: CanvasLike,
  profile: FabricPbrProfile,
): {
  normalCanvas: CanvasLike;
  roughnessCanvas: CanvasLike;
} {
  const srcW = colorCanvas.width;
  const srcH = colorCanvas.height;
  // Cap procedural PBR detail map at 512px max for silky 60 FPS texture upload
  const mapScale = Math.min(1, 512 / Math.max(srcW, srcH, 1));
  const w = Math.max(8, Math.round(srcW * mapScale));
  const h = Math.max(8, Math.round(srcH * mapScale));

  const sampleCanvas = createOffscreenOrDomCanvas(w, h);
  const sampleCtx = get2DContext(sampleCanvas, true);
  const normalCanvas = createOffscreenOrDomCanvas(w, h);
  const normalCtx = get2DContext(normalCanvas, false);
  const roughnessCanvas = createOffscreenOrDomCanvas(w, h);
  const roughnessCtx = get2DContext(roughnessCanvas, false);

  if (!sampleCtx || !normalCtx || !roughnessCtx) {
    return { normalCanvas, roughnessCanvas };
  }

  sampleCtx.drawImage(colorCanvas as CanvasImageSource, 0, 0, w, h);
  let srcPixels: Uint8ClampedArray;
  try {
    srcPixels = sampleCtx.getImageData(0, 0, w, h).data;
  } catch {
    return { normalCanvas, roughnessCanvas };
  }

  // Build normalized luminance buffer [0..1]
  const luma = new Float32Array(w * h);
  const alpha = new Float32Array(w * h);
  for (let i = 0; i < w * h; i += 1) {
    const o = i * 4;
    const a = srcPixels[o + 3]! / 255;
    alpha[i] = a;
    luma[i] =
      (0.299 * srcPixels[o]! +
        0.587 * srcPixels[o + 1]! +
        0.114 * srcPixels[o + 2]!) /
      255;
  }

  const normalImg = normalCtx.createImageData(w, h);
  const roughImg = roughnessCtx.createImageData(w, h);
  const nData = normalImg.data;
  const rData = roughImg.data;

  const strength = 2.6 * profile.normalScale;
  const weaveFreq = profile.weaveFrequency;
  const weaveAmp = profile.weaveStrength;
  const baseRough = profile.roughness;

  for (let y = 0; y < h; y += 1) {
    const ym1 = Math.max(0, y - 1);
    const yp1 = Math.min(h - 1, y + 1);
    for (let x = 0; x < w; x += 1) {
      const xm1 = Math.max(0, x - 1);
      const xp1 = Math.min(w - 1, x + 1);
      const idx = y * w + x;
      const o = idx * 4;

      // 3x3 Sobel luminance derivatives
      const tl = luma[ym1 * w + xm1]!;
      const tc = luma[ym1 * w + x]!;
      const tr = luma[ym1 * w + xp1]!;
      const ml = luma[y * w + xm1]!;
      const mr = luma[y * w + xp1]!;
      const bl = luma[yp1 * w + xm1]!;
      const bc = luma[yp1 * w + x]!;
      const br = luma[yp1 * w + xp1]!;

      const gx = -tl - 2 * ml - bl + tr + 2 * mr + br;
      const gy = -tl - 2 * tc - tr + bl + 2 * bc + br;

      // Micro-weave twill/linen thread perturbation
      const wx = Math.sin((x + y * 0.35) * (weaveFreq * 0.085));
      const wy = Math.cos((y - x * 0.25) * (weaveFreq * 0.085));
      const weaveDx = wx * weaveAmp * 0.35;
      const weaveDy = wy * weaveAmp * 0.35;

      const edgeMask = alpha[idx]! > 0.15 ? 1 : 0;
      const nxRaw = (-gx * strength + weaveDx) * edgeMask;
      const nyRaw = (-gy * strength + weaveDy) * edgeMask;
      const nzRaw = 1.0;
      const invLen = 1 / Math.sqrt(nxRaw * nxRaw + nyRaw * nyRaw + nzRaw * nzRaw);

      nData[o] = Math.round((nxRaw * invLen * 0.5 + 0.5) * 255);
      nData[o + 1] = Math.round((nyRaw * invLen * 0.5 + 0.5) * 255);
      nData[o + 2] = Math.round((nzRaw * invLen * 0.5 + 0.5) * 255);
      nData[o + 3] = 255;

      // Roughness map: base roughness + thread weave modulation + crease cavity darkening
      const weaveMod = (wx * wy) * weaveAmp * 0.22;
      const foldCrease = clamp(0.5 - luma[idx]!, -0.25, 0.35) * 0.22;
      const rVal = clamp(baseRough + weaveMod + foldCrease, 0.12, 0.98);
      const rByte = Math.round(rVal * 255);

      rData[o] = rByte;
      rData[o + 1] = rByte;
      rData[o + 2] = rByte;
      rData[o + 3] = 255;
    }
  }

  normalCtx.putImageData(normalImg, 0, 0);
  roughnessCtx.putImageData(roughImg, 0, 0);

  return { normalCanvas, roughnessCanvas };
}

/**
 * Generates a subtly darkened & softened fabric back canvas from the front canvas
 * when a product does not supply a dedicated `backUrl`.
 */
function synthesizeBackFromFrontCanvas(frontCanvas: CanvasLike): CanvasLike {
  const w = frontCanvas.width;
  const h = frontCanvas.height;
  const out = createOffscreenOrDomCanvas(w, h);
  const ctx = get2DContext(out, true);
  if (!ctx) return out;

  ctx.clearRect(0, 0, w, h);
  ctx.save();
  // Mirror horizontally so left/right seam edges align continuously around the 3D shell
  ctx.translate(w, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(frontCanvas as CanvasImageSource, 0, 0, w, h);
  ctx.restore();

  try {
    const imgData = ctx.getImageData(0, 0, w, h);
    const data = imgData.data;
    for (let i = 0; i < w * h; i += 1) {
      const o = i * 4;
      if (data[o + 3]! === 0) continue;
      // Subtle couture back-side depth shading (~14% darker, slightly warmer)
      data[o] = Math.round(data[o]! * 0.87);
      data[o + 1] = Math.round(data[o + 1]! * 0.86);
      data[o + 2] = Math.round(data[o + 2]! * 0.84);
    }
    ctx.putImageData(imgData, 0, 0);
  } catch {
    // Keep mirrored fallback
  }

  return out;
}

function buildCanvasTexture(
  canvas: CanvasLike,
  isColorSRGB: boolean,
): THREE.CanvasTexture {
  const domCanvas = toTextureCanvas(canvas);
  const texture = new THREE.CanvasTexture(domCanvas);
  texture.colorSpace = isColorSRGB
    ? THREE.SRGBColorSpace
    : THREE.NoColorSpace;
  texture.anisotropy = ANISOTROPY_LEVEL;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}

/**
 * Loads front (and optional back) garment textures, removes light-background edge halos,
 * synthesizes tangent-space Normal + micro-weave Roughness PBR maps, and returns
 * a complete disposable `GarmentTextureBundle`.
 */
export async function buildGarmentTextureBundle(
  spec: Pick<
    Garment3DLayerSpec,
    'slot' | 'frontUrl' | 'backUrl' | 'colorHex' | 'fabricComposition' | 'fabricWeight'
  >,
): Promise<GarmentTextureBundle> {
  const profile = resolveFabricPbrProfile(
    spec.fabricComposition,
    spec.fabricWeight,
  );

  const [frontAsset, backAsset] = await Promise.all([
    loadImageSafe(spec.frontUrl),
    spec.backUrl ? loadImageSafe(spec.backUrl) : Promise.resolve(null),
  ]);

  let isStylizedFallback = false;
  let frontTrimmed: ReturnType<typeof decontaminateAndTrimImage>;

  if (frontAsset) {
    try {
      frontTrimmed = decontaminateAndTrimImage(
        frontAsset.source,
        frontAsset.width,
        frontAsset.height,
      );
    } finally {
      frontAsset.cleanup();
    }
  } else {
    isStylizedFallback = true;
    const fallbackCanvas = createStylizedFallbackCanvas(
      spec.slot,
      spec.colorHex,
      false,
    );
    frontTrimmed = decontaminateAndTrimImage(
      fallbackCanvas,
      fallbackCanvas.width,
      fallbackCanvas.height,
    );
  }

  const frontMaps = generateProceduralNormalAndRoughnessMaps(
    frontTrimmed.canvas,
    profile,
  );

  let backCanvas: CanvasLike;
  let hasDedicatedBack = false;

  if (backAsset) {
    try {
      const backTrimmed = decontaminateAndTrimImage(
        backAsset.source,
        backAsset.width,
        backAsset.height,
      );
      backCanvas = backTrimmed.canvas;
      hasDedicatedBack = true;
    } finally {
      backAsset.cleanup();
    }
  } else if (isStylizedFallback) {
    backCanvas = createStylizedFallbackCanvas(spec.slot, spec.colorHex, true);
  } else {
    backCanvas = synthesizeBackFromFrontCanvas(frontTrimmed.canvas);
  }

  const backMaps = generateProceduralNormalAndRoughnessMaps(backCanvas, profile);

  return {
    colorMap: buildCanvasTexture(frontTrimmed.canvas, true),
    normalMap: buildCanvasTexture(frontMaps.normalCanvas, false),
    roughnessMap: buildCanvasTexture(frontMaps.roughnessCanvas, false),
    backColorMap: buildCanvasTexture(backCanvas, true),
    backNormalMap: buildCanvasTexture(backMaps.normalCanvas, false),
    backRoughnessMap: buildCanvasTexture(backMaps.roughnessCanvas, false),
    hasDedicatedBack,
    alphaField: frontTrimmed.alphaField,
    alphaGridW: ALPHA_GRID_W,
    alphaGridH: ALPHA_GRID_H,
    bounds: frontTrimmed.bounds,
    isStylizedFallback,
    sourceUrl: spec.frontUrl,
  };
}

/**
 * Releases every GPU texture owned by a `GarmentTextureBundle` (ZERO WebGL leaks).
 */
export function disposeGarmentTextureBundle(
  bundle: GarmentTextureBundle | null | undefined,
): void {
  if (!bundle) return;
  bundle.colorMap.dispose();
  bundle.normalMap.dispose();
  bundle.roughnessMap.dispose();
  bundle.backColorMap.dispose();
  bundle.backNormalMap.dispose();
  bundle.backRoughnessMap.dispose();
}
