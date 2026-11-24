'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
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

const SIZE_FILTER_OPTIONS = [
  SizeCode.XS,
  SizeCode.S,
  SizeCode.M,
  SizeCode.L,
  SizeCode.XL,
  SizeCode.XXL,
] as const;

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
  const size = searchParams.get('size') ?? '';
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
  const [mySizeActive, setMySizeActive] = useState(false);
  const [mySizeStatus, setMySizeStatus] = useState<string | null>(null);

  useEffect(() => {
    setSearchInput(q);
  }, [q]);

  useEffect(() => {
    let cancelled = false;
    const loadFiltered = async () => {
      setLoading(true);
      const params = new URLSearchParams();
      if (initialCategorySlug) params.set('categorySlug', initialCategorySlug);
      if (q) params.set('q', q);
      if (size) params.set('size', size);
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
        if (res.ok && res.data) {
          setProducts(extractProductArray(res.data));
        }
        setLoading(false);
      }
    };

    void loadFiltered();
    return () => {
      cancelled = true;
    };
  }, [
    initialCategorySlug,
    q,
    size,
    color,
    occasion,
    season,
    minPrice,
    maxPrice,
    isTryonEnabled,
    sort,
  ]);

  const updateFilter = (key: string, value: string) => {
    const next = new URLSearchParams(searchParams.toString());
    if (value) {
      next.set(key, value);
    } else {
      next.delete(key);
    }
    const routeSlug =
      initialCategorySlug || initialOccasionSlug || initialSeasonSlug;
    const base = routeSlug ? `/bo-suu-tap/${routeSlug}` : '/bo-suu-tap';
    const qs = next.toString();
    router.push(qs ? `${base}?${qs}` : base);
  };

  const handleToggleMySize = async () => {
    if (mySizeActive) {
      setMySizeActive(false);
      setMySizeStatus(null);
      updateFilter('size', '');
      return;
    }

    const session = getStoredSession();
    if (session?.accessToken) {
      setMySizeStatus('Đang đọc hồ sơ số đo cá nhân...');
      const profileRes = await apiFetch<CustomerBodyProfileDto>(
        '/bff/v1/customers/me/body-profile',
      );
      if (profileRes.ok && profileRes.data) {
        const referenceProduct = products[0] ?? initialProducts[0];
        if (referenceProduct) {
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
            try {
              window.sessionStorage.setItem(
                'atelier_last_recommended_size',
                recRes.data.recommendedSize,
              );
            } catch {
              // Ignore private mode errors
            }
            setMySizeActive(true);
            setMySizeStatus(
              `Đang lọc sản phẩm còn hàng theo cỡ ${recRes.data.recommendedSize} (từ hồ sơ ${profileRes.data.heightCm}cm / ${profileRes.data.weightKg}kg).`,
            );
            updateFilter('size', recRes.data.recommendedSize);
            return;
          }
        }
      }
    }

    try {
      const cachedSize = window.sessionStorage.getItem(
        'atelier_last_recommended_size',
      );
      if (cachedSize) {
        setMySizeActive(true);
        setMySizeStatus(
          `Đang lọc sản phẩm còn hàng theo cỡ ${cachedSize} (từ kết quả tính cỡ gần nhất trong phiên).`,
        );
        updateFilter('size', cachedSize);
        return;
      }
    } catch {
      // Ignore private mode
    }

    setMySizeStatus(
      'Vui lòng đăng nhập tại /dang-nhap hoặc tính cỡ tại Cố vấn Size AI để kích hoạt bộ lọc theo size của bạn.',
    );
  };

  const activeHeading =
    headingTitle ||
    CATEGORY_TABS.find((c) => c.slug === initialCategorySlug)?.name ||
    'Tất cả bộ sưu tập';

  return (
    <div className="mx-auto max-w-7xl px-6 py-10 lg:px-10">
      <div className="border-b border-[#B08A4A]/25 pb-7">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="atelier-eyebrow text-[#8A672C]">
            Danh mục sản phẩm · Meilisearch Tiếng Việt
          </p>
          <span className="rounded-full border border-[#B08A4A]/35 bg-[#F4EBDA] px-3 py-1 text-[11px] text-[#8A672C]">
            {initialSource === 'live-bff' ? 'Live Catalog' : 'Fallback Mode'} ·{' '}
            {products.length} thiết kế
          </span>
        </div>
        <h1 className="font-editorial mt-2 text-5xl font-light text-[#1C1410]">
          {activeHeading}
        </h1>

        <div className="mt-5 flex flex-wrap gap-2">
          <Link
            href="/bo-suu-tap"
            className={`rounded-full px-4 py-1.5 text-xs transition-colors ${
              !initialCategorySlug && !initialOccasionSlug && !initialSeasonSlug
                ? 'bg-[#1C1410] text-[#EBCF8F]'
                : 'border border-[#B08A4A]/35 bg-[#FBF7EF] text-[#2B2019]'
            }`}
          >
            Tất cả
          </Link>
          {CATEGORY_TABS.map((cat) => (
            <Link
              key={cat.slug}
              href={`/bo-suu-tap/${cat.slug}`}
              className={`rounded-full px-4 py-1.5 text-xs transition-colors ${
                initialCategorySlug === cat.slug
                  ? 'bg-[#1C1410] text-[#EBCF8F]'
                  : 'border border-[#B08A4A]/35 bg-[#FBF7EF] text-[#2B2019] hover:border-[#8A672C]'
              }`}
            >
              {cat.name}
            </Link>
          ))}
        </div>
      </div>

      {/* Multi-Facet Filter Bar synced with URL query */}
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
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              placeholder="Tìm không dấu: ao blazer, vay di tiec..."
              className="flex-1 rounded-full border border-[#B08A4A]/35 bg-white px-4 py-2 text-xs text-[#1C1410] outline-none focus:border-[#8A672C]"
            />
            <button
              type="submit"
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

        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-[#B08A4A]/20 pt-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] uppercase tracking-[0.16em] text-[#8A672C]">
              Kích cỡ:
            </span>
            {SIZE_FILTER_OPTIONS.map((code) => (
              <button
                key={code}
                type="button"
                onClick={() => updateFilter('size', size === code ? '' : code)}
                className={`rounded-full px-3 py-1 text-xs ${
                  size === code
                    ? 'bg-[#1C1410] text-[#EBCF8F]'
                    : 'border border-[#B08A4A]/35 bg-white text-[#2B2019]'
                }`}
              >
                {code}
              </button>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            <button
              type="button"
              onClick={() =>
                updateFilter(
                  'isTryonEnabled',
                  isTryonEnabled === 'true' ? '' : 'true',
                )
              }
              className={`rounded-full px-4 py-1.5 text-xs ${
                isTryonEnabled === 'true'
                  ? 'bg-[#1C1410] text-[#EBCF8F]'
                  : 'border border-[#B08A4A]/40 bg-white text-[#2B2019]'
              }`}
            >
              Hỗ trợ Thử đồ AI
            </button>

            <button
              type="button"
              onClick={handleToggleMySize}
              className={`rounded-full px-4 py-1.5 text-xs font-medium ${
                mySizeActive
                  ? 'bg-[#8A672C] text-[#FBF7EF]'
                  : 'border border-[#8A672C] bg-[#FBF7EF] text-[#8A672C]'
              }`}
            >
              Còn hàng theo Size của tôi
            </button>
          </div>
        </div>

        {mySizeStatus ? (
          <p className="mt-3 text-xs text-[#5C4B41]">{mySizeStatus}</p>
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
                      Ướm thử AI
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
