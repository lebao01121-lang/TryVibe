import type { Metadata } from 'next';
import { Suspense } from 'react';
import { InnerPageFrame } from '@/components/layout/InnerPageFrame';
import { PaymentResultClient } from '@/features/checkout/PaymentResultClient';

export const metadata: Metadata = {
  title: 'Kết quả thanh toán · Tầm Xuân Fashion Atelier',
  description:
    'Xác thực chữ ký số và theo dõi kết quả thanh toán đơn hàng Tầm Xuân Fashion Atelier qua VietQR PayOS, VNPay và MoMo.',
};

export default function PaymentResultPage() {
  return (
    <InnerPageFrame>
      <Suspense
        fallback={
          <div className="mx-auto max-w-3xl px-4 py-16 text-center text-sm text-[#7A6A5B]">
            Đang tải thông tin đối soát thanh toán từ Tầm Xuân Atelier…
          </div>
        }
      >
        <PaymentResultClient />
      </Suspense>
    </InnerPageFrame>
  );
}
