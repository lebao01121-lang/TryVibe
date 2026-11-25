'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import { Role } from '@atelier/contracts';
import { adminFetch, buildQueryString } from '@/lib/api-client';
import { emitPortalToast } from '../PortalToastBanner';

export interface RagTabNotifyPayload {
  kind: 'success' | 'error' | 'info';
  title?: string;
  message: string;
}

export interface RagKnowledgeBaseTabProps {
  roles: readonly Role[];
  mfaVerified?: boolean;
  darkMode?: boolean;
  onNotify?: (payload: RagTabNotifyPayload) => void;
  onRefreshOverview?: () => void;
}

type RagCategoryKey =
  | 'all'
  | 'policy_rma'
  | 'operations_sop'
  | 'fabric_care'
  | 'sizing'
  | 'privacy_tryon'
  | 'general';

interface RagCategoryOption {
  key: Exclude<RagCategoryKey, 'all'>;
  label: string;
  defaultDomain: string;
  uriPrefix: string;
}

const RAG_CATEGORIES: readonly RagCategoryOption[] = [
  {
    key: 'policy_rma',
    label: 'Chính sách Đổi/Trả',
    defaultDomain: 'policy_rma',
    uriPrefix: 'atelier://policies/',
  },
  {
    key: 'operations_sop',
    label: 'SOP Kho vận',
    defaultDomain: 'operations_sop',
    uriPrefix: 'atelier://sop/',
  },
  {
    key: 'fabric_care',
    label: 'Bảo quản Vải',
    defaultDomain: 'fabric_care',
    uriPrefix: 'atelier://care/',
  },
  {
    key: 'sizing',
    label: 'Bảng Size',
    defaultDomain: 'sizing',
    uriPrefix: 'atelier://sizing/',
  },
  {
    key: 'privacy_tryon',
    label: 'Quyền riêng tư',
    defaultDomain: 'privacy_tryon',
    uriPrefix: 'atelier://privacy/',
  },
  {
    key: 'general',
    label: 'Khác',
    defaultDomain: 'storefront_service',
    uriPrefix: 'atelier://knowledge/',
  },
] as const;

const PRESET_QUERIES = [
  'Đổi size trong bao nhiêu ngày?',
  'Ảnh thử đồ lưu bao lâu?',
  'Cách giặt áo len cashmere?',
  'Bảng size áo blazer phom Việt?',
  'Quy trình duyệt đơn nhập NHAP_AI?',
] as const;

interface RagDocumentItem {
  id: string;
  title: string;
  content: string;
  category: Exclude<RagCategoryKey, 'all'>;
  rawCategory: string;
  domain: string;
  sourceUri: string;
  version: number;
  chunkCount: number;
  isActive: boolean;
  embeddingStatus: string;
  embeddingModel: string;
  updatedBy: string;
  updatedAt: string | null;
}

interface RagCorpusSummary {
  totalDocuments: number;
  activeDocuments: number;
  totalChunks: number;
  embeddingModel: string;
  embeddingDim: number;
  hnswIndexActive: boolean;
  indexM: number;
  indexEfConstruction: number;
  backendMode: string;
}

interface RagRetrievalPassage {
  id: string;
  sourceId: string;
  title: string;
  content: string;
  category: Exclude<RagCategoryKey, 'all'>;
  domain: string;
  sourceUri: string;
  version: number;
  rrfScore: number;
  vectorScore: number | null;
  keywordScore: number | null;
  vectorRank: number | null;
  keywordRank: number | null;
}

interface RagRetrievalResponseState {
  query: string;
  status: string;
  rrfK: number;
  latencyMs: number;
  backendMode: string;
  passages: RagRetrievalPassage[];
}

