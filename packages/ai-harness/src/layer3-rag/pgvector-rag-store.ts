import { randomUUID } from 'node:crypto';
import {
  createIsolatedPgClient,
  type AtelierDbClient,
  type AtelierDbMode,
} from '@atelier/db-client';
import {
  DEFAULT_OLLAMA_EMBED_DIM,
  OllamaEmbeddingClient,
  embedLocalDeterministic768,
} from '../layer1-models';
import {
  DEFAULT_RRF_K,
  HybridRagRetriever,
  reciprocalRankFusion,
  type HybridRagResult,
  type KeywordSearchProvider,
  type RagCitation,
  type RagDocumentHit,
  type RagSearchOptions,
  type VectorSearchProvider,
} from './hybrid-rag';

export const EMBEDDING_DIM = DEFAULT_OLLAMA_EMBED_DIM;
export const RAG_EMBEDDING_DIM = EMBEDDING_DIM;
export const DEFAULT_RAG_DB_NAME = 'rag_vector_db';
export const DEFAULT_RAG_DATABASE_URL =
  'postgresql://svc_rag:Atelier_Rag2026!@127.0.0.1:5432/rag_vector_db';

export const RAG_CANONICAL_CATEGORIES = [
  'policy_rma',
  'operations_sop',
  'fabric_care',
  'sizing',
  'privacy_tryon',
  'storefront_service',
  'general',
] as const;

export type RagCanonicalCategory = (typeof RAG_CANONICAL_CATEGORIES)[number];

export interface RagVectorIndexSpec {
  readonly type: 'hnsw';
  readonly opClass: 'vector_cosine_ops';
  readonly m: number;
  readonly efConstruction: number;
}

export const RAG_HNSW_INDEX_SPEC: RagVectorIndexSpec = Object.freeze({
  type: 'hnsw',
  opClass: 'vector_cosine_ops',
  m: 16,
  efConstruction: 64,
});

export const RAG_HNSW_INDEX_SQL =
  'CREATE INDEX IF NOT EXISTS idx_rag_documents_embedding_hnsw ON rag_documents USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);';

export const RAG_FTS_INDEX_SQL =
  "CREATE INDEX IF NOT EXISTS idx_rag_documents_fts_simple ON rag_documents USING gin (to_tsvector('simple', coalesce(title,'') || ' ' || coalesce(content,'')));";

export const RAG_VERSIONING_ALTER_SQL = `
ALTER TABLE rag_documents ADD COLUMN IF NOT EXISTS category TEXT DEFAULT 'general';
ALTER TABLE rag_documents ADD COLUMN IF NOT EXISTS version INTEGER DEFAULT 1;
ALTER TABLE rag_documents ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE;
ALTER TABLE rag_documents ADD COLUMN IF NOT EXISTS updated_by TEXT DEFAULT 'system';
ALTER TABLE rag_documents ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE rag_documents ADD COLUMN IF NOT EXISTS parent_doc_id TEXT;
ALTER TABLE rag_documents ADD COLUMN IF NOT EXISTS chunk_index INTEGER DEFAULT 0;
ALTER TABLE rag_documents ADD COLUMN IF NOT EXISTS embedding_status TEXT DEFAULT 'EMBEDDED';
ALTER TABLE rag_documents ADD COLUMN IF NOT EXISTS embedding_model TEXT DEFAULT 'nomic-embed-text';

UPDATE rag_documents
SET
  category = COALESCE(NULLIF(category, ''), NULLIF(domain, ''), 'general'),
  version = COALESCE(version, 1),
  is_active = COALESCE(is_active, TRUE),
  updated_by = COALESCE(NULLIF(updated_by, ''), 'system'),
  updated_at = COALESCE(updated_at, NOW()),
  parent_doc_id = COALESCE(NULLIF(parent_doc_id, ''), id),
  chunk_index = COALESCE(chunk_index, 0),
  embedding_status = COALESCE(NULLIF(embedding_status, ''), 'EMBEDDED'),
  embedding_model = COALESCE(NULLIF(embedding_model, ''), 'nomic-embed-text')
WHERE
  parent_doc_id IS NULL
  OR category IS NULL
  OR version IS NULL
  OR is_active IS NULL
  OR updated_by IS NULL
  OR chunk_index IS NULL
  OR embedding_status IS NULL
  OR embedding_model IS NULL;

CREATE INDEX IF NOT EXISTS idx_rag_documents_active_category
  ON rag_documents (is_active, category, domain);

CREATE INDEX IF NOT EXISTS idx_rag_documents_parent_chunk
  ON rag_documents (parent_doc_id, chunk_index);
`;

export interface RagKnowledgeDocument {
  id: string;
  domain: string;
  category?: string;
  title: string;
  content: string;
  sourceUri: string;
  metadata: Record<string, unknown>;
}

export interface RagChunkOptions {
  maxChunkChars?: number;
  overlapChars?: number;
}

export interface RagDocumentChunk {
  chunkIndex: number;
  chunk_index: number;
  title: string;
  content: string;
  charStart: number;
  charEnd: number;
  totalChunks: number;
}

export interface RagStoredDocumentChunk {
  id: string;
  chunkIndex: number;
  content: string;
  embeddingStatus: string;
  embeddingModel: string;
}

export interface RagStoredDocument {
  id: string;
  parentDocId: string;
  title: string;
  content: string;
  category: string;
  domain: string;
  sourceUri: string;
  version: number;
  isActive: boolean;
  chunkCount: number;
  embeddingStatus: string;
  embeddingModel: string;
  updatedBy: string;
  updatedAt: string;
  metadata: Record<string, unknown>;
  chunks?: RagStoredDocumentChunk[];
}

export interface ListRagDocumentsFilter {
  category?: string;
  domain?: string;
  includeInactive?: boolean;
  q?: string;
}

export interface CreateRagDocumentInput {
  id?: string;
  title: string;
  content: string;
  category?: string;
  domain?: string;
  sourceUri?: string;
  metadata?: Record<string, unknown>;
  updatedBy?: string;
  maxChunkChars?: number;
  overlapChars?: number;
}

export interface UpdateRagDocumentInput {
  title?: string;
  content?: string;
  category?: string;
  domain?: string;
  sourceUri?: string;
  isActive?: boolean;
  metadata?: Record<string, unknown>;
  updatedBy?: string;
  maxChunkChars?: number;
  overlapChars?: number;
}

export interface RagReindexOptions {
  documentIds?: string[];
  updatedBy?: string;
  maxChunkChars?: number;
  overlapChars?: number;
}

export interface RagReindexResult {
  reindexedDocuments: number;
  reindexedChunks: number;
  embeddingModel: string;
  embeddingDim: number;
  usedFallbackEmbedding: boolean;
  durationMs: number;
  hnswIndexActive: boolean;
  indexSpec: RagVectorIndexSpec;
  dbMode: AtelierDbMode;
}

export interface RagTestRetrievalOptions {
  domain?: string;
  category?: string;
  limit?: number;
}

export interface RagTestRetrievalPassage {
  id: string;
  sourceId: string;
  parentDocId: string;
  chunkIndex: number;
  title: string;
  content: string;
  category: string;
  domain: string;
  sourceUri: string;
  version: number;
  rrfScore: number;
  vectorScore: number;
  keywordScore: number;
  vectorRank: number | null;
  keywordRank: number | null;
}

export interface RagTestRetrievalResult {
  status: 'GROUNDED' | 'NO_GROUNDED_EVIDENCE';
  query: string;
  rrfK: number;
  latencyMs: number;
  hnswIndexActive: boolean;
  indexSpec: RagVectorIndexSpec;
  embeddingModel: string;
  embeddingDim: number;
  dbMode: AtelierDbMode;
  passages: RagTestRetrievalPassage[];
  citations: RagCitation[];
}

export interface RagCorpusSummary {
  activeDocuments: number;
  totalDocuments: number;
  activeChunks: number;
  totalChunks: number;
  embeddingModel: string;
  embeddingDim: number;
  hnswIndexActive: boolean;
  ftsIndexActive: boolean;
  indexSpec: RagVectorIndexSpec;
  dbMode: AtelierDbMode;
}

export interface PgVectorRagStoreOptions {
  databaseUrl?: string;
  dbName?: string;
  dataDirRoot?: string;
  connectTimeoutMs?: number;
  forcePglite?: boolean;
  rrfK?: number;
  embeddingClient?: OllamaEmbeddingClient;
}

export interface HybridRagQueryOutput {
  status: 'GROUNDED' | 'NO_GROUNDED_EVIDENCE';
  query: string;
  answer: string;
  passages: Array<{
    sourceId: string;
    title: string;
    content: string;
    domain: string;
    category: string;
    sourceUri: string;
    score: number;
  }>;
  citations: RagCitation[];
  rrfK: number;
  dbMode: AtelierDbMode;
}

