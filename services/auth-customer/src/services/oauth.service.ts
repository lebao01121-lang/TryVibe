import * as crypto from 'node:crypto';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  AuditActorType,
  AuthProvider,
  canAccessPortal,
  ErrorCode,
  isMfaRequiredForRoles,
  LoyaltyTier,
  OAuthPortal,
  OAuthProvider,
  Portal,
  Role,
  UserStatus,
  type ErrorCode as ErrorCodeValue,
  type LoginResponse,
  type OAuthPortal as OAuthPortalValue,
  type OAuthProvider as OAuthProviderValue,
  type OAuthProvidersStatusResponse,
} from '@atelier/contracts';
import { createLogger } from '@atelier/observability';
import {
  ApiDomainException,
  extractClientIp,
  getCorrelationIdFromRequest,
} from '../common/api-exception';
import { AUTH_CONFIG_TOKEN, type AuthCustomerConfig } from '../config/env';
import { getDailyTryOnLimitForTier } from '../db/seed';
import { DatabaseService } from '../infra/database.service';
import { AuthRedisService } from '../infra/redis.service';
import { AuditService } from './audit.service';
import { AuthService, type UserDbRow } from './auth.service';

const OAUTH_STATE_TTL_SECONDS = 600;
const OAUTH_TICKET_TTL_SECONDS = 120;
const OAUTH_HTTP_TIMEOUT_MS = 12_000;

interface StoredOAuthState {
  provider: OAuthProviderValue;
  portal: OAuthPortalValue;
  returnTo: string;
  createdAt: string;
}

interface StoredOAuthTicketPayload {
  userId: string;
  sessionId: string;
  refreshToken: string;
  csrfToken: string;
  loginResponse: LoginResponse;
  createdAt: string;
}

export interface ResolveOAuthProfileInput {
  provider: OAuthProviderValue;
  providerAccountId: string;
  email: string;
  emailVerified: boolean;
  fullName: string;
  avatarUrl?: string | null;
  portal: OAuthPortalValue;
  ipAddress?: string | null;
  userAgent?: string | null;
  correlationId?: string | null;
}

export interface ResolveOAuthProfileResult {
  outcome: 'ADMIN_EXCEPTION_LOGIN' | 'OAUTH_LOGIN' | 'OAUTH_REGISTER';
  sessionId: string;
  refreshToken: string;
  csrfToken: string;
  loginResponse: LoginResponse;
}

interface VerifiedOAuthProfile {
  providerAccountId: string;
  email: string;
  emailVerified: boolean;
  fullName: string;
  avatarUrl: string | null;
}

export function sanitizeOAuthReturnTo(
  raw: string | undefined,
  portal: OAuthPortalValue,
): string {
  const fallback = portal === OAuthPortal.ADMIN ? '/' : '/tai-khoan';
  if (!raw || typeof raw !== 'string') {
    return fallback;
  }
  const trimmed = raw.trim();
  if (
    !trimmed.startsWith('/') ||
    trimmed.startsWith('//') ||
    trimmed.includes('\\') ||
    /[\r\n]/.test(trimmed)
  ) {
    return fallback;
  }
  return trimmed.slice(0, 256);
}

@Injectable()
export class OAuthService {
  private readonly logger = createLogger('@atelier/auth-customer:oauth');

  constructor(
    @Inject(AUTH_CONFIG_TOKEN) private readonly config: AuthCustomerConfig,
    private readonly db: DatabaseService,
    private readonly redis: AuthRedisService,
    private readonly authService: AuthService,
    private readonly audit: AuditService,
  ) {}

  getProvidersStatus(): OAuthProvidersStatusResponse {
    return {
      google: {
        enabled: this.config.oauth.google.enabled,
        callbackUrl: this.config.oauth.google.callbackUrl,
      },
      github: {
        enabled: this.config.oauth.github.enabled,
        callbackUrl: this.config.oauth.github.callbackUrl,
      },
      adminExceptionConfigured: this.config.oauth.adminExceptionEmails.length > 0,
    };
  }

  parseProvider(raw: string | undefined): OAuthProviderValue | null {
    const normalized = (raw ?? '').trim().toUpperCase();
    if (normalized === OAuthProvider.GOOGLE) {
      return OAuthProvider.GOOGLE;
    }
    if (normalized === OAuthProvider.GITHUB) {
      return OAuthProvider.GITHUB;
    }
    return null;
  }

