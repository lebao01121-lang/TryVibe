import type { MetadataRoute } from 'next';
import {
  fetchOccasionLookbooks,
  fetchSeasonalCollections,
  fetchStorefrontProducts,
  getSiteBaseUrl,
} from '@/lib/bootstrap';
import { CATEGORY_TABS } from '@/lib/catalog-data';

export const dynamic = 'force-dynamic';

function parseSafeDate(value: string | undefined, fallback: Date): Date {
  if (!value) return fallback;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed;
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const baseUrl = getSiteBaseUrl();
  const now = new Date();

  const [productsSettled, occasionsSettled, seasonsSettled] =
    await Promise.allSettled([
      fetchStorefrontProducts({ limit: 100 }),
      fetchOccasionLookbooks(),
      fetchSeasonalCollections(),
    ]);

  const products =
    productsSettled.status === 'fulfilled' ? productsSettled.value.products : [];
  const occasions =
    occasionsSettled.status === 'fulfilled' ? occasionsSettled.value : [];
  const seasons =
    seasonsSettled.status === 'fulfilled' ? seasonsSettled.value : [];

  const staticRoutes: MetadataRoute.Sitemap = [
    {
      url: `${baseUrl}/`,
      lastModified: now,
      changeFrequency: 'daily',
      priority: 1,
    },
    {
      url: `${baseUrl}/bo-suu-tap`,
      lastModified: now,
      changeFrequency: 'daily',
      priority: 0.9,
    },
    {
      url: `${baseUrl}/phoi-do`,
      lastModified: now,
      changeFrequency: 'weekly',
      priority: 0.8,
    },
    {
      url: `${baseUrl}/thu-do-ai`,
      lastModified: now,
      changeFrequency: 'weekly',
      priority: 0.85,
    },
  ];

  const categoryRoutes: MetadataRoute.Sitemap = CATEGORY_TABS.map((cat) => ({
    url: `${baseUrl}/bo-suu-tap/${encodeURIComponent(cat.slug)}`,
    lastModified: now,
    changeFrequency: 'weekly',
    priority: 0.8,
  }));

  const occasionRoutes: MetadataRoute.Sitemap = occasions.map((occ) => ({
    url: `${baseUrl}/bo-suu-tap/${encodeURIComponent(occ.slug)}`,
    lastModified: now,
    changeFrequency: 'weekly',
    priority: 0.8,
  }));

  const seasonRoutes: MetadataRoute.Sitemap = seasons.map((season) => ({
    url: `${baseUrl}/bo-suu-tap/${encodeURIComponent(season.slug)}`,
    lastModified: now,
    changeFrequency: 'weekly',
    priority: 0.8,
  }));

  const productRoutes: MetadataRoute.Sitemap = products
    .filter((product) => Boolean(product.slug))
    .map((product) => ({
      url: `${baseUrl}/san-pham/${encodeURIComponent(product.slug)}`,
      lastModified: parseSafeDate(product.updatedAt, now),
      changeFrequency: 'daily',
      priority: 0.9,
    }));

  const seen = new Set<string>();
  return [
    ...staticRoutes,
    ...categoryRoutes,
    ...occasionRoutes,
    ...seasonRoutes,
    ...productRoutes,
  ].filter((entry) => {
    if (seen.has(entry.url)) return false;
    seen.add(entry.url);
    return true;
  });
}
