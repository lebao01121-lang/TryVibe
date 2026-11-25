import { io, type Socket } from 'socket.io-client';
import { apiFetch, getStoredSession } from '@/lib/api-client';
import { getOrCreateGuestSessionId } from '@/lib/guest-session';
import { compositeLocalAnatomicalTryOn } from './localAnatomicalCompositor';
import {
  computeTryOnCacheKey,
  sessionPersonStore,
} from './sessionPersonStore';
import type {
  BffTryOnJobStatusResponse,
  BffTryOnSynthesizeResponse,
  SynthesizeTryOnParams,
  TryOnProviderId,
  TryOnSynthesisJobStatus,
  TryOnSynthesisMode,
  TryOnSynthesisProgress,
  TryOnSynthesisResult,
} from './types';

const SYNTHESIZE_ENDPOINT = '/bff/v1/tryon/synthesize';
const JOBS_BASE_ENDPOINT = '/bff/v1/tryon/jobs';

const INITIAL_REQUEST_TIMEOUT_MS = 18_000;
const POLL_INTERVAL_MS = 1_200;
const POLL_REQUEST_TIMEOUT_MS = 6_000;
const JOB_MAX_WAIT_MS = 48_000;

export const INSTANT_CACHE_BADGE = '⚡ Tức thì từ bộ nhớ đệm';
export const AI_VTON_BADGE = '✦ AI VTON Tạo Sinh';
export const ATELIER_PHOM_BADGE = '✦ AI Atelier Phom Chuẩn';

export class TryOnSynthesisError extends Error {
  public readonly code: string;

  constructor(message: string, code = 'TRYON_SYNTHESIS_FAILED') {
    super(message);
    this.name = 'TryOnSynthesisError';
    this.code = code;
  }
}

export function createAbortError(message = 'Người dùng đã hủy tác vụ thử đồ AI.'): Error {
  if (typeof DOMException !== 'undefined') {
    return new DOMException(message, 'AbortError');
  }
  const err = new Error(message);
  err.name = 'AbortError';
  return err;
}

export function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const candidate = err as { name?: unknown };
  return candidate.name === 'AbortError';
}

function nowMs(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function pickString(obj: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const val = obj[key];
    if (typeof val === 'string' && val.trim().length > 0) {
      return val.trim();
    }
  }
  return undefined;
}

