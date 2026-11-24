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

export interface RagKnowledgeDocument {
  id: string;
  domain: string;
  title: string;
  content: string;
  sourceUri: string;
  metadata: Record<string, unknown>;
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
    sourceUri: string;
    score: number;
  }>;
  citations: RagCitation[];
  rrfK: number;
  dbMode: AtelierDbMode;
}

interface RagDocumentRow {
  id: string;
  domain: string;
  title: string;
  content: string;
  source_uri: string;
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
    title: 'Chính sách Đổi Size RMA 2 chiều miễn phí trong 7–14 ngày',
    content:
      'Fashion Atelier hỗ trợ khách hàng đổi size RMA 2 chiều hoàn toàn miễn phí trong vòng 7–14 ngày kể từ ngày nhận hàng (7 ngày đối với đơn giao tiêu chuẩn và tối đa 14 ngày cho hội viên Silver trở lên hoặc đơn đổi kích cỡ). Điều kiện áp dụng: sản phẩm còn nguyên tem mác Atelier, chưa qua giặt là và không có mùi hương lạ. Khi gửi yêu cầu đổi size, bưu tá sẽ giao size mới đồng thời thu hồi size cũ tại cửa; trường hợp trả hàng hoàn tiền được xử lý trong 3–5 ngày làm việc sau khi bộ phận QC kho xác nhận đạt chuẩn.',
    sourceUri: 'atelier://policies/rma-size-exchange-v1',
    metadata: {
      keywords: ['doi size', 'rma', '7-14 ngay', 'hoan tra', 'hoan tien', '2 chieu', 'mien phi'],
      version: 'v1.0.0',
    },
  },
  {
    id: 'rag_doc_02_tryon_privacy_15min',
    domain: 'privacy_tryon',
    title: 'Cam kết quyền riêng tư Phòng Thử Đồ AI — Tự động xóa cứng sau 15 phút',
    content:
      'Mọi ảnh cá nhân và ảnh kết quả từ Phòng Thử Đồ AI (Camera căn dáng & Tải ảnh tĩnh) được lưu trữ độc lập trong kho kín atelier-private-tryon (chặn hoàn toàn truy cập công khai HTTP 403, chỉ truy xuất qua Presigned URL ngắn hạn). Hệ thống áp dụng cơ chế vòng đời dữ liệu tự động xóa cứng vĩnh viễn sau đúng 15 phút kể từ khi hoàn tất phiên thử đồ (tryon.media.purged), không lưu bản sao và tuyệt đối không sử dụng ảnh khách hàng để huấn luyện mô hình AI.',
    sourceUri: 'atelier://policies/tryon-privacy-15m-v1',
    metadata: {
      keywords: ['15 phut', 'xoa cung', 'vinh vien', 'rieng tu', 'thu do ai', 'private-tryon', 'anh thu do'],
      version: 'v1.0.0',
    },
  },
  {
    id: 'rag_doc_03_size_chart_tops_blazers',
    domain: 'sizing',
    title: 'Quy chuẩn bảng size Áo Sơ Mi, Áo Kiểu & Blazer Atelier (XS–XL)',
    content:
      'Bảng size Áo & Blazer chuẩn phom Việt: XS (150–158cm, 40–46kg, ngực 80cm, eo 62cm, vai 36cm), S (155–163cm, 46–52kg, ngực 84cm, eo 66cm, vai 37.5cm), M (160–168cm, 52–58kg, ngực 88cm, eo 70cm, vai 39cm), L (163–172cm, 58–65kg, ngực 93cm, eo 75cm, vai 40.5cm), XL (166–176cm, 65–74kg, ngực 98cm, eo 80cm, vai 42cm). Với dòng Blazer dựng vai thủ công dáng suông, chọn đúng cỡ theo rộng vai để ve áo đứng phom thanh lịch.',
    sourceUri: 'atelier://sizing/tops-blazers-v1',
    metadata: {
      keywords: ['bang size', 'ao blazer', 'ao so mi', 'nguc', 'eo', 'vai', 'xs', 's', 'm', 'l', 'xl'],
      version: 'v1.0.0',
    },
  },
  {
    id: 'rag_doc_04_size_chart_bottoms_skirts',
    domain: 'sizing',
    title: 'Quy chuẩn bảng size Quần Tây Ống Suông & Chân Váy Midi (XS–XL)',
    content:
      'Bảng size Quần & Chân Váy cạp cao đo tại vòng eo trên rốn 2cm và vòng hông đầy nhất: XS (eo 61cm, hông 85cm), S (eo 65cm, hông 89cm), M (eo 69cm, hông 93cm), L (eo 74cm, hông 98cm), XL (eo 79cm, hông 103cm). Nếu số đo eo và hông rơi vào hai cỡ liền kề, ưu tiên chọn theo vòng hông với quần ống suông xếp ly và chọn theo vòng eo với chân váy xếp ly xòe.',
    sourceUri: 'atelier://sizing/bottoms-skirts-v1',
    metadata: {
      keywords: ['quan tay', 'chan vay', 'culottes', 'vong eo', 'vong hong', 'bang size quan'],
      version: 'v1.0.0',
    },
  },
  {
    id: 'rag_doc_05_size_chart_dresses',
    domain: 'sizing',
    title: 'Quy chuẩn bảng size Đầm Dự Tiệc & Đầm Midi Chiết Eo (XS–XL)',
    content:
      'Đầm Dự Tiệc Lụa Satin và Đầm Midi Cổ Vuông Atelier sử dụng hệ rập 3D chuẩn số đo Việt: XS (ngực 80cm, eo 62cm, hông 86cm), S (ngực 84cm, eo 66cm, hông 90cm), M (ngực 88cm, eo 70cm, hông 94cm), L (ngực 93cm, eo 75cm, hông 99cm), XL (ngực 98cm, eo 80cm, hông 104cm). Dòng đầm chiết eo lụa không co giãn nên ưu tiên khoảng thở 1.5–2cm tại vòng eo.',
    sourceUri: 'atelier://sizing/dresses-v1',
    metadata: {
      keywords: ['dam du tiec', 'dam midi', 'chiet eo', 'vay di tiec', 'bang size dam'],
      version: 'v1.0.0',
    },
  },
  {
    id: 'rag_doc_06_stretch_calibration',
    domain: 'sizing',
    title: 'Hiệu chỉnh tư vấn size theo độ co giãn vải (NONE / LIGHT / HIGH)',
    content:
      'Hệ thống tư vấn size trung thực hiệu chỉnh theo độ co giãn thực tế của chất liệu: vải NONE (Lụa tơ tằm 19 momme, Linen hữu cơ, Organza, Tweed) không co giãn nên khuyến nghị tăng 1 size khi số đo nằm gần ngưỡng trên; vải LIGHT (Gabardine, Wool pha Spandex) giữ đúng cỡ chuẩn; vải HIGH (Len Merino, Dệt kim Bông Ai Cập) đàn hồi tốt, phù hợp chọn đúng size hoặc ưu tiên SLIM nếu thích ôm dáng.',
    sourceUri: 'atelier://sizing/stretch-calibration-v1',
    metadata: {
      keywords: ['co gian', 'none', 'light', 'high', 'hieu chinh', 'tu van size', 'fit preference'],
      version: 'v1.0.0',
    },
  },
  {
    id: 'rag_doc_07_care_silk_organza',
    domain: 'fabric_care',
    title: 'Hướng dẫn bảo quản Lụa Tơ Tằm Bảo Lộc & Lụa Organza',
    content:
      'Lụa Tơ Tằm 19 momme, Lụa Satin và Organza cần giặt tay nhẹ nhàng bằng nước mát dưới 30°C với dung dịch giặt có độ pH trung tính (không dùng chất tẩy mạnh hoặc nước xả làm mềm sợi). Không vắt xoắn mạnh; thấm ráo bằng khăn bông trắng rồi phơi trong bóng râm thoáng gió, tránh nắng gắt trực tiếp. Là hơi nước ở nhiệt độ thấp trên mặt trái vải.',
    sourceUri: 'atelier://care/silk-organza-v1',
    metadata: {
      keywords: ['bao quan', 'lua to tam', 'satin', 'organza', 'giat tay', 'la hoi'],
      version: 'v1.0.0',
    },
  },
  {
    id: 'rag_doc_08_care_linen_gabardine',
    domain: 'fabric_care',
    title: 'Hướng dẫn bảo quản Linen Hữu Cơ & Vải Gabardine',
    content:
      'Trang phục Linen Hữu Cơ (Blazer Linen, Quần Culottes) và Gabardine (Áo Khoác Trench) nên giặt chế độ nhẹ (delicate) trong túi giặt với nước lạnh. Sau khi giặt, giũ phẳng và treo trên móc gỗ bản rộng khi vải còn hơi ẩm để hạn chế nếp nhăn sâu và giữ đường ly chuẩn. Là hơi ở mức nhiệt trung bình (150–180°C).',
    sourceUri: 'atelier://care/linen-gabardine-v1',
    metadata: {
      keywords: ['bao quan', 'linen', 'huu co', 'gabardine', 'trench', 'moc go'],
      version: 'v1.0.0',
    },
  },
  {
    id: 'rag_doc_09_care_merino_tweed_denim',
    domain: 'fabric_care',
    title: 'Hướng dẫn bảo quản Len Merino, Tweed Dệt Thủ Công & Denim Cao Cấp',
    content:
      'Áo Khoác Tweed Dệt Thủ Công và Blazer dựng cầu vai bắt buộc giặt khô (dry clean) tại xưởng uy tín để bảo vệ cấu trúc dựng canh và sợi dệt nổi. Áo Cardigan Len Merino giặt tay nước lạnh, ép ráo nước bằng khăn và phơi ngang trên mặt phẳng để không bị giãn vai. Trang phục Denim cao cấp nên lộn trái trước khi giặt nước lạnh và hạn chế sấy nhiệt cao.',
    sourceUri: 'atelier://care/merino-tweed-denim-v1',
    metadata: {
      keywords: ['bao quan', 'len merino', 'tweed', 'denim', 'giat kho', 'phoi ngang'],
      version: 'v1.0.0',
    },
  },
  {
    id: 'rag_doc_10_dual_media_sop',
    domain: 'operations_sop',
    title: 'SOP kiểm định ảnh kép 2:3 Alpha (Giá treo 3D) & 3:4 Flat-lay (Thử đồ AI)',
    content:
      'Media Pipeline kiểm định tệp ảnh theo 3 tầng: xác thực Magic Bytes (loại bỏ tệp giả mạo định dạng), kiểm định ảnh Giá Treo 3D chuẩn tỷ lệ 2:3 (720×1080 WebP) bắt buộc có kênh trong suốt Alpha và tọa độ neo móc (hangerAnchorX, hangerAnchorY), và chuẩn hóa ảnh Thử Đồ AI tỷ lệ 3:4 (768×1024 WebP) nền sạch vào bucket atelier-garments. Mọi ảnh qua AI xử lý đều giữ trạng thái NHAP_AI và autoAttachAsTryOnGarment = false chờ duyệt.',
    sourceUri: 'atelier://sop/dual-media-pipeline-v1',
    metadata: {
      keywords: ['sop', '2:3', '3:4', 'alpha', 'flat-lay', 'magic bytes', '720x1080', '768x1024', 'nhap_ai'],
      version: 'v1.0.0',
    },
  },
  {
    id: 'rag_doc_11_supplier_nhap_ai_sop',
    domain: 'operations_sop',
    title: 'Quy trình duyệt mẫu Đối tác (Partner Portal) & Đơn nhập hàng NHAP_AI',
    content:
      'Đối tác Nhà cung cấp (SUPPLIER) đăng nhập Partner Portal bắt buộc xác thực 2FA và bị cô lập chặt theo supplier_id từ JWT. Mẫu mới gửi lên ở trạng thái PENDING_REVIEW để bộ phận Danh mục/Quản trị thẩm định giá vốn (costPriceVnd bị che giấu với nhân sự không có quyền tài chính/thu mua) và thông số rập. Mọi đề xuất đơn nhập hàng do AI Copilot khởi tạo luôn bị khóa ở trạng thái NHAP_AI, bắt buộc quản lý kho phê duyệt thủ công.',
    sourceUri: 'atelier://sop/supplier-nhap-ai-v1',
    metadata: {
      keywords: ['nha cung cap', 'partner', 'supplier_id', 'duyet mau', 'nhap_ai', 'costpricevnd', '2fa'],
      version: 'v1.0.0',
    },
  },
  {
    id: 'rag_doc_12_combo_payment_delivery',
    domain: 'storefront_service',
    title: 'Ưu đãi Phối đồ Combo Set, Thanh toán VietQR & Giao hàng Hỏa tốc',
    content:
      'Khi phối đồ tại Mix & Match Outfit Studio, khách hàng nhận ưu đãi Combo Set giảm 5% từ 2 sản phẩm và giảm 10% từ 3 sản phẩm trở lên. Thanh toán qua VietQR tự động đối soát với thời gian giữ tồn kho 15 phút chống bán quá tồn. Atelier cung cấp 3 hình thức đóng gói (Túi vải Linen mộc miễn phí, Hộp lụa cổ điển và Hộp quà khắc tên ánh kim) cùng giao hỏa tốc nội thành 2 giờ.',
    sourceUri: 'atelier://service/combo-vietqr-delivery-v1',
    metadata: {
      keywords: ['combo', 'phoi do', 'vietqr', '15 phut', 'giao hoa toc', 'hop qua', 'dong goi'],
      version: 'v1.0.0',
    },
  },
];

