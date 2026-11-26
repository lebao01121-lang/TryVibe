import { OutfitSlot } from '@atelier/contracts';
import {
  getMannequinWidthAt,
  MANNEQUIN_METRICS,
} from './mannequinMetrics';

export type AccessoryArchetype = 'scarf' | 'belt' | 'clutch';
export type NecklineArchetype = 'strapless' | 'spaghetti' | 'shoulder' | 'collared';

export interface GarmentSlice {
  /** Normalized vertical progress t in [0..1] across trimmed fabric height */
  t: number;
  /** Leftmost foreground pixel relative to trimmed garment left edge */
  leftPx: number;
  /** Rightmost foreground pixel relative to trimmed garment left edge */
  rightPx: number;
  /** Fabric width at this slice in trimmed garment pixels */
  widthPx: number;
  /** Horizontal midpoint of fabric in trimmed garment pixels */
  midXPx: number;
  /** Foreground density inside central 32% of slice width (0..1) */
  centerFill: number;
}

export interface ScannedGarmentSilhouette {
  imageUrl: string;
  /** Trimmed, stray-fragment-cleaned crisp RGBA garment canvas */
  cleanCanvas: HTMLCanvasElement;
  cropW: number;
  cropH: number;
  naturalWidth: number;
  naturalHeight: number;
  /** Normalized crop bounds inside original image [0..1] */
  cropTop: number;
  cropBottom: number;
  cropLeft: number;
  cropRight: number;
  /** Highest normalized t where central 20% has solid fabric (detects neckline dip) */
  centerTopT: number;
  /** N = 72 5-point Gaussian smoothed horizontal fabric slices */
  slices: readonly GarmentSlice[];
  /** Removed stray fragment pixel count (shoe tips, border specks) */
  cleanedStrayPixels: number;
}

export interface ProjectedGarmentStrip {
  t0: number;
  t1: number;
  srcY: number;
  srcH: number;
  /** Stage pixel coordinates on canonical 600 × 900 canvas */
  dstY: number;
  dstH: number;
  dstX: number;
  dstW: number;
  /** Projected left/right/center of opaque fabric in normalized [0..1] stage coordinates */
  fabricLeftNorm: number;
  fabricRightNorm: number;
  fabricMidNorm: number;
  stageYNorm: number;
  scaleX: number;
  midXPx: number;
}

export interface FittedGarmentBounds {
  slot: OutfitSlot;
  topY: number;
  bottomY: number;
  leftX: number;
  rightX: number;
  shoulderLeftX: number;
  shoulderRightX: number;
  waistLeftX: number;
  waistRightX: number;
  hipLeftX: number;
  hipRightX: number;
  midY: number;
  /** Vertical torso coverage span for GhostMannequinSvg dynamic occlusion */
  coveredTopY: number;
  coveredBottomY: number;
}

export interface CalibratedGarment {
  slot: OutfitSlot;
  imageUrl: string;
  silhouette: ScannedGarmentSilhouette;
  neckline: NecklineArchetype;
  accessoryType: AccessoryArchetype | null;
  /** Whether outerwear should render parted open to reveal inner ONE_PIECE bodice */
  shoulderDrapeSplit: boolean;
  /** Rigid target rect (used for ACCESSORY) in 600 × 900 stage pixels */
  rigidRect: { x: number; y: number; w: number; h: number } | null;
  /** 72 straightened & envelope-matched strips (used for wearable garments) */
  strips: readonly ProjectedGarmentStrip[];
  bounds: FittedGarmentBounds;
}

export interface CalibrateGarmentInput {
  imageUrl: string;
  slot: OutfitSlot;
  slug?: string;
  productName?: string;
  drapeStyle?: 'shoulder' | 'front';
  face?: 'front' | 'back';
  hasOnePiece?: boolean;
  hasPairedBottom?: boolean;
  /** Optional waist width of paired lower/dress layer so belt hugs outer silhouette */
  outerWaistWidthNorm?: number;
}

const SCAN_W = 240;
const SCAN_H = 360;
const SLICE_COUNT = 72;
const ALPHA_THRESHOLD = 32;
const MAX_CLEAN_DIM = 1080;

const STAGE_W = MANNEQUIN_METRICS.width;
const STAGE_H = MANNEQUIN_METRICS.height;

// Caches: raw CV silhouette scan (per imageUrl) + calibrated strip projection (per context key)
const silhouetteCache = new Map<string, Promise<ScannedGarmentSilhouette | null>>();
const calibrationCache = new Map<string, Promise<CalibratedGarment | null>>();

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function smoothstepCosine(t: number): number {
  const c = clamp(t, 0, 1);
  return 0.5 * (1 - Math.cos(Math.PI * c));
}

/**
 * 5-point Gaussian kernel [1, 4, 6, 4, 1] / 16 with edge clamping.
 */
function gaussianSmooth5(values: readonly number[]): number[] {
  const n = values.length;
  const out = new Array<number>(n);
  for (let i = 0; i < n; i += 1) {
    const vM2 = values[Math.max(0, i - 2)]!;
    const vM1 = values[Math.max(0, i - 1)]!;
    const v0 = values[i]!;
    const vP1 = values[Math.min(n - 1, i + 1)]!;
    const vP2 = values[Math.min(n - 1, i + 2)]!;
    out[i] = (vM2 + 4 * vM1 + 6 * v0 + 4 * vP1 + vP2) / 16;
  }
  return out;
}

/**
 * Wider 7-point Gaussian kernel [1, 6, 15, 20, 15, 6, 1] / 64 for ultra-smooth envelope curves.
 */
function gaussianSmooth7(values: readonly number[]): number[] {
  const n = values.length;
  const out = new Array<number>(n);
  for (let i = 0; i < n; i += 1) {
    const vM3 = values[Math.max(0, i - 3)]!;
    const vM2 = values[Math.max(0, i - 2)]!;
    const vM1 = values[Math.max(0, i - 1)]!;
    const v0 = values[i]!;
    const vP1 = values[Math.min(n - 1, i + 1)]!;
    const vP2 = values[Math.min(n - 1, i + 2)]!;
    const vP3 = values[Math.min(n - 1, i + 3)]!;
    out[i] =
      (vM3 + 6 * vM2 + 15 * vM1 + 20 * v0 + 15 * vP1 + 6 * vP2 + vP3) / 64;
  }
  return out;
}

function loadImageElement(src: string, useAnonymousCors: boolean): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    if (useAnonymousCors) {
      img.crossOrigin = 'anonymous';
    }
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

/**
 * Loads a garment cutout in a CORS-safe manner so `ctx.getImageData()` never
 * throws a SecurityError (even if the browser previously cached the same URL
 * without CORS via a non-CORS wardrobe thumbnail <img>).
 */
async function loadCorsSafeImage(url: string): Promise<{
  img: HTMLImageElement;
  cleanup: () => void;
} | null> {
  if (typeof window === 'undefined' || !url) return null;

  if (url.startsWith('data:') || url.startsWith('blob:')) {
    const img = await loadImageElement(url, false);
    return img ? { img, cleanup: () => {} } : null;
  }

  // Primary path: CORS fetch -> same-origin ObjectURL (immune to non-CORS <img> cache collisions)
  try {
    const res = await fetch(url, { mode: 'cors', credentials: 'omit' });
    if (res.ok) {
      const blob = await res.blob();
      const objectUrl = URL.createObjectURL(blob);
      const img = await loadImageElement(objectUrl, false);
      if (img && img.naturalWidth > 0 && img.naturalHeight > 0) {
        return {
          img,
          cleanup: () => URL.revokeObjectURL(objectUrl),
        };
      }
      URL.revokeObjectURL(objectUrl);
    } else if (res.status >= 400 && res.status < 500) {
      // Definitive client error (e.g. 404 Not Found / 403 / 410): stop immediately
      // instead of amplifying into 2 additional failing <img> / ?atelier_cors=1 requests.
      return null;
    }
  } catch {
    // Network or CORS TypeError — fall through to crossOrigin Image attempts
  }

  // Secondary path: direct anonymous CORS Image load
  const direct = await loadImageElement(url, true);
  if (direct && direct.naturalWidth > 0 && direct.naturalHeight > 0) {
    return { img: direct, cleanup: () => {} };
  }

  // Tertiary path: cache-busted anonymous CORS Image load
  const sep = url.includes('?') ? '&' : '?';
  const busted = await loadImageElement(`${url}${sep}atelier_cors=1`, true);
  if (busted && busted.naturalWidth > 0 && busted.naturalHeight > 0) {
    return { img: busted, cleanup: () => {} };
  }

  return null;
}

