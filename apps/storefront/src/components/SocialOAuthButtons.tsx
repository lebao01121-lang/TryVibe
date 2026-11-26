'use client';

import { useEffect, useState } from 'react';
import { apiFetch, getBffBaseUrl } from '@/lib/api-client';

export type SocialOAuthProvider = 'google' | 'github';

export interface OAuthProviderStatus {
  enabled: boolean;
  callbackUrl: string;
}

export interface OAuthProvidersStatusData {
  google: OAuthProviderStatus;
  github: OAuthProviderStatus;
  adminExceptionConfigured?: boolean;
}

export interface SocialOAuthButtonsProps {
  mode?: 'login' | 'register';
  returnTo?: string;
  disabled?: boolean;
  onInlineError?: (message: string | null) => void;
}

function sanitizeReturnTo(raw?: string): string {
  if (!raw) return '/tai-khoan';
  const trimmed = raw.trim();
  if (!trimmed.startsWith('/') || trimmed.startsWith('//')) {
    return '/tai-khoan';
  }
  return trimmed;
}

function resolveOAuthStartBaseUrl(): string {
  const configured = process.env.NEXT_PUBLIC_BFF_URL?.trim().replace(
    /\/+$/,
    '',
  );
  if (configured) {
    if (typeof window !== 'undefined') {
      const host = window.location.hostname;
      if (host === 'localhost' || host === '127.0.0.1') {
        try {
          const parsed = new URL(configured);
          if (
            parsed.hostname === 'localhost' ||
            parsed.hostname === '127.0.0.1'
          ) {
            // Keep configured localhost so redirect URI aligns with Google/GitHub Console
            return configured;
          }
        } catch {
          // Fallback to configured string
        }
      }
    }
    return configured;
  }

  const fromClient = getBffBaseUrl().trim().replace(/\/+$/, '');
  if (fromClient) {
    return fromClient;
  }

  if (typeof window !== 'undefined') {
    const host = window.location.hostname;
    if (host === 'localhost' || host === '127.0.0.1') {
      return `http://${host}:4000`;
    }
  }

  return '';
}

function GoogleMarkIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width={18}
      height={18}
      aria-hidden="true"
      className="shrink-0"
    >
      <path
        fill="#4285F4"
        d="M23.49 12.27c0-.79-.07-1.54-.19-2.27H12v4.51h6.47c-.29 1.48-1.14 2.73-2.4 3.58v3h3.86c2.26-2.09 3.56-5.17 3.56-8.82z"
      />
      <path
        fill="#34A853"
        d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.86-3c-1.08.72-2.45 1.16-4.07 1.16-3.13 0-5.78-2.11-6.73-4.96H1.29v3.09C3.26 21.3 7.31 24 12 24z"
      />
      <path
        fill="#FBBC05"
        d="M5.27 14.29c-.25-.72-.38-1.49-.38-2.29s.14-1.57.38-2.29V6.62H1.29C.47 8.24 0 10.06 0 12s.47 3.76 1.29 5.38l3.98-3.09z"
      />
      <path
        fill="#EA4335"
        d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.31 0 3.26 2.7 1.29 6.62l3.98 3.09c.95-2.85 3.6-4.96 6.73-4.96z"
      />
    </svg>
  );
}

function GitHubMarkIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width={18}
      height={18}
      fill="currentColor"
      aria-hidden="true"
      className="shrink-0"
    >
      <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
    </svg>
  );
}

