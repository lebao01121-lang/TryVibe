import { randomUUID } from 'node:crypto';
import type { RouterTier } from '../layer7-cache-router';

export type TelemetryOutcomeStatus =
  | 'SUCCESS'
  | 'BLOCKED_GUARDRAIL'
  | 'BLOCKED_RBAC'
  | 'ERROR';

export type TelemetryPortalScope = 'ADMIN_PORTAL' | 'STOREFRONT' | 'INTERNAL';
export type CopilotFeedbackRating = 'UP' | 'DOWN';

export interface CopilotFeedbackRecord {
  id: string;
  traceId: string;
  sessionId: string | null;
  portal: TelemetryPortalScope;
  role: string;
  userId: string;
  rating: CopilotFeedbackRating;
  reason: string | null;
  promptText: string | null;
  responseText: string | null;
  createdAt: string;
}

export interface CopilotFeedbackSummary {
  total: number;
  thumbsUp: number;
  thumbsDown: number;
  satisfactionPct: number;
  upCount: number;
  downCount: number;
  satisfactionRatePct: number;
  recentReasons: string[];
}

export function computeCopilotFeedbackSummary(
  thumbsUp: number,
  thumbsDown: number,
  recentReasons: readonly string[] = [],
): CopilotFeedbackSummary {
  const safeUp = Math.max(0, Math.floor(thumbsUp));
  const safeDown = Math.max(0, Math.floor(thumbsDown));
  const total = safeUp + safeDown;
  const satisfactionPct =
    total > 0 ? Number(((safeUp / total) * 100).toFixed(2)) : 0;
  const cleanedReasons: string[] = [];
  for (const r of recentReasons) {
    if (typeof r !== 'string') continue;
    const trimmed = r.trim();
    if (trimmed && !cleanedReasons.includes(trimmed)) {
      cleanedReasons.push(trimmed);
      if (cleanedReasons.length >= 10) break;
    }
  }
  return {
    total,
    thumbsUp: safeUp,
    thumbsDown: safeDown,
    satisfactionPct,
    upCount: safeUp,
    downCount: safeDown,
    satisfactionRatePct: satisfactionPct,
    recentReasons: cleanedReasons,
  };
}

export interface AiTelemetryPersistenceAdapter {
  persistTelemetryEvent: (entry: AiTelemetryRecord) => Promise<void>;
  loadTelemetryEvents?: (limit?: number) => Promise<AiTelemetryRecord[]>;
}

export type AiTelemetryProvider = 'ollama' | 'rule_fallback';
export type VtonTelemetryProvider = 'MOCK' | 'FAL_CATVTON' | 'CACHE_HIT';

export const DEFAULT_VTON_COST_USD: Readonly<
  Record<VtonTelemetryProvider, number>
> = {
  MOCK: 0,
  CACHE_HIT: 0,
  FAL_CATVTON: 0.04,
};

export interface AiTelemetryRecord {
  id: string;
  timestamp: string;
  actor_type: 'AI_COPILOT';
  aiProvider: AiTelemetryProvider;
  modelUsed: string;
  userId: string;
  roles: readonly string[];
  toolName: string;
  tier: RouterTier;
  latencyMs: number;
  promptTokens: number;
  completionTokens: number;
  promptEvalCount: number;
  evalCount: number;
  totalDurationMs: number;
  tokensPerSec: number;
  costUsd: 0;
  estimatedCostUsd: number;
  vtonCostUsd: number;
  cacheHit: boolean;
  vtonProvider?: VtonTelemetryProvider;
  correlationId: string;
  traceId: string;
  portal: TelemetryPortalScope;
  status: TelemetryOutcomeStatus;
  usedFallback: boolean;
  metadata?: Record<string, unknown>;
}

export interface RecordTelemetryInput {
  id?: string;
  timestamp?: string;
  userId: string;
  roles: readonly string[];
  toolName: string;
  tier: RouterTier;
  latencyMs: number;
  aiProvider?: AiTelemetryProvider;
  modelUsed?: string;
  promptTokens?: number;
  completionTokens?: number;
  promptEvalCount?: number;
  evalCount?: number;
  totalDurationMs?: number;
  tokensPerSec?: number;
  costUsd?: number;
  estimatedCostUsd?: number;
  vtonCostUsd?: number;
  cacheHit?: boolean;
  vtonProvider?: VtonTelemetryProvider;
  correlationId: string;
  traceId?: string;
  portal?: TelemetryPortalScope;
  status?: TelemetryOutcomeStatus;
  usedFallback?: boolean;
  metadata?: Record<string, unknown>;
}

