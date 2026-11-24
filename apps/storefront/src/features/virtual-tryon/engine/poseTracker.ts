import type {
  ArmPoseAngles,
  PhotoPoseHint,
  PoseLandmark3D,
  PoseTracking3DFrame,
  TailorPinOverlayData,
} from './types';

const LOCAL_MODEL_URL = '/models/pose_landmarker_lite.task';
const CDN_MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';
const CDN_WASM_URL =
  'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.22/wasm';

export const TRACKED_POSE_INDICES = [
  0, 9, 10, 11, 12, 13, 14, 15, 16, 23, 24,
] as const;

interface RawLandmark {
  x: number;
  y: number;
  z: number;
  visibility?: number;
}

interface PoseLandmarkerInstance {
  detectForVideo: (
    video: HTMLVideoElement,
    timestampMs: number,
  ) => {
    landmarks?: RawLandmark[][];
    worldLandmarks?: RawLandmark[][];
  };
  detect: (
    image: HTMLImageElement | HTMLCanvasElement | ImageBitmap,
  ) => {
    landmarks?: RawLandmark[][];
    worldLandmarks?: RawLandmark[][];
  };
  close?: () => void;
}

export interface CoverProjectionMetrics {
  srcWidth: number;
  srcHeight: number;
  dstWidth: number;
  dstHeight: number;
  mirrored: boolean;
}

function clamp(v: number, min: number, max: number): number {
  if (!Number.isFinite(v)) return min;
  return Math.max(min, Math.min(max, v));
}

/**
 * Adaptive 1€ (One-Euro) low-pass filter (Casiez et al., CHI 2012)
 * eliminates high-frequency webcam jitter in dim rooms while keeping rapid
 * movements snappy and lag-free at 60 FPS.
 */
export class OneEuroFilter {
  private readonly minCutoff: number;
  private readonly beta: number;
  private readonly dCutoff: number;
  private xPrev: number | null = null;
  private dxPrev = 0;
  private tPrev: number | null = null;

  constructor(minCutoff = 1.35, beta = 0.045, dCutoff = 1.0) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
  }

  private alpha(cutoff: number, dt: number): number {
    const tau = 1 / (2 * Math.PI * Math.max(0.001, cutoff));
    return 1 / (1 + tau / Math.max(0.001, dt));
  }

  public filter(value: number, timestampSec: number): number {
    if (!Number.isFinite(value)) {
      return this.xPrev ?? 0;
    }
    if (this.xPrev === null || this.tPrev === null) {
      this.xPrev = value;
      this.dxPrev = 0;
      this.tPrev = timestampSec;
      return value;
    }

    const dt = clamp(timestampSec - this.tPrev, 1 / 240, 0.25);
    const dx = (value - this.xPrev) / dt;
    const aD = this.alpha(this.dCutoff, dt);
    const dxHat = aD * dx + (1 - aD) * this.dxPrev;

    const cutoff = this.minCutoff + this.beta * Math.abs(dxHat);
    const aX = this.alpha(cutoff, dt);
    const xHat = aX * value + (1 - aX) * this.xPrev;

    this.xPrev = xHat;
    this.dxPrev = dxHat;
    this.tPrev = timestampSec;
    return xHat;
  }

  public reset(): void {
    this.xPrev = null;
    this.dxPrev = 0;
    this.tPrev = null;
  }
}

class LandmarkFilter3D {
  private readonly fx: OneEuroFilter;
  private readonly fy: OneEuroFilter;
  private readonly fz: OneEuroFilter;

  constructor(minCutoff = 1.4, beta = 0.05) {
    this.fx = new OneEuroFilter(minCutoff, beta);
    this.fy = new OneEuroFilter(minCutoff, beta);
    this.fz = new OneEuroFilter(minCutoff * 0.85, beta * 0.8);
  }