interface RagDocumentRow {
  id: string;
  parent_doc_id?: string | null;
  chunk_index?: number | string | null;
  domain: string;
  category?: string | null;
  title: string;
  content: string;
  source_uri: string;
  version?: number | string | null;
  is_active?: boolean | null;
  embedding_status?: string | null;
  embedding_model?: string | null;
  updated_by?: string | null;
  updated_at?: string | Date | null;
  metadata_jsonb: Record<string, unknown> | string | null;
  cosine_sim?: number;
  l2_dist?: number;
}

function foldVietnamese(input: string): string {
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

function slugifyDocId(input: string): string {
  const folded = foldVietnamese(input)
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  return folded || 'document';
}

function parseMetadataJson(
  raw: Record<string, unknown> | string | null | undefined,
): Record<string, unknown> {
  if (!raw) {
    return {};
  }
  if (typeof raw === 'string') {
    try {
      const parsed: unknown = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  return { ...raw };
}

function stripInternalMetadata(meta: Record<string, unknown>): Record<string, unknown> {
  const cleaned: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (k === '_fullContent') {
      continue;
    }
    cleaned[k] = v;
  }
  return cleaned;
}

function toIsoTimestamp(value: string | Date | null | undefined): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
  }
  return new Date().toISOString();
}

function splitLongSegmentByWords(segment: string, maxLen: number): string[] {
  const words = segment.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  let current = '';

  for (const word of words) {
    if (!current) {
      if (word.length <= maxLen) {
        current = word;
      } else {
        for (let i = 0; i < word.length; i += maxLen) {
          out.push(word.slice(i, i + maxLen));
        }
      }
      continue;
    }

    if (current.length + 1 + word.length <= maxLen) {
      current = `${current} ${word}`;
    } else {
      out.push(current);
      if (word.length <= maxLen) {
        current = word;
      } else {
        for (let i = 0; i < word.length; i += maxLen) {
          out.push(word.slice(i, i + maxLen));
        }
        current = '';
      }
    }
  }

  if (current) {
    out.push(current);
  }
  return out;
}

function extractOverlapTail(text: string, overlapChars: number): string {
  if (overlapChars <= 0 || !text) {
    return '';
  }
  const trimmed = text.trim();
  if (trimmed.length <= overlapChars) {
    return trimmed;
  }

  const rawTail = trimmed.slice(trimmed.length - overlapChars);
  // Avoid cutting a Vietnamese word in half by advancing to the first space if reasonable
  const firstSpace = rawTail.indexOf(' ');
  if (firstSpace > 0 && firstSpace < Math.floor(overlapChars * 0.6)) {
    return rawTail.slice(firstSpace + 1).trim();
  }
  return rawTail.trim();
}

/**
 * Context-overlapping Vietnamese-aware chunker for RAG documents.
 * - Short documents (`content.length <= maxChunkChars`) stay as single chunk `0`.
 * - Preserves Vietnamese sentences & paragraphs cleanly without splitting mid-word.
 * - Prepends `[<title>] ` context prefix and overlapping trailing context on continuation chunks (`chunk_index = 1..N-1`).
 */
export function chunkRagDocument(
  title: string,
  content: string,
  options: RagChunkOptions = {},
): RagDocumentChunk[] {
  const cleanTitle = title.trim();
  const normalizedContent = content.replace(/\r\n/g, '\n').trim();
  const maxChunkChars = Math.max(120, Math.floor(options.maxChunkChars ?? 700));
  const overlapChars = Math.max(
    0,
    Math.min(
      Math.floor(options.overlapChars ?? 120),
      Math.floor(maxChunkChars * 0.45),
    ),
  );

  if (!normalizedContent) {
    return [
      {
        chunkIndex: 0,
        chunk_index: 0,
        title: cleanTitle,
        content: cleanTitle,
        charStart: 0,
        charEnd: cleanTitle.length,
        totalChunks: 1,
      },
    ];
  }

  if (normalizedContent.length <= maxChunkChars) {
    return [
      {
        chunkIndex: 0,
        chunk_index: 0,
        title: cleanTitle,
        content: normalizedContent,
        charStart: 0,
        charEnd: normalizedContent.length,
        totalChunks: 1,
      },
    ];
  }

  const titlePrefix = cleanTitle ? `[${cleanTitle}] ` : '';
  const firstBodyBudget = maxChunkChars;
  const continuationBodyBudget = Math.max(
    100,
    maxChunkChars - titlePrefix.length,
  );

  // Split into paragraph/sentence units preserving Vietnamese punctuation
  const paragraphs = normalizedContent
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);

  const units: string[] = [];
  for (const para of paragraphs) {
    const sentences = para
      .split(/(?<=[.!?…;])\s+|\n+/)
      .map((s) => s.trim())
      .filter(Boolean);

    for (const sentence of sentences) {
      if (sentence.length <= continuationBodyBudget) {
        units.push(sentence);
      } else {
        units.push(...splitLongSegmentByWords(sentence, continuationBodyBudget));
      }
    }
  }

  const rawBodies: string[] = [];
  let unitIdx = 0;

  while (unitIdx < units.length) {
    const isFirst = rawBodies.length === 0;
    const budget = isFirst ? firstBodyBudget : continuationBodyBudget;
    const prevBody = isFirst ? '' : rawBodies[rawBodies.length - 1];
    const rawOverlap = isFirst ? '' : extractOverlapTail(prevBody, overlapChars);

    // Ensure overlap leaves plenty of room for new sentence units
    const maxOverlapForThisChunk = Math.max(
      0,
      Math.min(rawOverlap.length, Math.floor(budget * 0.4)),
    );
    const overlapPrefix =
      rawOverlap.length > maxOverlapForThisChunk
        ? extractOverlapTail(rawOverlap, maxOverlapForThisChunk)
        : rawOverlap;

    let body = overlapPrefix;
    let addedNewUnits = 0;

    while (unitIdx < units.length) {
      const nextUnit = units[unitIdx];
      const separator = body ? ' ' : '';
      const candidate = `${body}${separator}${nextUnit}`;
      if (candidate.length <= budget) {
        body = candidate;
        unitIdx += 1;
        addedNewUnits += 1;
      } else if (addedNewUnits === 0) {
        // Guarantee forward progress even if overlap + unit slightly exceeds budget
        const allowedForUnit = Math.max(
          40,
          budget - (overlapPrefix ? overlapPrefix.length + 1 : 0),
        );
        if (nextUnit.length <= budget) {
          body = nextUnit;
          unitIdx += 1;
          addedNewUnits += 1;
        } else {
          const splitPieces = splitLongSegmentByWords(nextUnit, allowedForUnit);
          body = overlapPrefix
            ? `${overlapPrefix} ${splitPieces[0]}`
            : splitPieces[0];
          const remainder = splitPieces.slice(1).join(' ');
          if (remainder) {
            units[unitIdx] = remainder;
          } else {
            unitIdx += 1;
          }
          addedNewUnits += 1;
        }
        break;
      } else {
        break;
      }
    }

    if (body.trim()) {
      rawBodies.push(body.trim());
    }
  }

  let runningOffset = 0;
  const totalChunks = rawBodies.length;

  return rawBodies.map((body, idx) => {
    const finalContent = idx === 0 ? body : `${titlePrefix}${body}`;
    const charStart = runningOffset;
    const charEnd = charStart + body.length;
    runningOffset = Math.max(0, charEnd - overlapChars);
    return {
      chunkIndex: idx,
      chunk_index: idx,
      title: cleanTitle,
      content: finalContent,
      charStart,
      charEnd,
      totalChunks,
    };
  });
}

export function computeDeterministicEmbedding64(text: string): number[] {
  return embedLocalDeterministic768(text, 64);
}

export function computeDeterministicEmbedding768(text: string): number[] {
  return embedLocalDeterministic768(text, EMBEDDING_DIM);
}

export function toPgVectorLiteral(embedding: readonly number[]): string {
  return `[${embedding.join(',')}]`;
}

