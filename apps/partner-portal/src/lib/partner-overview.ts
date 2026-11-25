import { Portal, type Role } from '@atelier/contracts';

export const LOCKED_SUPPLIER_ID = 'sup-atelier-silk-01';
export const LOCKED_SUPPLIER_NAME =
  'Xưởng Dệt Lụa Bảo Lộc · Silk Heritage Co., Ltd.';

export interface PartnerOverviewStatus {
  source: 'live-bff' | 'offline-fallback';
  bffOnline: boolean;
  portal: Portal;
  supplierId: string;
  bffUrl: string;
  message: string;
}

export interface PartnerLiveOverviewData {
  portal: typeof Portal.PARTNER_PORTAL;
  phase: string;
  supplierId: string;
  actor: {
    id: string;
    email: string;
    mfaVerified: boolean;
  };
  rbac: {
    allowedRoles: readonly Role[];
    blockedRoles: readonly string[];
    twoFactorRequired: boolean;
  };
  tenantIsolation: {
    scopeField: 'supplier_id';
    boundSupplierId: string;
    crossSupplierQueryAllowed: false;
    poApprovalRule: 'ONLY_ADMIN_APPROVED_POS_VISIBLE';
  };
  b2bSummary: {
    submissionsTotal: number;
    purchaseOrdersAwaitingConfirmation: number;
    scheduledGrnDeliveries: number;
    activeFabricLots: number;
    onTimeFulfillmentSlaPct: number;
  };
  generatedAt: string;
}

export async function fetchPartnerOverviewStatus(): Promise<PartnerOverviewStatus> {
  const publicBffUrl =
    process.env.NEXT_PUBLIC_BFF_URL?.replace(/\/$/, '') ||
    'http://localhost:4000';
  const probeBffUrl =
    process.env.BFF_URL?.replace(/\/$/, '') ||
    publicBffUrl.replace('://localhost', '://127.0.0.1');

  const fallback: PartnerOverviewStatus = {
    source: 'offline-fallback',
    bffOnline: false,
    portal: Portal.PARTNER_PORTAL,
    supplierId: LOCKED_SUPPLIER_ID,
    bffUrl: publicBffUrl,
    message: 'Cổng đối tác đang chạy chế độ độc lập (BFF :4000 ngoại tuyến)',
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
        portal: Portal.PARTNER_PORTAL,
        supplierId: LOCKED_SUPPLIER_ID,
        bffUrl: publicBffUrl,
        message: 'Kết nối trực tiếp Partner BFF (:4000 /health OK)',
      };
    }

    return fallback;
  } catch {
    return fallback;
  }
}
