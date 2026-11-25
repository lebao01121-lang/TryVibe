import type { Metadata } from 'next';
import { TryOnPageClient } from '@/components/TryOnPageClient';
import { fetchStorefrontProducts, getSiteBaseUrl } from '@/lib/bootstrap';

export const dynamic = 'force-dynamic';

interface VirtualTryOnPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export async function generateMetadata(): Promise<Metadata> {
  const siteUrl = getSiteBaseUrl();
  return {
    title: 'Phòng Thử Đồ AI · TryVibe Fashion Atelier',
    description:
      'Trải nghiệm Phòng Thử Đồ AI Atelier trên vóc dáng thật với Gương Camera Thông Minh, Tải Ảnh Của Bạn và Dáng Mẫu Thử Nhanh. Tự động xóa ảnh sau 15 phút.',
    alternates: {
      canonical: `${siteUrl}/thu-do-ai`,
    },
  };
}

export default async function VirtualTryOnPage({
  searchParams,
}: VirtualTryOnPageProps) {
  const query = await searchParams;
  const initialSlug =
    typeof query.slug === 'string' && query.slug.trim().length > 0
      ? query.slug.trim()
      : null;
  const initialVariantId =
    typeof query.variantId === 'string' && query.variantId.trim().length > 0
      ? query.variantId.trim()
      : null;

  const { products } = await fetchStorefrontProducts({ limit: 36 });

  return (
    <div
      data-nav-theme="dark"
      className="min-h-[100svh] w-full overflow-hidden bg-[#18120E] text-[#FBF7EF]"
    >
      <TryOnPageClient
        products={products}
        initialSlug={initialSlug}
        initialVariantId={initialVariantId}
      />
    </div>
  );
}