/**
 * Step 1: Render onto offscreen 240 × 360 canvas, scan alpha > 32, run fast
 * 4-connected-components stray-fragment removal (isolated islands < 3% area near
 * bottom/side borders such as stray shoe tips), trim 4-side empty margins, and
 * slice into N = 72 Gaussian-smoothed horizontal fabric slices.
 */
export async function scanAlphaSilhouette(
  imageUrl: string,
): Promise<ScannedGarmentSilhouette | null> {
  if (typeof document === 'undefined' || !imageUrl) return null;

  const existing = silhouetteCache.get(imageUrl);
  if (existing) {
    return existing;
  }

  const task = (async (): Promise<ScannedGarmentSilhouette | null> => {
    const loaded = await loadCorsSafeImage(imageUrl);
    if (!loaded) return null;

    const { img, cleanup } = loaded;
    try {
      const natW = img.naturalWidth;
      const natH = img.naturalHeight;
      if (natW < 4 || natH < 4) return null;

      // Preserve original aspect ratio inside 240 × 360 scan frame
      const fitScale = Math.min(SCAN_W / natW, SCAN_H / natH);
      const drawW = Math.max(1, Math.round(natW * fitScale));
      const drawH = Math.max(1, Math.round(natH * fitScale));

      const scanCanvas = document.createElement('canvas');
      scanCanvas.width = drawW;
      scanCanvas.height = drawH;
      const scanCtx = scanCanvas.getContext('2d', { willReadFrequently: true });
      if (!scanCtx) return null;

      scanCtx.clearRect(0, 0, drawW, drawH);
      scanCtx.drawImage(img, 0, 0, drawW, drawH);

      let imgData: ImageData;
      try {
        imgData = scanCtx.getImageData(0, 0, drawW, drawH);
      } catch {
        return null;
      }

      const data = imgData.data;
      const totalPixels = drawW * drawH;
      const fgMask = new Uint8Array(totalPixels);

      let rawMinX = drawW;
      let rawMaxX = -1;
      let rawMinY = drawH;
      let rawMaxY = -1;
      let totalFgArea = 0;

      for (let y = 0; y < drawH; y += 1) {
        const rowOff = y * drawW;
        for (let x = 0; x < drawW; x += 1) {
          const idx = rowOff + x;
          const a = data[idx * 4 + 3]!;
          if (a > ALPHA_THRESHOLD) {
            fgMask[idx] = 1;
            totalFgArea += 1;
            if (x < rawMinX) rawMinX = x;
            if (x > rawMaxX) rawMaxX = x;
            if (y < rawMinY) rawMinY = y;
            if (y > rawMaxY) rawMaxY = y;
          }
        }
      }

      if (totalFgArea < 16 || rawMaxX <= rawMinX || rawMaxY <= rawMinY) {
        return null;
      }

      // Fast 4-connected-components BFS to eliminate stray isolated islands (< 3% area)
      const labels = new Int32Array(totalPixels);
      const queue = new Int32Array(totalPixels);
      const compArea: number[] = [0];
      const compMinX: number[] = [0];
      const compMaxX: number[] = [0];
      const compMinY: number[] = [0];
      const compMaxY: number[] = [0];

      let nextLabel = 0;
      let largestArea = 0;

      for (let i = 0; i < totalPixels; i += 1) {
        if (fgMask[i] === 0 || labels[i] !== 0) continue;
        nextLabel += 1;
        let qHead = 0;
        let qTail = 0;
        queue[qTail++] = i;
        labels[i] = nextLabel;

        let area = 0;
        let cMinX = drawW;
        let cMaxX = -1;
        let cMinY = drawH;
        let cMaxY = -1;

        while (qHead < qTail) {
          const cur = queue[qHead++]!;
          const cx = cur % drawW;
          const cy = (cur - cx) / drawW;
          area += 1;
          if (cx < cMinX) cMinX = cx;
          if (cx > cMaxX) cMaxX = cx;
          if (cy < cMinY) cMinY = cy;
          if (cy > cMaxY) cMaxY = cy;

          if (cx > 0) {
            const nIdx = cur - 1;
            if (fgMask[nIdx] === 1 && labels[nIdx] === 0) {
              labels[nIdx] = nextLabel;
              queue[qTail++] = nIdx;
            }
          }
          if (cx + 1 < drawW) {
            const nIdx = cur + 1;
            if (fgMask[nIdx] === 1 && labels[nIdx] === 0) {
              labels[nIdx] = nextLabel;
              queue[qTail++] = nIdx;
            }
          }
          if (cy > 0) {
            const nIdx = cur - drawW;
            if (fgMask[nIdx] === 1 && labels[nIdx] === 0) {
              labels[nIdx] = nextLabel;
              queue[qTail++] = nIdx;
            }
          }
          if (cy + 1 < drawH) {
            const nIdx = cur + drawW;
            if (fgMask[nIdx] === 1 && labels[nIdx] === 0) {
              labels[nIdx] = nextLabel;
              queue[qTail++] = nIdx;
            }
          }
        }

        compArea.push(area);
        compMinX.push(cMinX);
        compMaxX.push(cMaxX);
        compMinY.push(cMinY);
        compMaxY.push(cMaxY);
        if (area > largestArea) largestArea = area;
      }

      const rawW = Math.max(1, rawMaxX - rawMinX + 1);
      const rawH = Math.max(1, rawMaxY - rawMinY + 1);
      const keepLabel = new Uint8Array(nextLabel + 1);
      let removedAnyComponent = false;

      for (let lbl = 1; lbl <= nextLabel; lbl += 1) {
        const area = compArea[lbl]!;
        const areaFrac = area / totalFgArea;
        if (area === largestArea || areaFrac >= 0.03) {
          keepLabel[lbl] = 1;
          continue;
        }
        const cMinY = compMinY[lbl]!;
        const cMinX = compMinX[lbl]!;
        const cMaxX = compMaxX[lbl]!;
        const nearBottom = cMinY >= rawMaxY - rawH * 0.16;
        const nearSide =
          cMaxX <= rawMinX + rawW * 0.14 || cMinX >= rawMaxX - rawW * 0.14;
        const tinyDust = areaFrac < 0.008;

        if (nearBottom || nearSide || tinyDust) {
          keepLabel[lbl] = 0;
          removedAnyComponent = true;
        } else {
          keepLabel[lbl] = 1;
        }
      }

      // Compute clean 4-side trimmed bounds on kept foreground pixels
      let minX = drawW;
      let maxX = -1;
      let minY = drawH;
      let maxY = -1;
      let cleanedStrayPixels = 0;

      for (let y = 0; y < drawH; y += 1) {
        const rowOff = y * drawW;
        for (let x = 0; x < drawW; x += 1) {
          const idx = rowOff + x;
          const lbl = labels[idx]!;
          if (lbl > 0) {
            if (keepLabel[lbl] === 1) {
              if (x < minX) minX = x;
              if (x > maxX) maxX = x;
              if (y < minY) minY = y;
              if (y > maxY) maxY = y;
            } else {
              fgMask[idx] = 0;
              cleanedStrayPixels += 1;
            }
          }
        }
      }

      if (maxX <= minX || maxY <= minY) {
        minX = rawMinX;
        maxX = rawMaxX;
        minY = rawMinY;
        maxY = rawMaxY;
      }

      // Normalized crop box in original image space [0..1]
      const cropLeft = clamp(minX / drawW, 0, 1);
      const cropRight = clamp((maxX + 1) / drawW, 0, 1);
      const cropTop = clamp(minY / drawH, 0, 1);
      const cropBottom = clamp((maxY + 1) / drawH, 0, 1);

      // Build crisp trimmed full-resolution RGBA garment canvas (capped at MAX_CLEAN_DIM)
      const srcCropX = Math.floor(cropLeft * natW);
      const srcCropY = Math.floor(cropTop * natH);
      const srcCropW = Math.max(2, Math.ceil((cropRight - cropLeft) * natW));
      const srcCropH = Math.max(2, Math.ceil((cropBottom - cropTop) * natH));

      const outScale = Math.min(1, MAX_CLEAN_DIM / Math.max(srcCropW, srcCropH));
      const cropW = Math.max(2, Math.round(srcCropW * outScale));
      const cropH = Math.max(2, Math.round(srcCropH * outScale));

      const cleanCanvas = document.createElement('canvas');
      cleanCanvas.width = cropW;
      cleanCanvas.height = cropH;
      const cleanCtx = cleanCanvas.getContext('2d');
      if (!cleanCtx) return null;

      cleanCtx.clearRect(0, 0, cropW, cropH);
      cleanCtx.drawImage(
        img,
        srcCropX,
        srcCropY,
        srcCropW,
        srcCropH,
        0,
        0,
        cropW,
        cropH,
      );

      // If stray fragments fell inside the trimmed crop box, erase them cleanly
      if (removedAnyComponent && cleanedStrayPixels > 0) {
        const maskW = Math.max(1, maxX - minX + 1);
        const maskH = Math.max(1, maxY - minY + 1);
        const keepCanvas = document.createElement('canvas');
        keepCanvas.width = maskW;
        keepCanvas.height = maskH;
        const keepCtx = keepCanvas.getContext('2d');
        if (keepCtx) {
          const keepImg = keepCtx.createImageData(maskW, maskH);
          const kData = keepImg.data;
          // Dilate keep mask by 1px so semi-transparent anti-aliased fabric edges stay silky
          for (let my = 0; my < maskH; my += 1) {
            const sy = minY + my;
            for (let mx = 0; mx < maskW; mx += 1) {
              const sx = minX + mx;
              let kept = fgMask[sy * drawW + sx] === 1;
              if (!kept) {
                for (let dy = -1; dy <= 1 && !kept; dy += 1) {
                  const ny = sy + dy;
                  if (ny < 0 || ny >= drawH) continue;
                  for (let dx = -1; dx <= 1; dx += 1) {
                    const nx = sx + dx;
                    if (nx < 0 || nx >= drawW) continue;
                    if (fgMask[ny * drawW + nx] === 1) {
                      kept = true;
                      break;
                    }
                  }
                }
              }
              const kIdx = (my * maskW + mx) * 4;
              kData[kIdx] = 255;
              kData[kIdx + 1] = 255;
              kData[kIdx + 2] = 255;
              kData[kIdx + 3] = kept ? 255 : 0;
            }
          }
          keepCtx.putImageData(keepImg, 0, 0);
          cleanCtx.save();
          cleanCtx.globalCompositeOperation = 'destination-in';
          cleanCtx.imageSmoothingEnabled = true;
          cleanCtx.drawImage(keepCanvas, 0, 0, cropW, cropH);
          cleanCtx.restore();
        }
      }

      // Slice trimmed fabric height into N = 72 horizontal slices
      const trimmedScanW = Math.max(1, maxX - minX + 1);
      const trimmedScanH = Math.max(1, maxY - minY + 1);
      const scanToCleanX = cropW / trimmedScanW;

      const rawLeft = new Array<number>(SLICE_COUNT).fill(-1);
      const rawRight = new Array<number>(SLICE_COUNT).fill(-1);
      const rawWidth = new Array<number>(SLICE_COUNT).fill(0);
      const rawMid = new Array<number>(SLICE_COUNT).fill(cropW * 0.5);
      const rawCenterFill = new Array<number>(SLICE_COUNT).fill(0);

      for (let i = 0; i < SLICE_COUNT; i += 1) {
        const y0 = minY + Math.floor((i / SLICE_COUNT) * trimmedScanH);
        const y1 = Math.max(
          y0 + 1,
          minY + Math.ceil(((i + 1) / SLICE_COUNT) * trimmedScanH),
        );
        const clampedY1 = Math.min(maxY + 1, y1);

        let sLeft = drawW;
        let sRight = -1;

        for (let y = y0; y < clampedY1; y += 1) {
          const rowOff = y * drawW;
          for (let x = minX; x <= maxX; x += 1) {
            if (fgMask[rowOff + x] === 1) {
              if (x < sLeft) sLeft = x;
              if (x > sRight) sRight = x;
            }
          }
        }

        if (sRight >= sLeft) {
          const leftInCrop = (sLeft - minX) * scanToCleanX;
          const rightInCrop = (sRight - minX + 1) * scanToCleanX;
          rawLeft[i] = leftInCrop;
          rawRight[i] = rightInCrop;
          rawWidth[i] = Math.max(1, rightInCrop - leftInCrop);
          rawMid[i] = 0.5 * (leftInCrop + rightInCrop);

          // Measure foreground density in central 32% of this slice
          const sSpan = Math.max(1, sRight - sLeft + 1);
          const cStart = Math.floor(sLeft + sSpan * 0.34);
          const cEnd = Math.ceil(sLeft + sSpan * 0.66);
          let cTotal = 0;
          let cHit = 0;
          for (let y = y0; y < clampedY1; y += 1) {
            const rowOff = y * drawW;
            for (let x = cStart; x <= cEnd && x <= maxX; x += 1) {
              cTotal += 1;
              if (fgMask[rowOff + x] === 1) cHit += 1;
            }
          }
          rawCenterFill[i] = cTotal > 0 ? cHit / cTotal : 0;
        }
      }

      // Fill any empty boundary/interior slice via nearest valid neighbor
      for (let i = 0; i < SLICE_COUNT; i += 1) {
        if (rawLeft[i]! >= 0) continue;
        let found = -1;
        for (let d = 1; d < SLICE_COUNT; d += 1) {
          if (i - d >= 0 && rawLeft[i - d]! >= 0) {
            found = i - d;
            break;
          }
          if (i + d < SLICE_COUNT && rawLeft[i + d]! >= 0) {
            found = i + d;
            break;
          }
        }
        if (found >= 0) {
          rawLeft[i] = rawLeft[found]!;
          rawRight[i] = rawRight[found]!;
          rawWidth[i] = rawWidth[found]!;
          rawMid[i] = rawMid[found]!;
          rawCenterFill[i] = rawCenterFill[found]!;
        } else {
          rawLeft[i] = 0;
          rawRight[i] = cropW;
          rawWidth[i] = cropW;
          rawMid[i] = cropW * 0.5;
          rawCenterFill[i] = 1;
        }
      }

      // Apply exact 5-point Gaussian kernel [1, 4, 6, 4, 1] / 16
      const smoothWidth = gaussianSmooth5(rawWidth);
      const smoothMid = gaussianSmooth5(rawMid);
      const smoothCenterFill = gaussianSmooth5(rawCenterFill);

      // Detect highest t where central neckline has solid fabric
      let centerTopT = 0;
      for (let i = 0; i < Math.min(20, SLICE_COUNT); i += 1) {
        if (smoothCenterFill[i]! >= 0.45) {
          centerTopT = i / SLICE_COUNT;
          break;
        }
      }

      const slices: GarmentSlice[] = new Array(SLICE_COUNT);
      for (let i = 0; i < SLICE_COUNT; i += 1) {
        const w = Math.max(1, smoothWidth[i]!);
        const mid = clamp(smoothMid[i]!, 0, cropW);
        slices[i] = {
          t: (i + 0.5) / SLICE_COUNT,
          leftPx: clamp(mid - w * 0.5, 0, cropW),
          rightPx: clamp(mid + w * 0.5, 0, cropW),
          widthPx: w,
          midXPx: mid,
          centerFill: smoothCenterFill[i]!,
        };
      }

      return {
        imageUrl,
        cleanCanvas,
        cropW,
        cropH,
        naturalWidth: natW,
        naturalHeight: natH,
        cropTop,
        cropBottom,
        cropLeft,
        cropRight,
        centerTopT,
        slices,
        cleanedStrayPixels,
      };
    } finally {
      cleanup();
    }
  })();

  silhouetteCache.set(imageUrl, task);
  const resolved = await task;
  if (!resolved) {
    silhouetteCache.delete(imageUrl);
  }
  return resolved;
}

