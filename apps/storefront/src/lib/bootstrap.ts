import {
  type ApiResponse,
  type AtelierStep,
  type CampaignFinale,
  type CampaignHero,
  type CampaignIntro,
  type OccasionLookbookDto,
  type PackagingOptionDto,
  type ProductFitStatsDto,
  type ProductSpuDto,
  type RackCollectionDto,
  type RackGarmentItemDto,
  type SeasonalCollectionDto,
  type StorefrontBootstrapDto,
  type VerifiedReviewDto,
} from '@atelier/contracts';
import {
  FALLBACK_PRODUCTS,
  OCCASION_CATALOG,
  PACKAGING_TIERS,
  SEASON_DROPS,
  extractProductArray,
  getPrimaryVariantImage,
  type OccasionCard,
  type SeasonDrop,
} from './catalog-data';

export interface StorefrontBootstrapView {
  source: 'live-bff' | 'editorial-fallback';
  bffUrl: string;
  intro: CampaignIntro;
  hero: CampaignHero;
  atelierSteps: AtelierStep[];
  finale: CampaignFinale;
  rackPreviewCount: number;
  occasionsCount: number;
  seasonsCount: number;
  serviceStatus: string;
  occasions: OccasionCard[];
  seasons: SeasonDrop[];
  featuredProducts: ProductSpuDto[];
  packagingOptions: PackagingOptionDto[];
}

export interface ProductQueryParams {
  categorySlug?: string;
  q?: string;
  size?: string;
  color?: string;
  occasion?: string;
  season?: string;
  minPrice?: string;
  maxPrice?: string;
  isTryonEnabled?: string;
  sort?: string;
  limit?: number;
}

export interface PdpCompositeView {
  source: 'live-bff' | 'editorial-fallback';
  product: ProductSpuDto;
  fitStats: ProductFitStatsDto | null;
  reviews: VerifiedReviewDto[];
  reviewsDegraded: boolean;
}

interface StorefrontMemoryCacheEntry<T> {
  value: T;
  expiresAt: number;
  tags: readonly string[];
}

const storefrontMemoryCache = new Map<string, StorefrontMemoryCacheEntry<unknown>>();
const MAX_STOREFRONT_CACHE_ENTRIES = 128;

function getMemoryCached<T>(key: string): T | null {
  const entry = storefrontMemoryCache.get(key);
  if (!entry) return null;
  if (Date.now() >= entry.expiresAt) {
    storefrontMemoryCache.delete(key);
    return null;
  }
  return entry.value as T;
}

function setMemoryCached<T>(
  key: string,
  value: T,
  ttlMs: number,
  tags: readonly string[],
): void {
  if (
    storefrontMemoryCache.size >= MAX_STOREFRONT_CACHE_ENTRIES &&
    !storefrontMemoryCache.has(key)
  ) {
    const oldestKey = storefrontMemoryCache.keys().next().value;
    if (oldestKey !== undefined) {
      storefrontMemoryCache.delete(oldestKey);
    }
  }
  storefrontMemoryCache.set(key, {
    value,
    expiresAt: Date.now() + ttlMs,
    tags,
  });
}

export function invalidateStorefrontMemoryCache(tags?: readonly string[]): void {
  if (!tags || tags.length === 0) {
    storefrontMemoryCache.clear();
    return;
  }
  const tagSet = new Set(tags);
  if (tagSet.has('storefront')) {
    storefrontMemoryCache.clear();
    return;
  }
  for (const [key, entry] of storefrontMemoryCache.entries()) {
    if (entry.tags.some((t) => tagSet.has(t))) {
      storefrontMemoryCache.delete(key);
    }
  }
}

export function getServerBffUrl(): string {
  if (typeof window !== 'undefined') {
    return '';
  }
  return (
    process.env.BFF_INTERNAL_URL?.replace(/\/+$/, '') ||
    'http://127.0.0.1:4000'
  );
}

export function getSiteBaseUrl(): string {
  return (
    process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, '') ||
    process.env.STOREFRONT_URL?.replace(/\/$/, '') ||
    'http://localhost:3000'
  );
}

