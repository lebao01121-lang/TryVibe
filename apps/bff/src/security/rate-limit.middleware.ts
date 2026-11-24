import { Inject, Injectable, type NestMiddleware } from '@nestjs/common';
import { createApiErrorResponse, ErrorCode } from '@atelier/contracts';
import { getOrCreateCorrelationId, type HeaderBag } from '@atelier/observability';
import type { NextFunction, Request, Response } from 'express';
import { BffRedisService } from '../common/redis.service';
import { BFF_CONFIG_TOKEN, type BffConfig } from '../config/env';

interface RateLimitRule {
  bucket: string;
  limit: number;
  windowSeconds: number;
  matches: (method: string, pathname: string) => boolean;
}

const RATE_LIMIT_RULES: readonly RateLimitRule[] = [
  {
    bucket: 'auth_login',
    limit: 30,
    windowSeconds: 60,
    matches: (method, pathname) =>
      method === 'POST' &&
      (pathname === '/api/v1/auth/login' ||
        pathname === '/bff/v1/auth/login' ||
        pathname === '/bff/v1/storefront/auth/login'),
  },
  {
    bucket: 'auth_2fa',
    limit: 20,
    windowSeconds: 60,
    matches: (method, pathname) =>
      method === 'POST' &&
      (pathname.startsWith('/api/v1/auth/2fa/') ||
        pathname.startsWith('/bff/v1/auth/2fa/') ||
        pathname.startsWith('/bff/v1/storefront/auth/2fa/')),
  },
  {
    bucket: 'tryon_sessions',
    limit: 30,
    windowSeconds: 60,
    matches: (method, pathname) =>
      method === 'POST' && pathname === '/bff/v1/storefront/tryon/sessions',
  },
  {
    bucket: 'promo_evaluate',
    limit: 60,
    windowSeconds: 60,
    matches: (method, pathname) =>
      method === 'POST' && pathname === '/bff/v1/storefront/promotions/evaluate',
  },
  {
    bucket: 'checkout_orders',
    limit: 120,
    windowSeconds: 60,
    matches: (method, pathname) =>
      method === 'POST' && pathname === '/bff/v1/storefront/orders',
  },
];

@Injectable()
export class TieredRateLimitMiddleware implements NestMiddleware {
  private readonly memoryWindows = new Map<string, number[]>();

  constructor(
    @Inject(BFF_CONFIG_TOKEN) private readonly config: BffConfig,
    @Inject(BffRedisService) private readonly redis: BffRedisService,
  ) {}

  async use(req: Request, res: Response, next: NextFunction): Promise<void> {
    const method = req.method.toUpperCase();
    const pathname = (req.originalUrl || req.url || '').split('?')[0] ?? '';

    const rule = RATE_LIMIT_RULES.find((item) => item.matches(method, pathname));
    if (!rule) {
      next();
      return;
    }

    // Allow explicit dev/load-test bypass ONLY outside production
    const bypassHeader = req.headers['x-load-test-bypass'];
    if (this.config.nodeEnv !== 'production' && bypassHeader === '1') {
      res.setHeader('X-RateLimit-Limit', String(rule.limit));
      res.setHeader('X-RateLimit-Remaining', String(rule.limit));
      next();
      return;
    }

    const clientIp = this.extractClientIp(req);
    const { count, retryAfterSeconds } = await this.incrementWindow(
      rule.bucket,
      clientIp,
      rule.windowSeconds,
    );

    const remaining = Math.max(0, rule.limit - count);
    res.setHeader('X-RateLimit-Limit', String(rule.limit));
    res.setHeader('X-RateLimit-Remaining', String(remaining));

    if (count > rule.limit) {
      const retryAfter = Math.max(1, retryAfterSeconds);
      res.setHeader('Retry-After', String(retryAfter));
      const correlationId = getOrCreateCorrelationId(req.headers as HeaderBag);
      res.status(429).json(
        createApiErrorResponse(
          ErrorCode.RATE_LIMITED,
          `Rate limit exceeded for ${rule.bucket} (${rule.limit} requests per ${rule.windowSeconds}s). Retry after ${retryAfter}s.`,
          {
            bucket: rule.bucket,
            limit: rule.limit,
            windowSeconds: rule.windowSeconds,
            retryAfterSeconds: retryAfter,
          },
          {
            correlationId,
            service: this.config.serviceName,
          },
        ),
      );
      return;
    }

    next();
  }

  private async incrementWindow(
    bucket: string,
    clientIp: string,
    windowSeconds: number,
  ): Promise<{ count: number; retryAfterSeconds: number }> {
    const nowMs = Date.now();
    const windowMs = windowSeconds * 1000;
    const currentSlot = Math.floor(nowMs / windowMs);
    const prevSlot = currentSlot - 1;
    const elapsedRatio = (nowMs % windowMs) / windowMs;
    const prevWeight = 1 - elapsedRatio;

    const currentKey = `rl:bff:${bucket}:${clientIp}:${currentSlot}`;
    const prevKey = `rl:bff:${bucket}:${clientIp}:${prevSlot}`;

    // Redis-backed sliding-window approximation with automatic in-memory fallback
    const currentRes = await this.redis.incrWithTtlSafe(currentKey, windowSeconds * 2);
    if (currentRes !== null) {
      const prevRaw = await this.redis.getSafe(prevKey);
      const prevCount = prevRaw ? Number.parseInt(prevRaw, 10) || 0 : 0;
      const weightedCount = Math.ceil(prevCount * prevWeight) + currentRes.count;
      const retryAfterSeconds = Math.max(1, Math.ceil((windowMs - (nowMs % windowMs)) / 1000));
      return { count: weightedCount, retryAfterSeconds };
    }

    // In-memory exact sliding window fallback
    const memKey = `${bucket}:${clientIp}`;
    const cutoff = nowMs - windowMs;
    const existing = this.memoryWindows.get(memKey) ?? [];
    const active = existing.filter((ts) => ts > cutoff);
    active.push(nowMs);
    this.memoryWindows.set(memKey, active);

    if (this.memoryWindows.size > 1000) {
      for (const [k, timestamps] of this.memoryWindows.entries()) {
        if (timestamps.length === 0 || timestamps[timestamps.length - 1] <= cutoff) {
          this.memoryWindows.delete(k);
        }
      }
    }

    const oldest = active[0] ?? nowMs;
    const retryAfterSeconds = Math.max(1, Math.ceil((oldest + windowMs - nowMs) / 1000));
    return { count: active.length, retryAfterSeconds };
  }

  private extractClientIp(req: Request): string {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.trim().length > 0) {
      return forwarded.split(',')[0]?.trim() || req.ip || '127.0.0.1';
    }
    return req.ip || req.socket?.remoteAddress || '127.0.0.1';
  }
}
