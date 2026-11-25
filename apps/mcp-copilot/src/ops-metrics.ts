import {
  computeCopilotFeedbackSummary,
  maskPii,
  type AiTelemetryRecorder,
  type CopilotFeedbackRating,
  type CopilotFeedbackSummary,
} from '@atelier/ai-harness';
import type { OllamaAiProvider } from '@atelier/contracts';
import type { PersistedTelemetryTotals } from './rag-service.js';

export interface CopilotOpsMetricsSnapshot {
  aiProvider: OllamaAiProvider;
  activeMainModel: string;
  activeFastModel: string;
  activeEmbedModel: string;
  embedDim: number;
  modelUsed: string;
  embedModel: string;
  totalChatTurns: number;
  toolCallsByName: Record<string, number>;
  semanticCacheHits: number;
  semanticCacheHitRatePct: number;
  promptInjectionsBlocked: number;
  rbacDenials: number;
  avgTokensPerSec: number;
  tokensPerSec: number;
  totalPromptTokens: number;
  totalEvalTokens: number;
  promptEvalCount: number;
  evalCount: number;
  localCostUsd: 0;
  costUsd: 0;
  estimatedGeminiCostUsd: 0;
  fallbackModeUsed: boolean;
  totalToolCalls: number;
  averageLatencyMs: number;
  totalCompletionTokens: number;
  vtonCostUsd: number;
  feedbackSummary: CopilotFeedbackSummary;
  copilotFeedback: CopilotFeedbackSummary;
  persistenceBackend: string;
  generatedAt: string;
}

export class CopilotOpsMetricsTracker {
  private totalChatTurns = 0;
  private readonly toolCallsByName = new Map<string, number>();
  private semanticCacheHits = 0;
  private semanticCacheLookups = 0;
  private promptInjectionsBlocked = 0;
  private rbacDenials = 0;
  private fallbackTurns = 0;
  private liveOllamaTurns = 0;
  private lastModelUsed = '';
  private lastTokensPerSec = 0;
  private feedbackThumbsUp = 0;
  private feedbackThumbsDown = 0;
  private recentFeedbackReasons: string[] = [];
  private hydratedFromDb = false;
  private persistedBaselinePromptTokens = 0;
  private persistedBaselineEvalTokens = 0;
  private persistedBaselineLatencyMs = 0;
  private persistedBaselineAvgTps = 0;

  public hydrateFromPersistence(
    totals: PersistedTelemetryTotals,
    feedbackSummary: CopilotFeedbackSummary,
  ): void {
    if (this.hydratedFromDb) {
      return;
    }
    this.hydratedFromDb = true;
    this.totalChatTurns += Math.max(0, totals.totalEvents);
    for (const [toolName, count] of Object.entries(totals.toolCallsByName)) {
      if (count > 0) {
        this.toolCallsByName.set(
          toolName,
          (this.toolCallsByName.get(toolName) ?? 0) + count,
        );
      }
    }
    this.semanticCacheHits += Math.max(0, totals.semanticCacheHits);
    this.semanticCacheLookups += Math.max(
      totals.semanticCacheHits,
      totals.semanticCacheLookups,
    );
    this.promptInjectionsBlocked += Math.max(0, totals.promptInjectionsBlocked);
    this.rbacDenials += Math.max(0, totals.rbacDenials);
    this.feedbackThumbsUp += Math.max(0, feedbackSummary.thumbsUp);
    this.feedbackThumbsDown += Math.max(0, feedbackSummary.thumbsDown);
    if (Array.isArray(feedbackSummary.recentReasons)) {
      for (const reason of feedbackSummary.recentReasons) {
        const cleaned = maskPii(String(reason)).trim();
        if (cleaned && !this.recentFeedbackReasons.includes(cleaned)) {
          this.recentFeedbackReasons.push(cleaned);
        }
      }
      this.recentFeedbackReasons = this.recentFeedbackReasons.slice(0, 10);
    }
    if (!this.lastModelUsed && totals.lastModelUsed) {
      this.lastModelUsed = totals.lastModelUsed;
    }
    if (this.lastTokensPerSec === 0 && totals.lastTokensPerSec > 0) {
      this.lastTokensPerSec = totals.lastTokensPerSec;
    }
    this.persistedBaselinePromptTokens = Math.max(0, totals.totalPromptTokens);
    this.persistedBaselineEvalTokens = Math.max(0, totals.totalEvalTokens);
    this.persistedBaselineLatencyMs = Math.max(0, totals.averageLatencyMs);
    this.persistedBaselineAvgTps = Math.max(0, totals.averageTokensPerSec);
  }

  public recordFeedback(
    rating: CopilotFeedbackRating,
    reason?: string | null,
  ): CopilotFeedbackSummary {
    if (rating === 'UP') {
      this.feedbackThumbsUp += 1;
    } else {
      this.feedbackThumbsDown += 1;
    }
    if (typeof reason === 'string' && reason.trim().length > 0) {
      const cleaned = maskPii(reason.trim()).slice(0, 240);
      this.recentFeedbackReasons = [
        cleaned,
        ...this.recentFeedbackReasons.filter((r) => r !== cleaned),
      ].slice(0, 10);
    }
    return this.getFeedbackSummary();
  }

