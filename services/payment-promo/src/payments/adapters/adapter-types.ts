export type PaymentProviderMode = 'LIVE' | 'SANDBOX_LOCAL';

export interface ProviderRefundResult {
  ok: boolean;
  mode: PaymentProviderMode;
  providerRefundId: string | null;
  providerCode: string;
  message: string;
  rawResponse?: Record<string, unknown> | null;
}

export interface HttpJsonResult {
  ok: boolean;
  status: number;
  json: Record<string, unknown> | null;
  rawText: string;
}

export async function fetchJsonWithRetry(
  url: string,
  init: RequestInit,
  options: { timeoutMs?: number; maxRetries?: number } = {},
): Promise<HttpJsonResult> {
  const timeoutMs = options.timeoutMs ?? 8000;
  const maxRetries = options.maxRetries ?? 1;

  let lastError: unknown = null;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        ...init,
        signal: controller.signal,
      });
      const rawText = await response.text();
      let json: Record<string, unknown> | null = null;
      if (rawText.trim().length > 0) {
        try {
          const parsed = JSON.parse(rawText) as unknown;
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            json = parsed as Record<string, unknown>;
          }
        } catch {
          json = null;
        }
      }

      if (response.status >= 500 && attempt < maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, 350));
        continue;
      }

      return {
        ok: response.ok,
        status: response.status,
        json,
        rawText,
      };
    } catch (error: unknown) {
      lastError = error;
      if (attempt < maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, 350));
        continue;
      }
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`External payment provider request failed: ${String(lastError)}`);
}

export function normalizeClientIp(rawIp: string | null | undefined): string {
  if (!rawIp) {
    return '127.0.0.1';
  }
  const first = rawIp.split(',')[0]?.trim() ?? '';
  if (!first || first === '::1') {
    return '127.0.0.1';
  }
  if (first.startsWith('::ffff:')) {
    return first.slice('::ffff:'.length);
  }
  return first.slice(0, 45);
}

export function toSingleQueryValue(value: unknown): string {
  if (Array.isArray(value)) {
    return value[0] === undefined || value[0] === null ? '' : String(value[0]);
  }
  if (value === undefined || value === null) {
    return '';
  }
  return String(value);
}
