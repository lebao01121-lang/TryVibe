import 'reflect-metadata';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Request, Response } from 'express';
import {
  AuthProvider,
  ErrorCode,
  OAuthPortal,
  OAuthProvider,
  Role,
} from '@atelier/contracts';
import { createIsolatedPgClient, type AtelierDbClient } from '@atelier/db-client';
import { ApiDomainException } from '../src/common/api-exception';
import { loadAuthCustomerConfig, type AuthCustomerConfig } from '../src/config/env';
import { JwksService } from '../src/crypto/jwks.service';
import { seedAuthDatabase, SEED_PASSWORD_PLAIN, SUPER_ADMIN_EMAIL } from '../src/db/seed';
import type { DatabaseService } from '../src/infra/database.service';
import type { MailService } from '../src/infra/mail.service';
import type { AuthRedisService } from '../src/infra/redis.service';
import { AuditService } from '../src/services/audit.service';
import { AuthService, CSRF_COOKIE_NAME, REFRESH_COOKIE_NAME } from '../src/services/auth.service';
import { OAuthService, sanitizeOAuthReturnTo } from '../src/services/oauth.service';

class InMemoryRedisStub {
  private readonly permVersions = new Map<string, number>();
  private readonly lockedUsers = new Set<string>();
  private readonly revokedJtis = new Set<string>();
  private readonly revokedFamilies = new Set<string>();
  private readonly states = new Map<string, string>();
  private readonly tickets = new Map<string, string>();
  private readonly passwordResets = new Map<string, string>();

  async ping(): Promise<boolean> {
    return true;
  }
  async setUserPermissionVersion(userId: string, version: number): Promise<void> {
    this.permVersions.set(userId, version);
  }
  async getUserPermissionVersion(userId: string): Promise<number | null> {
    return this.permVersions.get(userId) ?? null;
  }
  async setUserLocked(userId: string, locked: boolean): Promise<void> {
    if (locked) this.lockedUsers.add(userId);
    else this.lockedUsers.delete(userId);
  }
  async isUserLocked(userId: string): Promise<boolean> {
    return this.lockedUsers.has(userId);
  }
  async revokeJti(jti: string): Promise<void> {
    this.revokedJtis.add(jti);
  }
  async isJtiRevoked(jti: string): Promise<boolean> {
    return this.revokedJtis.has(jti);
  }
  async revokeTokenFamily(familyId: string): Promise<void> {
    this.revokedFamilies.add(familyId);
  }
  async isTokenFamilyRevoked(familyId: string): Promise<boolean> {
    return this.revokedFamilies.has(familyId);
  }
  async setOAuthState(state: string, payloadJson: string): Promise<void> {
    this.states.set(state, payloadJson);
  }
  async consumeOAuthState(state: string): Promise<string | null> {
    const val = this.states.get(state) ?? null;
    this.states.delete(state);
    return val;
  }
  async setOAuthTicket(ticket: string, payloadJson: string): Promise<void> {
    this.tickets.set(ticket, payloadJson);
  }
  async consumeOAuthTicket(ticket: string): Promise<string | null> {
    const val = this.tickets.get(ticket) ?? null;
    this.tickets.delete(ticket);
    return val;
  }
  async setPasswordResetKey(k: string, v: string): Promise<void> {
    this.passwordResets.set(k, v);
  }
  async getPasswordResetKey(k: string): Promise<string | null> {
    return this.passwordResets.get(k) ?? null;
  }
  async deletePasswordResetKey(k: string): Promise<void> {
    this.passwordResets.delete(k);
  }
}

function createMockReq(overrides: Partial<Request> = {}): Request {
  return {
    headers: {
      'user-agent': 'oauth-policy-test/1.0',
      'x-forwarded-for': '127.0.0.1',
      origin: 'http://localhost:3000',
    },
    ip: '127.0.0.1',
    secure: false,
    cookies: {},
    ...overrides,
  } as unknown as Request;
}

