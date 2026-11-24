import { existsSync } from 'node:fs';
import os from 'node:os';
import {
  CircuitBreaker,
  CircuitBreakerOpenError,
  type CircuitState,
} from './circuit-breaker';

export const DEFAULT_OLLAMA_BASE_URL_HOST = 'http://127.0.0.1:11434';
export const DEFAULT_OLLAMA_BASE_URL_DOCKER = 'http://host.docker.internal:11434';
export const DEFAULT_OLLAMA_MAIN_MODEL = 'qwen2.5:7b';
export const DEFAULT_OLLAMA_FAST_MODEL = 'qwen2.5:3b';
export const DEFAULT_OLLAMA_EMBED_MODEL = 'nomic-embed-text';
export const DEFAULT_OLLAMA_EMBED_DIM = 768;
export const DEFAULT_OLLAMA_NUM_CTX = 8192;
export const DEFAULT_OLLAMA_KEEP_ALIVE = '30m';
export const DEFAULT_OLLAMA_TIMEOUT_MS = 30_000;

export interface OllamaToolFunctionSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface OllamaToolDefinition {
  type: 'function';
  function: OllamaToolFunctionSchema;
}

export interface OllamaToolCall {
  id?: string;
  function: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

export interface OllamaChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: OllamaToolCall[];
  tool_name?: string;
}

export interface OllamaClientOptions {
  baseUrl?: string;
  mainModel?: string;
  fastModel?: string;
  embedModel?: string;
  numCtx?: number;
  keepAlive?: string;
  timeoutMs?: number;
  circuitBreaker?: CircuitBreaker;
  offlineMode?: boolean;
}

export interface OllamaChatRequest {
  model?: string;
  messages: readonly OllamaChatMessage[];
  tools?: readonly OllamaToolDefinition[];
  jsonSchema?: Record<string, unknown>;
  format?: 'json' | Record<string, unknown>;
  temperature?: number;
  topP?: number;
  numCtx?: number;
  keepAlive?: string;
  timeoutMs?: number;
  allowFallback?: boolean;
  fallbackText?: string;
}

export interface OllamaChatResponse {
  content: string;
  toolCalls: OllamaToolCall[];
  model: string;
  aiProvider: 'ollama' | 'rule_fallback';
  usedFallback: boolean;
  fallbackReason?: string;
  promptEvalCount: number;
  evalCount: number;
  totalDurationMs: number;
  evalDurationMs: number;
  tokensPerSec: number;
  latencyMs: number;
  costUsd: 0;
  circuitState: CircuitState;
}

export interface OllamaStreamChunk {
  delta: string;
  done: boolean;
  toolCalls?: OllamaToolCall[];
  model?: string;
  promptEvalCount?: number;
  evalCount?: number;
  totalDurationMs?: number;
  evalDurationMs?: number;
  tokensPerSec?: number;
  costUsd: 0;
}

export interface OllamaHealthResult {
  reachable: boolean;
  baseUrl: string;
  models: string[];
  activeMainModel: string;
  activeFastModel: string;
  activeEmbedModel: string;
  circuitState: CircuitState;
  latencyMs: number;
}

export interface OllamaEmbeddingOptions {
  baseUrl?: string;
  model?: string;
  dimension?: number;
  keepAlive?: string;
  timeoutMs?: number;
  offlineMode?: boolean;
}

export interface OllamaEmbeddingResult {
  embedding: number[];
  model: string;
  dimension: number;
  usedFallback: boolean;
  latencyMs: number;
  costUsd: 0;
}

export interface OllamaBatchEmbeddingResult {
  embeddings: number[][];
  model: string;
  dimension: number;
  usedFallback: boolean;
  latencyMs: number;
  costUsd: 0;
}

export function resolveOllamaBaseUrl(explicitBaseUrl?: string): string {
  const configured = (explicitBaseUrl ?? process.env.OLLAMA_BASE_URL ?? '').trim();
  if (configured) {
    return configured.replace(/\/+$/, '');
  }
  const inDocker = existsSync('/.dockerenv');
  return inDocker ? DEFAULT_OLLAMA_BASE_URL_DOCKER : DEFAULT_OLLAMA_BASE_URL_HOST;
}

