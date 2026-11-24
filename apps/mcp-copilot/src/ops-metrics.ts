import type { AiTelemetryRecorder } from '@atelier/ai-harness';
import type { OllamaAiProvider } from '@atelier/contracts';

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
        : this.lastTokensPerSec;
    const fallbackModeUsed =
      !meta.ollamaLiveAvailable ||
      (this.fallbackTurns > 0 && this.liveOllamaTurns === 0);

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
      totalPromptTokens: summary.totalPromptEvalCount,
      totalEvalTokens: summary.totalEvalCount,
      promptEvalCount: summary.totalPromptEvalCount,
      evalCount: summary.totalEvalCount,
      localCostUsd: 0,
      costUsd: 0,
      estimatedGeminiCostUsd: 0,
      fallbackModeUsed,
      totalToolCalls,
      averageLatencyMs: summary.averageLatencyMs,
      totalCompletionTokens: summary.totalEvalCount,
      vtonCostUsd: summary.totalVtonCostUsd,
      generatedAt: new Date().toISOString(),
    };
  }
}