const DEFAULT_MINIO_PUBLIC = (
  process.env.NEXT_PUBLIC_MINIO_URL ||
  process.env.MINIO_PUBLIC_URL ||
  'http://127.0.0.1:9000'
).replace(/\/$/, '');

const HERO_EYEBROW_CANONICAL =
  'FASHION ATELIER · EST. 2019 · MAY ĐO THỦ CÔNG TẠI HÀ NỘI';

function sanitizeHeroVideoUrl(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  if (
    trimmed.startsWith('http://') ||
    trimmed.startsWith('https://') ||
    trimmed.startsWith('/media/atelier-')
  ) {
    return trimmed;
  }
  return null;
}

const DEFAULT_INTRO: CampaignIntro = {
  monogramLeft: 'T',
  monogramAmp: '&',
  monogramRight: 'V',
  tagline: 'May đo thủ công · Hà Nội',
  brandName: 'TryVibe',
  brandSub: 'Fashion Atelier',
};

const DEFAULT_HERO: CampaignHero = {
  eyebrow: HERO_EYEBROW_CANONICAL,
  title: 'TryVibe',
  lead: 'Thiết kế may đo thủ công trên lụa tơ tằm và linen hữu cơ — ướm thử dáng thật bằng AI trước khi đặt may.',
  primaryCtaLabel: 'Khám phá bộ sưu tập',
  serviceNote: 'May đo theo số đo · Đổi size 7–14 ngày · Xóa ảnh AI sau 15 phút',
  posterUrl: '/media/atelier-hero-poster.webp',
  videoWebmUrl: null,
  videoMp4Url: null,
};

const DEFAULT_ATELIER_STEPS: AtelierStep[] = [
  {
    stepOrder: 1,
    timeTarget: '08:00',
    title: 'Tuyển chọn lụa & linen',
    description:
      'Kiểm tra từng thước lụa tơ tằm Bảo Lộc 19 momme, linen hữu cơ và wool lạnh dưới ánh sáng tự nhiên buổi sớm.',
    imageUrl: `${DEFAULT_MINIO_PUBLIC}/atelier-public/seed/atelier-step-1.webp`,
    imageAlt: 'Tuyển chọn lụa tơ tằm và linen tự nhiên tại xưởng TryVibe',
  },
  {
    stepOrder: 2,
    timeTarget: '11:00',
    title: 'Dựng rập & cắt thủ công',
    description:
      'Nghệ nhân rập điều chỉnh cầu vai, độ rủ nách và tỷ lệ eo riêng theo đặc thù hình thể người Việt.',
    imageUrl: `${DEFAULT_MINIO_PUBLIC}/atelier-public/seed/atelier-step-2.webp`,
    imageAlt: 'Nghệ nhân dựng rập giấy và cắt vải thủ công trên bàn xưởng',
  },
  {
    stepOrder: 3,
    timeTarget: '14:30',
    title: 'Khâu tay chi tiết',
    description:
      'Đường may lộn giấu chỉ bên trong, đính khuy sừng và viền lụa bằng tay đảm bảo sự êm nhẹ khi chạm da.',
    imageUrl: `${DEFAULT_MINIO_PUBLIC}/atelier-public/seed/atelier-step-3.webp`,
    imageAlt: 'Khâu tay chi tiết cổ áo và viền lụa tại xưởng may',
  },
  {
    stepOrder: 4,
    timeTarget: '17:00',
    title: 'Là hơi, kiểm chuẩn & đóng hộp',
    description:
      'Hoàn thiện bằng hơi nước giữ sợi vải mềm rủ, chụp ảnh kiểm chuẩn trước khi đóng hộp cứng kèm thiệp viết tay.',
    imageUrl: `${DEFAULT_MINIO_PUBLIC}/atelier-public/seed/atelier-step-4.webp`,
    imageAlt: 'Hộp quà cứng Signature Ivory sẵn sàng giao tận tay khách hàng',
  },
];

