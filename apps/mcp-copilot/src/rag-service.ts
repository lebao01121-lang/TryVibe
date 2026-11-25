import { randomUUID } from 'node:crypto';
import {
  ATELIER_RAG_KNOWLEDGE_DOCS,
  DEFAULT_RAG_DATABASE_URL,
  HybridRagRetriever,
  InMemoryKeywordProvider,
  InMemorySemanticProvider,
  OllamaEmbeddingClient,
  PgVectorRagStore,
  RAG_HNSW_INDEX_SPEC,
  computeCopilotFeedbackSummary,
  maskPii,
  type AiTelemetryRecord,
  type CopilotFeedbackRating,
  type CopilotFeedbackRecord,
  type CopilotFeedbackSummary,
  type CreateRagDocumentInput,
  type HybridRagResult,
  type KeywordSearchProvider,
  type KnowledgeCorpusDocument,
  type ListRagDocumentsFilter,
  type RagCitation,
  type RagCorpusSummary,
  type RagDocumentHit,
  type RagReindexOptions,
  type RagReindexResult,
  type RagSearchOptions,
  type RagStoredDocument,
  type RagTestRetrievalOptions,
  type RagTestRetrievalResult,
  type RagVectorIndexSpec,
  type RouterTier,
  type TelemetryOutcomeStatus,
  type TelemetryPortalScope,
  type UpdateRagDocumentInput,
} from '@atelier/ai-harness';
import type { Logger } from '@atelier/observability';
import {
  type McpCopilotConfig,
  parseSafeConnectionTarget,
  probeTcpConnectivity,
} from './config.js';

const INTERNAL_ONLY_RAG_DOC_IDS: ReadonlySet<string> = new Set([
  'rag_doc_10_dual_media_sop',
  'rag_doc_11_supplier_nhap_ai_sop',
]);

export interface PersistedTelemetryTotals {
  totalEvents: number;
  toolCallsByName: Record<string, number>;
  semanticCacheHits: number;
  semanticCacheLookups: number;
  promptInjectionsBlocked: number;
  rbacDenials: number;
  totalPromptTokens: number;
  totalEvalTokens: number;
  averageLatencyMs: number;
  averageTokensPerSec: number;
  lastModelUsed: string;
  lastTokensPerSec: number;
}

export interface SaveCopilotFeedbackInput {
  traceId: string;
  sessionId?: string | null;
  portal: TelemetryPortalScope;
  role: string;
  userId: string;
  rating: CopilotFeedbackRating;
  reason?: string | null;
  promptText?: string | null;
  responseText?: string | null;
}

const TELEMETRY_DDL_SQL = `
CREATE TABLE IF NOT EXISTS ai_telemetry_events (
  id TEXT PRIMARY KEY,
  trace_id TEXT NOT NULL,
  portal TEXT NOT NULL DEFAULT 'ADMIN_PORTAL',
  role TEXT NOT NULL DEFAULT 'UNKNOWN',
  model TEXT NOT NULL DEFAULT 'unknown',
  tier INTEGER NOT NULL DEFAULT 0,
  latency_ms DOUBLE PRECISION NOT NULL DEFAULT 0,
  tokens_per_sec DOUBLE PRECISION NOT NULL DEFAULT 0,
  cache_hit BOOLEAN NOT NULL DEFAULT FALSE,
  status TEXT NOT NULL DEFAULT 'SUCCESS',
  tool_name TEXT,
  prompt_eval_count INTEGER NOT NULL DEFAULT 0,
  eval_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ai_telemetry_events_created_at
  ON ai_telemetry_events (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_telemetry_events_trace_id
  ON ai_telemetry_events (trace_id);

CREATE TABLE IF NOT EXISTS ai_copilot_feedback (
  id TEXT PRIMARY KEY,
  trace_id TEXT NOT NULL,
  session_id TEXT,
  portal TEXT NOT NULL DEFAULT 'ADMIN_PORTAL',
  actor_role TEXT NOT NULL DEFAULT 'UNKNOWN',
  role TEXT NOT NULL DEFAULT 'UNKNOWN',
  user_id TEXT NOT NULL DEFAULT 'anonymous',
  rating TEXT NOT NULL CHECK (rating IN ('UP', 'DOWN')),
  reason TEXT,
  prompt_text TEXT,
  response_text TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ai_copilot_feedback_created_at
  ON ai_copilot_feedback (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_copilot_feedback_trace_id
  ON ai_copilot_feedback (trace_id);
`;