  public filter(lm: RawLandmark, tSec: number): PoseLandmark3D {
    return {
      x: this.fx.filter(lm.x, tSec),
      y: this.fy.filter(lm.y, tSec),
      z: this.fz.filter(lm.z ?? 0, tSec),
      visibility: clamp(lm.visibility ?? 0.9, 0, 1),
    };
  }

  public reset(): void {
    this.fx.reset();
    this.fy.reset();
    this.fz.reset();
  }
}

export class PoseStreamFilterBank {
  private readonly imageFilters = new Map<number, LandmarkFilter3D>();
  private readonly worldFilters = new Map<number, LandmarkFilter3D>();
  private readonly yawFilter = new OneEuroFilter(1.1, 0.04);
  private readonly pitchFilter = new OneEuroFilter(1.1, 0.03);
  private readonly rollFilter = new OneEuroFilter(1.2, 0.04);

  constructor() {
    for (const idx of TRACKED_POSE_INDICES) {
      this.imageFilters.set(idx, new LandmarkFilter3D(1.45, 0.055));
      this.worldFilters.set(idx, new LandmarkFilter3D(1.1, 0.04));
    }
  }

  public filterImageLandmark(
    idx: number,
    lm: RawLandmark | undefined,
    tSec: number,
  ): PoseLandmark3D | undefined {
    if (!lm) return undefined;
    let f = this.imageFilters.get(idx);
    if (!f) {
      f = new LandmarkFilter3D(1.45, 0.055);
      this.imageFilters.set(idx, f);
    }
    return f.filter(lm, tSec);
  }

  public filterWorldLandmark(
    idx: number,
    lm: RawLandmark | undefined,
    tSec: number,
  ): PoseLandmark3D | undefined {
    if (!lm) return undefined;
    let f = this.worldFilters.get(idx);
    if (!f) {
      f = new LandmarkFilter3D(1.1, 0.04);
      this.worldFilters.set(idx, f);
    }
    return f.filter(lm, tSec);
  }

  public filterOrientation(
    yawY: number,
    pitchX: number,
    rollZ: number,
    tSec: number,
  ): { yawY: number; pitchX: number; rollZ: number } {
    return {
      yawY: this.yawFilter.filter(yawY, tSec),
      pitchX: this.pitchFilter.filter(pitchX, tSec),
      rollZ: this.rollFilter.filter(rollZ, tSec),
    };
  }

  public reset(): void {
    this.imageFilters.forEach((f) => f.reset());
    this.worldFilters.forEach((f) => f.reset());
    this.yawFilter.reset();
    this.pitchFilter.reset();
    this.rollFilter.reset();
  }
}

let videoLandmarkerPromise: Promise<PoseLandmarkerInstance | null> | null = null;
let imageLandmarkerPromise: Promise<PoseLandmarkerInstance | null> | null = null;
let videoLandmarkerInstance: PoseLandmarkerInstance | null = null;
let imageLandmarkerInstance: PoseLandmarkerInstance | null = null;

async function resolveModelAssetPath(): Promise<string> {
  if (typeof window === 'undefined' || typeof fetch !== 'function') {
    return CDN_MODEL_URL;
  }
  try {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 1600);
    const res = await fetch(LOCAL_MODEL_URL, {
      method: 'HEAD',
      signal: controller.signal,
    });
    window.clearTimeout(timer);
    if (res.ok) {
      const len = Number(res.headers.get('content-length') ?? '0');
      if (len === 0 || len > 50_000) {
        return LOCAL_MODEL_URL;
      }
    }
  } catch {
    // Local cached model not available, fall through to CDN
  }
  return CDN_MODEL_URL;
}

