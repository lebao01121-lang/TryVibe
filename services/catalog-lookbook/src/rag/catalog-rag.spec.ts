import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_RRF_K,
  HybridRagRetriever,
  InMemoryKeywordProvider,
  InMemorySemanticProvider,
  PgVectorRagStore,
  reciprocalRankFusion,
  type HybridRagQueryOutput,
  type RagDocumentHit,
} from '@atelier/ai-harness';
import type { CatalogLookbookConfig } from '../config/env';
import { CatalogRagService } from './catalog-rag.service';

function createMockConfig(): CatalogLookbookConfig {
  return {
    serviceName: '@atelier/catalog-lookbook',
    boundedContext: 'catalog-lookbook',
    port: 4002,
    nodeEnv: 'test',
    database: {
      envVar: 'CATALOG_DATABASE_URL',
      url: 'postgresql://svc_catalog:test@127.0.0.1:5432/catalog_db',
      configured: false,
      targetDatabase: 'catalog_db',
      host: '127.0.0.1',
      port: 5432,
    },
    ragDatabase: {
      envVar: 'RAG_VECTOR_DATABASE_URL',
      url: 'postgresql://svc_rag:test@127.0.0.1:5432/rag_vector_db',
      targetDatabase: 'rag_vector_db',
    },
    infra: {
      meilisearchHost: 'http://127.0.0.1:7700',
      meilisearchMasterKey: 'test-key',
      meilisearchConfigured: false,
      minioEndpoint: '127.0.0.1',
      minioPort: 9000,
      minioRootUser: 'minio',
      minioRootPassword: 'secret',
      minioBucketPublic: 'atelier-public',
      minioBucketGarments: 'atelier-garments',
      minioPublicBaseUrl: 'http://127.0.0.1:9000',
      mediaServiceUrl: 'http://127.0.0.1:4003',
      notifyReviewServiceUrl: 'http://127.0.0.1:4008',
      aiTryOnServiceUrl: 'http://127.0.0.1:4009',
      storefrontUrl: 'http://127.0.0.1:3000',
      revalidateSecret: 'reval',
      internalServiceSecret: 'internal',
      redisUrl: 'redis://127.0.0.1:6379',
      rabbitmqConfigured: false,
    },
  };
}

describe('Hybrid RAG Reciprocal Rank Fusion (RRF k=60)', () => {
  it('merges semantic (pgvector) and keyword (Meilisearch/BM25) rankings with exact RRF k=60 math and deduplication', () => {
    const semanticHits: RagDocumentHit[] = [
      { sourceId: 'doc_a', title: 'Đổi size RMA', snippet: 'Đổi size 14 ngày', score: 0.92 },
      { sourceId: 'doc_b', title: 'Combo Set', snippet: '', score: 0.85 },
      { sourceId: 'doc_c', title: 'Bảo quản lụa', snippet: 'Giặt tay nước lạnh', score: 0.72 },
    ];
    const keywordHits: RagDocumentHit[] = [
      { sourceId: 'doc_b', title: 'Combo Set', snippet: 'Combo 3 món giảm 10%', score: 4.5 },
      { sourceId: 'doc_d', title: 'Giao hàng 2H', snippet: 'AhaMove nội thành', score: 3.1 },
      { sourceId: 'doc_a', title: 'Đổi size RMA', snippet: 'Đổi size 14 ngày', score: 2.0 },
    ];

    const fused = reciprocalRankFusion(semanticHits, keywordHits, DEFAULT_RRF_K);

    // Deduplicated to 4 unique documents
    expect(fused).toHaveLength(4);
    expect(DEFAULT_RRF_K).toBe(60);

    // doc_b: semantic rank 2 -> 1/62, keyword rank 1 -> 1/61 => highest score
    const expectedB = Number((1 / 62 + 1 / 61).toFixed(6));
    // doc_a: semantic rank 1 -> 1/61, keyword rank 3 -> 1/63
    const expectedA = Number((1 / 61 + 1 / 63).toFixed(6));
    // doc_d: keyword rank 2 -> 1/62
    const expectedD = Number((1 / 62).toFixed(6));
    // doc_c: semantic rank 3 -> 1/63
    const expectedC = Number((1 / 63).toFixed(6));

    expect(fused.map((h) => h.sourceId)).toEqual(['doc_b', 'doc_a', 'doc_d', 'doc_c']);
    expect(fused[0]?.score).toBe(expectedB);
    expect(fused[0]?.semanticRank).toBe(2);
    expect(fused[0]?.keywordRank).toBe(1);
    expect(fused[0]?.snippet).toBe('Combo 3 món giảm 10%');

    expect(fused[1]?.score).toBe(expectedA);
    expect(fused[1]?.semanticRank).toBe(1);
    expect(fused[1]?.keywordRank).toBe(3);

    expect(fused[2]?.score).toBe(expectedD);
    expect(fused[2]?.semanticRank).toBeNull();
    expect(fused[2]?.keywordRank).toBe(2);

    expect(fused[3]?.score).toBe(expectedC);
    expect(fused[3]?.semanticRank).toBe(3);
    expect(fused[3]?.keywordRank).toBeNull();
  });

  it('breaks identical RRF scores deterministically by ascending sourceId', () => {
    const fused = reciprocalRankFusion(
      [{ sourceId: 'doc_z', title: 'Z', snippet: 'Z', score: 0.9 }],
      [{ sourceId: 'doc_a', title: 'A', snippet: 'A', score: 0.9 }],
      60,
    );
    expect(fused.map((h) => h.sourceId)).toEqual(['doc_a', 'doc_z']);
    expect(fused[0]?.score).toBe(fused[1]?.score);
  });

  it('retrieves grounded evidence via HybridRagRetriever and falls back to NO_GROUNDED_EVIDENCE on empty or unmatched queries', async () => {
    const retriever = new HybridRagRetriever({
      semanticProvider: new InMemorySemanticProvider(),
      keywordProvider: new InMemoryKeywordProvider(),
      rrfK: 60,
      topK: 3,
    });

    const emptyRes = await retriever.retrieve('   ');
    expect(emptyRes.status).toBe('NO_GROUNDED_EVIDENCE');
    expect(emptyRes.citations).toEqual([]);
    expect(emptyRes.rrfK).toBe(60);

    const grounded = await retriever.retrieve('Chính sách đổi size RMA hoàn tiền 14 ngày');
    expect(grounded.status).toBe('GROUNDED');
    expect(grounded.citations.length).toBeGreaterThan(0);
    expect(grounded.citations[0]?.sourceId).toBe('kb_rma_exchange_policy_v1');

    const unmatched = await retriever.retrieve('zzzzz_unmatched_quantum_token_9999');
    expect(unmatched.status).toBe('NO_GROUNDED_EVIDENCE');
    expect(unmatched.fusedHits).toEqual([]);
  });
});