/**
 * Step 2: Compute straightened spine center offset per slice.
 * Locks bust-waist-hip (t in [0..0.58]) dead straight to centerX = 0.50 (0 deg)
 * with straightenFactor = 0.92, decaying smoothly to 0.35 across lower skirt flare.
 */
export function autoStraightenSpine(
  slices: readonly GarmentSlice[],
  slot: OutfitSlot,
): { centerOfMassX: number; residualOffsetPx: number[] } {
  const n = slices.length;
  const torsoEndT = slot === OutfitSlot.BOTTOM ? 0.45 : 0.58;
  const torsoStartT = slot === OutfitSlot.BOTTOM ? 0.02 : 0.06;

  let weightedMidSum = 0;
  let weightSum = 0;
  for (let i = 0; i < n; i += 1) {
    const s = slices[i]!;
    if (s.t >= torsoStartT && s.t <= torsoEndT) {
      const w = Math.max(1, s.widthPx);
      weightedMidSum += s.midXPx * w;
      weightSum += w;
    }
  }

  const centerOfMassX =
    weightSum > 0
      ? weightedMidSum / weightSum
      : slices[Math.floor(n * 0.3)]?.midXPx ?? 0;

  // Smooth raw spine deviation so sudden silhouette notches don't shear fabric texture
  const rawOffsets = slices.map((s) => s.midXPx - centerOfMassX);
  const smoothedOffsets = gaussianSmooth5(rawOffsets);

  const residualOffsetPx = new Array<number>(n);
  for (let i = 0; i < n; i += 1) {
    const t = slices[i]!.t;
    let factor: number;
    if (t <= 0.58) {
      factor = 0.92;
    } else {
      const u = smoothstepCosine((t - 0.58) / 0.42);
      factor = 0.92 * (1 - u) + 0.35 * u;
    }
    // Residual displacement remaining after applying `-spineOffset * factor`
    residualOffsetPx[i] = smoothedOffsets[i]! * (1 - factor);
  }

  return { centerOfMassX, residualOffsetPx };
}