const DEFAULT_FINALE: CampaignFinale = {
  eyebrow: 'Đặt may & Phòng thử AI',
  leadMain: 'Ghé xưởng hoặc ướm thử trực tuyến —',
  leadEmphasis: 'mỗi đường kim đều chuẩn theo dáng bạn.',
  ctaLabel: 'Khám phá bộ sưu tập',
  showroomInfo: 'Phố Phan Đình Phùng, Ba Đình · Mở cửa 9:00 – 21:00 mỗi ngày',
  wordmark: 'TryVibe',
  featuredVoices: [
    {
      quote:
        'Bề mặt lụa bóng mờ rất sang, mặc cả ngày làm việc không bị bám mồ hôi và vai áo đứng phom tự nhiên.',
      author: 'Chị Minh Anh · Ba Đình',
      fitMeta: '163cm · 52kg · Mặc Size S (Vừa vai)',
    },
    {
      quote:
        'Tư vấn bảng số đo chuẩn xác ngay từ lần đặt đầu tiên. Hộp quà và thiệp viết tay được hoàn thiện cực kỳ tinh tế.',
      author: 'Anh Quang Đức · Tây Hồ',
      fitMeta: '176cm · 70kg · Mặc Size L (Thoải mái)',
    },
    {
      quote:
        'Thử đồ AI giúp mình chọn đúng màu Cacao trước khi đặt may, đường may lộn giấu chỉ bên trong rất chỉn chu.',
      author: 'Chị Thu Hà · Hoàn Kiếm',
      fitMeta: '167cm · 56kg · Mặc Size M (Chuẩn eo)',
    },
  ],
};

const DEFAULT_PACKAGING_DTO: PackagingOptionDto[] = PACKAGING_TIERS.map(
  (pkg, index) => ({
    id: pkg.id,
    code: pkg.id,
    name: pkg.name,
    description: pkg.description,
    swatchHex: pkg.swatchHex,
    priceVnd: pkg.priceVnd,
    backAssetUrl: null,
    frontAssetUrl: null,
    isDefault: index === 0,
    sortOrder: index + 1,
  }),
);

function buildFallbackRackItems(): RackGarmentItemDto[] {
  return FALLBACK_PRODUCTS.map((product) => ({
    productId: product.id,
    slug: product.slug,
    name: product.name,
    subtitle: product.subtitle ?? null,
    fabricComposition: product.fabricComposition,
    fabricWeight: 0.55,
    minPriceVnd: product.minPriceVnd,
    isTryonEnabled: product.isTryonEnabled,
    tryonGarmentCategory: product.tryonGarmentCategory,
    fitStats: null,
    variants: product.variants.map((variant, vIdx) => {
      const { lookbookUrl, flatUrl } = getPrimaryVariantImage(product, vIdx);
      return {
        id: variant.id,
        colorName: variant.colorName,
        colorHex: variant.colorHex,
        frontCutoutUrl: variant.rackFrontUrl ?? lookbookUrl,
        backCutoutUrl: variant.rackBackUrl ?? flatUrl,
        lookbookMainUrl: variant.lookbookMainUrl ?? lookbookUrl,
        tryonFlatPreviewUrl: variant.tryonFlatPreviewUrl ?? flatUrl,
        rackFrontAssetId: variant.rackFrontAssetId,
        hangerAnchorX: 0.5,
        hangerAnchorY: 0.14,
        inStockSizes: variant.skus.filter((s) => s.inStock).map((s) => s.sizeCode),
        skus: variant.skus,
      };
    }),
  }));
}

function buildFallbackOccasionLookbooks(): OccasionLookbookDto[] {
  return OCCASION_CATALOG.map((occ, idx) => {
    const matched = FALLBACK_PRODUCTS.filter((p) =>
      p.occasionSlugs.includes(occ.slug),
    );
    const chosen = (matched.length > 0 ? matched : FALLBACK_PRODUCTS).slice(0, 4);
    return {
      id: `occ-${occ.slug}`,
      slug: occ.slug,
      key: occ.key,
      name: occ.title,
      tagline: occ.tagline,
      description: occ.tagline,
      themeBg: occ.paletteBg,
      themeInk: occ.paletteInk,
      themeAccent: occ.accentHex,
      isDark: occ.paletteBg === '#1C1410',
      badgeTag: idx === 0 ? 'Phổ biến' : null,
      sortOrder: idx + 1,
      productSlugs: chosen.map((p) => p.slug),
      featuredProducts: chosen,
      items: chosen.map((p, i) => {
        const { lookbookUrl, flatUrl } = getPrimaryVariantImage(p, 0);
        return {
          productId: p.id,
          slug: p.slug,
          name: p.name,
          minPriceVnd: p.minPriceVnd,
          lookbookMainUrl: lookbookUrl,
          tryonFlatPreviewUrl: flatUrl,
          isTryonEnabled: p.isTryonEnabled,
          slotLabel: `Look 0${i + 1}`,
        };
      }),
    };
  });
}

