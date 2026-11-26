'use client';

import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  FitFeedback,
  FitType,
  Gender,
  Permission,
  ProductStatus,
  SizeCode,
  StretchLevel,
  SubmissionStatus,
  TryOnGarmentCategory,
  canReadCostPrice,
  hasPermission,
  type CategoryDto,
  type ProductFitStatsDto,
  type ProductSpuDto,
  type Role,
  type SkuDto,
  type SupplierProductSubmissionDto,
  type VerifiedReviewDto,
} from '@atelier/contracts';
import {
  AnimatedTelemetryNumber,
  LiveStackedHealthBar,
} from '@atelier/motion-kit';
import {
  adminFetch,
  getAdminSession,
  type AdminStoredSession,
} from '@/lib/api-client';
import { emitPortalToast } from '../PortalToastBanner';

export interface CatalogMatrixNotifyPayload {
  kind: 'success' | 'error' | 'info';
  title?: string;
  message: string;
}

export interface CatalogMatrixTabProps {
  roles?: readonly Role[];
  session?: AdminStoredSession | null;
  mfaVerified?: boolean;
  darkMode?: boolean;
  onNotify?: (payload: CatalogMatrixNotifyPayload) => void;
  onRefreshOverview?: () => void;
}

type SentimentLabel = 'POSITIVE' | 'NEUTRAL' | 'NEGATIVE';
type ReviewSentimentFilter = 'ALL' | SentimentLabel | 'FIT_ISSUE';

interface AdminProductReviewItem extends VerifiedReviewDto {
  sentimentLabel?: SentimentLabel;
  diemCamXucNlp?: number | null;
  fitFeedbackLabelVi?: string;
}

interface ProductSentimentSummary {
  positivePct: number;
  neutralPct: number;
  negativePct: number;
  positiveCount?: number;
  neutralCount?: number;
  negativeCount?: number;
  averageSentimentScore: number;
  totalScored: number;
}

interface ProductReviewsPayload {
  productId: string;
  fitStats: ProductFitStatsDto | null;
  sentimentSummary?: ProductSentimentSummary;
  reviews: AdminProductReviewItem[];
  total: number;
}

interface ProductReviewsCacheEntry {
  loading: boolean;
  error: string | null;
  data: ProductReviewsPayload | null;
}

interface ProductEditFormState {
  id: string;
  name: string;
  subtitle: string;
  categorySlug: string;
  description: string;
  fabricComposition: string;
  fabricWeight: string;
  fitType: FitType;
  stretchLevel: StretchLevel;
  gender: Gender;
  isTryonEnabled: boolean;
  tryonGarmentCategory: TryOnGarmentCategory;
  fitCalibrationNote: string;
  status: ProductStatus;
}

interface VariantCreateFormState {
  productId: string;
  productName: string;
  colorName: string;
  colorHex: string;
  sizeCode: SizeCode;
  skuCode: string;
  priceVnd: string;
  costPriceVnd: string;
  barcode: string;
  weightGrams: string;
  isActive: boolean;
}

interface PaginationState {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

const FORMAT_VND = (v: number): string =>
  `${new Intl.NumberFormat('vi-VN').format(Math.round(v))}₫`;

const SIZE_OPTIONS: readonly SizeCode[] = [
  SizeCode.XS,
  SizeCode.S,
  SizeCode.M,
  SizeCode.L,
  SizeCode.XL,
  SizeCode.XXL,
  SizeCode.FREESIZE,
];

const SENTIMENT_BADGE_META: Record<
  SentimentLabel,
  { labelVi: string; badgeCls: string; dotCls: string }
> = {
  POSITIVE: {
    labelVi: 'Tích cực',
    badgeCls: 'border-emerald-300 bg-emerald-50 text-emerald-800',
    dotCls: 'bg-emerald-600',
  },
  NEUTRAL: {
    labelVi: 'Trung lập',
    badgeCls: 'border-amber-300 bg-amber-50 text-amber-900',
    dotCls: 'bg-amber-500',
  },
  NEGATIVE: {
    labelVi: 'Tiêu cực',
    badgeCls: 'border-rose-300 bg-rose-50 text-rose-800',
    dotCls: 'bg-rose-600',
  },
};

function resolveReviewSentiment(review: AdminProductReviewItem): {
  score: number;
  label: SentimentLabel;
} {
  const rawScore = review.sentimentScore ?? review.diemCamXucNlp;
  const score =
    typeof rawScore === 'number' && Number.isFinite(rawScore)
      ? Math.round(Math.min(1, Math.max(-1, rawScore)) * 100) / 100
      : 0;

  if (
    review.sentimentLabel === 'POSITIVE' ||
    review.sentimentLabel === 'NEUTRAL' ||
    review.sentimentLabel === 'NEGATIVE'
  ) {
    return { score, label: review.sentimentLabel };
  }

  if (score >= 0.2) return { score, label: 'POSITIVE' };
  if (score <= -0.2) return { score, label: 'NEGATIVE' };
  return { score, label: 'NEUTRAL' };
}

function resolveSentimentSummary(
  payload: ProductReviewsPayload,
): ProductSentimentSummary {
  if (payload.sentimentSummary) {
    return payload.sentimentSummary;
  }

  const list = payload.reviews ?? [];
  const totalScored = list.length;
  if (totalScored === 0) {
    return {
      positivePct: 0,
      neutralPct: 0,
      negativePct: 0,
      positiveCount: 0,
      neutralCount: 0,
      negativeCount: 0,
      averageSentimentScore: 0,
      totalScored: 0,
    };
  }

  let positiveCount = 0;
  let neutralCount = 0;
  let negativeCount = 0;
  let scoreSum = 0;

  for (const r of list) {
    const { score, label } = resolveReviewSentiment(r);
    scoreSum += score;
    if (label === 'POSITIVE') positiveCount += 1;
    else if (label === 'NEGATIVE') negativeCount += 1;
    else neutralCount += 1;
  }

  const positivePct = Math.round((positiveCount / totalScored) * 100);
  const negativePct = Math.round((negativeCount / totalScored) * 100);
  const neutralPct = Math.max(0, 100 - positivePct - negativePct);

  return {
    positivePct,
    neutralPct,
    negativePct,
    positiveCount,
    neutralCount,
    negativeCount,
    averageSentimentScore: Math.round((scoreSum / totalScored) * 1000) / 1000,
    totalScored,
  };
}

function formatFitFeedbackBadge(review: AdminProductReviewItem): {
  label: string;
  cls: string;
} {
  if (review.fitFeedback === FitFeedback.RUNS_SMALL) {
    return {
      label: review.fitFeedbackLabelVi || 'Hơi chật',
      cls: 'border-rose-200 bg-rose-50 text-rose-800',
    };
  }
  if (review.fitFeedback === FitFeedback.RUNS_LARGE) {
    return {
      label: review.fitFeedbackLabelVi || 'Hơi rộng',
      cls: 'border-amber-200 bg-amber-50 text-amber-900',
    };
  }
  return {
    label: review.fitFeedbackLabelVi || 'Chuẩn size',
    cls: 'border-emerald-200 bg-emerald-50 text-emerald-800',
  };
}

function formatReviewDate(iso: string | undefined): string {
  if (!iso) return '—';
  try {
    return new Intl.DateTimeFormat('vi-VN', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    }).format(new Date(iso));
  } catch {
    return iso.slice(0, 10);
  }
}

