import type { Metadata } from 'next';
import { Suspense } from 'react';
import { CollectionCatalogClient } from '@/components/CollectionCatalogClient';
import { InnerPageFrame } from '@/components/layout/InnerPageFrame';
import {
  fetchStorefrontProducts,
  getSiteBaseUrl,
} from '@/lib/bootstrap';
import {
  CATEGORY_TABS,
  OCCASION_CATALOG,
  SEASON_DROPS,
} from '@/lib/catalog-data';

export const dynamic = 'force-dynamic';

interface CollectionsCatchAllProps {
  params: Promise<{ slug?: string[] }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function readSingleParam(
  value: string | string[] | undefined,
): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (Array.isArray(value) && value[0]) {
    const trimmed = value[0].trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  return undefined;
}

function classifySlug(slug?: string): {
  categorySlug?: string;
  occasionSlug?: string;
  seasonSlug?: string;
  heading: string;
  description: string;
} {
  if (!slug) {
    return {
      heading: 'Bộ sưu tập TryVibe Fashion Atelier',
      description:
        'Khám phá toàn bộ thiết kế lụa tơ tằm Bảo Lộc, linen hữu cơ, đầm dự tiệc và blazer may đo thủ công hỗ trợ thử đồ AI.',
    };
  }

  const cat = CATEGORY_TABS.find((c) => c.slug === slug);
  if (cat) {
    return {
      categorySlug: cat.slug,
      heading: cat.name,
      description: `Bộ sưu tập ${cat.name} may đo thủ công tại TryVibe Fashion Atelier với tồn kho theo size thời gian thực.`,
    };
  }

  const occ = OCCASION_CATALOG.find((o) => o.slug === slug || o.key === slug);
  if (occ) {
    return {
      occasionSlug: occ.slug,
      heading: `Dịp mặc: ${occ.title}`,
      description: occ.tagline,
    };
  }

  const season = SEASON_DROPS.find((s) => s.slug === slug);
  if (season) {
    return {
      seasonSlug: season.slug,
      heading: `Bộ sưu tập ${season.title}`,
      description: season.note,
    };
  }

  return {
    categorySlug: slug,
    heading: `Bộ sưu tập · ${slug}`,
    description:
      'Danh mục thiết kế may đo thủ công tại TryVibe Fashion Atelier.',
  };
}

export async function generateMetadata({
  params,
  searchParams,
}: CollectionsCatchAllProps): Promise<Metadata> {
  const { slug } = await params;
  const query = await searchParams;
  const firstSlug = slug?.[0];
  const queryCategory =
    readSingleParam(query.category) ?? readSingleParam(query.categorySlug);
  const info = classifySlug(firstSlug ?? queryCategory);
  const siteUrl = getSiteBaseUrl();
  const canonicalPath = firstSlug
    ? `/bo-suu-tap/${encodeURIComponent(firstSlug)}`
    : '/bo-suu-tap';

  return {
    title: `${info.heading} | TryVibe Fashion Atelier`,
    description: info.description,
    alternates: {
      canonical: `${siteUrl}${canonicalPath}`,
    },
    openGraph: {
      title: `${info.heading} | TryVibe Fashion Atelier`,
      description: info.description,
      url: `${siteUrl}${canonicalPath}`,
      type: 'website',
      locale: 'vi_VN',
      siteName: 'TryVibe Fashion Atelier',
    },
  };
}

export default async function CollectionsCatchAllPage({
  params,
  searchParams,
}: CollectionsCatchAllProps) {
  const { slug } = await params;
  const query = await searchParams;
  const firstSlug = slug?.[0];
  const resolved = classifySlug(firstSlug);

  const queryCategory =
    readSingleParam(query.category) ?? readSingleParam(query.categorySlug);
  const effectiveCategorySlug = queryCategory ?? resolved.categorySlug;
  const occasion = readSingleParam(query.occasion) ?? resolved.occasionSlug;
  const season = readSingleParam(query.season) ?? resolved.seasonSlug;
  const mySize = readSingleParam(query.mySize)?.toUpperCase();
  const size = readSingleParam(query.size)?.toUpperCase();
  const effectiveSize = mySize || size;

  const { source, products: rawProducts } = await fetchStorefrontProducts({
    categorySlug: effectiveCategorySlug,
    q: readSingleParam(query.q),
    size: effectiveSize,
    color: readSingleParam(query.color),
    occasion,
    season,
    minPrice: readSingleParam(query.minPrice),
    maxPrice: readSingleParam(query.maxPrice),
    isTryonEnabled: readSingleParam(query.isTryonEnabled),
    sort: readSingleParam(query.sort),
  });

  // Ensure strict in-stock matching when `?mySize=` is specified in SSR URL
  const products = mySize
    ? rawProducts.filter((product) =>
        product.variants.some((variant) =>
          variant.skus.some(
            (sku) => sku.sizeCode.toUpperCase() === mySize && sku.inStock,
          ),
        ),
      )
    : rawProducts;

  const resolvedHeading =
    (queryCategory
      ? CATEGORY_TABS.find((c) => c.slug === queryCategory)?.name
      : undefined) ?? resolved.heading;

  return (
    <InnerPageFrame>
      <Suspense
        fallback={
          <div className="mx-auto max-w-7xl px-6 py-16 text-sm text-[#7A6A5B]">
            Đang tải bộ sưu tập...
          </div>
        }
      >
        <CollectionCatalogClient
          initialCategorySlug={resolved.categorySlug}
          initialOccasionSlug={resolved.occasionSlug}
          initialSeasonSlug={resolved.seasonSlug}
          headingTitle={resolvedHeading}
          initialProducts={products}
          initialSource={source}
        />
      </Suspense>
    </InnerPageFrame>
  );
}
