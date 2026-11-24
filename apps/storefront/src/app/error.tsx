'use client';

import Link from 'next/link';
import { useEffect } from 'react';

export interface StorefrontErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function StorefrontError({
  error,
  reset,
}: StorefrontErrorProps) {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production') {
      console.error('[StorefrontError]', error);
    }
  }, [error]);

  return (
    <section
      className="relative flex min-h-[100svh] items-center justify-center overflow-hidden bg-[#FBF7EF] px-6 py-24 text-[#2B2019]"
      role="alert"
      aria-live="assertive"
      data-nav-theme="light"
    >
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'radial-gradient(ellipse 55% 45% at 50% 25%, rgba(235, 207, 143, 0.28), transparent 72%), radial-gradient(ellipse 70% 50% at 50% 95%, rgba(176, 138, 74, 0.14), transparent 75%)',
        }}
        aria-hidden="true"
      />

      <div className="relative z-10 w-full max-w-xl rounded-[32px] border border-[#B08A4A]/35 bg-[#F4EBDA]/65 p-8 text-center shadow-[0_30px_80px_-40px_rgba(28,20,16,0.35)] backdrop-blur-md sm:p-12">
        <div className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-full border border-[#B08A4A]/45 bg-[#1C1410] font-editorial text-xl tracking-wider text-[#EBCF8F]">
          T&amp;X
        </div>

        <p className="atelier-eyebrow text-[#8A672C]">
          Tầm Xuân · Fashion Atelier
        </p>

        <h1 className="font-editorial mt-3 text-4xl leading-tight font-light text-[#1C1410] sm:text-5xl">
          Không gian đang tạm gián đoạn
        </h1>

        <p className="mx-auto mt-4 max-w-md text-sm leading-relaxed text-[#7A6A5B]">
          Một chi tiết hiển thị vừa gặp sự cố ngoài dự kiến. Bạn có thể tải lại
          trang ngay lập tức hoặc quay về phòng trưng bày chính của nhà mốt.
        </p>

        {error?.digest ? (
          <p className="mt-4 inline-block rounded-full border border-[#B08A4A]/30 bg-[#FBF7EF] px-3.5 py-1 font-mono text-[11px] text-[#8A672C]">
            Mã tham chiếu: {error.digest}
          </p>
        ) : null}

        <div className="mt-8 flex flex-wrap items-center justify-center gap-3.5">
          <button
            type="button"
            onClick={reset}
            className="rounded-full bg-[#1C1410] px-7 py-3 text-xs font-medium tracking-[0.2em] uppercase text-[#EBCF8F] transition-colors hover:bg-[#2A1E17]"
          >
            Thử tải lại
          </button>

          <Link
            href="/"
            className="rounded-full border border-[#B08A4A] bg-[#FBF7EF] px-7 py-3 text-xs font-medium tracking-[0.2em] uppercase text-[#2B2019] transition-colors hover:border-[#8A672C] hover:bg-[#EBD9B4]/40"
          >
            Về Trang Chủ
          </Link>
        </div>
      </div>
    </section>
  );
}
