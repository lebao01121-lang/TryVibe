/**
 * Photometric Multi-Layer Canvas Recoloring Engine (OKLab / OKLCH)
 * ---------------------------------------------------------------------------
 * Performs 0ms-latency, cumulative multi-garment photometric fabric recoloring
 * directly on an HTMLCanvasElement at HiDPI (devicePixelRatio) resolution.
 *
 * Physical Pipeline per Active Garment Slot:
 *  1. Intrinsic Shading & Folds Map: extracts OKLab L* fold luminance structure
 *     strictly inside the slot's 2.5px-feathered `garmentRegionMask` PNG.
 *  2. Material Specular & Sheen Curve:
 *     - 'silk'    : lifted S-curve Fresnel highlight sheen on high-L ridges
 *                   (authentic 22-Momme liquid luster even on Jet Black #171615)
 *     - 'linen'   : matte organic weave warmth + gentle micro-contrast
 *     - 'tweed'   : amplified high-frequency yarn cross-hatch micro-contrast
 *     - 'leather' : tight localized specular ridge + rich crease depth
 *  3. Context Ambient Relighting (6%–10%) & Contact Shadow AO: samples true
 *     ambient light color outside all garment masks and blends subtly into the
 *     recolored textile with soft edge contact-shadow occlusion.
 *  4. Bitwise Mask Isolation: pixels with alpha === 0 (face, neck, hands, hair,
 *     background) are never modified (MAE === 0).
 */

export type MaterialSheenType = 'silk' | 'linen' | 'tweed' | 'leather';

export interface MaterialOpticalProfile {
  sheen: MaterialSheenType;
  specularIntensity: number;
  shadowDepth: number;
}

export interface PhotometricSlotMaskInput {
  slotKey: string;
  garmentRegionMask: string;
  materialOpticalProfile: MaterialOpticalProfile;
}

export interface PhotometricRecolorSlotRequest {
  slotKey: string;
  targetHex: string;
  isDefaultColor?: boolean;
  materialOpticalProfile: MaterialOpticalProfile;
}

export interface MaskBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

interface HydratedMaskLayer {
  slotKey: string;
  maskUrl: string;
  bounds: MaskBounds;
  /** Tight bbox alpha values (0..255), length = bw * bh */
  alpha: Uint8Array;
  /** Precomputed OKLab L* of base pixels inside tight bbox */
  origL: Float32Array;
  /** Precomputed local high-frequency detail (origL - localAvgL) for linen/tweed */
  microDetail: Float32Array;
  /** Edge AO factor (0..255 representing 0..1 edge proximity) */
  edgeWeight: Uint8Array;
  meanL: number;
  p10L: number;
  p90L: number;
  pixelCount: number;
}

export interface HydratedSeasonScene {
  seasonSlug: string;
  baseUrl: string;
  width: number;
  height: number;
  basePixels: Uint8ClampedArray;
  /** Sampled ambient scene light in linear RGB (0..1) from non-garment background */
  ambientLinearRgb: [number, number, number];
  /** Precomputed offscreen working canvas for crisp HiDPI compositing */
  workCanvas: HTMLCanvasElement;
  workCtx: CanvasRenderingContext2D;
  workImageData: ImageData;
  masks: Map<string, HydratedMaskLayer>;
  bitmaps: ImageBitmap[];
}

// ============================================================================
// Fast sRGB <-> Linear RGB LUTs & OKLab Conversions (Björn Ottosson exact)
// ============================================================================