export interface AiTelemetrySummary {
  aiProvider: 'ollama';
  totalCalls: number;
  successCount: number;
  blockedGuardrailCount: number;
  blockedRbacCount: number;
  errorCount: number;
  cacheHitCount: number;
  cacheMissCount: number;
  cacheHitRatePct: number;
  vtonCallsCount: number;
  vtonCacheHitCount: number;
  vtonPaidCallsCount: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalPromptEvalCount: number;
  totalEvalCount: number;
  averageTokensPerSec: number;
  totalCostUsd: 0;
  totalEstimatedCostUsd: number;
  totalVtonCostUsd: number;
  averageLatencyMs: number;
  byTier: Record<RouterTier, number>;
  byTool: Record<string, number>;
}

export interface AiTelemetryRecorderOptions {
  maxEntries?: number;
  onRecord?: (entry: AiTelemetryRecord) => void;
  persistence?: AiTelemetryPersistenceAdapter;
}

/**
 * Local Ollama LLM inference always incurs $0.00 API cost.
 */
export function estimateOllamaCostUsd(): 0 {
  return 0;
}

export function estimateVtonCostUsd(
  provider: VtonTelemetryProvider,
  customFalCostUsd = DEFAULT_VTON_COST_USD.FAL_CATVTON,
): number {
  if (provider === 'CACHE_HIT' || provider === 'MOCK') {
    return 0;
  }
  return Number(Math.max(0, customFalCostUsd).toFixed(6));
}

export class AiTelemetryRecorder {
  private readonly maxEntries: number;
  private readonly onRecord?: (entry: AiTelemetryRecord) => void;
  private persistence?: AiTelemetryPersistenceAdapter;
  private readonly records: AiTelemetryRecord[] = [];
  private readonly knownIds = new Set<string>();

  constructor(options: AiTelemetryRecorderOptions = {}) {
    this.maxEntries = Math.max(10, options.maxEntries ?? 1000);
    this.onRecord = options.onRecord;
    this.persistence = options.persistence;
  }

  public setPersistenceAdapter(
    adapter: AiTelemetryPersistenceAdapter | undefined,
  ): void {
    this.persistence = adapter;
  }

  public hydrateRecords(entries: readonly AiTelemetryRecord[]): number {
    let added = 0;
    for (const entry of entries) {
      if (!entry?.id || this.knownIds.has(entry.id)) {
        continue;
      }
      if (this.records.length >= this.maxEntries) {
        const evicted = this.records.shift();
        if (evicted) {
          this.knownIds.delete(evicted.id);
        }
      }
      this.records.push(entry);
      this.knownIds.add(entry.id);
      added += 1;
    }
    return added;
  }

  public async hydrateFromPersistence(limit = 500): Promise<number> {
    if (!this.persistence?.loadTelemetryEvents) {
      return 0;
    }
    try {
      const loaded = await this.persistence.loadTelemetryEvents(limit);
      return this.hydrateRecords(loaded);
    } catch {
      return 0;
    }
  }

  public record(input: RecordTelemetryInput): AiTelemetryRecord {
    const promptEvalCount = Math.max(
      0,
      input.promptEvalCount ?? input.promptTokens ?? 0,
    );
    const evalCount = Math.max(
      0,
      input.evalCount ?? input.completionTokens ?? 0,
    );
    const totalDurationMs = Number(
      Math.max(0, input.totalDurationMs ?? input.latencyMs).toFixed(2),
    );
    const tokensPerSec = Number(Math.max(0, input.tokensPerSec ?? 0).toFixed(2));
    const cacheHit = input.cacheHit === true || input.vtonProvider === 'CACHE_HIT';
    const rawVtonCost = cacheHit
      ? 0
      : (input.vtonCostUsd ??
        (input.vtonProvider ? estimateVtonCostUsd(input.vtonProvider) : 0));
    const vtonCostUsd = Number(Math.max(0, rawVtonCost).toFixed(6));
    const usedFallback = input.usedFallback ?? false;
    const aiProvider: AiTelemetryProvider =
      input.aiProvider ?? (usedFallback ? 'rule_fallback' : 'ollama');

