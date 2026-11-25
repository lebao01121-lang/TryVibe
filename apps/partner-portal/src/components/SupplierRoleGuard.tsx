'use client';

import { useState, type FormEvent, type ReactNode } from 'react';
import {
  PARTNER_PORTAL_ROLES,
  Portal,
  Role,
  TwoFactorMethod,
  canAccessPortal,
  type LoginResponse,
  type TotpSetupResponse,
} from '@atelier/contracts';
import { partnerFetch } from '@/lib/api-client';

export interface SupplierRoleGuardProps {
  roles: readonly Role[];
  email: string;
  supplierId: string | null;
  mfaVerified: boolean;
  onSignOut: () => void;
  onMfaSuccess: (payload: LoginResponse) => void;
  children: ReactNode;
}

const STRICT_PARTNER_SET = new Set<Role>(PARTNER_PORTAL_ROLES);

export function isStrictSupplierRoles(roles: readonly Role[]): boolean {
  return (
    roles.length > 0 &&
    roles.includes(Role.SUPPLIER) &&
    roles.every((r) => STRICT_PARTNER_SET.has(r)) &&
    canAccessPortal(roles, Portal.PARTNER_PORTAL)
  );
}

export function SupplierRoleGuard({
  roles,
  email,
  supplierId,
  mfaVerified,
  onSignOut,
  onMfaSuccess,
  children,
}: SupplierRoleGuardProps) {
  const [method, setMethod] = useState<TwoFactorMethod>(
    TwoFactorMethod.EMAIL_OTP,
  );
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [infoMessage, setInfoMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [totpSetup, setTotpSetup] = useState<TotpSetupResponse | null>(null);

  if (!isStrictSupplierRoles(roles)) {
    return (
      <section
        role="alert"
        aria-live="assertive"
        className="mx-auto my-12 max-w-2xl rounded-3xl border border-[#8B2E2E]/40 bg-[#FFF8F6] p-8 shadow-sm"
      >
        <div className="flex items-center gap-3">
          <span className="rounded-full bg-[#8B2E2E] px-3 py-1 font-mono text-xs font-semibold text-[#FBF7EF]">
            HTTP 403
          </span>
          <span className="partner-eyebrow text-[#8B2E2E]">
            Truy cập bị chặn · SupplierRoleGuard
          </span>
        </div>

        <h2 className="font-editorial mt-4 text-4xl font-normal text-[#1C1410]">
          Vai trò{' '}
          <code className="font-mono text-2xl">{roles.join(', ') || 'NONE'}</code>{' '}
          không được phép vào Cổng Nhà Cung Cấp B2B
        </h2>

        <p className="mt-3 text-sm leading-relaxed text-[#5C4B41]">
          Cổng <code>PARTNER_PORTAL · :3002</code> chỉ cấp quyền duy nhất cho
          tài khoản đối tác mang vai trò <strong>SUPPLIER</strong> đã xác thực
          2FA. Cả <strong>CUSTOMER</strong> lẫn toàn bộ vai trò nội bộ (
          <code>SUPER_ADMIN</code>, <code>WAREHOUSE_MANAGER</code>,{' '}
          <code>CATALOG_AI_OPERATOR</code>, <code>ORDER_STAFF</code>) đều bị
          chặn cứng.
        </p>

        <div className="mt-6 border-t border-[#8B2E2E]/15 pt-5">
          <button
            type="button"
            onClick={onSignOut}
            className="rounded-full bg-[#1C1410] px-6 py-2.5 text-xs uppercase tracking-[0.18em] text-[#EBCF8F]"
          >
            Đăng xuất &amp; Đăng nhập tài khoản SUPPLIER
          </button>
        </div>
      </section>
    );
  }

  if (!mfaVerified) {
    const handleSendEmailOtp = async () => {
      setLoading(true);
      setErrorMessage(null);
      setInfoMessage(null);
      const res = await partnerFetch<unknown>('/api/v1/auth/2fa/email-otp/send', {
        method: 'POST',
        body: JSON.stringify({ purpose: 'MFA_LOGIN' }),
      });
      if (res.ok) {
        setInfoMessage(
          `Đã gửi mã OTP 6 chữ số tới ${email}. Kiểm tra hộp thư Gmail/SMTP thật (nếu đã cấu hình SMTP_USER/SMTP_PASS) hoặc Mailpit cục bộ (http://localhost:8025).`,
        );
      } else {
        setErrorMessage(res.error?.message || 'Gửi Email OTP thất bại.');
      }
      setLoading(false);
    };

    const handleSetupTotp = async () => {
      setLoading(true);
      setErrorMessage(null);
      setInfoMessage(null);
      const res = await partnerFetch<TotpSetupResponse>(
        '/api/v1/auth/2fa/totp/setup',
        { method: 'POST' },
      );
      if (res.ok && res.data) {
        setTotpSetup(res.data);
        setInfoMessage('Quét mã QR TOTP rồi nhập mã 6 chữ số để mở khóa.');
      } else {
        setErrorMessage(res.error?.message || 'Không thể khởi tạo TOTP.');
      }
      setLoading(false);
    };

    const handleVerifySubmit = async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (code.trim().length < 6) {
        setErrorMessage('Vui lòng nhập đủ mã OTP 6 chữ số.');
        return;
      }
      setLoading(true);
      setErrorMessage(null);

      const endpoint =
        method === TwoFactorMethod.TOTP
          ? '/api/v1/auth/2fa/totp/verify'
          : '/api/v1/auth/2fa/email-otp/verify';

      const res = await partnerFetch<LoginResponse>(endpoint, {
        method: 'POST',
        body: JSON.stringify({ method, code: code.trim() }),
      });

      if (res.ok && res.data?.accessToken) {
        onMfaSuccess(res.data);
      } else {
        setErrorMessage(
          res.error?.message || 'Mã xác thực 2FA không hợp lệ hoặc đã hết hạn.',
        );
      }
      setLoading(false);
    };

    return (
      <section className="mx-auto my-8 max-w-2xl rounded-3xl border border-[#B08A4A]/35 bg-white p-8 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="partner-eyebrow text-[#8A672C]">
            Supplier 2FA Gate · Bắt buộc MFA_REQUIRED
          </span>
          <span className="rounded-full bg-[#1C1410] px-3 py-1 font-mono text-[11px] text-[#EBCF8F]">
            SUPPLIER + 2FA
          </span>
        </div>

        <h2 className="font-editorial mt-3 text-4xl font-light text-[#1C1410]">
          Xác thực 2 lớp cho đối tác{' '}
          <code className="font-mono text-xl">{supplierId ?? 'SUPPLIER'}</code>
        </h2>
        <p className="mt-2 text-xs text-[#7A6A5B]">
          Mọi thao tác gửi Đề xuất Mẫu Mới (<code>/api/v1/partner/submissions</code>)
          và tải ảnh phẳng 3:4 yêu cầu phiên JWT có <code>mfaVerified: true</code>.
        </p>

        <div className="mt-5 grid grid-cols-2 gap-3">
          <button
            type="button"
            onClick={() => setMethod(TwoFactorMethod.EMAIL_OTP)}
            className={`rounded-2xl border p-3.5 text-left text-xs ${
              method === TwoFactorMethod.EMAIL_OTP
                ? 'border-[#1C1410] bg-[#1C1410] text-[#EBCF8F]'
                : 'border-[#B08A4A]/35 bg-[#FBF7EF] text-[#2B2019]'
            }`}
          >
            <p className="font-semibold uppercase tracking-[0.14em]">
              Email OTP (SMTP / Mailpit)
            </p>
            <p className="mt-0.5 text-[11px] opacity-80">
              Nhận mã 6 số qua Gmail SMTP hoặc Mailpit :8025
            </p>
          </button>

          <button
            type="button"
            onClick={() => setMethod(TwoFactorMethod.TOTP)}
            className={`rounded-2xl border p-3.5 text-left text-xs ${
              method === TwoFactorMethod.TOTP
                ? 'border-[#1C1410] bg-[#1C1410] text-[#EBCF8F]'
                : 'border-[#B08A4A]/35 bg-[#FBF7EF] text-[#2B2019]'
            }`}
          >
            <p className="font-semibold uppercase tracking-[0.14em]">
              TOTP Authenticator
            </p>
            <p className="mt-0.5 text-[11px] opacity-80">
              Quét mã QR chuẩn RFC 6238
            </p>
          </button>
        </div>

        <div className="mt-4">
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
              {loading ? 'Đang khởi tạo...' : 'Tạo mã QR TOTP'}
            </button>
          )}
        </div>

        {totpSetup && method === TwoFactorMethod.TOTP ? (
          <div className="mt-4 grid gap-4 rounded-2xl border border-[#B08A4A]/30 bg-[#FBF7EF] p-4 sm:grid-cols-[150px_1fr]">
            <img
              src={totpSetup.qrSvgDataUrl}
              alt="Mã QR TOTP đối tác"
              className="h-36 w-36 rounded-xl border border-[#B08A4A]/25 bg-white p-2"
            />
            <div className="space-y-2 text-xs">
              <p className="font-semibold uppercase tracking-[0.14em] text-[#8A672C]">
                Secret Base32
              </p>
              <p className="break-all rounded-lg bg-white px-2.5 py-1.5 font-mono text-[11px]">
                {totpSetup.secret}
              </p>
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
              Mã xác thực 6 chữ số ({method})
            </span>
            <input
              type="text"
              inputMode="numeric"
              value={code}
              onChange={(e) => setCode(e.target.value.slice(0, 16))}
              placeholder="000000"
              className="mt-1.5 w-full rounded-2xl border border-[#B08A4A]/40 bg-[#FBF7EF] px-4 py-3 font-mono text-lg tracking-[0.35em] text-[#1C1410]"
            />
          </label>

          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-full bg-[#1C1410] py-3 text-xs uppercase tracking-[0.2em] text-[#EBCF8F]"
          >
            {loading ? 'Đang xác minh...' : 'Xác thực 2FA & Mở Cổng Đối Tác'}
          </button>
        </form>
      </section>
    );
  }

  return <>{children}</>;
}
