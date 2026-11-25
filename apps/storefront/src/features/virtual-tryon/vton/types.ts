export type LightingPresetId = 'morning' | 'atelier' | 'evening';

export type TryOnGarmentSlot = 'upper' | 'lower' | 'onePiece' | 'outerwear';

export type TryOnProviderId =
  | 'local_preview'
  | 'fal'
  | 'fashn'
  | 'catvton'
  | 'hf_gradio'
  | 'local_gpu'
  | 'photometric_inpaint'
  | (string & {});

export type TryOnSynthesisMode = 'SINGLE' | 'OUTFIT';

export type TryOnSynthesisJobStatus =
  | 'QUEUED'
  | 'PROCESSING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED';

export type TryOnSizeCode = 'XS' | 'S' | 'M' | 'L' | 'XL';

export interface NormalizedPoseLandmark {
  x: number;
  y: number;
  z: number;
  visibility: number;
}

export interface SessionPersonFrame {
  frameId: string;
  frameHash: string;
  dataUrl: string;
  width: 768;
  height: 1024;
  source: 'camera' | 'upload' | 'preset';
  presetId?: string;
  label: string;
  poseLandmarks: NormalizedPoseLandmark[];
  ambientRgb: [number, number, number];
  capturedAt: number;
  expiresAt: number;
}

export interface QuickTryOnModelPreset {
  id: string;
  name: string;
  heightCm: number;
  weightKg: number;
  bustCm: number;
  waistCm: number;
  hipCm: number;
  recommendedSize: TryOnSizeCode;
  subtitle: string;
  imageUrl: string;
  fallbackLandmarks: NormalizedPoseLandmark[];
  ambientRgb: [number, number, number];
}

export interface TryOnSynthesisGarmentInput {
  productId: string;
  variantId: string;
  slot: TryOnGarmentSlot;
  name: string;
  garmentImageUrl: string;
  colorHex: string;
  colorName: string;
}

export interface TryOnSynthesisProgress {
  jobId?: string;
  status: TryOnSynthesisJobStatus;
  progressPct: number;
  stageLabel: string;
  stepCurrent: number;
  stepTotal: number;
}

export interface TryOnSynthesisResult {
  cacheKey: string;
  cacheHit: boolean;
  provider: TryOnProviderId;
  providerBadge: string;
  resultDataUrl: string;
  latencyMs: number;
  cleanCollarApplied: boolean;
  jobId?: string;
  expiresInSeconds?: number;
  quotaRemaining?: number;
  stepTotal?: number;
}

export interface GarmentAnchors {
  leftShoulderX: number;
  rightShoulderX: number;
  collarTopY: number;
  collarBottomY: number;
  shoulderCapY?: number;
  waistY: number;
  hemY: number;
}

export interface PreparedGarmentAsset {
  canvas: HTMLCanvasElement;
  anchors: GarmentAnchors;
  cleanCollarApplied: boolean;
  cleanDataUrl: string;
}

export interface LightingPresetMeta {
  id: LightingPresetId;
  label: string;
  tintRgb: [number, number, number];
  tintStrength: number;
  contrast: number;
  brightness: number;
  warmthShift: number;
}

export const LIGHTING_PRESET_META: Record<LightingPresetId, LightingPresetMeta> = {
  morning: {
    id: 'morning',
    label: 'Nắng Sớm',
    tintRgb: [255, 248, 236],
    tintStrength: 0.14,
    contrast: 1.03,
    brightness: 1.04,
    warmthShift: 0.04,
  },
  atelier: {
    id: 'atelier',
    label: 'Showroom Atelier',
    tintRgb: [248, 244, 237],
    tintStrength: 0.08,
    contrast: 1.02,
    brightness: 1.0,
    warmthShift: 0.01,
  },
  evening: {
    id: 'evening',
    label: 'Đèn Tiệc Tối',
    tintRgb: [242, 206, 162],
    tintStrength: 0.22,
    contrast: 1.07,
    brightness: 0.92,
    warmthShift: 0.09,
  },
};

export interface SynthesizeTryOnParams {
  personFrame: SessionPersonFrame;
  garments: TryOnSynthesisGarmentInput[];
  lightingPreset: LightingPresetId;
  mode?: TryOnSynthesisMode;
  onStageChange?: (stageIndex: number) => void;
  onProgress?: (update: TryOnSynthesisProgress) => void;
  signal?: AbortSignal;
}

export interface BffTryOnSynthesizeResponse {
  success?: boolean;
  jobId?: string | null;
  sessionId?: string | null;
  status: string;
  provider?: TryOnProviderId | null;
  providerUsed?: TryOnProviderId | null;
  providerBadge?: string | null;
  providerDisplayBadge?: string | null;
  stage2Ready?: boolean;
  supportedProviders?: TryOnProviderId[];
  cacheHit?: boolean;
  cacheKey?: string;
  progressPct?: number;
  stageLabel?: string | null;
  stepCurrent?: number;
  stepTotal?: number;
  privacyTtlSeconds?: number;
  expiresAt?: string | null;
  expiresInSeconds?: number;
  quotaRemaining?: number;
  resultUrl?: string | null;
  resultImageUrl?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
}

export type BffTryOnJobStatusResponse = BffTryOnSynthesizeResponse;

export const TRYON_FRAME_WIDTH = 768 as const;
export const TRYON_FRAME_HEIGHT = 1024 as const;
export const TRYON_SESSION_TTL_MS = 15 * 60 * 1000;