function modelMatchesName(installed: string, target: string): boolean {
  const normInstalled = installed.trim().toLowerCase();
  const normTarget = target.trim().toLowerCase();
  if (!normInstalled || !normTarget) {
    return false;
  }
  return (
    normInstalled === normTarget ||
    normInstalled === `${normTarget}:latest` ||
    normInstalled.startsWith(`${normTarget}-`)
  );
}

function hasInstalledModel(
  installedModels: readonly string[],
  target: string,
): boolean {
  return installedModels.some((m) => modelMatchesName(m, target));
}

export function resolveDefaultMainModel(
  installedModels?: readonly string[],
  explicitModel?: string,
): string {
  const configured = (explicitModel ?? process.env.OLLAMA_MAIN_MODEL ?? '').trim();
  const totalRamGb = os.totalmem() / (1024 * 1024 * 1024);
  const freeRamGb = os.freemem() / (1024 * 1024 * 1024);
  const isConstrainedRam = totalRamGb <= 16.5 || freeRamGb < 6;

  if (installedModels && installedModels.length > 0) {
    if (configured && hasInstalledModel(installedModels, configured)) {
      return configured;
    }

    if (
      isConstrainedRam &&
      !hasInstalledModel(installedModels, DEFAULT_OLLAMA_MAIN_MODEL) &&
      hasInstalledModel(installedModels, DEFAULT_OLLAMA_FAST_MODEL)
    ) {
      return DEFAULT_OLLAMA_FAST_MODEL;
    }

    if (hasInstalledModel(installedModels, DEFAULT_OLLAMA_MAIN_MODEL)) {
      return DEFAULT_OLLAMA_MAIN_MODEL;
    }

    if (hasInstalledModel(installedModels, DEFAULT_OLLAMA_FAST_MODEL)) {
      return DEFAULT_OLLAMA_FAST_MODEL;
    }

    if (configured) {
      return configured;
    }

    return installedModels[0];
  }

  if (configured) {
    return configured;
  }

  return isConstrainedRam ? DEFAULT_OLLAMA_FAST_MODEL : DEFAULT_OLLAMA_MAIN_MODEL;
}

function normalizeToolCallEntry(raw: unknown): OllamaToolCall | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  const obj = raw as Record<string, unknown>;
  const fnObj =
    obj.function && typeof obj.function === 'object' && !Array.isArray(obj.function)
      ? (obj.function as Record<string, unknown>)
      : obj;

  const name = typeof fnObj.name === 'string' ? fnObj.name.trim() : '';
  if (!name) {
    return null;
  }

  let args: Record<string, unknown> = {};
  const rawArgs = fnObj.arguments ?? fnObj.args ?? fnObj.parameters;
  if (typeof rawArgs === 'string') {
    try {
      const parsed: unknown = JSON.parse(rawArgs);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        args = parsed as Record<string, unknown>;
      }
    } catch {
      args = {};
    }
  } else if (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)) {
    args = rawArgs as Record<string, unknown>;
  }

  return {
    ...(typeof obj.id === 'string' && obj.id ? { id: obj.id } : {}),
    function: {
      name,
      arguments: args,
    },
  };
}

function extractToolCallsFromJsonBlock(jsonCandidate: string): OllamaToolCall[] {
  const trimmed = jsonCandidate.trim();
  if (!trimmed) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      return parsed
        .map((item) => normalizeToolCallEntry(item))
        .filter((tc): tc is OllamaToolCall => tc !== null);
    }
    if (parsed && typeof parsed === 'object') {
      const rec = parsed as Record<string, unknown>;
      if (Array.isArray(rec.tool_calls)) {
        return rec.tool_calls
          .map((item) => normalizeToolCallEntry(item))
          .filter((tc): tc is OllamaToolCall => tc !== null);
      }
      if (rec.tool_call && typeof rec.tool_call === 'object') {
        const single = normalizeToolCallEntry(rec.tool_call);
        return single ? [single] : [];
      }
      const direct = normalizeToolCallEntry(rec);
      return direct ? [direct] : [];
    }
    return [];
  } catch {
    return [];
  }
}

/**
 * Fallback parser for quantized local models (e.g. Qwen2.5 3B/7B) that occasionally
 * emit `<tool_call>{...}</tool_call>` tags or fenced ```json tool-call blocks inside `message.content`.
 */
