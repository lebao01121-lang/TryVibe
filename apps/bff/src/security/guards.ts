import * as crypto from 'node:crypto';
import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  ADMIN_PORTAL_ROLES,
  createApiErrorResponse,
  ErrorCode,
  hasPermission,
  isMfaRequiredForRoles,
  Role,
  type Permission,
} from '@atelier/contracts';
import { getOrCreateCorrelationId, type HeaderBag } from '@atelier/observability';
import type { Request } from 'express';
import { BFF_CONFIG_TOKEN, type BffConfig } from '../config/env';
import {
  REQUIRED_ANY_PERMISSIONS_METADATA_KEY,
  REQUIRED_PERMISSIONS_METADATA_KEY,
  type AuthenticatedRequest,
} from './auth-types';
import { JwtVerifierService } from './jwt-verifier.service';

function extractCookieValue(req: Request, cookieName: string): string | undefined {
  const cookies = (req as Request & { cookies?: Record<string, unknown> }).cookies;
  if (cookies && typeof cookies[cookieName] === 'string' && cookies[cookieName]) {
    return cookies[cookieName] as string;
  }
  const rawHeader = req.headers.cookie;
  if (!rawHeader) {
    return undefined;
  }
  for (const part of rawHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) {
      continue;
    }
    const name = part.slice(0, idx).trim();
    if (name === cookieName) {
      return decodeURIComponent(part.slice(idx + 1).trim());
    }
  }
  return undefined;
}

function timingSafeStringEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function extractRequestOrigin(req: Request): string | null {
  const originHeader = req.headers.origin;
  if (typeof originHeader === 'string' && originHeader.trim().length > 0) {
    return originHeader.trim().replace(/\/+$/, '');
  }
  const refererHeader = req.headers.referer;
  if (typeof refererHeader === 'string' && refererHeader.trim().length > 0) {
    try {
      return new URL(refererHeader.trim()).origin;
    } catch {
      return null;
    }
  }
  return null;
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    @Inject(JwtVerifierService) private readonly jwtVerifier: JwtVerifierService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    await this.jwtVerifier.verifyRequest(req);
    return true;
  }
}

const EXTERNAL_WEBHOOK_PATH_PREFIXES: readonly string[] = [
  '/bff/v1/payments/webhooks/',
  '/bff/v1/storefront/payments/webhooks/',
  '/bff/v1/payments/vnpay/ipn',
  '/bff/v1/payments/momo/ipn',
  '/bff/v1/payments/payos/webhook',
  '/bff/v1/webhooks/shipping/',
];

function isExternalWebhookPath(pathname: string): boolean {
  const clean = (pathname || '').split('?')[0] ?? '';
  return EXTERNAL_WEBHOOK_PATH_PREFIXES.some((prefix) =>
    prefix.endsWith('/') ? clean.startsWith(prefix) : clean === prefix,
  );
}

@Injectable()
export class CsrfOriginGuard implements CanActivate {
  constructor(@Inject(BFF_CONFIG_TOKEN) private readonly config: BffConfig) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (isExternalWebhookPath(req.originalUrl || req.url || '')) {
      return true;
    }
    const correlationId = getOrCreateCorrelationId(req.headers as HeaderBag);

    // 1. Validate Origin (or Referer origin) against strict allowlist
    const origin = extractRequestOrigin(req);
    if (!origin || !this.config.csrfAllowedOrigins.includes(origin)) {
      throw new HttpException(
        createApiErrorResponse(
          ErrorCode.CSRF_INVALID,
          `Missing or disallowed Origin "${origin ?? 'none'}" on state-changing auth endpoint.`,
          undefined,
          { correlationId, service: this.config.serviceName },
        ),
        HttpStatus.FORBIDDEN,
      );
    }

    // 2. Validate X-CSRF-Token header presence & Double-Submit Cookie match
    const rawCsrfHeader = req.headers['x-csrf-token'];
    const csrfHeader = Array.isArray(rawCsrfHeader)
      ? rawCsrfHeader[0]?.trim()
      : rawCsrfHeader?.trim();

    if (!csrfHeader) {
      throw new HttpException(
        createApiErrorResponse(
          ErrorCode.CSRF_INVALID,
          'Missing required X-CSRF-Token header.',
          undefined,
          { correlationId, service: this.config.serviceName },
        ),
        HttpStatus.FORBIDDEN,
      );
    }

    const rawCsrfCookie = extractCookieValue(req, 'atelier_csrf_token');
    const csrfCookie = rawCsrfCookie?.trim();

    if (!csrfCookie) {
      throw new HttpException(
        createApiErrorResponse(
          ErrorCode.CSRF_INVALID,
          'Missing required atelier_csrf_token cookie.',
          undefined,
          { correlationId, service: this.config.serviceName },
        ),
        HttpStatus.FORBIDDEN,
      );
    }

    if (!timingSafeStringEqual(csrfHeader, csrfCookie)) {
      throw new HttpException(
        createApiErrorResponse(
          ErrorCode.CSRF_INVALID,
          'X-CSRF-Token header does not match atelier_csrf_token cookie.',
          undefined,
          { correlationId, service: this.config.serviceName },
        ),
        HttpStatus.FORBIDDEN,
      );
    }

    return true;
  }
}