export const ATELIER_RAG_KNOWLEDGE_DOCS: readonly RagKnowledgeDocument[] = [
  {
    id: 'rag_doc_01_rma_size_exchange',
    domain: 'policy_rma',
    category: 'policy_rma',
    title: 'Chính sách Đổi Size RMA 2 chiều miễn phí trong 7–14 ngày',
    content:
      'Fashion Atelier hỗ trợ khách hàng đổi size RMA 2 chiều hoàn toàn miễn phí trong vòng 7–14 ngày kể từ ngày nhận hàng (7 ngày đối với đơn giao tiêu chuẩn và tối đa 14 ngày cho hội viên Silver trở lên hoặc đơn đổi kích cỡ). Điều kiện áp dụng: sản phẩm còn nguyên tem mác Atelier, chưa qua giặt là và không có mùi hương lạ. Khi gửi yêu cầu đổi size, bưu tá sẽ giao size mới đồng thời thu hồi size cũ tại cửa; trường hợp trả hàng hoàn tiền được xử lý trong 3–5 ngày làm việc sau khi bộ phận QC kho xác nhận đạt chuẩn.',
    sourceUri: 'atelier://policies/rma-size-exchange-v1',
    metadata: {
      keywords: [
        'doi size',
        'rma',
        '7-14 ngay',
        'hoan tra',
        'hoan tien',
        '2 chieu',
        'mien phi',
      ],
      version: 'v1.0.0',
    },
  },
  {
    id: 'rag_doc_02_tryon_privacy_15min',
    domain: 'privacy_tryon',
    category: 'privacy_tryon',
    title: 'Cam kết quyền riêng tư Phòng Thử Đồ AI — Tự động xóa cứng sau 15 phút',
    content:
      'Mọi ảnh cá nhân và ảnh kết quả từ Phòng Thử Đồ AI (Camera căn dáng & Tải ảnh tĩnh) được lưu trữ độc lập trong kho kín atelier-private-tryon (chặn hoàn toàn truy cập công khai HTTP 403, chỉ truy xuất qua Presigned URL ngắn hạn). Hệ thống áp dụng cơ chế vòng đời dữ liệu tự động xóa cứng vĩnh viễn sau đúng 15 phút kể từ khi hoàn tất phiên thử đồ (tryon.media.purged), không lưu bản sao và tuyệt đối không sử dụng ảnh khách hàng để huấn luyện mô hình AI.',
    sourceUri: 'atelier://policies/tryon-privacy-15m-v1',
    metadata: {
      keywords: [
        '15 phut',
        'xoa cung',
        'vinh vien',
        'rieng tu',
        'thu do ai',
        'private-tryon',
        'anh thu do',
      ],
      version: 'v1.0.0',
    },
  },
  {
    id: 'rag_doc_03_size_chart_tops_blazers',
    domain: 'sizing',
    category: 'sizing',
    title: 'Quy chuẩn bảng size Áo Sơ Mi, Áo Kiểu & Blazer Atelier (XS–XL)',
    content:
      'Bảng size Áo & Blazer chuẩn phom Việt: XS (150–158cm, 40–46kg, ngực 80cm, eo 62cm, vai 36cm), S (155–163cm, 46–52kg, ngực 84cm, eo 66cm, vai 37.5cm), M (160–168cm, 52–58kg, ngực 88cm, eo 70cm, vai 39cm), L (163–172cm, 58–65kg, ngực 93cm, eo 75cm, vai 40.5cm), XL (166–176cm, 65–74kg, ngực 98cm, eo 80cm, vai 42cm). Với dòng Blazer dựng vai thủ công dáng suông, chọn đúng cỡ theo rộng vai để ve áo đứng phom thanh lịch.',
    sourceUri: 'atelier://sizing/tops-blazers-v1',
    metadata: {
      keywords: [
        'bang size',
        'ao blazer',
        'ao so mi',
        'nguc',
        'eo',
        'vai',
        'xs',
        's',
        'm',
        'l',
        'xl',
      ],
      version: 'v1.0.0',
    },
  },
  {
    id: 'rag_doc_04_size_chart_bottoms_skirts',
    domain: 'sizing',
    category: 'sizing',
    title: 'Quy chuẩn bảng size Quần Tây Ống Suông & Chân Váy Midi (XS–XL)',
    content:
      'Bảng size Quần & Chân Váy cạp cao đo tại vòng eo trên rốn 2cm và vòng hông đầy nhất: XS (eo 61cm, hông 85cm), S (eo 65cm, hông 89cm), M (eo 69cm, hông 93cm), L (eo 74cm, hông 98cm), XL (eo 79cm, hông 103cm). Nếu số đo eo và hông rơi vào hai cỡ liền kề, ưu tiên chọn theo vòng hông với quần ống suông xếp ly và chọn theo vòng eo với chân váy xếp ly xòe.',
    sourceUri: 'atelier://sizing/bottoms-skirts-v1',
    metadata: {
      keywords: [
        'quan tay',
        'chan vay',
        'culottes',
        'vong eo',
        'vong hong',
        'bang size quan',
      ],
      version: 'v1.0.0',
    },
  },
  {
    id: 'rag_doc_05_size_chart_dresses',
    domain: 'sizing',
    category: 'sizing',
    title: 'Quy chuẩn bảng size Đầm Dự Tiệc & Đầm Midi Chiết Eo (XS–XL)',
    content:
      'Đầm Dự Tiệc Lụa Satin và Đầm Midi Cổ Vuông Atelier sử dụng hệ rập 3D chuẩn số đo Việt: XS (ngực 80cm, eo 62cm, hông 86cm), S (ngực 84cm, eo 66cm, hông 90cm), M (ngực 88cm, eo 70cm, hông 94cm), L (ngực 93cm, eo 75cm, hông 99cm), XL (ngực 98cm, eo 80cm, hông 104cm). Dòng đầm chiết eo lụa không co giãn nên ưu tiên khoảng thở 1.5–2cm tại vòng eo.',
    sourceUri: 'atelier://sizing/dresses-v1',
    metadata: {
      keywords: [
        'dam du tiec',
        'dam midi',
        'chiet eo',
        'vay di tiec',
        'bang size dam',
      ],
      version: 'v1.0.0',
    },
  },
  {
    id: 'rag_doc_06_stretch_calibration',
    domain: 'sizing',
    category: 'sizing',
    title: 'Hiệu chỉnh tư vấn size theo độ co giãn vải (NONE / LIGHT / HIGH)',
    content:
      'Hệ thống tư vấn size trung thực hiệu chỉnh theo độ co giãn thực tế của chất liệu: vải NONE (Lụa tơ tằm 19 momme, Linen hữu cơ, Organza, Tweed) không co giãn nên khuyến nghị tăng 1 size khi số đo nằm gần ngưỡng trên; vải LIGHT (Gabardine, Wool pha Spandex) giữ đúng cỡ chuẩn; vải HIGH (Len Merino, Dệt kim Bông Ai Cập) đàn hồi tốt, phù hợp chọn đúng size hoặc ưu tiên SLIM nếu thích ôm dáng.',
    sourceUri: 'atelier://sizing/stretch-calibration-v1',
    metadata: {
      keywords: [
        'co gian',
        'none',
        'light',
        'high',
        'hieu chinh',
        'tu van size',
        'fit preference',
      ],
      version: 'v1.0.0',
    },
  },
  {
    id: 'rag_doc_07_care_silk_organza',
    domain: 'fabric_care',
    category: 'fabric_care',
    title: 'Hướng dẫn bảo quản Lụa Tơ Tằm Bảo Lộc & Lụa Organza',
    content:
      'Lụa Tơ Tằm 19 momme, Lụa Satin và Organza cần giặt tay nhẹ nhàng bằng nước mát dưới 30°C với dung dịch giặt có độ pH trung tính (không dùng chất tẩy mạnh hoặc nước xả làm mềm sợi). Không vắt xoắn mạnh; thấm ráo bằng khăn bông trắng rồi phơi trong bóng râm thoáng gió, tránh nắng gắt trực tiếp. Là hơi nước ở nhiệt độ thấp trên mặt trái vải.',
    sourceUri: 'atelier://care/silk-organza-v1',
    metadata: {
      keywords: [
        'bao quan',
        'lua to tam',
        'satin',
        'organza',
        'giat tay',
        'la hoi',
      ],
      version: 'v1.0.0',
    },
  },
  {
    id: 'rag_doc_08_care_linen_gabardine',
    domain: 'fabric_care',
    category: 'fabric_care',
    title: 'Hướng dẫn bảo quản Linen Hữu Cơ & Vải Gabardine',
    content:
      'Trang phục Linen Hữu Cơ (Blazer Linen, Quần Culottes) và Gabardine (Áo Khoác Trench) nên giặt chế độ nhẹ (delicate) trong túi giặt với nước lạnh. Sau khi giặt, giũ phẳng và treo trên móc gỗ bản rộng khi vải còn hơi ẩm để hạn chế nếp nhăn sâu và giữ đường ly chuẩn. Là hơi ở mức nhiệt trung bình (150–180°C).',
    sourceUri: 'atelier://care/linen-gabardine-v1',
    metadata: {
      keywords: [
        'bao quan',
        'linen',
        'huu co',
        'gabardine',
        'trench',
        'moc go',
      ],
      version: 'v1.0.0',
    },
  },
  {
    id: 'rag_doc_09_care_merino_tweed_denim',
    domain: 'fabric_care',
    category: 'fabric_care',
    title: 'Hướng dẫn bảo quản Len Merino, Tweed Dệt Thủ Công & Denim Cao Cấp',
    content:
      'Áo Khoác Tweed Dệt Thủ Công và Blazer dựng cầu vai bắt buộc giặt khô (dry clean) tại xưởng uy tín để bảo vệ cấu trúc dựng canh và sợi dệt nổi. Áo Cardigan Len Merino giặt tay nước lạnh, ép ráo nước bằng khăn và phơi ngang trên mặt phẳng để không bị giãn vai. Trang phục Denim cao cấp nên lộn trái trước khi giặt nước lạnh và hạn chế sấy nhiệt cao.',
    sourceUri: 'atelier://care/merino-tweed-denim-v1',
    metadata: {
      keywords: [
        'bao quan',
        'len merino',
        'tweed',
        'denim',
        'giat kho',
        'phoi ngang',
      ],
      version: 'v1.0.0',
    },
  },
  {
    id: 'rag_doc_10_dual_media_sop',
    domain: 'operations_sop',
    category: 'operations_sop',
    title: 'SOP kiểm định ảnh kép 2:3 Alpha (Giá treo 3D) & 3:4 Flat-lay (Thử đồ AI)',
    content:
      'Media Pipeline kiểm định tệp ảnh theo 3 tầng: xác thực Magic Bytes (loại bỏ tệp giả mạo định dạng), kiểm định ảnh Giá Treo 3D chuẩn tỷ lệ 2:3 (720×1080 WebP) bắt buộc có kênh trong suốt Alpha và tọa độ neo móc (hangerAnchorX, hangerAnchorY), và chuẩn hóa ảnh Thử Đồ AI tỷ lệ 3:4 (768×1024 WebP) nền sạch vào bucket atelier-garments. Mọi ảnh qua AI xử lý đều giữ trạng thái NHAP_AI và autoAttachAsTryOnGarment = false chờ duyệt.',
    sourceUri: 'atelier://sop/dual-media-pipeline-v1',
    metadata: {
      keywords: [
        'sop',
        '2:3',
        '3:4',
        'alpha',
        'flat-lay',
        'magic bytes',
        '720x1080',
        '768x1024',
        'nhap_ai',
      ],
      version: 'v1.0.0',
    },
  },
  {
    id: 'rag_doc_11_supplier_nhap_ai_sop',
    domain: 'operations_sop',
    category: 'operations_sop',
    title: 'Quy trình duyệt mẫu Đối tác (Partner Portal) & Đơn nhập hàng NHAP_AI',
    content:
      'Đối tác Nhà cung cấp (SUPPLIER) đăng nhập Partner Portal bắt buộc xác thực 2FA và bị cô lập chặt theo supplier_id từ JWT. Mẫu mới gửi lên ở trạng thái PENDING_REVIEW để bộ phận Danh mục/Quản trị thẩm định giá vốn (costPriceVnd bị che giấu với nhân sự không có quyền tài chính/thu mua) và thông số rập. Mọi đề xuất đơn nhập hàng do AI Copilot khởi tạo luôn bị khóa ở trạng thái NHAP_AI, bắt buộc quản lý kho phê duyệt thủ công.',
    sourceUri: 'atelier://sop/supplier-nhap-ai-v1',
    metadata: {
      keywords: [
        'nha cung cap',
        'partner',
        'supplier_id',
        'duyet mau',
        'nhap_ai',
        'costpricevnd',
        '2fa',
      ],
      version: 'v1.0.0',
    },
  },
  {
    id: 'rag_doc_12_combo_payment_delivery',
    domain: 'storefront_service',
    category: 'storefront_service',
    title: 'Ưu đãi Phối đồ Combo Set, Thanh toán VietQR & Giao hàng Hỏa tốc',
    content:
      'Khi phối đồ tại Mix & Match Outfit Studio, khách hàng nhận ưu đãi Combo Set giảm 5% từ 2 sản phẩm và giảm 10% từ 3 sản phẩm trở lên. Thanh toán qua VietQR tự động đối soát với thời gian giữ tồn kho 15 phút chống bán quá tồn. Atelier cung cấp 3 hình thức đóng gói (Túi vải Linen mộc miễn phí, Hộp lụa cổ điển và Hộp quà khắc tên ánh kim) cùng giao hỏa tốc nội thành 2 giờ.',
    sourceUri: 'atelier://service/combo-vietqr-delivery-v1',
    metadata: {
      keywords: [
        'combo',
        'phoi do',
        'vietqr',
        '15 phut',
        'giao hoa toc',
        'hop qua',
        'dong goi',
      ],
      version: 'v1.0.0',
    },
  },
];