export function parseToolCallsFromContent(content: string): {
  toolCalls: OllamaToolCall[];
  cleanedContent: string;
} {
  if (!content || typeof content !== 'string') {
    return { toolCalls: [], cleanedContent: '' };
  }

  const found: OllamaToolCall[] = [];
  let cleaned = content;

  // 1. Parse <tool_call>...</tool_call> tags
  const tagRegex = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi;
  cleaned = cleaned.replace(tagRegex, (fullMatch, inner: string) => {
    const parsed = extractToolCallsFromJsonBlock(inner);
    if (parsed.length > 0) {
      found.push(...parsed);
      return '';
    }
    return fullMatch;
  });

  // 2. Parse fenced ```json ... ``` blocks that carry tool call structures
  if (found.length === 0) {
    const fenceRegex = /```(?:json)?\s*([\s\S]*?)```/gi;
    cleaned = cleaned.replace(fenceRegex, (fullMatch, inner: string) => {
      const parsed = extractToolCallsFromJsonBlock(inner);
      if (parsed.length > 0) {
        found.push(...parsed);
        return '';
      }
      return fullMatch;
    });
  }

  return {
    toolCalls: found,
    cleanedContent: cleaned.replace(/\n{3,}/g, '\n\n').trim(),
  };
}

interface RawOllamaChatResponse {
  model?: string;
  message?: {
    role?: string;
    content?: string;
    tool_calls?: unknown[];
  };
  done?: boolean;
  total_duration?: number;
  eval_duration?: number;
  prompt_eval_count?: number;
  eval_count?: number;
}

export class OllamaModelClient {
  private readonly baseUrl: string;
  private readonly configuredMainModel?: string;
  private readonly fastModel: string;
  private readonly embedModel: string;
  private readonly numCtx: number;
  private readonly keepAlive: string;
  private readonly timeoutMs: number;
  private readonly circuitBreaker: CircuitBreaker;
  private readonly offlineMode: boolean;

  private cachedInstalledModels: string[] | null = null;
  private modelsCachedAt = 0;

  constructor(options: OllamaClientOptions = {}) {
    this.offlineMode = options.offlineMode === true || options.baseUrl === '';
    this.baseUrl = this.offlineMode ? '' : resolveOllamaBaseUrl(options.baseUrl);
    this.configuredMainModel =
      options.mainModel?.trim() || process.env.OLLAMA_MAIN_MODEL?.trim() || undefined;
    this.fastModel =
      options.fastModel?.trim() ||
      process.env.OLLAMA_FAST_MODEL?.trim() ||
      DEFAULT_OLLAMA_FAST_MODEL;
    this.embedModel =
      options.embedModel?.trim() ||
      process.env.OLLAMA_EMBED_MODEL?.trim() ||
      DEFAULT_OLLAMA_EMBED_MODEL;
    const envCtx = Number(process.env.OLLAMA_NUM_CTX ?? DEFAULT_OLLAMA_NUM_CTX);
    this.numCtx =
      options.numCtx ??
      (Number.isFinite(envCtx) && envCtx > 0 ? envCtx : DEFAULT_OLLAMA_NUM_CTX);
    this.keepAlive =
      options.keepAlive ?? process.env.OLLAMA_KEEP_ALIVE ?? DEFAULT_OLLAMA_KEEP_ALIVE;
    const envTimeout = Number(
      process.env.OLLAMA_TIMEOUT_MS ?? DEFAULT_OLLAMA_TIMEOUT_MS,
    );
    this.timeoutMs =
      options.timeoutMs ??
      (Number.isFinite(envTimeout) && envTimeout > 0
        ? envTimeout
        : DEFAULT_OLLAMA_TIMEOUT_MS);
    this.circuitBreaker =
      options.circuitBreaker ??
      new CircuitBreaker({
        name: 'ollama-model-client',
        failureThreshold: 3,
        cooldownMs: 30_000,
      });
  }

  public getBaseUrl(): string {
    return this.baseUrl;
  }

  public getTimeoutMs(): number {
    return this.timeoutMs;
  }

  public getFastModel(): string {
    return this.fastModel;
  }

  public getEmbedModel(): string {
    return this.embedModel;
  }

  public getMainModel(): string {
    return resolveDefaultMainModel(
      this.cachedInstalledModels ?? undefined,
      this.configuredMainModel,
    );
  }

  public getCircuitBreaker(): CircuitBreaker {
    return this.circuitBreaker;
  }

  public isOfflineMode(): boolean {
    return this.offlineMode;
  }

