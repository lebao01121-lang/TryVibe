import type { MetadataRoute } from 'next';
import {
  fetchOccasionLookbooks,
  fetchSeasonalCollections,
  fetchStorefrontProducts,
  getSiteBaseUrl,
} from '@/lib/bootstrap';
import { CATEGORY_TABS } from '@/lib/catalog-data';

export const dynamic = 'force-dynamic';

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const baseUrl = getSiteBaseUrl();
  const now = new Date();

  const [productsRes, occasions, seasons] = await Promise.all([
    fetchStorefrontProducts({ limit: 100 }),
    fetchOccasionLookbooks(),
    fetchSeasonalCollections(),
  ]);

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
    url: `${baseUrl}/bo-suu-tap/${cat.slug}`,
    lastModified: now,
    changeFrequency: 'weekly',
    priority: 0.8,
  }));

  const occasionRoutes: MetadataRoute.Sitemap = occasions.map((occ) => ({
    url: `${baseUrl}/bo-suu-tap/${occ.slug}`,
    lastModified: now,
    changeFrequency: 'weekly',
    priority: 0.8,
  }));

  const seasonRoutes: MetadataRoute.Sitemap = seasons.map((season) => ({
    url: `${baseUrl}/bo-suu-tap/${season.slug}`,
    lastModified: now,
    changeFrequency: 'weekly',
    priority: 0.8,
  }));

  const productRoutes: MetadataRoute.Sitemap = productsRes.products.map(
    (product) => ({
      url: `${baseUrl}/san-pham/${product.slug}`,
      lastModified: product.updatedAt ? new Date(product.updatedAt) : now,
      changeFrequency: 'daily',
      priority: 0.9,
    }),
  );

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
