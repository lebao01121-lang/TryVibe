'use client';

import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  Permission,
  Role,
  hasPermission,
  type ProductSpuDto,
} from '@atelier/contracts';
import {
  AnimatedTelemetryNumber,
  LiveStreamProgressBar,
} from '@atelier/motion-kit';
import {
  adminFetch,
  getAdminSession,
  type AdminStoredSession,
} from '@/lib/api-client';
import { emitPortalToast } from '../PortalToastBanner';
import { HomepageCampaignTab } from './HomepageCampaignTab';

export interface EditorialCmsNotifyPayload {
  kind: 'success' | 'error' | 'info';
  title?: string;
  message: string;
}

export interface EditorialCmsTabProps {
  roles?: readonly Role[];
  session?: AdminStoredSession | null;
  mfaVerified?: boolean;
  darkMode?: boolean;
  onNotify?: (payload: EditorialCmsNotifyPayload) => void;
  onRefreshOverview?: () => void;
}

type EditorialSection = 'CAMPAIGN' | 'OCCASIONS' | 'SEASONS';

interface OpticalSwatchEntry {
  name: string;
  hex: string;
  fabricNote: string;
}

interface OccasionAdminItem {
  id: string;
  slug: string;
  key: string;
  name: string;
  tagline: string;
  description: string;
  themeBg: string;
  themeInk: string;
  themeAccent: string;
  isDark: boolean;
  badgeTag: string;
  coverImageUrl: string;
  sortOrder: number;
  isActive: boolean;
  spuIds: string[];
  productSlugs: string[];
}

interface SeasonAdminItem {
  id: string;
  slug: string;
  name: string;
  months: string;
  subtitle: string;
  materialHeadline: string;
  note: string;
  heroImageUrl: string;
  seasonOrder: number;
  isCurrent: boolean;
  isActive: boolean;
  swatches: OpticalSwatchEntry[];
  spuIds: string[];
  productSlugs: string[];
}

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

function toStringArray(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.map((x) => String(x).trim()).filter(Boolean);
  }
  return [];
}

function parseSwatches(raw: unknown): OpticalSwatchEntry[] {
  let list: unknown = raw;
  if (typeof raw === 'string') {
    try {
      list = JSON.parse(raw) as unknown;
    } catch {
      return [];
    }
  }
  if (!Array.isArray(list)) return [];
  return list
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return null;
      const rec = entry as Record<string, unknown>;
      return {
        name: String(rec.name ?? rec.colorName ?? 'Màu vải'),
        hex: String(rec.hex ?? rec.colorHex ?? '#B08A4A'),
        fabricNote: String(rec.fabricNote ?? rec.note ?? rec.fabric ?? ''),
      };
    })
    .filter((x): x is OpticalSwatchEntry => Boolean(x));
}

function normalizeOccasion(raw: Record<string, unknown>): OccasionAdminItem {
  const featured = Array.isArray(raw.featuredProducts)
    ? (raw.featuredProducts as Array<Record<string, unknown>>)
    : [];
  const items = Array.isArray(raw.items)
    ? (raw.items as Array<Record<string, unknown>>)
    : [];

  const spuIds = toStringArray(raw.spuIds ?? raw.productIds);
  const derivedIds =
    spuIds.length > 0
      ? spuIds
      : [
          ...featured.map((f) => String(f.id ?? '')),
          ...items.map((it) => String(it.productId ?? '')),
        ].filter(Boolean);

  const productSlugs = toStringArray(raw.productSlugs);

  return {
    id: String(raw.id ?? ''),
    slug: String(raw.slug ?? ''),
    key: String(raw.key ?? raw.slug ?? ''),
    name: String(raw.name ?? ''),
    tagline: String(raw.tagline ?? ''),
    description: String(raw.description ?? ''),
    themeBg: String(raw.themeBg ?? '#FBF7EF'),
    themeInk: String(raw.themeInk ?? '#1C1410'),
    themeAccent: String(raw.themeAccent ?? '#B08A4A'),
    isDark: Boolean(raw.isDark),
    badgeTag: String(raw.badgeTag ?? ''),
    coverImageUrl: String(
      raw.coverImageUrl ?? raw.heroCutoutUrl ?? raw.macroImageUrl ?? '',
    ),
    sortOrder: Number(raw.sortOrder ?? 0) || 0,
    isActive: raw.isActive !== false,
    spuIds: Array.from(new Set(derivedIds)),
    productSlugs,
  };
}

function normalizeSeason(raw: Record<string, unknown>): SeasonAdminItem {
  const heroProducts = Array.isArray(raw.heroProducts)
    ? (raw.heroProducts as Array<Record<string, unknown>>)
    : [];
  const spuIds = toStringArray(raw.spuIds ?? raw.productIds);
  const derivedIds =
    spuIds.length > 0
      ? spuIds
      : heroProducts.map((p) => String(p.id ?? '')).filter(Boolean);

  const productSlugs = toStringArray(
    raw.productSlugs ?? raw.featuredProductSlugs,
  );
  const swatches = parseSwatches(
    raw.swatches ?? raw.paletteJsonb ?? raw.colorSwatches,
  );

  return {
    id: String(raw.id ?? ''),
    slug: String(raw.slug ?? raw.code ?? ''),
    name: String(raw.name ?? ''),
    months: String(raw.months ?? raw.subtitle ?? ''),
    subtitle: String(raw.subtitle ?? raw.shortName ?? raw.months ?? ''),
    materialHeadline: String(raw.materialHeadline ?? ''),
    note: String(raw.note ?? raw.description ?? ''),
    heroImageUrl: String(raw.heroImageUrl ?? raw.coverAssetUrl ?? ''),
    seasonOrder: Number(raw.seasonOrder ?? raw.sortOrder ?? 1) || 1,
    isCurrent: Boolean(raw.isCurrent ?? raw.isCurrentSeason ?? raw.isNow),
    isActive: raw.isActive !== false,
    swatches,
    spuIds: Array.from(new Set(derivedIds)),
    productSlugs,
  };
}

const EMPTY_OCCASION_FORM: OccasionAdminItem = {
  id: '',
  slug: '',
  key: '',
  name: '',
  tagline: '',
  description: '',
  themeBg: '#FBF7EF',
  themeInk: '#1C1410',
  themeAccent: '#B08A4A',
  isDark: false,
  badgeTag: '',
  coverImageUrl: '',
  sortOrder: 1,
  isActive: true,
  spuIds: [],
  productSlugs: [],
};

const EMPTY_SEASON_FORM: SeasonAdminItem = {
  id: '',
  slug: '',
  name: '',
  months: 'Tháng 3 – Tháng 4',
  subtitle: '',
  materialHeadline: 'Lụa tơ tằm & Linen hữu cơ',
  note: '',
  heroImageUrl: '',
  seasonOrder: 1,
  isCurrent: false,
  isActive: true,
  swatches: [
    { name: 'Kem Ngà', hex: '#F4EBDA', fabricNote: 'Lụa 19mm bóng mờ' },
    { name: 'Vàng Đồng', hex: '#B08A4A', fabricNote: 'Tơ sống dệt chéo' },
  ],
  spuIds: [],
  productSlugs: [],
};

