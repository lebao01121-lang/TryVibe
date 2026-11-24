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
