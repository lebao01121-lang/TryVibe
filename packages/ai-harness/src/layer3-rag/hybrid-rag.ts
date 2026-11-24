export const DEFAULT_RRF_K = 60;

export interface RagDocumentHit {
  sourceId: string;
  title: string;
  snippet: string;
  score: number;
  metadata?: Record<string, unknown>;
}

export interface RagCitation {
  sourceId: string;
  title: string;
  snippet: string;
  score: number;
}

export interface FusedRagHit extends RagCitation {
  semanticRank: number | null;
  keywordRank: number | null;
  metadata?: Record<string, unknown>;
}

export interface RagSearchOptions {
  topK?: number;
  locale?: string;
  filters?: Record<string, string | number | boolean>;
}

export interface VectorSearchProvider {
  search(query: string, options?: RagSearchOptions): Promise<RagDocumentHit[]>;
}

export interface KeywordSearchProvider {
  search(query: string, options?: RagSearchOptions): Promise<RagDocumentHit[]>;
}

export type HybridRagResult =
  | {
      status: 'GROUNDED';
      query: string;
      answer: string;
      citations: RagCitation[];
      fusedHits: FusedRagHit[];
      rrfK: number;
    }
  | {
      status: 'NO_GROUNDED_EVIDENCE';
      query: string;
      answer: string;
      citations: [];
      fusedHits: [];
      rrfK: number;
    };

export interface HybridRagOptions {
  semanticProvider: VectorSearchProvider;
  keywordProvider: KeywordSearchProvider;
  rrfK?: number;
  minRrfScore?: number;
  topK?: number;
}

export function reciprocalRankFusion(
  semanticHits: readonly RagDocumentHit[],
  keywordHits: readonly RagDocumentHit[],
  k = DEFAULT_RRF_K,
): FusedRagHit[] {
  const safeK = Math.max(1, k);
  const accumulator = new Map<
    string,
    {
      sourceId: string;
      title: string;
      snippet: string;
      rrfScore: number;
      semanticRank: number | null;
      keywordRank: number | null;
      metadata?: Record<string, unknown>;
    }
  >();

  semanticHits.forEach((hit, index) => {
    const rank = index + 1;
    const contribution = 1 / (safeK + rank);
    const existing = accumulator.get(hit.sourceId);
    if (existing) {
      existing.rrfScore += contribution;
      existing.semanticRank = existing.semanticRank ?? rank;
    } else {
      accumulator.set(hit.sourceId, {
        sourceId: hit.sourceId,
        title: hit.title,
        snippet: hit.snippet,
        rrfScore: contribution,
        semanticRank: rank,
        keywordRank: null,
        metadata: hit.metadata,
      });
    }
  });

  keywordHits.forEach((hit, index) => {
    const rank = index + 1;
    const contribution = 1 / (safeK + rank);
    const existing = accumulator.get(hit.sourceId);
    if (existing) {
      existing.rrfScore += contribution;
      existing.keywordRank = existing.keywordRank ?? rank;
      if (!existing.snippet && hit.snippet) {
        existing.snippet = hit.snippet;
      }
    } else {
      accumulator.set(hit.sourceId, {
        sourceId: hit.sourceId,
        title: hit.title,
        snippet: hit.snippet,
        rrfScore: contribution,
        semanticRank: null,
        keywordRank: rank,
        metadata: hit.metadata,
      });
    }
  });

  return Array.from(accumulator.values())
    .map((entry) => ({
      sourceId: entry.sourceId,
      title: entry.title,
      snippet: entry.snippet,
      score: Number(entry.rrfScore.toFixed(6)),
      semanticRank: entry.semanticRank,
      keywordRank: entry.keywordRank,
      metadata: entry.metadata,
    }))
    .sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      return a.sourceId.localeCompare(b.sourceId);
    });
}

export class HybridRagRetriever {
  private readonly semanticProvider: VectorSearchProvider;
  private readonly keywordProvider: KeywordSearchProvider;
  private readonly rrfK: number;
  private readonly minRrfScore: number;
  private readonly defaultTopK: number;

  constructor(options: HybridRagOptions) {
    this.semanticProvider = options.semanticProvider;
    this.keywordProvider = options.keywordProvider;
    this.rrfK = options.rrfK ?? DEFAULT_RRF_K;
    this.minRrfScore = options.minRrfScore ?? 0.005;
    this.defaultTopK = options.topK ?? 5;
  }

  public async retrieve(
    query: string,
    options: RagSearchOptions = {},
  ): Promise<HybridRagResult> {
    const normalizedQuery = query.trim();
    const topK = options.topK ?? this.defaultTopK;

    if (!normalizedQuery) {
      return {
        status: 'NO_GROUNDED_EVIDENCE',
        query: normalizedQuery,
        answer: 'NO_GROUNDED_EVIDENCE',
        citations: [],
        fusedHits: [],
        rrfK: this.rrfK,
      };
    }

    const [semanticHits, keywordHits] = await Promise.all([
      this.semanticProvider.search(normalizedQuery, { ...options, topK }),
      this.keywordProvider.search(normalizedQuery, { ...options, topK }),
    ]);

    const fusedHits = reciprocalRankFusion(
      semanticHits,
      keywordHits,
      this.rrfK,
    )
      .filter((hit) => hit.score >= this.minRrfScore)
      .slice(0, topK);

    if (fusedHits.length === 0) {
      return {
        status: 'NO_GROUNDED_EVIDENCE',
        query: normalizedQuery,
        answer: 'NO_GROUNDED_EVIDENCE',
        citations: [],
        fusedHits: [],
        rrfK: this.rrfK,
      };
    }

    const citations: RagCitation[] = fusedHits.map((hit) => ({
      sourceId: hit.sourceId,
      title: hit.title,
      snippet: hit.snippet,
      score: hit.score,
    }));

    const summary = citations
      .slice(0, 2)
      .map((item) => `[${item.sourceId}] ${item.title}: ${item.snippet}`)
      .join(' | ');

    return {
      status: 'GROUNDED',
      query: normalizedQuery,
      answer: summary,
      citations,
      fusedHits,
      rrfK: this.rrfK,
    };
  }
}

