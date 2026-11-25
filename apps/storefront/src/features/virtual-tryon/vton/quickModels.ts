import { computeSha256Hex } from './sessionPersonStore';
import {
  TRYON_FRAME_HEIGHT,
  TRYON_FRAME_WIDTH,
  TRYON_SESSION_TTL_MS,
  type NormalizedPoseLandmark,
  type QuickTryOnModelPreset,
  type SessionPersonFrame,
} from './types';

interface CalibratedBodySpec {
  nose: [number, number];
  leftEye: [number, number];
  rightEye: [number, number];
  leftEar: [number, number];
  rightEar: [number, number];
  mouthLeft: [number, number];
  mouthRight: [number, number];
  leftShoulder: [number, number];
  rightShoulder: [number, number];
  leftElbow: [number, number];
  rightElbow: [number, number];
  leftWrist: [number, number];
  rightWrist: [number, number];
  leftHip: [number, number];
  rightHip: [number, number];
}

function build33PoseLandmarks(spec: CalibratedBodySpec): NormalizedPoseLandmark[] {
  const cx = Number(
    (((spec.leftShoulder[0] + spec.rightShoulder[0]) * 0.5)).toFixed(4),
  );
  const cy = Number(
    (((spec.leftShoulder[1] + spec.rightShoulder[1]) * 0.5)).toFixed(4),
  );

  const landmarks: NormalizedPoseLandmark[] = Array.from({ length: 33 }, () => ({
    x: cx,
    y: cy,
    z: 0,
    visibility: 0.1,
  }));

  const set = (idx: number, pt: [number, number], visibility: number) => {
    landmarks[idx] = { x: pt[0], y: pt[1], z: 0, visibility };
  };

  // MediaPipe Pose 33-landmark convention (front-facing subject):
  // odd indices = anatomical left (image-right), even indices = anatomical right (image-left)
  set(0, spec.nose, 0.99);
  set(2, spec.leftEye, 0.98);
  set(5, spec.rightEye, 0.98);
  set(7, spec.leftEar, 0.94);
  set(8, spec.rightEar, 0.94);
  set(9, spec.mouthLeft, 0.97);
  set(10, spec.mouthRight, 0.97);
  set(11, spec.leftShoulder, 0.99);
  set(12, spec.rightShoulder, 0.99);
  set(13, spec.leftElbow, 0.92);
  set(14, spec.rightElbow, 0.92);
  set(15, spec.leftWrist, 0.88);
  set(16, spec.rightWrist, 0.88);
  set(23, spec.leftHip, 0.95);
  set(24, spec.rightHip, 0.95);

  return landmarks;
}

/**
 * 4 curated high-resolution 768x1024 (3:4) Vietnamese studio quick-tryon model presets
 * covering XS/S, S/M, M, and L silhouettes with verified YuNet + silhouette landmarks.
 */
