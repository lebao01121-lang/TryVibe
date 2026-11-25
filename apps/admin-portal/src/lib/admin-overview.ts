import { Portal, type Role } from '@atelier/contracts';

export interface AdminOverviewStatus {
  source: 'live-bff' | 'offline-fallback';
  bffOnline: boolean;
  portal: Portal;
  bffUrl: string;
  message: string;
}

export interface AdminLiveOverviewModule {
  key: string;
  label: string;
  boundedContext: string;
  status: 'active' | 'degraded';
  pendingItems: number;
}

export interface AdminLiveOverviewMetrics {
  pendingSubmissions: number;
  lowStockSkus: number;
  outOfStockSkus: number;
  activeReservations: number;
  pendingAiDraftPos: number;
  totalOrders: number;
  pendingOrders: number;
  latePaymentAlerts: number;
  pendingRmas: number;
  totalRevenueVnd: number;
}

export interface AdminLiveOverviewData {
  portal: typeof Portal.ADMIN_PORTAL;
  phase: string;
  actor: {
    id: string;
    email: string;
    roles: readonly Role[];
    mfaVerified: boolean;
  };
  rbac: {
    allowedRoles: readonly Role[];
    blockedRoles: readonly string[];
    twoFactorRequired: boolean;
    costPricePermissionRequired: readonly string[];
  };
  aiGovernance: {
    draftStatusLock: 'NHAP_AI';
    autoAttachAsTryOnGarment: false;
    requiresHumanApproval: true;
  };
  liveMetrics?: AdminLiveOverviewMetrics;
  ledger: {
    title: string;
    modules: AdminLiveOverviewModule[];
  };
  generatedAt: string;
}

export async function fetchAdminOverviewStatus(): Promise<AdminOverviewStatus> {
  const publicBffUrl =
    process.env.NEXT_PUBLIC_BFF_URL?.replace(/\/$/, '') ||
    'http://localhost:4000';
  const probeBffUrl =
    process.env.BFF_URL?.replace(/\/$/, '') ||
    publicBffUrl.replace('://localhost', '://127.0.0.1');

  const fallback: AdminOverviewStatus = {
    source: 'offline-fallback',
    bffOnline: false,
    portal: Portal.ADMIN_PORTAL,
    bffUrl: publicBffUrl,
    message: 'Sổ cái đang chạy chế độ độc lập (BFF :4000 ngoại tuyến)',
  };

  try {
    // Public liveness probe during SSR (no Bearer JWT in sessionStorage yet)
    const healthRes = await fetch(`${probeBffUrl}/health`, {
      cache: 'no-store',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(2500),
    });

    if (healthRes.ok) {
      return {
        source: 'live-bff',
        bffOnline: true,
        portal: Portal.ADMIN_PORTAL,
        bffUrl: publicBffUrl,
        message: 'Kết nối trực tiếp Admin BFF (:4000 /health OK)',
      };
    }

    return fallback;
  } catch {
    return fallback;
  }
}
