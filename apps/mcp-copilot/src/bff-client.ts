import type { JwtPassThroughContext } from '@atelier/ai-harness';
import { ErrorCode } from '@atelier/contracts';
import {
  TRACEPARENT_HEADER,
  createChildTraceparent,
  type Logger,
} from '@atelier/observability';

export interface BffRequestResult<T> {
  ok: boolean;
  status: number;
  data: T | null;
  rawBody: unknown;
  errorCode?: string;
  errorMessage?: string;
  errorDetails?: Record<string, unknown>;
  offlineFallback: boolean;
}

export class BffHttpError extends Error {
  public readonly status: number;
  public readonly code: ErrorCode;
  public readonly details?: Record<string, unknown>;

  constructor(
    status: number,
    code: ErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'BffHttpError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function unwrapApiEnvelope<T>(parsed: unknown): {
  data: T | null;
  errorCode?: string;
  errorMessage?: string;
  errorDetails?: Record<string, unknown>;
} {
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const record = parsed as Record<string, unknown>;
    if ('success' in record) {
      const errObj =
        record.error && typeof record.error === 'object' && !Array.isArray(record.error)
          ? (record.error as Record<string, unknown>)
          : null;
      return {
        data: (record.data as T | null) ?? null,
        errorCode: typeof errObj?.code === 'string' ? errObj.code : undefined,
        errorMessage: typeof errObj?.message === 'string' ? errObj.message : undefined,
        errorDetails:
          errObj?.details && typeof errObj.details === 'object'
            ? (errObj.details as Record<string, unknown>)
            : undefined,
      };
    }
    if (typeof record.message === 'string' && 'statusCode' in record) {
      return {
        data: null,
        errorCode: typeof record.code === 'string' ? record.code : undefined,
        errorMessage: record.message,
      };
    }
  }

  return { data: parsed as T };
}

export class BffPassThroughClient {
  constructor(
    private readonly bffUrl: string,
    private readonly jwtContext: JwtPassThroughContext,
    private readonly logger: Logger,
    private readonly timeoutMs = 8_000,
  ) {}

  private async requestJson<T>(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH',
    path: string,
    body?: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<BffRequestResult<T>> {
    const baseHeaders: Record<string, string> = {
      Accept: 'application/json',
      ...extraHeaders,
    };
    if (body !== undefined) {
      baseHeaders['Content-Type'] = 'application/json';
    }

    // Layer 5 strict JWT pass-through via AsyncLocalStorage (ZERO superuser tokens) + W3C traceparent
    const forwardHeaders = this.jwtContext.buildForwardHeaders(baseHeaders);
    if (!forwardHeaders[TRACEPARENT_HEADER]) {
      const ctx = this.jwtContext.get();
      forwardHeaders[TRACEPARENT_HEADER] = createChildTraceparent(ctx?.traceparent);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.bffUrl}${path}`, {
        method,
        headers: forwardHeaders,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      const rawText = await response.text();
      let parsed: unknown = null;
      if (rawText) {
        try {
          parsed = JSON.parse(rawText) as unknown;
        } catch {
          parsed = rawText;
        }
      }

      const unwrapped = unwrapApiEnvelope<T>(parsed);

      if (!response.ok) {
        return {
          ok: false,
          status: response.status,
          data: unwrapped.data,
          rawBody: parsed,
          errorCode:
            unwrapped.errorCode ??
            (response.status === 403
              ? ErrorCode.FORBIDDEN
              : response.status === 401
                ? ErrorCode.UNAUTHORIZED
                : ErrorCode.INTERNAL_ERROR),
          errorMessage:
            unwrapped.errorMessage ??
            `BFF returned HTTP ${response.status} for ${method} ${path}`,
          errorDetails: unwrapped.errorDetails,
          offlineFallback: false,
        };
      }

      return {
        ok: true,
        status: response.status,
        data: unwrapped.data,
        rawBody: parsed,
        offlineFallback: false,
      };
    } catch (error) {
      this.logger.warn(
        {
          method,
          path,
          bffUrl: this.bffUrl,
          err: error instanceof Error ? error.message : String(error),
        },
        'BFF upstream unreachable during MCP tool HTTP pass-through',
      );
      return {
        ok: false,
        status: 0,
        data: null,
        rawBody: null,
        errorCode: ErrorCode.DEPENDENCY_UNAVAILABLE,
        errorMessage: error instanceof Error ? error.message : String(error),
        offlineFallback: true,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  public async getJson<T>(
    path: string,
    extraHeaders?: Record<string, string>,
  ): Promise<BffRequestResult<T>> {
    return this.requestJson<T>('GET', path, undefined, extraHeaders);
  }

  public async postJson<T>(
    path: string,
    body: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<BffRequestResult<T>> {
    return this.requestJson<T>('POST', path, body, extraHeaders);
  }
}
