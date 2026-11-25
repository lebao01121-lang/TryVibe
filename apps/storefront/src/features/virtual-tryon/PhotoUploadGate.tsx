'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  NormalizedPoseLandmark,
  SessionPersonFrame,
} from './vton/types';

export interface PhotoUploadGateProps {
  onFrameCaptured: (frame: SessionPersonFrame) => void;
  onSwitchToPresets: () => void;
}

const TARGET_WIDTH = 768 as const;
const TARGET_HEIGHT = 1024 as const;
const TARGET_ASPECT = TARGET_WIDTH / TARGET_HEIGHT; // 0.75 (3:4)
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB
const SESSION_TTL_MS = 15 * 60 * 1000; // 15 minutes

const LOCAL_MODEL_URL = '/models/pose_landmarker_lite.task';
const CDN_MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';
const LOCAL_WASM_URL = '/models/wasm';
const LOCAL_WASM_PROBE_URL = '/models/wasm/vision_wasm_internal.js';
const CDN_WASM_URL =
  'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm';

interface RawLandmark {
  x: number;
  y: number;
  z?: number;
  visibility?: number;
}

interface ImagePoseLandmarkerHandle {
  detect: (
    image: HTMLImageElement | HTMLCanvasElement | ImageBitmap,
  ) => { landmarks?: RawLandmark[][] };
  close?: () => void;
}

function clamp(v: number, min: number, max: number): number {
  if (!Number.isFinite(v)) return min;
  return Math.max(min, Math.min(max, v));
}

async function detectImageMimeFromMagicBytes(
  file: File,
): Promise<'image/jpeg' | 'image/png' | 'image/webp' | null> {
  const slice = file.slice(0, 12);
  const buffer = await slice.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 12) return null;

  // JPEG: FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'image/png';
  }
  // WebP: RIFF....WEBP
  if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp';
  }

  return null;
}

async function computeSha256HexFromDataUrl(dataUrl: string): Promise<string> {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(dataUrl);
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

function buildHeuristic33Landmarks(): NormalizedPoseLandmark[] {
  const landmarks: NormalizedPoseLandmark[] = Array.from({ length: 33 }, () => ({
    x: 0.5,
    y: 0.5,
    z: 0,
    visibility: 0.2,
  }));

  landmarks[0] = { x: 0.5, y: 0.2, z: -0.05, visibility: 0.94 }; // nose
  landmarks[7] = { x: 0.43, y: 0.19, z: 0.02, visibility: 0.88 }; // left ear
  landmarks[8] = { x: 0.57, y: 0.19, z: 0.02, visibility: 0.88 }; // right ear
  landmarks[9] = { x: 0.475, y: 0.24, z: -0.04, visibility: 0.9 }; // mouth left
  landmarks[10] = { x: 0.525, y: 0.24, z: -0.04, visibility: 0.9 }; // mouth right
  landmarks[11] = { x: 0.34, y: 0.35, z: 0, visibility: 0.95 }; // left shoulder
  landmarks[12] = { x: 0.66, y: 0.35, z: 0, visibility: 0.95 }; // right shoulder
  landmarks[13] = { x: 0.27, y: 0.55, z: 0.01, visibility: 0.88 }; // left elbow
  landmarks[14] = { x: 0.73, y: 0.55, z: 0.01, visibility: 0.88 }; // right elbow
  landmarks[15] = { x: 0.28, y: 0.73, z: -0.02, visibility: 0.82 }; // left wrist
  landmarks[16] = { x: 0.72, y: 0.73, z: -0.02, visibility: 0.82 }; // right wrist
  landmarks[23] = { x: 0.39, y: 0.74, z: 0.01, visibility: 0.9 }; // left hip
  landmarks[24] = { x: 0.61, y: 0.74, z: 0.01, visibility: 0.9 }; // right hip

  return landmarks;
}

async function createImageLandmarkerSafe(): Promise<ImagePoseLandmarkerHandle | null> {
  if (typeof window === 'undefined') return null;

  const task = (async (): Promise<ImagePoseLandmarkerHandle | null> => {
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
          // Try next WASM base
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
            runningMode: 'IMAGE',
            numPoses: 1,
            minPoseDetectionConfidence: 0.45,
            minPosePresenceConfidence: 0.45,
          });
          return inst as unknown as ImagePoseLandmarkerHandle;
        } catch {
          // Try next model asset
        }
      }
      return null;
    } catch {
      return null;
    }
  })();

  const timeout = new Promise<null>((resolve) => {
    window.setTimeout(() => resolve(null), 4500);
  });

  return Promise.race([task, timeout]);
}

