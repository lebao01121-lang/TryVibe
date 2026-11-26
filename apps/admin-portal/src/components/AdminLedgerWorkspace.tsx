'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import {
  Portal,
  Role,
  isMfaRequiredForRoles,
  type LoginResponse,
} from '@atelier/contracts';
import { LiveMotionTogglePill } from '@atelier/motion-kit';
import type {
  AdminLiveOverviewData,
  AdminOverviewStatus,
} from '@/lib/admin-overview';
import {
  canAccessAdminTab,
  getAdminNavItem,
  getDefaultAdminTab,
  getVisibleAdminNavGroups,
  getVisibleAdminTabs,
  type AdminNavBadgeTone,
  type AdminNavGroupId,
  type AdminTabKey,
} from '@/lib/admin-navigation';
import {
  adminFetch,
  clearAdminSession,
  getAdminSession,
  getBffBaseUrl,
  setAdminSession,
  type AdminStoredSession,
  type ApiFetchResult,
} from '@/lib/api-client';
import {
  AdminNavIcon,
  AlertTriangleIcon,
  BellIcon,
  BotIcon,
  BoxIcon,
  CheckCircleIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ExternalLinkIcon,
  MenuIcon,
  MoonIcon,
  RefreshIcon,
  SparklesIcon,
  SunIcon,
} from './AdminIcons';
import { AdminRoleGuard, hasStrictAdminRole } from './AdminRoleGuard';
import { McpCopilotDrawer } from './McpCopilotDrawer';
import { PortalToastBanner, emitPortalToast } from './PortalToastBanner';
import { TwoFactorGate } from './TwoFactorGate';
import { AiLookbookStudioTab } from './tabs/AiLookbookStudioTab';
import { AiOpsHealthTab } from './tabs/AiOpsHealthTab';
import { AiTryOnAnalyticsTab } from './tabs/AiTryOnAnalyticsTab';
import { AnalyticsBiTab } from './tabs/AnalyticsBiTab';
import { CatalogMatrixTab } from './tabs/CatalogMatrixTab';
import { CategorySizeChartTab } from './tabs/CategorySizeChartTab';
import { CrmModerationTab } from './tabs/CrmModerationTab';
import {
  DashboardOverviewTab,
  type DashboardLiveBadges,
} from './tabs/DashboardOverviewTab';
import { EditorialCmsTab } from './tabs/EditorialCmsTab';
import { IamAuditTab } from './tabs/IamAuditTab';
import { InventoryLedgerTab } from './tabs/InventoryLedgerTab';
import { MediaStudioTab } from './tabs/MediaStudioTab';
import { OrdersRmaTab } from './tabs/OrdersRmaTab';
import { PaymentLedgerTab } from './tabs/PaymentLedgerTab';
import { ProcurementTab } from './tabs/ProcurementTab';
import { PromotionsTab } from './tabs/PromotionsTab';
import { RagKnowledgeBaseTab } from './tabs/RagKnowledgeBaseTab';

export interface AdminLedgerWorkspaceProps {
  overviewStatus: AdminOverviewStatus;
}

type ThemeMode = 'light' | 'dark';

const THEME_STORAGE_KEY = 'atelier_admin_theme';
const SIDEBAR_STORAGE_KEY = 'atelier_admin_sidebar_collapsed';
const STOREFRONT_LIVE_URL =
  process.env.NEXT_PUBLIC_STOREFRONT_URL || 'http://127.0.0.1:3000';

const ENABLE_DEV_LOGIN = process.env.NEXT_PUBLIC_ENABLE_DEV_LOGIN === 'true';

const QUICK_DEV_ACCOUNTS = [
  { label: 'SUPER_ADMIN', email: 'lebao01121@gmail.com' },
  { label: 'CATALOG_AI_OPERATOR', email: 'operator@atelier.local' },
  { label: 'WAREHOUSE_MANAGER', email: 'warehouse@atelier.local' },
  { label: 'ORDER_STAFF', email: 'staff@atelier.local' },
  { label: 'CUSTOMER (403)', email: 'customer@atelier.local' },
  { label: 'SUPPLIER (403)', email: 'supplier-a@atelier.local' },
] as const;

function getBadgeToneClasses(tone?: AdminNavBadgeTone): string {
  switch (tone) {
    case 'emerald':
      return 'border-emerald-400/40 bg-emerald-500/20 text-emerald-300';
    case 'amber':
      return 'border-amber-400/40 bg-amber-500/20 text-amber-300';
    case 'rose':
      return 'border-rose-400/40 bg-rose-500/20 text-rose-300';
    case 'gold':
    default:
      return 'border-[#EBCF8F]/40 bg-[#B08A4A]/22 text-[#EBCF8F]';
  }
}

function getUserMonogram(email?: string): string {
  if (!email) return 'TV';
  const local = email.split('@')[0]?.replace(/[^a-zA-Z0-9]/g, '') || 'TV';
  return local.slice(0, 2).toUpperCase();
}

function getRoleShortLabel(role: Role): string {
  switch (role) {
    case Role.SUPER_ADMIN:
      return 'Quản trị viên';
    case Role.WAREHOUSE_MANAGER:
      return 'Quản lý Kho';
    case Role.ORDER_STAFF:
      return 'Vận hành Đơn';
    case Role.CATALOG_AI_OPERATOR:
      return 'Điều phối AI';
    default:
      return role;
  }
}

type AdminOAuthProvider = 'google' | 'github';

interface AdminOAuthProvidersStatus {
  google: { enabled: boolean; callbackUrl: string };
  github: { enabled: boolean; callbackUrl: string };
  adminExceptionConfigured?: boolean;
}

const inFlightAdminOAuthExchanges = new Map<
  string,
  Promise<ApiFetchResult<LoginResponse>>
>();

function resolveAdminOAuthError(
  oauthError: string | null,
  oauthErrorCode: string | null,
): string {
  if (oauthError && oauthError.trim().length > 0) {
    return oauthError.trim();
  }
  switch (oauthErrorCode) {
    case 'ADMIN_OAUTH_FORBIDDEN':
      return 'Tài khoản này không có quyền quản trị trên TryVibe Admin Portal.';
    case 'OAUTH_LOCAL_ACCOUNT_CONFLICT':
      return 'Email này đã được đăng ký tài khoản nội bộ trên website. Không thể đăng nhập nhanh bằng Google/GitHub — vui lòng dùng Email & Mật khẩu.';
    case 'OAUTH_PROVIDER_MISMATCH':
      return 'Email này đã được liên kết với nhà cung cấp đăng nhập nhanh khác.';
    case 'OAUTH_NOT_CONFIGURED':
      return 'Phương thức đăng nhập nhanh này chưa được cấu hình khóa OAuth2 trên máy chủ.';
    case 'OAUTH_CANCELLED':
      return 'Bạn đã hủy quá trình đăng nhập nhanh quản trị.';
    case 'OAUTH_STATE_INVALID':
      return 'Phiên xác thực OAuth2 quản trị đã hết hạn hoặc không hợp lệ. Vui lòng thử lại.';
    case 'OAUTH_EMAIL_UNVERIFIED':
      return 'Email từ Google/GitHub chưa được xác minh nên không thể đăng nhập Admin Portal.';
    case 'OAUTH_PROVIDER_ERROR':
      return 'Không thể kết nối nhà cung cấp OAuth2. Vui lòng thử lại sau giây lát.';
    case 'OAUTH_TICKET_INVALID':
      return 'Mã xác thực OAuth2 đã hết hạn hoặc đã được sử dụng. Vui lòng đăng nhập lại.';
    default:
      return 'Đăng nhập nhanh OAuth2 không thành công. Vui lòng thử lại hoặc dùng Email & Mật khẩu.';
  }
}

function cleanAdminOAuthQueryParams(): void {
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

function AdminGoogleIcon() {
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

function AdminGitHubIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width={17}
      height={17}
      fill="currentColor"
      aria-hidden="true"
      className="shrink-0"
    >
      <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
    </svg>
  );
}

