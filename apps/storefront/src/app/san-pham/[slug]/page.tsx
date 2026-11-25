import type { Metadata } from 'next';
import { InnerPageFrame } from '@/components/layout/InnerPageFrame';
import { ProductDetailClient } from '@/components/ProductDetailClient';
import { fetchPdpCompositeBySlug, getSiteBaseUrl } from '@/lib/bootstrap';
import { FORMAT_VND, getPrimaryVariantImage } from '@/lib/catalog-data';

export const dynamic = 'force-dynamic';

interface ProductDetailPageProps {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export async function generateMetadata({
  params,
}: ProductDetailPageProps): Promise<Metadata> {
  const { slug } = await params;
  const { product } = await fetchPdpCompositeBySlug(slug);
  const siteUrl = getSiteBaseUrl();
  const canonicalUrl = `${siteUrl}/san-pham/${encodeURIComponent(product.slug)}`;
  const ogImageUrl = `${siteUrl}/san-pham/${encodeURIComponent(product.slug)}/opengraph-image`;

  const description = [
    product.subtitle || product.description || product.fabricComposition,
    `Giá từ ${FORMAT_VND(product.minPriceVnd)}.`,
    'Đổi size 7–14 ngày và hỗ trợ ướm thử dáng thực tế bằng AI tại TryVibe Fashion Atelier.',
  ]
    .filter(Boolean)
    .join(' ');

  return {
    title: `${product.name} · ${product.categoryName} | TryVibe Fashion Atelier`,
    description,
    alternates: {
      canonical: canonicalUrl,
    },
    openGraph: {
      title: `${product.name} | TryVibe Fashion Atelier`,
      description,
      url: canonicalUrl,
      type: 'website',
      locale: 'vi_VN',
      siteName: 'TryVibe Fashion Atelier',
      images: [
        {
          url: ogImageUrl,
          width: 1200,
          height: 630,
          alt: `${product.name} — TryVibe Fashion Atelier`,
        },
      ],
    },
    twitter: {
      card: 'summary_large_image',
      title: `${product.name} | TryVibe Fashion Atelier`,
      description,
      images: [ogImageUrl],
    },
  };
}

export default async function ProductDetailPage({
  params,
  searchParams,
}: ProductDetailPageProps) {
  const { slug } = await params;
  const query = await searchParams;
  const { product, fitStats, reviews, reviewsDegraded } =
    await fetchPdpCompositeBySlug(slug);
  const { lookbookUrl, flatUrl } = getPrimaryVariantImage(product, 0);
  const siteUrl = getSiteBaseUrl();
  const canonicalUrl = `${siteUrl}/san-pham/${encodeURIComponent(product.slug)}`;

  const imageList = [
    lookbookUrl,
    ...(flatUrl && flatUrl !== lookbookUrl ? [flatUrl] : []),
  ].filter(Boolean);

  const productJsonLd: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: product.name,
    description:
      product.description || product.subtitle || product.fabricComposition,
    image: imageList,
    url: canonicalUrl,
    category: product.categoryName,
    brand: {
      '@type': 'Brand',
      name: product.brandName,
    },
    sku: product.variants[0]?.skus[0]?.skuCode ?? product.slug,
    material: product.fabricComposition,
    offers: {
      '@type': 'Offer',
      url: canonicalUrl,
      priceCurrency: 'VND',
      price: product.minPriceVnd,
      itemCondition: 'https://schema.org/NewCondition',
      availability:
        product.stockStatusSummary === 'OUT_OF_STOCK'
          ? 'https://schema.org/OutOfStock'
          : 'https://schema.org/InStock',
      seller: {
        '@type': 'Organization',
        name: 'TryVibe Fashion Atelier',
      },
    },
  };

  // Populate real AggregateRating from live ProductFitStatsDTO (or verified reviews fallback)
  if (fitStats && fitStats.totalReviews > 0) {
    productJsonLd.aggregateRating = {
      '@type': 'AggregateRating',
      ratingValue: Number(fitStats.averageRating.toFixed(1)),
      reviewCount: fitStats.totalReviews,
      bestRating: 5,
      worstRating: 1,
    };
  } else if (reviews.length > 0) {
    const ratingSum = reviews.reduce((acc, r) => acc + Number(r.rating || 5), 0);
    const avg = ratingSum / reviews.length;
    productJsonLd.aggregateRating = {
      '@type': 'AggregateRating',
      ratingValue: Number(avg.toFixed(1)),
      reviewCount: reviews.length,
      bestRating: 5,
      worstRating: 1,
    };
  }

  if (reviews.length > 0) {
    productJsonLd.review = reviews.slice(0, 5).map((r) => ({
      '@type': 'Review',
      author: {
        '@type': 'Person',
        name: r.reviewerName,
      },
      datePublished: r.createdAt?.slice(0, 10),
      reviewBody: r.comment,
      reviewRating: {
        '@type': 'Rating',
        ratingValue: r.rating,
        bestRating: 5,
        worstRating: 1,
      },
    }));
  }

  const safeJsonLd = JSON.stringify(productJsonLd).replace(/</g, '\\u003c');

  return (
    <InnerPageFrame>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: safeJsonLd }}
      />
      <ProductDetailClient
        product={product}
        initialFitStats={fitStats}
        initialReviews={reviews}
        reviewsDegraded={reviewsDegraded}
        initialOpenTryOn={query.tryon === '1'}
      />
    </InnerPageFrame>
  );
}