interface CapturedCookie {
  name: string;
  value: string;
  options: Record<string, unknown>;
}

function createMockRes(): { res: Response; cookies: CapturedCookie[] } {
  const cookies: CapturedCookie[] = [];
  const res = {
    cookie(name: string, value: string, options: Record<string, unknown> = {}) {
      cookies.push({ name, value, options });
      return res;
    },
    clearCookie() {
      return res;
    },
  } as unknown as Response;
  return { res, cookies };
}

async function expectApiError(
  fn: () => Promise<unknown>,
  expectedStatus: number,
  expectedCode: string,
): Promise<ApiDomainException> {
  try {
    await fn();
  } catch (err) {
    assert.ok(
      err instanceof ApiDomainException,
      `Expected ApiDomainException (${expectedCode}), got: ${String(err)}`,
    );
    assert.equal(
      err.getStatus(),
      expectedStatus,
      `Expected HTTP ${expectedStatus} for ${expectedCode}, got ${err.getStatus()} (${err.code}: ${err.message})`,
    );
    assert.equal(
      err.code,
      expectedCode,
      `Expected code ${expectedCode}, got ${err.code} (${err.message})`,
    );
    return err;
  }
  assert.fail(`Expected ApiDomainException ${expectedCode} (HTTP ${expectedStatus}), but resolved!`);
}