function sanitizeFeedbackText(raw: string, maxLen: number): string {
  return maskPii(raw.trim())
    .replace(/Bearer\s+[A-Za-z0-9._-]{10,}/gi, '[REDACTED_TOKEN]')
    .replace(/Atelier_[A-Za-z0-9!]+/g, '[REDACTED_SECRET]')
    .slice(0, maxLen);
}

function toInMemoryCorpus(): KnowledgeCorpusDocument[] {
  return ATELIER_RAG_KNOWLEDGE_DOCS.map((doc) => ({
    sourceId: doc.id,
    title: doc.title,
    snippet: doc.content,
    keywords: Array.isArray(doc.metadata.keywords)
      ? doc.metadata.keywords.map((k) => String(k))
      : [doc.domain],
    tags: [doc.domain],
  }));
}

class MeilisearchSupplementalKeywordProvider implements KeywordSearchProvider {
  constructor(
    private readonly baseProvider: KeywordSearchProvider,
    private readonly meilisearchHost: string,
    private readonly masterKey: string,
  ) {}

  public async search(
    query: string,
    options?: RagSearchOptions,
  ): Promise<RagDocumentHit[]> {
    const topK = options?.topK ?? 5;
    const [baseHits, meiliHits] = await Promise.all([
      this.baseProvider.search(query, options),
      this.searchMeilisearch(query, Math.min(3, topK)),
    ]);

    if (meiliHits.length === 0) {
      return baseHits;
    }

    const seen = new Set(baseHits.map((h) => h.sourceId));
    const merged = [...baseHits];
    for (const hit of meiliHits) {
      if (!seen.has(hit.sourceId)) {
        merged.push(hit);
        seen.add(hit.sourceId);
      }
    }
    return merged.slice(0, topK);
  }

  private async searchMeilisearch(
    query: string,
    limit: number,
  ): Promise<RagDocumentHit[]> {
    if (!this.meilisearchHost) {
      return [];
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 300);

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      };
      if (this.masterKey) {
        headers.Authorization = `Bearer ${this.masterKey}`;
      }

      const response = await fetch(
        `${this.meilisearchHost}/indexes/atelier_products/search`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({ q: query, limit }),
          signal: controller.signal,
        },
      );
      if (!response.ok) {
        return [];
      }
      const parsed = (await response.json()) as {
        hits?: Array<{
          id?: string;
          slug?: string;
          name?: string;
          fabric?: string;
          description?: string;
        }>;
      };
      if (!Array.isArray(parsed.hits)) {
        return [];
      }

      return parsed.hits
        .filter((h) => Boolean(h.id && h.name))
        .map((h, idx) => ({
          sourceId: `meili_product_${h.slug ?? h.id}`,
          title: `Danh mục sản phẩm: ${h.name}`,
          snippet: `${h.name}${h.fabric ? ` · Chất liệu: ${h.fabric}` : ''}${h.description ? ` — ${h.description.slice(0, 140)}` : ''}`,
          score: Number((0.4 / (idx + 1)).toFixed(4)),
          metadata: { provider: 'meilisearch', productId: h.id, slug: h.slug },
        }));
    } catch {
      return [];
    } finally {
      clearTimeout(timer);
    }
  }
}

export class CopilotRagService {
  private readonly fallbackRetriever: HybridRagRetriever;
  private readonly embeddingClient: OllamaEmbeddingClient;
  private pgStore: PgVectorRagStore | null = null;
  private pgRetriever: HybridRagRetriever | null = null;
  private initPromise: Promise<void> | null = null;
  private backendMode: 'pgvector-postgres' | 'pgvector-pglite' | 'in-memory' = 'in-memory';
  private readonly memoryFeedback: CopilotFeedbackRecord[] = [];