interface RagDocFormState {
  id: string | null;
  title: string;
  category: Exclude<RagCategoryKey, 'all'>;
  domain: string;
  sourceUri: string;
  content: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asNumber(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function asNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeCategoryKey(
  rawCategory: unknown,
  rawDomain?: unknown,
): Exclude<RagCategoryKey, 'all'> {
  const combined = `${String(rawCategory ?? '').trim()} ${String(rawDomain ?? '').trim()}`
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd');

  if (
    combined.includes('policy_rma') ||
    combined.includes('rma') ||
    combined.includes('doi') ||
    combined.includes('tra') ||
    combined.includes('hoan') ||
    combined.includes('policy')
  ) {
    return 'policy_rma';
  }
  if (
    combined.includes('operations_sop') ||
    combined.includes('sop') ||
    combined.includes('kho') ||
    combined.includes('nhap_ai') ||
    combined.includes('media') ||
    combined.includes('operations')
  ) {
    return 'operations_sop';
  }
  if (
    combined.includes('fabric_care') ||
    combined.includes('care') ||
    combined.includes('bao quan') ||
    combined.includes('vai') ||
    combined.includes('giat')
  ) {
    return 'fabric_care';
  }
  if (
    combined.includes('sizing') ||
    combined.includes('size') ||
    combined.includes('co gian') ||
    combined.includes('bang size')
  ) {
    return 'sizing';
  }
  if (
    combined.includes('privacy_tryon') ||
    combined.includes('privacy') ||
    combined.includes('rieng tu') ||
    combined.includes('tryon') ||
    combined.includes('15 phut')
  ) {
    return 'privacy_tryon';
  }
  return 'general';
}

function getCategoryLabel(key: Exclude<RagCategoryKey, 'all'>): string {
  return RAG_CATEGORIES.find((c) => c.key === key)?.label ?? 'Khác';
}

function formatDateTimeVi(iso: string | null | undefined): string {
  if (!iso) return '—';
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return iso.slice(0, 16);
  return new Intl.DateTimeFormat('vi-VN', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(dt);
}

function slugifyUriSegment(input: string): string {
  return input
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

/**
 * Mirrors PgVectorRagStore's overlapping chunking parameters (maxChunkChars=700, overlapChars=120)
 * so operators get an accurate live chunk preview before saving.
 */
function estimateRagChunks(
  title: string,
  content: string,
  maxChunkChars = 700,
  overlapChars = 120,
): string[] {
  const clean = content.replace(/\r\n/g, '\n').trim();
  if (!clean) return [];
  if (clean.length <= maxChunkChars) {
    return [clean];
  }

  const chunks: string[] = [];
  const step = Math.max(120, maxChunkChars - overlapChars);
  let cursor = 0;

  while (cursor < clean.length) {
    let end = Math.min(clean.length, cursor + maxChunkChars);
    if (end < clean.length) {
      const slice = clean.slice(cursor, end);
      const sentenceBreak = Math.max(
        slice.lastIndexOf('\n\n'),
        slice.lastIndexOf('. '),
        slice.lastIndexOf('! '),
        slice.lastIndexOf('? '),
        slice.lastIndexOf('\n'),
      );
      if (sentenceBreak > Math.floor(maxChunkChars * 0.45)) {
        end = cursor + sentenceBreak + 1;
      }
    }

    const body = clean.slice(cursor, end).trim();
    if (body) {
      const prefix =
        chunks.length > 0 && title.trim() ? `[${title.trim()}] ` : '';
      chunks.push(`${prefix}${body}`);
    }
    if (end >= clean.length) break;
    cursor = Math.max(cursor + step, end - overlapChars);
    if (chunks.length >= 64) break;
  }

  return chunks;
}

function foldVietnameseForMatch(input: string): string {
  return input
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'd')
    .toLowerCase();
}

function highlightQueryTerms(
  text: string,
  query: string,
  darkMode: boolean,
): ReactNode {
  const rawTerms = query
    .trim()
    .split(/\s+/)
    .map((t) => foldVietnameseForMatch(t).replace(/[^a-z0-9]/g, ''))
    .filter((t) => t.length >= 2);
  const uniqueTerms = Array.from(new Set(rawTerms)).slice(0, 12);

  if (uniqueTerms.length === 0 || !text) {
    return text;
  }

  // Split preserving whitespace tokens for diacritic-insensitive highlighting without innerHTML
  const tokens = text.split(/(\s+)/);
  const markCls = darkMode
    ? 'rounded bg-[#EBCF8F]/28 px-1 py-0.5 font-medium text-[#FBF7EF]'
    : 'rounded bg-[#EBCF8F]/55 px-1 py-0.5 font-medium text-[#1C1410]';

  return tokens.map((token, idx) => {
    if (!token.trim()) return token;
    const folded = foldVietnameseForMatch(token).replace(/[^a-z0-9]/g, '');
    const matched =
      folded.length >= 2 &&
      uniqueTerms.some((term) => folded.includes(term) || term.includes(folded));
    if (matched) {
      return (
        <mark key={idx} className={markCls}>
          {token}
        </mark>
      );
    }
    return <span key={idx}>{token}</span>;
  });
}

function normalizeDocument(raw: Record<string, unknown>): RagDocumentItem {
  const domain = String(raw.domain ?? 'general').trim() || 'general';
  const rawCat = String(raw.category ?? domain).trim() || 'general';
  const category = normalizeCategoryKey(rawCat, domain);
  const versionRaw = asNumber(raw.version, 1);
  const chunkCountRaw = asNumber(
    raw.chunkCount ?? raw.chunksCount ?? raw.totalChunks,
    1,
  );
  const isActive =
    typeof raw.isActive === 'boolean'
      ? raw.isActive
      : typeof raw.is_active === 'boolean'
        ? raw.is_active
        : true;

  return {
    id: String(raw.id ?? raw.parentDocId ?? raw.parent_doc_id ?? ''),
    title: String(raw.title ?? 'Tài liệu không tiêu đề'),
    content: String(raw.content ?? raw.snippet ?? ''),
    category,
    rawCategory: rawCat,
    domain,
    sourceUri: String(raw.sourceUri ?? raw.source_uri ?? ''),
    version: Math.max(1, Math.round(versionRaw)),
    chunkCount: Math.max(1, Math.round(chunkCountRaw)),
    isActive,
    embeddingStatus: String(
      raw.embeddingStatus ?? raw.embedding_status ?? 'EMBEDDED',
    ).toUpperCase(),
    embeddingModel: String(
      raw.embeddingModel ?? raw.embedding_model ?? 'nomic-embed-text',
    ),
    updatedBy: String(raw.updatedBy ?? raw.updated_by ?? 'system'),
    updatedAt:
      typeof raw.updatedAt === 'string'
        ? raw.updatedAt
        : typeof raw.updated_at === 'string'
          ? raw.updated_at
          : null,
  };
}

function parseDocumentsPayload(data: unknown): {
  documents: RagDocumentItem[];
  summary: RagCorpusSummary;
} {
  const root = asRecord(data) ?? {};
  const rawList = Array.isArray(data)
    ? data
    : Array.isArray(root.documents)
      ? root.documents
      : Array.isArray(root.items)
        ? root.items
        : [];

  const documents = rawList
    .map((item) => asRecord(item))
    .filter((item): item is Record<string, unknown> => Boolean(item))
    .map(normalizeDocument);

  const rawSummary = asRecord(root.summary) ?? asRecord(root.stats) ?? root;
  const rawIndexSpec = asRecord(rawSummary.indexSpec) ?? asRecord(root.indexSpec);

  const activeDocsComputed = documents.filter((d) => d.isActive);
  const totalChunksComputed = activeDocsComputed.reduce(
    (sum, d) => sum + d.chunkCount,
    0,
  );

  const summary: RagCorpusSummary = {
    totalDocuments: Math.max(
      documents.length,
      asNumber(rawSummary.totalDocuments ?? root.totalDocuments, documents.length),
    ),
    activeDocuments: asNumber(
      rawSummary.activeDocuments ?? root.activeDocuments,
      activeDocsComputed.length,
    ),
    totalChunks: asNumber(
      rawSummary.totalChunks ?? root.totalChunks,
      totalChunksComputed,
    ),
    embeddingModel: String(
      rawSummary.embeddingModel ??
        root.embeddingModel ??
        documents[0]?.embeddingModel ??
        'nomic-embed-text',
    ),
    embeddingDim: asNumber(
      rawSummary.embeddingDim ?? root.embeddingDim,
      768,
    ),
    hnswIndexActive: Boolean(
      rawSummary.hnswIndexActive ?? root.hnswIndexActive ?? false,
    ),
    indexM: asNumber(rawIndexSpec?.m, 16),
    indexEfConstruction: asNumber(
      rawIndexSpec?.efConstruction ?? rawIndexSpec?.ef_construction,
      64,
    ),
    backendMode: String(
      rawSummary.backendMode ?? root.backendMode ?? 'pgvector-pglite',
    ),
  };

  return { documents, summary };
}

function parseRetrievalPayload(
  data: unknown,
  fallbackQuery: string,
): RagRetrievalResponseState {
  const root = asRecord(data) ?? {};
  const rawPassages = Array.isArray(root.passages)
    ? root.passages
    : Array.isArray(root.hits)
      ? root.hits
      : Array.isArray(root.results)
        ? root.results
        : [];

  const passages: RagRetrievalPassage[] = rawPassages
    .map((entry, idx) => {
      const rec = asRecord(entry);
      if (!rec) return null;
      const domain = String(rec.domain ?? 'general');
      return {
        id: String(rec.id ?? rec.sourceId ?? `passage-${idx}`),
        sourceId: String(rec.sourceId ?? rec.id ?? `rag-${idx + 1}`),
        title: String(rec.title ?? 'Đoạn tri thức'),
        content: String(rec.content ?? rec.snippet ?? ''),
        category: normalizeCategoryKey(rec.category ?? domain, domain),
        domain,
        sourceUri: String(
          rec.sourceUri ?? rec.source_uri ?? `atelier://rag/${rec.sourceId ?? idx + 1}`,
        ),
        version: Math.max(1, Math.round(asNumber(rec.version, 1))),
        rrfScore: asNumber(rec.rrfScore ?? rec.score, 0),
        vectorScore: asNullableNumber(rec.vectorScore ?? rec.semanticScore),
        keywordScore: asNullableNumber(rec.keywordScore ?? rec.lexicalScore),
        vectorRank: asNullableNumber(rec.vectorRank),
        keywordRank: asNullableNumber(rec.keywordRank),
      };
    })
    .filter((item): item is RagRetrievalPassage => Boolean(item));

  return {
    query: String(root.query ?? fallbackQuery),
    status: String(
      root.status ?? (passages.length > 0 ? 'GROUNDED' : 'NO_GROUNDED_EVIDENCE'),
    ),
    rrfK: asNumber(root.rrfK, 60),
    latencyMs: asNumber(root.latencyMs, 0),
    backendMode: String(root.backendMode ?? root.dbMode ?? 'hybrid-rrf'),
    passages,
  };
}

export function RagKnowledgeBaseTab({
  roles,
  mfaVerified = false,
  darkMode = false,
  onNotify,
  onRefreshOverview,
}: RagKnowledgeBaseTabProps) {
  const isSuperAdmin = roles.includes(Role.SUPER_ADMIN);
  const canManageRag =
    isSuperAdmin || roles.includes(Role.CATALOG_AI_OPERATOR);
  const canTriggerReindex = canManageRag && (!isSuperAdmin || mfaVerified);

  const [documents, setDocuments] = useState<RagDocumentItem[]>([]);
  const [summary, setSummary] = useState<RagCorpusSummary>({
    totalDocuments: 0,
    activeDocuments: 0,
    totalChunks: 0,
    embeddingModel: 'nomic-embed-text',
    embeddingDim: 768,
    hnswIndexActive: false,
    indexM: 16,
    indexEfConstruction: 64,
    backendMode: 'pgvector-pglite',
  });

  const [loading, setLoading] = useState(true);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);

  // Filters
  const [categoryFilter, setCategoryFilter] = useState<RagCategoryKey>('all');
  const [includeInactive, setIncludeInactive] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  // Mutations
  const [reindexing, setReindexing] = useState(false);
  const [confirmDeactivateId, setConfirmDeactivateId] = useState<string | null>(
    null,
  );
  const [busyDocId, setBusyDocId] = useState<string | null>(null);

  // Create / Edit Modal
  const [modalOpen, setModalOpen] = useState(false);
  const [savingDoc, setSavingDoc] = useState(false);
  const [loadingEditId, setLoadingEditId] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [form, setForm] = useState<RagDocFormState>({
    id: null,
    title: '',
    category: 'policy_rma',
    domain: 'policy_rma',
    sourceUri: '',
    content: '',
  });

  // Test Retrieval Sandbox
  const [testQuery, setTestQuery] = useState('');
  const [testCategory, setTestCategory] = useState<RagCategoryKey>('all');
  const [testLimit, setTestLimit] = useState<number>(5);
  const [testingRetrieval, setTestingRetrieval] = useState(false);
  const [retrievalError, setRetrievalError] = useState<string | null>(null);
  const [retrievalResult, setRetrievalResult] =
    useState<RagRetrievalResponseState | null>(null);

  const notify = useCallback(
    (payload: RagTabNotifyPayload) => {
      if (onNotify) {
        onNotify(payload);
      } else {
        emitPortalToast(payload);
      }
    },
    [onNotify],
  );

  const loadDocuments = useCallback(async () => {
    setLoading(true);
    setErrorBanner(null);

    const qs = buildQueryString({
      includeInactive: includeInactive ? 'true' : undefined,
    });
    const res = await adminFetch<unknown>(`/api/v1/admin/rag/documents${qs}`, {
      timeoutMs: 15_000,
    });

    if (res.ok && res.data) {
      const parsed = parseDocumentsPayload(res.data);
      setDocuments(parsed.documents);
      setSummary(parsed.summary);
    } else {
      setErrorBanner(
        res.error?.message ||
          'Không thể tải kho tài liệu Tri thức AI (RAG) từ BFF / MCP Copilot.',
      );
    }

    setLoading(false);
  }, [includeInactive]);

  useEffect(() => {
    void loadDocuments();
  }, [loadDocuments]);

  const filteredDocuments = useMemo(() => {
    const qFolded = foldVietnameseForMatch(searchQuery.trim());
    return documents.filter((doc) => {
      if (!includeInactive && !doc.isActive) {
        return false;
      }
      if (categoryFilter !== 'all' && doc.category !== categoryFilter) {
        return false;
      }
      if (qFolded) {
        const hay = foldVietnameseForMatch(
          `${doc.title} ${doc.content} ${doc.sourceUri} ${doc.domain} ${doc.id}`,
        );
        if (!hay.includes(qFolded)) {
          return false;
        }
      }
      return true;
    });
  }, [documents, includeInactive, categoryFilter, searchQuery]);

  const categoryCounts = useMemo(() => {
    const counts: Record<RagCategoryKey, number> = {
      all: 0,
      policy_rma: 0,
      operations_sop: 0,
      fabric_care: 0,
      sizing: 0,
      privacy_tryon: 0,
      general: 0,
    };
    for (const doc of documents) {
      if (!includeInactive && !doc.isActive) continue;
      counts.all += 1;
      counts[doc.category] = (counts[doc.category] ?? 0) + 1;
    }
    return counts;
  }, [documents, includeInactive]);

  const estimatedChunks = useMemo(
    () => estimateRagChunks(form.title, form.content),
    [form.title, form.content],
  );

  const openCreateModal = () => {
    setFormError(null);
    setForm({
      id: null,
      title: '',
      category: 'policy_rma',
      domain: 'policy_rma',
      sourceUri: '',
      content: '',
    });
    setModalOpen(true);
  };

  const openEditModal = async (doc: RagDocumentItem) => {
    setFormError(null);
    let fullContent = doc.content;

    if (!fullContent || fullContent.length < 40) {
      setLoadingEditId(doc.id);
      const detailRes = await adminFetch<unknown>(
        `/api/v1/admin/rag/documents/${encodeURIComponent(doc.id)}`,
        { timeoutMs: 10_000 },
      );
      setLoadingEditId(null);
      if (detailRes.ok && detailRes.data) {
        const rec = asRecord(detailRes.data);
        const docRec = asRecord(rec?.document) ?? rec;
        if (typeof docRec?.content === 'string' && docRec.content.trim()) {
          fullContent = docRec.content;
        }
      }
    }

    setForm({
      id: doc.id,
      title: doc.title,
      category: doc.category,
      domain: doc.domain,
      sourceUri: doc.sourceUri,
      content: fullContent,
    });
    setModalOpen(true);
  };

  const handleSaveDocument = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFormError(null);

    const title = form.title.trim();
    const content = form.content.trim();
    const domain = form.domain.trim() || form.category;
    const catMeta = RAG_CATEGORIES.find((c) => c.key === form.category);
    const sourceUri =
      form.sourceUri.trim() ||
      `${catMeta?.uriPrefix ?? 'atelier://knowledge/'}${slugifyUriSegment(title) || 'doc'}-v1`;

    if (!title) {
      setFormError('Vui lòng nhập tiêu đề tài liệu.');
      return;
    }
    if (content.length < 20) {
      setFormError('Nội dung tài liệu cần tối thiểu 20 ký tự để tạo vector ngữ nghĩa.');
      return;
    }

    setSavingDoc(true);
    const isEdit = Boolean(form.id);
    const endpoint = isEdit
      ? `/api/v1/admin/rag/documents/${encodeURIComponent(form.id!)}`
      : '/api/v1/admin/rag/documents';

    const res = await adminFetch<unknown>(endpoint, {
      method: isEdit ? 'PUT' : 'POST',
      timeoutMs: 35_000,
      body: JSON.stringify({
        title,
        category: form.category,
        domain,
        sourceUri,
        content,
      }),
    });

    setSavingDoc(false);
    if (res.ok) {
      setModalOpen(false);
      notify({
        kind: 'success',
        title: isEdit ? 'CẬP NHẬT TRI THỨC RAG' : 'TẠO TÀI LIỆU RAG MỚI',
        message: isEdit
          ? `Đã nâng phiên bản tài liệu "${title}", nhúng lại vector (${estimatedChunks.length} phân đoạn) và xóa cache Copilot.`
          : `Đã lưu tài liệu "${title}" (${estimatedChunks.length} phân đoạn ${summary.embeddingModel}) và xóa cache Copilot.`,
      });
      await loadDocuments();
      onRefreshOverview?.();
    } else {
      setFormError(
        res.error?.message ||
          (isEdit
            ? 'Không thể cập nhật tài liệu RAG.'
            : 'Không thể khởi tạo tài liệu RAG mới.'),
      );
    }
  };

  const handleDeactivateDocument = async (doc: RagDocumentItem) => {
    setBusyDocId(doc.id);
    const res = await adminFetch<unknown>(
      `/api/v1/admin/rag/documents/${encodeURIComponent(doc.id)}`,
      {
        method: 'DELETE',
        timeoutMs: 20_000,
      },
    );
    setBusyDocId(null);
    setConfirmDeactivateId(null);

    if (res.ok) {
      notify({
        kind: 'info',
        title: 'VÔ HIỆU HÓA TÀI LIỆU RAG',
        message: `Đã vô hiệu hóa "${doc.title}" (is_active = false) và xóa bộ nhớ đệm Copilot.`,
      });
      await loadDocuments();
      onRefreshOverview?.();
    } else {
      notify({
        kind: 'error',
        title: 'LỖI VÔ HIỆU HÓA',
        message: res.error?.message || 'Không thể vô hiệu hóa tài liệu RAG.',
      });
    }
  };

  const handleReactivateDocument = async (doc: RagDocumentItem) => {
    setBusyDocId(doc.id);
    const res = await adminFetch<unknown>(
      `/api/v1/admin/rag/documents/${encodeURIComponent(doc.id)}`,
      {
        method: 'PUT',
        timeoutMs: 25_000,
        body: JSON.stringify({ isActive: true }),
      },
    );
    setBusyDocId(null);

    if (res.ok) {
      notify({
        kind: 'success',
        title: 'KÍCH HOẠT LẠI TÀI LIỆU',
        message: `Đã kích hoạt lại "${doc.title}" trong chỉ mục Hybrid RAG.`,
      });
      await loadDocuments();
    } else {
      notify({
        kind: 'error',
        title: 'LỖI KÍCH HOẠT',
        message: res.error?.message || 'Không thể kích hoạt lại tài liệu.',
      });
    }
  };

  const handleReindexCorpus = async () => {
    if (!canTriggerReindex || reindexing) return;
    setReindexing(true);

    const res = await adminFetch<unknown>('/api/v1/admin/rag/reindex', {
      method: 'POST',
      timeoutMs: 65_000,
      body: JSON.stringify({}),
    });

    setReindexing(false);

    if (res.ok) {
      const rec = asRecord(res.data) ?? {};
      const reindexedDocs = asNumber(rec.reindexedDocuments, summary.activeDocuments);
      const reindexedChunks = asNumber(rec.reindexedChunks, summary.totalChunks);
      const durationMs = Math.round(asNumber(rec.durationMs, 0));
      const model = String(rec.embeddingModel ?? summary.embeddingModel);
      const dim = asNumber(rec.embeddingDim, summary.embeddingDim);

      notify({
        kind: 'success',
        title: 'RE-INDEX VECTOR & XÓA CACHE HOÀN TẤT',
        message: `Đã đồng bộ ${reindexedDocs} tài liệu (${reindexedChunks} chunks · ${model} ${dim}d) trong ${durationMs}ms và xóa toàn bộ copilot:cache:*.`,
      });
      await loadDocuments();
      onRefreshOverview?.();
    } else {
      notify({
        kind: 'error',
        title: 'RE-INDEX THẤT BẠI',
        message:
          res.error?.message ||
          'Không thể thực thi Re-index Vector. Kiểm tra dịch vụ MCP Copilot (:4010).',
      });
    }
  };

  const executeTestRetrieval = useCallback(
    async (rawQuery: string) => {
      const trimmed = rawQuery.trim();
      if (!trimmed) {
        setRetrievalError('Vui lòng nhập câu hỏi tiếng Việt để kiểm thử truy xuất RAG.');
        return;
      }

      setTestingRetrieval(true);
      setRetrievalError(null);

      const res = await adminFetch<unknown>('/api/v1/admin/rag/test-retrieval', {
        method: 'POST',
        timeoutMs: 25_000,
        body: JSON.stringify({
          query: trimmed,
          category: testCategory !== 'all' ? testCategory : undefined,
          limit: testLimit,
        }),
      });

      setTestingRetrieval(false);

      if (res.ok && res.data) {
        setRetrievalResult(parseRetrievalPayload(res.data, trimmed));
      } else {
        setRetrievalError(
          res.error?.message ||
            'Không thể chạy kiểm thử truy xuất Hybrid RAG RRF k=60.',
        );
      }
    },
    [testCategory, testLimit],
  );

  const handleRetrievalSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void executeTestRetrieval(testQuery);
  };