async function createPoseLandmarkerSafe(
  runningMode: 'VIDEO' | 'IMAGE',
  timeoutMs = 6500,
): Promise<PoseLandmarkerInstance | null> {
  if (typeof window === 'undefined') return null;

  const task = (async (): Promise<PoseLandmarkerInstance | null> => {
    try {
      const visionModule = await import('@mediapipe/tasks-vision');
      const wasmFileset = await visionModule.FilesetResolver.forVisionTasks(
        CDN_WASM_URL,
      );
      const preferredModel = await resolveModelAssetPath();
      const candidates =
        preferredModel === LOCAL_MODEL_URL
          ? [LOCAL_MODEL_URL, CDN_MODEL_URL]
          : [CDN_MODEL_URL];

      for (const modelAssetPath of candidates) {
        try {
          const instance = await visionModule.PoseLandmarker.createFromOptions(
            wasmFileset,
            {
              baseOptions: {
                modelAssetPath,
              },
              runningMode,
              numPoses: 1,
              minPoseDetectionConfidence: 0.45,
              minPosePresenceConfidence: 0.45,
              minTrackingConfidence: 0.45,
            },
          );
          return instance as unknown as PoseLandmarkerInstance;
        } catch {
          // Try next model candidate
        }
      }
      return null;
    } catch {
      return null;
    }
  })();

  const timeout = new Promise<null>((resolve) => {
    window.setTimeout(() => resolve(null), timeoutMs);
  });

  return Promise.race([task, timeout]);
}

export async function getVideoPoseLandmarker(): Promise<PoseLandmarkerInstance | null> {
  if (videoLandmarkerInstance) return videoLandmarkerInstance;
  if (!videoLandmarkerPromise) {
    videoLandmarkerPromise = createPoseLandmarkerSafe('VIDEO').then((inst) => {
      videoLandmarkerInstance = inst;
      return inst;
    });
  }
  return videoLandmarkerPromise;
}

export async function getImagePoseLandmarker(): Promise<PoseLandmarkerInstance | null> {
  if (imageLandmarkerInstance) return imageLandmarkerInstance;
  if (!imageLandmarkerPromise) {
    imageLandmarkerPromise = createPoseLandmarkerSafe('IMAGE').then((inst) => {
      imageLandmarkerInstance = inst;
      return inst;
    });
  }
  return imageLandmarkerPromise;
}

/**
 * Releases MediaPipe WASM PoseLandmarker instances cleanly.
 */
export function closePoseTrackers(): void {
  try {
    videoLandmarkerInstance?.close?.();
  } catch {
    // Ignore close errors
  }
  try {
    imageLandmarkerInstance?.close?.();
  } catch {
    // Ignore close errors
  }
  videoLandmarkerInstance = null;
  imageLandmarkerInstance = null;
  videoLandmarkerPromise = null;
  imageLandmarkerPromise = null;
}

/**
 * Projects a raw MediaPipe normalized coordinate `(x, y)` from source video/image
 * aspect ratio onto an `object-cover` viewport container (optionally horizontally mirrored).
 */
export function projectToCoverViewport(
  rawX: number,
  rawY: number,
  metrics: CoverProjectionMetrics,
): { x: number; y: number } {
  const srcW = Math.max(1, metrics.srcWidth);
  const srcH = Math.max(1, metrics.srcHeight);
  const dstW = Math.max(1, metrics.dstWidth);
  const dstH = Math.max(1, metrics.dstHeight);

  const srcAspect = srcW / srcH;
  const dstAspect = dstW / dstH;

  let vx = rawX;
  let vy = rawY;

  if (srcAspect > dstAspect) {
    // Source is wider than viewport: left/right sides cropped
    const visibleFrac = dstAspect / srcAspect;
    const offset = (1 - visibleFrac) * 0.5;
    vx = (rawX - offset) / visibleFrac;
  } else if (srcAspect < dstAspect) {
    // Source is taller than viewport: top/bottom cropped
    const visibleFrac = srcAspect / dstAspect;
    const offset = (1 - visibleFrac) * 0.5;
    vy = (rawY - offset) / visibleFrac;
  }

  if (metrics.mirrored) {
    vx = 1 - vx;
  }

  return { x: vx, y: vy };
}