  constructor(
    private readonly config: McpCopilotConfig,
    private readonly logger: Logger,
    embeddingClient?: OllamaEmbeddingClient,
  ) {
    this.embeddingClient =
      embeddingClient ??
      new OllamaEmbeddingClient({
        baseUrl: config.ollamaOfflineMode ? '' : config.ollamaBaseUrl,
        model: config.ollamaEmbedModel,
        dimension: config.ollamaEmbedDim,
        keepAlive: config.ollamaKeepAlive,
        offlineMode: config.ollamaOfflineMode,
      });

    const corpus = toInMemoryCorpus();
    const fallbackKeyword = new MeilisearchSupplementalKeywordProvider(
      new InMemoryKeywordProvider(corpus),
      config.meilisearchHost,
      config.meilisearchMasterKey,
    );
    this.fallbackRetriever = new HybridRagRetriever({
      semanticProvider: new InMemorySemanticProvider(corpus),
      keywordProvider: fallbackKeyword,
      rrfK: 60,
    });
  }

  public getBackendMode(): string {
    return this.backendMode;
  }

  public getEmbedModel(): string {
    return this.embeddingClient.getModel();
  }

  public getEmbedDim(): number {
    return this.embeddingClient.getDimension();
  }

  public isHnswIndexActive(): boolean {
    return this.pgStore?.hnswIndexActive ?? false;
  }

  public getIndexSpec(): RagVectorIndexSpec {
    return this.pgStore?.indexSpec ?? RAG_HNSW_INDEX_SPEC;
  }

  private async ensurePgStoreForAdmin(): Promise<PgVectorRagStore> {
    await this.ensureInitialized();
    if (this.pgStore) {
      return this.pgStore;
    }
    const effectiveRagUrl =
      this.config.ragVectorDatabaseUrl || DEFAULT_RAG_DATABASE_URL;
    const store = new PgVectorRagStore({
      databaseUrl: effectiveRagUrl,
      dbName: 'rag_vector_db_copilot',
      forcePglite: true,
      rrfK: 60,
      embeddingClient: this.embeddingClient,
    });
    await store.ensureInitialized();
    this.pgStore = store;
    const combinedKeyword = new MeilisearchSupplementalKeywordProvider(
      store.asKeywordProvider(),
      this.config.meilisearchHost,
      this.config.meilisearchMasterKey,
    );
    this.pgRetriever = new HybridRagRetriever({
      semanticProvider: store.asSemanticProvider(),
      keywordProvider: combinedKeyword,
      rrfK: 60,
    });
    this.backendMode =
      store.getMode() === 'postgres' ? 'pgvector-postgres' : 'pgvector-pglite';
    return store;
  }

  public async getCorpusSummary(): Promise<
    RagCorpusSummary & { backendMode: string }
  > {
    const store = await this.ensurePgStoreForAdmin();
    const summary = await store.getCorpusSummary();
    return {
      ...summary,
      backendMode: this.backendMode,
    };
  }

  public async listDocuments(
    filter: ListRagDocumentsFilter = {},
  ): Promise<RagStoredDocument[]> {
    const store = await this.ensurePgStoreForAdmin();
    return store.listDocuments(filter);
  }

  public async getDocument(id: string): Promise<RagStoredDocument | null> {
    const store = await this.ensurePgStoreForAdmin();
    return store.getDocument(id);
  }

  public async createDocument(
    input: CreateRagDocumentInput,
  ): Promise<RagStoredDocument> {
    const store = await this.ensurePgStoreForAdmin();
    return store.createDocument(input);
  }

  public async updateDocument(
    id: string,
    patch: UpdateRagDocumentInput,
  ): Promise<{ before: RagStoredDocument; after: RagStoredDocument } | null> {
    const store = await this.ensurePgStoreForAdmin();
    return store.updateDocument(id, patch);
  }

  public async softDeleteDocument(
    id: string,
    updatedBy?: string,
  ): Promise<{
    before: RagStoredDocument;
    after: RagStoredDocument;
    deactivated: true;
  } | null> {
    const store = await this.ensurePgStoreForAdmin();
    return store.softDeleteDocument(id, updatedBy);
  }

  public async reindexDocuments(
    options: RagReindexOptions = {},
  ): Promise<RagReindexResult> {
    const store = await this.ensurePgStoreForAdmin();
    return store.reindexDocuments(options);
  }