  parsePortal(raw: unknown): OAuthPortalValue {
    const normalized = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
    return normalized === OAuthPortal.ADMIN ? OAuthPortal.ADMIN : OAuthPortal.STOREFRONT;
  }

  buildPortalErrorRedirectUrl(
    portal: OAuthPortalValue,
    code: ErrorCodeValue,
    message: string,
  ): string {
    const base =
      portal === OAuthPortal.ADMIN
        ? `${this.config.oauth.adminRedirectBase}/`
        : `${this.config.oauth.storefrontRedirectBase}/dang-nhap`;
    const url = new URL(base);
    url.searchParams.set('oauthErrorCode', code);
    url.searchParams.set('oauthError', message);
    return url.toString();
  }

  buildPortalTicketRedirectUrl(
    portal: OAuthPortalValue,
    ticket: string,
    returnTo?: string,
  ): string {
    const base =
      portal === OAuthPortal.ADMIN
        ? `${this.config.oauth.adminRedirectBase}/`
        : `${this.config.oauth.storefrontRedirectBase}/dang-nhap`;
    const url = new URL(base);
    url.searchParams.set('oauthTicket', ticket);
    if (portal === OAuthPortal.STOREFRONT) {
      const safeReturnTo = sanitizeOAuthReturnTo(returnTo, portal);
      url.searchParams.set('returnTo', safeReturnTo);
    }
    return url.toString();
  }

  async startOAuth(params: {
    providerRaw: string;
    portalRaw?: string;
    returnToRaw?: string;
  }): Promise<{ redirectUrl: string }> {
    const portal = this.parsePortal(params.portalRaw);
    const returnTo = sanitizeOAuthReturnTo(params.returnToRaw, portal);
    const provider = this.parseProvider(params.providerRaw);

    if (!provider) {
      return {
        redirectUrl: this.buildPortalErrorRedirectUrl(
          portal,
          ErrorCode.OAUTH_PROVIDER_ERROR,
          'Nhà cung cấp đăng nhập nhanh không được hỗ trợ.',
        ),
      };
    }

    const providerCfg =
      provider === OAuthProvider.GOOGLE ? this.config.oauth.google : this.config.oauth.github;

    if (!providerCfg.enabled) {
      const label = provider === OAuthProvider.GOOGLE ? 'Google' : 'GitHub';
      const missingEnvHint =
        provider === OAuthProvider.GOOGLE
          ? 'GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET'
          : 'GITHUB_OAUTH_CLIENT_ID / GITHUB_OAUTH_CLIENT_SECRET';
      return {
        redirectUrl: this.buildPortalErrorRedirectUrl(
          portal,
          ErrorCode.OAUTH_NOT_CONFIGURED,
          `Đăng nhập nhanh bằng ${label} chưa được cấu hình (vui lòng bổ sung ${missingEnvHint} trong tệp .env).`,
        ),
      };
    }

    const state = crypto.randomBytes(24).toString('hex');
    const statePayload: StoredOAuthState = {
      provider,
      portal,
      returnTo,
      createdAt: new Date().toISOString(),
    };
    await this.redis.setOAuthState(state, JSON.stringify(statePayload), OAUTH_STATE_TTL_SECONDS);

    if (provider === OAuthProvider.GOOGLE) {
      const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      authUrl.searchParams.set('client_id', providerCfg.clientId);
      authUrl.searchParams.set('redirect_uri', providerCfg.callbackUrl);
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('scope', 'openid email profile');
      authUrl.searchParams.set('prompt', 'select_account');
      authUrl.searchParams.set('state', state);
      return { redirectUrl: authUrl.toString() };
    }

    const authUrl = new URL('https://github.com/login/oauth/authorize');
    authUrl.searchParams.set('client_id', providerCfg.clientId);
    authUrl.searchParams.set('redirect_uri', providerCfg.callbackUrl);
    authUrl.searchParams.set('scope', 'read:user user:email');
    authUrl.searchParams.set('state', state);
    return { redirectUrl: authUrl.toString() };
  }

