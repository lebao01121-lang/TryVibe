import type { Metadata } from 'next';
import { InnerPageFrame } from '@/components/layout/InnerPageFrame';
import { OrderDetailClient } from '@/features/orders/OrderDetailClient';

interface OrderDetailPageProps {
  params: Promise<{ code: string }>;
}

export async function generateMetadata({
  params,
}: OrderDetailPageProps): Promise<Metadata> {
  const { code } = await params;
  return {
    title: `Đơn hàng #${code} · Tầm Xuân Fashion Atelier`,
    description:
      'Theo dõi hành trình đơn hàng thời trang, xem ảnh chụp hộp quà trước khi niêm phong, đổi size 1 chạm và gửi đánh giá độ vừa xác thực.',
  };
}

export default async function OrderDetailPage({ params }: OrderDetailPageProps) {
  const { code } = await params;
  return (
    <InnerPageFrame>
      <OrderDetailClient orderCode={decodeURIComponent(code)} />
    </InnerPageFrame>
  );
}
