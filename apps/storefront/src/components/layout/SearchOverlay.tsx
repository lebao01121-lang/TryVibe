'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { OccasionLookbookDto, ProductSpuDto } from '@atelier/contracts';
import { useScrollLock } from '@atelier/motion-kit';
import { apiFetch } from '@/lib/api-client';
import {
  FORMAT_VND,
  OCCASION_CATALOG,
  extractProductArray,
} from '@/lib/catalog-data';

export interface SearchOverlayProps {
  open: boolean;
  onClose: () => void;
}

interface OccasionMatch {
  slug: string;
  name: string;
  tagline: string;
}

function foldVietnamese(input: string): string {
  return input
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase();
}

export function SearchOverlay({ open, onClose }: SearchOverlayProps) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<ProductSpuDto[]>([]);
  const [allOccasions, setAllOccasions] = useState<OccasionMatch[]>(
    OCCASION_CATALOG.map((o) => ({
      slug: o.slug,
      name: o.title,
      tagline: o.tagline,
    })),
  );
  const [searching, setSearching] = useState(false);

  useScrollLock(open);

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();

    let cancelled = false;
    void (async () => {
      const occRes = await apiFetch<
        OccasionLookbookDto[] | { items: OccasionLookbookDto[] }
      >('/bff/v1/storefront/occasions', { skipAuthRefresh: true });
      if (!cancelled && occRes.ok && occRes.data) {
        const list = Array.isArray(occRes.data)
          ? occRes.data
          : occRes.data.items ?? [];
        if (list.length > 0) {
          setAllOccasions(
            list.map((o) => ({
              slug: o.slug,
              name: o.name,
              tagline: o.tagline,
            })),
          );
        }
      }
    })();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      cancelled = true;
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return;
    const trimmed = query.trim();
    if (!trimmed) {
      setResults([]);
      setSearching(false);
      return;
    }

    setSearching(true);
    const timer = window.setTimeout(async () => {
      const res = await apiFetch<unknown>(
        `/bff/v1/storefront/products?q=${encodeURIComponent(trimmed)}&limit=8`,
        { skipAuthRefresh: true },
      );
      if (res.ok && res.data) {
        setResults(extractProductArray(res.data).slice(0, 8));
      } else {
        setResults([]);
      }
      setSearching(false);
    }, 200);

    return () => window.clearTimeout(timer);
  }, [query, open]);

  if (!open) return null;

  const foldedQuery = foldVietnamese(query.trim());
  const matchingOccasions = foldedQuery
    ? allOccasions.filter(
        (occ) =>
          foldVietnamese(occ.name).includes(foldedQuery) ||
          foldVietnamese(occ.tagline).includes(foldedQuery) ||
          occ.slug.includes(foldedQuery),
      )
    : [];

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = query.trim();
    onClose();
    router.push(
      trimmed ? `/bo-suu-tap?q=${encodeURIComponent(trimmed)}` : '/bo-suu-tap',
    );
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Tìm kiếm trang phục Atelier"
      data-lenis-prevent=""
      className="fixed inset-0 z-[85] flex items-start justify-center bg-[#1C1410]/80 px-4 pt-24 backdrop-blur-md"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-2xl overflow-hidden rounded-3xl border border-[#B08A4A]/40 bg-[#FBF7EF] text-[#2B2019] shadow-2xl">
        <form
          onSubmit={handleSubmit}
          className="flex items-center gap-3 border-b border-[#B08A4A]/20 px-6 py-4"
        >
          <input
            ref={inputRef}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Tìm không dấu: ao blazer, vay di tiec, cong so... (Phím / hoặc Ctrl+K)"
            className="flex-1 bg-transparent font-editorial text-2xl text-[#1C1410] placeholder-[#7A6A5B]/70 outline-none"
          />
          <button
            type="submit"
            className="rounded-full bg-[#1C1410] px-5 py-2 text-[11px] uppercase tracking-[0.18em] text-[#EBCF8F]"
          >
            Tìm
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="Đóng tìm kiếm"
            className="flex h-9 w-9 items-center justify-center rounded-full border border-[#B08A4A]/40 text-lg text-[#8A672C]"
          >
            ×
          </button>
        </form>

        <div className="max-h-[420px] overflow-y-auto p-5">
          {!query.trim() ? (
            <div className="space-y-4 text-xs text-[#7A6A5B]">
              <div>
                <p className="eyebrow">
                  Từ khóa Meilisearch tiếng Việt không dấu
                </p>
                <div className="mt-2.5 flex flex-wrap gap-2">
                  {[
                    'ao blazer',
                    'ao so mi lua',
                    'vay di tiec',
                    'quan tay',
                  ].map((kw) => (
                    <button
                      key={kw}
                      type="button"
                      onClick={() => setQuery(kw)}
                      className="rounded-full border border-[#B08A4A]/35 bg-[#F4EBDA]/60 px-3.5 py-1.5 text-xs text-[#2B2019] hover:border-[#8A672C]"
                    >
                      {kw}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <p className="eyebrow">Dịp mặc (Dress Code)</p>
                <div className="mt-2.5 flex flex-wrap gap-2">
                  {allOccasions.slice(0, 6).map((occ) => (
                    <Link
                      key={occ.slug}
                      href={`/bo-suu-tap/${occ.slug}`}
                      onClick={onClose}
                      className="rounded-full border border-[#B08A4A]/25 bg-white px-3.5 py-1.5 text-xs text-[#2B2019] hover:border-[#8A672C]"
                    >
                      {occ.name}
                    </Link>
                  ))}
                </div>
              </div>
            </div>
          ) : searching ? (
            <p className="py-6 text-center text-xs text-[#7A6A5B]">
              Đang tìm kiếm trên Meilisearch...
            </p>
          ) : (
            <div className="space-y-5">
              {matchingOccasions.length > 0 ? (
                <div>
                  <p className="eyebrow mb-2">Dịp mặc phù hợp</p>
                  <div className="flex flex-wrap gap-2">
                    {matchingOccasions.map((occ) => (
                      <Link
                        key={occ.slug}
                        href={`/bo-suu-tap/${occ.slug}`}
                        onClick={onClose}
                        className="rounded-2xl border border-[#B08A4A]/35 bg-[#F4EBDA]/70 px-3.5 py-2 text-xs text-[#1C1410] hover:border-[#8A672C]"
                      >
                        <strong>{occ.name}</strong>
                        <span className="ml-2 text-[#7A6A5B]">→</span>
                      </Link>
                    ))}
                  </div>
                </div>
              ) : null}

              <div>
                <p className="eyebrow mb-2">
                  Sản phẩm phù hợp ({results.length})
                </p>
                {results.length > 0 ? (
                  <ul className="divide-y divide-[#B08A4A]/15">
                    {results.map((item) => (
                      <li key={item.id}>
                        <Link
                          href={`/san-pham/${item.slug}`}
                          onClick={onClose}
                          className="flex items-center justify-between gap-4 py-3 text-xs transition-colors hover:text-[#8A672C]"
                        >
                          <div>
                            <p className="font-editorial text-xl text-[#1C1410]">
                              {item.name}
                            </p>
                            <p className="text-[11px] text-[#7A6A5B]">
                              {item.categoryName} · {item.fabricComposition}
                            </p>
                          </div>
                          <span className="shrink-0 font-editorial text-lg text-[#8A672C]">
                            {FORMAT_VND(item.minPriceVnd)}
                          </span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="py-4 text-center text-xs text-[#7A6A5B]">
                    Không có thiết kế khớp từ khóa &ldquo;{query}&rdquo;.
                  </p>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