function computeArmAngleMetrics(
  shoulder: PoseLandmark3D | undefined,
  elbow: PoseLandmark3D | undefined,
  wrist: PoseLandmark3D | undefined,
  isScreenLeft: boolean,
): { elbowAngle: number; shoulderLift: number } {
  if (!shoulder || !elbow || elbow.visibility < 0.35) {
    return { elbowAngle: 0, shoulderLift: 0 };
  }

  const dx1 = elbow.x - shoulder.x;
  const dy1 = elbow.y - shoulder.y;
  const sideDir = isScreenLeft ? -1 : 1;

  // Outward abduction lift: positive when elbow lifts outward/upward away from ribs
  const outward = dx1 * sideDir;
  const liftAngle = Math.atan2(outward, Math.max(0.03, dy1));
  const shoulderLift = clamp((liftAngle - 0.16) * 1.15, -0.35, 0.85);

  let elbowAngle = 0;
  if (wrist && wrist.visibility > 0.35) {
    const dx2 = wrist.x - elbow.x;
    const dy2 = wrist.y - elbow.y;
    const a1 = Math.atan2(dy1, dx1);
    const a2 = Math.atan2(dy2, dx2);
    let diff = a2 - a1;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    elbowAngle = clamp(diff * 0.45 * sideDir, -0.6, 0.6);
  }

  return { elbowAngle, shoulderLift };
}

/**
 * Builds a clean fallback pose frame from either a `PhotoPoseHint` (e.g. studio sample models)
 * or an ergonomic centered heuristic portrait pose when MediaPipe WASM is unavailable.
 */
export function buildFallbackPoseFrame(
  hint?: PhotoPoseHint | null,
  seatedDefault = false,
): PoseTracking3DFrame {
  const lsX = hint?.leftShoulder?.x ?? 0.35;
  const lsY = hint?.leftShoulder?.y ?? (seatedDefault ? 0.42 : 0.36);
  const rsX = hint?.rightShoulder?.x ?? 0.65;
  const rsY = hint?.rightShoulder?.y ?? (seatedDefault ? 0.42 : 0.36);

  const screenLeftX = Math.min(lsX, rsX);
  const screenRightX = Math.max(lsX, rsX);
  const screenLeftY = lsX <= rsX ? lsY : rsY;
  const screenRightY = lsX <= rsX ? rsY : lsY;

  const shoulderCenter = {
    x: (screenLeftX + screenRightX) * 0.5,
    y: (screenLeftY + screenRightY) * 0.5,
  };
  const shoulderWidth = Math.max(0.18, screenRightX - screenLeftX);

  const noseX = hint?.nose?.x ?? shoulderCenter.x;
  const noseY = hint?.nose?.y ?? Math.max(0.08, shoulderCenter.y - shoulderWidth * 0.54);
  const chinY =
    hint?.chinY ?? Math.min(shoulderCenter.y - 0.03, noseY + shoulderWidth * 0.24);

  const hasValidHips =
    Boolean(hint?.leftHip && hint?.rightHip) &&
    (hint?.leftHip?.visibility ?? 0.9) >= 0.45 &&
    (hint?.rightHip?.visibility ?? 0.9) >= 0.45 &&
    (hint?.leftHip?.y ?? 1) <= 0.96 &&
    (hint?.rightHip?.y ?? 1) <= 0.96;

  const seatedMode = !hasValidHips;
  const inferredTorsoH = Math.max(
    shoulderWidth * 1.36,
    (shoulderCenter.y - chinY) * 3.1,
  );

  const leftHip = hasValidHips
    ? { x: hint!.leftHip!.x, y: hint!.leftHip!.y }
    : { x: shoulderCenter.x - shoulderWidth * 0.38, y: shoulderCenter.y + inferredTorsoH };
  const rightHip = hasValidHips
    ? { x: hint!.rightHip!.x, y: hint!.rightHip!.y }
    : { x: shoulderCenter.x + shoulderWidth * 0.38, y: shoulderCenter.y + inferredTorsoH };

  const hipCenter = {
    x: (leftHip.x + rightHip.x) * 0.5,
    y: (leftHip.y + rightHip.y) * 0.5,
  };
  const torsoHeight = Math.max(0.18, hipCenter.y - shoulderCenter.y);
  const collar = {
    x: shoulderCenter.x,
    y: shoulderCenter.y - Math.min(0.035, torsoHeight * 0.08),
  };

  const tailorPins: TailorPinOverlayData = {
    visible: true,
    confidence: hint ? 0.92 : 0.7,
    seatedMode,
    leftShoulder: { x: screenLeftX, y: screenLeftY },
    rightShoulder: { x: screenRightX, y: screenRightY },
    collar,
    ...(hasValidHips ? { leftHip, rightHip } : {}),
  };

  return {
    detected: true,
    confidence: hint ? 0.92 : 0.7,
    seatedMode,
    source: hint ? 'hint' : 'fallback',
    shoulderCenter,
    hipCenter,
    neckCenter: { x: (noseX + collar.x) * 0.5, y: (chinY + collar.y) * 0.5 },
    headCenter: { x: noseX, y: noseY },
    shoulderWidth,
    torsoHeight,
    headRadius: clamp((shoulderCenter.y - noseY) * 0.46, 0.055, 0.14),
    rollZ: Math.atan2(screenRightY - screenLeftY, screenRightX - screenLeftX),
    yawY: 0,
    pitchX: 0,
    armAngles: {
      leftElbowAngle: 0,
      rightElbowAngle: 0,
      leftShoulderLift: 0,
      rightShoulderLift: 0,
    },
    leftShoulderZ: 0,
    rightShoulderZ: 0,
    tailorPins,
  };
}

