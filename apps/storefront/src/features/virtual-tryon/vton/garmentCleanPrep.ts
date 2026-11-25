import type {
  GarmentAnchors,
  PreparedGarmentAsset,
  TryOnGarmentSlot,
} from './types';

export interface LoadedCorsImage {
  source: HTMLImageElement | ImageBitmap;
  width: number;
  height: number;
  cleanup: () => void;
}

export interface PrepareCleanGarmentInput {
  garmentImageUrl: string;
  colorHex: string;
  slot: TryOnGarmentSlot;
  name?: string;
}

const MAX_WORK_DIM = 768;
const MAX_PREPARED_CACHE = 40;
const preparedCache = new Map<string, PreparedGarmentAsset>();

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function parseHexToRgb(hex: string): [number, number, number] {
  const clean = (hex || '#EFE6D8').replace('#', '').trim();
  if (clean.length === 3) {
    const r = parseInt(clean[0]! + clean[0]!, 16);
    const g = parseInt(clean[1]! + clean[1]!, 16);
    const b = parseInt(clean[2]! + clean[2]!, 16);
    if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) {
      return [r, g, b];
    }
  }
  if (clean.length >= 6) {
    const r = parseInt(clean.slice(0, 2), 16);
    const g = parseInt(clean.slice(2, 4), 16);
    const b = parseInt(clean.slice(4, 6), 16);
    if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) {
      return [r, g, b];
    }
  }
  return [239, 230, 216];
}

function rgbLuma(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
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
    const finish = (val: HTMLImageElement | null) => {
      if (settled) return;
      settled = true;
      resolve(val);
    };
    const timer =
      typeof window !== 'undefined'
        ? window.setTimeout(() => finish(null), 8500)
        : null;
    img.onload = () => {
      if (timer !== null) window.clearTimeout(timer);
      finish(img.naturalWidth > 0 && img.naturalHeight > 0 ? img : null);
    };
    img.onerror = () => {
      if (timer !== null) window.clearTimeout(timer);
      finish(null);
    };
    img.src = src;
  });
}

function buildCandidateUrls(rawUrl: string): string[] {
  const trimmed = rawUrl.trim();
  if (!trimmed) return [];
  const candidates = [trimmed];

  // If browser origin is localhost vs 127.0.0.1 and MinIO URL uses the other, add mirror host fallback
  if (typeof window !== 'undefined' && /^https?:\/\//i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      if (parsed.hostname === '127.0.0.1' && window.location.hostname === 'localhost') {
        const alt = new URL(trimmed);
        alt.hostname = 'localhost';
        candidates.push(alt.toString());
      } else if (
        parsed.hostname === 'localhost' &&
        window.location.hostname === '127.0.0.1'
      ) {
        const alt = new URL(trimmed);
        alt.hostname = '127.0.0.1';
        candidates.push(alt.toString());
      }
    } catch {
      // Ignore invalid URL parse
    }
  }

  return candidates;
}

/**
 * Loads an image without tainting HTMLCanvasElement:
 * supports `data:`, `blob:`, same-origin relative URLs (`/images/...`, `/bff/...`),
 * and CORS-enabled MinIO/CDN URLs.
 */
export async function loadImageCorsSafe(
  url: string,
): Promise<LoadedCorsImage | null> {
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

  const candidates = buildCandidateUrls(trimmed);

  for (const candidate of candidates) {
    const isSameOrigin =
      candidate.startsWith('/') ||
      candidate.startsWith(window.location.origin);

    // Path 1: fetch -> Blob -> createImageBitmap (immune to non-CORS <img> cache tainting)
    try {
      const controller =
        typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timeoutId = controller
        ? window.setTimeout(() => controller.abort(), 8000)
        : null;
      const res = await fetch(candidate, {
        mode: isSameOrigin ? 'same-origin' : 'cors',
        credentials: isSameOrigin ? 'same-origin' : 'omit',
        signal: controller?.signal,
      });
      if (timeoutId !== null) window.clearTimeout(timeoutId);

      if (res.ok) {
        const blob = await res.blob();
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
            // Fall through to ObjectURL HTMLImageElement
          }
        }
        const objUrl = URL.createObjectURL(blob);
        const img = await loadHtmlImage(objUrl, false);
        if (img) {
          return {
            source: img,
            width: img.naturalWidth,
            height: img.naturalHeight,
            cleanup: () => URL.revokeObjectURL(objUrl),
          };
        }
        URL.revokeObjectURL(objUrl);
      }
    } catch {
      // Fall through to anonymous Image load
    }

    // Path 2: direct Image with crossOrigin='anonymous'
    const direct = await loadHtmlImage(candidate, !isSameOrigin);
    if (direct) {
      return {
        source: direct,
        width: direct.naturalWidth,
        height: direct.naturalHeight,
        cleanup: () => {},
      };
    }

    // Path 3: cache-busted anonymous retry
    const sep = candidate.includes('?') ? '&' : '?';
    const busted = await loadHtmlImage(`${candidate}${sep}vton_cors=1`, true);
    if (busted) {
      return {
        source: busted,
        width: busted.naturalWidth,
        height: busted.naturalHeight,
        cleanup: () => {},
      };
    }
  }

  return null;
}

