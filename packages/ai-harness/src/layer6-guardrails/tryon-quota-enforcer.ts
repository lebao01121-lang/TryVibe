import {
  AiTelemetryRecorder,
  estimateVtonCostUsd,
  type VtonTelemetryProvider,
} from '../layer8-telemetry-eval';

export type TryOnLoyaltyTier = 'BRONZE' | 'SILVER' | 'GOLD' | 'DIAMOND';

export type TryOnQuotaRejectionReason =
  | 'USER_QUOTA_EXCEEDED'
  | 'IP_QUOTA_EXCEEDED';

export const DEFAULT_USER_DAILY_TRYON_LIMIT = 10;
export const DEFAULT_GUEST_IP_DAILY_TRYON_LIMIT = 5;
export const DEFAULT_AUTH_IP_DAILY_TRYON_CEILING = 30;

export const DEFAULT_LOYALTY_TRYON_LIMITS: Readonly<
  Record<TryOnLoyaltyTier, number>
> = {
  BRONZE: 10,
  SILVER: 12,
  GOLD: 15,
  DIAMOND: 25,
};

export interface TryOnQuotaEnforcerOptions {
  defaultUserDailyLimit?: number;
  guestIpDailyLimit?: number;
  authenticatedIpDailyLimit?: number;
  loyaltyLimits?: Partial<Record<TryOnLoyaltyTier, number>>;
  falVtonCostUsd?: number;
  telemetry?: AiTelemetryRecorder;
  dateKeyFn?: () => string;
}

export interface TryOnQuotaIdentity {
  userId?: string;
  guestSessionId?: string;
  ipAddress: string;
  loyaltyTier?: TryOnLoyaltyTier;
}

export interface TryOnQuotaReserveRequest extends TryOnQuotaIdentity {
  cacheHit?: boolean;
  provider?: VtonTelemetryProvider;
  correlationId?: string;
}

export interface TryOnQuotaReserveResult {
  allowed: boolean;
  deducted: boolean;
  cacheHit: boolean;
  reason?: TryOnQuotaRejectionReason;
  costUsd: number;
  userLimit: number;
  ipLimit: number;
  userUsed: number;
  ipUsed: number;
  remainingUserQuota: number;
  remainingIpQuota: number;
  resetAt: string;
}

export interface TryOnQuotaRefundRequest extends TryOnQuotaIdentity {
  correlationId?: string;
  reason?: string;
}

export interface TryOnQuotaRefundResult {
  refunded: boolean;
  refundedAmount: 0 | 1;
  userLimit: number;
  ipLimit: number;
  userUsed: number;
  ipUsed: number;
  remainingUserQuota: number;
  remainingIpQuota: number;
  resetAt: string;
}

export interface TryOnQuotaStatusResult {
  userLimit: number;
  ipLimit: number;
  userUsed: number;
  ipUsed: number;
  remainingUserQuota: number;
  remainingIpQuota: number;
  resetAt: string;
}

function getUtcDateKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function computeNextUtcMidnightIso(dateKey: string): string {
  const base = new Date(`${dateKey}T00:00:00.000Z`);
  if (Number.isNaN(base.getTime())) {
    const tomorrow = new Date(Date.now() + 86_400_000);
    tomorrow.setUTCHours(0, 0, 0, 0);
    return tomorrow.toISOString();
  }
  base.setUTCDate(base.getUTCDate() + 1);
  return base.toISOString();
}

export class TryOnQuotaEnforcer {
  private readonly defaultUserDailyLimit: number;
  private readonly guestIpDailyLimit: number;
  private readonly authenticatedIpDailyLimit: number;
  private readonly loyaltyLimits: Record<TryOnLoyaltyTier, number>;
  private readonly falVtonCostUsd: number;
  private readonly telemetry?: AiTelemetryRecorder;
  private readonly dateKeyFn: () => string;

  private readonly userCounters = new Map<string, number>();
  private readonly ipCounters = new Map<string, number>();

