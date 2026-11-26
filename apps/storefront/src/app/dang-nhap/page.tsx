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
  type ApiFetchResult,
} from '@/lib/api-client';

const inFlightTicketExchanges = new Map<
  string,
  Promise<ApiFetchResult<LoginResponse>>
>();

function sanitizeReturnTo(raw: string | null): string {
  if (!raw) return '/tai-khoan';
  const trimmed = raw.trim();
  if (!trimmed.startsWith('/') || trimmed.startsWith('//')) {
    return '/tai-khoan';
  }
  return trimmed;
}

function resolveOAuthErrorMessage(
  oauthError: string | null,
  oauthErrorCode: string | null,
): string {
  if (oauthError && oauthError.trim().length > 0) {
    return oauthError.trim();
  }
  switch (oauthErrorCode) {
    case 'OAUTH_LOCAL_ACCOUNT_CONFLICT':
      return 'Email này đã được đăng ký tài khoản trên website. Không thể đăng nhập nhanh bằng Google/GitHub — vui lòng đăng nhập bằng Email & Mật khẩu.';
    case 'OAUTH_PROVIDER_MISMATCH':
      return 'Email này đã được liên kết với phương thức đăng nhập nhanh khác. Vui lòng chọn đúng nhà cung cấp đã tạo tài khoản.';
    case 'OAUTH_NOT_CONFIGURED':
      return 'Phương thức đăng nhập nhanh này chưa được cấu hình khóa OAuth2 trên máy chủ.';
    case 'OAUTH_CANCELLED':
      return 'Bạn đã hủy quá trình đăng nhập nhanh. Vui lòng thử lại nếu muốn tiếp tục.';
    case 'OAUTH_STATE_INVALID':
      return 'Phiên xác thực OAuth2 không hợp lệ hoặc đã hết hạn. Vui lòng bấm đăng nhập lại.';
    case 'OAUTH_EMAIL_UNVERIFIED':
      return 'Tài khoản Google/GitHub chưa xác minh email nên không thể đăng nhập nhanh.';
    case 'OAUTH_PROVIDER_ERROR':
      return 'Không thể kết nối tới nhà cung cấp OAuth2. Vui lòng thử lại sau giây lát.';
    case 'OAUTH_TICKET_INVALID':
      return 'Mã xác thực đăng nhập nhanh đã hết hạn hoặc đã được sử dụng. Vui lòng đăng nhập lại.';
    case 'ADMIN_OAUTH_FORBIDDEN':
      return 'Tài khoản này không có quyền quản trị trên TryVibe Admin Portal.';
    default:
      return 'Đăng nhập nhanh không thành công. Vui lòng thử lại hoặc sử dụng Email & Mật khẩu.';
  }
}

function cleanOAuthQueryParams(): void {
  if (typeof window === 'undefined') return;
  const current = new URL(window.location.href);
  let changed = false;
  for (const key of [
    'oauthTicket',
    'oauthError',
    'oauthErrorCode',
    'returnTo',
  ]) {
    if (current.searchParams.has(key)) {
      current.searchParams.delete(key);
      changed = true;
    }
  }
  if (changed) {
    const nextSearch = current.searchParams.toString();
    const nextUrl = `${current.pathname}${nextSearch ? `?${nextSearch}` : ''}${current.hash}`;
    window.history.replaceState({}, '', nextUrl);
  }
}