  public async testRetrieval(
    query: string,
    options: RagTestRetrievalOptions = {},
  ): Promise<RagTestRetrievalResult> {
    const store = await this.ensurePgStoreForAdmin();
    return store.testRetrieval(query, options);
  }

  private async ensureInitialized(): Promise<void> {
    if (this.pgRetriever) {
      return;
    }
    if (!this.initPromise) {
      this.initPromise = this.initializeStore();
    }
    await this.initPromise;
  }

  private async initializeStore(): Promise<void> {
    const effectiveRagUrl =
      this.config.ragVectorDatabaseUrl || DEFAULT_RAG_DATABASE_URL;
    if (
      !this.config.ragVectorDatabaseUrl &&
      this.config.ollamaOfflineMode &&
      process.env.MCP_EPHEMERAL_TEST === '1'
    ) {
      this.backendMode = 'in-memory';
      return;
    }

    try {
      const target = this.config.ragVectorDatabaseUrl
        ? parseSafeConnectionTarget(this.config.ragVectorDatabaseUrl)
        : null;
      const tcpReachable = target
        ? (await probeTcpConnectivity(target.host, target.port, 250)).reachable
        : false;

      // Connect strictly to rag_vector_db (vector(768) + persistent AI telemetry/feedback; ZERO transactional DBs!)
      const store = new PgVectorRagStore({
        databaseUrl: effectiveRagUrl,
        dbName: tcpReachable ? 'rag_vector_db' : 'rag_vector_db_copilot',
        forcePglite: !tcpReachable,
        rrfK: 60,
        embeddingClient: this.embeddingClient,
      });

      const db = await store.ensureInitialized();
      await db.exec(TELEMETRY_DDL_SQL);
      await db
        .exec(
          `ALTER TABLE ai_telemetry_events ADD COLUMN IF NOT EXISTS tool_name TEXT;
           ALTER TABLE ai_telemetry_events ADD COLUMN IF NOT EXISTS prompt_eval_count INTEGER NOT NULL DEFAULT 0;
           ALTER TABLE ai_telemetry_events ADD COLUMN IF NOT EXISTS eval_count INTEGER NOT NULL DEFAULT 0;
           ALTER TABLE ai_copilot_feedback ADD COLUMN IF NOT EXISTS actor_role TEXT NOT NULL DEFAULT 'UNKNOWN';`,
        )
        .catch(() => undefined);

      this.pgStore = store;
      const combinedKeyword = new MeilisearchSupplementalKeywordProvider(
        store.asKeywordProvider(),
        this.config.meilisearchHost,
        this.config.meilisearchMasterKey,
      );
      this.pgRetriever = new HybridRagRetriever({
        semanticProvider: store.asSemanticProvider(),
        keywordProvider: combinedKeyword,
        rrfK: 60,
      });
      this.backendMode =
        store.getMode() === 'postgres' ? 'pgvector-postgres' : 'pgvector-pglite';
      this.logger.info(
        {
          backendMode: this.backendMode,
          embedModel: this.embeddingClient.getModel(),
          embedDim: this.embeddingClient.getDimension(),
        },
        'MCP Copilot Layer 3 Hybrid RAG + P1-5 Telemetry/Feedback initialized on rag_vector_db',
      );
    } catch (error) {
      this.backendMode = 'in-memory';
      this.logger.warn(
        { err: error instanceof Error ? error.message : String(error) },
        'Falling back to in-memory Hybrid RAG corpus for policy citations',
      );
    }
  }

  public async initPersistence(): Promise<boolean> {
    await this.ensureInitialized();
    return Boolean(this.pgStore);
  }