function detectAccessoryArchetype(
  slug: string,
  productName: string,
  aspect: number,
): AccessoryArchetype {
  const hay = `${slug} ${productName}`.toLowerCase();
  if (hay.includes('khăn') || hay.includes('khan') || hay.includes('scarf')) {
    return 'scarf';
  }
  if (
    hay.includes('thắt lưng') ||
    hay.includes('that-lung') ||
    hay.includes('belt') ||
    hay.includes('đai') ||
    aspect > 2.25
  ) {
    return 'belt';
  }
  return 'clutch';
}

interface AnatomicalAnchorPlan {
  neckline: NecklineArchetype;
  targetTopY: number;
  targetBottomY: number;
  /** Optional waist slice tWaist pinned strictly to MANNEQUIN_METRICS.yWaist */
  pinWaistT: number | null;
  /** Highest normalized stage Y where solid torso envelope width matching starts */
  envelopeStartY: number;
  minEnvelopeRatio: number;
  maxWidthNorm: number;
}

/**
 * Step 3: Detect anatomical anchor landmarks & target vertical proportions from
 * the 72-slice silhouette profile + slot + metadata.
 */
export function detectAnatomicalAnchors(
  silhouette: ScannedGarmentSilhouette,
  slot: OutfitSlot,
  meta: {
    slug?: string;
    productName?: string;
    drapeStyle?: 'shoulder' | 'front';
    hasOnePiece?: boolean;
    hasPairedBottom?: boolean;
  },
): AnatomicalAnchorPlan {
  const { slices, cropW, cropH, centerTopT } = silhouette;
  const aspect = cropW / Math.max(1, cropH);
  const hay = `${meta.slug ?? ''} ${meta.productName ?? ''}`.toLowerCase();

  // Measure top width ratio: width(0.05) / max(width(0.12..0.30))
  const idx05 = clamp(Math.round(0.05 * (slices.length - 1)), 0, slices.length - 1);
  const topWidth05 =
    (slices[Math.max(0, idx05 - 1)]!.widthPx +
      slices[idx05]!.widthPx +
      slices[Math.min(slices.length - 1, idx05 + 1)]!.widthPx) /
    3;

  let upperMaxW = 1;
  for (const s of slices) {
    if (s.t >= 0.12 && s.t <= 0.30) {
      if (s.widthPx > upperMaxW) upperMaxW = s.widthPx;
    }
  }
  const topWidthRatio = topWidth05 / upperMaxW;

  if (slot === OutfitSlot.ONE_PIECE) {
    const isAoDai = hay.includes('ao-dai') || hay.includes('áo dài');
    const isExplicitStraplessOrCowl =
      hay.includes('cổ đổ') ||
      hay.includes('co-do') ||
      hay.includes('cúp ngực') ||
      hay.includes('cup-nguc') ||
      hay.includes('strapless') ||
      hay.includes('hai dây') ||
      hay.includes('hai-day');
    const isSleevedKeyword =
      isAoDai ||
      hay.includes('cổ vuông') ||
      hay.includes('co-vuong') ||
      hay.includes('tay') ||
      hay.includes('sơ mi') ||
      hay.includes('linen');

    let neckline: NecklineArchetype;
    let targetTopY: number;
    let envelopeStartY: number;

    if (isAoDai || (!isExplicitStraplessOrCowl && topWidthRatio < 0.44)) {
      neckline = 'collared';
      targetTopY = MANNEQUIN_METRICS.yNeckBase; // 0.168
      envelopeStartY = MANNEQUIN_METRICS.yShoulder; // 0.205
    } else if (isExplicitStraplessOrCowl && centerTopT >= 0.06) {
      // Cowl / spaghetti-strap gown with open strap valley at top
      neckline = 'spaghetti';
      targetTopY = MANNEQUIN_METRICS.yShoulder + 0.008; // straps rest on shoulders, bust lands at yUpperBust
      envelopeStartY = MANNEQUIN_METRICS.yUpperBust;
    } else if (
      isExplicitStraplessOrCowl ||
      (!isSleevedKeyword && topWidthRatio >= 0.64 && centerTopT < 0.05)
    ) {
      neckline = 'strapless';
      targetTopY = MANNEQUIN_METRICS.yUpperBust; // 0.252
      envelopeStartY = MANNEQUIN_METRICS.yUpperBust;
    } else {
      neckline = 'shoulder';
      targetTopY = MANNEQUIN_METRICS.yShoulder - 0.012; // 0.193
      envelopeStartY = MANNEQUIN_METRICS.yUpperBust - 0.01;
    }

    // Locate narrowest waist slice tWaist in [0.15, 0.42]
    let bestWaistIdx = Math.round(0.28 * (slices.length - 1));
    let minWaistW = Number.POSITIVE_INFINITY;
    for (let i = 0; i < slices.length; i += 1) {
      const s = slices[i]!;
      if (s.t >= 0.15 && s.t <= 0.42 && s.widthPx < minWaistW) {
        minWaistW = s.widthPx;
        bestWaistIdx = i;
      }
    }
    const rawWaistT = slices[bestWaistIdx]!.t;
    // Clamp waist t to realistic bodice ratio so non-cinched shift/A-line dresses never stretch wildly
    const pinWaistT =
      neckline === 'strapless'
        ? clamp(rawWaistT, 0.20, 0.34)
        : clamp(rawWaistT, 0.24, 0.39);

    // Proportional hem extension into [yMidi .. yMaxi] (0.745 .. 0.885)
    const upperBodySpan = MANNEQUIN_METRICS.yWaist - targetTopY;
    const naturalTotalSpan = upperBodySpan / pinWaistT;
    const isMidiKeyword = hay.includes('midi');
    const isEveningGown =
      hay.includes('dạ tiệc') ||
      hay.includes('da-tiec') ||
      hay.includes('maxi') ||
      isAoDai;

    const minHem = isEveningGown ? 0.825 : MANNEQUIN_METRICS.yMidi;
    const maxHem = isMidiKeyword ? 0.805 : MANNEQUIN_METRICS.yMaxi;
    const targetBottomY = clamp(targetTopY + naturalTotalSpan, minHem, maxHem);

    return {
      neckline,
      targetTopY,
      targetBottomY,
      pinWaistT,
      envelopeStartY,
      minEnvelopeRatio: 1.08,
      maxWidthNorm: 0.72,
    };
  }

  if (slot === OutfitSlot.TOP) {
    const isStraplessTop =
      hay.includes('cúp ngực') ||
      hay.includes('hai dây') ||
      hay.includes('cami') ||
      hay.includes('strapless') ||
      (topWidthRatio >= 0.76 && centerTopT < 0.04);

    const neckline: NecklineArchetype = isStraplessTop ? 'strapless' : 'collared';
    const targetTopY = isStraplessTop ? 0.245 : MANNEQUIN_METRICS.yNeckBase;
    // Tucked smoothly behind BOTTOM waistband (0.410) when paired, or draped to hip (0.515) solo
    const targetBottomY = meta.hasPairedBottom ? 0.445 : 0.515;

    return {
      neckline,
      targetTopY,
      targetBottomY,
      pinWaistT: null,
      envelopeStartY: isStraplessTop
        ? MANNEQUIN_METRICS.yUpperBust
        : MANNEQUIN_METRICS.yShoulder,
      minEnvelopeRatio: 1.08,
      maxWidthNorm: 0.64,
    };
  }

  if (slot === OutfitSlot.BOTTOM) {
    const isMidiSkirtOrCulotte =
      hay.includes('midi') ||
      hay.includes('chân váy') ||
      hay.includes('chan-vay') ||
      hay.includes('culottes');

    const targetTopY = 0.410; // Pinned strictly to waistband yWaist = 0.410
    const naturalH = clamp(0.28 / Math.max(0.32, aspect), 0.34, 0.48);
    const targetBottomY = isMidiSkirtOrCulotte
      ? clamp(targetTopY + naturalH, MANNEQUIN_METRICS.yMidi, 0.815)
      : clamp(targetTopY + naturalH, 0.835, MANNEQUIN_METRICS.yMaxi);

    return {
      neckline: 'shoulder',
      targetTopY,
      targetBottomY,
      pinWaistT: null,
      envelopeStartY: 0.410,
      minEnvelopeRatio: 1.08,
      maxWidthNorm: 0.68,
    };
  }

  // OUTERWEAR (blazer, cardigan, tweed jacket, trench coat)
  const isTrench = hay.includes('trench') || hay.includes('măng tô');
  const isShoulderDrape =
    (meta.drapeStyle ?? (meta.hasOnePiece ? 'shoulder' : 'front')) === 'shoulder';
  const targetTopY = isShoulderDrape ? 0.194 : 0.188;
  const targetBottomY = isTrench ? 0.785 : 0.585;

  return {
    neckline: 'collared',
    targetTopY,
    targetBottomY,
    pinWaistT: null,
    envelopeStartY: MANNEQUIN_METRICS.yShoulder,
    minEnvelopeRatio: isShoulderDrape ? 1.15 : 1.13,
    maxWidthNorm: 0.74,
  };
}

