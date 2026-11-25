import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { createRedisClient, type AtelierRedisClient } from '@atelier/db-client';
import { createLogger } from '@atelier/observability';
import { AUTH_CONFIG_TOKEN, type AuthCustomerConfig } from '../config/env';

const PERM_VER_PREFIX = 'user:perm_ver:';
const LOCKED_PREFIX = 'user:locked:';
const REVOKED_JTI_PREFIX = 'revoked_jti:';
const REVOKED_FAMILY_PREFIX = 'revoked_family:';
const EMAIL_OTP_PREFIX = 'mfa:email_otp:';
const PASSWORD_RESET_PREFIX = 'auth:pwd_reset:';

@Injectable()
export class AuthRedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = createLogger('@atelier/auth-customer:redis');
  private readonly client: AtelierRedisClient;
  private readonly fallbackOtpStore = new Map<string, { code: string; expiresAtMs: number }>();
  private readonly fallbackPasswordResetStore = new Map<
    string,
    { value: string; expiresAtMs: number }
  >();

  constructor(@Inject(AUTH_CONFIG_TOKEN) private readonly config: AuthCustomerConfig) {
    this.client = createRedisClient({
      url: this.config.redis.url,
      ...(this.config.redis.password ? { password: this.config.redis.password } : {}),
    });
  }

  async onModuleInit(): Promise<void> {
    const ok = await this.ping();
    if (ok) {
      this.logger.info({ redisUrl: this.config.redis.url }, 'Connected to Redis session/RBAC store');
    } else {
      this.logger.warn(
        { redisUrl: this.config.redis.url },
        'Redis not reachable during auth-customer startup; will retry lazily',
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.quit();
  }

  async ping(): Promise<boolean> {
    return this.client.ping();
  }

  async setUserPermissionVersion(userId: string, version: number): Promise<void> {
    try {
      await this.client.set(`${PERM_VER_PREFIX}${userId}`, String(version));
    } catch (error) {
      this.logger.warn({ err: error, userId, version }, 'Failed to sync user permission_version to Redis');
    }
  }

  async getUserPermissionVersion(userId: string): Promise<number | null> {
    try {
      const raw = await this.client.get(`${PERM_VER_PREFIX}${userId}`);
      if (raw === null) {
        return null;
      }
      const parsed = Number.parseInt(raw, 10);
      return Number.isInteger(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  async setUserLocked(userId: string, locked: boolean): Promise<void> {
    try {
      const key = `${LOCKED_PREFIX}${userId}`;
      if (locked) {
        await this.client.set(key, '1');
      } else {
        await this.client.del(key);
      }
    } catch (error) {
      this.logger.warn({ err: error, userId, locked }, 'Failed to sync user locked flag to Redis');
    }
  }

  async isUserLocked(userId: string): Promise<boolean> {
    try {
      const val = await this.client.get(`${LOCKED_PREFIX}${userId}`);
      return val === '1';
    } catch {
      return false;
    }
  }

  async revokeJti(jti: string, ttlSeconds: number = 900): Promise<void> {
    try {
      await this.client.set(`${REVOKED_JTI_PREFIX}${jti}`, '1', Math.max(60, ttlSeconds));
    } catch (error) {
      this.logger.warn({ err: error, jti }, 'Failed to store revoked_jti in Redis');
    }
  }

  async isJtiRevoked(jti: string): Promise<boolean> {
    try {
      const val = await this.client.get(`${REVOKED_JTI_PREFIX}${jti}`);
      return val === '1';
    } catch {
      return false;
    }
  }

  async revokeTokenFamily(tokenFamilyId: string, ttlSeconds: number = 7 * 24 * 60 * 60): Promise<void> {
    try {
      await this.client.set(`${REVOKED_FAMILY_PREFIX}${tokenFamilyId}`, '1', ttlSeconds);
    } catch (error) {
      this.logger.warn({ err: error, tokenFamilyId }, 'Failed to store revoked_family in Redis');
    }
  }

  async isTokenFamilyRevoked(tokenFamilyId: string): Promise<boolean> {
    try {
      const val = await this.client.get(`${REVOKED_FAMILY_PREFIX}${tokenFamilyId}`);
      return val === '1';
    } catch {
      return false;
    }
  }

  async setEmailOtp(userId: string, code: string, ttlSeconds: number = 300): Promise<void> {
    const key = `${EMAIL_OTP_PREFIX}${userId}`;
    try {
      await this.client.set(key, code, ttlSeconds);
      this.fallbackOtpStore.delete(userId);
    } catch (error) {
      this.logger.warn({ err: error, userId }, 'Redis unavailable for email OTP; using memory fallback');
      this.fallbackOtpStore.set(userId, {
        code,
        expiresAtMs: Date.now() + ttlSeconds * 1000,
      });
    }
  }

  async getEmailOtp(userId: string): Promise<string | null> {
    const key = `${EMAIL_OTP_PREFIX}${userId}`;
    try {
      const val = await this.client.get(key);
      if (val !== null) {
        return val;
      }
    } catch {
      // Fallback below
    }

    const fallback = this.fallbackOtpStore.get(userId);
    if (!fallback) {
      return null;
    }
    if (fallback.expiresAtMs <= Date.now()) {
      this.fallbackOtpStore.delete(userId);
      return null;
    }
    return fallback.code;
  }

  async deleteEmailOtp(userId: string): Promise<void> {
    this.fallbackOtpStore.delete(userId);
    try {
      await this.client.del(`${EMAIL_OTP_PREFIX}${userId}`);
    } catch {
      // Ignore Redis cleanup failure
    }
  }

  async setPasswordResetKey(
    keySuffix: string,
    value: string,
    ttlSeconds: number = 600,
  ): Promise<void> {
    const redisKey = `${PASSWORD_RESET_PREFIX}${keySuffix}`;
    try {
      await this.client.set(redisKey, value, ttlSeconds);
      this.fallbackPasswordResetStore.delete(keySuffix);
    } catch (error) {
      this.logger.warn(
        { err: error, keySuffix },
        'Redis unavailable for password reset token; using memory fallback',
      );
      this.fallbackPasswordResetStore.set(keySuffix, {
        value,
        expiresAtMs: Date.now() + ttlSeconds * 1000,
      });
    }
  }

  async getPasswordResetKey(keySuffix: string): Promise<string | null> {
    const redisKey = `${PASSWORD_RESET_PREFIX}${keySuffix}`;
    try {
      const val = await this.client.get(redisKey);
      if (val !== null) {
        return val;
      }
    } catch {
      // Fallback below
    }

    const fallback = this.fallbackPasswordResetStore.get(keySuffix);
    if (!fallback) {
      return null;
    }
    if (fallback.expiresAtMs <= Date.now()) {
      this.fallbackPasswordResetStore.delete(keySuffix);
      return null;
    }
    return fallback.value;
  }

  async deletePasswordResetKey(keySuffix: string): Promise<void> {
    this.fallbackPasswordResetStore.delete(keySuffix);
    try {
      await this.client.del(`${PASSWORD_RESET_PREFIX}${keySuffix}`);
    } catch {
      // Ignore Redis cleanup failure
    }
  }
}
