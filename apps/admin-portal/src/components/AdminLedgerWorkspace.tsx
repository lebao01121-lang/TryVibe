'use client';

import { useEffect, useState, type FormEvent } from 'react';
import {
  Permission,
  Portal,
  Role,
  hasPermission,
  isMfaRequiredForRoles,
  type LoginResponse,
} from '@atelier/contracts';
import type { AdminOverviewStatus } from '@/lib/admin-overview';
import {
  adminFetch,
  clearAdminSession,
  getAdminSession,
  setAdminSession,
  type AdminStoredSession,
} from '@/lib/api-client';
import { AdminRoleGuard, hasStrictAdminRole } from './AdminRoleGuard';
import { McpCopilotDrawer } from './McpCopilotDrawer';
import { PortalToastBanner, emitPortalToast } from './PortalToastBanner';
import { TwoFactorGate } from './TwoFactorGate';
import { AiLookbookStudioTab } from './tabs/AiLookbookStudioTab';
import { AiOpsHealthTab } from './tabs/AiOpsHealthTab';
import { CatalogMatrixTab } from './tabs/CatalogMatrixTab';
import { HomepageCampaignTab } from './tabs/HomepageCampaignTab';
import { IamAuditTab } from './tabs/IamAuditTab';
import { InventoryLedgerTab } from './tabs/InventoryLedgerTab';
import { MediaStudioTab } from './tabs/MediaStudioTab';
import { OrdersRmaTab } from './tabs/OrdersRmaTab';
import { ProcurementTab } from './tabs/ProcurementTab';

export interface AdminLedgerWorkspaceProps {
  overviewStatus: AdminOverviewStatus;
}

type AdminTabKey =
  | 'iam'
  | 'ops'
  | 'orders'
  | 'procurement'
  | 'inventory'
  | 'catalog'
  | 'media'
  | 'lookbook'
  | 'campaign';

const QUICK_DEV_ACCOUNTS = [
  { label: 'SUPER_ADMIN', email: 'admin@atelier.local' },
  { label: 'CATALOG_AI_OPERATOR', email: 'operator@atelier.local' },
  { label: 'WAREHOUSE_MANAGER', email: 'warehouse@atelier.local' },
  { label: 'ORDER_STAFF', email: 'staff@atelier.local' },
  { label: 'CUSTOMER (403)', email: 'customer@atelier.local' },
  { label: 'SUPPLIER (403)', email: 'supplier-a@atelier.local' },
] as const;

function getDefaultTabForRoles(roles: readonly Role[]): AdminTabKey {
  if (roles.includes(Role.SUPER_ADMIN)) return 'iam';
  if (roles.includes(Role.WAREHOUSE_MANAGER)) return 'procurement';
  if (roles.includes(Role.ORDER_STAFF)) return 'orders';
  if (roles.includes(Role.CATALOG_AI_OPERATOR)) return 'catalog';
  return 'catalog';
}

