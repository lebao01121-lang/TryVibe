'use client';

import {
  TryOnSource,
  type TryOnFaceBox,
  type TryOnPoseLandmarks,
  type TryOnPosePoint,
} from '@atelier/contracts';

export type { TryOnFaceBox, TryOnPoseLandmarks, TryOnPosePoint };

export interface CapturedTryOnPhoto {
  blob: Blob;
  previewDataUrl: string;
  sha256Hash: string;
  poseScore: number;
  source: TryOnSource;
  poseLandmarks?: TryOnPoseLandmarks | null;
}

export interface TryOnSampleModel {
  id: 'sample-female-1' | 'sample-female-2' | 'sample-male-1';
  testId: string;
  src: string;
  name: string;
  subtitle: string;
  fullLabel: string;
  poseLandmarks: TryOnPoseLandmarks;
}

export const TRYON_SAMPLE_MODELS: readonly TryOnSampleModel[] = [
  {
    id: 'sample-female-1',
    testId: 'tryon-sample-female-1',
    src: '/tryon-samples/sample-female-1.webp',
    name: 'Minh Thư',
    subtitle: 'Nữ 1m65 · Bán thân',
    fullLabel: 'Minh Thư · Nữ 1m65 (Bán thân)',
    poseLandmarks: {
      nose: { x: 0.5, y: 0.2, visibility: 0.98 },
      leftShoulder: { x: 0.36, y: 0.37, visibility: 0.97 },
      rightShoulder: { x: 0.64, y: 0.37, visibility: 0.97 },
      leftHip: { x: 0.4, y: 0.72, visibility: 0.92 },
      rightHip: { x: 0.6, y: 0.72, visibility: 0.92 },
      chinY: 0.27,
      faceBox: { x: 0.39, y: 0.09, w: 0.22, h: 0.19 },
    },
  },
  {
    id: 'sample-female-2',
    testId: 'tryon-sample-female-2',
    src: '/tryon-samples/sample-female-2.webp',
    name: 'Khánh Linh',
    subtitle: 'Nữ 1m70 · Toàn thân',
    fullLabel: 'Khánh Linh · Nữ 1m70 (Toàn thân)',
    poseLandmarks: {
      nose: { x: 0.5, y: 0.17, visibility: 0.98 },
      leftShoulder: { x: 0.37, y: 0.34, visibility: 0.97 },
      rightShoulder: { x: 0.63, y: 0.34, visibility: 0.97 },
      leftHip: { x: 0.41, y: 0.62, visibility: 0.95 },
      rightHip: { x: 0.59, y: 0.62, visibility: 0.95 },
      chinY: 0.23,
      faceBox: { x: 0.41, y: 0.08, w: 0.18, h: 0.16 },
    },
  },
  {
    id: 'sample-male-1',
    testId: 'tryon-sample-male-1',
    src: '/tryon-samples/sample-male-1.webp',
    name: 'Quang Minh',
    subtitle: 'Nam 1m78 · Bán thân',
    fullLabel: 'Quang Minh · Nam 1m78 (Bán thân)',
    poseLandmarks: {
      nose: { x: 0.5, y: 0.19, visibility: 0.98 },
      leftShoulder: { x: 0.32, y: 0.36, visibility: 0.97 },
      rightShoulder: { x: 0.68, y: 0.36, visibility: 0.97 },
      leftHip: { x: 0.38, y: 0.74, visibility: 0.91 },
      rightHip: { x: 0.62, y: 0.74, visibility: 0.91 },
      chinY: 0.26,
      faceBox: { x: 0.39, y: 0.09, w: 0.22, h: 0.18 },
    },
  },
] as const;

export const TOO_CLOSE_WARNING_TEXT =
  'Hãy lùi nhẹ khoảng 55–90cm để lộ rõ hai vai cho Gương 3D AR.';

export interface MediaPipePoseCameraProps {
  onCaptured?: (photo: CapturedTryOnPhoto) => void;
  disabled?: boolean;
  framingMode?: 'UPPER' | 'ONE_PIECE' | 'MIX_MATCH_OUTFIT' | 'LOWER';
  requestedMode?: { mode: 'camera' | 'upload'; nonce: number } | null;
}

export function stopMediaStreamTracks(stream: MediaStream | null | undefined): void {
  if (!stream || typeof stream.getTracks !== 'function') return;
  stream.getTracks().forEach((track) => {
    try {
      track.stop();
    } catch {
      // Ignore already-ended hardware track errors
    }
  });
}

export async function computeSha256Hex(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const hashBuf = await crypto.subtle.digest('SHA-256', buffer);
    const bytes = new Uint8Array(hashBuf);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }
  const view = new Uint8Array(buffer);
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < view.length; i += Math.max(1, Math.floor(view.length / 4096))) {
    const ch = view[i] ?? 0;
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  const part = `${(h1 >>> 0).toString(16).padStart(8, '0')}${(h2 >>> 0).toString(16).padStart(8, '0')}`;
  return (part + part + part + part).slice(0, 64);
}

export async function loadSampleModelAsCapturedPhoto(
  sample: TryOnSampleModel,
): Promise<CapturedTryOnPhoto> {
  const response = await fetch(sample.src);
  if (!response.ok) {
    throw new Error(`Không thể tải ảnh người mẫu thật (HTTP ${response.status}).`);
  }
  const rawBlob = await response.blob();
  const blob =
    rawBlob.type && rawBlob.type.startsWith('image/')
      ? rawBlob
      : new Blob([rawBlob], { type: 'image/webp' });
  const sha256Hash = await computeSha256Hex(blob);
  const previewDataUrl = await new Promise<string>((resolve) => {
    const reader = new FileReader();
    reader.onload = () =>
      resolve(typeof reader.result === 'string' ? reader.result : sample.src);
    reader.onerror = () => resolve(sample.src);
    reader.readAsDataURL(blob);
  });

  return {
    blob,
    previewDataUrl,
    sha256Hash,
    poseScore: 0.95,
    source: TryOnSource.STATIC_UPLOAD,
    poseLandmarks: sample.poseLandmarks,
  };
}

/**
 * Thin backward-compatible placeholder; real-time 3D AR camera tracking lives
 * in `./engine/TryOn3DScene.tsx`.
 */
export function MediaPipePoseCamera(_props: MediaPipePoseCameraProps) {
  return null;
}