  constructor(options: TryOnQuotaEnforcerOptions = {}) {
    this.defaultUserDailyLimit = Math.max(
      1,
      options.defaultUserDailyLimit ?? DEFAULT_USER_DAILY_TRYON_LIMIT,
    );
    this.guestIpDailyLimit = Math.max(
      1,
      options.guestIpDailyLimit ?? DEFAULT_GUEST_IP_DAILY_TRYON_LIMIT,
    );
    this.authenticatedIpDailyLimit = Math.max(
      1,
      options.authenticatedIpDailyLimit ?? DEFAULT_AUTH_IP_DAILY_TRYON_CEILING,
    );
    this.loyaltyLimits = {
      ...DEFAULT_LOYALTY_TRYON_LIMITS,
      ...(options.loyaltyLimits ?? {}),
    };
    this.falVtonCostUsd = Math.max(0, options.falVtonCostUsd ?? 0.04);
    this.telemetry = options.telemetry;
    this.dateKeyFn = options.dateKeyFn ?? getUtcDateKey;
  }

  private resolveScope(identity: TryOnQuotaIdentity): {
    dateKey: string;
    resetAt: string;
    isAuthenticated: boolean;
    subjectKey: string;
    ipKey: string;
    userLimit: number;
    ipLimit: number;
  } {
    const dateKey = this.dateKeyFn();
    const resetAt = computeNextUtcMidnightIso(dateKey);
    const normalizedIp = identity.ipAddress.trim() || '127.0.0.1';
    const isAuthenticated = Boolean(
      identity.userId && identity.userId.trim().length > 0,
    );

    const subjectId = isAuthenticated
      ? `user:${identity.userId!.trim()}`
      : `guest:${identity.guestSessionId?.trim() || normalizedIp}`;
    const subjectKey = `${dateKey}:${subjectId}`;
    const ipKey = `${dateKey}:ip:${normalizedIp}`;

    const userLimit = isAuthenticated
      ? identity.loyaltyTier
        ? (this.loyaltyLimits[identity.loyaltyTier] ??
          this.defaultUserDailyLimit)
        : this.defaultUserDailyLimit
      : this.guestIpDailyLimit;

    const ipLimit = isAuthenticated
      ? this.authenticatedIpDailyLimit
      : this.guestIpDailyLimit;

    return {
      dateKey,
      resetAt,
      isAuthenticated,
      subjectKey,
      ipKey,
      userLimit,
      ipLimit,
    };
  }

  public getStatus(identity: TryOnQuotaIdentity): TryOnQuotaStatusResult {
    const scope = this.resolveScope(identity);
    const userUsed = this.userCounters.get(scope.subjectKey) ?? 0;
    const ipUsed = this.ipCounters.get(scope.ipKey) ?? 0;

    return {
      userLimit: scope.userLimit,
      ipLimit: scope.ipLimit,
      userUsed,
      ipUsed,
      remainingUserQuota: Math.max(0, scope.userLimit - userUsed),
      remainingIpQuota: Math.max(0, scope.ipLimit - ipUsed),
      resetAt: scope.resetAt,
    };
  }

