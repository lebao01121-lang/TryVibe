import {
  HTTP_HEADERS,
  type ApiError,
  type ApiResponse,
  type RefreshResponse,
  type UserSummaryDto,
} from '@atelier/contracts';

export interface PartnerStoredSession {
  accessToken: string;
  csrfToken: string;
  mfaRequired: boolean;
  mfaVerified: boolean;
  user: UserSummaryDto;
}

export interface ApiFetchResult<T> {
  ok: boolean;
  status: number;
  data: T | null;
  error: ApiError | null;
  headers: Headers | null;
}

const STORAGE_KEY = 'atelier_partner_session_v1';
const REFRESH_ENDPOINT = '/api/v1/auth/refresh';

let memorySession: PartnerStoredSession | null = null;
let activeRefreshPromise: Promise<string | null> | null = null;

export function getBffBaseUrl(): string {
  return (
    process.env.NEXT_PUBLIC_BFF_URL?.replace(/\/$/, '') ||
    'http://localhost:4000'
  );
}

function generateCorrelationId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `ptr-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function randomHex(byteLength: number): string {
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const bytes = new Uint8Array(byteLength);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }
  let out = '';
  for (let i = 0; i < byteLength; i += 1) {
    out += Math.floor(Math.random() * 256)
      .toString(16)
      .padStart(2, '0');
  }
  return out;
}

export function generateW3cTraceparent(): string {
  return `00-${randomHex(16)}-${randomHex(8)}-01`;
}

function readCookie(name: string): string | null {
  if (typeof document === 'undefined') return null;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = document.cookie.match(new RegExp(`(?:^|;\\s*)${escaped}=([^;]*)`));
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

export function getPartnerSession(): PartnerStoredSession | null {
  if (memorySession) return memorySession;
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PartnerStoredSession;
    if (parsed && typeof parsed.accessToken === 'string' && parsed.user) {
      memorySession = parsed;
      return memorySession;
    }
  } catch {
    return null;
  }
  return null;
}

export function setPartnerSession(session: PartnerStoredSession | null): void {
  memorySession = session;
  if (typeof window !== 'undefined') {
    try {
      if (session) {
        window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(session));
      } else {
        window.sessionStorage.removeItem(STORAGE_KEY);
      }
    } catch {
      // Ignore storage quota issues
    }
  }
}

export function clearPartnerSession(): void {
  setPartnerSession(null);
}

function getEffectiveCsrfToken(): string | null {
  const cookieToken = readCookie('atelier_csrf_token');
  if (cookieToken) {
    return cookieToken;
  }
  const session = getPartnerSession();
  return session?.csrfToken || null;
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
        traceparent: generateW3cTraceparent(),
      });
      if (csrfToken) {
        headers.set(HTTP_HEADERS.CSRF_TOKEN, csrfToken);
      }

      const response = await fetch(`${getBffBaseUrl()}${REFRESH_ENDPOINT}`, {
        method: 'POST',
        credentials: 'include',
        headers,
      });

      if (!response.ok) {
        clearPartnerSession();
        return null;
      }

      const payload = (await response.json()) as ApiResponse<RefreshResponse>;
      if (!payload?.success || !payload.data?.accessToken) {
        clearPartnerSession();
        return null;
      }

      const current = getPartnerSession();
      if (!current) return null;

      const updated: PartnerStoredSession = {
        ...current,
        accessToken: payload.data.accessToken,
        csrfToken: payload.data.csrfToken || current.csrfToken,
        user: payload.data.user ?? current.user,
        mfaVerified: payload.data.user?.mfaVerified ?? current.mfaVerified,
      };
      setPartnerSession(updated);
      return updated.accessToken;
    } catch {
      return null;
    } finally {
      activeRefreshPromise = null;
    }
  })();

  return activeRefreshPromise;
}

export interface PartnerFetchOptions extends Omit<RequestInit, 'headers'> {
  headers?: Record<string, string>;
  skipAuthRefresh?: boolean;
  timeoutMs?: number;
}

export async function partnerFetch<T>(
  path: string,
  options: PartnerFetchOptions = {},
): Promise<ApiFetchResult<T>> {
  const {
    headers: customHeaders,
    skipAuthRefresh = false,
    timeoutMs = 12000,
    ...rest
  } = options;

  const url = path.startsWith('http')
    ? path
    : `${getBffBaseUrl()}${path.startsWith('/') ? path : `/${path}`}`;

  const execute = async (overrideToken?: string): Promise<Response> => {
    const session = getPartnerSession();
    const token = overrideToken ?? session?.accessToken;
    const csrfToken = getEffectiveCsrfToken();

    const reqHeaders = new Headers({
      Accept: 'application/json',
      [HTTP_HEADERS.CORRELATION_ID]: generateCorrelationId(),
      traceparent: generateW3cTraceparent(),
    });

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
      Object.entries(customHeaders).forEach(([k, v]) => reqHeaders.set(k, v));
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
      path.includes('/auth/login') || path.includes('/auth/refresh');

    if (response.status === 401 && !skipAuthRefresh && !isAuthEndpoint) {
      const refreshed = await performSilentRefresh();
      if (refreshed) {
        response = await execute(refreshed);
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

    const extracted =
      json && 'data' in json ? json.data : ((json as unknown as T) ?? null);

    return {
      ok: true,
      status: response.status,
      data: extracted,
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
            ? `Không thể kết nối BFF: ${err.message}`
            : 'Không thể kết nối BFF.',
      },
      headers: null,
    };
  }
}
