'use client';

import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  Permission,
  Role,
  hasAnyPermission,
  type ProductSpuDto,
} from '@atelier/contracts';
import {
  adminFetch,
  getAdminSession,
  type AdminStoredSession,
} from '@/lib/api-client';
import { emitPortalToast } from '../PortalToastBanner';

export interface AdminTabNotifyPayload {
  kind: 'success' | 'error' | 'info';
  title?: string;
  message: string;
}

export interface PromotionsTabProps {
  roles?: readonly Role[];
  session?: AdminStoredSession | null;
  mfaVerified?: boolean;
  darkMode?: boolean;
  onNotify?: (payload: AdminTabNotifyPayload) => void;
  onRefreshOverview?: () => void;
}

type PromoFormDiscountType =
  | 'PERCENTAGE'
  | 'FIXED_AMOUNT'
  | 'FREESHIP'
  | 'CLEARANCE_ODD_SIZE'
  | 'OUTFIT_COMBO'
  | 'FLASH_SALE';

type PromoStatusFilter =
  | 'ALL'
  | 'NHAP_AI'
  | 'ACTIVE'
  | 'INACTIVE'
  | 'PAUSED'
  | 'EXPIRED'
  | 'ARCHIVED';

interface AdminPromotionItem {
  id: string;
  code: string;
  name: string;
  description: string | null;
  type: string;
  status: string;
  discountValue: number;
  discountPercent: number | null;
  discountAmountVnd: number | null;
  maxDiscountVnd: number | null;
  minOrderVnd: number;
  usageLimit: number | null;
  usedCount: number;
  perUserLimit: number | null;
  applicableSkus: string[];
  applicableSpuIds: string[];
  startsAt: string | null;
  endsAt: string | null;
  createdByActorType: string;
  approvedBy: string | null;
  approvedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

interface PromoFormState {
  id: string | null;
  code: string;
  name: string;
  description: string;
  discountType: PromoFormDiscountType;
  discountValue: string;
  maxDiscountVnd: string;
  minOrderVnd: string;
  usageLimit: string;
  perUserLimit: string;
  startsAt: string;
  endsAt: string;
  applicableSkusText: string;
  applicableSpuIds: string[];
  status: 'ACTIVE' | 'INACTIVE' | 'PAUSED' | 'NHAP_AI';
}

const FORMAT_VND = (amount: number): string =>
  `${new Intl.NumberFormat('vi-VN').format(Math.round(amount))}₫`;

function toLocalDateTimeInput(iso: string | null | undefined): string {
  if (!iso) return '';
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}T${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
}

function toIsoOrNull(localDt: string): string | null {
  const trimmed = localDt.trim();
  if (!trimmed) return null;
  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function formatDateTimeVi(iso: string | null | undefined): string {
  if (!iso) return 'Không giới hạn';
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

function toStringArray(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.map((x) => String(x).trim()).filter(Boolean);
  }
  return [];
}

function normalizePromotion(raw: Record<string, unknown>): AdminPromotionItem {
  const rawType = String(
    raw.discountType ?? raw.type ?? raw.promoType ?? 'PERCENT',
  ).toUpperCase();
  const discountPercent =
    typeof raw.discountPercent === 'number' ? raw.discountPercent : null;
  const discountAmountVnd =
    typeof raw.discountAmountVnd === 'number' ? raw.discountAmountVnd : null;
  const rawDiscountValue =
    typeof raw.discountValue === 'number'
      ? raw.discountValue
      : discountPercent ?? discountAmountVnd ?? 0;

  const usageLimitRaw = raw.usageLimit ?? raw.maxUses;
  const usageLimit =
    typeof usageLimitRaw === 'number' && usageLimitRaw > 0
      ? usageLimitRaw
      : null;

  return {
    id: String(raw.id ?? ''),
    code: String(raw.code ?? ''),
    name: String(raw.name ?? raw.title ?? raw.code ?? 'Khuyến mãi'),
    description: typeof raw.description === 'string' ? raw.description : null,
    type: rawType,
    status: String(raw.status ?? 'ACTIVE').toUpperCase(),
    discountValue: Number.isFinite(rawDiscountValue) ? rawDiscountValue : 0,
    discountPercent,
    discountAmountVnd,
    maxDiscountVnd:
      typeof raw.maxDiscountVnd === 'number' && raw.maxDiscountVnd > 0
        ? raw.maxDiscountVnd
        : null,
    minOrderVnd:
      typeof raw.minOrderVnd === 'number' && Number.isFinite(raw.minOrderVnd)
        ? raw.minOrderVnd
        : 0,
    usageLimit,
    usedCount:
      typeof raw.usedCount === 'number' && Number.isFinite(raw.usedCount)
        ? raw.usedCount
        : 0,
    perUserLimit:
      typeof raw.perUserLimit === 'number' && raw.perUserLimit > 0
        ? raw.perUserLimit
        : null,
    applicableSkus: toStringArray(raw.applicableSkus ?? raw.targetSkuCodes),
    applicableSpuIds: toStringArray(
      raw.applicableSpuIds ?? raw.targetProductIds,
    ),
    startsAt:
      typeof raw.startsAt === 'string'
        ? raw.startsAt
        : typeof raw.startAt === 'string'
          ? raw.startAt
          : null,
    endsAt:
      typeof raw.endsAt === 'string'
        ? raw.endsAt
        : typeof raw.endAt === 'string'
          ? raw.endAt
          : null,
    createdByActorType: String(raw.createdByActorType ?? 'USER').toUpperCase(),
    approvedBy: typeof raw.approvedBy === 'string' ? raw.approvedBy : null,
    approvedAt: typeof raw.approvedAt === 'string' ? raw.approvedAt : null,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : null,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
  };
}

function mapRawTypeToFormType(rawType: string): PromoFormDiscountType {
  const upper = rawType.toUpperCase();
  if (upper === 'PERCENT' || upper === 'PERCENTAGE') return 'PERCENTAGE';
  if (upper === 'FIXED' || upper === 'FIXED_AMOUNT') return 'FIXED_AMOUNT';
  if (upper === 'FREESHIP') return 'FREESHIP';
  if (upper === 'CLEARANCE_ODD_SIZE') return 'CLEARANCE_ODD_SIZE';
  if (upper === 'OUTFIT_COMBO') return 'OUTFIT_COMBO';
  if (upper === 'FLASH_SALE') return 'FLASH_SALE';
  return 'PERCENTAGE';
}

function isPercentagePromoType(type: string): boolean {
  const upper = type.toUpperCase();
  return (
    upper === 'PERCENT' ||
    upper === 'PERCENTAGE' ||
    upper === 'CLEARANCE_ODD_SIZE' ||
    upper === 'OUTFIT_COMBO'
  );
}

function formatDiscountSummary(item: AdminPromotionItem): string {
  const upper = item.type.toUpperCase();
  if (upper === 'FREESHIP') {
    return item.maxDiscountVnd
      ? `Miễn phí ship (tối đa ${FORMAT_VND(item.maxDiscountVnd)})`
      : 'Miễn phí vận chuyển';
  }
  if (
    isPercentagePromoType(upper) ||
    (upper === 'FLASH_SALE' && item.discountValue <= 100)
  ) {
    const pct = item.discountPercent ?? item.discountValue;
    return item.maxDiscountVnd
      ? `Giảm ${pct}% · tối đa ${FORMAT_VND(item.maxDiscountVnd)}`
      : `Giảm ${pct}%`;
  }
  const vnd = item.discountAmountVnd ?? item.discountValue;
  return `Giảm ${FORMAT_VND(vnd)}`;
}

const PROMO_TYPE_LABEL: Record<string, string> = {
  PERCENT: 'Phần trăm (%)',
  PERCENTAGE: 'Phần trăm (%)',
  FIXED: 'Số tiền cố định (₫)',
  FIXED_AMOUNT: 'Số tiền cố định (₫)',
  FREESHIP: 'Miễn phí vận chuyển',
  CLEARANCE_ODD_SIZE: 'Xả kho lẻ size (AI)',
  OUTFIT_COMBO: 'Combo Mix & Match',
  FLASH_SALE: 'Flash Sale',
};

const PROMO_STATUS_LABEL: Record<string, string> = {
  NHAP_AI: 'NHAP_AI · Chờ duyệt HITL',
  ACTIVE: 'Đang hoạt động',
  INACTIVE: 'Tạm ngưng',
  PAUSED: 'Tạm dừng',
  EXPIRED: 'Hết hạn',
  ARCHIVED: 'Đã lưu trữ',
};

const EMPTY_FORM: PromoFormState = {
  id: null,
  code: '',
  name: '',
  description: '',
  discountType: 'PERCENTAGE',
  discountValue: '15',
  maxDiscountVnd: '300000',
  minOrderVnd: '1000000',
  usageLimit: '100',
  perUserLimit: '1',
  startsAt: '',
  endsAt: '',
  applicableSkusText: '',
  applicableSpuIds: [],
  status: 'ACTIVE',
};

export function PromotionsTab({
  roles: rolesProp,
  session: sessionProp,
  darkMode = false,
  onNotify,
  onRefreshOverview,
}: PromotionsTabProps) {
  const effectiveSession = sessionProp ?? getAdminSession();
  const roles = useMemo(
    () => rolesProp ?? effectiveSession?.user.roles ?? ([] as readonly Role[]),
    [rolesProp, effectiveSession],
  );

  const canManagePromos = useMemo(
    () =>
      roles.includes(Role.SUPER_ADMIN) ||
      hasAnyPermission(roles, [Permission.CATALOG_PRODUCT_WRITE]),
    [roles],
  );
  const canApproveDrafts = useMemo(
    () =>
      roles.includes(Role.SUPER_ADMIN) ||
      hasAnyPermission(roles, [
        Permission.CATALOG_AI_APPROVE,
        Permission.CATALOG_PRODUCT_WRITE,
      ]),
    [roles],
  );

  const notify = useCallback(
    (payload: AdminTabNotifyPayload) => {
      if (onNotify) {
        onNotify(payload);
      } else {
        emitPortalToast(payload);
      }
    },
    [onNotify],
  );

  const [promotions, setPromotions] = useState<AdminPromotionItem[]>([]);
  const [products, setProducts] = useState<ProductSpuDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Filters
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<PromoStatusFilter>('ALL');
  const [typeFilter, setTypeFilter] = useState<string>('ALL');

  // Action states
  const [approvingId, setApprovingId] = useState<string | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [archivingId, setArchivingId] = useState<string | null>(null);
  const [confirmArchiveId, setConfirmArchiveId] = useState<string | null>(null);

  // Create / Edit Modal
  const [modalOpen, setModalOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [form, setForm] = useState<PromoFormState>(EMPTY_FORM);
  const [spuSearch, setSpuSearch] = useState('');

  const loadPromotions = useCallback(async () => {
    setLoading(true);
    setErrorMsg(null);
    const [promoRes, prodRes] = await Promise.all([
      adminFetch<unknown>('/api/v1/admin/promotions?limit=200'),
      adminFetch<unknown>('/api/v1/admin/products?limit=100'),
    ]);

    if (promoRes.ok) {
      const rawItems = extractList<Record<string, unknown>>(promoRes.data, [
        'items',
        'promotions',
        'list',
      ]);
      setPromotions(rawItems.map(normalizePromotion));
    } else {
      setErrorMsg(
        promoRes.error?.message ||
          'Chưa thể tải danh sách khuyến mãi & voucher từ BFF.',
      );
    }

    if (prodRes.ok) {
      setProducts(
        extractList<ProductSpuDto>(prodRes.data, ['items', 'products', 'list']),
      );
    }

    setLoading(false);
  }, []);

  useEffect(() => {
    void loadPromotions();
  }, [loadPromotions]);

  const aiDrafts = useMemo(
    () => promotions.filter((p) => p.status === 'NHAP_AI'),
    [promotions],
  );

  const filteredPromotions = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return promotions.filter((item) => {
      if (statusFilter !== 'ALL' && item.status !== statusFilter) return false;
      if (typeFilter !== 'ALL') {
        const normalized = mapRawTypeToFormType(item.type);
        if (item.type !== typeFilter && normalized !== typeFilter) return false;
      }
      if (q) {
        const hay = `${item.code} ${item.name} ${item.description ?? ''} ${item.applicableSkus.join(' ')}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [promotions, searchQuery, statusFilter, typeFilter]);

  const kpis = useMemo(() => {
    const total = promotions.length;
    const active = promotions.filter((p) => p.status === 'ACTIVE').length;
    const drafts = aiDrafts.length;
    const totalUsed = promotions.reduce((acc, p) => acc + p.usedCount, 0);
    return { total, active, drafts, totalUsed };
  }, [promotions, aiDrafts]);

  const filteredSpus = useMemo(() => {
    const q = spuSearch.trim().toLowerCase();
    if (!q) return products.slice(0, 30);
    return products.filter((p) =>
      `${p.name} ${p.slug} ${p.categorySlug}`.toLowerCase().includes(q),
    );
  }, [products, spuSearch]);

  const openCreateModal = () => {
    setForm(EMPTY_FORM);
    setFormError(null);
    setSpuSearch('');
    setModalOpen(true);
  };

  const openEditModal = (item: AdminPromotionItem) => {
    const formType = mapRawTypeToFormType(item.type);
    const statusCandidate =
      item.status === 'ACTIVE' ||
      item.status === 'INACTIVE' ||
      item.status === 'PAUSED' ||
      item.status === 'NHAP_AI'
        ? item.status
        : 'INACTIVE';

    setForm({
      id: item.id,
      code: item.code,
      name: item.name,
      description: item.description ?? '',
      discountType: formType,
      discountValue: String(item.discountValue || 0),
      maxDiscountVnd: item.maxDiscountVnd ? String(item.maxDiscountVnd) : '',
      minOrderVnd: String(item.minOrderVnd ?? 0),
      usageLimit: item.usageLimit ? String(item.usageLimit) : '',
      perUserLimit: item.perUserLimit ? String(item.perUserLimit) : '',
      startsAt: toLocalDateTimeInput(item.startsAt),
      endsAt: toLocalDateTimeInput(item.endsAt),
      applicableSkusText: item.applicableSkus.join(', '),
      applicableSpuIds: [...item.applicableSpuIds],
      status: statusCandidate,
    });
    setFormError(null);
    setSpuSearch('');
    setModalOpen(true);
  };

  const handleToggleSpu = (spuId: string) => {
    setForm((prev) => ({
      ...prev,
      applicableSpuIds: prev.applicableSpuIds.includes(spuId)
        ? prev.applicableSpuIds.filter((id) => id !== spuId)
        : [...prev.applicableSpuIds, spuId],
    }));
  };

  const handleSavePromotion = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canManagePromos) return;
    setFormError(null);

    const code = form.code.trim().toUpperCase().replace(/\s+/g, '');
    const name = form.name.trim();
    if (code.length < 3) {
      setFormError('Mã voucher phải có ít nhất 3 ký tự (không chứa khoảng trắng).');
      return;
    }
    if (name.length < 2) {
      setFormError('Tên chiến dịch không được để trống.');
      return;
    }

    const numericDiscount = Number(form.discountValue || 0);
    const isPercent =
      form.discountType === 'PERCENTAGE' ||
      form.discountType === 'CLEARANCE_ODD_SIZE' ||
      form.discountType === 'OUTFIT_COMBO';
    if (isPercent && (numericDiscount <= 0 || numericDiscount > 100)) {
      setFormError('Phần trăm giảm giá phải nằm trong khoảng 1% – 100%.');
      return;
    }
    if (form.discountType === 'FIXED_AMOUNT' && numericDiscount <= 0) {
      setFormError('Số tiền giảm cố định phải lớn hơn 0₫.');
      return;
    }

    const startsIso = toIsoOrNull(form.startsAt);
    const endsIso = toIsoOrNull(form.endsAt);
    if (startsIso && endsIso && new Date(endsIso) <= new Date(startsIso)) {
      setFormError('Thời điểm kết thúc phải sau thời điểm bắt đầu.');
      return;
    }

    const skuList = form.applicableSkusText
      .split(/[,\n]+/)
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);

    const mappedPromoType =
      form.discountType === 'PERCENTAGE'
        ? 'PERCENT'
        : form.discountType === 'FIXED_AMOUNT'
          ? 'FIXED'
          : form.discountType;

    const maxDiscountNum = form.maxDiscountVnd.trim()
      ? Math.max(0, Math.round(Number(form.maxDiscountVnd)))
      : null;
    const minOrderNum = Math.max(0, Math.round(Number(form.minOrderVnd || 0)));
    const usageLimitNum = form.usageLimit.trim()
      ? Math.max(1, Math.round(Number(form.usageLimit)))
      : null;
    const perUserLimitNum = form.perUserLimit.trim()
      ? Math.max(1, Math.round(Number(form.perUserLimit)))
      : null;

    const payload: Record<string, unknown> = {
      code,
      name,
      title: name,
      description: form.description.trim() || null,
      discountType: form.discountType,
      type: mappedPromoType,
      discountValue:
        form.discountType === 'FREESHIP'
          ? maxDiscountNum ?? 35000
          : Math.round(numericDiscount),
      ...(isPercent
        ? { discountPercent: Math.round(numericDiscount) }
        : form.discountType === 'FIXED_AMOUNT'
          ? { discountAmountVnd: Math.round(numericDiscount) }
          : {}),
      maxDiscountVnd: maxDiscountNum,
      minOrderVnd: minOrderNum,
      ...(usageLimitNum
        ? { usageLimit: usageLimitNum, maxUses: usageLimitNum }
        : {}),
      ...(perUserLimitNum ? { perUserLimit: perUserLimitNum } : {}),
      startsAt: startsIso,
      endsAt: endsIso,
      applicableSkus: skuList,
      targetSkuCodes: skuList,
      applicableSpuIds: form.applicableSpuIds,
      targetProductIds: form.applicableSpuIds,
      status: form.status,
    };

    setSaving(true);
    const isEdit = Boolean(form.id);
    const endpoint = isEdit
      ? `/api/v1/admin/promotions/${encodeURIComponent(form.id!)}`
      : '/api/v1/admin/promotions';

    const res = await adminFetch<unknown>(endpoint, {
      method: isEdit ? 'PATCH' : 'POST',
      body: JSON.stringify(payload),
    });

    setSaving(false);
    if (res.ok) {
      setModalOpen(false);
      notify({
        kind: 'success',
        title: isEdit ? 'CẬP NHẬT KHUYẾN MÃI' : 'TẠO VOUCHER MỚI',
        message: isEdit
          ? `Đã cập nhật chiến dịch ${code} và đồng bộ bộ nhớ đệm Storefront.`
          : `Đã tạo mã ưu đãi ${code} (${form.status}) thành công.`,
      });
      await loadPromotions();
      onRefreshOverview?.();
    } else {
      setFormError(
        res.error?.message ||
          (isEdit
            ? 'Không thể cập nhật khuyến mãi.'
            : 'Không thể tạo mã khuyến mãi mới.'),
      );
    }
  };

  const handleApproveDraft = async (item: AdminPromotionItem) => {
    if (!canApproveDrafts) return;
    setApprovingId(item.id);
    const res = await adminFetch<unknown>(
      `/api/v1/admin/promotions/${encodeURIComponent(item.id)}/approve-draft`,
      {
        method: 'POST',
        body: JSON.stringify({}),
      },
    );
    setApprovingId(null);

    if (res.ok) {
      notify({
        kind: 'success',
        title: 'HITL PHÊ DUYỆT CHIẾN DỊCH AI',
        message: `Đã kích hoạt chiến dịch ${item.code} (NHAP_AI → ACTIVE) và xóa cache Redis Storefront.`,
      });
      await loadPromotions();
      onRefreshOverview?.();
    } else {
      notify({
        kind: 'error',
        title: 'PHÊ DUYỆT THẤT BẠI',
        message:
          res.error?.message ||
          `Không thể phê duyệt chiến dịch ${item.code}.`,
      });
    }
  };

  const handleToggleActive = async (item: AdminPromotionItem) => {
    if (!canManagePromos || item.status === 'NHAP_AI') return;
    const nextStatus = item.status === 'ACTIVE' ? 'PAUSED' : 'ACTIVE';
    setTogglingId(item.id);
    const res = await adminFetch<unknown>(
      `/api/v1/admin/promotions/${encodeURIComponent(item.id)}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ status: nextStatus, isActive: nextStatus === 'ACTIVE' }),
      },
    );
    setTogglingId(null);

    if (res.ok) {
      notify({
        kind: 'info',
        title: 'TRẠNG THÁI VOUCHER',
        message: `Đã chuyển ${item.code} sang trạng thái ${nextStatus}.`,
      });
      await loadPromotions();
      onRefreshOverview?.();
    } else {
      notify({
        kind: 'error',
        title: 'LỖI CẬP NHẬT',
        message: res.error?.message || 'Không thể thay đổi trạng thái khuyến mãi.',
      });
    }
  };

  const handleArchivePromotion = async (item: AdminPromotionItem) => {
    if (!canManagePromos) return;
    setArchivingId(item.id);
    const res = await adminFetch<unknown>(
      `/api/v1/admin/promotions/${encodeURIComponent(item.id)}`,
      {
        method: 'DELETE',
      },
    );
    setArchivingId(null);
    setConfirmArchiveId(null);

    if (res.ok) {
      notify({
        kind: 'success',
        title: 'LƯU TRỮ KHUYẾN MÃI',
        message: `Đã vô hiệu hóa / lưu trữ mã ${item.code}.`,
      });
      await loadPromotions();
      onRefreshOverview?.();
    } else {
      notify({
        kind: 'error',
        title: 'LƯU TRỮ THẤT BẠI',
        message: res.error?.message || 'Không thể lưu trữ mã khuyến mãi.',
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
    : 'border-[#B08A4A]/35 bg-[#FBF7EF] text-[#1C1410] placeholder:text-[#7A6A5B] focus:border-[#1C1410]';
  const tableHeadCls = darkMode
    ? 'border-b border-[#B08A4A]/25 bg-[#241A13] text-[#EBCF8F]'
    : 'border-b border-[#B08A4A]/20 bg-[#F4EBDA]/75 text-[#8A672C]';
  const rowHoverCls = darkMode ? 'hover:bg-[#251B14]' : 'hover:bg-[#FBF7EF]/85';

  const getStatusBadgeCls = (status: string): string => {
    if (status === 'NHAP_AI') {
      return darkMode
        ? 'border-[#EBCF8F]/60 bg-[#3B2A14] text-[#EBCF8F]'
        : 'border-[#B08A4A] bg-[#FEF4E1] text-[#7A5216]';
    }
    if (status === 'ACTIVE') {
      return darkMode
        ? 'border-emerald-500/45 bg-emerald-950/55 text-emerald-300'
        : 'border-[#2E6B47]/35 bg-[#EBF9F1] text-[#1E4B32]';
    }
    if (status === 'PAUSED' || status === 'INACTIVE') {
      return darkMode
        ? 'border-amber-500/40 bg-amber-950/50 text-amber-300'
        : 'border-[#D9822B]/40 bg-[#FFF6E5] text-[#9A5B13]';
    }
    return darkMode
      ? 'border-[#7A6A5B]/40 bg-[#261E19] text-[#B4A391]'
      : 'border-[#7A6A5B]/35 bg-[#F4EBDA]/65 text-[#5C4B41]';
  };

  return (
    <div data-testid="promotions-tab" className="space-y-6">
      {/* Header & KPI Strip */}
      <section className={`rounded-3xl border p-6 ${cardCls}`}>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <p className={`ledger-eyebrow ${goldTextCls}`}>
              Promotions &amp; Vouchers Engine · HITL AI Clearance Governance
            </p>
            <h2 className="font-editorial mt-1 text-3xl font-normal tracking-tight">
              Quản trị Khuyến mãi, Voucher &amp; Duyệt Chiến dịch AI
            </h2>
            <p className={`mt-1 text-xs leading-relaxed ${mutedCls}`}>
              Điều phối toàn bộ mã giảm giá Storefront (phần trăm, tiền mặt, miễn
              phí vận chuyển) và phê duyệt Human-in-the-Loop các chiến dịch xả
              kho lẻ size <code>NHAP_AI</code> từ MCP Copilot.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            <button
              type="button"
              onClick={() => void loadPromotions()}
              disabled={loading}
              className={`rounded-full border px-4 py-2 text-xs transition-colors disabled:opacity-50 ${
                darkMode
                  ? 'border-[#B08A4A]/45 text-[#EBCF8F] hover:bg-[#2A1E17]'
                  : 'border-[#B08A4A]/45 text-[#8A672C] hover:bg-[#FBF7EF]'
              }`}
            >
              {loading ? 'Đang tải...' : 'Làm mới'}
            </button>
            {canManagePromos ? (
              <button
                type="button"
                data-testid="promo-create-open-btn"
                onClick={openCreateModal}
                className={`rounded-full px-5 py-2 text-xs font-medium uppercase tracking-[0.14em] transition-opacity hover:opacity-90 ${
                  darkMode
                    ? 'bg-[#EBCF8F] text-[#1C1410]'
                    : 'bg-[#1C1410] text-[#EBCF8F]'
                }`}
              >
                + Tạo Voucher mới
              </button>
            ) : null}
          </div>
        </div>

        {errorMsg ? (
          <div
            role="alert"
            className={`mt-4 rounded-2xl border px-4 py-3 text-xs ${
              darkMode
                ? 'border-rose-500/45 bg-rose-950/40 text-rose-200'
                : 'border-[#8B2E2E]/35 bg-[#FFF5F4] text-[#8B2E2E]'
            }`}
          >
            {errorMsg}
          </div>
        ) : null}

        <div className="mt-5 grid grid-cols-1 gap-3.5 sm:grid-cols-2 xl:grid-cols-4">
          <div className={`rounded-2xl border p-4 ${subCardCls}`}>
            <p className={`text-[10px] font-semibold uppercase tracking-[0.16em] ${mutedCls}`}>
              Tổng chiến dịch &amp; mã
            </p>
            <p className="adm-tabular mt-1.5 font-mono text-3xl font-semibold">
              {kpis.total}
            </p>
            <p className={`mt-1 text-[11px] ${secondaryCls}`}>
              Sổ cái payment-promo (:4007)
            </p>
          </div>

          <div className={`rounded-2xl border p-4 ${subCardCls}`}>
            <p className={`text-[10px] font-semibold uppercase tracking-[0.16em] ${mutedCls}`}>
              Đang kích hoạt (ACTIVE)
            </p>
            <p
              className={`adm-tabular mt-1.5 font-mono text-3xl font-semibold ${
                darkMode ? 'text-emerald-300' : 'text-[#1E4B32]'
              }`}
            >
              {kpis.active}
            </p>
            <p className={`mt-1 text-[11px] ${secondaryCls}`}>
              Khả dụng ngay trên Storefront
            </p>
          </div>

          <div
            className={`rounded-2xl border p-4 ${
              kpis.drafts > 0
                ? darkMode
                  ? 'border-[#EBCF8F]/60 bg-[#2E2012] text-[#FBF7EF]'
                  : 'border-[#B08A4A] bg-[#FEF6E4] text-[#1C1410]'
                : subCardCls
            }`}
          >
            <p className={`text-[10px] font-semibold uppercase tracking-[0.16em] ${goldTextCls}`}>
              Nháp AI chờ phê duyệt (NHAP_AI)
            </p>
            <p className={`adm-tabular mt-1.5 font-mono text-3xl font-semibold ${goldTextCls}`}>
              {kpis.drafts}
            </p>
            <p className={`mt-1 text-[11px] ${secondaryCls}`}>
              Khóa HITL — chưa hiển thị công khai
            </p>
          </div>

          <div className={`rounded-2xl border p-4 ${subCardCls}`}>
            <p className={`text-[10px] font-semibold uppercase tracking-[0.16em] ${mutedCls}`}>
              Tổng lượt áp dụng
            </p>
            <p className="adm-tabular mt-1.5 font-mono text-3xl font-semibold">
              {kpis.totalUsed}
            </p>
            <p className={`mt-1 text-[11px] ${secondaryCls}`}>
              Lượt khóa &amp; thanh toán thành công
            </p>
          </div>
        </div>
      </section>

      {/* Highlighted HITL AI Draft Approval Queue */}
      {aiDrafts.length > 0 ? (
        <section
          data-testid="promo-ai-drafts-banner"
          className={`rounded-3xl border-2 p-6 ${
            darkMode
              ? 'border-[#EBCF8F]/55 bg-[#231910] text-[#FBF7EF]'
              : 'border-[#B08A4A]/70 bg-[#FDF5E4] text-[#1C1410]'
          }`}
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className={`ledger-eyebrow ${goldTextCls}`}>
                Human-in-the-Loop · Chiến dịch Xả kho Lẻ size từ AI Copilot
              </p>
              <h3 className="font-editorial mt-0.5 text-2xl">
                {aiDrafts.length} bản nháp <code>NHAP_AI</code> đang chờ phê duyệt kích hoạt
              </h3>
            </div>
            <span className="rounded-full border border-[#B08A4A]/50 bg-[#1C1410] px-3 py-1 font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-[#EBCF8F]">
              STRICT NHAP_AI LOCK
            </span>
          </div>

          <div className="mt-4 grid gap-3 lg:grid-cols-2">
            {aiDrafts.map((draft) => (
              <article
                key={draft.id}
                data-testid={`promo-ai-draft-card-${draft.code}`}
                className={`flex flex-col justify-between gap-3 rounded-2xl border p-4 ${
                  darkMode
                    ? 'border-[#B08A4A]/35 bg-[#16100C]'
                    : 'border-[#B08A4A]/40 bg-white'
                }`}
              >
                <div>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="rounded-lg bg-[#1C1410] px-2.5 py-1 font-mono text-xs font-bold tracking-wider text-[#EBCF8F]">
                        {draft.code}
                      </span>
                      <span className={`rounded-full border px-2.5 py-0.5 font-mono text-[10px] font-semibold ${getStatusBadgeCls(draft.status)}`}>
                        {draft.status}
                      </span>
                    </div>
                    <span className={`font-mono text-[10px] ${goldTextCls}`}>
                      {PROMO_TYPE_LABEL[draft.type] ?? draft.type}
                    </span>
                  </div>

                  <h4 className="font-editorial mt-2 text-xl font-medium">
                    {draft.name}
                  </h4>
                  {draft.description ? (
                    <p className={`mt-1 text-xs leading-relaxed ${secondaryCls}`}>
                      {draft.description}
                    </p>
                  ) : null}

                  <div className={`mt-2.5 flex flex-wrap gap-2 font-mono text-[11px] ${mutedCls}`}>
                    <span className="rounded-md bg-[#B08A4A]/15 px-2 py-0.5 text-[#8A672C] dark:text-[#EBCF8F]">
                      {formatDiscountSummary(draft)}
                    </span>
                    <span>
                      Đơn tối thiểu: {FORMAT_VND(draft.minOrderVnd)}
                    </span>
                    <span>
                      Giới hạn: {draft.usageLimit ?? '∞'} lượt
                    </span>
                  </div>

                  {draft.applicableSkus.length > 0 ? (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {draft.applicableSkus.map((sku) => (
                        <span
                          key={sku}
                          className={`rounded-md border px-2 py-0.5 font-mono text-[10px] ${
                            darkMode
                              ? 'border-[#B08A4A]/30 bg-[#231912] text-[#EBCF8F]'
                              : 'border-[#B08A4A]/30 bg-[#FBF7EF] text-[#5C4B41]'
                          }`}
                        >
                          {sku}
                        </span>
                      ))}
                    </div>
                  ) : null}
                </div>

                <div className="flex flex-wrap items-center justify-end gap-2 border-t border-[#B08A4A]/20 pt-3">
                  {canApproveDrafts ? (
                    <>
                      {canManagePromos ? (
                        <button
                          type="button"
                          onClick={() => openEditModal(draft)}
                          className={`rounded-full border px-3.5 py-1.5 text-[11px] ${
                            darkMode
                              ? 'border-[#B08A4A]/40 text-[#EBCF8F] hover:bg-[#2A1E17]'
                              : 'border-[#B08A4A]/45 text-[#5C4B41] hover:bg-[#FBF7EF]'
                          }`}
                        >
                          Điều chỉnh thông số
                        </button>
                      ) : null}
                      <button
                        type="button"
                        data-testid={`promo-approve-draft-${draft.id}`}
                        disabled={approvingId === draft.id}
                        onClick={() => void handleApproveDraft(draft)}
                        className="rounded-full bg-[#1E4B32] px-4 py-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-[#FBF7EF] shadow-sm transition-opacity hover:opacity-90 disabled:opacity-50"
                      >
                        {approvingId === draft.id
                          ? 'Đang phê duyệt...'
                          : '✓ Phê duyệt & Kích hoạt (HITL)'}
                      </button>
                    </>
                  ) : (
                    <span className={`font-mono text-[10px] ${mutedCls}`}>
                      Cần quyền quản trị khuyến mãi để phê duyệt
                    </span>
                  )}
                </div>
              </article>
            ))}
          </div>
        </section>
      ) : null}

      {/* Filter Bar + Promotions Ledger Table */}
      <section className={`overflow-hidden rounded-3xl border ${cardCls}`}>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#B08A4A]/20 px-6 py-4">
          <div className="flex flex-wrap items-center gap-1.5">
            {(
              [
                ['ALL', `Tất cả (${promotions.length})`],
                ['NHAP_AI', `NHAP_AI (${aiDrafts.length})`],
                ['ACTIVE', 'Đang chạy'],
                ['PAUSED', 'Tạm dừng'],
                ['INACTIVE', 'Tạm ngưng'],
                ['EXPIRED', 'Hết hạn'],
                ['ARCHIVED', 'Lưu trữ'],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setStatusFilter(key)}
                className={`rounded-full px-3 py-1 text-[11px] font-medium transition-colors ${
                  statusFilter === key
                    ? darkMode
                      ? 'bg-[#EBCF8F] text-[#1C1410]'
                      : 'bg-[#1C1410] text-[#EBCF8F]'
                    : darkMode
                      ? 'border border-[#B08A4A]/30 bg-[#231912] text-[#DFD2C2] hover:border-[#EBCF8F]'
                      : 'border border-[#B08A4A]/30 bg-[#FBF7EF] text-[#5C4B41] hover:border-[#1C1410]'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <select
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value)}
              aria-label="Lọc theo loại khuyến mãi"
              className={`rounded-full border px-3.5 py-1.5 text-xs outline-none ${inputCls}`}
            >
              <option value="ALL">Mọi loại ưu đãi</option>
              <option value="PERCENTAGE">Phần trăm (%)</option>
              <option value="FIXED_AMOUNT">Số tiền cố định (₫)</option>
              <option value="FREESHIP">Miễn phí vận chuyển</option>
              <option value="CLEARANCE_ODD_SIZE">Xả kho lẻ size (AI)</option>
              <option value="OUTFIT_COMBO">Combo Mix &amp; Match</option>
              <option value="FLASH_SALE">Flash Sale</option>
            </select>

            <input
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Tìm mã voucher, tên, SKU..."
              className={`w-56 rounded-full border px-3.5 py-1.5 text-xs outline-none ${inputCls}`}
            />
          </div>
        </div>

        {loading ? (
          <div className={`p-8 text-center text-xs ${mutedCls}`}>
            Đang tải sổ cái khuyến mãi &amp; voucher từ payment-promo (:4007)...
          </div>
        ) : filteredPromotions.length === 0 ? (
          <div className={`p-10 text-center text-xs ${mutedCls}`}>
            Không tìm thấy mã khuyến mãi nào phù hợp với bộ lọc hiện tại.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className={`text-[10px] uppercase tracking-[0.14em] ${tableHeadCls}`}>
                <tr>
                  <th className="px-5 py-3">Mã &amp; Chiến dịch</th>
                  <th className="px-4 py-3">Loại &amp; Mức giảm</th>
                  <th className="px-4 py-3">Điều kiện &amp; Lượt dùng</th>
                  <th className="px-4 py-3">Hiệu lực</th>
                  <th className="px-4 py-3">Trạng thái</th>
                  <th className="px-5 py-3 text-right">Thao tác</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#B08A4A]/15">
                {filteredPromotions.map((item) => {
                  const isAiDraft = item.status === 'NHAP_AI';
                  const usagePct =
                    item.usageLimit && item.usageLimit > 0
                      ? Math.min(100, Math.round((item.usedCount / item.usageLimit) * 100))
                      : 0;

                  return (
                    <tr
                      key={item.id}
                      className={`transition-colors ${
                        isAiDraft
                          ? darkMode
                            ? 'bg-[#2C2012]/70 hover:bg-[#342615]'
                            : 'bg-[#FEF8EC] hover:bg-[#FDF1D6]'
                          : rowHoverCls
                      }`}
                    >
                      <td className="px-5 py-3.5 align-top">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="rounded-md bg-[#1C1410] px-2 py-0.5 font-mono text-[11px] font-bold tracking-wider text-[#EBCF8F]">
                            {item.code}
                          </span>
                          {item.createdByActorType === 'AI_COPILOT' || isAiDraft ? (
                            <span className="rounded-full border border-[#B08A4A]/45 bg-[#B08A4A]/15 px-2 py-0.5 font-mono text-[9.5px] font-semibold text-[#8A672C] dark:text-[#EBCF8F]">
                              AI COPILOT
                            </span>
                          ) : null}
                        </div>
                        <p className="mt-1 font-medium">{item.name}</p>
                        {item.description ? (
                          <p className={`mt-0.5 line-clamp-2 max-w-xs text-[11px] ${mutedCls}`}>
                            {item.description}
                          </p>
                        ) : null}
                        {item.applicableSkus.length > 0 || item.applicableSpuIds.length > 0 ? (
                          <p className={`mt-1 font-mono text-[10px] ${goldTextCls}`}>
                            Phạm vi: {item.applicableSkus.length} SKU · {item.applicableSpuIds.length} SPU
                          </p>
                        ) : null}
                      </td>

                      <td className="px-4 py-3.5 align-top">
                        <span className={`block font-mono text-[10px] uppercase ${mutedCls}`}>
                          {PROMO_TYPE_LABEL[item.type] ?? item.type}
                        </span>
                        <p className="adm-tabular mt-0.5 font-semibold">
                          {formatDiscountSummary(item)}
                        </p>
                      </td>

                      <td className="px-4 py-3.5 align-top">
                        <p className="adm-tabular text-[11px]">
                          Đơn tối thiểu:{' '}
                          <strong className="font-mono">
                            {FORMAT_VND(item.minOrderVnd)}
                          </strong>
                        </p>
                        <div className="mt-1.5 flex items-center gap-2 font-mono text-[10.5px]">
                          <span className="adm-tabular">
                            {item.usedCount} / {item.usageLimit ?? '∞'}
                          </span>
                          {item.usageLimit ? (
                            <div className="h-1.5 w-20 overflow-hidden rounded-full bg-[#B08A4A]/20">
                              <div
                                className="h-full rounded-full bg-[#B08A4A]"
                                style={{ width: `${usagePct}%` }}
                              />
                            </div>
                          ) : null}
                        </div>
                      </td>

                      <td className="px-4 py-3.5 align-top font-mono text-[10.5px]">
                        <p className={secondaryCls}>
                          Từ: {formatDateTimeVi(item.startsAt)}
                        </p>
                        <p className={`mt-0.5 ${mutedCls}`}>
                          Đến: {formatDateTimeVi(item.endsAt)}
                        </p>
                      </td>

                      <td className="px-4 py-3.5 align-top">
                        <span
                          className={`inline-flex rounded-full border px-2.5 py-0.5 font-mono text-[10px] font-semibold ${getStatusBadgeCls(item.status)}`}
                        >
                          {PROMO_STATUS_LABEL[item.status] ?? item.status}
                        </span>
                      </td>

                      <td className="px-5 py-3.5 text-right align-top">
                        {canManagePromos ? (
                          <div className="flex flex-wrap items-center justify-end gap-1.5">
                            {isAiDraft ? (
                              <button
                                type="button"
                                disabled={approvingId === item.id}
                                onClick={() => void handleApproveDraft(item)}
                                className="rounded-full bg-[#1E4B32] px-3 py-1 text-[10.5px] font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                              >
                                {approvingId === item.id
                                  ? 'Đang duyệt...'
                                  : 'Phê duyệt (HITL)'}
                              </button>
                            ) : item.status !== 'ARCHIVED' ? (
                              <button
                                type="button"
                                disabled={togglingId === item.id}
                                onClick={() => void handleToggleActive(item)}
                                className={`rounded-full border px-3 py-1 text-[10.5px] transition-colors disabled:opacity-50 ${
                                  darkMode
                                    ? 'border-[#B08A4A]/40 text-[#EBCF8F] hover:bg-[#2A1E17]'
                                    : 'border-[#B08A4A]/45 text-[#5C4B41] hover:bg-[#F4EBDA]'
                                }`}
                              >
                                {item.status === 'ACTIVE' ? 'Tạm dừng' : 'Kích hoạt'}
                              </button>
                            ) : null}

                            <button
                              type="button"
                              onClick={() => openEditModal(item)}
                              className={`rounded-full border px-3 py-1 text-[10.5px] ${
                                darkMode
                                  ? 'border-[#B08A4A]/35 text-[#DFD2C2] hover:border-[#EBCF8F]'
                                  : 'border-[#B08A4A]/35 text-[#1C1410] hover:border-[#1C1410]'
                              }`}
                            >
                              Sửa
                            </button>

                            {item.status !== 'ARCHIVED' ? (
                              confirmArchiveId === item.id ? (
                                <div className="flex items-center gap-1">
                                  <button
                                    type="button"
                                    disabled={archivingId === item.id}
                                    onClick={() => void handleArchivePromotion(item)}
                                    className="rounded-full bg-[#8B2E2E] px-2.5 py-1 text-[10px] font-semibold text-white"
                                  >
                                    {archivingId === item.id ? '...' : 'Xác nhận'}
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => setConfirmArchiveId(null)}
                                    className="rounded-full border border-[#B08A4A]/35 px-2 py-1 text-[10px]"
                                  >
                                    Hủy
                                  </button>
                                </div>
                              ) : (
                                <button
                                  type="button"
                                  onClick={() => setConfirmArchiveId(item.id)}
                                  className="rounded-full border border-[#8B2E2E]/45 px-3 py-1 text-[10.5px] text-[#8B2E2E] hover:bg-[#8B2E2E]/10 dark:text-rose-300"
                                >
                                  Lưu trữ
                                </button>
                              )
                            ) : null}
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

      {/* Create / Edit Promotion Modal */}
      {modalOpen ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={form.id ? 'Chỉnh sửa mã khuyến mãi' : 'Tạo mã khuyến mãi mới'}
          className="fixed inset-0 z-50 flex items-center justify-center bg-[#0D0805]/65 p-4 backdrop-blur-xs"
        >
          <form
            onSubmit={handleSavePromotion}
            className={`max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-3xl border p-6 shadow-2xl ${cardCls}`}
          >
            <div className="flex items-start justify-between gap-4 border-b border-[#B08A4A]/20 pb-4">
              <div>
                <p className={`ledger-eyebrow ${goldTextCls}`}>
                  {form.id ? 'Cập nhật Voucher / Chiến dịch' : 'Khởi tạo Voucher / Chiến dịch mới'}
                </p>
                <h3 className="font-editorial mt-0.5 text-2xl">
                  {form.id ? `Chỉnh sửa ${form.code}` : 'Thiết lập Mã ưu đãi Storefront'}
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
              <label className="text-xs">
                <span className={secondaryCls}>Mã Voucher (code) *</span>
                <input
                  type="text"
                  required
                  value={form.code}
                  onChange={(e) =>
                    setForm({ ...form, code: e.target.value.toUpperCase() })
                  }
                  placeholder="VD: ATELIER20"
                  className={`mt-1 w-full rounded-xl border px-3 py-2 font-mono text-xs uppercase outline-none ${inputCls}`}
                />
              </label>

              <label className="text-xs">
                <span className={secondaryCls}>Trạng thái khởi tạo</span>
                <select
                  value={form.status}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      status: e.target.value as PromoFormState['status'],
                    })
                  }
                  className={`mt-1 w-full rounded-xl border px-3 py-2 text-xs outline-none ${inputCls}`}
                >
                  <option value="ACTIVE">ACTIVE (Kích hoạt ngay)</option>
                  <option value="INACTIVE">INACTIVE (Chưa kích hoạt)</option>
                  <option value="PAUSED">PAUSED (Tạm dừng)</option>
                  <option value="NHAP_AI">NHAP_AI (Bản nháp chờ duyệt HITL)</option>
                </select>
              </label>

              <label className="text-xs sm:col-span-2">
                <span className={secondaryCls}>Tên chiến dịch *</span>
                <input
                  type="text"
                  required
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="VD: Ưu đãi Bộ sưu tập Lụa Thu Đông 2026"
                  className={`mt-1 w-full rounded-xl border px-3 py-2 text-xs outline-none ${inputCls}`}
                />
              </label>

              <label className="text-xs sm:col-span-2">
                <span className={secondaryCls}>Mô tả hiển thị / Ghi chú nội bộ</span>
                <textarea
                  rows={2}
                  value={form.description}
                  onChange={(e) =>
                    setForm({ ...form, description: e.target.value })
                  }
                  placeholder="Điều kiện áp dụng hoặc lý do chiến dịch xả kho..."
                  className={`mt-1 w-full rounded-xl border px-3 py-2 text-xs outline-none ${inputCls}`}
                />
              </label>

              <label className="text-xs">
                <span className={secondaryCls}>Loại ưu đãi *</span>
                <select
                  value={form.discountType}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      discountType: e.target.value as PromoFormDiscountType,
                    })
                  }
                  className={`mt-1 w-full rounded-xl border px-3 py-2 text-xs outline-none ${inputCls}`}
                >
                  <option value="PERCENTAGE">PERCENTAGE · Giảm theo phần trăm (%)</option>
                  <option value="FIXED_AMOUNT">FIXED_AMOUNT · Giảm tiền cố định (₫)</option>
                  <option value="FREESHIP">FREESHIP · Miễn phí vận chuyển</option>
                  <option value="CLEARANCE_ODD_SIZE">CLEARANCE_ODD_SIZE · Xả kho lẻ size (%)</option>
                  <option value="OUTFIT_COMBO">OUTFIT_COMBO · Combo Mix &amp; Match (%)</option>
                  <option value="FLASH_SALE">FLASH_SALE · Flash Sale</option>
                </select>
              </label>

              {form.discountType !== 'FREESHIP' ? (
                <label className="text-xs">
                  <span className={secondaryCls}>
                    {form.discountType === 'FIXED_AMOUNT'
                      ? 'Số tiền giảm (VND) *'
                      : 'Mức giảm (%) *'}
                  </span>
                  <input
                    type="number"
                    required
                    min={1}
                    max={form.discountType === 'FIXED_AMOUNT' ? undefined : 100}
                    value={form.discountValue}
                    onChange={(e) =>
                      setForm({ ...form, discountValue: e.target.value })
                    }
                    className={`mt-1 w-full rounded-xl border px-3 py-2 font-mono text-xs outline-none ${inputCls}`}
                  />
                </label>
              ) : (
                <div className={`flex items-end pb-2 text-[11px] ${mutedCls}`}>
                  Tự động miễn phí vận chuyển (nhập mức hỗ trợ tối đa ở ô bên dưới).
                </div>
              )}

              <label className="text-xs">
                <span className={secondaryCls}>Giảm tối đa (maxDiscountVnd)</span>
                <input
                  type="number"
                  min={0}
                  value={form.maxDiscountVnd}
                  onChange={(e) =>
                    setForm({ ...form, maxDiscountVnd: e.target.value })
                  }
                  placeholder="VD: 300000 (bỏ trống nếu không trần)"
                  className={`mt-1 w-full rounded-xl border px-3 py-2 font-mono text-xs outline-none ${inputCls}`}
                />
              </label>

              <label className="text-xs">
                <span className={secondaryCls}>Đơn hàng tối thiểu (minOrderVnd)</span>
                <input
                  type="number"
                  min={0}
                  value={form.minOrderVnd}
                  onChange={(e) =>
                    setForm({ ...form, minOrderVnd: e.target.value })
                  }
                  className={`mt-1 w-full rounded-xl border px-3 py-2 font-mono text-xs outline-none ${inputCls}`}
                />
              </label>

              <label className="text-xs">
                <span className={secondaryCls}>Tổng lượt dùng (usageLimit)</span>
                <input
                  type="number"
                  min={1}
                  value={form.usageLimit}
                  onChange={(e) =>
                    setForm({ ...form, usageLimit: e.target.value })
                  }
                  placeholder="Để trống = không giới hạn"
                  className={`mt-1 w-full rounded-xl border px-3 py-2 font-mono text-xs outline-none ${inputCls}`}
                />
              </label>

              <label className="text-xs">
                <span className={secondaryCls}>Lượt tối đa / Khách hàng</span>
                <input
                  type="number"
                  min={1}
                  value={form.perUserLimit}
                  onChange={(e) =>
                    setForm({ ...form, perUserLimit: e.target.value })
                  }
                  placeholder="VD: 1"
                  className={`mt-1 w-full rounded-xl border px-3 py-2 font-mono text-xs outline-none ${inputCls}`}
                />
              </label>

              <label className="text-xs">
                <span className={secondaryCls}>Bắt đầu hiệu lực (startsAt)</span>
                <input
                  type="datetime-local"
                  value={form.startsAt}
                  onChange={(e) =>
                    setForm({ ...form, startsAt: e.target.value })
                  }
                  className={`mt-1 w-full rounded-xl border px-3 py-2 font-mono text-xs outline-none ${inputCls}`}
                />
              </label>

              <label className="text-xs">
                <span className={secondaryCls}>Kết thúc hiệu lực (endsAt)</span>
                <input
                  type="datetime-local"
                  value={form.endsAt}
                  onChange={(e) => setForm({ ...form, endsAt: e.target.value })}
                  className={`mt-1 w-full rounded-xl border px-3 py-2 font-mono text-xs outline-none ${inputCls}`}
                />
              </label>

              <label className="text-xs sm:col-span-2">
                <span className={secondaryCls}>
                  Mã SKU áp dụng (ngăn cách bằng dấu phẩy — bỏ trống để áp dụng toàn bộ)
                </span>
                <input
                  type="text"
                  value={form.applicableSkusText}
                  onChange={(e) =>
                    setForm({ ...form, applicableSkusText: e.target.value })
                  }
                  placeholder="VD: TX-BLZ-KEM-XS, TX-BLZ-KEM-XL"
                  className={`mt-1 w-full rounded-xl border px-3 py-2 font-mono text-xs outline-none ${inputCls}`}
                />
              </label>

              {/* Multi-SPU Picker */}
              <div className="sm:col-span-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className={`text-xs ${secondaryCls}`}>
                    Phạm vi SPU áp dụng ({form.applicableSpuIds.length} đã chọn)
                  </span>
                  <input
                    type="search"
                    value={spuSearch}
                    onChange={(e) => setSpuSearch(e.target.value)}
                    placeholder="Lọc sản phẩm SPU..."
                    className={`w-48 rounded-full border px-3 py-1 text-[11px] outline-none ${inputCls}`}
                  />
                </div>
                <div
                  className={`mt-2 grid max-h-36 gap-1.5 overflow-y-auto rounded-2xl border p-2.5 sm:grid-cols-2 ${subCardCls}`}
                >
                  {filteredSpus.map((prod) => {
                    const checked = form.applicableSpuIds.includes(prod.id);
                    return (
                      <label
                        key={prod.id}
                        className={`flex cursor-pointer items-center gap-2 rounded-xl border px-2.5 py-1.5 text-[11px] transition-colors ${
                          checked
                            ? darkMode
                              ? 'border-[#EBCF8F]/60 bg-[#2D2116] text-[#EBCF8F]'
                              : 'border-[#1C1410] bg-[#1C1410] text-[#EBCF8F]'
                            : 'border-transparent hover:border-[#B08A4A]/35'
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => handleToggleSpu(prod.id)}
                          className="accent-[#B08A4A]"
                        />
                        <span className="truncate">{prod.name}</span>
                      </label>
                    );
                  })}
                  {filteredSpus.length === 0 ? (
                    <p className={`col-span-2 py-2 text-center text-[11px] ${mutedCls}`}>
                      Không tìm thấy sản phẩm SPU phù hợp.
                    </p>
                  ) : null}
                </div>
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
                disabled={saving}
                data-testid="promo-save-submit-btn"
                className={`rounded-full px-6 py-2 text-xs font-semibold uppercase tracking-[0.14em] disabled:opacity-50 ${
                  darkMode
                    ? 'bg-[#EBCF8F] text-[#1C1410]'
                    : 'bg-[#1C1410] text-[#EBCF8F]'
                }`}
              >
                {saving
                  ? 'Đang lưu...'
                  : form.id
                    ? 'Lưu thay đổi'
                    : 'Tạo khuyến mãi'}
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </div>
  );
}