function loadImageElementFromFile(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      URL.revokeObjectURL(objectUrl);
      if (img.naturalWidth < 64 || img.naturalHeight < 64) {
        reject(new Error('Kích thước ảnh quá nhỏ (tối thiểu 64×64px).'));
        return;
      }
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error('Không thể đọc dữ liệu ảnh — tệp có thể đã bị hỏng.'));
    };
    img.src = objectUrl;
  });
}

function computeSmartPortraitCrop(
  srcW: number,
  srcH: number,
  rawLandmarks: RawLandmark[] | null,
): { cropX: number; cropY: number; cropW: number; cropH: number } {
  const srcAspect = srcW / Math.max(1, srcH);
  let cropW: number;
  let cropH: number;

  if (srcAspect > TARGET_ASPECT) {
    // Source wider than 3:4
    cropH = srcH;
    cropW = Math.round(srcH * TARGET_ASPECT);
  } else {
    // Source taller than 3:4
    cropW = srcW;
    cropH = Math.round(srcW / TARGET_ASPECT);
  }

  let centerX = srcW * 0.5;
  let topY = Math.max(0, (srcH - cropH) * 0.22);

  if (rawLandmarks && rawLandmarks.length >= 25) {
    const nose = rawLandmarks[0];
    const ls = rawLandmarks[11];
    const rs = rawLandmarks[12];
    const lh = rawLandmarks[23];
    const rh = rawLandmarks[24];

    if (
      ls &&
      rs &&
      (ls.visibility ?? 0.9) >= 0.45 &&
      (rs.visibility ?? 0.9) >= 0.45
    ) {
      const shMidX = ((ls.x + rs.x) * 0.5) * srcW;
      const shMidY = ((ls.y + rs.y) * 0.5) * srcH;
      const shSpanPx = Math.hypot((ls.x - rs.x) * srcW, (ls.y - rs.y) * srcH);

      // Only zoom into upper/three-quarter torso when subject is small in a wide photo;
      // preserve full 3:4 framing for already well-composed studio portraits
      if (shSpanPx / Math.max(1, cropW) < 0.24) {
        const idealCropW = clamp(shSpanPx / 0.34, cropW * 0.52, cropW);
        const idealCropH = idealCropW / TARGET_ASPECT;
        if (idealCropW <= srcW && idealCropH <= srcH) {
          cropW = Math.round(idealCropW);
          cropH = Math.round(idealCropH);
        }
      }

      centerX = shMidX;
      const noseY = nose && (nose.visibility ?? 0.8) > 0.4 ? nose.y * srcH : shMidY - shSpanPx * 0.55;
      const hipY =
        lh && rh && (lh.visibility ?? 0) > 0.45 && (rh.visibility ?? 0) > 0.45
          ? ((lh.y + rh.y) * 0.5) * srcH
          : shMidY + shSpanPx * 1.4;

      // Place nose around ~19% from top while keeping hips inside frame
      const idealTopFromNose = noseY - cropH * 0.19;
      const idealTopFromTorso = (shMidY + hipY) * 0.5 - cropH * 0.54;
      topY = idealTopFromNose * 0.65 + idealTopFromTorso * 0.35;
    }
  }

  const cropX = clamp(Math.round(centerX - cropW * 0.5), 0, Math.max(0, srcW - cropW));
  const cropY = clamp(Math.round(topY), 0, Math.max(0, srcH - cropH));

  return { cropX, cropY, cropW, cropH };
}