export function EditorialCmsTab({
  roles: rolesProp,
  session: sessionProp,
  mfaVerified,
  darkMode = false,
  onNotify,
  onRefreshOverview,
}: EditorialCmsTabProps) {
  const effectiveSession = sessionProp ?? getAdminSession();
  const roles = useMemo(
    () => rolesProp ?? effectiveSession?.user.roles ?? ([] as readonly Role[]),
    [rolesProp, effectiveSession],
  );
  const canWrite =
    roles.includes(Role.SUPER_ADMIN) ||
    hasPermission(roles, Permission.CATALOG_PRODUCT_WRITE);

  const notify = useCallback(
    (payload: EditorialCmsNotifyPayload) => {
      if (onNotify) onNotify(payload);
      else emitPortalToast(payload);
    },
    [onNotify],
  );

  const [section, setSection] = useState<EditorialSection>('CAMPAIGN');

  // Shared live catalog products for Multi-SPU Pickers
  const [products, setProducts] = useState<ProductSpuDto[]>([]);

  // Occasions state
  const [occasions, setOccasions] = useState<OccasionAdminItem[]>([]);
  const [occasionsLoading, setOccasionsLoading] = useState(false);
  const [occasionError, setOccasionError] = useState<string | null>(null);
  const [occasionModalOpen, setOccasionModalOpen] = useState(false);
  const [occasionForm, setOccasionForm] =
    useState<OccasionAdminItem>(EMPTY_OCCASION_FORM);
  const [occasionSaving, setOccasionSaving] = useState(false);
  const [occasionSpuSearch, setOccasionSpuSearch] = useState('');
  const [confirmDeleteOccasionId, setConfirmDeleteOccasionId] = useState<
    string | null
  >(null);

  // Seasons state
  const [seasons, setSeasons] = useState<SeasonAdminItem[]>([]);
  const [seasonsLoading, setSeasonsLoading] = useState(false);
  const [seasonError, setSeasonError] = useState<string | null>(null);
  const [seasonModalOpen, setSeasonModalOpen] = useState(false);
  const [seasonForm, setSeasonForm] =
    useState<SeasonAdminItem>(EMPTY_SEASON_FORM);
  const [seasonSaving, setSeasonSaving] = useState(false);
  const [seasonSpuSearch, setSeasonSpuSearch] = useState('');
  const [confirmDeleteSeasonId, setConfirmDeleteSeasonId] = useState<
    string | null
  >(null);

  const loadProducts = useCallback(async () => {
    const res = await adminFetch<unknown>('/api/v1/admin/products?limit=100');
    if (res.ok) {
      setProducts(
        extractList<ProductSpuDto>(res.data, ['items', 'products', 'list']),
      );
    }
  }, []);

  const loadOccasions = useCallback(async () => {
    setOccasionsLoading(true);
    setOccasionError(null);
    const res = await adminFetch<unknown>('/api/v1/admin/occasions');
    if (res.ok) {
      const list = extractList<Record<string, unknown>>(res.data, [
        'items',
        'occasions',
        'list',
      ]);
      setOccasions(
        list
          .map(normalizeOccasion)
          .sort((a, b) => a.sortOrder - b.sortOrder),
      );
    } else {
      setOccasionError(
        res.error?.message || 'Chưa thể tải danh sách Dịp mặc (Occasions).',
      );
    }
    setOccasionsLoading(false);
  }, []);

  const loadSeasons = useCallback(async () => {
    setSeasonsLoading(true);
    setSeasonError(null);
    const res = await adminFetch<unknown>('/api/v1/admin/seasons');
    if (res.ok) {
      const list = extractList<Record<string, unknown>>(res.data, [
        'items',
        'seasons',
        'list',
      ]);
      setSeasons(
        list
          .map(normalizeSeason)
          .sort((a, b) => a.seasonOrder - b.seasonOrder),
      );
    } else {
      setSeasonError(
        res.error?.message ||
          'Chưa thể tải danh sách 6 Mùa Lookbook (Seasons).',
      );
    }
    setSeasonsLoading(false);
  }, []);

  useEffect(() => {
    void loadProducts();
    void loadOccasions();
    void loadSeasons();
  }, [loadProducts, loadOccasions, loadSeasons]);

  // Helper to resolve productIds <-> slugs
  const productBySlug = useMemo(() => {
    const map = new Map<string, ProductSpuDto>();
    products.forEach((p) => map.set(p.slug, p));
    return map;
  }, [products]);

  const productById = useMemo(() => {
    const map = new Map<string, ProductSpuDto>();
    products.forEach((p) => map.set(p.id, p));
    return map;
  }, [products]);

  const resolveSelectedSpuIds = useCallback(
    (spuIds: string[], slugs: string[]): string[] => {
      const set = new Set<string>(spuIds);
      for (const s of slugs) {
        const match = productBySlug.get(s);
        if (match) set.add(match.id);
      }
      return Array.from(set);
    },
    [productBySlug],
  );

  // Occasion handlers
  const openCreateOccasion = () => {
    setOccasionForm({
      ...EMPTY_OCCASION_FORM,
      sortOrder: occasions.length + 1,
    });
    setOccasionSpuSearch('');
    setOccasionModalOpen(true);
  };

  const openEditOccasion = (item: OccasionAdminItem) => {
    setOccasionForm({
      ...item,
      spuIds: resolveSelectedSpuIds(item.spuIds, item.productSlugs),
    });
    setOccasionSpuSearch('');
    setOccasionModalOpen(true);
  };

  const handleSaveOccasion = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canWrite) return;

    const slug = (occasionForm.slug || slugifyVi(occasionForm.name)).trim();
    if (!occasionForm.name.trim() || !slug) {
      notify({
        kind: 'error',
        title: 'THIẾU THÔNG TIN',
        message: 'Tên dịp mặc và đường dẫn slug không được bỏ trống.',
      });
      return;
    }

    const selectedSlugs = occasionForm.spuIds
      .map((id) => productById.get(id)?.slug)
      .filter((s): s is string => Boolean(s));

    const payload = {
      slug,
      key: occasionForm.key.trim() || slug,
      name: occasionForm.name.trim(),
      tagline: occasionForm.tagline.trim(),
      description: occasionForm.description.trim() || null,
      themeBg: occasionForm.themeBg.trim() || '#FBF7EF',
      themeInk: occasionForm.themeInk.trim() || '#1C1410',
      themeAccent: occasionForm.themeAccent.trim() || '#B08A4A',
      isDark: occasionForm.isDark,
      badgeTag: occasionForm.badgeTag.trim() || null,
      coverImageUrl: occasionForm.coverImageUrl.trim() || null,
      heroCutoutUrl: occasionForm.coverImageUrl.trim() || null,
      sortOrder: Number(occasionForm.sortOrder) || 0,
      isActive: occasionForm.isActive,
      spuIds: occasionForm.spuIds,
      productIds: occasionForm.spuIds,
      productSlugs: selectedSlugs,
    };

    setOccasionSaving(true);
    const isEdit = Boolean(occasionForm.id);
    const res = await adminFetch<unknown>(
      isEdit
        ? `/api/v1/admin/occasions/${encodeURIComponent(occasionForm.id)}`
        : '/api/v1/admin/occasions',
      {
        method: isEdit ? 'PATCH' : 'POST',
        body: JSON.stringify(payload),
      },
    );
    setOccasionSaving(false);

    if (res.ok) {
      setOccasionModalOpen(false);
      notify({
        kind: 'success',
        title: isEdit ? 'CẬP NHẬT DỊP MẶC' : 'TẠO DỊP MẶC MỚI',
        message: `Đã lưu dịp mặc "${occasionForm.name}" và làm mới bộ nhớ đệm Storefront.`,
      });
      await loadOccasions();
      onRefreshOverview?.();
    } else {
      notify({
        kind: 'error',
        title: 'LƯU THẤT BẠI',
        message: res.error?.message || 'Không thể lưu thông tin dịp mặc.',
      });
    }
  };

  const handleDeleteOccasion = async (item: OccasionAdminItem) => {
    if (!canWrite) return;
    const res = await adminFetch<unknown>(
      `/api/v1/admin/occasions/${encodeURIComponent(item.id)}`,
      { method: 'DELETE' },
    );
    setConfirmDeleteOccasionId(null);
    if (res.ok) {
      notify({
        kind: 'success',
        title: 'XÓA DỊP MẶC',
        message: `Đã xóa/vô hiệu hóa dịp mặc "${item.name}".`,
      });
      await loadOccasions();
      onRefreshOverview?.();
    } else {
      notify({
        kind: 'error',
        title: 'XÓA THẤT BẠI',
        message: res.error?.message || 'Không thể xóa dịp mặc.',
      });
    }
  };

  // Season handlers
  const openCreateSeason = () => {
    setSeasonForm({
      ...EMPTY_SEASON_FORM,
      seasonOrder: seasons.length + 1,
    });
    setSeasonSpuSearch('');
    setSeasonModalOpen(true);
  };

  const openEditSeason = (item: SeasonAdminItem) => {
    setSeasonForm({
      ...item,
      swatches:
        item.swatches.length > 0
          ? item.swatches.map((s) => ({ ...s }))
          : [{ name: 'Kem Atelier', hex: '#F4EBDA', fabricNote: '' }],
      spuIds: resolveSelectedSpuIds(item.spuIds, item.productSlugs),
    });
    setSeasonSpuSearch('');
    setSeasonModalOpen(true);
  };

  const handleUpdateSwatch = (
    idx: number,
    patch: Partial<OpticalSwatchEntry>,
  ) => {
    setSeasonForm((prev) => ({
      ...prev,
      swatches: prev.swatches.map((sw, i) =>
        i === idx ? { ...sw, ...patch } : sw,
      ),
    }));
  };

  const handleSaveSeason = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canWrite) return;

    const slug = (seasonForm.slug || slugifyVi(seasonForm.name)).trim();
    if (!seasonForm.name.trim() || !slug) {
      notify({
        kind: 'error',
        title: 'THIẾU THÔNG TIN',
        message: 'Tên mùa Lookbook và mã slug không được để trống.',
      });
      return;
    }

    const cleanedSwatches = seasonForm.swatches
      .filter((sw) => sw.name.trim() && sw.hex.trim())
      .map((sw) => ({
        name: sw.name.trim(),
        hex: sw.hex.trim(),
        fabricNote: sw.fabricNote.trim(),
      }));

    const selectedSlugs = seasonForm.spuIds
      .map((id) => productById.get(id)?.slug)
      .filter((s): s is string => Boolean(s));

    const payload = {
      slug,
      code: slug,
      name: seasonForm.name.trim(),
      months: seasonForm.months.trim() || seasonForm.subtitle.trim() || 'Quanh năm',
      subtitle: seasonForm.subtitle.trim() || seasonForm.months.trim(),
      materialHeadline: seasonForm.materialHeadline.trim(),
      note: seasonForm.note.trim(),
      heroImageUrl: seasonForm.heroImageUrl.trim() || null,
      coverAssetUrl: seasonForm.heroImageUrl.trim() || null,
      seasonOrder: Number(seasonForm.seasonOrder) || 1,
      sortOrder: Number(seasonForm.seasonOrder) || 1,
      isCurrent: seasonForm.isCurrent,
      isActive: seasonForm.isActive,
      swatches: cleanedSwatches,
      paletteJsonb: cleanedSwatches,
      spuIds: seasonForm.spuIds,
      productIds: seasonForm.spuIds,
      productSlugs: selectedSlugs,
    };

    setSeasonSaving(true);
    const isEdit = Boolean(seasonForm.id);
    const res = await adminFetch<unknown>(
      isEdit
        ? `/api/v1/admin/seasons/${encodeURIComponent(seasonForm.id)}`
        : '/api/v1/admin/seasons',
      {
        method: isEdit ? 'PATCH' : 'POST',
        body: JSON.stringify(payload),
      },
    );
    setSeasonSaving(false);

    if (res.ok) {
      setSeasonModalOpen(false);
      notify({
        kind: 'success',
        title: isEdit ? 'CẬP NHẬT MÙA LOOKBOOK' : 'TẠO MÙA LOOKBOOK MỚI',
        message: `Đã lưu bộ sưu tập mùa "${seasonForm.name}" (${cleanedSwatches.length} sắc độ vải).`,
      });
      await loadSeasons();
      onRefreshOverview?.();
    } else {
      notify({
        kind: 'error',
        title: 'LƯU THẤT BẠI',
        message: res.error?.message || 'Không thể lưu mùa Lookbook.',
      });
    }
  };

  const handleDeleteSeason = async (item: SeasonAdminItem) => {
    if (!canWrite) return;
    const res = await adminFetch<unknown>(
      `/api/v1/admin/seasons/${encodeURIComponent(item.id)}`,
      { method: 'DELETE' },
    );
    setConfirmDeleteSeasonId(null);
    if (res.ok) {
      notify({
        kind: 'success',
        title: 'XÓA MÙA LOOKBOOK',
        message: `Đã xóa/lưu trữ mùa "${item.name}".`,
      });
      await loadSeasons();
      onRefreshOverview?.();
    } else {
      notify({
        kind: 'error',
        title: 'XÓA THẤT BẠI',
        message: res.error?.message || 'Không thể xóa mùa Lookbook.',
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

  const filteredOccasionSpus = useMemo(() => {
    const q = occasionSpuSearch.trim().toLowerCase();
    return products.filter((p) =>
      !q ? true : `${p.name} ${p.slug} ${p.categorySlug}`.toLowerCase().includes(q),
    );
  }, [products, occasionSpuSearch]);

  const filteredSeasonSpus = useMemo(() => {
    const q = seasonSpuSearch.trim().toLowerCase();
    return products.filter((p) =>
      !q ? true : `${p.name} ${p.slug} ${p.categorySlug}`.toLowerCase().includes(q),
    );
  }, [products, seasonSpuSearch]);

  return (
    <div data-testid="editorial-cms-tab" className="space-y-6">
      {/* Unified Editorial CMS Header & Sub-Tab Bar */}
      <section className={`rounded-3xl border p-6 ${cardCls}`}>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className={`ledger-eyebrow ${goldTextCls}`}>
              Editorial CMS Hub · Storefront Storytelling &amp; Lookbook Control
            </p>
            <h2 className="font-editorial mt-1 text-3xl font-normal tracking-tight">
              Nội dung Biên tập: Chiến dịch, Dịp mặc &amp; 6 Mùa Lookbook
            </h2>
            <p className={`mt-1 text-xs leading-relaxed ${mutedCls}`}>
              Quản trị tập trung toàn bộ lớp kể chuyện Storefront — tự động xóa
              cache Redis và kích hoạt On-Demand ISR ngay khi xuất bản.
            </p>
          </div>
        </div>

        <div className="mt-5 flex flex-wrap gap-2">
          {(
            [
              ['CAMPAIGN', '1. Chiến dịch Trang chủ'],
              ['OCCASIONS', `2. Dịp mặc · Occasions (${occasions.length})`],
              ['SEASONS', `3. 6 Mùa Lookbook · Seasons (${seasons.length})`],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              data-testid={`editorial-subtab-${key.toLowerCase()}`}
              onClick={() => setSection(key)}
              className={`rounded-full px-4 py-2 text-xs font-medium transition-colors ${
                section === key
                  ? darkMode
                    ? 'bg-[#EBCF8F] text-[#1C1410]'
                    : 'bg-[#1C1410] text-[#EBCF8F]'
                  : darkMode
                    ? 'border border-[#B08A4A]/35 bg-[#231912] text-[#DFD2C2]'
                    : 'border border-[#B08A4A]/35 bg-[#FBF7EF] text-[#5C4B41]'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="mt-4">
          <LiveStreamProgressBar
            percent={
              occasions.length + seasons.length > 0
                ? Math.round(
                    ((occasions.filter((o) => o.isActive).length +
                      seasons.filter((s) => s.isActive).length) /
                      (occasions.length + seasons.length)) *
                      100,
                  )
                : 0
            }
            tone="gold"
            height="xs"
            isDark={darkMode}
            label={
              <>
                Phủ sóng Editorial Storefront:{' '}
                <AnimatedTelemetryNumber value={occasions.length} /> dịp mặc ·{' '}
                <AnimatedTelemetryNumber value={seasons.length} /> mùa Lookbook
              </>
            }
            rightText={`${
              occasions.length + seasons.length > 0
                ? Math.round(
                    ((occasions.filter((o) => o.isActive).length +
                      seasons.filter((s) => s.isActive).length) /
                      (occasions.length + seasons.length)) *
                      100,
                  )
                : 0
            }% ACTIVE`}
          />
        </div>
      </section>

      {/* SECTION 1: Homepage Campaign */}
      {section === 'CAMPAIGN' ? (
        <HomepageCampaignTab
          roles={roles}
          session={effectiveSession}
          mfaVerified={mfaVerified}
          darkMode={darkMode}
          onNotify={notify}
          onRefreshOverview={onRefreshOverview}
        />
      ) : null}

      {/* SECTION 2: Occasions CRUD */}
      {section === 'OCCASIONS' ? (
        <section className={`rounded-3xl border p-6 ${cardCls}`}>
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#B08A4A]/20 pb-4">
            <div>
              <p className={`ledger-eyebrow ${goldTextCls}`}>
                Occasions Lookbook Manager · /api/v1/admin/occasions
              </p>
              <h3 className="font-editorial mt-0.5 text-2xl">
                Quản lý Dịp mặc ({occasions.length})
              </h3>
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => void loadOccasions()}
                className="rounded-full border border-[#B08A4A]/40 px-4 py-1.5 text-xs"
              >
                Làm mới
              </button>
              {canWrite ? (
                <button
                  type="button"
                  data-testid="occasion-create-btn"
                  onClick={openCreateOccasion}
                  className={`rounded-full px-5 py-1.5 text-xs font-medium uppercase tracking-[0.12em] ${
                    darkMode
                      ? 'bg-[#EBCF8F] text-[#1C1410]'
                      : 'bg-[#1C1410] text-[#EBCF8F]'
                  }`}
                >
                  + Thêm Dịp mặc
                </button>
              ) : null}
            </div>
          </div>

          {occasionError ? (
            <p className="mt-4 text-xs text-[#8B2E2E] dark:text-rose-300">
              {occasionError}
            </p>
          ) : occasionsLoading ? (
            <p className={`py-8 text-center text-xs ${mutedCls}`}>
              Đang tải danh sách Dịp mặc...
            </p>
          ) : occasions.length === 0 ? (
            <p className={`py-8 text-center text-xs ${mutedCls}`}>
              Chưa có dịp mặc nào trong hệ thống.
            </p>
          ) : (
            <div className="mt-5 grid gap-4 md:grid-cols-2">
              {occasions.map((occ) => {
                const linkedCount = Math.max(
                  occ.spuIds.length,
                  occ.productSlugs.length,
                );
                return (
                  <article
                    key={occ.id}
                    className={`flex flex-col justify-between gap-3 rounded-2xl border p-4 ${subCardCls}`}
                  >
                    <div>
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex items-center gap-2.5">
                          <span
                            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-[#B08A4A]/35 font-mono text-xs font-bold"
                            style={{
                              backgroundColor: occ.themeBg,
                              color: occ.themeInk,
                            }}
                          >
                            #{occ.sortOrder}
                          </span>
                          <div>
                            <h4 className="font-editorial text-2xl leading-tight">
                              {occ.name}
                            </h4>
                            <p className={`font-mono text-[10.5px] ${mutedCls}`}>
                              /{occ.slug} · {linkedCount} SPU gắn kết
                            </p>
                          </div>
                        </div>

                        <span
                          className={`rounded-full border px-2.5 py-0.5 font-mono text-[10px] font-semibold ${
                            occ.isActive
                              ? 'border-[#2E6B47]/40 bg-[#EBF9F1] text-[#1E4B32]'
                              : 'border-[#7A6A5B]/35 bg-[#F4EBDA] text-[#5C4B41]'
                          }`}
                        >
                          {occ.isActive ? 'ACTIVE' : 'HIDDEN'}
                        </span>
                      </div>

                      {occ.tagline ? (
                        <p className={`mt-2 text-xs italic ${goldTextCls}`}>
                          {occ.tagline}
                        </p>
                      ) : null}
                      {occ.description ? (
                        <p className={`mt-1 line-clamp-2 text-xs ${secondaryCls}`}>
                          {occ.description}
                        </p>
                      ) : null}

                      <div className="mt-3 flex flex-wrap items-center gap-2 text-[10.5px]">
                        <span className="inline-flex items-center gap-1 rounded-full border border-[#B08A4A]/30 px-2 py-0.5 font-mono">
                          <span
                            className="h-2.5 w-2.5 rounded-full border border-black/20"
                            style={{ backgroundColor: occ.themeBg }}
                          />
                          BG {occ.themeBg}
                        </span>
                        <span className="inline-flex items-center gap-1 rounded-full border border-[#B08A4A]/30 px-2 py-0.5 font-mono">
                          <span
                            className="h-2.5 w-2.5 rounded-full border border-black/20"
                            style={{ backgroundColor: occ.themeAccent }}
                          />
                          Accent {occ.themeAccent}
                        </span>
                      </div>
                    </div>

                    {canWrite ? (
                      <div className="flex items-center justify-end gap-2 border-t border-[#B08A4A]/20 pt-3">
                        <button
                          type="button"
                          onClick={() => openEditOccasion(occ)}
                          className="rounded-full border border-[#B08A4A]/40 px-3.5 py-1 text-[11px]"
                        >
                          Sửa &amp; Chọn SPU
                        </button>
                        {confirmDeleteOccasionId === occ.id ? (
                          <div className="flex gap-1">
                            <button
                              type="button"
                              onClick={() => void handleDeleteOccasion(occ)}
                              className="rounded-full bg-[#8B2E2E] px-3 py-1 text-[10.5px] font-semibold text-white"
                            >
                              Xác nhận xóa
                            </button>
                            <button
                              type="button"
                              onClick={() => setConfirmDeleteOccasionId(null)}
                              className="rounded-full border border-[#B08A4A]/40 px-2.5 py-1 text-[10.5px]"
                            >
                              Hủy
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setConfirmDeleteOccasionId(occ.id)}
                            className="rounded-full border border-[#8B2E2E]/45 px-3 py-1 text-[11px] text-[#8B2E2E] dark:text-rose-300"
                          >
                            Xóa
                          </button>
                        )}
                      </div>
                    ) : null}
                  </article>
                );
              })}
            </div>
          )}
      </section>
      ) : null}

      {/* SECTION 3: 6 Seasons Lookbook CRUD */}
      {section === 'SEASONS' ? (
        <section className={`rounded-3xl border p-6 ${cardCls}`}>
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#B08A4A]/20 pb-4">
            <div>
              <p className={`ledger-eyebrow ${goldTextCls}`}>
                6 Seasons Interactive Lookbook · Optical Color Swatch Map
              </p>
              <h3 className="font-editorial mt-0.5 text-2xl">
                Quản lý 6 Mùa Lookbook ({seasons.length})
              </h3>
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => void loadSeasons()}
                className="rounded-full border border-[#B08A4A]/40 px-4 py-1.5 text-xs"
              >
                Làm mới
              </button>
              {canWrite ? (
                <button
                  type="button"
                  data-testid="season-create-btn"
                  onClick={openCreateSeason}
                  className={`rounded-full px-5 py-1.5 text-xs font-medium uppercase tracking-[0.12em] ${
                    darkMode
                      ? 'bg-[#EBCF8F] text-[#1C1410]'
                      : 'bg-[#1C1410] text-[#EBCF8F]'
                  }`}
                >
                  + Thêm Mùa Lookbook
                </button>
              ) : null}
            </div>
          </div>

          {seasonError ? (
            <p className="mt-4 text-xs text-[#8B2E2E] dark:text-rose-300">
              {seasonError}
            </p>
          ) : seasonsLoading ? (
            <p className={`py-8 text-center text-xs ${mutedCls}`}>
              Đang tải dữ liệu 6 Mùa Lookbook...
            </p>
          ) : seasons.length === 0 ? (
            <p className={`py-8 text-center text-xs ${mutedCls}`}>
              Chưa có mùa Lookbook nào.
            </p>
          ) : (
            <div className="mt-5 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              {seasons.map((season) => {
                const linkedCount = Math.max(
                  season.spuIds.length,
                  season.productSlugs.length,
                );
                return (
                  <article
                    key={season.id}
                    className={`flex flex-col justify-between gap-3 rounded-2xl border p-4 ${subCardCls}`}
                  >
                    <div>
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <span className={`font-mono text-[10px] uppercase ${goldTextCls}`}>
                            Mùa #{season.seasonOrder} · {season.months || 'Quanh năm'}
                          </span>
                          <h4 className="font-editorial mt-0.5 text-2xl leading-tight">
                            {season.name}
                          </h4>
                          <p className={`font-mono text-[10.5px] ${mutedCls}`}>
                            /{season.slug} · {linkedCount} SPU
                          </p>
                        </div>
                        {season.isCurrent ? (
                          <span className="rounded-full bg-[#1C1410] px-2.5 py-0.5 font-mono text-[9.5px] font-semibold text-[#EBCF8F]">
                            MÙA HIỆN TẠI
                          </span>
                        ) : null}
                      </div>

                      {season.materialHeadline ? (
                        <p className={`mt-2 text-xs font-medium ${secondaryCls}`}>
                          {season.materialHeadline}
                        </p>
                      ) : null}
                      {season.note ? (
                        <p className={`mt-1 line-clamp-2 text-xs ${mutedCls}`}>
                          {season.note}
                        </p>
                      ) : null}

                      {/* Optical Color Swatch Strip */}
                      <div className="mt-3">
                        <p className={`font-mono text-[10px] uppercase ${mutedCls}`}>
                          Bảng sắc độ quang học ({season.swatches.length})
                        </p>
                        {season.swatches.length > 0 ? (
                          <div className="mt-1.5 flex flex-wrap gap-1.5">
                            {season.swatches.map((sw, idx) => (
                              <span
                                key={`${sw.hex}-${idx}`}
                                title={sw.fabricNote || sw.name}
                                className="inline-flex items-center gap-1.5 rounded-full border border-[#B08A4A]/30 px-2 py-0.5 text-[10.5px]"
                              >
                                <span
                                  className="h-3 w-3 rounded-full border border-black/20"
                                  style={{ backgroundColor: sw.hex }}
                                />
                                <span>{sw.name}</span>
                              </span>
                            ))}
                          </div>
                        ) : (
                          <p className={`mt-1 text-[11px] italic ${mutedCls}`}>
                            Chưa cấu hình swatch màu vải
                          </p>
                        )}
                      </div>
                    </div>

                    {canWrite ? (
                      <div className="flex items-center justify-end gap-2 border-t border-[#B08A4A]/20 pt-3">
                        <button
                          type="button"
                          onClick={() => openEditSeason(season)}
                          className="rounded-full border border-[#B08A4A]/40 px-3.5 py-1 text-[11px]"
                        >
                          Sửa &amp; Swatches
                        </button>
                        {confirmDeleteSeasonId === season.id ? (
                          <div className="flex gap-1">
                            <button
                              type="button"
                              onClick={() => void handleDeleteSeason(season)}
                              className="rounded-full bg-[#8B2E2E] px-3 py-1 text-[10.5px] font-semibold text-white"
                            >
                              Xác nhận
                            </button>
                            <button
                              type="button"
                              onClick={() => setConfirmDeleteSeasonId(null)}
                              className="rounded-full border border-[#B08A4A]/40 px-2 py-1 text-[10.5px]"
                            >
                              Hủy
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setConfirmDeleteSeasonId(season.id)}
                            className="rounded-full border border-[#8B2E2E]/45 px-3 py-1 text-[11px] text-[#8B2E2E] dark:text-rose-300"
                          >
                            Xóa
                          </button>
                        )}
                      </div>
                    ) : null}
                  </article>
                );
              })}
            </div>
          )}
      </section>
      ) : null}

      {/* Occasion Create/Edit Modal */}
      {occasionModalOpen ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Chỉnh sửa Dịp mặc"
          className="fixed inset-0 z-50 flex items-center justify-center bg-[#0D0805]/65 p-4 backdrop-blur-xs"
        >
          <form
            onSubmit={handleSaveOccasion}
            className={`max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-3xl border p-6 shadow-2xl ${cardCls}`}
          >
            <div className="flex items-start justify-between gap-3 border-b border-[#B08A4A]/20 pb-4">
              <div>
                <p className={`ledger-eyebrow ${goldTextCls}`}>
                  Occasion Editorial CRUD
                </p>
                <h3 className="font-editorial mt-0.5 text-2xl">
                  {occasionForm.id ? `Sửa Dịp mặc: ${occasionForm.name}` : 'Thêm Dịp mặc mới'}
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setOccasionModalOpen(false)}
                className="rounded-full border border-[#B08A4A]/40 px-3 py-1 text-xs"
              >
                Đóng
              </button>
            </div>

            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <label className="text-xs">
                <span className={secondaryCls}>Tên dịp mặc *</span>
                <input
                  type="text"
                  required
                  value={occasionForm.name}
                  onChange={(e) => {
                    const nextName = e.target.value;
                    setOccasionForm((prev) => ({
                      ...prev,
                      name: nextName,
                      slug: prev.id ? prev.slug : slugifyVi(nextName),
                    }));
                  }}
                  placeholder="VD: Dạ tiệc Tối"
                  className={`mt-1 w-full rounded-xl border px-3 py-2 text-xs outline-none ${inputCls}`}
                />
              </label>

              <label className="text-xs">
                <span className={secondaryCls}>Slug URL *</span>
                <input
                  type="text"
                  required
                  value={occasionForm.slug}
                  onChange={(e) =>
                    setOccasionForm({ ...occasionForm, slug: e.target.value })
                  }
                  placeholder="da-tiec-toi"
                  className={`mt-1 w-full rounded-xl border px-3 py-2 font-mono text-xs outline-none ${inputCls}`}
                />
              </label>

              <label className="text-xs sm:col-span-2">
                <span className={secondaryCls}>Tagline biên tập</span>
                <input
                  type="text"
                  value={occasionForm.tagline}
                  onChange={(e) =>
                    setOccasionForm({ ...occasionForm, tagline: e.target.value })
                  }
                  placeholder="Ánh sáng vàng nhạt trên nền lụa tơ tằm..."
                  className={`mt-1 w-full rounded-xl border px-3 py-2 text-xs outline-none ${inputCls}`}
                />
              </label>

              <label className="text-xs sm:col-span-2">
                <span className={secondaryCls}>Mô tả chi tiết</span>
                <textarea
                  rows={2}
                  value={occasionForm.description}
                  onChange={(e) =>
                    setOccasionForm({
                      ...occasionForm,
                      description: e.target.value,
                    })
                  }
                  className={`mt-1 w-full rounded-xl border px-3 py-2 text-xs outline-none ${inputCls}`}
                />
              </label>

              <label className="text-xs sm:col-span-2">
                <span className={secondaryCls}>Ảnh bìa / Hero Cutout URL</span>
                <input
                  type="text"
                  value={occasionForm.coverImageUrl}
                  onChange={(e) =>
                    setOccasionForm({
                      ...occasionForm,
                      coverImageUrl: e.target.value,
                    })
                  }
                  placeholder="https://..."
                  className={`mt-1 w-full rounded-xl border px-3 py-2 font-mono text-xs outline-none ${inputCls}`}
                />
              </label>

              <div className="grid grid-cols-3 gap-2 sm:col-span-2">
                <label className="text-xs">
                  <span className={secondaryCls}>Màu nền (themeBg)</span>
                  <div className="mt-1 flex items-center gap-1.5">
                    <input
                      type="color"
                      value={occasionForm.themeBg}
                      onChange={(e) =>
                        setOccasionForm({
                          ...occasionForm,
                          themeBg: e.target.value,
                        })
                      }
                      className="h-8 w-8 rounded border border-[#B08A4A]/40"
                    />
                    <input
                      type="text"
                      value={occasionForm.themeBg}
                      onChange={(e) =>
                        setOccasionForm({
                          ...occasionForm,
                          themeBg: e.target.value,
                        })
                      }
                      className={`min-w-0 flex-1 rounded-lg border px-2 py-1 font-mono text-[11px] ${inputCls}`}
                    />
                  </div>
                </label>

                <label className="text-xs">
                  <span className={secondaryCls}>Màu chữ (themeInk)</span>
                  <div className="mt-1 flex items-center gap-1.5">
                    <input
                      type="color"
                      value={occasionForm.themeInk}
                      onChange={(e) =>
                        setOccasionForm({
                          ...occasionForm,
                          themeInk: e.target.value,
                        })
                      }
                      className="h-8 w-8 rounded border border-[#B08A4A]/40"
                    />
                    <input
                      type="text"
                      value={occasionForm.themeInk}
                      onChange={(e) =>
                        setOccasionForm({
                          ...occasionForm,
                          themeInk: e.target.value,
                        })
                      }
                      className={`min-w-0 flex-1 rounded-lg border px-2 py-1 font-mono text-[11px] ${inputCls}`}
                    />
                  </div>
                </label>

                <label className="text-xs">
                  <span className={secondaryCls}>Màu nhấn (Accent)</span>
                  <div className="mt-1 flex items-center gap-1.5">
                    <input
                      type="color"
                      value={occasionForm.themeAccent}
                      onChange={(e) =>
                        setOccasionForm({
                          ...occasionForm,
                          themeAccent: e.target.value,
                        })
                      }
                      className="h-8 w-8 rounded border border-[#B08A4A]/40"
                    />
                    <input
                      type="text"
                      value={occasionForm.themeAccent}
                      onChange={(e) =>
                        setOccasionForm({
                          ...occasionForm,
                          themeAccent: e.target.value,
                        })
                      }
                      className={`min-w-0 flex-1 rounded-lg border px-2 py-1 font-mono text-[11px] ${inputCls}`}
                    />
                  </div>
                </label>
              </div>

              <label className="text-xs">
                <span className={secondaryCls}>Thứ tự hiển thị (sortOrder)</span>
                <input
                  type="number"
                  value={occasionForm.sortOrder}
                  onChange={(e) =>
                    setOccasionForm({
                      ...occasionForm,
                      sortOrder: Number(e.target.value) || 0,
                    })
                  }
                  className={`mt-1 w-full rounded-xl border px-3 py-2 font-mono text-xs outline-none ${inputCls}`}
                />
              </label>

              <div className="flex items-end gap-4 pb-2 text-xs">
                <label className="flex cursor-pointer items-center gap-2">
                  <input
                    type="checkbox"
                    checked={occasionForm.isActive}
                    onChange={(e) =>
                      setOccasionForm({
                        ...occasionForm,
                        isActive: e.target.checked,
                      })
                    }
                    className="accent-[#B08A4A]"
                  />
                  <span>Hiển thị công khai</span>
                </label>
                <label className="flex cursor-pointer items-center gap-2">
                  <input
                    type="checkbox"
                    checked={occasionForm.isDark}
                    onChange={(e) =>
                      setOccasionForm({
                        ...occasionForm,
                        isDark: e.target.checked,
                      })
                    }
                    className="accent-[#B08A4A]"
                  />
                  <span>Nền tối</span>
                </label>
              </div>

              {/* Multi-SPU Picker */}
              <div className="sm:col-span-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className={`text-xs font-medium ${secondaryCls}`}>
                    Chọn SPU thuộc Dịp mặc ({occasionForm.spuIds.length} đã chọn)
                  </span>
                  <input
                    type="search"
                    value={occasionSpuSearch}
                    onChange={(e) => setOccasionSpuSearch(e.target.value)}
                    placeholder="Tìm sản phẩm SPU..."
                    className={`w-52 rounded-full border px-3 py-1 text-[11px] outline-none ${inputCls}`}
                  />
                </div>
                <div
                  className={`mt-2 grid max-h-44 gap-1.5 overflow-y-auto rounded-2xl border p-2.5 sm:grid-cols-2 ${subCardCls}`}
                >
                  {filteredOccasionSpus.map((prod) => {
                    const checked = occasionForm.spuIds.includes(prod.id);
                    return (
                      <label
                        key={prod.id}
                        className={`flex cursor-pointer items-center gap-2 rounded-xl border px-2.5 py-1.5 text-[11px] ${
                          checked
                            ? darkMode
                              ? 'border-[#EBCF8F]/60 bg-[#2E2116] text-[#EBCF8F]'
                              : 'border-[#1C1410] bg-[#1C1410] text-[#EBCF8F]'
                            : 'border-transparent hover:border-[#B08A4A]/35'
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() =>
                            setOccasionForm((prev) => ({
                              ...prev,
                              spuIds: prev.spuIds.includes(prod.id)
                                ? prev.spuIds.filter((id) => id !== prod.id)
                                : [...prev.spuIds, prod.id],
                            }))
                          }
                          className="accent-[#B08A4A]"
                        />
                        <span className="truncate">{prod.name}</span>
                      </label>
                    );
                  })}
                </div>
              </div>
            </div>

            <div className="mt-6 flex justify-end gap-2.5 border-t border-[#B08A4A]/20 pt-4">
              <button
                type="button"
                onClick={() => setOccasionModalOpen(false)}
                className="rounded-full border border-[#B08A4A]/40 px-4 py-2 text-xs"
              >
                Hủy
              </button>
              <button
                type="submit"
                disabled={occasionSaving}
                className={`rounded-full px-6 py-2 text-xs font-semibold uppercase tracking-[0.14em] disabled:opacity-50 ${
                  darkMode
                    ? 'bg-[#EBCF8F] text-[#1C1410]'
                    : 'bg-[#1C1410] text-[#EBCF8F]'
                }`}
              >
                {occasionSaving ? 'Đang lưu...' : 'Lưu Dịp mặc'}
              </button>
            </div>
          </form>
        </div>
      ) : null}

      {/* Season Create/Edit Modal with Interactive Optical Color Swatch Map Editor */}
      {seasonModalOpen ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Chỉnh sửa Mùa Lookbook"
          className="fixed inset-0 z-50 flex items-center justify-center bg-[#0D0805]/65 p-4 backdrop-blur-xs"
        >
          <form
            onSubmit={handleSaveSeason}
            className={`max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-3xl border p-6 shadow-2xl ${cardCls}`}
          >
            <div className="flex items-start justify-between gap-3 border-b border-[#B08A4A]/20 pb-4">
              <div>
                <p className={`ledger-eyebrow ${goldTextCls}`}>
                  6 Seasons Lookbook CRUD · Optical Swatch Map
                </p>
                <h3 className="font-editorial mt-0.5 text-2xl">
                  {seasonForm.id
                    ? `Sửa Mùa: ${seasonForm.name}`
                    : 'Thêm Mùa Lookbook mới'}
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setSeasonModalOpen(false)}
                className="rounded-full border border-[#B08A4A]/40 px-3 py-1 text-xs"
              >
                Đóng
              </button>
            </div>

            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <label className="text-xs">
                <span className={secondaryCls}>Tên Mùa Lookbook *</span>
                <input
                  type="text"
                  required
                  value={seasonForm.name}
                  onChange={(e) => {
                    const nextName = e.target.value;
                    setSeasonForm((prev) => ({
                      ...prev,
                      name: nextName,
                      slug: prev.id ? prev.slug : slugifyVi(nextName),
                    }));
                  }}
                  placeholder="VD: Xuân Mưa Phùn"
                  className={`mt-1 w-full rounded-xl border px-3 py-2 text-xs outline-none ${inputCls}`}
                />
              </label>

              <label className="text-xs">
                <span className={secondaryCls}>Mã / Slug *</span>
                <input
                  type="text"
                  required
                  value={seasonForm.slug}
                  onChange={(e) =>
                    setSeasonForm({ ...seasonForm, slug: e.target.value })
                  }
                  placeholder="xuan-mua-phun"
                  className={`mt-1 w-full rounded-xl border px-3 py-2 font-mono text-xs outline-none ${inputCls}`}
                />
              </label>

              <label className="text-xs">
                <span className={secondaryCls}>Khung tháng / Phụ đề</span>
                <input
                  type="text"
                  value={seasonForm.months}
                  onChange={(e) =>
                    setSeasonForm({
                      ...seasonForm,
                      months: e.target.value,
                      subtitle: e.target.value,
                    })
                  }
                  placeholder="VD: Tháng 2 – Tháng 3"
                  className={`mt-1 w-full rounded-xl border px-3 py-2 text-xs outline-none ${inputCls}`}
                />
              </label>

              <label className="text-xs">
                <span className={secondaryCls}>Thứ tự mùa (1–6)</span>
                <input
                  type="number"
                  min={1}
                  max={12}
                  value={seasonForm.seasonOrder}
                  onChange={(e) =>
                    setSeasonForm({
                      ...seasonForm,
                      seasonOrder: Number(e.target.value) || 1,
                    })
                  }
                  className={`mt-1 w-full rounded-xl border px-3 py-2 font-mono text-xs outline-none ${inputCls}`}
                />
              </label>

              <label className="text-xs sm:col-span-2">
                <span className={secondaryCls}>
                  Tiêu đề chất liệu (materialHeadline)
                </span>
                <input
                  type="text"
                  value={seasonForm.materialHeadline}
                  onChange={(e) =>
                    setSeasonForm({
                      ...seasonForm,
                      materialHeadline: e.target.value,
                    })
                  }
                  placeholder="Lụa Bảo Lộc dệt chéo & Linen Nhật thoáng nhẹ"
                  className={`mt-1 w-full rounded-xl border px-3 py-2 text-xs outline-none ${inputCls}`}
                />
              </label>

              <label className="text-xs sm:col-span-2">
                <span className={secondaryCls}>Ghi chú cảm hứng mùa (note)</span>
                <textarea
                  rows={2}
                  value={seasonForm.note}
                  onChange={(e) =>
                    setSeasonForm({ ...seasonForm, note: e.target.value })
                  }
                  className={`mt-1 w-full rounded-xl border px-3 py-2 text-xs outline-none ${inputCls}`}
                />
              </label>

              <label className="text-xs sm:col-span-2">
                <span className={secondaryCls}>Ảnh Lookbook chính (heroImageUrl)</span>
                <input
                  type="text"
                  value={seasonForm.heroImageUrl}
                  onChange={(e) =>
                    setSeasonForm({
                      ...seasonForm,
                      heroImageUrl: e.target.value,
                    })
                  }
                  placeholder="https://..."
                  className={`mt-1 w-full rounded-xl border px-3 py-2 font-mono text-xs outline-none ${inputCls}`}
                />
              </label>

              <div className="flex items-center gap-5 text-xs sm:col-span-2">
                <label className="flex cursor-pointer items-center gap-2">
                  <input
                    type="checkbox"
                    checked={seasonForm.isCurrent}
                    onChange={(e) =>
                      setSeasonForm({
                        ...seasonForm,
                        isCurrent: e.target.checked,
                      })
                    }
                    className="accent-[#B08A4A]"
                  />
                  <span>Đánh dấu là Mùa hiện tại (Highlight trên Storefront)</span>
                </label>
              </div>

              {/* Interactive Optical Color Swatch Map Editor */}
              <div className={`rounded-2xl border p-4 sm:col-span-2 ${subCardCls}`}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className={`text-xs font-semibold uppercase tracking-[0.14em] ${goldTextCls}`}>
                      Optical Color Swatch Map ({seasonForm.swatches.length} màu)
                    </p>
                    <p className={`text-[11px] ${mutedCls}`}>
                      Thiết lập tên sắc độ, mã màu Hex quang học và ghi chú bề mặt chất liệu.
                    </p>
                  </div>
                  <button
                    type="button"
                    data-testid="season-add-swatch-btn"
                    onClick={() =>
                      setSeasonForm((prev) => ({
                        ...prev,
                        swatches: [
                          ...prev.swatches,
                          { name: '', hex: '#C8A97E', fabricNote: '' },
                        ],
                      }))
                    }
                    className="rounded-full border border-[#B08A4A]/45 px-3 py-1 text-[11px] font-medium"
                  >
                    + Thêm Swatch
                  </button>
                </div>

                <div className="mt-3 space-y-2.5">
                  {seasonForm.swatches.map((sw, idx) => (
                    <div
                      key={`swatch-row-${idx}`}
                      className="grid grid-cols-1 items-center gap-2 sm:grid-cols-[42px_110px_1fr_1.4fr_auto]"
                    >
                      <input
                        type="color"
                        value={/^#[0-9a-fA-F]{6}$/.test(sw.hex) ? sw.hex : '#B08A4A'}
                        onChange={(e) =>
                          handleUpdateSwatch(idx, { hex: e.target.value })
                        }
                        aria-label={`Chọn màu swatch ${idx + 1}`}
                        className="h-9 w-10 cursor-pointer rounded-lg border border-[#B08A4A]/40"
                      />
                      <input
                        type="text"
                        value={sw.hex}
                        onChange={(e) =>
                          handleUpdateSwatch(idx, { hex: e.target.value })
                        }
                        placeholder="#F4EBDA"
                        className={`rounded-lg border px-2.5 py-1.5 font-mono text-xs outline-none ${inputCls}`}
                      />
                      <input
                        type="text"
                        value={sw.name}
                        onChange={(e) =>
                          handleUpdateSwatch(idx, { name: e.target.value })
                        }
                        placeholder="Tên màu (vd: Trắng Ngà)"
                        className={`rounded-lg border px-2.5 py-1.5 text-xs outline-none ${inputCls}`}
                      />
                      <input
                        type="text"
                        value={sw.fabricNote}
                        onChange={(e) =>
                          handleUpdateSwatch(idx, {
                            fabricNote: e.target.value,
                          })
                        }
                        placeholder="Ghi chú vải (vd: Lụa mờ ánh xà cừ)"
                        className={`rounded-lg border px-2.5 py-1.5 text-xs outline-none ${inputCls}`}
                      />
                      <button
                        type="button"
                        onClick={() =>
                          setSeasonForm((prev) => ({
                            ...prev,
                            swatches: prev.swatches.filter((_, i) => i !== idx),
                          }))
                        }
                        className="rounded-full border border-[#8B2E2E]/40 px-2.5 py-1 text-[10.5px] text-[#8B2E2E] dark:text-rose-300"
                      >
                        Xóa
                      </button>
                    </div>
                  ))}
                </div>
              </div>

              {/* Linked SPUs Selector */}
              <div className="sm:col-span-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className={`text-xs font-medium ${secondaryCls}`}>
                    Sản phẩm SPU gắn kết với Mùa ({seasonForm.spuIds.length} đã chọn)
                  </span>
                  <input
                    type="search"
                    value={seasonSpuSearch}
                    onChange={(e) => setSeasonSpuSearch(e.target.value)}
                    placeholder="Tìm sản phẩm SPU..."
                    className={`w-52 rounded-full border px-3 py-1 text-[11px] outline-none ${inputCls}`}
                  />
                </div>
                <div
                  className={`mt-2 grid max-h-44 gap-1.5 overflow-y-auto rounded-2xl border p-2.5 sm:grid-cols-2 ${subCardCls}`}
                >
                  {filteredSeasonSpus.map((prod) => {
                    const checked = seasonForm.spuIds.includes(prod.id);
                    return (
                      <label
                        key={prod.id}
                        className={`flex cursor-pointer items-center gap-2 rounded-xl border px-2.5 py-1.5 text-[11px] ${
                          checked
                            ? darkMode
                              ? 'border-[#EBCF8F]/60 bg-[#2E2116] text-[#EBCF8F]'
                              : 'border-[#1C1410] bg-[#1C1410] text-[#EBCF8F]'
                            : 'border-transparent hover:border-[#B08A4A]/35'
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() =>
                            setSeasonForm((prev) => ({
                              ...prev,
                              spuIds: prev.spuIds.includes(prod.id)
                                ? prev.spuIds.filter((id) => id !== prod.id)
                                : [...prev.spuIds, prod.id],
                            }))
                          }
                          className="accent-[#B08A4A]"
                        />
                        <span className="truncate">{prod.name}</span>
                      </label>
                    );
                  })}
                </div>
              </div>
            </div>

            <div className="mt-6 flex justify-end gap-2.5 border-t border-[#B08A4A]/20 pt-4">
              <button
                type="button"
                onClick={() => setSeasonModalOpen(false)}
                className="rounded-full border border-[#B08A4A]/40 px-4 py-2 text-xs"
              >
                Hủy
              </button>
              <button
                type="submit"
                disabled={seasonSaving}
                className={`rounded-full px-6 py-2 text-xs font-semibold uppercase tracking-[0.14em] disabled:opacity-50 ${
                  darkMode
                    ? 'bg-[#EBCF8F] text-[#1C1410]'
                    : 'bg-[#1C1410] text-[#EBCF8F]'
                }`}
              >
                {seasonSaving ? 'Đang lưu...' : 'Lưu Mùa Lookbook'}
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </div>
  );
}