  async handleOAuthCallback(params: {
    providerRaw: string;
    code?: string;
    state?: string;
    error?: string;
    errorDescription?: string;
    req: Request;
  }): Promise<{ redirectUrl: string }> {
    const provider = this.parseProvider(params.providerRaw);
    const correlationId = getCorrelationIdFromRequest(params.req);
    const ipAddress = extractClientIp(params.req);
    const userAgent =
      typeof params.req.headers['user-agent'] === 'string'
        ? params.req.headers['user-agent'].slice(0, 255)
        : null;

    let storedState: StoredOAuthState | null = null;
    if (params.state && params.state.trim().length > 0) {
      const rawState = await this.redis.consumeOAuthState(params.state.trim());
      if (rawState) {
        try {
          storedState = JSON.parse(rawState) as StoredOAuthState;
        } catch {
          storedState = null;
        }
      }
    }

    const portal = storedState?.portal ?? OAuthPortal.STOREFRONT;
    const returnTo = storedState?.returnTo ?? (portal === OAuthPortal.ADMIN ? '/' : '/tai-khoan');

    if (params.error && params.error.trim().length > 0) {
      const normalizedErr = params.error.trim().toLowerCase();
      if (normalizedErr === 'access_denied' || normalizedErr === 'user_cancelled') {
        return {
          redirectUrl: this.buildPortalErrorRedirectUrl(
            portal,
            ErrorCode.OAUTH_CANCELLED,
            'Bạn đã hủy quá trình đăng nhập nhanh.',
          ),
        };
      }
      return {
        redirectUrl: this.buildPortalErrorRedirectUrl(
          portal,
          ErrorCode.OAUTH_PROVIDER_ERROR,
          'Nhà cung cấp OAuth2 trả về lỗi xác thực. Vui lòng thử lại.',
        ),
      };
    }

    if (!provider) {
      return {
        redirectUrl: this.buildPortalErrorRedirectUrl(
          portal,
          ErrorCode.OAUTH_PROVIDER_ERROR,
          'Nhà cung cấp đăng nhập nhanh không hợp lệ.',
        ),
      };
    }

    if (!storedState || storedState.provider !== provider || !params.code?.trim()) {
      return {
        redirectUrl: this.buildPortalErrorRedirectUrl(
          portal,
          ErrorCode.OAUTH_STATE_INVALID,
          'Phiên xác thực OAuth2 không hợp lệ hoặc đã hết hạn. Vui lòng thử lại.',
        ),
      };
    }

    const providerCfg =
      provider === OAuthProvider.GOOGLE ? this.config.oauth.google : this.config.oauth.github;
    if (!providerCfg.enabled) {
      const label = provider === OAuthProvider.GOOGLE ? 'Google' : 'GitHub';
      return {
        redirectUrl: this.buildPortalErrorRedirectUrl(
          portal,
          ErrorCode.OAUTH_NOT_CONFIGURED,
          `Đăng nhập nhanh bằng ${label} chưa được cấu hình.`,
        ),
      };
    }

    try {
      const profile =
        provider === OAuthProvider.GOOGLE
          ? await this.exchangeGoogleCodeForProfile(params.code.trim())
          : await this.exchangeGitHubCodeForProfile(params.code.trim());

      const resolved = await this.resolveOAuthProfileLogin({
        provider,
        providerAccountId: profile.providerAccountId,
        email: profile.email,
        emailVerified: profile.emailVerified,
        fullName: profile.fullName,
        avatarUrl: profile.avatarUrl,
        portal,
        ipAddress,
        userAgent,
        correlationId,
      });

      const ticket = await this.createOneTimeTicket(resolved);
      return {
        redirectUrl: this.buildPortalTicketRedirectUrl(portal, ticket, returnTo),
      };
    } catch (error) {
      if (error instanceof ApiDomainException) {
        return {
          redirectUrl: this.buildPortalErrorRedirectUrl(portal, error.code, error.message),
        };
      }

      this.logger.warn(
        {
          err: error instanceof Error ? error.message : String(error),
          provider,
          portal,
          correlationId,
        },
        'OAuth2 callback exchange failed unexpectedly',
      );
      return {
        redirectUrl: this.buildPortalErrorRedirectUrl(
          portal,
          ErrorCode.OAUTH_PROVIDER_ERROR,
          'Không thể xác thực với nhà cung cấp Google/GitHub lúc này. Vui lòng thử lại.',
        ),
      };
    }
  }

  async createOneTimeTicket(resolved: ResolveOAuthProfileResult): Promise<string> {
    const ticket = crypto.randomBytes(32).toString('hex');
    const payload: StoredOAuthTicketPayload = {
      userId: resolved.loginResponse.user.id,
      sessionId: resolved.sessionId,
      refreshToken: resolved.refreshToken,
      csrfToken: resolved.csrfToken,
      loginResponse: resolved.loginResponse,
      createdAt: new Date().toISOString(),
    };
    await this.redis.setOAuthTicket(
      ticket,
      JSON.stringify(payload),
      OAUTH_TICKET_TTL_SECONDS,
    );
    return ticket;
  }