  public isLiveAvailable(): boolean {
    return !this.offlineMode && this.circuitBreaker.getState() !== 'OPEN';
  }

  public async listModels(forceRefresh = false): Promise<string[]> {
    if (this.offlineMode || !this.baseUrl) {
      return [];
    }
    const now = Date.now();
    if (
      !forceRefresh &&
      this.cachedInstalledModels &&
      now - this.modelsCachedAt < 15_000
    ) {
      return [...this.cachedInstalledModels];
    }

    const response = await fetch(`${this.baseUrl}/api/tags`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(3_000),
    });

    if (!response.ok) {
      throw new Error(`Ollama /api/tags returned HTTP ${response.status}`);
    }

    const data = (await response.json()) as {
      models?: Array<{ name?: string; model?: string }>;
    };
    const names = (data.models ?? [])
      .map((m) => (m.name ?? m.model ?? '').trim())
      .filter(Boolean);

    this.cachedInstalledModels = names;
    this.modelsCachedAt = now;
    return [...names];
  }

  public async checkHealth(): Promise<OllamaHealthResult> {
    const startedAt = Date.now();
    if (this.offlineMode || !this.baseUrl) {
      return {
        reachable: false,
        baseUrl: this.baseUrl || DEFAULT_OLLAMA_BASE_URL_HOST,
        models: [],
        activeMainModel: this.getMainModel(),
        activeFastModel: this.fastModel,
        activeEmbedModel: this.embedModel,
        circuitState: this.circuitBreaker.getState(),
        latencyMs: Date.now() - startedAt,
      };
    }

    try {
      const models = await this.listModels(true);
      const activeMainModel = resolveDefaultMainModel(
        models,
        this.configuredMainModel,
      );
      return {
        reachable: true,
        baseUrl: this.baseUrl,
        models,
        activeMainModel,
        activeFastModel: this.fastModel,
        activeEmbedModel: this.embedModel,
        circuitState: this.circuitBreaker.getState(),
        latencyMs: Date.now() - startedAt,
      };
    } catch {
      return {
        reachable: false,
        baseUrl: this.baseUrl,
        models: [],
        activeMainModel: this.getMainModel(),
        activeFastModel: this.fastModel,
        activeEmbedModel: this.embedModel,
        circuitState: this.circuitBreaker.getState(),
        latencyMs: Date.now() - startedAt,
      };
    }
  }

  private buildDeterministicFallback(
    request: OllamaChatRequest,
    reason: string,
    startedAt: number,
  ): OllamaChatResponse {
    const content =
      request.fallbackText ??
      JSON.stringify({
        mode: 'RULE_BASED_FALLBACK',
        reason,
        summary:
          'He thong Ollama local tam thoi ngoai tuyen — dang su dung che do du phong xac dinh (RuleBasedFallback).',
      });

    const elapsed = Math.max(0, Date.now() - startedAt);
    return {
      content,
      toolCalls: [],
      model: `${request.model ?? this.getMainModel()}:rule-fallback`,
      aiProvider: 'rule_fallback',
      usedFallback: true,
      fallbackReason: reason,
      promptEvalCount: 0,
      evalCount: 0,
      totalDurationMs: elapsed,
      evalDurationMs: 0,
      tokensPerSec: 0,
      latencyMs: elapsed,
      costUsd: 0,
      circuitState: this.circuitBreaker.getState(),
    };
  }

  private async resolveModelForRequest(explicitModel?: string): Promise<string> {
    if (!this.cachedInstalledModels && !this.offlineMode && this.baseUrl) {
      await this.listModels().catch(() => []);
    }
    if (explicitModel && explicitModel.trim()) {
      if (
        this.cachedInstalledModels &&
        this.cachedInstalledModels.length > 0 &&
        !hasInstalledModel(this.cachedInstalledModels, explicitModel) &&
        hasInstalledModel(this.cachedInstalledModels, this.fastModel)
      ) {
        return this.fastModel;
      }
      return explicitModel.trim();
    }
    return resolveDefaultMainModel(
      this.cachedInstalledModels ?? undefined,
      this.configuredMainModel,
    );
  }

  public async chat(request: OllamaChatRequest): Promise<OllamaChatResponse> {
    const startedAt = Date.now();
    const allowFallback = request.allowFallback ?? true;

    if (this.offlineMode || !this.baseUrl) {
      if (!allowFallback) {
        throw new Error('OllamaModelClient is configured in offline mode');
      }
      return this.buildDeterministicFallback(
        request,
        'OLLAMA_OFFLINE_MODE',
        startedAt,
      );
    }

    if (this.circuitBreaker.getState() === 'OPEN') {
      if (!allowFallback) {
        const snapshot = this.circuitBreaker.getSnapshot();
        throw new CircuitBreakerOpenError(snapshot.name, snapshot.cooldownMs);
      }
      return this.buildDeterministicFallback(
        request,
        'CIRCUIT_BREAKER_OPEN',
        startedAt,
      );
    }

    try {
      const targetModel = await this.resolveModelForRequest(request.model);
      const timeoutMs = request.timeoutMs ?? this.timeoutMs;
      const bodyPayload: Record<string, unknown> = {
        model: targetModel,
        messages: request.messages,
        stream: false,
        keep_alive: request.keepAlive ?? this.keepAlive,
        options: {
          temperature: request.temperature ?? 0.1,
          top_p: request.topP ?? 0.9,
          num_ctx: request.numCtx ?? this.numCtx,
        },
      };

      if (request.tools && request.tools.length > 0) {
        bodyPayload.tools = request.tools;
      }
      if (request.jsonSchema) {
        bodyPayload.format = request.jsonSchema;
      } else if (request.format) {
        bodyPayload.format = request.format;
      }

      const raw = await this.circuitBreaker.execute(async () => {
        const response = await fetch(`${this.baseUrl}/api/chat`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify(bodyPayload),
          signal: AbortSignal.timeout(timeoutMs),
        });

        if (!response.ok) {
          const errText = await response.text().catch(() => '');
          throw new Error(
            `Ollama /api/chat failed (${response.status}): ${errText.slice(0, 200)}`,
          );
        }

        return (await response.json()) as RawOllamaChatResponse;
      });

      const rawContent = raw.message?.content ?? '';
      let toolCalls: OllamaToolCall[] = Array.isArray(raw.message?.tool_calls)
        ? raw.message.tool_calls
            .map((entry) => normalizeToolCallEntry(entry))
            .filter((tc): tc is OllamaToolCall => tc !== null)
        : [];
      let content = rawContent;

      if (toolCalls.length === 0 && rawContent) {
        const parsedFallback = parseToolCallsFromContent(rawContent);
        if (parsedFallback.toolCalls.length > 0) {
          toolCalls = parsedFallback.toolCalls;
          content = parsedFallback.cleanedContent;
        }
      }

      const latencyMs = Math.max(0, Date.now() - startedAt);
      const promptEvalCount = Math.max(0, Number(raw.prompt_eval_count ?? 0));
      const evalCount = Math.max(0, Number(raw.eval_count ?? 0));
      const totalDurationMs =
        typeof raw.total_duration === 'number' && raw.total_duration > 0
          ? Number((raw.total_duration / 1e6).toFixed(2))
          : latencyMs;
      const evalDurationMs =
        typeof raw.eval_duration === 'number' && raw.eval_duration > 0
          ? Number((raw.eval_duration / 1e6).toFixed(2))
          : 0;
      const durationSec =
        ((raw.eval_duration || raw.total_duration || 0) as number) / 1e9;
      const tokensPerSec =
        evalCount > 0 && durationSec > 0
          ? Number((evalCount / durationSec).toFixed(2))
          : 0;

      return {
        content,
        toolCalls,
        model: raw.model ?? targetModel,
        aiProvider: 'ollama',
        usedFallback: false,
        promptEvalCount,
        evalCount,
        totalDurationMs,
        evalDurationMs,
        tokensPerSec,
        latencyMs,
        costUsd: 0,
        circuitState: this.circuitBreaker.getState(),
      };
    } catch (error) {
      if (!allowFallback) {
        throw error;
      }
      const reason =
        error instanceof CircuitBreakerOpenError
          ? 'CIRCUIT_BREAKER_OPEN'
          : error instanceof Error
            ? `OLLAMA_ERROR:${error.message}`
            : 'OLLAMA_UNKNOWN_ERROR';
      return this.buildDeterministicFallback(request, reason, startedAt);
    }
  }

  public async *chatStream(
    request: OllamaChatRequest,
  ): AsyncGenerator<OllamaStreamChunk> {
    if (this.offlineMode || !this.baseUrl || this.circuitBreaker.getState() === 'OPEN') {
      const fallback = this.buildDeterministicFallback(
        request,
        this.circuitBreaker.getState() === 'OPEN'
          ? 'CIRCUIT_BREAKER_OPEN'
          : 'OLLAMA_OFFLINE_MODE',
        Date.now(),
      );
      yield {
        delta: fallback.content,
        done: true,
        model: fallback.model,
        promptEvalCount: 0,
        evalCount: 0,
        totalDurationMs: fallback.totalDurationMs,
        evalDurationMs: 0,
        tokensPerSec: 0,
        costUsd: 0,
      };
      return;
    }

    const targetModel = await this.resolveModelForRequest(request.model);
    const timeoutMs = request.timeoutMs ?? this.timeoutMs;
    const bodyPayload: Record<string, unknown> = {
      model: targetModel,
      messages: request.messages,
      stream: true,
      keep_alive: request.keepAlive ?? this.keepAlive,
      options: {
        temperature: request.temperature ?? 0.1,
        top_p: request.topP ?? 0.9,
        num_ctx: request.numCtx ?? this.numCtx,
      },
    };
    if (request.tools && request.tools.length > 0) {
      bodyPayload.tools = request.tools;
    }
    if (request.jsonSchema) {
      bodyPayload.format = request.jsonSchema;
    } else if (request.format) {
      bodyPayload.format = request.format;
    }

    const response = await this.circuitBreaker.execute(async () => {
      const res = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/x-ndjson',
        },
        body: JSON.stringify(bodyPayload),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok || !res.body) {
        throw new Error(`Ollama streaming /api/chat failed (${res.status})`);
      }
      return res;
    });

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        let newlineIdx = buffer.indexOf('\n');
        while (newlineIdx !== -1) {
          const line = buffer.slice(0, newlineIdx).trim();
          buffer = buffer.slice(newlineIdx + 1);
          if (line) {
            try {
              const parsed = JSON.parse(line) as RawOllamaChatResponse;
              const toolCalls = Array.isArray(parsed.message?.tool_calls)
                ? parsed.message.tool_calls
                    .map((entry) => normalizeToolCallEntry(entry))
                    .filter((tc): tc is OllamaToolCall => tc !== null)
                : undefined;
              const evalCount = Number(parsed.eval_count ?? 0);
              const durationSec =
                ((parsed.eval_duration || parsed.total_duration || 0) as number) / 1e9;
              yield {
                delta: parsed.message?.content ?? '',
                done: Boolean(parsed.done),
                ...(toolCalls && toolCalls.length > 0 ? { toolCalls } : {}),
                model: parsed.model ?? targetModel,
                ...(parsed.done
                  ? {
                      promptEvalCount: Number(parsed.prompt_eval_count ?? 0),
                      evalCount,
                      totalDurationMs:
                        typeof parsed.total_duration === 'number'
                          ? Number((parsed.total_duration / 1e6).toFixed(2))
                          : 0,
                      evalDurationMs:
                        typeof parsed.eval_duration === 'number'
                          ? Number((parsed.eval_duration / 1e6).toFixed(2))
                          : 0,
                      tokensPerSec:
                        evalCount > 0 && durationSec > 0
                          ? Number((evalCount / durationSec).toFixed(2))
                          : 0,
                    }
                  : {}),
                costUsd: 0,
              };
            } catch {
              // Ignore malformed partial NDJSON lines
            }
          }
          newlineIdx = buffer.indexOf('\n');
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}

