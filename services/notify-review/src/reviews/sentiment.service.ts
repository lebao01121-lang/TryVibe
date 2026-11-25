import { Inject, Injectable } from '@nestjs/common';
import {
  AiTelemetryRecorder,
  CircuitBreaker,
  OllamaModelClient,
  analyzeVietnameseSentimentWithOllama,
  maskPii,
  type AiTelemetrySummary,
  type CircuitState,
} from '@atelier/ai-harness';
import { createLogger } from '@atelier/observability';
import {
  NOTIFY_CONFIG_TOKEN,
  SERVICE_NAME,
  type NotifyReviewConfig,
} from '../config/env';

export type SentimentLabel = 'POSITIVE' | 'NEUTRAL' | 'NEGATIVE';

export interface ReviewSentimentResult {
  diemCamXucNlp: number;
  score: number;
  sentimentScore: number;
  sentimentLabel: SentimentLabel;
  provider: 'ollama' | 'vietnamese_lexicon_fallback';
  maskedInput: string;
  summary: string;
  modelUsed: string;
  tokensPerSec: number;
  promptEvalCount: number;
  evalCount: number;
  latencyMs: number;
  costUsd: 0;
  fallbackUsed: boolean;
  circuitState?: CircuitState;
}

const POSITIVE_LEXICON = [
  'đẹp',
  'mát',
  'rủ',
  'chuẩn',
  'sắc nét',
  'mềm',
  'tinh tế',
  'hài lòng',
  'ưng',
  'sang',
  'thoải mái',
  'thủ công',
  'chỉnh chu',
  'tôn dáng',
  'nhẹ',
  'mịn',
  'ấm',
  'tốt',
  'xuất sắc',
  'tuyệt',
  'chất lượng',
  'đáng tiền',
  'vừa vặn',
] as const;

const NEGATIVE_LEXICON = [
  'tệ',
  'xấu',
  'kém',
  'rách',
  'bẩn',
  'lỗi',
  'thất vọng',
  'ngứa',
  'cứng',
  'không vừa',
  'trả lại',
  'mỏng quá',
  'hơi chật',
  'chật',
  'bó',
  'kích',
  'rộng quá',
  'nhăn',
  'giao chậm',
  'không giống',
  'phai màu',
  'bục chỉ',
] as const;

function clampScore(value: number): number {
  const clamped = Math.min(1, Math.max(-1, value));
  return Math.round(clamped * 1000) / 1000;
}

export function deriveSentimentLabelFromScore(score: number): SentimentLabel {
  if (score >= 0.2) {
    return 'POSITIVE';
  }
  if (score <= -0.2) {
    return 'NEGATIVE';
  }
  return 'NEUTRAL';
}

/**
 * Deterministic Vietnamese lexicon fallback returning a normalized score in [-1, 1]
 * with pre-masked PII when local Ollama is offline or circuit-broken.
 */
export function computeFallbackVietnameseSentiment(
  text: string,
  rating?: number,
): Omit<ReviewSentimentResult, 'latencyMs'> {
  const maskedInput = maskPii(typeof text === 'string' ? text : String(text ?? '')).trim();
  const normalized = maskedInput.normalize('NFC').toLowerCase();

  let positiveHits = 0;
  for (const kw of POSITIVE_LEXICON) {
    if (normalized.includes(kw)) {
      positiveHits += 1;
    }
  }

  let negativeHits = 0;
  for (const kw of NEGATIVE_LEXICON) {
    if (normalized.includes(kw)) {
      negativeHits += 1;
    }
  }

  let score: number;
  if (typeof rating === 'number' && Number.isFinite(rating)) {
    const clampedRating = Math.min(5, Math.max(1, Math.round(rating)));
    const baseByRating: Record<number, number> = {
      1: -0.82,
      2: -0.45,
      3: 0.05,
      4: 0.58,
      5: 0.85,
    };
    score =
      (baseByRating[clampedRating] ?? 0.25) +
      Math.min(positiveHits, 4) * 0.05 -
      Math.min(negativeHits, 4) * 0.14;
  } else if (positiveHits === 0 && negativeHits === 0) {
    score = 0;
  } else {
    const net = positiveHits * 0.28 - negativeHits * 0.34;
    score = Math.tanh(net);
  }

  const finalScore = clampScore(score);
  const sentimentLabel = deriveSentimentLabelFromScore(finalScore);
  const summary =
    sentimentLabel === 'POSITIVE'
      ? 'Đánh giá tích cực về chất liệu và trải nghiệm sản phẩm.'
      : sentimentLabel === 'NEGATIVE'
        ? 'Đánh giá phản ánh trải nghiệm chưa hài lòng hoặc lỗi cần lưu ý.'
        : 'Đánh giá trung tính, ghi nhận cả ưu điểm và điểm cần lưu ý.';

  return {
    diemCamXucNlp: finalScore,
    score: finalScore,
    sentimentScore: finalScore,
    sentimentLabel,
    provider: 'vietnamese_lexicon_fallback',
    maskedInput,
    summary,
    modelUsed: 'vietnamese-lexicon-fallback',
    tokensPerSec: 0,
    promptEvalCount: 0,
    evalCount: 0,
    costUsd: 0,
    fallbackUsed: true,
  };
}

@Injectable()
export class SentimentService {
  private readonly logger = createLogger(`${SERVICE_NAME}:sentiment`);
  private readonly circuitBreaker: CircuitBreaker;
  private readonly ollamaClient: OllamaModelClient;
  private readonly telemetry: AiTelemetryRecorder;

