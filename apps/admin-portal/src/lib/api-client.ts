import {
  HTTP_HEADERS,
  type ApiError,
  type ApiResponse,
  type RefreshResponse,
  type UserSummaryDto,
} from '@atelier/contracts';

export interface AdminStoredSession {
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

const STORAGE_KEY = 'atelier_admin_session_v1';
const REFRESH_ENDPOINT = '/api/v1/auth/refresh';

let memorySession: AdminStoredSession | null = null;
let activeRefreshPromise: Promise<string | null> | null = null;

export function getBffBaseUrl(): string {
  const configured = process.env.NEXT_PUBLIC_BFF_URL?.trim().replace(/\/+$/, '');
  if (typeof window !== 'undefined') {
    const host = window.location.hostname;
    const isLocalBrowser = host === 'localhost' || host === '127.0.0.1';
    if (!configured) {
      return isLocalBrowser ? `http://${host}:4000` : 'http://localhost:4000';
    }
    if (isLocalBrowser) {
      try {
        const parsed = new URL(configured);
        if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') {
          parsed.hostname = host;
          return parsed.toString().replace(/\/+$/, '');
        }
      } catch {
        // Keep configured URL as-is
      }
    }
    return configured;
  }
  return configured || 'http://localhost:4000';
}

function generateCorrelationId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `adm-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
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

export function getAdminSession(): AdminStoredSession | null {
  if (memorySession) return memorySession;
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AdminStoredSession;
    if (parsed && typeof parsed.accessToken === 'string' && parsed.user) {
      memorySession = parsed;
      return memorySession;
    }
  } catch {
    return null;
  }
  return null;
}

export function setAdminSession(session: AdminStoredSession | null): void {
  memorySession = session;
  if (typeof window !== 'undefined') {
    try {
      if (session) {
        window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(session));
      } else {
        window.sessionStorage.removeItem(STORAGE_KEY);
      }
    } catch {
      // Ignore storage errors
    }
  }
}

export function clearAdminSession(): void {
  setAdminSession(null);
}

function getEffectiveCsrfToken(): string | null {
  const cookieToken = readCookie('atelier_csrf_token');
  if (cookieToken) {
    return cookieToken;
  }
  const session = getAdminSession();
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
        clearAdminSession();
        return null;
      }

      const payload = (await response.json()) as ApiResponse<RefreshResponse>;
      if (!payload?.success || !payload.data?.accessToken) {
        clearAdminSession();
        return null;
      }

      const current = getAdminSession();
      if (!current) return null;

      const updated: AdminStoredSession = {
        ...current,
        accessToken: payload.data.accessToken,
        csrfToken: payload.data.csrfToken || current.csrfToken,
        user: payload.data.user ?? current.user,
        mfaVerified: payload.data.user?.mfaVerified ?? current.mfaVerified,
      };
      setAdminSession(updated);
      return updated.accessToken;
    } catch {
      return null;
    } finally {
      activeRefreshPromise = null;
    }
  })();

  return activeRefreshPromise;
}

export interface AdminFetchOptions extends Omit<RequestInit, 'headers'> {
  headers?: Record<string, string>;
  skipAuthRefresh?: boolean;
  timeoutMs?: number;
}

export async function adminFetch<T>(
  path: string,
  options: AdminFetchOptions = {},
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
    const session = getAdminSession();
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

export interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface PaginatedResult<T> {
  items: T[];
  pagination: PaginationMeta;
}

export function buildQueryString(
  params: Record<string, string | number | boolean | null | undefined>,
): string {
  const search = new URLSearchParams();
  for (const [key, raw] of Object.entries(params)) {
    if (raw === undefined || raw === null) continue;
    const str = typeof raw === 'string' ? raw.trim() : String(raw);
    if (str.length === 0) continue;
    search.set(key, str);
  }
  const qs = search.toString();
  return qs ? `?${qs}` : '';
}

const DEFAULT_LIST_KEYS = [
  'items',
  'list',
  'rows',
  'records',
  'logs',
  'data',
] as const;

export function extractList<T>(
  data: unknown,
  fallbackKeys: readonly string[] = DEFAULT_LIST_KEYS,
): T[] {
  if (Array.isArray(data)) return data as T[];
  if (data && typeof data === 'object') {
    const rec = data as Record<string, unknown>;
    for (const key of [...fallbackKeys, ...DEFAULT_LIST_KEYS]) {
      if (Array.isArray(rec[key])) {
        return rec[key] as T[];
      }
    }
  }
  return [];
}

export function extractPaginatedList<T>(
  data: unknown,
  fallbackKeys: readonly string[] = DEFAULT_LIST_KEYS,
  defaultLimit = 20,
): PaginatedResult<T> {
  const items = extractList<T>(data, fallbackKeys);
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const rec = data as Record<string, unknown>;
    const rawPag =
      rec.pagination && typeof rec.pagination === 'object' && !Array.isArray(rec.pagination)
        ? (rec.pagination as Record<string, unknown>)
        : rec;

    const page = Math.max(1, Number(rawPag.page ?? 1) || 1);
    const limit = Math.max(1, Number(rawPag.limit ?? rawPag.pageSize ?? defaultLimit) || defaultLimit);
    const total = Math.max(
      items.length,
      Number(rawPag.total ?? rawPag.totalCount ?? items.length) || items.length,
    );
    const totalPages = Math.max(
      1,
      Number(rawPag.totalPages ?? Math.ceil(total / limit)) || 1,
    );
    return {
      items,
      pagination: { page, limit, total, totalPages },
    };
  }
  return {
    items,
    pagination: {
      page: 1,
      limit: defaultLimit,
      total: items.length,
      totalPages: Math.max(1, Math.ceil(items.length / defaultLimit)),
    },
  };
}

function escapeCsvCell(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return '';
  let str = String(value);
  if (typeof value === 'string' && /^[=@+\t\r]/.test(str)) {
    str = `'${str}`;
  }
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function downloadUtf8BomCsv(
  filename: string,
  headers: readonly string[],
  rows: ReadonlyArray<ReadonlyArray<string | number | boolean | null | undefined>>,
): void {
  const csvLines = [
    headers.map((h) => escapeCsvCell(h)).join(','),
    ...rows.map((row) => row.map((cell) => escapeCsvCell(cell)).join(',')),
  ];
  const bomCsv = `\uFEFF${csvLines.join('\r\n')}`;
  const blob = new Blob([bomCsv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