// ============================================================================
// 768-dim Deterministic Local Fallback Embedding + OllamaEmbeddingClient
// ============================================================================

function foldVietnameseForEmbedding(input: string): string {
  return input
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function fnv1aHash32(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

const EMBEDDING_DOMAIN_BUCKETS: ReadonlyArray<{
  bucket: number;
  weight: number;
  terms: readonly string[];
}> = [
  { bucket: 0, weight: 2.4, terms: ['doi size', 'rma', '7-14', '14 ngay', 'hoan tra', 'hoan tien', '2 chieu'] },
  { bucket: 1, weight: 2.4, terms: ['15 phut', 'xoa cung', 'rieng tu', 'privacy', 'private-tryon', 'thu do', 'try-on'] },
  { bucket: 2, weight: 2.0, terms: ['bang size', 'so do', 'ao blazer', 'so mi', 'chieu cao', 'can nang', 'nguc', 'vai'] },
  { bucket: 3, weight: 2.0, terms: ['quan tay', 'chan vay', 'culottes', 'vong eo', 'vong hong', 'cap cao'] },
  { bucket: 4, weight: 2.0, terms: ['dam du tiec', 'dam midi', 'chiet eo', 'vay di tiec', 'satin'] },
  { bucket: 5, weight: 2.0, terms: ['co gian', 'stretch', 'none', 'light', 'high', 'hieu chinh', 'fit'] },
  { bucket: 6, weight: 2.0, terms: ['lua to tam', 'bao quan lua', 'giat tay', 'organza', 'ph trung tinh'] },
  { bucket: 7, weight: 2.0, terms: ['linen', 'huu co', 'gabardine', 'trench', 'bao quan linen'] },
  { bucket: 8, weight: 2.0, terms: ['merino', 'tweed', 'denim', 'giat kho', 'phoi ngang'] },
  { bucket: 9, weight: 2.0, terms: ['2:3', '3:4', 'alpha', 'flat-lay', '720x1080', '768x1024', 'media pipeline'] },
  { bucket: 10, weight: 2.0, terms: ['nhap_ai', 'nha cung cap', 'supplier', 'partner', 'po draft', 'grn', 'kho'] },
  { bucket: 11, weight: 2.0, terms: ['phoi do', 'combo', 'vietqr', 'hoa toc', 'hop qua', 'mix match'] },
];

export function normalizeL2Vector(
  raw: readonly number[],
  targetDim = DEFAULT_OLLAMA_EMBED_DIM,
): number[] {
  const vec = new Float64Array(targetDim);
  const copyLen = Math.min(raw.length, targetDim);
  let normSq = 0;
  for (let i = 0; i < copyLen; i += 1) {
    const val = Number.isFinite(raw[i]) ? raw[i] : 0;
    vec[i] = val;
    normSq += val * val;
  }
  const norm = Math.sqrt(normSq);
  if (norm === 0) {
    vec[0] = 1;
    return Array.from(vec);
  }
  const normalized: number[] = new Array(targetDim);
  for (let i = 0; i < targetDim; i += 1) {
    normalized[i] = Number((vec[i] / norm).toFixed(6));
  }
  return normalized;
}

/**
 * Offline deterministic 768-dim L2-normalized embedding fallback used ONLY when
 * local Ollama daemon (`nomic-embed-text`) is unreachable.
 */
export function embedLocalDeterministic768(
  text: string,
  dimension = DEFAULT_OLLAMA_EMBED_DIM,
): number[] {
  const dim = Math.max(16, Math.floor(dimension));
  const vec = new Float64Array(dim);
  const folded = foldVietnameseForEmbedding(text);

  if (!folded) {
    vec[0] = 1;
    return Array.from(vec);
  }

  for (const feature of EMBEDDING_DOMAIN_BUCKETS) {
    for (const term of feature.terms) {
      if (folded.includes(term)) {
        vec[feature.bucket] += feature.weight;
      }
    }
  }

  const reserved = Math.min(16, dim - 1);
  const hashSpace = dim - reserved;
  const tokens = folded.split(' ').filter((t) => t.length >= 2);

  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i];
    const h1 = fnv1aHash32(`w:${tok}`);
    const idx1 = reserved + (h1 % hashSpace);
    const sign1 = (h1 & 1) === 0 ? 1 : -1;
    vec[idx1] += sign1 * 1.4;

    if (i + 1 < tokens.length) {
      const bigram = `${tok}_${tokens[i + 1]}`;
      const h2 = fnv1aHash32(`b:${bigram}`);
      const idx2 = reserved + (h2 % hashSpace);
      const sign2 = (h2 & 1) === 0 ? 1 : -1;
      vec[idx2] += sign2 * 1.6;
    }
  }

  const compact = folded.replace(/\s+/g, '_');
  const maxTrigrams = Math.min(compact.length - 2, 320);
  for (let i = 0; i < maxTrigrams; i += 1) {
    const tri = compact.slice(i, i + 3);
    const h = fnv1aHash32(`t:${tri}`);
    const idx = reserved + (h % hashSpace);
    const sign = (h & 1) === 0 ? 1 : -1;
    vec[idx] += sign * 0.45;
  }

  return normalizeL2Vector(Array.from(vec), dim);
}