const RAG_SCHEMA_SQL = `
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS rag_documents (
  id TEXT PRIMARY KEY,
  domain TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  source_uri TEXT NOT NULL,
  metadata_jsonb JSONB NOT NULL DEFAULT '{}'::jsonb,
  embedding vector(${EMBEDDING_DIM}) NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;

export async function seedRagKnowledgeBase(
  store: PgVectorRagStore,
  docs: readonly RagKnowledgeDocument[] = ATELIER_RAG_KNOWLEDGE_DOCS,
): Promise<number> {
  return store.seedDocuments(docs);
}

export class PgVectorRagStore {
  private readonly databaseUrl: string;
  private readonly dbName: string;
  private readonly dataDirRoot?: string;
  private readonly connectTimeoutMs?: number;
  private readonly forcePglite?: boolean;
  private readonly rrfK: number;
  private readonly embeddingClient: OllamaEmbeddingClient;

  private db: AtelierDbClient | null = null;
  private initPromise: Promise<void> | null = null;

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

  private async initializeInternal(): Promise<void> {
    const client = await createIsolatedPgClient({
      databaseUrl: this.databaseUrl,
      dbName: this.dbName,
      enableVector: true,
      dataDirRoot: this.dataDirRoot,
      connectTimeoutMs: this.connectTimeoutMs,
      forcePglite: this.forcePglite,
    });
    await client.exec('CREATE EXTENSION IF NOT EXISTS vector');
    await this.migrateLegacyVectorDimensionIfNeeded(client);
    await client.exec(RAG_SCHEMA_SQL);
    this.db = client;
    await this.seedDocuments(ATELIER_RAG_KNOWLEDGE_DOCS);
  }

  public getMode(): AtelierDbMode {
    return this.db?.mode ?? 'pglite';
  }

  public async seedDocuments(
    docs: readonly RagKnowledgeDocument[] = ATELIER_RAG_KNOWLEDGE_DOCS,
  ): Promise<number> {
    const db = this.db ?? (await this.ensureInitialized());
    const texts = docs.map((doc) => `${doc.title} ${doc.content} ${doc.domain}`);
    const batchResult = await this.embeddingClient.embedBatch(texts);
    let upserted = 0;

    for (let i = 0; i < docs.length; i += 1) {
      const doc = docs[i];
      const embeddingVec =
        batchResult.embeddings[i] ?? computeDeterministicEmbedding768(texts[i]);
      const vectorLiteral = toPgVectorLiteral(embeddingVec);

      await db.query(
        `INSERT INTO rag_documents (id, domain, title, content, source_uri, metadata_jsonb, embedding, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::vector, NOW())
         ON CONFLICT (id) DO UPDATE SET
           domain = EXCLUDED.domain,
           title = EXCLUDED.title,
           content = EXCLUDED.content,
           source_uri = EXCLUDED.source_uri,
           metadata_jsonb = EXCLUDED.metadata_jsonb,
           embedding = EXCLUDED.embedding,
           updated_at = NOW()`,
        [
          doc.id,
          doc.domain,
          doc.title,
          doc.content,
          doc.sourceUri,
          JSON.stringify({
            ...(doc.metadata ?? {}),
            embedModel: batchResult.model,
            embedDim: batchResult.dimension,
          }),
          vectorLiteral,
        ],
      );
      upserted += 1;
    }

    return upserted;
  }

  public async getDocumentCount(): Promise<number> {
    const db = await this.ensureInitialized();
    const res = await db.query<{ count: string | number }>(
      'SELECT COUNT(*)::int AS count FROM rag_documents',
    );
    return Number(res.rows[0]?.count ?? 0);
  }

  public async searchSemantic(
    query: string,
    options: RagSearchOptions = {},
  ): Promise<RagDocumentHit[]> {
    const db = await this.ensureInitialized();
    const topK = options.topK ?? 5;
    const embedded = await this.embeddingClient.embed(query);
    const queryVec = toPgVectorLiteral(embedded.embedding);

    const res = await db.query<RagDocumentRow>(
      `SELECT
         id,
         domain,
         title,
         content,
         source_uri,
         metadata_jsonb,
         (1 - (embedding <=> $1::vector))::float8 AS cosine_sim,
         (embedding <-> $1::vector)::float8 AS l2_dist
       FROM rag_documents
       ORDER BY embedding <=> $1::vector ASC
       LIMIT $2`,
      [queryVec, topK],
    );

    return res.rows
      .filter((row) => Number(row.cosine_sim ?? 0) > 0.05)
      .map((row) => ({
        sourceId: row.id,
        title: row.title,
        snippet: row.content,
        score: Number(Math.max(0, Number(row.cosine_sim ?? 0)).toFixed(4)),
        metadata: {
          provider: 'pgvector',
          embedModel: embedded.model,
          embedDim: embedded.dimension,
          embedFallback: embedded.usedFallback,
          dbName: this.dbName,
          dbMode: db.mode,
          domain: row.domain,
          sourceUri: row.source_uri,
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

    const res = await db.query<RagDocumentRow>(
      'SELECT id, domain, title, content, source_uri, metadata_jsonb FROM rag_documents',
    );

    const scored: RagDocumentHit[] = [];

    for (const row of res.rows) {
      const meta =
        typeof row.metadata_jsonb === 'string'
          ? (JSON.parse(row.metadata_jsonb) as Record<string, unknown>)
          : (row.metadata_jsonb ?? {});
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
        if (foldedTitle.includes(bg)) score += 2.2;
        else if (foldedContent.includes(bg)) score += 1.4;
      }
      for (const tok of queryTokens) {
        if (foldedTitle.includes(tok)) score += 0.9;
        else if (haystack.includes(tok)) score += 0.45;
      }

      if (score > 0.5) {
        scored.push({
          sourceId: row.id,
          title: row.title,
          snippet: row.content,
          score: Number(score.toFixed(4)),
          metadata: {
            provider: 'rag-lexical-keyword',
            domain: row.domain,
            sourceUri: row.source_uri,
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
      sourceUri: String(hit.metadata?.sourceUri ?? `atelier://kb/${hit.sourceId}`),
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
