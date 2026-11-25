import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OllamaEmbeddingClient } from '../layer1-models';
import {
  DEFAULT_RRF_K,
  PgVectorRagStore,
  RAG_FTS_INDEX_SQL,
  RAG_HNSW_INDEX_SPEC,
  RAG_HNSW_INDEX_SQL,
  RAG_VERSIONING_ALTER_SQL,
  chunkRagDocument,
} from './index';

describe('Layer 3 RAG — Context-Overlapping Chunking, HNSW DDL & Dynamic Versioning CRUD', () => {
  const tempDirs: string[] = [];
  const openStores: PgVectorRagStore[] = [];

  afterEach(async () => {
    while (openStores.length > 0) {
      const store = openStores.pop();
      if (store) {
        await store.close();
      }
    }
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  function createIsolatedTestStore(): PgVectorRagStore {
    const dir = mkdtempSync(join(tmpdir(), 'atelier-rag-hnsw-spec-'));
    tempDirs.push(dir);
    const store = new PgVectorRagStore({
      dbName: 'rag_hnsw_unit_test',
      dataDirRoot: dir,
      forcePglite: true,
      embeddingClient: new OllamaEmbeddingClient({ offlineMode: true, dimension: 768 }),
    });
    openStores.push(store);
    return store;
  }

  it('keeps short Vietnamese documents as single chunk 0 and chunks long documents with title prefix and overlap', () => {
    const shortChunks = chunkRagDocument(
      'Chính sách Đổi Size',
      'Khách hàng được đổi size miễn phí trong vòng 7–14 ngày kể từ ngày nhận hàng.',
    );
    expect(shortChunks).toHaveLength(1);
    expect(shortChunks[0]?.chunkIndex).toBe(0);
    expect(shortChunks[0]?.chunk_index).toBe(0);
    expect(shortChunks[0]?.totalChunks).toBe(1);

    const longVietnameseDoc = [
      'Bộ sưu tập Tầm Xuân Fashion Atelier 2026 sử dụng lụa tơ tằm Bảo Lộc 19 momme dệt thủ công kết hợp đường cắt may chuẩn phom dáng Việt Nam. Mỗi sản phẩm đều trải qua ba vòng kiểm định đường kim mũi chỉ nghiêm ngặt trước khi đóng gói vào hộp lụa cổ điển.',
      'Hướng dẫn bảo quản áo len cashmere và lụa tơ tằm yêu cầu giặt tay nhẹ nhàng bằng nước mát dưới 28 độ C cùng dung dịch giặt độ pH trung tính. Tuyệt đối không sử dụng chất tẩy clo, không vắt xoắn mạnh tay và luôn thấm khô bằng khăn bông trắng trước khi phơi ngang trong bóng râm.',
      'Chính sách bảo hành cúc ngọc trai và chỉnh sửa gấu áo miễn phí trọn đời áp dụng cho toàn bộ đơn hàng có mã xác thực Atelier Authenticity Tag tại hệ thống showroom Hà Nội và Thành phố Hồ Chí Minh. Khách hàng chỉ cần xuất trình mã đơn hàng để nghệ nhân rập trực tiếp đo chỉnh trong vòng 48 giờ làm việc.',
      'Đối với các đơn hàng đặt may đo cá nhân hóa hoặc đổi size RMA hai chiều, bưu tá chuyên trách sẽ giao sản phẩm mới đồng thời thu hồi sản phẩm cần đổi tận cửa mà không phát sinh phụ phí vận chuyển nội thành.',
    ].join('\n\n');

    const chunks = chunkRagDocument('Cẩm nang Chăm sóc & Bảo hành Atelier 2026', longVietnameseDoc, {
      maxChunkChars: 340,
      overlapChars: 80,
    });

    expect(chunks.length).toBeGreaterThanOrEqual(3);
    expect(chunks[0]?.chunk_index).toBe(0);
    expect(chunks[0]?.totalChunks).toBe(chunks.length);

    for (let i = 1; i < chunks.length; i += 1) {
      const prev = chunks[i - 1];
      const curr = chunks[i];
      expect(curr.chunk_index).toBe(i);
      expect(curr.chunkIndex).toBe(i);
      expect(curr.content.startsWith('[Cẩm nang Chăm sóc & Bảo hành Atelier 2026] ')).toBe(true);
      // Verify meaningful overlap between consecutive chunks
      const prevWords = prev.content
        .replace(/^\[[^\]]+\]\s*/, '')
        .split(/\s+/)
        .slice(-6)
        .filter((w) => w.length >= 3);
      const overlapFound = prevWords.some((word) => curr.content.includes(word));
      expect(overlapFound).toBe(true);
    }
  });

  it('ships valid idempotent HNSW (m=16, ef_construction=64) & FTS GIN migration DDL', () => {
    expect(RAG_HNSW_INDEX_SPEC).toEqual({
      type: 'hnsw',
      opClass: 'vector_cosine_ops',
      m: 16,
      efConstruction: 64,
    });
    expect(RAG_HNSW_INDEX_SQL).toContain('USING hnsw (embedding vector_cosine_ops)');
    expect(RAG_HNSW_INDEX_SQL).toContain('WITH (m = 16, ef_construction = 64)');
    expect(RAG_FTS_INDEX_SQL).toContain("USING gin (to_tsvector('simple'");
    expect(RAG_VERSIONING_ALTER_SQL).toContain('ADD COLUMN IF NOT EXISTS version INTEGER');
    expect(RAG_VERSIONING_ALTER_SQL).toContain('ADD COLUMN IF NOT EXISTS is_active BOOLEAN');
    expect(RAG_VERSIONING_ALTER_SQL).toContain('ADD COLUMN IF NOT EXISTS parent_doc_id TEXT');

    const migrationPath = resolve(
      __dirname,
      '../../../../infra/sql/migrations/002_rag_hnsw_versioning.sql',
    );
    const migrationSql = readFileSync(migrationPath, 'utf8');
    expect(migrationSql).toContain('idx_rag_documents_embedding_hnsw');
    expect(migrationSql).toContain('USING hnsw (embedding vector_cosine_ops)');
    expect(migrationSql).toContain('WITH (m = 16, ef_construction = 64)');
    expect(migrationSql).toContain('idx_rag_documents_fts_simple');
    expect(migrationSql).toContain('embedding_status');
    expect(migrationSql).toContain('embedding_model');
  });

  it('supports CRUD versioning, multi-chunk persistence, soft-delete filtering, reindex, and RRF k=60 testRetrieval on PGlite', async () => {
    const store = createIsolatedTestStore();
    await store.ensureInitialized();

    expect(store.indexSpec).toEqual(RAG_HNSW_INDEX_SPEC);
    expect(typeof store.hnswIndexActive).toBe('boolean');

    // Initial seeded corpus should be active
    const seededList = await store.listDocuments();
    expect(seededList.length).toBeGreaterThanOrEqual(12);

    // 1. Create a new multi-chunk policy document
    const created = await store.createDocument({
      id: 'rag_doc_cashmere_vip_2026',
      title: 'Chính sách Bảo hành Cúc Ngọc Trai & Giặt Hấp Cashmere VIP 2026',
      category: 'fabric_care',
      domain: 'fabric_care',
      sourceUri: 'atelier://policies/cashmere-vip-2026',
      updatedBy: 'superadmin@atelier.vn',
      maxChunkChars: 240,
      overlapChars: 60,
      content: [
        'Hội viên VIP Platinum của Tầm Xuân Atelier được miễn phí dịch vụ giặt hấp Cashmere bằng hơi nước lạnh 2 lần mỗi mùa đông tại xưởng chăm sóc độc quyền.',
        'Mọi áo khoác Tweed và áo sơ mi lụa gắn cúc ngọc trai Akoya đều được bảo hành thay cúc miễn phí trọn đời trong vòng 24 giờ kể từ khi tiếp nhận tại boutique.',
        'Vui lòng bảo quản áo len Cashmere trong túi vải cotton thoáng khí kèm gỗ tuyết tùng tự nhiên và không treo móc sắt để tránh bai dão cầu vai.',
      ].join('\n\n'),
    });

    expect(created.id).toBe('rag_doc_cashmere_vip_2026');
    expect(created.version).toBe(1);
    expect(created.isActive).toBe(true);
    expect(created.chunkCount).toBeGreaterThanOrEqual(2);
    expect(created.updatedBy).toBe('superadmin@atelier.vn');

    // 2. Newly created document is immediately searchable via testRetrieval (RRF k=60) & queryHybrid
    const retrievalBeforeUpdate = await store.testRetrieval(
      'Chính sách bảo hành cúc ngọc trai Akoya và giặt hấp Cashmere VIP',
      { category: 'fabric_care', limit: 5 },
    );
    expect(retrievalBeforeUpdate.status).toBe('GROUNDED');
    expect(retrievalBeforeUpdate.rrfK).toBe(DEFAULT_RRF_K);
    expect(retrievalBeforeUpdate.passages.length).toBeGreaterThan(0);
    expect(
      retrievalBeforeUpdate.passages.some(
        (p) => p.parentDocId === 'rag_doc_cashmere_vip_2026',
      ),
    ).toBe(true);
    expect(retrievalBeforeUpdate.passages[0]?.rrfScore).toBeGreaterThan(0);

    // 3. Update document -> version increments to 2 & new fact is immediately retrieved
    const updated = await store.updateDocument('rag_doc_cashmere_vip_2026', {
      title: 'Chính sách Bảo hành Cúc Ngọc Trai & Giặt Hấp Cashmere VIP v2',
      content:
        'Hội viên VIP Platinum được miễn phí giặt hấp Cashmere 4 lần mỗi mùa đông và bảo hành cúc ngọc trai Akoya siêu tốc trong 12 giờ tại boutique Hà Nội.',
      updatedBy: 'catalog_ai@atelier.vn',
    });
    expect(updated).not.toBeNull();
    expect(updated?.before.version).toBe(1);
    expect(updated?.after.version).toBe(2);
    expect(updated?.after.chunkCount).toBe(1);

    const hybridAfterUpdate = await store.queryHybrid(
      'giặt hấp Cashmere 4 lần mùa đông cúc ngọc trai 12 giờ',
    );
    expect(hybridAfterUpdate.status).toBe('GROUNDED');
    expect(hybridAfterUpdate.answer).toContain('4 lần mỗi mùa đông');

    // 4. Reindex active corpus
    const reindexed = await store.reindexDocuments({
      documentIds: ['rag_doc_cashmere_vip_2026'],
      updatedBy: 'superadmin@atelier.vn',
    });
    expect(reindexed.reindexedDocuments).toBe(1);
    expect(reindexed.reindexedChunks).toBe(1);
    expect(reindexed.embeddingDim).toBe(768);
    expect(reindexed.indexSpec).toEqual(RAG_HNSW_INDEX_SPEC);

    // 5. Soft delete -> excluded from active listing, queryHybrid, and testRetrieval
    const deleted = await store.softDeleteDocument(
      'rag_doc_cashmere_vip_2026',
      'superadmin@atelier.vn',
    );
    expect(deleted).not.toBeNull();
    expect(deleted?.deactivated).toBe(true);
    expect(deleted?.before.isActive).toBe(true);
    expect(deleted?.after.isActive).toBe(false);

    const activeList = await store.listDocuments({ includeInactive: false });
    expect(activeList.some((d) => d.id === 'rag_doc_cashmere_vip_2026')).toBe(false);

    const allList = await store.listDocuments({ includeInactive: true });
    expect(allList.some((d) => d.id === 'rag_doc_cashmere_vip_2026')).toBe(true);

    const retrievalAfterDelete = await store.testRetrieval(
      'cúc ngọc trai Akoya siêu tốc 12 giờ',
      { limit: 5 },
    );
    expect(
      retrievalAfterDelete.passages.some(
        (p) => p.parentDocId === 'rag_doc_cashmere_vip_2026',
      ),
    ).toBe(false);

    const hybridAfterDelete = await store.queryHybrid(
      'cúc ngọc trai Akoya siêu tốc 12 giờ',
    );
    expect(
      hybridAfterDelete.passages.some(
        (p) => p.sourceId.startsWith('rag_doc_cashmere_vip_2026'),
      ),
    ).toBe(false);
  });
});