function pickNumber(obj: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const val = obj[key];
    if (typeof val === 'number' && Number.isFinite(val)) {
      return val;
    }
    if (typeof val === 'string' && val.trim().length > 0) {
      const parsed = Number(val);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return undefined;
}

function pickBoolean(obj: Record<string, unknown>, ...keys: string[]): boolean | undefined {
  for (const key of keys) {
    const val = obj[key];
    if (typeof val === 'boolean') {
      return val;
    }
  }
  return undefined;
}

function normalizeJobStatus(rawStatus: string | undefined): TryOnSynthesisJobStatus {
  const upper = (rawStatus ?? '').trim().toUpperCase();
  if (upper === 'COMPLETED' || upper === 'SYNTHESIZED' || upper === 'DONE') {
    return 'COMPLETED';
  }
  if (upper === 'FAILED' || upper === 'ERROR') {
    return 'FAILED';
  }
  if (upper === 'CANCELLED' || upper === 'CANCELED') {
    return 'CANCELLED';
  }
  if (upper === 'QUEUED' || upper === 'PENDING') {
    return 'QUEUED';
  }
  return 'PROCESSING';
}

function mapProgressToStageIndex(progressPct: number): number {
  if (progressPct >= 90) return 3;
  if (progressPct >= 60) return 2;
  if (progressPct >= 25) return 1;
  return 0;
}

export function resolveProviderBadge(
  provider: TryOnProviderId | undefined,
  rawBadge: string | undefined,
  cacheHit: boolean,
): string {
  if (cacheHit) {
    return rawBadge && rawBadge.trim().length > 0 ? rawBadge.trim() : INSTANT_CACHE_BADGE;
  }
  if (rawBadge && rawBadge.trim().length > 0) {
    return rawBadge.trim();
  }
  const normalized = (provider ?? '').toLowerCase();
  if (
    normalized === 'local_preview' ||
    normalized.includes('photometric') ||
    normalized.includes('mock') ||
    normalized.includes('pose_warp')
  ) {
    return ATELIER_PHOM_BADGE;
  }
  return AI_VTON_BADGE;
}

function createLinkedSignal(
  externalSignal: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  const onExternalAbort = () => {
    controller.abort();
  };

  if (externalSignal) {
    if (externalSignal.aborted) {
      clearTimeout(timer);
      controller.abort();
    } else {
      externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      externalSignal?.removeEventListener('abort', onExternalAbort);
    },
  };
}

function resolveRealtimeSocketUrl(): string {
  if (typeof window === 'undefined') {
    return '/realtime';
  }
  const explicit = process.env.NEXT_PUBLIC_REALTIME_URL?.trim();
  if (explicit) {
    return `${explicit.replace(/\/+$/, '')}/realtime`;
  }
  // When running direct Next.js on port 3000, Next.js strips trailing slash on `/socket.io/` -> 308 -> 404.
  // BFF :4000 explicitly whitelists http://127.0.0.1:3000 & http://localhost:3000 with credentials for Socket.io.
  const { protocol, hostname, port } = window.location;
  if (port === '3000' && (hostname === '127.0.0.1' || hostname === 'localhost')) {
    return `${protocol}//${hostname}:4000/realtime`;
  }
  return '/realtime';
}

function sendFireAndForgetCancel(jobId: string): void {
  const url = `${JOBS_BASE_ENDPOINT}/${encodeURIComponent(jobId)}/cancel`;
  void apiFetch<unknown>(url, {
    method: 'POST',
    timeoutMs: 4000,
    skipAuthRefresh: true,
    keepalive: true,
    body: JSON.stringify({ reason: 'USER_CANCELLED' }),
  }).catch(() => {
    // Ignore cancel network errors
  });
}

function mapVietnameseErrorMessage(
  statusCode: number,
  errorCode: string | undefined,
  rawMessage: string | undefined,
): string {
  const code = (errorCode ?? '').toUpperCase();
  if (code === 'INVALID_IMAGE_MAGIC_BYTES') {
    return 'Định dạng ảnh không hợp lệ. Vui lòng chọn ảnh JPEG, PNG hoặc WebP dưới 10MB.';
  }
  if (code === 'PRIVACY_CONSENT_REQUIRED') {
    return 'Vui lòng xác nhận đồng ý bảo mật 15 phút trước khi thử đồ AI.';
  }
  if (code === 'POSE_TOO_CLOSE') {
    return 'Bạn đang đứng quá gần khung hình. Vui lòng lùi lại nhẹ để thấy rõ vai và thân người (lượt thử đã được hoàn lại).';
  }
  if (code === 'NO_PERSON_DETECTED') {
    return 'Không nhận diện được dáng người rõ ràng trong ảnh. Vui lòng chọn ảnh đủ sáng (lượt thử đã được hoàn lại).';
  }
  if (statusCode === 429 || code.includes('QUOTA') || code.includes('RATE_LIMIT')) {
    return rawMessage && !rawMessage.startsWith('Yêu cầu thất bại')
      ? rawMessage
      : 'Bạn đã dùng hết lượt thử đồ AI trong ngày. Vui lòng thử lại sau hoặc dùng ảnh đã lưu trong bộ nhớ đệm.';
  }
  if (rawMessage && !rawMessage.startsWith('Yêu cầu thất bại')) {
    return rawMessage;
  }
  return 'Không thể hoàn tất ướm thử AI cho thiết kế này. Vui lòng thử lại sau giây lát.';
}

async function runLocalFallback(
  params: SynthesizeTryOnParams,
  cacheKey: string,
  startedAt: number,
  stepTotal: number,
): Promise<TryOnSynthesisResult> {
  const { personFrame, garments, lightingPreset, onStageChange, onProgress, signal } = params;

  if (signal?.aborted) {
    throw createAbortError();
  }

  const stageLabels = [
    'Đang định vị 33 khớp dáng chuẩn...',
    'Đang xử lý cổ áo & nền vải may đo...',
    'Đang căn phom & hòa ánh sáng phòng thử...',
    'Hoàn tất ướm thử Atelier',
  ] as const;
  const stagePcts = [20, 50, 80, 100] as const;

  const forwardStage = (stageIdx: number) => {
    const clamped = Math.max(0, Math.min(3, stageIdx));
    onStageChange?.(clamped);
    onProgress?.({
      status: clamped >= 3 ? 'COMPLETED' : 'PROCESSING',
      progressPct: stagePcts[clamped] ?? 50,
      stageLabel: stageLabels[clamped] ?? stageLabels[0],
      stepCurrent: Math.min(stepTotal, clamped >= 2 ? stepTotal : 1),
      stepTotal,
    });
  };

  try {
    const localOutput = await compositeLocalAnatomicalTryOn({
      personFrame,
      garments,
      lightingPreset,
      onStageChange: forwardStage,
    });

    if (signal?.aborted) {
      throw createAbortError();
    }

    const result: TryOnSynthesisResult = {
      cacheKey,
      cacheHit: false,
      provider: 'local_preview',
      providerBadge: ATELIER_PHOM_BADGE,
      resultDataUrl: localOutput.resultDataUrl,
      latencyMs: Math.max(1, Math.round(nowMs() - startedAt)),
      cleanCollarApplied: localOutput.cleanCollarApplied,
      stepTotal,
    };

    sessionPersonStore.setCachedResult(cacheKey, result);
    return result;
  } catch (err) {
    if (isAbortError(err) || signal?.aborted) {
      throw createAbortError();
    }
    forwardStage(3);
    return {
      cacheKey,
      cacheHit: false,
      provider: 'local_preview',
      providerBadge: ATELIER_PHOM_BADGE,
      resultDataUrl: personFrame.dataUrl,
      latencyMs: Math.max(1, Math.round(nowMs() - startedAt)),
      cleanCollarApplied: false,
      stepTotal,
    };
  }
}

interface AsyncJobWaitParams {
  jobId: string;
  sessionId?: string;
  initialProgressPct: number;
  initialStageLabel: string;
  initialStepCurrent: number;
  initialStepTotal: number;
  cacheKey: string;
  startedAt: number;
  onStageChange?: (stageIndex: number) => void;
  onProgress?: (update: TryOnSynthesisProgress) => void;
  signal?: AbortSignal;
}

class JobTimeoutFallbackError extends Error {
  constructor() {
    super('TRYON_JOB_TIMEOUT');
    this.name = 'JobTimeoutFallbackError';
  }
}

function waitForAsyncTryOnJob(
  params: AsyncJobWaitParams,
): Promise<TryOnSynthesisResult> {
  const {
    jobId,
    sessionId,
    initialProgressPct,
    initialStageLabel,
    initialStepCurrent,
    initialStepTotal,
    cacheKey,
    startedAt,
    onStageChange,
    onProgress,
    signal,
  } = params;

  return new Promise<TryOnSynthesisResult>((resolve, reject) => {
    let settled = false;
    let socket: Socket | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
    let pollInFlight = false;

    let highestPct = Math.max(1, Math.min(99, initialProgressPct));
    let lastStepCurrent = Math.max(1, initialStepCurrent);
    let lastStepTotal = Math.max(1, initialStepTotal);
    let lastStageLabel = initialStageLabel;

    const cleanup = () => {
      if (pollTimer !== null) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      if (timeoutTimer !== null) {
        clearTimeout(timeoutTimer);
        timeoutTimer = null;
      }
      if (socket) {
        try {
          socket.removeAllListeners();
          socket.disconnect();
        } catch {
          // Ignore socket disconnect cleanup errors
        }
        socket = null;
      }
      signal?.removeEventListener('abort', handleAbort);
    };

    const finishResolve = (result: TryOnSynthesisResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    const finishReject = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    const handleAbort = () => {
      if (settled) return;
      sendFireAndForgetCancel(jobId);
      finishReject(createAbortError());
    };

    if (signal?.aborted) {
      handleAbort();
      return;
    }
    signal?.addEventListener('abort', handleAbort, { once: true });

    const emitUpdate = (
      status: TryOnSynthesisJobStatus,
      pctCandidate: number | undefined,
      labelCandidate: string | undefined,
      stepCurrCandidate: number | undefined,
      stepTotalCandidate: number | undefined,
    ) => {
      if (settled) return;
      if (typeof stepTotalCandidate === 'number' && stepTotalCandidate >= 1) {
        lastStepTotal = Math.max(1, Math.round(stepTotalCandidate));
      }
      if (typeof stepCurrCandidate === 'number' && stepCurrCandidate >= 1) {
        lastStepCurrent = Math.max(1, Math.min(lastStepTotal, Math.round(stepCurrCandidate)));
      }
      if (typeof pctCandidate === 'number' && Number.isFinite(pctCandidate)) {
        const clamped = Math.max(0, Math.min(100, Math.round(pctCandidate)));
        highestPct = status === 'COMPLETED' ? 100 : Math.max(highestPct, clamped);
      } else if (status === 'COMPLETED') {
        highestPct = 100;
      }
      if (labelCandidate && labelCandidate.trim().length > 0) {
        lastStageLabel = labelCandidate.trim();
      }

      onStageChange?.(mapProgressToStageIndex(highestPct));
      onProgress?.({
        jobId,
        status,
        progressPct: highestPct,
        stageLabel: lastStageLabel,
        stepCurrent: lastStepCurrent,
        stepTotal: lastStepTotal,
      });
    };

    const handlePayload = (
      rawInput: unknown,
      forcedStatus?: TryOnSynthesisJobStatus,
    ) => {
      if (settled) return;
      const data = asRecord(rawInput);

      // Ignore events explicitly addressed to another job/session
      const evtJobId = pickString(data, 'jobId', 'job_id');
      const evtSessionId = pickString(data, 'sessionId', 'session_id');
      const matchesJob =
        (!evtJobId && !evtSessionId) ||
        evtJobId === jobId ||
        evtSessionId === jobId ||
        (Boolean(sessionId) && (evtJobId === sessionId || evtSessionId === sessionId));
      if (!matchesJob) {
        return;
      }

      const rawStatusStr = pickString(data, 'status');
      const status = forcedStatus ?? normalizeJobStatus(rawStatusStr);
      const pct = pickNumber(data, 'progressPct', 'progress_pct', 'progress');
      const stageLabel = pickString(data, 'stageLabel', 'stage_label', 'message');
      const stepCurrent = pickNumber(data, 'stepCurrent', 'step_current', 'stepOrder', 'step_order');
      const stepTotal = pickNumber(data, 'stepTotal', 'step_total', 'totalSteps', 'total_steps');

      if (status === 'CANCELLED') {
        finishReject(createAbortError());
        return;
      }

      if (status === 'FAILED') {
        const errorCode = pickString(data, 'errorCode', 'error_code');
        const rawErrMsg = pickString(data, 'errorMessage', 'error_message', 'error', 'message');
        const friendly = mapVietnameseErrorMessage(500, errorCode, rawErrMsg);
        emitUpdate('FAILED', highestPct, friendly, stepCurrent, stepTotal);
        finishReject(new TryOnSynthesisError(friendly, errorCode ?? 'TRYON_JOB_FAILED'));
        return;
      }

      const resultUrl = pickString(data, 'resultUrl', 'result_url', 'resultImageUrl', 'result_image_url');
      if (status === 'COMPLETED' && resultUrl) {
        const provider = (pickString(data, 'providerUsed', 'provider_used', 'provider') ??
          'catvton') as TryOnProviderId;
        const cacheHit = pickBoolean(data, 'cacheHit', 'cache_hit') ?? false;
        const rawBadge = pickString(
          data,
          'providerBadge',
          'provider_badge',
          'providerDisplayBadge',
          'provider_display_badge',
        );
        const providerBadge = resolveProviderBadge(provider, rawBadge, cacheHit);
        const serverCacheKey = pickString(data, 'cacheKey', 'cache_key');
        const expiresInSeconds = pickNumber(
          data,
          'expiresInSeconds',
          'expires_in_seconds',
          'privacyTtlSeconds',
        );
        const quotaRemaining = pickNumber(
          data,
          'quotaRemaining',
          'quota_remaining',
          'remainingQuota',
        );
        const finalStepTotal =
          typeof stepTotal === 'number' && stepTotal >= 1
            ? Math.round(stepTotal)
            : lastStepTotal;

        emitUpdate('COMPLETED', 100, stageLabel || 'Hoàn tất ướm thử', finalStepTotal, finalStepTotal);

        const completedResult: TryOnSynthesisResult = {
          cacheKey: serverCacheKey || cacheKey,
          cacheHit,
          provider,
          providerBadge,
          resultDataUrl: resultUrl,
          latencyMs: Math.max(1, Math.round(nowMs() - startedAt)),
          cleanCollarApplied: true,
          jobId,
          expiresInSeconds,
          quotaRemaining,
          stepTotal: finalStepTotal,
        };
        sessionPersonStore.setCachedResult(cacheKey, completedResult);
        finishResolve(completedResult);
        return;
      }

      emitUpdate(
        status === 'COMPLETED' ? 'PROCESSING' : status,
        pct,
        stageLabel,
        stepCurrent,
        stepTotal,
      );
    };

    // Emit immediate initial QUEUED progress
    emitUpdate('QUEUED', initialProgressPct, initialStageLabel, initialStepCurrent, initialStepTotal);

    // 1. Primary transport: Socket.io `/realtime` (with `path: '/socket.io/'`)
    if (typeof window !== 'undefined') {
      try {
        const socketUrl = resolveRealtimeSocketUrl();
        const session = getStoredSession();
        const guestSessionId = getOrCreateGuestSessionId();
        socket = io(socketUrl, {
          path: '/socket.io/',
          transports: ['websocket', 'polling'],
          withCredentials: true,
          auth: {
            ...(session?.accessToken ? { token: session.accessToken } : {}),
            guestSessionId,
          },
          reconnection: true,
          reconnectionAttempts: 2,
          reconnectionDelay: 800,
          timeout: 6000,
        });

        const subscribeRoom = () => {
          if (!socket || settled) return;
          socket.emit('tryon:subscribe', { jobId, sessionId: jobId });
          if (sessionId && sessionId !== jobId) {
            socket.emit('tryon:subscribe', { jobId, sessionId });
          }
        };

        socket.on('connect', subscribeRoom);
        socket.on('tryon:progress', (payload: unknown) => handlePayload(payload, 'PROCESSING'));
        socket.on('tryon:completed', (payload: unknown) => handlePayload(payload, 'COMPLETED'));
        socket.on('tryon:failed', (payload: unknown) => handlePayload(payload, 'FAILED'));
        socket.on('connect_error', () => {
          // Silently rely on parallel 1200ms HTTP polling fallback — zero console pollution!
        });
      } catch {
        // Socket.io init failed -> 1200ms HTTP polling handles completion seamlessly
      }
    }

    // 2. Parallel reliability transport: HTTP Polling Fallback every 1200ms
    const pollOnce = async () => {
      if (settled || pollInFlight || signal?.aborted) return;
      pollInFlight = true;
      const linked = createLinkedSignal(signal, POLL_REQUEST_TIMEOUT_MS);
      try {
        const res = await apiFetch<BffTryOnJobStatusResponse>(
          `${JOBS_BASE_ENDPOINT}/${encodeURIComponent(jobId)}`,
          {
            method: 'GET',
            skipAuthRefresh: true,
            signal: linked.signal,
          },
        );
        if (settled) return;
        if (signal?.aborted) {
          handleAbort();
          return;
        }
        if (res.ok && res.data) {
          handlePayload(res.data);
        }
      } catch {
        // Transient poll error — next tick will retry
      } finally {
        linked.cleanup();
        pollInFlight = false;
      }
    };

    pollTimer = setInterval(() => {
      void pollOnce();
    }, POLL_INTERVAL_MS);

    // 3. Hard 48s transient timeout guard -> graceful local fallback so user NEVER sees a broken screen
    timeoutTimer = setTimeout(() => {
      if (settled) return;
      sendFireAndForgetCancel(jobId);
      finishReject(new JobTimeoutFallbackError());
    }, JOB_MAX_WAIT_MS);
  });
}

export interface VtonProviderAdapter {
  synthesize(params: SynthesizeTryOnParams): Promise<TryOnSynthesisResult>;
}

/**
 * Stage 2 Realtime Virtual Try-On synthesis orchestrator:
 * 1. Client-side SHA-256 LRU cache (`sessionPersonStore`) -> instant `< 150ms` return (`⚡ Tức thì từ bộ nhớ đệm`).
 * 2. `POST /bff/v1/tryon/synthesize` (same-origin Next.js rewrite):
 *    - Case A (`HTTP 200 OK` + `COMPLETED` + `resultUrl`): Server Redis SHA-256 Cache HIT (`< 300ms`, 0 quota).
 *    - Case B (`HTTP 202 Accepted` + `jobId`): Async VTON job -> Socket.io `/realtime` + parallel `1200ms` HTTP polling,
 *      with full `AbortSignal` cancel (`POST /bff/v1/tryon/jobs/:jobId/cancel`) and `48s` fallback guard.
 *    - Case C (`LOCAL_PREVIEW_READY` or unreachable backend): seamless `compositeLocalAnatomicalTryOn` fallback.
 */
export async function synthesizeTryOn(
  params: SynthesizeTryOnParams,
): Promise<TryOnSynthesisResult> {
  const startedAt = nowMs();
  const {
    personFrame,
    garments,
    lightingPreset,
    mode,
    onStageChange,
    onProgress,
    signal,
  } = params;

  if (signal?.aborted) {
    throw createAbortError();
  }

  const resolvedMode: TryOnSynthesisMode =
    mode ?? (garments.length >= 2 ? 'OUTFIT' : 'SINGLE');
  const defaultStepTotal =
    resolvedMode === 'OUTFIT' ? Math.max(1, garments.length) : 1;

  const cacheKey = await computeTryOnCacheKey(
    personFrame.frameHash,
    garments,
    lightingPreset,
  );

  if (signal?.aborted) {
    throw createAbortError();
  }

  // Fast path: Client-side SHA-256 LRU cache hit (< 150ms)
  const cached = sessionPersonStore.getCachedResult(cacheKey);
  if (cached) {
    onStageChange?.(3);
    onProgress?.({
      jobId: cached.jobId,
      status: 'COMPLETED',
      progressPct: 100,
      stageLabel: 'Tức thì từ bộ nhớ đệm',
      stepCurrent: cached.stepTotal ?? defaultStepTotal,
      stepTotal: cached.stepTotal ?? defaultStepTotal,
    });
    return {
      ...cached,
      cacheKey,
      cacheHit: true,
      providerBadge: INSTANT_CACHE_BADGE,
      latencyMs: Math.max(1, Math.round(nowMs() - startedAt)),
    };
  }

  onStageChange?.(0);
  onProgress?.({
    status: 'QUEUED',
    progressPct: 5,
    stageLabel: 'Đang xếp hàng xử lý phòng thử đồ AI...',
    stepCurrent: 1,
    stepTotal: defaultStepTotal,
  });

  const requestBody = {
    personImageDataUrl: personFrame.dataUrl,
    personFrameHash: personFrame.frameHash,
    mode: resolvedMode,
    lightingPreset,
    privacyConsent: true,
    poseLandmarks: personFrame.poseLandmarks,
    garments: garments.map((g) => ({
      productId: g.productId,
      variantId: g.variantId,
      slot: g.slot,
      name: g.name,
      garmentImageUrl: g.garmentImageUrl,
      cleanGarmentUrl768x1024: g.garmentImageUrl,
      colorHex: g.colorHex,
      colorName: g.colorName,
    })),
  };

  const linked = createLinkedSignal(signal, INITIAL_REQUEST_TIMEOUT_MS);
  try {
    const res = await apiFetch<BffTryOnSynthesizeResponse>(SYNTHESIZE_ENDPOINT, {
      method: 'POST',
      skipAuthRefresh: true,
      signal: linked.signal,
      body: JSON.stringify(requestBody),
    });
    linked.cleanup();

    if (signal?.aborted) {
      throw createAbortError();
    }

    // Explicit client validation or quota rejection (400 / 429) -> surface crisp Vietnamese message
    if (!res.ok) {
      if (res.status === 400 || res.status === 429) {
        const message = mapVietnameseErrorMessage(
          res.status,
          res.error?.code,
          res.error?.message,
        );
        throw new TryOnSynthesisError(
          message,
          res.error?.code || (res.status === 429 ? 'QUOTA_EXCEEDED' : 'VALIDATION_ERROR'),
        );
      }
      // Unreachable BFF / 5xx gateway error -> seamless Case C local fallback
      return runLocalFallback(params, cacheKey, startedAt, defaultStepTotal);
    }

    const raw = asRecord(res.data);
    const rawStatus = (pickString(raw, 'status') ?? '').toUpperCase();

    // Case C: Backend explicitly signals Stage 1 local preview fallback
    if (rawStatus === 'LOCAL_PREVIEW_READY') {
      return runLocalFallback(params, cacheKey, startedAt, defaultStepTotal);
    }

    const resultUrl = pickString(raw, 'resultUrl', 'result_url', 'resultImageUrl', 'result_image_url');
    const jobId = pickString(raw, 'jobId', 'job_id', 'sessionId', 'session_id');
    const sessionId = pickString(raw, 'sessionId', 'session_id');
    const stepTotal = Math.max(
      1,
      Math.round(pickNumber(raw, 'stepTotal', 'step_total', 'totalSteps') ?? defaultStepTotal),
    );
    const stepCurrent = Math.max(
      1,
      Math.round(pickNumber(raw, 'stepCurrent', 'step_current') ?? 1),
    );

    // Case A: HTTP 200 OK & COMPLETED (or SYNTHESIZED) & resultUrl -> Server Redis SHA-256 Cache HIT!
    if ((rawStatus === 'COMPLETED' || rawStatus === 'SYNTHESIZED') && resultUrl) {
      const provider = (pickString(raw, 'providerUsed', 'provider_used', 'provider') ??
        'catvton') as TryOnProviderId;
      const cacheHit = pickBoolean(raw, 'cacheHit', 'cache_hit') ?? (res.status === 200);
      const rawBadge = pickString(
        raw,
        'providerBadge',
        'provider_badge',
        'providerDisplayBadge',
        'provider_display_badge',
      );
      const providerBadge = resolveProviderBadge(
        provider,
        rawBadge || (cacheHit ? INSTANT_CACHE_BADGE : undefined),
        cacheHit,
      );
      const serverCacheKey = pickString(raw, 'cacheKey', 'cache_key');
      const expiresInSeconds = pickNumber(
        raw,
        'expiresInSeconds',
        'expires_in_seconds',
        'privacyTtlSeconds',
      );
      const quotaRemaining = pickNumber(
        raw,
        'quotaRemaining',
        'quota_remaining',
        'remainingQuota',
      );

      onStageChange?.(3);
      onProgress?.({
        jobId,
        status: 'COMPLETED',
        progressPct: 100,
        stageLabel: pickString(raw, 'stageLabel', 'stage_label') || 'Tức thì từ bộ nhớ đệm',
        stepCurrent: stepTotal,
        stepTotal,
      });

      const instantResult: TryOnSynthesisResult = {
        cacheKey: serverCacheKey || cacheKey,
        cacheHit,
        provider,
        providerBadge,
        resultDataUrl: resultUrl,
        latencyMs: Math.max(1, Math.round(nowMs() - startedAt)),
        cleanCollarApplied: true,
        jobId,
        expiresInSeconds,
        quotaRemaining,
        stepTotal,
      };
      sessionPersonStore.setCachedResult(cacheKey, instantResult);
      return instantResult;
    }

    // Case B: HTTP 202 Accepted (or QUEUED/PROCESSING) & jobId -> Socket.io + 1200ms HTTP Polling
    if (jobId && (res.status === 202 || rawStatus === 'QUEUED' || rawStatus === 'PROCESSING')) {
      const initialPct = pickNumber(raw, 'progressPct', 'progress_pct') ?? 5;
      const initialLabel =
        pickString(raw, 'stageLabel', 'stage_label') ||
        'Đang xếp hàng xử lý phòng thử đồ AI...';

      try {
        return await waitForAsyncTryOnJob({
          jobId,
          sessionId,
          initialProgressPct: initialPct,
          initialStageLabel: initialLabel,
          initialStepCurrent: stepCurrent,
          initialStepTotal: stepTotal,
          cacheKey,
          startedAt,
          onStageChange,
          onProgress,
          signal,
        });
      } catch (err) {
        if (isAbortError(err) || signal?.aborted) {
          throw createAbortError();
        }
        if (err instanceof JobTimeoutFallbackError) {
          // Transient > 48s timeout -> fall back cleanly to local anatomical compositor
          return runLocalFallback(params, cacheKey, startedAt, stepTotal);
        }
        throw err;
      }
    }

    // Any unexpected status without jobId/resultUrl -> seamless Case C fallback
    return runLocalFallback(params, cacheKey, startedAt, defaultStepTotal);
  } catch (err) {
    linked.cleanup();
    if (isAbortError(err) || signal?.aborted) {
      throw createAbortError();
    }
    if (err instanceof TryOnSynthesisError) {
      throw err;
    }
    return runLocalFallback(params, cacheKey, startedAt, defaultStepTotal);
  }
}

export const defaultVtonProviderAdapter: VtonProviderAdapter = {
  synthesize: synthesizeTryOn,
};