async function run(): Promise<void> {
  const repoRoot = path.resolve(__dirname, '../../..');
  const tempRoot = path.join(repoRoot, '.project-data', `oauth-policy-test-${Date.now()}`);
  fs.mkdirSync(tempRoot, { recursive: true });

  let pgClient: AtelierDbClient | null = null;

  try {
    const baseConfig = loadAuthCustomerConfig();
    const testConfig: AuthCustomerConfig = {
      ...baseConfig,
      jwt: {
        ...baseConfig.jwt,
        keyDir: path.join(tempRoot, 'jwt-keys'),
      },
      oauth: {
        google: {
          clientId: 'test-google-client-id.apps.googleusercontent.com',
          clientSecret: 'TEST_GOOGLE_SECRET_VALUE_DO_NOT_LEAK',
          callbackUrl: 'http://localhost:4000/api/v1/auth/oauth/google/callback',
          enabled: true,
        },
        github: {
          clientId: '',
          clientSecret: '',
          callbackUrl: 'http://localhost:4000/api/v1/auth/oauth/github/callback',
          enabled: false,
        },
        adminExceptionEmails: [SUPER_ADMIN_EMAIL.toLowerCase()],
        storefrontRedirectBase: 'http://localhost:3000',
        adminRedirectBase: 'http://localhost:3001',
      },
    };

    pgClient = await createIsolatedPgClient({
      databaseUrl: 'postgresql://127.0.0.1:5432/oauth_policy_test',
      dbName: 'oauth_policy_test',
      dataDirRoot: tempRoot,
      forcePglite: true,
    });

    // 1. Verify schema.sql is idempotent (run TWICE!) and seed runs cleanly
    const schemaSql = fs.readFileSync(
      path.resolve(__dirname, '../src/db/schema.sql'),
      'utf8',
    );
    await pgClient.exec(schemaSql);
    await pgClient.exec(schemaSql);
    const seedSummary = await seedAuthDatabase(pgClient);
    assert.ok(seedSummary.seededUsersCount >= 9, 'Expected seeded users to be created');

    const dbShim = {
      query: pgClient.query.bind(pgClient),
      exec: pgClient.exec.bind(pgClient),
      transaction: pgClient.transaction.bind(pgClient),
    } as unknown as DatabaseService;

    const redisStub = new InMemoryRedisStub();
    const jwks = new JwksService(testConfig);
    jwks.onModuleInit();
    const mailStub = {
      sendPasswordResetEmail: async () => undefined,
      sendEmailOtp: async () => undefined,
    } as unknown as MailService;

    const auditService = new AuditService(dbShim);
    const authService = new AuthService(
      testConfig,
      dbShim,
      redisStub as unknown as AuthRedisService,
      jwks,
      mailStub,
      auditService,
    );
    const oauthService = new OAuthService(
      testConfig,
      dbShim,
      redisStub as unknown as AuthRedisService,
      authService,
      auditService,
    );

    // -------------------------------------------------------------------------
    // TEST 0: Providers status, zero secret leak, redirect generation & state
    // -------------------------------------------------------------------------
    const providersStatus = oauthService.getProvidersStatus();
    assert.equal(providersStatus.google.enabled, true);
    assert.equal(providersStatus.github.enabled, false);
    assert.equal(providersStatus.adminExceptionConfigured, true);
    const serializedStatus = JSON.stringify(providersStatus);
    assert.ok(
      !serializedStatus.includes('TEST_GOOGLE_SECRET_VALUE_DO_NOT_LEAK'),
      'Client secret must NEVER appear in providers status',
    );
    assert.ok(
      !serializedStatus.includes('test-google-client-id'),
      'Client ID should not appear in providers status',
    );

    // Sanitize open redirects
    assert.equal(sanitizeOAuthReturnTo('//evil.com/steal', OAuthPortal.STOREFRONT), '/tai-khoan');
    assert.equal(sanitizeOAuthReturnTo('https://evil.com', OAuthPortal.STOREFRONT), '/tai-khoan');
    assert.equal(sanitizeOAuthReturnTo('/gio-hang', OAuthPortal.STOREFRONT), '/gio-hang');

    // Start Google OAuth
    const googleStart = await oauthService.startOAuth({
      providerRaw: 'google',
      portalRaw: 'storefront',
      returnToRaw: '/tai-khoan',
    });
    const googleUrl = new URL(googleStart.redirectUrl);
    assert.equal(googleUrl.origin, 'https://accounts.google.com');
    assert.equal(googleUrl.pathname, '/o/oauth2/v2/auth');
    assert.equal(googleUrl.searchParams.get('client_id'), testConfig.oauth.google.clientId);
    assert.equal(googleUrl.searchParams.get('redirect_uri'), testConfig.oauth.google.callbackUrl);
    assert.equal(googleUrl.searchParams.get('scope'), 'openid email profile');
    assert.equal(googleUrl.searchParams.get('prompt'), 'select_account');
    const generatedState = googleUrl.searchParams.get('state');
    assert.ok(generatedState && generatedState.length >= 32, 'Expected random CSRF state');

    // Cancelled callback consumes state once, replay fails with OAUTH_STATE_INVALID
    const cancelRes = await oauthService.handleOAuthCallback({
      providerRaw: 'google',
      state: generatedState,
      error: 'access_denied',
      req: createMockReq(),
    });
    const cancelUrl = new URL(cancelRes.redirectUrl);
    assert.equal(cancelUrl.pathname, '/dang-nhap');
    assert.equal(cancelUrl.searchParams.get('oauthErrorCode'), ErrorCode.OAUTH_CANCELLED);

    const replayStateRes = await oauthService.handleOAuthCallback({
      providerRaw: 'google',
      state: generatedState,
      code: 'fake-code',
      req: createMockReq(),
    });
    const replayStateUrl = new URL(replayStateRes.redirectUrl);
    assert.equal(replayStateUrl.searchParams.get('oauthErrorCode'), ErrorCode.OAUTH_STATE_INVALID);

    // Unconfigured GitHub redirects cleanly with OAUTH_NOT_CONFIGURED
    const githubStart = await oauthService.startOAuth({
      providerRaw: 'github',
      portalRaw: 'storefront',
    });
    const githubStartUrl = new URL(githubStart.redirectUrl);
    assert.equal(githubStartUrl.pathname, '/dang-nhap');
    assert.equal(githubStartUrl.searchParams.get('oauthErrorCode'), ErrorCode.OAUTH_NOT_CONFIGURED);

    console.log('PASS [0] Providers status, secret hygiene, CSRF state & unconfigured GitHub redirect');

    // -------------------------------------------------------------------------
    // TEST 1: Brand-new Google user on Storefront -> creates OAuth-only CUSTOMER
    // -------------------------------------------------------------------------
    const newGoogleEmail = 'google-fresh-customer@example.com';
    const googleRegResult = await oauthService.resolveOAuthProfileLogin({
      provider: OAuthProvider.GOOGLE,
      providerAccountId: 'google-sub-10001',
      email: newGoogleEmail,
      emailVerified: true,
      fullName: 'Lê Minh Anh Google',
      avatarUrl: 'https://lh3.googleusercontent.com/avatar-1',
      portal: OAuthPortal.STOREFRONT,
      ipAddress: '127.0.0.1',
      userAgent: 'policy-test',
    });
    assert.equal(googleRegResult.outcome, 'OAUTH_REGISTER');
    assert.equal(googleRegResult.loginResponse.mfaRequired, false);
    assert.equal(googleRegResult.loginResponse.user.email, newGoogleEmail);
    assert.equal(googleRegResult.loginResponse.user.authProvider, AuthProvider.GOOGLE);
    assert.deepEqual(googleRegResult.loginResponse.user.roles, [Role.CUSTOMER]);

    const dbNewUser = await pgClient.query<{ auth_provider: string; password_hash: string }>(
      'SELECT auth_provider, password_hash FROM users WHERE email = $1',
      [newGoogleEmail],
    );
    assert.equal(dbNewUser.rows[0]?.auth_provider, AuthProvider.GOOGLE);
    assert.ok(dbNewUser.rows[0]?.password_hash.startsWith('__OAUTH_ONLY__'));

    // Returning Google login succeeds
    const googleRelogin = await oauthService.resolveOAuthProfileLogin({
      provider: OAuthProvider.GOOGLE,
      providerAccountId: 'google-sub-10001',
      email: newGoogleEmail,
      emailVerified: true,
      fullName: 'Lê Minh Anh Google',
      avatarUrl: 'https://lh3.googleusercontent.com/avatar-1',
      portal: OAuthPortal.STOREFRONT,
    });
    assert.equal(googleRelogin.outcome, 'OAUTH_LOGIN');
    assert.equal(googleRelogin.loginResponse.user.authProvider, AuthProvider.GOOGLE);

    // Cross-provider GitHub login for the Google-created email is BLOCKED
    await expectApiError(
      () =>
        oauthService.resolveOAuthProfileLogin({
          provider: OAuthProvider.GITHUB,
          providerAccountId: 'gh-9991',
          email: newGoogleEmail,
          emailVerified: true,
          fullName: 'Lê Minh Anh GitHub',
          portal: OAuthPortal.STOREFRONT,
        }),
      409,
      ErrorCode.OAUTH_PROVIDER_MISMATCH,
    );

    console.log('PASS [1] New Google customer auto-created, repeat login works, GitHub cross-login blocked');

    // -------------------------------------------------------------------------
    // TEST 2: Google customer BLOCKED from password /register (409 EMAIL_BOUND_TO_OAUTH)
    // -------------------------------------------------------------------------
    const regMock = createMockRes();
    const regErr = await expectApiError(
      () =>
        authService.register(
          {
            email: newGoogleEmail,
            password: 'StrongPassword123!',
            fullName: 'Duplicate Attempt',
          },
          createMockReq(),
          regMock.res,
        ),
      409,
      ErrorCode.EMAIL_BOUND_TO_OAUTH,
    );
    assert.ok(regErr.message.includes('Google/GitHub'));

    console.log('PASS [2] Google customer blocked from /register with 409 EMAIL_BOUND_TO_OAUTH');

    // -------------------------------------------------------------------------
    // TEST 3: Google customer BLOCKED from password /login, /forgot-password, /change-password
    // -------------------------------------------------------------------------
    const loginMock = createMockRes();
    await expectApiError(
      () =>
        authService.login(
          { email: newGoogleEmail, password: 'AnyPassword123!' },
          createMockReq(),
          loginMock.res,
        ),
      403,
      ErrorCode.OAUTH_ONLY_ACCOUNT,
    );

    await expectApiError(
      () => authService.forgotPassword({ email: newGoogleEmail }, createMockReq()),
      403,
      ErrorCode.OAUTH_ONLY_ACCOUNT,
    );

    const googleJwtPayload = jwks.verifyAccessToken(googleRegResult.loginResponse.accessToken);
    const changePwdMock = createMockRes();
    await expectApiError(
      () =>
        authService.changePassword(
          googleJwtPayload,
          { currentPassword: 'OldPassword123!', newPassword: 'NewPassword456!' },
          createMockReq(),
          changePwdMock.res,
        ),
      403,
      ErrorCode.OAUTH_ONLY_ACCOUNT,
    );

    console.log('PASS [3] Google customer blocked from /login, /forgot-password, /change-password (403 OAUTH_ONLY_ACCOUNT)');

    // -------------------------------------------------------------------------
    // TEST 4: Existing LOCAL website accounts BLOCKED from Google & GitHub quick-login
    // -------------------------------------------------------------------------
    const localConflictErr = await expectApiError(
      () =>
        oauthService.resolveOAuthProfileLogin({
          provider: OAuthProvider.GOOGLE,
          providerAccountId: 'google-sub-local-conflict',
          email: 'customer@atelier.local',
          emailVerified: true,
          fullName: 'Local Customer',
          portal: OAuthPortal.STOREFRONT,
        }),
      409,
      ErrorCode.OAUTH_LOCAL_ACCOUNT_CONFLICT,
    );
    assert.ok(localConflictErr.message.includes('Email & Mật khẩu'));

    await expectApiError(
      () =>
        oauthService.resolveOAuthProfileLogin({
          provider: OAuthProvider.GITHUB,
          providerAccountId: 'gh-local-operator',
          email: 'operator@atelier.local',
          emailVerified: true,
          fullName: 'Local Operator',
          portal: OAuthPortal.ADMIN,
        }),
      409,
      ErrorCode.OAUTH_LOCAL_ACCOUNT_CONFLICT,
    );

    // Newly registered local user also blocked from Google quick-login
    const freshLocalEmail = 'local-registered@example.com';
    await authService.register(
      {
        email: freshLocalEmail,
        password: 'LocalUser2026!',
        fullName: 'Local Registered User',
      },
      createMockReq(),
      createMockRes().res,
    );
    await expectApiError(
      () =>
        oauthService.resolveOAuthProfileLogin({
          provider: OAuthProvider.GOOGLE,
          providerAccountId: 'google-sub-fresh-local',
          email: freshLocalEmail,
          emailVerified: true,
          fullName: 'Local Registered User',
          portal: OAuthPortal.STOREFRONT,
        }),
      409,
      ErrorCode.OAUTH_LOCAL_ACCOUNT_CONFLICT,
    );

    console.log('PASS [4] Existing & newly registered LOCAL accounts blocked from Google/GitHub (409 OAUTH_LOCAL_ACCOUNT_CONFLICT)');

    // -------------------------------------------------------------------------
    // TEST 5: Admin Exception (lebao01121@gmail.com) allowed via Google with SUPER_ADMIN + mfaVerified=true
    // -------------------------------------------------------------------------
    const adminOAuthResult = await oauthService.resolveOAuthProfileLogin({
      provider: OAuthProvider.GOOGLE,
      providerAccountId: 'google-sub-super-admin',
      email: SUPER_ADMIN_EMAIL,
      emailVerified: true,
      fullName: 'Le Bao Admin',
      avatarUrl: 'https://lh3.googleusercontent.com/admin-avatar',
      portal: OAuthPortal.ADMIN,
      ipAddress: '127.0.0.1',
      userAgent: 'policy-test-admin',
    });

    assert.equal(adminOAuthResult.outcome, 'ADMIN_EXCEPTION_LOGIN');
    assert.equal(adminOAuthResult.loginResponse.mfaRequired, false);
    assert.equal(adminOAuthResult.loginResponse.user.mfaVerified, true);
    assert.ok(adminOAuthResult.loginResponse.user.roles.includes(Role.SUPER_ADMIN));
    assert.equal(adminOAuthResult.loginResponse.user.authProvider, AuthProvider.LOCAL);

    const verifiedAdminJwt = jwks.verifyAccessToken(adminOAuthResult.loginResponse.accessToken);
    assert.equal(verifiedAdminJwt.mfaVerified, true);
    assert.ok(verifiedAdminJwt.roles.includes(Role.SUPER_ADMIN));

    // Confirm audit log AUTH_OAUTH_ADMIN_EXCEPTION_LOGIN written
    const auditRes = await pgClient.query<{ action: string }>(
      `SELECT action FROM audit_logs WHERE action = 'AUTH_OAUTH_ADMIN_EXCEPTION_LOGIN'`,
    );
    assert.equal(auditRes.rows.length, 1);

    // Confirm password login STILL works for lebao01121@gmail.com!
    const adminPwdLogin = await authService.login(
      { email: SUPER_ADMIN_EMAIL, password: SEED_PASSWORD_PLAIN },
      createMockReq(),
      createMockRes().res,
    );
    assert.ok(adminPwdLogin.user.roles.includes(Role.SUPER_ADMIN));
    assert.equal(adminPwdLogin.user.authProvider, AuthProvider.LOCAL);

    // Confirm GitHub IS ALSO covered by the Admin Exception for lebao01121@gmail.com
    const adminGithubResult = await oauthService.resolveOAuthProfileLogin({
      provider: OAuthProvider.GITHUB,
      providerAccountId: 'gh-admin-lebao',
      email: SUPER_ADMIN_EMAIL,
      emailVerified: true,
      fullName: 'Le Bao GitHub Admin',
      avatarUrl: 'https://avatars.githubusercontent.com/u/10001',
      portal: OAuthPortal.ADMIN,
      ipAddress: '127.0.0.1',
      userAgent: 'policy-test-admin-gh',
    });
    assert.equal(adminGithubResult.outcome, 'ADMIN_EXCEPTION_LOGIN');
    assert.equal(adminGithubResult.loginResponse.mfaRequired, false);
    assert.equal(adminGithubResult.loginResponse.user.mfaVerified, true);
    assert.ok(adminGithubResult.loginResponse.user.roles.includes(Role.SUPER_ADMIN));
    assert.equal(adminGithubResult.loginResponse.user.authProvider, AuthProvider.LOCAL);

    const auditResAfterGh = await pgClient.query<{ action: string }>(
      `SELECT action FROM audit_logs WHERE action = 'AUTH_OAUTH_ADMIN_EXCEPTION_LOGIN'`,
    );
    assert.equal(auditResAfterGh.rows.length, 2);

    console.log('PASS [5] Admin Exception (lebao01121@gmail.com) Google & GitHub quick-login keep SUPER_ADMIN + mfaVerified=true + LOCAL password intact');

    // -------------------------------------------------------------------------
    // TEST 6: Non-admin blocked on portal=admin (ZERO rogue account created) + unverified email blocked
    // -------------------------------------------------------------------------
    const rogueEmail = 'rogue-admin-attempt@example.com';
    await expectApiError(
      () =>
        oauthService.resolveOAuthProfileLogin({
          provider: OAuthProvider.GOOGLE,
          providerAccountId: 'google-sub-rogue',
          email: rogueEmail,
          emailVerified: true,
          fullName: 'Rogue User',
          portal: OAuthPortal.ADMIN,
        }),
      403,
      ErrorCode.ADMIN_OAUTH_FORBIDDEN,
    );

    const rogueCount = await pgClient.query<{ cnt: string | number }>(
      'SELECT COUNT(*)::int AS cnt FROM users WHERE email = $1',
      [rogueEmail],
    );
    assert.equal(Number(rogueCount.rows[0]?.cnt ?? 0), 0, 'Admin portal MUST NEVER auto-create a user');

    // Existing Google CUSTOMER blocked from Admin Portal
    await expectApiError(
      () =>
        oauthService.resolveOAuthProfileLogin({
          provider: OAuthProvider.GOOGLE,
          providerAccountId: 'google-sub-10001',
          email: newGoogleEmail,
          emailVerified: true,
          fullName: 'Lê Minh Anh Google',
          portal: OAuthPortal.ADMIN,
        }),
      403,
      ErrorCode.ADMIN_OAUTH_FORBIDDEN,
    );

    // Unverified email blocked
    await expectApiError(
      () =>
        oauthService.resolveOAuthProfileLogin({
          provider: OAuthProvider.GOOGLE,
          providerAccountId: 'google-sub-unverified',
          email: 'unverified@example.com',
          emailVerified: false,
          fullName: 'Unverified',
          portal: OAuthPortal.STOREFRONT,
        }),
      403,
      ErrorCode.OAUTH_EMAIL_UNVERIFIED,
    );

    console.log('PASS [6] Non-admin blocked on portal=admin (zero rogue account) & unverified email blocked');

    // -------------------------------------------------------------------------
    // TEST 7: Single-use oauthTicket exchange + HttpOnly cookie + zero JWT in URL
    // -------------------------------------------------------------------------
    const ticket = await oauthService.createOneTimeTicket(adminOAuthResult);
    const redirectUrl = oauthService.buildPortalTicketRedirectUrl(OAuthPortal.ADMIN, ticket);
    assert.ok(redirectUrl.includes(`oauthTicket=${ticket}`));
    assert.ok(!redirectUrl.includes(adminOAuthResult.loginResponse.accessToken), 'JWT must NEVER be in URL');
    assert.ok(!redirectUrl.includes('eyJ'), 'JWT prefix must NEVER be in URL');

    const exchangeMock = createMockRes();
    const exchanged = await oauthService.exchangeOAuthTicket(
      ticket,
      createMockReq(),
      exchangeMock.res,
    );
    assert.equal(exchanged.accessToken, adminOAuthResult.loginResponse.accessToken);
    assert.equal(exchanged.user.mfaVerified, true);
    const refreshCookie = exchangeMock.cookies.find((c) => c.name === REFRESH_COOKIE_NAME);
    const csrfCookie = exchangeMock.cookies.find((c) => c.name === CSRF_COOKIE_NAME);
    assert.ok(refreshCookie && refreshCookie.options.httpOnly === true, 'Expected HttpOnly refresh cookie');
    assert.ok(csrfCookie && csrfCookie.value === exchanged.csrfToken, 'Expected CSRF cookie');

    // Replaying same ticket fails atomically!
    await expectApiError(
      () => oauthService.exchangeOAuthTicket(ticket, createMockReq(), createMockRes().res),
      401,
      ErrorCode.OAUTH_TICKET_INVALID,
    );

    console.log('PASS [7] Single-use oauthTicket exchange sets HttpOnly cookie, zero JWT in URL, replay blocked');
    console.log('\nALL 8 OAUTH2 POLICY & SECURITY TEST SUITES PASSED 100%!');
  } finally {
    if (pgClient) {
      await pgClient.close();
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

run().catch((err) => {
  console.error('OAuth2 policy test failed:', err);
  process.exit(1);
});
