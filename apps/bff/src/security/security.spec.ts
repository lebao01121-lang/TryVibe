import * as crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { HttpException, HttpStatus, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ErrorCode,
  Permission,
  Portal,
  Role,
  canAccessPortal,
  canReadCostPrice,
  hasAnyPermission,
  hasPermission,
  type JwtAccessPayload,
} from '@atelier/contracts';
import type { Request, Response } from 'express';
import {
  HttpProxyService,
  collectRawRequestBody,
} from '../common/http-proxy.service';
import type { BffRedisService } from '../common/redis.service';
import {
  buildCanonicalQueryString,
  stripStorefrontSensitiveFields,
} from '../common/sanitize';
import { DEFAULT_CSRF_ORIGINS, type BffConfig } from '../config/env';
import {
  REQUIRED_ANY_PERMISSIONS_METADATA_KEY,
  REQUIRED_PERMISSIONS_METADATA_KEY,
  RequireAnyPermission,
  RequirePermissions,
  type AuthenticatedRequest,
} from './auth-types';
import {
  AdminPortalGuard,
  CsrfOriginGuard,
  JwtAuthGuard,
  PartnerPortalGuard,
} from './guards';
import { JwtVerifierService } from './jwt-verifier.service';
import {
  ApiPublicWebhooksController,
  extractWebhookForwardHeaders,
  PublicWebhooksController,
} from '../webhooks/public-webhooks.controller';
import {
  ApiAuthBffController,
  AuthProxyService,
  StorefrontAuthBffController,
} from '../auth/auth-bff.controller';

function createMockBffConfig(): BffConfig {
  return {
    serviceName: '@atelier/bff',
    port: 4000,
    nodeEnv: 'test',
    corsAllowedOrigins: [...DEFAULT_CSRF_ORIGINS],
    csrfAllowedOrigins: [...DEFAULT_CSRF_ORIGINS],
    vtonProvider: 'mock',
    redisUrl: 'redis://127.0.0.1:6379',
    redisConfigured: false,
    socketIoRedisEnabled: false,
    rabbitmqConfigured: false,
    meilisearchHost: 'http://127.0.0.1:7700',
    minioPublicUrl: 'http://127.0.0.1:9000',
    mailpitUiUrl: 'http://127.0.0.1:8025',
    rabbitmqMgmtUrl: 'http://127.0.0.1:15672',
    rabbitmqUser: 'atelier_mq',
    rabbitmqPassword: 'secret',
    ollamaBaseUrl: 'http://127.0.0.1:11434',
    ollamaMainModel: 'qwen2.5:3b',
    ollamaFastModel: 'qwen2.5:3b',
    ollamaEmbedModel: 'nomic-embed-text',
    ollamaEmbedDim: 768,
    inventoryServiceUrl: 'http://127.0.0.1:4004',
    cartOutfitServiceUrl: 'http://127.0.0.1:4005',
    orderRmaServiceUrl: 'http://127.0.0.1:4006',
    paymentPromoServiceUrl: 'http://127.0.0.1:4007',
    notifyReviewServiceUrl: 'http://127.0.0.1:4008',
    aiTryonServiceUrl: 'http://127.0.0.1:4009',
    mcpCopilotUrl: 'http://127.0.0.1:4010',
    storefrontUrl: 'http://127.0.0.1:3000',
    revalidateSecret: 'reval-secret',
    internalServiceSecret: 'internal-secret',
    upstreams: {
      authCustomerUrl: 'http://127.0.0.1:4001',
      catalogLookbookUrl: 'http://127.0.0.1:4002',
      mediaPipelineUrl: 'http://127.0.0.1:4003',
      inventoryUrl: 'http://127.0.0.1:4004',
      cartOutfitUrl: 'http://127.0.0.1:4005',
      orderRmaUrl: 'http://127.0.0.1:4006',
      paymentPromoUrl: 'http://127.0.0.1:4007',
      notifyReviewUrl: 'http://127.0.0.1:4008',
      aiTryOnUrl: 'http://127.0.0.1:4009',
      mcpCopilotUrl: 'http://127.0.0.1:4010',
    },
  };
}

