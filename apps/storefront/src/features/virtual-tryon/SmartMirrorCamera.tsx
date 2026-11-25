'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { PrivacyConsentGate } from './PrivacyConsentGate';
import type {
  NormalizedPoseLandmark,
  SessionPersonFrame,
} from './vton/types';

export interface SmartMirrorGarmentPreview {
  productId: string;
  name: string;
  imageUrl: string;
  colorName?: string;
}

export interface SmartMirrorCameraProps {
  selectedGarments: SmartMirrorGarmentPreview[];
  onFrameCaptured: (frame: SessionPersonFrame) => void;
  onFallbackToUpload: () => void;
  onFallbackToPresets: () => void;
  onCameraActiveChange?: (active: boolean) => void;
}

const TARGET_WIDTH = 768 as const;
const TARGET_HEIGHT = 1024 as const;
const TARGET_ASPECT = TARGET_WIDTH / TARGET_HEIGHT; // 0.75 (3:4)
const SESSION_TTL_MS = 15 * 60 * 1000;

const DETECT_INTERVAL_MS = 60; // ~16.6 fps (within 15-20 fps requirement)
const STABILITY_HOLD_MS = 650;
const MAX_JITTER_RATIO = 0.018; // < 1.8%
const MIN_LUMINANCE = 45; // >= 45/255
const MAX_SHOULDER_TILT_DEG = 10;

const LOCAL_MODEL_URL = '/models/pose_landmarker_lite.task';
const CDN_MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';
const LOCAL_WASM_URL = '/models/wasm';
const LOCAL_WASM_PROBE_URL = '/models/wasm/vision_wasm_internal.js';
const CDN_WASM_URL =
  'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm';

type MirrorPhase = 'consent' | 'starting' | 'live' | 'error';
type GuideTone = 'neutral' | 'amber' | 'gold';

interface RawLandmark {
  x: number;
  y: number;
  z?: number;
  visibility?: number;
}

interface VideoPoseLandmarkerHandle {
  detectForVideo: (
    video: HTMLVideoElement,
    timestampMs: number,
  ) => { landmarks?: RawLandmark[][] };
  close?: () => void;
}

interface GateEvaluation {
  allPassed: boolean;
  tone: GuideTone;
  hint: string;
  shoulderMidX?: number;
  shoulderMidY?: number;
  shoulderWidthRatio?: number;
}

function clamp(v: number, min: number, max: number): number {
  if (!Number.isFinite(v)) return min;
  return Math.max(min, Math.min(max, v));
}

function stopStreamTracks(stream: MediaStream | null): void {
  if (!stream || typeof stream.getTracks !== 'function') return;
  stream.getTracks().forEach((track) => {
    try {
      track.stop();
    } catch {
      // Ignore already stopped hardware tracks
    }
  });
}

async function computeSha256HexFromString(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest), (b) =>
      b.toString(16).padStart(2, '0'),
    ).join('');
  }
  let h1 = 0x811c9dc5;
  let h2 = 0xdeadbeef;
  const step = Math.max(1, Math.floor(bytes.length / 4096));
  for (let i = 0; i < bytes.length; i += step) {
    const ch = bytes[i] ?? 0;
    h1 = Math.imul(h1 ^ ch, 0x01000193);
    h2 = Math.imul(h2 ^ ch, 2654435761);
  }
  const chunk = `${(h1 >>> 0).toString(16).padStart(8, '0')}${(h2 >>> 0)
    .toString(16)
    .padStart(8, '0')}`;
  return (chunk + chunk + chunk + chunk).slice(0, 64);
}

function buildFallback33Landmarks(): NormalizedPoseLandmark[] {
  const landmarks: NormalizedPoseLandmark[] = Array.from({ length: 33 }, () => ({
    x: 0.5,
    y: 0.5,
    z: 0,
    visibility: 0.2,
  }));

  landmarks[0] = { x: 0.5, y: 0.21, z: -0.05, visibility: 0.94 };
  landmarks[7] = { x: 0.43, y: 0.2, z: 0.02, visibility: 0.88 };
  landmarks[8] = { x: 0.57, y: 0.2, z: 0.02, visibility: 0.88 };
  landmarks[9] = { x: 0.475, y: 0.25, z: -0.04, visibility: 0.9 };
  landmarks[10] = { x: 0.525, y: 0.25, z: -0.04, visibility: 0.9 };
  landmarks[11] = { x: 0.33, y: 0.37, z: 0, visibility: 0.95 };
  landmarks[12] = { x: 0.67, y: 0.37, z: 0, visibility: 0.95 };
  landmarks[13] = { x: 0.27, y: 0.56, z: 0.01, visibility: 0.88 };
  landmarks[14] = { x: 0.73, y: 0.56, z: 0.01, visibility: 0.88 };
  landmarks[15] = { x: 0.28, y: 0.74, z: -0.02, visibility: 0.82 };
  landmarks[16] = { x: 0.72, y: 0.74, z: -0.02, visibility: 0.82 };
  landmarks[23] = { x: 0.39, y: 0.75, z: 0.01, visibility: 0.9 };
  landmarks[24] = { x: 0.61, y: 0.75, z: 0.01, visibility: 0.9 };

  return landmarks;
}