  constructor(
    @Inject(NOTIFY_CONFIG_TOKEN)
    private readonly config: NotifyReviewConfig,
  ) {
    this.circuitBreaker = new CircuitBreaker({
      name: 'notify-review-sentiment-ollama',
      failureThreshold: 3,
      cooldownMs: 30_000,
    });
    this.ollamaClient = new OllamaModelClient({
      baseUrl: this.config.ollama.baseUrl,
      fastModel: this.config.ollama.fastModel,
      keepAlive: this.config.ollama.keepAlive,
      timeoutMs: this.config.ollama.sentimentTimeoutMs,
      circuitBreaker: this.circuitBreaker,
    });
    this.telemetry = new AiTelemetryRecorder({ maxEntries: 500 });
  }

  public getCircuitState(): CircuitState {
    return this.circuitBreaker.getState();
  }

  public getTelemetrySummary(): AiTelemetrySummary {
    return this.telemetry.getSummary();
  }

  /**
   * Unified Tier-1 Vietnamese NLP Sentiment powered by `@atelier/ai-harness`:
   * - Applies `maskPii` BEFORE invoking Ollama or lexicon fallback
   * - Protects Ollama (`qwen2.5:3b`) via shared `CircuitBreaker`
   * - Gracefully falls back to deterministic Vietnamese fashion lexicon when offline
   * - Records Layer 8 telemetry via `AiTelemetryRecorder`
   */
  public async analyzeVietnameseSentiment(
    text: string,
    rating?: number,
    context?: { correlationId?: string; userId?: string },
  ): Promise<ReviewSentimentResult> {
    const startedAt = Date.now();
    const cleanedText = (typeof text === 'string' ? text : String(text ?? ''))
      .trim()
      .slice(0, 1500);
    const preMaskedText = maskPii(cleanedText);

    try {
      const harnessResult = await analyzeVietnameseSentimentWithOllama(preMaskedText, {
        ollamaClient: this.ollamaClient,
        telemetry: this.telemetry,
        rating,
        timeoutMs: this.config.ollama.sentimentTimeoutMs,
        correlationId: context?.correlationId,
        userId: context?.userId,
      });

      let sentimentScore = clampScore(
        Number.isFinite(harnessResult.sentimentScore)
          ? harnessResult.sentimentScore
          : harnessResult.score,
      );
      const sentimentLabel: SentimentLabel = harnessResult.label;

      // Preserve sign/label consistency for downstream dashboards
      if (sentimentLabel === 'POSITIVE' && sentimentScore < 0.1) {
        sentimentScore = clampScore(Math.max(0.35, Math.abs(sentimentScore)));
      } else if (sentimentLabel === 'NEGATIVE' && sentimentScore > -0.1) {
        sentimentScore = clampScore(-Math.max(0.35, Math.abs(sentimentScore)));
      }

      if (harnessResult.fallbackUsed) {
        this.logger.warn(
          {
            modelUsed: harnessResult.modelUsed,
            provider: harnessResult.provider,
            circuitState: this.circuitBreaker.getState(),
            latencyMs: harnessResult.latencyMs,
            sentimentScore,
            sentimentLabel,
          },
          'Unified @atelier/ai-harness sentiment used Vietnamese lexicon fallback',
        );
      }

      return {
        diemCamXucNlp: sentimentScore,
        score: sentimentScore,
        sentimentScore,
        sentimentLabel,
        provider: harnessResult.provider,
        maskedInput: harnessResult.maskedInput,
        summary: harnessResult.summary,
        modelUsed: harnessResult.modelUsed,
        tokensPerSec: harnessResult.tokensPerSec,
        promptEvalCount: harnessResult.promptEvalCount,
        evalCount: harnessResult.evalCount,
        latencyMs: harnessResult.latencyMs,
        costUsd: 0,
        fallbackUsed: harnessResult.fallbackUsed,
        circuitState: this.circuitBreaker.getState(),
      };
    } catch (error: unknown) {
      const latencyMs = Math.max(0, Date.now() - startedAt);
      const fallback = computeFallbackVietnameseSentiment(preMaskedText, rating);

      this.telemetry.record({
        userId: context?.userId ?? 'notify-review-service',
        roles: ['SYSTEM'],
        toolName: 'analyze_vietnamese_sentiment',
        tier: 1,
        latencyMs,
        aiProvider: 'rule_fallback',
        modelUsed: fallback.modelUsed,
        correlationId: context?.correlationId ?? `sentiment-fallback-${Date.now()}`,
        status: 'ERROR',
        usedFallback: true,
        metadata: {
          provider: fallback.provider,
          sentimentLabel: fallback.sentimentLabel,
          circuitState: this.circuitBreaker.getState(),
        },
      });

      this.logger.warn(
        {
          model: this.config.ollama.fastModel,
          circuitState: this.circuitBreaker.getState(),
          latencyMs,
          fallbackScore: fallback.sentimentScore,
          fallbackLabel: fallback.sentimentLabel,
          err: error instanceof Error ? error.message : String(error),
        },
        'Unified @atelier/ai-harness sentiment threw unexpectedly; using Vietnamese lexicon fallback',
      );

      return {
        ...fallback,
        latencyMs,
        circuitState: this.circuitBreaker.getState(),
      };
    }
  }
}