function buildFallbackSeasonalCollections(): SeasonalCollectionDto[] {
  return SEASON_DROPS.map((drop, idx) => {
    const matched =
      FALLBACK_PRODUCTS.find((p) => p.seasonSlugs.includes(drop.slug)) ??
      FALLBACK_PRODUCTS[idx % FALLBACK_PRODUCTS.length]!;
    const { lookbookUrl } = getPrimaryVariantImage(matched, 0);
    return {
      id: `season-${drop.slug}`,
      slug: drop.slug,
      months: drop.months,
      name: drop.title,
      note: drop.note,
      coverAssetUrl: lookbookUrl,
      launchAt: null,
      endAt: null,
      isCurrent: drop.isCurrent,
      isNow: drop.isCurrent,
      sortOrder: idx + 1,
      productSlugs: [matched.slug],
      productCount: 2,
      featuredProductSlugs: [matched.slug],
    };
  });
}

export async function fetchRackCollection(): Promise<RackGarmentItemDto[]> {
  const cacheKey = 'rack-collection';
  const cached = getMemoryCached<RackGarmentItemDto[]>(cacheKey);
  if (cached) return cached;

  const bffUrl = getServerBffUrl();
  try {
    const res = await fetch(`${bffUrl}/bff/v1/storefront/rack-collection`, {
      cache: 'no-store',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(2500),
    });
    if (res.ok) {
      const json = (await res.json()) as ApiResponse<
        RackCollectionDto | RackGarmentItemDto[]
      >;
      if (json?.success && json.data) {
        const items = Array.isArray(json.data)
          ? json.data
          : json.data.items ?? [];
        if (items.length > 0) {
          setMemoryCached(cacheKey, items, 120_000, ['storefront', 'rack']);
          return items;
        }
      }
    }
  } catch {
    // Fallback below (never cached)
  }
  return buildFallbackRackItems();
}

export async function fetchOccasionLookbooks(): Promise<OccasionLookbookDto[]> {
  const cacheKey = 'occasions';
  const cached = getMemoryCached<OccasionLookbookDto[]>(cacheKey);
  if (cached) return cached;

  const bffUrl = getServerBffUrl();
  try {
    const res = await fetch(`${bffUrl}/bff/v1/storefront/occasions`, {
      cache: 'no-store',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(2500),
    });
    if (res.ok) {
      const json = (await res.json()) as ApiResponse<
        OccasionLookbookDto[] | { items: OccasionLookbookDto[] }
      >;
      if (json?.success && json.data) {
        const list = Array.isArray(json.data)
          ? json.data
          : json.data.items ?? [];
        if (list.length > 0) {
          setMemoryCached(cacheKey, list, 180_000, ['storefront', 'occasions']);
          return list;
        }
      }
    }
  } catch {
    // Fallback below (never cached)
  }
  return buildFallbackOccasionLookbooks();
}

export async function fetchSeasonalCollections(): Promise<
  SeasonalCollectionDto[]
