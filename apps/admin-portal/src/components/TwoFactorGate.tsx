'use client';

import { useState, type FormEvent, type ReactNode } from 'react';
import {
  TwoFactorMethod,
  type LoginResponse,
  type Role,
  type TotpSetupResponse,
} from '@atelier/contracts';
import { adminFetch } from '@/lib/api-client';

export interface TwoFactorGateProps {
  roles: readonly Role[];
  email: string;
  mfaRequired: boolean;
  mfaVerified: boolean;
  onMfaSuccess: (payload: LoginResponse) => void;
  children: ReactNode;
}

export function TwoFactorGate({
  roles,
  email,
  mfaRequired,
  mfaVerified,
  onMfaSuccess,
  children,
}: TwoFactorGateProps) {
  const [method, setMethod] = useState<TwoFactorMethod>(
    TwoFactorMethod.EMAIL_OTP,
  );
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [infoMessage, setInfoMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [totpSetup, setTotpSetup] = useState<TotpSetupResponse | null>(null);

  if (!mfaRequired || mfaVerified) {
    return <>{children}</>;
  }

  const handleSetupTotp = async () => {
    setLoading(true);
    setErrorMessage(null);
    setInfoMessage(null);
    const res = await adminFetch<TotpSetupResponse>(
      '/api/v1/auth/2fa/totp/setup',
      { method: 'POST' },
    );
    if (res.ok && res.data) {
      setTotpSetup(res.data);
      setInfoMessage(
        'Quét mã QR bằng Google Authenticator / Authy rồi nhập mã 6 chữ số.',
      );
    } else {
      setErrorMessage(res.error?.message || 'Không thể khởi tạo TOTP.');
    }
    setLoading(false);
  };

  const handleSendEmailOtp = async () => {
    setLoading(true);
    setErrorMessage(null);
    setInfoMessage(null);
    const res = await adminFetch<{ sent?: boolean; message?: string }>(
      '/api/v1/auth/2fa/email-otp/send',
      {
        method: 'POST',
        body: JSON.stringify({ purpose: 'MFA_LOGIN' }),
      },
    );
    if (res.ok) {
      setInfoMessage(
        `Đã gửi mã OTP 6 chữ số tới ${email} (kiểm tra hộp thư Mailpit :8025).`,
      );
    } else {
      setErrorMessage(res.error?.message || 'Gửi Email OTP thất bại.');
    }
    setLoading(false);
  };

  const handleVerifySubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const cleaned = code.trim();
    if (!cleaned || cleaned.length < 6) {
      setErrorMessage('Vui lòng nhập mã xác thực 6 chữ số (hoặc mã khôi phục).');
      return;
    }

    setLoading(true);
    setErrorMessage(null);

    const endpoint =
      method === TwoFactorMethod.TOTP
        ? '/api/v1/auth/2fa/totp/verify'
        : '/api/v1/auth/2fa/email-otp/verify';

    const res = await adminFetch<LoginResponse>(endpoint, {
      method: 'POST',
      body: JSON.stringify({ method, code: cleaned }),
    });

    if (res.ok && res.data?.accessToken) {
      onMfaSuccess(res.data);
    } else {
      setErrorMessage(
        res.error?.message || 'Mã xác thực không hợp lệ hoặc đã hết hạn.',
      );
    }
    setLoading(false);
  };

  return (
    <section className="mx-auto my-8 max-w-2xl rounded-3xl border border-[#B08A4A]/40 bg-[#FBF7EF] p-8 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="ledger-eyebrow text-[#8A672C]">
          TwoFactorGate · Bắt buộc 2FA (MFA_REQUIRED)
        </span>
        <span className="rounded-full bg-[#1C1410] px-3 py-1 font-mono text-[11px] text-[#EBCF8F]">
          {roles.join(', ')}
        </span>
      </div>

      <h2 className="font-editorial mt-3 text-4xl font-light text-[#1C1410]">
        Xác thực 2 lớp trước khi mở Sổ cái điều hành
      </h2>
      <p className="mt-2 text-xs leading-relaxed text-[#7A6A5B]">
        Tài khoản <strong>{email}</strong> yêu cầu nâng cấp phiên JWT lên{' '}
        <code>mfaVerified: true</code> qua Email OTP (Mailpit) hoặc TOTP QR
        Authenticator.
      </p>

      {/* Method Switcher */}
      <div className="mt-5 grid grid-cols-2 gap-3">
        <button
          type="button"
          onClick={() => {
            setMethod(TwoFactorMethod.EMAIL_OTP);
            setErrorMessage(null);
          }}
          className={`rounded-2xl border p-3.5 text-left text-xs ${
            method === TwoFactorMethod.EMAIL_OTP
              ? 'border-[#1C1410] bg-[#1C1410] text-[#EBCF8F]'
              : 'border-[#B08A4A]/35 bg-white text-[#2B2019]'
          }`}
        >
          <p className="font-semibold uppercase tracking-[0.14em]">
            Email OTP (Mailpit)
          </p>
          <p className="mt-0.5 text-[11px] opacity-80">
            Gửi mã 6 số qua SMTP :1025
          </p>
        </button>

        <button
          type="button"
          onClick={() => {
            setMethod(TwoFactorMethod.TOTP);
            setErrorMessage(null);
          }}
          className={`rounded-2xl border p-3.5 text-left text-xs ${
            method === TwoFactorMethod.TOTP
              ? 'border-[#1C1410] bg-[#1C1410] text-[#EBCF8F]'
              : 'border-[#B08A4A]/35 bg-white text-[#2B2019]'
          }`}
        >
          <p className="font-semibold uppercase tracking-[0.14em]">
            TOTP Authenticator (QR)
          </p>
          <p className="mt-0.5 text-[11px] opacity-80">
            RFC 6238 HMAC-SHA1 · 30s
          </p>
        </button>
      </div>

      <div className="mt-5 flex flex-wrap gap-3">
        {method === TwoFactorMethod.EMAIL_OTP ? (
          <button
            type="button"
            disabled={loading}
            onClick={handleSendEmailOtp}
            className="rounded-full border border-[#8A672C] bg-[#F4EBDA] px-5 py-2 text-xs font-medium uppercase tracking-[0.16em] text-[#1C1410]"
          >
            {loading ? 'Đang gửi...' : 'Gửi mã Email OTP'}
          </button>
        ) : (
          <button
            type="button"
            disabled={loading}
            onClick={handleSetupTotp}
            className="rounded-full border border-[#8A672C] bg-[#F4EBDA] px-5 py-2 text-xs font-medium uppercase tracking-[0.16em] text-[#1C1410]"
          >
            {loading ? 'Đang khởi tạo...' : 'Khởi tạo QR TOTP mới'}
          </button>
        )}
      </div>

      {totpSetup && method === TwoFactorMethod.TOTP ? (
        <div className="mt-5 grid gap-4 rounded-2xl border border-[#B08A4A]/30 bg-white p-4 sm:grid-cols-[160px_1fr]">
          <img
            src={totpSetup.qrSvgDataUrl}
            alt="Mã QR TOTP Authenticator"
            className="h-40 w-40 rounded-xl border border-[#B08A4A]/25 bg-white p-2"
          />
          <div className="space-y-2 text-xs">
            <p className="font-semibold uppercase tracking-[0.14em] text-[#8A672C]">
              Secret Base32
            </p>
            <p className="break-all rounded-lg bg-[#F4EBDA] px-2.5 py-1.5 font-mono text-[11px]">
              {totpSetup.secret}
            </p>
            <p className="font-semibold uppercase tracking-[0.14em] text-[#8A672C]">
              Mã khôi phục ({totpSetup.recoveryCodes.length})
            </p>
            <div className="flex flex-wrap gap-1.5 font-mono text-[10px]">
              {totpSetup.recoveryCodes.slice(0, 4).map((rc) => (
                <span key={rc} className="rounded bg-[#FBF7EF] px-2 py-0.5 border border-[#B08A4A]/25">
                  {rc}
                </span>
              ))}
            </div>
          </div>
        </div>
      ) : null}

      {infoMessage ? (
        <p className="mt-4 rounded-xl border border-[#B08A4A]/35 bg-[#F4EBDA] px-4 py-2.5 text-xs text-[#1C1410]">
          {infoMessage}
        </p>
      ) : null}

      {errorMessage ? (
        <p className="mt-4 rounded-xl border border-[#8B2E2E]/35 bg-[#FFF5F4] px-4 py-2.5 text-xs text-[#8B2E2E]">
          {errorMessage}
        </p>
      ) : null}

      <form onSubmit={handleVerifySubmit} className="mt-5 space-y-4">
        <label className="block text-xs">
          <span className="font-medium uppercase tracking-[0.16em] text-[#8A672C]">
            Nhập mã xác thực 6 chữ số ({method})
          </span>
          <input
            type="text"
            inputMode="numeric"
            value={code}
            onChange={(e) => setCode(e.target.value.slice(0, 16))}
            placeholder="000000"
            className="mt-1.5 w-full rounded-2xl border border-[#B08A4A]/40 bg-white px-4 py-3 font-mono text-lg tracking-[0.35em] text-[#1C1410] outline-none focus:border-[#8A672C]"
          />
        </label>

        <button
          type="submit"
          disabled={loading}
          className="w-full rounded-full bg-[#1C1410] py-3 text-xs font-medium uppercase tracking-[0.2em] text-[#EBCF8F] hover:opacity-90 disabled:opacity-50"
        >
          {loading ? 'Đang xác minh...' : 'Xác nhận 2FA & Mở khóa Sổ cái'}
        </button>
      </form>
    </section>
  );
}