export interface KnowledgeCorpusDocument {
  sourceId: string;
  title: string;
  snippet: string;
  keywords: readonly string[];
  tags: readonly string[];
}

function normalizeVietnameseForSearch(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export const DEFAULT_ATELIER_KNOWLEDGE_CORPUS: readonly KnowledgeCorpusDocument[] =
  [
    {
      sourceId: 'kb_size_chart_tops_v1',
      title: 'Bang thong so size ao lua & so mi Atelier',
      snippet:
        'Size S (nguc 82-86cm, eo 64-68cm, 45-51kg), Size M (nguc 87-91cm, eo 69-73cm, 52-57kg), Size L (nguc 92-96cm, eo 74-78cm, 58-64kg).',
      keywords: ['size', 'so do', 'ao', 'lua', 'so mi', 'nguc', 'eo', 'can nang'],
      tags: ['sizing', 'catalog', 'tops'],
    },
    {
      sourceId: 'kb_rma_exchange_policy_v1',
      title: 'Chinh sach doi size & hoan tra RMA 14 ngay',
      snippet:
        'Ho tro doi size mien phi trong 14 ngay ke tu ngay nhan hang khi con nguyen tem mac, chua giat la. Hoan tien trong 3-5 ngay lam viec sau khi QC kho dat.',
      keywords: ['doi size', 'rma', 'hoan tra', 'hoan tien', 'qc', 'chinh sach'],
      tags: ['rma', 'refund', 'sizing'],
    },
    {
      sourceId: 'kb_outfit_compatibility_v1',
      title: 'Quy tac phoi do Mix & Match & Combo Set Atelier',
      snippet:
        'Ao lua co tau (TOP) phoi quan au ong suong hoac chan vay midi (BOTTOM) kem blazer (OUTERWEAR). Combo tu 2 mon giam 5%, tu 3 mon giam 10%.',
      keywords: ['phoi do', 'outfit', 'combo', 'blazer', 'chan vay', 'quan au', 'tiec toi', 'cong so'],
      tags: ['styling', 'outfit', 'promotion'],
    },
    {
      sourceId: 'kb_vton_garment_standards_v1',
      title: 'Tieu chuan anh phang 3:4 cho phong thu do AI Try-On',
      snippet:
        'Anh trang phuc thu do AI can ty le 3:4 (768x1024px), nen sach, tach vien ro rang, va phai o trang thai NHAP_AI cho nhan su danh muc duyet.',
      keywords: ['try-on', 'thu do', 'anh phang', '3:4', '768x1024', 'nhap_ai'],
      tags: ['vton', 'media', 'catalog'],
    },
  ];

export class InMemorySemanticProvider implements VectorSearchProvider {
  constructor(
    private readonly docs: readonly KnowledgeCorpusDocument[] = DEFAULT_ATELIER_KNOWLEDGE_CORPUS,
  ) {}

  public async search(
    query: string,
    options?: RagSearchOptions,
  ): Promise<RagDocumentHit[]> {
    const tokens = normalizeVietnameseForSearch(query).split(' ').filter(Boolean);
    const topK = options?.topK ?? 5;

    return this.docs
      .map((doc) => {
        const haystack = normalizeVietnameseForSearch(
          `${doc.title} ${doc.snippet} ${doc.tags.join(' ')}`,
        );
        const matches = tokens.filter((t) => haystack.includes(t)).length;
        const score = tokens.length > 0 ? matches / tokens.length : 0;
        return {
          sourceId: doc.sourceId,
          title: doc.title,
          snippet: doc.snippet,
          score: Number(score.toFixed(4)),
          metadata: { provider: 'pgvector-inmemory' },
        };
      })
      .filter((hit) => hit.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }
}

export class InMemoryKeywordProvider implements KeywordSearchProvider {
  constructor(
    private readonly docs: readonly KnowledgeCorpusDocument[] = DEFAULT_ATELIER_KNOWLEDGE_CORPUS,
  ) {}

  public async search(
    query: string,
    options?: RagSearchOptions,
  ): Promise<RagDocumentHit[]> {
    const normalized = normalizeVietnameseForSearch(query);
    const topK = options?.topK ?? 5;

    return this.docs
      .map((doc) => {
        let hits = 0;
        for (const kw of doc.keywords) {
          if (normalized.includes(normalizeVietnameseForSearch(kw))) {
            hits += 1;
          }
        }
        const score = doc.keywords.length > 0 ? hits / doc.keywords.length : 0;
        return {
          sourceId: doc.sourceId,
          title: doc.title,
          snippet: doc.snippet,
          score: Number(score.toFixed(4)),
          metadata: { provider: 'meilisearch-inmemory' },
        };
      })
      .filter((hit) => hit.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }
}