/**
 * Smooth vertical mapping t in [0..1] -> stageY in [targetTopY..targetBottomY],
 * optionally pinning tWaist strictly to MANNEQUIN_METRICS.yWaist = 0.415.
 */
function mapNormalizedTToStageY(
  t: number,
  targetTopY: number,
  targetBottomY: number,
  pinWaistT: number | null,
): number {
  const cT = clamp(t, 0, 1);
  if (pinWaistT === null || pinWaistT <= 0.05 || pinWaistT >= 0.95) {
    return targetTopY + cT * (targetBottomY - targetTopY);
  }

  const yW = MANNEQUIN_METRICS.yWaist;
  if (cT <= pinWaistT) {
    return targetTopY + (cT / pinWaistT) * (yW - targetTopY);
  }
  return yW + ((cT - pinWaistT) / (1 - pinWaistT)) * (targetBottomY - yW);
}

function sampleEdgeAtY(
  strips: readonly ProjectedGarmentStrip[],
  targetY: number,
  fallbackLeft: number,
  fallbackRight: number,
): { leftX: number; rightX: number } {
  let best: ProjectedGarmentStrip | null = null;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const s of strips) {
    const dist = Math.abs(s.stageYNorm - targetY);
    if (dist < bestDist) {
      bestDist = dist;
      best = s;
    }
  }
  if (!best || bestDist > 0.09) {
    return { leftX: fallbackLeft, rightX: fallbackRight };
  }
  return { leftX: best.fabricLeftNorm, rightX: best.fabricRightNorm };
}

/**
 * Complete AutoFit calibration pipeline (cached in Map for < 10ms @ 60fps).
 */
