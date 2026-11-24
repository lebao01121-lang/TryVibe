import type { Metadata } from 'next';
import { HomeOutfitStudioBridge } from '@/components/HomeOutfitStudioBridge';
import { AtelierCraftJourney } from '@/features/atelier-story/AtelierCraftJourney';
import { FinaleShowcase } from '@/features/finale/FinaleShowcase';
import { HeroEditorial } from '@/features/hero/HeroEditorial';
import { IntroCurtain } from '@/features/intro/IntroCurtain';
import { OccasionShowcase } from '@/features/occasion/OccasionShowcase';
import { ClothingRack3D } from '@/features/rack-3d/ClothingRack3D';
import { SeasonLookbookTrack } from '@/features/seasons-lookbook/SeasonLookbookTrack';
import {
  fetchOccasionLookbooks,
  fetchRackCollection,
  fetchSeasonalCollections,
  fetchStorefrontBootstrap,
  fetchStorefrontProducts,
  getSiteBaseUrl,
} from '@/lib/bootstrap';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const siteUrl = getSiteBaseUrl();
  return {
    title: 'Tầm Xuân · Fashion Atelier — Thời Trang May Đo Thủ Công',
    description:
      'Nhà mốt thời trang Editorial Quiet Luxury tại Hà Nội: giá treo 3D WebGL, chọn trang phục theo dịp, phối đồ Mix & Match Studio và phòng thử đồ AI riêng tư.',
    alternates: {
      canonical: `${siteUrl}/`,
    },
    openGraph: {
      title: 'Tầm Xuân · Fashion Atelier — Thời Trang May Đo Thủ Công',
      description:
        'Khám phá giá treo 3D WebGL, bộ sưu tập lụa tơ tằm Bảo Lộc và phòng thử đồ AI riêng tư 15 phút tự hủy.',
      type: 'website',
      url: `${siteUrl}/`,
      locale: 'vi_VN',
    },
  };
}

export default async function HomePage() {
  const [bootstrapRes, rackRes, occasionsRes, seasonsRes, catalogRes] =
    await Promise.allSettled([
      fetchStorefrontBootstrap(),
      fetchRackCollection(),
      fetchOccasionLookbooks(),
      fetchSeasonalCollections(),
      fetchStorefrontProducts({ limit: 32 }),
    ]);

  const bootstrap =
    bootstrapRes.status === 'fulfilled'
      ? bootstrapRes.value
      : await fetchStorefrontBootstrap();
  const rackItems = rackRes.status === 'fulfilled' ? rackRes.value : [];
  const occasions =
    occasionsRes.status === 'fulfilled' ? occasionsRes.value : [];
  const seasons = seasonsRes.status === 'fulfilled' ? seasonsRes.value : [];
  const studioProducts =
    catalogRes.status === 'fulfilled' && catalogRes.value.products.length > 0
      ? catalogRes.value.products
      : bootstrap.featuredProducts;

  return (
    <>
      <IntroCurtain intro={bootstrap.intro} />
      <HeroEditorial hero={bootstrap.hero} tagline={bootstrap.intro.tagline} />
      <ClothingRack3D items={rackItems} />
      <OccasionShowcase occasions={occasions} />
      <HomeOutfitStudioBridge
        products={studioProducts}
        packagingOptions={bootstrap.packagingOptions}
        showSizeAdvisor
      />
      <SeasonLookbookTrack seasons={seasons} />
      <AtelierCraftJourney steps={bootstrap.atelierSteps} />
      <FinaleShowcase finale={bootstrap.finale} />
    </>
  );
}
