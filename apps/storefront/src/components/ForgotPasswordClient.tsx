'use client';

import Link from 'next/link';
import { useEffect, useState, type FormEvent } from 'react';
import { apiFetch, clearStoredSession } from '@/lib/api-client';

type RecoveryStep = 'request' | 'reset' | 'done';

interface ForgotPasswordResponse {
  message?: string;
  sent?: boolean;
}

interface ResetPasswordResponse {
  message?: string;
  reset?: boolean;
}

export function ForgotPasswordClient() {
  const [step, setStep] = useState<RecoveryStep>('request');
  const [email, setEmail] = useState('');
  const [otpCode, setOtpCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [infoMessage, setInfoMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    const paramEmail = params.get('email')?.trim();
    const paramCode = (params.get('code') || params.get('token'))?.trim();
    if (paramEmail) {
      setEmail(paramEmail);
    }
    if (paramCode) {
      setOtpCode(paramCode);
      setStep('reset');
    }
  }, []);

  const handleRequestOtp = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalizedEmail = email.trim().toLowerCase();
    if (!normalizedEmail) {
      setErrorMessage('Vui lòng nhập địa chỉ email đã đăng ký tài khoản.');
      return;
    }

    setSubmitting(true);
    setErrorMessage(null);
    setInfoMessage(null);

    const res = await apiFetch<ForgotPasswordResponse>('/bff/v1/auth/forgot-password', {
      method: 'POST',
      skipAuthRefresh: true,
      body: JSON.stringify({ email: normalizedEmail }),
    });

    setSubmitting(false);

    if (!res.ok) {
      setErrorMessage(
        res.error?.message ||
          'Không thể gửi mã khôi phục lúc này. Vui lòng thử lại sau ít phút.',
      );
      return;
    }

    setEmail(normalizedEmail);
    setInfoMessage(
      'Mã khôi phục 6 chữ số có hiệu lực trong 10 phút đã được gửi tới email của bạn.',
    );
    setStep('reset');
  };

  const handleResetPassword = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setErrorMessage(null);

    const normalizedEmail = email.trim().toLowerCase();
    const cleanCode = otpCode.trim();

    if (!normalizedEmail) {
      setErrorMessage('Vui lòng nhập địa chỉ email tài khoản.');
      return;
    }
    if (cleanCode.length < 6) {
      setErrorMessage('Vui lòng nhập đầy đủ mã khôi phục 6 chữ số được gửi qua email.');
      return;
    }
    if (newPassword.length < 8) {
      setErrorMessage('Mật khẩu mới cần có tối thiểu 8 ký tự.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setErrorMessage('Mật khẩu xác nhận không khớp với mật khẩu mới.');
      return;
    }

    setSubmitting(true);
    const res = await apiFetch<ResetPasswordResponse>('/bff/v1/auth/reset-password', {
      method: 'POST',
      skipAuthRefresh: true,
      body: JSON.stringify({
        email: normalizedEmail,
        code: cleanCode,
        newPassword,
      }),
    });
    setSubmitting(false);

    if (!res.ok) {
      setErrorMessage(
        res.error?.message ||
          'Mã khôi phục không chính xác hoặc đã hết hạn. Vui lòng kiểm tra lại.',
      );
      return;
    }

    clearStoredSession();
    setNewPassword('');
    setConfirmPassword('');
    setOtpCode('');
    setInfoMessage(
      res.data?.message ||
        'Đặt lại mật khẩu thành công. Các phiên đăng nhập cũ đã được thu hồi để bảo vệ tài khoản.',
    );
    setStep('done');
  };

  return (
    <div className="mx-auto max-w-md px-6 py-16">
      <div className="rounded-3xl border border-[#B08A4A]/30 bg-[#FBF7EF] p-8 shadow-sm">
        <p className="atelier-eyebrow text-[#8A672C]">Bảo mật tài khoản</p>
        <h1 className="font-editorial mt-2 text-4xl font-light text-[#1C1410]">
          Khôi phục mật khẩu
        </h1>
        <p className="mt-2 text-xs leading-relaxed text-[#7A6A5B]">
          {step === 'request'
            ? 'Nhập email thành viên để nhận mã xác thực 6 chữ số có hiệu lực trong 10 phút.'
            : step === 'reset'
              ? 'Nhập mã khôi phục 6 chữ số từ hộp thư của bạn và thiết lập mật khẩu mới.'
              : 'Mật khẩu của bạn đã được cập nhật an toàn bằng chuẩn mã hóa Argon2id.'}
        </p>

        {/* Stepper */}
        <div className="mt-5 grid grid-cols-2 gap-2 text-[11px]">
          <div
            className={`rounded-xl border px-3 py-2 ${
              step === 'request'
                ? 'border-[#1C1410] bg-[#1C1410] text-[#EBCF8F]'
                : 'border-[#B08A4A]/35 bg-[#F4EBDA]/70 text-[#5C431C]'
            }`}
          >
            <span className="font-mono text-[10px] uppercase tracking-[0.18em]">
              Bước 1
            </span>
            <p className="mt-0.5 font-medium">Nhận mã OTP</p>
          </div>
          <div
            className={`rounded-xl border px-3 py-2 ${
              step === 'reset' || step === 'done'
                ? 'border-[#1C1410] bg-[#1C1410] text-[#EBCF8F]'
                : 'border-[#B08A4A]/25 bg-white text-[#7A6A5B]'
            }`}
          >
            <span className="font-mono text-[10px] uppercase tracking-[0.18em]">
              Bước 2
            </span>
            <p className="mt-0.5 font-medium">Đặt mật khẩu mới</p>
          </div>
        </div>

        {infoMessage ? (
          <div
            role="status"
            data-testid="forgot-password-status"
            className="mt-5 rounded-2xl border border-emerald-300 bg-emerald-50 px-4 py-3 text-xs leading-relaxed text-emerald-950"
          >
            {infoMessage}
          </div>
        ) : null}

        {errorMessage ? (
          <div
            role="alert"
            className="mt-5 rounded-2xl border border-[#8B2E2E]/35 bg-[#FFF5F4] px-4 py-3 text-xs text-[#8B2E2E]"
          >
            {errorMessage}
          </div>
        ) : null}

        {step === 'request' ? (
          <form onSubmit={handleRequestOtp} className="mt-6 space-y-4">
            <label className="block text-xs">
              <span className="uppercase tracking-[0.16em] text-[#8A672C]">
                Email đăng ký
              </span>
              <input
                type="email"
                required
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="ban@example.com"
                data-testid="forgot-password-email-input"
                className="mt-1.5 w-full rounded-2xl border border-[#B08A4A]/35 bg-white px-4 py-2.5 text-sm text-[#1C1410] outline-none focus:border-[#8A672C]"
              />
            </label>

            <button
              type="submit"
              disabled={submitting}
              data-testid="forgot-password-request-btn"
              className="w-full rounded-full bg-[#1C1410] py-3 text-xs font-medium uppercase tracking-[0.2em] text-[#EBCF8F] transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {submitting ? 'Đang gửi mã khôi phục...' : 'Gửi mã khôi phục 6 chữ số'}
            </button>
          </form>
        ) : null}

        {step === 'reset' ? (
          <form onSubmit={handleResetPassword} className="mt-6 space-y-4">
            <label className="block text-xs">
              <span className="uppercase tracking-[0.16em] text-[#8A672C]">
                Email tài khoản
              </span>
              <input
                type="email"
                required
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="mt-1.5 w-full rounded-2xl border border-[#B08A4A]/35 bg-white px-4 py-2.5 text-sm text-[#1C1410] outline-none focus:border-[#8A672C]"
              />
            </label>

            <label className="block text-xs">
              <span className="uppercase tracking-[0.16em] text-[#8A672C]">
                Mã khôi phục 6 chữ số (OTP)
              </span>
              <input
                type="text"
                required
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={64}
                value={otpCode}
                onChange={(e) => setOtpCode(e.target.value)}
                placeholder="Nhập 6 chữ số từ email"
                data-testid="reset-password-otp-input"
                className="mt-1.5 w-full rounded-2xl border border-[#B08A4A]/35 bg-white px-4 py-2.5 font-mono text-sm tracking-[0.18em] text-[#1C1410] outline-none focus:border-[#8A672C]"
              />
            </label>

            <label className="block text-xs">
              <span className="uppercase tracking-[0.16em] text-[#8A672C]">
                Mật khẩu mới (tối thiểu 8 ký tự)
              </span>
              <input
                type="password"
                required
                minLength={8}
                autoComplete="new-password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="••••••••"
                data-testid="reset-password-new-input"
                className="mt-1.5 w-full rounded-2xl border border-[#B08A4A]/35 bg-white px-4 py-2.5 text-sm text-[#1C1410] outline-none focus:border-[#8A672C]"
              />
            </label>

            <label className="block text-xs">
              <span className="uppercase tracking-[0.16em] text-[#8A672C]">
                Xác nhận mật khẩu mới
              </span>
              <input
                type="password"
                required
                minLength={8}
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="••••••••"
                data-testid="reset-password-confirm-input"
                className="mt-1.5 w-full rounded-2xl border border-[#B08A4A]/35 bg-white px-4 py-2.5 text-sm text-[#1C1410] outline-none focus:border-[#8A672C]"
              />
            </label>

            <button
              type="submit"
              disabled={submitting}
              data-testid="reset-password-submit-btn"
              className="w-full rounded-full bg-[#1C1410] py-3 text-xs font-medium uppercase tracking-[0.2em] text-[#EBCF8F] transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {submitting ? 'Đang đặt lại mật khẩu...' : 'Xác nhận đặt lại mật khẩu'}
            </button>

            <div className="flex items-center justify-between pt-1 text-xs">
              <button
                type="button"
                onClick={() => {
                  setErrorMessage(null);
                  setStep('request');
                }}
                className="text-[#7A6A5B] underline underline-offset-4 hover:text-[#1C1410]"
              >
                ← Gửi lại mã khác
              </button>
              <Link
                href="/dang-nhap"
                className="text-[#8A672C] underline underline-offset-4"
              >
                Về trang đăng nhập
              </Link>
            </div>
          </form>
        ) : null}

        {step === 'done' ? (
          <div className="mt-6 space-y-3">
            <Link
              href="/tai-khoan"
              data-testid="reset-password-go-account-btn"
              className="block w-full rounded-full bg-[#1C1410] py-3 text-center text-xs font-medium uppercase tracking-[0.2em] text-[#EBCF8F] transition-opacity hover:opacity-90"
            >
              Đăng nhập tại Tài khoản
            </Link>
            <Link
              href="/dang-nhap"
              className="block w-full rounded-full border border-[#8A672C] py-2.5 text-center text-xs font-medium uppercase tracking-[0.18em] text-[#8A672C] transition-colors hover:bg-[#F4EBDA]"
            >
              Mở trang Đăng nhập ngay
            </Link>
          </div>
        ) : null}

        {step === 'request' ? (
          <div className="mt-6 border-t border-[#B08A4A]/20 pt-4 text-center text-xs text-[#7A6A5B]">
            Đã nhớ lại mật khẩu?{' '}
            <Link
              href="/dang-nhap"
              className="font-medium text-[#8A672C] underline underline-offset-4"
            >
              Đăng nhập ngay
            </Link>
          </div>
        ) : null}
      </div>
    </div>
  );
}