> {
  const cacheKey = 'seasons';
  const cached = getMemoryCached<SeasonalCollectionDto[]>(cacheKey);
  if (cached) return cached;

  const bffUrl = getServerBffUrl();
  try {
    const res = await fetch(`${bffUrl}/bff/v1/storefront/seasons`, {
      cache: 'no-store',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(2500),
    });
    if (res.ok) {
      const json = (await res.json()) as ApiResponse<
        SeasonalCollectionDto[] | { items: SeasonalCollectionDto[] }
      >;
      if (json?.success && json.data) {
        const list = Array.isArray(json.data)
          ? json.data
          : json.data.items ?? [];
        if (list.length > 0) {
          setMemoryCached(cacheKey, list, 180_000, ['storefront', 'seasons']);
          return list;
        }
      }
    }
  } catch {
    // Fallback below (never cached)
  }
  return buildFallbackSeasonalCollections();
}

export async function fetchStorefrontProducts(
  params: ProductQueryParams = {},
): Promise<{
  source: 'live-bff' | 'editorial-fallback';
  products: ProductSpuDto[];
}> {
  const bffUrl = getServerBffUrl();
  const query = new URLSearchParams();
  if (params.categorySlug) query.set('categorySlug', params.categorySlug);
  if (params.q) query.set('q', params.q);
  if (params.size) query.set('size', params.size);
  if (params.color) query.set('color', params.color);
  if (params.occasion) query.set('occasion', params.occasion);
  if (params.season) query.set('season', params.season);
  if (params.minPrice) query.set('minPrice', params.minPrice);
  if (params.maxPrice) query.set('maxPrice', params.maxPrice);
  if (params.isTryonEnabled) query.set('isTryonEnabled', params.isTryonEnabled);
  if (params.sort) query.set('sort', params.sort);
  if (params.limit) query.set('limit', String(params.limit));

  const qs = query.toString();
  const cacheKey = `products:${qs}`;
  const cached = getMemoryCached<{
    source: 'live-bff' | 'editorial-fallback';
    products: ProductSpuDto[];
  }>(cacheKey);
  if (cached) return cached;

  try {
    const res = await fetch(
      `${bffUrl}/bff/v1/storefront/products${qs ? `?${qs}` : ''}`,
      {
        cache: 'no-store',
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(2500),
      },
    );
    if (res.ok) {
      const json = (await res.json()) as ApiResponse<unknown>;
      const items = extractProductArray(json?.data);
      if (json?.success) {
        const result = { source: 'live-bff' as const, products: items };
        if (items.length > 0) {
          setMemoryCached(cacheKey, result, 120_000, ['storefront', 'products']);
        }
        return result;
      }
    }
  } catch {
    // Graceful offline fallback (never cached)
  }

  let filtered = [...FALLBACK_PRODUCTS];
  if (params.categorySlug) {
    filtered = filtered.filter((p) => p.categorySlug === params.categorySlug);
  }
  if (params.occasion) {
    filtered = filtered.filter((p) =>
      p.occasionSlugs.includes(params.occasion!),
    );
  }
  if (params.season) {
    filtered = filtered.filter((p) => p.seasonSlugs.includes(params.season!));
  }
  if (params.isTryonEnabled === 'true') {
    filtered = filtered.filter((p) => p.isTryonEnabled);
  }
  if (params.size) {
    filtered = filtered.filter((p) =>
      p.variants.some((v) =>
        v.skus.some((s) => s.sizeCode === params.size && s.inStock),
      ),
    );
  }
  if (params.minPrice && Number.isFinite(Number(params.minPrice))) {
    filtered = filtered.filter((p) => p.minPriceVnd >= Number(params.minPrice));
  }
  if (params.maxPrice && Number.isFinite(Number(params.maxPrice))) {
    filtered = filtered.filter((p) => p.minPriceVnd <= Number(params.maxPrice));
  }
  if (params.q) {
    const qLower = params.q.toLowerCase();
    filtered = filtered.filter(
      (p) =>
        p.name.toLowerCase().includes(qLower) ||
        p.fabricComposition.toLowerCase().includes(qLower) ||
        p.categoryName.toLowerCase().includes(qLower),
    );
  }
  if (params.sort === 'price_asc') {
    filtered.sort((a, b) => a.minPriceVnd - b.minPriceVnd);
  } else if (params.sort === 'price_desc') {
    filtered.sort((a, b) => b.minPriceVnd - a.minPriceVnd);
  }

  return { source: 'editorial-fallback', products: filtered };
}

