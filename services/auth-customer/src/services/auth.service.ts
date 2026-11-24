import * as crypto from 'node:crypto';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  ALL_PERMISSIONS,
  ALL_ROLES,
  AuditActorType,
  ErrorCode,
  isMfaRequiredForRoles,
  LoyaltyTier,
  Role,
  UserStatus,
  type JwtAccessPayload,
  type LoginRequest,
  type LoginResponse,
  type LoyaltyTier as LoyaltyTierValue,
  type Permission,
  type RefreshResponse,
  type RegisterRequest,
  type TotpSetupResponse,
  type UserStatus as UserStatusValue,
  type UserSummaryDto,
} from '@atelier/contracts';
import type { AtelierDbExecutor } from '@atelier/db-client';
import {
  ApiDomainException,
  extractBearerToken,
  extractClientIp,
  getCorrelationIdFromRequest,
  isHttpsRequest,
} from '../common/api-exception';
import { AUTH_CONFIG_TOKEN, type AuthCustomerConfig } from '../config/env';
import {
  constantTimeEqualString,
  generateCsrfToken,
  generateOpaqueToken,
  JwksService,
  sha256Hex,
} from '../crypto/jwks.service';
import { hashPassword, verifyPassword } from '../crypto/password';
import {
  buildOtpAuthUri,
  buildQrSvgDataUrl,
  decryptTotpSecret,
  encryptTotpSecret,
  generateNumericOtp,
  generateRecoveryCodes,
  generateTotpSecret,
  verifyTotpCode,
  type StoredRecoveryCode,
} from '../crypto/totp';
import { getDailyTryOnLimitForTier } from '../db/seed';
import { DatabaseService } from '../infra/database.service';
import { MailService } from '../infra/mail.service';
import { AuthRedisService } from '../infra/redis.service';
import { AuditService } from './audit.service';

export const REFRESH_COOKIE_NAME = 'atelier_refresh_token';
export const CSRF_COOKIE_NAME = 'atelier_csrf_token';

const VALID_ROLE_SET = new Set<string>(ALL_ROLES);
const VALID_PERMISSION_SET = new Set<string>(ALL_PERMISSIONS);

export interface UserDbRow {
  id: string;
  email: string;
  phone: string | null;
  password_hash: string;
  full_name: string;
  avatar_url: string | null;
  status: UserStatusValue;
  mfa_enabled: boolean;
  permission_version: number;
  loyalty_tier: LoyaltyTierValue;
  cod_trust_score: number;
  supplier_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface AuthSessionRow {
  id: string;
  user_id: string;
  refresh_token_hash: string;
  token_family_id: string;
  csrf_token: string | null;
  last_access_jti: string | null;
  device_info: string | null;
  ip_address: string | null;
  mfa_verified: boolean;
  expires_at: Date | string;
  revoked: boolean;
  created_at: Date | string;
}

interface TwoFactorRow {
  user_id: string;
  method: 'TOTP' | 'EMAIL_OTP';
  totp_secret_encrypted: string | null;
  recovery_codes_jsonb: unknown;
  verified_at: Date | string | null;
}

export interface VerifyAuthOptions {
  requireMfa?: boolean;
  requiredPermissions?: readonly Permission[];
  requireAdminPortalRole?: boolean;
}

export interface TwoFactorVerifyResponse {
  accessToken: string;
  csrfToken: string;
  mfaVerified: boolean;
  user: UserSummaryDto;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!local || !domain) {
    return email;
  }
  const visible = local.slice(0, Math.min(2, local.length));
  return `${visible}***@${domain}`;
}

