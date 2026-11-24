'use client';

import { useEffect } from 'react';

const CHUNK_RELOAD_STORAGE_KEY = 'atelier_chunk_reload_ts';
const CHUNK_RELOAD_TTL_MS = 15_000;

function isChunkLoadError(
  error: (Error & { digest?: string }) | null | undefined,
): boolean {
  if (!error) return false;
  if (error.name === 'ChunkLoadError') return true;
  const message = typeof error.message === 'string' ? error.message : '';
  return /Loading chunk [\w-]+ failed|Failed to fetch dynamically imported module|Importing a module script failed/i.test(
    message,
  );
}

export interface GlobalErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function GlobalError({ error, reset }: GlobalErrorProps) {
  const chunkError = isChunkLoadError(error);

  useEffect(() => {
    if (process.env.NODE_ENV !== 'production') {
      console.error('[GlobalStorefrontError]', error);
    }

    if (!chunkError || typeof window === 'undefined') {
      return;
    }

    try {
      const now = Date.now();
      const rawLast = window.sessionStorage.getItem(CHUNK_RELOAD_STORAGE_KEY);
      const lastTs = rawLast ? Number.parseInt(rawLast, 10) : 0;
      if (!Number.isFinite(lastTs) || now - lastTs > CHUNK_RELOAD_TTL_MS) {
        window.sessionStorage.setItem(CHUNK_RELOAD_STORAGE_KEY, String(now));
        window.location.reload();
      }
    } catch {
      // Ignore storage errors in restricted browsing contexts
    }
  }, [chunkError, error]);

  const handleRetry = () => {
    if (chunkError && typeof window !== 'undefined') {
      window.location.reload();
      return;
    }
    reset();
  };