/**
 * Solves filtered 2D + 3D `worldLandmarks` into a complete `PoseTracking3DFrame`
 * with Seated Webcam Auto-Adaptation (`seatedMode`), 3D orientation (`rollZ`, `yawY`, `pitchX`),
 * forearm landmarks, and refined Tailor's Pins overlay coordinates.
 */
export function solvePoseFrameFromLandmarks(
  rawLandmarks: RawLandmark[] | undefined,
  rawWorldLandmarks: RawLandmark[] | undefined,
  metrics: CoverProjectionMetrics,
  filterBank: PoseStreamFilterBank | null,
  timestampSec: number,
): PoseTracking3DFrame | null {
  if (!rawLandmarks || rawLandmarks.length < 25) {
    return null;
  }

  const projectLm = (idx: number): PoseLandmark3D | undefined => {
    const raw = rawLandmarks[idx];
    if (!raw) return undefined;
    const p = projectToCoverViewport(raw.x, raw.y, metrics);
    const projected: RawLandmark = {
      x: p.x,
      y: p.y,
      z: raw.z ?? 0,
      visibility: raw.visibility ?? 0.9,
    };
    return filterBank
      ? filterBank.filterImageLandmark(idx, projected, timestampSec)
      : {
          x: projected.x,
          y: projected.y,
          z: projected.z,
          visibility: clamp(projected.visibility ?? 0.9, 0, 1),
        };
  };

  const getWorldLm = (idx: number): PoseLandmark3D | undefined => {
    const raw = rawWorldLandmarks?.[idx];
    if (!raw) return undefined;
    return filterBank
      ? filterBank.filterWorldLandmark(idx, raw, timestampSec)
      : {
          x: raw.x,
          y: raw.y,
          z: raw.z ?? 0,
          visibility: clamp(raw.visibility ?? 0.9, 0, 1),
        };
  };

  const nose = projectLm(0);
  const mouthLeft = projectLm(9);
  const mouthRight = projectLm(10);
  const rawLeftShoulder = projectLm(11);
  const rawRightShoulder = projectLm(12);
  const rawLeftElbow = projectLm(13);
  const rawRightElbow = projectLm(14);
  const rawLeftWrist = projectLm(15);
  const rawRightWrist = projectLm(16);
  const rawLeftHip = projectLm(23);
  const rawRightHip = projectLm(24);

  if (!rawLeftShoulder || !rawRightShoulder) {
    return null;
  }

  const shoulderVis = Math.min(
    rawLeftShoulder.visibility,
    rawRightShoulder.visibility,
  );
  if (shoulderVis < 0.3) {
    return null;
  }

  // Order shoulders consistently from viewer's screen-left to screen-right
  const leftIsScreenLeft = rawLeftShoulder.x <= rawRightShoulder.x;
  const screenLeftShoulder = leftIsScreenLeft ? rawLeftShoulder : rawRightShoulder;
  const screenRightShoulder = leftIsScreenLeft ? rawRightShoulder : rawLeftShoulder;
  const screenLeftElbow = leftIsScreenLeft ? rawLeftElbow : rawRightElbow;
  const screenRightElbow = leftIsScreenLeft ? rawRightElbow : rawLeftElbow;
  const screenLeftWrist = leftIsScreenLeft ? rawLeftWrist : rawRightWrist;
  const screenRightWrist = leftIsScreenLeft ? rawRightWrist : rawLeftWrist;
  const screenLeftHip = leftIsScreenLeft ? rawLeftHip : rawRightHip;
  const screenRightHip = leftIsScreenLeft ? rawRightHip : rawLeftHip;

  const viewportAspect = Math.max(0.4, metrics.dstWidth / Math.max(1, metrics.dstHeight));
  const dxS = screenRightShoulder.x - screenLeftShoulder.x;
  const dyS = screenRightShoulder.y - screenLeftShoulder.y;
  const shoulderWidth = clamp(
    Math.hypot(dxS, dyS / viewportAspect),
    0.1,
    0.92,
  );

  const shoulderCenter = {
    x: (screenLeftShoulder.x + screenRightShoulder.x) * 0.5,
    y: (screenLeftShoulder.y + screenRightShoulder.y) * 0.5,
  };

  // Roll (shoulder tilt in screen plane)
  const rawRollZ = clamp(
    Math.atan2(dyS, Math.max(0.04, dxS * viewportAspect)),
    -0.55,
    0.55,
  );

  // 3D Yaw (body turn left/right) from worldLandmarks[11].z - worldLandmarks[12].z
  // combined with horizontal foreshortening
  const worldLS = getWorldLm(11);
  const worldRS = getWorldLm(12);
  const worldLH = getWorldLm(23);
  const worldRH = getWorldLm(24);
  const worldNose = getWorldLm(0);

  let rawYawY = 0;
  if (worldLS && worldRS) {
    const worldDx = Math.max(0.12, Math.abs(worldLS.x - worldRS.x));
    const worldDz = worldLS.z - worldRS.z;
    const mirrorSign = metrics.mirrored ? -1 : 1;
    rawYawY = clamp(Math.atan2(worldDz, worldDx) * 0.88 * mirrorSign, -0.82, 0.82);
  } else {
    const imageDz = screenLeftShoulder.z - screenRightShoulder.z;
    rawYawY = clamp(imageDz * 1.45, -0.75, 0.75);
  }

  // 3D Pitch (torso lean forward / backward)
  let rawPitchX = 0;
  if (worldLS && worldRS && worldLH && worldRH) {
    const shZ = (worldLS.z + worldRS.z) * 0.5;
    const hipZ = (worldLH.z + worldRH.z) * 0.5;
    rawPitchX = clamp((hipZ - shZ) * 0.85, -0.34, 0.34);
  } else if (worldNose && worldLS && worldRS) {
    const shZ = (worldLS.z + worldRS.z) * 0.5;
    rawPitchX = clamp((shZ - worldNose.z - 0.14) * 0.65, -0.28, 0.28);
  }

  const orientation = filterBank
    ? filterBank.filterOrientation(rawYawY, rawPitchX, rawRollZ, timestampSec)
    : { yawY: rawYawY, pitchX: rawPitchX, rollZ: rawRollZ };

  // Chin & head geometry
  const mouthCenter =
    mouthLeft && mouthRight
      ? {
          x: (mouthLeft.x + mouthRight.x) * 0.5,
          y: (mouthLeft.y + mouthRight.y) * 0.5,
        }
      : null;

  const headCenter = nose
    ? { x: nose.x, y: nose.y }
    : { x: shoulderCenter.x, y: shoulderCenter.y - shoulderWidth * 0.52 };

  const chinY = mouthCenter
    ? mouthCenter.y + Math.max(0.025, (mouthCenter.y - headCenter.y) * 0.72)
    : headCenter.y + Math.max(0.04, (shoulderCenter.y - headCenter.y) * 0.45);
  const chinToShoulder = clamp(shoulderCenter.y - chinY, 0.035, 0.28);

  // Seated Webcam Auto-Adaptation:
  // When hips (23, 24) have visibility < 0.45 OR lie outside bottom frame (y > 0.96),
  // automatically infer torso height from shoulderWidth * 1.36 & chin-to-shoulder distance!
  const hipsVisible =
    Boolean(screenLeftHip && screenRightHip) &&
    (screenLeftHip?.visibility ?? 0) >= 0.45 &&
    (screenRightHip?.visibility ?? 0) >= 0.45 &&
    (screenLeftHip?.y ?? 2) <= 0.96 &&
    (screenRightHip?.y ?? 2) <= 0.96;

  const seatedMode = !hipsVisible;

  let hipCenter: { x: number; y: number };
  let torsoHeight: number;

  if (hipsVisible && screenLeftHip && screenRightHip) {
    hipCenter = {
      x: (screenLeftHip.x + screenRightHip.x) * 0.5,
      y: (screenLeftHip.y + screenRightHip.y) * 0.5,
    };
    torsoHeight = clamp(
      Math.hypot(
        (hipCenter.x - shoulderCenter.x) * viewportAspect,
        hipCenter.y - shoulderCenter.y,
      ),
      shoulderWidth * 0.95,
      0.85,
    );
  } else {
    // Seated ergonomic inference: shoulderWidth * 1.36 blended with chin-to-shoulder cue
    const fromShoulderSpan = shoulderWidth * viewportAspect * 1.36;
    const fromChinSpan = chinToShoulder * 3.1;
    torsoHeight = clamp(
      fromShoulderSpan * 0.76 + fromChinSpan * 0.24,
      0.22,
      0.78,
    );
    const downX = -Math.sin(orientation.rollZ) * (torsoHeight / viewportAspect);
    const downY = Math.cos(orientation.rollZ) * torsoHeight;
    hipCenter = {
      x: shoulderCenter.x + downX,
      y: shoulderCenter.y + downY,
    };
  }

  const collar = {
    x: shoulderCenter.x,
    y: shoulderCenter.y - Math.min(0.038, chinToShoulder * 0.28),
  };

  const neckCenter = {
    x: (headCenter.x + collar.x) * 0.5,
    y: (chinY + collar.y) * 0.5,
  };

  const leftArm = computeArmAngleMetrics(
    screenLeftShoulder,
    screenLeftElbow,
    screenLeftWrist,
    true,
  );
  const rightArm = computeArmAngleMetrics(
    screenRightShoulder,
    screenRightElbow,
    screenRightWrist,
    false,
  );

  const armAngles: ArmPoseAngles = {
    leftElbowAngle: leftArm.elbowAngle,
    rightElbowAngle: rightArm.elbowAngle,
    leftShoulderLift: leftArm.shoulderLift,
    rightShoulderLift: rightArm.shoulderLift,
  };

  const confidence = clamp(
    (screenLeftShoulder.visibility +
      screenRightShoulder.visibility +
      (nose?.visibility ?? 0.8)) /
      3,
    0,
    1,
  );

  const tailorPins: TailorPinOverlayData = {
    visible: true,
    confidence,
    seatedMode,
    leftShoulder: { x: screenLeftShoulder.x, y: screenLeftShoulder.y },
    rightShoulder: { x: screenRightShoulder.x, y: screenRightShoulder.y },
    collar,
    ...(hipsVisible && screenLeftHip && screenRightHip
      ? {
          leftHip: { x: screenLeftHip.x, y: screenLeftHip.y },
          rightHip: { x: screenRightHip.x, y: screenRightHip.y },
        }
      : {}),
  };

  return {
    detected: true,
    confidence,
    seatedMode,
    source: 'mediapipe',
    shoulderCenter,
    hipCenter,
    neckCenter,
    headCenter,
    shoulderWidth,
    torsoHeight,
    headRadius: clamp((shoulderCenter.y - headCenter.y) * 0.48, 0.052, 0.16),
    rollZ: orientation.rollZ,
    yawY: orientation.yawY,
    pitchX: orientation.pitchX,
    armAngles,
    leftElbow: screenLeftElbow,
    rightElbow: screenRightElbow,
    leftWrist: screenLeftWrist,
    rightWrist: screenRightWrist,
    leftShoulderZ: screenLeftShoulder.z,
    rightShoulderZ: screenRightShoulder.z,
    tailorPins,
  };
}

