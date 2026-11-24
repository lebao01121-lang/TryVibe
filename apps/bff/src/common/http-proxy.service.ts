import { Inject, Injectable } from '@nestjs/common';
import { createApiErrorResponse, ErrorCode, HTTP_HEADERS } from '@atelier/contracts';
import {
  createChildTraceparent,
  createLogger,
  getOrCreateCorrelationId,
  getOrCreateTraceparent,
  TRACEPARENT_HEADER,
  type HeaderBag,
  type Logger,
} from '@atelier/observability';
import type { Request, Response } from 'express';
import { BFF_CONFIG_TOKEN, BFF_SERVICE_NAME, type BffConfig } from '../config/env';

export interface ProxyRequestOptions {
  method: string;
  url: string;
  req?: Request;
  body?: unknown;
  rawBody?: Buffer;
  contentType?: string;
  extraHeaders?: Record<string, string | undefined>;
  timeoutMs?: number;
  correlationId?: string;
}

export interface ProxyResponseResult<T = unknown> {
  status: number;
  ok: boolean;
  body: T;
  rawText: string;
  contentType: string;
  setCookies: string[];
}

const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

export async function collectRawRequestBody(
  req: Request,
  maxBytes: number = MAX_UPLOAD_BYTES,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;

  return new Promise<Buffer>((resolve, reject) => {
    req.on('data', (chunk: Buffer | string) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.length;
      if (total > maxBytes) {
        req.pause();
        reject(new Error(`Request payload exceeds maximum limit of ${maxBytes} bytes.`));
        return;
      }
      chunks.push(buf);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

@Injectable()
export class HttpProxyService {
  private readonly logger: Logger = createLogger(BFF_SERVICE_NAME);

  constructor(@Inject(BFF_CONFIG_TOKEN) private readonly config: BffConfig) {}

  async request<T = unknown>(options: ProxyRequestOptions): Promise<ProxyResponseResult<T>> {
    const reqHeaders = (options.req?.headers ?? {}) as HeaderBag;
    const correlationId =
      options.correlationId ?? getOrCreateCorrelationId(reqHeaders);
    const parentTraceparent = getOrCreateTraceparent(reqHeaders);
    const childTraceparent = createChildTraceparent(parentTraceparent);

    const headers = new Headers();
    headers.set(HTTP_HEADERS.CORRELATION_ID, correlationId);
    headers.set(TRACEPARENT_HEADER, childTraceparent);

    if (options.req) {
      this.copyHeaderIfPresent(reqHeaders, headers, 'authorization', HTTP_HEADERS.AUTHORIZATION);
      this.copyHeaderIfPresent(reqHeaders, headers, 'cookie', 'Cookie');
      this.copyHeaderIfPresent(reqHeaders, headers, 'x-csrf-token', HTTP_HEADERS.CSRF_TOKEN);
      this.copyHeaderIfPresent(reqHeaders, headers, 'origin', 'Origin');
      this.copyHeaderIfPresent(reqHeaders, headers, 'referer', 'Referer');
      this.copyHeaderIfPresent(reqHeaders, headers, 'user-agent', 'User-Agent');
      this.copyHeaderIfPresent(
        reqHeaders,
        headers,
        'idempotency-key',
        HTTP_HEADERS.IDEMPOTENCY_KEY,
      );
      this.copyHeaderIfPresent(
        reqHeaders,
        headers,
        'x-guest-session-id',
        HTTP_HEADERS.GUEST_SESSION_ID,
      );

      const clientIp = this.extractClientIp(options.req);
      if (clientIp) {
        headers.set('X-Forwarded-For', clientIp);
      }
    }

    // Strict IDOR scrubbing: never allow client-supplied privileged headers to pass through
    headers.delete('x-user-id');
    headers.delete('x-actor-roles');
    headers.delete('x-supplier-id');
    headers.delete('x-internal-secret');
    headers.delete('x-user-email');
    headers.delete('x-user-name');
    headers.delete('x-loyalty-tier');

    if (options.extraHeaders) {
      for (const [key, value] of Object.entries(options.extraHeaders)) {
        if (value !== undefined) {
          headers.set(key, value);
        }
      }
    }

    const method = options.method.toUpperCase();
    let fetchBody: NonNullable<Parameters<typeof fetch>[1]>['body'];

    if (options.rawBody !== undefined) {
      fetchBody = new Uint8Array(options.rawBody);
      if (options.contentType) {
        headers.set('Content-Type', options.contentType);
      }
    } else if (
      options.body !== undefined &&
      method !== 'GET' &&
      method !== 'HEAD'
    ) {
      headers.set('Content-Type', options.contentType ?? 'application/json');
      fetchBody =
        typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
    }

    const controller = new AbortController();
    const timeoutMs = options.timeoutMs ?? 15_000;
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(options.url, {
        method,
        headers,
        body: fetchBody,
        signal: controller.signal,
      });

      const contentType = response.headers.get('content-type') ?? 'application/json';
      const setCookies = this.extractSetCookies(response.headers);
      const rawText = await response.text();

      let parsedBody: unknown = null;
      if (rawText.length > 0) {
        try {
          parsedBody = JSON.parse(rawText);
        } catch {
          parsedBody = rawText;
        }
      }

      return {
        status: response.status,
        ok: response.ok,
        body: parsedBody as T,
        rawText,
        contentType,
        setCookies,
      };
    } catch (error) {
      const isTimeout = error instanceof Error && error.name === 'AbortError';
      this.logger.warn(
        {
          url: options.url,
          method,
          correlationId,
          timeout: isTimeout,
          err: error instanceof Error ? error.message : String(error),
        },
        'Downstream proxy request failed',
      );

      const errPayload = createApiErrorResponse(
        ErrorCode.DEPENDENCY_UNAVAILABLE,
        isTimeout
          ? `Downstream service timed out (${method} ${options.url}).`
          : `Downstream service unavailable (${method} ${options.url}).`,
        undefined,
        { correlationId, service: this.config.serviceName },
      );

      return {
        status: 503,
        ok: false,
        body: errPayload as T,
        rawText: JSON.stringify(errPayload),
        contentType: 'application/json',
        setCookies: [],
      };
    } finally {
      clearTimeout(timer);
    }
  }

  sendProxyResponse(
    res: Response,
    upstream: ProxyResponseResult,
    transformBody?: (body: unknown) => unknown,
  ): void {
    if (upstream.setCookies.length > 0) {
      res.setHeader('Set-Cookie', upstream.setCookies);
    }

    const finalBody = transformBody ? transformBody(upstream.body) : upstream.body;

    if (finalBody === null || finalBody === undefined) {
      res.status(upstream.status).send();
      return;
    }

    if (typeof finalBody === 'string') {
      res.status(upstream.status).type(upstream.contentType).send(finalBody);
      return;
    }

    res.status(upstream.status).json(finalBody);
  }

  extractClientIp(req: Request): string {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.trim().length > 0) {
      return forwarded.split(',')[0]?.trim() || req.ip || '127.0.0.1';
    }
    return req.ip || req.socket?.remoteAddress || '127.0.0.1';
  }

  private copyHeaderIfPresent(
    source: HeaderBag,
    target: Headers,
    lowerKey: string,
    canonicalKey: string,
  ): void {
    const raw = source[lowerKey];
    if (typeof raw === 'string' && raw.length > 0) {
      target.set(canonicalKey, raw);
    } else if (Array.isArray(raw) && raw.length > 0) {
      target.set(canonicalKey, raw.join('; '));
    }
  }

  private extractSetCookies(headers: Headers): string[] {
    const maybeHeaders = headers as Headers & { getSetCookie?: () => string[] };
    if (typeof maybeHeaders.getSetCookie === 'function') {
      return maybeHeaders.getSetCookie();
    }
    const single = headers.get('set-cookie');
    return single ? [single] : [];
  }
}