  public async persistTelemetryEvent(entry: AiTelemetryRecord): Promise<void> {
    await this.ensureInitialized();
    if (!this.pgStore) {
      return;
    }
    try {
      const db = await this.pgStore.getDbClient();
      const roleStr =
        entry.roles && entry.roles.length > 0 ? entry.roles.join(',') : 'UNKNOWN';
      await db.query(
        `INSERT INTO ai_telemetry_events (
           id, trace_id, portal, role, model, tier, latency_ms,
           tokens_per_sec, cache_hit, status, tool_name, prompt_eval_count, eval_count, created_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::timestamptz)
         ON CONFLICT (id) DO NOTHING`,
        [
          entry.id,
          entry.traceId || entry.correlationId || entry.id,
          entry.portal || 'ADMIN_PORTAL',
          roleStr,
          entry.modelUsed || 'unknown',
          Number(entry.tier ?? 0),
          Number(entry.latencyMs ?? 0),
          Number(entry.tokensPerSec ?? 0),
          Boolean(entry.cacheHit),
          entry.status || 'SUCCESS',
          entry.toolName || null,
          Number(entry.promptEvalCount ?? 0),
          Number(entry.evalCount ?? 0),
          entry.timestamp || new Date().toISOString(),
        ],
      );
    } catch (err) {
      this.logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'Failed to persist ai_telemetry_events row to rag_vector_db',
      );
    }
  }

  public async loadHistoricalTelemetry(limit = 500): Promise<{
    events: AiTelemetryRecord[];
    totals: PersistedTelemetryTotals;
  }> {
    await this.ensureInitialized();
    const emptyTotals: PersistedTelemetryTotals = {
      totalEvents: 0,
      toolCallsByName: {},
      semanticCacheHits: 0,
      semanticCacheLookups: 0,
      promptInjectionsBlocked: 0,
      rbacDenials: 0,
      totalPromptTokens: 0,
      totalEvalTokens: 0,
      averageLatencyMs: 0,
      averageTokensPerSec: 0,
      lastModelUsed: '',
      lastTokensPerSec: 0,
    };

    if (!this.pgStore) {
      return { events: [], totals: emptyTotals };
    }

    try {
      const db = await this.pgStore.getDbClient();
      const [aggRes, toolsRes, rowsRes] = await Promise.all([
        db.query<{
          total_events: number | string;
          cache_hits: number | string;
          cache_lookups: number | string;
          injections_blocked: number | string;
          rbac_denials: number | string;
          total_prompt_tokens: number | string;
          total_eval_tokens: number | string;
          avg_latency_ms: number | string;
          avg_tps: number | string;
        }>(
          `SELECT
             COUNT(*)::int AS total_events,
             COALESCE(SUM(CASE WHEN cache_hit THEN 1 ELSE 0 END), 0)::int AS cache_hits,
             COALESCE(SUM(CASE WHEN cache_hit OR tool_name IN ('hybrid_rag_policy_lookup', 'policy_rag_semantic_cache') THEN 1 ELSE 0 END), 0)::int AS cache_lookups,
             COALESCE(SUM(CASE WHEN status = 'BLOCKED_GUARDRAIL' THEN 1 ELSE 0 END), 0)::int AS injections_blocked,
             COALESCE(SUM(CASE WHEN status = 'BLOCKED_RBAC' THEN 1 ELSE 0 END), 0)::int AS rbac_denials,
             COALESCE(SUM(prompt_eval_count), 0)::int AS total_prompt_tokens,
             COALESCE(SUM(eval_count), 0)::int AS total_eval_tokens,
             COALESCE(AVG(latency_ms), 0)::float8 AS avg_latency_ms,
             COALESCE(AVG(NULLIF(tokens_per_sec, 0)), 0)::float8 AS avg_tps
           FROM ai_telemetry_events`,
        ),
        db.query<{ tool_name: string; cnt: number | string }>(
          `SELECT tool_name, COUNT(*)::int AS cnt
           FROM ai_telemetry_events
           WHERE tool_name IS NOT NULL AND tool_name <> ''
           GROUP BY tool_name`,
        ),
        db.query<{
          id: string;
          trace_id: string;
          portal: string;
          role: string;
          model: string;
          tier: number | string;
          latency_ms: number | string;
          tokens_per_sec: number | string;
          cache_hit: boolean;
          status: string;
          tool_name: string | null;
          prompt_eval_count: number | string;
          eval_count: number | string;
          created_at: string | Date;
        }>(
          `SELECT id, trace_id, portal, role, model, tier, latency_ms, tokens_per_sec,
                  cache_hit, status, tool_name, prompt_eval_count, eval_count, created_at
           FROM ai_telemetry_events
           ORDER BY created_at DESC
           LIMIT $1`,
          [Math.max(1, Math.min(1000, Math.floor(limit)))],
        ),
      ]);

      const toolCallsByName: Record<string, number> = {};
      for (const r of toolsRes.rows) {
        if (r.tool_name) {
          toolCallsByName[r.tool_name] = Number(r.cnt ?? 0);
        }
      }

      const agg = aggRes.rows[0];
      const latest = rowsRes.rows[0];

      const events: AiTelemetryRecord[] = rowsRes.rows
        .slice()
        .reverse()
        .map((row) => {
          const tierRaw = Number(row.tier ?? 0);
          const tier: RouterTier = tierRaw === 2 ? 2 : tierRaw === 1 ? 1 : 0;
          const statusRaw = String(row.status || 'SUCCESS').toUpperCase();
          const status: TelemetryOutcomeStatus =
            statusRaw === 'BLOCKED_GUARDRAIL' ||
            statusRaw === 'BLOCKED_RBAC' ||
            statusRaw === 'ERROR'
              ? statusRaw
              : 'SUCCESS';
          const portalRaw = String(row.portal || 'ADMIN_PORTAL').toUpperCase();
          const portal: TelemetryPortalScope =
            portalRaw === 'STOREFRONT' || portalRaw === 'INTERNAL'
              ? portalRaw
              : 'ADMIN_PORTAL';
          const modelUsed = String(row.model || 'unknown');
          const usedFallback = modelUsed.includes('fallback');
          const promptEvalCount = Math.max(0, Number(row.prompt_eval_count ?? 0));
          const evalCount = Math.max(0, Number(row.eval_count ?? 0));
          const latencyMs = Math.max(0, Math.round(Number(row.latency_ms ?? 0)));
          const tokensPerSec = Number(Math.max(0, Number(row.tokens_per_sec ?? 0)).toFixed(2));
          const createdIso =
            row.created_at instanceof Date
              ? row.created_at.toISOString()
              : String(row.created_at || new Date().toISOString());

          return {
            id: String(row.id),
            timestamp: createdIso,
            actor_type: 'AI_COPILOT',
            aiProvider: usedFallback ? 'rule_fallback' : 'ollama',
            modelUsed,
            userId: 'persisted-history',
            roles: String(row.role || 'UNKNOWN')
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean),
            toolName: row.tool_name || 'copilot_chat',
            tier,
            latencyMs,
            promptTokens: promptEvalCount,
            completionTokens: evalCount,
            promptEvalCount,
            evalCount,
            totalDurationMs: latencyMs,
            tokensPerSec,
            costUsd: 0,
            estimatedCostUsd: 0,
            vtonCostUsd: 0,
            cacheHit: Boolean(row.cache_hit),
            correlationId: String(row.trace_id || row.id),
            traceId: String(row.trace_id || row.id),
            portal,
            status,
            usedFallback,
          };
        });

      return {
        events,
        totals: {
          totalEvents: Number(agg?.total_events ?? 0),
          toolCallsByName,
          semanticCacheHits: Number(agg?.cache_hits ?? 0),
          semanticCacheLookups: Number(agg?.cache_lookups ?? 0),
          promptInjectionsBlocked: Number(agg?.injections_blocked ?? 0),
          rbacDenials: Number(agg?.rbac_denials ?? 0),
          totalPromptTokens: Number(agg?.total_prompt_tokens ?? 0),
          totalEvalTokens: Number(agg?.total_eval_tokens ?? 0),
          averageLatencyMs: Number(Number(agg?.avg_latency_ms ?? 0).toFixed(2)),
          averageTokensPerSec: Number(Number(agg?.avg_tps ?? 0).toFixed(2)),
          lastModelUsed: latest?.model ? String(latest.model) : '',
          lastTokensPerSec: latest?.tokens_per_sec
            ? Number(Number(latest.tokens_per_sec).toFixed(2))
            : 0,
        },
      };
    } catch (err) {
      this.logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'Failed to hydrate historical ai_telemetry_events from rag_vector_db',
      );
      return { events: [], totals: emptyTotals };
    }
  }

  public async insertFeedback(
    input: SaveCopilotFeedbackInput,
  ): Promise<CopilotFeedbackRecord> {
    await this.ensureInitialized();
    const record: CopilotFeedbackRecord = {
      id: `fb_${randomUUID()}`,
      traceId: input.traceId.trim(),
      sessionId: input.sessionId?.trim() || null,
      portal: input.portal,
      role: input.role || 'UNKNOWN',
      userId: input.userId || 'anonymous',
      rating: input.rating,
      reason: input.reason ? sanitizeFeedbackText(input.reason, 500) : null,
      promptText: input.promptText
        ? sanitizeFeedbackText(input.promptText, 4000)
        : null,
      responseText: input.responseText
        ? sanitizeFeedbackText(input.responseText, 8000)
        : null,
      createdAt: new Date().toISOString(),
    };

    this.memoryFeedback.unshift(record);
    if (this.memoryFeedback.length > 500) {
      this.memoryFeedback.pop();
    }

    if (this.pgStore) {
      try {
        const db = await this.pgStore.getDbClient();
        await db.query(
          `INSERT INTO ai_copilot_feedback (
             id, trace_id, session_id, portal, actor_role, role, user_id,
             rating, reason, prompt_text, response_text, created_at
           )
           VALUES ($1, $2, $3, $4, $5, $5, $6, $7, $8, $9, $10, $11::timestamptz)`,
          [
            record.id,
            record.traceId,
            record.sessionId,
            record.portal,
            record.role,
            record.userId,
            record.rating,
            record.reason,
            record.promptText,
            record.responseText,
            record.createdAt,
          ],
        );
      } catch (err) {
        this.logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'Failed to persist ai_copilot_feedback row to rag_vector_db',
        );
      }
    }

    return record;
  }

  public async getFeedbackSummary(): Promise<CopilotFeedbackSummary> {
    await this.ensureInitialized();
    if (this.pgStore) {
      try {
        const db = await this.pgStore.getDbClient();
        const [countsRes, reasonsRes] = await Promise.all([
          db.query<{ rating: string; cnt: number | string }>(
            `SELECT rating, COUNT(*)::int AS cnt
             FROM ai_copilot_feedback
             GROUP BY rating`,
          ),
          db.query<{ reason: string }>(
            `SELECT reason
             FROM ai_copilot_feedback
             WHERE reason IS NOT NULL AND BTRIM(reason) <> ''
             ORDER BY created_at DESC
             LIMIT 10`,
          ),
        ]);
        let thumbsUp = 0;
        let thumbsDown = 0;
        for (const row of countsRes.rows) {
          if (String(row.rating).toUpperCase() === 'UP') {
            thumbsUp = Number(row.cnt ?? 0);
          } else if (String(row.rating).toUpperCase() === 'DOWN') {
            thumbsDown = Number(row.cnt ?? 0);
          }
        }
        const recentReasons = reasonsRes.rows
          .map((r) => (r.reason ? sanitizeFeedbackText(String(r.reason), 240) : ''))
          .filter(Boolean);
        return computeCopilotFeedbackSummary(thumbsUp, thumbsDown, recentReasons);
      } catch (err) {
        this.logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'Failed to query ai_copilot_feedback summary from rag_vector_db',
        );
      }
    }

    const up = this.memoryFeedback.filter((f) => f.rating === 'UP').length;
    const down = this.memoryFeedback.filter((f) => f.rating === 'DOWN').length;
    const recentReasons = this.memoryFeedback
      .map((f) => f.reason)
      .filter((r): r is string => typeof r === 'string' && r.trim().length > 0)
      .slice(0, 10);
    return computeCopilotFeedbackSummary(up, down, recentReasons);
  }

  public async listFeedbackForExport(limit = 500): Promise<CopilotFeedbackRecord[]> {
    await this.ensureInitialized();
    const safeLimit = Math.max(1, Math.min(2000, Math.floor(limit)));
    if (this.pgStore) {
      try {
        const db = await this.pgStore.getDbClient();
        const res = await db.query<{
          id: string;
          trace_id: string;
          session_id: string | null;
          portal: string;
          actor_role: string | null;
          role: string | null;
          user_id: string;
          rating: string;
          reason: string | null;
          prompt_text: string | null;
          response_text: string | null;
          created_at: string | Date;
        }>(
          `SELECT id, trace_id, session_id, portal,
                  COALESCE(actor_role, role, 'UNKNOWN') AS actor_role,
                  COALESCE(role, actor_role, 'UNKNOWN') AS role,
                  user_id, rating, reason, prompt_text, response_text, created_at
           FROM ai_copilot_feedback
           ORDER BY created_at DESC
           LIMIT $1`,
          [safeLimit],
        );
        return res.rows.map((r) => ({
          id: String(r.id),
          traceId: String(r.trace_id),
          sessionId: r.session_id ? String(r.session_id) : null,
          portal:
            String(r.portal).toUpperCase() === 'STOREFRONT'
              ? 'STOREFRONT'
              : String(r.portal).toUpperCase() === 'INTERNAL'
                ? 'INTERNAL'
                : 'ADMIN_PORTAL',
          role: String(r.actor_role || r.role || 'UNKNOWN'),
          userId: String(r.user_id || 'anonymous'),
          rating: String(r.rating).toUpperCase() === 'DOWN' ? 'DOWN' : 'UP',
          reason: r.reason ? sanitizeFeedbackText(String(r.reason), 500) : null,
          promptText: r.prompt_text
            ? sanitizeFeedbackText(String(r.prompt_text), 4000)
            : null,
          responseText: r.response_text
            ? sanitizeFeedbackText(String(r.response_text), 8000)
            : null,
          createdAt:
            r.created_at instanceof Date
              ? r.created_at.toISOString()
              : String(r.created_at || new Date().toISOString()),
        }));
      } catch {
        // Fall through to memory feedback
      }
    }
    return this.memoryFeedback.slice(0, safeLimit);
  }

  public async retrieveStorefront(
    query: string,
    topK = 3,
  ): Promise<HybridRagResult> {
    const raw = await this.retrieve(query, Math.max(topK + 3, 6));
    const isInternalHit = (hit: {
      sourceId: string;
      metadata?: Record<string, unknown>;
    }): boolean => {
      const parentDocId =
        typeof hit.metadata?.parentDocId === 'string'
          ? hit.metadata.parentDocId
          : hit.sourceId.replace(/::chunk_\d+$/, '');
      const domain =
        typeof hit.metadata?.domain === 'string' ? hit.metadata.domain : '';
      const category =
        typeof hit.metadata?.category === 'string' ? hit.metadata.category : '';
      return (
        INTERNAL_ONLY_RAG_DOC_IDS.has(hit.sourceId) ||
        INTERNAL_ONLY_RAG_DOC_IDS.has(parentDocId) ||
        domain === 'operations_sop' ||
        category === 'operations_sop'
      );
    };

    const filteredHits = raw.fusedHits
      .filter((h) => !isInternalHit(h))
      .slice(0, topK);
    const filteredCitations: RagCitation[] = filteredHits.map((h) => ({
      sourceId: h.sourceId,
      title: h.title,
      snippet: h.snippet,
      score: h.score,
    }));

    if (filteredCitations.length > 0) {
      return {
        query: raw.query,
        answer: raw.answer,
        rrfK: raw.rrfK,
        status: 'GROUNDED',
        citations: filteredCitations,
        fusedHits: filteredHits,
      };
    }
    return {
      query: raw.query,
      answer: raw.answer,
      rrfK: raw.rrfK,
      status: 'NO_GROUNDED_EVIDENCE',
      citations: [],
      fusedHits: [],
    };
  }

  public async retrieve(
    query: string,
    topK = 3,
  ): Promise<HybridRagResult> {
    await this.ensureInitialized();
    const retriever = this.pgRetriever ?? this.fallbackRetriever;
    try {
      const result = await retriever.retrieve(query, { topK });
      if (this.pgStore) {
        // When live rag_vector_db store is active, honor active/deactivated state strictly
        return result;
      }
      return result;
    } catch {
      return this.fallbackRetriever.retrieve(query, { topK });
    }
  }

  public async resolveCitations(
    query: string,
    fallbackCitation: RagCitation,
    topK = 3,
  ): Promise<RagCitation[]> {
    const rag = await this.retrieve(query, topK);
    if (rag.status === 'GROUNDED' && rag.citations.length > 0) {
      return rag.citations;
    }
    return [fallbackCitation];
  }

  public async close(): Promise<void> {
    if (this.pgStore) {
      const s = this.pgStore;
      this.pgStore = null;
      this.pgRetriever = null;
      await s.close().catch(() => undefined);
    }
  }
}