export async function fetchPdpCompositeBySlug(
  slug: string,
): Promise<PdpCompositeView> {
  const cacheKey = `pdp:${slug}`;
  const cached = getMemoryCached<PdpCompositeView>(cacheKey);
  if (cached) return cached;

  const bffUrl = getServerBffUrl();
  try {
    const res = await fetch(
      `${bffUrl}/bff/v1/storefront/products/${encodeURIComponent(slug)}`,
      {
        cache: 'no-store',
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(2500),
      },
    );
    if (res.ok) {
      const json = (await res.json()) as ApiResponse<
        ProductSpuDto & {
          product?: ProductSpuDto;
          fitStats?: ProductFitStatsDto | null;
          reviews?: VerifiedReviewDto[];
          reviewsDegraded?: boolean;
        }
      >;
      if (json?.success && json.data) {
        const raw = json.data;
        const product: ProductSpuDto = raw.product ?? raw;
        const view: PdpCompositeView = {
          source: 'live-bff',
          product,
          fitStats: raw.fitStats ?? null,
          reviews: Array.isArray(raw.reviews) ? raw.reviews : [],
          reviewsDegraded: Boolean(raw.reviewsDegraded),
        };
        if (!view.reviewsDegraded) {
          setMemoryCached(cacheKey, view, 120_000, [
            'storefront',
            'products',
            `product:${slug}`,
          ]);
        }
        return view;
      }
    }
  } catch {
    // Fallback below (never cached)
  }

  const fallback =
    FALLBACK_PRODUCTS.find((p) => p.slug === slug) ?? FALLBACK_PRODUCTS[0]!;
  return {
    source: 'editorial-fallback',
    product: fallback,
    fitStats: null,
    reviews: [],
    reviewsDegraded: true,
  };
}