  public checkAndReserve(
    request: TryOnQuotaReserveRequest,
  ): TryOnQuotaReserveResult {
    const scope = this.resolveScope(request);
    const currentUserUsed = this.userCounters.get(scope.subjectKey) ?? 0;
    const currentIpUsed = this.ipCounters.get(scope.ipKey) ?? 0;
    const isCacheHit = request.cacheHit === true || request.provider === 'CACHE_HIT';

    if (isCacheHit) {
      this.recordTelemetryIfConfigured({
        userId: request.userId ?? request.guestSessionId ?? `guest:${request.ipAddress}`,
        provider: 'CACHE_HIT',
        costUsd: 0,
        cacheHit: true,
        status: 'SUCCESS',
        correlationId: request.correlationId ?? 'tryon-cache-hit',
        metadata: {
          ipAddress: request.ipAddress,
          deducted: false,
        },
      });

      return {
        allowed: true,
        deducted: false,
        cacheHit: true,
        costUsd: 0,
        userLimit: scope.userLimit,
        ipLimit: scope.ipLimit,
        userUsed: currentUserUsed,
        ipUsed: currentIpUsed,
        remainingUserQuota: Math.max(0, scope.userLimit - currentUserUsed),
        remainingIpQuota: Math.max(0, scope.ipLimit - currentIpUsed),
        resetAt: scope.resetAt,
      };
    }

    // Atomically verify BOTH limits before mutating either counter
    if (scope.isAuthenticated) {
      if (currentUserUsed >= scope.userLimit) {
        this.recordTelemetryIfConfigured({
          userId: request.userId!,
          provider: request.provider ?? 'MOCK',
          costUsd: 0,
          cacheHit: false,
          status: 'BLOCKED_GUARDRAIL',
          correlationId: request.correlationId ?? 'tryon-quota-blocked',
          metadata: { reason: 'USER_QUOTA_EXCEEDED', ipAddress: request.ipAddress },
        });
        return {
          allowed: false,
          deducted: false,
          cacheHit: false,
          reason: 'USER_QUOTA_EXCEEDED',
          costUsd: 0,
          userLimit: scope.userLimit,
          ipLimit: scope.ipLimit,
          userUsed: currentUserUsed,
          ipUsed: currentIpUsed,
          remainingUserQuota: 0,
          remainingIpQuota: Math.max(0, scope.ipLimit - currentIpUsed),
          resetAt: scope.resetAt,
        };
      }
      if (currentIpUsed >= scope.ipLimit) {
        this.recordTelemetryIfConfigured({
          userId: request.userId!,
          provider: request.provider ?? 'MOCK',
          costUsd: 0,
          cacheHit: false,
          status: 'BLOCKED_GUARDRAIL',
          correlationId: request.correlationId ?? 'tryon-quota-blocked',
          metadata: { reason: 'IP_QUOTA_EXCEEDED', ipAddress: request.ipAddress },
        });
        return {
          allowed: false,
          deducted: false,
          cacheHit: false,
          reason: 'IP_QUOTA_EXCEEDED',
          costUsd: 0,
          userLimit: scope.userLimit,
          ipLimit: scope.ipLimit,
          userUsed: currentUserUsed,
          ipUsed: currentIpUsed,
          remainingUserQuota: Math.max(0, scope.userLimit - currentUserUsed),
          remainingIpQuota: 0,
          resetAt: scope.resetAt,
        };
      }
    } else {
      if (currentIpUsed >= scope.ipLimit) {
        this.recordTelemetryIfConfigured({
          userId: request.guestSessionId ?? `guest:${request.ipAddress}`,
          provider: request.provider ?? 'MOCK',
          costUsd: 0,
          cacheHit: false,
          status: 'BLOCKED_GUARDRAIL',
          correlationId: request.correlationId ?? 'tryon-quota-blocked',
          metadata: { reason: 'IP_QUOTA_EXCEEDED', ipAddress: request.ipAddress },
        });
        return {
          allowed: false,
          deducted: false,
          cacheHit: false,
          reason: 'IP_QUOTA_EXCEEDED',
          costUsd: 0,
          userLimit: scope.userLimit,
          ipLimit: scope.ipLimit,
          userUsed: currentUserUsed,
          ipUsed: currentIpUsed,
          remainingUserQuota: Math.max(0, scope.userLimit - currentUserUsed),
          remainingIpQuota: 0,
          resetAt: scope.resetAt,
        };
      }
      if (currentUserUsed >= scope.userLimit) {
        this.recordTelemetryIfConfigured({
          userId: request.guestSessionId ?? `guest:${request.ipAddress}`,
          provider: request.provider ?? 'MOCK',
          costUsd: 0,
          cacheHit: false,
          status: 'BLOCKED_GUARDRAIL',
          correlationId: request.correlationId ?? 'tryon-quota-blocked',
          metadata: { reason: 'USER_QUOTA_EXCEEDED', ipAddress: request.ipAddress },
        });
        return {
          allowed: false,
          deducted: false,
          cacheHit: false,
          reason: 'USER_QUOTA_EXCEEDED',
          costUsd: 0,
          userLimit: scope.userLimit,
          ipLimit: scope.ipLimit,
          userUsed: currentUserUsed,
          ipUsed: currentIpUsed,
          remainingUserQuota: 0,
          remainingIpQuota: Math.max(0, scope.ipLimit - currentIpUsed),
          resetAt: scope.resetAt,
        };
      }
    }

    const nextUserUsed = currentUserUsed + 1;
    const nextIpUsed = currentIpUsed + 1;
    this.userCounters.set(scope.subjectKey, nextUserUsed);
    this.ipCounters.set(scope.ipKey, nextIpUsed);

    const provider: VtonTelemetryProvider = request.provider ?? 'MOCK';
    const costUsd = estimateVtonCostUsd(provider, this.falVtonCostUsd);

    this.recordTelemetryIfConfigured({
      userId: request.userId ?? request.guestSessionId ?? `guest:${request.ipAddress}`,
      provider,
      costUsd,
      cacheHit: false,
      status: 'SUCCESS',
      correlationId: request.correlationId ?? 'tryon-reserve',
      metadata: {
        ipAddress: request.ipAddress,
        loyaltyTier: request.loyaltyTier ?? (scope.isAuthenticated ? 'BRONZE' : 'GUEST'),
        deducted: true,
      },
    });

    return {
      allowed: true,
      deducted: true,
      cacheHit: false,
      costUsd,
      userLimit: scope.userLimit,
      ipLimit: scope.ipLimit,
      userUsed: nextUserUsed,
      ipUsed: nextIpUsed,
      remainingUserQuota: Math.max(0, scope.userLimit - nextUserUsed),
      remainingIpQuota: Math.max(0, scope.ipLimit - nextIpUsed),
      resetAt: scope.resetAt,
    };
  }