export const QUICK_TRYON_MODELS: readonly QuickTryOnModelPreset[] = [
  {
    id: 'vn-petite-xs',
    name: 'Minh Anh',
    heightCm: 156,
    weightKg: 46,
    bustCm: 80,
    waistCm: 61,
    hipCm: 86,
    recommendedSize: 'XS',
    subtitle: '1m56 · 46kg · Size XS/S',
    imageUrl: '/images/tryon-models/vn-model-petite-xs.webp',
    ambientRgb: [182, 178, 173],
    fallbackLandmarks: build33PoseLandmarks({
      nose: [0.5294, 0.2112],
      leftEye: [0.5572, 0.1822],
      rightEye: [0.4948, 0.1801],
      leftEar: [0.6073, 0.1967],
      rightEar: [0.4447, 0.1956],
      mouthLeft: [0.5472, 0.2309],
      mouthRight: [0.4926, 0.2284],
      leftShoulder: [0.616, 0.32],
      rightShoulder: [0.338, 0.316],
      leftElbow: [0.658, 0.52],
      rightElbow: [0.285, 0.52],
      leftWrist: [0.688, 0.715],
      rightWrist: [0.258, 0.715],
      leftHip: [0.605, 0.635],
      rightHip: [0.378, 0.635],
    }),
  },
  {
    id: 'vn-balanced-s',
    name: 'Thảo Vy',
    heightCm: 163,
    weightKg: 52,
    bustCm: 84,
    waistCm: 65,
    hipCm: 90,
    recommendedSize: 'S',
    subtitle: '1m63 · 52kg · Size S/M',
    imageUrl: '/images/tryon-models/vn-model-balanced-s.webp',
    ambientRgb: [216, 207, 201],
    fallbackLandmarks: build33PoseLandmarks({
      nose: [0.49, 0.1948],
      leftEye: [0.5272, 0.1503],
      rightEye: [0.4471, 0.159],
      leftEar: [0.5906, 0.1726],
      rightEar: [0.3838, 0.1769],
      mouthLeft: [0.5363, 0.2128],
      mouthRight: [0.4693, 0.2203],
      leftShoulder: [0.668, 0.348],
      rightShoulder: [0.332, 0.348],
      leftElbow: [0.718, 0.575],
      rightElbow: [0.296, 0.575],
      leftWrist: [0.742, 0.815],
      rightWrist: [0.268, 0.815],
      leftHip: [0.635, 0.708],
      rightHip: [0.365, 0.708],
    }),
  },
  {
    id: 'vn-tall-m',
    name: 'Khánh Linh',
    heightCm: 168,
    weightKg: 56,
    bustCm: 88,
    waistCm: 68,
    hipCm: 94,
    recommendedSize: 'M',
    subtitle: '1m68 · 56kg · Size M',
    imageUrl: '/images/tryon-models/vn-model-tall-m.webp',
    ambientRgb: [222, 219, 211],
    fallbackLandmarks: build33PoseLandmarks({
      nose: [0.5874, 0.2183],
      leftEye: [0.5988, 0.188],
      rightEye: [0.5351, 0.1885],
      leftEar: [0.6509, 0.2032],
      rightEar: [0.483, 0.2034],
      mouthLeft: [0.5943, 0.2446],
      mouthRight: [0.5405, 0.2442],
      leftShoulder: [0.638, 0.36],
      rightShoulder: [0.352, 0.352],
      leftElbow: [0.682, 0.568],
      rightElbow: [0.318, 0.562],
      leftWrist: [0.665, 0.675],
      rightWrist: [0.35, 0.78],
      leftHip: [0.625, 0.688],
      rightHip: [0.372, 0.688],
    }),
  },
  {
    id: 'vn-curvy-l',
    name: 'Ngọc Hân',
    heightCm: 162,
    weightKg: 63,
    bustCm: 94,
    waistCm: 76,
    hipCm: 100,
    recommendedSize: 'L',
    subtitle: '1m62 · 63kg · Size L',
    imageUrl: '/images/tryon-models/vn-model-curvy-l.webp',
    ambientRgb: [163, 122, 100],
    fallbackLandmarks: build33PoseLandmarks({
      nose: [0.5006, 0.2313],
      leftEye: [0.5319, 0.2038],
      rightEye: [0.4678, 0.2068],
      leftEar: [0.5784, 0.2176],
      rightEar: [0.4213, 0.2191],
      mouthLeft: [0.5334, 0.251],
      mouthRight: [0.4773, 0.2547],
      leftShoulder: [0.682, 0.348],
      rightShoulder: [0.338, 0.348],
      leftElbow: [0.715, 0.552],
      rightElbow: [0.312, 0.558],
      leftWrist: [0.565, 0.555],
      rightWrist: [0.455, 0.555],
      leftHip: [0.648, 0.682],
      rightHip: [0.372, 0.682],
    }),
  },
] as const;

export function getQuickTryOnModelById(
  id: string,
): QuickTryOnModelPreset | undefined {
  return QUICK_TRYON_MODELS.find((m) => m.id === id);
}

const presetFrameAssetCache = new Map<
  string,
  { dataUrl: string; frameHash: string }
>();

async function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result);
      } else {
        reject(new Error('Invalid DataURL result'));
      }
    };
    reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'));
    reader.readAsDataURL(blob);
  });
}

/**
 * Loads one of the 4 curated studio model portraits into a locked 768x1024
 * `SessionPersonFrame` with SHA-256 `frameHash`, calibrated 33-point landmarks,
 * and 15-minute auto-purge TTL.
 */
export async function loadQuickModelAsSessionFrame(
  preset: QuickTryOnModelPreset,
): Promise<SessionPersonFrame> {
  const now = Date.now();
  const cached = presetFrameAssetCache.get(preset.id);

  if (cached) {
    return {
      frameId: `preset-${preset.id}-${now}`,
      frameHash: cached.frameHash,
      dataUrl: cached.dataUrl,
      width: TRYON_FRAME_WIDTH,
      height: TRYON_FRAME_HEIGHT,
      source: 'preset',
      presetId: preset.id,
      label: `${preset.name} · ${preset.subtitle}`,
      poseLandmarks: preset.fallbackLandmarks,
      ambientRgb: preset.ambientRgb,
      capturedAt: now,
      expiresAt: now + TRYON_SESSION_TTL_MS,
    };
  }

  let dataUrl = preset.imageUrl;
  let frameHash = await computeSha256Hex(`preset:${preset.id}:${preset.imageUrl}`);

  if (typeof window !== 'undefined' && typeof fetch === 'function') {
    try {
      const response = await fetch(preset.imageUrl, {
        mode: 'same-origin',
        credentials: 'same-origin',
      });
      if (response.ok) {
        const blob = await response.blob();
        const bytes = new Uint8Array(await blob.arrayBuffer());
        frameHash = await computeSha256Hex(bytes);
        dataUrl = await blobToDataUrl(blob);
      }
    } catch {
      // Retain preset.imageUrl and deterministic hash if fetch fails offline
    }
  }

  presetFrameAssetCache.set(preset.id, { dataUrl, frameHash });

  return {
    frameId: `preset-${preset.id}-${now}`,
    frameHash,
    dataUrl,
    width: TRYON_FRAME_WIDTH,
    height: TRYON_FRAME_HEIGHT,
    source: 'preset',
    presetId: preset.id,
    label: `${preset.name} · ${preset.subtitle}`,
    poseLandmarks: preset.fallbackLandmarks,
    ambientRgb: preset.ambientRgb,
    capturedAt: now,
    expiresAt: now + TRYON_SESSION_TTL_MS,
  };
}
