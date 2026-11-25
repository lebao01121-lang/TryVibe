import type { Metadata } from 'next';
import { InnerPageFrame } from '@/components/layout/InnerPageFrame';
import { CheckoutPageClient } from '@/features/checkout/CheckoutPageClient';

export const metadata: Metadata = {
  title: 'Thanh toán an toàn · TryVibe Fashion Atelier',
  description:
    'Hoàn tất đơn hàng thời trang TryVibe với giao hỏa tốc 2 giờ, ưu đãi Combo Set, thiệp viết tay và thanh toán VietQR tự động.',
};

export default function CheckoutPage() {
  return (
    <InnerPageFrame>
      <CheckoutPageClient />
    </InnerPageFrame>
  );
}
