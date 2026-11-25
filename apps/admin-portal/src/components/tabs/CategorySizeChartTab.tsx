'use client';

import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  Gender,
  Permission,
  Role,
  SizeCode,
  hasPermission,
  type CategoryDto,
  type SizeChartDto,
} from '@atelier/contracts';
import {
  adminFetch,
  getAdminSession,
  type AdminStoredSession,
} from '@/lib/api-client';
import { emitPortalToast } from '../PortalToastBanner';

export interface CategorySizeChartNotifyPayload {
  kind: 'success' | 'error' | 'info';
  title?: string;
  message: string;
}

export interface CategorySizeChartTabProps {
  roles?: readonly Role[];
  session?: AdminStoredSession | null;
  mfaVerified?: boolean;
  darkMode?: boolean;
  onNotify?: (payload: CategorySizeChartNotifyPayload) => void;
  onRefreshOverview?: () => void;
}

type ManagerSubTab = 'CATEGORIES' | 'SIZE_CHARTS';
type StretchOption = 'NONE' | 'LOW' | 'MEDIUM' | 'HIGH';

interface SizeChartRowDraft {
  sizeCode: SizeCode;
  heightMinCm: string;
  heightMaxCm: string;
  weightMinKg: string;
  weightMaxKg: string;
  chestMinCm: string;
  chestMaxCm: string;
  waistMinCm: string;
  waistMaxCm: string;
  hipMinCm: string;
  hipMaxCm: string;
  shoulderCm: string;
  lengthCm: string;
}

interface NormalizedSizeChart {
  id: string;
  code: string;
  name: string;
  categoryId: string | null;
  garmentCategory: string;
  gender: Gender;
  stretchLevel: StretchOption;
  fitNote: string;
  rows: SizeChartRowDraft[];
}

interface CategoryFormState {
  id: string | null;
  name: string;
  slug: string;
  parentId: string;
  description: string;
  sortOrder: string;
  isActive: boolean;
}

interface SizeChartFormState {
  id: string | null;
  code: string;
  name: string;
  categoryId: string;
  garmentCategory: string;
  gender: Gender;
  stretchLevel: StretchOption;
  fitNote: string;
  rows: SizeChartRowDraft[];
}

const SIZE_CODE_OPTIONS: readonly SizeCode[] = [
  SizeCode.XS,
  SizeCode.S,
  SizeCode.M,
  SizeCode.L,
  SizeCode.XL,
  SizeCode.XXL,
  SizeCode.FREESIZE,
];

const STRETCH_META: Record<
  StretchOption,
  { label: string; badgeCls: string }
> = {
  NONE: {
    label: 'NONE · Không co giãn (Lụa / Linen / Tweed)',
    badgeCls: 'border-stone-400/40 bg-stone-500/10 text-stone-700 dark:text-stone-300',
  },
  LOW: {
    label: 'LOW · Co giãn nhẹ (2–5%)',
    badgeCls: 'border-amber-500/40 bg-amber-500/15 text-amber-800 dark:text-amber-300',
  },
  MEDIUM: {
    label: 'MEDIUM · Co giãn vừa (Cotton pha)',
    badgeCls: 'border-sky-500/40 bg-sky-500/15 text-sky-800 dark:text-sky-300',
  },
  HIGH: {
    label: 'HIGH · Co giãn cao (Dệt kim / Thun)',
    badgeCls: 'border-emerald-500/40 bg-emerald-500/15 text-emerald-800 dark:text-emerald-300',
  },
};