  async exchangeOAuthTicket(
    ticket: string,
    req: Request,
    res: Response,
  ): Promise<LoginResponse> {
    const normalizedTicket = ticket.trim();
    const raw = await this.redis.consumeOAuthTicket(normalizedTicket);
    if (!raw) {
      throw new ApiDomainException(
        HttpStatus.UNAUTHORIZED,
        ErrorCode.OAUTH_TICKET_INVALID,
        'Mã phiên đăng nhập nhanh không hợp lệ, đã được sử dụng hoặc đã hết hạn. Vui lòng đăng nhập lại.',
      );
    }

    let payload: StoredOAuthTicketPayload;
    try {
      payload = JSON.parse(raw) as StoredOAuthTicketPayload;
    } catch {
      throw new ApiDomainException(
        HttpStatus.UNAUTHORIZED,
        ErrorCode.OAUTH_TICKET_INVALID,
        'Dữ liệu phiên đăng nhập nhanh không hợp lệ.',
      );
    }

    if (!payload.refreshToken || !payload.csrfToken || !payload.loginResponse) {
      throw new ApiDomainException(
        HttpStatus.UNAUTHORIZED,
        ErrorCode.OAUTH_TICKET_INVALID,
        'Phiên đăng nhập nhanh không đầy đủ thông tin.',
      );
    }

    this.authService.applyOAuthCookies(req, res, payload.refreshToken, payload.csrfToken);
    return payload.loginResponse;
  }