async function createVideoLandmarkerSafe(): Promise<VideoPoseLandmarkerHandle | null> {
  if (typeof window === 'undefined') return null;

  const task = (async (): Promise<VideoPoseLandmarkerHandle | null> => {
    try {
      const vision = await import('@mediapipe/tasks-vision');

      let wasmBase = CDN_WASM_URL;
      try {
        const probe = await fetch(LOCAL_WASM_PROBE_URL, { method: 'HEAD' });
        if (probe.ok) wasmBase = LOCAL_WASM_URL;
      } catch {
        // Fallback to CDN WASM
      }

      let modelUrl = CDN_MODEL_URL;
      try {
        const probe = await fetch(LOCAL_MODEL_URL, { method: 'HEAD' });
        if (probe.ok) modelUrl = LOCAL_MODEL_URL;
      } catch {
        // Fallback to CDN model
      }

      const wasmCandidates =
        wasmBase === LOCAL_WASM_URL
          ? [LOCAL_WASM_URL, CDN_WASM_URL]
          : [CDN_WASM_URL];

      let fileset: Awaited<
        ReturnType<typeof vision.FilesetResolver.forVisionTasks>
      > | null = null;
      for (const candidate of wasmCandidates) {
        try {
          fileset = await vision.FilesetResolver.forVisionTasks(candidate);
          break;
        } catch {
          // Try next candidate
        }
      }
      if (!fileset) return null;

      const modelCandidates =
        modelUrl === LOCAL_MODEL_URL
          ? [LOCAL_MODEL_URL, CDN_MODEL_URL]
          : [CDN_MODEL_URL];

      for (const candidate of modelCandidates) {
        try {
          const inst = await vision.PoseLandmarker.createFromOptions(fileset, {
            baseOptions: { modelAssetPath: candidate },
            runningMode: 'VIDEO',
            numPoses: 1,
            minPoseDetectionConfidence: 0.5,
            minPosePresenceConfidence: 0.5,
            minTrackingConfidence: 0.5,
          });
          return inst as unknown as VideoPoseLandmarkerHandle;
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
    window.setTimeout(() => resolve(null), 6500);
  });

  return Promise.race([task, timeout]);
}

/**
 * Projects raw webcam coordinates onto the visible 3:4 mirrored cover frame.
 */
function projectRawToMirrored3x4(
  rawX: number,
  rawY: number,
  videoW: number,
  videoH: number,
): { x: number; y: number } {
  const srcAspect = videoW / Math.max(1, videoH);
  let vx = rawX;
  let vy = rawY;

  if (srcAspect > TARGET_ASPECT) {
    const visibleFrac = TARGET_ASPECT / srcAspect;
    const offset = (1 - visibleFrac) * 0.5;
    vx = (rawX - offset) / visibleFrac;
  } else if (srcAspect < TARGET_ASPECT) {
    const visibleFrac = srcAspect / TARGET_ASPECT;
    const offset = (1 - visibleFrac) * 0.5;
    vy = (rawY - offset) / visibleFrac;
  }

  return { x: 1 - vx, y: vy };
}

function measureCenterLuminance(
  video: HTMLVideoElement,
  probeCanvas: HTMLCanvasElement,
): number {
  const ctx = probeCanvas.getContext('2d', { willReadFrequently: true });
  if (!ctx || video.videoWidth <= 0 || video.videoHeight <= 0) return 120;

  const w = probeCanvas.width;
  const h = probeCanvas.height;
  ctx.drawImage(video, 0, 0, w, h);

  const sx = Math.floor(w * 0.22);
  const sy = Math.floor(h * 0.18);
  const sw = Math.max(8, Math.floor(w * 0.56));
  const sh = Math.max(8, Math.floor(h * 0.62));
  const data = ctx.getImageData(sx, sy, sw, sh).data;

  let lumSum = 0;
  let count = 0;
  for (let i = 0; i < data.length; i += 4) {
    lumSum +=
      0.299 * (data[i] ?? 0) +
      0.587 * (data[i + 1] ?? 0) +
      0.114 * (data[i + 2] ?? 0);
    count += 1;
  }

  return count > 0 ? lumSum / count : 120;
}

function evaluatePoseGates(
  rawLandmarks: RawLandmark[] | undefined,
  videoW: number,
  videoH: number,
  centerLuminance: number,
): GateEvaluation {
  // Gate 3: Lighting check first if extremely dim
  if (centerLuminance < MIN_LUMINANCE) {
    return {
      allPassed: false,
      tone: 'amber',
      hint: 'Ánh sáng hơi tối — hãy hướng mặt về phía nguồn sáng để lên màu vải chuẩn nhất',
    };
  }

  if (!rawLandmarks || rawLandmarks.length < 25) {
    return {
      allPassed: false,
      tone: 'neutral',
      hint: 'Đứng chính diện vào giữa khung dáng để hiện rõ đầu, hai vai và phần eo',
    };
  }

  const nose = rawLandmarks[0];
  const ls = rawLandmarks[11];
  const rs = rawLandmarks[12];
  const le = rawLandmarks[13];
  const re = rawLandmarks[14];
  const lw = rawLandmarks[15];
  const rw = rawLandmarks[16];
  const lh = rawLandmarks[23];
  const rh = rawLandmarks[24];

  const coreVisible =
    Boolean(nose && ls && rs) &&
    (nose?.visibility ?? 0) >= 0.72 &&
    (ls?.visibility ?? 0) >= 0.72 &&
    (rs?.visibility ?? 0) >= 0.72;

  if (!coreVisible || !nose || !ls || !rs) {
    return {
      allPassed: false,
      tone: 'amber',
      hint: 'Bạn đang ngồi hơi gần camera — hãy lùi nhẹ ra khoảng 80cm–1m để lấy trọn hai vai & dáng lưng',
    };
  }

  const pLs = projectRawToMirrored3x4(ls.x, ls.y, videoW, videoH);
  const pRs = projectRawToMirrored3x4(rs.x, rs.y, videoW, videoH);
  const pNose = projectRawToMirrored3x4(nose.x, nose.y, videoW, videoH);

  const leftX = Math.min(pLs.x, pRs.x);
  const rightX = Math.max(pLs.x, pRs.x);
  const leftY = pLs.x <= pRs.x ? pLs.y : pRs.y;
  const rightY = pLs.x <= pRs.x ? pRs.y : pLs.y;

  const shoulderWidthRatio = Math.hypot(rightX - leftX, (rightY - leftY) * (4 / 3));
  const shoulderMidX = (leftX + rightX) * 0.5;
  const shoulderMidY = (leftY + rightY) * 0.5;

  const elbowsVisible =
    Boolean(le && re) &&
    (le?.visibility ?? 0) >= 0.5 &&
    (re?.visibility ?? 0) >= 0.5 &&
    projectRawToMirrored3x4(le!.x, le!.y, videoW, videoH).y <= 0.98 &&
    projectRawToMirrored3x4(re!.x, re!.y, videoW, videoH).y <= 0.98;

  const hipsVisible =
    Boolean(lh && rh) &&
    (lh?.visibility ?? 0) >= 0.45 &&
    (rh?.visibility ?? 0) >= 0.45 &&
    projectRawToMirrored3x4(lh!.x, lh!.y, videoW, videoH).y <= 1.04 &&
    projectRawToMirrored3x4(rh!.x, rh!.y, videoW, videoH).y <= 1.04;

  // Gate 1: Distance & Upper-Body Ratio
  if (
    shoulderWidthRatio > 0.52 ||
    (!elbowsVisible && !hipsVisible) ||
    leftX < 0.04 ||
    rightX > 0.96
  ) {
    return {
      allPassed: false,
      tone: 'amber',
      hint: 'Bạn đang ngồi hơi gần camera — hãy lùi nhẹ ra khoảng 80cm–1m để lấy trọn hai vai & dáng lưng',
      shoulderMidX,
      shoulderMidY,
      shoulderWidthRatio,
    };
  }

  if (shoulderWidthRatio < 0.18) {
    return {
      allPassed: false,
      tone: 'amber',
      hint: 'Hãy tiến lại gần hơn một chút',
      shoulderMidX,
      shoulderMidY,
      shoulderWidthRatio,
    };
  }

  if (shoulderWidthRatio < 0.22) {
    return {
      allPassed: false,
      tone: 'amber',
      hint: 'Hãy tiến thêm một bước nhỏ để hai vai khớp khung dáng',
      shoulderMidX,
      shoulderMidY,
      shoulderWidthRatio,
    };
  }

  // Gate 2: Posture (shoulder tilt <= 10 deg + wrists not covering chest/neck polygon)
  const dxPx = Math.max(0.01, (rightX - leftX) * TARGET_WIDTH);
  const dyPx = (rightY - leftY) * TARGET_HEIGHT;
  const tiltDeg = Math.abs((Math.atan2(dyPx, dxPx) * 180) / Math.PI);

  if (tiltDeg > MAX_SHOULDER_TILT_DEG) {
    return {
      allPassed: false,
      tone: 'amber',
      hint: 'Hãy giữ thẳng hai vai cân bằng trong khung dáng',
      shoulderMidX,
      shoulderMidY,
      shoulderWidthRatio,
    };
  }

  // Chest/neck polygon exclusion for hands
  const chestTopY = pNose.y + (shoulderMidY - pNose.y) * 0.45;
  const chestBottomY = shoulderMidY + shoulderWidthRatio * 0.9;
  const chestMinX = leftX + (rightX - leftX) * 0.12;
  const chestMaxX = rightX - (rightX - leftX) * 0.12;

  for (const wrist of [lw, rw]) {
    if (!wrist || (wrist.visibility ?? 0) < 0.55) continue;
    const pw = projectRawToMirrored3x4(wrist.x, wrist.y, videoW, videoH);
    if (
      pw.x >= chestMinX &&
      pw.x <= chestMaxX &&
      pw.y >= chestTopY &&
      pw.y <= chestBottomY
    ) {
      return {
        allPassed: false,
        tone: 'amber',
        hint: 'Vui lòng hạ tay khỏi vùng cổ và ngực để chuẩn hóa dáng vải chính xác',
        shoulderMidX,
        shoulderMidY,
        shoulderWidthRatio,
      };
    }
  }

  return {
    allPassed: true,
    tone: 'gold',
    hint: 'Giữ nguyên tư thế trong giây lát...',
    shoulderMidX,
    shoulderMidY,
    shoulderWidthRatio,
  };
}

function sampleCapturedAmbientRgb(
  ctx: CanvasRenderingContext2D,
): [number, number, number] {
  const sx = Math.floor(TARGET_WIDTH * 0.25);
  const sy = Math.floor(TARGET_HEIGHT * 0.24);
  const sw = Math.floor(TARGET_WIDTH * 0.5);
  const sh = Math.floor(TARGET_HEIGHT * 0.5);
  const data = ctx.getImageData(sx, sy, sw, sh).data;

  let rSum = 0;
  let gSum = 0;
  let bSum = 0;
  let count = 0;
  for (let i = 0; i < data.length; i += 64) {
    rSum += data[i] ?? 185;
    gSum += data[i + 1] ?? 176;
    bSum += data[i + 2] ?? 165;
    count += 1;
  }
  if (count === 0) return [192, 182, 170];
  return [
    Math.round(rSum / count),
    Math.round(gSum / count),
    Math.round(bSum / count),
  ];
}

function SelectedGarmentPip({
  garments,
}: {
  garments: SmartMirrorGarmentPreview[];
}) {
  const primary = garments[0] ?? null;
  const secondary = garments[1] ?? null;
  const extraCount = Math.max(0, garments.length - 1);

  return (
    <div
      data-testid="selected-garment-pip"
      aria-label={
        primary
          ? `Trang phục đang chọn thử: ${primary.name}`
          : 'Trang phục đang chọn thử'
      }
      className="pointer-events-none absolute top-3 right-3 z-20 flex flex-col items-end"
    >
      <div className="relative h-[100px] w-[76px]">
        {/* Stacked card behind when in outfit mode */}
        {secondary ? (
          <div className="absolute top-1 -left-2 h-[92px] w-[68px] -rotate-6 overflow-hidden rounded-xl border border-[#EBCF8F]/35 bg-[#1C1410]/85 shadow-lg">
            <img
              src={secondary.imageUrl}
              alt={secondary.name}
              className="h-full w-full object-cover opacity-80"
            />
          </div>
        ) : null}

        {/* Primary 76×100 frosted obsidian glass PiP card */}
        <div className="relative h-[100px] w-[76px] overflow-hidden rounded-xl border border-[#EBCF8F]/55 bg-[#1C1410]/82 shadow-[0_12px_30px_-8px_rgba(0,0,0,0.85)] backdrop-blur-md">
          {primary ? (
            <>
              <img
                src={primary.imageUrl}
                alt={primary.name}
                className="h-full w-full object-cover"
              />
              <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-[#1C1410]/96 via-[#1C1410]/70 to-transparent px-1.5 pt-4 pb-1">
                <p className="truncate text-[8px] font-medium leading-tight text-[#FBF7EF]">
                  {primary.name}
                </p>
                {primary.colorName ? (
                  <p className="truncate text-[7px] text-[#EBCF8F]">
                    {primary.colorName}
                  </p>
                ) : null}
              </div>
            </>
          ) : (
            <div className="flex h-full w-full flex-col items-center justify-center px-1.5 text-center">
              <span className="font-editorial text-sm text-[#EBCF8F]">✦</span>
              <span className="mt-1 text-[8px] leading-tight text-[#FBF7EF]/70">
                Chọn trang phục
              </span>
            </div>
          )}

          {extraCount > 0 ? (
            <span className="absolute top-1 right-1 rounded-full border border-[#EBCF8F]/70 bg-[#1C1410]/92 px-1.5 py-0.5 font-mono text-[8px] font-semibold text-[#EBCF8F]">
              +{extraCount}
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * Pure Smart Mirror Camera (ZERO 2D garment overlay on live video, ZERO yellow chest dots).
 * Guides the user via 4 MediaPipe PoseLandmarker (lite) gates -> 650ms stability lock ->
 * 3-2-1 auto countdown (or instant manual "Chụp ngay") -> 768×1024 smart crop ->
 * immediate hardware camera track stop!
 */
export function SmartMirrorCamera({
  selectedGarments,
  onFrameCaptured,
  onFallbackToUpload,
  onFallbackToPresets,
  onCameraActiveChange,
}: SmartMirrorCameraProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const landmarkerRef = useRef<VideoPoseLandmarkerHandle | null>(null);
  const probeCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafIdRef = useRef<number>(0);
  const countdownTimerRef = useRef<number | null>(null);
  const unmountedRef = useRef(false);
  const capturingRef = useRef(false);

  const lastDetectMsRef = useRef<number>(0);
  const lastVideoTimeRef = useRef<number>(-1);
  const latestLandmarksRef = useRef<RawLandmark[] | null>(null);
  const stableStartMsRef = useRef<number | null>(null);
  const anchorPosRef = useRef<{ x: number; y: number; w: number } | null>(null);
  const countdownActiveRef = useRef<boolean>(false);

  const onFrameCapturedRef = useRef(onFrameCaptured);
  onFrameCapturedRef.current = onFrameCaptured;
  const onCameraActiveChangeRef = useRef(onCameraActiveChange);
  onCameraActiveChangeRef.current = onCameraActiveChange;

  const [consentAccepted, setConsentAccepted] = useState(false);
  const [phase, setPhase] = useState<MirrorPhase>('consent');
  const [videoReady, setVideoReady] = useState(false);
  const [errorReason, setErrorReason] = useState<string | null>(null);
  const [guideTone, setGuideTone] = useState<GuideTone>('neutral');
  const [guideHint, setGuideHint] = useState<string>(
    'Đứng chính diện vào giữa khung dáng để hiện rõ hai vai và phần eo',
  );
  const [poseLocked, setPoseLocked] = useState(false);
  const [countdownValue, setCountdownValue] = useState<number | null>(null);
  const [capturing, setCapturing] = useState(false);

  const clearCountdownTimer = useCallback(() => {
    if (countdownTimerRef.current !== null) {
      window.clearInterval(countdownTimerRef.current);
      countdownTimerRef.current = null;
    }
    countdownActiveRef.current = false;
    setCountdownValue(null);
  }, []);

  const stopCameraHardware = useCallback(
    (notifyInactive = true) => {
      if (rafIdRef.current) {
        window.cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = 0;
      }
      clearCountdownTimer();
      stableStartMsRef.current = null;
      anchorPosRef.current = null;

      if (streamRef.current) {
        stopStreamTracks(streamRef.current);
        streamRef.current = null;
      }
      if (videoRef.current) {
        try {
          videoRef.current.pause();
          videoRef.current.srcObject = null;
        } catch {
          // Ignore detach errors
        }
      }
      setVideoReady(false);
      if (notifyInactive) {
        onCameraActiveChangeRef.current?.(false);
      }
    },
    [clearCountdownTimer],
  );

  // Strict cleanup on unmount: MediaStream + rAF + timers + PoseLandmarker
  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
      stopCameraHardware(true);
      try {
        landmarkerRef.current?.close?.();
      } catch {
        // Ignore landmarker close errors
      }
      landmarkerRef.current = null;
    };
  }, [stopCameraHardware]);

  const captureAndEmitFrame = useCallback(async () => {
    if (capturingRef.current) return;
    const video = videoRef.current;
    if (!video || video.videoWidth <= 0 || video.videoHeight <= 0) return;

    capturingRef.current = true;
    setCapturing(true);
    clearCountdownTimer();

    try {
      const srcW = video.videoWidth;
      const srcH = video.videoHeight;
      const rawLandmarks = latestLandmarksRef.current;

      // Determine smart 3:4 crop in raw source pixel coordinates
      const srcAspect = srcW / Math.max(1, srcH);
      let cropW: number;
      let cropH: number;
      if (srcAspect > TARGET_ASPECT) {
        cropH = srcH;
        cropW = Math.round(srcH * TARGET_ASPECT);
      } else {
        cropW = srcW;
        cropH = Math.round(srcW / TARGET_ASPECT);
      }

      let rawCenterX = srcW * 0.5;
      let cropY = Math.max(0, Math.round((srcH - cropH) * 0.2));

      if (rawLandmarks && rawLandmarks.length >= 25) {
        const nose = rawLandmarks[0];
        const ls = rawLandmarks[11];
        const rs = rawLandmarks[12];
        if (
          ls &&
          rs &&
          (ls.visibility ?? 0) >= 0.5 &&
          (rs.visibility ?? 0) >= 0.5
        ) {
          rawCenterX = ((ls.x + rs.x) * 0.5) * srcW;
          const shMidY = ((ls.y + rs.y) * 0.5) * srcH;
          const noseY =
            nose && (nose.visibility ?? 0) >= 0.5
              ? nose.y * srcH
              : shMidY - cropH * 0.16;
          cropY = clamp(
            Math.round(noseY - cropH * 0.2),
            0,
            Math.max(0, srcH - cropH),
          );
        }
      }

      const rawCropX = clamp(
        Math.round(rawCenterX - cropW * 0.5),
        0,
        Math.max(0, srcW - cropW),
      );

      // Draw mirrored high-res smart crop onto 768×1024 canvas
      const canvas = document.createElement('canvas');
      canvas.width = TARGET_WIDTH;
      canvas.height = TARGET_HEIGHT;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) {
        throw new Error('Canvas 2D context unavailable');
      }

      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.save();
      ctx.translate(TARGET_WIDTH, 0);
      ctx.scale(-1, 1);
      ctx.drawImage(
        video,
        rawCropX,
        cropY,
        cropW,
        cropH,
        0,
        0,
        TARGET_WIDTH,
        TARGET_HEIGHT,
      );
      ctx.restore();

      // IMMEDIATELY turn off webcam hardware LED right after grabbing the frame!
      stopCameraHardware(true);

      const ambientRgb = sampleCapturedAmbientRgb(ctx);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.92);
      const frameHash = await computeSha256HexFromString(dataUrl);

      if (unmountedRef.current) return;

      let poseLandmarks: NormalizedPoseLandmark[];
      if (rawLandmarks && rawLandmarks.length >= 25) {
        poseLandmarks = Array.from({ length: 33 }, (_, idx) => {
          const lm = rawLandmarks[idx];
          if (!lm) {
            return { x: 0.5, y: 0.5, z: 0, visibility: 0.1 };
          }
          // Exact mirrored crop projection matching translate(768,0) + scale(-1,1)
          const outX = 1 - (lm.x * srcW - rawCropX) / Math.max(1, cropW);
          const outY = (lm.y * srcH - cropY) / Math.max(1, cropH);
          return {
            x: clamp(outX, -0.15, 1.15),
            y: clamp(outY, -0.15, 1.15),
            z: Number.isFinite(lm.z) ? (lm.z as number) : 0,
            visibility: clamp(lm.visibility ?? 0.9, 0, 1),
          };
        });
      } else {
        poseLandmarks = buildFallback33Landmarks();
      }

      const now = Date.now();
      const frame: SessionPersonFrame = {
        frameId: `cam-${now}-${frameHash.slice(0, 8)}`,
        frameHash,
        dataUrl,
        width: TARGET_WIDTH,
        height: TARGET_HEIGHT,
        source: 'camera',
        label: 'Chân dung Gương Thông Minh',
        poseLandmarks,
        ambientRgb,
        capturedAt: now,
        expiresAt: now + SESSION_TTL_MS,
      };

      onFrameCapturedRef.current(frame);
    } catch {
      stopCameraHardware(true);
      if (!unmountedRef.current) {
        setErrorReason(
          'Không thể chụp khung hình từ camera — vui lòng thử lại hoặc tải ảnh có sẵn.',
        );
        setPhase('error');
      }
    } finally {
      capturingRef.current = false;
      if (!unmountedRef.current) {
        setCapturing(false);
      }
    }
  }, [clearCountdownTimer, stopCameraHardware]);

  const beginAutoCountdown = useCallback(() => {
    if (countdownActiveRef.current || capturingRef.current) return;
    countdownActiveRef.current = true;
    setPoseLocked(true);
    setGuideTone('gold');
    setCountdownValue(3);

    let remaining = 3;
    countdownTimerRef.current = window.setInterval(() => {
      remaining -= 1;
      if (remaining > 0) {
        setCountdownValue(remaining);
      } else {
        clearCountdownTimer();
        void captureAndEmitFrame();
      }
    }, 950);
  }, [captureAndEmitFrame, clearCountdownTimer]);

  const startTrackingLoop = useCallback(() => {
    if (!probeCanvasRef.current) {
      const c = document.createElement('canvas');
      c.width = 48;
      c.height = 64;
      probeCanvasRef.current = c;
    }

    const step = (nowMs: number) => {
      if (unmountedRef.current || capturingRef.current || !streamRef.current) {
        return;
      }

      const video = videoRef.current;
      if (
        video &&
        video.readyState >= 2 &&
        video.videoWidth > 0 &&
        nowMs - lastDetectMsRef.current >= DETECT_INTERVAL_MS
      ) {
        lastDetectMsRef.current = nowMs;
        const luminance = measureCenterLuminance(video, probeCanvasRef.current!);

        let rawLandmarks: RawLandmark[] | undefined;
        const landmarker = landmarkerRef.current;
        if (landmarker && video.currentTime !== lastVideoTimeRef.current) {
          lastVideoTimeRef.current = video.currentTime;
          try {
            const res = landmarker.detectForVideo(video, nowMs);
            if (res?.landmarks?.[0] && res.landmarks[0].length >= 25) {
              rawLandmarks = res.landmarks[0];
              latestLandmarksRef.current = rawLandmarks;
            }
          } catch {
            // Skip single transient detection frame
          }
        } else if (latestLandmarksRef.current) {
          rawLandmarks = latestLandmarksRef.current;
        }

        if (!landmarker) {
          // Still warming up MediaPipe — show luminance gate or calm guidance
          if (luminance < MIN_LUMINANCE) {
            setGuideTone('amber');
            setGuideHint(
              'Ánh sáng hơi tối — hãy hướng mặt về phía nguồn sáng để lên màu vải chuẩn nhất',
            );
          } else {
            setGuideTone('neutral');
            setGuideHint(
              'Căn vai vào khung hoặc nhấn "Chụp ngay" bất cứ lúc nào',
            );
          }
        } else {
          const gate = evaluatePoseGates(
            rawLandmarks,
            video.videoWidth,
            video.videoHeight,
            luminance,
          );

          if (!gate.allPassed) {
            // If countdown was active and user moved significantly away, abort countdown
            if (countdownActiveRef.current) {
              clearCountdownTimer();
            }
            stableStartMsRef.current = null;
            anchorPosRef.current = null;
            setPoseLocked(false);
            setGuideTone(gate.tone);
            setGuideHint(gate.hint);
          } else if (
            typeof gate.shoulderMidX === 'number' &&
            typeof gate.shoulderMidY === 'number' &&
            typeof gate.shoulderWidthRatio === 'number'
          ) {
            const prevAnchor = anchorPosRef.current;
            const jitter = prevAnchor
              ? Math.max(
                  Math.hypot(
                    gate.shoulderMidX - prevAnchor.x,
                    gate.shoulderMidY - prevAnchor.y,
                  ),
                  Math.abs(gate.shoulderWidthRatio - prevAnchor.w),
                )
              : 0;

            if (!prevAnchor || jitter >= MAX_JITTER_RATIO) {
              anchorPosRef.current = {
                x: gate.shoulderMidX,
                y: gate.shoulderMidY,
                w: gate.shoulderWidthRatio,
              };
              if (!countdownActiveRef.current) {
                stableStartMsRef.current = nowMs;
                setPoseLocked(false);
                setGuideTone('neutral');
                setGuideHint('Giữ yên cơ thể trong giây lát để khóa khung dáng...');
              } else if (jitter > 0.065) {
                // Only cancel active countdown on large movement
                clearCountdownTimer();
                stableStartMsRef.current = nowMs;
                setPoseLocked(false);
              }
            } else {
              // Smoothly blend anchor
              anchorPosRef.current = {
                x: prevAnchor.x * 0.8 + gate.shoulderMidX * 0.2,
                y: prevAnchor.y * 0.8 + gate.shoulderMidY * 0.2,
                w: prevAnchor.w * 0.8 + gate.shoulderWidthRatio * 0.2,
              };

              const heldMs =
                stableStartMsRef.current !== null
                  ? nowMs - stableStartMsRef.current
                  : 0;

              if (heldMs >= STABILITY_HOLD_MS) {
                setPoseLocked(true);
                setGuideTone('gold');
                setGuideHint('Đã khóa chuẩn khung dáng — giữ nguyên tư thế');
                if (!countdownActiveRef.current) {
                  beginAutoCountdown();
                }
              } else {
                setGuideTone('neutral');
                setGuideHint('Rất tốt — giữ ổn định để tự động chụp 3–2–1');
              }
            }
          }
        }
      }

      rafIdRef.current = window.requestAnimationFrame(step);
    };

    rafIdRef.current = window.requestAnimationFrame(step);
  }, [beginAutoCountdown, clearCountdownTimer]);

  const startCamera = useCallback(async () => {
    setErrorReason(null);
    setPhase('starting');
    setVideoReady(false);
    setPoseLocked(false);
    setGuideTone('neutral');
    latestLandmarksRef.current = null;
    stableStartMsRef.current = null;
    anchorPosRef.current = null;

    if (
      typeof navigator === 'undefined' ||
      !navigator.mediaDevices ||
      typeof navigator.mediaDevices.getUserMedia !== 'function'
    ) {
      setErrorReason(
        'Thiết bị hoặc trình duyệt hiện không hỗ trợ truy cập Camera trực tiếp.',
      );
      setPhase('error');
      onCameraActiveChangeRef.current?.(false);
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: 'user',
          width: { ideal: 1280 },
          height: { ideal: 960 },
        },
        audio: false,
      });

      if (unmountedRef.current) {
        stopStreamTracks(stream);
        return;
      }

      streamRef.current = stream;
      onCameraActiveChangeRef.current?.(true);
      setPhase('live');
    } catch (err) {
      if (unmountedRef.current) return;
      onCameraActiveChangeRef.current?.(false);

      const errName = err instanceof DOMException ? err.name : '';
      if (errName === 'NotAllowedError' || errName === 'PermissionDeniedError') {
        setErrorReason(
          'Trình duyệt chưa được cấp quyền Camera. Bạn có thể cấp quyền hoặc thử ngay bằng ảnh tải lên / dáng mẫu.',
        );
      } else if (errName === 'NotFoundError' || errName === 'DevicesNotFoundError') {
        setErrorReason(
          'Không tìm thấy thiết bị Camera kết nối. Hãy dùng ảnh của bạn hoặc Dáng Mẫu Thử Nhanh.',
        );
      } else {
        setErrorReason(
          'Không thể khởi động Camera lúc này (có thể đang được ứng dụng khác sử dụng).',
        );
      }
      setPhase('error');
    }
  }, []);

  // Attach active MediaStream to <video> safely after React commits phase === 'live'
  useEffect(() => {
    if (phase !== 'live') return undefined;
    const video = videoRef.current;
    const stream = streamRef.current;
    if (!video || !stream) return undefined;

    let cancelled = false;
    video.srcObject = stream;
    void video
      .play()
      .catch(() => {
        // Autoplay may settle via onLoadedData
      })
      .finally(() => {
        if (cancelled || unmountedRef.current || !streamRef.current) return;
        setVideoReady(true);

        // Warm up MediaPipe PoseLandmarker (lite) asynchronously without blocking manual capture
        if (!landmarkerRef.current) {
          void createVideoLandmarkerSafe().then((inst) => {
            if (unmountedRef.current) {
              inst?.close?.();
              return;
            }
            landmarkerRef.current = inst;
          });
        }

        startTrackingLoop();
      });

    return () => {
      cancelled = true;
    };
  }, [phase, startTrackingLoop]);

  const handleConsentAccept = useCallback(() => {
    setConsentAccepted(true);
    void startCamera();
  }, [startCamera]);

  const silhouetteStroke =
    guideTone === 'gold'
      ? '#EBCF8F'
      : guideTone === 'amber'
        ? '#F5B74F'
        : 'rgba(251, 247, 239, 0.52)';

  return (
    <div
      data-testid="smart-mirror-camera"
      className="flex h-full w-full flex-col items-center justify-center"
    >
      <div className="relative aspect-[3/4] h-full max-h-full max-w-full overflow-hidden rounded-2xl border border-[#B08A4A]/42 bg-[#16100C] shadow-[0_24px_64px_-24px_rgba(0,0,0,0.88)]">
        {/* Top-Right 76×100px Selected Garment Picture-in-Picture (visible in all mirror states) */}
        <SelectedGarmentPip garments={selectedGarments} />

        {/* Phase 1: Privacy Consent Gate */}
        {phase === 'consent' ? (
          <div className="relative z-10 flex h-full w-full items-center justify-center overflow-y-auto bg-[radial-gradient(circle_at_50%_24%,#2B2019_0%,#1C1410_62%,#120C09_100%)] px-4 pt-16 pb-4">
            <PrivacyConsentGate
              accepted={consentAccepted}
              compact={false}
              onAccept={handleConsentAccept}
              onChange={setConsentAccepted}
              onSwitchToUpload={onFallbackToUpload}
              onSwitchToPresets={onFallbackToPresets}
            />
          </div>
        ) : null}

        {/* Phase 2: Starting Camera */}
        {phase === 'starting' ? (
          <div className="relative z-10 flex h-full w-full flex-col items-center justify-center gap-3 bg-[#1C1410] p-6 text-center text-[#FBF7EF]">
            <span className="h-9 w-9 animate-spin rounded-full border-2 border-[#EBCF8F]/25 border-t-[#EBCF8F]" />
            <p className="font-editorial text-xl text-[#FBF7EF]">
              Đang kích hoạt Gương Thông Minh...
            </p>
            <p className="max-w-[260px] text-xs text-[#FBF7EF]/68">
              Vui lòng chọn <strong className="text-[#EBCF8F]">Cho phép</strong>{' '}
              truy cập Camera trên thanh trình duyệt.
            </p>
          </div>
        ) : null}

        {/* Phase 3: Camera Error / Denied Fallback Card */}
        {phase === 'error' ? (
          <div
            data-testid="smart-mirror-error-fallback"
            className="relative z-10 flex h-full w-full items-center justify-center bg-[radial-gradient(circle_at_50%_24%,#2B2019_0%,#1C1410_62%,#120C09_100%)] p-5"
          >
            <div className="flex w-full max-w-[340px] flex-col items-center rounded-2xl border border-[#B08A4A]/40 bg-[#1C1410]/92 px-5 py-6 text-center text-[#FBF7EF] shadow-2xl">
              <span className="flex h-11 w-11 items-center justify-center rounded-full border border-amber-400/45 bg-amber-950/50 text-lg text-[#EBCF8F]">
                ✦
              </span>
              <h3 className="mt-3 font-editorial text-2xl text-[#FBF7EF]">
                Camera chưa sẵn sàng
              </h3>
              <p className="mt-2 text-xs leading-relaxed text-[#FBF7EF]/75">
                {errorReason ||
                  'Không thể mở camera — bạn vẫn có thể thử đồ ngay với ảnh cá nhân hoặc Dáng Mẫu Atelier.'}
              </p>

              <div className="mt-5 flex w-full flex-col gap-2">
                <button
                  type="button"
                  data-testid="smart-mirror-fallback-upload"
                  onClick={onFallbackToUpload}
                  className="w-full cursor-pointer rounded-full bg-gradient-to-r from-[#EBCF8F] via-[#D2AC65] to-[#B08A4A] px-4 py-2.5 text-xs font-semibold tracking-[0.12em] uppercase text-[#1C1410] transition-all hover:brightness-105"
                >
                  Tải Ảnh Của Bạn
                </button>
                <button
                  type="button"
                  data-testid="smart-mirror-fallback-presets"
                  onClick={onFallbackToPresets}
                  className="w-full cursor-pointer rounded-full border border-[#EBCF8F]/50 bg-[#2B2019] px-4 py-2 text-xs font-medium text-[#EBCF8F] transition-colors hover:bg-[#38291F]"
                >
                  Dáng Mẫu Thử Nhanh
                </button>
                <button
                  type="button"
                  data-testid="smart-mirror-retry-camera"
                  onClick={() => void startCamera()}
                  className="mt-1 cursor-pointer text-[11px] text-[#EBD9B4]/75 underline decoration-[#B08A4A]/55 underline-offset-4 hover:text-[#EBCF8F]"
                >
                  Thử bật lại Camera
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {/* Phase 4: Pure Live Smart Mirror (Mirrored <video>, ZERO 2D garment overlay!) */}
        {phase === 'live' ? (
          <>
            <video
              ref={videoRef}
              data-testid="smart-mirror-video"
              autoPlay
              playsInline
              muted
              onLoadedData={() => setVideoReady(true)}
              style={{ transform: 'scaleX(-1)' }}
              className="block h-full w-full object-cover"
            />

            {/* Top-left live privacy + pose lock status pill */}
            <div className="pointer-events-none absolute top-3 left-3 z-20 flex flex-col items-start gap-1.5">
              <span className="inline-flex items-center gap-1.5 rounded-full border border-[#EBCF8F]/40 bg-[#1C1410]/80 px-2.5 py-1 text-[10px] font-medium tracking-[0.12em] uppercase text-[#F4EBDA] backdrop-blur-md">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
                <span>Gương Thông Minh</span>
              </span>

              {poseLocked ? (
                <span
                  data-testid="smart-mirror-pose-locked-badge"
                  className="inline-flex items-center gap-1 rounded-full border border-[#EBCF8F] bg-[#1C1410]/88 px-2.5 py-1 text-[10px] font-semibold text-[#EBCF8F] shadow-[0_0_20px_rgba(235,207,143,0.4)] backdrop-blur-md"
                >
                  <span>✓ Đã khóa chuẩn khung dáng</span>
                </span>
              ) : null}
            </div>

            {/* Center Refined Silhouette Guide Frame SVG (ZERO dots on chest, ZERO pasted clothes) */}
            <svg
              viewBox="0 0 300 400"
              aria-hidden="true"
              data-testid="smart-mirror-silhouette-guide"
              data-guide-tone={guideTone}
              className="pointer-events-none absolute inset-0 z-10 h-full w-full transition-all duration-300"
              style={
                guideTone === 'gold'
                  ? { filter: 'drop-shadow(0 0 12px rgba(235,207,143,0.65))' }
                  : undefined
              }
            >
              {/* Framing corner hairlines */}
              <path
                d="M24 44 V24 H44 M256 24 H276 V44 M24 356 V376 H44 M256 376 H276 V356"
                fill="none"
                stroke={silhouetteStroke}
                strokeWidth="1.5"
                strokeLinecap="round"
              />

              {/* Subtle head & upper-body couture silhouette guide */}
              <ellipse
                cx="150"
                cy="90"
                rx="32"
                ry="40"
                fill="none"
                stroke={silhouetteStroke}
                strokeWidth="1.5"
                strokeDasharray={guideTone === 'gold' ? undefined : '5 5'}
              />
              <path
                d="M132 128 C132 142, 126 148, 108 154 C84 162, 66 184, 62 222 L56 344 M168 128 C168 142, 174 148, 192 154 C216 162, 234 184, 238 222 L244 344"
                fill="none"
                stroke={silhouetteStroke}
                strokeWidth="1.75"
                strokeLinecap="round"
                strokeDasharray={guideTone === 'gold' ? undefined : '6 5'}
              />
            </svg>

            {/* Centered 3 — 2 — 1 Auto Countdown */}
            {countdownValue !== null ? (
              <div
                data-testid="smart-mirror-countdown"
                className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center"
              >
                <div className="flex h-24 w-24 items-center justify-center rounded-full border-2 border-[#EBCF8F] bg-[#1C1410]/78 font-editorial text-5xl font-semibold text-[#EBCF8F] shadow-[0_0_48px_rgba(235,207,143,0.55)] backdrop-blur-md">
                  {countdownValue}
                </div>
              </div>
            ) : null}

            {/* Bottom Guidance Hint + Parallel Manual "Chụp ngay" Action */}
            <div className="absolute inset-x-3 bottom-3 z-20 flex flex-col items-center gap-2">
              <p
                data-testid="smart-mirror-hint"
                role="status"
                aria-live="polite"
                className={`max-w-full rounded-xl border px-3 py-1.5 text-center text-[11px] leading-snug shadow-lg backdrop-blur-md ${
                  guideTone === 'gold'
                    ? 'border-[#EBCF8F]/70 bg-[#1C1410]/88 text-[#EBCF8F]'
                    : guideTone === 'amber'
                      ? 'border-amber-400/60 bg-[#261A10]/90 text-amber-100'
                      : 'border-[#B08A4A]/35 bg-[#1C1410]/84 text-[#FBF7EF]/90'
                }`}
              >
                {guideHint}
              </p>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  data-testid="smart-mirror-capture-now-btn"
                  disabled={!videoReady || capturing}
                  onClick={() => void captureAndEmitFrame()}
                  className="cursor-pointer rounded-full bg-gradient-to-r from-[#EBCF8F] via-[#D2AC65] to-[#B08A4A] px-5 py-2 text-xs font-semibold tracking-[0.14em] uppercase text-[#1C1410] shadow-[0_12px_28px_-10px_rgba(235,207,143,0.7)] transition-all hover:brightness-105 active:translate-y-px disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {capturing ? 'Đang lưu khung hình...' : 'Chụp ngay'}
                </button>
              </div>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