function createExecContext(req: Partial<AuthenticatedRequest>): ExecutionContext {
  const handler = () => undefined;
  class DummyController {}
  return {
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => ({}),
      getNext: () => undefined,
    }),
    getHandler: () => handler,
    getClass: () => DummyController,
  } as unknown as ExecutionContext;
}

function makeJwtUser(overrides: Partial<JwtAccessPayload> = {}): JwtAccessPayload {
  const now = Math.floor(Date.now() / 1000);
  return {
    sub: '11111111-1111-4111-8111-111111111111',
    email: 'admin@atelier.vn',
    roles: [Role.SUPER_ADMIN],
    permissions: [],
    supplierId: null,
    loyaltyTier: 'BRONZE',
    mfaVerified: true,
    permissionVersion: 1,
    jti: 'jti-001',
    iat: now - 10,
    exp: now + 900,
    ...overrides,
  };
}

describe('6-Role RBAC Permission Matrix', () => {
  it('enforces exact portal access matrix across all 6 roles', () => {
    expect(canAccessPortal(Role.SUPER_ADMIN, Portal.ADMIN_PORTAL)).toBe(true);
    expect(canAccessPortal(Role.CATALOG_AI_OPERATOR, Portal.ADMIN_PORTAL)).toBe(true);
    expect(canAccessPortal(Role.WAREHOUSE_MANAGER, Portal.ADMIN_PORTAL)).toBe(true);
    expect(canAccessPortal(Role.ORDER_STAFF, Portal.ADMIN_PORTAL)).toBe(true);
    expect(canAccessPortal(Role.SUPPLIER, Portal.ADMIN_PORTAL)).toBe(false);
    expect(canAccessPortal(Role.CUSTOMER, Portal.ADMIN_PORTAL)).toBe(false);

    expect(canAccessPortal(Role.SUPPLIER, Portal.PARTNER_PORTAL)).toBe(true);
    expect(canAccessPortal(Role.SUPER_ADMIN, Portal.PARTNER_PORTAL)).toBe(false);
    expect(canAccessPortal(Role.CUSTOMER, Portal.PARTNER_PORTAL)).toBe(false);
    expect(canAccessPortal(Role.WAREHOUSE_MANAGER, Portal.PARTNER_PORTAL)).toBe(false);

    for (const role of Object.values(Role)) {
      expect(canAccessPortal(role, Portal.STOREFRONT)).toBe(true);
    }
  });

  it('restricts canReadCostPrice strictly to SUPER_ADMIN and WAREHOUSE_MANAGER', () => {
    expect(canReadCostPrice(Role.SUPER_ADMIN)).toBe(true);
    expect(canReadCostPrice(Role.WAREHOUSE_MANAGER)).toBe(true);
    expect(canReadCostPrice(Role.CATALOG_AI_OPERATOR)).toBe(false);
    expect(canReadCostPrice(Role.ORDER_STAFF)).toBe(false);
    expect(canReadCostPrice(Role.SUPPLIER)).toBe(false);
    expect(canReadCostPrice(Role.CUSTOMER)).toBe(false);
  });

  it('enforces granular permissions per role', () => {
    expect(hasPermission(Role.CATALOG_AI_OPERATOR, Permission.CATALOG_AI_APPROVE)).toBe(true);
    expect(hasPermission(Role.CATALOG_AI_OPERATOR, Permission.INVENTORY_PO_APPROVE)).toBe(false);
    expect(hasPermission(Role.WAREHOUSE_MANAGER, Permission.INVENTORY_GRN_APPROVE)).toBe(true);
    expect(hasPermission(Role.WAREHOUSE_MANAGER, Permission.ORDER_REFUND_APPROVE)).toBe(false);
    expect(hasPermission(Role.ORDER_STAFF, Permission.ORDER_RMA_MANAGE)).toBe(true);
    expect(hasPermission(Role.ORDER_STAFF, Permission.ADMIN_RBAC_MANAGE)).toBe(false);
    expect(hasPermission(Role.SUPPLIER, Permission.SUPPLIER_PO_CONFIRM)).toBe(true);
    expect(hasPermission(Role.CUSTOMER, Permission.CUSTOMER_COPILOT_ACCESS)).toBe(true);
    expect(
      hasAnyPermission([Role.ORDER_STAFF], [Permission.ADMIN_RBAC_MANAGE, Permission.ORDER_MANAGE]),
    ).toBe(true);
  });
});