function sampleAmbientRgb(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
): [number, number, number] {
  const sampleX = Math.floor(width * 0.25);
  const sampleY = Math.floor(height * 0.22);
  const sampleW = Math.max(16, Math.floor(width * 0.5));
  const sampleH = Math.max(16, Math.floor(height * 0.52));
  const data = ctx.getImageData(sampleX, sampleY, sampleW, sampleH).data;

  let rSum = 0;
  let gSum = 0;
  let bSum = 0;
  let count = 0;

  // Stride by 16 pixels for sub-millisecond ambient RGB estimate
  for (let i = 0; i < data.length; i += 64) {
    rSum += data[i] ?? 180;
    gSum += data[i + 1] ?? 170;
    bSum += data[i + 2] ?? 160;
    count += 1;
  }

  if (count === 0) return [192, 182, 170];
  return [
    Math.round(rSum / count),
    Math.round(gSum / count),
    Math.round(bSum / count),
  ];
}

/**
 * Quiet Luxury drag-and-drop / file picker portrait upload gate.
 * Validates real JPEG/PNG/WebP magic bytes <= 10MB, detects pose landmarks in browser,
 * smart-crops to 768×1024 (3:4), samples ambientRgb, and computes SHA-256 frameHash.
 */
export function PhotoUploadGate({
  onFrameCaptured,
  onSwitchToPresets,
}: PhotoUploadGateProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const landmarkerRef = useRef<ImagePoseLandmarkerHandle | null>(null);
  const unmountedRef = useRef(false);

  const [dragActive, setDragActive] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
      try {
        landmarkerRef.current?.close?.();
      } catch {
        // Ignore WASM close errors
      }
      landmarkerRef.current = null;
    };
  }, []);

  const processSelectedFile = useCallback(
    async (file: File) => {
      setErrorMessage(null);
      setProcessing(true);
      setStatusMessage('Đang kiểm tra định dạng ảnh...');

      try {
        if (file.size <= 0) {
          throw new Error('Tệp ảnh rỗng — vui lòng chọn ảnh chân dung hợp lệ.');
        }
        if (file.size > MAX_UPLOAD_BYTES) {
          throw new Error(
            'Ảnh vượt quá giới hạn 10MB — vui lòng chọn ảnh dung lượng nhẹ hơn.',
          );
        }

        const realMime = await detectImageMimeFromMagicBytes(file);
        if (!realMime) {
          throw new Error(
            'Định dạng tệp chưa được hỗ trợ — vui lòng tải lên ảnh JPEG, PNG hoặc WebP.',
          );
        }

        setStatusMessage('Đang giải mã ảnh & định vị khung dáng...');
        const img = await loadImageElementFromFile(file);
        if (unmountedRef.current) return;

        // Run MediaPipe PoseLandmarker (IMAGE mode) when available
        let rawLandmarks: RawLandmark[] | null = null;
        try {
          if (!landmarkerRef.current) {
            landmarkerRef.current = await createImageLandmarkerSafe();
          }
          if (landmarkerRef.current && !unmountedRef.current) {
            const res = landmarkerRef.current.detect(img);
            if (res?.landmarks?.[0] && res.landmarks[0].length >= 25) {
              rawLandmarks = res.landmarks[0];
            }
          }
        } catch {
          rawLandmarks = null;
        }

        if (unmountedRef.current) return;
        setStatusMessage('Đang chuẩn hóa khung chân dung 768×1024 (3:4)...');

        const { cropX, cropY, cropW, cropH } = computeSmartPortraitCrop(
          img.naturalWidth,
          img.naturalHeight,
          rawLandmarks,
        );

        const canvas = document.createElement('canvas');
        canvas.width = TARGET_WIDTH;
        canvas.height = TARGET_HEIGHT;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) {
          throw new Error('Trình duyệt không hỗ trợ dựng ảnh Canvas 2D.');
        }

        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.fillStyle = '#1C1410';
        ctx.fillRect(0, 0, TARGET_WIDTH, TARGET_HEIGHT);
        ctx.drawImage(
          img,
          cropX,
          cropY,
          cropW,
          cropH,
          0,
          0,
          TARGET_WIDTH,
          TARGET_HEIGHT,
        );

        const ambientRgb = sampleAmbientRgb(ctx, TARGET_WIDTH, TARGET_HEIGHT);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.92);
        const frameHash = await computeSha256HexFromDataUrl(dataUrl);

        if (unmountedRef.current) return;

        let poseLandmarks: NormalizedPoseLandmark[];
        if (rawLandmarks && rawLandmarks.length >= 25) {
          poseLandmarks = Array.from({ length: 33 }, (_, idx) => {
            const lm = rawLandmarks?.[idx];
            if (!lm) {
              return { x: 0.5, y: 0.5, z: 0, visibility: 0.1 };
            }
            return {
              x: clamp((lm.x * img.naturalWidth - cropX) / Math.max(1, cropW), -0.15, 1.15),
              y: clamp((lm.y * img.naturalHeight - cropY) / Math.max(1, cropH), -0.15, 1.15),
              z: Number.isFinite(lm.z) ? (lm.z as number) : 0,
              visibility: clamp(lm.visibility ?? 0.9, 0, 1),
            };
          });
        } else {
          poseLandmarks = buildHeuristic33Landmarks();
        }

        const now = Date.now();
        const cleanName = file.name
          .replace(/\.[^.]+$/, '')
          .replace(/[^\p{L}\p{N}\s_-]/gu, ' ')
          .trim()
          .slice(0, 40);

        const frame: SessionPersonFrame = {
          frameId: `upload-${now}-${frameHash.slice(0, 8)}`,
          frameHash,
          dataUrl,
          width: TARGET_WIDTH,
          height: TARGET_HEIGHT,
          source: 'upload',
          label: cleanName || 'Ảnh chân dung của bạn',
          poseLandmarks,
          ambientRgb,
          capturedAt: now,
          expiresAt: now + SESSION_TTL_MS,
        };

        setProcessing(false);
        setStatusMessage(null);
        onFrameCaptured(frame);
      } catch (err) {
        if (unmountedRef.current) return;
        setProcessing(false);
        setStatusMessage(null);
        setErrorMessage(
          err instanceof Error
            ? err.message
            : 'Không thể xử lý ảnh tải lên — vui lòng thử ảnh khác.',
        );
      }
    },
    [onFrameCaptured],
  );

  return (
    <div
      data-testid="photo-upload-gate"
      className="flex h-full w-full flex-col items-center justify-center"
    >
      <div
        onDragEnter={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setDragActive(true);
        }}
        onDragOver={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setDragActive(true);
        }}
        onDragLeave={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setDragActive(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setDragActive(false);
          const dropped = event.dataTransfer.files?.[0];
          if (dropped) {
            void processSelectedFile(dropped);
          }
        }}
        className={`relative flex aspect-[3/4] h-full max-h-full max-w-full flex-col items-center justify-between overflow-hidden rounded-2xl border px-5 py-6 text-center text-[#FBF7EF] shadow-[0_24px_64px_-24px_rgba(0,0,0,0.85)] transition-colors ${
          dragActive
            ? 'border-[#EBCF8F] bg-[#2B2019]/95'
            : 'border-dashed border-[#B08A4A]/48 bg-[#1C1410]/92'
        }`}
      >
        {/* Hidden real file input */}
        <input
          ref={inputRef}
          type="file"
          data-testid="tryon-photo-upload-input"
          accept="image/jpeg,image/png,image/webp"
          className="sr-only"
          onChange={(event) => {
            const picked = event.target.files?.[0];
            event.target.value = '';
            if (picked) {
              void processSelectedFile(picked);
            }
          }}
        />

        {/* Top Privacy Pill */}
        <span className="inline-flex items-center gap-1.5 rounded-full border border-[#EBCF8F]/40 bg-[#241A14]/90 px-3 py-1 text-[10px] font-medium tracking-[0.16em] uppercase text-[#EBCF8F]">
          <span aria-hidden="true">🔒</span>
          <span>TỰ ĐỘNG XÓA ẢNH SAU 15 PHÚT</span>
        </span>

        {/* Center Dropzone Graphic & CTA */}
        <div className="my-auto flex w-full max-w-[320px] flex-col items-center">
          <div className="flex h-16 w-16 items-center justify-center rounded-full border border-[#EBCF8F]/45 bg-[#2B2019]/85 text-2xl text-[#EBCF8F] shadow-inner">
            {processing ? (
              <span className="inline-block h-6 w-6 animate-spin rounded-full border-2 border-[#EBCF8F]/30 border-t-[#EBCF8F]" />
            ) : (
              <svg
                width="28"
                height="28"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M12 16V4" />
                <path d="m7 9 5-5 5 5" />
                <path d="M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
              </svg>
            )}
          </div>

          <h3 className="mt-4 font-editorial text-2xl font-medium text-[#FBF7EF]">
            {processing ? 'Đang xử lý ảnh chân dung' : 'Tải Ảnh Của Bạn'}
          </h3>

          <p className="mt-1.5 text-xs leading-relaxed text-[#FBF7EF]/72">
            {processing && statusMessage
              ? statusMessage
              : 'Kéo thả ảnh chân dung vào đây hoặc chọn từ thiết bị. Hệ thống tự nhận diện dáng vai và chuẩn hóa tỷ lệ 3:4.'}
          </p>

          <button
            type="button"
            disabled={processing}
            data-testid="tryon-photo-upload-btn"
            onClick={() => inputRef.current?.click()}
            className="mt-5 w-full cursor-pointer rounded-full bg-gradient-to-r from-[#EBCF8F] via-[#D2AC65] to-[#B08A4A] px-5 py-2.5 text-xs font-semibold tracking-[0.14em] uppercase text-[#1C1410] shadow-[0_12px_28px_-10px_rgba(235,207,143,0.55)] transition-all hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-55"
          >
            {processing ? 'Đang phân tích...' : 'Chọn ảnh từ thiết bị'}
          </button>

          <p className="mt-2.5 text-[10px] tracking-[0.1em] text-[#EBD9B4]/65">
            Hỗ trợ JPEG · PNG · WebP · Tối đa 10MB
          </p>

          {errorMessage ? (
            <div
              data-testid="tryon-photo-upload-error"
              role="alert"
              className="mt-3 w-full rounded-xl border border-amber-400/50 bg-amber-950/55 px-3 py-2 text-[11px] leading-snug text-amber-100"
            >
              {errorMessage}
            </div>
          ) : null}
        </div>

        {/* Bottom Framing Tips + Quick Preset Fallback */}
        <div className="w-full space-y-2.5">
          <div className="grid grid-cols-3 gap-1.5 rounded-xl border border-[#B08A4A]/22 bg-[#241A14]/72 p-2 text-[10px] text-[#F4EBDA]/80">
            <span>Chụp chính diện</span>
            <span>Rõ hai vai & eo</span>
            <span>Ánh sáng đều</span>
          </div>

          <button
            type="button"
            data-testid="tryon-upload-switch-presets"
            onClick={onSwitchToPresets}
            className="cursor-pointer text-[11px] text-[#EBCF8F]/90 underline decoration-[#B08A4A]/60 underline-offset-4 transition-colors hover:text-[#EBCF8F]"
          >
            Chưa có ảnh sẵn? Thử ngay trên Dáng Mẫu Atelier →
          </button>
        </div>
      </div>
    </div>
  );
}
