import * as crypto from 'node:crypto';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { Request, Response } from 'express';
import nodemailer from 'nodemailer';
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
  is_active?: boolean | null;
  deleted_at?: Date | string | null;
  mfa_enabled: boolean;
  permission_version: number;
  loyalty_tier: LoyaltyTierValue;
  cod_trust_score: number;
  supplier_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

export interface ExtendedUserSummaryDto extends UserSummaryDto {
  isActive?: boolean;
  deletedAt?: string | null;
  codTrustScore?: number;
  vipTier?: LoyaltyTierValue;
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

export interface ForgotPasswordResponse {
  sent: boolean;
  expiresInSeconds: number;
  message: string;
}

export interface ResetPasswordResponse {
  reset: boolean;
  message: string;
}

export interface ChangePasswordResponse {
  changed: boolean;
  accessToken: string;
  csrfToken: string;
  user: UserSummaryDto;
  message: string;
}

interface StoredPasswordResetRecord {
  userId: string;
  email: string;
  codeHash: string;
  tokenHash: string;
  attempts: number;
  createdAt: string;
}

const PASSWORD_RESET_TTL_SECONDS = 600;
const PASSWORD_RESET_MAX_ATTEMPTS = 5;
const FORGOT_PASSWORD_EMAIL_LIMIT = 5;
const FORGOT_PASSWORD_IP_LIMIT = 20;
const FORGOT_PASSWORD_WINDOW_MS = 10 * 60 * 1000;

function isLocalSmtpHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return (
    normalized === '127.0.0.1' ||
    normalized === 'localhost' ||
    normalized === '::1' ||
    normalized === 'mailpit'
  );
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function assertStrongPassword(password: string): void {
  if (password.length < 8 || password.length > 128) {
    throw new ApiDomainException(
      HttpStatus.BAD_REQUEST,
      ErrorCode.VALIDATION_ERROR,
      'Mật khẩu mới phải dài từ 8 đến 128 ký tự.',
    );
  }
  const hasLetter = /[a-zA-Z]/.test(password);
  const hasDigit = /\d/.test(password);
  if (!hasLetter || !hasDigit) {
    throw new ApiDomainException(
      HttpStatus.BAD_REQUEST,
      ErrorCode.VALIDATION_ERROR,
      'Mật khẩu mới cần bao gồm cả chữ cái và chữ số để đảm bảo an toàn.',
    );
  }
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
  private readonly forgotPasswordWindows = new Map<string, number[]>();
  private recoveryTransporter: nodemailer.Transporter | null = null;

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
  ): Promise<ExtendedUserSummaryDto | null> {
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
  ): Promise<ExtendedUserSummaryDto> {
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

    const isActive =
      user.is_active !== false &&
      user.status === UserStatus.ACTIVE &&
      !user.deleted_at;

    return {
      id: user.id,
      email: user.email,
      fullName: user.full_name,
      phone: user.phone,
      status: user.status,
      isActive,
      deletedAt: user.deleted_at ? toIso(user.deleted_at) : null,
      roles,
      permissions,
      permissionVersion: Number(user.permission_version),
      mfaEnabled: Boolean(user.mfa_enabled),
      ...(mfaVerifiedOverride !== undefined ? { mfaVerified: mfaVerifiedOverride } : {}),
      supplierId: user.supplier_id,
      loyaltyTier: user.loyalty_tier,
      vipTier: user.loyalty_tier,
      codTrustScore: Number(user.cod_trust_score ?? 100),
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
      const dbUser = await this.db.query<{
        permission_version: number;
        status: string;
        is_active?: boolean | null;
        deleted_at?: Date | string | null;
      }>('SELECT permission_version, status, is_active, deleted_at FROM users WHERE id = $1', [
        payload.sub,
      ]);
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
      if (row.status === UserStatus.LOCKED || row.is_active === false || Boolean(row.deleted_at)) {
        await this.redis.setUserLocked(payload.sub, true);
        throw new ApiDomainException(
          HttpStatus.FORBIDDEN,
          ErrorCode.PERMISSION_REVOKED,
          'Tài khoản đã bị khóa hoặc vô hiệu hóa.',
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

    if (userRow.status === UserStatus.LOCKED || userRow.is_active === false || Boolean(userRow.deleted_at)) {
      await this.redis.setUserLocked(userRow.id, true);
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
    if (userRow.status !== UserStatus.ACTIVE || userRow.is_active === false || Boolean(userRow.deleted_at)) {
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

  async forgotPassword(
    input: { email: string },
    req: Request,
  ): Promise<ForgotPasswordResponse> {
    const email = input.email.trim().toLowerCase();
    const ipAddress = extractClientIp(req) ?? '127.0.0.1';
    const correlationId = getCorrelationIdFromRequest(req);

    // Per-IP and per-email sliding-window rate limits
    this.enforceForgotPasswordRateLimit(`ip:${ipAddress}`, FORGOT_PASSWORD_IP_LIMIT);
    this.enforceForgotPasswordRateLimit(
      `email:${sha256Hex(email)}`,
      FORGOT_PASSWORD_EMAIL_LIMIT,
    );

    const uniformResponse: ForgotPasswordResponse = {
      sent: true,
      expiresInSeconds: PASSWORD_RESET_TTL_SECONDS,
      message:
        'Nếu email tồn tại trong hệ thống, mã khôi phục 6 chữ số có hiệu lực trong 10 phút đã được gửi tới hộp thư của bạn.',
    };

    const userRes = await this.db.query<
      Pick<UserDbRow, 'id' | 'email' | 'full_name' | 'status'>
    >('SELECT id, email, full_name, status FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1', [
      email,
    ]);

    if (userRes.rows.length === 0) {
      return uniformResponse;
    }

    const user = userRes.rows[0];
    if (user.status !== UserStatus.ACTIVE) {
      return uniformResponse;
    }

    const otpCode = generateNumericOtp(6);
    const recoveryToken = generateOpaqueToken(32);
    const emailHash = sha256Hex(email);
    const codeHash = sha256Hex(otpCode);
    const tokenHash = sha256Hex(recoveryToken);

    const record: StoredPasswordResetRecord = {
      userId: user.id,
      email,
      codeHash,
      tokenHash,
      attempts: 0,
      createdAt: new Date().toISOString(),
    };

    // Store ONLY SHA-256 hashes (never plaintext OTP/token) in Redis with 600s TTL
    await Promise.all([
      this.redis.setPasswordResetKey(
        `email:${emailHash}`,
        JSON.stringify(record),
        PASSWORD_RESET_TTL_SECONDS,
      ),
      this.redis.setPasswordResetKey(
        `tok:${tokenHash}`,
        emailHash,
        PASSWORD_RESET_TTL_SECONDS,
      ),
      this.redis.setPasswordResetKey(
        `code:${codeHash}`,
        emailHash,
        PASSWORD_RESET_TTL_SECONDS,
      ),
    ]);

    const storefrontBase = (
      process.env.STOREFRONT_URL?.trim() ||
      process.env.NEXT_PUBLIC_STOREFRONT_URL?.trim() ||
      'http://127.0.0.1:3000'
    ).replace(/\/+$/, '');
    const resetLink = `${storefrontBase}/quen-mat-khau?email=${encodeURIComponent(user.email)}&token=${encodeURIComponent(recoveryToken)}`;

    try {
      await this.mail.sendPasswordResetEmail({
        to: user.email,
        fullName: user.full_name,
        otpCode,
        resetLink,
        ttlMinutes: Math.round(PASSWORD_RESET_TTL_SECONDS / 60),
      });
    } catch (error) {
      // Fallback to direct recovery transport if shared MailService transport fails unexpectedly
      try {
        await this.sendPasswordResetEmail({
          to: user.email,
          fullName: user.full_name,
          otpCode,
          resetLink,
          ttlMinutes: Math.round(PASSWORD_RESET_TTL_SECONDS / 60),
        });
      } catch (fallbackErr) {
        throw new ApiDomainException(
          HttpStatus.SERVICE_UNAVAILABLE,
          ErrorCode.DEPENDENCY_UNAVAILABLE,
          'Không thể gửi email khôi phục mật khẩu qua máy chủ SMTP lúc này.',
          {
            detail:
              fallbackErr instanceof Error
                ? fallbackErr.message
                : error instanceof Error
                  ? error.message
                  : String(error),
          },
        );
      }
    }

    await this.audit.record({
      actorId: user.id,
      actorEmail: user.email,
      actorType: AuditActorType.USER,
      action: 'PASSWORD_RESET_REQUESTED',
      resourceType: 'user',
      resourceId: user.id,
      afterJsonb: {
        ttlSeconds: PASSWORD_RESET_TTL_SECONDS,
        maskedEmail: maskEmail(user.email),
      },
      correlationId,
      ipAddress,
    });

    return uniformResponse;
  }

  async resetPassword(
    input: {
      email?: string;
      code?: string;
      token?: string;
      otp?: string;
      newPassword: string;
    },
    req: Request,
    res: Response,
  ): Promise<ResetPasswordResponse> {
    assertStrongPassword(input.newPassword);

    const rawSecret = (input.code ?? input.otp ?? input.token ?? '').trim();
    if (!rawSecret) {
      throw new ApiDomainException(
        HttpStatus.BAD_REQUEST,
        ErrorCode.VALIDATION_ERROR,
        'Vui lòng cung cấp mã xác thực 6 chữ số hoặc token khôi phục.',
      );
    }

    const compactOtpHash = sha256Hex(rawSecret.replace(/\s+/g, ''));
    const rawTokenHash = sha256Hex(rawSecret);

    let emailHash: string | null = null;
    if (input.email && input.email.trim().length > 0) {
      emailHash = sha256Hex(input.email.trim().toLowerCase());
    } else {
      if (input.token && input.token.trim().length > 0) {
        emailHash = await this.redis.getPasswordResetKey(
          `tok:${sha256Hex(input.token.trim())}`,
        );
      }
      if (!emailHash) {
        emailHash = await this.redis.getPasswordResetKey(`code:${compactOtpHash}`);
      }
      if (!emailHash) {
        emailHash = await this.redis.getPasswordResetKey(`tok:${rawTokenHash}`);
      }
    }

    if (!emailHash) {
      throw new ApiDomainException(
        HttpStatus.BAD_REQUEST,
        ErrorCode.VALIDATION_ERROR,
        'Mã khôi phục mật khẩu không hợp lệ hoặc đã hết hạn.',
      );
    }

    const recordKey = `email:${emailHash}`;
    const rawStored = await this.redis.getPasswordResetKey(recordKey);
    if (!rawStored) {
      throw new ApiDomainException(
        HttpStatus.BAD_REQUEST,
        ErrorCode.VALIDATION_ERROR,
        'Mã khôi phục mật khẩu không hợp lệ hoặc đã hết hạn.',
      );
    }

    let stored: StoredPasswordResetRecord;
    try {
      stored = JSON.parse(rawStored) as StoredPasswordResetRecord;
    } catch {
      await this.redis.deletePasswordResetKey(recordKey);
      throw new ApiDomainException(
        HttpStatus.BAD_REQUEST,
        ErrorCode.VALIDATION_ERROR,
        'Mã khôi phục mật khẩu không hợp lệ hoặc đã hết hạn.',
      );
    }

    const codeMatched = constantTimeEqualString(compactOtpHash, stored.codeHash);
    const tokenMatched = constantTimeEqualString(rawTokenHash, stored.tokenHash);

    if (!codeMatched && !tokenMatched) {
      const nextAttempts = (stored.attempts ?? 0) + 1;
      if (nextAttempts >= PASSWORD_RESET_MAX_ATTEMPTS) {
        await Promise.all([
          this.redis.deletePasswordResetKey(recordKey),
          this.redis.deletePasswordResetKey(`tok:${stored.tokenHash}`),
          this.redis.deletePasswordResetKey(`code:${stored.codeHash}`),
        ]);
      } else {
        await this.redis.setPasswordResetKey(
          recordKey,
          JSON.stringify({ ...stored, attempts: nextAttempts }),
          PASSWORD_RESET_TTL_SECONDS,
        );
      }
      throw new ApiDomainException(
        HttpStatus.BAD_REQUEST,
        ErrorCode.VALIDATION_ERROR,
        'Mã khôi phục mật khẩu không chính xác hoặc đã hết hạn.',
      );
    }

    // Single-use: immediately delete recovery keys from Redis
    await Promise.all([
      this.redis.deletePasswordResetKey(recordKey),
      this.redis.deletePasswordResetKey(`tok:${stored.tokenHash}`),
      this.redis.deletePasswordResetKey(`code:${stored.codeHash}`),
    ]);

    const newPasswordHash = hashPassword(input.newPassword);
    const correlationId = getCorrelationIdFromRequest(req);
    const ipAddress = extractClientIp(req);

    const txResult = await this.db.transaction(async (tx) => {
      const updatedUser = await tx.query<Pick<UserDbRow, 'id' | 'email' | 'permission_version'>>(
        `UPDATE users
         SET password_hash = $1,
             permission_version = permission_version + 1,
             updated_at = NOW()
         WHERE id = $2
         RETURNING id, email, permission_version`,
        [newPasswordHash, stored.userId],
      );
      if (updatedUser.rows.length === 0) {
        throw new ApiDomainException(
          HttpStatus.NOT_FOUND,
          ErrorCode.NOT_FOUND,
          'Không tìm thấy tài khoản người dùng.',
        );
      }

      const activeSessions = await tx.query<{
        token_family_id: string;
        last_access_jti: string | null;
      }>(
        `SELECT token_family_id, last_access_jti
         FROM auth_sessions
         WHERE user_id = $1 AND revoked = FALSE`,
        [stored.userId],
      );

      await tx.query(
        'UPDATE auth_sessions SET revoked = TRUE WHERE user_id = $1 AND revoked = FALSE',
        [stored.userId],
      );

      const newPermVersion = Number(updatedUser.rows[0].permission_version);

      await this.audit.record(
        {
          actorId: stored.userId,
          actorEmail: updatedUser.rows[0].email,
          actorType: AuditActorType.USER,
          action: 'PASSWORD_RESET_COMPLETED',
          resourceType: 'user',
          resourceId: stored.userId,
          afterJsonb: {
            permissionVersion: newPermVersion,
            revokedSessionsCount: activeSessions.rows.length,
          },
          correlationId,
          ipAddress,
        },
        tx,
      );

      return {
        userId: stored.userId,
        permissionVersion: newPermVersion,
        sessions: activeSessions.rows,
      };
    });

    await this.revokeAllSessionsInRedis(
      txResult.userId,
      txResult.permissionVersion,
      txResult.sessions,
    );
    this.clearAuthCookies(req, res);

    return {
      reset: true,
      message:
        'Đặt lại mật khẩu thành công. Tất cả phiên đăng nhập cũ đã bị thu hồi; vui lòng đăng nhập lại bằng mật khẩu mới.',
    };
  }

  async changePassword(
    authUser: JwtAccessPayload,
    input: { currentPassword: string; newPassword: string },
    req: Request,
    res: Response,
  ): Promise<ChangePasswordResponse> {
    assertStrongPassword(input.newPassword);

    if (input.currentPassword === input.newPassword) {
      throw new ApiDomainException(
        HttpStatus.BAD_REQUEST,
        ErrorCode.VALIDATION_ERROR,
        'Mật khẩu mới phải khác với mật khẩu hiện tại.',
      );
    }

    const userRes = await this.db.query<UserDbRow>(
      'SELECT * FROM users WHERE id = $1 LIMIT 1',
      [authUser.sub],
    );
    if (userRes.rows.length === 0) {
      throw new ApiDomainException(
        HttpStatus.NOT_FOUND,
        ErrorCode.NOT_FOUND,
        'Không tìm thấy tài khoản người dùng.',
      );
    }

    const userRow = userRes.rows[0];
    if (!verifyPassword(input.currentPassword, userRow.password_hash)) {
      throw new ApiDomainException(
        HttpStatus.BAD_REQUEST,
        ErrorCode.VALIDATION_ERROR,
        'Mật khẩu hiện tại không chính xác.',
      );
    }

    const newPasswordHash = hashPassword(input.newPassword);
    const correlationId = getCorrelationIdFromRequest(req);
    const ipAddress = extractClientIp(req);

    const txResult = await this.db.transaction(async (tx) => {
      const updatedUser = await tx.query<UserDbRow>(
        `UPDATE users
         SET password_hash = $1,
             permission_version = permission_version + 1,
             updated_at = NOW()
         WHERE id = $2
         RETURNING *`,
        [newPasswordHash, authUser.sub],
      );

      const activeSessions = await tx.query<{
        token_family_id: string;
        last_access_jti: string | null;
      }>(
        `SELECT token_family_id, last_access_jti
         FROM auth_sessions
         WHERE user_id = $1 AND revoked = FALSE`,
        [authUser.sub],
      );

      await tx.query(
        'UPDATE auth_sessions SET revoked = TRUE WHERE user_id = $1 AND revoked = FALSE',
        [authUser.sub],
      );

      const summary = await this.buildUserSummary(
        updatedUser.rows[0],
        tx,
        Boolean(authUser.mfaVerified),
      );

      await this.audit.record(
        {
          actorId: authUser.sub,
          actorEmail: summary.email,
          actorType: AuditActorType.USER,
          action: 'PASSWORD_CHANGED',
          resourceType: 'user',
          resourceId: authUser.sub,
          afterJsonb: {
            permissionVersion: summary.permissionVersion,
            revokedSessionsCount: activeSessions.rows.length,
          },
          correlationId,
          ipAddress,
        },
        tx,
      );

      return {
        userSummary: summary,
        sessions: activeSessions.rows,
      };
    });

    await this.revokeAllSessionsInRedis(
      txResult.userSummary.id,
      txResult.userSummary.permissionVersion,
      txResult.sessions,
      authUser.jti,
    );

    const { accessToken, csrfToken } = await this.createFreshSessionAndTokens({
      user: txResult.userSummary,
      mfaVerified: Boolean(authUser.mfaVerified),
      req,
      res,
    });

    return {
      changed: true,
      accessToken,
      csrfToken,
      user: txResult.userSummary,
      message: 'Đổi mật khẩu thành công. Phiên đăng nhập đã được làm mới an toàn.',
    };
  }

  private enforceForgotPasswordRateLimit(bucketKey: string, limit: number): void {
    const now = Date.now();
    const cutoff = now - FORGOT_PASSWORD_WINDOW_MS;
    const existing = this.forgotPasswordWindows.get(bucketKey) ?? [];
    const active = existing.filter((ts) => ts > cutoff);
    if (active.length >= limit) {
      const oldest = active[0] ?? now;
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((oldest + FORGOT_PASSWORD_WINDOW_MS - now) / 1000),
      );
      throw new ApiDomainException(
        HttpStatus.TOO_MANY_REQUESTS,
        ErrorCode.RATE_LIMITED,
        `Bạn đã yêu cầu khôi phục mật khẩu quá nhiều lần. Vui lòng thử lại sau ${retryAfterSeconds} giây.`,
        { retryAfterSeconds },
      );
    }
    active.push(now);
    this.forgotPasswordWindows.set(bucketKey, active);

    if (this.forgotPasswordWindows.size > 2000) {
      for (const [key, timestamps] of this.forgotPasswordWindows.entries()) {
        if (timestamps.length === 0 || timestamps[timestamps.length - 1] <= cutoff) {
          this.forgotPasswordWindows.delete(key);
        }
      }
    }
  }

  private async revokeAllSessionsInRedis(
    userId: string,
    newPermissionVersion: number,
    sessions: Array<{ token_family_id: string; last_access_jti: string | null }>,
    currentAccessJti?: string,
  ): Promise<void> {
    await this.redis.setUserPermissionVersion(userId, newPermissionVersion);

    const uniqueFamilies = new Set<string>();
    const uniqueJtis = new Set<string>();
    for (const row of sessions) {
      if (row.token_family_id) {
        uniqueFamilies.add(row.token_family_id);
      }
      if (row.last_access_jti) {
        uniqueJtis.add(row.last_access_jti);
      }
    }
    if (currentAccessJti) {
      uniqueJtis.add(currentAccessJti);
    }

    await Promise.all([
      ...[...uniqueFamilies].map((familyId) =>
        this.redis.revokeTokenFamily(familyId, this.config.jwt.refreshTtlSeconds),
      ),
      ...[...uniqueJtis].map((jti) =>
        this.redis.revokeJti(jti, this.config.jwt.accessTtlSeconds),
      ),
    ]);
  }

  private getRecoveryMailTransporter(): nodemailer.Transporter {
    if (!this.recoveryTransporter) {
      const { host, port, secure, user, pass } = this.config.smtp;
      const hasAuth = Boolean(user && pass);
      const useLocalMailpitMode = !hasAuth && isLocalSmtpHost(host);
      this.recoveryTransporter = nodemailer.createTransport({
        host,
        port,
        secure: useLocalMailpitMode ? false : secure,
        ...(useLocalMailpitMode ? { ignoreTLS: true } : { requireTLS: !secure }),
        ...(hasAuth ? { auth: { user, pass } } : {}),
        connectionTimeout: useLocalMailpitMode ? 5000 : 15000,
        greetingTimeout: useLocalMailpitMode ? 5000 : 15000,
        socketTimeout: useLocalMailpitMode ? 8000 : 15000,
      });
    }
    return this.recoveryTransporter;
  }

  private async sendPasswordResetEmail(params: {
    to: string;
    fullName: string;
    otpCode: string;
    resetLink: string;
    ttlMinutes: number;
  }): Promise<void> {
    const { to, fullName, otpCode, resetLink, ttlMinutes } = params;
    const subject = `[TryVibe · Fashion Atelier] Mã khôi phục mật khẩu: ${otpCode}`;
    const text = [
      `Xin chào ${fullName},`,
      '',
      'Chúng tôi nhận được yêu cầu đặt lại mật khẩu cho tài khoản Fashion Atelier của bạn.',
      `Mã khôi phục 6 chữ số của bạn là: ${otpCode}`,
      '',
      `Hoặc mở trực tiếp liên kết đặt lại mật khẩu: ${resetLink}`,
      '',
      `Mã khôi phục có hiệu lực trong ${ttlMinutes} phút và chỉ sử dụng một lần.`,
      'Nếu bạn không thực hiện yêu cầu này, vui lòng bỏ qua email này.',
      '',
      'Trân trọng,',
      'TryVibe · Fashion Atelier Security Team',
    ].join('\n');

    const html = [
      '<div style="font-family:Inter,Arial,sans-serif;max-width:540px;margin:0 auto;padding:28px;border:1px solid #d6c5a7;border-radius:12px;background:#fbf7ef;color:#1c1410">',
      '<p style="letter-spacing:0.18em;font-size:11px;text-transform:uppercase;color:#8a672c;margin:0 0 10px">TryVibe · Fashion Atelier · Khôi phục mật khẩu</p>',
      `<h2 style="font-size:22px;font-weight:600;margin:0 0 12px;color:#1c1410">Xin chào ${escapeHtml(fullName)},</h2>`,
      '<p style="font-size:14px;line-height:1.65;margin:0 0 16px;color:#3d2f27">Sử dụng mã OTP 6 chữ số dưới đây tại trang <strong>/quen-mat-khau</strong> để đặt lại mật khẩu tài khoản của bạn:</p>',
      `<div style="font-size:34px;font-weight:700;letter-spacing:0.28em;text-align:center;padding:18px 20px;background:#ffffff;border:1px solid #b08a4a;border-radius:10px;color:#1c1410;margin:0 0 18px">${escapeHtml(otpCode)}</div>`,
      `<p style="text-align:center;margin:0 0 18px"><a href="${escapeHtml(resetLink)}" style="display:inline-block;padding:12px 24px;border-radius:999px;background:#1c1410;color:#ebcf8f;text-decoration:none;font-size:13px;font-weight:600;letter-spacing:0.08em">Mở trang Đặt lại mật khẩu</a></p>`,
      `<p style="font-size:13px;color:#6b5b4c;line-height:1.55;margin:0">Mã có hiệu lực trong <strong>${ttlMinutes} phút</strong> và chỉ dùng 1 lần. Khi đặt lại mật khẩu thành công, toàn bộ phiên đăng nhập cũ sẽ tự động đăng xuất.</p>`,
      '</div>',
    ].join('');

    const transporter = this.getRecoveryMailTransporter();
    await transporter.sendMail({
      from: this.config.smtp.from,
      to,
      subject,
      text,
      html,
    });
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
