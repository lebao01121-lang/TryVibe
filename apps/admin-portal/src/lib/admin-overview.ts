import { Portal } from '@atelier/contracts';

export interface AdminOverviewStatus {
  source: 'live-bff' | 'offline-fallback';
  portal: Portal;
  bffUrl: string;
  message: string;
}

export async function fetchAdminOverviewStatus(): Promise<AdminOverviewStatus> {
  const bffUrl =
    process.env.NEXT_PUBLIC_BFF_URL?.replace(/\/$/, '') ||
    'http://localhost:4000';

  const fallback: AdminOverviewStatus = {
    source: 'offline-fallback',
    portal: Portal.ADMIN_PORTAL,
    bffUrl,
    message: 'Sổ cái đang chạy chế độ độc lập (BFF :4000 ngoại tuyến)',
  };

  try {
    const res = await fetch(`${bffUrl}/api/v1/admin/overview`, {
      cache: 'no-store',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(2000),
    });

    if (!res.ok) {
      return fallback;
    }

    return {
      source: 'live-bff',
      portal: Portal.ADMIN_PORTAL,
      bffUrl,
      message: 'Kết nối trực tiếp Admin BFF (/api/v1/admin/overview)',
    };
  } catch {
    return fallback;
  }
}
