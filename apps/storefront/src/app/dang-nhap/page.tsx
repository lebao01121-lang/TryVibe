'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import type { LoginResponse } from '@atelier/contracts';
import { InnerPageFrame } from '@/components/layout/InnerPageFrame';
import {
  apiFetch,
  mergeGuestCartAfterAuth,
  setStoredSession,
} from '@/lib/api-client';

export default function CustomerLoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('customer@atelier.local');
  const [password, setPassword] = useState('Atelier@2026!');
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setLoading(true);
    setErrorMessage(null);

    const res = await apiFetch<LoginResponse>('/bff/v1/auth/login', {
      method: 'POST',
      skipAuthRefresh: true,
      body: JSON.stringify({ email: email.trim(), password }),
    });

    if (res.ok && res.data) {
      setStoredSession({
        accessToken: res.data.accessToken,
        csrfToken: res.data.csrfToken,
        user: res.data.user,
      });
      // Seamlessly merge anonymous guest outfits, items & gift notes into account
      await mergeGuestCartAfterAuth();
      router.push('/tai-khoan');
      return;
    }

    setErrorMessage(
      res.error?.message || 'Đăng nhập thất bại. Vui lòng kiểm tra thông tin.',
    );
    setLoading(false);
  };

  return (
    <InnerPageFrame>
      <div className="mx-auto max-w-md px-6 py-16">
        <div className="rounded-3xl border border-[#B08A4A]/30 bg-[#FBF7EF] p-8 shadow-sm">
          <p className="atelier-eyebrow text-[#8A672C]">Tài khoản thành viên</p>
          <h1 className="font-editorial mt-2 text-4xl font-light text-[#1C1410]">
            Đăng nhập Atelier
          </h1>
          <p className="mt-2 text-xs text-[#7A6A5B]">
            Đồng bộ hồ sơ số đo cá nhân, giỏ đồ phối sẵn, sổ địa chỉ và hạn mức
            phòng thử đồ AI hằng ngày.
          </p>

          <form onSubmit={handleSubmit} className="mt-6 space-y-4">
            <label className="block text-xs">
              <span className="uppercase tracking-[0.16em] text-[#8A672C]">
                Email
              </span>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="mt-1.5 w-full rounded-2xl border border-[#B08A4A]/35 bg-white px-4 py-2.5 text-sm text-[#1C1410] outline-none focus:border-[#8A672C]"
              />
            </label>

            <label className="block text-xs">
              <span className="uppercase tracking-[0.16em] text-[#8A672C]">
                Mật khẩu
              </span>
              <input
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="mt-1.5 w-full rounded-2xl border border-[#B08A4A]/35 bg-white px-4 py-2.5 text-sm text-[#1C1410] outline-none focus:border-[#8A672C]"
              />
            </label>

            {errorMessage ? (
              <p className="rounded-xl border border-[#8B2E2E]/35 bg-[#FFF5F4] px-3.5 py-2.5 text-xs text-[#8B2E2E]">
                {errorMessage}
              </p>
            ) : null}

            <button
              type="submit"
              disabled={loading}
              className="w-full rounded-full bg-[#1C1410] py-3 text-xs font-medium uppercase tracking-[0.2em] text-[#EBCF8F] hover:opacity-90 disabled:opacity-50"
            >
              {loading ? 'Đang xác thực...' : 'Đăng nhập'}
            </button>
          </form>

          <div className="mt-6 border-t border-[#B08A4A]/20 pt-4 text-center text-xs text-[#7A6A5B]">
            Chưa có tài khoản?{' '}
            <Link
              href="/dang-ky"
              className="font-medium text-[#8A672C] underline underline-offset-4"
            >
              Đăng ký thành viên mới
            </Link>
          </div>
        </div>
      </div>
    </InnerPageFrame>
  );
}
