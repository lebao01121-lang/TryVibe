import {
  HTTP_HEADERS,
  type ApiError,
  type ApiResponse,
  type CartDto,
  type RefreshResponse,
  type UserSummaryDto,
} from '@atelier/contracts';
import {
  getExistingGuestSessionId,
  getOrCreateGuestSessionId,
} from './guest-session';
import { emitCartUpdated, refreshCartCount } from './storefront-actions';

export interface StoredSession {
  accessToken: string;
  csrfToken: string;
  user: UserSummaryDto | null;
}

export interface ApiFetchResult<T> {
  ok: boolean;
  status: number;
  data: T | null;
  error: ApiError | null;
  headers: Headers | null;
}

const STORAGE_KEY = 'atelier_storefront_session_v1';
const REFRESH_ENDPOINT = '/bff/v1/auth/refresh';

let memorySession: StoredSession | null = null;
const sessionListeners = new Set<() => void>();

let activeRefreshPromise: Promise<string | null> | null = null;

export function getBffBaseUrl(): string {
  if (typeof window !== 'undefined') {
    return '';
  }
  return (process.env.BFF_INTERNAL_URL || 'http://127.0.0.1:4000').replace(
    /\/+$/,
    '',
  );
}

function resolveApiRequestUrl(path: string): string {
  if (path.startsWith('http://') || path.startsWith('https://')) {
    return path;
  }
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  if (typeof window !== 'undefined') {
    return normalizedPath;
  }
  return `${getBffBaseUrl()}${normalizedPath}`;
}