describe('CsrfOriginGuard', () => {
  const guard = new CsrfOriginGuard(createMockBffConfig());

  it('allows external provider webhooks without Origin or CSRF headers', () => {
    const webhookPaths = [
      '/bff/v1/payments/vnpay/ipn?vnp_TxnRef=TX-1',
      '/bff/v1/payments/momo/ipn',
      '/bff/v1/payments/payos/webhook',
      '/bff/v1/payments/sepay/webhook',
      '/bff/v1/payments/sepay/webhook?source=sepay',
      '/api/v1/payments/sepay/webhook',
      '/api/v1/payments/sepay/webhook?source=sepay',
      '/bff/v1/payments/webhooks/vietqr',
      '/bff/v1/payments/webhooks/sepay',
      '/bff/v1/storefront/payments/webhooks/momo',
      '/bff/v1/storefront/payments/webhooks/sepay',
      '/bff/v1/webhooks/shipping/ghn?token=abc',
    ];

    for (const url of webhookPaths) {
      const ctx = createExecContext({ originalUrl: url, url, headers: {} });
      expect(guard.canActivate(ctx)).toBe(true);
    }
  });

  it('rejects missing Origin, untrusted Origin, invalid Referer, missing CSRF header/cookie, and mismatched tokens', () => {
    const assertCsrfRejected = (req: Partial<AuthenticatedRequest>) => {
      try {
        guard.canActivate(createExecContext(req));
        throw new Error('Expected CSRF rejection');
      } catch (err) {
        expect(err).toBeInstanceOf(HttpException);
        const httpErr = err as HttpException;
        expect(httpErr.getStatus()).toBe(HttpStatus.FORBIDDEN);
        expect((httpErr.getResponse() as { error: { code: string } }).error.code).toBe(
          ErrorCode.CSRF_INVALID,
        );
      }
    };

    // Missing Origin/Referer
    assertCsrfRejected({ url: '/api/v1/admin/orders', headers: {} });

    // Untrusted Origin
    assertCsrfRejected({
      url: '/api/v1/admin/orders',
      headers: { origin: 'https://evil.example.com', 'x-csrf-token': 'tok1', cookie: 'atelier_csrf_token=tok1' },
    });

    // Malformed Referer
    assertCsrfRejected({
      url: '/api/v1/admin/orders',
      headers: { referer: 'not-a-url', 'x-csrf-token': 'tok1', cookie: 'atelier_csrf_token=tok1' },
    });

    // Missing X-CSRF-Token header
    assertCsrfRejected({
      url: '/api/v1/admin/orders',
      headers: { origin: 'http://localhost:3001', cookie: 'atelier_csrf_token=tok1' },
    });

    // Missing cookie
    assertCsrfRejected({
      url: '/api/v1/admin/orders',
      headers: { origin: 'http://localhost:3001', 'x-csrf-token': 'tok1' },
    });

    // Mismatched double-submit token (same length and different length)
    assertCsrfRejected({
      url: '/api/v1/admin/orders',
      headers: {
        origin: 'http://localhost:3001',
        'x-csrf-token': 'token-aaa-111',
        cookie: 'atelier_csrf_token=token-bbb-222',
      },
    });
    assertCsrfRejected({
      url: '/api/v1/admin/orders',
      headers: {
        origin: 'http://localhost:3001',
        'x-csrf-token': 'short',
        cookie: 'atelier_csrf_token=much-longer-token',
      },
    });
  });

  it('allows valid Origin/Referer with matching Double-Submit cookie & header', () => {
    const ctxCookieHeader = createExecContext({
      originalUrl: '/api/v1/admin/orders/cancel',
      headers: {
        origin: 'http://localhost:3001/',
        'x-csrf-token': 'csrf-secret-value-2026',
        cookie: 'other=1; atelier_csrf_token=csrf-secret-value-2026',
      },
    });
    expect(guard.canActivate(ctxCookieHeader)).toBe(true);

    const ctxParsedCookies = createExecContext({
      originalUrl: '/api/v1/storefront/orders',
      headers: {
        referer: 'http://localhost:3000/thanh-toan',
        'x-csrf-token': ['csrf-referer-match'],
      },
      cookies: { atelier_csrf_token: 'csrf-referer-match' },
    } as Partial<AuthenticatedRequest>);
    expect(guard.canActivate(ctxParsedCookies)).toBe(true);
  });
});