describe('CatalogRagService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('initializes PgVectorRagStore onModuleInit, exposes mode & documentCount, queries hybrid RAG, and closes cleanly', async () => {
    const ensureSpy = vi
      .spyOn(PgVectorRagStore.prototype, 'ensureInitialized')
      .mockResolvedValue({} as never);
    const countSpy = vi.spyOn(PgVectorRagStore.prototype, 'getDocumentCount').mockResolvedValue(12);
    const modeSpy = vi.spyOn(PgVectorRagStore.prototype, 'getMode').mockReturnValue('postgres');
    const closeSpy = vi.spyOn(PgVectorRagStore.prototype, 'close').mockResolvedValue(undefined);

    const mockOutput: HybridRagQueryOutput = {
      status: 'GROUNDED',
      query: 'phối đồ blazer công sở',
      answer: '[Quy tắc phối đồ] Combo 3 món giảm 10%',
      passages: [
        {
          sourceId: 'rag_doc_12_combo_payment_delivery',
          title: 'Ưu đãi Phối đồ Combo Set',
          content: 'Combo 3 món giảm 10%',
          domain: 'storefront_service',
          category: 'other',
          sourceUri: 'atelier://service/combo-vietqr-delivery-v1',
          score: 0.032522,
        },
      ],
      citations: [
        {
          sourceId: 'rag_doc_12_combo_payment_delivery',
          title: 'Ưu đãi Phối đồ Combo Set',
          snippet: 'Combo 3 món giảm 10%',
          score: 0.032522,
        },
      ],
      rrfK: 60,
      dbMode: 'postgres',
    };
    const querySpy = vi
      .spyOn(PgVectorRagStore.prototype, 'queryHybrid')
      .mockResolvedValue(mockOutput);

    const service = new CatalogRagService(createMockConfig());
    await service.onModuleInit();

    expect(ensureSpy).toHaveBeenCalledTimes(1);
    expect(countSpy).toHaveBeenCalledTimes(1);
    expect(service.getMode()).toBe('postgres');
    expect(service.getDocumentCount()).toBe(12);

    const result = await service.query('phối đồ blazer công sở', 4);
    expect(querySpy).toHaveBeenCalledWith('phối đồ blazer công sở', { topK: 4 });
    expect(result.status).toBe('GROUNDED');
    expect(result.rrfK).toBe(60);
    expect(modeSpy).toHaveBeenCalled();

    await service.onModuleDestroy();
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('defers initialization safely when onModuleInit fails and refreshes document count on first query', async () => {
    vi.spyOn(PgVectorRagStore.prototype, 'ensureInitialized').mockRejectedValue(
      new Error('db starting up'),
    );
    const countSpy = vi.spyOn(PgVectorRagStore.prototype, 'getDocumentCount').mockResolvedValue(12);
    vi.spyOn(PgVectorRagStore.prototype, 'getMode').mockReturnValue('pglite');
    vi.spyOn(PgVectorRagStore.prototype, 'queryHybrid').mockResolvedValue({
      status: 'NO_GROUNDED_EVIDENCE',
      query: 'unknown',
      answer: 'NO_GROUNDED_EVIDENCE',
      passages: [],
      citations: [],
      rrfK: 60,
      dbMode: 'pglite',
    });

    const service = new CatalogRagService(createMockConfig());
    await expect(service.onModuleInit()).resolves.toBeUndefined();
    expect(service.getDocumentCount()).toBe(0);
    expect(service.getMode()).toBe('pglite');

    const res = await service.query('unknown');
    expect(res.status).toBe('NO_GROUNDED_EVIDENCE');
    expect(countSpy).toHaveBeenCalledTimes(1);
    expect(service.getDocumentCount()).toBe(12);
  });
});
