import type { MetadataRoute } from 'next';
import { getSiteBaseUrl } from '@/lib/bootstrap';

export default function robots(): MetadataRoute.Robots {
  const baseUrl = getSiteBaseUrl();

  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        disallow: ['/api/', '/tai-khoan'],
      },
    ],
    sitemap: `${baseUrl}/sitemap.xml`,
  };
}
