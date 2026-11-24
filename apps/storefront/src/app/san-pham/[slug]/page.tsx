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
    'Đổi size 7–14 ngày và hỗ trợ ướm thử dáng thực tế bằng AI tại Tầm Xuân Fashion Atelier.',
  ]
    .filter(Boolean)
    .join(' ');

  return {
    title: `${product.name} · ${product.categoryName} | Tầm Xuân Fashion Atelier`,
    description,
    alternates: {
      canonical: canonicalUrl,
    },
    openGraph: {
      title: `${product.name} | Tầm Xuân Fashion Atelier`,
      description,
      url: canonicalUrl,
      type: 'website',
      locale: 'vi_VN',
      siteName: 'Tầm Xuân Fashion Atelier',
      images: [
        {
          url: ogImageUrl,
          width: 1200,
          height: 630,
          alt: `${product.name} — Tầm Xuân Fashion Atelier`,
        },
      ],
    },
    twitter: {
      card: 'summary_large_image',
      title: `${product.name} | Tầm Xuân Fashion Atelier`,
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

  const productJsonLd: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: product.name,
    description:
      product.description || product.subtitle || product.fabricComposition,
    image: [lookbookUrl, ...(flatUrl && flatUrl !== lookbookUrl ? [flatUrl] : [])],
    url: canonicalUrl,
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
      availability:
        product.stockStatusSummary === 'OUT_OF_STOCK'
          ? 'https://schema.org/OutOfStock'
          : 'https://schema.org/InStock',
    },
  };

  if (fitStats && fitStats.totalReviews > 0) {
    productJsonLd.aggregateRating = {
      '@type': 'AggregateRating',
      ratingValue: Number(fitStats.averageRating.toFixed(1)),
      reviewCount: fitStats.totalReviews,
      bestRating: 5,
      worstRating: 1,
    };
  }

  return (
    <InnerPageFrame>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(productJsonLd) }}
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