  // Quiet Luxury Atelier Theme Tokens (Kem Atelier & Espresso Tối)
  const cardCls = darkMode
    ? 'border-[#B08A4A]/30 bg-[#1A130E] text-[#FBF7EF]'
    : 'border-[#B08A4A]/25 bg-[#FFFDF9] text-[#1C1410]';
  const subCardCls = darkMode
    ? 'border-[#B08A4A]/25 bg-[#231912] text-[#FBF7EF]'
    : 'border-[#B08A4A]/20 bg-[#FBF7EF] text-[#1C1410]';
  const mutedCls = darkMode ? 'text-[#B4A391]' : 'text-[#7A6A5B]';
  const secondaryCls = darkMode ? 'text-[#DFD2C2]' : 'text-[#5C4B41]';
  const goldTextCls = darkMode ? 'text-[#EBCF8F]' : 'text-[#8A672C]';
  const inputCls = darkMode
    ? 'border-[#B08A4A]/35 bg-[#140E0A] text-[#FBF7EF] placeholder:text-[#8E7D6B] focus:border-[#EBCF8F]'
    : 'border-[#B08A4A]/35 bg-[#FBF7EF] text-[#1C1410] placeholder:text-[#7A6A5B] focus:border-[#1C1410]';
  const tableHeadCls = darkMode
    ? 'border-b border-[#B08A4A]/25 bg-[#241A13] text-[#EBCF8F]'
    : 'border-b border-[#B08A4A]/20 bg-[#F4EBDA]/75 text-[#8A672C]';
  const rowHoverCls = darkMode ? 'hover:bg-[#251B14]' : 'hover:bg-[#FBF7EF]/85';