export class OllamaEmbeddingClient {
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly dimension: number;
  private readonly keepAlive: string;
  private readonly timeoutMs: number;
  private readonly offlineMode: boolean;

  constructor(options: OllamaEmbeddingOptions = {}) {
    this.offlineMode = options.offlineMode === true || options.baseUrl === '';
    this.baseUrl = this.offlineMode ? '' : resolveOllamaBaseUrl(options.baseUrl);
    this.model =
      options.model?.trim() ||
      process.env.OLLAMA_EMBED_MODEL?.trim() ||
      DEFAULT_OLLAMA_EMBED_MODEL;
    const envDim = Number(process.env.OLLAMA_EMBED_DIM ?? DEFAULT_OLLAMA_EMBED_DIM);
    this.dimension =
      options.dimension ??
      (Number.isFinite(envDim) && envDim > 0 ? envDim : DEFAULT_OLLAMA_EMBED_DIM);
    this.keepAlive =
      options.keepAlive ?? process.env.OLLAMA_KEEP_ALIVE ?? DEFAULT_OLLAMA_KEEP_ALIVE;
    const envTimeout = Number(
      process.env.OLLAMA_TIMEOUT_MS ?? DEFAULT_OLLAMA_TIMEOUT_MS,
    );
    this.timeoutMs =
      options.timeoutMs ??
      (Number.isFinite(envTimeout) && envTimeout > 0
        ? Math.min(envTimeout, 15_000)
        : 10_000);
  }