describe('AdminPortalGuard, PartnerPortalGuard & Decorators', () => {
  const config = createMockBffConfig();

  it('registers RequirePermissions and RequireAnyPermission metadata keys', () => {
    class SampleHandler {
      @RequirePermissions(Permission.INVENTORY_PO_APPROVE)
      @RequireAnyPermission(Permission.ORDER_READ, Permission.ORDER_MANAGE)
      handle(): void {
        // noop
      }
    }
    const reflector = new Reflector();
    expect(
      reflector.get<Permission[]>(REQUIRED_PERMISSIONS_METADATA_KEY, SampleHandler.prototype.handle),
    ).toEqual([Permission.INVENTORY_PO_APPROVE]);
    expect(
      reflector.get<Permission[]>(
        REQUIRED_ANY_PERMISSIONS_METADATA_KEY,
        SampleHandler.prototype.handle,
      ),
    ).toEqual([Permission.ORDER_READ, Permission.ORDER_MANAGE]);
  });

  it('enforces authentication, Admin role allowlist, 2FA for SUPER_ADMIN/WAREHOUSE_MANAGER, and per-route permissions', () => {
    const reflector = new Reflector();
    const getAllSpy = vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(undefined);
    const guard = new AdminPortalGuard(reflector, config);

    // Unauthenticated -> 401
    expect(() => guard.canActivate(createExecContext({ headers: {} }))).toThrow(HttpException);

    // CUSTOMER blocked -> 403
    expect(() =>
      guard.canActivate(createExecContext({ headers: {}, user: makeJwtUser({ roles: [Role.CUSTOMER] }) })),
    ).toThrow(HttpException);

    // SUPPLIER blocked -> 403
    expect(() =>
      guard.canActivate(createExecContext({ headers: {}, user: makeJwtUser({ roles: [Role.SUPPLIER] }) })),
    ).toThrow(HttpException);

    // WAREHOUSE_MANAGER without 2FA -> 403 MFA_REQUIRED
    try {
      guard.canActivate(
        createExecContext({
          headers: {},
          user: makeJwtUser({ roles: [Role.WAREHOUSE_MANAGER], mfaVerified: false }),
        }),
      );
      throw new Error('Expected MFA_REQUIRED');
    } catch (err) {
      expect((err as HttpException).getResponse()).toMatchObject({
        error: { code: ErrorCode.MFA_REQUIRED },
      });
    }

    // ORDER_STAFF allowed without 2FA when permissions match
    expect(
      guard.canActivate(
        createExecContext({
          headers: {},
          user: makeJwtUser({ roles: [Role.ORDER_STAFF], mfaVerified: false }),
        }),
      ),
    ).toBe(true);

    // Missing required ALL permission -> 403
    getAllSpy.mockImplementation((key) =>
      key === REQUIRED_PERMISSIONS_METADATA_KEY ? [Permission.INVENTORY_PO_APPROVE] : undefined,
    );
    expect(() =>
      guard.canActivate(
        createExecContext({
          headers: {},
          user: makeJwtUser({ roles: [Role.ORDER_STAFF], mfaVerified: false }),
        }),
      ),
    ).toThrow(HttpException);

    // SUPER_ADMIN with 2FA passes required permissions
    expect(
      guard.canActivate(
        createExecContext({
          headers: {},
          user: makeJwtUser({ roles: [Role.SUPER_ADMIN], mfaVerified: true }),
        }),
      ),
    ).toBe(true);

    // Missing required ANY permission -> 403
    getAllSpy.mockImplementation((key) =>
      key === REQUIRED_ANY_PERMISSIONS_METADATA_KEY
        ? [Permission.ADMIN_RBAC_MANAGE, Permission.FINANCE_COST_PRICE_READ]
        : undefined,
    );
    expect(() =>
      guard.canActivate(
        createExecContext({
          headers: {},
          user: makeJwtUser({ roles: [Role.CATALOG_AI_OPERATOR], mfaVerified: false }),
        }),
      ),
    ).toThrow(HttpException);
  });

  it('enforces PartnerPortalGuard (SUPPLIER only + 2FA + mandatory supplierId binding)', () => {
    const guard = new PartnerPortalGuard(config);

    expect(() => guard.canActivate(createExecContext({ headers: {} }))).toThrow(HttpException);
    expect(() =>
      guard.canActivate(createExecContext({ headers: {}, user: makeJwtUser({ roles: [Role.CUSTOMER] }) })),
    ).toThrow(HttpException);
    expect(() =>
      guard.canActivate(
        createExecContext({
          headers: {},
          user: makeJwtUser({ roles: [Role.SUPPLIER], mfaVerified: false, supplierId: 'sup-1' }),
        }),
      ),
    ).toThrow(HttpException);
    expect(() =>
      guard.canActivate(
        createExecContext({
          headers: {},
          user: makeJwtUser({ roles: [Role.SUPPLIER], mfaVerified: true, supplierId: null }),
        }),
      ),
    ).toThrow(HttpException);

    expect(
      guard.canActivate(
        createExecContext({
          headers: {},
          user: makeJwtUser({ roles: [Role.SUPPLIER], mfaVerified: true, supplierId: 'sup-a' }),
        }),
      ),
    ).toBe(true);
  });
});