export async function fetchStorefrontBootstrap(): Promise<StorefrontBootstrapView> {
  const cacheKey = 'bootstrap';
  const cached = getMemoryCached<StorefrontBootstrapView>(cacheKey);
  if (cached) return cached;

  const bffUrl = getServerBffUrl();

  const fallback: StorefrontBootstrapView = {
    source: 'editorial-fallback',
    bffUrl: '',
    intro: DEFAULT_INTRO,
    hero: DEFAULT_HERO,
    atelierSteps: DEFAULT_ATELIER_STEPS,
    finale: DEFAULT_FINALE,
    rackPreviewCount: FALLBACK_PRODUCTS.length,
    occasionsCount: OCCASION_CATALOG.length,
    seasonsCount: SEASON_DROPS.length,
    serviceStatus: 'Chế độ trình diễn ngoại tuyến (BFF đang tắt)',
    occasions: OCCASION_CATALOG,
    seasons: SEASON_DROPS,
    featuredProducts: FALLBACK_PRODUCTS,
    packagingOptions: DEFAULT_PACKAGING_DTO,
  };

  try {
    const response = await fetch(`${bffUrl}/bff/v1/storefront/bootstrap`, {
      cache: 'no-store',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(2500),
    });

    if (!response.ok) {
      return fallback;
    }

    const payload =
      (await response.json()) as ApiResponse<StorefrontBootstrapDto>;
    const data = payload?.data;

    if (!payload?.success || !data) {
      return fallback;
    }

    const hc = data.homepageCampaign;

    const intro: CampaignIntro = {
      ...DEFAULT_INTRO,
      ...(hc?.intro ?? {}),
    };

    const hero: CampaignHero = {
      ...DEFAULT_HERO,
      eyebrow:
        hc?.hero?.eyebrow ||
        hc?.eyebrow ||
        data.campaign.eyebrow ||
        DEFAULT_HERO.eyebrow,
      title:
        hc?.hero?.title ||
        hc?.heroTitle ||
        hc?.title ||
        data.campaign.title ||
        DEFAULT_HERO.title,
      lead:
        hc?.hero?.lead ||
        hc?.heroSubtitle ||
        hc?.subtitle ||
        data.campaign.subtitle ||
        DEFAULT_HERO.lead,
      primaryCtaLabel:
        hc?.hero?.primaryCtaLabel ||
        hc?.ctaLabel ||
        data.campaign.ctaLabel ||
        DEFAULT_HERO.primaryCtaLabel,
      serviceNote:
        hc?.hero?.serviceNote ||
        hc?.serviceNote ||
        data.campaign.serviceNote ||
        DEFAULT_HERO.serviceNote,
      posterUrl:
        hc?.hero?.posterUrl ||
        hc?.heroPosterUrl ||
        hc?.heroImageUrl ||
        data.campaign.heroPosterUrl ||
        DEFAULT_HERO.posterUrl,
      videoWebmUrl: sanitizeHeroVideoUrl(
        hc?.hero?.videoWebmUrl !== undefined
          ? hc.hero.videoWebmUrl
          : DEFAULT_HERO.videoWebmUrl,
      ),
      videoMp4Url: sanitizeHeroVideoUrl(
        hc?.hero?.videoMp4Url !== undefined
          ? hc.hero.videoMp4Url
          : DEFAULT_HERO.videoMp4Url,
      ),
    };

    const atelierSteps: AtelierStep[] =
      hc?.atelierSteps && hc.atelierSteps.length > 0
        ? hc.atelierSteps
        : DEFAULT_ATELIER_STEPS;

    const finale: CampaignFinale = {
      ...DEFAULT_FINALE,
      ...(hc?.finale ?? {}),
      featuredVoices:
        hc?.finale?.featuredVoices && hc.finale.featuredVoices.length > 0
          ? hc.finale.featuredVoices
          : DEFAULT_FINALE.featuredVoices,
    };

    const occasions: OccasionCard[] =
      data.occasions && data.occasions.length > 0
        ? data.occasions.map((occ) => ({
            key: occ.key,
            slug: occ.slug || occ.key,
            title: occ.name,
            tagline: occ.tagline,
            paletteBg: occ.themeBg,
            paletteInk: occ.themeInk,
            accentHex: occ.themeAccent,
            featuredCount: occ.itemCount,
          }))
        : fallback.occasions;

    const seasons: SeasonDrop[] =
      data.seasonalCollections && data.seasonalCollections.length > 0
        ? data.seasonalCollections.map((col) => ({
            slug: col.slug,
            months: col.months,
            title: col.name,
            note: col.note,
            isCurrent: col.isCurrent,
          }))
        : fallback.seasons;

    let featuredProducts =
      data.featuredProducts && data.featuredProducts.length > 0
        ? data.featuredProducts
        : [];
    let hasLiveFeatured = featuredProducts.length > 0;

    if (featuredProducts.length === 0) {
      const listRes = await fetchStorefrontProducts({ limit: 12 });
      if (listRes.source === 'live-bff' && listRes.products.length > 0) {
        featuredProducts = listRes.products;
        hasLiveFeatured = true;
      } else {
        featuredProducts = fallback.featuredProducts;
        hasLiveFeatured = false;
      }
    }

    const bffHealth = (data.serviceStatus?.bff || '').toLowerCase();
    const isHealthy = bffHealth !== 'degraded' && hasLiveFeatured;

    const view: StorefrontBootstrapView = {
      source: isHealthy ? 'live-bff' : 'editorial-fallback',
      bffUrl: '',
      intro,
      hero,
      atelierSteps,
      finale,
      rackPreviewCount: data.rackPreviewCount || featuredProducts.length,
      occasionsCount: occasions.length,
      seasonsCount: seasons.length,
      serviceStatus: `Fashion BFF ${data.serviceStatus.bff.toUpperCase()} · Try-On ${data.serviceStatus.aiTryOnMode} (${data.serviceStatus.phase})`,
      occasions,
      seasons,
      featuredProducts,
      packagingOptions:
        data.packagingOptions && data.packagingOptions.length > 0
          ? data.packagingOptions
          : DEFAULT_PACKAGING_DTO,
    };

    // Only cache healthy live bootstrap responses — NEVER poison cache with cold-boot degraded state
    if (isHealthy) {
      setMemoryCached(cacheKey, view, 180_000, ['storefront', 'bootstrap']);
    }

    return view;
  } catch {
    return fallback;
  }
}