  /**
   * Core OAuth2 account-separation policy engine.
   * Extracted as a directly testable method so automated suites can verify
   * every policy branch deterministically without live Google/GitHub tokens.
   */
  async resolveOAuthProfileLogin(
    input: ResolveOAuthProfileInput,
  ): Promise<ResolveOAuthProfileResult> {
    const email = input.email.trim().toLowerCase();
    const providerAccountId = input.providerAccountId.trim();
    const avatarUrl = input.avatarUrl?.trim() || null;
    const provider = input.provider;
    const portal = input.portal;
    const correlationId = input.correlationId ?? null;
    const ipAddress = input.ipAddress ?? '127.0.0.1';
    const userAgent = input.userAgent ?? null;

    if (!email || !providerAccountId || !input.emailVerified) {
      throw new ApiDomainException(
        HttpStatus.FORBIDDEN,
        ErrorCode.OAUTH_EMAIL_UNVERIFIED,
        'Tài khoản Google/GitHub của bạn chưa xác minh địa chỉ email nên không thể đăng nhập nhanh.',
      );
    }

    const isAdminOAuthException =
      (provider === OAuthProvider.GOOGLE || provider === OAuthProvider.GITHUB) &&
      this.config.oauth.adminExceptionEmails.includes(email);

    // Look up existing user by email first, or by linked (provider, provider_account_id)
    let userRow: UserDbRow | null = null;
    const byEmailRes = await this.db.query<UserDbRow>(
      'SELECT * FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1',
      [email],
    );
    if (byEmailRes.rows.length > 0) {
      userRow = byEmailRes.rows[0];
    } else {
      const byLinkRes = await this.db.query<UserDbRow>(
        `SELECT u.*
         FROM users u
         INNER JOIN user_oauth_accounts oa ON oa.user_id = u.id
         WHERE oa.provider = $1 AND oa.provider_account_id = $2
         LIMIT 1`,
        [provider, providerAccountId],
      );
      if (byLinkRes.rows.length > 0) {
        userRow = byLinkRes.rows[0];
      }
    }

    // -------------------------------------------------------------------------
    // POLICY A: Admin Exception (e.g. lebao01121@gmail.com) + GOOGLE / GITHUB
    // Preserves auth_provider='LOCAL' (password + 2FA still work) and ALL roles
    // (SUPER_ADMIN), grants mfaVerified=true quick-login session.
    // -------------------------------------------------------------------------
    if (isAdminOAuthException) {
      if (!userRow) {
        throw new ApiDomainException(
          HttpStatus.FORBIDDEN,
          ErrorCode.ADMIN_OAUTH_FORBIDDEN,
          'Không tìm thấy tài khoản quản trị ngoại lệ trong hệ thống.',
        );
      }
      this.assertUserActiveForOAuth(userRow);

      const adminUserSummary = await this.db.transaction(async (tx) => {
        await this.upsertOAuthAccountLink(tx, {
          userId: userRow.id,
          provider,
          providerAccountId,
          email,
          avatarUrl,
        });

        if (avatarUrl && !userRow.avatar_url) {
          await tx.query(
            `UPDATE users
             SET avatar_url = $1, updated_at = NOW()
             WHERE id = $2 AND (avatar_url IS NULL OR avatar_url = '')`,
            [avatarUrl, userRow.id],
          );
        }

        const summary = await this.authService.loadUserSummaryById(userRow.id, tx, true);
        if (!summary) {
          throw new Error('Failed to load admin exception user summary.');
        }

        if (portal === OAuthPortal.ADMIN && !canAccessPortal(summary.roles, Portal.ADMIN_PORTAL)) {
          throw new ApiDomainException(
            HttpStatus.FORBIDDEN,
            ErrorCode.ADMIN_OAUTH_FORBIDDEN,
            'Tài khoản này không có quyền quản trị trên TryVibe Admin Portal.',
          );
        }

        await this.audit.record(
          {
            actorId: summary.id,
            actorEmail: summary.email,
            actorType: AuditActorType.USER,
            action: 'AUTH_OAUTH_ADMIN_EXCEPTION_LOGIN',
            resourceType: 'auth_session',
            resourceId: summary.id,
            afterJsonb: {
              provider,
              portal,
              roles: summary.roles,
              authProviderPreserved: summary.authProvider ?? AuthProvider.LOCAL,
              mfaVerified: true,
            },
            correlationId,
            ipAddress,
          },
          tx,
        );

        return summary;
      });

      await this.redis.setUserPermissionVersion(
        adminUserSummary.id,
        adminUserSummary.permissionVersion,
      );
      await this.redis.setUserLocked(adminUserSummary.id, false);

      const sessionPayload = await this.authService.createOAuthSessionPayload({
        user: adminUserSummary,
        mfaVerified: true,
        mfaRequired: false,
        ipAddress,
        userAgent,
      });

      return {
        outcome: 'ADMIN_EXCEPTION_LOGIN',
        ...sessionPayload,
      };
    }

    // -------------------------------------------------------------------------
    // POLICY B: Existing User Found (NOT Admin Google Exception)
    // Strict account separation: LOCAL accounts cannot use OAuth quick-login,
    // and GOOGLE/GITHUB accounts cannot cross over to the other provider.
    // -------------------------------------------------------------------------
    if (userRow) {
      const existingAuthProvider = (userRow.auth_provider ?? AuthProvider.LOCAL).toUpperCase();

      if (existingAuthProvider === AuthProvider.LOCAL) {
        throw new ApiDomainException(
          HttpStatus.CONFLICT,
          ErrorCode.OAUTH_LOCAL_ACCOUNT_CONFLICT,
          'Email này đã được đăng ký tài khoản trên website. Không thể đăng nhập nhanh bằng Google/GitHub — vui lòng đăng nhập bằng Email & Mật khẩu.',
          { authProvider: AuthProvider.LOCAL, attemptedProvider: provider },
        );
      }

      if (existingAuthProvider !== provider) {
        const boundLabel = existingAuthProvider === AuthProvider.GOOGLE ? 'Google' : 'GitHub';
        const attemptedLabel = provider === OAuthProvider.GOOGLE ? 'Google' : 'GitHub';
        throw new ApiDomainException(
          HttpStatus.CONFLICT,
          ErrorCode.OAUTH_PROVIDER_MISMATCH,
          `Email này đã được tạo qua đăng nhập nhanh ${boundLabel} nên không thể đăng nhập bằng ${attemptedLabel}. Vui lòng tiếp tục đăng nhập bằng ${boundLabel}.`,
          { authProvider: existingAuthProvider, attemptedProvider: provider },
        );
      }

      this.assertUserActiveForOAuth(userRow);

      const existingSummary = await this.authService.buildUserSummary(userRow);
      if (
        portal === OAuthPortal.ADMIN &&
        !canAccessPortal(existingSummary.roles, Portal.ADMIN_PORTAL)
      ) {
        throw new ApiDomainException(
          HttpStatus.FORBIDDEN,
          ErrorCode.ADMIN_OAUTH_FORBIDDEN,
          'Tài khoản này không có quyền quản trị trên TryVibe Admin Portal.',
        );
      }

      const refreshedSummary = await this.db.transaction(async (tx) => {
        await this.upsertOAuthAccountLink(tx, {
          userId: userRow.id,
          provider,
          providerAccountId,
          email,
          avatarUrl,
        });

        if (avatarUrl && !userRow.avatar_url) {
          await tx.query(
            `UPDATE users
             SET avatar_url = $1, updated_at = NOW()
             WHERE id = $2 AND (avatar_url IS NULL OR avatar_url = '')`,
            [avatarUrl, userRow.id],
          );
        }

        const loaded = await this.authService.loadUserSummaryById(userRow.id, tx, false);
        if (!loaded) {
          throw new Error('Failed to reload OAuth user summary.');
        }

        await this.audit.record(
          {
            actorId: loaded.id,
            actorEmail: loaded.email,
            actorType: AuditActorType.USER,
            action: 'AUTH_OAUTH_LOGIN',
            resourceType: 'auth_session',
            resourceId: loaded.id,
            afterJsonb: {
              provider,
              portal,
              roles: loaded.roles,
            },
            correlationId,
            ipAddress,
          },
          tx,
        );

        return loaded;
      });

      await this.redis.setUserPermissionVersion(
        refreshedSummary.id,
        refreshedSummary.permissionVersion,
      );
      await this.redis.setUserLocked(refreshedSummary.id, false);

      const mfaRequired =
        isMfaRequiredForRoles(refreshedSummary.roles) || Boolean(userRow.mfa_enabled);
      const sessionPayload = await this.authService.createOAuthSessionPayload({
        user: refreshedSummary,
        mfaVerified: false,
        mfaRequired,
        ipAddress,
        userAgent,
      });

      return {
        outcome: 'OAUTH_LOGIN',
        ...sessionPayload,
      };
    }

    // -------------------------------------------------------------------------
    // POLICY C: Brand-New Email (not in `users`)
    // NEVER auto-create a user from Admin Portal. On Storefront, create an
    // isolated OAuth-only CUSTOMER account (`auth_provider = 'GOOGLE' | 'GITHUB'`).
    // -------------------------------------------------------------------------
    if (portal === OAuthPortal.ADMIN) {
      throw new ApiDomainException(
        HttpStatus.FORBIDDEN,
        ErrorCode.ADMIN_OAUTH_FORBIDDEN,
        'Tài khoản này không có quyền quản trị trên TryVibe Admin Portal.',
      );
    }

    const userId = crypto.randomUUID();
    const oauthOnlyPasswordHash = `__OAUTH_ONLY__${crypto.randomBytes(32).toString('hex')}`;
    const displayName = (
      input.fullName?.trim() ||
      email.split('@')[0] ||
      'Khách hàng TryVibe'
    ).slice(0, 160);

    const createdSummary = await this.db.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO users (
          id, email, phone, password_hash, full_name, avatar_url, auth_provider,
          status, is_active, mfa_enabled, permission_version, loyalty_tier,
          cod_trust_score, supplier_id
        ) VALUES ($1, $2, NULL, $3, $4, $5, $6, $7, TRUE, FALSE, 1, $8, 100, NULL)`,
        [
          userId,
          email,
          oauthOnlyPasswordHash,
          displayName,
          avatarUrl,
          provider,
          UserStatus.ACTIVE,
          LoyaltyTier.BRONZE,
        ],
      );

      const customerRole = await tx.query<{ id: string }>(
        'SELECT id FROM roles WHERE code = $1',
        [Role.CUSTOMER],
      );
      if (customerRole.rows.length > 0) {
        await tx.query(
          `INSERT INTO user_roles (user_id, role_id)
           VALUES ($1, $2)
           ON CONFLICT (user_id, role_id) DO NOTHING`,
          [userId, customerRole.rows[0].id],
        );
      }

      await tx.query(
        `INSERT INTO tryon_quotas (user_id, daily_limit, used_today, reset_at)
         VALUES ($1, $2, 0, NOW() + INTERVAL '1 day')
         ON CONFLICT (user_id) DO NOTHING`,
        [userId, getDailyTryOnLimitForTier(LoyaltyTier.BRONZE)],
      );

      await this.upsertOAuthAccountLink(tx, {
        userId,
        provider,
        providerAccountId,
        email,
        avatarUrl,
      });

      await this.audit.record(
        {
          actorId: userId,
          actorEmail: email,
          actorType: AuditActorType.USER,
          action: 'AUTH_OAUTH_REGISTER',
          resourceType: 'user',
          resourceId: userId,
          afterJsonb: {
            email,
            fullName: displayName,
            authProvider: provider,
            role: Role.CUSTOMER,
            portal,
          },
          correlationId,
          ipAddress,
        },
        tx,
      );

      const summary = await this.authService.loadUserSummaryById(userId, tx, false);
      if (!summary) {
        throw new Error('Failed to load newly created OAuth user.');
      }
      return summary;
    });

    await this.redis.setUserPermissionVersion(createdSummary.id, createdSummary.permissionVersion);
    await this.redis.setUserLocked(createdSummary.id, false);

    const sessionPayload = await this.authService.createOAuthSessionPayload({
      user: createdSummary,
      mfaVerified: false,
      mfaRequired: false,
      ipAddress,
      userAgent,
    });

    return {
      outcome: 'OAUTH_REGISTER',
      ...sessionPayload,
    };
  }

  private assertUserActiveForOAuth(userRow: UserDbRow): void {
    if (
      userRow.status === UserStatus.LOCKED ||
      userRow.is_active === false ||
      Boolean(userRow.deleted_at)
    ) {
      throw new ApiDomainException(
        HttpStatus.FORBIDDEN,
        ErrorCode.PERMISSION_REVOKED,
        'Tài khoản đã bị khóa hoặc vô hiệu hóa. Vui lòng liên hệ quản trị viên.',
      );
    }
    if (userRow.status !== UserStatus.ACTIVE) {
      throw new ApiDomainException(
        HttpStatus.FORBIDDEN,
        ErrorCode.FORBIDDEN,
        'Tài khoản chưa được kích hoạt.',
      );
    }
  }

  private async upsertOAuthAccountLink(
    tx: Pick<DatabaseService, 'query'>,
    params: {
      userId: string;
      provider: OAuthProviderValue;
      providerAccountId: string;
      email: string;
      avatarUrl: string | null;
    },
  ): Promise<void> {
    await tx.query(
      `INSERT INTO user_oauth_accounts (
        id, user_id, provider, provider_account_id, email, avatar_url, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
      ON CONFLICT (user_id, provider) DO UPDATE
      SET provider_account_id = EXCLUDED.provider_account_id,
          email = EXCLUDED.email,
          avatar_url = COALESCE(EXCLUDED.avatar_url, user_oauth_accounts.avatar_url),
          updated_at = NOW()`,
      [
        crypto.randomUUID(),
        params.userId,
        params.provider,
        params.providerAccountId,
        params.email,
        params.avatarUrl,
      ],
    );
  }

  private async exchangeGoogleCodeForProfile(code: string): Promise<VerifiedOAuthProfile> {
    const cfg = this.config.oauth.google;
    const tokenBody = new URLSearchParams({
      code,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      redirect_uri: cfg.callbackUrl,
      grant_type: 'authorization_code',
    });

    const tokenRes = await this.fetchWithTimeout('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: tokenBody.toString(),
    });

    if (!tokenRes.ok) {
      throw new ApiDomainException(
        HttpStatus.BAD_GATEWAY,
        ErrorCode.OAUTH_PROVIDER_ERROR,
        'Không thể trao đổi mã xác thực với Google OAuth2. Vui lòng thử lại.',
      );
    }

    const tokenJson = (await tokenRes.json()) as { access_token?: string };
    if (!tokenJson.access_token) {
      throw new ApiDomainException(
        HttpStatus.BAD_GATEWAY,
        ErrorCode.OAUTH_PROVIDER_ERROR,
        'Google OAuth2 không trả về access token hợp lệ.',
      );
    }

    const userInfoRes = await this.fetchWithTimeout(
      'https://openidconnect.googleapis.com/v1/userinfo',
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${tokenJson.access_token}`,
          Accept: 'application/json',
        },
      },
    );

    if (!userInfoRes.ok) {
      throw new ApiDomainException(
        HttpStatus.BAD_GATEWAY,
        ErrorCode.OAUTH_PROVIDER_ERROR,
        'Không thể lấy thông tin tài khoản từ Google.',
      );
    }

    const profile = (await userInfoRes.json()) as {
      sub?: string;
      email?: string;
      email_verified?: boolean;
      name?: string;
      picture?: string;
    };

    if (!profile.sub || !profile.email) {
      throw new ApiDomainException(
        HttpStatus.BAD_GATEWAY,
        ErrorCode.OAUTH_PROVIDER_ERROR,
        'Hồ sơ Google không chứa đầy đủ định danh email.',
      );
    }

    if (profile.email_verified !== true) {
      throw new ApiDomainException(
        HttpStatus.FORBIDDEN,
        ErrorCode.OAUTH_EMAIL_UNVERIFIED,
        'Email trên tài khoản Google của bạn chưa được xác minh nên không thể đăng nhập nhanh.',
      );
    }

    return {
      providerAccountId: String(profile.sub),
      email: profile.email.trim().toLowerCase(),
      emailVerified: true,
      fullName: profile.name?.trim() || profile.email.split('@')[0] || 'Khách hàng TryVibe',
      avatarUrl: profile.picture?.trim() || null,
    };
  }

  private async exchangeGitHubCodeForProfile(code: string): Promise<VerifiedOAuthProfile> {
    const cfg = this.config.oauth.github;
    const tokenRes = await this.fetchWithTimeout('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
        code,
        redirect_uri: cfg.callbackUrl,
      }),
    });

    if (!tokenRes.ok) {
      throw new ApiDomainException(
        HttpStatus.BAD_GATEWAY,
        ErrorCode.OAUTH_PROVIDER_ERROR,
        'Không thể trao đổi mã xác thực với GitHub OAuth2. Vui lòng thử lại.',
      );
    }

    const tokenJson = (await tokenRes.json()) as {
      access_token?: string;
      error?: string;
    };
    if (!tokenJson.access_token || tokenJson.error) {
      throw new ApiDomainException(
        HttpStatus.BAD_GATEWAY,
        ErrorCode.OAUTH_PROVIDER_ERROR,
        'GitHub OAuth2 không trả về access token hợp lệ.',
      );
    }

    const ghHeaders = {
      Authorization: `Bearer ${tokenJson.access_token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'TryVibe-Fashion-Atelier',
    };

    const [userRes, emailsRes] = await Promise.all([
      this.fetchWithTimeout('https://api.github.com/user', {
        method: 'GET',
        headers: ghHeaders,
      }),
      this.fetchWithTimeout('https://api.github.com/user/emails', {
        method: 'GET',
        headers: ghHeaders,
      }),
    ]);

    if (!userRes.ok) {
      throw new ApiDomainException(
        HttpStatus.BAD_GATEWAY,
        ErrorCode.OAUTH_PROVIDER_ERROR,
        'Không thể lấy thông tin hồ sơ từ GitHub.',
      );
    }

    const ghUser = (await userRes.json()) as {
      id?: number | string;
      login?: string;
      name?: string | null;
      email?: string | null;
      avatar_url?: string | null;
    };

    let verifiedEmail: string | null = null;
    if (emailsRes.ok) {
      const emails = (await emailsRes.json()) as Array<{
        email?: string;
        primary?: boolean;
        verified?: boolean;
      }>;
      if (Array.isArray(emails)) {
        const primaryVerified = emails.find((e) => e.primary && e.verified && e.email);
        const anyVerified = emails.find((e) => e.verified && e.email);
        verifiedEmail = (primaryVerified?.email ?? anyVerified?.email ?? null)?.trim().toLowerCase() || null;
      }
    }

    if (!ghUser.id) {
      throw new ApiDomainException(
        HttpStatus.BAD_GATEWAY,
        ErrorCode.OAUTH_PROVIDER_ERROR,
        'Hồ sơ GitHub không trả về định danh hợp lệ.',
      );
    }

    if (!verifiedEmail) {
      throw new ApiDomainException(
        HttpStatus.FORBIDDEN,
        ErrorCode.OAUTH_EMAIL_UNVERIFIED,
        'Tài khoản GitHub của bạn chưa có email chính đã xác minh (verified primary email).',
      );
    }

    return {
      providerAccountId: String(ghUser.id),
      email: verifiedEmail,
      emailVerified: true,
      fullName:
        ghUser.name?.trim() ||
        ghUser.login?.trim() ||
        verifiedEmail.split('@')[0] ||
        'Khách hàng TryVibe',
      avatarUrl: ghUser.avatar_url?.trim() || null,
    };
  }

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<globalThis.Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), OAUTH_HTTP_TIMEOUT_MS);
    try {
      return await fetch(url, {
        ...init,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }
}