export async function calibrateGarment(
  input: CalibrateGarmentInput,
): Promise<CalibratedGarment | null> {
  if (!input.imageUrl) return null;

  const face = input.face ?? 'front';
  const effectiveDrape =
    input.slot === OutfitSlot.OUTERWEAR
      ? input.drapeStyle ?? (input.hasOnePiece ? 'shoulder' : 'front')
      : 'front';
  const waistHint = input.outerWaistWidthNorm
    ? input.outerWaistWidthNorm.toFixed(3)
    : '0';

  const cacheKey = [
    input.imageUrl,
    input.slot,
    face,
    effectiveDrape,
    input.hasOnePiece ? '1' : '0',
    input.hasPairedBottom ? '1' : '0',
    waistHint,
    input.slug ?? '',
  ].join('|');

  const cached = calibrationCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const task = (async (): Promise<CalibratedGarment | null> => {
    const silhouette = await scanAlphaSilhouette(input.imageUrl);
    if (!silhouette) return null;

    const { cropW, cropH, slices } = silhouette;
    const aspect = cropW / Math.max(1, cropH);

    // ACCESSORY: precise anatomical anchor without distorting rigid bags/belts
    if (input.slot === OutfitSlot.ACCESSORY) {
      const accType = detectAccessoryArchetype(
        input.slug ?? '',
        input.productName ?? '',
        aspect,
      );

      let cxNorm: number;
      let cyNorm: number;
      let targetWNorm: number;
      let maxHNorm = 0.28;

      if (accType === 'scarf') {
        cxNorm = MANNEQUIN_METRICS.centerX;
        cyNorm = 0.235;
        targetWNorm = 0.24;
      } else if (accType === 'belt') {
        if (aspect < 2.2) {
          // Coiled belt studio cutout -> compact side waist/hip accent so torso stays crisp
          cxNorm = face === 'back' ? 0.345 : 0.655;
          cyNorm = 0.455;
          targetWNorm = 0.145;
          maxHNorm = 0.115;
        } else {
          // Flat horizontal belt strap -> centered cleanly across exact waist
          cxNorm = MANNEQUIN_METRICS.centerX;
          cyNorm = MANNEQUIN_METRICS.yWaist;
          const baseBeltW = MANNEQUIN_METRICS.wWaist * 1.08;
          targetWNorm = Math.max(
            baseBeltW,
            (input.outerWaistWidthNorm ?? baseBeltW) * 1.03,
          );
          maxHNorm = 0.07;
        }
      } else {
        // Clutch / evening bag at right hip (mirrored on back view)
        cxNorm = face === 'back' ? 1 - 0.655 : 0.655;
        cyNorm = MANNEQUIN_METRICS.yHip;
        targetWNorm = 0.165;
      }

      const safeAspect = Math.max(0.25, aspect);
      const maxHPx = STAGE_H * maxHNorm;
      let drawW = targetWNorm * STAGE_W;
      let drawH = drawW / safeAspect;
      if (drawH > maxHPx) {
        drawH = maxHPx;
        drawW = drawH * safeAspect;
      }
      drawH = Math.max(22, drawH);
      const drawX = cxNorm * STAGE_W - drawW * 0.5;
      const drawY = cyNorm * STAGE_H - drawH * 0.5;

      const leftX = clamp(drawX / STAGE_W, 0.04, 0.96);
      const rightX = clamp((drawX + drawW) / STAGE_W, 0.04, 0.96);
      const topY = clamp(drawY / STAGE_H, 0.05, 0.95);
      const bottomY = clamp((drawY + drawH) / STAGE_H, 0.05, 0.95);

      return {
        slot: input.slot,
        imageUrl: input.imageUrl,
        silhouette,
        neckline: 'shoulder',
        accessoryType: accType,
        shoulderDrapeSplit: false,
        rigidRect: { x: drawX, y: drawY, w: drawW, h: drawH },
        strips: [],
        bounds: {
          slot: input.slot,
          topY,
          bottomY,
          leftX,
          rightX,
          shoulderLeftX: leftX,
          shoulderRightX: rightX,
          waistLeftX: leftX,
          waistRightX: rightX,
          hipLeftX: leftX,
          hipRightX: rightX,
          midY: (topY + bottomY) * 0.5,
          coveredTopY: topY,
          coveredBottomY: bottomY,
        },
      };
    }

    // Wearable garments: Step 2 spine straightening + Step 3 anchors + Step 4 envelope matching
    const { residualOffsetPx } = autoStraightenSpine(slices, input.slot);
    const plan = detectAnatomicalAnchors(silhouette, input.slot, {
      slug: input.slug,
      productName: input.productName,
      drapeStyle: effectiveDrape,
      hasOnePiece: input.hasOnePiece,
      hasPairedBottom: input.hasPairedBottom,
    });

    const shoulderDrapeSplit =
      input.slot === OutfitSlot.OUTERWEAR &&
      effectiveDrape === 'shoulder' &&
      Boolean(input.hasOnePiece) &&
      face === 'front';

    // Base uniform scale derived from natural vertical mapping
    const totalStageH = (plan.targetBottomY - plan.targetTopY) * STAGE_H;
    const baseScale = totalStageH / Math.max(1, cropH);

    // Prevent unusually wide flat-lay images from overflowing stage width while keeping natural flare
    let maxNaturalWidthNorm = 0;
    for (const s of slices) {
      const wn = (s.widthPx * baseScale) / STAGE_W;
      if (wn > maxNaturalWidthNorm) maxNaturalWidthNorm = wn;
    }
    const uniformScaleX =
      maxNaturalWidthNorm > plan.maxWidthNorm
        ? baseScale * (plan.maxWidthNorm / maxNaturalWidthNorm)
        : baseScale;

    // Step 4: Compute per-slice envelope width boost so ZERO mannequin wire ever pokes out
    const rawBoost = new Array<number>(SLICE_COUNT).fill(1);
    const stageYs = new Array<number>(SLICE_COUNT);

    for (let i = 0; i < SLICE_COUNT; i += 1) {
      const s = slices[i]!;
      const yNorm = mapNormalizedTToStageY(
        s.t,
        plan.targetTopY,
        plan.targetBottomY,
        plan.pinWaistT,
      );
      stageYs[i] = yNorm;

      const naturalWidthNorm = (s.widthPx * uniformScaleX) / STAGE_W;

      let reqWidthNorm = 0;
      if (yNorm >= plan.envelopeStartY && yNorm <= MANNEQUIN_METRICS.yTorsoEnd) {
        const manW = getMannequinWidthAt(yNorm);
        // Only apply shoulder/upper-chest envelope when slice isn't thin spaghetti straps
        const isThinStraps =
          plan.neckline === 'spaghetti' &&
          yNorm < MANNEQUIN_METRICS.yUpperBust &&
          s.centerFill < 0.35;
        if (!isThinStraps && manW > 0) {
          reqWidthNorm = manW * plan.minEnvelopeRatio;
        }
      } else if (
        yNorm > MANNEQUIN_METRICS.yTorsoEnd &&
        yNorm < MANNEQUIN_METRICS.yTorsoEnd + 0.11
      ) {
        // Smooth cosine release below yTorsoEnd so flared/pencil hems have zero kink
        const releaseU = smoothstepCosine(
          (yNorm - MANNEQUIN_METRICS.yTorsoEnd) / 0.11,
        );
        const endReq = getMannequinWidthAt(MANNEQUIN_METRICS.yTorsoEnd) * plan.minEnvelopeRatio;
        reqWidthNorm = endReq * (1 - releaseU);
      }

      if (reqWidthNorm > 0 && naturalWidthNorm > 0.04) {
        const boost = reqWidthNorm / naturalWidthNorm;
        rawBoost[i] = clamp(Math.max(1, boost), 1, 1.72);
      }
    }

    // Upper-envelope Gaussian smoothing: silky smooth scaleX(y) that NEVER dips below required minimum
    const smoothedBoost = gaussianSmooth7(rawBoost);
    const finalBoost = new Array<number>(SLICE_COUNT);
    for (let i = 0; i < SLICE_COUNT; i += 1) {
      finalBoost[i] = Math.max(rawBoost[i]!, smoothedBoost[i]!);
    }
    const gentleFinalBoost = gaussianSmooth5(finalBoost);
    for (let i = 0; i < SLICE_COUNT; i += 1) {
      // Strictly protect bust, waist, hip torso coverage after final smoothing pass
      const yNorm = stageYs[i]!;
      const protect =
        yNorm >= plan.envelopeStartY && yNorm <= MANNEQUIN_METRICS.yTorsoEnd;
      finalBoost[i] = protect
        ? Math.max(rawBoost[i]!, gentleFinalBoost[i]!)
        : gentleFinalBoost[i]!;
    }

    // Build 72 projected strips in 600 × 900 canonical stage coordinates
    const strips: ProjectedGarmentStrip[] = new Array(SLICE_COUNT);
    let minLeftNorm = 1;
    let maxRightNorm = 0;

    for (let i = 0; i < SLICE_COUNT; i += 1) {
      const s = slices[i]!;
      const t0 = i / SLICE_COUNT;
      const t1 = (i + 1) / SLICE_COUNT;
      const y0Norm = mapNormalizedTToStageY(
        t0,
        plan.targetTopY,
        plan.targetBottomY,
        plan.pinWaistT,
      );
      const y1Norm = mapNormalizedTToStageY(
        t1,
        plan.targetTopY,
        plan.targetBottomY,
        plan.pinWaistT,
      );

      const scaleX = uniformScaleX * finalBoost[i]!;
      // Lock bust–waist–hip dead straight to centerX = 0.50 with graceful skirt residual
      const centerXStagePx =
        MANNEQUIN_METRICS.centerX * STAGE_W + residualOffsetPx[i]! * uniformScaleX;

      const dstX = centerXStagePx - s.midXPx * scaleX;
      const dstW = cropW * scaleX;
      const dstY = y0Norm * STAGE_H;
      const dstH = Math.max(1, (y1Norm - y0Norm) * STAGE_H);

      const halfFabricW = (s.widthPx * scaleX) * 0.5;
      const fabricLeftNorm = clamp((centerXStagePx - halfFabricW) / STAGE_W, 0.03, 0.97);
      const fabricRightNorm = clamp((centerXStagePx + halfFabricW) / STAGE_W, 0.03, 0.97);
      const fabricMidNorm = clamp(centerXStagePx / STAGE_W, 0.05, 0.95);

      if (fabricLeftNorm < minLeftNorm) minLeftNorm = fabricLeftNorm;
      if (fabricRightNorm > maxRightNorm) maxRightNorm = fabricRightNorm;

      strips[i] = {
        t0,
        t1,
        srcY: t0 * cropH,
        srcH: Math.max(1, (t1 - t0) * cropH),
        dstY,
        dstH,
        dstX,
        dstW,
        fabricLeftNorm,
        fabricRightNorm,
        fabricMidNorm,
        stageYNorm: stageYs[i]!,
        scaleX,
        midXPx: s.midXPx,
      };
    }

    const shoulderEdges = sampleEdgeAtY(
      strips,
      Math.max(plan.targetTopY + 0.02, MANNEQUIN_METRICS.yShoulder),
      minLeftNorm,
      maxRightNorm,
    );
    const waistEdges = sampleEdgeAtY(
      strips,
      MANNEQUIN_METRICS.yWaist,
      minLeftNorm,
      maxRightNorm,
    );
    const hipEdges = sampleEdgeAtY(
      strips,
      MANNEQUIN_METRICS.yHip,
      minLeftNorm,
      maxRightNorm,
    );

    // If shoulder-draped outerwear is parted, outer shoulder span expands gently
    const outerSpread = shoulderDrapeSplit ? 0.025 : 0;

    const bounds: FittedGarmentBounds = {
      slot: input.slot,
      topY: plan.targetTopY,
      bottomY: plan.targetBottomY,
      leftX: clamp(minLeftNorm - outerSpread, 0.04, 0.96),
      rightX: clamp(maxRightNorm + outerSpread, 0.04, 0.96),
      shoulderLeftX: clamp(shoulderEdges.leftX - outerSpread, 0.04, 0.96),
      shoulderRightX: clamp(shoulderEdges.rightX + outerSpread, 0.04, 0.96),
      waistLeftX: clamp(waistEdges.leftX - outerSpread, 0.04, 0.96),
      waistRightX: clamp(waistEdges.rightX + outerSpread, 0.04, 0.96),
      hipLeftX: clamp(hipEdges.leftX - outerSpread, 0.04, 0.96),
      hipRightX: clamp(hipEdges.rightX + outerSpread, 0.04, 0.96),
      midY: (plan.targetTopY + plan.targetBottomY) * 0.5,
      coveredTopY:
        plan.neckline === 'spaghetti'
          ? MANNEQUIN_METRICS.yUpperBust
          : plan.targetTopY,
      coveredBottomY: plan.targetBottomY,
    };

    return {
      slot: input.slot,
      imageUrl: input.imageUrl,
      silhouette,
      neckline: plan.neckline,
      accessoryType: null,
      shoulderDrapeSplit,
      rigidRect: null,
      strips,
      bounds,
    };
  })();

  calibrationCache.set(cacheKey, task);
  const resolved = await task;
  if (!resolved) {
    calibrationCache.delete(cacheKey);
  }
  return resolved;
}