function parseRecoveryCodes(raw: unknown): StoredRecoveryCode[] {
  let list: unknown = raw;
  if (typeof raw === 'string') {
    try {
      list = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(list)) {
    return [];
  }
  return list
    .filter(
      (item): item is StoredRecoveryCode =>
        typeof item === 'object' &&
        item !== null &&
        typeof (item as { hash?: unknown }).hash === 'string' &&
        typeof (item as { used?: unknown }).used === 'boolean',
    )
    .map((item) => ({ hash: item.hash, used: item.used }));
}

@Injectable()
export class AuthService {
  constructor(
    @Inject(AUTH_CONFIG_TOKEN) private readonly config: AuthCustomerConfig,
    private readonly db: DatabaseService,
    private readonly redis: AuthRedisService,
    private readonly jwks: JwksService,
    private readonly mail: MailService,
    private readonly audit: AuditService,
  ) {}

  async loadUserSummaryById(
    userId: string,
    executor?: AtelierDbExecutor,
    mfaVerifiedOverride?: boolean,
  ): Promise<UserSummaryDto | null> {
    const runner = executor ?? this.db;
    const userRes = await runner.query<UserDbRow>('SELECT * FROM users WHERE id = $1', [userId]);
    if (userRes.rows.length === 0) {
      return null;
    }
    return this.buildUserSummary(userRes.rows[0], runner, mfaVerifiedOverride);
  }

  async buildUserSummary(
    user: UserDbRow,
    executor?: AtelierDbExecutor,
    mfaVerifiedOverride?: boolean,
  ): Promise<UserSummaryDto> {
    const runner = executor ?? this.db;

    const rolesRes = await runner.query<{ code: string }>(
      `SELECT r.code
       FROM roles r
       INNER JOIN user_roles ur ON ur.role_id = r.id
       WHERE ur.user_id = $1
       ORDER BY r.code ASC`,
      [user.id],
    );
    const roles = rolesRes.rows
      .map((r) => r.code)
      .filter((code): code is Role => VALID_ROLE_SET.has(code));

    const permsRes = await runner.query<{ code: string }>(
      `SELECT DISTINCT p.code
       FROM permissions p
       INNER JOIN role_permissions rp ON rp.permission_id = p.id
       INNER JOIN user_roles ur ON ur.role_id = rp.role_id
       WHERE ur.user_id = $1
       ORDER BY p.code ASC`,
      [user.id],
    );
    const permissions = permsRes.rows
      .map((p) => p.code)
      .filter((code): code is Permission => VALID_PERMISSION_SET.has(code));

    return {
      id: user.id,
      email: user.email,
      fullName: user.full_name,
      phone: user.phone,
      status: user.status,
      roles,
      permissions,
      permissionVersion: Number(user.permission_version),
      mfaEnabled: Boolean(user.mfa_enabled),
      ...(mfaVerifiedOverride !== undefined ? { mfaVerified: mfaVerifiedOverride } : {}),
      supplierId: user.supplier_id,
      loyaltyTier: user.loyalty_tier,
      createdAt: toIso(user.created_at),
      updatedAt: toIso(user.updated_at),
    };
  }

  async authenticateRequest(
    req: Request,
    options: VerifyAuthOptions = {},
  ): Promise<JwtAccessPayload> {
    const token = extractBearerToken(req);
    if (!token) {
      throw new ApiDomainException(
        HttpStatus.UNAUTHORIZED,
        ErrorCode.UNAUTHORIZED,
        'Thiếu Authorization Bearer token.',
      );
    }

    let payload: JwtAccessPayload;
    try {
      payload = this.jwks.verifyAccessToken(token);
    } catch {
      throw new ApiDomainException(
        HttpStatus.UNAUTHORIZED,
        ErrorCode.UNAUTHORIZED,
        'Access token không hợp lệ hoặc đã hết hạn.',
      );
    }

    if (await this.redis.isJtiRevoked(payload.jti)) {
      throw new ApiDomainException(
        HttpStatus.UNAUTHORIZED,
        ErrorCode.UNAUTHORIZED,
        'Phiên đăng nhập đã bị thu hồi.',
      );
    }

    if (await this.redis.isUserLocked(payload.sub)) {
      throw new ApiDomainException(
        HttpStatus.FORBIDDEN,
        ErrorCode.PERMISSION_REVOKED,
        'Tài khoản đã bị khóa.',
      );
    }

    let currentPermVer = await this.redis.getUserPermissionVersion(payload.sub);
    if (currentPermVer === null) {
      const dbUser = await this.db.query<{ permission_version: number; status: string }>(
        'SELECT permission_version, status FROM users WHERE id = $1',
        [payload.sub],
      );
      if (dbUser.rows.length === 0) {
        throw new ApiDomainException(
          HttpStatus.UNAUTHORIZED,
          ErrorCode.UNAUTHORIZED,
          'Tài khoản không tồn tại.',
        );
      }
      const row = dbUser.rows[0];
      currentPermVer = Number(row.permission_version);
      await this.redis.setUserPermissionVersion(payload.sub, currentPermVer);
      if (row.status === UserStatus.LOCKED) {
        await this.redis.setUserLocked(payload.sub, true);
        throw new ApiDomainException(
          HttpStatus.FORBIDDEN,
          ErrorCode.PERMISSION_REVOKED,
          'Tài khoản đã bị khóa.',
        );
      }
    }

    if (currentPermVer > payload.permissionVersion) {
      throw new ApiDomainException(
        HttpStatus.FORBIDDEN,
        ErrorCode.PERMISSION_REVOKED,
        'Quyền hạn của tài khoản đã thay đổi. Vui lòng đăng nhập lại hoặc làm mới phiên.',
      );
    }

    if (options.requireMfa && isMfaRequiredForRoles(payload.roles) && !payload.mfaVerified) {
      throw new ApiDomainException(
        HttpStatus.FORBIDDEN,
        ErrorCode.MFA_REQUIRED,
        'Tài khoản yêu cầu xác thực 2 lớp (2FA) trước khi truy cập tài nguyên này.',
      );
    }

    if (options.requiredPermissions && options.requiredPermissions.length > 0) {
      const isSuperAdmin = payload.roles.includes(Role.SUPER_ADMIN);
      const allowed =
        isSuperAdmin ||
        options.requiredPermissions.some((perm) => payload.permissions.includes(perm));
      if (!allowed) {
        throw new ApiDomainException(
          HttpStatus.FORBIDDEN,
          ErrorCode.FORBIDDEN,
          'Bạn không có quyền thực hiện thao tác này.',
        );
      }
    }

    return payload;
  }

  validateCsrfAndOrigin(req: Request): string {
    const originHeader = this.extractRequestOrigin(req);
    if (!originHeader || !this.isOriginAllowed(originHeader)) {
      throw new ApiDomainException(
        HttpStatus.FORBIDDEN,
        ErrorCode.CSRF_INVALID,
        'Origin không hợp lệ hoặc bị từ chối bởi chính sách bảo vệ CSRF.',
      );
    }

    const rawHeaderToken = req.headers['x-csrf-token'];
    const headerToken = Array.isArray(rawHeaderToken) ? rawHeaderToken[0] : rawHeaderToken;
    const cookieToken = this.getCookie(req, CSRF_COOKIE_NAME);

    if (
      !headerToken ||
      !cookieToken ||
      headerToken.trim().length === 0 ||
      !constantTimeEqualString(headerToken.trim(), cookieToken.trim())
    ) {
      throw new ApiDomainException(
        HttpStatus.FORBIDDEN,
        ErrorCode.CSRF_INVALID,
        'Thiếu hoặc sai mã bảo vệ CSRF (X-CSRF-Token).',
      );
    }

    return headerToken.trim();
  }

  async register(input: RegisterRequest, req: Request, res: Response): Promise<LoginResponse> {
    const email = input.email.trim().toLowerCase();
    const phone = input.phone?.trim() || null;
    const correlationId = getCorrelationIdFromRequest(req);
    const ipAddress = extractClientIp(req);

    const existingEmail = await this.db.query<{ id: string }>(
      'SELECT id FROM users WHERE LOWER(email) = LOWER($1)',
      [email],
    );
    if (existingEmail.rows.length > 0) {
      throw new ApiDomainException(
        HttpStatus.CONFLICT,
        ErrorCode.CONFLICT,
        'Email đã được đăng ký trong hệ thống.',
      );
    }

    if (phone) {
      const existingPhone = await this.db.query<{ id: string }>(
        'SELECT id FROM users WHERE phone = $1',
        [phone],
      );
      if (existingPhone.rows.length > 0) {
        throw new ApiDomainException(
          HttpStatus.CONFLICT,
          ErrorCode.CONFLICT,
          'Số điện thoại đã được sử dụng.',
        );
      }
    }

    const userId = crypto.randomUUID();
    const passwordHash = hashPassword(input.password);

    const userSummary = await this.db.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO users (
          id, email, phone, password_hash, full_name, status,
          mfa_enabled, permission_version, loyalty_tier, cod_trust_score, supplier_id
        ) VALUES ($1, $2, $3, $4, $5, $6, FALSE, 1, $7, 100, NULL)`,
        [
          userId,
          email,
          phone,
          passwordHash,
          input.fullName.trim(),
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

      await this.audit.record(
        {
          actorId: userId,
          actorEmail: email,
          actorType: AuditActorType.USER,
          action: 'USER_REGISTERED',
          resourceType: 'user',
          resourceId: userId,
          afterJsonb: { email, fullName: input.fullName.trim(), role: Role.CUSTOMER },
          correlationId,
          ipAddress,
        },
        tx,
      );

      const summary = await this.loadUserSummaryById(userId, tx, false);
      if (!summary) {
        throw new Error('Failed to load newly created user.');
      }
      return summary;
    });

    await this.redis.setUserPermissionVersion(userSummary.id, userSummary.permissionVersion);
    await this.redis.setUserLocked(userSummary.id, false);

    const { accessToken, csrfToken } = await this.createFreshSessionAndTokens({
      user: userSummary,
      mfaVerified: false,
      req,
      res,
    });

    return {
      accessToken,
      csrfToken,
      mfaRequired: false,
      user: userSummary,
    };
  }

  async login(input: LoginRequest, req: Request, res: Response): Promise<LoginResponse> {
    const email = input.email.trim().toLowerCase();
    const userRes = await this.db.query<UserDbRow>(
      'SELECT * FROM users WHERE LOWER(email) = LOWER($1)',
      [email],
    );

    if (userRes.rows.length === 0) {
      throw new ApiDomainException(
        HttpStatus.UNAUTHORIZED,
        ErrorCode.UNAUTHORIZED,
        'Email hoặc mật khẩu không chính xác.',
      );
    }

    const userRow = userRes.rows[0];
    if (!verifyPassword(input.password, userRow.password_hash)) {
      throw new ApiDomainException(
        HttpStatus.UNAUTHORIZED,
        ErrorCode.UNAUTHORIZED,
        'Email hoặc mật khẩu không chính xác.',
      );
    }

    if (userRow.status === UserStatus.LOCKED) {
      await this.redis.setUserLocked(userRow.id, true);
      throw new ApiDomainException(
        HttpStatus.FORBIDDEN,
        ErrorCode.PERMISSION_REVOKED,
        'Tài khoản đã bị khóa. Vui lòng liên hệ quản trị viên.',
      );
    }

    if (userRow.status !== UserStatus.ACTIVE) {
      throw new ApiDomainException(
        HttpStatus.FORBIDDEN,
        ErrorCode.FORBIDDEN,
        'Tài khoản chưa được kích hoạt.',
      );
    }

    const summaryWithoutMfa = await this.buildUserSummary(userRow);
    const requiresMfa = isMfaRequiredForRoles(summaryWithoutMfa.roles) || Boolean(userRow.mfa_enabled);
    let mfaVerified = false;

    if (requiresMfa && input.totpCode && input.totpCode.trim().length > 0) {
      const verified = await this.tryVerifyTotpOrRecovery(userRow.id, input.totpCode.trim());
      if (verified) {
        mfaVerified = true;
      }
    }

    const mfaRequired = requiresMfa && !mfaVerified;
    const userSummary: UserSummaryDto = {
      ...summaryWithoutMfa,
      mfaVerified,
    };

    await this.redis.setUserPermissionVersion(userSummary.id, userSummary.permissionVersion);
    await this.redis.setUserLocked(userSummary.id, false);

    const { accessToken, csrfToken } = await this.createFreshSessionAndTokens({
      user: userSummary,
      mfaVerified,
      req,
      res,
    });

    return {
      accessToken,
      csrfToken,
      mfaRequired,
      user: userSummary,
    };
  }

  async refresh(req: Request, res: Response): Promise<RefreshResponse> {
    const headerCsrf = this.validateCsrfAndOrigin(req);
    const rawRefreshToken = this.getCookie(req, REFRESH_COOKIE_NAME);

    if (!rawRefreshToken) {
      throw new ApiDomainException(
        HttpStatus.UNAUTHORIZED,
        ErrorCode.UNAUTHORIZED,
        'Không tìm thấy refresh token trong phiên.',
      );
    }

    const tokenHash = sha256Hex(rawRefreshToken);
    const sessionRes = await this.db.query<AuthSessionRow>(
      'SELECT * FROM auth_sessions WHERE refresh_token_hash = $1',
      [tokenHash],
    );

    if (sessionRes.rows.length === 0) {
      throw new ApiDomainException(
        HttpStatus.UNAUTHORIZED,
        ErrorCode.UNAUTHORIZED,
        'Refresh token không hợp lệ.',
      );
    }

    const session = sessionRes.rows[0];
    const familyAlreadyRevoked = await this.redis.isTokenFamilyRevoked(session.token_family_id);

    if (session.revoked || familyAlreadyRevoked) {
      await this.handleTokenReuseAttack(session, req, res);
    }

    if (new Date(session.expires_at).getTime() <= Date.now()) {
      await this.db.query('UPDATE auth_sessions SET revoked = TRUE WHERE id = $1', [session.id]);
      this.clearAuthCookies(req, res);
      throw new ApiDomainException(
        HttpStatus.UNAUTHORIZED,
        ErrorCode.UNAUTHORIZED,
        'Refresh token đã hết hạn. Vui lòng đăng nhập lại.',
      );
    }

    if (session.csrf_token && !constantTimeEqualString(session.csrf_token, headerCsrf)) {
      throw new ApiDomainException(
        HttpStatus.FORBIDDEN,
        ErrorCode.CSRF_INVALID,
        'Mã bảo vệ CSRF không khớp với phiên đăng nhập.',
      );
    }

    const userRes = await this.db.query<UserDbRow>('SELECT * FROM users WHERE id = $1', [
      session.user_id,
    ]);
    if (userRes.rows.length === 0) {
      this.clearAuthCookies(req, res);
      throw new ApiDomainException(
        HttpStatus.UNAUTHORIZED,
        ErrorCode.UNAUTHORIZED,
        'Tài khoản không còn tồn tại.',
      );
    }

    const userRow = userRes.rows[0];
    if (userRow.status !== UserStatus.ACTIVE) {
      await this.db.query('UPDATE auth_sessions SET revoked = TRUE WHERE token_family_id = $1', [
        session.token_family_id,
      ]);
      this.clearAuthCookies(req, res);
      throw new ApiDomainException(
        HttpStatus.FORBIDDEN,
        ErrorCode.PERMISSION_REVOKED,
        'Tài khoản đã bị khóa hoặc tạm ngừng hoạt động.',
      );
    }

    const userSummary = await this.buildUserSummary(userRow, undefined, Boolean(session.mfa_verified));
    const rotated = await this.rotateSessionAtomic({
      previousSession: session,
      user: userSummary,
      mfaVerified: Boolean(session.mfa_verified),
      req,
      res,
    });

    await this.redis.setUserPermissionVersion(userSummary.id, userSummary.permissionVersion);

    return {
      accessToken: rotated.accessToken,
      csrfToken: rotated.csrfToken,
      user: userSummary,
    };
  }

  async logout(req: Request, res: Response): Promise<{ loggedOut: boolean }> {
    this.validateCsrfAndOrigin(req);

    const rawRefreshToken = this.getCookie(req, REFRESH_COOKIE_NAME);
    if (rawRefreshToken) {
      const tokenHash = sha256Hex(rawRefreshToken);
      const sessionRes = await this.db.query<AuthSessionRow>(
        'SELECT * FROM auth_sessions WHERE refresh_token_hash = $1',
        [tokenHash],
      );
      if (sessionRes.rows.length > 0) {
        const session = sessionRes.rows[0];
        const familyRows = await this.db.query<{ last_access_jti: string | null }>(
          'SELECT last_access_jti FROM auth_sessions WHERE token_family_id = $1',
          [session.token_family_id],
        );
        await this.db.query(
          'UPDATE auth_sessions SET revoked = TRUE WHERE token_family_id = $1',
          [session.token_family_id],
        );
        await this.redis.revokeTokenFamily(session.token_family_id);
        for (const row of familyRows.rows) {
          if (row.last_access_jti) {
            await this.redis.revokeJti(row.last_access_jti, this.config.jwt.accessTtlSeconds);
          }
        }
      }
    }

    const bearer = extractBearerToken(req);
    if (bearer) {
      try {
        const payload = this.jwks.verifyAccessToken(bearer);
        const remaining = Math.max(60, payload.exp - Math.floor(Date.now() / 1000));
        await this.redis.revokeJti(payload.jti, remaining);
      } catch {
        // Ignore expired/invalid access token during logout
      }
    }

    this.clearAuthCookies(req, res);
    return { loggedOut: true };
  }

  async getMe(authUser: JwtAccessPayload): Promise<UserSummaryDto> {
    const summary = await this.loadUserSummaryById(authUser.sub, undefined, authUser.mfaVerified);
    if (!summary) {
      throw new ApiDomainException(
        HttpStatus.NOT_FOUND,
        ErrorCode.NOT_FOUND,
        'Không tìm thấy thông tin người dùng.',
      );
    }
    return summary;
  }

  async setupTotp(authUser: JwtAccessPayload): Promise<TotpSetupResponse> {
    const secret = generateTotpSecret(20);
    const encryptedSecret = encryptTotpSecret(secret, this.config.security.mfaEncryptionKey);
    const { plaintextCodes, storedCodes } = generateRecoveryCodes(8);
    const otpauthUri = buildOtpAuthUri(authUser.email, secret, 'Fashion Atelier');
    const qrSvgDataUrl = buildQrSvgDataUrl(otpauthUri, secret);

    await this.db.query(
      `INSERT INTO two_factor_auth (user_id, method, totp_secret_encrypted, recovery_codes_jsonb, verified_at)
       VALUES ($1, 'TOTP', $2, $3::jsonb, NULL)
       ON CONFLICT (user_id) DO UPDATE
       SET method = 'TOTP',
           totp_secret_encrypted = EXCLUDED.totp_secret_encrypted,
           recovery_codes_jsonb = EXCLUDED.recovery_codes_jsonb,
           verified_at = NULL`,
      [authUser.sub, encryptedSecret, JSON.stringify(storedCodes)],
    );

    return {
      secret,
      otpauthUri,
      qrSvgDataUrl,
      recoveryCodes: plaintextCodes,
    };
  }

  async verifyTotp(
    authUser: JwtAccessPayload,
    code: string,
    req: Request,
    res: Response,
  ): Promise<TwoFactorVerifyResponse> {
    const verified = await this.tryVerifyTotpOrRecovery(authUser.sub, code.trim());
    if (!verified) {
      throw new ApiDomainException(
        HttpStatus.UNAUTHORIZED,
        ErrorCode.UNAUTHORIZED,
        'Mã TOTP hoặc mã khôi phục không hợp lệ.',
      );
    }

    await this.db.query(
      `UPDATE two_factor_auth SET verified_at = NOW() WHERE user_id = $1`,
      [authUser.sub],
    );
    await this.db.query(
      `UPDATE users SET mfa_enabled = TRUE, updated_at = NOW() WHERE id = $1`,
      [authUser.sub],
    );

    await this.audit.record({
      actorId: authUser.sub,
      actorEmail: authUser.email,
      actorType: AuditActorType.USER,
      action: 'MFA_TOTP_VERIFIED',
      resourceType: 'two_factor_auth',
      resourceId: authUser.sub,
      afterJsonb: { method: 'TOTP', mfaVerified: true },
      correlationId: getCorrelationIdFromRequest(req),
      ipAddress: extractClientIp(req),
    });

    return this.upgradeSessionToMfaVerified(authUser, req, res);
  }

  async sendEmailOtp(
    authUser: JwtAccessPayload,
    purpose: string = 'MFA_LOGIN',
  ): Promise<{ sent: boolean; maskedEmail: string; expiresInSeconds: number; purpose: string }> {
    const userRes = await this.db.query<Pick<UserDbRow, 'id' | 'email' | 'full_name'>>(
      'SELECT id, email, full_name FROM users WHERE id = $1',
      [authUser.sub],
    );
    if (userRes.rows.length === 0) {
      throw new ApiDomainException(
        HttpStatus.NOT_FOUND,
        ErrorCode.NOT_FOUND,
        'Không tìm thấy tài khoản người dùng.',
      );
    }

    const user = userRes.rows[0];
    const otpCode = generateNumericOtp(6);
    const ttlSeconds = 300;

    await this.redis.setEmailOtp(user.id, otpCode, ttlSeconds);

    try {
      await this.mail.sendEmailOtp({
        to: user.email,
        fullName: user.full_name,
        otpCode,
        purpose,
      });
    } catch (error) {
      throw new ApiDomainException(
        HttpStatus.SERVICE_UNAVAILABLE,
        ErrorCode.DEPENDENCY_UNAVAILABLE,
        'Không thể gửi email OTP qua máy chủ SMTP lúc này.',
        { detail: error instanceof Error ? error.message : String(error) },
      );
    }

    return {
      sent: true,
      maskedEmail: maskEmail(user.email),
      expiresInSeconds: ttlSeconds,
      purpose,
    };
  }

  async verifyEmailOtp(
    authUser: JwtAccessPayload,
    code: string,
    req: Request,
    res: Response,
  ): Promise<TwoFactorVerifyResponse> {
    const normalized = code.replace(/\s+/g, '');
    const expectedOtp = await this.redis.getEmailOtp(authUser.sub);

    if (!expectedOtp || !constantTimeEqualString(normalized, expectedOtp)) {
      throw new ApiDomainException(
        HttpStatus.UNAUTHORIZED,
        ErrorCode.UNAUTHORIZED,
        'Mã OTP Email không đúng hoặc đã hết hạn.',
      );
    }

    await this.redis.deleteEmailOtp(authUser.sub);

    await this.db.query(
      `INSERT INTO two_factor_auth (user_id, method, totp_secret_encrypted, recovery_codes_jsonb, verified_at)
       VALUES ($1, 'EMAIL_OTP', NULL, '[]'::jsonb, NOW())
       ON CONFLICT (user_id) DO UPDATE
       SET method = 'EMAIL_OTP',
           verified_at = NOW()`,
      [authUser.sub],
    );

    await this.db.query(
      `UPDATE users SET mfa_enabled = TRUE, updated_at = NOW() WHERE id = $1`,
      [authUser.sub],
    );

    await this.audit.record({
      actorId: authUser.sub,
      actorEmail: authUser.email,
      actorType: AuditActorType.USER,
      action: 'MFA_EMAIL_OTP_VERIFIED',
      resourceType: 'two_factor_auth',
      resourceId: authUser.sub,
      afterJsonb: { method: 'EMAIL_OTP', mfaVerified: true },
      correlationId: getCorrelationIdFromRequest(req),
      ipAddress: extractClientIp(req),
    });

    return this.upgradeSessionToMfaVerified(authUser, req, res);
  }

  private async tryVerifyTotpOrRecovery(userId: string, candidateCode: string): Promise<boolean> {
    const res = await this.db.query<TwoFactorRow>(
      'SELECT * FROM two_factor_auth WHERE user_id = $1',
      [userId],
    );
    if (res.rows.length === 0) {
      return false;
    }

    const row = res.rows[0];
    if (row.totp_secret_encrypted) {
      try {
        const secret = decryptTotpSecret(
          row.totp_secret_encrypted,
          this.config.security.mfaEncryptionKey,
        );
        if (verifyTotpCode(secret, candidateCode, 1)) {
          return true;
        }
      } catch {
        // Continue to check recovery codes
      }
    }

    const recoveryCodes = parseRecoveryCodes(row.recovery_codes_jsonb);
    const candidateHash = sha256Hex(candidateCode.toUpperCase());
    const idx = recoveryCodes.findIndex(
      (entry) => !entry.used && constantTimeEqualString(entry.hash, candidateHash),
    );
    if (idx !== -1) {
      recoveryCodes[idx].used = true;
      await this.db.query(
        'UPDATE two_factor_auth SET recovery_codes_jsonb = $1::jsonb WHERE user_id = $2',
        [JSON.stringify(recoveryCodes), userId],
      );
      return true;
    }

    return false;
  }

  private async upgradeSessionToMfaVerified(
    authUser: JwtAccessPayload,
    req: Request,
    res: Response,
  ): Promise<TwoFactorVerifyResponse> {
    const userSummary = await this.loadUserSummaryById(authUser.sub, undefined, true);
    if (!userSummary) {
      throw new ApiDomainException(
        HttpStatus.NOT_FOUND,
        ErrorCode.NOT_FOUND,
        'Không tìm thấy tài khoản.',
      );
    }

    const activeSession = await this.findActiveSessionForUpgrade(authUser, req);
    let accessToken: string;
    let csrfToken: string;

    if (activeSession) {
      const rotated = await this.rotateSessionAtomic({
        previousSession: activeSession,
        user: userSummary,
        mfaVerified: true,
        req,
        res,
      });
      accessToken = rotated.accessToken;
      csrfToken = rotated.csrfToken;
    } else {
      const created = await this.createFreshSessionAndTokens({
        user: userSummary,
        mfaVerified: true,
        req,
        res,
      });
      accessToken = created.accessToken;
      csrfToken = created.csrfToken;
    }

    await this.redis.setUserPermissionVersion(userSummary.id, userSummary.permissionVersion);

    return {
      accessToken,
      csrfToken,
      mfaVerified: true,
      user: userSummary,
    };
  }

  private async findActiveSessionForUpgrade(
    authUser: JwtAccessPayload,
    req: Request,
  ): Promise<AuthSessionRow | null> {
    const rawRefresh = this.getCookie(req, REFRESH_COOKIE_NAME);
    if (rawRefresh) {
      const hash = sha256Hex(rawRefresh);
      const byCookie = await this.db.query<AuthSessionRow>(
        `SELECT * FROM auth_sessions
         WHERE refresh_token_hash = $1 AND user_id = $2 AND revoked = FALSE AND expires_at > NOW()
         LIMIT 1`,
        [hash, authUser.sub],
      );
      if (byCookie.rows.length > 0) {
        return byCookie.rows[0];
      }
    }

    const byJti = await this.db.query<AuthSessionRow>(
      `SELECT * FROM auth_sessions
       WHERE last_access_jti = $1 AND user_id = $2 AND revoked = FALSE AND expires_at > NOW()
       ORDER BY created_at DESC
       LIMIT 1`,
      [authUser.jti, authUser.sub],
    );
    if (byJti.rows.length > 0) {
      return byJti.rows[0];
    }

    const latest = await this.db.query<AuthSessionRow>(
      `SELECT * FROM auth_sessions
       WHERE user_id = $1 AND revoked = FALSE AND expires_at > NOW()
       ORDER BY created_at DESC
       LIMIT 1`,
      [authUser.sub],
    );
    return latest.rows[0] ?? null;
  }

  private async createFreshSessionAndTokens(params: {
    user: UserSummaryDto;
    mfaVerified: boolean;
    req: Request;
    res: Response;
  }): Promise<{ accessToken: string; csrfToken: string }> {
    const { user, mfaVerified, req, res } = params;
    const refreshToken = generateOpaqueToken(48);
    const refreshTokenHash = sha256Hex(refreshToken);
    const tokenFamilyId = crypto.randomUUID();
    const csrfToken = generateCsrfToken();

    const { token: accessToken, payload } = this.jwks.signAccessToken({
      sub: user.id,
      email: user.email,
      roles: user.roles,
      permissions: user.permissions,
      permissionVersion: user.permissionVersion,
      mfaVerified,
      supplierId: user.supplierId,
      loyaltyTier: user.loyaltyTier,
    });

    const expiresAt = new Date(Date.now() + this.config.jwt.refreshTtlSeconds * 1000);
    const userAgent =
      typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'].slice(0, 255) : null;
    const ipAddress = extractClientIp(req);

    await this.db.query(
      `INSERT INTO auth_sessions (
        id, user_id, refresh_token_hash, token_family_id, csrf_token, last_access_jti,
        device_info, ip_address, mfa_verified, expires_at, revoked, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, FALSE, NOW())`,
      [
        crypto.randomUUID(),
        user.id,
        refreshTokenHash,
        tokenFamilyId,
        csrfToken,
        payload.jti,
        userAgent,
        ipAddress,
        mfaVerified,
        expiresAt.toISOString(),
      ],
    );

    this.setAuthCookies(req, res, refreshToken, csrfToken);
    return { accessToken, csrfToken };
  }

  private async rotateSessionAtomic(params: {
    previousSession: AuthSessionRow;
    user: UserSummaryDto;
    mfaVerified: boolean;
    req: Request;
    res: Response;
  }): Promise<{ accessToken: string; csrfToken: string }> {
    const { previousSession, user, mfaVerified, req, res } = params;
    const newRefreshToken = generateOpaqueToken(48);
    const newRefreshTokenHash = sha256Hex(newRefreshToken);
    const newCsrfToken = generateCsrfToken();

    const { token: accessToken, payload } = this.jwks.signAccessToken({
      sub: user.id,
      email: user.email,
      roles: user.roles,
      permissions: user.permissions,
      permissionVersion: user.permissionVersion,
      mfaVerified,
      supplierId: user.supplierId,
      loyaltyTier: user.loyaltyTier,
    });

    const expiresAt = new Date(Date.now() + this.config.jwt.refreshTtlSeconds * 1000);
    const userAgent =
      typeof req.headers['user-agent'] === 'string'
        ? req.headers['user-agent'].slice(0, 255)
        : previousSession.device_info;
    const ipAddress = extractClientIp(req);

    const rotatedOk = await this.db.transaction(async (tx) => {
      const updated = await tx.query<{ id: string }>(
        `UPDATE auth_sessions
         SET revoked = TRUE
         WHERE id = $1 AND revoked = FALSE
         RETURNING id`,
        [previousSession.id],
      );
      if (updated.rows.length === 0) {
        return false;
      }

      await tx.query(
        `INSERT INTO auth_sessions (
          id, user_id, refresh_token_hash, token_family_id, csrf_token, last_access_jti,
          device_info, ip_address, mfa_verified, expires_at, revoked, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, FALSE, NOW())`,
        [
          crypto.randomUUID(),
          user.id,
          newRefreshTokenHash,
          previousSession.token_family_id,
          newCsrfToken,
          payload.jti,
          userAgent,
          ipAddress,
          mfaVerified,
          expiresAt.toISOString(),
        ],
      );
      return true;
    });

    if (!rotatedOk) {
      await this.handleTokenReuseAttack(previousSession, req, res);
    }

    this.setAuthCookies(req, res, newRefreshToken, newCsrfToken);
    return { accessToken, csrfToken: newCsrfToken };
  }

  private async handleTokenReuseAttack(
    session: AuthSessionRow,
    req: Request,
    res: Response,
  ): Promise<never> {
    const familySessions = await this.db.query<{ id: string; last_access_jti: string | null }>(
      'SELECT id, last_access_jti FROM auth_sessions WHERE token_family_id = $1',
      [session.token_family_id],
    );

    await this.db.query(
      'UPDATE auth_sessions SET revoked = TRUE WHERE token_family_id = $1',
      [session.token_family_id],
    );

    await this.redis.revokeTokenFamily(
      session.token_family_id,
      this.config.jwt.refreshTtlSeconds,
    );

    for (const row of familySessions.rows) {
      if (row.last_access_jti) {
        await this.redis.revokeJti(row.last_access_jti, this.config.jwt.accessTtlSeconds);
      }
    }

    await this.audit.record({
      actorId: session.user_id,
      actorType: AuditActorType.SYSTEM,
      action: 'TOKEN_REUSE_DETECTED',
      resourceType: 'auth_session',
      resourceId: session.token_family_id,
      beforeJsonb: {
        replayedSessionId: session.id,
        tokenFamilyId: session.token_family_id,
      },
      afterJsonb: {
        familyRevoked: true,
        revokedSessionCount: familySessions.rows.length,
      },
      correlationId: getCorrelationIdFromRequest(req),
      ipAddress: extractClientIp(req),
    });

    this.clearAuthCookies(req, res);

    throw new ApiDomainException(
      HttpStatus.UNAUTHORIZED,
      ErrorCode.TOKEN_REUSE_DETECTED,
      'Phát hiện tái sử dụng refresh token đã xoay vòng! Toàn bộ phiên trong chuỗi token đã bị thu hồi ngay lập tức.',
    );
  }

  private setAuthCookies(
    req: Request,
    res: Response,
    refreshToken: string,
    csrfToken: string,
  ): void {
    const secure = isHttpsRequest(req);
    const maxAgeMs = this.config.jwt.refreshTtlSeconds * 1000;

    res.cookie(REFRESH_COOKIE_NAME, refreshToken, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      secure,
      maxAge: maxAgeMs,
    });

    res.cookie(CSRF_COOKIE_NAME, csrfToken, {
      httpOnly: false,
      sameSite: 'lax',
      path: '/',
      secure,
      maxAge: maxAgeMs,
    });
  }

  private clearAuthCookies(req: Request, res: Response): void {
    const secure = isHttpsRequest(req);
    res.clearCookie(REFRESH_COOKIE_NAME, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      secure,
    });
    res.clearCookie(CSRF_COOKIE_NAME, {
      httpOnly: false,
      sameSite: 'lax',
      path: '/',
      secure,
    });
  }

  private getCookie(req: Request, name: string): string | null {
    const cookies = (req as Request & { cookies?: Record<string, unknown> }).cookies;
    const fromParsed = cookies?.[name];
    if (typeof fromParsed === 'string' && fromParsed.trim().length > 0) {
      return fromParsed.trim();
    }

    const rawHeader = req.headers.cookie;
    if (typeof rawHeader === 'string' && rawHeader.length > 0) {
      for (const pair of rawHeader.split(';')) {
        const idx = pair.indexOf('=');
        if (idx <= 0) {
          continue;
        }
        const key = pair.slice(0, idx).trim();
        if (key === name) {
          return decodeURIComponent(pair.slice(idx + 1).trim());
        }
      }
    }

    return null;
  }

  private extractRequestOrigin(req: Request): string | null {
    const rawOrigin = req.headers.origin;
    if (typeof rawOrigin === 'string' && rawOrigin.trim().length > 0) {
      return rawOrigin.trim().replace(/\/+$/, '');
    }

    const rawReferer = req.headers.referer;
    if (typeof rawReferer === 'string' && rawReferer.trim().length > 0) {
      try {
        return new URL(rawReferer).origin;
      } catch {
        return null;
      }
    }

    return null;
  }

  private isOriginAllowed(origin: string): boolean {
    if (this.config.security.allowedOrigins.includes(origin)) {
      return true;
    }
    return /^https:\/\/([a-z0-9-]+\.)?localhost(:\d+)?$/i.test(origin);
  }
}