export function CatalogMatrixTab({
  roles: rolesProp,
  session: sessionProp,
  darkMode = false,
  onNotify,
  onRefreshOverview,
}: CatalogMatrixTabProps) {
  const effectiveSession = sessionProp ?? getAdminSession();
  const roles = useMemo(
    () => rolesProp ?? effectiveSession?.user.roles ?? ([] as readonly Role[]),
    [rolesProp, effectiveSession],
  );
  const showCostPrice = canReadCostPrice(roles);
  const canWriteCatalog = hasPermission(roles, Permission.CATALOG_PRODUCT_WRITE);

  const notify = useCallback(
    (payload: CatalogMatrixNotifyPayload) => {
      if (onNotify) onNotify(payload);
      else emitPortalToast(payload);
    },
    [onNotify],
  );

  const [products, setProducts] = useState<ProductSpuDto[]>([]);
  const [pagination, setPagination] = useState<PaginationState>({
    page: 1,
    limit: 12,
    total: 0,
    totalPages: 1,
  });
  const [categories, setCategories] = useState<CategoryDto[]>([]);
  const [submissions, setSubmissions] = useState<SupplierProductSubmissionDto[]>(
    [],
  );

  // Search & Pagination filters
  const [searchQuery, setSearchQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('ALL');
  const [statusFilter, setStatusFilter] = useState<'ALL' | ProductStatus>('ALL');
  const [includeArchived, setIncludeArchived] = useState(false);
  const [page, setPage] = useState(1);

  const [expandedProductId, setExpandedProductId] = useState<string | null>(null);
  const [reviewsOpenProductId, setReviewsOpenProductId] = useState<string | null>(
    null,
  );
  const [reviewsByProduct, setReviewsByProduct] = useState<
    Record<string, ProductReviewsCacheEntry>
  >({});
  const [reviewFilterByProduct, setReviewFilterByProduct] = useState<
    Record<string, ReviewSentimentFilter>
  >({});
  const [loading, setLoading] = useState(true);
  const [feedback, setFeedback] = useState<string | null>(null);

  // Create Product quick form
  const [newName, setNewName] = useState('');
  const [newCategorySlug, setNewCategorySlug] = useState('ao-blazer');
  const [newFabric, setNewFabric] = useState('100% Lụa Tơ Tằm 19 momme');
  const [newPrice, setNewPrice] = useState('2450000');
  const [newCostPrice, setNewCostPrice] = useState('1150000');

  // SKU price edit draft map
  const [skuPriceDrafts, setSkuPriceDrafts] = useState<
    Record<string, { salePriceVnd: string; costPriceVnd: string }>
  >({});

  // Full SPU Edit Modal
  const [editingProduct, setEditingProduct] =
    useState<ProductEditFormState | null>(null);
  const [savingProductEdit, setSavingProductEdit] = useState(false);

  // Create Variant / SKU Modal
  const [variantForm, setVariantForm] = useState<VariantCreateFormState | null>(
    null,
  );
  const [savingVariant, setSavingVariant] = useState(false);

  // Archive Confirmation
  const [confirmArchiveId, setConfirmArchiveId] = useState<string | null>(null);
  const [archivingId, setArchivingId] = useState<string | null>(null);

  // Real Admin Review Comments per B2B Partner Submission (ZERO hardcoded comment!)
  const [submissionComments, setSubmissionComments] = useState<
    Record<string, string>
  >({});
  const [reviewingSubmissionId, setReviewingSubmissionId] = useState<
    string | null
  >(null);

  const loadAll = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams();
    params.set('page', String(page));
    params.set('limit', '12');
    params.set('pageSize', '12');
    if (searchQuery.trim()) params.set('q', searchQuery.trim());
    if (categoryFilter !== 'ALL') params.set('categorySlug', categoryFilter);
    if (statusFilter !== 'ALL') params.set('status', statusFilter);
    if (includeArchived || statusFilter === ProductStatus.ARCHIVED) {
      params.set('includeArchived', 'true');
    }

    const [prodRes, catRes, subRes] = await Promise.all([
      adminFetch<
        | ProductSpuDto[]
        | {
            items?: ProductSpuDto[];
            total?: number;
            page?: number;
            pageSize?: number;
            pagination?: Partial<PaginationState>;
          }
      >(`/api/v1/admin/products?${params.toString()}`),
      adminFetch<CategoryDto[] | { items: CategoryDto[] }>(
        '/api/v1/admin/categories',
      ),
      adminFetch<
        SupplierProductSubmissionDto[] | { items: SupplierProductSubmissionDto[] }
      >('/api/v1/admin/submissions'),
    ]);

    if (prodRes.ok && prodRes.data) {
      const dataObj = prodRes.data;
      const list = Array.isArray(dataObj) ? dataObj : (dataObj.items ?? []);
      setProducts(list);

      if (Array.isArray(dataObj)) {
        setPagination({
          page,
          limit: 12,
          total: list.length,
          totalPages: Math.max(1, Math.ceil(list.length / 12)),
        });
      } else {
        const pag = dataObj.pagination;
        const total =
          typeof pag?.total === 'number'
            ? pag.total
            : typeof dataObj.total === 'number'
              ? dataObj.total
              : list.length;
        const lim =
          typeof pag?.limit === 'number'
            ? pag.limit
            : typeof dataObj.pageSize === 'number'
              ? dataObj.pageSize
              : 12;
        const curPage =
          typeof pag?.page === 'number'
            ? pag.page
            : typeof dataObj.page === 'number'
              ? dataObj.page
              : page;
        const totalPages =
          typeof pag?.totalPages === 'number'
            ? pag.totalPages
            : Math.max(1, Math.ceil(total / Math.max(1, lim)));
        setPagination({ page: curPage, limit: lim, total, totalPages });
      }
    }

    if (catRes.ok && catRes.data) {
      const list = Array.isArray(catRes.data)
        ? catRes.data
        : (catRes.data.items ?? []);
      setCategories(list);
      if (list[0] && !list.some((c) => c.slug === newCategorySlug)) {
        setNewCategorySlug(list[0].slug);
      }
    }

    if (subRes.ok && subRes.data) {
      const list = Array.isArray(subRes.data)
        ? subRes.data
        : (subRes.data.items ?? []);
      setSubmissions(list);
    }
    setLoading(false);
  }, [page, searchQuery, categoryFilter, statusFilter, includeArchived, newCategorySlug]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const loadProductReviews = useCallback(async (productId: string) => {
    setReviewsByProduct((prev) => ({
      ...prev,
      [productId]: {
        loading: true,
        error: null,
        data: prev[productId]?.data ?? null,
      },
    }));

    let res = await adminFetch<ProductReviewsPayload>(
      `/api/v1/admin/products/${encodeURIComponent(productId)}/reviews`,
    );

    if (!res.ok && res.status === 404) {
      res = await adminFetch<ProductReviewsPayload>(
        `/bff/v1/storefront/reviews/products/${encodeURIComponent(productId)}`,
      );
    }

    if (res.ok && res.data) {
      setReviewsByProduct((prev) => ({
        ...prev,
        [productId]: {
          loading: false,
          error: null,
          data: {
            productId: res.data!.productId ?? productId,
            fitStats: res.data!.fitStats ?? null,
            sentimentSummary: res.data!.sentimentSummary,
            reviews: Array.isArray(res.data!.reviews) ? res.data!.reviews : [],
            total:
              typeof res.data!.total === 'number'
                ? res.data!.total
                : Array.isArray(res.data!.reviews)
                  ? res.data!.reviews.length
                  : 0,
          },
        },
      }));
    } else {
      setReviewsByProduct((prev) => ({
        ...prev,
        [productId]: {
          loading: false,
          error:
            res.error?.message ||
            'Chưa thể tải đánh giá & phân tích cảm xúc NLP của sản phẩm này.',
          data: prev[productId]?.data ?? null,
        },
      }));
    }
  }, []);

  const handleToggleProductReviews = (productId: string) => {
    if (reviewsOpenProductId === productId) {
      setReviewsOpenProductId(null);
      return;
    }
    setReviewsOpenProductId(productId);
    if (!reviewsByProduct[productId]?.data && !reviewsByProduct[productId]?.loading) {
      void loadProductReviews(productId);
    }
  };

  const handleCreateProduct = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canWriteCatalog) return;
    setFeedback(null);

    const payload: Record<string, unknown> = {
      name: newName.trim(),
      categorySlug: newCategorySlug,
      fabricComposition: newFabric.trim(),
      basePriceVnd: Number(newPrice),
      salePriceVnd: Number(newPrice),
      isTryonEnabled: true,
    };
    if (showCostPrice && newCostPrice.trim()) {
      payload.costPriceVnd = Number(newCostPrice);
    }

    const res = await adminFetch<ProductSpuDto>('/api/v1/admin/products', {
      method: 'POST',
      body: JSON.stringify(payload),
    });

    if (res.ok) {
      setNewName('');
      const msg = 'Đã tạo SPU sản phẩm mới và xóa cache Storefront.';
      setFeedback(msg);
      notify({ kind: 'success', title: 'TẠO SPU MỚI', message: msg });
      await loadAll();
      onRefreshOverview?.();
    } else {
      const msg = res.error?.message || 'Tạo sản phẩm thất bại.';
      setFeedback(msg);
      notify({ kind: 'error', title: 'LỖI TẠO SPU', message: msg });
    }
  };

  const openEditProductModal = (product: ProductSpuDto) => {
    setEditingProduct({
      id: product.id,
      name: product.name,
      subtitle: product.subtitle ?? '',
      categorySlug: product.categorySlug,
      description: product.description ?? '',
      fabricComposition: product.fabricComposition ?? '',
      fabricWeight: String(product.fabricWeight ?? ''),
      fitType: product.fitType ?? FitType.REGULAR,
      stretchLevel: product.stretchLevel ?? StretchLevel.NONE,
      gender: product.gender ?? Gender.WOMEN,
      isTryonEnabled: Boolean(product.isTryonEnabled),
      tryonGarmentCategory:
        product.tryonGarmentCategory ?? TryOnGarmentCategory.UPPER,
      fitCalibrationNote: product.fitCalibrationNote ?? '',
      status: product.status ?? ProductStatus.PUBLISHED,
    });
  };

  const handleSaveProductEdit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editingProduct || !canWriteCatalog) return;

    setSavingProductEdit(true);
    const res = await adminFetch<ProductSpuDto>(
      `/api/v1/admin/products/${encodeURIComponent(editingProduct.id)}`,
      {
        method: 'PATCH',
        body: JSON.stringify({
          name: editingProduct.name.trim(),
          subtitle: editingProduct.subtitle.trim() || null,
          categorySlug: editingProduct.categorySlug,
          description: editingProduct.description.trim(),
          fabricComposition: editingProduct.fabricComposition.trim(),
          fabricWeight: editingProduct.fabricWeight.trim() || '190gsm',
          fitType: editingProduct.fitType,
          stretchLevel: editingProduct.stretchLevel,
          gender: editingProduct.gender,
          isTryonEnabled: editingProduct.isTryonEnabled,
          tryonGarmentCategory: editingProduct.tryonGarmentCategory,
          fitCalibrationNote: editingProduct.fitCalibrationNote.trim() || null,
          status: editingProduct.status,
        }),
      },
    );
    setSavingProductEdit(false);

    if (res.ok) {
      const msg = `Đã cập nhật SPU "${editingProduct.name}" và làm mới cache Storefront.`;
      setEditingProduct(null);
      setFeedback(msg);
      notify({ kind: 'success', title: 'CẬP NHẬT SPU', message: msg });
      await loadAll();
      onRefreshOverview?.();
    } else {
      notify({
        kind: 'error',
        title: 'CẬP NHẬT SPU THẤT BẠI',
        message: res.error?.message || 'Không thể cập nhật thông tin SPU.',
      });
    }
  };

  const openAddVariantModal = (product: ProductSpuDto) => {
    const slugPrefix = product.slug
      .replace(/[^a-z0-9]/gi, '')
      .toUpperCase()
      .slice(0, 6);
    setVariantForm({
      productId: product.id,
      productName: product.name,
      colorName: 'Kem Ngà',
      colorHex: '#F4EBDA',
      sizeCode: SizeCode.M,
      skuCode: `TX-${slugPrefix}-KEM-M`,
      priceVnd: String(product.minPriceVnd || 2250000),
      costPriceVnd: '',
      barcode: '',
      weightGrams: '350',
      isActive: true,
    });
  };

  const handleSaveNewVariant = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!variantForm || !canWriteCatalog) return;

    const priceNum = Math.max(0, Math.round(Number(variantForm.priceVnd || 0)));
    const payload: Record<string, unknown> = {
      sku: variantForm.skuCode.trim().toUpperCase(),
      skuCode: variantForm.skuCode.trim().toUpperCase(),
      size: variantForm.sizeCode,
      sizeCode: variantForm.sizeCode,
      colorName: variantForm.colorName.trim(),
      colorHex: variantForm.colorHex.trim() || '#1C1410',
      priceVnd: priceNum,
      basePriceVnd: priceNum,
      salePriceVnd: priceNum,
      barcode: variantForm.barcode.trim() || null,
      weightGrams: Math.max(0, Math.round(Number(variantForm.weightGrams || 350))),
      isActive: variantForm.isActive,
      isReturnable: true,
    };

    if (showCostPrice && variantForm.costPriceVnd.trim()) {
      payload.costPriceVnd = Math.max(
        0,
        Math.round(Number(variantForm.costPriceVnd)),
      );
    }

    setSavingVariant(true);
    const res = await adminFetch<unknown>(
      `/api/v1/admin/products/${encodeURIComponent(variantForm.productId)}/variants`,
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
    );
    setSavingVariant(false);

    if (res.ok) {
      const msg = `Đã thêm Variant / SKU ${String(payload.skuCode)} vào ${variantForm.productName}.`;
      setExpandedProductId(variantForm.productId);
      setVariantForm(null);
      setFeedback(msg);
      notify({ kind: 'success', title: 'THÊM VARIANT / SKU', message: msg });
      await loadAll();
      onRefreshOverview?.();
    } else {
      notify({
        kind: 'error',
        title: 'THÊM VARIANT THẤT BẠI',
        message: res.error?.message || 'Không thể thêm biến thể / SKU mới.',
      });
    }
  };

  const handleArchiveProduct = async (product: ProductSpuDto) => {
    if (!canWriteCatalog) return;
    setArchivingId(product.id);
    const res = await adminFetch<unknown>(
      `/api/v1/admin/products/${encodeURIComponent(product.id)}`,
      { method: 'DELETE' },
    );
    setArchivingId(null);
    setConfirmArchiveId(null);

    if (res.ok) {
      const msg = `Đã lưu trữ SPU "${product.name}" (ARCHIVED) và cập nhật Storefront.`;
      setFeedback(msg);
      notify({ kind: 'success', title: 'LƯU TRỮ SPU', message: msg });
      await loadAll();
      onRefreshOverview?.();
    } else {
      notify({
        kind: 'error',
        title: 'LƯU TRỮ THẤT BẠI',
        message: res.error?.message || 'Không thể lưu trữ sản phẩm.',
      });
    }
  };

  const handleUpdateSku = async (sku: SkuDto) => {
    if (!canWriteCatalog) return;
    const draft = skuPriceDrafts[sku.id];
    const salePriceVnd = Number(draft?.salePriceVnd ?? sku.salePriceVnd);
    const body: Record<string, unknown> = {
      salePriceVnd,
      basePriceVnd: salePriceVnd,
    };
    if (showCostPrice && draft?.costPriceVnd && draft.costPriceVnd.trim()) {
      body.costPriceVnd = Number(draft.costPriceVnd);
    }

    setFeedback(null);
    const res = await adminFetch<SkuDto>(
      `/api/v1/admin/skus/${encodeURIComponent(sku.id)}`,
      {
        method: 'PATCH',
        body: JSON.stringify(body),
      },
    );

    if (res.ok) {
      const msg = `Đã cập nhật SKU ${sku.skuCode} (${FORMAT_VND(salePriceVnd)}) · Đã ghi audit_logs và xóa cache Redis Storefront.`;
      setFeedback(msg);
      notify({ kind: 'success', title: 'CẬP NHẬT SKU', message: msg });
      await loadAll();
    } else {
      const msg = res.error?.message || 'Cập nhật SKU thất bại.';
      setFeedback(msg);
      notify({ kind: 'error', title: 'LỖI CẬP NHẬT SKU', message: msg });
    }
  };

  const handleReviewSubmission = async (
    id: string,
    decision: 'APPROVED' | 'REJECTED',
  ) => {
    if (!canWriteCatalog) return;
    const note = (submissionComments[id] ?? '').trim();
    if (!note) {
      const msg =
        decision === 'REJECTED'
          ? 'Vui lòng nhập nhận xét lý do từ chối gửi cho Đối tác B2B trước khi xác nhận.'
          : 'Vui lòng nhập nhận xét kiểm duyệt mẫu gửi cho Đối tác B2B trước khi phê duyệt.';
      setFeedback(msg);
      notify({ kind: 'error', title: 'THIẾU GHI CHÚ DUYỆT MẪU', message: msg });
      return;
    }

    setReviewingSubmissionId(id);
    setFeedback(null);
    const res = await adminFetch<SupplierProductSubmissionDto>(
      `/api/v1/admin/submissions/${encodeURIComponent(id)}/review`,
      {
        method: 'PATCH',
        body: JSON.stringify({
          decision,
          reviewComment: note,
          reviewNote: note,
        }),
      },
    );
    setReviewingSubmissionId(null);

    if (res.ok) {
      const msg = `Đã cập nhật trạng thái đề xuất mẫu đối tác → ${decision} (Nhận xét: "${note}").`;
      setFeedback(msg);
      notify({ kind: 'success', title: 'DUYỆT MẪU B2B', message: msg });
      setSubmissionComments((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      await loadAll();
      onRefreshOverview?.();
    } else {
      const msg = res.error?.message || 'Không thể duyệt đề xuất mẫu.';
      setFeedback(msg);
      notify({ kind: 'error', title: 'LỖI DUYỆT MẪU', message: msg });
    }
  };

  // Theme tokens
  const cardCls = darkMode
    ? 'border-[#B08A4A]/30 bg-[#1A130E] text-[#FBF7EF]'
    : 'border-[#B08A4A]/25 bg-white text-[#1C1410]';
  const subCardCls = darkMode
    ? 'border-[#B08A4A]/25 bg-[#231912] text-[#FBF7EF]'
    : 'border-[#B08A4A]/25 bg-[#FBF7EF] text-[#1C1410]';
  const mutedCls = darkMode ? 'text-[#B4A391]' : 'text-[#7A6A5B]';
  const secondaryCls = darkMode ? 'text-[#DFD2C2]' : 'text-[#5C4B41]';
  const goldTextCls = darkMode ? 'text-[#EBCF8F]' : 'text-[#8A672C]';
  const inputCls = darkMode
    ? 'border-[#B08A4A]/35 bg-[#140E0A] text-[#FBF7EF] placeholder:text-[#8E7D6B] focus:border-[#EBCF8F]'
    : 'border-[#B08A4A]/35 bg-white text-[#1C1410] placeholder:text-[#7A6A5B] focus:border-[#1C1410]';
  const tableHeadCls = darkMode
    ? 'border-b border-[#B08A4A]/25 bg-[#241A13] text-[#EBCF8F]'
    : 'border-b border-[#B08A4A]/20 bg-[#F4EBDA]/65 text-[#8A672C]';

  return (
    <div data-testid="catalog-matrix-tab" className="space-y-8">
      {feedback ? (
        <div
          role="status"
          className={`rounded-2xl border px-5 py-3 text-xs ${
            darkMode
              ? 'border-[#EBCF8F]/40 bg-[#2A1F14] text-[#FBF7EF]'
              : 'border-[#B08A4A]/40 bg-[#F4EBDA] text-[#1C1410]'
          }`}
        >
          {feedback}
        </div>
      ) : null}

      {/* RBAC Cost-Price Indicator */}
      <div
        className={`flex flex-wrap items-center justify-between gap-3 rounded-2xl border px-5 py-3 text-xs ${cardCls}`}
      >
        <span className={secondaryCls}>
          Chính sách ẩn giá vốn (Layer 5 RBAC Field Redaction):
        </span>
        <span
          className={`rounded-full px-3 py-1 font-mono text-[11px] ${
            showCostPrice
              ? 'bg-[#2E6B47]/15 text-[#2E6B47] dark:text-emerald-300'
              : 'bg-[#8A672C]/15 text-[#8A672C] dark:text-[#EBCF8F]'
          }`}
        >
          {showCostPrice
            ? 'COST_PRICE VISIBLE (SUPER_ADMIN / WAREHOUSE_MANAGER)'
            : 'COST_PRICE HIDDEN & REDACTED (CATALOG_AI_OPERATOR / ORDER_STAFF)'}
        </span>
      </div>

      {/* Create New Product Form */}
      {canWriteCatalog ? (
        <form
          onSubmit={handleCreateProduct}
          className={`rounded-3xl border p-6 ${cardCls}`}
        >
          <p className={`ledger-eyebrow ${goldTextCls}`}>
            Tạo nhanh SPU sản phẩm mới
          </p>
          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <input
              type="text"
              required
              placeholder="Tên sản phẩm (vd: Áo Lụa Cổ Đổ)"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              className={`rounded-xl border px-3 py-2 text-xs outline-none lg:col-span-2 ${inputCls}`}
            />
            <select
              value={newCategorySlug}
              onChange={(e) => setNewCategorySlug(e.target.value)}
              className={`rounded-xl border px-3 py-2 text-xs outline-none ${inputCls}`}
            >
              {categories.length > 0 ? (
                categories.map((cat) => (
                  <option key={cat.slug} value={cat.slug}>
                    {cat.name}
                  </option>
                ))
              ) : (
                <option value={newCategorySlug}>{newCategorySlug}</option>
              )}
            </select>
            <input
              type="number"
              required
              placeholder="Giá bán (VND)"
              value={newPrice}
              onChange={(e) => setNewPrice(e.target.value)}
              className={`rounded-xl border px-3 py-2 font-mono text-xs outline-none ${inputCls}`}
            />
            {showCostPrice ? (
              <input
                type="number"
                placeholder="Giá vốn costPriceVnd"
                value={newCostPrice}
                onChange={(e) => setNewCostPrice(e.target.value)}
                className={`rounded-xl border px-3 py-2 font-mono text-xs outline-none ${inputCls}`}
              />
            ) : null}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <input
              type="text"
              required
              value={newFabric}
              onChange={(e) => setNewFabric(e.target.value)}
              placeholder="Thành phần chất liệu vải"
              className={`min-w-[240px] flex-1 rounded-xl border px-3 py-2 text-xs outline-none ${inputCls}`}
            />
            <button
              type="submit"
              className={`rounded-full px-5 py-2 text-xs uppercase tracking-[0.16em] ${
                darkMode
                  ? 'bg-[#EBCF8F] text-[#1C1410] font-semibold'
                  : 'bg-[#1C1410] text-[#EBCF8F]'
              }`}
            >
              Tạo SPU
            </button>
          </div>
        </form>
      ) : null}

      {/* SPU -> Variant -> SKU Matrix Table */}
      <section className={`overflow-hidden rounded-3xl border ${cardCls}`}>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#B08A4A]/20 px-6 py-4">
          <div>
            <p className={`ledger-eyebrow ${goldTextCls}`}>
              Catalog SPU / Variant / SKU Matrix
            </p>
            <h2 className="font-editorial mt-1 text-3xl">
              Danh mục sản phẩm (
              <AnimatedTelemetryNumber value={pagination.total} /> SPU)
            </h2>
            <div className="mt-2 max-w-md">
              <LiveStackedHealthBar
                isDark={darkMode}
                heightClass="h-2"
                segments={[
                  {
                    id: 'published',
                    label: 'Đang mở bán',
                    value: products.filter(
                      (p) => p.status === ProductStatus.PUBLISHED,
                    ).length,
                    tone: 'emerald',
                  },
                  {
                    id: 'draft',
                    label: 'Bản nháp',
                    value: products.filter(
                      (p) => p.status === ProductStatus.DRAFT,
                    ).length,
                    tone: 'amber',
                  },
                  {
                    id: 'archived',
                    label: 'Lưu trữ',
                    value: products.filter(
                      (p) => p.status === ProductStatus.ARCHIVED,
                    ).length,
                    tone: 'slate',
                  },
                ]}
              />
            </div>
          </div>

          {/* Search, Category, Status Filters */}
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="search"
              data-testid="catalog-search-input"
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value);
                setPage(1);
              }}
              placeholder="Tìm tên SPU, slug, chất liệu..."
              className={`w-56 rounded-full border px-3.5 py-1.5 text-xs outline-none ${inputCls}`}
            />
            <select
              value={categoryFilter}
              onChange={(e) => {
                setCategoryFilter(e.target.value);
                setPage(1);
              }}
              aria-label="Lọc theo danh mục"
              className={`rounded-full border px-3 py-1.5 text-xs outline-none ${inputCls}`}
            >
              <option value="ALL">Mọi danh mục</option>
              {categories.map((cat) => (
                <option key={cat.id} value={cat.slug}>
                  {cat.name}
                </option>
              ))}
            </select>
            <select
              value={statusFilter}
              onChange={(e) => {
                setStatusFilter(e.target.value as 'ALL' | ProductStatus);
                setPage(1);
              }}
              aria-label="Lọc trạng thái SPU"
              className={`rounded-full border px-3 py-1.5 text-xs outline-none ${inputCls}`}
            >
              <option value="ALL">Mọi trạng thái</option>
              <option value={ProductStatus.PUBLISHED}>PUBLISHED</option>
              <option value={ProductStatus.DRAFT}>DRAFT</option>
              <option value={ProductStatus.ARCHIVED}>ARCHIVED</option>
            </select>
            <label className={`flex cursor-pointer items-center gap-1.5 text-[11px] ${secondaryCls}`}>
              <input
                type="checkbox"
                checked={includeArchived}
                onChange={(e) => {
                  setIncludeArchived(e.target.checked);
                  setPage(1);
                }}
                className="accent-[#B08A4A]"
              />
              <span>Hiện lưu trữ</span>
            </label>
            <button
              type="button"
              onClick={() => void loadAll()}
              className="rounded-full border border-[#B08A4A]/45 px-4 py-1.5 text-xs"
            >
              Làm mới
            </button>
          </div>
        </div>

        {loading ? (
          <p className={`p-6 text-xs ${mutedCls}`}>
            Đang tải danh mục SPU/SKU...
          </p>
        ) : products.length === 0 ? (
          <p className={`p-8 text-center text-xs ${mutedCls}`}>
            Không tìm thấy sản phẩm SPU nào khớp điều kiện tìm kiếm.
          </p>
        ) : (
          <div className="divide-y divide-[#B08A4A]/15">
            {products.map((product) => {
              const expanded = expandedProductId === product.id;
              const variantsList = Array.isArray(product.variants)
                ? product.variants
                : [];
              const allSkus = variantsList.flatMap((v) =>
                (Array.isArray(v.skus) ? v.skus : []).map((s) => ({
                  ...s,
                  colorName: v.colorName,
                })),
              );
              const isArchived = product.status === ProductStatus.ARCHIVED;

              return (
                <div key={product.id} className="p-5">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <strong className="font-editorial text-2xl">
                          {product.name}
                        </strong>
                        <span className="rounded-full bg-[#F4EBDA] px-2.5 py-0.5 font-mono text-[10px] text-[#8A672C]">
                          {product.categorySlug}
                        </span>
                        <span
                          className={`rounded-full border px-2.5 py-0.5 font-mono text-[10px] ${
                            isArchived
                              ? 'border-[#8B2E2E]/40 bg-[#FFF5F4] text-[#8B2E2E]'
                              : product.status === ProductStatus.DRAFT
                                ? 'border-amber-400/45 bg-amber-50 text-amber-800'
                                : 'border-[#2E6B47]/35 bg-[#EBF9F1] text-[#1E4B32]'
                          }`}
                        >
                          {product.status}
                        </span>
                        {product.isTryonEnabled ? (
                          <span className="rounded-full bg-[#1C1410] px-2.5 py-0.5 text-[10px] text-[#EBCF8F]">
                            Try-On Ready
                          </span>
                        ) : null}
                      </div>
                      <p className={`mt-0.5 text-xs ${mutedCls}`}>
                        {product.fabricComposition} · Từ{' '}
                        <strong>{FORMAT_VND(product.minPriceVnd ?? 0)}</strong> ·{' '}
                        {variantsList.length} màu · {allSkus.length} SKUs
                      </p>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      {canWriteCatalog ? (
                        <>
                          <button
                            type="button"
                            data-testid={`catalog-edit-spu-${product.id}`}
                            onClick={() => openEditProductModal(product)}
                            className="rounded-full border border-[#B08A4A]/45 px-3.5 py-1.5 text-xs"
                          >
                            Sửa SPU
                          </button>
                          <button
                            type="button"
                            data-testid={`catalog-add-variant-${product.id}`}
                            onClick={() => openAddVariantModal(product)}
                            className={`rounded-full px-3.5 py-1.5 text-xs font-medium ${
                              darkMode
                                ? 'bg-[#EBCF8F] text-[#1C1410]'
                                : 'bg-[#1C1410] text-[#EBCF8F]'
                            }`}
                          >
                            + Thêm Variant / SKU
                          </button>
                          {!isArchived ? (
                            confirmArchiveId === product.id ? (
                              <div className="flex items-center gap-1">
                                <button
                                  type="button"
                                  disabled={archivingId === product.id}
                                  onClick={() =>
                                    void handleArchiveProduct(product)
                                  }
                                  className="rounded-full bg-[#8B2E2E] px-3 py-1.5 text-[11px] font-semibold text-white"
                                >
                                  {archivingId === product.id
                                    ? '...'
                                    : 'Xác nhận Lưu trữ'}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setConfirmArchiveId(null)}
                                  className="rounded-full border border-[#B08A4A]/40 px-2.5 py-1.5 text-[11px]"
                                >
                                  Hủy
                                </button>
                              </div>
                            ) : (
                              <button
                                type="button"
                                data-testid={`catalog-archive-spu-${product.id}`}
                                onClick={() => setConfirmArchiveId(product.id)}
                                className="rounded-full border border-[#8B2E2E]/45 px-3 py-1.5 text-xs text-[#8B2E2E] dark:text-rose-300"
                              >
                                Lưu trữ SPU
                              </button>
                            )
                          ) : null}
                        </>
                      ) : null}

                      <button
                        type="button"
                        data-testid={`product-reviews-toggle-${product.id}`}
                        onClick={() => handleToggleProductReviews(product.id)}
                        className={`rounded-full border px-3.5 py-1.5 text-xs transition-colors ${
                          reviewsOpenProductId === product.id
                            ? 'border-[#1C1410] bg-[#1C1410] text-[#EBCF8F]'
                            : 'border-[#B08A4A]/45 text-[#8A672C] dark:text-[#EBCF8F]'
                        }`}
                      >
                        {reviewsOpenProductId === product.id
                          ? 'Ẩn Đánh giá NLP'
                          : 'Đánh giá NLP'}
                      </button>

                      <button
                        type="button"
                        onClick={() =>
                          setExpandedProductId(expanded ? null : product.id)
                        }
                        className="rounded-full border border-[#B08A4A]/45 px-3.5 py-1.5 text-xs"
                      >
                        {expanded ? 'Thu gọn SKU' : 'Mở bảng SKU'}
                      </button>
                    </div>
                  </div>

                  {/* Inline Expandable Product Reviews & Sentiment NLP Panel */}
                  {reviewsOpenProductId === product.id
                    ? (() => {
                        const entry = reviewsByProduct[product.id];
                        const payload = entry?.data ?? null;
                        const summary = payload
                          ? resolveSentimentSummary(payload)
                          : null;
                        const fitStats = payload?.fitStats ?? null;
                        const activeFilter =
                          reviewFilterByProduct[product.id] ?? 'ALL';
                        const allReviews = payload?.reviews ?? [];
                        const filteredReviews = allReviews.filter((rev) => {
                          if (activeFilter === 'ALL') return true;
                          if (activeFilter === 'FIT_ISSUE') {
                            return (
                              rev.fitFeedback === FitFeedback.RUNS_SMALL ||
                              rev.fitFeedback === FitFeedback.RUNS_LARGE
                            );
                          }
                          return (
                            resolveReviewSentiment(rev).label === activeFilter
                          );
                        });
                        const hasFitWarning =
                          Boolean(fitStats) &&
                          ((fitStats?.runsSmallPct ?? 0) >= 50 ||
                            (fitStats?.runsLargePct ?? 0) >= 50);

                        return (
                          <div
                            data-testid="catalog-product-reviews-panel"
                            className={`mt-4 rounded-2xl border p-4 text-xs ${subCardCls}`}
                          >
                            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#B08A4A]/20 pb-3">
                              <div>
                                <p className={`font-mono text-[10px] uppercase tracking-[0.14em] ${goldTextCls}`}>
                                  Phân tích Cảm xúc Đánh giá NLP · @atelier/ai-harness
                                </p>
                                <h3 className="font-editorial mt-0.5 text-xl">
                                  Phản hồi chất liệu &amp; phom dáng — {product.name}
                                </h3>
                              </div>
                              <button
                                type="button"
                                disabled={entry?.loading}
                                onClick={() => void loadProductReviews(product.id)}
                                className="rounded-full border border-[#B08A4A]/45 px-3 py-1 text-[11px] disabled:opacity-50"
                              >
                                {entry?.loading
                                  ? 'Đang tải...'
                                  : 'Làm mới đánh giá'}
                              </button>
                            </div>

                            {entry?.loading && !payload ? (
                              <p className={`py-5 text-center ${mutedCls}`}>
                                Đang tải đánh giá đã xác thực &amp; điểm cảm xúc NLP...
                              </p>
                            ) : entry?.error ? (
                              <p className="mt-3 rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-rose-800">
                                {entry.error}
                              </p>
                            ) : payload && summary ? (
                              <div className="mt-3 space-y-3.5">
                                <div className={`rounded-2xl border p-3.5 ${cardCls}`}>
                                  <div className="flex flex-wrap items-center justify-between gap-2">
                                    <div className="flex flex-wrap items-center gap-2">
                                      <span
                                        data-testid="sentiment-summary-positive"
                                        className="inline-flex items-center gap-1.5 rounded-full border border-emerald-300 bg-emerald-50 px-2.5 py-0.5 font-mono text-[11px] font-semibold text-emerald-800"
                                      >
                                        <span className="h-1.5 w-1.5 rounded-full bg-emerald-600" />
                                        POSITIVE: {summary.positivePct}%
                                      </span>
                                      <span
                                        data-testid="sentiment-summary-neutral"
                                        className="inline-flex items-center gap-1.5 rounded-full border border-amber-300 bg-amber-50 px-2.5 py-0.5 font-mono text-[11px] font-semibold text-amber-900"
                                      >
                                        <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
                                        NEUTRAL: {summary.neutralPct}%
                                      </span>
                                      <span
                                        data-testid="sentiment-summary-negative"
                                        className="inline-flex items-center gap-1.5 rounded-full border border-rose-300 bg-rose-50 px-2.5 py-0.5 font-mono text-[11px] font-semibold text-rose-800"
                                      >
                                        <span className="h-1.5 w-1.5 rounded-full bg-rose-600" />
                                        NEGATIVE: {summary.negativePct}%
                                      </span>
                                    </div>
                                    <div className="flex flex-wrap items-center gap-2 font-mono text-[11px]">
                                      <span className="rounded-full bg-[#F4EBDA] px-2.5 py-0.5 font-semibold text-[#1C1410]">
                                        NLP TB:{' '}
                                        {summary.averageSentimentScore >= 0 ? '+' : ''}
                                        {summary.averageSentimentScore.toFixed(2)}
                                      </span>
                                      <span>{summary.totalScored} đánh giá</span>
                                    </div>
                                  </div>

                                  {fitStats && fitStats.totalReviews > 0 ? (
                                    <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2 border-t border-[#B08A4A]/15 pt-2 text-[11px]">
                                      <span>
                                        ★ <strong>{fitStats.averageRating.toFixed(1)}/5</strong> · Hơi chật{' '}
                                        <strong className="text-rose-700">
                                          {fitStats.runsSmallPct}%
                                        </strong>{' '}
                                        · Chuẩn size{' '}
                                        <strong className="text-emerald-700">
                                          {fitStats.trueToSizePct}%
                                        </strong>{' '}
                                        · Hơi rộng{' '}
                                        <strong className="text-amber-700">
                                          {fitStats.runsLargePct}%
                                        </strong>
                                      </span>
                                      {hasFitWarning ? (
                                        <span className="rounded-full border border-rose-300 bg-rose-50 px-2.5 py-0.5 font-mono text-[10px] font-semibold text-rose-800">
                                          CẢNH BÁO LỆCH PHOM / SIZE
                                        </span>
                                      ) : null}
                                    </div>
                                  ) : null}
                                </div>

                                <div className="flex flex-wrap gap-1.5">
                                  {(
                                    [
                                      ['ALL', `Tất cả (${allReviews.length})`],
                                      ['NEGATIVE', 'Tiêu cực'],
                                      ['NEUTRAL', 'Trung lập'],
                                      ['POSITIVE', 'Tích cực'],
                                      ['FIT_ISSUE', 'Lệch phom (Chật / Rộng)'],
                                    ] as const
                                  ).map(([key, label]) => (
                                    <button
                                      key={key}
                                      type="button"
                                      onClick={() =>
                                        setReviewFilterByProduct((prev) => ({
                                          ...prev,
                                          [product.id]: key,
                                        }))
                                      }
                                      className={`rounded-full px-3 py-1 text-[11px] ${
                                        activeFilter === key
                                          ? 'bg-[#1C1410] text-[#EBCF8F]'
                                          : 'border border-[#B08A4A]/35'
                                      }`}
                                    >
                                      {label}
                                    </button>
                                  ))}
                                </div>

                                {filteredReviews.length === 0 ? (
                                  <p className={`rounded-xl border px-4 py-5 text-center ${cardCls} ${mutedCls}`}>
                                    Không có đánh giá nào khớp bộ lọc.
                                  </p>
                                ) : (
                                  <div className="space-y-2.5">
                                    {filteredReviews.map((review) => {
                                      const sentiment =
                                        resolveReviewSentiment(review);
                                      const badgeMeta =
                                        SENTIMENT_BADGE_META[sentiment.label];
                                      const fitBadge =
                                        formatFitFeedbackBadge(review);
                                      return (
                                        <article
                                          key={review.id}
                                          data-testid="admin-review-sentiment-card"
                                          className={`rounded-xl border p-3.5 ${cardCls}`}
                                        >
                                          <div className="flex flex-wrap items-center justify-between gap-2">
                                            <div className="flex flex-wrap items-center gap-1.5">
                                              <strong>{review.reviewerName}</strong>
                                              <span className={`font-mono text-[11px] ${goldTextCls}`}>
                                                ★ {review.rating}/5
                                              </span>
                                              <span className="rounded-full bg-[#F4EBDA] px-2 py-0.5 font-mono text-[10px] text-[#5C4B41]">
                                                Size {review.sizePurchased}
                                              </span>
                                              <span
                                                className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${fitBadge.cls}`}
                                              >
                                                {fitBadge.label}
                                              </span>
                                            </div>
                                            <div className="flex items-center gap-1.5">
                                              <span
                                                data-testid="review-sentiment-badge"
                                                className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 font-mono text-[10px] font-semibold ${badgeMeta.badgeCls}`}
                                              >
                                                <span
                                                  className={`h-1.5 w-1.5 rounded-full ${badgeMeta.dotCls}`}
                                                />
                                                {sentiment.label} · {badgeMeta.labelVi} (
                                                {sentiment.score >= 0 ? '+' : ''}
                                                {sentiment.score.toFixed(2)})
                                              </span>
                                              <span className={`font-mono text-[10px] ${mutedCls}`}>
                                                {formatReviewDate(review.createdAt)}
                                              </span>
                                            </div>
                                          </div>
                                          <p className={`mt-2 leading-relaxed ${secondaryCls}`}>
                                            {review.comment}
                                          </p>
                                        </article>
                                      );
                                    })}
                                  </div>
                                )}
                              </div>
                            ) : null}
                          </div>
                        );
                      })()
                    : null}

                  {/* Expanded SKU Matrix */}
                  {expanded ? (
                    <div className="mt-4 overflow-x-auto rounded-2xl border border-[#B08A4A]/20">
                      <table className="w-full text-left text-xs">
                        <thead className={`text-[10px] uppercase tracking-[0.14em] ${tableHeadCls}`}>
                          <tr>
                            <th className="px-4 py-2.5">Mã SKU</th>
                            <th className="px-4 py-2.5">Màu / Size</th>
                            <th className="px-4 py-2.5">Giá bán (VND)</th>
                            {showCostPrice ? (
                              <th className="px-4 py-2.5">
                                Giá vốn (costPriceVnd)
                              </th>
                            ) : null}
                            <th className="px-4 py-2.5">Tồn</th>
                            {canWriteCatalog ? (
                              <th className="px-4 py-2.5 text-right">Lưu</th>
                            ) : null}
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-[#B08A4A]/15 font-mono">
                          {allSkus.map((sku) => {
                            const draft = skuPriceDrafts[sku.id];
                            const safeCostStr =
                              typeof sku.costPriceVnd === 'number'
                                ? String(sku.costPriceVnd)
                                : '';
                            return (
                              <tr key={sku.id}>
                                <td className="px-4 py-2.5 font-semibold">
                                  {sku.skuCode}
                                </td>
                                <td className="px-4 py-2.5 font-sans">
                                  {sku.colorName} ·{' '}
                                  <strong>{sku.sizeCode}</strong>
                                </td>
                                <td className="px-4 py-2.5">
                                  {canWriteCatalog ? (
                                    <input
                                      type="number"
                                      value={
                                        draft?.salePriceVnd ??
                                        String(sku.salePriceVnd ?? 0)
                                      }
                                      onChange={(e) =>
                                        setSkuPriceDrafts((prev) => ({
                                          ...prev,
                                          [sku.id]: {
                                            salePriceVnd: e.target.value,
                                            costPriceVnd:
                                              prev[sku.id]?.costPriceVnd ??
                                              safeCostStr,
                                          },
                                        }))
                                      }
                                      className={`w-32 rounded-lg border px-2.5 py-1 text-xs outline-none ${inputCls}`}
                                    />
                                  ) : (
                                    FORMAT_VND(sku.salePriceVnd ?? 0)
                                  )}
                                </td>

                                {/* STRICT RBAC: Column completely absent when !canReadCostPrice(roles) */}
                                {showCostPrice ? (
                                  <td className="px-4 py-2.5">
                                    {canWriteCatalog ? (
                                      <input
                                        type="number"
                                        value={
                                          draft?.costPriceVnd ?? safeCostStr
                                        }
                                        placeholder="—"
                                        onChange={(e) =>
                                          setSkuPriceDrafts((prev) => ({
                                            ...prev,
                                            [sku.id]: {
                                              salePriceVnd:
                                                prev[sku.id]?.salePriceVnd ??
                                                String(sku.salePriceVnd ?? 0),
                                              costPriceVnd: e.target.value,
                                            },
                                          }))
                                        }
                                        className={`w-32 rounded-lg border px-2.5 py-1 text-xs outline-none ${inputCls}`}
                                      />
                                    ) : typeof sku.costPriceVnd === 'number' ? (
                                      FORMAT_VND(sku.costPriceVnd)
                                    ) : (
                                      '—'
                                    )}
                                  </td>
                                ) : null}

                                <td className="px-4 py-2.5 font-sans">
                                  {sku.inStock ? 'Còn hàng' : 'Hết'}
                                </td>
                                {canWriteCatalog ? (
                                  <td className="px-4 py-2.5 text-right font-sans">
                                    <button
                                      type="button"
                                      onClick={() => void handleUpdateSku(sku)}
                                      className={`rounded-full px-3 py-1 text-[10px] uppercase tracking-[0.14em] ${
                                        darkMode
                                          ? 'bg-[#EBCF8F] text-[#1C1410] font-semibold'
                                          : 'bg-[#1C1410] text-[#EBCF8F]'
                                      }`}
                                    >
                                      Lưu
                                    </button>
                                  </td>
                                ) : null}
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}

        {/* Pagination Controls */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[#B08A4A]/20 px-6 py-3 text-xs">
          <span className={`font-mono text-[11px] ${mutedCls}`}>
            Trang {pagination.page} / {pagination.totalPages} · Tổng{' '}
            {pagination.total} SPU
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={page <= 1 || loading}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              className="rounded-full border border-[#B08A4A]/40 px-3 py-1 text-[11px] disabled:opacity-40"
            >
              ← Trước
            </button>
            <button
              type="button"
              disabled={page >= pagination.totalPages || loading}
              onClick={() => setPage((p) => p + 1)}
              className="rounded-full border border-[#B08A4A]/40 px-3 py-1 text-[11px] disabled:opacity-40"
            >
              Sau →
            </button>
          </div>
        </div>
      </section>

      {/* Supplier Product Submissions Review Queue (Real Admin Review Comment Input!) */}
      <section className={`overflow-hidden rounded-3xl border ${cardCls}`}>
        <div className="border-b border-[#B08A4A]/20 px-6 py-4">
          <p className={`ledger-eyebrow ${goldTextCls}`}>
            Duyệt mẫu Đối tác Nhà cung cấp (Supplier Submissions)
          </p>
          <h2 className="font-editorial mt-1 text-3xl">
            Hàng đợi duyệt mẫu mới ({submissions.length})
          </h2>
        </div>

        <div className="divide-y divide-[#B08A4A]/15">
          {submissions.map((sub) => {
            const isPending = sub.status === SubmissionStatus.PENDING_REVIEW;
            const currentComment = submissionComments[sub.id] ?? '';
            return (
              <div
                key={sub.id}
                className="flex flex-col gap-3 px-6 py-4 text-xs lg:flex-row lg:items-start lg:justify-between"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <strong className="font-editorial text-2xl">
                      {sub.proposedName}
                    </strong>
                    <span className="rounded-full bg-[#F4EBDA] px-2.5 py-0.5 font-mono text-[10px] text-[#8A672C]">
                      {sub.status}
                    </span>
                  </div>
                  <p className={`mt-1 ${mutedCls}`}>
                    Supplier: <code>{sub.supplierId}</code> · Danh mục:{' '}
                    <code>{sub.proposedCategorySlug}</code> · Chất liệu:{' '}
                    {sub.fabricComposition}
                  </p>
                  <p className={`mt-0.5 font-mono text-[11px] ${secondaryCls}`}>
                    Giá lẻ đề xuất: {FORMAT_VND(sub.suggestedRetailVnd ?? 0)}
                    {showCostPrice && typeof sub.wholesaleCostVnd === 'number'
                      ? ` · Giá sỉ: ${FORMAT_VND(sub.wholesaleCostVnd)}`
                      : ''}
                  </p>
                </div>

                {isPending ? (
                  canWriteCatalog ? (
                    <div className="w-full space-y-2 lg:w-[400px]">
                      <textarea
                        rows={2}
                        data-testid={`submission-review-comment-${sub.id}`}
                        value={currentComment}
                        onChange={(e) =>
                          setSubmissionComments((prev) => ({
                            ...prev,
                            [sub.id]: e.target.value,
                          }))
                        }
                        placeholder="Nhập nhận xét kiểm duyệt thực tế gửi Đối tác B2B (chất liệu, rập size, yêu cầu ảnh 3:4)..."
                        className={`w-full rounded-xl border px-3 py-2 text-xs outline-none ${inputCls}`}
                      />
                      <div className="flex flex-wrap items-center justify-end gap-2">
                        <button
                          type="button"
                          data-testid={`submission-approve-${sub.id}`}
                          disabled={reviewingSubmissionId === sub.id}
                          onClick={() =>
                            void handleReviewSubmission(sub.id, 'APPROVED')
                          }
                          className={`rounded-full px-4 py-1.5 text-[11px] uppercase tracking-[0.14em] disabled:opacity-45 ${
                            darkMode
                              ? 'bg-[#EBCF8F] text-[#1C1410] font-semibold'
                              : 'bg-[#1C1410] text-[#EBCF8F]'
                          }`}
                        >
                          Phê duyệt
                        </button>
                        <button
                          type="button"
                          data-testid={`submission-reject-${sub.id}`}
                          disabled={reviewingSubmissionId === sub.id}
                          onClick={() =>
                            void handleReviewSubmission(sub.id, 'REJECTED')
                          }
                          className="rounded-full border border-[#8B2E2E]/60 px-4 py-1.5 text-[11px] uppercase tracking-[0.14em] text-[#8B2E2E] disabled:opacity-45 dark:text-rose-300"
                        >
                          Từ chối
                        </button>
                      </div>
                    </div>
                  ) : (
                    <span className="rounded-full border border-[#B08A4A]/35 px-3 py-1 font-mono text-[10px]">
                      Chỉ đọc · Cần quyền catalog.product.write
                    </span>
                  )
                ) : (
                  <div className={`max-w-sm text-right ${mutedCls}`}>
                    <p className="font-medium">Nhận xét gửi Đối tác:</p>
                    <p className="mt-0.5 italic">
                      {sub.reviewComment || 'Đã xử lý'}
                    </p>
                  </div>
                )}
              </div>
            );
          })}

          {submissions.length === 0 ? (
            <p className={`p-6 text-center text-xs ${mutedCls}`}>
              Chưa có đề xuất mẫu từ đối tác nhà cung cấp.
            </p>
          ) : null}
        </div>
      </section>

      {/* Full SPU Edit Modal */}
      {editingProduct ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Chỉnh sửa SPU sản phẩm"
          className="fixed inset-0 z-50 flex items-center justify-center bg-[#0D0805]/65 p-4 backdrop-blur-xs"
        >
          <form
            onSubmit={handleSaveProductEdit}
            className={`max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-3xl border p-6 shadow-2xl ${cardCls}`}
          >
            <div className="flex items-start justify-between gap-3 border-b border-[#B08A4A]/20 pb-4">
              <div>
                <p className={`ledger-eyebrow ${goldTextCls}`}>
                  PATCH /api/v1/admin/products/:id
                </p>
                <h3 className="font-editorial mt-0.5 text-2xl">
                  Chỉnh sửa SPU: {editingProduct.name}
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setEditingProduct(null)}
                className="rounded-full border border-[#B08A4A]/40 px-3 py-1 text-xs"
              >
                Đóng
              </button>
            </div>

            <div className="mt-4 grid gap-4 text-xs sm:grid-cols-2">
              <label className="sm:col-span-2">
                <span className={secondaryCls}>Tên sản phẩm (SPU) *</span>
                <input
                  type="text"
                  required
                  value={editingProduct.name}
                  onChange={(e) =>
                    setEditingProduct({
                      ...editingProduct,
                      name: e.target.value,
                    })
                  }
                  className={`mt-1 w-full rounded-xl border px-3 py-2 outline-none ${inputCls}`}
                />
              </label>

              <label className="sm:col-span-2">
                <span className={secondaryCls}>Phụ đề editorial (subtitle)</span>
                <input
                  type="text"
                  value={editingProduct.subtitle}
                  onChange={(e) =>
                    setEditingProduct({
                      ...editingProduct,
                      subtitle: e.target.value,
                    })
                  }
                  className={`mt-1 w-full rounded-xl border px-3 py-2 outline-none ${inputCls}`}
                />
              </label>

              <label>
                <span className={secondaryCls}>Danh mục</span>
                <select
                  value={editingProduct.categorySlug}
                  onChange={(e) =>
                    setEditingProduct({
                      ...editingProduct,
                      categorySlug: e.target.value,
                    })
                  }
                  className={`mt-1 w-full rounded-xl border px-3 py-2 outline-none ${inputCls}`}
                >
                  {categories.map((cat) => (
                    <option key={cat.slug} value={cat.slug}>
                      {cat.name}
                    </option>
                  ))}
                </select>
              </label>

              <label>
                <span className={secondaryCls}>Trạng thái hiển thị</span>
                <select
                  value={editingProduct.status}
                  onChange={(e) =>
                    setEditingProduct({
                      ...editingProduct,
                      status: e.target.value as ProductStatus,
                    })
                  }
                  className={`mt-1 w-full rounded-xl border px-3 py-2 outline-none ${inputCls}`}
                >
                  <option value={ProductStatus.PUBLISHED}>PUBLISHED</option>
                  <option value={ProductStatus.DRAFT}>DRAFT</option>
                  <option value={ProductStatus.ARCHIVED}>ARCHIVED</option>
                </select>
              </label>

              <label>
                <span className={secondaryCls}>Thành phần chất liệu vải</span>
                <input
                  type="text"
                  value={editingProduct.fabricComposition}
                  onChange={(e) =>
                    setEditingProduct({
                      ...editingProduct,
                      fabricComposition: e.target.value,
                    })
                  }
                  className={`mt-1 w-full rounded-xl border px-3 py-2 outline-none ${inputCls}`}
                />
              </label>

              <label>
                <span className={secondaryCls}>Định lượng vải (fabricWeight)</span>
                <input
                  type="text"
                  value={editingProduct.fabricWeight}
                  onChange={(e) =>
                    setEditingProduct({
                      ...editingProduct,
                      fabricWeight: e.target.value,
                    })
                  }
                  className={`mt-1 w-full rounded-xl border px-3 py-2 outline-none ${inputCls}`}
                />
              </label>

              <label>
                <span className={secondaryCls}>Phom dáng (fitType)</span>
                <select
                  value={editingProduct.fitType}
                  onChange={(e) =>
                    setEditingProduct({
                      ...editingProduct,
                      fitType: e.target.value as FitType,
                    })
                  }
                  className={`mt-1 w-full rounded-xl border px-3 py-2 outline-none ${inputCls}`}
                >
                  <option value={FitType.SLIM}>SLIM</option>
                  <option value={FitType.REGULAR}>REGULAR</option>
                  <option value={FitType.RELAXED}>RELAXED</option>
                  <option value={FitType.OVERSIZE}>OVERSIZE</option>
                </select>
              </label>

              <label>
                <span className={secondaryCls}>Độ co giãn (stretchLevel)</span>
                <select
                  value={editingProduct.stretchLevel}
                  onChange={(e) =>
                    setEditingProduct({
                      ...editingProduct,
                      stretchLevel: e.target.value as StretchLevel,
                    })
                  }
                  className={`mt-1 w-full rounded-xl border px-3 py-2 outline-none ${inputCls}`}
                >
                  <option value={StretchLevel.NONE}>NONE</option>
                  <option value={StretchLevel.LIGHT}>LIGHT</option>
                  <option value={StretchLevel.HIGH}>HIGH</option>
                </select>
              </label>

              <label>
                <span className={secondaryCls}>Giới tính</span>
                <select
                  value={editingProduct.gender}
                  onChange={(e) =>
                    setEditingProduct({
                      ...editingProduct,
                      gender: e.target.value as Gender,
                    })
                  }
                  className={`mt-1 w-full rounded-xl border px-3 py-2 outline-none ${inputCls}`}
                >
                  <option value={Gender.WOMEN}>WOMEN</option>
                  <option value={Gender.MEN}>MEN</option>
                  <option value={Gender.UNISEX}>UNISEX</option>
                </select>
              </label>

              <label>
                <span className={secondaryCls}>Vùng thử đồ AI Try-On</span>
                <select
                  value={editingProduct.tryonGarmentCategory}
                  onChange={(e) =>
                    setEditingProduct({
                      ...editingProduct,
                      tryonGarmentCategory: e.target
                        .value as TryOnGarmentCategory,
                    })
                  }
                  className={`mt-1 w-full rounded-xl border px-3 py-2 outline-none ${inputCls}`}
                >
                  <option value={TryOnGarmentCategory.UPPER}>UPPER</option>
                  <option value={TryOnGarmentCategory.LOWER}>LOWER</option>
                  <option value={TryOnGarmentCategory.OVERALL}>OVERALL</option>
                  <option value={TryOnGarmentCategory.NONE}>NONE</option>
                </select>
              </label>

              <label className="sm:col-span-2">
                <span className={secondaryCls}>Mô tả chi tiết sản phẩm</span>
                <textarea
                  rows={3}
                  value={editingProduct.description}
                  onChange={(e) =>
                    setEditingProduct({
                      ...editingProduct,
                      description: e.target.value,
                    })
                  }
                  className={`mt-1 w-full rounded-xl border px-3 py-2 outline-none ${inputCls}`}
                />
              </label>

              <label className="sm:col-span-2">
                <span className={secondaryCls}>
                  Ghi chú hiệu chỉnh size (fitCalibrationNote)
                </span>
                <input
                  type="text"
                  value={editingProduct.fitCalibrationNote}
                  onChange={(e) =>
                    setEditingProduct({
                      ...editingProduct,
                      fitCalibrationNote: e.target.value,
                    })
                  }
                  className={`mt-1 w-full rounded-xl border px-3 py-2 outline-none ${inputCls}`}
                />
              </label>

              <label className="flex cursor-pointer items-center gap-2 sm:col-span-2">
                <input
                  type="checkbox"
                  checked={editingProduct.isTryonEnabled}
                  onChange={(e) =>
                    setEditingProduct({
                      ...editingProduct,
                      isTryonEnabled: e.target.checked,
                    })
                  }
                  className="accent-[#B08A4A]"
                />
                <span>Bật Phòng thử đồ ảo AI (isTryonEnabled)</span>
              </label>
            </div>

            <div className="mt-6 flex justify-end gap-2.5 border-t border-[#B08A4A]/20 pt-4">
              <button
                type="button"
                onClick={() => setEditingProduct(null)}
                className="rounded-full border border-[#B08A4A]/40 px-4 py-2 text-xs"
              >
                Hủy
              </button>
              <button
                type="submit"
                disabled={savingProductEdit}
                className={`rounded-full px-6 py-2 text-xs font-semibold uppercase tracking-[0.14em] disabled:opacity-50 ${
                  darkMode
                    ? 'bg-[#EBCF8F] text-[#1C1410]'
                    : 'bg-[#1C1410] text-[#EBCF8F]'
                }`}
              >
                {savingProductEdit ? 'Đang lưu...' : 'Lưu cập nhật SPU'}
              </button>
            </div>
          </form>
        </div>
      ) : null}

      {/* Add Variant / SKU Modal */}
      {variantForm ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Thêm Variant và SKU mới"
          className="fixed inset-0 z-50 flex items-center justify-center bg-[#0D0805]/65 p-4 backdrop-blur-xs"
        >
          <form
            onSubmit={handleSaveNewVariant}
            className={`w-full max-w-lg rounded-3xl border p-6 shadow-2xl ${cardCls}`}
          >
            <div className="flex items-start justify-between gap-3 border-b border-[#B08A4A]/20 pb-4">
              <div>
                <p className={`ledger-eyebrow ${goldTextCls}`}>
                  POST /api/v1/admin/products/:id/variants
                </p>
                <h3 className="font-editorial mt-0.5 text-2xl">
                  Thêm Variant / SKU — {variantForm.productName}
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setVariantForm(null)}
                className="rounded-full border border-[#B08A4A]/40 px-3 py-1 text-xs"
              >
                Đóng
              </button>
            </div>

            <div className="mt-4 grid gap-3.5 text-xs sm:grid-cols-2">
              <label className="sm:col-span-2">
                <span className={secondaryCls}>Mã SKU *</span>
                <input
                  type="text"
                  required
                  value={variantForm.skuCode}
                  onChange={(e) =>
                    setVariantForm({
                      ...variantForm,
                      skuCode: e.target.value.toUpperCase(),
                    })
                  }
                  placeholder="TX-BLZ-KEM-XL"
                  className={`mt-1 w-full rounded-xl border px-3 py-2 font-mono outline-none ${inputCls}`}
                />
              </label>

              <label>
                <span className={secondaryCls}>Tên màu sắc *</span>
                <input
                  type="text"
                  required
                  value={variantForm.colorName}
                  onChange={(e) =>
                    setVariantForm({
                      ...variantForm,
                      colorName: e.target.value,
                    })
                  }
                  className={`mt-1 w-full rounded-xl border px-3 py-2 outline-none ${inputCls}`}
                />
              </label>

              <label>
                <span className={secondaryCls}>Mã màu Hex</span>
                <div className="mt-1 flex items-center gap-2">
                  <input
                    type="color"
                    value={
                      /^#[0-9a-fA-F]{6}$/.test(variantForm.colorHex)
                        ? variantForm.colorHex
                        : '#1C1410'
                    }
                    onChange={(e) =>
                      setVariantForm({
                        ...variantForm,
                        colorHex: e.target.value,
                      })
                    }
                    className="h-9 w-10 rounded-lg border border-[#B08A4A]/40"
                  />
                  <input
                    type="text"
                    value={variantForm.colorHex}
                    onChange={(e) =>
                      setVariantForm({
                        ...variantForm,
                        colorHex: e.target.value,
                      })
                    }
                    className={`min-w-0 flex-1 rounded-xl border px-3 py-2 font-mono outline-none ${inputCls}`}
                  />
                </div>
              </label>

              <label>
                <span className={secondaryCls}>Cỡ Size *</span>
                <select
                  value={variantForm.sizeCode}
                  onChange={(e) =>
                    setVariantForm({
                      ...variantForm,
                      sizeCode: e.target.value as SizeCode,
                    })
                  }
                  className={`mt-1 w-full rounded-xl border px-3 py-2 outline-none ${inputCls}`}
                >
                  {SIZE_OPTIONS.map((sz) => (
                    <option key={sz} value={sz}>
                      {sz}
                    </option>
                  ))}
                </select>
              </label>

              <label>
                <span className={secondaryCls}>Giá bán (VND) *</span>
                <input
                  type="number"
                  required
                  min={0}
                  value={variantForm.priceVnd}
                  onChange={(e) =>
                    setVariantForm({
                      ...variantForm,
                      priceVnd: e.target.value,
                    })
                  }
                  className={`mt-1 w-full rounded-xl border px-3 py-2 font-mono outline-none ${inputCls}`}
                />
              </label>

              {showCostPrice ? (
                <label>
                  <span className={secondaryCls}>Giá vốn (costPriceVnd)</span>
                  <input
                    type="number"
                    min={0}
                    value={variantForm.costPriceVnd}
                    onChange={(e) =>
                      setVariantForm({
                        ...variantForm,
                        costPriceVnd: e.target.value,
                      })
                    }
                    placeholder="Tùy chọn"
                    className={`mt-1 w-full rounded-xl border px-3 py-2 font-mono outline-none ${inputCls}`}
                  />
                </label>
              ) : null}

              <label>
                <span className={secondaryCls}>Trọng lượng (gram)</span>
                <input
                  type="number"
                  min={0}
                  value={variantForm.weightGrams}
                  onChange={(e) =>
                    setVariantForm({
                      ...variantForm,
                      weightGrams: e.target.value,
                    })
                  }
                  className={`mt-1 w-full rounded-xl border px-3 py-2 font-mono outline-none ${inputCls}`}
                />
              </label>

              <label>
                <span className={secondaryCls}>Mã vạch (barcode)</span>
                <input
                  type="text"
                  value={variantForm.barcode}
                  onChange={(e) =>
                    setVariantForm({ ...variantForm, barcode: e.target.value })
                  }
                  placeholder="Tùy chọn"
                  className={`mt-1 w-full rounded-xl border px-3 py-2 font-mono outline-none ${inputCls}`}
                />
              </label>
            </div>

            <div className="mt-6 flex justify-end gap-2.5 border-t border-[#B08A4A]/20 pt-4">
              <button
                type="button"
                onClick={() => setVariantForm(null)}
                className="rounded-full border border-[#B08A4A]/40 px-4 py-2 text-xs"
              >
                Hủy
              </button>
              <button
                type="submit"
                disabled={savingVariant}
                className={`rounded-full px-6 py-2 text-xs font-semibold uppercase tracking-[0.14em] disabled:opacity-50 ${
                  darkMode
                    ? 'bg-[#EBCF8F] text-[#1C1410]'
                    : 'bg-[#1C1410] text-[#EBCF8F]'
                }`}
              >
                {savingVariant ? 'Đang tạo...' : 'Thêm Variant / SKU'}
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </div>
  );
}
