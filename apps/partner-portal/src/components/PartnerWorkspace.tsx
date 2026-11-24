'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { Portal, Role, type LoginResponse } from '@atelier/contracts';
import type { PartnerOverviewStatus } from '@/lib/partner-overview';
import {
  clearPartnerSession,
  getPartnerSession,
  partnerFetch,
  setPartnerSession,
  type PartnerStoredSession,
} from '@/lib/api-client';
import {
  PartnerGoodsReceiptsTab,
  PartnerPayablesTab,
  PartnerPurchaseOrdersTab,
} from './PartnerProcurementPanels';
import { PartnerSubmissionPanel } from './PartnerSubmissionPanel';
import { PortalToastBanner, emitPortalToast } from './PortalToastBanner';
import { SupplierRoleGuard } from './SupplierRoleGuard';
import { SupplierTenantBar } from './SupplierTenantBar';

export interface PartnerWorkspaceProps {
  overviewStatus: PartnerOverviewStatus;
}

type PartnerTabKey = 'po' | 'grn' | 'payables' | 'submissions';

const QUICK_SUPPLIER_ACCOUNTS = [
  { label: 'Supplier A (SUPPLIER)', email: 'supplier-a@atelier.local' },
  { label: 'Supplier B (SUPPLIER)', email: 'supplier-b@atelier.local' },
  { label: 'Supplier C (SUPPLIER)', email: 'supplier-c@atelier.local' },
  { label: 'SUPER_ADMIN (403)', email: 'admin@atelier.local' },
  { label: 'CUSTOMER (403)', email: 'customer@atelier.local' },
] as const;