  return (
    <html lang="vi">
      <body
        style={{
          margin: 0,
          minHeight: '100svh',
          backgroundColor: '#FBF7EF',
          color: '#2B2019',
          fontFamily: 'system-ui, -apple-system, sans-serif',
        }}
      >
        <section
          className="relative flex min-h-[100svh] items-center justify-center overflow-hidden bg-[#FBF7EF] px-6 py-24 text-[#2B2019]"
          role="alert"
          aria-live="assertive"
          style={{
            position: 'relative',
            display: 'flex',
            minHeight: '100svh',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '6rem 1.5rem',
            backgroundColor: '#FBF7EF',
            color: '#2B2019',
          }}
        >
          <div
            className="pointer-events-none absolute inset-0"
            style={{
              position: 'absolute',
              inset: 0,
              pointerEvents: 'none',
              background:
                'radial-gradient(ellipse 55% 45% at 50% 25%, rgba(235, 207, 143, 0.28), transparent 72%), radial-gradient(ellipse 70% 50% at 50% 95%, rgba(176, 138, 74, 0.14), transparent 75%)',
            }}
            aria-hidden="true"
          />

          <div
            className="relative z-10 w-full max-w-xl rounded-[32px] border border-[#B08A4A]/35 bg-[#F4EBDA]/75 p-8 text-center shadow-[0_30px_80px_-40px_rgba(28,20,16,0.35)] backdrop-blur-md sm:p-12"
            style={{
              position: 'relative',
              zIndex: 10,
              width: '100%',
              maxWidth: '36rem',
              borderRadius: '32px',
              border: '1px solid rgba(176, 138, 74, 0.35)',
              backgroundColor: 'rgba(244, 235, 218, 0.8)',
              padding: '2.5rem 2rem',
              textAlign: 'center',
              boxShadow: '0 30px 80px -40px rgba(28, 20, 16, 0.35)',
            }}
          >
            <div
              className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-full border border-[#B08A4A]/45 bg-[#1C1410] font-editorial text-xl tracking-wider text-[#EBCF8F]"
              style={{
                margin: '0 auto 1.5rem',
                display: 'flex',
                height: '4rem',
                width: '4rem',
                alignItems: 'center',
                justifyContent: 'center',
                borderRadius: '9999px',
                border: '1px solid rgba(176, 138, 74, 0.45)',
                backgroundColor: '#1C1410',
                fontFamily: 'Georgia, "Times New Roman", serif',
                fontSize: '1.25rem',
                letterSpacing: '0.06em',
                color: '#EBCF8F',
              }}
            >
              T&amp;X
            </div>

            <p
              className="atelier-eyebrow text-[#8A672C]"
              style={{
                fontSize: '0.6875rem',
                letterSpacing: '0.28em',
                textTransform: 'uppercase',
                fontWeight: 500,
                color: '#8A672C',
                margin: 0,
              }}
            >
              Tầm Xuân · Fashion Atelier
            </p>

            <h1
              className="font-editorial mt-3 text-4xl leading-tight font-light text-[#1C1410] sm:text-5xl"
              style={{
                fontFamily: 'Georgia, "Times New Roman", serif',
                marginTop: '0.75rem',
                marginBottom: 0,
                fontSize: '2.5rem',
                lineHeight: 1.15,
                fontWeight: 300,
                color: '#1C1410',
              }}
            >
              Không gian đang tạm gián đoạn
            </h1>

            <p
              className="mx-auto mt-4 max-w-md text-sm leading-relaxed text-[#7A6A5B]"
              style={{
                margin: '1rem auto 0',
                maxWidth: '28rem',
                fontSize: '0.875rem',
                lineHeight: 1.65,
                color: '#7A6A5B',
              }}
            >
              Một chi tiết hiển thị vừa gặp sự cố ngoài dự kiến. Bạn có thể tải
              lại trang ngay lập tức hoặc quay về phòng trưng bày chính của nhà
              mốt.
            </p>

            {error?.digest ? (
              <p
                className="mt-4 inline-block rounded-full border border-[#B08A4A]/30 bg-[#FBF7EF] px-3.5 py-1 font-mono text-[11px] text-[#8A672C]"
                style={{
                  marginTop: '1rem',
                  display: 'inline-block',
                  borderRadius: '9999px',
                  border: '1px solid rgba(176, 138, 74, 0.3)',
                  backgroundColor: '#FBF7EF',
                  padding: '0.25rem 0.875rem',
                  fontFamily: 'monospace',
                  fontSize: '11px',
                  color: '#8A672C',
                }}
              >
                Mã tham chiếu: {error.digest}
              </p>
            ) : null}

            <div
              className="mt-8 flex flex-wrap items-center justify-center gap-3.5"
              style={{
                marginTop: '2rem',
                display: 'flex',
                flexWrap: 'wrap',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '0.875rem',
              }}
            >
              <button
                type="button"
                onClick={handleRetry}
                className="rounded-full bg-[#1C1410] px-7 py-3 text-xs font-medium tracking-[0.2em] uppercase text-[#EBCF8F] transition-colors hover:bg-[#2A1E17]"
                style={{
                  cursor: 'pointer',
                  border: 'none',
                  borderRadius: '9999px',
                  backgroundColor: '#1C1410',
                  padding: '0.75rem 1.75rem',
                  fontSize: '0.75rem',
                  fontWeight: 500,
                  letterSpacing: '0.2em',
                  textTransform: 'uppercase',
                  color: '#EBCF8F',
                }}
              >
                Thử tải lại
              </button>

              <a
                href="/"
                className="rounded-full border border-[#B08A4A] bg-[#FBF7EF] px-7 py-3 text-xs font-medium tracking-[0.2em] uppercase text-[#2B2019] transition-colors hover:border-[#8A672C] hover:bg-[#EBD9B4]/40"
                style={{
                  textDecoration: 'none',
                  borderRadius: '9999px',
                  border: '1px solid #B08A4A',
                  backgroundColor: '#FBF7EF',
                  padding: '0.75rem 1.75rem',
                  fontSize: '0.75rem',
                  fontWeight: 500,
                  letterSpacing: '0.2em',
                  textTransform: 'uppercase',
                  color: '#2B2019',
                }}
              >
                Về Trang Chủ
              </a>
            </div>
          </div>
        </section>
      </body>
    </html>
  );
}
