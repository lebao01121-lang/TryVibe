'use client';

import type { PartnerOverviewStatus } from '@/lib/partner-overview';

export interface SupplierTenantBarProps {
  supplierId: string | null;
  supplierEmail?: string;
  twoFactorVerified: boolean;
  overviewStatus: PartnerOverviewStatus;
}

export function SupplierTenantBar({
  supplierId,
  supplierEmail,
  twoFactorVerified,
  overviewStatus,
}: SupplierTenantBarProps) {
  return (
    <div
      role="region"
      aria-label="Thanh ngữ cảnh cách ly tenant nhà cung cấp"
      className="border-b border-[#B08A4A]/35 bg-[#241A14] px-6 py-3 text-xs text-[#FBF7EF]"
    >
      <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <span className="inline-flex items-center gap-2 rounded-full border border-[#EBCF8F]/50 bg-[#1C1410] px-3.5 py-1 font-mono text-[11px] font-semibold text-[#EBCF8F]">
            <span className="h-2 w-2 rounded-full bg-[#EBCF8F]" />
            supplier_id: {supplierId ?? 'CHƯA ĐĂNG NHẬP'}
          </span>
          {supplierEmail ? (
            <span className="text-[#FBF7EF]/90">{supplierEmail}</span>
          ) : null}
          <span className="hidden text-[#FBF7EF]/55 md:inline">
            | Tenant JWT Lock · BFF tự ghi đè x-supplier-id từ token
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2.5 text-[11px]">
          <span
            className={`rounded-full px-3 py-1 font-mono ${
              twoFactorVerified
                ? 'bg-[#2E6B47]/30 text-[#9CE3B8]'
                : 'bg-[#8B2E2E]/40 text-[#FFD0C7]'
            }`}
          >
            2FA: {twoFactorVerified ? 'VERIFIED' : 'REQUIRED'}
          </span>
          <span className="rounded-full border border-[#B08A4A]/35 px-3 py-1 text-[#EBCF8F]/85">
            {overviewStatus.source === 'live-bff'
              ? 'BFF Live (:4000)'
              : 'Offline Fallback'}
          </span>
        </div>
      </div>
    </div>
  );
}
