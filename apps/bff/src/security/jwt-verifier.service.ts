import * as crypto from 'node:crypto';
import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import {
  createApiErrorResponse,
  ErrorCode,
  JwtAccessPayloadSchema,
  type JwtAccessPayload,
} from '@atelier/contracts';
import {
  createLogger,
  getOrCreateCorrelationId,
  type HeaderBag,
  type Logger,
} from '@atelier/observability';
import { BffRedisService } from '../common/redis.service';
import { BFF_CONFIG_TOKEN, BFF_SERVICE_NAME, type BffConfig } from '../config/env';
import type { AuthenticatedRequest } from './auth-types';

interface JsonWebKeyEntry {
  kty: string;
  kid?: string;
  use?: string;
  alg?: string;
  n?: string;
  e?: string;
  [key: string]: unknown;
}

interface JwksDocument {
  keys?: JsonWebKeyEntry[];
}

interface JwtHeader {
  alg?: string;
  typ?: string;
  kid?: string;
}

const JWKS_CACHE_TTL_MS = 5 * 60 * 1000;

function decodeBase64Url(segment: string): Buffer {
  const base64 = segment.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
  return Buffer.from(padded, 'base64');
}

function parseJsonSegment<T>(segment: string): T | null {
  try {
    const decoded = decodeBase64Url(segment).toString('utf8');
    return JSON.parse(decoded) as T;
  } catch {
    return null;
  }
}

@Injectable()
export class JwtVerifierService {
  private readonly logger: Logger = createLogger(BFF_SERVICE_NAME);
  private readonly keyCache = new Map<string, crypto.KeyObject>();
  private defaultKey: crypto.KeyObject | null = null;
  private lastFetchedAtMs = 0;
  private inflightFetch: Promise<void> | null = null;

  constructor(
    @Inject(BFF_CONFIG_TOKEN) private readonly config: BffConfig,
    @Inject(BffRedisService) private readonly redis: BffRedisService,
  ) {}

  async verifyRequest(req: AuthenticatedRequest): Promise<JwtAccessPayload> {
    const correlationId = getOrCreateCorrelationId(req.headers as HeaderBag);
    const authHeader = req.headers.authorization;

    if (!authHeader || typeof authHeader !== 'string' || !authHeader.startsWith('Bearer ')) {
      throw this.buildAuthError(
        HttpStatus.UNAUTHORIZED,
        ErrorCode.UNAUTHORIZED,
        'Missing or malformed Authorization Bearer token.',
        correlationId,
      );
    }

    const token = authHeader.slice(7).trim();
    if (!token) {
      throw this.buildAuthError(
        HttpStatus.UNAUTHORIZED,
        ErrorCode.UNAUTHORIZED,
        'Empty Bearer token.',
        correlationId,
      );
    }

    const payload = await this.verifyAccessToken(token, correlationId);
    req.user = payload;
    return payload;
  }

  async verifyRequestOptional(req: AuthenticatedRequest): Promise<JwtAccessPayload | null> {
    const authHeader = req.headers.authorization;
    if (!authHeader || typeof authHeader !== 'string' || !authHeader.startsWith('Bearer ')) {
      return null;
    }
    const token = authHeader.slice(7).trim();
    if (!token) {
      return null;
    }
    try {
      const correlationId = getOrCreateCorrelationId(req.headers as HeaderBag);
      const payload = await this.verifyAccessToken(token, correlationId);
      req.user = payload;
      return payload;
    } catch {
      return null;
    }
  }