function generateCorrelationId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `sf-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function generateRandomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  if (
    typeof crypto !== 'undefined' &&
    typeof crypto.getRandomValues === 'function'
  ) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < byteLength; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  // W3C Trace Context forbids all-zero trace-id and parent-id
  if (bytes.every((b) => b === 0)) {
    bytes[byteLength - 1] = 1;
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Generates a W3C Trace Context v00 `traceparent` header:
 * `00-<32 lowercase hex trace-id>-<16 lowercase hex span-id>-01`
 */
export function generateW3CTraceparent(): string {
  const traceId = generateRandomHex(16);
  const spanId = generateRandomHex(8);
  return `00-${traceId}-${spanId}-01`;
}

function readCookie(name: string): string | null {
  if (typeof document === 'undefined') return null;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = document.cookie.match(new RegExp(`(?:^|;\\s*)${escaped}=([^;]*)`));
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

export function getStoredSession(): StoredSession | null {
  if (memorySession) return memorySession;
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredSession;
    if (parsed && typeof parsed.accessToken === 'string') {
      memorySession = parsed;
      return memorySession;
    }
  } catch {
    return null;
  }
  return null;
}

export function setStoredSession(session: StoredSession | null): void {
  memorySession = session;
  if (typeof window !== 'undefined') {
    try {
      if (session) {
        window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(session));
      } else {
        window.sessionStorage.removeItem(STORAGE_KEY);
      }
    } catch {
      // Ignore storage quota errors in private mode
    }
  }
  sessionListeners.forEach((listener) => listener());
}

export function clearStoredSession(): void {
  setStoredSession(null);
}

export function subscribeSession(listener: () => void): () => void {
  sessionListeners.add(listener);
  return () => {
    sessionListeners.delete(listener);
  };
}

function getEffectiveCsrfToken(): string | null {
  const session = getStoredSession();
  return session?.csrfToken || readCookie('atelier_csrf_token');
}

async function performSilentRefresh(): Promise<string | null> {
  if (activeRefreshPromise) {
    return activeRefreshPromise;
  }

  activeRefreshPromise = (async () => {
    try {
      const csrfToken = getEffectiveCsrfToken();
      const headers = new Headers({
        Accept: 'application/json',
        [HTTP_HEADERS.CORRELATION_ID]: generateCorrelationId(),
        traceparent: generateW3CTraceparent(),
      });
      if (csrfToken) {
        headers.set(HTTP_HEADERS.CSRF_TOKEN, csrfToken);
      }
      if (typeof window !== 'undefined') {
        headers.set(HTTP_HEADERS.GUEST_SESSION_ID, getOrCreateGuestSessionId());
      }

      const response = await fetch(resolveApiRequestUrl(REFRESH_ENDPOINT), {
        method: 'POST',
        credentials: 'include',
        headers,
      });

      if (!response.ok) {
        clearStoredSession();
        return null;
      }

      const payload = (await response.json()) as ApiResponse<RefreshResponse>;
      if (!payload?.success || !payload.data?.accessToken) {
        clearStoredSession();
        return null;
      }

      const current = getStoredSession();
      const updated: StoredSession = {
        accessToken: payload.data.accessToken,
        csrfToken: payload.data.csrfToken || current?.csrfToken || '',
        user: payload.data.user ?? current?.user ?? null,
      };
      setStoredSession(updated);
      return updated.accessToken;
    } catch {
      return null;
    } finally {
      activeRefreshPromise = null;
    }
  })();

  return activeRefreshPromise;
}

export interface ApiFetchOptions extends Omit<RequestInit, 'headers'> {
  headers?: Record<string, string>;
  skipAuthRefresh?: boolean;
  timeoutMs?: number;
}

export async function apiFetch<T>(
  path: string,
  options: ApiFetchOptions = {},
): Promise<ApiFetchResult<T>> {
  const {
    headers: customHeaders,
    skipAuthRefresh = false,
    timeoutMs = 8000,
    ...rest
  } = options;

  const url = resolveApiRequestUrl(path);

  const execute = async (overrideToken?: string): Promise<Response> => {
    const session = getStoredSession();
    const token = overrideToken ?? session?.accessToken;
    const csrfToken = getEffectiveCsrfToken();

    const reqHeaders = new Headers({
      Accept: 'application/json',
      [HTTP_HEADERS.CORRELATION_ID]: generateCorrelationId(),
      traceparent: generateW3CTraceparent(),
    });

    if (typeof window !== 'undefined') {
      reqHeaders.set(HTTP_HEADERS.GUEST_SESSION_ID, getOrCreateGuestSessionId());
    }

    if (rest.body && !(rest.body instanceof FormData)) {
      reqHeaders.set('Content-Type', 'application/json');
    }
    if (token) {
      reqHeaders.set(HTTP_HEADERS.AUTHORIZATION, `Bearer ${token}`);
    }
    if (csrfToken) {
      reqHeaders.set(HTTP_HEADERS.CSRF_TOKEN, csrfToken);
    }
    if (customHeaders) {
      Object.entries(customHeaders).forEach(([key, value]) => {
        reqHeaders.set(key, value);
      });
    }

    return fetch(url, {
      ...rest,
      credentials: 'include',
      headers: reqHeaders,
      signal: rest.signal ?? AbortSignal.timeout(timeoutMs),
    });
  };

  try {
    let response = await execute();

    const isAuthEndpoint =
      path.includes('/auth/login') ||
      path.includes('/auth/register') ||
      path.includes('/auth/refresh');

    if (response.status === 401 && !skipAuthRefresh && !isAuthEndpoint) {
      const refreshedToken = await performSilentRefresh();
      if (refreshedToken) {
        response = await execute(refreshedToken);
      }
    }

    let json: ApiResponse<T> | null = null;
    try {
      json = (await response.json()) as ApiResponse<T>;
    } catch {
      json = null;
    }

    if (!response.ok || (json && !json.success)) {
      return {
        ok: false,
        status: response.status,
        data: null,
        error: json?.error ?? {
          code: 'INTERNAL_ERROR',
          message: `Yêu cầu thất bại (HTTP ${response.status})`,
        },
        headers: response.headers,
      };
    }

    const extractedData =
      json && 'data' in json ? json.data : ((json as unknown as T) ?? null);

    return {
      ok: true,
      status: response.status,
      data: extractedData,
      error: null,
      headers: response.headers,
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      data: null,
      error: {
        code: 'DEPENDENCY_UNAVAILABLE',
        message:
          err instanceof Error
            ? `Không thể kết nối máy chủ: ${err.message}`
            : 'Không thể kết nối máy chủ BFF.',
      },
      headers: null,
    };
  }
}

/**
 * Seamlessly merges an anonymous guest shopping cart (outfits, items, gift note)
 * into the authenticated customer account immediately after Login/Register.
 */
export async function mergeGuestCartAfterAuth(): Promise<CartDto | null> {
  if (typeof window === 'undefined') return null;
  const session = getStoredSession();
  const guestSessionId = getExistingGuestSessionId();
  if (!session?.accessToken || !guestSessionId) {
    refreshCartCount();
    return null;
  }

  const res = await apiFetch<CartDto>('/bff/v1/storefront/cart/merge', {
    method: 'POST',
    skipAuthRefresh: true,
    body: JSON.stringify({ guestSessionId }),
  });

  if (res.ok && res.data) {
    emitCartUpdated(res.data);
    return res.data;
  }

  refreshCartCount();
  return null;
}