  public refund(request: TryOnQuotaRefundRequest): TryOnQuotaRefundResult {
    const scope = this.resolveScope(request);
    const currentUserUsed = this.userCounters.get(scope.subjectKey) ?? 0;
    const currentIpUsed = this.ipCounters.get(scope.ipKey) ?? 0;

    const nextUserUsed = Math.max(0, currentUserUsed - 1);
    const nextIpUsed = Math.max(0, currentIpUsed - 1);
    const refunded = nextUserUsed < currentUserUsed || nextIpUsed < currentIpUsed;

    this.userCounters.set(scope.subjectKey, nextUserUsed);
    this.ipCounters.set(scope.ipKey, nextIpUsed);

    if (refunded && this.telemetry) {
      this.telemetry.record({
        userId: request.userId ?? request.guestSessionId ?? `guest:${request.ipAddress}`,
        roles: ['CUSTOMER'],
        toolName: 'ai_tryon_quota_refund',
        tier: 0,
        latencyMs: 0,
        promptTokens: 0,
        completionTokens: 0,
        vtonCostUsd: 0,
        cacheHit: false,
        vtonProvider: 'MOCK',
        correlationId: request.correlationId ?? 'tryon-refund',
        status: 'ERROR',
        metadata: {
          refundedAmount: 1,
          reason: request.reason ?? 'VTON_JOB_FAILED',
          ipAddress: request.ipAddress,
        },
      });
    }

    return {
      refunded,
      refundedAmount: refunded ? 1 : 0,
      userLimit: scope.userLimit,
      ipLimit: scope.ipLimit,
      userUsed: nextUserUsed,
      ipUsed: nextIpUsed,
      remainingUserQuota: Math.max(0, scope.userLimit - nextUserUsed),
      remainingIpQuota: Math.max(0, scope.ipLimit - nextIpUsed),
      resetAt: scope.resetAt,
    };
  }

  public reset(): void {
    this.userCounters.clear();
    this.ipCounters.clear();
  }

  private recordTelemetryIfConfigured(params: {
    userId: string;
    provider: VtonTelemetryProvider;
    costUsd: number;
    cacheHit: boolean;
    status: 'SUCCESS' | 'BLOCKED_GUARDRAIL' | 'BLOCKED_RBAC' | 'ERROR';
    correlationId: string;
    metadata?: Record<string, unknown>;
  }): void {
    if (!this.telemetry) {
      return;
    }
    this.telemetry.record({
      userId: params.userId,
      roles: ['CUSTOMER'],
      toolName: 'ai_tryon_vton',
      tier: 0,
      latencyMs: 0,
      promptTokens: 0,
      completionTokens: 0,
      vtonCostUsd: params.costUsd,
      cacheHit: params.cacheHit,
      vtonProvider: params.provider,
      correlationId: params.correlationId,
      status: params.status,
      metadata: params.metadata,
    });
  }
}