  async verifyAccessToken(token: string, correlationId?: string): Promise<JwtAccessPayload> {
    const segments = token.split('.');
    if (segments.length !== 3 || !segments[0] || !segments[1] || !segments[2]) {
      throw this.buildAuthError(
        HttpStatus.UNAUTHORIZED,
        ErrorCode.UNAUTHORIZED,
        'Malformed JWT token structure.',
        correlationId,
      );
    }

    const [headerB64, payloadB64, signatureB64] = segments;
    const header = parseJsonSegment<JwtHeader>(headerB64);
    if (!header || header.alg !== 'RS256') {
      throw this.buildAuthError(
        HttpStatus.UNAUTHORIZED,
        ErrorCode.UNAUTHORIZED,
        'Only RS256 signed access tokens are accepted.',
        correlationId,
      );
    }

    const publicKey = await this.resolvePublicKey(header.kid, correlationId);
    const signingInput = Buffer.from(`${headerB64}.${payloadB64}`, 'utf8');
    const signature = decodeBase64Url(signatureB64);

    let signatureValid = false;
    try {
      signatureValid = crypto.verify('RSA-SHA256', signingInput, publicKey, signature);
    } catch {
      signatureValid = false;
    }

    if (!signatureValid) {
      throw this.buildAuthError(
        HttpStatus.UNAUTHORIZED,
        ErrorCode.UNAUTHORIZED,
        'Invalid RS256 JWT signature.',
        correlationId,
      );
    }

    const rawPayload = parseJsonSegment<Record<string, unknown>>(payloadB64);
    if (!rawPayload) {
      throw this.buildAuthError(
        HttpStatus.UNAUTHORIZED,
        ErrorCode.UNAUTHORIZED,
        'Malformed JWT payload.',
        correlationId,
      );
    }

    const normalizedRaw: Record<string, unknown> = {
      ...rawPayload,
      supplierId:
        typeof rawPayload.supplierId === 'string' && rawPayload.supplierId.trim().length > 0
          ? rawPayload.supplierId.trim()
          : null,
      permissions: Array.isArray(rawPayload.permissions) ? rawPayload.permissions : [],
    };

    const parsed = JwtAccessPayloadSchema.safeParse(normalizedRaw);
    if (!parsed.success) {
      throw this.buildAuthError(
        HttpStatus.UNAUTHORIZED,
        ErrorCode.UNAUTHORIZED,
        'Access token claims failed schema validation.',
        correlationId,
      );
    }

    const payload = parsed.data;
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (nowSeconds >= payload.exp) {
      throw this.buildAuthError(
        HttpStatus.UNAUTHORIZED,
        ErrorCode.UNAUTHORIZED,
        'Access token has expired.',
        correlationId,
      );
    }

    // Immediate Redis revocation & permissionVersion check (< 1ms)
    const [lockedFlag, redisPermVerRaw, revokedJtiFlag] = await Promise.all([
      this.redis.getSafe(`user:locked:${payload.sub}`),
      this.redis.getSafe(`user:perm_ver:${payload.sub}`),
      this.redis.getSafe(`revoked_jti:${payload.jti}`),
    ]);

    if (lockedFlag === '1' || lockedFlag === 'true') {
      throw this.buildAuthError(
        HttpStatus.FORBIDDEN,
        ErrorCode.PERMISSION_REVOKED,
        'Account is locked. Access denied immediately.',
        correlationId,
      );
    }

    if (redisPermVerRaw !== null) {
      const redisPermVer = Number.parseInt(redisPermVerRaw, 10);
      if (Number.isFinite(redisPermVer) && redisPermVer > payload.permissionVersion) {
        throw this.buildAuthError(
          HttpStatus.FORBIDDEN,
          ErrorCode.PERMISSION_REVOKED,
          'Role or permission version has been revoked. Please re-authenticate.',
          correlationId,
        );
      }
    }

    if (revokedJtiFlag !== null) {
      throw this.buildAuthError(
        HttpStatus.UNAUTHORIZED,
        ErrorCode.UNAUTHORIZED,
        'Access token has been revoked.',
        correlationId,
      );
    }

    return payload;
  }

  private async resolvePublicKey(
    kid: string | undefined,
    correlationId?: string,
  ): Promise<crypto.KeyObject> {
    const cacheExpired = Date.now() - this.lastFetchedAtMs > JWKS_CACHE_TTL_MS;

    if (cacheExpired || (kid && !this.keyCache.has(kid)) || (!kid && !this.defaultKey)) {
      await this.refreshJwks(correlationId);
    }

    const key = kid ? this.keyCache.get(kid) : this.defaultKey;
    if (key) {
      return key;
    }

    // Force one fresh fetch in case key rotated while cache was warm
    await this.refreshJwks(correlationId);
    const refreshed = kid ? this.keyCache.get(kid) : this.defaultKey;
    if (!refreshed) {
      throw this.buildAuthError(
        HttpStatus.UNAUTHORIZED,
        ErrorCode.UNAUTHORIZED,
        `Signing key "${kid ?? 'default'}" not found in auth JWKS.`,
        correlationId,
      );
    }

    return refreshed;
  }

  private async refreshJwks(correlationId?: string): Promise<void> {
    if (this.inflightFetch) {
      await this.inflightFetch;
      return;
    }

    const jwksUrl = `${this.config.upstreams.authCustomerUrl}/.well-known/jwks.json`;

    this.inflightFetch = (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3000);
      try {
        const res = await fetch(jwksUrl, {
          method: 'GET',
          headers: correlationId ? { 'X-Correlation-Id': correlationId } : undefined,
          signal: controller.signal,
        });
        if (!res.ok) {
          throw new Error(`JWKS endpoint returned HTTP ${res.status}`);
        }
        const doc = (await res.json()) as JwksDocument;
        const keys = Array.isArray(doc.keys) ? doc.keys : [];

        this.keyCache.clear();
        this.defaultKey = null;

        for (const jwk of keys) {
          if (jwk.kty !== 'RSA' || !jwk.n || !jwk.e) {
            continue;
          }
          const keyObject = crypto.createPublicKey({
            key: jwk as crypto.JsonWebKey,
            format: 'jwk',
          });
          if (!this.defaultKey) {
            this.defaultKey = keyObject;
          }
          if (jwk.kid) {
            this.keyCache.set(jwk.kid, keyObject);
          }
        }

        this.lastFetchedAtMs = Date.now();
        this.logger.info({ keyCount: this.keyCache.size }, 'Refreshed RS256 JWKS public keys');
      } catch (error) {
        this.logger.warn(
          { jwksUrl, err: error instanceof Error ? error.message : String(error) },
          'Failed to fetch RS256 JWKS from auth-customer',
        );
        if (!this.defaultKey && this.keyCache.size === 0) {
          throw this.buildAuthError(
            HttpStatus.SERVICE_UNAVAILABLE,
            ErrorCode.DEPENDENCY_UNAVAILABLE,
            'Authentication JWKS service is unavailable.',
            correlationId,
          );
        }
      } finally {
        clearTimeout(timer);
        this.inflightFetch = null;
      }
    })();

    await this.inflightFetch;
  }

  private buildAuthError(
    status: HttpStatus,
    code: ErrorCode,
    message: string,
    correlationId?: string,
  ): HttpException {
    return new HttpException(
      createApiErrorResponse(code, message, undefined, {
        correlationId,
        service: this.config.serviceName,
      }),
      status,
    );
  }
}
