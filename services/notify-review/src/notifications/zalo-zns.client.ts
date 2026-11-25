import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { createRedisClient, type AtelierRedisClient } from '@atelier/db-client';
import { createLogger } from '@atelier/observability';
import {
  NOTIFY_CONFIG_TOKEN,
  SERVICE_NAME,
  type NotifyReviewConfig,
} from '../config/env';

export const ZALO_ACCESS_TOKEN_REDIS_KEY = 'zalo:oa:access_token';
export const ZALO_REFRESH_TOKEN_REDIS_KEY = 'zalo:oa:refresh_token';
export const ZALO_ACCESS_TOKEN_DEFAULT_TTL_SEC = 82_800; // ~23h (Zalo OA token valid 25h)
export const ZALO_REFRESH_TOKEN_TTL_SEC = 7_776_000; // 90 days
export const ZALO_ZNS_RETRY_BACKOFF_MS = [400, 1200, 2400] as const;
export const ZALO_ZNS_MAX_ATTEMPTS = 3;

export type ZaloZnsDeliveryMode = 'LIVE' | 'LOCAL_SANDBOX_DRYRUN';
export type ZaloZnsDeliveryStatus = 'SENT' | 'FAILED' | 'LOCAL_SANDBOX';

export interface SendZaloZnsInput {
  phone: string;
  templateCode: string;
  templateData: Record<string, string | number | boolean | null | undefined>;
  trackingId: string;
  simulateZnsFailure?: boolean;
}

export interface ZaloZnsSendResult {
  ok: boolean;
  status: ZaloZnsDeliveryStatus;
  deliveryMode: ZaloZnsDeliveryMode;
  normalizedPhone: string | null;
  templateId: string;
  providerMessageId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  retryCount: number;
  shouldDeadLetter: boolean;
  formattedPayload: Record<string, unknown>;
}

interface MemoryCacheEntry {
  value: string;
  expiresAtMs: number;
}

/**
 * Normalizes Vietnamese phone numbers to Zalo ZNS E.164-without-plus format (`84xxxxxxxxx`).
 * Examples: `0901234567` -> `84901234567`, `+84 901 234 567` -> `84901234567`.
 */
export function normalizeVietnamZnsPhone(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.includes('@')) {
    return null;
  }
  const digits = trimmed.replace(/[^\d+]/g, '');
  if (!digits) {
    return null;
  }

  let normalized = digits.startsWith('+') ? digits.slice(1) : digits;
  if (normalized.startsWith('0')) {
    normalized = `84${normalized.slice(1)}`;
  } else if (!normalized.startsWith('84') && normalized.length >= 9 && normalized.length <= 10) {
    normalized = `84${normalized}`;
  }

  if (!/^84\d{8,10}$/.test(normalized)) {
    return null;
  }
  return normalized;
}

function sanitizeTemplateData(
  data: Record<string, string | number | boolean | null | undefined>,
): Record<string, string | number> {
  const clean: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(data)) {
    if (value === null || value === undefined) {
      continue;
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      clean[key] = value;
    } else if (typeof value === 'boolean') {
      clean[key] = value ? 'Có' : 'Không';
    } else {
      const str = String(value).trim();
      if (str.length > 0) {
        clean[key] = str.slice(0, 200);
      }
    }
  }
  return clean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

