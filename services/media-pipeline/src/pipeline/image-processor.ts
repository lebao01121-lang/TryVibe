import sharp from 'sharp';

export interface MagicByteDetection {
  valid: boolean;
  kind: 'image' | 'video' | 'unknown';
  mimeType: string | null;
  format: 'jpeg' | 'png' | 'webp' | 'mp4' | 'webm' | null;
}

export interface AspectAndAlphaInspection {
  width: number;
  height: number;
  aspectRatio: number;
  aspectDeviationPct: number;
  aspectValid: boolean;
  hasAlphaMetadata: boolean;
  transparentCorners: number;
  cornerAlphas: number[];
  hasRealAlpha: boolean;
}

export interface PixelBoundingBox extends Record<string, unknown> {
  x: number;
  y: number;
  width: number;
  height: number;
  normalizedX: number;
  normalizedY: number;
  normalizedWidth: number;
  normalizedHeight: number;
  imageWidth: number;
  imageHeight: number;
  computedFromPixels: true;
  shoulderY: number;
  waistY: number;
  hipY: number;
  hemY: number;
}

export interface GeneratedImageVariant {
  buffer: Buffer;
  width: number;
  height: number;
  mimeType: string;
  sizeBytes: number;
}

export interface RackCutoutVariants {
  w480: GeneratedImageVariant;
  w720: GeneratedImageVariant;
}

export interface TryOnFlatLayVariants {
  flat768x1024: GeneratedImageVariant;
  preview768x1024: GeneratedImageVariant;
  w720: GeneratedImageVariant;
}

export interface LookbookVariants {
  w960: GeneratedImageVariant;
  w1600: GeneratedImageVariant;
}

export interface GarmentValidationMetrics {
  magicBytesValid: boolean;
  detectedFormat: 'jpeg' | 'png' | 'webp' | null;
  mimeType: string | null;
  sizeBytes: number;
  aspectDeviationPct: number;
  laplacianVariance: number;
  luminanceStdDev: number;
  maxBorderTouchRatio: number;
  borderTouchRatios: {
    top: number;
    bottom: number;
    left: number;
    right: number;
  };
  transparentCornerPixels: number;
  totalCornerPixels: number;
  corrupted: boolean;
  decodeError?: string;
}

export interface GarmentValidationResult {
  isValid: boolean;
  qualityScore: number;
  detectedAspectRatio: string;
  width: number;
  height: number;
  aspectRatio: number;
  hasAlpha: boolean;
  cornerTransparencyRatio: number;
  sharpnessScore: number;
  contrastScore: number;
  edgeClipped: boolean;
  warnings: string[];
  metrics: GarmentValidationMetrics;
}

export const RACK_TARGET_ASPECT_RATIO = 2 / 3;
export const RACK_ASPECT_TOLERANCE_PCT = 0.02; // <= 2% of 2/3 ([0.6533, 0.6800])
export const CORNER_ALPHA_THRESHOLD = 10;
export const MIN_TRANSPARENT_CORNERS = 3;

const STUDIO_NEUTRAL_RGB = { r: 250, g: 249, b: 247 } as const;
const STUDIO_NEUTRAL_RGBA = { r: 250, g: 249, b: 247, alpha: 1 } as const;
const TRANSPARENT_RGBA = { r: 0, g: 0, b: 0, alpha: 0 } as const;

/**
 * Strictly inspects raw binary headers (Magic Bytes).
 * Never trusts file extensions or client-supplied Content-Type headers.
 */
export function detectMagicBytes(buffer: Buffer): MagicByteDetection {
  if (!Buffer.isBuffer(buffer) || buffer.length < 3) {
    return { valid: false, kind: 'unknown', mimeType: null, format: null };
  }

  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { valid: true, kind: 'image', mimeType: 'image/jpeg', format: 'jpeg' };
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return { valid: true, kind: 'image', mimeType: 'image/png', format: 'png' };
  }

  // WebP: RIFF (52 49 46 46) at offset 0 AND WEBP (57 45 42 50) at offset 8
  if (
    buffer.length >= 12 &&
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  ) {
    return { valid: true, kind: 'image', mimeType: 'image/webp', format: 'webp' };
  }

  // MP4 (ISO Base Media): 'ftyp' at offset 4..7 (for HERO_VIDEO only)
  if (
    buffer.length >= 12 &&
    buffer[4] === 0x66 &&
    buffer[5] === 0x74 &&
    buffer[6] === 0x79 &&
    buffer[7] === 0x70
  ) {
    return { valid: true, kind: 'video', mimeType: 'video/mp4', format: 'mp4' };
  }

  // WebM (EBML): 1A 45 DF A3 at offset 0..3 (for HERO_VIDEO only)
  if (
    buffer.length >= 4 &&
    buffer[0] === 0x1a &&
    buffer[1] === 0x45 &&
    buffer[2] === 0xdf &&
    buffer[3] === 0xa3
  ) {
    return { valid: true, kind: 'video', mimeType: 'video/webm', format: 'webm' };
  }

  return { valid: false, kind: 'unknown', mimeType: null, format: null };
}

