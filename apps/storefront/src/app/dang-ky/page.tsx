'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import type { LoginResponse } from '@atelier/contracts';
import { InnerPageFrame } from '@/components/layout/InnerPageFrame';
import { SocialOAuthButtons } from '@/components/SocialOAuthButtons';
import {
  apiFetch,
  mergeGuestCartAfterAuth,
  setStoredSession,
} from '@/lib/api-client';

export default function CustomerRegisterPage() {
  const router = useRouter();
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    const oauthError = params.get('oauthError');
    const oauthErrorCode = params.get('oauthErrorCode');
    if (oauthError || oauthErrorCode) {
      setErrorMessage(
        oauthError?.trim() ||
          'Đăng nhập nhanh không thành công. Vui lòng thử lại hoặc đăng ký bằng Email & Mật khẩu.',
      );
      params.delete('oauthError');
      params.delete('oauthErrorCode');
      const nextSearch = params.toString();
      const nextUrl = `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ''}${window.location.hash}`;
      window.history.replaceState({}, '', nextUrl);
    }
  }, []);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setLoading(true);
    setErrorMessage(null);

    const res = await apiFetch<LoginResponse>('/bff/v1/auth/register', {
      method: 'POST',
      skipAuthRefresh: true,
      body: JSON.stringify({
        fullName: fullName.trim(),
        email: email.trim(),
        phone: phone.trim() || undefined,
        password,
      }),
    });

    if (res.ok && res.data?.accessToken) {
      setStoredSession({
        accessToken: res.data.accessToken,
        csrfToken: res.data.csrfToken,
        user: res.data.user,
      });
      await mergeGuestCartAfterAuth();
      router.push('/tai-khoan');
      return;
    }

    const errorCode = String(res.error?.code ?? '');
    if (errorCode === 'EMAIL_BOUND_TO_OAUTH' || res.status === 409) {
      setErrorMessage(
        res.error?.message ||
          'Email này đã được tạo qua đăng nhập nhanh bằng Google/GitHub nên không thể đăng ký tài khoản mới. Vui lòng tiếp tục đăng nhập bằng Google/GitHub.',
      );
    } else {
      setErrorMessage(
        res.error?.message ||
          'Đăng ký không thành công. Kiểm tra email và mật khẩu (tối thiểu 8 ký tự).',
      );
    }
    setLoading(false);
  };

  return (
    <InnerPageFrame>
      <div className="mx-auto max-w-md px-6 py-16">
        <div className="rounded-3xl border border-[#B08A4A]/30 bg-[#FBF7EF] p-8 shadow-sm">
          <p className="atelier-eyebrow text-[#8A672C]">Thành viên Atelier</p>
          <h1 className="font-editorial mt-2 text-4xl font-light text-[#1C1410]">
            Tạo tài khoản mới
          </h1>
          <p className="mt-2 text-xs text-[#7A6A5B]">
            Lưu hồ sơ số đo chuẩn xác, đồng bộ giỏ đồ phối sẵn và nhận hạn mức
            phòng thử đồ AI miễn phí mỗi ngày.
          </p>

          <form onSubmit={handleSubmit} className="mt-6 space-y-4">
            <label className="block text-xs">
              <span className="uppercase tracking-[0.16em] text-[#8A672C]">
                Họ và tên
              </span>
              <input
                type="text"
                required
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                placeholder="Nguyễn Minh Anh"
                className="mt-1.5 w-full rounded-2xl border border-[#B08A4A]/35 bg-white px-4 py-2.5 text-sm outline-none focus:border-[#8A672C]"
              />
            </label>

            <label className="block text-xs">
              <span className="uppercase tracking-[0.16em] text-[#8A672C]">
                Email
              </span>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="ban@example.com"
                className="mt-1.5 w-full rounded-2xl border border-[#B08A4A]/35 bg-white px-4 py-2.5 text-sm outline-none focus:border-[#8A672C]"
              />
            </label>

            <label className="block text-xs">
              <span className="uppercase tracking-[0.16em] text-[#8A672C]">
                Số điện thoại (tùy chọn)
              </span>
              <input
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="0901234567"
                className="mt-1.5 w-full rounded-2xl border border-[#B08A4A]/35 bg-white px-4 py-2.5 text-sm outline-none focus:border-[#8A672C]"
              />
            </label>

            <label className="block text-xs">
              <span className="uppercase tracking-[0.16em] text-[#8A672C]">
                Mật khẩu (tối thiểu 8 ký tự)
              </span>
              <input
                type="password"
                required
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="mt-1.5 w-full rounded-2xl border border-[#B08A4A]/35 bg-white px-4 py-2.5 text-sm outline-none focus:border-[#8A672C]"
              />
            </label>

            {errorMessage ? (
              <p
                role="alert"
                data-testid="register-error-alert"
                className="rounded-2xl border border-[#8B2E2E]/35 bg-[#FFF5F4] px-3.5 py-2.5 text-xs leading-relaxed text-[#8B2E2E]"
              >
                {errorMessage}
              </p>
            ) : null}

            <button
              type="submit"
              disabled={loading}
              className="w-full rounded-full bg-[#1C1410] py-3 text-xs font-medium uppercase tracking-[0.2em] text-[#EBCF8F] hover:opacity-90 disabled:opacity-50"
            >
              {loading ? 'Đang khởi tạo...' : 'Đăng ký thành viên'}
            </button>
          </form>

          <SocialOAuthButtons
            mode="register"
            returnTo="/tai-khoan"
            disabled={loading}
            onInlineError={setErrorMessage}
          />

          <div className="mt-6 border-t border-[#B08A4A]/20 pt-4 text-center text-xs text-[#7A6A5B]">
            Đã có tài khoản?{' '}
            <Link
              href="/dang-nhap"
              className="font-medium text-[#8A672C] underline underline-offset-4"
            >
              Đăng nhập ngay
            </Link>
          </div>
        </div>
      </div>
    </InnerPageFrame>
  );
}