  const getEmbeddingBadgeCls = (status: string): string => {
    if (status === 'EMBEDDED' || status === 'READY') {
      return darkMode
        ? 'border-emerald-500/45 bg-emerald-950/55 text-emerald-300'
        : 'border-[#2E6B47]/35 bg-[#EBF9F1] text-[#1E4B32]';
    }
    if (status === 'FALLBACK' || status === 'DETERMINISTIC') {
      return darkMode
        ? 'border-[#EBCF8F]/45 bg-[#362614] text-[#EBCF8F]'
        : 'border-[#B08A4A]/45 bg-[#FEF4E1] text-[#8A672C]';
    }
    if (status === 'FAILED' || status === 'ERROR') {
      return darkMode
        ? 'border-rose-500/45 bg-rose-950/50 text-rose-300'
        : 'border-[#8B2E2E]/40 bg-[#FFF5F4] text-[#8B2E2E]';
    }
    return darkMode
      ? 'border-amber-500/45 bg-amber-950/50 text-amber-300'
      : 'border-[#D9822B]/40 bg-[#FFF6E5] text-[#9A5B13]';
  };

  return (
    <div data-testid="rag-knowledge-base-tab" className="min-w-0 space-y-6">
      {/* ==================================================================== */}
      {/* 1. Header, KPI & Vector HNSW Index Status Strip                      */}
      {/* ==================================================================== */}
      <section className={`rounded-3xl border p-5 sm:p-6 ${cardCls}`}>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <p className={`ledger-eyebrow ${goldTextCls}`}>
              Layer 3 Hybrid RAG · pgvector HNSW (768d) &amp; RRF k=60 Knowledge Console
            </p>
            <h2 className="font-editorial mt-1 text-3xl font-normal tracking-tight">
              Kho Tri thức AI (RAG) &amp; Chỉ mục Vector
            </h2>
            <p className={`mt-1 max-w-3xl text-xs leading-relaxed ${mutedCls}`}>
              Quản trị tập tài liệu chính sách, SOP kho vận, hướng dẫn bảo quản vải &amp;
              bảng size cho cả <strong>Admin MCP Copilot</strong> và{' '}
              <strong>Trợ lý Storefront</strong>. Mọi cập nhật tự động nâng phiên bản,
              phân đoạn gối đầu, nhúng vector <code>{summary.embeddingModel}</code> và xóa
              cache <code>copilot:cache:*</code>.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void loadDocuments()}
              disabled={loading}
              className={`rounded-full border px-3.5 py-2 text-xs transition-colors disabled:opacity-50 ${
                darkMode
                  ? 'border-[#B08A4A]/45 text-[#EBCF8F] hover:bg-[#2A1E17]'
                  : 'border-[#B08A4A]/45 text-[#8A672C] hover:bg-[#FBF7EF]'
              }`}
            >
              {loading ? 'Đang tải...' : 'Làm mới'}
            </button>

            {canManageRag ? (
              <button
                type="button"
                data-testid="rag-reindex-btn"
                onClick={() => void handleReindexCorpus()}
                disabled={reindexing || !canTriggerReindex}
                title={
                  !canTriggerReindex
                    ? 'SUPER_ADMIN cần xác thực 2FA trước khi Re-index Vector'
                    : 'Nhúng lại toàn bộ tài liệu đang hoạt động và xóa cache Copilot'
                }
                className={`inline-flex items-center gap-2 rounded-full border px-4 py-2 text-xs font-medium transition-colors disabled:opacity-50 ${
                  darkMode
                    ? 'border-[#EBCF8F]/55 bg-[#2D2116] text-[#EBCF8F] hover:bg-[#3A2B1D]'
                    : 'border-[#B08A4A] bg-[#FEF4E1] text-[#7A5216] hover:bg-[#F9E7C2]'
                }`}
              >
                {reindexing ? (
                  <svg
                    className="h-3.5 w-3.5 animate-spin"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    aria-hidden="true"
                  >
                    <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                  </svg>
                ) : (
                  <svg
                    className="h-3.5 w-3.5"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    aria-hidden="true"
                  >
                    <path d="M21 12a9 9 0 1 1-2.64-6.36" />
                    <path d="M21 3v6h-6" />
                  </svg>
                )}
                <span>
                  {reindexing
                    ? 'Đang Re-index Vector...'
                    : 'Re-index Vector & Xóa Cache Copilot'}
                </span>
              </button>
            ) : null}

            {canManageRag ? (
              <button
                type="button"
                data-testid="rag-create-doc-btn"
                onClick={openCreateModal}
                className={`rounded-full px-4 py-2 text-xs font-medium uppercase tracking-[0.12em] transition-opacity hover:opacity-90 ${
                  darkMode
                    ? 'bg-[#EBCF8F] text-[#1C1410]'
                    : 'bg-[#1C1410] text-[#EBCF8F]'
                }`}
              >
                + Thêm tài liệu
              </button>
            ) : null}
          </div>
        </div>