const RAG_SCHEMA_SQL = `
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS rag_documents (
  id TEXT PRIMARY KEY,
  domain TEXT NOT NULL DEFAULT 'general',
  category TEXT NOT NULL DEFAULT 'general',
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  source_uri TEXT NOT NULL DEFAULT '',
  metadata_jsonb JSONB NOT NULL DEFAULT '{}'::jsonb,
  embedding vector(${EMBEDDING_DIM}) NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  updated_by TEXT NOT NULL DEFAULT 'system',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  parent_doc_id TEXT,
  chunk_index INTEGER NOT NULL DEFAULT 0,
  embedding_status TEXT NOT NULL DEFAULT 'EMBEDDED',
  embedding_model TEXT NOT NULL DEFAULT 'nomic-embed-text'
);

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

export async function seedRagKnowledgeBase(
  store: PgVectorRagStore,
  docs: readonly RagKnowledgeDocument[] = ATELIER_RAG_KNOWLEDGE_DOCS,
): Promise<number> {
  return store.seedDocuments(docs);
}

function buildChunkRowId(parentDocId: string, chunkIndex: number): string {
  return chunkIndex === 0 ? parentDocId : `${parentDocId}::chunk_${chunkIndex}`;
}

function groupRowsIntoDocuments(
  rows: readonly RagDocumentRow[],
  includeChunks = false,
): RagStoredDocument[] {
  const grouped = new Map<string, RagDocumentRow[]>();
  for (const row of rows) {
    const logicalId = (row.parent_doc_id && row.parent_doc_id.trim()) || row.id;
    const bucket = grouped.get(logicalId);
    if (bucket) {
      bucket.push(row);
    } else {
      grouped.set(logicalId, [row]);
    }
  }

  const documents: RagStoredDocument[] = [];
  for (const [logicalId, docRows] of grouped.entries()) {
    docRows.sort(
      (a, b) => Number(a.chunk_index ?? 0) - Number(b.chunk_index ?? 0),
    );
    const primary = docRows[0];
    const rawMeta = parseMetadataJson(primary.metadata_jsonb);
    const fullContent =
      typeof rawMeta._fullContent === 'string' && rawMeta._fullContent.trim()
        ? rawMeta._fullContent
        : docRows.map((r) => r.content).join('\n\n');

    const anyActive = docRows.some((r) => r.is_active !== false);
    const latestUpdatedAt = docRows
      .map((r) => toIsoTimestamp(r.updated_at))
      .sort()
      .pop() ?? new Date().toISOString();

    const doc: RagStoredDocument = {
      id: logicalId,
      parentDocId: logicalId,
      title: primary.title,
      content: fullContent,
      category:
        (primary.category && primary.category.trim()) ||
        (primary.domain && primary.domain.trim()) ||
        'general',
      domain: (primary.domain && primary.domain.trim()) || 'general',
      sourceUri: primary.source_uri || `atelier://kb/${logicalId}`,
      version: Math.max(1, Number(primary.version ?? 1) || 1),
      isActive: anyActive,
      chunkCount: docRows.length,
      embeddingStatus:
        (primary.embedding_status && primary.embedding_status.trim()) || 'EMBEDDED',
      embeddingModel:
        (primary.embedding_model && primary.embedding_model.trim()) ||
        String(rawMeta.embedModel ?? 'nomic-embed-text'),
      updatedBy:
        (primary.updated_by && primary.updated_by.trim()) || 'system',
      updatedAt: latestUpdatedAt,
      metadata: stripInternalMetadata(rawMeta),
    };

    if (includeChunks) {
      doc.chunks = docRows.map((r) => ({
        id: r.id,
        chunkIndex: Number(r.chunk_index ?? 0),
        content: r.content,
        embeddingStatus:
          (r.embedding_status && r.embedding_status.trim()) || 'EMBEDDED',
        embeddingModel:
          (r.embedding_model && r.embedding_model.trim()) || doc.embeddingModel,
      }));
    }

    documents.push(doc);
  }

  return documents.sort((a, b) => {
    const timeCmp = b.updatedAt.localeCompare(a.updatedAt);
    if (timeCmp !== 0) {
      return timeCmp;
    }
    return a.id.localeCompare(b.id);
  });
}

