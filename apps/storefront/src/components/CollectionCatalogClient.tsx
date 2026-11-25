'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  SizeCode,
  type CustomerBodyProfileDto,
  type ProductSpuDto,
  type SizeRecommendResponse,
} from '@atelier/contracts';
import { apiFetch, getStoredSession } from '@/lib/api-client';
import {
  CATEGORY_TABS,
  FORMAT_VND,
  OCCASION_CATALOG,
  SEASON_DROPS,
  extractProductArray,
  getPrimaryVariantImage,
} from '@/lib/catalog-data';

const BODY_PROFILE_STORAGE_KEY = 'atelier_body_profile_v1';

const SIZE_FILTER_OPTIONS = [
  SizeCode.XS,
  SizeCode.S,
  SizeCode.M,
  SizeCode.L,
  SizeCode.XL,
  SizeCode.XXL,
] as const;

const QUICK_MY_SIZES = ['XS', 'S', 'M', 'L', 'XL'] as const;

interface StoredBodyProfile {
  heightCm?: number;
  weightKg?: number;
  bustCm?: number;
  waistCm?: number;
  hipCm?: number;
  fitPreference?: string;
  recommendedSize?: string;
  updatedAt?: number;
}

function readStoredBodyProfile(): StoredBodyProfile | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(BODY_PROFILE_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as StoredBodyProfile | null;
      if (parsed && typeof parsed === 'object') {
        return {
          ...parsed,
          recommendedSize:
            typeof parsed.recommendedSize === 'string' &&
            parsed.recommendedSize.trim()
              ? parsed.recommendedSize.trim().toUpperCase()
              : undefined,
        };
      }
    }
    const sessionSize = window.sessionStorage.getItem(
      'atelier_last_recommended_size',
    );
    if (sessionSize && sessionSize.trim()) {
      return { recommendedSize: sessionSize.trim().toUpperCase() };
    }
    return null;
  } catch {
    return null;
  }
}

function saveBodyProfileSize(
  recommendedSize: string,
  base?: StoredBodyProfile | null,
): StoredBodyProfile {
  const normalized = recommendedSize.trim().toUpperCase();
  const nextProfile: StoredBodyProfile = {
    ...(base ?? {}),
    fitPreference: base?.fitPreference || 'TRUE_TO_SIZE',
    recommendedSize: normalized,
    updatedAt: Date.now(),
  };
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(
        BODY_PROFILE_STORAGE_KEY,
        JSON.stringify(nextProfile),
      );
      window.sessionStorage.setItem('atelier_last_recommended_size', normalized);
      window.dispatchEvent(
        new CustomEvent('atelier:body-profile-updated', { detail: nextProfile }),
      );
    } catch {
      // Ignore private browsing storage errors
    }
  }
  return nextProfile;
}

function hasInStockSize(product: ProductSpuDto, targetSize: string): boolean {
  const want = targetSize.trim().toUpperCase();
  return product.variants.some((variant) =>
    variant.skus.some((sku) => sku.sizeCode.toUpperCase() === want && sku.inStock),
  );
}

export interface CollectionCatalogClientProps {
  initialCategorySlug?: string;
  initialOccasionSlug?: string;
  initialSeasonSlug?: string;
  headingTitle?: string;
  initialProducts: ProductSpuDto[];
  initialSource: 'live-bff' | 'editorial-fallback';
}

