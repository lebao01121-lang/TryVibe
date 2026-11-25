import type { Metadata } from 'next';
import { HomeOutfitStudioBridge } from '@/components/HomeOutfitStudioBridge';
import { InnerPageFrame } from '@/components/layout/InnerPageFrame';
import {
  fetchStorefrontBootstrap,
  fetchStorefrontProducts,
  getSiteBaseUrl,
} from '@/lib/bootstrap';

export const dynamic = 'force-dynamic';

interface OutfitStudioPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export async function generateMetadata(): Promise<Metadata> {
  const siteUrl = getSiteBaseUrl();
  return {
    title: 'Mix & Match Outfit Studio · TryVibe Fashion Atelier',
    description:
      'Xưởng phối đồ cá nhân Mix & Match trực quan trên ma-nơ-canh, tự động tính ưu đãi Combo -5% / -10%, kiểm tra tồn kho theo size và chia sẻ liên kết bộ trang phục.',
    alternates: {
      canonical: `${siteUrl}/phoi-do`,
    },
  };
}

export default async function OutfitStudioPage({
  searchParams,
}: OutfitStudioPageProps) {
  const query = await searchParams;
  const shareCode =
    typeof query.share === 'string' && query.share.trim().length > 0
      ? query.share.trim()
      : null;

  const [bootstrap, catalog] = await Promise.all([
    fetchStorefrontBootstrap(),
    fetchStorefrontProducts({ limit: 32 }),
  ]);

  const products =
    catalog.products.length > 0
      ? catalog.products
      : bootstrap.featuredProducts;

  return (
    <InnerPageFrame>
      <HomeOutfitStudioBridge
        products={products}
        packagingOptions={bootstrap.packagingOptions}
        initialShareCode={shareCode}
        showSizeAdvisor
      />
    </InnerPageFrame>
  );
}