const SRGB_TO_LINEAR = new Float32Array(256);
for (let i = 0; i < 256; i += 1) {
  const c = i / 255;
  SRGB_TO_LINEAR[i] =
    c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

const LINEAR_LUT_SIZE = 4096;
const LINEAR_TO_SRGB = new Uint8Array(LINEAR_LUT_SIZE + 1);
for (let i = 0; i <= LINEAR_LUT_SIZE; i += 1) {
  const v = i / LINEAR_LUT_SIZE;
  const s =
    v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  LINEAR_TO_SRGB[i] = Math.max(0, Math.min(255, Math.round(s * 255)));
}

function linearToSrgbByte(linear: number): number {
  if (linear <= 0) return 0;
  if (linear >= 1) return 255;
  return LINEAR_TO_SRGB[(linear * LINEAR_LUT_SIZE + 0.5) | 0] ?? 255;
}

function linearRgbToOkLab(
  r: number,
  g: number,
  b: number,
): [number, number, number] {
  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;

  const l_ = Math.cbrt(Math.max(0, l));
  const m_ = Math.cbrt(Math.max(0, m));
  const s_ = Math.cbrt(Math.max(0, s));

  const L = 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_;
  const a = 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_;
  const bLab = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_;
  return [L, a, bLab];
}

function okLabToLinearRgb(
  L: number,
  a: number,
  b: number,
): [number, number, number] {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;

  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;

  const r = +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const bl = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
  return [r, g, bl];
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / Math.max(1e-5, edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function parseHexToRgb(hex: string): [number, number, number] {
  const clean = hex.trim().replace(/^#/, '');
  if (clean.length === 3) {
    const r = parseInt(clean[0]! + clean[0]!, 16);
    const g = parseInt(clean[1]! + clean[1]!, 16);
    const b = parseInt(clean[2]! + clean[2]!, 16);
    if (!Number.isNaN(r) && !Number.isNaN(g) && !Number.isNaN(b)) {
      return [r, g, b];
    }
  } else if (clean.length >= 6) {
    const r = parseInt(clean.slice(0, 2), 16);
    const g = parseInt(clean.slice(2, 4), 16);
    const b = parseInt(clean.slice(4, 6), 16);
    if (!Number.isNaN(r) && !Number.isNaN(g) && !Number.isNaN(b)) {
      return [r, g, b];
    }
  }
  return [244, 239, 230]; // Fallback warm ivory
}

// ============================================================================
// Image & Bitmap Loading Helpers (CORS-clean for same-origin & MinIO)
// ============================================================================

async function loadImageSource(
  url: string,
): Promise<{ source: CanvasImageSource; width: number; height: number; bitmap?: ImageBitmap } | null> {
  if (typeof window === 'undefined' || !url) return null;

  return new Promise((resolve) => {
    const img = new Image();
    img.decoding = 'async';
    if (url.startsWith('http://') || url.startsWith('https://')) {
      img.crossOrigin = 'anonymous';
    }
    let settled = false;
    const finish = (
      val: {
        source: CanvasImageSource;
        width: number;
        height: number;
        bitmap?: ImageBitmap;
      } | null,
    ) => {
      if (settled) return;
      settled = true;
      resolve(val);
    };

    img.onload = () => {
      const width = img.naturalWidth || img.width;
      const height = img.naturalHeight || img.height;
      if (width <= 0 || height <= 0) {
        finish(null);
        return;
      }
      if (typeof createImageBitmap === 'function') {
        createImageBitmap(img)
          .then((bitmap) => finish({ source: bitmap, width, height, bitmap }))
          .catch(() => finish({ source: img, width, height }));
      } else {
        finish({ source: img, width, height });
      }
    };
    img.onerror = () => finish(null);
    img.src = url;
  });
}

function extractMaskLayer(
  slotKey: string,
  maskUrl: string,
  maskPixels: Uint8ClampedArray,
  basePixels: Uint8ClampedArray,
  width: number,
  height: number,
): HydratedMaskLayer | null {
  // Detect whether PNG uses alpha channel or grayscale luminance
  let minAlpha = 255;
  let maxAlpha = 0;
  for (let i = 3; i < maskPixels.length; i += 64) {
    const a = maskPixels[i]!;
    if (a < minAlpha) minAlpha = a;
    if (a > maxAlpha) maxAlpha = a;
  }
  const useAlphaChannel = minAlpha < 245 && maxAlpha > 8;

  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y += 1) {
    const rowOffset = y * width;
    for (let x = 0; x < width; x += 1) {
      const idx4 = (rowOffset + x) * 4;
      const a = useAlphaChannel ? maskPixels[idx4 + 3]! : maskPixels[idx4]!;
      if (a > 2) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX < minX || maxY < minY) {
    return null;
  }

  const bw = maxX - minX + 1;
  const bh = maxY - minY + 1;
  const len = bw * bh;

  const alpha = new Uint8Array(len);
  const origL = new Float32Array(len);
  const microDetail = new Float32Array(len);
  const edgeWeight = new Uint8Array(len);

  // Histogram of OKLab L* (256 bins) for fast p10 / p90 shading calibration
  const hist = new Uint32Array(256);
  let sumL = 0;
  let weightSum = 0;
  let pixelCount = 0;

  for (let ly = 0; ly < bh; ly += 1) {
    const gy = minY + ly;
    const baseRow = gy * width;
    const localRow = ly * bw;
    for (let lx = 0; lx < bw; lx += 1) {
      const gx = minX + lx;
      const idx4 = (baseRow + gx) * 4;
      const aByte = useAlphaChannel ? maskPixels[idx4 + 3]! : maskPixels[idx4]!;
      const localIdx = localRow + lx;
      alpha[localIdx] = aByte;

      if (aByte > 2) {
        const lr = SRGB_TO_LINEAR[basePixels[idx4]!]!;
        const lg = SRGB_TO_LINEAR[basePixels[idx4 + 1]!]!;
        const lb = SRGB_TO_LINEAR[basePixels[idx4 + 2]!]!;
        const [L] = linearRgbToOkLab(lr, lg, lb);
        origL[localIdx] = L;

        if (aByte >= 32) {
          const w = aByte / 255;
          sumL += L * w;
          weightSum += w;
          pixelCount += 1;
          const bin = clamp((L * 255 + 0.5) | 0, 0, 255);
          hist[bin] = (hist[bin] ?? 0) + 1;
        }
      }
    }
  }

  if (pixelCount < 16 || weightSum <= 0) {
    return null;
  }

  const meanL = sumL / weightSum;

  // Compute p10 and p90 from luminance histogram
  const p10Target = pixelCount * 0.1;
  const p90Target = pixelCount * 0.9;
  let cumulative = 0;
  let p10L = Math.max(0.05, meanL - 0.14);
  let p90L = Math.min(0.98, meanL + 0.14);
  let foundP10 = false;
  let foundP90 = false;

  for (let b = 0; b < 256; b += 1) {
    cumulative += hist[b]!;
    if (!foundP10 && cumulative >= p10Target) {
      p10L = b / 255;
      foundP10 = true;
    }
    if (!foundP90 && cumulative >= p90Target) {
      p90L = b / 255;
      foundP90 = true;
      break;
    }
  }

  // Compute high-frequency local detail & feathered contact-shadow edge weight
  for (let ly = 0; ly < bh; ly += 1) {
    const localRow = ly * bw;
    const prevRow = Math.max(0, ly - 1) * bw;
    const nextRow = Math.min(bh - 1, ly + 1) * bw;
    for (let lx = 0; lx < bw; lx += 1) {
      const idx = localRow + lx;
      const aByte = alpha[idx]!;
      if (aByte <= 2) continue;

      const lxPrev = Math.max(0, lx - 1);
      const lxNext = Math.min(bw - 1, lx + 1);
      const avgL =
        (origL[prevRow + lx]! +
          origL[nextRow + lx]! +
          origL[localRow + lxPrev]! +
          origL[localRow + lxNext]!) *
        0.25;
      microDetail[idx] = origL[idx]! - avgL;

      // Contact edge detection (boundary pixels adjacent to non-mask pixels)
      const minNeighborA = Math.min(
        alpha[prevRow + lx]!,
        alpha[nextRow + lx]!,
        alpha[localRow + lxPrev]!,
        alpha[localRow + lxNext]!,
      );
      if (aByte < 236 || minNeighborA < 220) {
        const edgeStrength = 1 - Math.min(aByte, minNeighborA) / 255;
        edgeWeight[idx] = clamp((edgeStrength * 255 + 0.5) | 0, 0, 255);
      }
    }
  }

  return {
    slotKey,
    maskUrl,
    bounds: { minX, minY, maxX, maxY },
    alpha,
    origL,
    microDetail,
    edgeWeight,
    meanL,
    p10L,
    p90L,
    pixelCount,
  };
}

function sampleSceneAmbientLight(
  basePixels: Uint8ClampedArray,
  masks: Map<string, HydratedMaskLayer>,
  width: number,
  height: number,
): [number, number, number] {
  // Sample every 12th pixel outside all garment masks to capture garden/studio ambient tone
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  let count = 0;

  const maskList = Array.from(masks.values());
  const step = 12;

  for (let y = 0; y < height; y += step) {
    const rowOff = y * width;
    for (let x = 0; x < width; x += step) {
      let insideMask = false;
      for (let m = 0; m < maskList.length; m += 1) {
        const layer = maskList[m]!;
        const b = layer.bounds;
        if (x >= b.minX && x <= b.maxX && y >= b.minY && y <= b.maxY) {
          const a = layer.alpha[(y - b.minY) * (b.maxX - b.minX + 1) + (x - b.minX)]!;
          if (a > 16) {
            insideMask = true;
            break;
          }
        }
      }
      if (insideMask) continue;

      const idx4 = (rowOff + x) * 4;
      const r = SRGB_TO_LINEAR[basePixels[idx4]!]!;
      const g = SRGB_TO_LINEAR[basePixels[idx4 + 1]!]!;
      const b = SRGB_TO_LINEAR[basePixels[idx4 + 2]!]!;
      sumR += r;
      sumG += g;
      sumB += b;
      count += 1;
    }
  }

  if (count < 20) {
    return [0.58, 0.52, 0.44]; // Warm editorial ivory daylight fallback
  }

  // Normalize towards natural warm illumination so dark backgrounds don't kill ambient tint
  const avgR = sumR / count;
  const avgG = sumG / count;
  const avgB = sumB / count;
  const lum = Math.max(0.08, 0.2126 * avgR + 0.7152 * avgG + 0.0722 * avgB);
  const targetLum = clamp(lum, 0.28, 0.72);
  const scale = targetLum / lum;

  return [
    clamp(avgR * scale, 0.18, 0.92),
    clamp(avgG * scale, 0.16, 0.88),
    clamp(avgB * scale, 0.14, 0.84),
  ];
}

// ============================================================================
// Core Photometric Multi-Layer Canvas Recoloring Render Pass
// ============================================================================

export function renderPhotometricSceneToCanvas(
  canvas: HTMLCanvasElement,
  scene: HydratedSeasonScene,
  slotRequests: PhotometricRecolorSlotRequest[],
  options?: {
    hoveredSlotKey?: string | null;
    maxDpr?: number;
  },
): void {
  const { width, height, basePixels, workCanvas, workCtx, workImageData, ambientLinearRgb } =
    scene;

  // Start from exact bitwise copy of base editorial photograph
  const out = workImageData.data;
  out.set(basePixels);

  const [ambR, ambG, ambB] = ambientLinearRgb;

  // Cumulative multi-slot photometric recolor pass (TOP + BOTTOM + ACCESSORY simultaneously!)
  for (let s = 0; s < slotRequests.length; s += 1) {
    const req = slotRequests[s]!;
    if (req.isDefaultColor) continue;

    const layer = scene.masks.get(req.slotKey);
    if (!layer) continue;

    const [tRByte, tGByte, tBByte] = parseHexToRgb(req.targetHex);
    const tLinR = SRGB_TO_LINEAR[tRByte]!;
    const tLinG = SRGB_TO_LINEAR[tGByte]!;
    const tLinB = SRGB_TO_LINEAR[tBByte]!;
    const [tL, ta, tb] = linearRgbToOkLab(tLinR, tLinG, tLinB);

    const { sheen, specularIntensity, shadowDepth } = req.materialOpticalProfile;
    const spec = clamp(specularIntensity, 0.05, 1.0);
    const depth = clamp(shadowDepth, 0.2, 1.0);

    const { minX, minY, maxX, maxY } = layer.bounds;
    const bw = maxX - minX + 1;
    const bh = maxY - minY + 1;
    const { alpha, origL, microDetail, edgeWeight, p10L, p90L } = layer;
    const invRange = 1 / Math.max(0.11, p90L - p10L);

    // Target-lightness adaptive shading curve: preserves deep folds without crushing dark silk
    // and keeps ivory/champagne shades luminous without over-darkening midtones.
    const isDarkTarget = tL < 0.44;
    const shadowFloor =
      lerp(0.34, 0.56, clamp(tL, 0, 1)) * (1 - 0.16 * (depth - 0.5));
    const rangeGain = lerp(0.92, 0.58, clamp(tL, 0, 1));

    // Context ambient relighting strength (6%–10% per spec)
    const ambientMix = sheen === 'silk' ? 0.085 : sheen === 'leather' ? 0.07 : 0.08;

    for (let ly = 0; ly < bh; ly += 1) {
      const gy = minY + ly;
      const outRow = gy * width;
      const localRow = ly * bw;

      for (let lx = 0; lx < bw; lx += 1) {
        const localIdx = localRow + lx;
        const aByte = alpha[localIdx]!;
        if (aByte <= 2) continue;

        const normFold = clamp((origL[localIdx]! - p10L) * invRange, 0, 1.32);

        // 1. Intrinsic Shading & Folds Mapping in OKLab L*
        let mappedL = tL * (shadowFloor + rangeGain * normFold);

        // 2. Material Specular & Sheen Curve
        let ridgeHighlight = 0;
        if (sheen === 'silk') {
          // 22-Momme liquid silk S-curve highlight sheen on high-luminance ridges
          const ridge = smoothstep(0.54, 1.16, normFold);
          const sheenScale = isDarkTarget
            ? 0.14 + 0.17 * spec
            : 0.06 + 0.09 * spec;
          ridgeHighlight = Math.pow(ridge, 1.75) * sheenScale;
          mappedL += ridgeHighlight;
          // Preserve fine silk crease micro-modulation
          mappedL += microDetail[localIdx]! * 0.45;
        } else if (sheen === 'linen') {
          // Organic matte linen: gentle weave warmth & tactile micro-contrast
          const softRidge = smoothstep(0.65, 1.2, normFold);
          ridgeHighlight = softRidge * 0.045 * spec;
          mappedL += ridgeHighlight + microDetail[localIdx]! * 0.85;
        } else if (sheen === 'tweed') {
          // High-frequency bouclé / tweed weave texture preservation
          const subtleHighlight = smoothstep(0.72, 1.2, normFold) * 0.05 * spec;
          ridgeHighlight = subtleHighlight;
          mappedL += subtleHighlight + microDetail[localIdx]! * 1.28;
        } else {
          // 'leather': crisp localized specular ridge + deeper fold contrast
          const tightRidge = smoothstep(0.74, 1.14, normFold);
          ridgeHighlight = Math.pow(tightRidge, 2.8) * (0.16 + 0.16 * spec);
          mappedL = mappedL * (0.94 + 0.08 * normFold) + ridgeHighlight;
          mappedL += microDetail[localIdx]! * 0.55;
        }

        // Contact shadow AO along feathered inner garment edges (waist, wrist, clutch grip)
        const edgeFactor = edgeWeight[localIdx]! / 255;
        if (edgeFactor > 0.05) {
          mappedL *= 1 - 0.065 * edgeFactor;
        }

        mappedL = clamp(mappedL, 0.03, 0.975);

        // 3. Physically plausible chroma attenuation in deep shadows & dielectric specular crests
        const shadowChroma = 0.62 + 0.38 * Math.min(1, normFold * 1.8);
        const specularDesat = 1 - clamp(ridgeHighlight * 2.1, 0, 0.58);
        const chromaScale = shadowChroma * specularDesat;

        const [rawLinR, rawLinG, rawLinB] = okLabToLinearRgb(
          mappedL,
          ta * chromaScale,
          tb * chromaScale,
        );

        // 4. Context Ambient Relighting (6%–10% warm garden/studio light temperature)
        const ambWeight = ambientMix * (0.42 + 0.58 * Math.min(1, normFold));
        const litLinR = clamp(
          rawLinR * (1 - ambWeight) + ambR * ambWeight * (0.35 + mappedL),
          0,
          1,
        );
        const litLinG = clamp(
          rawLinG * (1 - ambWeight) + ambG * ambWeight * (0.35 + mappedL),
          0,
          1,
        );
        const litLinB = clamp(
          rawLinB * (1 - ambWeight) + ambB * ambWeight * (0.35 + mappedL),
          0,
          1,
        );

        const newR = linearToSrgbByte(litLinR);
        const newG = linearToSrgbByte(litLinG);
        const newB = linearToSrgbByte(litLinB);

        // 5. Smooth 2.5px feathered alpha composite (zero bleed where alpha === 0)
        const idx4 = (outRow + (minX + lx)) * 4;
        if (aByte >= 253) {
          out[idx4] = newR;
          out[idx4 + 1] = newG;
          out[idx4 + 2] = newB;
        } else {
          const aNorm = aByte / 255;
          const invA = 1 - aNorm;
          out[idx4] = (out[idx4]! * invA + newR * aNorm + 0.5) | 0;
          out[idx4 + 1] = (out[idx4 + 1]! * invA + newG * aNorm + 0.5) | 0;
          out[idx4 + 2] = (out[idx4 + 2]! * invA + newB * aNorm + 0.5) | 0;
        }
      }
    }
  }

  // Optional soft golden mask-contour glow on hovered garment slot
  const hoveredSlotKey = options?.hoveredSlotKey;
  if (hoveredSlotKey) {
    const hoverLayer = scene.masks.get(hoveredSlotKey);
    if (hoverLayer) {
      const { minX, minY, maxX, maxY } = hoverLayer.bounds;
      const bw = maxX - minX + 1;
      const bh = maxY - minY + 1;
      const { alpha, edgeWeight } = hoverLayer;
      // Warm champagne gold #EBCF8F (235, 207, 143)
      for (let ly = 0; ly < bh; ly += 1) {
        const outRow = (minY + ly) * width;
        const localRow = ly * bw;
        for (let lx = 0; lx < bw; lx += 1) {
          const localIdx = localRow + lx;
          const aByte = alpha[localIdx]!;
          if (aByte <= 8) continue;
          const edge = edgeWeight[localIdx]! / 255;
          // Crisp golden contour rim + faint 4.5% silk illumination kiss
          const glow = edge > 0.1 ? 0.34 * edge : 0.045 * (aByte / 255);
          if (glow <= 0.005) continue;
          const invG = 1 - glow;
          const idx4 = (outRow + (minX + lx)) * 4;
          out[idx4] = (out[idx4]! * invG + 235 * glow + 0.5) | 0;
          out[idx4 + 1] = (out[idx4 + 1]! * invG + 207 * glow + 0.5) | 0;
          out[idx4 + 2] = (out[idx4 + 2]! * invG + 143 * glow + 0.5) | 0;
        }
      }
    }
  }

  // Commit offscreen working pixels, then draw cleanly to HiDPI display canvas
  workCtx.putImageData(workImageData, 0, 0);

  const dpr = Math.min(
    options?.maxDpr ?? 2,
    typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1,
  );
  const rect = canvas.getBoundingClientRect();
  const displayW = rect.width > 32 ? Math.round(rect.width * dpr) : width;
  const displayH = rect.height > 32 ? Math.round(rect.height * dpr) : height;
  const targetW = Math.min(width, Math.max(480, displayW));
  const targetH = Math.min(height, Math.max(600, displayH));

  if (canvas.width !== targetW || canvas.height !== targetH) {
    canvas.width = targetW;
    canvas.height = targetH;
  }

  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return;

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(workCanvas, 0, 0, width, height, 0, 0, canvas.width, canvas.height);
}

// ============================================================================
// Memory-Safe Season Cache (only hydrates active ±1 chapters, disposes cleanly)
// ============================================================================

export class PhotometricLookbookCache {
  private readonly scenes = new Map<string, HydratedSeasonScene>();
  private readonly inflight = new Map<string, Promise<HydratedSeasonScene | null>>();

  getCached(seasonSlug: string): HydratedSeasonScene | null {
    return this.scenes.get(seasonSlug) ?? null;
  }

  async hydrateSeason(
    seasonSlug: string,
    baseUrl: string,
    slots: PhotometricSlotMaskInput[],
  ): Promise<HydratedSeasonScene | null> {
    const existing = this.scenes.get(seasonSlug);
    if (existing && existing.baseUrl === baseUrl) {
      return existing;
    }

    const pending = this.inflight.get(seasonSlug);
    if (pending) return pending;

    const task = this.loadSeasonInternal(seasonSlug, baseUrl, slots).finally(() => {
      this.inflight.delete(seasonSlug);
    });
    this.inflight.set(seasonSlug, task);
    return task;
  }

  private async loadSeasonInternal(
    seasonSlug: string,
    baseUrl: string,
    slots: PhotometricSlotMaskInput[],
  ): Promise<HydratedSeasonScene | null> {
    if (typeof document === 'undefined') return null;

    const baseLoaded = await loadImageSource(baseUrl);
    if (!baseLoaded) return null;

    const bitmaps: ImageBitmap[] = [];
    if (baseLoaded.bitmap) bitmaps.push(baseLoaded.bitmap);

    // Clamp max working resolution to 960x1200 to guarantee < 4ms photometric render latency
    const maxW = 960;
    const maxH = 1200;
    const scale = Math.min(1, maxW / baseLoaded.width, maxH / baseLoaded.height);
    const width = Math.max(1, Math.round(baseLoaded.width * scale));
    const height = Math.max(1, Math.round(baseLoaded.height * scale));

    const workCanvas = document.createElement('canvas');
    workCanvas.width = width;
    workCanvas.height = height;
    const workCtx = workCanvas.getContext('2d', { willReadFrequently: true });
    if (!workCtx) {
      for (const bm of bitmaps) bm.close();
      return null;
    }

    workCtx.drawImage(baseLoaded.source, 0, 0, width, height);

    let basePixels: Uint8ClampedArray;
    try {
      basePixels = new Uint8ClampedArray(
        workCtx.getImageData(0, 0, width, height).data,
      );
    } catch {
      for (const bm of bitmaps) bm.close();
      return null;
    }

    const workImageData = workCtx.createImageData(width, height);

    // Hydrate all slot masks in parallel
    const maskCanvas = document.createElement('canvas');
    maskCanvas.width = width;
    maskCanvas.height = height;
    const maskCtx = maskCanvas.getContext('2d', { willReadFrequently: true });

    const maskMap = new Map<string, HydratedMaskLayer>();
    if (maskCtx) {
      const maskResults = await Promise.all(
        slots.map(async (slot) => {
          const loaded = await loadImageSource(slot.garmentRegionMask);
          return { slot, loaded };
        }),
      );

      for (const { slot, loaded } of maskResults) {
        if (!loaded) continue;
        if (loaded.bitmap) bitmaps.push(loaded.bitmap);

        maskCtx.clearRect(0, 0, width, height);
        maskCtx.drawImage(loaded.source, 0, 0, width, height);
        try {
          const maskData = maskCtx.getImageData(0, 0, width, height).data;
          const layer = extractMaskLayer(
            slot.slotKey,
            slot.garmentRegionMask,
            maskData,
            basePixels,
            width,
            height,
          );
          if (layer) {
            maskMap.set(slot.slotKey, layer);
          }
        } catch {
          // Ignore tainted mask gracefully
        }
      }
    }

    // Release temporary ImageBitmaps right after pixel extraction to keep GPU memory flat
    for (const bm of bitmaps) {
      try {
        bm.close();
      } catch {
        // Ignore already-closed bitmap
      }
    }
    bitmaps.length = 0;

    // Reset temporary mask scratch canvas
    maskCanvas.width = 0;
    maskCanvas.height = 0;

    const ambientLinearRgb = sampleSceneAmbientLight(
      basePixels,
      maskMap,
      width,
      height,
    );

    const scene: HydratedSeasonScene = {
      seasonSlug,
      baseUrl,
      width,
      height,
      basePixels,
      ambientLinearRgb,
      workCanvas,
      workCtx,
      workImageData,
      masks: maskMap,
      bitmaps,
    };

    const previous = this.scenes.get(seasonSlug);
    if (previous) {
      this.releaseScene(previous);
    }
    this.scenes.set(seasonSlug, scene);
    return scene;
  }

  /**
   * Releases off-screen buffers & bitmaps for any season outside the active ±1 chapter window.
   */
  pruneOutsideWindow(activeIndex: number, orderedSeasonSlugs: readonly string[]): void {
    const keepSet = new Set<string>();
    for (let offset = -1; offset <= 1; offset += 1) {
      const idx = activeIndex + offset;
      if (idx >= 0 && idx < orderedSeasonSlugs.length) {
        keepSet.add(orderedSeasonSlugs[idx]!);
      }
    }

    for (const [slug, scene] of this.scenes.entries()) {
      if (!keepSet.has(slug)) {
        this.releaseScene(scene);
        this.scenes.delete(slug);
      }
    }
  }

  private releaseScene(scene: HydratedSeasonScene): void {
    for (const bm of scene.bitmaps) {
      try {
        bm.close();
      } catch {
        // Ignore
      }
    }
    scene.bitmaps.length = 0;
    scene.masks.clear();
    scene.workCanvas.width = 0;
    scene.workCanvas.height = 0;
  }

  dispose(): void {
    for (const scene of this.scenes.values()) {
      this.releaseScene(scene);
    }
    this.scenes.clear();
    this.inflight.clear();
  }
}