export class PgVectorRagStore {
  public readonly indexSpec: RagVectorIndexSpec = { ...RAG_HNSW_INDEX_SPEC };

  private readonly databaseUrl: string;
  private readonly dbName: string;
  private readonly dataDirRoot?: string;
  private readonly connectTimeoutMs?: number;
  private readonly forcePglite?: boolean;
  private readonly rrfK: number;
  private readonly embeddingClient: OllamaEmbeddingClient;

  private db: AtelierDbClient | null = null;
  private initPromise: Promise<void> | null = null;
  private _hnswIndexActive = false;
  private _ftsIndexActive = false;

  constructor(options: PgVectorRagStoreOptions = {}) {
    this.databaseUrl =
      options.databaseUrl ??
      process.env.RAG_VECTOR_DATABASE_URL ??
      DEFAULT_RAG_DATABASE_URL;
    this.dbName = options.dbName ?? DEFAULT_RAG_DB_NAME;
    this.dataDirRoot = options.dataDirRoot;
    this.connectTimeoutMs = options.connectTimeoutMs;
    this.forcePglite = options.forcePglite;
    this.rrfK = options.rrfK ?? DEFAULT_RRF_K;
    this.embeddingClient =
      options.embeddingClient ??
      new OllamaEmbeddingClient({ dimension: EMBEDDING_DIM });
  }

  public get hnswIndexActive(): boolean {
    return this._hnswIndexActive;
  }

  public get ftsIndexActive(): boolean {
    return this._ftsIndexActive;
  }

  public getEmbeddingClient(): OllamaEmbeddingClient {
    return this.embeddingClient;
  }

  public async ensureInitialized(): Promise<AtelierDbClient> {
    if (this.db) {
      return this.db;
    }
    if (!this.initPromise) {
      this.initPromise = this.initializeInternal();
    }
    await this.initPromise;
    if (!this.db) {
      throw new Error('PgVectorRagStore failed to initialize rag_vector_db');
    }
    return this.db;
  }

  private async migrateLegacyVectorDimensionIfNeeded(
    client: AtelierDbClient,
  ): Promise<void> {
    try {
      const check = await client.query<{ vec_type: string }>(
        `SELECT format_type(a.atttypid, a.atttypmod) AS vec_type
         FROM pg_attribute a
         JOIN pg_class c ON c.oid = a.attrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE c.relname = 'rag_documents'
           AND n.nspname = current_schema()
           AND a.attname = 'embedding'
           AND NOT a.attisdropped
         LIMIT 1`,
      );
      const currentType = check.rows[0]?.vec_type;
      const expectedType = `vector(${EMBEDDING_DIM})`;
      if (currentType && currentType !== expectedType) {
        await client.exec('DROP TABLE IF EXISTS rag_documents');
      }
    } catch {
      // Table does not exist yet or schema introspection unavailable; CREATE TABLE IF NOT EXISTS handles it
    }
  }