/**
 * Runs single-frame detection on an active `<video>` element (with One-Euro smoothing).
 * Never throws; returns `null` if landmarker is not yet ready or no pose detected.
 */
export function detectVideoPoseSync(
  landmarker: PoseLandmarkerInstance | null,
  video: HTMLVideoElement,
  timestampMs: number,
  dstWidth: number,
  dstHeight: number,
  filterBank: PoseStreamFilterBank,
): PoseTracking3DFrame | null {
  if (!landmarker || video.readyState < 2 || video.videoWidth < 2 || video.videoHeight < 2) {
    return null;
  }
  try {
    const result = landmarker.detectForVideo(video, timestampMs);
    const landmarks = result.landmarks?.[0];
    const worldLandmarks = result.worldLandmarks?.[0];
    if (!landmarks || landmarks.length < 25) return null;
    return solvePoseFrameFromLandmarks(
      landmarks,
      worldLandmarks,
      {
        srcWidth: video.videoWidth,
        srcHeight: video.videoHeight,
        dstWidth,
        dstHeight,
        mirrored: true,
      },
      filterBank,
      timestampMs / 1000,
    );
  } catch {
    return null;
  }
}

/**
 * Runs one-shot `PoseLandmarker` `IMAGE` mode on an uploaded or sample portrait photo.
 * Automatically falls back to `photoPoseHint` or heuristic portrait framing if WASM/CDN is unavailable.
 */
export async function detectPhotoPoseSafe(
  image: HTMLImageElement,
  dstWidth: number,
  dstHeight: number,
  hint?: PhotoPoseHint | null,
): Promise<PoseTracking3DFrame> {
  try {
    const landmarker = await getImagePoseLandmarker();
    if (landmarker && image.naturalWidth > 4 && image.naturalHeight > 4) {
      const result = landmarker.detect(image);
      const landmarks = result.landmarks?.[0];
      const worldLandmarks = result.worldLandmarks?.[0];
      const solved = solvePoseFrameFromLandmarks(
        landmarks,
        worldLandmarks,
        {
          srcWidth: image.naturalWidth,
          srcHeight: image.naturalHeight,
          dstWidth: Math.max(1, dstWidth),
          dstHeight: Math.max(1, dstHeight),
          mirrored: false,
        },
        null,
        performance.now() / 1000,
      );
      if (solved) {
        return solved;
      }
    }
  } catch {
    // Graceful fallback to hint or heuristic estimator
  }

  return buildFallbackPoseFrame(hint, false);
}