export function SocialOAuthButtons({
  mode = 'login',
  returnTo = '/tai-khoan',
  disabled = false,
  onInlineError,
}: SocialOAuthButtonsProps) {
  const [providers, setProviders] = useState<OAuthProvidersStatusData | null>(
    null,
  );
  const [providersLoaded, setProvidersLoaded] = useState(false);
  const [redirectingProvider, setRedirectingProvider] =
    useState<SocialOAuthProvider | null>(null);
  const [configHint, setConfigHint] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void apiFetch<OAuthProvidersStatusData>('/bff/v1/auth/oauth/providers', {
      method: 'GET',
      skipAuthRefresh: true,
    }).then((res) => {
      if (cancelled) return;
      if (res.ok && res.data) {
        setProviders(res.data);
      }
      setProvidersLoaded(true);
    });

    return () => {
      cancelled = true;
    };
  }, []);

  const googleEnabled = providers ? Boolean(providers.google?.enabled) : true;
  const githubEnabled = providers ? Boolean(providers.github?.enabled) : false;

  const handleStartOAuth = (provider: SocialOAuthProvider) => {
    if (disabled || redirectingProvider !== null) return;

    const isEnabled = provider === 'google' ? googleEnabled : githubEnabled;

    if (providersLoaded && !isEnabled) {
      const hintMessage =
        provider === 'github'
          ? 'Đăng nhập nhanh bằng GitHub chưa được cấu hình trên máy chủ. Quản trị viên vui lòng bổ sung GITHUB_OAUTH_CLIENT_ID và GITHUB_OAUTH_CLIENT_SECRET vào tệp .env rồi khởi động lại dịch vụ Auth/BFF.'
          : 'Đăng nhập nhanh bằng Google chưa được cấu hình trên máy chủ. Quản trị viên vui lòng bổ sung GOOGLE_OAUTH_CLIENT_ID và GOOGLE_OAUTH_CLIENT_SECRET vào tệp .env rồi khởi động lại dịch vụ Auth/BFF.';
      setConfigHint(hintMessage);
      onInlineError?.(null);
      return;
    }

    setConfigHint(null);
    onInlineError?.(null);
    setRedirectingProvider(provider);

    const safeReturnTo = sanitizeReturnTo(returnTo);
    const startBase = resolveOAuthStartBaseUrl();
    const query = new URLSearchParams({
      portal: 'storefront',
      returnTo: safeReturnTo,
    });
    window.location.href = `${startBase}/bff/v1/auth/oauth/${provider}/start?${query.toString()}`;
  };

  const isBusy = disabled || redirectingProvider !== null;

  return (
    <div className="mt-6">
      {/* Editorial Quiet Luxury Divider */}
      <div className="relative flex items-center">
        <div className="flex-1 border-t border-[#B08A4A]/25" />
        <span className="px-3.5 text-[11px] font-medium uppercase tracking-[0.18em] text-[#8A672C]/90">
          hoặc đăng nhập nhanh
        </span>
        <div className="flex-1 border-t border-[#B08A4A]/25" />
      </div>

      {/* Social OAuth Buttons */}
      <div className="mt-4 space-y-2.5">
        <button
          type="button"
          data-testid="oauth-google-btn"
          disabled={isBusy}
          onClick={() => handleStartOAuth('google')}
          className="group flex w-full items-center justify-center gap-3 rounded-2xl border border-[#B08A4A]/35 bg-white px-4 py-3 text-[13px] font-medium text-[#1C1410] shadow-[0_6px_18px_-14px_rgba(28,20,16,0.35)] transition-all duration-200 hover:-translate-y-[0.5px] hover:border-[#8A672C]/65 hover:bg-[#F4EBDA] hover:shadow-[0_12px_26px_-16px_rgba(28,20,16,0.45)] disabled:cursor-not-allowed disabled:opacity-55"
        >
          <GoogleMarkIcon />
          <span>
            {redirectingProvider === 'google'
              ? 'Đang chuyển tới Google...'
              : 'Đăng nhập nhanh bằng Google'}
          </span>
        </button>

        <button
          type="button"
          data-testid="oauth-github-btn"
          disabled={isBusy}
          onClick={() => handleStartOAuth('github')}
          className={`group flex w-full items-center justify-center gap-3 rounded-2xl border px-4 py-3 text-[13px] font-medium transition-all duration-200 disabled:cursor-not-allowed disabled:opacity-55 ${
            providersLoaded && !githubEnabled
              ? 'border-[#B08A4A]/28 bg-[#FAF5EB] text-[#4E3F35] hover:border-[#B08A4A]/55 hover:bg-[#F4EBDA]'
              : 'border-[#1C1410]/20 bg-[#231A15] text-[#FBF7EF] shadow-[0_6px_18px_-14px_rgba(28,20,16,0.45)] hover:-translate-y-[0.5px] hover:border-[#B08A4A]/55 hover:bg-[#1C1410]'
          }`}
        >
          <GitHubMarkIcon />
          <span className="flex flex-col items-start text-left sm:flex-row sm:items-center sm:gap-2">
            <span>
              {redirectingProvider === 'github'
                ? 'Đang chuyển tới GitHub...'
                : 'Đăng nhập nhanh bằng GitHub'}
            </span>
            {providersLoaded && !githubEnabled ? (
              <span className="rounded-full border border-[#B08A4A]/35 bg-white/80 px-2 py-0.5 text-[10px] font-normal text-[#8A672C]">
                Chưa cấu hình khóa GitHub
              </span>
            ) : null}
          </span>
        </button>
      </div>

      {/* Inline Configuration Hint for Unconfigured OAuth Provider */}
      {configHint ? (
        <p
          role="status"
          data-testid="oauth-config-hint"
          className="mt-3 rounded-2xl border border-[#B08A4A]/40 bg-[#FFF9EC] px-3.5 py-2.5 text-[11.5px] leading-relaxed text-[#6B4E1F]"
        >
          {configHint}
        </p>
      ) : null}

      {/* Policy Separation Notice */}
      <p
        data-testid="oauth-policy-notice"
        className="mt-3.5 rounded-2xl border border-[#B08A4A]/20 bg-[#F4EBDA]/45 px-3.5 py-2.5 text-[11px] leading-relaxed text-[#6E5D4F]"
      >
        {mode === 'register'
          ? 'Đăng nhập nhanh bằng Google/GitHub sẽ tự tạo tài khoản đăng nhập nhanh tách biệt — email này sẽ không thể đăng ký thêm tài khoản mật khẩu riêng trên website (ngoại lệ đặc quyền Quản trị).'
          : 'Tài khoản đăng nhập nhanh Google/GitHub tách biệt với tài khoản đăng ký bằng mật khẩu (ngoại lệ đặc quyền Quản trị).'}
      </p>
    </div>
  );
}