@Injectable()
export class ZaloZnsClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = createLogger(`${SERVICE_NAME}:zalo-zns`);
  private redis: AtelierRedisClient | null = null;
  private redisReachable = false;
  private readonly memoryCache = new Map<string, MemoryCacheEntry>();

  constructor(
    @Inject(NOTIFY_CONFIG_TOKEN) private readonly config: NotifyReviewConfig,
  ) {}

  async onModuleInit(): Promise<void> {
    this.redis = createRedisClient({
      url: this.config.redis.url,
      connectTimeoutMs: 1500,
      maxRetriesPerRequest: 1,
    });
    try {
      this.redisReachable = await this.redis.ping();
      if (this.redisReachable) {
        this.logger.info(
          { liveConfigured: this.isLiveConfigured() },
          'ZaloZnsClient connected to Redis for OA token caching',
        );
      } else {
        this.logger.warn(
          'Redis unavailable for ZaloZnsClient — using in-memory token cache fallback',
        );
      }
    } catch {
      this.redisReachable = false;
      this.logger.warn(
        'Redis probe failed for ZaloZnsClient — using in-memory token cache fallback',
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.redis) {
      const client = this.redis;
      this.redis = null;
      this.redisReachable = false;
      await client.quit().catch(() => undefined);
    }
  }

  public isLiveConfigured(): boolean {
    const z = this.config.zaloZns;
    const hasStaticAccessToken = Boolean(z.accessToken);
    const hasOauthRefresh = Boolean(
      z.appId && z.secretKey && (z.refreshToken || this.getFromMemory(ZALO_REFRESH_TOKEN_REDIS_KEY)),
    );
    return hasStaticAccessToken || hasOauthRefresh;
  }

  public getStatus(): {
    liveConfigured: boolean;
    deliveryMode: ZaloZnsDeliveryMode;
    redisConnected: boolean;
    apiUrl: string;
    oauthUrl: string;
    templates: NotifyReviewConfig['zaloZns']['templates'];
  } {
    const liveConfigured = this.isLiveConfigured();
    return {
      liveConfigured,
      deliveryMode: liveConfigured ? 'LIVE' : 'LOCAL_SANDBOX_DRYRUN',
      redisConnected: this.redisReachable && Boolean(this.redis?.isConnected()),
      apiUrl: this.config.zaloZns.apiUrl,
      oauthUrl: this.config.zaloZns.oauthUrl,
      templates: this.config.zaloZns.templates,
    };
  }

  public resolveTemplateId(templateCode: string): string {
    const normalized = templateCode.trim().toUpperCase();
    const templates = this.config.zaloZns.templates;
    switch (normalized) {
      case 'ORDER_CONFIRMED_VI':
      case 'ORDER_CONFIRMED':
        return templates.orderConfirmed;
      case 'ORDER_PACKED_PHOTO_VI':
      case 'ORDER_PACKED':
        return templates.orderPacked;
      case 'ORDER_SHIPPED_VI':
      case 'ORDER_SHIPPED':
        return templates.orderShipped;
      case 'RMA_REJECTED_VI':
      case 'RMA_UPDATED_VI':
      case 'RMA_UPDATE':
        return templates.rmaUpdate;
      case 'B2B_PO_SUBMITTED_VI':
      case 'PO_SUBMITTED':
        return templates.poSubmitted;
      default:
        return templateCode.trim() || templates.orderConfirmed;
    }
  }

  private getFromMemory(key: string): string | null {
    const entry = this.memoryCache.get(key);
    if (!entry) {
      return null;
    }
    if (Date.now() >= entry.expiresAtMs) {
      this.memoryCache.delete(key);
      return null;
    }
    return entry.value;
  }

  private setInMemory(key: string, value: string, ttlSeconds: number): void {
    this.memoryCache.set(key, {
      value,
      expiresAtMs: Date.now() + Math.max(1, ttlSeconds) * 1000,
    });
  }

  private async cacheGet(key: string): Promise<string | null> {
    if (this.redis) {
      try {
        const val = await this.redis.get(key);
        this.redisReachable = true;
        if (val && val.trim().length > 0) {
          return val.trim();
        }
      } catch {
        this.redisReachable = false;
      }
    }
    return this.getFromMemory(key);
  }

  private async cacheSet(key: string, value: string, ttlSeconds: number): Promise<void> {
    this.setInMemory(key, value, ttlSeconds);
    if (this.redis) {
      try {
        await this.redis.set(key, value, ttlSeconds);
        this.redisReachable = true;
      } catch {
        this.redisReachable = false;
      }
    }
  }

  /**
   * Resolves a valid Zalo OA access token in priority order:
   * 1. Redis cache (`zalo:oa:access_token`) / in-memory fallback
   * 2. Static env `ZALO_ZNS_ACCESS_TOKEN`
   * 3. Real OAuth2 refresh POST to `https://oauth.zaloapp.com/v4/oa/access_token`
   *    storing rotated `access_token` (TTL ~82800s) & `refresh_token` in Redis.
   */
  public async getAccessToken(forceRefresh: boolean = false): Promise<string | null> {
    if (!forceRefresh) {
      const cached = await this.cacheGet(ZALO_ACCESS_TOKEN_REDIS_KEY);
      if (cached) {
        return cached;
      }
      if (this.config.zaloZns.accessToken) {
        await this.cacheSet(
          ZALO_ACCESS_TOKEN_REDIS_KEY,
          this.config.zaloZns.accessToken,
          ZALO_ACCESS_TOKEN_DEFAULT_TTL_SEC,
        );
        return this.config.zaloZns.accessToken;
      }
    }

    const { appId, secretKey, oauthUrl, timeoutMs } = this.config.zaloZns;
    const storedRefreshToken =
      (await this.cacheGet(ZALO_REFRESH_TOKEN_REDIS_KEY)) || this.config.zaloZns.refreshToken;

    if (!appId || !secretKey || !storedRefreshToken) {
      return forceRefresh ? null : this.config.zaloZns.accessToken;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const formBody = new URLSearchParams({
        app_id: appId,
        refresh_token: storedRefreshToken,
        grant_type: 'refresh_token',
      });

      const response = await fetch(oauthUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          secret_key: secretKey,
        },
        body: formBody.toString(),
        signal: controller.signal,
      });

      const rawText = await response.text();
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(rawText) as Record<string, unknown>;
      } catch {
        parsed = {};
      }

      const newAccessToken =
        typeof parsed.access_token === 'string' && parsed.access_token.trim().length > 0
          ? parsed.access_token.trim()
          : null;

      if (!response.ok || !newAccessToken) {
        this.logger.warn(
          {
            status: response.status,
            error: parsed.error ?? parsed.error_name ?? 'oauth_refresh_failed',
            message: parsed.error_description ?? parsed.message ?? rawText.slice(0, 200),
          },
          'Zalo OA OAuth2 access_token refresh failed',
        );
        return null;
      }

      const expiresInRaw = Number(parsed.expires_in ?? 86_400);
      const accessTtl = Number.isFinite(expiresInRaw) && expiresInRaw > 3600
        ? Math.min(ZALO_ACCESS_TOKEN_DEFAULT_TTL_SEC, Math.floor(expiresInRaw - 3600))
        : ZALO_ACCESS_TOKEN_DEFAULT_TTL_SEC;

      await this.cacheSet(ZALO_ACCESS_TOKEN_REDIS_KEY, newAccessToken, accessTtl);

      const rotatedRefreshToken =
        typeof parsed.refresh_token === 'string' && parsed.refresh_token.trim().length > 0
          ? parsed.refresh_token.trim()
          : null;
      if (rotatedRefreshToken) {
        await this.cacheSet(
          ZALO_REFRESH_TOKEN_REDIS_KEY,
          rotatedRefreshToken,
          ZALO_REFRESH_TOKEN_TTL_SEC,
        );
      }

      this.logger.info(
        {
          accessTtl,
          refreshTokenRotated: Boolean(rotatedRefreshToken),
          redisCached: this.redisReachable,
        },
        'Rotated Zalo OA access_token via OAuth2 refresh_token grant',
      );
      return newAccessToken;
    } catch (error: unknown) {
      this.logger.warn(
        { err: error instanceof Error ? error.message : String(error) },
        'Network error refreshing Zalo OA access_token',
      );
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  public async sendTemplateMessage(input: SendZaloZnsInput): Promise<ZaloZnsSendResult> {
    const normalizedPhone = normalizeVietnamZnsPhone(input.phone);
    const templateId = this.resolveTemplateId(input.templateCode);
    const sanitizedData = sanitizeTemplateData(input.templateData);
    const formattedPayload: Record<string, unknown> = {
      phone: normalizedPhone ?? input.phone,
      template_id: templateId,
      template_data: sanitizedData,
      tracking_id: input.trackingId,
    };

    const liveMode = this.isLiveConfigured();

    // Explicit failure simulation hook for retry + DLQ verification (works in CI/Local too)
    if (input.simulateZnsFailure) {
      for (let attempt = 1; attempt <= ZALO_ZNS_MAX_ATTEMPTS; attempt += 1) {
        this.logger.warn(
          {
            trackingId: input.trackingId,
            templateId,
            attempt,
            maxAttempts: ZALO_ZNS_MAX_ATTEMPTS,
          },
          'Simulated Zalo ZNS upstream failure — executing exponential backoff retry',
        );
        if (attempt < ZALO_ZNS_MAX_ATTEMPTS) {
          const delayMs =
            ZALO_ZNS_RETRY_BACKOFF_MS[attempt - 1] ??
            ZALO_ZNS_RETRY_BACKOFF_MS[ZALO_ZNS_RETRY_BACKOFF_MS.length - 1];
          await sleep(delayMs);
        }
      }

      return {
        ok: false,
        status: 'FAILED',
        deliveryMode: liveMode ? 'LIVE' : 'LOCAL_SANDBOX_DRYRUN',
        normalizedPhone,
        templateId,
        providerMessageId: null,
        errorCode: 'SIMULATED_ZNS_503',
        errorMessage: `Simulated Zalo ZNS upstream outage exhausted ${ZALO_ZNS_MAX_ATTEMPTS} retry attempts (${ZALO_ZNS_RETRY_BACKOFF_MS.join('ms -> ')}ms).`,
        retryCount: ZALO_ZNS_MAX_ATTEMPTS,
        shouldDeadLetter: true,
        formattedPayload,
      };
    }

    // Local Offline / CI mode: truthful LOCAL_SANDBOX_DRYRUN (never fake live API SENT!)
    if (!liveMode) {
      return {
        ok: true,
        status: 'LOCAL_SANDBOX',
        deliveryMode: 'LOCAL_SANDBOX_DRYRUN',
        normalizedPhone,
        templateId,
        providerMessageId: null,
        errorCode: null,
        errorMessage:
          'Zalo OA credentials not configured — dry-run ZNS template payload persisted locally.',
        retryCount: 0,
        shouldDeadLetter: false,
        formattedPayload,
      };
    }

    if (!normalizedPhone) {
      return {
        ok: false,
        status: 'FAILED',
        deliveryMode: 'LIVE',
        normalizedPhone: null,
        templateId,
        providerMessageId: null,
        errorCode: 'INVALID_VN_PHONE',
        errorMessage: `Số điện thoại "${input.phone}" không đúng định dạng Việt Nam cho Zalo ZNS (84xxxxxxxxx).`,
        retryCount: 0,
        shouldDeadLetter: true,
        formattedPayload,
      };
    }

    let accessToken = await this.getAccessToken(false);
    if (!accessToken) {
      return {
        ok: false,
        status: 'FAILED',
        deliveryMode: 'LIVE',
        normalizedPhone,
        templateId,
        providerMessageId: null,
        errorCode: 'ZALO_TOKEN_UNAVAILABLE',
        errorMessage: 'Không lấy được Zalo OA access_token từ Redis hoặc OAuth2 refresh.',
        retryCount: 1,
        shouldDeadLetter: true,
        formattedPayload,
      };
    }

    let tokenRefreshed = false;
    let lastErrorCode = 'ZALO_ZNS_ERROR';
    let lastErrorMessage = 'Zalo ZNS dispatch failed';

    for (let attempt = 1; attempt <= ZALO_ZNS_MAX_ATTEMPTS; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.config.zaloZns.timeoutMs);

      try {
        const response = await fetch(this.config.zaloZns.apiUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            access_token: accessToken,
          },
          body: JSON.stringify(formattedPayload),
          signal: controller.signal,
        });

        const rawText = await response.text();
        let json: Record<string, unknown> | null = null;
        try {
          const parsed = JSON.parse(rawText) as unknown;
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            json = parsed as Record<string, unknown>;
          }
        } catch {
          json = null;
        }

        const zaloErrorNum =
          json && json.error !== undefined ? Number(json.error) : response.ok ? 0 : response.status;

        // Token expired (-124 or HTTP 401) -> refresh once via OAuth2 & retry immediately
        if ((response.status === 401 || zaloErrorNum === -124) && !tokenRefreshed) {
          tokenRefreshed = true;
          this.logger.warn(
            { trackingId: input.trackingId, status: response.status, zaloError: zaloErrorNum },
            'Zalo OA access_token expired (-124/401) — refreshing via OAuth2 and retrying once',
          );
          const refreshed = await this.getAccessToken(true);
          if (refreshed) {
            accessToken = refreshed;
            attempt -= 1; // Do not consume a transient backoff attempt for one-time token refresh
            continue;
          }
          lastErrorCode = String(zaloErrorNum);
          lastErrorMessage = 'Zalo OA access_token expired and OAuth2 refresh failed.';
          break;
        }

        if (response.ok && zaloErrorNum === 0) {
          const dataObj = (json?.data as Record<string, unknown> | undefined) ?? {};
          const msgId = String(dataObj.msg_id ?? json?.msg_id ?? '').trim() || null;
          this.logger.info(
            {
              trackingId: input.trackingId,
              templateId,
              providerMessageId: msgId,
              attempts: attempt,
            },
            'Dispatched live Zalo ZNS template message',
          );
          return {
            ok: true,
            status: 'SENT',
            deliveryMode: 'LIVE',
            normalizedPhone,
            templateId,
            providerMessageId: msgId,
            errorCode: null,
            errorMessage: null,
            retryCount: attempt - 1,
            shouldDeadLetter: false,
            formattedPayload,
          };
        }

        lastErrorCode = String(zaloErrorNum || response.status);
        lastErrorMessage = String(
          json?.message ?? json?.error_description ?? rawText.slice(0, 240) ?? `HTTP ${response.status}`,
        );

        const isRetryable = response.status >= 500 || response.status === 429;
        if (!isRetryable) {
          this.logger.warn(
            {
              trackingId: input.trackingId,
              templateId,
              status: response.status,
              errorCode: lastErrorCode,
              errorMessage: lastErrorMessage,
            },
            'Zalo ZNS returned non-retryable client/API error; routing to DLQ',
          );
          return {
            ok: false,
            status: 'FAILED',
            deliveryMode: 'LIVE',
            normalizedPhone,
            templateId,
            providerMessageId: null,
            errorCode: lastErrorCode,
            errorMessage: lastErrorMessage,
            retryCount: attempt,
            shouldDeadLetter: true,
            formattedPayload,
          };
        }

        this.logger.warn(
          {
            trackingId: input.trackingId,
            templateId,
            attempt,
            status: response.status,
            errorCode: lastErrorCode,
          },
          'Zalo ZNS HTTP 5xx/429 error — retrying with exponential backoff',
        );
      } catch (error: unknown) {
        lastErrorCode = 'NETWORK_ERROR';
        lastErrorMessage = error instanceof Error ? error.message : String(error);
        this.logger.warn(
          {
            trackingId: input.trackingId,
            templateId,
            attempt,
            err: lastErrorMessage,
          },
          'Zalo ZNS network/timeout error — retrying with exponential backoff',
        );
      } finally {
        clearTimeout(timer);
      }

      if (attempt < ZALO_ZNS_MAX_ATTEMPTS) {
        const delayMs =
          ZALO_ZNS_RETRY_BACKOFF_MS[attempt - 1] ??
          ZALO_ZNS_RETRY_BACKOFF_MS[ZALO_ZNS_RETRY_BACKOFF_MS.length - 1];
        await sleep(delayMs);
      }
    }

    return {
      ok: false,
      status: 'FAILED',
      deliveryMode: 'LIVE',
      normalizedPhone,
      templateId,
      providerMessageId: null,
      errorCode: lastErrorCode,
      errorMessage: lastErrorMessage,
      retryCount: ZALO_ZNS_MAX_ATTEMPTS,
      shouldDeadLetter: true,
      formattedPayload,
    };
  }
}