/**
 * Draws a calibrated garment cleanly onto a target 600 × 900 canvas context.
 * Uses a dedicated offscreen buffer canvas so all 72 strips (with 1.5px bleed
 * overlap) composite into a single silk-smooth layer before applying the studio
 * drop shadow — eliminating horizontal strip shadow banding.
 */
export function drawCalibratedGarment(
  targetCtx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  calibrated: CalibratedGarment,
  options: {
    bufferCanvas?: HTMLCanvasElement | null;
    shadowBlur?: number;
    shadowOffsetY?: number;
    shadowAlpha?: number;
  } = {},
): void {
  const { silhouette, rigidRect, strips, shoulderDrapeSplit } = calibrated;
  const src = silhouette.cleanCanvas;

  // Rigid accessory placement (clutch, belt, scarf)
  if (rigidRect) {
    targetCtx.save();
    const isSideAccent =
      calibrated.accessoryType === 'clutch' ||
      (calibrated.accessoryType === 'belt' &&
        Math.abs((rigidRect.x + rigidRect.w * 0.5) / STAGE_W - 0.5) > 0.08);
    targetCtx.shadowColor = isSideAccent
      ? 'rgba(28, 20, 16, 0.26)'
      : 'rgba(28, 20, 16, 0.16)';
    targetCtx.shadowBlur = isSideAccent ? 20 : 12;
    targetCtx.shadowOffsetX = isSideAccent ? -4 : 0;
    targetCtx.shadowOffsetY = isSideAccent ? 12 : 6;
    targetCtx.imageSmoothingEnabled = true;
    targetCtx.imageSmoothingQuality = 'high';
    targetCtx.drawImage(src, rigidRect.x, rigidRect.y, rigidRect.w, rigidRect.h);
    targetCtx.restore();
    return;
  }

  // Render all 72 strips onto a clean un-shadowed 600 × 900 buffer first
  let layerCanvas = options.bufferCanvas ?? null;
  if (!layerCanvas && typeof document !== 'undefined') {
    layerCanvas = document.createElement('canvas');
    layerCanvas.width = STAGE_W;
    layerCanvas.height = STAGE_H;
  }

  const drawStripsInto = (
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  ) => {
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    const bleedPx = 1.5;

    if (!shoulderDrapeSplit) {
      for (let i = 0; i < strips.length; i += 1) {
        const st = strips[i]!;
        const isLast = i === strips.length - 1;
        ctx.drawImage(
          src,
          0,
          st.srcY,
          silhouette.cropW,
          st.srcH,
          st.dstX,
          st.dstY,
          st.dstW,
          isLast ? st.dstH : st.dstH + bleedPx,
        );
      }
      return;
    }

    // Couture shoulder-drape parting over ONE_PIECE:
    // Smoothly opens left & right blazer fronts downward from bust so the inner
    // evening bodice remains visibly regal while shoulders fit impeccably.
    const cx = MANNEQUIN_METRICS.centerX * STAGE_W;
    const partStartY = MANNEQUIN_METRICS.yShoulder + 0.015;
    const partFullY = MANNEQUIN_METRICS.yBust + 0.06;

    for (let i = 0; i < strips.length; i += 1) {
      const st = strips[i]!;
      const isLast = i === strips.length - 1;
      const drawH = isLast ? st.dstH : st.dstH + bleedPx;
      const openProgress = smoothstepCosine(
        (st.stageYNorm - partStartY) / Math.max(0.01, partFullY - partStartY),
      );

      if (openProgress <= 0.02) {
        // Upper shoulder collar wraps cleanly behind neck/shoulders
        ctx.drawImage(
          src,
          0,
          st.srcY,
          silhouette.cropW,
          st.srcH,
          st.dstX,
          st.dstY,
          st.dstW,
          drawH,
        );
        continue;
      }

      // Open gap widens gently down the bodice (~56px half-gap -> ~112px crimson showcase window)
      const lowerEase = smoothstepCosine(
        (st.stageYNorm - partFullY) / Math.max(0.05, 0.585 - partFullY),
      );
      const halfGapPx = openProgress * (46 + lowerEase * 14);
      const panelCompress = 1 - openProgress * 0.16;

      const splitSrcX = clamp(st.midXPx, 1, silhouette.cropW - 1);
      const leftSrcW = splitSrcX;
      const rightSrcW = silhouette.cropW - splitSrcX;

      const leftDstW = leftSrcW * st.scaleX * panelCompress;
      const rightDstW = rightSrcW * st.scaleX * panelCompress;

      const leftDstX = cx - halfGapPx - leftDstW;
      const rightDstX = cx + halfGapPx;

      // Left draped blazer front + sleeve
      ctx.drawImage(
        src,
        0,
        st.srcY,
        leftSrcW,
        st.srcH,
        leftDstX,
        st.dstY,
        leftDstW,
        drawH,
      );

      // Right draped blazer front + sleeve
      ctx.drawImage(
        src,
        splitSrcX,
        st.srcY,
        rightSrcW,
        st.srcH,
        rightDstX,
        st.dstY,
        rightDstW,
        drawH,
      );

      // Subtle tailored lapel inner edge depth along the parted front edges
      const edgeW = Math.min(7, leftDstW * 0.12);
      if (edgeW > 1) {
        ctx.save();
        ctx.globalCompositeOperation = 'source-atop';
        const leftGrad = ctx.createLinearGradient(
          cx - halfGapPx - edgeW,
          0,
          cx - halfGapPx,
          0,
        );
        leftGrad.addColorStop(0, 'rgba(28, 20, 16, 0)');
        leftGrad.addColorStop(1, 'rgba(28, 20, 16, 0.18)');
        ctx.fillStyle = leftGrad;
        ctx.fillRect(cx - halfGapPx - edgeW, st.dstY, edgeW, drawH);

        const rightGrad = ctx.createLinearGradient(
          cx + halfGapPx,
          0,
          cx + halfGapPx + edgeW,
          0,
        );
        rightGrad.addColorStop(0, 'rgba(28, 20, 16, 0.18)');
        rightGrad.addColorStop(1, 'rgba(28, 20, 16, 0)');
        ctx.fillStyle = rightGrad;
        ctx.fillRect(cx + halfGapPx, st.dstY, edgeW, drawH);
        ctx.restore();
      }
    }
  };

  if (layerCanvas) {
    const layerCtx = layerCanvas.getContext('2d');
    if (layerCtx) {
      layerCtx.clearRect(0, 0, STAGE_W, STAGE_H);
      drawStripsInto(layerCtx);

      targetCtx.save();
      const alpha = options.shadowAlpha ?? (shoulderDrapeSplit ? 0.24 : 0.17);
      targetCtx.shadowColor = `rgba(28, 20, 16, ${alpha})`;
      targetCtx.shadowBlur = options.shadowBlur ?? (shoulderDrapeSplit ? 22 : 18);
      targetCtx.shadowOffsetX = 0;
      targetCtx.shadowOffsetY = options.shadowOffsetY ?? (shoulderDrapeSplit ? 13 : 10);
      targetCtx.drawImage(layerCanvas, 0, 0, STAGE_W, STAGE_H);
      targetCtx.restore();
      return;
    }
  }

  // Fallback direct draw (OffscreenCanvas environments without DOM buffer)
  targetCtx.save();
  drawStripsInto(targetCtx);
  targetCtx.restore();
}

