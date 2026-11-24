'use client';

import { useEffect } from 'react';

interface AdminErrorBoundaryProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function AdminPortalError({
  error,
  reset,
}: AdminErrorBoundaryProps) {
  useEffect(() => {
    // Keep error traceable in browser diagnostics during operational support
    console.error('[admin-portal] boundary caught:', error);
  }, [error]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#FBF7EF] px-6 py-16 text-[#2B2019]">
      <div className="w-full max-w-lg rounded-3xl border border-[#B08A4A]/40 bg-white p-8 shadow-sm">
        <p className="ledger-eyebrow text-[#8B2E2E]">
          ADMIN_PORTAL · Runtime Boundary
        </p>
        <h1 className="font-editorial mt-2 text-4xl font-light text-[#1C1410]">
          Phân hệ điều hành gặp gián đoạn tạm thời
        </h1>
        <p className="mt-3 text-xs leading-relaxed text-[#5C4B41]">
          {error.message ||
            'Đã xảy ra sự cố hiển thị ngoài dự kiến. Dữ liệu sổ cái an toàn — bạn có thể khôi phục phiên làm việc ngay bên dưới.'}
        </p>
        {error.digest ? (
          <p className="mt-3 rounded-xl bg-[#F4EBDA]/70 px-3 py-2 font-mono text-[11px] text-[#7A6A5B]">
            Mã truy vết: {error.digest}
          </p>
        ) : null}
        <div className="mt-6 flex flex-wrap gap-3">
          <button
            type="button"
            onClick={reset}
            className="rounded-full bg-[#1C1410] px-6 py-2.5 text-xs font-medium uppercase tracking-[0.16em] text-[#EBCF8F]"
          >
            Thử tải lại phân hệ
          </button>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="rounded-full border border-[#B08A4A]/45 px-5 py-2.5 text-xs text-[#2B2019]"
          >
            Tải lại toàn trang
          </button>
        </div>
      </div>
    </div>
  );
}