    const entry: AiTelemetryRecord = {
      id: input.id ?? randomUUID(),
      timestamp: input.timestamp ?? new Date().toISOString(),
      actor_type: 'AI_COPILOT',
      aiProvider,
      modelUsed: input.modelUsed ?? (usedFallback ? 'rule-based-fallback' : 'qwen2.5:3b'),
      userId: input.userId,
      roles: [...input.roles],
      toolName: input.toolName,
      tier: input.tier,
      latencyMs: Math.max(0, Math.round(input.latencyMs)),
      promptTokens: promptEvalCount,
      completionTokens: evalCount,
      promptEvalCount,
      evalCount,
      totalDurationMs,
      tokensPerSec,
      costUsd: 0,
      estimatedCostUsd: 0,
      vtonCostUsd,
      cacheHit,
      ...(input.vtonProvider ? { vtonProvider: input.vtonProvider } : {}),
      correlationId: input.correlationId,
      traceId: input.traceId ?? input.correlationId,
      portal: input.portal ?? 'ADMIN_PORTAL',
      status: input.status ?? 'SUCCESS',
      usedFallback,
      metadata: input.metadata,
    };

    if (this.records.length >= this.maxEntries) {
      const evicted = this.records.shift();
      if (evicted) {
        this.knownIds.delete(evicted.id);
      }
    }
    this.records.push(entry);
    this.knownIds.add(entry.id);

    if (this.onRecord) {
      this.onRecord(entry);
    }

    if (this.persistence) {
      void this.persistence.persistTelemetryEvent(entry).catch(() => undefined);
    }

    return entry;
  }

  public getRecords(): readonly AiTelemetryRecord[] {
    return [...this.records];
  }

  public getSummary(): AiTelemetrySummary {
    const byTier: Record<RouterTier, number> = { 0: 0, 1: 0, 2: 0 };
    const byTool: Record<string, number> = {};

    let successCount = 0;
    let blockedGuardrailCount = 0;
    let blockedRbacCount = 0;
    let errorCount = 0;
    let cacheHitCount = 0;
    let cacheMissCount = 0;
    let vtonCallsCount = 0;
    let vtonCacheHitCount = 0;
    let vtonPaidCallsCount = 0;
    let totalPromptEvalCount = 0;
    let totalEvalCount = 0;
    let tokensPerSecSum = 0;
    let tokensPerSecSamples = 0;
    let totalVtonCostUsd = 0;
    let totalLatencyMs = 0;

    for (const item of this.records) {
      byTier[item.tier] = (byTier[item.tier] ?? 0) + 1;
      byTool[item.toolName] = (byTool[item.toolName] ?? 0) + 1;

      if (item.status === 'SUCCESS') successCount += 1;
      else if (item.status === 'BLOCKED_GUARDRAIL') blockedGuardrailCount += 1;
      else if (item.status === 'BLOCKED_RBAC') blockedRbacCount += 1;
      else errorCount += 1;

      if (item.cacheHit) cacheHitCount += 1;
      else cacheMissCount += 1;

      if (item.vtonProvider !== undefined || item.toolName === 'ai_tryon_vton') {
        vtonCallsCount += 1;
        if (item.cacheHit || item.vtonProvider === 'CACHE_HIT') {
          vtonCacheHitCount += 1;
        } else if (item.vtonCostUsd > 0) {
          vtonPaidCallsCount += 1;
        }
      }

      totalPromptEvalCount += item.promptEvalCount;
      totalEvalCount += item.evalCount;
      if (item.tokensPerSec > 0) {
        tokensPerSecSum += item.tokensPerSec;
        tokensPerSecSamples += 1;
      }
      totalVtonCostUsd += item.vtonCostUsd;
      totalLatencyMs += item.latencyMs;
    }

    const totalCalls = this.records.length;
    return {
      aiProvider: 'ollama',
      totalCalls,
      successCount,
      blockedGuardrailCount,
      blockedRbacCount,
      errorCount,
      cacheHitCount,
      cacheMissCount,
      cacheHitRatePct:
        totalCalls > 0
          ? Number(((cacheHitCount / totalCalls) * 100).toFixed(2))
          : 0,
      vtonCallsCount,
      vtonCacheHitCount,
      vtonPaidCallsCount,
      totalPromptTokens: totalPromptEvalCount,
      totalCompletionTokens: totalEvalCount,
      totalPromptEvalCount,
      totalEvalCount,
      averageTokensPerSec:
        tokensPerSecSamples > 0
          ? Number((tokensPerSecSum / tokensPerSecSamples).toFixed(2))
          : 0,
      totalCostUsd: 0,
      totalEstimatedCostUsd: 0,
      totalVtonCostUsd: Number(totalVtonCostUsd.toFixed(6)),
      averageLatencyMs:
        totalCalls > 0 ? Number((totalLatencyMs / totalCalls).toFixed(2)) : 0,
      byTier,
      byTool,
    };
  }

  public clear(): void {
    this.records.length = 0;
    this.knownIds.clear();
  }
}