/**
 * Draws the 3D Inner Neckline Back-Wrap Shadow (curved dark crescent tucked
 * right behind the top neckline/strapless bust edge where fabric wraps around
 * the mannequin torso).
 */
export function drawInnerNecklineBackWrapShadow(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  calibrated: CalibratedGarment,
): void {
  if (calibrated.slot === OutfitSlot.ACCESSORY || calibrated.slot === OutfitSlot.BOTTOM) {
    return;
  }
  const topStrip = calibrated.strips[2] ?? calibrated.strips[0];
  if (!topStrip) return;

  const leftPx = topStrip.fabricLeftNorm * STAGE_W;
  const rightPx = topStrip.fabricRightNorm * STAGE_W;
  const spanPx = rightPx - leftPx;
  if (spanPx < 24) return;

  const cx = (leftPx + rightPx) * 0.5;
  const topPx = calibrated.bounds.coveredTopY * STAGE_H;
  const archDepth = calibrated.neckline === 'strapless' ? 11 : 14;

  ctx.save();
  const grad = ctx.createRadialGradient(
    cx,
    topPx + 4,
    spanPx * 0.08,
    cx,
    topPx + 2,
    spanPx * 0.54,
  );
  grad.addColorStop(0, 'rgba(28, 20, 16, 0.28)');
  grad.addColorStop(0.65, 'rgba(28, 20, 16, 0.13)');
  grad.addColorStop(1, 'rgba(28, 20, 16, 0)');

  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.moveTo(leftPx + spanPx * 0.08, topPx + 6);
  ctx.quadraticCurveTo(cx, topPx - archDepth, rightPx - spanPx * 0.08, topPx + 6);
  ctx.quadraticCurveTo(cx, topPx + 14, leftPx + spanPx * 0.08, topPx + 6);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/**
 * Draws the Soft Contact Floor / Pedestal Shadow grounding the silhouette onto
 * the vintage brass tripod base.
 */
export function drawStagePedestalContactShadow(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  maxGarmentBottomY: number,
): void {
  if (maxGarmentBottomY <= 0) return;

  const cx = MANNEQUIN_METRICS.centerX * STAGE_W;
  const standFloorY = MANNEQUIN_METRICS.yStandEnd * STAGE_H;

  ctx.save();
  // Grounded soft ambient shadow beneath tripod stand
  const floorGrad = ctx.createRadialGradient(cx, standFloorY, 10, cx, standFloorY, 108);
  floorGrad.addColorStop(0, 'rgba(28, 20, 16, 0.13)');
  floorGrad.addColorStop(0.55, 'rgba(28, 20, 16, 0.05)');
  floorGrad.addColorStop(1, 'rgba(28, 20, 16, 0)');
  ctx.fillStyle = floorGrad;
  ctx.beginPath();
  ctx.ellipse(cx, standFloorY, 108, 13, 0, 0, Math.PI * 2);
  ctx.fill();

  // Subtle hem cast shadow onto the brass stem right below the garment hem
  const hemY = clamp(maxGarmentBottomY * STAGE_H + 8, 480, standFloorY - 12);
  const hemGrad = ctx.createRadialGradient(cx, hemY, 4, cx, hemY, 54);
  hemGrad.addColorStop(0, 'rgba(28, 20, 16, 0.14)');
  hemGrad.addColorStop(1, 'rgba(28, 20, 16, 0)');
  ctx.fillStyle = hemGrad;
  ctx.beginPath();
  ctx.ellipse(cx, hemY, 54, 9, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}
