import { randomBytes, randomUUID } from 'node:crypto';
import { HTTP_HEADERS } from '@atelier/contracts';

export const CORRELATION_ID_HEADER = 'x-correlation-id' as const;
export const CORRELATION_ID_CANONICAL_HEADER = HTTP_HEADERS.CORRELATION_ID;
export const TRACEPARENT_HEADER = 'traceparent' as const;

export type HeaderBag = Record<string, string | string[] | undefined>;

export interface ParsedTraceparent {
  version: string;
  traceId: string;
  spanId: string;
  traceFlags: string;
  raw: string;
}

export interface CorrelationRequestLike {
  headers: HeaderBag;
  correlationId?: string;
  traceparent?: string;
  traceId?: string;
  spanId?: string;
}

export interface CorrelationResponseLike {
  setHeader(name: string, value: string): unknown;
}

export type NextFunctionLike = (err?: unknown) => void;

const MAX_CORRELATION_ID_LENGTH = 128;
const W3C_TRACEPARENT_REGEX = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i;
const ZERO_TRACE_ID = '0'.repeat(32);
const ZERO_SPAN_ID = '0'.repeat(16);

function randomNonZeroHex(byteLength: number): string {
  const zero = '0'.repeat(byteLength * 2);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const hex = randomBytes(byteLength).toString('hex');
    if (hex !== zero) {
      return hex;
    }
  }
  return `${'1'.padStart(byteLength * 2, '0')}`;
}

export function generateTraceId(): string {
  return randomNonZeroHex(16);
}

export function generateSpanId(): string {
  return randomNonZeroHex(8);
}

/**
 * Parses a W3C Trace Context `traceparent` header:
 * `00-<32-hex-trace-id>-<16-hex-span-id>-<2-hex-flags>`
 */
export function parseTraceparent(
  header: string | string[] | undefined | null,
): ParsedTraceparent | null {
  if (!header) {
    return null;
  }
  const candidate = Array.isArray(header) ? header[0] : header;
  if (typeof candidate !== 'string') {
    return null;
  }
  const trimmed = candidate.trim();
  const match = W3C_TRACEPARENT_REGEX.exec(trimmed);
  if (!match) {
    return null;
  }
  const version = match[1].toLowerCase();
  const traceId = match[2].toLowerCase();
  const spanId = match[3].toLowerCase();
  const traceFlags = match[4].toLowerCase();

  if (version === 'ff' || traceId === ZERO_TRACE_ID || spanId === ZERO_SPAN_ID) {
    return null;
  }

  return {
    version,
    traceId,
    spanId,
    traceFlags,
    raw: `${version}-${traceId}-${spanId}-${traceFlags}`,
  };
}

/**
 * Creates a child W3C `traceparent` preserving the parent's `traceId` and flags
 * with a newly minted 16-hex `spanId`, or creates a fresh root `traceparent` if absent/invalid.
 */
export function createChildTraceparent(
  parent?: string | ParsedTraceparent | null,
): string {
  const parsed =
    typeof parent === 'string' || parent === null || parent === undefined
      ? parseTraceparent(parent)
      : parent;

  if (parsed && parsed.traceId !== ZERO_TRACE_ID) {
    return `00-${parsed.traceId}-${generateSpanId()}-${parsed.traceFlags || '01'}`;
  }
  return `00-${generateTraceId()}-${generateSpanId()}-01`;
}

export function getOrCreateTraceparent(headers?: HeaderBag): string {
  if (headers) {
    const raw = headers[TRACEPARENT_HEADER] ?? headers.Traceparent;
    const parsed = parseTraceparent(raw);
    if (parsed) {
      return parsed.raw;
    }
  }
  return `00-${generateTraceId()}-${generateSpanId()}-01`;
}

export function getOrCreateCorrelationId(headers?: HeaderBag): string {
  if (headers) {
    const raw = headers[CORRELATION_ID_HEADER] ?? headers[CORRELATION_ID_CANONICAL_HEADER];
    const candidate = Array.isArray(raw) ? raw[0] : raw;
    if (typeof candidate === 'string') {
      const trimmed = candidate.trim();
      if (trimmed.length > 0 && trimmed.length <= MAX_CORRELATION_ID_LENGTH) {
        return trimmed;
      }
    }
  }
  return randomUUID();
}

export function correlationIdMiddleware(
  req: CorrelationRequestLike,
  res: CorrelationResponseLike,
  next: NextFunctionLike,
): void {
  const correlationId = getOrCreateCorrelationId(req.headers);
  const traceparent = getOrCreateTraceparent(req.headers);
  const parsed = parseTraceparent(traceparent);

  req.correlationId = correlationId;
  req.traceparent = traceparent;
  if (parsed) {
    req.traceId = parsed.traceId;
    req.spanId = parsed.spanId;
  }

  req.headers[CORRELATION_ID_HEADER] = correlationId;
  req.headers[TRACEPARENT_HEADER] = traceparent;

  res.setHeader(CORRELATION_ID_CANONICAL_HEADER, correlationId);
  res.setHeader(TRACEPARENT_HEADER, traceparent);
  next();
}
