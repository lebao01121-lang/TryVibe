import type { Metadata } from 'next';
import { ForgotPasswordClient } from '@/components/ForgotPasswordClient';
import { InnerPageFrame } from '@/components/layout/InnerPageFrame';

export const metadata: Metadata = {
  title: 'Khôi phục mật khẩu · TryVibe Atelier',
  description:
    'Xác thực mã OTP 6 chữ số qua email để đặt lại mật khẩu tài khoản thành viên TryVibe Fashion Atelier.',
};

export default function ForgotPasswordPage() {
  return (
    <InnerPageFrame>
      <ForgotPasswordClient />
    </InnerPageFrame>
  );
}