export default function CustomerLoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('customer@atelier.local');
  const [password, setPassword] = useState('Atelier@2026!');
  const [loading, setLoading] = useState(false);
  const [oauthExchanging, setOauthExchanging] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;

    const params = new URLSearchParams(window.location.search);
    const oauthTicket = params.get('oauthTicket')?.trim() || '';
    const oauthError = params.get('oauthError');
    const oauthErrorCode = params.get('oauthErrorCode');
    const returnTo = sanitizeReturnTo(params.get('returnTo'));

    if (oauthError || oauthErrorCode) {
      setErrorMessage(resolveOAuthErrorMessage(oauthError, oauthErrorCode));
      cleanOAuthQueryParams();
      return undefined;
    }

    if (!oauthTicket) {
      return undefined;
    }

    let active = true;
    setOauthExchanging(true);
    setErrorMessage(null);

    let exchangePromise = inFlightTicketExchanges.get(oauthTicket);
    if (!exchangePromise) {
      exchangePromise = apiFetch<LoginResponse>('/bff/v1/auth/oauth/exchange', {
        method: 'POST',
        skipAuthRefresh: true,
        body: JSON.stringify({ ticket: oauthTicket }),
      });
      inFlightTicketExchanges.set(oauthTicket, exchangePromise);
    }

    void exchangePromise.then(async (res) => {
      if (!active) return;
      inFlightTicketExchanges.delete(oauthTicket);
      cleanOAuthQueryParams();

      if (res.ok && res.data?.accessToken) {
        setStoredSession({
          accessToken: res.data.accessToken,
          csrfToken: res.data.csrfToken,
          user: res.data.user,
        });
        await mergeGuestCartAfterAuth();
        router.push(returnTo);
        return;
      }

      setErrorMessage(
        res.error?.message ||
          'Không thể hoàn tất đăng nhập nhanh. Mã xác thực đã hết hạn hoặc không hợp lệ.',
      );
      setOauthExchanging(false);
    });

    return () => {
      active = false;
    };
  }, [router]);

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

          {oauthExchanging ? (
            <div
              role="status"
              data-testid="oauth-exchanging-banner"
              className="mt-5 flex items-center gap-3 rounded-2xl border border-[#B08A4A]/40 bg-[#F4EBDA]/80 px-4 py-3 text-xs text-[#5C4630]"
            >
              <span className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-[#B08A4A] border-t-transparent" />
              <span>Đang hoàn tất xác thực nhanh...</span>
            </div>
          ) : null}

          <form onSubmit={handleSubmit} className="mt-6 space-y-4">
            <label className="block text-xs">
              <span className="uppercase tracking-[0.16em] text-[#8A672C]">
                Email
              </span>
              <input
                type="email"
                required
                disabled={loading || oauthExchanging}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="mt-1.5 w-full rounded-2xl border border-[#B08A4A]/35 bg-white px-4 py-2.5 text-sm text-[#1C1410] outline-none focus:border-[#8A672C] disabled:opacity-60"
              />
            </label>

            <label className="block text-xs">
              <span className="uppercase tracking-[0.16em] text-[#8A672C]">
                Mật khẩu
              </span>
              <input
                type="password"
                required
                disabled={loading || oauthExchanging}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="mt-1.5 w-full rounded-2xl border border-[#B08A4A]/35 bg-white px-4 py-2.5 text-sm text-[#1C1410] outline-none focus:border-[#8A672C] disabled:opacity-60"
              />
            </label>

            {errorMessage ? (
              <p
                role="alert"
                data-testid="auth-error-alert"
                className="rounded-2xl border border-[#8B2E2E]/35 bg-[#FFF5F4] px-3.5 py-2.5 text-xs leading-relaxed text-[#8B2E2E]"
              >
                {errorMessage}
              </p>
            ) : null}

            <button
              type="submit"
              disabled={loading || oauthExchanging}
              className="w-full rounded-full bg-[#1C1410] py-3 text-xs font-medium uppercase tracking-[0.2em] text-[#EBCF8F] hover:opacity-90 disabled:opacity-50"
            >
              {loading
                ? 'Đang xác thực...'
                : oauthExchanging
                  ? 'Đang hoàn tất xác thực nhanh...'
                  : 'Đăng nhập'}
            </button>
          </form>

          <SocialOAuthButtons
            mode="login"
            returnTo="/tai-khoan"
            disabled={loading || oauthExchanging}
            onInlineError={setErrorMessage}
          />

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
