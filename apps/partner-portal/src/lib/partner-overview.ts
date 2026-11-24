import { Portal } from '@atelier/contracts';

export const LOCKED_SUPPLIER_ID = 'sup-atelier-silk-01';
export const LOCKED_SUPPLIER_NAME =
  'Xưởng Dệt Lụa Bảo Lộc · Silk Heritage Co., Ltd.';

export interface PartnerOverviewStatus {
  source: 'live-bff' | 'offline-fallback';
  portal: Portal;
  supplierId: string;
  bffUrl: string;
  message: string;
}

export async function fetchPartnerOverviewStatus(): Promise<PartnerOverviewStatus> {
  const bffUrl =
    process.env.NEXT_PUBLIC_BFF_URL?.replace(/\/$/, '') ||
    'http://localhost:4000';

  const fallback: PartnerOverviewStatus = {
    source: 'offline-fallback',
    portal: Portal.PARTNER_PORTAL,
    supplierId: LOCKED_SUPPLIER_ID,
    bffUrl,
    message: 'Cổng đối tác đang chạy chế độ độc lập (BFF :4000 ngoại tuyến)',
  };

  try {
    const res = await fetch(`${bffUrl}/api/v1/partner/overview`, {
      cache: 'no-store',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(2000),
    });

    if (!res.ok) {
      return fallback;
    }

    return {
      source: 'live-bff',
      portal: Portal.PARTNER_PORTAL,
      supplierId: LOCKED_SUPPLIER_ID,
      bffUrl,
      message: 'Kết nối trực tiếp Partner BFF (/api/v1/partner/overview)',
    };
  } catch {
    return fallback;
  }
}
