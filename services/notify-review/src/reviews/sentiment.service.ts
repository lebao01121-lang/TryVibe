import { Inject, Injectable } from '@nestjs/common';
import { createLogger } from '@atelier/observability';
import {
  NOTIFY_CONFIG_TOKEN,
  SERVICE_NAME,
  type NotifyReviewConfig,
} from '../config/env';

export type SentimentLabel = 'POSITIVE' | 'NEUTRAL' | 'NEGATIVE';

export interface ReviewSentimentResult {
  diemCamXucNlp: number;
  sentimentScore: number;
  sentimentLabel: SentimentLabel;
  summary: string;
  modelUsed: string;
  tokensPerSec: number;
  promptEvalCount: number;
  evalCount: number;
  latencyMs: number;
  costUsd: 0;
  fallbackUsed: boolean;
}

interface OllamaChatResponse {
  model?: string;
  message?: {
    role?: string;
    content?: string;
  };
  prompt_eval_count?: number;
  eval_count?: number;
  eval_duration?: number;
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

const SENTIMENT_JSON_SCHEMA = {
  type: 'object',
  properties: {
    sentimentScore: {
      type: 'number',
      minimum: -1,
      maximum: 1,
    },
    label: {
      type: 'string',
      enum: ['POSITIVE', 'NEUTRAL', 'NEGATIVE'],
    },
    summary: {
      type: 'string',
    },
  },
  required: ['sentimentScore', 'label', 'summary'],
};

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

function normalizeLabel(raw: unknown, fallbackScore: number): SentimentLabel {
  if (typeof raw === 'string') {
    const upper = raw.trim().toUpperCase();
    if (upper === 'POSITIVE' || upper === 'NEUTRAL' || upper === 'NEGATIVE') {
      return upper;
    }
  }
  return deriveSentimentLabelFromScore(fallbackScore);
}

function extractJsonObject(rawContent: string): Record<string, unknown> | null {
  const trimmed = rawContent.trim();
  const stripped = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  try {
    const parsed: unknown = JSON.parse(stripped);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    const firstBrace = stripped.indexOf('{');
    const lastBrace = stripped.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      try {
        const sliced: unknown = JSON.parse(stripped.slice(firstBrace, lastBrace + 1));
        if (sliced && typeof sliced === 'object' && !Array.isArray(sliced)) {
          return sliced as Record<string, unknown>;
        }
      } catch {
        return null;
      }
    }
  }
  return null;
}

/**
 * Deterministic Vietnamese lexicon fallback returning a normalized score in [-1, 1]
 * when local Ollama is offline or times out.
 */
export function computeFallbackVietnameseSentiment(
  text: string,
  rating?: number,
): Omit<ReviewSentimentResult, 'latencyMs'> {
  const normalized = text.normalize('NFC').toLowerCase();

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
    const clampedRating = Math.min(5, Math.max(1, rating));
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
    sentimentScore: finalScore,
    sentimentLabel,
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

  constructor(
    @Inject(NOTIFY_CONFIG_TOKEN)
    private readonly config: NotifyReviewConfig,
  ) {}

  /**
   * Tier-1 Local Ollama NLP Sentiment (`qwen2.5:3b`) with structured JSON format
   * (`{ sentimentScore, label, summary }`), 10s timeout, and deterministic
   * Vietnamese lexicon fallback if Ollama is unreachable.
   */
  public async analyzeVietnameseSentiment(
    text: string,
    rating?: number,
  ): Promise<ReviewSentimentResult> {
    const startedAt = Date.now();
    const cleanedText = text.trim().slice(0, 1500);
    const endpoint = `${this.config.ollama.baseUrl}/api/chat`;
    const model = this.config.ollama.fastModel;

    try {
      const userPrompt =
        typeof rating === 'number' && Number.isFinite(rating)
          ? `Điểm sao: ${rating}/5. Nhận xét khách hàng: "${cleanedText}"`
          : `Nhận xét khách hàng: "${cleanedText}"`;

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model,
          stream: false,
          keep_alive: this.config.ollama.keepAlive,
          options: {
            temperature: 0.1,
            top_p: 0.9,
            num_ctx: 2048,
          },
          format: SENTIMENT_JSON_SCHEMA,
          messages: [
            {
              role: 'system',
              content:
                'Bạn là bộ phân tích cảm xúc đánh giá thời trang tiếng Việt của Tầm Xuân Fashion Atelier. Hãy chấm điểm cảm xúc từ -1.0 (rất tiêu cực) đến 1.0 (rất tích cực), gán nhãn POSITIVE / NEUTRAL / NEGATIVE, và viết 1 câu tóm tắt tiếng Việt ngắn gọn. Trả về DUY NHẤT JSON hợp lệ theo đúng schema.',
            },
            {
              role: 'user',
              content: userPrompt,
            },
          ],
        }),
        signal: AbortSignal.timeout(this.config.ollama.sentimentTimeoutMs),
      });

      if (!response.ok) {
        throw new Error(`Ollama /api/chat returned HTTP ${response.status}`);
      }

      const raw = (await response.json()) as OllamaChatResponse;
      const content = raw.message?.content ?? '';
      const parsed = extractJsonObject(content);
      if (!parsed) {
        throw new Error('Ollama returned non-JSON sentiment content');
      }

      const rawScore = Number(parsed.sentimentScore);
      const fallback = computeFallbackVietnameseSentiment(cleanedText, rating);
      let sentimentScore = Number.isFinite(rawScore)
        ? clampScore(rawScore)
        : fallback.sentimentScore;
      const sentimentLabel = normalizeLabel(parsed.label, sentimentScore);

      // Keep label and sign consistent if a small quantized model returns slight mismatch
      if (sentimentLabel === 'POSITIVE' && sentimentScore < 0.1) {
        sentimentScore = clampScore(Math.max(0.35, Math.abs(sentimentScore)));
      } else if (sentimentLabel === 'NEGATIVE' && sentimentScore > -0.1) {
        sentimentScore = clampScore(-Math.max(0.35, Math.abs(sentimentScore)));
      }

      const summary =
        typeof parsed.summary === 'string' && parsed.summary.trim().length > 0
          ? parsed.summary.trim().slice(0, 280)
          : fallback.summary;

      const promptEvalCount = Number(raw.prompt_eval_count ?? 0);
      const evalCount = Number(raw.eval_count ?? 0);
      const evalDurationNs = Number(raw.eval_duration ?? 0);
      const tokensPerSec =
        evalCount > 0 && evalDurationNs > 0
          ? Math.round((evalCount / (evalDurationNs / 1e9)) * 100) / 100
          : 0;
      const latencyMs = Date.now() - startedAt;

      return {
        diemCamXucNlp: sentimentScore,
        sentimentScore,
        sentimentLabel,
        summary,
        modelUsed: raw.model || model,
        tokensPerSec,
        promptEvalCount,
        evalCount,
        latencyMs,
        costUsd: 0,
        fallbackUsed: false,
      };
    } catch (error: unknown) {
      const latencyMs = Date.now() - startedAt;
      const fallback = computeFallbackVietnameseSentiment(cleanedText, rating);
      this.logger.warn(
        {
          endpoint,
          model,
          latencyMs,
          fallbackScore: fallback.sentimentScore,
          fallbackLabel: fallback.sentimentLabel,
          err: error instanceof Error ? error.message : String(error),
        },
        'Ollama Tier-1 sentiment unavailable; using deterministic Vietnamese lexicon fallback',
      );
      return {
        ...fallback,
        latencyMs,
      };
    }
  }
}
