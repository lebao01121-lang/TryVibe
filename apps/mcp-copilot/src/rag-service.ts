import {
  ATELIER_RAG_KNOWLEDGE_DOCS,
  HybridRagRetriever,
  InMemoryKeywordProvider,
  InMemorySemanticProvider,
  OllamaEmbeddingClient,
  PgVectorRagStore,
  type HybridRagResult,
  type KeywordSearchProvider,
  type KnowledgeCorpusDocument,
  type RagCitation,
  type RagDocumentHit,
  type RagSearchOptions,
} from '@atelier/ai-harness';
import type { Logger } from '@atelier/observability';
import {
  type McpCopilotConfig,
  parseSafeConnectionTarget,
  probeTcpConnectivity,
} from './config.js';

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
    if (!this.config.ragVectorDatabaseUrl) {
      this.backendMode = 'in-memory';
      return;
    }

    try {
      const target = parseSafeConnectionTarget(this.config.ragVectorDatabaseUrl);
      const tcpReachable = target
        ? (await probeTcpConnectivity(target.host, target.port, 250)).reachable
        : false;

      // Connect strictly to rag_vector_db (vector(768) powered by Ollama nomic-embed-text)
      const store = new PgVectorRagStore({
        databaseUrl: this.config.ragVectorDatabaseUrl,
        dbName: tcpReachable ? 'rag_vector_db' : 'rag_vector_db_copilot',
        forcePglite: !tcpReachable,
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
      this.logger.info(
        {
          backendMode: this.backendMode,
          embedModel: this.embeddingClient.getModel(),
          embedDim: this.embeddingClient.getDimension(),
        },
        'MCP Copilot Layer 3 Hybrid RAG (768-dim Ollama nomic-embed-text) initialized on rag_vector_db',
      );
    } catch (error) {
      this.backendMode = 'in-memory';
      this.logger.warn(
        { err: error instanceof Error ? error.message : String(error) },
        'Falling back to in-memory Hybrid RAG corpus for policy citations',
      );
    }
  }

  public async retrieve(
    query: string,
    topK = 3,
  ): Promise<HybridRagResult> {
    await this.ensureInitialized();
    const retriever = this.pgRetriever ?? this.fallbackRetriever;
    try {
      const result = await retriever.retrieve(query, { topK });
      if (result.status === 'GROUNDED' && result.citations.length > 0) {
        return result;
      }
      if (retriever !== this.fallbackRetriever) {
        return this.fallbackRetriever.retrieve(query, { topK });
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