export function CollectionCatalogClient({
  initialCategorySlug,
  initialOccasionSlug,
  initialSeasonSlug,
  headingTitle,
  initialProducts,
  initialSource,
}: CollectionCatalogClientProps) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const q = searchParams.get('q') ?? '';
  const categoryQuery =
    searchParams.get('category') ?? searchParams.get('categorySlug') ?? '';
  const activeCategorySlug = categoryQuery || initialCategorySlug || '';
  const mySize = (searchParams.get('mySize') ?? '').trim().toUpperCase();
  const size = (searchParams.get('size') ?? '').trim().toUpperCase();
  const effectiveSize = mySize || size;
  const color = searchParams.get('color') ?? '';
  const occasion = searchParams.get('occasion') ?? initialOccasionSlug ?? '';
  const season = searchParams.get('season') ?? initialSeasonSlug ?? '';
  const minPrice = searchParams.get('minPrice') ?? '';
  const maxPrice = searchParams.get('maxPrice') ?? '';
  const isTryonEnabled = searchParams.get('isTryonEnabled') ?? '';
  const sort = searchParams.get('sort') ?? '';

  const [searchInput, setSearchInput] = useState(q);
  const [products, setProducts] = useState<ProductSpuDto[]>(initialProducts);
  const [loading, setLoading] = useState(false);
  const [lastQueryMs, setLastQueryMs] = useState<number | null>(null);
  const [savedProfile, setSavedProfile] = useState<StoredBodyProfile | null>(null);
  const [mySizeStatus, setMySizeStatus] = useState<string | null>(null);
  const [showQuickSizePicker, setShowQuickSizePicker] = useState(false);

  const initialQuerySignature = useMemo(
    () =>
      JSON.stringify({
        activeCategorySlug,
        q,
        mySize,
        size,
        color,
        occasion,
        season,
        minPrice,
        maxPrice,
        isTryonEnabled,
        sort,
      }),
    [
      activeCategorySlug,
      q,
      mySize,
      size,
      color,
      occasion,
      season,
      minPrice,
      maxPrice,
      isTryonEnabled,
      sort,
    ],
  );
  const ssrSignatureRef = useRef<string>(initialQuerySignature);

  useEffect(() => {
    setSearchInput(q);
  }, [q]);

  // Read shared body profile from localStorage (`atelier_body_profile_v1`) & listen for updates
  useEffect(() => {
    setSavedProfile(readStoredBodyProfile());

    const onProfileUpdated = (event: Event) => {
      const custom = event as CustomEvent<StoredBodyProfile | undefined>;
      if (custom.detail && typeof custom.detail === 'object') {
        setSavedProfile(custom.detail);
      } else {
        setSavedProfile(readStoredBodyProfile());
      }
    };

    const onStorage = (event: StorageEvent) => {
      if (event.key === BODY_PROFILE_STORAGE_KEY) {
        setSavedProfile(readStoredBodyProfile());
      }
    };

    window.addEventListener('atelier:body-profile-updated', onProfileUpdated);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener('atelier:body-profile-updated', onProfileUpdated);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  useEffect(() => {
    // Skip redundant fetch on initial SSR hydration when URL params match SSR props
    if (ssrSignatureRef.current === initialQuerySignature) {
      ssrSignatureRef.current = '__hydrated__';
      setProducts(initialProducts);
      return;
    }

    let cancelled = false;
    const loadFiltered = async () => {
      setLoading(true);
      const startedAt = performance.now();
      const params = new URLSearchParams();
      if (activeCategorySlug) params.set('categorySlug', activeCategorySlug);
      if (q) params.set('q', q);
      if (mySize) {
        params.set('size', mySize);
        params.set('inStockSize', mySize);
        params.set('inStockOnly', 'true');
      } else if (size) {
        params.set('size', size);
      }
      if (color) params.set('color', color);
      if (occasion) params.set('occasion', occasion);
      if (season) params.set('season', season);
      if (minPrice) params.set('minPrice', minPrice);
      if (maxPrice) params.set('maxPrice', maxPrice);
      if (isTryonEnabled === 'true') params.set('isTryonEnabled', 'true');
      if (sort) params.set('sort', sort);

      const qs = params.toString();
      const res = await apiFetch<unknown>(
        `/bff/v1/storefront/products${qs ? `?${qs}` : ''}`,
        { skipAuthRefresh: true },
      );

      if (!cancelled) {
        const elapsed = Math.max(1, Math.round(performance.now() - startedAt));
        setLastQueryMs(elapsed);
        if (res.ok && res.data) {
          let list = extractProductArray(res.data);
          if (mySize) {
            list = list.filter((p) => hasInStockSize(p, mySize));
          }
          if (isTryonEnabled === 'true') {
            list = list.filter((p) => p.isTryonEnabled);
          }
          setProducts(list);
        }
        setLoading(false);
      }
    };

    void loadFiltered();
    return () => {
      cancelled = true;
    };
  }, [
    initialQuerySignature,
    initialProducts,
    activeCategorySlug,
    q,
    mySize,
    size,
    color,
    occasion,
    season,
    minPrice,
    maxPrice,
    isTryonEnabled,
    sort,
  ]);

  const updateFilters = useCallback(
    (patch: Record<string, string>) => {
      const next = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(patch)) {
        const trimmed = value.trim();
        if (trimmed) {
          next.set(key, trimmed);
        } else {
          next.delete(key);
        }
      }
      const routeSlug =
        initialCategorySlug || initialOccasionSlug || initialSeasonSlug;
      const base = routeSlug ? `/bo-suu-tap/${routeSlug}` : '/bo-suu-tap';
      const qs = next.toString();
      router.replace(qs ? `${base}?${qs}` : base, { scroll: false });
    },
    [initialCategorySlug, initialOccasionSlug, initialSeasonSlug, router, searchParams],
  );

  const updateFilter = useCallback(
    (key: string, value: string) => {
      updateFilters({ [key]: value });
    },
    [updateFilters],
  );

  const buildCategoryHref = (slug?: string) => {
    const next = new URLSearchParams(searchParams.toString());
    next.delete('category');
    next.delete('categorySlug');
    const qs = next.toString();
    const base = slug ? `/bo-suu-tap/${slug}` : '/bo-suu-tap';
    return qs ? `${base}?${qs}` : base;
  };

  const handleApplyQuickMySize = (chosenSize: string) => {
    const normalized = chosenSize.trim().toUpperCase();
    const updated = saveBodyProfileSize(normalized, savedProfile);
    setSavedProfile(updated);
    setShowQuickSizePicker(false);
    setMySizeStatus(
      `Đã lưu Size ${normalized} vào hồ sơ vóc dáng và đang lọc các thiết kế còn hàng cỡ ${normalized}.`,
    );
    updateFilters({ mySize: normalized, size: '' });
  };

  const handleToggleMySize = async () => {
    if (mySize) {
      setMySizeStatus(null);
      setShowQuickSizePicker(false);
      updateFilters({ mySize: '', size: '' });
      return;
    }

    // 1. Check shared localStorage `atelier_body_profile_v1` first
    const profile = readStoredBodyProfile();
    if (profile?.recommendedSize) {
      setSavedProfile(profile);
      setShowQuickSizePicker(false);
      const bodyMeta =
        profile.heightCm && profile.weightKg
          ? ` (từ hồ sơ ${Math.round(profile.heightCm)}cm · ${Math.round(profile.weightKg)}kg)`
          : '';
      setMySizeStatus(
        `Đang lọc sản phẩm còn hàng theo Size ${profile.recommendedSize}${bodyMeta}.`,
      );
      updateFilters({ mySize: profile.recommendedSize, size: '' });
      return;
    }

    // 2. If profile has height & weight without recommendedSize yet, calculate live
    const referenceProduct = products[0] ?? initialProducts[0];
    if (profile?.heightCm && profile?.weightKg && referenceProduct) {
      setMySizeStatus('Đang tính kích cỡ phù hợp từ hồ sơ số đo của bạn...');
      const recRes = await apiFetch<SizeRecommendResponse>(
        '/bff/v1/storefront/size-recommend',
        {
          method: 'POST',
          skipAuthRefresh: true,
          body: JSON.stringify({
            productSlug: referenceProduct.slug,
            heightCm: profile.heightCm,
            weightKg: profile.weightKg,
            bustCm: profile.bustCm ?? undefined,
            waistCm: profile.waistCm ?? undefined,
            hipCm: profile.hipCm ?? undefined,
          }),
        },
      );
      if (recRes.ok && recRes.data?.recommendedSize) {
        const updated = saveBodyProfileSize(recRes.data.recommendedSize, profile);
        setSavedProfile(updated);
        setShowQuickSizePicker(false);
        setMySizeStatus(
          `Đang lọc sản phẩm còn hàng theo Size ${recRes.data.recommendedSize} (${profile.heightCm}cm / ${profile.weightKg}kg).`,
        );
        updateFilters({ mySize: recRes.data.recommendedSize, size: '' });
        return;
      }
    }

    // 3. Check logged-in customer body profile from BFF
    const session = getStoredSession();
    if (session?.accessToken) {
      setMySizeStatus('Đang đồng bộ hồ sơ số đo cá nhân...');
      const profileRes = await apiFetch<CustomerBodyProfileDto>(
        '/bff/v1/customers/me/body-profile',
      );
      if (profileRes.ok && profileRes.data && referenceProduct) {
        const recRes = await apiFetch<SizeRecommendResponse>(
          '/bff/v1/storefront/size-recommend',
          {
            method: 'POST',
            body: JSON.stringify({
              productSlug: referenceProduct.slug,
              heightCm: profileRes.data.heightCm,
              weightKg: profileRes.data.weightKg,
              bustCm: profileRes.data.bustCm ?? undefined,
              waistCm: profileRes.data.waistCm ?? undefined,
              hipCm: profileRes.data.hipCm ?? undefined,
              shoulderCm: profileRes.data.shoulderCm ?? undefined,
              fitPreference: profileRes.data.fitPreference,
            }),
          },
        );

        if (recRes.ok && recRes.data?.recommendedSize) {
          const updated = saveBodyProfileSize(recRes.data.recommendedSize, {
            heightCm: profileRes.data.heightCm,
            weightKg: profileRes.data.weightKg,
            bustCm: profileRes.data.bustCm ?? undefined,
            waistCm: profileRes.data.waistCm ?? undefined,
            hipCm: profileRes.data.hipCm ?? undefined,
          });
          setSavedProfile(updated);
          setShowQuickSizePicker(false);
          setMySizeStatus(
            `Đang lọc sản phẩm còn hàng theo Size ${recRes.data.recommendedSize} (từ hồ sơ ${profileRes.data.heightCm}cm / ${profileRes.data.weightKg}kg).`,
          );
          updateFilters({ mySize: recRes.data.recommendedSize, size: '' });
          return;
        }
      }
    }

    // 4. No saved profile yet: show inline instant quick-size picker + advisor link
    setShowQuickSizePicker((prev) => !prev);
    setMySizeStatus(
      'Chưa có hồ sơ size đã lưu. Chọn nhanh cỡ của bạn bên dưới hoặc tính chi tiết bằng Cố vấn Size AI:',
    );
  };

  const activeHeading =
    CATEGORY_TABS.find((c) => c.slug === activeCategorySlug)?.name ||
    headingTitle ||
    'Tất cả bộ sưu tập';

  const firstProductSlug =
    products[0]?.slug ?? initialProducts[0]?.slug ?? 'ao-so-mi-lua-to-tam-tam-xuan';
  const isTryOnFilterActive = isTryonEnabled === 'true';
  const isMySizeFilterActive = Boolean(mySize);
  const savedSizeHint = savedProfile?.recommendedSize;

  return (
    <div className="mx-auto max-w-7xl px-6 py-10 lg:px-10">
      <div className="border-b border-[#B08A4A]/25 pb-7">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="atelier-eyebrow text-[#8A672C]">
            Danh mục sản phẩm · Meilisearch Tiếng Việt
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {lastQueryMs !== null ? (
              <span className="rounded-full border border-[#B08A4A]/30 bg-white px-3 py-1 font-mono text-[11px] text-[#5C4B41]">
                Truy vấn {lastQueryMs}ms
              </span>
            ) : null}
            <span className="rounded-full border border-[#B08A4A]/35 bg-[#F4EBDA] px-3 py-1 text-[11px] text-[#8A672C]">
              {initialSource === 'live-bff' ? 'Live Catalog' : 'Fallback Mode'} ·{' '}
              {products.length} thiết kế
            </span>
          </div>
        </div>
        <h1 className="font-editorial mt-2 text-5xl font-light text-[#1C1410]">
          {activeHeading}
        </h1>

        <div className="mt-5 flex flex-wrap gap-2">
          <Link
            href={buildCategoryHref()}
            className={`rounded-full px-4 py-1.5 text-xs transition-colors ${
              !activeCategorySlug && !initialOccasionSlug && !initialSeasonSlug
                ? 'bg-[#1C1410] text-[#EBCF8F]'
                : 'border border-[#B08A4A]/35 bg-[#FBF7EF] text-[#2B2019] hover:border-[#8A672C]'
            }`}
          >
            Tất cả
          </Link>
          {CATEGORY_TABS.map((cat) => (
            <Link
              key={cat.slug}
              href={buildCategoryHref(cat.slug)}
              className={`rounded-full px-4 py-1.5 text-xs transition-colors ${
                activeCategorySlug === cat.slug
                  ? 'bg-[#1C1410] text-[#EBCF8F]'
                  : 'border border-[#B08A4A]/35 bg-[#FBF7EF] text-[#2B2019] hover:border-[#8A672C]'
              }`}
            >
              {cat.name}
            </Link>
          ))}
        </div>
      </div>

      {/* Multi-Facet Filter Bar synced with URL Search Params */}
      <section className="mt-6 rounded-3xl border border-[#B08A4A]/25 bg-[#F4EBDA]/55 p-5">
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-6">
          <form
            onSubmit={(event) => {
              event.preventDefault();
              updateFilter('q', searchInput.trim());
            }}
            className="flex gap-2 lg:col-span-2"
          >
            <input
              type="search"
              data-testid="plp-search-input"
              value={searchInput}
              onChange={(event) => {
                const nextVal = event.target.value;
                setSearchInput(nextVal);
                if (nextVal === '' && q !== '') {
                  updateFilter('q', '');
                }
              }}
              placeholder="Tìm không dấu: ao so mi lua, ao len cashmere..."
              className="flex-1 rounded-full border border-[#B08A4A]/35 bg-white px-4 py-2 text-xs text-[#1C1410] outline-none focus:border-[#8A672C]"
            />
            <button
              type="submit"
              data-testid="plp-search-submit"
              className="rounded-full bg-[#1C1410] px-4 py-2 text-[11px] uppercase tracking-[0.14em] text-[#EBCF8F]"
            >
              Tìm
            </button>
          </form>

          <select
            aria-label="Lọc theo dịp mặc"
            value={occasion}
            onChange={(event) => updateFilter('occasion', event.target.value)}
            className="rounded-full border border-[#B08A4A]/35 bg-white px-3.5 py-2 text-xs text-[#1C1410]"
          >
            <option value="">Tất cả dịp mặc</option>
            {OCCASION_CATALOG.map((occ) => (
              <option key={occ.slug} value={occ.slug}>
                {occ.title}
              </option>
            ))}
          </select>

          <select
            aria-label="Lọc theo mùa"
            value={season}
            onChange={(event) => updateFilter('season', event.target.value)}
            className="rounded-full border border-[#B08A4A]/35 bg-white px-3.5 py-2 text-xs text-[#1C1410]"
          >
            <option value="">Tất cả mùa BST</option>
            {SEASON_DROPS.map((drop) => (
              <option key={drop.slug} value={drop.slug}>
                {drop.title}
              </option>
            ))}
          </select>

          <input
            type="text"
            value={color}
            onChange={(event) => updateFilter('color', event.target.value)}
            placeholder="Màu (Kem, Cacao)"
            aria-label="Lọc theo màu sắc"
            className="rounded-full border border-[#B08A4A]/35 bg-white px-3.5 py-2 text-xs text-[#1C1410]"
          />

          <select
            aria-label="Sắp xếp theo"
            data-testid="plp-sort-select"
            value={sort}
            onChange={(event) => updateFilter('sort', event.target.value)}
            className="rounded-full border border-[#B08A4A]/35 bg-white px-3.5 py-2 text-xs text-[#1C1410]"
          >
            <option value="">Mặc định Atelier</option>
            <option value="price_asc">Giá: Thấp → Cao</option>
            <option value="price_desc">Giá: Cao → Thấp</option>
          </select>
        </div>

        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <input
            type="number"
            min={0}
            step={100000}
            value={minPrice}
            onChange={(e) => updateFilter('minPrice', e.target.value)}
            placeholder="Giá tối thiểu (VND)"
            aria-label="Giá tối thiểu"
            className="rounded-full border border-[#B08A4A]/35 bg-white px-3.5 py-1.5 font-mono text-xs"
          />
          <input
            type="number"
            min={0}
            step={100000}
            value={maxPrice}
            onChange={(e) => updateFilter('maxPrice', e.target.value)}
            placeholder="Giá tối đa (VND)"
            aria-label="Giá tối đa"
            className="rounded-full border border-[#B08A4A]/35 bg-white px-3.5 py-1.5 font-mono text-xs"
          />
        </div>

        {/* Size pills + 2 Strategic Quick Toggle Chips */}
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-[#B08A4A]/20 pt-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] uppercase tracking-[0.16em] text-[#8A672C]">
              Kích cỡ:
            </span>
            {SIZE_FILTER_OPTIONS.map((code) => {
              const selected = effectiveSize === code;
              return (
                <button
                  key={code}
                  type="button"
                  aria-pressed={selected}
                  onClick={() =>
                    updateFilters({
                      size: selected ? '' : code,
                      mySize: '',
                    })
                  }
                  className={`rounded-full px-3 py-1 text-xs transition-colors ${
                    selected
                      ? 'bg-[#1C1410] text-[#EBCF8F]'
                      : 'border border-[#B08A4A]/35 bg-white text-[#2B2019] hover:border-[#8A672C]'
                  }`}
                >
                  {code}
                </button>
              );
            })}
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            <button
              type="button"
              data-testid="plp-filter-tryon"
              aria-pressed={isTryOnFilterActive}
              onClick={() =>
                updateFilter(
                  'isTryonEnabled',
                  isTryOnFilterActive ? '' : 'true',
                )
              }
              className={`rounded-full px-4 py-1.5 text-xs font-medium transition-colors ${
                isTryOnFilterActive
                  ? 'bg-[#1C1410] text-[#EBCF8F] shadow-sm'
                  : 'border border-[#B08A4A]/45 bg-white text-[#1C1410] hover:border-[#8A672C]'
              }`}
            >
              ✦ Hỗ trợ Thử đồ AI
            </button>

            <button
              type="button"
              data-testid="plp-filter-mysize"
              aria-pressed={isMySizeFilterActive}
              onClick={() => void handleToggleMySize()}
              className={`rounded-full px-4 py-1.5 text-xs font-medium transition-colors ${
                isMySizeFilterActive
                  ? 'bg-[#8A672C] text-[#FBF7EF] shadow-sm'
                  : 'border border-[#8A672C] bg-[#FBF7EF] text-[#8A672C] hover:bg-[#1C1410] hover:text-[#EBCF8F]'
              }`}
            >
              ✓ Còn hàng theo Size của tôi
              {isMySizeFilterActive
                ? ` (${mySize})`
                : savedSizeHint
                  ? ` (${savedSizeHint})`
                  : ''}
            </button>
          </div>
        </div>

        {mySizeStatus ? (
          <p className="mt-3 text-xs text-[#5C4B41]">{mySizeStatus}</p>
        ) : null}

        {showQuickSizePicker ? (
          <div
            data-testid="plp-mysize-quick-picker"
            className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[#B08A4A]/35 bg-[#FBF7EF] px-4 py-3"
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[11px] font-medium uppercase tracking-[0.14em] text-[#8A672C]">
                Chọn nhanh Size của bạn:
              </span>
              {QUICK_MY_SIZES.map((sz) => (
                <button
                  key={sz}
                  type="button"
                  data-testid={`plp-quick-size-${sz}`}
                  onClick={() => handleApplyQuickMySize(sz)}
                  className="rounded-full border border-[#8A672C]/50 bg-white px-3.5 py-1 text-xs font-medium text-[#1C1410] transition-colors hover:bg-[#1C1410] hover:text-[#EBCF8F]"
                >
                  Size {sz}
                </button>
              ))}
            </div>
            <Link
              href={`/san-pham/${firstProductSlug}#pdp-size-advisor`}
              className="text-xs font-medium text-[#8A672C] underline underline-offset-4 hover:text-[#1C1410]"
            >
              Hoặc tính chuẩn theo số đo tại Cố vấn Size AI →
            </Link>
          </div>
        ) : null}
      </section>

      {loading ? (
        <div
          className="mt-8 grid gap-6 sm:grid-cols-2 lg:grid-cols-4"
          aria-busy="true"
          aria-label="Đang lọc danh mục sản phẩm"
        >
          {Array.from({ length: 8 }).map((_, idx) => (
            <div
              key={`catalog-skeleton-${idx}`}
              className="flex flex-col rounded-3xl border border-[#B08A4A]/20 bg-[#FBF7EF] p-3.5"
            >
              <div className="atelier-skeleton aspect-[3/4] w-full rounded-2xl" />
              <div className="mt-3.5 space-y-2 px-1">
                <div className="atelier-skeleton h-2.5 w-20 rounded-full" />
                <div className="atelier-skeleton h-6 w-4/5 rounded-lg" />
                <div className="atelier-skeleton h-3 w-3/5 rounded-full" />
                <div className="mt-3 flex items-center justify-between border-t border-[#B08A4A]/15 pt-2.5">
                  <div className="flex gap-1">
                    <span className="atelier-skeleton h-3.5 w-3.5 rounded-full" />
                    <span className="atelier-skeleton h-3.5 w-3.5 rounded-full" />
                  </div>
                  <div className="atelier-skeleton h-5 w-24 rounded-md" />
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="mt-8 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {products.map((product) => {
            const { lookbookUrl, flatUrl } = getPrimaryVariantImage(product, 0);
            return (
              <article
                key={product.id}
                className="group flex flex-col rounded-3xl border border-[#B08A4A]/25 bg-[#FBF7EF] p-3.5 transition-all hover:border-[#8A672C] hover:shadow-lg"
              >
                <div className="relative aspect-[3/4] overflow-hidden rounded-2xl bg-[#F4EBDA]">
                  <Link
                    href={`/san-pham/${product.slug}`}
                    data-cursor="view"
                    data-cursor-label="XEM"
                    className="block h-full w-full"
                  >
                    <img
                      src={lookbookUrl}
                      alt={product.name}
                      width={600}
                      height={800}
                      loading="lazy"
                      decoding="async"
                      className="h-full w-full object-cover transition-opacity duration-500 group-hover:opacity-0"
                    />
                    <img
                      src={flatUrl}
                      alt={`${product.name} Flat-Lay 3:4`}
                      width={600}
                      height={800}
                      loading="lazy"
                      decoding="async"
                      className="absolute inset-0 h-full w-full bg-[#F8F4EC] object-contain opacity-0 transition-opacity duration-500 group-hover:opacity-100"
                    />
                  </Link>
                  {product.isTryonEnabled ? (
                    <Link
                      href={`/san-pham/${product.slug}?tryon=1`}
                      className="absolute right-3 bottom-3 rounded-full bg-[#1C1410]/90 px-3 py-1 text-[10px] uppercase tracking-[0.16em] text-[#EBCF8F]"
                    >
                      ✦ Ướm thử AI
                    </Link>
                  ) : null}
                </div>

                <div className="mt-3.5 flex flex-1 flex-col justify-between px-1">
                  <div>
                    <p className="text-[10px] uppercase tracking-[0.18em] text-[#8A672C]">
                      {product.categoryName}
                    </p>
                    <Link
                      href={`/san-pham/${product.slug}`}
                      className="font-editorial mt-1 block text-2xl leading-tight text-[#1C1410] hover:text-[#8A672C]"
                    >
                      {product.name}
                    </Link>
                    <p className="mt-1 line-clamp-1 text-xs text-[#7A6A5B]">
                      {product.fabricComposition}
                    </p>
                  </div>

                  <div className="mt-3 flex items-center justify-between border-t border-[#B08A4A]/15 pt-2.5">
                    <div className="flex gap-1">
                      {product.variants.map((v) => (
                        <span
                          key={v.id}
                          title={v.colorName}
                          className="h-3.5 w-3.5 rounded-full border border-[#2B2019]/25"
                          style={{ backgroundColor: v.colorHex }}
                        />
                      ))}
                    </div>
                    <span className="font-editorial text-xl text-[#8A672C]">
                      {FORMAT_VND(product.minPriceVnd)}
                    </span>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}

      {!loading && products.length === 0 ? (
        <div className="mt-10 rounded-3xl border border-[#B08A4A]/25 bg-[#F4EBDA]/50 p-10 text-center">
          <p className="font-editorial text-3xl text-[#1C1410]">
            Không tìm thấy thiết kế phù hợp
          </p>
          <p className="mt-2 text-xs text-[#7A6A5B]">
            Thử bỏ bớt bộ lọc kích cỡ hoặc tìm kiếm từ khóa khác.
          </p>
          <Link
            href="/bo-suu-tap"
            className="mt-5 inline-block rounded-full bg-[#1C1410] px-6 py-2.5 text-xs uppercase tracking-[0.18em] text-[#EBCF8F]"
          >
            Đặt lại bộ lọc
          </Link>
        </div>
      ) : null}
    </div>
  );
}