function toHexChannel(value: number): string {
  const clamped = Math.max(0, Math.min(255, Math.round(value)));
  return clamped.toString(16).padStart(2, '0').toUpperCase();
}

export async function inspectAspectAndAlpha(buffer: Buffer): Promise<AspectAndAlphaInspection> {
  const metadata = await sharp(buffer).metadata();
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;

  if (width <= 0 || height <= 0) {
    throw new Error('Image dimensions could not be decoded');
  }

  const aspectRatio = width / height;
  const aspectDeviationPct =
    Math.abs(aspectRatio - RACK_TARGET_ASPECT_RATIO) / RACK_TARGET_ASPECT_RATIO;
  const aspectValid = aspectDeviationPct <= RACK_ASPECT_TOLERANCE_PCT;
  const hasAlphaMetadata = metadata.hasAlpha === true;

  const { data, info } = await sharp(buffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const w = info.width;
  const h = info.height;
  const channels = info.channels;

  const corners: ReadonlyArray<[number, number]> = [
    [0, 0],
    [w - 1, 0],
    [0, h - 1],
    [w - 1, h - 1],
  ];

  const cornerAlphas = corners.map(([x, y]) => {
    const idx = (y * w + x) * channels + 3;
    return data[idx] ?? 255;
  });

  const transparentCorners = cornerAlphas.filter((alpha) => alpha < CORNER_ALPHA_THRESHOLD).length;
  const hasRealAlpha = hasAlphaMetadata && transparentCorners >= MIN_TRANSPARENT_CORNERS;

  return {
    width,
    height,
    aspectRatio,
    aspectDeviationPct,
    aspectValid,
    hasAlphaMetadata,
    transparentCorners,
    cornerAlphas,
    hasRealAlpha,
  };
}

export async function computeDominantHex(buffer: Buffer): Promise<string> {
  const stats = await sharp(buffer).stats();
  const { r, g, b } = stats.dominant;
  return `#${toHexChannel(r)}${toHexChannel(g)}${toHexChannel(b)}`;
}

/**
 * Computes REAL garment/foreground bounding box from raw RGBA image pixels.
 * - For alpha-cutout images (PNG/WebP with transparent border): scans all pixels where alpha > 16.
 * - For opaque images (JPEG / flat-lay / lookbook): samples corner background color and scans
 *   all non-background pixels outside RGB tolerance.
 */
export async function computePixelBoundingBox(buffer: Buffer): Promise<PixelBoundingBox> {
  const { data, info } = await sharp(buffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const imgW = Math.max(1, info.width);
  const imgH = Math.max(1, info.height);
  const channels = info.channels;

  const alphaThreshold = 16;
  const corners: ReadonlyArray<[number, number]> = [
    [0, 0],
    [imgW - 1, 0],
    [0, imgH - 1],
    [imgW - 1, imgH - 1],
  ];

  let transparentCornerCount = 0;
  for (const [cx, cy] of corners) {
    const idx = (cy * imgW + cx) * channels;
    if ((data[idx + 3] ?? 255) <= alphaThreshold) {
      transparentCornerCount += 1;
    }
  }

  let hasAnyTransparentPixel = transparentCornerCount > 0;
  if (!hasAnyTransparentPixel) {
    const stride = Math.max(1, Math.floor((imgW * imgH) / 4096));
    for (let p = 0; p < imgW * imgH; p += stride) {
      if ((data[p * channels + 3] ?? 255) <= alphaThreshold) {
        hasAnyTransparentPixel = true;
        break;
      }
    }
  }

  let minX = imgW;
  let minY = imgH;
  let maxX = -1;
  let maxY = -1;

  if (hasAnyTransparentPixel) {
    for (let y = 0; y < imgH; y += 1) {
      const rowOffset = y * imgW * channels;
      for (let x = 0; x < imgW; x += 1) {
        const a = data[rowOffset + x * channels + 3] ?? 255;
        if (a > alphaThreshold) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
  } else {
    // Opaque image: estimate background RGB from the 4 corners and scan non-background pixels
    let sumR = 0;
    let sumG = 0;
    let sumB = 0;
    for (const [cx, cy] of corners) {
      const idx = (cy * imgW + cx) * channels;
      sumR += data[idx] ?? 0;
      sumG += data[idx + 1] ?? 0;
      sumB += data[idx + 2] ?? 0;
    }
    const bgR = sumR / corners.length;
    const bgG = sumG / corners.length;
    const bgB = sumB / corners.length;
    const rgbManhattanTolerance = 36;

    for (let y = 0; y < imgH; y += 1) {
      const rowOffset = y * imgW * channels;
      for (let x = 0; x < imgW; x += 1) {
        const idx = rowOffset + x * channels;
        const diff =
          Math.abs((data[idx] ?? 0) - bgR) +
          Math.abs((data[idx + 1] ?? 0) - bgG) +
          Math.abs((data[idx + 2] ?? 0) - bgB);
        if (diff > rgbManhattanTolerance) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
  }

  // Fallback if image is 100% uniform or 100% transparent: full pixel canvas bounds
  if (maxX < minX || maxY < minY) {
    minX = 0;
    minY = 0;
    maxX = imgW - 1;
    maxY = imgH - 1;
  }

  const width = Math.max(1, maxX - minX + 1);
  const height = Math.max(1, maxY - minY + 1);
  const normalizedX = Number((minX / imgW).toFixed(4));
  const normalizedY = Number((minY / imgH).toFixed(4));
  const normalizedWidth = Number((width / imgW).toFixed(4));
  const normalizedHeight = Number((height / imgH).toFixed(4));

  return {
    x: minX,
    y: minY,
    width,
    height,
    normalizedX,
    normalizedY,
    normalizedWidth,
    normalizedHeight,
    imageWidth: imgW,
    imageHeight: imgH,
    computedFromPixels: true,
    shoulderY: Number(Math.min(1, normalizedY + normalizedHeight * 0.08).toFixed(4)),
    waistY: Number(Math.min(1, normalizedY + normalizedHeight * 0.42).toFixed(4)),
    hipY: Number(Math.min(1, normalizedY + normalizedHeight * 0.62).toFixed(4)),
    hemY: Number(Math.min(1, normalizedY + normalizedHeight).toFixed(4)),
  };
}

/**
 * Flow 1 — 3D Rack & Outfit Studio (`RACK_CUTOUT_2_3`, `STUDIO_LAYER_2_3`, `PACKAGING_LAYER`)
 * Produces 480x720 and 720x1080 WebP variants preserving full alpha transparency.
 */
export async function generateRackCutoutVariants(buffer: Buffer): Promise<RackCutoutVariants> {
  const [res480, res720] = await Promise.all([
    sharp(buffer)
      .ensureAlpha()
      .resize(480, 720, {
        fit: 'contain',
        position: 'centre',
        background: TRANSPARENT_RGBA,
      })
      .webp({ quality: 88, alphaQuality: 100 })
      .toBuffer({ resolveWithObject: true }),
    sharp(buffer)
      .ensureAlpha()
      .resize(720, 1080, {
        fit: 'contain',
        position: 'centre',
        background: TRANSPARENT_RGBA,
      })
      .webp({ quality: 90, alphaQuality: 100 })
      .toBuffer({ resolveWithObject: true }),
  ]);

  return {
    w480: {
      buffer: res480.data,
      width: res480.info.width,
      height: res480.info.height,
      mimeType: 'image/webp',
      sizeBytes: res480.data.length,
    },
    w720: {
      buffer: res720.data,
      width: res720.info.width,
      height: res720.info.height,
      mimeType: 'image/webp',
      sizeBytes: res720.data.length,
    },
  };
}

/**
 * Flow 2 — AI Try-On Flat-Lay (`TRYON_FLAT_3_4`)
 * Normalizes & centers garment onto crisp 768x1024 (3:4) clean studio neutral backdrop,
 * plus a matching Storefront/Admin public preview variant (768x1024 + 720w).
 */
export async function generateTryOnFlatLayVariants(buffer: Buffer): Promise<TryOnFlatLayVariants> {
  const flatRes = await sharp(buffer)
    .flatten({ background: STUDIO_NEUTRAL_RGB })
    .resize(768, 1024, {
      fit: 'contain',
      position: 'centre',
      background: STUDIO_NEUTRAL_RGBA,
    })
    .webp({ quality: 92 })
    .toBuffer({ resolveWithObject: true });

  const [previewRes, w720Res] = await Promise.all([
    sharp(flatRes.data)
      .webp({ quality: 86 })
      .toBuffer({ resolveWithObject: true }),
    sharp(flatRes.data)
      .resize(720, 960, {
        fit: 'contain',
        position: 'centre',
        background: STUDIO_NEUTRAL_RGBA,
      })
      .webp({ quality: 86 })
      .toBuffer({ resolveWithObject: true }),
  ]);

  return {
    flat768x1024: {
      buffer: flatRes.data,
      width: flatRes.info.width,
      height: flatRes.info.height,
      mimeType: 'image/webp',
      sizeBytes: flatRes.data.length,
    },
    preview768x1024: {
      buffer: previewRes.data,
      width: previewRes.info.width,
      height: previewRes.info.height,
      mimeType: 'image/webp',
      sizeBytes: previewRes.data.length,
    },
    w720: {
      buffer: w720Res.data,
      width: w720Res.info.width,
      height: w720Res.info.height,
      mimeType: 'image/webp',
      sizeBytes: w720Res.data.length,
    },
  };
}

/**
 * Flow 3 — Editorial Lookbook (`LOOKBOOK_PHOTO`)
 * Produces 960w and 1600w WebP variants for Storefront PDP/Lookbook galleries.
 */
export async function generateLookbookVariants(buffer: Buffer): Promise<LookbookVariants> {
  const [res960, res1600] = await Promise.all([
    sharp(buffer)
      .resize({ width: 960, withoutEnlargement: false })
      .webp({ quality: 88 })
      .toBuffer({ resolveWithObject: true }),
    sharp(buffer)
      .resize({ width: 1600, withoutEnlargement: true })
      .webp({ quality: 90 })
      .toBuffer({ resolveWithObject: true }),
  ]);

  return {
    w960: {
      buffer: res960.data,
      width: res960.info.width,
      height: res960.info.height,
      mimeType: 'image/webp',
      sizeBytes: res960.data.length,
    },
    w1600: {
      buffer: res1600.data,
      width: res1600.info.width,
      height: res1600.info.height,
      mimeType: 'image/webp',
      sizeBytes: res1600.data.length,
    },
  };
}

const GARMENT_TARGET_ASPECT_RATIO = 3 / 4; // 0.75
const GARMENT_ASPECT_WARN_DEVIATION = 0.12;
const GARMENT_MIN_WIDTH = 512;
const GARMENT_MIN_HEIGHT = 640;
const GARMENT_CORNER_ALPHA_THRESHOLD = 24;
const GARMENT_CORNER_MIN_TRANSPARENT_RATIO = 0.6;
const GARMENT_LAPLACIAN_BLUR_THRESHOLD = 40;
const GARMENT_CONTRAST_STDDEV_THRESHOLD = 18;
const GARMENT_BORDER_CLIP_RATIO_THRESHOLD = 0.3;

const CANONICAL_ASPECT_RATIOS: ReadonlyArray<{ label: string; value: number }> = [
  { label: '3:4', value: 3 / 4 },
  { label: '2:3', value: 2 / 3 },
  { label: '4:5', value: 4 / 5 },
  { label: '1:1', value: 1 },
  { label: '4:3', value: 4 / 3 },
  { label: '3:2', value: 3 / 2 },
  { label: '16:9', value: 16 / 9 },
  { label: '9:16', value: 9 / 16 },
  { label: '16:10', value: 16 / 10 },
  { label: '21:9', value: 21 / 9 },
];

function gcdInt(a: number, b: number): number {
  let x = Math.abs(Math.trunc(a));
  let y = Math.abs(Math.trunc(b));
  while (y !== 0) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x || 1;
}

export function detectCanonicalAspectRatioLabel(width: number, height: number): string {
  if (width <= 0 || height <= 0) {
    return 'unknown';
  }
  const ratio = width / height;
  let bestLabel: string | null = null;
  let bestRelErr = Number.POSITIVE_INFINITY;
  for (const item of CANONICAL_ASPECT_RATIOS) {
    const relErr = Math.abs(ratio - item.value) / item.value;
    if (relErr < bestRelErr) {
      bestRelErr = relErr;
      bestLabel = item.label;
    }
  }
  if (bestLabel && bestRelErr <= 0.04) {
    return bestLabel;
  }

  const divisor = gcdInt(width, height);
  const rw = Math.round(width / divisor);
  const rh = Math.round(height / divisor);
  if (rw <= 24 && rh <= 24) {
    return `${rw}:${rh}`;
  }

  // Find compact integer approximation W:H with denominator <= 16
  let approxW = Math.max(1, Math.round(ratio * 10));
  let approxH = 10;
  let approxErr = Number.POSITIVE_INFINITY;
  for (let h = 1; h <= 16; h += 1) {
    const w = Math.max(1, Math.round(ratio * h));
    const err = Math.abs(w / h - ratio);
    if (err < approxErr) {
      approxErr = err;
      approxW = w;
      approxH = h;
    }
  }
  const d2 = gcdInt(approxW, approxH);
  return `${approxW / d2}:${approxH / d2}`;
}

function computeGrayscaleSharpnessAndContrast(
  gray: Buffer,
  width: number,
  height: number,
): { laplacianVariance: number; luminanceStdDev: number } {
  const total = width * height;
  if (total === 0) {
    return { laplacianVariance: 0, luminanceStdDev: 0 };
  }

  let lumSum = 0;
  for (let i = 0; i < total; i += 1) {
    lumSum += gray[i] ?? 0;
  }
  const lumMean = lumSum / total;

  let lumSqDiff = 0;
  for (let i = 0; i < total; i += 1) {
    const d = (gray[i] ?? 0) - lumMean;
    lumSqDiff += d * d;
  }
  const luminanceStdDev = Math.sqrt(lumSqDiff / total);

  if (width < 3 || height < 3) {
    return { laplacianVariance: 0, luminanceStdDev };
  }

  // 3x3 discrete Laplacian kernel: [0, 1, 0; 1, -4, 1; 0, 1, 0]
  const interiorCount = (width - 2) * (height - 2);
  let lapSum = 0;
  let lapSqSum = 0;
  for (let y = 1; y < height - 1; y += 1) {
    const row = y * width;
    const prevRow = (y - 1) * width;
    const nextRow = (y + 1) * width;
    for (let x = 1; x < width - 1; x += 1) {
      const center = gray[row + x] ?? 0;
      const top = gray[prevRow + x] ?? 0;
      const bottom = gray[nextRow + x] ?? 0;
      const left = gray[row + x - 1] ?? 0;
      const right = gray[row + x + 1] ?? 0;
      const lap = top + bottom + left + right - 4 * center;
      lapSum += lap;
      lapSqSum += lap * lap;
    }
  }
  const lapMean = lapSum / interiorCount;
  const laplacianVariance = Math.max(0, lapSqSum / interiorCount - lapMean * lapMean);

  return { laplacianVariance, luminanceStdDev };
}

/**
 * Real binary image quality analysis for AI Try-On garment assets (P2-4.3):
 * - Magic Bytes verification (PNG/JPEG/WebP)
 * - Exact sharp metadata & RGBA pixel decoding
 * - Resolution & canonical 3:4 aspect ratio deviation scoring
 * - 4-corner 16x16 alpha transparency ratio check
 * - 3x3 Laplacian sharpness variance + luminance contrast std-dev on 256px grayscale
 * - Outer 2px border obstruction / edge clipping check
 */
export async function analyzeGarmentImage(buffer: Buffer): Promise<GarmentValidationResult> {
  const sizeBytes = Buffer.isBuffer(buffer) ? buffer.length : 0;
  const magic = detectMagicBytes(buffer);

  if (!magic.valid || magic.kind !== 'image' || !magic.mimeType || !magic.format) {
    return {
      isValid: false,
      qualityScore: 0,
      detectedAspectRatio: 'unknown',
      width: 0,
      height: 0,
      aspectRatio: 0,
      hasAlpha: false,
      cornerTransparencyRatio: 0,
      sharpnessScore: 0,
      contrastScore: 0,
      edgeClipped: false,
      warnings: [
        'Tệp ảnh giả mạo hoặc không đúng định dạng nhị phân (Magic Bytes không khớp PNG, JPEG hoặc WebP thực).',
      ],
      metrics: {
        magicBytesValid: false,
        detectedFormat: null,
        mimeType: null,
        sizeBytes,
        aspectDeviationPct: 100,
        laplacianVariance: 0,
        luminanceStdDev: 0,
        maxBorderTouchRatio: 0,
        borderTouchRatios: { top: 0, bottom: 0, left: 0, right: 0 },
        transparentCornerPixels: 0,
        totalCornerPixels: 0,
        corrupted: false,
      },
    };
  }

  let width = 0;
  let height = 0;
  let hasAlpha = false;
  let rgbaData: Buffer;
  let rgbaWidth = 0;
  let rgbaHeight = 0;
  let rgbaChannels = 4;

  try {
    const metadata = await sharp(buffer).metadata();
    width = metadata.width ?? 0;
    height = metadata.height ?? 0;
    hasAlpha = metadata.hasAlpha === true;

    if (width <= 0 || height <= 0) {
      throw new Error('Image dimensions could not be decoded');
    }

    const rawDecoded = await sharp(buffer)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    rgbaData = rawDecoded.data;
    rgbaWidth = rawDecoded.info.width;
    rgbaHeight = rawDecoded.info.height;
    rgbaChannels = rawDecoded.info.channels;
  } catch (err: unknown) {
    return {
      isValid: false,
      qualityScore: 0,
      detectedAspectRatio: 'unknown',
      width: 0,
      height: 0,
      aspectRatio: 0,
      hasAlpha: false,
      cornerTransparencyRatio: 0,
      sharpnessScore: 0,
      contrastScore: 0,
      edgeClipped: false,
      warnings: [
        'Tệp ảnh bị hỏng hoặc thiếu dữ liệu pixel — không thể giải mã hợp lệ để kiểm định Try-On.',
      ],
      metrics: {
        magicBytesValid: true,
        detectedFormat: magic.format as 'jpeg' | 'png' | 'webp',
        mimeType: magic.mimeType,
        sizeBytes,
        aspectDeviationPct: 100,
        laplacianVariance: 0,
        luminanceStdDev: 0,
        maxBorderTouchRatio: 0,
        borderTouchRatios: { top: 0, bottom: 0, left: 0, right: 0 },
        transparentCornerPixels: 0,
        totalCornerPixels: 0,
        corrupted: true,
        decodeError: err instanceof Error ? err.message : String(err),
      },
    };
  }

  const rawAspectRatio = width / height;
  const aspectRatio = Number(rawAspectRatio.toFixed(4));
  const detectedAspectRatio = detectCanonicalAspectRatioLabel(width, height);
  const aspectDeviation =
    Math.abs(rawAspectRatio - GARMENT_TARGET_ASPECT_RATIO) / GARMENT_TARGET_ASPECT_RATIO;
  const aspectDeviationPct = Number((aspectDeviation * 100).toFixed(2));

  // 1. Sample 4 corner patches (up to 16x16 each) for alpha transparency & opaque background RGB
  const patchW = Math.min(16, Math.max(1, Math.floor(rgbaWidth / 8) || 1));
  const patchH = Math.min(16, Math.max(1, Math.floor(rgbaHeight / 8) || 1));
  const cornerOrigins: ReadonlyArray<[number, number]> = [
    [0, 0],
    [Math.max(0, rgbaWidth - patchW), 0],
    [0, Math.max(0, rgbaHeight - patchH)],
    [Math.max(0, rgbaWidth - patchW), Math.max(0, rgbaHeight - patchH)],
  ];

  let transparentCornerPixels = 0;
  let totalCornerPixels = 0;
  let cornerSumR = 0;
  let cornerSumG = 0;
  let cornerSumB = 0;

  for (const [ox, oy] of cornerOrigins) {
    for (let dy = 0; dy < patchH; dy += 1) {
      const y = oy + dy;
      const rowOffset = y * rgbaWidth * rgbaChannels;
      for (let dx = 0; dx < patchW; dx += 1) {
        const idx = rowOffset + (ox + dx) * rgbaChannels;
        const r = rgbaData[idx] ?? 0;
        const g = rgbaData[idx + 1] ?? 0;
        const b = rgbaData[idx + 2] ?? 0;
        const a = rgbaData[idx + 3] ?? 255;
        totalCornerPixels += 1;
        cornerSumR += r;
        cornerSumG += g;
        cornerSumB += b;
        if (a < GARMENT_CORNER_ALPHA_THRESHOLD) {
          transparentCornerPixels += 1;
        }
      }
    }
  }

  const cornerTransparencyRatio =
    totalCornerPixels > 0
      ? Number((transparentCornerPixels / totalCornerPixels).toFixed(4))
      : 0;
  const hasRealTransparentCorners =
    hasAlpha && cornerTransparencyRatio >= GARMENT_CORNER_MIN_TRANSPARENT_RATIO;

  const bgR = totalCornerPixels > 0 ? cornerSumR / totalCornerPixels : 255;
  const bgG = totalCornerPixels > 0 ? cornerSumG / totalCornerPixels : 255;
  const bgB = totalCornerPixels > 0 ? cornerSumB / totalCornerPixels : 255;

  // 2. Sharpness (3x3 Laplacian variance) & Contrast (luminance std-dev) on resized 256px grayscale
  let laplacianVariance = 0;
  let luminanceStdDev = 0;

  if (hasRealTransparentCorners) {
    // Evaluate on both light studio and dark studio backdrops so neither dark blazers nor ivory gowns lose contrast
    const [lightGray, darkGray] = await Promise.all([
      sharp(buffer)
        .flatten({ background: STUDIO_NEUTRAL_RGB })
        .resize(256, 256, { fit: 'inside', withoutEnlargement: true })
        .grayscale()
        .raw()
        .toBuffer({ resolveWithObject: true }),
      sharp(buffer)
        .flatten({ background: { r: 28, g: 20, b: 16 } })
        .resize(256, 256, { fit: 'inside', withoutEnlargement: true })
        .grayscale()
        .raw()
        .toBuffer({ resolveWithObject: true }),
    ]);

    const lightStats = computeGrayscaleSharpnessAndContrast(
      lightGray.data,
      lightGray.info.width,
      lightGray.info.height,
    );
    const darkStats = computeGrayscaleSharpnessAndContrast(
      darkGray.data,
      darkGray.info.width,
      darkGray.info.height,
    );
    laplacianVariance = Math.max(lightStats.laplacianVariance, darkStats.laplacianVariance);
    luminanceStdDev = Math.max(lightStats.luminanceStdDev, darkStats.luminanceStdDev);
  } else {
    const grayRes = await sharp(buffer)
      .resize(256, 256, { fit: 'inside', withoutEnlargement: true })
      .grayscale()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const stats = computeGrayscaleSharpnessAndContrast(
      grayRes.data,
      grayRes.info.width,
      grayRes.info.height,
    );
    laplacianVariance = stats.laplacianVariance;
    luminanceStdDev = stats.luminanceStdDev;
  }

  const sharpnessScore = Math.round(
    Math.max(0, Math.min(100, (Math.log1p(Math.max(0, laplacianVariance)) / Math.log1p(1200)) * 100)),
  );
  const contrastScore = Math.round(
    Math.max(0, Math.min(100, (luminanceStdDev / 64) * 100)),
  );

  // 3. Edge clipping / outer 2px border obstruction check
  const borderDepth = Math.min(2, Math.max(1, Math.floor(Math.min(rgbaWidth, rgbaHeight) / 4)));
  const isForegroundPixel = (x: number, y: number): boolean => {
    const idx = (y * rgbaWidth + x) * rgbaChannels;
    if (hasRealTransparentCorners) {
      return (rgbaData[idx + 3] ?? 255) > GARMENT_CORNER_ALPHA_THRESHOLD;
    }
    const diff =
      Math.abs((rgbaData[idx] ?? 0) - bgR) +
      Math.abs((rgbaData[idx + 1] ?? 0) - bgG) +
      Math.abs((rgbaData[idx + 2] ?? 0) - bgB);
    return diff > 42;
  };

  let topFg = 0;
  let topTotal = 0;
  let bottomFg = 0;
  let bottomTotal = 0;
  for (let d = 0; d < borderDepth; d += 1) {
    const yTop = d;
    const yBottom = rgbaHeight - 1 - d;
    for (let x = 0; x < rgbaWidth; x += 1) {
      topTotal += 1;
      if (isForegroundPixel(x, yTop)) topFg += 1;
      bottomTotal += 1;
      if (isForegroundPixel(x, yBottom)) bottomFg += 1;
    }
  }

  let leftFg = 0;
  let leftTotal = 0;
  let rightFg = 0;
  let rightTotal = 0;
  for (let d = 0; d < borderDepth; d += 1) {
    const xLeft = d;
    const xRight = rgbaWidth - 1 - d;
    for (let y = 0; y < rgbaHeight; y += 1) {
      leftTotal += 1;
      if (isForegroundPixel(xLeft, y)) leftFg += 1;
      rightTotal += 1;
      if (isForegroundPixel(xRight, y)) rightFg += 1;
    }
  }

  const topRatio = topTotal > 0 ? Number((topFg / topTotal).toFixed(4)) : 0;
  const bottomRatio = bottomTotal > 0 ? Number((bottomFg / bottomTotal).toFixed(4)) : 0;
  const leftRatio = leftTotal > 0 ? Number((leftFg / leftTotal).toFixed(4)) : 0;
  const rightRatio = rightTotal > 0 ? Number((rightFg / rightTotal).toFixed(4)) : 0;
  const maxBorderTouchRatio = Number(
    Math.max(topRatio, bottomRatio, leftRatio, rightRatio).toFixed(4),
  );
  const edgeClipped = maxBorderTouchRatio > GARMENT_BORDER_CLIP_RATIO_THRESHOLD;

  // 4. Dynamic quality score & actionable Vietnamese warnings
  const warnings: string[] = [];
  let score = 100;

  if (width < GARMENT_MIN_WIDTH || height < GARMENT_MIN_HEIGHT) {
    score -= width < 256 || height < 320 ? 25 : 18;
    warnings.push(
      `Độ phân giải ảnh quá thấp (${width}×${height}px) — cần tối thiểu ${GARMENT_MIN_WIDTH}×${GARMENT_MIN_HEIGHT}px (chuẩn khuyến nghị 768×1024px) cho Phòng Thử Đồ AI.`,
    );
  }

  if (aspectDeviation > GARMENT_ASPECT_WARN_DEVIATION) {
    score -= aspectDeviation > 0.45 ? 25 : aspectDeviation > 0.25 ? 18 : 12;
    warnings.push(
      `Tỷ lệ khung hình ${detectedAspectRatio} (${width}×${height}) lệch ${aspectDeviationPct.toFixed(1)}% so với chuẩn 3:4 của Phòng Thử Đồ AI.`,
    );
  }

  if (!hasAlpha || cornerTransparencyRatio < GARMENT_CORNER_MIN_TRANSPARENT_RATIO) {
    score -= !hasAlpha || cornerTransparencyRatio < 0.1 ? 22 : 14;
    warnings.push(
      'Ảnh còn nền đặc ở 4 góc — nên tách nền PNG/WebP trong suốt trước khi đưa vào thử đồ.',
    );
  }

  if (laplacianVariance < GARMENT_LAPLACIAN_BLUR_THRESHOLD) {
    score -= laplacianVariance < 15 ? 18 : 12;
    warnings.push(
      `Ảnh bị mờ hoặc thiếu độ sắc nét chi tiết vải (Laplacian variance=${laplacianVariance.toFixed(1)}) — vui lòng dùng ảnh chụp rõ nét hơn.`,
    );
  }

  if (luminanceStdDev < GARMENT_CONTRAST_STDDEV_THRESHOLD) {
    score -= luminanceStdDev < 8 ? 15 : 10;
    warnings.push(
      `Độ tương phản ảnh quá thấp hoặc bị nhợt màu (độ lệch chuẩn độ sáng=${luminanceStdDev.toFixed(1)}).`,
    );
  }

  if (edgeClipped) {
    score -= 15;
    warnings.push(
      'Trang phục chạm sát mép khung hình, có nguy cơ bị cắt viền khi dựng Try-On.',
    );
  }

  const qualityScore = Math.max(0, Math.min(100, Math.round(score)));
  const isValid =
    qualityScore >= 70 &&
    width >= GARMENT_MIN_WIDTH &&
    height >= GARMENT_MIN_HEIGHT &&
    aspectDeviation <= 0.15;

  return {
    isValid,
    qualityScore,
    detectedAspectRatio,
    width,
    height,
    aspectRatio,
    hasAlpha,
    cornerTransparencyRatio,
    sharpnessScore,
    contrastScore,
    edgeClipped,
    warnings,
    metrics: {
      magicBytesValid: true,
      detectedFormat: magic.format as 'jpeg' | 'png' | 'webp',
      mimeType: magic.mimeType,
      sizeBytes,
      aspectDeviationPct,
      laplacianVariance: Number(laplacianVariance.toFixed(2)),
      luminanceStdDev: Number(luminanceStdDev.toFixed(2)),
      maxBorderTouchRatio,
      borderTouchRatios: {
        top: topRatio,
        bottom: bottomRatio,
        left: leftRatio,
        right: rightRatio,
      },
      transparentCornerPixels,
      totalCornerPixels,
      corrupted: false,
    },
  };
}
