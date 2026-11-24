import type { Metadata } from 'next';
import { TryOnPageClient } from '@/components/TryOnPageClient';
import { InnerPageFrame } from '@/components/layout/InnerPageFrame';
import { fetchStorefrontProducts, getSiteBaseUrl } from '@/lib/bootstrap';

export const dynamic = 'force-dynamic';

interface VirtualTryOnPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export async function generateMetadata(): Promise<Metadata> {
  const siteUrl = getSiteBaseUrl();
  return {
    title: 'Phòng Thử Đồ 3D AR · Tầm Xuân Fashion Atelier',
    description:
      'Trải nghiệm Phòng Thử Đồ 3D AR trực tiếp trên trình duyệt với Gương Camera thời gian thực, ảnh tĩnh và Ma-nơ-canh 360°. Hình ảnh Camera được xử lý dựng phom 3D trực tiếp ngay trên thiết bị của bạn — tuyệt đối không tải lên hay lưu trữ video cá nhân trên máy chủ.',
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

  const { products } = await fetchStorefrontProducts({ limit: 24 });

  return (
    <InnerPageFrame>
      <div className="mx-auto max-w-7xl px-6 py-10 lg:px-10">
        <div className="mb-8 border-b border-[#B08A4A]/25 pb-6">
          <p className="atelier-eyebrow text-[#8A672C]">
            Phòng Thử Đồ 3D AR · Virtual Try-On Studio
          </p>
          <h1 className="font-editorial mt-2 text-4xl font-light text-[#2B2019] sm:text-5xl">
            Ướm thử thiết kế trên vóc dáng của bạn
          </h1>
          <p className="mt-2.5 max-w-2xl text-sm leading-relaxed text-[#7A6A5B]">
            Trải nghiệm Gương 3D Camera thời gian thực, ướm 3D trên ảnh tĩnh hoặc
            xoay Ma-nơ-canh 3D 360° theo số đo riêng. Hình ảnh Camera được xử lý
            dựng phom 3D trực tiếp ngay trên thiết bị của bạn — tuyệt đối không
            tải lên hay lưu trữ video cá nhân trên máy chủ.
          </p>
        </div>

        <TryOnPageClient
          products={products}
          initialSlug={initialSlug}
          initialVariantId={initialVariantId}
        />
      </div>
    </InnerPageFrame>
  );
}