describe('JwtVerifierService & JwtAuthGuard', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const publicJwk = { ...(publicKey.export({ format: 'jwk' }) as Record<string, unknown>), kid: 'kid-1', use: 'sig', alg: 'RS256' };

  function signRs256Jwt(
    payload: Record<string, unknown>,
    headerOverrides: Record<string, unknown> = {},
  ): string {
    const header = Buffer.from(
      JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'kid-1', ...headerOverrides }),
    ).toString('base64url');
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const sig = crypto
      .sign('RSA-SHA256', Buffer.from(`${header}.${body}`, 'utf8'), privateKey)
      .toString('base64url');
    return `${header}.${body}.${sig}`;
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('verifies RS256 access tokens via JWKS, enforces Redis revocation/lock/permVer checks, and guards routes', async () => {
    const redisStore = new Map<string, string>();
    const mockRedis = {
      getSafe: vi.fn(async (key: string) => redisStore.get(key) ?? null),
    } as unknown as BffRedisService;

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ keys: [publicJwk] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const verifier = new JwtVerifierService(createMockBffConfig(), mockRedis);
    const jwtGuard = new JwtAuthGuard(verifier);

    const userClaims = makeJwtUser();
    const validToken = signRs256Jwt(userClaims as unknown as Record<string, unknown>);

    const req: Partial<AuthenticatedRequest> = {
      headers: { authorization: `Bearer ${validToken}` },
    };
    expect(await jwtGuard.canActivate(createExecContext(req))).toBe(true);
    expect(req.user?.sub).toBe(userClaims.sub);

    // Optional auth returns null when header missing or invalid
    expect(await verifier.verifyRequestOptional({ headers: {} } as AuthenticatedRequest)).toBeNull();
    expect(
      await verifier.verifyRequestOptional({
        headers: { authorization: 'Bearer invalid.token.sig' },
      } as AuthenticatedRequest),
    ).toBeNull();
    expect(
      await verifier.verifyRequestOptional({
        headers: { authorization: `Bearer ${validToken}` },
      } as AuthenticatedRequest),
    ).not.toBeNull();

    // Missing / malformed Authorization header
    await expect(
      verifier.verifyRequest({ headers: {} } as AuthenticatedRequest),
    ).rejects.toBeInstanceOf(HttpException);
    await expect(
      verifier.verifyRequest({ headers: { authorization: 'Bearer   ' } } as AuthenticatedRequest),
    ).rejects.toBeInstanceOf(HttpException);

    // Reject non-RS256 alg
    const hsToken = signRs256Jwt(userClaims as unknown as Record<string, unknown>, { alg: 'HS256' });
    await expect(verifier.verifyAccessToken(hsToken)).rejects.toBeInstanceOf(HttpException);

    // Reject tampered signature
    await expect(verifier.verifyAccessToken(`${validToken.slice(0, -4)}AAAA`)).rejects.toBeInstanceOf(
      HttpException,
    );

    // Reject expired token
    const expiredToken = signRs256Jwt({
      ...userClaims,
      exp: Math.floor(Date.now() / 1000) - 60,
    });
    await expect(verifier.verifyAccessToken(expiredToken)).rejects.toBeInstanceOf(HttpException);

    // Reject locked account in Redis
    redisStore.set(`user:locked:${userClaims.sub}`, '1');
    await expect(verifier.verifyAccessToken(validToken)).rejects.toBeInstanceOf(HttpException);
    redisStore.clear();

    // Reject revoked permissionVersion in Redis
    redisStore.set(`user:perm_ver:${userClaims.sub}`, '2');
    await expect(verifier.verifyAccessToken(validToken)).rejects.toBeInstanceOf(HttpException);
    redisStore.clear();

    // Reject revoked JTI in Redis
    redisStore.set(`revoked_jti:${userClaims.jti}`, '1');
    await expect(verifier.verifyAccessToken(validToken)).rejects.toBeInstanceOf(HttpException);
  });
});