  public getFeedbackSummary(): CopilotFeedbackSummary {
    return computeCopilotFeedbackSummary(
      this.feedbackThumbsUp,
      this.feedbackThumbsDown,
      this.recentFeedbackReasons,
    );
  }

  public recordChatTurn(params: {
    toolNames: readonly string[];
    cacheLookup?: boolean;
    cacheHit?: boolean;
    promptInjectionBlocked?: boolean;
    rbacDenied?: boolean;
    fallbackUsed?: boolean;
    modelUsed?: string;
    tokensPerSec?: number;
  }): void {
    this.totalChatTurns += 1;

    for (const name of params.toolNames) {
      this.toolCallsByName.set(name, (this.toolCallsByName.get(name) ?? 0) + 1);
    }

    if (params.cacheLookup) {
      this.semanticCacheLookups += 1;
      if (params.cacheHit) {
        this.semanticCacheHits += 1;
      }
    } else if (params.cacheHit) {
      this.semanticCacheLookups += 1;
      this.semanticCacheHits += 1;
    }

    if (params.promptInjectionBlocked) {
      this.promptInjectionsBlocked += 1;
    }

    if (params.rbacDenied) {
      this.rbacDenials += 1;
    }

    if (params.fallbackUsed) {
      this.fallbackTurns += 1;
    } else {
      this.liveOllamaTurns += 1;
    }

    if (params.modelUsed) {
      this.lastModelUsed = params.modelUsed;
    }
    if (typeof params.tokensPerSec === 'number' && params.tokensPerSec > 0) {
      this.lastTokensPerSec = params.tokensPerSec;
    }
  }

  public recordRbacDenial(): void {
    this.totalChatTurns += 1;
    this.rbacDenials += 1;
  }

  public snapshot(
    telemetry: AiTelemetryRecorder,
    meta: {
      activeMainModel: string;
      activeFastModel: string;
      activeEmbedModel: string;
      embedDim: number;
      ollamaLiveAvailable: boolean;
      persistenceBackend?: string;
      feedbackSummaryOverride?: CopilotFeedbackSummary;
    },
  ): CopilotOpsMetricsSnapshot {
    const summary = telemetry.getSummary();
    const toolCallsByNameObj: Record<string, number> = {};
    let totalToolCalls = 0;

    for (const [name, count] of this.toolCallsByName.entries()) {
      toolCallsByNameObj[name] = count;
      totalToolCalls += count;
    }

    const hitRatePct =
      this.semanticCacheLookups > 0
        ? Number(
            ((this.semanticCacheHits / this.semanticCacheLookups) * 100).toFixed(2),
          )
        : 0;

    const avgTokensPerSec =
      summary.averageTokensPerSec > 0
        ? summary.averageTokensPerSec
        : this.lastTokensPerSec || this.persistedBaselineAvgTps;
    const totalPromptTokens = Math.max(
      summary.totalPromptEvalCount,
      this.persistedBaselinePromptTokens,
    );
    const totalEvalTokens = Math.max(
      summary.totalEvalCount,
      this.persistedBaselineEvalTokens,
    );
    const averageLatencyMs =
      summary.averageLatencyMs > 0
        ? summary.averageLatencyMs
        : this.persistedBaselineLatencyMs;

    const fallbackModeUsed =
      !meta.ollamaLiveAvailable ||
      (this.fallbackTurns > 0 && this.liveOllamaTurns === 0);
    const feedbackSummary =
      meta.feedbackSummaryOverride ?? this.getFeedbackSummary();

    return {
      aiProvider: fallbackModeUsed ? 'rule_fallback' : 'ollama',
      activeMainModel: meta.activeMainModel,
      activeFastModel: meta.activeFastModel,
      activeEmbedModel: meta.activeEmbedModel,
      embedDim: meta.embedDim,
      modelUsed: this.lastModelUsed || meta.activeMainModel,
      embedModel: meta.activeEmbedModel,
      totalChatTurns: this.totalChatTurns,
      toolCallsByName: toolCallsByNameObj,
      semanticCacheHits: this.semanticCacheHits,
      semanticCacheHitRatePct: hitRatePct,
      promptInjectionsBlocked: this.promptInjectionsBlocked,
      rbacDenials: this.rbacDenials,
      avgTokensPerSec,
      tokensPerSec: avgTokensPerSec,
      totalPromptTokens,
      totalEvalTokens,
      promptEvalCount: totalPromptTokens,
      evalCount: totalEvalTokens,
      localCostUsd: 0,
      costUsd: 0,
      estimatedGeminiCostUsd: 0,
      fallbackModeUsed,
      totalToolCalls,
      averageLatencyMs,
      totalCompletionTokens: totalEvalTokens,
      vtonCostUsd: summary.totalVtonCostUsd,
      feedbackSummary,
      copilotFeedback: feedbackSummary,
      persistenceBackend: meta.persistenceBackend ?? 'in-memory',
      generatedAt: new Date().toISOString(),
    };
  }
}