function createFallbackGarmentCanvas(
  slot: TryOnGarmentSlot,
  colorHex: string,
): HTMLCanvasElement {
  const w = 480;
  const h = 640;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;

  const [r, g, b] = parseHexToRgb(colorHex);
  const hiR = clamp(r + 24, 0, 255);
  const hiG = clamp(g + 22, 0, 255);
  const hiB = clamp(b + 20, 0, 255);
  const loR = clamp(Math.round(r * 0.72), 10, 235);
  const loG = clamp(Math.round(g * 0.72), 10, 235);
  const loB = clamp(Math.round(b * 0.72), 10, 235);

  ctx.save();
  ctx.beginPath();
  if (slot === 'lower') {
    ctx.moveTo(w * 0.25, h * 0.05);
    ctx.quadraticCurveTo(w * 0.5, h * 0.08, w * 0.75, h * 0.05);
    ctx.lineTo(w * 0.84, h * 0.96);
    ctx.lineTo(w * 0.54, h * 0.96);
    ctx.lineTo(w * 0.5, h * 0.34);
    ctx.lineTo(w * 0.46, h * 0.96);
    ctx.lineTo(w * 0.16, h * 0.96);
    ctx.closePath();
  } else if (slot === 'onePiece') {
    ctx.moveTo(w * 0.34, h * 0.04);
    ctx.quadraticCurveTo(w * 0.5, h * 0.13, w * 0.66, h * 0.04);
    ctx.lineTo(w * 0.8, h * 0.13);
    ctx.quadraticCurveTo(w * 0.72, h * 0.3, w * 0.67, h * 0.42);
    ctx.quadraticCurveTo(w * 0.84, h * 0.7, w * 0.88, h * 0.96);
    ctx.quadraticCurveTo(w * 0.5, h * 0.99, w * 0.12, h * 0.96);
    ctx.quadraticCurveTo(w * 0.16, h * 0.7, w * 0.33, h * 0.42);
    ctx.quadraticCurveTo(w * 0.28, h * 0.3, w * 0.2, h * 0.13);
    ctx.closePath();
  } else {
    ctx.moveTo(w * 0.35, h * 0.05);
    ctx.quadraticCurveTo(w * 0.5, h * 0.14, w * 0.65, h * 0.05);
    ctx.lineTo(w * 0.85, h * 0.15);
    ctx.lineTo(w * 0.95, h * 0.78);
    ctx.lineTo(w * 0.8, h * 0.8);
    ctx.lineTo(w * 0.75, h * 0.42);
    ctx.lineTo(w * 0.77, h * 0.95);
    ctx.quadraticCurveTo(w * 0.5, h * 0.98, w * 0.23, h * 0.95);
    ctx.lineTo(w * 0.25, h * 0.42);
    ctx.lineTo(w * 0.2, h * 0.8);
    ctx.lineTo(w * 0.05, h * 0.78);
    ctx.lineTo(w * 0.15, h * 0.15);
    ctx.closePath();
  }

  const grad = ctx.createLinearGradient(w * 0.1, 0, w * 0.9, 0);
  grad.addColorStop(0, `rgb(${loR},${loG},${loB})`);
  grad.addColorStop(0.28, `rgb(${r},${g},${b})`);
  grad.addColorStop(0.5, `rgb(${hiR},${hiG},${hiB})`);
  grad.addColorStop(0.74, `rgb(${r},${g},${b})`);
  grad.addColorStop(1, `rgb(${loR},${loG},${loB})`);
  ctx.fillStyle = grad;
  ctx.fill();
  ctx.restore();
  return canvas;
}

/**
 * Strips opaque light/ivory studio background via edge BFS flood-fill if the
 * source image has no real alpha channel (e.g. studio product cards).
 */
function stripOpaqueStudioBackground(
  data: Uint8ClampedArray,
  w: number,
  h: number,
): void {
  const cornerCoords: Array<[number, number]> = [
    [2, 2],
    [w - 3, 2],
    [2, h - 3],
    [w - 3, h - 3],
  ];

  let lightOpaqueCorners = 0;
  let bgR = 0;
  let bgG = 0;
  let bgB = 0;

  for (const [cx, cy] of cornerCoords) {
    const x = clamp(cx, 0, w - 1);
    const y = clamp(cy, 0, h - 1);
    const o = (y * w + x) * 4;
    const r = data[o]!;
    const g = data[o + 1]!;
    const b = data[o + 2]!;
    const a = data[o + 3]!;
    const luma = rgbLuma(r, g, b);
    const chroma = Math.max(r, g, b) - Math.min(r, g, b);
    if (a > 240 && luma > 186 && chroma < 48) {
      lightOpaqueCorners += 1;
      bgR += r;
      bgG += g;
      bgB += b;
    }
  }

  if (lightOpaqueCorners < 3) return;

  bgR /= lightOpaqueCorners;
  bgG /= lightOpaqueCorners;
  bgB /= lightOpaqueCorners;

  const total = w * h;
  const visited = new Uint8Array(total);
  const bgMask = new Uint8Array(total);
  const queue = new Int32Array(total);
  let head = 0;
  let tail = 0;

  const tryEnqueue = (idx: number) => {
    if (visited[idx]) return;
    const o = idx * 4;
    const r = data[o]!;
    const g = data[o + 1]!;
    const b = data[o + 2]!;
    const dist =
      Math.abs(r - bgR) * 0.36 +
      Math.abs(g - bgG) * 0.4 +
      Math.abs(b - bgB) * 0.24;
    const chroma = Math.max(r, g, b) - Math.min(r, g, b);
    if (dist < 30 && chroma < 52) {
      visited[idx] = 1;
      bgMask[idx] = 1;
      queue[tail++] = idx;
    }
  };

  for (let x = 0; x < w; x += 1) {
    tryEnqueue(x);
    tryEnqueue((h - 1) * w + x);
  }
  for (let y = 1; y < h - 1; y += 1) {
    tryEnqueue(y * w);
    tryEnqueue(y * w + (w - 1));
  }

  while (head < tail) {
    const idx = queue[head++]!;
    const x = idx % w;
    const y = (idx - x) / w;
    if (x > 0) tryEnqueue(idx - 1);
    if (x < w - 1) tryEnqueue(idx + 1);
    if (y > 0) tryEnqueue(idx - w);
    if (y < h - 1) tryEnqueue(idx + w);
  }

  // Zero out flood-filled background and softly feather 1px border
  for (let i = 0; i < total; i += 1) {
    if (bgMask[i]) {
      data[i * 4 + 3] = 0;
    }
  }

  for (let y = 1; y < h - 1; y += 1) {
    const row = y * w;
    for (let x = 1; x < w - 1; x += 1) {
      const idx = row + x;
      if (bgMask[idx]) continue;
      if (
        bgMask[idx - 1] ||
        bgMask[idx + 1] ||
        bgMask[idx - w] ||
        bgMask[idx + w]
      ) {
        const o = idx * 4;
        const dist =
          Math.abs(data[o]! - bgR) * 0.36 +
          Math.abs(data[o + 1]! - bgG) * 0.4 +
          Math.abs(data[o + 2]! - bgB) * 0.24;
        if (dist < 44) {
          data[o + 3] = Math.round(data[o + 3]! * clamp((dist - 24) / 22, 0.15, 0.85));
        }
      }
    }
  }
}