export function AdminLedgerWorkspace({
  overviewStatus,
}: AdminLedgerWorkspaceProps) {
  const [session, setSession] = useState<AdminStoredSession | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [liveOverview, setLiveOverview] =
    useState<AdminLiveOverviewData | null>(null);
  const [bffOnline, setBffOnline] = useState<boolean>(
    overviewStatus.bffOnline || overviewStatus.source === 'live-bff',
  );

  // Login Form (prefilled ONLY when NEXT_PUBLIC_ENABLE_DEV_LOGIN === 'true')
  const [email, setEmail] = useState(
    ENABLE_DEV_LOGIN ? 'lebao01121@gmail.com' : '',
  );
  const [password, setPassword] = useState(
    ENABLE_DEV_LOGIN ? 'Atelier@2026!' : '',
  );
  const [loginLoading, setLoginLoading] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [oauthProviders, setOauthProviders] =
    useState<AdminOAuthProvidersStatus | null>(null);
  const [oauthProvidersLoaded, setOauthProvidersLoaded] = useState(false);
  const [oauthExchanging, setOauthExchanging] = useState(false);
  const [oauthRedirecting, setOauthRedirecting] =
    useState<AdminOAuthProvider | null>(null);
  const [oauthConfigHint, setOauthConfigHint] = useState<string | null>(null);

  // Enterprise Shell UI State
  const [activeTab, setActiveTab] = useState<AdminTabKey>('dashboard');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [pendingCopilotPrompt, setPendingCopilotPrompt] = useState<
    string | null
  >(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [collapsedNavGroups, setCollapsedNavGroups] = useState<
    Partial<Record<AdminNavGroupId, boolean>>
  >({});
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [themeMode, setThemeMode] = useState<ThemeMode>('light');
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [syncTick, setSyncTick] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [bgSyncing, setBgSyncing] = useState(false);
  const [alertsOpen, setAlertsOpen] = useState(false);
  const alertsContainerRef = useRef<HTMLDivElement | null>(null);

  const [liveBadges, setLiveBadges] = useState<DashboardLiveBadges>({
    pendingOrdersRma: 0,
    lowStockCount: 0,
    openPoCount: 0,
    servicesReady: 0,
    servicesTotal: 11,
  });

  // Hydrate persisted session & shell preferences on client
  useEffect(() => {
    const existing = getAdminSession();
    setSession(existing);
    if (existing?.user.roles?.length) {
      setActiveTab(getDefaultAdminTab(existing.user.roles));
    }

    try {
      const savedTheme = window.localStorage.getItem(THEME_STORAGE_KEY);
      if (savedTheme === 'dark' || savedTheme === 'light') {
        setThemeMode(savedTheme);
      }
      const savedCollapsed = window.localStorage.getItem(SIDEBAR_STORAGE_KEY);
      if (savedCollapsed === 'true') {
        setSidebarCollapsed(true);
      }
    } catch {
      // Ignore storage access restrictions
    }

    setHydrated(true);
  }, []);

  // Load OAuth provider availability when unauthenticated
  useEffect(() => {
    if (!hydrated || session) return undefined;
    let cancelled = false;
    void adminFetch<AdminOAuthProvidersStatus>('/api/v1/auth/oauth/providers', {
      method: 'GET',
      skipAuthRefresh: true,
    }).then((res) => {
      if (cancelled) return;
      if (res.ok && res.data) {
        setOauthProviders(res.data);
      }
      setOauthProvidersLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, [hydrated, session]);

  // Handle OAuth2 callback (?oauthTicket=... or ?oauthError=...) when unauthenticated
  useEffect(() => {
    if (!hydrated || session || typeof window === 'undefined') {
      return undefined;
    }

    const params = new URLSearchParams(window.location.search);
    const oauthTicket = params.get('oauthTicket')?.trim() || '';
    const oauthError = params.get('oauthError');
    const oauthErrorCode = params.get('oauthErrorCode');

    if (oauthError || oauthErrorCode) {
      setLoginError(resolveAdminOAuthError(oauthError, oauthErrorCode));
      cleanAdminOAuthQueryParams();
      return undefined;
    }

    if (!oauthTicket) {
      return undefined;
    }

    let active = true;
    setOauthExchanging(true);
    setLoginError(null);
    setOauthConfigHint(null);

    let exchangePromise = inFlightAdminOAuthExchanges.get(oauthTicket);
    if (!exchangePromise) {
      exchangePromise = adminFetch<LoginResponse>(
        '/api/v1/auth/oauth/exchange',
        {
          method: 'POST',
          skipAuthRefresh: true,
          body: JSON.stringify({ ticket: oauthTicket }),
        },
      );
      inFlightAdminOAuthExchanges.set(oauthTicket, exchangePromise);
    }

    void exchangePromise.then((res) => {
      if (!active) return;
      inFlightAdminOAuthExchanges.delete(oauthTicket);
      cleanAdminOAuthQueryParams();

      if (res.ok && res.data) {
        const mfaReq = Boolean(
          res.data.mfaRequired && !res.data.user.mfaVerified,
        );
        const nextSession: AdminStoredSession = {
          accessToken: res.data.accessToken,
          csrfToken: res.data.csrfToken,
          mfaRequired: mfaReq,
          mfaVerified: Boolean(res.data.user.mfaVerified) || !mfaReq,
          user: res.data.user,
        };
        setAdminSession(nextSession);
        setSession(nextSession);
        setActiveTab(getDefaultAdminTab(res.data.user.roles));
        setDrawerOpen(false);
        emitPortalToast({
          kind: 'success',
          title: 'ĐĂNG NHẬP NHANH QUẢN TRỊ',
          message: `Đã xác thực OAuth2 cho ${res.data.user.email} (${res.data.user.roles.join(', ')}).`,
        });
      } else {
        setLoginError(
          res.error?.message ||
            'Không thể hoàn tất đăng nhập nhanh quản trị. Mã xác thực đã hết hạn hoặc không hợp lệ.',
        );
      }
      setOauthExchanging(false);
    });

    return () => {
      active = false;
    };
  }, [hydrated, session]);

  // Close notification popover on outside click or Escape
  useEffect(() => {
    if (!alertsOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (
        alertsContainerRef.current &&
        !alertsContainerRef.current.contains(event.target as Node)
      ) {
        setAlertsOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setAlertsOpen(false);
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [alertsOpen]);

  const handleToggleTheme = () => {
    setThemeMode((prev) => {
      const next: ThemeMode = prev === 'light' ? 'dark' : 'light';
      try {
        window.localStorage.setItem(THEME_STORAGE_KEY, next);
      } catch {
        // Ignore storage write errors
      }
      return next;
    });
  };

  const handleToggleSidebar = () => {
    setSidebarCollapsed((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(SIDEBAR_STORAGE_KEY, String(next));
      } catch {
        // Ignore storage write errors
      }
      return next;
    });
  };

  const handleNavigateTab = useCallback((tab: AdminTabKey) => {
    setActiveTab(tab);
    setMobileNavOpen(false);
    setAlertsOpen(false);
  }, []);

  const handleOpenCopilotWithPrompt = useCallback((prompt: string) => {
    setPendingCopilotPrompt(prompt);
    setDrawerOpen(true);
  }, []);

  const handleConsumeInitialPrompt = useCallback(() => {
    setPendingCopilotPrompt(null);
  }, []);

  const handleLiveBadgesChange = useCallback((badges: DashboardLiveBadges) => {
    setLiveBadges((prev) => {
      if (
        prev.pendingOrdersRma === badges.pendingOrdersRma &&
        prev.lowStockCount === badges.lowStockCount &&
        prev.openPoCount === badges.openPoCount &&
        prev.servicesReady === badges.servicesReady &&
        prev.servicesTotal === badges.servicesTotal
      ) {
        return prev;
      }
      return badges;
    });
  }, []);

  const handleManualRefresh = () => {
    setRefreshing(true);
    setRefreshNonce((prev) => prev + 1);
    window.setTimeout(() => setRefreshing(false), 550);
  };

  const handleTriggerRefreshOverview = useCallback(() => {
    setRefreshNonce((prev) => prev + 1);
  }, []);

  const handleToggleNavGroup = useCallback((groupId: AdminNavGroupId) => {
    setCollapsedNavGroups((prev) => ({
      ...prev,
      [groupId]: !prev[groupId],
    }));
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
      setActiveTab(getDefaultAdminTab(res.data.user.roles));
      setDrawerOpen(false);
      emitPortalToast({
        kind: 'info',
        title: 'PHIÊN ĐIỀU HÀNH',
        message: `Đã đăng nhập ${res.data.user.email} (${res.data.user.roles.join(', ')}).`,
      });
    } else {
      setLoginError(
        res.error?.message ||
          'Đăng nhập thất bại. Vui lòng kiểm tra tài khoản.',
      );
    }
    setLoginLoading(false);
  };

  const handleAdminOAuthStart = (provider: AdminOAuthProvider) => {
    if (loginLoading || oauthExchanging || oauthRedirecting !== null) return;

    const isEnabled =
      provider === 'google'
        ? oauthProviders
          ? Boolean(oauthProviders.google?.enabled)
          : true
        : oauthProviders
          ? Boolean(oauthProviders.github?.enabled)
          : false;

    if (oauthProvidersLoaded && !isEnabled) {
      setOauthConfigHint(
        provider === 'github'
          ? 'Đăng nhập nhanh GitHub chưa được cấu hình. Vui lòng thêm GITHUB_OAUTH_CLIENT_ID và GITHUB_OAUTH_CLIENT_SECRET vào tệp .env rồi khởi động lại Auth/BFF.'
          : 'Đăng nhập nhanh Google chưa được cấu hình. Vui lòng thêm GOOGLE_OAUTH_CLIENT_ID và GOOGLE_OAUTH_CLIENT_SECRET vào tệp .env rồi khởi động lại Auth/BFF.',
      );
      return;
    }

    setOauthConfigHint(null);
    setLoginError(null);
    setOauthRedirecting(provider);
    window.location.href = `${getBffBaseUrl()}/api/v1/auth/oauth/${provider}/start?portal=admin`;
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
    setActiveTab(getDefaultAdminTab(payload.user.roles));
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
    setLiveOverview(null);
    setDrawerOpen(false);
    setAlertsOpen(false);
    setMobileNavOpen(false);
  };

  const roles = useMemo(
    () => session?.user.roles ?? ([] as readonly Role[]),
    [session],
  );
  const primaryRole: Role = roles[0] ?? Role.CUSTOMER;
  const isAllowed = session ? hasStrictAdminRole(roles) : false;
  const isTwoFactorSatisfied = Boolean(
    session && (!session.mfaRequired || session.mfaVerified),
  );

  // Hydrate authenticated live Admin overview metrics once Bearer JWT & 2FA are satisfied
  useEffect(() => {
    if (!session?.accessToken || !isAllowed || !isTwoFactorSatisfied) {
      setLiveOverview(null);
      return;
    }

    let cancelled = false;
    void adminFetch<AdminLiveOverviewData>('/api/v1/admin/overview').then(
      (res) => {
        if (cancelled) return;
        if (res.ok && res.data) {
          setLiveOverview(res.data);
          setBffOnline(true);
        }
      },
    );

    return () => {
      cancelled = true;
    };
  }, [session?.accessToken, isAllowed, isTwoFactorSatisfied, refreshNonce, syncTick]);

  // Silent 15s background auto-sync (no tab remount, no white flash, paused while tab hidden)
  useEffect(() => {
    if (!session?.accessToken || !isAllowed || !isTwoFactorSatisfied) {
      return undefined;
    }

    let clearTimer: number | null = null;
    const pollTimer = window.setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) {
        return;
      }
      setBgSyncing(true);
      setSyncTick((prev) => prev + 1);
      if (clearTimer !== null) {
        window.clearTimeout(clearTimer);
      }
      clearTimer = window.setTimeout(() => {
        setBgSyncing(false);
        clearTimer = null;
      }, 1300);
    }, 15_000);

    return () => {
      window.clearInterval(pollTimer);
      if (clearTimer !== null) {
        window.clearTimeout(clearTimer);
      }
    };
  }, [session?.accessToken, isAllowed, isTwoFactorSatisfied]);

  const visibleTabs = useMemo(() => getVisibleAdminTabs(roles), [roles]);
  const visibleNavGroups = useMemo(
    () => getVisibleAdminNavGroups(roles),
    [roles],
  );

  const effectiveTab: AdminTabKey = visibleTabs.some(
    (t) => t.key === activeTab,
  )
    ? activeTab
    : (visibleTabs[0]?.key ?? 'dashboard');

  const currentNavItem = getAdminNavItem(effectiveTab);
  const canSeeOrders = canAccessAdminTab(roles, 'orders');
  const canSeeLookbook = canAccessAdminTab(roles, 'lookbook');
  const canSeeInventory = canAccessAdminTab(roles, 'inventory');
  const canSeeProcurement = canAccessAdminTab(roles, 'procurement');
  const canSeeOps = canAccessAdminTab(roles, 'ops');

  const isDark = themeMode === 'dark';
  const totalAlertCount =
    liveBadges.pendingOrdersRma +
    liveBadges.lowStockCount +
    liveBadges.openPoCount;

  const servicesReadyDisplay =
    liveBadges.servicesReady > 0
      ? liveBadges.servicesReady
      : liveOverview
        ? liveOverview.ledger.modules.filter((m) => m.status === 'active')
            .length
        : bffOnline
          ? 11
          : 0;
  const servicesTotalDisplay = liveBadges.servicesTotal || 11;

  const hasAiHubGroup = visibleNavGroups.some((g) => g.id === 'ai_hub');

  // Shared sidebar nav content renderer (for Desktop rail & Mobile slide-over)
  const renderSidebarNavigation = (compact: boolean) => (
    <div className="flex h-full flex-col bg-[#16100C] text-[#FBF7EF]">
      {/* Brand Header */}
      <div
        className={`flex h-16 shrink-0 items-center border-b border-[#B08A4A]/20 ${
          compact ? 'justify-center px-2' : 'justify-between px-4'
        }`}
      >
        <button
          type="button"
          onClick={() => handleNavigateTab('dashboard')}
          className="flex min-w-0 items-center gap-2.5 text-left"
          title="TryVibe Atelier · Enterprise Admin"
        >
          <span className="font-editorial flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-[#EBCF8F] via-[#B08A4A] to-[#8A672C] text-lg font-bold tracking-tight text-[#16100C] shadow-[0_8px_20px_-6px_rgba(176,138,74,0.65)]">
            TV
          </span>
          {!compact ? (
            <span className="min-w-0">
              <span className="block truncate text-[12px] font-semibold tracking-[0.14em] text-[#FBF7EF]">
                TRYVIBE ATELIER
              </span>
              <span className="mt-0.5 block truncate font-mono text-[9px] uppercase tracking-[0.22em] text-[#EBCF8F]/75">
                ENTERPRISE ADMIN
              </span>
            </span>
          ) : null}
        </button>

        {!compact ? (
          <button
            type="button"
            data-testid="sidebar-collapse-btn"
            onClick={handleToggleSidebar}
            aria-label="Thu gọn thanh điều hướng"
            title="Thu gọn thanh điều hướng"
            className="hidden h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-[#B08A4A]/25 bg-[#231912] text-[#EBCF8F]/80 transition-colors hover:border-[#EBCF8F]/55 hover:text-[#FBF7EF] lg:flex"
          >
            <ChevronLeftIcon size={15} />
          </button>
        ) : null}
      </div>

      {/* Expand button when collapsed on desktop */}
      {compact ? (
        <div className="hidden justify-center border-b border-[#B08A4A]/15 py-2 lg:flex">
          <button
            type="button"
            data-testid="sidebar-collapse-btn"
            onClick={handleToggleSidebar}
            aria-label="Mở rộng thanh điều hướng"
            title="Mở rộng thanh điều hướng"
            className="flex h-7 w-7 items-center justify-center rounded-lg border border-[#B08A4A]/25 bg-[#231912] text-[#EBCF8F]/80 transition-colors hover:border-[#EBCF8F]/55 hover:text-[#FBF7EF]"
          >
            <ChevronRightIcon size={15} />
          </button>
        </div>
      ) : null}

      {/* Grouped Navigation Sections (4 Collapsible Groups, Zero Horizontal Overflow) */}
      <nav
        aria-label="Phân hệ điều hành TryVibe Atelier"
        className="adm-sidebar-scroll flex-1 space-y-4 overflow-x-hidden overflow-y-auto px-2.5 py-4"
      >
        {visibleNavGroups.map((group) => {
          const isGroupCollapsed =
            !compact && Boolean(collapsedNavGroups[group.id]);
          return (
          <div key={group.id}>
            {!compact ? (
              <button
                type="button"
                onClick={() => handleToggleNavGroup(group.id)}
                aria-expanded={!isGroupCollapsed}
                className="mb-1.5 flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1 text-left text-[10px] font-semibold uppercase tracking-[0.18em] text-[#B08A4A]/80 transition-colors hover:bg-[#221912] hover:text-[#EBCF8F]"
              >
                <span className="truncate">{group.label}</span>
                <ChevronDownIcon
                  size={12}
                  className={`shrink-0 transition-transform duration-150 ${
                    isGroupCollapsed ? '-rotate-90' : ''
                  }`}
                />
              </button>
            ) : (
              <div className="mx-auto mb-2 h-px w-7 bg-[#B08A4A]/25" />
            )}

            {!isGroupCollapsed ? (
            <div className="space-y-1">
              {group.items.map((item) => {
                const isActive = effectiveTab === item.key;

                // Resolve live numeric badge or static tag badge
                let dynamicCount: number | null = null;
                let dynamicClass = '';
                if (
                  item.key === 'orders' &&
                  liveBadges.pendingOrdersRma > 0
                ) {
                  dynamicCount = liveBadges.pendingOrdersRma;
                  dynamicClass =
                    'bg-[#D9822B] text-[#16100C] border border-[#F2A65A]/60 font-bold';
                } else if (
                  item.key === 'inventory' &&
                  liveBadges.lowStockCount > 0
                ) {
                  dynamicCount = liveBadges.lowStockCount;
                  dynamicClass =
                    'border border-amber-400/45 bg-amber-500/20 text-amber-300 font-semibold';
                } else if (
                  item.key === 'procurement' &&
                  liveBadges.openPoCount > 0
                ) {
                  dynamicCount = liveBadges.openPoCount;
                  dynamicClass =
                    'border border-[#EBCF8F]/35 bg-[#B08A4A]/22 text-[#EBCF8F] font-semibold';
                }

                return (
                  <button
                    key={item.key}
                    type="button"
                    data-testid={`nav-item-${item.key}`}
                    onClick={() => handleNavigateTab(item.key)}
                    title={compact ? item.label : undefined}
                    className={`group relative flex w-full items-center rounded-xl border text-left text-[12.5px] transition-all duration-150 ${
                      compact
                        ? 'justify-center px-2 py-2.5'
                        : 'justify-between gap-2 px-3 py-2.5'
                    } ${
                      isActive
                        ? 'border-[#EBCF8F]/45 bg-[#B08A4A]/18 font-medium text-[#FBF7EF] shadow-[inset_0_0_24px_rgba(235,207,143,0.08)]'
                        : 'border-transparent text-[#D6C7B6]/82 hover:border-[#B08A4A]/20 hover:bg-[#221912] hover:text-[#FBF7EF]'
                    }`}
                  >
                    <span className="flex min-w-0 items-center gap-2.5">
                      <AdminNavIcon
                        tab={item.key}
                        size={17}
                        className={`shrink-0 transition-colors ${
                          isActive
                            ? 'text-[#EBCF8F]'
                            : 'text-[#B08A4A]/75 group-hover:text-[#EBCF8F]'
                        }`}
                      />
                      {!compact ? (
                        <span className="truncate">{item.label}</span>
                      ) : null}
                    </span>

                    {!compact ? (
                      <span className="flex shrink-0 items-center gap-1">
                        {dynamicCount !== null ? (
                          <span
                            className={`adm-tabular min-w-[20px] rounded-md px-1.5 py-0.5 text-center font-mono text-[10px] leading-none ${dynamicClass}`}
                          >
                            {dynamicCount}
                          </span>
                        ) : item.badgeText ? (
                          <span
                            className={`rounded-md border px-1.5 py-0.5 font-mono text-[9.5px] font-semibold leading-none tracking-[0.04em] ${getBadgeToneClasses(item.badgeTone)}`}
                          >
                            {item.badgeText}
                          </span>
                        ) : item.key === 'reports' ? (
                          <ChevronRightIcon
                            size={13}
                            className="text-[#B08A4A]/60"
                          />
                        ) : null}
                      </span>
                    ) : dynamicCount !== null ? (
                      <span className="absolute top-1.5 right-1.5 h-2 w-2 rounded-full bg-[#D9822B] ring-2 ring-[#16100C]" />
                    ) : null}
                  </button>
                );
              })}

              {/* Quick Copilot Launcher inside AI HUB group */}
              {group.id === 'ai_hub' ? (
                <button
                  type="button"
                  data-testid="nav-item-copilot"
                  onClick={() => {
                    setDrawerOpen(true);
                    setMobileNavOpen(false);
                  }}
                  title={compact ? 'Trợ lý MCP Copilot' : undefined}
                  className={`group flex w-full items-center rounded-xl border text-left text-[12.5px] transition-all duration-150 ${
                    compact
                      ? 'justify-center px-2 py-2.5'
                      : 'justify-between gap-2 px-3 py-2.5'
                  } ${
                    drawerOpen
                      ? 'border-[#EBCF8F]/45 bg-[#B08A4A]/18 font-medium text-[#FBF7EF]'
                      : 'border-transparent text-[#D6C7B6]/82 hover:border-[#B08A4A]/20 hover:bg-[#221912] hover:text-[#FBF7EF]'
                  }`}
                >
                  <span className="flex min-w-0 items-center gap-2.5">
                    <BotIcon
                      size={17}
                      className="shrink-0 text-[#EBCF8F]/85 group-hover:text-[#EBCF8F]"
                    />
                    {!compact ? (
                      <span className="truncate">Trợ lý MCP Copilot</span>
                    ) : null}
                  </span>
                  {!compact ? (
                    <span className="rounded-md border border-[#EBCF8F]/40 bg-[#B08A4A]/20 px-1.5 py-0.5 font-mono text-[9.5px] font-semibold leading-none text-[#EBCF8F]">
                      MCP
                    </span>
                  ) : null}
                </button>
              ) : null}
            </div>
            ) : null}
          </div>
          );
        })}

        {/* Ensure MCP Copilot shortcut is always reachable even for roles without AI Hub tabs */}
        {!hasAiHubGroup ? (
          <div>
            {!compact ? (
              <p className="mb-1.5 px-2.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-[#B08A4A]/75">
                TRÍ TUỆ NHÂN TẠO (AI HUB)
              </p>
            ) : (
              <div className="mx-auto mb-2 h-px w-7 bg-[#B08A4A]/25" />
            )}
            <button
              type="button"
              data-testid="nav-item-copilot"
              onClick={() => {
                setDrawerOpen(true);
                setMobileNavOpen(false);
              }}
              title={compact ? 'Trợ lý MCP Copilot' : undefined}
              className={`group flex w-full items-center rounded-xl border border-transparent text-left text-[12.5px] text-[#D6C7B6]/82 transition-all hover:border-[#B08A4A]/20 hover:bg-[#221912] hover:text-[#FBF7EF] ${
                compact
                  ? 'justify-center px-2 py-2.5'
                  : 'justify-between gap-2 px-3 py-2.5'
              }`}
            >
              <span className="flex min-w-0 items-center gap-2.5">
                <BotIcon size={17} className="shrink-0 text-[#EBCF8F]" />
                {!compact ? (
                  <span className="truncate">Trợ lý MCP Copilot</span>
                ) : null}
              </span>
              {!compact ? (
                <span className="rounded-md border border-[#EBCF8F]/40 bg-[#B08A4A]/20 px-1.5 py-0.5 font-mono text-[9.5px] font-semibold leading-none text-[#EBCF8F]">
                  MCP
                </span>
              ) : null}
            </button>
          </div>
        ) : null}
      </nav>

      {/* Sidebar Footer: Live Storefront Link */}
      <div className="shrink-0 border-t border-[#B08A4A]/20 p-3">
        <a
          href={STOREFRONT_LIVE_URL}
          target="_blank"
          rel="noreferrer"
          title="Xem Storefront Live"
          className={`flex items-center rounded-xl border border-[#B08A4A]/25 bg-[#1F1711] text-[12px] text-[#EBCF8F]/90 transition-colors hover:border-[#EBCF8F]/55 hover:bg-[#2A1E17] hover:text-[#FBF7EF] ${
            compact ? 'justify-center p-2.5' : 'justify-between gap-2 px-3 py-2.5'
          }`}
        >
          <span className="flex min-w-0 items-center gap-2">
            <ExternalLinkIcon size={15} className="shrink-0 text-[#EBCF8F]" />
            {!compact ? (
              <span className="truncate font-medium">Xem Storefront Live</span>
            ) : null}
          </span>
          {!compact ? (
            <span className="font-mono text-[10px] text-[#EBCF8F]/60">↗</span>
          ) : null}
        </a>
      </div>
    </div>
  );

  // Pre-auth / 2FA / 403 Minimal Luxury Header (zero dashboard shell or Copilot leakage!)
  const renderPreAuthHeader = () => (
    <header className="border-b border-[#B08A4A]/25 bg-[#16100C] px-6 py-4 text-[#FBF7EF]">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <span className="font-editorial flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-[#EBCF8F] via-[#B08A4A] to-[#8A672C] text-xl font-bold text-[#16100C] shadow-md">
            TV
          </span>
          <div>
            <p className="ledger-eyebrow text-[#EBCF8F]">
              {Portal.ADMIN_PORTAL} · Zero-Trust Operational Ledger
            </p>
            <h1 className="font-editorial text-2xl font-normal tracking-wide text-[#FBF7EF]">
              TryVibe Atelier · Enterprise Admin
            </h1>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2.5 text-xs">
          <span
            className={`inline-flex items-center gap-1.5 rounded-full border px-3.5 py-1.5 font-mono text-[11px] ${
              bffOnline
                ? 'border-emerald-400/35 bg-emerald-950/60 text-emerald-300'
                : 'border-amber-400/40 bg-amber-950/50 text-amber-200'
            }`}
          >
            <span
              className={`h-2 w-2 rounded-full ${
                bffOnline ? 'bg-emerald-400' : 'bg-amber-400'
              }`}
            />
            {bffOnline ? 'BFF Live (:4000)' : 'BFF Ngoại tuyến (:4000)'}
          </span>

          {session ? (
            <>
              <span className="rounded-full border border-[#B08A4A]/40 bg-[#231912] px-3.5 py-1.5 font-mono text-[11px] text-[#FBF7EF]">
                {session.user.email} · {roles.join(', ')}
              </span>
              <button
                type="button"
                onClick={() => void handleLogout()}
                className="rounded-full border border-[#EBCF8F]/50 px-4 py-1.5 text-[11px] uppercase tracking-[0.14em] text-[#EBCF8F] transition-colors hover:bg-[#B08A4A] hover:text-[#16100C]"
              >
                Đăng xuất
              </button>
            </>
          ) : null}
        </div>
      </div>
    </header>
  );

  // Unauthenticated / Hydrating / Pre-2FA Gate Views
  if (!hydrated) {
    return (
      <div className="flex min-h-screen flex-col bg-[#F7F1E6] text-[#1C1410]">
        {renderPreAuthHeader()}
        <main className="flex flex-1 items-center justify-center px-6 py-12">
          <div className="rounded-2xl border border-[#B08A4A]/30 bg-[#FFFDF9] px-6 py-4 text-xs text-[#7A6A5B] shadow-sm">
            Đang khởi tạo phiên điều hành TryVibe Atelier...
          </div>
        </main>
        <PortalToastBanner />
      </div>
    );
  }

  if (!session) {
    return (
      <div className="flex min-h-screen flex-col bg-[#F7F1E6] text-[#1C1410]">
        {renderPreAuthHeader()}

        <main className="flex flex-1 items-center justify-center px-4 py-8 sm:px-6 lg:py-12">
          <section className="grid w-full max-w-5xl overflow-hidden rounded-3xl border border-[#B08A4A]/35 bg-[#FFFDF9] shadow-[0_28px_72px_-24px_rgba(28,20,16,0.22)] lg:grid-cols-[1.02fr_1fr]">
            {/* Left Editorial Quiet Luxury Brand Showcase */}
            <div className="relative flex flex-col justify-between bg-gradient-to-br from-[#19120D] via-[#241A13] to-[#130D09] p-8 text-[#FBF7EF] sm:p-10">
              <div
                aria-hidden="true"
                className="pointer-events-none absolute -top-24 -right-24 h-64 w-64 rounded-full bg-[#B08A4A]/18 blur-3xl"
              />
              <div className="relative">
                <div className="inline-flex items-center gap-2 rounded-full border border-[#EBCF8F]/35 bg-[#2A1E17]/90 px-3 py-1 font-mono text-[10px] tracking-[0.16em] text-[#EBCF8F]">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                  TRYVIBE ATELIER · ENTERPRISE ADMIN
                </div>

                <h2 className="font-editorial mt-6 text-4xl font-light leading-tight text-[#FBF7EF] sm:text-[42px]">
                  Trung Tâm Chỉ Huy &amp; Sổ Cái Vận Hành
                </h2>

                <p className="mt-4 text-xs leading-relaxed text-[#EBD9B4]/80">
                  Cổng quản trị tách biệt vật lý cho bộ sưu tập thời trang may
                  đo, tồn kho đa chi nhánh, đơn hàng &amp; đổi size RMA, thu mua
                  B2B và phòng thử đồ AI cục bộ.
                </p>

                <ul className="mt-7 space-y-3 text-xs text-[#FBF7EF]/85">
                  <li className="flex items-start gap-2.5">
                    <CheckCircleIcon
                      size={16}
                      className="mt-0.5 shrink-0 text-[#EBCF8F]"
                    />
                    <span>
                      Xác thực <strong>RS256 JWKS</strong> kết hợp{' '}
                      <strong>Dual 2FA</strong> (Email OTP / TOTP QR) cho cấp
                      quản trị &amp; kho.
                    </span>
                  </li>
                  <li className="flex items-start gap-2.5">
                    <CheckCircleIcon
                      size={16}
                      className="mt-0.5 shrink-0 text-[#EBCF8F]"
                    />
                    <span>
                      Trợ lý điều hành{' '}
                      <strong>Ollama Qwen 2.5 · MCP Copilot</strong> chạy 100%
                      nội bộ, khóa ghi ở trạng thái{' '}
                      <code className="text-[#EBCF8F]">NHAP_AI</code>.
                    </span>
                  </li>
                  <li className="flex items-start gap-2.5">
                    <CheckCircleIcon
                      size={16}
                      className="mt-0.5 shrink-0 text-[#EBCF8F]"
                    />
                    <span>
                      Cách ly cứng <strong>RBAC</strong> — chặn tuyệt đối tài
                      khoản <code>CUSTOMER</code> và <code>SUPPLIER</code>.
                    </span>
                  </li>
                </ul>
              </div>

              <div className="relative mt-8 flex flex-wrap items-center justify-between gap-2 border-t border-[#B08A4A]/20 pt-5 font-mono text-[10px] text-[#EBCF8F]/75">
                <span>BFF Gateway :4000 · Ollama :11434</span>
                <span>
                  {bffOnline ? '● Sẵn sàng kết nối' : '○ Chế độ ngoại tuyến'}
                </span>
              </div>
            </div>

            {/* Right Login Form Panel */}
            <div className="p-8 sm:p-10">
              <p className="ledger-eyebrow text-[#8A672C]">
                Xác thực nội bộ · RS256 JWKS + Dual 2FA
              </p>
              <h2 className="font-editorial mt-2 text-4xl font-light text-[#1C1410]">
                Đăng nhập Sổ cái
              </h2>
              <p className="mt-2 text-xs leading-relaxed text-[#7A6A5B]">
                Đăng nhập trực tiếp qua{' '}
                <code className="rounded bg-[#F4EBDA] px-1.5 py-0.5 text-[#1C1410]">
                  POST /api/v1/auth/login
                </code>
                . Vai trò <code>SUPER_ADMIN</code> &amp;{' '}
                <code>WAREHOUSE_MANAGER</code> bắt buộc qua cổng 2FA trước khi
                mở không gian điều hành.
              </p>

              {ENABLE_DEV_LOGIN ? (
                <div className="mt-4 flex flex-wrap gap-1.5">
                  {QUICK_DEV_ACCOUNTS.map((acc) => (
                    <button
                      key={acc.email}
                      type="button"
                      onClick={() => {
                        setEmail(acc.email);
                        setPassword('Atelier@2026!');
                      }}
                      className="rounded-full border border-[#B08A4A]/35 bg-[#FBF7EF] px-2.5 py-1 font-mono text-[10px] text-[#5C4B41] transition-colors hover:border-[#1C1410] hover:bg-[#F4EBDA]"
                    >
                      {acc.label}
                    </button>
                  ))}
                </div>
              ) : null}

              <form onSubmit={handleLoginSubmit} className="mt-6 space-y-4">
                <label className="block text-xs">
                  <span className="font-medium uppercase tracking-[0.16em] text-[#8A672C]">
                    Email nội bộ
                  </span>
                  <input
                    type="email"
                    required
                    placeholder="admin@atelier.local"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="mt-1.5 w-full rounded-2xl border border-[#B08A4A]/35 bg-[#FBF7EF] px-4 py-3 text-sm text-[#1C1410] outline-none transition-colors focus:border-[#8A672C] focus:bg-white"
                  />
                </label>

                <label className="block text-xs">
                  <span className="font-medium uppercase tracking-[0.16em] text-[#8A672C]">
                    Mật khẩu
                  </span>
                  <input
                    type="password"
                    required
                    placeholder="Nhập mật khẩu tài khoản nội bộ"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="mt-1.5 w-full rounded-2xl border border-[#B08A4A]/35 bg-[#FBF7EF] px-4 py-3 text-sm text-[#1C1410] outline-none transition-colors focus:border-[#8A672C] focus:bg-white"
                  />
                </label>

                {loginError ? (
                  <p
                    role="alert"
                    data-testid="admin-login-error-alert"
                    className="rounded-xl border border-[#8B2E2E]/35 bg-[#FFF5F4] px-4 py-2.5 text-xs leading-relaxed text-[#8B2E2E]"
                  >
                    {loginError}
                  </p>
                ) : null}

                {oauthExchanging ? (
                  <div
                    role="status"
                    data-testid="admin-oauth-exchanging-banner"
                    className="flex items-center gap-2.5 rounded-xl border border-[#B08A4A]/40 bg-[#F4EBDA]/80 px-4 py-2.5 text-xs text-[#5C4630]"
                  >
                    <span className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-[#B08A4A] border-t-transparent" />
                    <span>Đang hoàn tất xác thực nhanh quản trị...</span>
                  </div>
                ) : null}

                <button
                  type="submit"
                  disabled={
                    loginLoading || oauthExchanging || oauthRedirecting !== null
                  }
                  className="w-full rounded-full bg-[#1C1410] py-3.5 text-xs font-medium uppercase tracking-[0.2em] text-[#EBCF8F] shadow-md transition-all hover:bg-[#2A1E17] disabled:opacity-55"
                >
                  {loginLoading
                    ? 'Đang xác thực...'
                    : oauthExchanging
                      ? 'Đang hoàn tất xác thực nhanh...'
                      : 'Đăng nhập Admin Portal'}
                </button>
              </form>

              {/* Admin OAuth2 Quick-Login Section */}
              <div className="mt-6">
                <div className="relative flex items-center">
                  <div className="flex-1 border-t border-[#B08A4A]/25" />
                  <span className="px-3 text-[10.5px] font-medium uppercase tracking-[0.18em] text-[#8A672C]/90">
                    hoặc đăng nhập nhanh quản trị
                  </span>
                  <div className="flex-1 border-t border-[#B08A4A]/25" />
                </div>

                <div className="mt-4 space-y-2.5">
                  <button
                    type="button"
                    data-testid="admin-oauth-google-btn"
                    disabled={
                      loginLoading ||
                      oauthExchanging ||
                      oauthRedirecting !== null
                    }
                    onClick={() => handleAdminOAuthStart('google')}
                    className="flex w-full items-center justify-center gap-3 rounded-2xl border border-[#B08A4A]/40 bg-white px-4 py-3 text-[13px] font-medium text-[#1C1410] shadow-[0_6px_18px_-14px_rgba(28,20,16,0.35)] transition-all duration-200 hover:-translate-y-[0.5px] hover:border-[#8A672C]/70 hover:bg-[#F4EBDA] hover:shadow-[0_12px_26px_-16px_rgba(28,20,16,0.45)] disabled:cursor-not-allowed disabled:opacity-55"
                  >
                    <AdminGoogleIcon />
                    <span>
                      {oauthRedirecting === 'google'
                        ? 'Đang chuyển tới Google...'
                        : 'Đăng nhập nhanh Quản trị bằng Google'}
                    </span>
                  </button>

                  <button
                    type="button"
                    data-testid="admin-oauth-github-btn"
                    disabled={
                      loginLoading ||
                      oauthExchanging ||
                      oauthRedirecting !== null
                    }
                    onClick={() => handleAdminOAuthStart('github')}
                    className={`flex w-full items-center justify-center gap-2.5 rounded-2xl border px-4 py-2.5 text-[12.5px] font-medium transition-all duration-200 disabled:cursor-not-allowed disabled:opacity-55 ${
                      oauthProvidersLoaded && !oauthProviders?.github?.enabled
                        ? 'border-[#B08A4A]/28 bg-[#FAF5EB] text-[#5C4B41] hover:border-[#B08A4A]/55 hover:bg-[#F4EBDA]'
                        : 'border-[#1C1410]/20 bg-[#231A15] text-[#FBF7EF] hover:border-[#B08A4A]/55 hover:bg-[#1C1410]'
                    }`}
                  >
                    <AdminGitHubIcon />
                    <span>
                      {oauthRedirecting === 'github'
                        ? 'Đang chuyển tới GitHub...'
                        : 'GitHub'}
                    </span>
                    {oauthProvidersLoaded &&
                    !oauthProviders?.github?.enabled ? (
                      <span className="rounded-full border border-[#B08A4A]/35 bg-white/80 px-2 py-0.5 text-[10px] font-normal text-[#8A672C]">
                        Chưa cấu hình khóa GitHub
                      </span>
                    ) : null}
                  </button>
                </div>

                {oauthConfigHint ? (
                  <p
                    role="status"
                    data-testid="admin-oauth-config-hint"
                    className="mt-3 rounded-2xl border border-[#B08A4A]/40 bg-[#FFF9EC] px-3.5 py-2.5 text-[11px] leading-relaxed text-[#6B4E1F]"
                  >
                    {oauthConfigHint}
                  </p>
                ) : null}

                <p
                  data-testid="admin-oauth-policy-caption"
                  className="mt-3.5 rounded-2xl border border-[#B08A4A]/22 bg-[#FBF7EF] px-3.5 py-2.5 text-[11px] leading-relaxed text-[#6E5D4F]"
                >
                  Đặc quyền Admin (Google &amp; GitHub): cho phép{' '}
                  <code className="rounded bg-[#F4EBDA] px-1 py-0.5 text-[10.5px] text-[#1C1410]">
                    lebao01121@gmail.com
                  </code>{' '}
                  đăng nhập nhanh giữ nguyên vai trò{' '}
                  <code className="rounded bg-[#F4EBDA] px-1 py-0.5 text-[10.5px] text-[#8A672C]">
                    SUPER_ADMIN
                  </code>
                  .
                </p>
              </div>
            </div>
          </section>
        </main>

        <PortalToastBanner />
      </div>
    );
  }

  // Authenticated session: strictly wrap ENTIRE Dashboard Shell + McpCopilotDrawer inside AdminRoleGuard + TwoFactorGate!
  return (
    <div
      className={`min-h-screen transition-colors duration-200 ${
        isDark
          ? 'atelier-admin-dark bg-[#110C09] text-[#FBF7EF]'
          : 'bg-[#F7F1E6] text-[#1C1410]'
      }`}
    >
      {/* Keep pre-auth header ONLY when blocked by RoleGuard or pending 2FA */}
      {!isAllowed || !isTwoFactorSatisfied ? renderPreAuthHeader() : null}

      <AdminRoleGuard roles={roles} onSignOut={() => void handleLogout()}>
        <TwoFactorGate
          roles={roles}
          email={session.user.email}
          mfaRequired={session.mfaRequired}
          mfaVerified={session.mfaVerified}
          onMfaSuccess={handleMfaSuccess}
        >
          {/* Full Enterprise Command Dashboard Shell (Image 1 Geometry + Image 2 Atelier Aesthetic) */}
          <div className="flex min-h-screen w-full">
            {/* Desktop Sticky Espresso Sidebar */}
            <aside
              data-testid="admin-sidebar"
              aria-label="Thanh điều hướng trái"
              className={`hidden border-r border-[#B08A4A]/20 bg-[#16100C] transition-[width] duration-200 ease-out lg:sticky lg:top-0 lg:flex lg:h-screen lg:shrink-0 lg:flex-col ${
                sidebarCollapsed ? 'w-[74px]' : 'w-[256px]'
              }`}
            >
              {renderSidebarNavigation(sidebarCollapsed)}
            </aside>

            {/* Mobile Slide-Over Sidebar */}
            {mobileNavOpen ? (
              <div className="fixed inset-0 z-50 flex lg:hidden">
                <div
                  aria-hidden="true"
                  onClick={() => setMobileNavOpen(false)}
                  className="fixed inset-0 bg-[#0D0805]/60 backdrop-blur-[2px]"
                />
                <aside
                  aria-label="Thanh điều hướng di động"
                  className="relative z-10 flex h-full w-[264px] flex-col border-r border-[#B08A4A]/25 bg-[#16100C] shadow-2xl"
                >
                  {renderSidebarNavigation(false)}
                </aside>
              </div>
            ) : null}

            {/* Right Main Column: Sticky Top Command Bar + Main Content Canvas */}
            <div className="flex min-w-0 flex-1 flex-col">
              {/* Sticky Enterprise Top Command Bar (64px) */}
              <header
                data-testid="admin-topbar"
                className={`sticky top-0 z-30 flex min-h-[64px] items-center justify-between gap-3 border-b px-4 py-2 backdrop-blur-md transition-colors lg:px-5 ${
                  isDark
                    ? 'border-[#B08A4A]/20 bg-[#16100C]/94 text-[#FBF7EF]'
                    : 'border-[#B08A4A]/22 bg-[#FFFDF9]/94 text-[#1C1410]'
                }`}
              >
                {/* Left Cluster: Mobile Menu + Title + BFF Live Pill + Route Chip + Subtitle */}
                <div className="flex min-w-0 items-center gap-2.5">
                  <button
                    type="button"
                    onClick={() => setMobileNavOpen(true)}
                    aria-label="Mở menu điều hướng"
                    className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border lg:hidden ${
                      isDark
                        ? 'border-[#B08A4A]/30 bg-[#231912] text-[#EBCF8F]'
                        : 'border-[#B08A4A]/30 bg-[#FBF7EF] text-[#1C1410]'
                    }`}
                  >
                    <MenuIcon size={18} />
                  </button>

                  <div className="min-w-0">
                    <div className="flex flex-nowrap items-center gap-2">
                      <h1 className="truncate whitespace-nowrap text-[14px] font-semibold tracking-tight sm:text-[15px]">
                        {currentNavItem.label}
                      </h1>

                      <span
                        className={`adm-tabular inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 font-mono text-[10px] font-medium ${
                          bffOnline
                            ? isDark
                              ? 'border-emerald-400/30 bg-emerald-950/60 text-emerald-300'
                              : 'border-emerald-600/25 bg-emerald-50 text-emerald-800'
                            : isDark
                              ? 'border-amber-400/35 bg-amber-950/50 text-amber-300'
                              : 'border-amber-600/30 bg-amber-50 text-amber-800'
                        }`}
                      >
                        <span className="relative flex h-2 w-2 items-center justify-center">
                          {bffOnline ? (
                            <>
                              <span
                                aria-hidden="true"
                                className="telemetry-anim telemetry-beacon-ring absolute inset-0 rounded-full bg-emerald-400/75"
                              />
                              <span
                                aria-hidden="true"
                                className="telemetry-anim telemetry-beacon-ring-delay absolute inset-0 rounded-full bg-emerald-400/60"
                              />
                            </>
                          ) : null}
                          <span
                            className={`relative h-1.5 w-1.5 rounded-full ${
                              bffOnline ? 'bg-emerald-500' : 'bg-amber-500'
                            }`}
                          />
                        </span>
                        {bffOnline
                          ? `BFF Live (:4000) · ${servicesReadyDisplay}/${servicesTotalDisplay} Online`
                          : 'BFF Ngoại tuyến (:4000)'}
                      </span>

                      <span
                        className={`hidden shrink-0 whitespace-nowrap rounded-md border px-1.5 py-0.5 font-mono text-[10px] xl:inline-flex ${
                          isDark
                            ? 'border-[#B08A4A]/25 bg-[#231912] text-[#EBCF8F]/80'
                            : 'border-[#B08A4A]/25 bg-[#FBF7EF] text-[#8A672C]'
                        }`}
                      >
                        /admin/{effectiveTab}
                      </span>
                    </div>

                    <p
                      className={`mt-0.5 hidden truncate text-[11px] sm:block ${
                        isDark ? 'text-[#C2B3A3]/80' : 'text-[#7A6A5B]'
                      }`}
                    >
                      Hệ thống Quản trị &amp; Sổ cái Vận hành TryVibe Fashion
                      Atelier · BFF :4000 &amp; Ollama qwen2.5:3b
                    </p>
                  </div>
                </div>

                {/* Right Cluster: Warehouse + Refresh + Quick Jumps + Theme + Alerts + User Pill */}
                <div className="flex shrink-0 items-center gap-1.5">
                  {/* Warehouse Context Chip */}
                  <span
                    title="Kho Trung Tâm · Hà Nội"
                    className={`hidden items-center gap-1.5 rounded-xl border px-2.5 py-1.5 text-[10.5px] font-medium xl:inline-flex ${
                      isDark
                        ? 'border-[#B08A4A]/25 bg-[#231912] text-[#EBCF8F]'
                        : 'border-[#B08A4A]/28 bg-[#FBF7EF] text-[#5C4B41]'
                    }`}
                  >
                    <span className="h-1.5 w-1.5 rounded-full bg-[#B08A4A]" />
                    <span>
                      Kho Trung Tâm
                      <span className="hidden 2xl:inline"> · Hà Nội</span>
                    </span>
                  </span>

                  {/* Refresh Button */}
                  <button
                    type="button"
                    data-testid="admin-refresh-btn"
                    onClick={handleManualRefresh}
                    title="Làm mới dữ liệu sổ cái & tổng quan"
                    className={`inline-flex items-center gap-1.5 rounded-xl border px-2.5 py-1.5 text-[10.5px] font-medium transition-colors ${
                      isDark
                        ? 'border-[#B08A4A]/28 bg-[#231912] text-[#FBF7EF] hover:border-[#EBCF8F]/55 hover:bg-[#2E2118]'
                        : 'border-[#B08A4A]/28 bg-white text-[#1C1410] hover:border-[#8A672C] hover:bg-[#FBF7EF]'
                    }`}
                  >
                    <RefreshIcon
                      size={13}
                      className={
                        refreshing || bgSyncing
                          ? 'telemetry-anim telemetry-refresh-spin text-[#B08A4A]'
                          : ''
                      }
                    />
                    <span className="hidden sm:inline">Làm mới</span>
                  </button>

                  {/* Live GPU Telemetry Motion Toggle Pill */}
                  <LiveMotionTogglePill
                    compact
                    tone={isDark ? 'dark' : 'light'}
                  />

                  {/* Role-Permitted Quick Jump Buttons (shown at 2xl+ so 1440px topbar stays single-line) */}
                  {canSeeLookbook ? (
                    <button
                      type="button"
                      onClick={() => handleNavigateTab('lookbook')}
                      className={`hidden items-center gap-1 rounded-xl border px-2 py-1.5 text-[10.5px] font-medium transition-colors 2xl:inline-flex ${
                        effectiveTab === 'lookbook'
                          ? isDark
                            ? 'border-[#EBCF8F]/60 bg-[#B08A4A]/22 text-[#EBCF8F]'
                            : 'border-[#B08A4A] bg-[#B08A4A]/18 text-[#8A672C]'
                          : isDark
                            ? 'border-[#B08A4A]/30 bg-[#231912] text-[#EBCF8F] hover:border-[#EBCF8F]/60'
                            : 'border-[#B08A4A]/35 bg-[#FBF7EF] text-[#8A672C] hover:border-[#8A672C] hover:bg-[#F4EBDA]'
                      }`}
                    >
                      <SparklesIcon size={12} />
                      <span>Lookbook AI</span>
                    </button>
                  ) : null}

                  {canSeeOrders ? (
                    <button
                      type="button"
                      onClick={() => handleNavigateTab('orders')}
                      className={`hidden items-center gap-1 rounded-xl border px-2 py-1.5 text-[10.5px] font-medium transition-colors 2xl:inline-flex ${
                        effectiveTab === 'orders'
                          ? 'border-[#1C1410] bg-[#1C1410] text-[#EBCF8F]'
                          : isDark
                            ? 'border-[#B08A4A]/30 bg-[#231912] text-[#FBF7EF] hover:border-[#EBCF8F]/60'
                            : 'border-[#B08A4A]/35 bg-[#FBF7EF] text-[#1C1410] hover:border-[#8A672C] hover:bg-[#F4EBDA]'
                      }`}
                    >
                      <BoxIcon size={12} />
                      <span>Đơn &amp; RMA</span>
                    </button>
                  ) : null}

                  {/* Theme Toggle: Kem Atelier <-> Espresso Tối */}
                  <button
                    type="button"
                    data-testid="admin-theme-toggle"
                    onClick={handleToggleTheme}
                    title={
                      isDark
                        ? 'Chuyển sang giao diện sáng Kem Atelier'
                        : 'Chuyển sang giao diện tối Espresso Tối'
                    }
                    className={`inline-flex items-center gap-1.5 rounded-xl border px-2.5 py-1.5 text-[10.5px] font-medium transition-colors ${
                      isDark
                        ? 'border-[#EBCF8F]/35 bg-[#261B14] text-[#EBCF8F] hover:border-[#EBCF8F]/70'
                        : 'border-[#B08A4A]/30 bg-[#FBF7EF] text-[#1C1410] hover:border-[#8A672C] hover:bg-[#F4EBDA]'
                    }`}
                  >
                    {isDark ? <MoonIcon size={13} /> : <SunIcon size={13} />}
                    <span className="hidden md:inline">
                      {isDark ? 'Espresso Tối' : 'Kem Atelier'}
                    </span>
                  </button>

                  {/* Notification Bell + Actionable Alerts Popover */}
                  <div ref={alertsContainerRef} className="relative">
                    <button
                      type="button"
                      data-testid="admin-alerts-btn"
                      onClick={() => setAlertsOpen((prev) => !prev)}
                      aria-label="Cảnh báo vận hành"
                      aria-expanded={alertsOpen}
                      className={`relative flex h-8 w-8 items-center justify-center rounded-xl border transition-colors ${
                        alertsOpen
                          ? 'border-[#B08A4A] bg-[#B08A4A]/18 text-[#B08A4A]'
                          : isDark
                            ? 'border-[#B08A4A]/28 bg-[#231912] text-[#EBCF8F] hover:border-[#EBCF8F]/60'
                            : 'border-[#B08A4A]/28 bg-white text-[#1C1410] hover:border-[#8A672C] hover:bg-[#FBF7EF]'
                      }`}
                    >
                      <BellIcon size={15} />
                      {totalAlertCount > 0 ? (
                        <span
                          className={`adm-tabular absolute -top-1 -right-1 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-[#D9822B] px-1 font-mono text-[9px] font-bold text-[#16100C] ring-2 ${
                            isDark ? 'ring-[#16100C]' : 'ring-[#FFFDF9]'
                          }`}
                        >
                          {totalAlertCount > 99 ? '99+' : totalAlertCount}
                        </span>
                      ) : null}
                    </button>

                    {alertsOpen ? (
                      <div
                        data-testid="admin-alerts-popover"
                        role="dialog"
                        aria-label="Danh sách cảnh báo vận hành"
                        className={`absolute right-0 mt-2 w-80 overflow-hidden rounded-2xl border shadow-2xl ${
                          isDark
                            ? 'border-[#B08A4A]/35 bg-[#1A130E] text-[#FBF7EF]'
                            : 'border-[#B08A4A]/35 bg-[#FFFDF9] text-[#1C1410]'
                        }`}
                      >
                        <div
                          className={`flex items-center justify-between border-b px-4 py-3 ${
                            isDark
                              ? 'border-[#B08A4A]/20 bg-[#231912]'
                              : 'border-[#B08A4A]/18 bg-[#FBF7EF]'
                          }`}
                        >
                          <div className="flex items-center gap-2">
                            <AlertTriangleIcon
                              size={15}
                              className="text-[#B08A4A]"
                            />
                            <span className="text-xs font-semibold">
                              Cảnh báo Vận hành
                            </span>
                          </div>
                          <span className="adm-tabular rounded-full bg-[#B08A4A]/20 px-2 py-0.5 font-mono text-[10px] font-semibold text-[#B08A4A]">
                            {totalAlertCount} mục
                          </span>
                        </div>

                        <div className="divide-y divide-[#B08A4A]/15 p-2">
                          <button
                            type="button"
                            disabled={!canSeeOrders}
                            onClick={() => handleNavigateTab('orders')}
                            className={`flex w-full items-center justify-between gap-2 rounded-xl px-3 py-2.5 text-left text-xs transition-colors disabled:opacity-50 ${
                              isDark
                                ? 'hover:bg-[#261B14]'
                                : 'hover:bg-[#FBF7EF]'
                            }`}
                          >
                            <div>
                              <p className="font-medium">
                                Đơn hàng &amp; RMA chờ duyệt
                              </p>
                              <p
                                className={`text-[10.5px] ${
                                  isDark ? 'text-[#C2B3A3]' : 'text-[#7A6A5B]'
                                }`}
                              >
                                Kiểm tra đóng gói &amp; duyệt đổi size QC
                              </p>
                            </div>
                            <span
                              className={`adm-tabular shrink-0 rounded-full px-2 py-0.5 font-mono text-[10px] font-semibold ${
                                liveBadges.pendingOrdersRma > 0
                                  ? 'bg-[#D9822B]/20 text-[#D9822B]'
                                  : 'bg-emerald-500/15 text-emerald-600'
                              }`}
                            >
                              {liveBadges.pendingOrdersRma}
                            </span>
                          </button>

                          <button
                            type="button"
                            disabled={!canSeeInventory}
                            onClick={() => handleNavigateTab('inventory')}
                            className={`flex w-full items-center justify-between gap-2 rounded-xl px-3 py-2.5 text-left text-xs transition-colors disabled:opacity-50 ${
                              isDark
                                ? 'hover:bg-[#261B14]'
                                : 'hover:bg-[#FBF7EF]'
                            }`}
                          >
                            <div>
                              <p className="font-medium">
                                SKU sắp hết / tồn kho thấp
                              </p>
                              <p
                                className={`text-[10.5px] ${
                                  isDark ? 'text-[#C2B3A3]' : 'text-[#7A6A5B]'
                                }`}
                              >
                                Xem sổ cái đa kho &amp; giữ chỗ 15 phút
                              </p>
                            </div>
                            <span
                              className={`adm-tabular shrink-0 rounded-full px-2 py-0.5 font-mono text-[10px] font-semibold ${
                                liveBadges.lowStockCount > 0
                                  ? 'bg-amber-500/20 text-amber-600'
                                  : 'bg-emerald-500/15 text-emerald-600'
                              }`}
                            >
                              {liveBadges.lowStockCount}
                            </span>
                          </button>

                          <button
                            type="button"
                            disabled={!canSeeProcurement}
                            onClick={() => handleNavigateTab('procurement')}
                            className={`flex w-full items-center justify-between gap-2 rounded-xl px-3 py-2.5 text-left text-xs transition-colors disabled:opacity-50 ${
                              isDark
                                ? 'hover:bg-[#261B14]'
                                : 'hover:bg-[#FBF7EF]'
                            }`}
                          >
                            <div>
                              <p className="font-medium">
                                Đơn thu mua B2B (PO / NHAP_AI)
                              </p>
                              <p
                                className={`text-[10.5px] ${
                                  isDark ? 'text-[#C2B3A3]' : 'text-[#7A6A5B]'
                                }`}
                              >
                                Duyệt phát hành PO &amp; nghiệm thu GRN
                              </p>
                            </div>
                            <span
                              className={`adm-tabular shrink-0 rounded-full px-2 py-0.5 font-mono text-[10px] font-semibold ${
                                liveBadges.openPoCount > 0
                                  ? 'bg-[#B08A4A]/20 text-[#8A672C]'
                                  : 'bg-emerald-500/15 text-emerald-600'
                              }`}
                            >
                              {liveBadges.openPoCount}
                            </span>
                          </button>
                        </div>

                        <div
                          className={`flex items-center justify-between border-t px-4 py-2.5 text-[10.5px] ${
                            isDark
                              ? 'border-[#B08A4A]/20 bg-[#16100C] text-[#C2B3A3]'
                              : 'border-[#B08A4A]/18 bg-[#FBF7EF] text-[#7A6A5B]'
                          }`}
                        >
                          <span>
                            Cụm dịch vụ: {servicesReadyDisplay}/
                            {servicesTotalDisplay} Online
                          </span>
                          {canSeeOps ? (
                            <button
                              type="button"
                              onClick={() => handleNavigateTab('ops')}
                              className="font-medium text-[#B08A4A] hover:underline"
                            >
                              Mở AI Ops →
                            </button>
                          ) : null}
                        </div>
                      </div>
                    ) : null}
                  </div>

                  {/* User Account Pill + Sign Out */}
                  <div
                    className={`flex items-center gap-2 rounded-xl border px-1.5 py-1 ${
                      isDark
                        ? 'border-[#B08A4A]/28 bg-[#231912]'
                        : 'border-[#B08A4A]/28 bg-[#FBF7EF]'
                    }`}
                  >
                    <span
                      title={`${session.user.email} (${roles.join(', ')})`}
                      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-[#B08A4A] to-[#8A672C] font-mono text-[10.5px] font-bold text-[#FBF7EF]"
                    >
                      {getUserMonogram(session.user.email)}
                    </span>

                    <div className="hidden max-w-[96px] leading-tight lg:block">
                      <p
                        title={session.user.email}
                        className="truncate text-[10.5px] font-semibold"
                      >
                        {session.user.email.split('@')[0]}
                      </p>
                      <p
                        className={`truncate font-mono text-[9px] ${
                          isDark ? 'text-[#EBCF8F]/80' : 'text-[#8A672C]'
                        }`}
                      >
                        {getRoleShortLabel(primaryRole)}
                      </p>
                    </div>

                    <button
                      type="button"
                      onClick={() => void handleLogout()}
                      className={`rounded-lg border px-2 py-1 text-[10px] font-medium uppercase tracking-[0.1em] transition-colors ${
                        isDark
                          ? 'border-[#EBCF8F]/35 text-[#EBCF8F] hover:bg-[#B08A4A] hover:text-[#16100C]'
                          : 'border-[#B08A4A]/40 bg-white text-[#1C1410] hover:bg-[#1C1410] hover:text-[#EBCF8F]'
                      }`}
                    >
                      Đăng xuất
                    </button>
                  </div>
                </div>
                {refreshing || bgSyncing ? (
                  <span
                    aria-hidden="true"
                    data-testid="admin-sync-sweep-bar"
                    className="telemetry-anim telemetry-sync-bar"
                  />
                ) : null}
              </header>

              {/* Main Content Canvas */}
              <main className="flex-1 px-4 py-5 sm:px-6 lg:px-7 lg:py-6">
                <div
                  key={effectiveTab}
                  className="telemetry-tab-enter mx-auto max-w-[1440px] pb-20"
                >
                  {effectiveTab === 'dashboard' ? (
                    <DashboardOverviewTab
                      roles={roles}
                      userEmail={session.user.email}
                      bffOnline={bffOnline}
                      liveOverview={liveOverview}
                      onNavigateTab={handleNavigateTab}
                      onOpenCopilot={() => setDrawerOpen(true)}
                      refreshNonce={refreshNonce}
                      syncTick={syncTick}
                      darkMode={isDark}
                      onLiveBadgesChange={handleLiveBadgesChange}
                    />
                  ) : null}

                  {effectiveTab === 'customers' ? (
                    <CrmModerationTab
                      key={`customers-${refreshNonce}`}
                      roles={roles}
                      darkMode={isDark}
                      onRefreshOverview={handleTriggerRefreshOverview}
                    />
                  ) : null}

                  {effectiveTab === 'tryon-hub' ? (
                    <AiTryOnAnalyticsTab
                      key={`tryon-${refreshNonce}`}
                      onOpenCopilotWithPrompt={handleOpenCopilotWithPrompt}
                      onNavigateLookbook={
                        canSeeLookbook
                          ? () => handleNavigateTab('lookbook')
                          : undefined
                      }
                      darkMode={isDark}
                    />
                  ) : null}

                  {effectiveTab === 'reports' ? (
                    <AnalyticsBiTab
                      key={`reports-${refreshNonce}`}
                      roles={roles}
                      darkMode={isDark}
                    />
                  ) : null}

                  {effectiveTab === 'payments' ? (
                    <PaymentLedgerTab
                      key={`payments-${refreshNonce}`}
                      roles={roles}
                      session={session}
                      mfaVerified={session.mfaVerified}
                      darkMode={isDark}
                      onNotify={emitPortalToast}
                      onRefreshOverview={handleTriggerRefreshOverview}
                    />
                  ) : null}

                  {effectiveTab === 'promotions' ? (
                    <PromotionsTab
                      key={`promotions-${refreshNonce}`}
                      roles={roles}
                      session={session}
                      mfaVerified={session.mfaVerified}
                      darkMode={isDark}
                      onNotify={emitPortalToast}
                      onRefreshOverview={handleTriggerRefreshOverview}
                    />
                  ) : null}

                  {effectiveTab === 'categories' ? (
                    <CategorySizeChartTab
                      key={`categories-${refreshNonce}`}
                      roles={roles}
                      session={session}
                      mfaVerified={session.mfaVerified}
                      darkMode={isDark}
                      onNotify={emitPortalToast}
                      onRefreshOverview={handleTriggerRefreshOverview}
                    />
                  ) : null}

                  {effectiveTab === 'campaign' ? (
                    <EditorialCmsTab
                      key={`campaign-${refreshNonce}`}
                      roles={roles}
                      session={session}
                      mfaVerified={session.mfaVerified}
                      darkMode={isDark}
                      onNotify={emitPortalToast}
                      onRefreshOverview={handleTriggerRefreshOverview}
                    />
                  ) : null}

                  {effectiveTab === 'rag-kb' ? (
                    <RagKnowledgeBaseTab
                      key={`rag-kb-${refreshNonce}`}
                      roles={roles}
                      mfaVerified={session.mfaVerified}
                      darkMode={isDark}
                      onNotify={emitPortalToast}
                      onRefreshOverview={handleTriggerRefreshOverview}
                    />
                  ) : null}

                  {/* Light-Surface Operational Ledger Modules */}
                  {effectiveTab !== 'dashboard' &&
                  effectiveTab !== 'customers' &&
                  effectiveTab !== 'tryon-hub' &&
                  effectiveTab !== 'reports' &&
                  effectiveTab !== 'payments' &&
                  effectiveTab !== 'promotions' &&
                  effectiveTab !== 'categories' &&
                  effectiveTab !== 'campaign' &&
                  effectiveTab !== 'rag-kb' ? (
                    <div className={isDark ? 'text-[#2B2019]' : undefined}>
                      {effectiveTab === 'iam' ? (
                        <IamAuditTab
                          key={`iam-${refreshNonce}`}
                          roles={roles}
                          mfaVerified={session.mfaVerified}
                          currentUserId={session.user.id}
                          darkMode={isDark}
                          onRefreshOverview={handleTriggerRefreshOverview}
                        />
                      ) : null}
                      {effectiveTab === 'ops' ? (
                        <AiOpsHealthTab
                          key={`ops-${refreshNonce}`}
                          roles={roles}
                          mfaVerified={session.mfaVerified}
                        />
                      ) : null}
                      {effectiveTab === 'orders' ? (
                        <OrdersRmaTab
                          key={`orders-${refreshNonce}`}
                          roles={roles}
                          darkMode={isDark}
                          onRefreshOverview={handleTriggerRefreshOverview}
                        />
                      ) : null}
                      {effectiveTab === 'procurement' ? (
                        <ProcurementTab
                          key={`procurement-${refreshNonce}`}
                          roles={roles}
                          darkMode={isDark}
                          onRefreshOverview={handleTriggerRefreshOverview}
                        />
                      ) : null}
                      {effectiveTab === 'inventory' ? (
                        <InventoryLedgerTab
                          key={`inventory-${refreshNonce}`}
                          roles={roles}
                          darkMode={isDark}
                          onRefreshOverview={handleTriggerRefreshOverview}
                        />
                      ) : null}
                      {effectiveTab === 'catalog' ? (
                        <CatalogMatrixTab
                          key={`catalog-${refreshNonce}`}
                          roles={roles}
                          session={session}
                          mfaVerified={session.mfaVerified}
                          darkMode={isDark}
                          onNotify={emitPortalToast}
                          onRefreshOverview={handleTriggerRefreshOverview}
                        />
                      ) : null}
                      {effectiveTab === 'media' ? (
                        <MediaStudioTab
                          key={`media-${refreshNonce}`}
                          roles={roles}
                          session={session}
                          mfaVerified={session.mfaVerified}
                          darkMode={isDark}
                          onNotify={emitPortalToast}
                          onRefreshOverview={handleTriggerRefreshOverview}
                        />
                      ) : null}
                      {effectiveTab === 'lookbook' ? (
                        <AiLookbookStudioTab key={`lookbook-${refreshNonce}`} />
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </main>
            </div>

            {/* 2FA-Gated Floating Bottom-Right MCP Copilot Launcher & Slide-Over Drawer */}
            {isAllowed && isTwoFactorSatisfied ? (
              <McpCopilotDrawer
                activeRole={primaryRole}
                twoFactorVerified={session.mfaVerified}
                isOpen={drawerOpen}
                onToggleOpen={() => setDrawerOpen((prev) => !prev)}
                initialPrompt={pendingCopilotPrompt}
                onConsumeInitialPrompt={handleConsumeInitialPrompt}
                onPromotionApproved={() => handleTriggerRefreshOverview()}
                onRefreshOverview={handleTriggerRefreshOverview}
              />
            ) : null}
          </div>
        </TwoFactorGate>
      </AdminRoleGuard>

      <PortalToastBanner />
    </div>
  );
}