@Injectable()
export class AdminPortalGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(BFF_CONFIG_TOKEN) private readonly config: BffConfig,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const correlationId = getOrCreateCorrelationId(req.headers as HeaderBag);
    const user = req.user;

    if (!user) {
      throw new HttpException(
        createApiErrorResponse(
          ErrorCode.UNAUTHORIZED,
          'Authentication required for Admin Portal endpoints.',
          undefined,
          { correlationId, service: this.config.serviceName },
        ),
        HttpStatus.UNAUTHORIZED,
      );
    }

    // Hard-reject CUSTOMER and SUPPLIER; permit ONLY ADMIN_PORTAL_ROLES
    const hasAdminRole = user.roles.some((role) => ADMIN_PORTAL_ROLES.includes(role));
    if (!hasAdminRole) {
      throw new HttpException(
        createApiErrorResponse(
          ErrorCode.FORBIDDEN,
          'Only internal Admin Portal roles may access /api/v1/admin/* endpoints.',
          { roles: user.roles },
          { correlationId, service: this.config.serviceName },
        ),
        HttpStatus.FORBIDDEN,
      );
    }

    // Mandatory 2FA enforcement for SUPER_ADMIN & WAREHOUSE_MANAGER
    if (isMfaRequiredForRoles(user.roles) && user.mfaVerified !== true) {
      throw new HttpException(
        createApiErrorResponse(
          ErrorCode.MFA_REQUIRED,
          'Two-factor authentication (2FA) verification is required before accessing Admin Ledger endpoints.',
          { roles: user.roles },
          { correlationId, service: this.config.serviceName },
        ),
        HttpStatus.FORBIDDEN,
      );
    }

    // Fine-grained per-route permission check (ALL required)
    const requiredPermissions =
      this.reflector.getAllAndOverride<Permission[] | undefined>(
        REQUIRED_PERMISSIONS_METADATA_KEY,
        [context.getHandler(), context.getClass()],
      ) ?? [];

    if (requiredPermissions.length > 0 && !user.roles.includes(Role.SUPER_ADMIN)) {
      const missing = requiredPermissions.filter(
        (perm) => !user.permissions.includes(perm) && !hasPermission(user.roles, perm),
      );
      if (missing.length > 0) {
        throw new HttpException(
          createApiErrorResponse(
            ErrorCode.FORBIDDEN,
            `Insufficient permissions: missing [${missing.join(', ')}].`,
            { missingPermissions: missing },
            { correlationId, service: this.config.serviceName },
          ),
          HttpStatus.FORBIDDEN,
        );
      }
    }

    // Fine-grained per-route OR-permission check (ANY one required)
    const requiredAnyPermissions =
      this.reflector.getAllAndOverride<Permission[] | undefined>(
        REQUIRED_ANY_PERMISSIONS_METADATA_KEY,
        [context.getHandler(), context.getClass()],
      ) ?? [];

    if (requiredAnyPermissions.length > 0 && !user.roles.includes(Role.SUPER_ADMIN)) {
      const hasAny = requiredAnyPermissions.some(
        (perm) => user.permissions.includes(perm) || hasPermission(user.roles, perm),
      );
      if (!hasAny) {
        throw new HttpException(
          createApiErrorResponse(
            ErrorCode.FORBIDDEN,
            `Insufficient permissions: requires at least one of [${requiredAnyPermissions.join(', ')}].`,
            { requiredAnyPermissions },
            { correlationId, service: this.config.serviceName },
          ),
          HttpStatus.FORBIDDEN,
        );
      }
    }

    return true;
  }
}

@Injectable()
export class PartnerPortalGuard implements CanActivate {
  constructor(@Inject(BFF_CONFIG_TOKEN) private readonly config: BffConfig) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const correlationId = getOrCreateCorrelationId(req.headers as HeaderBag);
    const user = req.user;

    if (!user) {
      throw new HttpException(
        createApiErrorResponse(
          ErrorCode.UNAUTHORIZED,
          'Authentication required for Partner Portal endpoints.',
          undefined,
          { correlationId, service: this.config.serviceName },
        ),
        HttpStatus.UNAUTHORIZED,
      );
    }

    // Strictly permit ONLY Role.SUPPLIER
    const isSupplier = user.roles.includes(Role.SUPPLIER);
    if (!isSupplier) {
      throw new HttpException(
        createApiErrorResponse(
          ErrorCode.FORBIDDEN,
          'Only authenticated SUPPLIER accounts may access /api/v1/partner/* endpoints.',
          { roles: user.roles },
          { correlationId, service: this.config.serviceName },
        ),
        HttpStatus.FORBIDDEN,
      );
    }

    // Mandatory 2FA enforcement for SUPPLIER
    if (user.mfaVerified !== true) {
      throw new HttpException(
        createApiErrorResponse(
          ErrorCode.MFA_REQUIRED,
          'Two-factor authentication (2FA) verification is required before accessing Partner Portal endpoints.',
          undefined,
          { correlationId, service: this.config.serviceName },
        ),
        HttpStatus.FORBIDDEN,
      );
    }

    // Strict tenant isolation binding check
    if (!user.supplierId || user.supplierId.trim().length === 0) {
      throw new HttpException(
        createApiErrorResponse(
          ErrorCode.FORBIDDEN,
          'Supplier account is missing mandatory supplierId tenant binding.',
          undefined,
          { correlationId, service: this.config.serviceName },
        ),
        HttpStatus.FORBIDDEN,
      );
    }

    return true;
  }
}