describe('HttpProxyService & Storefront Sanitization', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('scrubs client-injected IDOR headers, forwards correlation/trace headers, and handles timeouts gracefully', async () => {
    const proxy = new HttpProxyService(createMockBffConfig());
    let capturedHeaders: Headers | undefined;

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      capturedHeaders = init?.headers as Headers;
      return new Response(JSON.stringify({ ok: true, items: [] }), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'set-cookie': 'atelier_sid=abc; HttpOnly',
        },
      });
    });

    const fakeReq = {
      headers: {
        authorization: 'Bearer abc',
        'x-user-id': 'spoofed-admin-id',
        'x-actor-roles': 'SUPER_ADMIN',
        'x-supplier-id': 'spoofed-sup',
        'x-internal-secret': 'spoofed-secret',
        'x-forwarded-for': '203.0.113.10, 10.0.0.1',
      },
      ip: '127.0.0.1',
    } as unknown as Request;

    const result = await proxy.request<{ ok: boolean }>({
      method: 'POST',
      url: 'http://127.0.0.1:4004/v1/inventory/reserve',
      req: fakeReq,
      body: { skuId: 'sku-1' },
      extraHeaders: { 'x-user-id': 'verified-user-1' },
    });

    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.body.ok).toBe(true);
    expect(capturedHeaders?.get('x-user-id')).toBe('verified-user-1');
    expect(capturedHeaders?.get('x-actor-roles')).toBeNull();
    expect(capturedHeaders?.get('x-supplier-id')).toBeNull();
    expect(capturedHeaders?.get('x-internal-secret')).toBeNull();
    expect(capturedHeaders?.get('x-forwarded-for')).toBe('203.0.113.10');
    expect(capturedHeaders?.get('traceparent')).toBeTruthy();

    // sendProxyResponse handles JSON, string, and null
    const resMock = {
      setHeader: vi.fn(),
      status: vi.fn().mockReturnThis(),
      type: vi.fn().mockReturnThis(),
      send: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    } as unknown as Response;

    proxy.sendProxyResponse(resMock, result);
    expect(resMock.setHeader).toHaveBeenCalled();
    expect(resMock.json).toHaveBeenCalledWith({ ok: true, items: [] });

    proxy.sendProxyResponse(resMock, { ...result, setCookies: [], body: 'plain' });
    expect(resMock.send).toHaveBeenCalledWith('plain');

    proxy.sendProxyResponse(resMock, { ...result, setCookies: [], body: null });
    expect(resMock.send).toHaveBeenCalled();

    // Downstream timeout returns 503 DEPENDENCY_UNAVAILABLE
    const abortErr = new Error('The operation was aborted');
    abortErr.name = 'AbortError';
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(abortErr);

    const errRes = await proxy.request({
      method: 'GET',
      url: 'http://127.0.0.1:4004/v1/inventory/health',
    });
    expect(errRes.status).toBe(503);
    expect(errRes.ok).toBe(false);
    expect((errRes.body as { error: { code: string } }).error.code).toBe(
      ErrorCode.DEPENDENCY_UNAVAILABLE,
    );
  });

  it('collects raw request body chunks and enforces maxBytes limit', async () => {
    const okStream = new EventEmitter() as unknown as Request;
    const promise = collectRawRequestBody(okStream, 64);
    okStream.emit('data', Buffer.from('hello '));
    okStream.emit('data', 'atelier');
    okStream.emit('end');
    expect((await promise).toString('utf8')).toBe('hello atelier');

    const tooBigStream = Object.assign(new EventEmitter(), { pause: vi.fn() }) as unknown as Request;
    const failPromise = collectRawRequestBody(tooBigStream, 4);
    tooBigStream.emit('data', Buffer.from('123456'));
    await expect(failPromise).rejects.toThrow(/exceeds maximum limit/);
  });

  it('strips sensitive storefront cost/supplier fields and builds canonical query strings', () => {
    const payload = {
      id: 'spu-1',
      salePriceVnd: 1_990_000,
      costPriceVnd: 750_000,
      giaNhap: 750_000,
      cogs: 750_000,
      supplierId: 'sup-a',
      createdAt: new Date('2026-11-25T00:00:00.000Z'),
      skus: [{ skuCode: 'SKU-1', wholesaleCostVnd: 680_000, price: 1_990_000 }],
    };

    const stripped = stripStorefrontSensitiveFields(payload);
    expect('costPriceVnd' in stripped).toBe(false);
    expect('giaNhap' in stripped).toBe(false);
    expect('cogs' in stripped).toBe(false);
    expect('supplierId' in stripped).toBe(false);
    expect('wholesaleCostVnd' in (stripped.skus[0] as Record<string, unknown>)).toBe(false);
    expect(stripped.salePriceVnd).toBe(1_990_000);
    expect(stripped.createdAt).toBeInstanceOf(Date);

    expect(
      buildCanonicalQueryString({ z: '2', a: ['M', 'S'], empty: '  ', skip: null }),
    ).toBe('a=M&a=S&z=2');
  });

  it('preserves SePay payment intent and status fields in storefront sanitization', () => {
    const sepayPayload = {
      success: true,
      data: {
        orderCode: 'TX-2026SEPAY01',
        sepayQrImageUrl: 'https://qr.sepay.vn/img?acc=088820269999&bank=MB&amount=1850000&des=TRYVIBE+TX2026SEPAY01',
        transferContent: 'TRYVIBE TX2026SEPAY01',
        vietqrProvider: 'SEPAY',
        providerMode: 'SANDBOX_LOCAL',
        sepaySyncedNow: true,
        costPriceVnd: 650_000,
        bankInfo: {
          bankBin: '970422',
          bankCode: 'MB',
          bankName: 'MBBank',
          accountNo: '088820269999',
          accountName: 'TRYVIBE FASHION ATELIER',
        },
      },
    };

    const sanitized = stripStorefrontSensitiveFields(sepayPayload);
    expect('costPriceVnd' in sanitized.data).toBe(false);
    expect(sanitized.data.sepayQrImageUrl).toBe(sepayPayload.data.sepayQrImageUrl);
    expect(sanitized.data.transferContent).toBe('TRYVIBE TX2026SEPAY01');
    expect(sanitized.data.vietqrProvider).toBe('SEPAY');
    expect(sanitized.data.providerMode).toBe('SANDBOX_LOCAL');
    expect(sanitized.data.sepaySyncedNow).toBe(true);
    expect(sanitized.data.bankInfo).toEqual(sepayPayload.data.bankInfo);
  });

  it('forwards SePay Authorization: Apikey and API key headers across /bff/v1 and /api/v1 webhook routes', async () => {
    const config = createMockBffConfig();
    const proxy = new HttpProxyService(config);
    const forwardedCalls: Array<{ url: string; headers: Headers; body: string }> = [];

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const bodyBytes = init?.body instanceof Uint8Array ? Buffer.from(init.body).toString('utf8') : String(init?.body ?? '');
      forwardedCalls.push({
        url: String(input),
        headers: init?.headers as Headers,
        body: bodyBytes,
      });
      return new Response(JSON.stringify({ success: true, ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const rawJson = JSON.stringify({
      id: 987654,
      gateway: 'MBBank',
      transferType: 'in',
      transferAmount: 1850000,
      content: 'TRYVIBE TX2026SEPAY01',
    });

    const fakeReq = {
      originalUrl: '/bff/v1/payments/sepay/webhook',
      url: '/bff/v1/payments/sepay/webhook',
      ip: '203.0.113.55',
      headers: {
        'content-type': 'application/json',
        authorization: 'Apikey sepay_live_webhook_secret_2026',
        'x-sepay-apikey': 'sepay_alt_key',
        'x-api-key': 'sepay_x_api_key',
        'x-sepay-signature': 'sig-abc',
      },
      rawBody: Buffer.from(rawJson, 'utf8'),
    } as unknown as Request & { rawBody?: Buffer };

    const extracted = extractWebhookForwardHeaders(fakeReq, 'corr-sepay-1', '203.0.113.55');
    expect(extracted.authorization).toBe('Apikey sepay_live_webhook_secret_2026');
    expect(extracted['x-sepay-apikey']).toBe('sepay_alt_key');
    expect(extracted['x-api-key']).toBe('sepay_x_api_key');
    expect(extracted['x-sepay-signature']).toBe('sig-abc');

    const resMock = {
      setHeader: vi.fn(),
      status: vi.fn().mockReturnThis(),
      type: vi.fn().mockReturnThis(),
      send: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    } as unknown as Response;

    const bffWebhookCtrl = new PublicWebhooksController(config, proxy);
    await bffWebhookCtrl.sepayWebhookPost(fakeReq, resMock);

    const apiWebhookCtrl = new ApiPublicWebhooksController(config, proxy);
    await apiWebhookCtrl.sepayWebhookAliasPost(
      { ...fakeReq, originalUrl: '/api/v1/payments/sepay/webhook', url: '/api/v1/payments/sepay/webhook' } as unknown as Request & { rawBody?: Buffer },
      resMock,
    );

    expect(forwardedCalls).toHaveLength(2);
    for (const call of forwardedCalls) {
      expect(call.url).toBe('http://127.0.0.1:4007/v1/payments/sepay/webhook');
      expect(call.headers.get('authorization')).toBe('Apikey sepay_live_webhook_secret_2026');
      expect(call.headers.get('x-sepay-apikey')).toBe('sepay_alt_key');
      expect(call.headers.get('x-api-key')).toBe('sepay_x_api_key');
      expect(call.headers.get('x-sepay-signature')).toBe('sig-abc');
      expect(call.body).toBe(rawJson);
    }
  });

  it('forwards OAuth2 start & callback with query strings and manual 302 Location without following redirects', async () => {
    const config = createMockBffConfig();
    const proxy = new HttpProxyService(config);
    const authProxy = new AuthProxyService(config, proxy);
    const storefrontCtrl = new StorefrontAuthBffController(authProxy);
    const apiCtrl = new ApiAuthBffController(authProxy);

    const calls: Array<{ url: string; redirect?: string }> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      calls.push({ url, redirect: init?.redirect });
      return new globalThis.Response(null, {
        status: 302,
        headers: {
          Location: 'https://accounts.google.com/o/oauth2/v2/auth?client_id=test&state=abc123',
        },
      });
    });

    const resMock = {
      setHeader: vi.fn(),
      status: vi.fn().mockReturnThis(),
      type: vi.fn().mockReturnThis(),
      send: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    } as unknown as Response;

    const startReq = {
      originalUrl: '/bff/v1/auth/oauth/google/start?portal=storefront&returnTo=%2Ftai-khoan',
      url: '/bff/v1/auth/oauth/google/start?portal=storefront&returnTo=%2Ftai-khoan',
      ip: '127.0.0.1',
      headers: {},
    } as unknown as Request;

    await storefrontCtrl.oauthStart('google', startReq, resMock);

    const callbackReq = {
      originalUrl: '/api/v1/auth/oauth/google/callback?code=4%2Fabc&state=xyz999',
      url: '/api/v1/auth/oauth/google/callback?code=4%2Fabc&state=xyz999',
      ip: '127.0.0.1',
      headers: {},
    } as unknown as Request;

    await apiCtrl.oauthCallback('google', callbackReq, resMock);

    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toBe(
      'http://127.0.0.1:4001/v1/auth/oauth/google/start?portal=storefront&returnTo=%2Ftai-khoan',
    );
    expect(calls[0]?.redirect).toBe('manual');
    expect(calls[1]?.url).toBe(
      'http://127.0.0.1:4001/v1/auth/oauth/google/callback?code=4%2Fabc&state=xyz999',
    );
    expect(calls[1]?.redirect).toBe('manual');

    expect(resMock.setHeader).toHaveBeenCalledWith(
      'Location',
      'https://accounts.google.com/o/oauth2/v2/auth?client_id=test&state=abc123',
    );
    expect(resMock.status).toHaveBeenCalledWith(302);
  });
});