        {errorBanner ? (
          <div
            role="alert"
            className={`mt-4 rounded-2xl border px-4 py-3 text-xs ${
              darkMode
                ? 'border-rose-500/45 bg-rose-950/40 text-rose-200'
                : 'border-[#8B2E2E]/35 bg-[#FFF5F4] text-[#8B2E2E]'
            }`}
          >
            {errorBanner}
          </div>
        ) : null}

        {/* KPI Cards */}
        <div className="mt-5 grid grid-cols-1 gap-3.5 sm:grid-cols-2 xl:grid-cols-4">
          <div className={`rounded-2xl border p-4 ${subCardCls}`}>
            <p
              className={`text-[10px] font-semibold uppercase tracking-[0.16em] ${mutedCls}`}
            >
              Tài liệu Đang hoạt động
            </p>
            <div className="mt-1.5 flex items-baseline gap-2">
              <p className="adm-tabular font-mono text-3xl font-semibold">
                {summary.activeDocuments}
              </p>
              <span className={`font-mono text-xs ${mutedCls}`}>
                / {summary.totalDocuments} tổng
              </span>
            </div>
            <p className={`mt-1 text-[11px] ${secondaryCls}`}>
              Khả dụng ngay cho Copilot &amp; Storefront
            </p>
          </div>

          <div className={`rounded-2xl border p-4 ${subCardCls}`}>
            <p
              className={`text-[10px] font-semibold uppercase tracking-[0.16em] ${mutedCls}`}
            >
              Tổng phân đoạn (Vector Chunks)
            </p>
            <p className="adm-tabular mt-1.5 font-mono text-3xl font-semibold">
              {summary.totalChunks}
            </p>
            <p className={`mt-1 text-[11px] ${secondaryCls}`}>
              Cắt đoạn ngữ cảnh gối đầu (700 / 120 ký tự)
            </p>
          </div>

          <div className={`rounded-2xl border p-4 ${subCardCls}`}>
            <p
              className={`text-[10px] font-semibold uppercase tracking-[0.16em] ${mutedCls}`}
            >
              Mô hình Embedding Cục bộ
            </p>
            <p className={`mt-2 truncate font-mono text-base font-semibold ${goldTextCls}`}>
              {summary.embeddingModel} · {summary.embeddingDim}d
            </p>
            <p className={`mt-1.5 text-[11px] ${secondaryCls}`}>
              Ollama Local AI · 0 USD chi phí API
            </p>
          </div>