export function PartnerWorkspace({ overviewStatus }: PartnerWorkspaceProps) {
  const [session, setSession] = useState<PartnerStoredSession | null>(null);
  const [hydrated, setHydrated] = useState(false);

  const [email, setEmail] = useState('supplier-a@atelier.local');
  const [password, setPassword] = useState('Atelier@2026!');
  const [loginLoading, setLoginLoading] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);

  const [activeTab, setActiveTab] = useState<PartnerTabKey>('po');

  useEffect(() => {
    setSession(getPartnerSession());
    setHydrated(true);
  }, []);

  const handleLogin = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setLoginLoading(true);
    setLoginError(null);

    const res = await partnerFetch<LoginResponse>('/api/v1/auth/login', {
      method: 'POST',
      skipAuthRefresh: true,
      body: JSON.stringify({ email: email.trim(), password }),
    });

    if (res.ok && res.data) {
      const next: PartnerStoredSession = {
        accessToken: res.data.accessToken,
        csrfToken: res.data.csrfToken,
        mfaRequired: true,
        mfaVerified: Boolean(res.data.user.mfaVerified),
        user: res.data.user,
      };
      setPartnerSession(next);
      setSession(next);
    } else {
      setLoginError(
        res.error?.message || 'Đăng nhập đối tác thất bại. Vui lòng thử lại.',
      );
    }
    setLoginLoading(false);
  };

  const handleMfaSuccess = (payload: LoginResponse) => {
    const updated: PartnerStoredSession = {
      accessToken: payload.accessToken,
      csrfToken: payload.csrfToken,
      mfaRequired: false,
      mfaVerified: true,
      user: { ...payload.user, mfaVerified: true },
    };
    setPartnerSession(updated);
    setSession(updated);
    emitPortalToast({
      kind: 'success',
      title: '2FA SUPPLIER VERIFIED',
      message: `Đã mở khóa phạm vi nhà cung cấp ${updated.user.supplierId ?? ''}.`,
    });
  };

  const handleLogout = async () => {
    await partnerFetch('/api/v1/auth/logout', {
      method: 'POST',
      skipAuthRefresh: true,
    });
    clearPartnerSession();
    setSession(null);
  };

  const lockedSupplierId = session?.user.supplierId ?? null;
  const roles = session?.user.roles ?? [];

  return (
    <div className="flex min-h-screen flex-col">
      {/* Top Header */}
      <header className="border-b border-[#B08A4A]/25 bg-[#1C1410] px-6 py-4 text-[#FBF7EF]">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4">
          <div>
            <p className="partner-eyebrow text-[#EBCF8F]">
              {Portal.PARTNER_PORTAL} · Port 3002 · B2B Supplier Portal
            </p>
            <h1 className="font-editorial text-2xl font-normal tracking-wide text-[#FBF7EF]">
              Cổng Đối Tác Nhà Cung Cấp · Tầm Xuân Atelier
            </h1>
          </div>

          {session ? (
            <div className="flex items-center gap-3 text-xs">
              <span className="rounded-full border border-[#B08A4A]/45 px-3.5 py-1.5 font-mono text-[#EBCF8F]">
                {roles.join(', ')}
              </span>
              <button
                type="button"
                onClick={() => void handleLogout()}
                className="rounded-full border border-[#EBCF8F]/50 px-4 py-1.5 text-[11px] uppercase tracking-[0.14em] text-[#EBCF8F]"
              >
                Đăng xuất
              </button>
            </div>
          ) : null}
        </div>
      </header>

      {/* Persistent JWT Tenant Isolation Status Bar */}
      <SupplierTenantBar
        supplierId={lockedSupplierId}
        supplierEmail={session?.user.email}
        twoFactorVerified={Boolean(session?.mfaVerified)}
        overviewStatus={overviewStatus}
      />

      {/* Main Content */}
      <main className="mx-auto w-full max-w-7xl flex-1 px-6 py-8">
        {!hydrated ? (
          <p className="text-xs text-[#7A6A5B]">Đang khởi tạo cổng đối tác...</p>
        ) : !session ? (
          <section className="mx-auto my-8 max-w-lg rounded-3xl border border-[#B08A4A]/35 bg-white p-8 shadow-sm">
            <p className="partner-eyebrow text-[#8A672C]">
              B2B Supplier Auth · Mandatory 2FA + Tenant Lock
            </p>
            <h2 className="font-editorial mt-2 text-4xl font-light text-[#1C1410]">
              Đăng nhập Cổng Nhà Cung Cấp
            </h2>
            <p className="mt-2 text-xs text-[#7A6A5B]">
              Chỉ tài khoản mang vai trò <code>{Role.SUPPLIER}</code> và hoàn
              tất xác thực 2FA OTP mới được truy cập dữ liệu theo{' '}
              <code>supplier_id</code>.
            </p>

            <div className="mt-4 flex flex-wrap gap-1.5">
              {QUICK_SUPPLIER_ACCOUNTS.map((acc) => (
                <button
                  key={acc.email}
                  type="button"
                  onClick={() => {
                    setEmail(acc.email);
                    setPassword('Atelier@2026!');
                  }}
                  className="rounded-full border border-[#B08A4A]/35 bg-[#FBF7EF] px-2.5 py-1 font-mono text-[10px] text-[#5C4B41]"
                >
                  {acc.label}
                </button>
              ))}
            </div>

            <form onSubmit={handleLogin} className="mt-5 space-y-4">
              <label className="block text-xs">
                <span className="uppercase tracking-[0.16em] text-[#8A672C]">
                  Email nhà cung cấp
                </span>
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="mt-1.5 w-full rounded-2xl border border-[#B08A4A]/35 bg-[#FBF7EF] px-4 py-2.5 text-sm"
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
                  className="mt-1.5 w-full rounded-2xl border border-[#B08A4A]/35 bg-[#FBF7EF] px-4 py-2.5 text-sm"
                />
              </label>

              {loginError ? (
                <p className="rounded-xl border border-[#8B2E2E]/35 bg-[#FFF5F4] px-4 py-2.5 text-xs text-[#8B2E2E]">
                  {loginError}
                </p>
              ) : null}

              <button
                type="submit"
                disabled={loginLoading}
                className="w-full rounded-full bg-[#1C1410] py-3 text-xs font-medium uppercase tracking-[0.2em] text-[#EBCF8F]"
              >
                {loginLoading ? 'Đang xác thực...' : 'Tiếp tục tới Bước 2FA'}
              </button>
            </form>
          </section>
        ) : (
          <SupplierRoleGuard
            roles={roles}
            email={session.user.email}
            supplierId={lockedSupplierId}
            mfaVerified={session.mfaVerified}
            onSignOut={() => void handleLogout()}
            onMfaSuccess={handleMfaSuccess}
          >
            {/* Partner B2B Navigation Tabs */}
            <nav
              aria-label="Phân hệ Đối tác B2B"
              className="mb-6 flex flex-wrap gap-2 border-b border-[#B08A4A]/25 pb-4"
            >
              {(
                [
                  ['po', 'Đơn đặt hàng nhập (PO)'],
                  ['grn', 'Biên bản nghiệm thu (GRN)'],
                  ['payables', 'Đối soát công nợ (Payables)'],
                  ['submissions', 'Đề xuất Mẫu Mới (Submissions)'],
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setActiveTab(key)}
                  className={`rounded-full px-5 py-2 text-xs font-medium transition-colors ${
                    activeTab === key
                      ? 'bg-[#1C1410] text-[#EBCF8F]'
                      : 'border border-[#B08A4A]/35 bg-white text-[#2B2019] hover:border-[#8A672C]'
                  }`}
                >
                  {label}
                </button>
              ))}
            </nav>

            {activeTab === 'po' && lockedSupplierId ? (
              <PartnerPurchaseOrdersTab supplierId={lockedSupplierId} />
            ) : null}
            {activeTab === 'grn' ? <PartnerGoodsReceiptsTab /> : null}
            {activeTab === 'payables' ? <PartnerPayablesTab /> : null}
            {activeTab === 'submissions' && lockedSupplierId ? (
              <PartnerSubmissionPanel supplierId={lockedSupplierId} />
            ) : null}
          </SupplierRoleGuard>
        )}
      </main>
      <PortalToastBanner />
    </div>
  );
}