  public getModel(): string {
    return this.model;
  }

  public getDimension(): number {
    return this.dimension;
  }

  public getBaseUrl(): string {
    return this.baseUrl;
  }

  public async embed(input: string): Promise<OllamaEmbeddingResult> {
    const batch = await this.embedBatch([input]);
    return {
      embedding: batch.embeddings[0] ?? embedLocalDeterministic768(input, this.dimension),
      model: batch.model,
      dimension: batch.dimension,
      usedFallback: batch.usedFallback,
      latencyMs: batch.latencyMs,
      costUsd: 0,
    };
  }

  public async embedBatch(
    inputs: readonly string[],
  ): Promise<OllamaBatchEmbeddingResult> {
    const startedAt = Date.now();
    if (inputs.length === 0) {
      return {
        embeddings: [],
        model: this.model,
        dimension: this.dimension,
        usedFallback: false,
        latencyMs: 0,
        costUsd: 0,
      };
    }

    if (this.offlineMode || !this.baseUrl) {
      return {
        embeddings: inputs.map((text) =>
          embedLocalDeterministic768(text, this.dimension),
        ),
        model: `${this.model}:offline-deterministic-768`,
        dimension: this.dimension,
        usedFallback: true,
        latencyMs: Date.now() - startedAt,
        costUsd: 0,
      };
    }

    try {
      const response = await fetch(`${this.baseUrl}/api/embed`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          input: inputs.length === 1 ? inputs[0] : inputs,
          keep_alive: this.keepAlive,
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      if (!response.ok) {
        throw new Error(`Ollama /api/embed returned HTTP ${response.status}`);
      }

      const data = (await response.json()) as {
        model?: string;
        embeddings?: number[][];
        embedding?: number[];
      };

      const rawVectors: number[][] = Array.isArray(data.embeddings)
        ? data.embeddings
        : Array.isArray(data.embedding)
          ? [data.embedding]
          : [];

      if (rawVectors.length !== inputs.length) {
        throw new Error(
          `Ollama /api/embed returned ${rawVectors.length} vectors for ${inputs.length} inputs`,
        );
      }

      const normalized = rawVectors.map((vec) =>
        normalizeL2Vector(vec, this.dimension),
      );

      return {
        embeddings: normalized,
        model: data.model ?? this.model,
        dimension: this.dimension,
        usedFallback: false,
        latencyMs: Date.now() - startedAt,
        costUsd: 0,
      };
    } catch {
      return {
        embeddings: inputs.map((text) =>
          embedLocalDeterministic768(text, this.dimension),
        ),
        model: `${this.model}:offline-deterministic-768`,
        dimension: this.dimension,
        usedFallback: true,
        latencyMs: Date.now() - startedAt,
        costUsd: 0,
      };
    }
  }
}