          <div className={`rounded-2xl border p-4 ${subCardCls}`}>
            <p
              className={`text-[10px] font-semibold uppercase tracking-[0.16em] ${mutedCls}`}
            >
              Trạng thái Chỉ mục Vector
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <span
                data-testid="rag-hnsw-badge"
                className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-mono text-[10.5px] font-semibold ${
                  summary.hnswIndexActive
                    ? darkMode
                      ? 'border-emerald-400/45 bg-emerald-950/60 text-emerald-300'
                      : 'border-[#2E6B47]/40 bg-[#EBF9F1] text-[#1E4B32]'
                    : darkMode
                      ? 'border-[#EBCF8F]/45 bg-[#332414] text-[#EBCF8F]'
                      : 'border-[#B08A4A]/50 bg-[#FEF4E1] text-[#8A672C]'
                }`}
              >
                <span
                  className={`h-1.5 w-1.5 rounded-full ${
                    summary.hnswIndexActive ? 'bg-emerald-500' : 'bg-[#B08A4A]'
                  }`}
                />
                {summary.hnswIndexActive
                  ? `HNSW m=${summary.indexM}, ef=${summary.indexEfConstruction}`
                  : `Fallback · HNSW m=${summary.indexM}, ef=${summary.indexEfConstruction}`}
              </span>
            </div>
            <p className={`mt-1.5 truncate font-mono text-[10.5px] ${mutedCls}`}>
              Backend: {summary.backendMode} · RRF k=60
            </p>
          </div>
        </div>
      </section>

      {/* ==================================================================== */}
      {/* 2. Document Corpus Manager (Filter + Search + Versioned Table)       */}
      {/* ==================================================================== */}
      <section className={`rounded-3xl border p-5 sm:p-6 ${cardCls}`}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className={`ledger-eyebrow ${goldTextCls}`}>
              Document Corpus Manager · Dynamic Versioning
            </p>
            <h3 className="font-editorial mt-0.5 text-2xl font-normal">
              Danh mục Tài liệu Tri thức ({filteredDocuments.length})
            </h3>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            {/* Search Box */}
            <input
              type="search"
              data-testid="rag-doc-search-input"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Tìm tiêu đề, nội dung, URI..."
              className={`w-56 rounded-full border px-3.5 py-1.5 text-xs outline-none transition-colors sm:w-64 ${inputCls}`}
            />

            {/* Active / Archived Toggle */}
            <label
              className={`inline-flex cursor-pointer items-center gap-2 rounded-full border px-3 py-1.5 text-[11px] font-medium ${subCardCls}`}
            >
              <input
                type="checkbox"
                data-testid="rag-include-inactive-toggle"
                checked={includeInactive}
                onChange={(e) => setIncludeInactive(e.target.checked)}
                className="accent-[#B08A4A]"
              />
              <span>Hiện bản đã vô hiệu hóa</span>
            </label>
          </div>
        </div>

        {/* Category Filter Pills */}
        <div className="mt-4 flex flex-wrap items-center gap-1.5">
          {(
            [
              { key: 'all' as const, label: 'Tất cả' },
              ...RAG_CATEGORIES.map((c) => ({ key: c.key, label: c.label })),
            ] as const
          ).map((tab) => {
            const active = categoryFilter === tab.key;
            const count = categoryCounts[tab.key] ?? 0;
            return (
              <button
                key={tab.key}
                type="button"
                onClick={() => setCategoryFilter(tab.key)}
                className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[11px] font-medium transition-colors ${
                  active
                    ? darkMode
                      ? 'border-[#EBCF8F] bg-[#EBCF8F] text-[#1C1410]'
                      : 'border-[#1C1410] bg-[#1C1410] text-[#EBCF8F]'
                    : darkMode
                      ? 'border-[#B08A4A]/30 bg-[#231912] text-[#DFD2C2] hover:border-[#EBCF8F]/60'
                      : 'border-[#B08A4A]/30 bg-[#FBF7EF] text-[#5C4B41] hover:border-[#8A672C]'
                }`}
              >
                <span>{tab.label}</span>
                <span
                  className={`adm-tabular rounded-full px-1.5 py-0.2 font-mono text-[10px] ${
                    active
                      ? darkMode
                        ? 'bg-[#1C1410]/15 text-[#1C1410]'
                        : 'bg-[#EBCF8F]/20 text-[#EBCF8F]'
                      : darkMode
                        ? 'bg-[#140E0A] text-[#B4A391]'
                        : 'bg-white text-[#7A6A5B]'
                  }`}
                >
                  {count}
                </span>
              </button>
            );
          })}
        </div>

        {/* Corpus Table */}
        {loading && documents.length === 0 ? (
          <div className={`mt-5 rounded-2xl border p-8 text-center text-xs ${subCardCls}`}>
            Đang tải danh sách tài liệu Tri thức AI (RAG)...
          </div>
        ) : filteredDocuments.length === 0 ? (
          <div className={`mt-5 rounded-2xl border p-8 text-center text-xs ${subCardCls}`}>
            <p className="font-medium">Không có tài liệu nào khớp bộ lọc hiện tại.</p>
            <p className={`mt-1 text-[11px] ${mutedCls}`}>
              Hãy thử chuyển bộ lọc danh mục hoặc nhấn &ldquo;+ Thêm tài liệu&rdquo; để bổ
              sung quy định mới cho Copilot.
            </p>
          </div>
        ) : (
          <div className="mt-4 overflow-x-auto rounded-2xl border border-[#B08A4A]/22">
            <table className="w-full min-w-[780px] border-collapse text-left text-xs">
              <thead>
                <tr className={tableHeadCls}>
                  <th className="px-4 py-3 font-semibold uppercase tracking-[0.12em] text-[10px]">
                    Tài liệu &amp; Nguồn URI
                  </th>
                  <th className="px-3.5 py-3 font-semibold uppercase tracking-[0.12em] text-[10px]">
                    Danh mục
                  </th>
                  <th className="px-3 py-3 font-semibold uppercase tracking-[0.12em] text-[10px]">
                    Phiên bản
                  </th>
                  <th className="px-3 py-3 text-center font-semibold uppercase tracking-[0.12em] text-[10px]">
                    Chunks
                  </th>
                  <th className="px-3.5 py-3 font-semibold uppercase tracking-[0.12em] text-[10px]">
                    Trạng thái Embedding
                  </th>
                  <th className="px-3.5 py-3 font-semibold uppercase tracking-[0.12em] text-[10px]">
                    Cập nhật
                  </th>
                  <th className="px-4 py-3 text-right font-semibold uppercase tracking-[0.12em] text-[10px]">
                    Thao tác
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#B08A4A]/15">
                {filteredDocuments.map((doc) => (
                  <tr
                    key={doc.id}
                    data-testid={`rag-doc-row-${doc.id}`}
                    className={`transition-colors ${rowHoverCls} ${
                      !doc.isActive ? 'opacity-65' : ''
                    }`}
                  >
                    <td className="max-w-[320px] px-4 py-3.5 align-top">
                      <p className="font-medium leading-snug">{doc.title}</p>
                      <div className="mt-1 flex flex-wrap items-center gap-1.5">
                        <span
                          className={`max-w-[240px] truncate rounded bg-[#B08A4A]/12 px-1.5 py-0.5 font-mono text-[10px] ${goldTextCls}`}
                          title={doc.sourceUri || doc.id}
                        >
                          {doc.sourceUri || doc.id}
                        </span>
                        <span className={`font-mono text-[10px] ${mutedCls}`}>
                          · {doc.domain}
                        </span>
                      </div>
                    </td>

                    <td className="px-3.5 py-3.5 align-top whitespace-nowrap">
                      <span
                        className={`inline-flex rounded-full border px-2.5 py-0.5 text-[10.5px] font-medium ${
                          darkMode
                            ? 'border-[#B08A4A]/35 bg-[#231912] text-[#EBCF8F]'
                            : 'border-[#B08A4A]/35 bg-[#FBF7EF] text-[#5C4B41]'
                        }`}
                      >
                        {getCategoryLabel(doc.category)}
                      </span>
                    </td>

                    <td className="px-3 py-3.5 align-top whitespace-nowrap">
                      <div className="flex flex-col items-start gap-1">
                        <span className="adm-tabular rounded-md bg-[#1C1410] px-2 py-0.5 font-mono text-[10.5px] font-semibold text-[#EBCF8F]">
                          v{doc.version}
                        </span>
                        <span
                          className={`text-[10px] font-medium ${
                            doc.isActive
                              ? darkMode
                                ? 'text-emerald-300'
                                : 'text-[#1E4B32]'
                              : mutedCls
                          }`}
                        >
                          {doc.isActive ? '● Hoạt động' : '○ Đã vô hiệu hóa'}
                        </span>
                      </div>
                    </td>

                    <td className="px-3 py-3.5 text-center align-top whitespace-nowrap">
                      <span className="adm-tabular font-mono text-xs font-semibold">
                        {doc.chunkCount}
                      </span>
                    </td>

                    <td className="px-3.5 py-3.5 align-top whitespace-nowrap">
                      <span
                        className={`inline-flex rounded-full border px-2.5 py-0.5 font-mono text-[10px] font-semibold ${getEmbeddingBadgeCls(doc.embeddingStatus)}`}
                      >
                        {doc.embeddingStatus}
                      </span>
                      <p className={`mt-1 font-mono text-[10px] ${mutedCls}`}>
                        {doc.embeddingModel}
                      </p>
                    </td>

                    <td className="px-3.5 py-3.5 align-top whitespace-nowrap">
                      <p className="max-w-[140px] truncate text-[11px] font-medium">
                        {doc.updatedBy}
                      </p>
                      <p className={`mt-0.5 font-mono text-[10px] ${mutedCls}`}>
                        {formatDateTimeVi(doc.updatedAt)}
                      </p>
                    </td>

                    <td className="px-4 py-3.5 text-right align-top whitespace-nowrap">
                      {canManageRag ? (
                        <div className="flex flex-wrap items-center justify-end gap-1.5">
                          <button
                            type="button"
                            disabled={loadingEditId === doc.id || busyDocId === doc.id}
                            onClick={() => void openEditModal(doc)}
                            className={`rounded-full border px-3 py-1 text-[10.5px] transition-colors disabled:opacity-50 ${
                              darkMode
                                ? 'border-[#B08A4A]/40 text-[#EBCF8F] hover:border-[#EBCF8F] hover:bg-[#2A1E17]'
                                : 'border-[#B08A4A]/40 text-[#1C1410] hover:border-[#1C1410] hover:bg-[#F4EBDA]'
                            }`}
                          >
                            {loadingEditId === doc.id ? 'Đang mở...' : 'Chỉnh sửa'}
                          </button>

                          {doc.isActive ? (
                            confirmDeactivateId === doc.id ? (
                              <div className="flex items-center gap-1">
                                <button
                                  type="button"
                                  disabled={busyDocId === doc.id}
                                  onClick={() => void handleDeactivateDocument(doc)}
                                  className="rounded-full bg-[#8B2E2E] px-2.5 py-1 text-[10px] font-semibold text-white"
                                >
                                  {busyDocId === doc.id ? '...' : 'Xác nhận'}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setConfirmDeactivateId(null)}
                                  className="rounded-full border border-[#B08A4A]/35 px-2 py-1 text-[10px]"
                                >
                                  Hủy
                                </button>
                              </div>
                            ) : (
                              <button
                                type="button"
                                onClick={() => setConfirmDeactivateId(doc.id)}
                                className={`rounded-full border px-3 py-1 text-[10.5px] transition-colors ${
                                  darkMode
                                    ? 'border-rose-400/45 text-rose-300 hover:bg-rose-950/40'
                                    : 'border-[#8B2E2E]/45 text-[#8B2E2E] hover:bg-[#8B2E2E]/10'
                                }`}
                              >
                                Vô hiệu hóa
                              </button>
                            )
                          ) : (
                            <button
                              type="button"
                              disabled={busyDocId === doc.id}
                              onClick={() => void handleReactivateDocument(doc)}
                              className={`rounded-full border px-3 py-1 text-[10.5px] transition-colors disabled:opacity-50 ${
                                darkMode
                                  ? 'border-emerald-400/45 text-emerald-300 hover:bg-emerald-950/40'
                                  : 'border-[#2E6B47]/45 text-[#1E4B32] hover:bg-[#EBF9F1]'
                              }`}
                            >
                              {busyDocId === doc.id ? '...' : 'Kích hoạt lại'}
                            </button>
                          )}
                        </div>
                      ) : (
                        <span className={`font-mono text-[10px] ${mutedCls}`}>
                          Chỉ đọc
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ==================================================================== */}
      {/* 3. Test Truy Xuất Thử (Hybrid RAG RRF k=60) Sandbox Panel           */}
      {/* ==================================================================== */}
      <section
        data-testid="rag-test-retrieval-sandbox"
        className={`rounded-3xl border p-5 sm:p-6 ${cardCls}`}
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className={`ledger-eyebrow ${goldTextCls}`}>
              Hybrid Search Sandbox · Cosine Vector + PostgreSQL FTS · RRF k=60
            </p>
            <h3 className="font-editorial mt-0.5 text-2xl font-normal">
              Test Truy Xuất Thử (Hybrid RAG RRF k=60)
            </h3>
            <p className={`mt-1 text-xs ${mutedCls}`}>
              Nhập câu hỏi tiếng Việt bất kỳ để kiểm tra độ chính xác xếp hạng kết hợp giữa
              truy vấn Vector (<code>nomic-embed-text</code>) và Từ khóa (Full-Text Search)
              trước khi đưa vào phản hồi Copilot.
            </p>
          </div>

          {retrievalResult ? (
            <div className="flex flex-wrap items-center gap-2 font-mono text-[10.5px]">
              <span
                className={`rounded-full border px-2.5 py-1 font-semibold ${
                  retrievalResult.status === 'GROUNDED'
                    ? darkMode
                      ? 'border-emerald-400/40 bg-emerald-950/55 text-emerald-300'
                      : 'border-[#2E6B47]/35 bg-[#EBF9F1] text-[#1E4B32]'
                    : darkMode
                      ? 'border-amber-400/40 bg-amber-950/50 text-amber-300'
                      : 'border-[#D9822B]/40 bg-[#FFF6E5] text-[#9A5B13]'
                }`}
              >
                {retrievalResult.status}
              </span>
              <span className={`rounded-full border px-2.5 py-1 ${subCardCls}`}>
                RRF k={retrievalResult.rrfK}
              </span>
              <span className={`adm-tabular rounded-full border px-2.5 py-1 ${subCardCls}`}>
                {retrievalResult.latencyMs.toFixed(1)} ms
              </span>
            </div>
          ) : null}
        </div>

        {/* Query Form */}
        <form onSubmit={handleRetrievalSubmit} className="mt-4 space-y-3">
          <div className="flex flex-col gap-2.5 lg:flex-row">
            <input
              type="text"
              data-testid="rag-test-query-input"
              value={testQuery}
              onChange={(e) => setTestQuery(e.target.value)}
              placeholder="Ví dụ: Khách muốn đổi size váy lụa sau 10 ngày có mất phí không?"
              className={`min-w-0 flex-1 rounded-2xl border px-4 py-2.5 text-xs outline-none transition-colors ${inputCls}`}
            />

            <div className="flex flex-wrap items-center gap-2">
              <select
                aria-label="Lọc danh mục kiểm thử"
                value={testCategory}
                onChange={(e) =>
                  setTestCategory(e.target.value as RagCategoryKey)
                }
                className={`rounded-2xl border px-3 py-2.5 text-xs outline-none ${inputCls}`}
              >
                <option value="all">Mọi danh mục</option>
                {RAG_CATEGORIES.map((cat) => (
                  <option key={cat.key} value={cat.key}>
                    {cat.label}
                  </option>
                ))}
              </select>

              <select
                aria-label="Số đoạn trích tối đa"
                value={testLimit}
                onChange={(e) => setTestLimit(Number(e.target.value))}
                className={`rounded-2xl border px-3 py-2.5 font-mono text-xs outline-none ${inputCls}`}
              >
                <option value={3}>Top 3</option>
                <option value={5}>Top 5</option>
                <option value={8}>Top 8</option>
              </select>

              <button
                type="submit"
                data-testid="rag-test-retrieval-btn"
                disabled={testingRetrieval}
                className={`rounded-full px-5 py-2.5 text-xs font-semibold uppercase tracking-[0.12em] transition-opacity hover:opacity-90 disabled:opacity-50 ${
                  darkMode
                    ? 'bg-[#EBCF8F] text-[#1C1410]'
                    : 'bg-[#1C1410] text-[#EBCF8F]'
                }`}
              >
                {testingRetrieval ? 'Đang truy xuất...' : 'Truy xuất thử'}
              </button>
            </div>
          </div>

          {/* Preset Query Chips */}
          <div className="flex flex-wrap items-center gap-1.5">
            <span className={`text-[10.5px] font-medium ${mutedCls}`}>
              Câu hỏi mẫu:
            </span>
            {PRESET_QUERIES.map((preset) => (
              <button
                key={preset}
                type="button"
                disabled={testingRetrieval}
                onClick={() => {
                  setTestQuery(preset);
                  void executeTestRetrieval(preset);
                }}
                className={`rounded-full border px-3 py-1 text-[11px] transition-colors disabled:opacity-50 ${
                  darkMode
                    ? 'border-[#B08A4A]/35 bg-[#231912] text-[#EBCF8F] hover:border-[#EBCF8F]'
                    : 'border-[#B08A4A]/35 bg-[#FBF7EF] text-[#5C4B41] hover:border-[#1C1410] hover:bg-[#F4EBDA]'
                }`}
              >
                {preset}
              </button>
            ))}
          </div>
        </form>

        {retrievalError ? (
          <div
            role="alert"
            className={`mt-4 rounded-2xl border px-4 py-3 text-xs ${
              darkMode
                ? 'border-rose-500/45 bg-rose-950/40 text-rose-200'
                : 'border-[#8B2E2E]/35 bg-[#FFF5F4] text-[#8B2E2E]'
            }`}
          >
            {retrievalError}
          </div>
        ) : null}

        {/* Ranked Passages */}
        {retrievalResult ? (
          <div className="mt-5 space-y-3">
            {retrievalResult.passages.length === 0 ? (
              <div className={`rounded-2xl border p-6 text-center text-xs ${subCardCls}`}>
                Không tìm thấy đoạn tri thức nào khớp câu hỏi &ldquo;
                {retrievalResult.query}&rdquo; (trạng thái{' '}
                <code>NO_GROUNDED_EVIDENCE</code>).
              </div>
            ) : (
              retrievalResult.passages.map((passage, idx) => (
                <article
                  key={`${passage.id}-${idx}`}
                  data-testid={`rag-retrieval-hit-${idx + 1}`}
                  className={`rounded-2xl border p-4 ${subCardCls}`}
                >
                  <div className="flex flex-wrap items-start justify-between gap-2.5">
                    <div className="flex min-w-0 items-start gap-2.5">
                      <span className="adm-tabular flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-[#1C1410] font-mono text-[11px] font-bold text-[#EBCF8F]">
                        #{idx + 1}
                      </span>
                      <div className="min-w-0">
                        <h4 className="text-xs font-semibold leading-snug">
                          {passage.title}
                        </h4>
                        <div className="mt-1 flex flex-wrap items-center gap-1.5">
                          <span
                            className={`rounded-md border px-2 py-0.5 font-mono text-[10px] break-all ${
                              darkMode
                                ? 'border-[#B08A4A]/35 bg-[#16100C] text-[#EBCF8F]'
                                : 'border-[#B08A4A]/35 bg-white text-[#8A672C]'
                            }`}
                          >
                            {passage.sourceUri}
                          </span>
                          <span className="adm-tabular rounded-md bg-[#B08A4A]/20 px-1.5 py-0.5 font-mono text-[10px] font-semibold">
                            v{passage.version}
                          </span>
                          <span
                            className={`rounded-full border px-2 py-0.5 text-[10px] ${
                              darkMode
                                ? 'border-[#B08A4A]/30 text-[#DFD2C2]'
                                : 'border-[#B08A4A]/30 text-[#5C4B41]'
                            }`}
                          >
                            {getCategoryLabel(passage.category)}
                          </span>
                        </div>
                      </div>
                    </div>

                    {/* RRF + Vector / Keyword Score Breakdown */}
                    <div className="flex flex-wrap items-center gap-1.5 font-mono text-[10.5px]">
                      <span className="adm-tabular rounded-full border border-[#B08A4A]/60 bg-[#1C1410] px-2.5 py-1 font-semibold text-[#EBCF8F]">
                        RRF (k={retrievalResult.rrfK}): {passage.rrfScore.toFixed(4)}
                      </span>
                      <span
                        className={`adm-tabular rounded-full border px-2.5 py-1 ${
                          darkMode
                            ? 'border-emerald-500/35 bg-emerald-950/45 text-emerald-300'
                            : 'border-[#2E6B47]/30 bg-[#EBF9F1] text-[#1E4B32]'
                        }`}
                      >
                        Vector:{' '}
                        {passage.vectorScore !== null
                          ? passage.vectorScore.toFixed(3)
                          : '—'}
                        {passage.vectorRank !== null ? ` (#${passage.vectorRank})` : ''}
                      </span>
                      <span
                        className={`adm-tabular rounded-full border px-2.5 py-1 ${
                          darkMode
                            ? 'border-amber-500/35 bg-amber-950/40 text-amber-200'
                            : 'border-[#D9822B]/35 bg-[#FFF6E5] text-[#9A5B13]'
                        }`}
                      >
                        Keyword:{' '}
                        {passage.keywordScore !== null
                          ? passage.keywordScore.toFixed(3)
                          : '—'}
                        {passage.keywordRank !== null ? ` (#${passage.keywordRank})` : ''}
                      </span>
                    </div>
                  </div>

                  {/* Highlighted Snippet */}
                  <p
                    className={`mt-3 rounded-xl border p-3 text-xs leading-relaxed break-words ${
                      darkMode
                        ? 'border-[#B08A4A]/20 bg-[#140E0A] text-[#EBD9B4]/90'
                        : 'border-[#B08A4A]/18 bg-white text-[#2B2019]'
                    }`}
                  >
                    {highlightQueryTerms(
                      passage.content,
                      retrievalResult.query,
                      darkMode,
                    )}
                  </p>
                </article>
              ))
            )}
          </div>
        ) : (
          <div
            className={`mt-4 rounded-2xl border border-dashed p-5 text-center text-xs ${subCardCls}`}
          >
            Chọn nhanh một câu hỏi mẫu ở trên hoặc nhập câu hỏi của riêng bạn để xem điểm
            xếp hạng <strong>RRF (k=60)</strong>, điểm <strong>Vector / Keyword</strong> và
            trích dẫn nguồn tài liệu.
          </div>
        )}
      </section>

      {/* ==================================================================== */}
      {/* 4. Create / Edit RAG Document Modal with Live Chunk Preview          */}
      {/* ==================================================================== */}
      {modalOpen ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={
            form.id ? 'Chỉnh sửa tài liệu Tri thức RAG' : 'Thêm tài liệu Tri thức RAG mới'
          }
          className="fixed inset-0 z-50 flex items-center justify-center bg-[#0D0805]/65 p-4 backdrop-blur-xs"
        >
          <form
            onSubmit={handleSaveDocument}
            className={`max-h-[92vh] w-full max-w-3xl overflow-y-auto rounded-3xl border p-6 shadow-2xl ${cardCls}`}
          >
            <div className="flex items-start justify-between gap-4 border-b border-[#B08A4A]/20 pb-4">
              <div>
                <p className={`ledger-eyebrow ${goldTextCls}`}>
                  {form.id
                    ? 'Cập nhật Tài liệu · Tự động tăng Version & Re-Embed'
                    : 'Bổ sung Tài liệu Tri thức · Hybrid RAG Vector (768d)'}
                </p>
                <h3 className="font-editorial mt-0.5 text-2xl">
                  {form.id
                    ? `Chỉnh sửa tài liệu (${form.id})`
                    : 'Tạo Tài liệu Tri thức AI mới'}
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setModalOpen(false)}
                className="rounded-full border border-[#B08A4A]/40 px-3 py-1 text-xs"
              >
                Đóng
              </button>
            </div>

            {formError ? (
              <div
                role="alert"
                className="mt-4 rounded-2xl border border-[#8B2E2E]/40 bg-[#FFF5F4] px-4 py-2.5 text-xs text-[#8B2E2E]"
              >
                {formError}
              </div>
            ) : null}

            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <label className="text-xs sm:col-span-2">
                <span className={secondaryCls}>Tiêu đề tài liệu (title) *</span>
                <input
                  type="text"
                  required
                  data-testid="rag-form-title"
                  value={form.title}
                  onChange={(e) => setForm({ ...form, title: e.target.value })}
                  placeholder="VD: Chính sách Bảo hành & Chỉnh sửa số đo May đo Cao cấp 2026"
                  className={`mt-1 w-full rounded-xl border px-3.5 py-2.5 text-xs outline-none ${inputCls}`}
                />
              </label>

              <label className="text-xs">
                <span className={secondaryCls}>Danh mục (category) *</span>
                <select
                  data-testid="rag-form-category"
                  value={form.category}
                  onChange={(e) => {
                    const nextCat = e.target.value as Exclude<RagCategoryKey, 'all'>;
                    const catMeta = RAG_CATEGORIES.find((c) => c.key === nextCat);
                    setForm((prev) => ({
                      ...prev,
                      category: nextCat,
                      domain: prev.id
                        ? prev.domain
                        : (catMeta?.defaultDomain ?? nextCat),
                    }));
                  }}
                  className={`mt-1 w-full rounded-xl border px-3.5 py-2.5 text-xs outline-none ${inputCls}`}
                >
                  {RAG_CATEGORIES.map((cat) => (
                    <option key={cat.key} value={cat.key}>
                      {cat.label} ({cat.key})
                    </option>
                  ))}
                </select>
              </label>

              <label className="text-xs">
                <span className={secondaryCls}>Miền nghiệp vụ (domain) *</span>
                <input
                  type="text"
                  required
                  data-testid="rag-form-domain"
                  value={form.domain}
                  onChange={(e) => setForm({ ...form, domain: e.target.value })}
                  placeholder="policy_rma, operations_sop, fabric_care, sizing..."
                  className={`mt-1 w-full rounded-xl border px-3.5 py-2.5 font-mono text-xs outline-none ${inputCls}`}
                />
              </label>

              <label className="text-xs sm:col-span-2">
                <span className={secondaryCls}>
                  Nguồn trích dẫn URI (sourceUri — bỏ trống để tự sinh theo tiêu đề)
                </span>
                <input
                  type="text"
                  data-testid="rag-form-source-uri"
                  value={form.sourceUri}
                  onChange={(e) =>
                    setForm({ ...form, sourceUri: e.target.value })
                  }
                  placeholder="atelier://policies/bao-hanh-may-do-2026-v1"
                  className={`mt-1 w-full rounded-xl border px-3.5 py-2.5 font-mono text-xs outline-none ${inputCls}`}
                />
              </label>

              <div className="sm:col-span-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <label htmlFor="rag-form-content" className={`text-xs ${secondaryCls}`}>
                    Nội dung tài liệu (Markdown / Văn bản thuần) *
                  </label>
                  <div className="flex flex-wrap items-center gap-2 font-mono text-[10.5px]">
                    <span className={mutedCls}>
                      {form.content.trim().length} ký tự
                    </span>
                    <span
                      data-testid="rag-chunk-estimate"
                      className={`rounded-full border px-2.5 py-0.5 font-semibold ${
                        darkMode
                          ? 'border-[#EBCF8F]/45 bg-[#2D2116] text-[#EBCF8F]'
                          : 'border-[#B08A4A]/45 bg-[#FEF4E1] text-[#8A672C]'
                      }`}
                    >
                      Ước tính: {estimatedChunks.length} chunk
                      {estimatedChunks.length > 1 ? 's' : ''} (700/120)
                    </span>
                  </div>
                </div>

                <textarea
                  id="rag-form-content"
                  data-testid="rag-form-content"
                  required
                  rows={10}
                  value={form.content}
                  onChange={(e) =>
                    setForm({ ...form, content: e.target.value })
                  }
                  placeholder="Nhập đầy đủ quy định, con số, điều kiện áp dụng bằng tiếng Việt chuẩn để mô hình nomic-embed-text lập chỉ mục chính xác..."
                  className={`mt-1.5 w-full rounded-2xl border px-3.5 py-3 font-mono text-xs leading-relaxed outline-none ${inputCls}`}
                />

                {estimatedChunks.length > 1 ? (
                  <div className={`mt-2 rounded-2xl border p-3 ${subCardCls}`}>
                    <p className={`text-[10.5px] font-semibold ${goldTextCls}`}>
                      Xem trước phân đoạn gối đầu (Context-Overlapping Chunks):
                    </p>
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {estimatedChunks.map((chunk, idx) => (
                        <span
                          key={idx}
                          className={`rounded-lg border px-2 py-0.5 font-mono text-[10px] ${
                            darkMode
                              ? 'border-[#B08A4A]/30 bg-[#16100C] text-[#DFD2C2]'
                              : 'border-[#B08A4A]/30 bg-white text-[#5C4B41]'
                          }`}
                        >
                          Chunk #{idx + 1}: {chunk.length} ký tự
                        </span>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            </div>

            <div className="mt-6 flex justify-end gap-2.5 border-t border-[#B08A4A]/20 pt-4">
              <button
                type="button"
                onClick={() => setModalOpen(false)}
                className="rounded-full border border-[#B08A4A]/40 px-4 py-2 text-xs"
              >
                Hủy
              </button>
              <button
                type="submit"
                disabled={savingDoc}
                data-testid="rag-form-submit-btn"
                className={`rounded-full px-6 py-2 text-xs font-semibold uppercase tracking-[0.12em] disabled:opacity-50 ${
                  darkMode
                    ? 'bg-[#EBCF8F] text-[#1C1410]'
                    : 'bg-[#1C1410] text-[#EBCF8F]'
                }`}
              >
                {savingDoc
                  ? 'Đang lưu & Nhúng Vector...'
                  : form.id
                    ? 'Lưu phiên bản mới'
                    : 'Lưu & Lập chỉ mục'}
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </div>
  );
}