function slugifyVi(input: string): string {
  return input
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/gi, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function extractList<T>(data: unknown, keys: string[]): T[] {
  if (Array.isArray(data)) return data as T[];
  if (data && typeof data === 'object') {
    const rec = data as Record<string, unknown>;
    for (const k of keys) {
      if (Array.isArray(rec[k])) return rec[k] as T[];
    }
  }
  return [];
}

function normalizeStretchLevel(raw: unknown): StretchOption {
  const s = String(raw ?? 'NONE').toUpperCase();
  if (s === 'HIGH') return 'HIGH';
  if (s === 'MEDIUM') return 'MEDIUM';
  if (s === 'LOW' || s === 'LIGHT') return 'LOW';
  return 'NONE';
}

function numToStr(val: unknown): string {
  return typeof val === 'number' && Number.isFinite(val) ? String(val) : '';
}

function strToOptNum(val: string): number | null {
  const trimmed = val.trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

function createDefaultSizeRows(): SizeChartRowDraft[] {
  return [
    {
      sizeCode: SizeCode.S,
      heightMinCm: '152',
      heightMaxCm: '160',
      weightMinKg: '44',
      weightMaxKg: '50',
      chestMinCm: '80',
      chestMaxCm: '84',
      waistMinCm: '62',
      waistMaxCm: '66',
      hipMinCm: '86',
      hipMaxCm: '90',
      shoulderCm: '36',
      lengthCm: '62',
    },
    {
      sizeCode: SizeCode.M,
      heightMinCm: '158',
      heightMaxCm: '166',
      weightMinKg: '50',
      weightMaxKg: '56',
      chestMinCm: '84',
      chestMaxCm: '88',
      waistMinCm: '66',
      waistMaxCm: '70',
      hipMinCm: '90',
      hipMaxCm: '94',
      shoulderCm: '37.5',
      lengthCm: '64',
    },
    {
      sizeCode: SizeCode.L,
      heightMinCm: '164',
      heightMaxCm: '172',
      weightMinKg: '56',
      weightMaxKg: '64',
      chestMinCm: '88',
      chestMaxCm: '93',
      waistMinCm: '70',
      waistMaxCm: '76',
      hipMinCm: '94',
      hipMaxCm: '99',
      shoulderCm: '39',
      lengthCm: '66',
    },
  ];
}

function normalizeSizeChart(raw: Record<string, unknown>): NormalizedSizeChart {
  const rawRows = Array.isArray(raw.rows)
    ? (raw.rows as Array<Record<string, unknown>>)
    : [];

  const mappedRows: SizeChartRowDraft[] =
    rawRows.length > 0
      ? rawRows.map((r) => {
          const bust = typeof r.bustCm === 'number' ? r.bustCm : null;
          const waist = typeof r.waistCm === 'number' ? r.waistCm : null;
          const hip = typeof r.hipCm === 'number' ? r.hipCm : null;
          return {
            sizeCode: (SIZE_CODE_OPTIONS.includes(r.sizeCode as SizeCode)
              ? r.sizeCode
              : SizeCode.M) as SizeCode,
            heightMinCm: numToStr(r.heightMinCm),
            heightMaxCm: numToStr(r.heightMaxCm),
            weightMinKg: numToStr(r.weightMinKg),
            weightMaxKg: numToStr(r.weightMaxKg),
            chestMinCm: numToStr(r.chestMinCm ?? r.chestMin ?? bust),
            chestMaxCm: numToStr(r.chestMaxCm ?? r.chestMax ?? bust),
            waistMinCm: numToStr(r.waistMinCm ?? r.waistMin ?? waist),
            waistMaxCm: numToStr(r.waistMaxCm ?? r.waistMax ?? waist),
            hipMinCm: numToStr(r.hipMinCm ?? r.hipMin ?? hip),
            hipMaxCm: numToStr(r.hipMaxCm ?? r.hipMax ?? hip),
            shoulderCm: numToStr(r.shoulderCm),
            lengthCm: numToStr(r.lengthCm),
          };
        })
      : raw.sizeCode
        ? [
            {
              sizeCode: (SIZE_CODE_OPTIONS.includes(raw.sizeCode as SizeCode)
                ? raw.sizeCode
                : SizeCode.M) as SizeCode,
              heightMinCm: numToStr(raw.heightMinCm),
              heightMaxCm: numToStr(raw.heightMaxCm),
              weightMinKg: numToStr(raw.weightMinKg),
              weightMaxKg: numToStr(raw.weightMaxKg),
              chestMinCm: numToStr(raw.chestMin ?? raw.chestMinCm),
              chestMaxCm: numToStr(raw.chestMax ?? raw.chestMaxCm),
              waistMinCm: numToStr(raw.waistMin ?? raw.waistMinCm),
              waistMaxCm: numToStr(raw.waistMax ?? raw.waistMaxCm),
              hipMinCm: numToStr(raw.hipMin ?? raw.hipMinCm),
              hipMaxCm: numToStr(raw.hipMax ?? raw.hipMaxCm),
              shoulderCm: numToStr(raw.shoulderCm),
              lengthCm: numToStr(raw.lengthCm),
            },
          ]
        : [];

  const rawGender = String(raw.gender ?? 'WOMEN').toUpperCase();
  const gender: Gender =
    rawGender === 'MEN'
      ? Gender.MEN
      : rawGender === 'UNISEX'
        ? Gender.UNISEX
        : Gender.WOMEN;

  return {
    id: String(raw.id ?? ''),
    code: String(raw.code ?? ''),
    name: String(raw.name ?? 'Bảng thông số rập'),
    categoryId: typeof raw.categoryId === 'string' ? raw.categoryId : null,
    garmentCategory: String(
      raw.garmentCategory ?? raw.garmentType ?? 'UPPER',
    ),
    gender,
    stretchLevel: normalizeStretchLevel(raw.stretchLevel),
    fitNote: String(raw.fitNote ?? raw.fitNotes ?? ''),
    rows: mappedRows,
  };
}

const EMPTY_CATEGORY_FORM: CategoryFormState = {
  id: null,
  name: '',
  slug: '',
  parentId: '',
  description: '',
  sortOrder: '0',
  isActive: true,
};

const EMPTY_SIZE_CHART_FORM: SizeChartFormState = {
  id: null,
  code: '',
  name: '',
  categoryId: '',
  garmentCategory: 'ao-blazer',
  gender: Gender.WOMEN,
  stretchLevel: 'NONE',
  fitNote: '',
  rows: createDefaultSizeRows(),
};

export function CategorySizeChartTab({
  roles: rolesProp,
  session: sessionProp,
  darkMode = false,
  onNotify,
  onRefreshOverview,
}: CategorySizeChartTabProps) {
  const effectiveSession = sessionProp ?? getAdminSession();
  const roles = useMemo(
    () => rolesProp ?? effectiveSession?.user.roles ?? ([] as readonly Role[]),
    [rolesProp, effectiveSession],
  );
  const canWrite =
    roles.includes(Role.SUPER_ADMIN) ||
    hasPermission(roles, Permission.CATALOG_PRODUCT_WRITE);

  const notify = useCallback(
    (payload: CategorySizeChartNotifyPayload) => {
      if (onNotify) onNotify(payload);
      else emitPortalToast(payload);
    },
    [onNotify],
  );

  const [subTab, setSubTab] = useState<ManagerSubTab>('CATEGORIES');

  // Data
  const [categories, setCategories] = useState<CategoryDto[]>([]);
  const [sizeCharts, setSizeCharts] = useState<NormalizedSizeChart[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Category Modal
  const [catModalOpen, setCatModalOpen] = useState(false);
  const [catForm, setCatForm] =
    useState<CategoryFormState>(EMPTY_CATEGORY_FORM);
  const [catSaving, setCatSaving] = useState(false);
  const [confirmDeleteCatId, setConfirmDeleteCatId] = useState<string | null>(
    null,
  );

  // Size Chart Modal
  const [chartModalOpen, setChartModalOpen] = useState(false);
  const [chartForm, setChartForm] = useState<SizeChartFormState>(
    EMPTY_SIZE_CHART_FORM,
  );
  const [chartSaving, setChartSaving] = useState(false);
  const [confirmDeleteChartId, setConfirmDeleteChartId] = useState<
    string | null
  >(null);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setErrorMsg(null);
    const [catRes, chartRes] = await Promise.all([
      adminFetch<unknown>('/api/v1/admin/categories'),
      adminFetch<unknown>('/api/v1/admin/size-charts'),
    ]);

    if (catRes.ok) {
      const list = extractList<CategoryDto>(catRes.data, [
        'items',
        'categories',
        'list',
      ]);
      setCategories([...list].sort((a, b) => a.sortOrder - b.sortOrder));
    } else {
      setErrorMsg(
        catRes.error?.message || 'Chưa thể tải cây danh mục sản phẩm.',
      );
    }

    if (chartRes.ok) {
      const list = extractList<Record<string, unknown>>(chartRes.data, [
        'items',
        'sizeCharts',
        'charts',
        'list',
      ]);
      setSizeCharts(list.map(normalizeSizeChart));
    } else if (catRes.ok) {
      setErrorMsg(
        chartRes.error?.message || 'Chưa thể tải bảng thông số rập & size.',
      );
    }

    setLoading(false);
  }, []);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const categoryById = useMemo(() => {
    const map = new Map<string, CategoryDto>();
    categories.forEach((c) => map.set(c.id, c));
    return map;
  }, [categories]);

  // Hierarchical tree ordering (roots -> children)
  const categoryTreeRows = useMemo(() => {
    const roots = categories.filter(
      (c) => !c.parentId || !categoryById.has(c.parentId),
    );
    const childrenByParent = new Map<string, CategoryDto[]>();
    for (const c of categories) {
      if (c.parentId && categoryById.has(c.parentId)) {
        const list = childrenByParent.get(c.parentId) ?? [];
        list.push(c);
        childrenByParent.set(c.parentId, list);
      }
    }

    const ordered: Array<{ category: CategoryDto; depth: number }> = [];
    const visited = new Set<string>();
    const visit = (node: CategoryDto, depth: number) => {
      if (visited.has(node.id)) return;
      visited.add(node.id);
      ordered.push({ category: node, depth });
      const kids = childrenByParent.get(node.id) ?? [];
      kids.sort((a, b) => a.sortOrder - b.sortOrder);
      for (const kid of kids) {
        visit(kid, depth + 1);
      }
    };
    roots.sort((a, b) => a.sortOrder - b.sortOrder);
    for (const r of roots) visit(r, 0);
    for (const c of categories) {
      if (!visited.has(c.id)) ordered.push({ category: c, depth: 0 });
    }
    return ordered;
  }, [categories, categoryById]);

  // Category CRUD Handlers
  const openCreateCategory = () => {
    setCatForm({
      ...EMPTY_CATEGORY_FORM,
      sortOrder: String(categories.length + 1),
    });
    setCatModalOpen(true);
  };

  const openEditCategory = (cat: CategoryDto) => {
    setCatForm({
      id: cat.id,
      name: cat.name,
      slug: cat.slug,
      parentId: cat.parentId ?? '',
      description: cat.description ?? '',
      sortOrder: String(cat.sortOrder),
      isActive: cat.isActive,
    });
    setCatModalOpen(true);
  };

  const handleSaveCategory = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canWrite) return;

    const name = catForm.name.trim();
    const slug = (catForm.slug.trim() || slugifyVi(name)).trim();
    if (name.length < 2 || slug.length < 2) {
      notify({
        kind: 'error',
        title: 'THIẾU THÔNG TIN',
        message: 'Tên danh mục và slug phải có ít nhất 2 ký tự.',
      });
      return;
    }

    const payload = {
      name,
      slug,
      parentId: catForm.parentId.trim() || null,
      description: catForm.description.trim() || null,
      sortOrder: Number(catForm.sortOrder) || 0,
      isActive: catForm.isActive,
    };

    setCatSaving(true);
    const isEdit = Boolean(catForm.id);
    const res = await adminFetch<CategoryDto>(
      isEdit
        ? `/api/v1/admin/categories/${encodeURIComponent(catForm.id!)}`
        : '/api/v1/admin/categories',
      {
        method: isEdit ? 'PATCH' : 'POST',
        body: JSON.stringify(payload),
      },
    );
    setCatSaving(false);

    if (res.ok) {
      setCatModalOpen(false);
      notify({
        kind: 'success',
        title: isEdit ? 'CẬP NHẬT DANH MỤC' : 'TẠO DANH MỤC MỚI',
        message: `Đã lưu danh mục "${name}" (/${slug}).`,
      });
      await loadAll();
      onRefreshOverview?.();
    } else {
      notify({
        kind: 'error',
        title: 'LƯU THẤT BẠI',
        message: res.error?.message || 'Không thể lưu danh mục sản phẩm.',
      });
    }
  };

  const handleToggleCategoryActive = async (cat: CategoryDto) => {
    if (!canWrite) return;
    const res = await adminFetch<CategoryDto>(
      `/api/v1/admin/categories/${encodeURIComponent(cat.id)}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ isActive: !cat.isActive }),
      },
    );
    if (res.ok) {
      notify({
        kind: 'info',
        title: 'TRẠNG THÁI DANH MỤC',
        message: `Đã ${!cat.isActive ? 'kích hoạt' : 'ẩn'} danh mục "${cat.name}".`,
      });
      await loadAll();
    } else {
      notify({
        kind: 'error',
        title: 'CẬP NHẬT THẤT BẠI',
        message: res.error?.message || 'Không thể đổi trạng thái danh mục.',
      });
    }
  };

  const handleDeleteCategory = async (cat: CategoryDto) => {
    if (!canWrite) return;
    const res = await adminFetch<unknown>(
      `/api/v1/admin/categories/${encodeURIComponent(cat.id)}`,
      { method: 'DELETE' },
    );
    setConfirmDeleteCatId(null);
    if (res.ok) {
      notify({
        kind: 'success',
        title: 'XÓA / LƯU TRỮ DANH MỤC',
        message: `Đã xử lý danh mục "${cat.name}".`,
      });
      await loadAll();
      onRefreshOverview?.();
    } else {
      notify({
        kind: 'error',
        title: 'KHÔNG THỂ XÓA',
        message: res.error?.message || 'Không thể xóa danh mục này.',
      });
    }
  };

  // Size Chart CRUD Handlers
  const openCreateChart = () => {
    setChartForm({
      ...EMPTY_SIZE_CHART_FORM,
      categoryId: categories[0]?.id ?? '',
      garmentCategory: categories[0]?.slug ?? 'ao-blazer',
      rows: createDefaultSizeRows(),
    });
    setChartModalOpen(true);
  };

  const openEditChart = (chart: NormalizedSizeChart) => {
    setChartForm({
      id: chart.id,
      code: chart.code,
      name: chart.name,
      categoryId: chart.categoryId ?? '',
      garmentCategory: chart.garmentCategory,
      gender: chart.gender,
      stretchLevel: chart.stretchLevel,
      fitNote: chart.fitNote,
      rows:
        chart.rows.length > 0
          ? chart.rows.map((r) => ({ ...r }))
          : createDefaultSizeRows(),
    });
    setChartModalOpen(true);
  };

  const updateChartRow = (
    idx: number,
    patch: Partial<SizeChartRowDraft>,
  ) => {
    setChartForm((prev) => ({
      ...prev,
      rows: prev.rows.map((row, i) => (i === idx ? { ...row, ...patch } : row)),
    }));
  };

  const handleSaveSizeChart = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canWrite) return;

    const name = chartForm.name.trim();
    if (name.length < 2) {
      notify({
        kind: 'error',
        title: 'THIẾU TÊN BẢNG SIZE',
        message: 'Tên bảng thông số rập phải có ít nhất 2 ký tự.',
      });
      return;
    }

    const mappedRows = chartForm.rows.map((r) => {
      const chestMinCm = strToOptNum(r.chestMinCm);
      const chestMaxCm = strToOptNum(r.chestMaxCm);
      const waistMinCm = strToOptNum(r.waistMinCm);
      const waistMaxCm = strToOptNum(r.waistMaxCm);
      const hipMinCm = strToOptNum(r.hipMinCm);
      const hipMaxCm = strToOptNum(r.hipMaxCm);
      const avg = (a: number | null, b: number | null) =>
        a !== null && b !== null
          ? Math.round(((a + b) / 2) * 10) / 10
          : a ?? b;

      return {
        sizeCode: r.sizeCode,
        heightMinCm: strToOptNum(r.heightMinCm) ?? 150,
        heightMaxCm: strToOptNum(r.heightMaxCm) ?? 175,
        weightMinKg: strToOptNum(r.weightMinKg) ?? 42,
        weightMaxKg: strToOptNum(r.weightMaxKg) ?? 72,
        chestMinCm,
        chestMaxCm,
        bustCm: avg(chestMinCm, chestMaxCm),
        waistMinCm,
        waistMaxCm,
        waistCm: avg(waistMinCm, waistMaxCm),
        hipMinCm,
        hipMaxCm,
        hipCm: avg(hipMinCm, hipMaxCm),
        shoulderCm: strToOptNum(r.shoulderCm),
        lengthCm: strToOptNum(r.lengthCm),
      };
    });

    const firstRow = mappedRows[0];
    const code =
      chartForm.code.trim().toUpperCase() ||
      `SC-${slugifyVi(name).toUpperCase().slice(0, 18)}`;

    const payload = {
      code,
      name,
      categoryId: chartForm.categoryId.trim() || null,
      garmentCategory: chartForm.garmentCategory.trim() || 'UPPER',
      garmentType: chartForm.garmentCategory.trim() || 'UPPER',
      gender: chartForm.gender,
      stretchLevel: chartForm.stretchLevel,
      fitNote: chartForm.fitNote.trim() || null,
      fitNotes: chartForm.fitNote.trim() || null,
      ...(firstRow
        ? {
            sizeCode: firstRow.sizeCode,
            chestMin: firstRow.chestMinCm,
            chestMax: firstRow.chestMaxCm,
            waistMin: firstRow.waistMinCm,
            waistMax: firstRow.waistMaxCm,
            hipMin: firstRow.hipMinCm,
            hipMax: firstRow.hipMaxCm,
            shoulderCm: firstRow.shoulderCm,
            weightMinKg: firstRow.weightMinKg,
            weightMaxKg: firstRow.weightMaxKg,
            heightMinCm: firstRow.heightMinCm,
            heightMaxCm: firstRow.heightMaxCm,
          }
        : {}),
      rows: mappedRows,
    };

    setChartSaving(true);
    const isEdit = Boolean(chartForm.id);
    const res = await adminFetch<SizeChartDto>(
      isEdit
        ? `/api/v1/admin/size-charts/${encodeURIComponent(chartForm.id!)}`
        : '/api/v1/admin/size-charts',
      {
        method: isEdit ? 'PATCH' : 'POST',
        body: JSON.stringify(payload),
      },
    );
    setChartSaving(false);

    if (res.ok) {
      setChartModalOpen(false);
      notify({
        kind: 'success',
        title: isEdit ? 'CẬP NHẬT BẢNG SIZE' : 'TẠO BẢNG SIZE MỚI',
        message: `Đã lưu bảng thông số rập "${name}" (${mappedRows.length} cỡ size, độ co giãn ${chartForm.stretchLevel}).`,
      });
      await loadAll();
      onRefreshOverview?.();
    } else {
      notify({
        kind: 'error',
        title: 'LƯU THẤT BẠI',
        message: res.error?.message || 'Không thể lưu bảng thông số size.',
      });
    }
  };

  const handleDeleteSizeChart = async (chart: NormalizedSizeChart) => {
    if (!canWrite) return;
    const res = await adminFetch<unknown>(
      `/api/v1/admin/size-charts/${encodeURIComponent(chart.id)}`,
      { method: 'DELETE' },
    );
    setConfirmDeleteChartId(null);
    if (res.ok) {
      notify({
        kind: 'success',
        title: 'XÓA BẢNG SIZE',
        message: `Đã xóa bảng thông số "${chart.name}".`,
      });
      await loadAll();
      onRefreshOverview?.();
    } else {
      notify({
        kind: 'error',
        title: 'XÓA THẤT BẠI',
        message: res.error?.message || 'Không thể xóa bảng thông số size.',
      });
    }
  };

  // Theme tokens
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
    : 'border-[#B08A4A]/35 bg-white text-[#1C1410] placeholder:text-[#7A6A5B] focus:border-[#1C1410]';
  const tableHeadCls = darkMode
    ? 'border-b border-[#B08A4A]/25 bg-[#241A13] text-[#EBCF8F]'
    : 'border-b border-[#B08A4A]/20 bg-[#F4EBDA]/75 text-[#8A672C]';
  const rowHoverCls = darkMode ? 'hover:bg-[#251B14]' : 'hover:bg-[#FBF7EF]/85';

  return (
    <div data-testid="category-size-chart-tab" className="space-y-6">
      {/* Header & Sub-Tab Switcher */}
      <section className={`rounded-3xl border p-6 ${cardCls}`}>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className={`ledger-eyebrow ${goldTextCls}`}>
              Taxonomy &amp; Pattern Sizing Engine · AI Size Advisor Source of Truth
            </p>
            <h2 className="font-editorial mt-1 text-3xl font-normal tracking-tight">
              Cây Danh mục Sản phẩm &amp; Bảng Thông số Rập / Size
            </h2>
            <p className={`mt-1 text-xs leading-relaxed ${mutedCls}`}>
              Quản trị cấu trúc danh mục phân cấp và thông số vòng ngực, eo, mông,
              vai, chiều cao, cân nặng cùng mức độ co giãn vải (
              <code>NONE | LOW | MEDIUM | HIGH</code>) phục vụ thuật toán tư vấn
              size.
            </p>
          </div>

          <button
            type="button"
            onClick={() => void loadAll()}
            disabled={loading}
            className="rounded-full border border-[#B08A4A]/45 px-4 py-2 text-xs disabled:opacity-50"
          >
            {loading ? 'Đang tải...' : 'Làm mới'}
          </button>
        </div>

        <div className="mt-5 flex flex-wrap gap-2">
          <button
            type="button"
            data-testid="cat-size-subtab-categories"
            onClick={() => setSubTab('CATEGORIES')}
            className={`rounded-full px-4 py-2 text-xs font-medium transition-colors ${
              subTab === 'CATEGORIES'
                ? darkMode
                  ? 'bg-[#EBCF8F] text-[#1C1410]'
                  : 'bg-[#1C1410] text-[#EBCF8F]'
                : darkMode
                  ? 'border border-[#B08A4A]/35 bg-[#231912] text-[#DFD2C2]'
                  : 'border border-[#B08A4A]/35 bg-[#FBF7EF] text-[#5C4B41]'
            }`}
          >
            1. Cây Danh mục · Categories ({categories.length})
          </button>
          <button
            type="button"
            data-testid="cat-size-subtab-sizecharts"
            onClick={() => setSubTab('SIZE_CHARTS')}
            className={`rounded-full px-4 py-2 text-xs font-medium transition-colors ${
              subTab === 'SIZE_CHARTS'
                ? darkMode
                  ? 'bg-[#EBCF8F] text-[#1C1410]'
                  : 'bg-[#1C1410] text-[#EBCF8F]'
                : darkMode
                  ? 'border border-[#B08A4A]/35 bg-[#231912] text-[#DFD2C2]'
                  : 'border border-[#B08A4A]/35 bg-[#FBF7EF] text-[#5C4B41]'
            }`}
          >
            2. Bảng Thông số Rập &amp; Size · Size Charts ({sizeCharts.length})
          </button>
        </div>

        {errorMsg ? (
          <div
            role="alert"
            className="mt-4 rounded-2xl border border-[#8B2E2E]/40 bg-[#FFF5F4] px-4 py-3 text-xs text-[#8B2E2E]"
          >
            {errorMsg}
          </div>
        ) : null}
      </section>

      {/* SECTION A: Categories Tree CRUD */}
      {subTab === 'CATEGORIES' ? (
        <section className={`overflow-hidden rounded-3xl border ${cardCls}`}>
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#B08A4A]/20 px-6 py-4">
            <div>
              <p className={`ledger-eyebrow ${goldTextCls}`}>
                Hierarchical Categories · /api/v1/admin/categories
              </p>
              <h3 className="font-editorial mt-0.5 text-2xl">
                Cây Danh mục ({categories.length})
              </h3>
            </div>
            {canWrite ? (
              <button
                type="button"
                data-testid="category-create-btn"
                onClick={openCreateCategory}
                className={`rounded-full px-5 py-2 text-xs font-medium uppercase tracking-[0.14em] ${
                  darkMode
                    ? 'bg-[#EBCF8F] text-[#1C1410]'
                    : 'bg-[#1C1410] text-[#EBCF8F]'
                }`}
              >
                + Thêm Danh mục
              </button>
            ) : null}
          </div>

          {loading ? (
            <p className={`p-8 text-center text-xs ${mutedCls}`}>
              Đang tải cây danh mục...
            </p>
          ) : categoryTreeRows.length === 0 ? (
            <p className={`p-8 text-center text-xs ${mutedCls}`}>
              Chưa có danh mục nào trong cơ sở dữ liệu.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className={`text-[10px] uppercase tracking-[0.14em] ${tableHeadCls}`}>
                  <tr>
                    <th className="px-5 py-3">Tên Danh mục (Phân cấp)</th>
                    <th className="px-4 py-3">Slug</th>
                    <th className="px-4 py-3">Danh mục cha</th>
                    <th className="px-4 py-3 text-center">Thứ tự</th>
                    <th className="px-4 py-3">Trạng thái</th>
                    <th className="px-5 py-3 text-right">Thao tác</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#B08A4A]/15">
                  {categoryTreeRows.map(({ category, depth }) => {
                    const parent = category.parentId
                      ? categoryById.get(category.parentId)
                      : null;
                    return (
                      <tr key={category.id} className={rowHoverCls}>
                        <td className="px-5 py-3.5">
                          <div
                            className="flex items-center gap-2"
                            style={{ paddingLeft: `${depth * 22}px` }}
                          >
                            {depth > 0 ? (
                              <span className={`font-mono text-xs ${goldTextCls}`}>
                                ↳
                              </span>
                            ) : null}
                            <div>
                              <p className="font-medium">{category.name}</p>
                              {category.description ? (
                                <p className={`mt-0.5 text-[11px] ${mutedCls}`}>
                                  {category.description}
                                </p>
                              ) : null}
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-3.5 font-mono text-[11px]">
                          /{category.slug}
                        </td>
                        <td className={`px-4 py-3.5 text-[11px] ${secondaryCls}`}>
                          {parent ? parent.name : 'Danh mục gốc'}
                        </td>
                        <td className="adm-tabular px-4 py-3.5 text-center font-mono">
                          {category.sortOrder}
                        </td>
                        <td className="px-4 py-3.5">
                          <button
                            type="button"
                            disabled={!canWrite}
                            onClick={() =>
                              void handleToggleCategoryActive(category)
                            }
                            className={`rounded-full border px-2.5 py-0.5 font-mono text-[10px] font-semibold transition-opacity disabled:opacity-60 ${
                              category.isActive
                                ? darkMode
                                  ? 'border-emerald-500/45 bg-emerald-950/55 text-emerald-300'
                                  : 'border-[#2E6B47]/35 bg-[#EBF9F1] text-[#1E4B32]'
                                : darkMode
                                  ? 'border-[#7A6A5B]/45 bg-[#261E19] text-[#B4A391]'
                                  : 'border-[#7A6A5B]/35 bg-[#F4EBDA] text-[#5C4B41]'
                            }`}
                          >
                            {category.isActive ? 'ACTIVE' : 'INACTIVE'}
                          </button>
                        </td>
                        <td className="px-5 py-3.5 text-right">
                          {canWrite ? (
                            <div className="flex items-center justify-end gap-1.5">
                              <button
                                type="button"
                                onClick={() => openEditCategory(category)}
                                className="rounded-full border border-[#B08A4A]/40 px-3 py-1 text-[11px]"
                              >
                                Sửa
                              </button>
                              {confirmDeleteCatId === category.id ? (
                                <div className="flex gap-1">
                                  <button
                                    type="button"
                                    onClick={() =>
                                      void handleDeleteCategory(category)
                                    }
                                    className="rounded-full bg-[#8B2E2E] px-2.5 py-1 text-[10.5px] font-semibold text-white"
                                  >
                                    Xác nhận
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => setConfirmDeleteCatId(null)}
                                    className="rounded-full border border-[#B08A4A]/40 px-2 py-1 text-[10.5px]"
                                  >
                                    Hủy
                                  </button>
                                </div>
                              ) : (
                                <button
                                  type="button"
                                  onClick={() =>
                                    setConfirmDeleteCatId(category.id)
                                  }
                                  className="rounded-full border border-[#8B2E2E]/45 px-3 py-1 text-[11px] text-[#8B2E2E] dark:text-rose-300"
                                >
                                  Xóa
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
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ) : null}

      {/* SECTION B: Size Charts CRUD */}
      {subTab === 'SIZE_CHARTS' ? (
        <section className={`rounded-3xl border p-6 ${cardCls}`}>
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#B08A4A]/20 pb-4">
            <div>
              <p className={`ledger-eyebrow ${goldTextCls}`}>
                Pattern Measurements &amp; Stretch Matrix · /api/v1/admin/size-charts
              </p>
              <h3 className="font-editorial mt-0.5 text-2xl">
                Bảng Thông số Rập &amp; Size ({sizeCharts.length})
              </h3>
            </div>
            {canWrite ? (
              <button
                type="button"
                data-testid="sizechart-create-btn"
                onClick={openCreateChart}
                className={`rounded-full px-5 py-2 text-xs font-medium uppercase tracking-[0.14em] ${
                  darkMode
                    ? 'bg-[#EBCF8F] text-[#1C1410]'
                    : 'bg-[#1C1410] text-[#EBCF8F]'
                }`}
              >
                + Tạo Bảng Size mới
              </button>
            ) : null}
          </div>

          {loading ? (
            <p className={`py-8 text-center text-xs ${mutedCls}`}>
              Đang tải bảng thông số size...
            </p>
          ) : sizeCharts.length === 0 ? (
            <p className={`py-8 text-center text-xs ${mutedCls}`}>
              Chưa có bảng thông số size nào.
            </p>
          ) : (
            <div className="mt-5 space-y-5">
              {sizeCharts.map((chart) => {
                const stretchMeta = STRETCH_META[chart.stretchLevel];
                return (
                  <article
                    key={chart.id}
                    className={`overflow-hidden rounded-2xl border ${subCardCls}`}
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[#B08A4A]/20 p-4">
                      <div>
                        <div className="flex flex-wrap items-center gap-2">
                          <h4 className="font-editorial text-2xl">
                            {chart.name}
                          </h4>
                          <span className="rounded-full bg-[#1C1410] px-2.5 py-0.5 font-mono text-[10px] text-[#EBCF8F]">
                            {chart.code || chart.garmentCategory}
                          </span>
                          <span className="rounded-full border border-[#B08A4A]/35 px-2.5 py-0.5 font-mono text-[10px]">
                            {chart.gender}
                          </span>
                          <span
                            className={`rounded-full border px-2.5 py-0.5 font-mono text-[10px] font-semibold ${stretchMeta.badgeCls}`}
                          >
                            Co giãn: {chart.stretchLevel}
                          </span>
                        </div>
                        {chart.fitNote ? (
                          <p className={`mt-1 text-xs ${secondaryCls}`}>
                            {chart.fitNote}
                          </p>
                        ) : null}
                      </div>

                      {canWrite ? (
                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => openEditChart(chart)}
                            className="rounded-full border border-[#B08A4A]/45 px-3.5 py-1 text-[11px]"
                          >
                            Sửa thông số
                          </button>
                          {confirmDeleteChartId === chart.id ? (
                            <div className="flex gap-1">
                              <button
                                type="button"
                                onClick={() =>
                                  void handleDeleteSizeChart(chart)
                                }
                                className="rounded-full bg-[#8B2E2E] px-2.5 py-1 text-[10.5px] font-semibold text-white"
                              >
                                Xác nhận
                              </button>
                              <button
                                type="button"
                                onClick={() => setConfirmDeleteChartId(null)}
                                className="rounded-full border border-[#B08A4A]/40 px-2 py-1 text-[10.5px]"
                              >
                                Hủy
                              </button>
                            </div>
                          ) : (
                            <button
                              type="button"
                              onClick={() => setConfirmDeleteChartId(chart.id)}
                              className="rounded-full border border-[#8B2E2E]/45 px-3 py-1 text-[11px] text-[#8B2E2E] dark:text-rose-300"
                            >
                              Xóa
                            </button>
                          )}
                        </div>
                      ) : null}
                    </div>

                    <div className="overflow-x-auto">
                      <table className="w-full text-left font-mono text-[11px]">
                        <thead className={`text-[10px] uppercase tracking-[0.12em] ${tableHeadCls}`}>
                          <tr>
                            <th className="px-4 py-2">Size</th>
                            <th className="px-3 py-2">Chiều cao (cm)</th>
                            <th className="px-3 py-2">Cân nặng (kg)</th>
                            <th className="px-3 py-2">Ngực (cm)</th>
                            <th className="px-3 py-2">Eo (cm)</th>
                            <th className="px-3 py-2">Mông (cm)</th>
                            <th className="px-3 py-2">Vai (cm)</th>
                            <th className="px-3 py-2">Dài (cm)</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-[#B08A4A]/15">
                          {chart.rows.map((r, rIdx) => (
                            <tr key={`${chart.id}-${r.sizeCode}-${rIdx}`}>
                              <td className="px-4 py-2 font-bold">
                                {r.sizeCode}
                              </td>
                              <td className="px-3 py-2">
                                {r.heightMinCm || '—'} – {r.heightMaxCm || '—'}
                              </td>
                              <td className="px-3 py-2">
                                {r.weightMinKg || '—'} – {r.weightMaxKg || '—'}
                              </td>
                              <td className="px-3 py-2">
                                {r.chestMinCm && r.chestMaxCm && r.chestMinCm !== r.chestMaxCm
                                  ? `${r.chestMinCm}–${r.chestMaxCm}`
                                  : r.chestMinCm || r.chestMaxCm || '—'}
                              </td>
                              <td className="px-3 py-2">
                                {r.waistMinCm && r.waistMaxCm && r.waistMinCm !== r.waistMaxCm
                                  ? `${r.waistMinCm}–${r.waistMaxCm}`
                                  : r.waistMinCm || r.waistMaxCm || '—'}
                              </td>
                              <td className="px-3 py-2">
                                {r.hipMinCm && r.hipMaxCm && r.hipMinCm !== r.hipMaxCm
                                  ? `${r.hipMinCm}–${r.hipMaxCm}`
                                  : r.hipMinCm || r.hipMaxCm || '—'}
                              </td>
                              <td className="px-3 py-2">
                                {r.shoulderCm || '—'}
                              </td>
                              <td className="px-3 py-2">
                                {r.lengthCm || '—'}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </section>
      ) : null}

      {/* Category Create / Edit Modal */}
      {catModalOpen ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Chỉnh sửa Danh mục"
          className="fixed inset-0 z-50 flex items-center justify-center bg-[#0D0805]/65 p-4 backdrop-blur-xs"
        >
          <form
            onSubmit={handleSaveCategory}
            className={`w-full max-w-lg rounded-3xl border p-6 shadow-2xl ${cardCls}`}
          >
            <div className="flex items-start justify-between gap-3 border-b border-[#B08A4A]/20 pb-4">
              <div>
                <p className={`ledger-eyebrow ${goldTextCls}`}>
                  Category Hierarchy CRUD
                </p>
                <h3 className="font-editorial mt-0.5 text-2xl">
                  {catForm.id ? `Sửa Danh mục: ${catForm.name}` : 'Thêm Danh mục mới'}
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setCatModalOpen(false)}
                className="rounded-full border border-[#B08A4A]/40 px-3 py-1 text-xs"
              >
                Đóng
              </button>
            </div>

            <div className="mt-4 space-y-3.5 text-xs">
              <label className="block">
                <span className={secondaryCls}>Tên danh mục *</span>
                <input
                  type="text"
                  required
                  value={catForm.name}
                  onChange={(e) => {
                    const nextName = e.target.value;
                    setCatForm((prev) => ({
                      ...prev,
                      name: nextName,
                      slug: prev.id ? prev.slug : slugifyVi(nextName),
                    }));
                  }}
                  placeholder="VD: Áo Khoác Dạ Tweed"
                  className={`mt-1 w-full rounded-xl border px-3 py-2 outline-none ${inputCls}`}
                />
              </label>

              <label className="block">
                <span className={secondaryCls}>Slug URL *</span>
                <input
                  type="text"
                  required
                  value={catForm.slug}
                  onChange={(e) =>
                    setCatForm({ ...catForm, slug: e.target.value })
                  }
                  placeholder="ao-khoac-da-tweed"
                  className={`mt-1 w-full rounded-xl border px-3 py-2 font-mono outline-none ${inputCls}`}
                />
              </label>

              <label className="block">
                <span className={secondaryCls}>Danh mục cha (parentId)</span>
                <select
                  value={catForm.parentId}
                  onChange={(e) =>
                    setCatForm({ ...catForm, parentId: e.target.value })
                  }
                  className={`mt-1 w-full rounded-xl border px-3 py-2 outline-none ${inputCls}`}
                >
                  <option value="">— Danh mục gốc (Root) —</option>
                  {categories
                    .filter((c) => c.id !== catForm.id)
                    .map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name} (/{c.slug})
                      </option>
                    ))}
                </select>
              </label>

              <label className="block">
                <span className={secondaryCls}>Mô tả danh mục</span>
                <textarea
                  rows={2}
                  value={catForm.description}
                  onChange={(e) =>
                    setCatForm({ ...catForm, description: e.target.value })
                  }
                  className={`mt-1 w-full rounded-xl border px-3 py-2 outline-none ${inputCls}`}
                />
              </label>

              <div className="grid grid-cols-2 gap-3">
                <label className="block">
                  <span className={secondaryCls}>Thứ tự (sortOrder)</span>
                  <input
                    type="number"
                    value={catForm.sortOrder}
                    onChange={(e) =>
                      setCatForm({ ...catForm, sortOrder: e.target.value })
                    }
                    className={`mt-1 w-full rounded-xl border px-3 py-2 font-mono outline-none ${inputCls}`}
                  />
                </label>

                <label className="flex cursor-pointer items-end gap-2 pb-2">
                  <input
                    type="checkbox"
                    checked={catForm.isActive}
                    onChange={(e) =>
                      setCatForm({ ...catForm, isActive: e.target.checked })
                    }
                    className="accent-[#B08A4A]"
                  />
                  <span>Đang hoạt động (Active)</span>
                </label>
              </div>
            </div>

            <div className="mt-6 flex justify-end gap-2.5 border-t border-[#B08A4A]/20 pt-4">
              <button
                type="button"
                onClick={() => setCatModalOpen(false)}
                className="rounded-full border border-[#B08A4A]/40 px-4 py-2 text-xs"
              >
                Hủy
              </button>
              <button
                type="submit"
                disabled={catSaving}
                className={`rounded-full px-6 py-2 text-xs font-semibold uppercase tracking-[0.14em] disabled:opacity-50 ${
                  darkMode
                    ? 'bg-[#EBCF8F] text-[#1C1410]'
                    : 'bg-[#1C1410] text-[#EBCF8F]'
                }`}
              >
                {catSaving ? 'Đang lưu...' : 'Lưu Danh mục'}
              </button>
            </div>
          </form>
        </div>
      ) : null}

      {/* Size Chart Create / Edit Modal */}
      {chartModalOpen ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Chỉnh sửa Bảng Thông số Size"
          className="fixed inset-0 z-50 flex items-center justify-center bg-[#0D0805]/65 p-4 backdrop-blur-xs"
        >
          <form
            onSubmit={handleSaveSizeChart}
            className={`max-h-[92vh] w-full max-w-5xl overflow-y-auto rounded-3xl border p-6 shadow-2xl ${cardCls}`}
          >
            <div className="flex items-start justify-between gap-3 border-b border-[#B08A4A]/20 pb-4">
              <div>
                <p className={`ledger-eyebrow ${goldTextCls}`}>
                  Size Chart &amp; Pattern Measurements CRUD
                </p>
                <h3 className="font-editorial mt-0.5 text-2xl">
                  {chartForm.id
                    ? `Sửa Bảng Size: ${chartForm.name}`
                    : 'Khởi tạo Bảng Thông số Rập & Size mới'}
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setChartModalOpen(false)}
                className="rounded-full border border-[#B08A4A]/40 px-3 py-1 text-xs"
              >
                Đóng
              </button>
            </div>

            <div className="mt-4 grid gap-4 sm:grid-cols-3 text-xs">
              <label className="sm:col-span-2">
                <span className={secondaryCls}>Tên Bảng Size *</span>
                <input
                  type="text"
                  required
                  value={chartForm.name}
                  onChange={(e) =>
                    setChartForm({ ...chartForm, name: e.target.value })
                  }
                  placeholder="VD: Rập Blazer Nữ Dáng Suông Atelier"
                  className={`mt-1 w-full rounded-xl border px-3 py-2 outline-none ${inputCls}`}
                />
              </label>

              <label>
                <span className={secondaryCls}>Mã quy chuẩn (code)</span>
                <input
                  type="text"
                  value={chartForm.code}
                  onChange={(e) =>
                    setChartForm({
                      ...chartForm,
                      code: e.target.value.toUpperCase(),
                    })
                  }
                  placeholder="VD: SC-BLAZER-W"
                  className={`mt-1 w-full rounded-xl border px-3 py-2 font-mono outline-none ${inputCls}`}
                />
              </label>

              <label>
                <span className={secondaryCls}>Danh mục áp dụng</span>
                <select
                  value={chartForm.categoryId}
                  onChange={(e) => {
                    const cid = e.target.value;
                    const found = categories.find((c) => c.id === cid);
                    setChartForm({
                      ...chartForm,
                      categoryId: cid,
                      garmentCategory: found?.slug ?? chartForm.garmentCategory,
                    });
                  }}
                  className={`mt-1 w-full rounded-xl border px-3 py-2 outline-none ${inputCls}`}
                >
                  <option value="">— Chọn danh mục —</option>
                  {categories.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name} ({c.slug})
                    </option>
                  ))}
                </select>
              </label>

              <label>
                <span className={secondaryCls}>Giới tính (gender)</span>
                <select
                  value={chartForm.gender}
                  onChange={(e) =>
                    setChartForm({
                      ...chartForm,
                      gender: e.target.value as Gender,
                    })
                  }
                  className={`mt-1 w-full rounded-xl border px-3 py-2 outline-none ${inputCls}`}
                >
                  <option value={Gender.WOMEN}>WOMEN (Nữ)</option>
                  <option value={Gender.MEN}>MEN (Nam)</option>
                  <option value={Gender.UNISEX}>UNISEX</option>
                </select>
              </label>

              <label>
                <span className={secondaryCls}>
                  Độ co giãn vải (stretchLevel) *
                </span>
                <select
                  value={chartForm.stretchLevel}
                  onChange={(e) =>
                    setChartForm({
                      ...chartForm,
                      stretchLevel: e.target.value as StretchOption,
                    })
                  }
                  className={`mt-1 w-full rounded-xl border px-3 py-2 outline-none ${inputCls}`}
                >
                  {(
                    ['NONE', 'LOW', 'MEDIUM', 'HIGH'] as const
                  ).map((st) => (
                    <option key={st} value={st}>
                      {STRETCH_META[st].label}
                    </option>
                  ))}
                </select>
              </label>

              <label className="sm:col-span-3">
                <span className={secondaryCls}>Ghi chú phom dáng &amp; tư vấn size</span>
                <input
                  type="text"
                  value={chartForm.fitNote}
                  onChange={(e) =>
                    setChartForm({ ...chartForm, fitNote: e.target.value })
                  }
                  placeholder="VD: Phom ôm vai nhẹ, khách vai rộng nên chọn nhích 1 size..."
                  className={`mt-1 w-full rounded-xl border px-3 py-2 outline-none ${inputCls}`}
                />
              </label>
            </div>

            {/* Measurement Matrix Rows */}
            <div className="mt-5">
              <div className="flex items-center justify-between gap-2">
                <p className={`text-xs font-semibold uppercase tracking-[0.14em] ${goldTextCls}`}>
                  Ma trận Thông số theo Cỡ Size ({chartForm.rows.length} dòng)
                </p>
                <button
                  type="button"
                  onClick={() =>
                    setChartForm((prev) => ({
                      ...prev,
                      rows: [
                        ...prev.rows,
                        {
                          sizeCode:
                            SIZE_CODE_OPTIONS[
                              prev.rows.length % SIZE_CODE_OPTIONS.length
                            ] ?? SizeCode.XL,
                          heightMinCm: '165',
                          heightMaxCm: '175',
                          weightMinKg: '60',
                          weightMaxKg: '70',
                          chestMinCm: '90',
                          chestMaxCm: '96',
                          waistMinCm: '74',
                          waistMaxCm: '80',
                          hipMinCm: '96',
                          hipMaxCm: '102',
                          shoulderCm: '40',
                          lengthCm: '68',
                        },
                      ],
                    }))
                  }
                  className="rounded-full border border-[#B08A4A]/45 px-3 py-1 text-[11px]"
                >
                  + Thêm dòng Size
                </button>
              </div>

              <div className="mt-2.5 overflow-x-auto rounded-2xl border border-[#B08A4A]/25">
                <table className="w-full text-left font-mono text-[11px]">
                  <thead className={`text-[10px] uppercase ${tableHeadCls}`}>
                    <tr>
                      <th className="px-2.5 py-2">Size</th>
                      <th className="px-2 py-2">Cao (Min–Max cm)</th>
                      <th className="px-2 py-2">Nặng (Min–Max kg)</th>
                      <th className="px-2 py-2">Ngực (Min–Max)</th>
                      <th className="px-2 py-2">Eo (Min–Max)</th>
                      <th className="px-2 py-2">Mông (Min–Max)</th>
                      <th className="px-2 py-2">Vai</th>
                      <th className="px-2 py-2">Dài</th>
                      <th className="px-2 py-2" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#B08A4A]/15">
                    {chartForm.rows.map((row, idx) => (
                      <tr key={`row-edit-${idx}`}>
                        <td className="px-2 py-2">
                          <select
                            value={row.sizeCode}
                            onChange={(e) =>
                              updateChartRow(idx, {
                                sizeCode: e.target.value as SizeCode,
                              })
                            }
                            className={`rounded-lg border px-1.5 py-1 text-xs ${inputCls}`}
                          >
                            {SIZE_CODE_OPTIONS.map((sc) => (
                              <option key={sc} value={sc}>
                                {sc}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td className="px-1.5 py-2">
                          <div className="flex gap-1">
                            <input
                              type="number"
                              value={row.heightMinCm}
                              onChange={(e) =>
                                updateChartRow(idx, {
                                  heightMinCm: e.target.value,
                                })
                              }
                              placeholder="152"
                              className={`w-14 rounded-lg border px-1.5 py-1 ${inputCls}`}
                            />
                            <input
                              type="number"
                              value={row.heightMaxCm}
                              onChange={(e) =>
                                updateChartRow(idx, {
                                  heightMaxCm: e.target.value,
                                })
                              }
                              placeholder="160"
                              className={`w-14 rounded-lg border px-1.5 py-1 ${inputCls}`}
                            />
                          </div>
                        </td>
                        <td className="px-1.5 py-2">
                          <div className="flex gap-1">
                            <input
                              type="number"
                              value={row.weightMinKg}
                              onChange={(e) =>
                                updateChartRow(idx, {
                                  weightMinKg: e.target.value,
                                })
                              }
                              placeholder="44"
                              className={`w-14 rounded-lg border px-1.5 py-1 ${inputCls}`}
                            />
                            <input
                              type="number"
                              value={row.weightMaxKg}
                              onChange={(e) =>
                                updateChartRow(idx, {
                                  weightMaxKg: e.target.value,
                                })
                              }
                              placeholder="50"
                              className={`w-14 rounded-lg border px-1.5 py-1 ${inputCls}`}
                            />
                          </div>
                        </td>
                        <td className="px-1.5 py-2">
                          <div className="flex gap-1">
                            <input
                              type="number"
                              step="0.5"
                              value={row.chestMinCm}
                              onChange={(e) =>
                                updateChartRow(idx, {
                                  chestMinCm: e.target.value,
                                })
                              }
                              placeholder="80"
                              className={`w-14 rounded-lg border px-1.5 py-1 ${inputCls}`}
                            />
                            <input
                              type="number"
                              step="0.5"
                              value={row.chestMaxCm}
                              onChange={(e) =>
                                updateChartRow(idx, {
                                  chestMaxCm: e.target.value,
                                })
                              }
                              placeholder="84"
                              className={`w-14 rounded-lg border px-1.5 py-1 ${inputCls}`}
                            />
                          </div>
                        </td>
                        <td className="px-1.5 py-2">
                          <div className="flex gap-1">
                            <input
                              type="number"
                              step="0.5"
                              value={row.waistMinCm}
                              onChange={(e) =>
                                updateChartRow(idx, {
                                  waistMinCm: e.target.value,
                                })
                              }
                              placeholder="62"
                              className={`w-14 rounded-lg border px-1.5 py-1 ${inputCls}`}
                            />
                            <input
                              type="number"
                              step="0.5"
                              value={row.waistMaxCm}
                              onChange={(e) =>
                                updateChartRow(idx, {
                                  waistMaxCm: e.target.value,
                                })
                              }
                              placeholder="66"
                              className={`w-14 rounded-lg border px-1.5 py-1 ${inputCls}`}
                            />
                          </div>
                        </td>
                        <td className="px-1.5 py-2">
                          <div className="flex gap-1">
                            <input
                              type="number"
                              step="0.5"
                              value={row.hipMinCm}
                              onChange={(e) =>
                                updateChartRow(idx, { hipMinCm: e.target.value })
                              }
                              placeholder="86"
                              className={`w-14 rounded-lg border px-1.5 py-1 ${inputCls}`}
                            />
                            <input
                              type="number"
                              step="0.5"
                              value={row.hipMaxCm}
                              onChange={(e) =>
                                updateChartRow(idx, { hipMaxCm: e.target.value })
                              }
                              placeholder="90"
                              className={`w-14 rounded-lg border px-1.5 py-1 ${inputCls}`}
                            />
                          </div>
                        </td>
                        <td className="px-1.5 py-2">
                          <input
                            type="number"
                            step="0.5"
                            value={row.shoulderCm}
                            onChange={(e) =>
                              updateChartRow(idx, { shoulderCm: e.target.value })
                            }
                            placeholder="37"
                            className={`w-14 rounded-lg border px-1.5 py-1 ${inputCls}`}
                          />
                        </td>
                        <td className="px-1.5 py-2">
                          <input
                            type="number"
                            step="0.5"
                            value={row.lengthCm}
                            onChange={(e) =>
                              updateChartRow(idx, { lengthCm: e.target.value })
                            }
                            placeholder="64"
                            className={`w-14 rounded-lg border px-1.5 py-1 ${inputCls}`}
                          />
                        </td>
                        <td className="px-1.5 py-2 text-right">
                          {chartForm.rows.length > 1 ? (
                            <button
                              type="button"
                              onClick={() =>
                                setChartForm((prev) => ({
                                  ...prev,
                                  rows: prev.rows.filter((_, i) => i !== idx),
                                }))
                              }
                              className="text-[10px] text-[#8B2E2E] hover:underline dark:text-rose-300"
                            >
                              Xóa
                            </button>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="mt-6 flex justify-end gap-2.5 border-t border-[#B08A4A]/20 pt-4">
              <button
                type="button"
                onClick={() => setChartModalOpen(false)}
                className="rounded-full border border-[#B08A4A]/40 px-4 py-2 text-xs"
              >
                Hủy
              </button>
              <button
                type="submit"
                disabled={chartSaving}
                className={`rounded-full px-6 py-2 text-xs font-semibold uppercase tracking-[0.14em] disabled:opacity-50 ${
                  darkMode
                    ? 'bg-[#EBCF8F] text-[#1C1410]'
                    : 'bg-[#1C1410] text-[#EBCF8F]'
                }`}
              >
                {chartSaving ? 'Đang lưu...' : 'Lưu Bảng Thông số Size'}
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </div>
  );
}