interface GarmentBBox {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  gw: number;
  gh: number;
}

function findOpaqueBBox(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  alphaThreshold = 26,
): GarmentBBox {
  let minX = w;
  let maxX = -1;
  let minY = h;
  let maxY = -1;

  for (let y = 0; y < h; y += 1) {
    const row = y * w;
    for (let x = 0; x < w; x += 1) {
      if (data[(row + x) * 4 + 3]! >= alphaThreshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX <= minX || maxY <= minY) {
    return { minX: 0, maxX: w - 1, minY: 0, maxY: h - 1, gw: w, gh: h };
  }

  return {
    minX,
    maxX,
    minY,
    maxY,
    gw: maxX - minX + 1,
    gh: maxY - minY + 1,
  };
}

interface BodiceFabricStats {
  meanR: number;
  meanG: number;
  meanB: number;
  medianLuma: number;
  p15Luma: number;
  meanChroma: number;
  sampleCount: number;
}

function measureBodiceFabricStats(
  data: Uint8ClampedArray,
  w: number,
  bbox: GarmentBBox,
): BodiceFabricStats {
  const x0 = Math.round(bbox.minX + bbox.gw * 0.25);
  const x1 = Math.round(bbox.minX + bbox.gw * 0.75);
  const y0 = Math.round(bbox.minY + bbox.gh * 0.3);
  const y1 = Math.round(bbox.minY + bbox.gh * 0.65);

  const lumaHist = new Uint32Array(256);
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  let sumChroma = 0;
  let count = 0;

  for (let y = y0; y <= y1; y += 1) {
    const row = y * w;
    for (let x = x0; x <= x1; x += 1) {
      const o = (row + x) * 4;
      if (data[o + 3]! < 190) continue;
      const r = data[o]!;
      const g = data[o + 1]!;
      const b = data[o + 2]!;
      sumR += r;
      sumG += g;
      sumB += b;
      sumChroma += Math.max(r, g, b) - Math.min(r, g, b);
      const lumaBin = clamp(Math.round(rgbLuma(r, g, b)), 0, 255);
      lumaHist[lumaBin] = (lumaHist[lumaBin] ?? 0) + 1;
      count += 1;
    }
  }

  if (count === 0) {
    return {
      meanR: 210,
      meanG: 205,
      meanB: 196,
      medianLuma: 205,
      p15Luma: 150,
      meanChroma: 14,
      sampleCount: 0,
    };
  }

  let acc = 0;
  let medianLuma = 180;
  let p15Luma = 130;
  const p15Target = count * 0.15;
  const p50Target = count * 0.5;
  let foundP15 = false;

  for (let i = 0; i < 256; i += 1) {
    acc += lumaHist[i]!;
    if (!foundP15 && acc >= p15Target) {
      p15Luma = i;
      foundP15 = true;
    }
    if (acc >= p50Target) {
      medianLuma = i;
      break;
    }
  }

  return {
    meanR: sumR / count,
    meanG: sumG / count,
    meanB: sumB / count,
    medianLuma,
    p15Luma,
    meanChroma: sumChroma / count,
    sampleCount: count,
  };
}

/**
 * Eliminates dark/grey mannequin inner-collar cavities, inner neck-lining shadows,
 * and thin floating back-collar rim bridges directly above the cavity — across BOTH
 * light/medium knitwear (`Kem Cashmere`) AND dark knitwear (`Cacao Đậm`, `medL >= 36`)
 * without ever harming genuinely pitch-black garments.
 */
function cleanInnerCollarCavity(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  bbox: GarmentBBox,
  bodice: BodiceFabricStats,
  slot: TryOnGarmentSlot,
): boolean {
  if (slot === 'lower' || bodice.sampleCount < 40) return false;
  // Preserve pitch-black garments whose fabric luma is itself near-zero
  if (bodice.medianLuma < 36) return false;

  const zoneX0 = clamp(Math.floor(bbox.minX + bbox.gw * 0.28), 0, w - 1);
  const zoneX1 = clamp(Math.ceil(bbox.minX + bbox.gw * 0.72), 0, w - 1);
  const zoneY0 = clamp(bbox.minY, 0, h - 1);
  const zoneY1 = clamp(Math.ceil(bbox.minY + bbox.gh * 0.24), 0, h - 1);

  const zw = zoneX1 - zoneX0 + 1;
  const zh = zoneY1 - zoneY0 + 1;
  if (zw < 8 || zh < 8) return false;

  const zTotal = zw * zh;
  const zLuma = new Float32Array(zTotal);
  const darkCand = new Uint8Array(zTotal);
  const greyBackCand = new Uint8Array(zTotal);

  const isLightOrMid = bodice.medianLuma >= 95;
  const darkLumaCutoff = isLightOrMid
    ? Math.min(104, bodice.medianLuma - 62)
    : Math.min(36, bodice.medianLuma * 0.48);
  const darkP15Cutoff = Math.max(92, bodice.p15Luma - 24);
  const greyLumaCutoff = Math.min(176, bodice.medianLuma - 42);

  for (let zy = 0; zy < zh; zy += 1) {
    const gy = zoneY0 + zy;
    const rowOff = gy * w;
    const zRow = zy * zw;
    for (let zx = 0; zx < zw; zx += 1) {
      const gx = zoneX0 + zx;
      const o = (rowOff + gx) * 4;
      const a = data[o + 3]!;
      if (a < 24) {
        zLuma[zRow + zx] = 255;
        continue;
      }
      const r = data[o]!;
      const g = data[o + 1]!;
      const b = data[o + 2]!;
      const luma = rgbLuma(r, g, b);
      zLuma[zRow + zx] = luma;
      const chroma = Math.max(r, g, b) - Math.min(r, g, b);
      const colorDiv =
        Math.abs(r - bodice.meanR) +
        Math.abs(g - bodice.meanG) +
        Math.abs(b - bodice.meanB);

      if (isLightOrMid) {
        // Pattern A1: Dark charcoal / black mannequin neck opening on light/mid fabrics
        if (
          luma < darkLumaCutoff &&
          luma < darkP15Cutoff &&
          chroma < 46 &&
          colorDiv > 140
        ) {
          darkCand[zRow + zx] = 1;
        }
        // Pattern B: Medium-grey desaturated inner-collar back-lining on light tops
        if (
          bodice.medianLuma >= 148 &&
          luma < greyLumaCutoff &&
          chroma < 26 &&
          colorDiv > 110
        ) {
          greyBackCand[zRow + zx] = 1;
        }
      } else {
        // Pattern A2: Ultra-dark smooth neutral mannequin cavity inside dark-toned knitwear (e.g. Cacao Đậm)
        if (luma < darkLumaCutoff && chroma < 26) {
          darkCand[zRow + zx] = 1;
        }
      }
    }
  }

  const removeMask = new Uint8Array(zTotal);
  const removedBoxes: Array<{
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
  }> = [];
  const minCompArea = Math.max(42, Math.round(bbox.gw * bbox.gh * 0.00042));
  const maxTopClearance = Math.max(8, Math.round(bbox.gh * 0.075));
  const queue = new Int32Array(zTotal);

  const extractQualifyingComponents = (
    cand: Uint8Array,
    requireTopBoundaryTouch: boolean,
  ) => {
    const visited = new Uint8Array(zTotal);

    for (let i = 0; i < zTotal; i += 1) {
      if (!cand[i] || visited[i]) continue;

      let head = 0;
      let tail = 0;
      visited[i] = 1;
      queue[tail++] = i;

      let sumX = 0;
      let sumLuma = 0;
      let minCX = zw;
      let maxCX = 0;
      let minCY = zh;
      let maxCY = 0;
      let touchesTopTransparent = false;

      while (head < tail) {
        const cur = queue[head++]!;
        const zx = cur % zw;
        const zy = (cur - zx) / zw;
        sumX += zx;
        sumLuma += zLuma[cur]!;
        if (zx < minCX) minCX = zx;
        if (zx > maxCX) maxCX = zx;
        if (zy < minCY) minCY = zy;
        if (zy > maxCY) maxCY = zy;

        const gx = zoneX0 + zx;
        const gy = zoneY0 + zy;
        if (gy <= bbox.minY + 1 || data[((gy - 1) * w + gx) * 4 + 3]! < 28) {
          touchesTopTransparent = true;
        }

        if (zx > 0 && cand[cur - 1] && !visited[cur - 1]) {
          visited[cur - 1] = 1;
          queue[tail++] = cur - 1;
        }
        if (zx < zw - 1 && cand[cur + 1] && !visited[cur + 1]) {
          visited[cur + 1] = 1;
          queue[tail++] = cur + 1;
        }
        if (zy > 0 && cand[cur - zw] && !visited[cur - zw]) {
          visited[cur - zw] = 1;
          queue[tail++] = cur - zw;
        }
        if (zy < zh - 1 && cand[cur + zw] && !visited[cur + zw]) {
          visited[cur + zw] = 1;
          queue[tail++] = cur + zw;
        }
      }

      if (tail < minCompArea) continue;

      const centroidNormX = (zoneX0 + sumX / tail - bbox.minX) / bbox.gw;
      const compMinNormY = (zoneY0 + minCY - bbox.minY) / bbox.gh;
      const compMaxNormY = (zoneY0 + maxCY - bbox.minY) / bbox.gh;

      if (centroidNormX < 0.32 || centroidNormX > 0.68) continue;
      if (compMinNormY > 0.14 || compMaxNormY > 0.23) continue;

      // Verify surrounding collar ring contrast: real collar walls around a mannequin hole
      // are meaningfully brighter than the dark cavity interior (+20 luma), protecting solid black garments.
      const compMask = new Uint8Array(zTotal);
      for (let k = 0; k < tail; k += 1) {
        compMask[queue[k]!] = 1;
      }
      const rX0 = Math.max(0, minCX - 4);
      const rX1 = Math.min(zw - 1, maxCX + 4);
      const rY0 = Math.max(0, minCY - 4);
      const rY1 = Math.min(zh - 1, maxCY + 4);
      let ringSumLuma = 0;
      let ringCount = 0;
      for (let ry = rY0; ry <= rY1; ry += 1) {
        const rRow = ry * zw;
        const gy = zoneY0 + ry;
        for (let rx = rX0; rx <= rX1; rx += 1) {
          const ri = rRow + rx;
          if (compMask[ri]) continue;
          const gx = zoneX0 + rx;
          if (data[(gy * w + gx) * 4 + 3]! < 120) continue;
          // Check proximity (within 3px of component)
          let near = false;
          for (let dy = -3; dy <= 3 && !near; dy += 3) {
            const ny = ry + dy;
            if (ny < 0 || ny >= zh) continue;
            for (let dx = -3; dx <= 3; dx += 3) {
              const nx = rx + dx;
              if (nx >= 0 && nx < zw && compMask[ny * zw + nx]) {
                near = true;
                break;
              }
            }
          }
          if (near) {
            ringSumLuma += zLuma[ri]!;
            ringCount += 1;
          }
        }
      }

      const compMeanLuma = sumLuma / tail;
      const ringMeanLuma = ringCount > 0 ? ringSumLuma / ringCount : compMeanLuma;
      if (ringCount < 16 || ringMeanLuma - compMeanLuma < 20) continue;

      // Verify collar geometry: touches top neckline transparency directly OR sits just beneath a thin back-collar lip
      let nearTopNeckline = touchesTopTransparent;
      if (!nearTopNeckline && !requireTopBoundaryTouch) {
        const midX = clamp(
          zoneX0 + Math.round((minCX + maxCX) * 0.5),
          0,
          w - 1,
        );
        const startY = zoneY0 + minCY;
        let hasOpenAbove = false;
        for (let step = 1; step <= maxTopClearance; step += 1) {
          const py = startY - step;
          if (py < 0 || data[(py * w + midX) * 4 + 3]! < 28) {
            hasOpenAbove = true;
            break;
          }
        }
        const midY = clamp(
          zoneY0 + Math.round((minCY + maxCY) * 0.5),
          0,
          h - 1,
        );
        const leftWallX = clamp(zoneX0 + minCX - 5, 0, w - 1);
        const rightWallX = clamp(zoneX0 + maxCX + 5, 0, w - 1);
        const hasWalls =
          data[(midY * w + leftWallX) * 4 + 3]! >= 120 &&
          data[(midY * w + rightWallX) * 4 + 3]! >= 120;

        nearTopNeckline = hasOpenAbove && hasWalls;
      }

      if (!nearTopNeckline) continue;

      for (let k = 0; k < tail; k += 1) {
        removeMask[queue[k]!] = 1;
      }
      removedBoxes.push({
        minX: minCX,
        maxX: maxCX,
        minY: minCY,
        maxY: maxCY,
      });
    }
  };

  extractQualifyingComponents(darkCand, false);
  if (isLightOrMid) {
    extractQualifyingComponents(greyBackCand, true);
  }

  let removedCount = 0;
  for (let i = 0; i < zTotal; i += 1) {
    if (removeMask[i]) {
      const zx = i % zw;
      const zy = (i - zx) / zw;
      const gx = zoneX0 + zx;
      const gy = zoneY0 + zy;
      data[(gy * w + gx) * 4 + 3] = 0;
      removedCount += 1;
    }
  }

  if (removedCount === 0) return false;

  // Clean 2-pixel dark fringe halo around the removed cavity so zero grey ring remains
  const ringDarkCut = isLightOrMid
    ? bodice.medianLuma - 28
    : bodice.medianLuma * 0.65;
  const ring1 = new Uint8Array(zTotal);
  for (let zy = 1; zy < zh - 1; zy += 1) {
    const zRow = zy * zw;
    for (let zx = 1; zx < zw - 1; zx += 1) {
      const zi = zRow + zx;
      if (removeMask[zi]) continue;
      if (
        removeMask[zi - 1] ||
        removeMask[zi + 1] ||
        removeMask[zi - zw] ||
        removeMask[zi + zw] ||
        removeMask[zi - zw - 1] ||
        removeMask[zi - zw + 1] ||
        removeMask[zi + zw - 1] ||
        removeMask[zi + zw + 1]
      ) {
        const gx = zoneX0 + zx;
        const gy = zoneY0 + zy;
        const o = (gy * w + gx) * 4;
        const a = data[o + 3]!;
        if (a === 0) continue;
        const luma = zLuma[zi]!;
        if (luma < ringDarkCut) {
          data[o + 3] = 0;
          ring1[zi] = 1;
        } else {
          data[o + 3] = Math.round(a * 0.4);
          ring1[zi] = 1;
        }
      }
    }
  }

  // Outer 2nd-ring gentle feathering on residual shadow fringe
  for (let zy = 1; zy < zh - 1; zy += 1) {
    const zRow = zy * zw;
    for (let zx = 1; zx < zw - 1; zx += 1) {
      const zi = zRow + zx;
      if (removeMask[zi] || ring1[zi]) continue;
      if (
        ring1[zi - 1] ||
        ring1[zi + 1] ||
        ring1[zi - zw] ||
        ring1[zi + zw]
      ) {
        const gx = zoneX0 + zx;
        const gy = zoneY0 + zy;
        const o = (gy * w + gx) * 4;
        const a = data[o + 3]!;
        if (a === 0) continue;
        const luma = zLuma[zi]!;
        if (luma < ringDarkCut * 0.85) {
          data[o + 3] = Math.round(a * 0.2);
        }
      }
    }
  }

  // Strip thin floating back-collar rim bridge sitting directly above the removed cavity
  // so zero stray cream/cacao specks poke out beside the wearer's neck.
  const maxLipThickness = Math.max(14, Math.round(bbox.gh * 0.048));
  for (const box of removedBoxes) {
    const padX = Math.max(6, Math.round((box.maxX - box.minX) * 0.08));
    const sx0 = Math.max(0, box.minX - padX);
    const sx1 = Math.min(zw - 1, box.maxX + padX);
    for (let zx = sx0; zx <= sx1; zx += 1) {
      let topCavY = box.minY + 2;
      for (let zy = 0; zy < zh; zy += 1) {
        if (removeMask[zy * zw + zx]) {
          topCavY = zy;
          break;
        }
      }
      const gx = zoneX0 + zx;
      let opaqueAbove = 0;
      for (let zy = 0; zy < topCavY; zy += 1) {
        const gy = zoneY0 + zy;
        if (data[(gy * w + gx) * 4 + 3]! >= 24) {
          opaqueAbove += 1;
        }
      }
      if (opaqueAbove > 0 && opaqueAbove <= maxLipThickness) {
        for (let zy = 0; zy < topCavY; zy += 1) {
          const gy = zoneY0 + zy;
          data[(gy * w + gx) * 4 + 3] = 0;
        }
      }
    }
  }

  return true;
}

/**
 * Luminance-preserving fabric recoloring so switching e.g.
 * Kem Cashmere (#EFE6D8) <-> Cacao Đậm (#2E221B) transforms the fabric color
 * richly while preserving knit weave, pleats, and silk highlights.
 */
function applyVariantColorRecoloring(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  bodice: BodiceFabricStats,
  targetHex: string,
): void {
  if (!targetHex || bodice.sampleCount < 40) return;

  const [tgtR, tgtG, tgtB] = parseHexToRgb(targetHex);
  const srcLuma = rgbLuma(bodice.meanR, bodice.meanG, bodice.meanB);
  const tgtLuma = rgbLuma(tgtR, tgtG, tgtB);

  // Perceptually weighted RGB distance
  const dR = tgtR - bodice.meanR;
  const dG = tgtG - bodice.meanG;
  const dB = tgtB - bodice.meanB;
  const perceptualDelta = Math.sqrt(
    0.299 * dR * dR + 0.587 * dG * dG + 0.114 * dB * dB,
  );
  const hueShift =
    Math.abs((tgtR - tgtLuma) - (bodice.meanR - srcLuma)) +
    Math.abs((tgtG - tgtLuma) - (bodice.meanG - srcLuma)) +
    Math.abs((tgtB - tgtLuma) - (bodice.meanB - srcLuma));

  const effectiveDelta = Math.max(perceptualDelta, hueShift * 0.55);

  // If requested swatch already closely matches source fabric (e.g. Kem Cashmere on cream knit),
  // leave natural photography untouched!
  if (effectiveDelta < 32) return;

  const blendStrength = clamp((effectiveDelta - 26) / 48, 0.18, 0.94);
  const refMidLuma = clamp(bodice.medianLuma, 36, 236);
  const darkening = tgtLuma < srcLuma - 28;
  const lightening = tgtLuma > srcLuma + 28;

  const total = w * h;
  for (let i = 0; i < total; i += 1) {
    const o = i * 4;
    const a = data[o + 3]!;
    if (a < 10) continue;

    const r = data[o]!;
    const g = data[o + 1]!;
    const b = data[o + 2]!;
    const pxLuma = rgbLuma(r, g, b);
    const foldRatio = pxLuma / refMidLuma;

    let outR: number;
    let outG: number;
    let outB: number;

    if (darkening) {
      // Preserve rich knit/weave relief even on deep Cacao / Jet Black
      const shaped = Math.pow(clamp(foldRatio, 0.18, 1.48), 1.18);
      const mult = 0.24 + 0.84 * shaped;
      const microSheen = Math.max(0, foldRatio - 1.04) * 38;
      outR = tgtR * mult + microSheen * (0.65 + (tgtR / 255) * 0.35);
      outG = tgtG * mult + microSheen * (0.62 + (tgtG / 255) * 0.38);
      outB = tgtB * mult + microSheen * (0.58 + (tgtB / 255) * 0.42);
    } else if (lightening) {
      const shaped = Math.pow(clamp(foldRatio, 0.32, 1.55), 0.72);
      const mult = 0.42 + 0.6 * shaped;
      outR = tgtR * mult;
      outG = tgtG * mult;
      outB = tgtB * mult;
    } else {
      const mult = clamp(foldRatio, 0.28, 1.46);
      outR = tgtR * mult;
      outG = tgtG * mult;
      outB = tgtB * mult;
    }

    data[o] = Math.round(clamp(r + (outR - r) * blendStrength, 0, 255));
    data[o + 1] = Math.round(clamp(g + (outG - g) * blendStrength, 0, 255));
    data[o + 2] = Math.round(clamp(b + (outB - b) * blendStrength, 0, 255));
  }
}

/**
 * Decontaminates pale studio matte halos along semi-transparent garment edges.
 */
function decontaminateEdgeHalos(data: Uint8ClampedArray, totalPx: number): void {
  const matteR = 246;
  const matteG = 242;
  const matteB = 236;

  for (let i = 0; i < totalPx; i += 1) {
    const o = i * 4;
    const a = data[o + 3]!;
    if (a === 0) continue;
    if (a < 16) {
      data[o + 3] = 0;
      continue;
    }
    if (a < 230) {
      const alpha = a / 255;
      const r = data[o]!;
      const g = data[o + 1]!;
      const b = data[o + 2]!;
      const luma = rgbLuma(r, g, b);
      const chroma = Math.max(r, g, b) - Math.min(r, g, b);

      if (a < 88 && luma > 224 && chroma < 24) {
        data[o + 3] = Math.round(a * 0.25);
        continue;
      }

      const strength = clamp((1 - alpha) * 0.64, 0, 0.58);
      const denom = Math.max(0.35, 1 - strength);
      data[o] = Math.round(clamp((r - matteR * strength) / denom, 0, 255));
      data[o + 1] = Math.round(clamp((g - matteG * strength) / denom, 0, 255));
      data[o + 2] = Math.round(clamp((b - matteB * strength) / denom, 0, 255));
    }
  }
}

/**
 * Measures normalized [0..1] anatomical garment anchors on the trimmed canvas
 * so the compositor aligns collar, shoulders, waist, and hem accurately to pose landmarks.
 */
function detectGarmentAnchors(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  slot: TryOnGarmentSlot,
): GarmentAnchors {
  const rowSpan = (yNorm: number): { left: number; right: number } | null => {
    const y = clamp(Math.round(yNorm * (h - 1)), 0, h - 1);
    const row = y * w;
    let l = -1;
    let r = -1;
    for (let x = 0; x < w; x += 1) {
      if (data[(row + x) * 4 + 3]! >= 40) {
        if (l === -1) l = x;
        r = x;
      }
    }
    if (l === -1 || r <= l) return null;
    return { left: l / w, right: r / w };
  };

  // Top collar / shoulder peak near center-left & center-right
  let collarTopRow = h - 1;
  const cX0 = Math.floor(w * 0.32);
  const cX1 = Math.ceil(w * 0.68);
  for (let y = 0; y < Math.floor(h * 0.35); y += 1) {
    const row = y * w;
    for (let x = cX0; x <= cX1; x += 1) {
      if (data[(row + x) * 4 + 3]! >= 50) {
        collarTopRow = Math.min(collarTopRow, y);
        break;
      }
    }
    if (collarTopRow < h - 1) break;
  }

  // Front neckline dip along exact horizontal center (x in 46%..54%).
  // Skips past any thin back-collar lip sitting above an open turtleneck cavity
  // so `collarBottomY` lands directly on the front collar rim.
  const midX0 = Math.floor(w * 0.46);
  const midX1 = Math.ceil(w * 0.54);
  const midSpan = Math.max(1, midX1 - midX0 + 1);
  const isRowCenterOpaque = (y: number): boolean => {
    const row = y * w;
    let opaqueCount = 0;
    for (let x = midX0; x <= midX1; x += 1) {
      if (data[(row + x) * 4 + 3]! >= 65) {
        opaqueCount += 1;
      }
    }
    return opaqueCount / midSpan >= 0.55;
  };

  let collarBottomRow = collarTopRow;
  const maxNeckScan = Math.floor(h * 0.44);
  const minSolidRun = Math.max(4, Math.round(h * 0.025));
  let solidRun = 0;
  let firstSolidStart = -1;
  let sawHoleAfterLip = false;
  let lastFrontStart = -1;

  for (let y = collarTopRow; y < maxNeckScan; y += 1) {
    if (isRowCenterOpaque(y)) {
      if (solidRun === 0) {
        if (firstSolidStart === -1) firstSolidStart = y;
        lastFrontStart = y;
      }
      solidRun += 1;
      // Once we have a thick solid front chest/collar band, stop scanning
      if (solidRun >= minSolidRun && (sawHoleAfterLip || y - collarTopRow > Math.round(h * 0.05))) {
        collarBottomRow = lastFrontStart;
        break;
      }
    } else {
      if (solidRun > 0 && solidRun < Math.round(h * 0.05)) {
        sawHoleAfterLip = true;
      }
      solidRun = 0;
    }
  }
  if (collarBottomRow === collarTopRow && firstSolidStart !== -1) {
    collarBottomRow = sawHoleAfterLip && lastFrontStart !== -1 ? lastFrontStart : firstSolidStart;
  }

  const collarTopY = clamp(collarTopRow / Math.max(1, h), 0.01, 0.25);
  const collarBottomY = clamp(
    Math.max(collarBottomRow / Math.max(1, h), collarTopY + 0.03),
    0.04,
    0.38,
  );

  // Measure shoulder span around upper torso row (~14%..20% below collarTop)
  const shoulderProbeY = clamp(
    collarTopY + (slot === 'onePiece' ? 0.09 : 0.14),
    0.08,
    0.32,
  );
  const sSpan = rowSpan(shoulderProbeY) ?? { left: 0.14, right: 0.86 };

  // Measure outer garment shoulder cap height at x=0.22w & x=0.78w so sloping knit/raglan
  // shoulders align cleanly ABOVE the wearer's trapezius & tank-top straps.
  const findColTopRow = (xNorm: number): number | null => {
    const x = clamp(Math.round(xNorm * (w - 1)), 0, w - 1);
    for (let y = 0; y < Math.floor(h * 0.42); y += 1) {
      if (data[(y * w + x) * 4 + 3]! >= 65) {
        return y / Math.max(1, h);
      }
    }
    return null;
  };
  const leftCapY = findColTopRow(0.22);
  const rightCapY = findColTopRow(0.78);
  const shoulderCapY = clamp(
    leftCapY !== null && rightCapY !== null
      ? (leftCapY + rightCapY) * 0.5
      : leftCapY ?? rightCapY ?? collarTopY + 0.11,
    0.04,
    0.26,
  );

  // Waist Y: narrowest row in mid-section or canonical ratio per slot
  let waistY = slot === 'lower' ? 0.06 : slot === 'onePiece' ? 0.37 : 0.66;
  if (slot !== 'lower') {
    let minWidth = 2;
    const scanStart = slot === 'onePiece' ? 0.28 : 0.48;
    const scanEnd = slot === 'onePiece' ? 0.46 : 0.78;
    for (let yn = scanStart; yn <= scanEnd; yn += 0.02) {
      const span = rowSpan(yn);
      if (span) {
        const width = span.right - span.left;
        if (width < minWidth && width > 0.2) {
          minWidth = width;
          waistY = yn;
        }
      }
    }
  }

  // Hem Y: lowest opaque row
  let hemRow = h - 1;
  for (let y = h - 1; y >= Math.floor(h * 0.6); y -= 1) {
    const row = y * w;
    let hasOpaque = false;
    for (let x = 0; x < w; x += 2) {
      if (data[(row + x) * 4 + 3]! >= 36) {
        hasOpaque = true;
        break;
      }
    }
    if (hasOpaque) {
      hemRow = y;
      break;
    }
  }

  return {
    leftShoulderX: clamp(sSpan.left, 0.02, 0.45),
    rightShoulderX: clamp(sSpan.right, 0.55, 0.98),
    collarTopY,
    collarBottomY,
    shoulderCapY,
    waistY: clamp(waistY, 0.05, 0.88),
    hemY: clamp((hemRow + 1) / Math.max(1, h), 0.7, 1.0),
  };
}

export function clearPreparedGarmentCache(): void {
  preparedCache.clear();
}

/**
 * Prepares a clean, studio-matted, collar-cleaned, variant-recolored garment canvas
 * with anatomical anchors ready for pose-aligned virtual try-on compositing.
 */
export async function prepareCleanGarment(
  input: PrepareCleanGarmentInput,
): Promise<PreparedGarmentAsset> {
  const cacheKey = `${input.garmentImageUrl.trim()}|${input.colorHex.trim().toLowerCase()}|${input.slot}`;
  const cached = preparedCache.get(cacheKey);
  if (cached) {
    // LRU promote
    preparedCache.delete(cacheKey);
    preparedCache.set(cacheKey, cached);
    return cached;
  }

  const loaded = await loadImageCorsSafe(input.garmentImageUrl);

  let workCanvas: HTMLCanvasElement;
  if (loaded) {
    const fitScale = Math.min(
      1,
      MAX_WORK_DIM / Math.max(loaded.width, loaded.height, 1),
    );
    const workW = Math.max(16, Math.round(loaded.width * fitScale));
    const workH = Math.max(16, Math.round(loaded.height * fitScale));

    workCanvas = document.createElement('canvas');
    workCanvas.width = workW;
    workCanvas.height = workH;
    const ctx = workCanvas.getContext('2d', { willReadFrequently: true });
    if (ctx) {
      ctx.clearRect(0, 0, workW, workH);
      ctx.drawImage(loaded.source as CanvasImageSource, 0, 0, workW, workH);
    }
    loaded.cleanup();
  } else {
    workCanvas = createFallbackGarmentCanvas(input.slot, input.colorHex);
  }

  const workW = workCanvas.width;
  const workH = workCanvas.height;
  const workCtx = workCanvas.getContext('2d', { willReadFrequently: true });

  let cleanCollarApplied = false;
  let trimmedCanvas = workCanvas;
  let anchors: GarmentAnchors = {
    leftShoulderX: 0.14,
    rightShoulderX: 0.86,
    collarTopY: 0.04,
    collarBottomY: 0.12,
    waistY: input.slot === 'lower' ? 0.08 : input.slot === 'onePiece' ? 0.37 : 0.66,
    hemY: 0.97,
  };

  if (workCtx) {
    try {
      const imgData = workCtx.getImageData(0, 0, workW, workH);
      const data = imgData.data;

      // 1. Strip opaque light/cream studio background if present
      stripOpaqueStudioBackground(data, workW, workH);

      // 2. Clean pale semi-transparent edge halos
      decontaminateEdgeHalos(data, workW * workH);

      // 3. Measure garment bbox + bodice fabric statistics
      const bbox = findOpaqueBBox(data, workW, workH);
      const bodiceStats = measureBodiceFabricStats(data, workW, bbox);

      // 4. Surgical inner-collar mannequin cavity & back-lining cleanup
      cleanCollarApplied = cleanInnerCollarCavity(
        data,
        workW,
        workH,
        bbox,
        bodiceStats,
        input.slot,
      );

      // 5. Luminance-preserving variant swatch recoloring
      applyVariantColorRecoloring(
        data,
        workW,
        workH,
        bodiceStats,
        input.colorHex,
      );

      workCtx.putImageData(imgData, 0, 0);

      // 6. Tight crop with 2% safety pad
      const postBbox = findOpaqueBBox(data, workW, workH);
      const padX = Math.max(3, Math.round(postBbox.gw * 0.02));
      const padY = Math.max(3, Math.round(postBbox.gh * 0.02));
      const tx0 = Math.max(0, postBbox.minX - padX);
      const ty0 = Math.max(0, postBbox.minY - padY);
      const tx1 = Math.min(workW - 1, postBbox.maxX + padX);
      const ty1 = Math.min(workH - 1, postBbox.maxY + padY);
      const trimW = Math.max(16, tx1 - tx0 + 1);
      const trimH = Math.max(16, ty1 - ty0 + 1);

      trimmedCanvas = document.createElement('canvas');
      trimmedCanvas.width = trimW;
      trimmedCanvas.height = trimH;
      const trimCtx = trimmedCanvas.getContext('2d', {
        willReadFrequently: true,
      });
      if (trimCtx) {
        trimCtx.clearRect(0, 0, trimW, trimH);
        trimCtx.drawImage(
          workCanvas,
          tx0,
          ty0,
          trimW,
          trimH,
          0,
          0,
          trimW,
          trimH,
        );
        const trimData = trimCtx.getImageData(0, 0, trimW, trimH).data;
        anchors = detectGarmentAnchors(trimData, trimW, trimH, input.slot);
      }
    } catch {
      // Fallback safely if canvas is unavailable in a headless/SSR environment
    }
  }

  let cleanDataUrl = '';
  try {
    cleanDataUrl = trimmedCanvas.toDataURL('image/png');
  } catch {
    cleanDataUrl = input.garmentImageUrl;
  }

  const asset: PreparedGarmentAsset = {
    canvas: trimmedCanvas,
    anchors,
    cleanCollarApplied,
    cleanDataUrl,
  };

  if (preparedCache.size >= MAX_PREPARED_CACHE) {
    const oldest = preparedCache.keys().next().value;
    if (oldest !== undefined) {
      preparedCache.delete(oldest);
    }
  }
  preparedCache.set(cacheKey, asset);

  return asset;
}