export function AdminLedgerWorkspace({
  overviewStatus,
}: AdminLedgerWorkspaceProps) {
  const [session, setSession] = useState<AdminStoredSession | null>(null);
  const [hydrated, setHydrated] = useState(false);

  // Login Form
  const [email, setEmail] = useState('admin@atelier.local');
  const [password, setPassword] = useState('Atelier@2026!');
  const [loginLoading, setLoginLoading] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);

  const [activeTab, setActiveTab] = useState<AdminTabKey>('catalog');
  const [drawerOpen, setDrawerOpen] = useState(true);

  useEffect(() => {
    const existing = getAdminSession();
    setSession(existing);
    if (existing?.user.roles?.length) {
      setActiveTab(getDefaultTabForRoles(existing.user.roles));
    }
    setHydrated(true);
  }, []);

  const handleLoginSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setLoginLoading(true);
    setLoginError(null);

    const res = await adminFetch<LoginResponse>('/api/v1/auth/login', {
      method: 'POST',
      skipAuthRefresh: true,
      body: JSON.stringify({ email: email.trim(), password }),
    });

    if (res.ok && res.data) {
      const mfaReq =
        res.data.mfaRequired || isMfaRequiredForRoles(res.data.user.roles);
      const nextSession: AdminStoredSession = {
        accessToken: res.data.accessToken,
        csrfToken: res.data.csrfToken,
        mfaRequired: mfaReq,
        mfaVerified: Boolean(res.data.user.mfaVerified) || !mfaReq,
        user: res.data.user,
      };
      setAdminSession(nextSession);
      setSession(nextSession);
      setActiveTab(getDefaultTabForRoles(res.data.user.roles));
      emitPortalToast({
        kind: 'info',
        title: 'PHIÊN ĐIỀU HÀNH',
        message: `Đã đăng nhập ${res.data.user.email} (${res.data.user.roles.join(', ')}).`,
      });
    } else {
      setLoginError(
        res.error?.message || 'Đăng nhập thất bại. Vui lòng kiểm tra tài khoản.',
      );
    }
    setLoginLoading(false);
  };

  const handleMfaSuccess = (payload: LoginResponse) => {
    const updated: AdminStoredSession = {
      accessToken: payload.accessToken,
      csrfToken: payload.csrfToken,
      mfaRequired: false,
      mfaVerified: true,
      user: { ...payload.user, mfaVerified: true },
    };
    setAdminSession(updated);
    setSession(updated);
    emitPortalToast({
      kind: 'success',
      title: '2FA VERIFIED',
      message: 'Đã xác thực 2FA thành công — mở khóa toàn bộ quyền sổ cái.',
    });
  };

  const handleLogout = async () => {
    await adminFetch('/api/v1/auth/logout', {
      method: 'POST',
      skipAuthRefresh: true,
    });
    clearAdminSession();
    setSession(null);
  };

  const roles = session?.user.roles ?? [];
  const primaryRole: Role = roles[0] ?? Role.CUSTOMER;
  const isAllowed = session ? hasStrictAdminRole(roles) : false;

  const canSeeIam =
    roles.includes(Role.SUPER_ADMIN) ||
    hasPermission(roles, Permission.ADMIN_RBAC_MANAGE) ||
    hasPermission(roles, Permission.ADMIN_AUDIT_READ);
  const canSeeOps =
    roles.includes(Role.SUPER_ADMIN) || roles.includes(Role.WAREHOUSE_MANAGER);
  const canSeeOrders =
    (roles.includes(Role.SUPER_ADMIN) || roles.includes(Role.ORDER_STAFF)) &&
    hasPermission(roles, Permission.ORDER_READ);
  const canSeeProcurement =
    (roles.includes(Role.SUPER_ADMIN) ||
      roles.includes(Role.WAREHOUSE_MANAGER)) &&
    hasPermission(roles, Permission.INVENTORY_PO_READ);
  const canSeeInventory =
    (roles.includes(Role.SUPER_ADMIN) ||
      roles.includes(Role.WAREHOUSE_MANAGER)) &&
    hasPermission(roles, Permission.INVENTORY_STOCK_READ);
  const canSeeCatalog =
    hasPermission(roles, Permission.CATALOG_PRODUCT_READ) ||
    hasPermission(roles, Permission.CATALOG_PRODUCT_WRITE);
  const canSeeMedia =
    roles.includes(Role.SUPER_ADMIN) ||
    hasPermission(roles, Permission.CATALOG_MEDIA_PROCESS) ||
    hasPermission(roles, Permission.CATALOG_PRODUCT_WRITE);
  const canSeeLookbook =
    (roles.includes(Role.SUPER_ADMIN) ||
      roles.includes(Role.CATALOG_AI_OPERATOR)) &&
    hasPermission(roles, Permission.CATALOG_PRODUCT_WRITE);
  const canSeeCampaign =
    roles.includes(Role.SUPER_ADMIN) ||
    roles.includes(Role.CATALOG_AI_OPERATOR);

  const visibleTabs: Array<{ key: AdminTabKey; label: string }> = [
    ...(canSeeIam
      ? [{ key: 'iam' as const, label: 'IAM, RBAC & Audit Logs' }]
      : []),
    ...(canSeeOps
      ? [{ key: 'ops' as const, label: 'AI Ops, Health & DLQ' }]
      : []),
    ...(canSeeOrders
      ? [{ key: 'orders' as const, label: 'Đơn hàng, Cảnh báo Trễ & RMA QC' }]
      : []),
    ...(canSeeProcurement
      ? [
          {
            key: 'procurement' as const,
            label: 'Thu mua B2B · PO → GRN & Công nợ',
          },
        ]
      : []),
    ...(canSeeInventory
      ? [
          {
            key: 'inventory' as const,
            label: 'Tồn kho & Giữ chỗ (Inventory Ledger)',
          },
        ]
      : []),
    ...(canSeeCatalog
      ? [
          {
            key: 'catalog' as const,
            label: 'Catalog SPU/SKU & Duyệt mẫu Đối tác',
          },
        ]
      : []),
    ...(canSeeMedia
      ? [{ key: 'media' as const, label: 'Dual Media Studio & Calibrator' }]
      : []),
    ...(canSeeLookbook
      ? [{ key: 'lookbook' as const, label: 'AI Lookbook Studio' }]
      : []),
    ...(canSeeCampaign
      ? [
          {
            key: 'campaign' as const,
            label: 'Chiến dịch Trang chủ (Homepage Campaign)',
          },
        ]
      : []),
  ];

  const effectiveTab: AdminTabKey = visibleTabs.some((t) => t.key === activeTab)
    ? activeTab
    : (visibleTabs[0]?.key ?? 'catalog');

  return (
    <div className="flex min-h-screen flex-col">
      {/* Top Operational Header */}
      <header className="border-b border-[#B08A4A]/25 bg-[#1C1410] px-6 py-4 text-[#FBF7EF]">
        <div className="mx-auto flex max-w-[1600px] flex-wrap items-center justify-between gap-4">
          <div>
            <p className="ledger-eyebrow text-[#EBCF8F]">
              {Portal.ADMIN_PORTAL} · Port 3001 · Zero-Trust Operational Ledger
            </p>
            <h1 className="font-editorial text-2xl font-normal tracking-wide text-[#FBF7EF]">
              Sổ Cái Điều Hành · Tầm Xuân Atelier
            </h1>
          </div>

          <div className="flex flex-wrap items-center gap-3 text-xs">
            <span className="rounded-full border border-[#EBCF8F]/35 bg-[#2A1E17] px-3.5 py-1.5 text-[#EBCF8F]">
              {overviewStatus.source === 'live-bff'
                ? 'BFF Live (:4000)'
                : 'BFF Offline Fallback'}
            </span>
            {session ? (
              <>
                <span className="rounded-full border border-[#B08A4A]/40 px-3.5 py-1.5 font-mono text-[#FBF7EF]">
                  {session.user.email} · {roles.join(', ')}
                </span>
                <button
                  type="button"
                  onClick={() => void handleLogout()}
                  className="rounded-full border border-[#EBCF8F]/50 px-4 py-1.5 text-[11px] uppercase tracking-[0.14em] text-[#EBCF8F] hover:bg-[#B08A4A] hover:text-[#1C1410]"
                >
                  Đăng xuất
                </button>
              </>
            ) : null}
          </div>
        </div>
      </header>

      {/* Main Content + Right-side MCP Copilot Drawer */}
      <div className="flex flex-1 flex-col xl:flex-row">
        <main className="flex-1 px-6 py-8 lg:px-10">
          {!hydrated ? (
            <p className="text-xs text-[#7A6A5B]">
              Đang khởi tạo phiên điều hành...
            </p>
          ) : !session ? (
            <section className="mx-auto my-8 max-w-lg rounded-3xl border border-[#B08A4A]/35 bg-white p-8 shadow-sm">
              <p className="ledger-eyebrow text-[#8A672C]">
                Xác thực nội bộ · RS256 JWKS + Dual 2FA
              </p>
              <h2 className="font-editorial mt-2 text-4xl font-light text-[#1C1410]">
                Đăng nhập Sổ cái điều hành
              </h2>
              <p className="mt-2 text-xs text-[#7A6A5B]">
                Đăng nhập thật qua <code>POST /api/v1/auth/login</code>. Vai trò{' '}
                <code>SUPER_ADMIN</code> &amp; <code>WAREHOUSE_MANAGER</code> bắt
                buộc qua cổng 2FA (TOTP / Email OTP).
              </p>

              <div className="mt-4 flex flex-wrap gap-1.5">
                {QUICK_DEV_ACCOUNTS.map((acc) => (
                  <button
                    key={acc.email}
                    type="button"
                    onClick={() => {
                      setEmail(acc.email);
                      setPassword('Atelier@2026!');
                    }}
                    className="rounded-full border border-[#B08A4A]/35 bg-[#FBF7EF] px-2.5 py-1 font-mono text-[10px] text-[#5C4B41] hover:border-[#1C1410]"
                  >
                    {acc.label}
                  </button>
                ))}
              </div>

              <form onSubmit={handleLoginSubmit} className="mt-5 space-y-4">
                <label className="block text-xs">
                  <span className="uppercase tracking-[0.16em] text-[#8A672C]">
                    Email nội bộ
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
                  {loginLoading ? 'Đang xác thực...' : 'Đăng nhập Admin Portal'}
                </button>
              </form>
            </section>
          ) : (
            <div className="mx-auto max-w-6xl">
              <AdminRoleGuard
                roles={roles}
                onSignOut={() => void handleLogout()}
              >
                <TwoFactorGate
                  roles={roles}
                  email={session.user.email}
                  mfaRequired={session.mfaRequired}
                  mfaVerified={session.mfaVerified}
                  onMfaSuccess={handleMfaSuccess}
                >
                  {/* Dynamic RBAC Tab Navigation */}
                  <nav
                    aria-label="Phân hệ điều hành"
                    className="mb-6 flex flex-wrap gap-2 border-b border-[#B08A4A]/25 pb-4"
                  >
                    {visibleTabs.map((tab) => (
                      <button
                        key={tab.key}
                        type="button"
                        onClick={() => setActiveTab(tab.key)}
                        className={`rounded-full px-4 py-2 text-xs font-medium transition-colors ${
                          effectiveTab === tab.key
                            ? 'bg-[#1C1410] text-[#EBCF8F]'
                            : 'border border-[#B08A4A]/35 bg-white text-[#2B2019] hover:border-[#8A672C]'
                        }`}
                      >
                        {tab.label}
                      </button>
                    ))}
                  </nav>

                  {effectiveTab === 'iam' ? <IamAuditTab /> : null}
                  {effectiveTab === 'ops' ? (
                    <AiOpsHealthTab
                      roles={roles}
                      mfaVerified={session.mfaVerified}
                    />
                  ) : null}
                  {effectiveTab === 'orders' ? <OrdersRmaTab /> : null}
                  {effectiveTab === 'procurement' ? <ProcurementTab /> : null}
                  {effectiveTab === 'inventory' ? <InventoryLedgerTab /> : null}
                  {effectiveTab === 'catalog' ? (
                    <CatalogMatrixTab roles={roles} />
                  ) : null}
                  {effectiveTab === 'media' ? <MediaStudioTab /> : null}
                  {effectiveTab === 'lookbook' ? <AiLookbookStudioTab /> : null}
                  {effectiveTab === 'campaign' ? <HomepageCampaignTab /> : null}
                </TwoFactorGate>
              </AdminRoleGuard>
            </div>
          )}
        </main>

        {isAllowed && session ? (
          <McpCopilotDrawer
            activeRole={primaryRole}
            twoFactorVerified={session.mfaVerified}
            isOpen={drawerOpen}
            onToggleOpen={() => setDrawerOpen((prev) => !prev)}
          />
        ) : null}
      </div>

      <PortalToastBanner />
    </div>
  );
}