  public async ensureSchema(explicitClient?: AtelierDbClient): Promise<{
    hnswIndexActive: boolean;
    ftsIndexActive: boolean;
    indexSpec: RagVectorIndexSpec;
    dbMode: AtelierDbMode;
  }> {
    const client = explicitClient ?? this.db ?? (await this.ensureInitialized());
    await client.exec('CREATE EXTENSION IF NOT EXISTS vector');
    await this.migrateLegacyVectorDimensionIfNeeded(client);
    await client.exec(RAG_SCHEMA_SQL);
    await client.exec(RAG_VERSIONING_ALTER_SQL);
    await client
      .exec(
        `ALTER TABLE ai_copilot_feedback ADD COLUMN IF NOT EXISTS actor_role TEXT NOT NULL DEFAULT 'UNKNOWN';`,
      )
      .catch(() => undefined);

    // 1. Check whether PostgreSQL / pgvector HNSW access method is supported before creating HNSW index
    let hnswSupported = client.mode === 'postgres';
    try {
      const amCheck = await client.query<{ has_hnsw: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM pg_am WHERE amname = 'hnsw') AS has_hnsw`,
      );
      hnswSupported = Boolean(amCheck.rows[0]?.has_hnsw);
    } catch {
      hnswSupported = client.mode === 'postgres';
    }

    if (hnswSupported) {
      try {
        await client.exec(RAG_HNSW_INDEX_SQL);
        this._hnswIndexActive = true;
      } catch {
        this._hnswIndexActive = false;
      }
    } else {
      this._hnswIndexActive = false;
    }

    // 2. Full-Text Search GIN index (safe fallback if unavailable)
    try {
      await client.exec(RAG_FTS_INDEX_SQL);
      this._ftsIndexActive = true;
    } catch {
      this._ftsIndexActive = false;
    }

    return {
      hnswIndexActive: this._hnswIndexActive,
      ftsIndexActive: this._ftsIndexActive,
      indexSpec: this.indexSpec,
      dbMode: client.mode,
    };
  }

  private async initializeInternal(): Promise<void> {
    const client = await createIsolatedPgClient({
      databaseUrl: this.databaseUrl,
      dbName: this.dbName,
      enableVector: true,
      dataDirRoot: this.dataDirRoot,
      connectTimeoutMs: this.connectTimeoutMs,
      forcePglite: this.forcePglite,
    });
    await this.ensureSchema(client);
    this.db = client;
    // Seed any missing default Atelier docs without clobbering admin edits/deactivations
    await this.seedDocuments(ATELIER_RAG_KNOWLEDGE_DOCS, { overwrite: false });
  }

  public getMode(): AtelierDbMode {
    return this.db?.mode ?? 'pglite';
  }

  public async getDbClient(): Promise<AtelierDbClient> {
    return this.ensureInitialized();
  }

  public async seedDocuments(
    docs: readonly RagKnowledgeDocument[] = ATELIER_RAG_KNOWLEDGE_DOCS,
    options: { overwrite?: boolean } = {},
  ): Promise<number> {
    const db = this.db ?? (await this.ensureInitialized());
    const overwrite = options.overwrite ?? true;

    let docsToProcess = docs;
    if (!overwrite) {
      const existingRes = await db.query<{ doc_key: string }>(
        'SELECT DISTINCT COALESCE(parent_doc_id, id) AS doc_key FROM rag_documents',
      );
      const existingKeys = new Set(existingRes.rows.map((r) => r.doc_key));
      docsToProcess = docs.filter((doc) => !existingKeys.has(doc.id));
    }

    if (docsToProcess.length === 0) {
      return 0;
    }

    const texts = docsToProcess.map(
      (doc) => `${doc.title} ${doc.content} ${doc.domain}`,
    );
    const batchResult = await this.embeddingClient.embedBatch(texts);
    let upserted = 0;

    for (let i = 0; i < docsToProcess.length; i += 1) {
      const doc = docsToProcess[i];
      const category = doc.category?.trim() || doc.domain || 'general';
      const embeddingVec =
        batchResult.embeddings[i] ?? computeDeterministicEmbedding768(texts[i]);
      const vectorLiteral = toPgVectorLiteral(embeddingVec);

      await db.query(
        `INSERT INTO rag_documents (
           id, parent_doc_id, chunk_index, domain, category, title, content,
           source_uri, metadata_jsonb, embedding, version, is_active,
           updated_by, updated_at, embedding_status, embedding_model
         )
         VALUES ($1, $1, 0, $2, $3, $4, $5, $6, $7::jsonb, $8::vector, 1, TRUE, 'system', NOW(), 'EMBEDDED', $9)
         ON CONFLICT (id) DO UPDATE SET
           parent_doc_id = EXCLUDED.parent_doc_id,
           chunk_index = EXCLUDED.chunk_index,
           domain = EXCLUDED.domain,
           category = EXCLUDED.category,
           title = EXCLUDED.title,
           content = EXCLUDED.content,
           source_uri = EXCLUDED.source_uri,
           metadata_jsonb = EXCLUDED.metadata_jsonb,
           embedding = EXCLUDED.embedding,
           embedding_status = 'EMBEDDED',
           embedding_model = EXCLUDED.embedding_model,
           updated_at = NOW()`,
        [
          doc.id,
          doc.domain,
          category,
          doc.title,
          doc.content,
          doc.sourceUri,
          JSON.stringify({
            ...(doc.metadata ?? {}),
            _fullContent: doc.content,
            embedModel: batchResult.model,
            embedDim: batchResult.dimension,
          }),
          vectorLiteral,
          batchResult.model,
        ],
      );
      upserted += 1;
    }

    return upserted;
  }

  public async getDocumentCount(includeInactive = false): Promise<number> {
    const db = await this.ensureInitialized();
    const res = await db.query<{ count: string | number }>(
      includeInactive
        ? 'SELECT COUNT(*)::int AS count FROM rag_documents'
        : 'SELECT COUNT(*)::int AS count FROM rag_documents WHERE is_active = TRUE',
    );
    return Number(res.rows[0]?.count ?? 0);
  }

  public async getCorpusSummary(): Promise<RagCorpusSummary> {
    const db = await this.ensureInitialized();
    const res = await db.query<{
      total_chunks: number | string;
      active_chunks: number | string;
      total_docs: number | string;
      active_docs: number | string;
      latest_model: string | null;
    }>(
      `SELECT
         COUNT(*)::int AS total_chunks,
         COALESCE(SUM(CASE WHEN is_active THEN 1 ELSE 0 END), 0)::int AS active_chunks,
         COUNT(DISTINCT COALESCE(parent_doc_id, id))::int AS total_docs,
         COUNT(DISTINCT CASE WHEN is_active THEN COALESCE(parent_doc_id, id) END)::int AS active_docs,
         MAX(NULLIF(embedding_model, '')) AS latest_model
       FROM rag_documents`,
    );
    const row = res.rows[0];
    return {
      activeDocuments: Number(row?.active_docs ?? 0),
      totalDocuments: Number(row?.total_docs ?? 0),
      activeChunks: Number(row?.active_chunks ?? 0),
      totalChunks: Number(row?.total_chunks ?? 0),
      embeddingModel: row?.latest_model || this.embeddingClient.getModel(),
      embeddingDim: this.embeddingClient.getDimension(),
      hnswIndexActive: this._hnswIndexActive,
      ftsIndexActive: this._ftsIndexActive,
      indexSpec: this.indexSpec,
      dbMode: this.getMode(),
    };
  }

  public async listDocuments(
    filter: ListRagDocumentsFilter = {},
  ): Promise<RagStoredDocument[]> {
    const db = await this.ensureInitialized();
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (!filter.includeInactive) {
      conditions.push('is_active = TRUE');
    }
    if (filter.category && filter.category.trim() && filter.category !== 'all') {
      params.push(filter.category.trim());
      conditions.push(`category = $${params.length}`);
    }
    if (filter.domain && filter.domain.trim() && filter.domain !== 'all') {
      params.push(filter.domain.trim());
      conditions.push(`domain = $${params.length}`);
    }

    const whereClause =
      conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const res = await db.query<RagDocumentRow>(
      `SELECT
         id, parent_doc_id, chunk_index, domain, category, title, content,
         source_uri, version, is_active, embedding_status, embedding_model,
         updated_by, updated_at, metadata_jsonb
       FROM rag_documents
       ${whereClause}
       ORDER BY updated_at DESC, chunk_index ASC`,
      params,
    );

    const grouped = groupRowsIntoDocuments(res.rows, false);
    const searchQuery = filter.q ? foldVietnamese(filter.q) : '';
    if (!searchQuery) {
      return grouped;
    }

    return grouped.filter((doc) => {
      const haystack = foldVietnamese(
        `${doc.id} ${doc.title} ${doc.content} ${doc.category} ${doc.domain} ${doc.sourceUri}`,
      );
      return haystack.includes(searchQuery);
    });
  }

  public async getDocument(id: string): Promise<RagStoredDocument | null> {
    const cleanId = id.trim();
    if (!cleanId) {
      return null;
    }
    const db = await this.ensureInitialized();
    const res = await db.query<RagDocumentRow>(
      `SELECT
         id, parent_doc_id, chunk_index, domain, category, title, content,
         source_uri, version, is_active, embedding_status, embedding_model,
         updated_by, updated_at, metadata_jsonb
       FROM rag_documents
       WHERE parent_doc_id = $1 OR id = $1
       ORDER BY chunk_index ASC`,
      [cleanId],
    );
    if (res.rows.length === 0) {
      return null;
    }
    const docs = groupRowsIntoDocuments(res.rows, true);
    return docs[0] ?? null;
  }

  public async createDocument(
    input: CreateRagDocumentInput,
  ): Promise<RagStoredDocument> {
    const db = await this.ensureInitialized();
    const title = input.title.trim();
    const content = input.content.trim();
    if (!title) {
      throw new Error('Document title is required');
    }
    if (!content) {
      throw new Error('Document content is required');
    }

    const docId =
      input.id?.trim() ||
      `rag_doc_${slugifyDocId(title)}_${randomUUID().slice(0, 6)}`;
    const existing = await this.getDocument(docId);
    if (existing) {
      throw new Error(`RAG document with id "${docId}" already exists`);
    }

    const category =
      input.category?.trim() || input.domain?.trim() || 'general';
    const domain = input.domain?.trim() || category;
    const sourceUri =
      input.sourceUri?.trim() || `atelier://kb/${category}/${docId}`;
    const updatedBy = input.updatedBy?.trim() || 'admin';
    const baseMetadata = stripInternalMetadata(input.metadata ?? {});

    const chunks = chunkRagDocument(title, content, {
      maxChunkChars: input.maxChunkChars,
      overlapChars: input.overlapChars,
    });
    const embedInputs = chunks.map(
      (chunk) => `${title} ${chunk.content} ${domain} ${category}`,
    );
    const batchResult = await this.embeddingClient.embedBatch(embedInputs);

    await db.transaction(async (tx) => {
      for (let i = 0; i < chunks.length; i += 1) {
        const chunk = chunks[i];
        const rowId = buildChunkRowId(docId, chunk.chunkIndex);
        const vec =
          batchResult.embeddings[i] ??
          computeDeterministicEmbedding768(embedInputs[i]);
        const vectorLiteral = toPgVectorLiteral(vec);

        await tx.query(
          `INSERT INTO rag_documents (
             id, parent_doc_id, chunk_index, domain, category, title, content,
             source_uri, metadata_jsonb, embedding, version, is_active,
             updated_by, updated_at, embedding_status, embedding_model
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::vector, 1, TRUE, $11, NOW(), 'EMBEDDED', $12)`,
          [
            rowId,
            docId,
            chunk.chunkIndex,
            domain,
            category,
            title,
            chunk.content,
            sourceUri,
            JSON.stringify({
              ...baseMetadata,
              _fullContent: content,
              embedModel: batchResult.model,
              embedDim: batchResult.dimension,
              totalChunks: chunks.length,
            }),
            vectorLiteral,
            updatedBy,
            batchResult.model,
          ],
        );
      }
    });

    const created = await this.getDocument(docId);
    if (!created) {
      throw new Error(`Failed to reload newly created RAG document "${docId}"`);
    }
    return created;
  }

  public async updateDocument(
    id: string,
    patch: UpdateRagDocumentInput,
  ): Promise<{ before: RagStoredDocument; after: RagStoredDocument } | null> {
    const db = await this.ensureInitialized();
    const before = await this.getDocument(id);
    if (!before) {
      return null;
    }

    const nextTitle = patch.title !== undefined ? patch.title.trim() : before.title;
    const nextContent =
      patch.content !== undefined ? patch.content.trim() : before.content;
    if (!nextTitle) {
      throw new Error('Document title cannot be empty');
    }
    if (!nextContent) {
      throw new Error('Document content cannot be empty');
    }

    const nextCategory =
      patch.category !== undefined && patch.category.trim()
        ? patch.category.trim()
        : before.category;
    const nextDomain =
      patch.domain !== undefined && patch.domain.trim()
        ? patch.domain.trim()
        : patch.category !== undefined && patch.category.trim()
          ? patch.category.trim()
          : before.domain;
    const nextSourceUri =
      patch.sourceUri !== undefined && patch.sourceUri.trim()
        ? patch.sourceUri.trim()
        : before.sourceUri;
    const nextIsActive =
      patch.isActive !== undefined ? Boolean(patch.isActive) : before.isActive;
    const nextUpdatedBy = patch.updatedBy?.trim() || 'admin';
    const nextVersion = before.version + 1;
    const nextMetadata = stripInternalMetadata({
      ...before.metadata,
      ...(patch.metadata ?? {}),
    });

    const chunks = chunkRagDocument(nextTitle, nextContent, {
      maxChunkChars: patch.maxChunkChars,
      overlapChars: patch.overlapChars,
    });
    const embedInputs = chunks.map(
      (chunk) => `${nextTitle} ${chunk.content} ${nextDomain} ${nextCategory}`,
    );
    const batchResult = await this.embeddingClient.embedBatch(embedInputs);

    await db.transaction(async (tx) => {
      await tx.query(
        'DELETE FROM rag_documents WHERE parent_doc_id = $1 OR id = $1',
        [before.id],
      );

      for (let i = 0; i < chunks.length; i += 1) {
        const chunk = chunks[i];
        const rowId = buildChunkRowId(before.id, chunk.chunkIndex);
        const vec =
          batchResult.embeddings[i] ??
          computeDeterministicEmbedding768(embedInputs[i]);
        const vectorLiteral = toPgVectorLiteral(vec);

        await tx.query(
          `INSERT INTO rag_documents (
             id, parent_doc_id, chunk_index, domain, category, title, content,
             source_uri, metadata_jsonb, embedding, version, is_active,
             updated_by, updated_at, embedding_status, embedding_model
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::vector, $11, $12, $13, NOW(), 'EMBEDDED', $14)`,
          [
            rowId,
            before.id,
            chunk.chunkIndex,
            nextDomain,
            nextCategory,
            nextTitle,
            chunk.content,
            nextSourceUri,
            JSON.stringify({
              ...nextMetadata,
              _fullContent: nextContent,
              embedModel: batchResult.model,
              embedDim: batchResult.dimension,
              totalChunks: chunks.length,
            }),
            vectorLiteral,
            nextVersion,
            nextIsActive,
            nextUpdatedBy,
            batchResult.model,
          ],
        );
      }
    });

    const after = await this.getDocument(before.id);
    if (!after) {
      throw new Error(`Failed to reload updated RAG document "${before.id}"`);
    }
    return { before, after };
  }

  public async softDeleteDocument(
    id: string,
    updatedBy = 'admin',
  ): Promise<{
    before: RagStoredDocument;
    after: RagStoredDocument;
    deactivated: true;
  } | null> {
    const db = await this.ensureInitialized();
    const before = await this.getDocument(id);
    if (!before) {
      return null;
    }

    const actor = updatedBy.trim() || 'admin';
    await db.query(
      `UPDATE rag_documents
       SET is_active = FALSE, updated_by = $2, updated_at = NOW()
       WHERE parent_doc_id = $1 OR id = $1`,
      [before.id, actor],
    );

    const after = await this.getDocument(before.id);
    if (!after) {
      throw new Error(`Failed to reload soft-deleted RAG document "${before.id}"`);
    }
    return { before, after, deactivated: true };
  }

  public async reindexDocuments(
    options: RagReindexOptions = {},
  ): Promise<RagReindexResult> {
    const startedAt = Date.now();
    const db = await this.ensureInitialized();
    await this.ensureSchema(db);

    const activeDocs = await this.listDocuments({ includeInactive: false });
    const idFilter =
      Array.isArray(options.documentIds) && options.documentIds.length > 0
        ? new Set(options.documentIds.map((d) => d.trim()).filter(Boolean))
        : null;
    const targetDocs = idFilter
      ? activeDocs.filter((doc) => idFilter.has(doc.id))
      : activeDocs;

    const actor = options.updatedBy?.trim() || 'system-reindex';
    let reindexedChunks = 0;
    let lastEmbeddingModel = this.embeddingClient.getModel();
    let usedFallbackEmbedding = false;

    for (const doc of targetDocs) {
      const chunks = chunkRagDocument(doc.title, doc.content, {
        maxChunkChars: options.maxChunkChars,
        overlapChars: options.overlapChars,
      });
      const embedInputs = chunks.map(
        (chunk) => `${doc.title} ${chunk.content} ${doc.domain} ${doc.category}`,
      );
      const batchResult = await this.embeddingClient.embedBatch(embedInputs);
      lastEmbeddingModel = batchResult.model;
      if (batchResult.usedFallback) {
        usedFallbackEmbedding = true;
      }

      await db.transaction(async (tx) => {
        await tx.query(
          'DELETE FROM rag_documents WHERE parent_doc_id = $1 OR id = $1',
          [doc.id],
        );

        for (let i = 0; i < chunks.length; i += 1) {
          const chunk = chunks[i];
          const rowId = buildChunkRowId(doc.id, chunk.chunkIndex);
          const vec =
            batchResult.embeddings[i] ??
            computeDeterministicEmbedding768(embedInputs[i]);
          const vectorLiteral = toPgVectorLiteral(vec);

          await tx.query(
            `INSERT INTO rag_documents (
               id, parent_doc_id, chunk_index, domain, category, title, content,
               source_uri, metadata_jsonb, embedding, version, is_active,
               updated_by, updated_at, embedding_status, embedding_model
             )
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::vector, $11, TRUE, $12, NOW(), 'EMBEDDED', $13)`,
            [
              rowId,
              doc.id,
              chunk.chunkIndex,
              doc.domain,
              doc.category,
              doc.title,
              chunk.content,
              doc.sourceUri,
              JSON.stringify({
                ...stripInternalMetadata(doc.metadata),
                _fullContent: doc.content,
                embedModel: batchResult.model,
                embedDim: batchResult.dimension,
                totalChunks: chunks.length,
              }),
              vectorLiteral,
              doc.version,
              actor,
              batchResult.model,
            ],
          );
          reindexedChunks += 1;
        }
      });
    }

    return {
      reindexedDocuments: targetDocs.length,
      reindexedChunks,
      embeddingModel: lastEmbeddingModel,
      embeddingDim: EMBEDDING_DIM,
      usedFallbackEmbedding,
      durationMs: Math.max(0, Date.now() - startedAt),
      hnswIndexActive: this._hnswIndexActive,
      indexSpec: this.indexSpec,
      dbMode: this.getMode(),
    };
  }

  public async searchSemantic(
    query: string,
    options: RagSearchOptions = {},
  ): Promise<RagDocumentHit[]> {
    const db = await this.ensureInitialized();
    const topK = options.topK ?? 5;
    const embedded = await this.embeddingClient.embed(query);
    const queryVec = toPgVectorLiteral(embedded.embedding);

    const conditions = ['is_active = TRUE'];
    const params: unknown[] = [queryVec];

    const domainFilter =
      typeof options.filters?.domain === 'string'
        ? options.filters.domain.trim()
        : '';
    if (domainFilter && domainFilter !== 'all') {
      params.push(domainFilter);
      conditions.push(`domain = $${params.length}`);
    }

    const categoryFilter =
      typeof options.filters?.category === 'string'
        ? options.filters.category.trim()
        : '';
    if (categoryFilter && categoryFilter !== 'all') {
      params.push(categoryFilter);
      conditions.push(`category = $${params.length}`);
    }

    params.push(topK);
    const limitParam = `$${params.length}`;

    const res = await db.query<RagDocumentRow>(
      `SELECT
         id,
         parent_doc_id,
         chunk_index,
         domain,
         category,
         title,
         content,
         source_uri,
         version,
         embedding_model,
         metadata_jsonb,
         (1 - (embedding <=> $1::vector))::float8 AS cosine_sim,
         (embedding <-> $1::vector)::float8 AS l2_dist
       FROM rag_documents
       WHERE ${conditions.join(' AND ')}
       ORDER BY embedding <=> $1::vector ASC
       LIMIT ${limitParam}`,
      params,
    );

    return res.rows
      .filter((row) => Number(row.cosine_sim ?? 0) > 0.05)
      .map((row) => ({
        sourceId: row.id,
        title: row.title,
        snippet: row.content,
        score: Number(Math.max(0, Number(row.cosine_sim ?? 0)).toFixed(4)),
        metadata: {
          provider: this._hnswIndexActive ? 'pgvector-hnsw' : 'pgvector',
          hnswIndexActive: this._hnswIndexActive,
          embedModel: row.embedding_model || embedded.model,
          embedDim: embedded.dimension,
          embedFallback: embedded.usedFallback,
          dbName: this.dbName,
          dbMode: db.mode,
          domain: row.domain,
          category: row.category || row.domain || 'general',
          sourceUri: row.source_uri,
          version: Number(row.version ?? 1),
          parentDocId: row.parent_doc_id || row.id,
          chunkIndex: Number(row.chunk_index ?? 0),
          l2Distance: Number(Number(row.l2_dist ?? 0).toFixed(4)),
        },
      }));
  }

  public async searchKeyword(
    query: string,
    options: RagSearchOptions = {},
  ): Promise<RagDocumentHit[]> {
    const db = await this.ensureInitialized();
    const topK = options.topK ?? 5;
    const foldedQuery = foldVietnamese(query);
    if (!foldedQuery) {
      return [];
    }

    const queryTokens = foldedQuery.split(' ').filter((t) => t.length >= 2);
    const queryBigrams: string[] = [];
    for (let i = 0; i + 1 < queryTokens.length; i += 1) {
      queryBigrams.push(`${queryTokens[i]} ${queryTokens[i + 1]}`);
    }

    const conditions = ['is_active = TRUE'];
    const params: unknown[] = [];
    const domainFilter =
      typeof options.filters?.domain === 'string'
        ? options.filters.domain.trim()
        : '';
    if (domainFilter && domainFilter !== 'all') {
      params.push(domainFilter);
      conditions.push(`domain = $${params.length}`);
    }
    const categoryFilter =
      typeof options.filters?.category === 'string'
        ? options.filters.category.trim()
        : '';
    if (categoryFilter && categoryFilter !== 'all') {
      params.push(categoryFilter);
      conditions.push(`category = $${params.length}`);
    }

    const res = await db.query<RagDocumentRow>(
      `SELECT
         id, parent_doc_id, chunk_index, domain, category, title, content,
         source_uri, version, embedding_model, metadata_jsonb
       FROM rag_documents
       WHERE ${conditions.join(' AND ')}`,
      params,
    );

    const scored: RagDocumentHit[] = [];

    for (const row of res.rows) {
      const meta = parseMetadataJson(row.metadata_jsonb);
      const keywords = Array.isArray(meta.keywords)
        ? meta.keywords.map((k) => foldVietnamese(String(k)))
        : [];
      const foldedTitle = foldVietnamese(row.title);
      const foldedContent = foldVietnamese(row.content);
      const haystack = `${foldedTitle} ${foldedContent} ${keywords.join(' ')}`;

      let score = 0;
      for (const kw of keywords) {
        if (kw && foldedQuery.includes(kw)) {
          score += 3.0;
        }
      }
      for (const bg of queryBigrams) {
        if (foldedTitle.includes(bg)) score += 2.4;
        else if (foldedContent.includes(bg)) score += 1.5;
      }
      for (const tok of queryTokens) {
        if (foldedTitle.includes(tok)) score += 1.1;
        else if (haystack.includes(tok)) score += 0.5;
      }

      if (score > 0.45) {
        scored.push({
          sourceId: row.id,
          title: row.title,
          snippet: row.content,
          score: Number(score.toFixed(4)),
          metadata: {
            provider: 'rag-lexical-keyword',
            domain: row.domain,
            category: row.category || row.domain || 'general',
            sourceUri: row.source_uri,
            version: Number(row.version ?? 1),
            parentDocId: row.parent_doc_id || row.id,
            chunkIndex: Number(row.chunk_index ?? 0),
          },
        });
      }
    }

    return scored.sort((a, b) => b.score - a.score).slice(0, topK);
  }

  public asSemanticProvider(): VectorSearchProvider {
    return {
      search: (q, opts) => this.searchSemantic(q, opts),
    };
  }

  public asKeywordProvider(): KeywordSearchProvider {
    return {
      search: (q, opts) => this.searchKeyword(q, opts),
    };
  }

  public createHybridRetriever(
    options: { rrfK?: number; topK?: number; minRrfScore?: number } = {},
  ): HybridRagRetriever {
    return new HybridRagRetriever({
      semanticProvider: this.asSemanticProvider(),
      keywordProvider: this.asKeywordProvider(),
      rrfK: options.rrfK ?? this.rrfK,
      topK: options.topK ?? 5,
      minRrfScore: options.minRrfScore ?? 0.005,
    });
  }

  public async testRetrieval(
    query: string,
    options: RagTestRetrievalOptions = {},
  ): Promise<RagTestRetrievalResult> {
    const startedAt = performance.now();
    await this.ensureInitialized();
    const normalizedQuery = query.trim();
    const limit = Math.max(1, Math.min(20, Math.floor(options.limit ?? 5)));

    const filters: Record<string, string> = {};
    if (options.domain && options.domain.trim() && options.domain !== 'all') {
      filters.domain = options.domain.trim();
    }
    if (
      options.category &&
      options.category.trim() &&
      options.category !== 'all'
    ) {
      filters.category = options.category.trim();
    }

    if (!normalizedQuery) {
      return {
        status: 'NO_GROUNDED_EVIDENCE',
        query: normalizedQuery,
        rrfK: this.rrfK,
        latencyMs: Number((performance.now() - startedAt).toFixed(2)),
        hnswIndexActive: this._hnswIndexActive,
        indexSpec: this.indexSpec,
        embeddingModel: this.embeddingClient.getModel(),
        embeddingDim: this.embeddingClient.getDimension(),
        dbMode: this.getMode(),
        passages: [],
        citations: [],
      };
    }

    const candidateTopK = Math.max(limit * 3, 15);
    const searchOpts: RagSearchOptions = {
      topK: candidateTopK,
      ...(Object.keys(filters).length > 0 ? { filters } : {}),
    };

    const [semanticHits, keywordHits] = await Promise.all([
      this.searchSemantic(normalizedQuery, searchOpts),
      this.searchKeyword(normalizedQuery, searchOpts),
    ]);

    const fused = reciprocalRankFusion(
      semanticHits,
      keywordHits,
      this.rrfK,
    ).slice(0, limit);

    const passages: RagTestRetrievalPassage[] = fused.map((hit) => ({
      id: hit.sourceId,
      sourceId: hit.sourceId,
      parentDocId: String(hit.metadata?.parentDocId ?? hit.sourceId),
      chunkIndex: Number(hit.metadata?.chunkIndex ?? 0),
      title: hit.title,
      content: hit.snippet,
      category: String(
        hit.metadata?.category ?? hit.metadata?.domain ?? 'general',
      ),
      domain: String(hit.metadata?.domain ?? 'general'),
      sourceUri: String(
        hit.metadata?.sourceUri ?? `atelier://kb/${hit.sourceId}`,
      ),
      version: Number(hit.metadata?.version ?? 1),
      rrfScore: hit.score,
      vectorScore: Number(hit.vectorScore ?? 0),
      keywordScore: Number(hit.keywordScore ?? 0),
      vectorRank: hit.semanticRank,
      keywordRank: hit.keywordRank,
    }));

    const citations: RagCitation[] = passages.map((p) => ({
      sourceId: p.sourceId,
      title: p.title,
      snippet: p.content,
      score: p.rrfScore,
    }));

    return {
      status: passages.length > 0 ? 'GROUNDED' : 'NO_GROUNDED_EVIDENCE',
      query: normalizedQuery,
      rrfK: this.rrfK,
      latencyMs: Number((performance.now() - startedAt).toFixed(2)),
      hnswIndexActive: this._hnswIndexActive,
      indexSpec: this.indexSpec,
      embeddingModel: this.embeddingClient.getModel(),
      embeddingDim: this.embeddingClient.getDimension(),
      dbMode: this.getMode(),
      passages,
      citations,
    };
  }

  public async queryHybrid(
    query: string,
    options: RagSearchOptions = {},
  ): Promise<HybridRagQueryOutput> {
    await this.ensureInitialized();
    const retriever = this.createHybridRetriever({
      topK: options.topK ?? 5,
    });
    const result: HybridRagResult = await retriever.retrieve(query, options);

    if (result.status === 'NO_GROUNDED_EVIDENCE') {
      return {
        status: 'NO_GROUNDED_EVIDENCE',
        query: result.query,
        answer: 'NO_GROUNDED_EVIDENCE',
        passages: [],
        citations: [],
        rrfK: result.rrfK,
        dbMode: this.getMode(),
      };
    }

    const topPassages = result.fusedHits.slice(0, 3).map((hit) => ({
      sourceId: hit.sourceId,
      title: hit.title,
      content: hit.snippet,
      domain: String(hit.metadata?.domain ?? 'atelier_kb'),
      category: String(
        hit.metadata?.category ?? hit.metadata?.domain ?? 'general',
      ),
      sourceUri: String(
        hit.metadata?.sourceUri ?? `atelier://kb/${hit.sourceId}`,
      ),
      score: hit.score,
    }));

    const answer = topPassages
      .map((p) => `[${p.title}] ${p.content}`)
      .join('\n\n');

    return {
      status: 'GROUNDED',
      query: result.query,
      answer,
      passages: topPassages,
      citations: result.citations,
      rrfK: result.rrfK,
      dbMode: this.getMode(),
    };
  }

  public async close(): Promise<void> {
    if (this.db) {
      const current = this.db;
      this.db = null;
      this.initPromise = null;
      await current.close();
    }
  }
}
