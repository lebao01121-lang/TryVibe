'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { ProductSpuDto, UserSummaryDto } from '@atelier/contracts';
import {
  apiFetch,
  getStoredSession,
  subscribeSession,
} from '@/lib/api-client';
import { FORMAT_VND, extractProductArray } from '@/lib/catalog-data';

const NAV_ITEMS = [
  { href: '/bo-suu-tap', label: 'Bộ sưu tập' },
  { href: '/bo-suu-tap/ao-blazer', label: 'Áo & Blazer' },
  { href: '/bo-suu-tap/quan-chan-vay', label: 'Quần & Váy' },
  { href: '/bo-suu-tap/dam-du-tiec', label: 'Đầm' },
  { href: '/thu-do-ai', label: 'Phòng thử AI' },
] as const;

export function CustomerHeader() {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<ProductSpuDto[]>([]);
  const [searching, setSearching] = useState(false);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [user, setUser] = useState<UserSummaryDto | null>(null);
  const searchBoxRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const sync = () => {
      const session = getStoredSession();
      setUser(session?.user ?? null);
    };
    sync();
    return subscribeSession(sync);
  }, []);

  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      setResults([]);
      setSearching(false);
      return;
    }

    setSearching(true);
    const timer = window.setTimeout(async () => {
      const res = await apiFetch<unknown>(
        `/bff/v1/storefront/products?q=${encodeURIComponent(trimmed)}&limit=6`,
        { skipAuthRefresh: true },
      );
      if (res.ok && res.data) {
        setResults(extractProductArray(res.data).slice(0, 6));
      } else {
        setResults([]);
      }
      setSearching(false);
      setDropdownOpen(true);
    }, 200);

    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        searchBoxRef.current &&
        !searchBoxRef.current.contains(event.target as Node)
      ) {
        setDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleSearchSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = query.trim();
    setDropdownOpen(false);
    router.push(
      trimmed ? `/bo-suu-tap?q=${encodeURIComponent(trimmed)}` : '/bo-suu-tap',
    );
  };

  return (
    <header className="sticky top-0 z-40 border-b border-[#B08A4A]/25 bg-[#1C1410]/95 text-[#FBF7EF] backdrop-blur-md">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4 px-6 py-3.5 lg:px-10">
        <Link href="/" className="group flex flex-col leading-none">
          <span className="font-editorial text-2xl font-normal tracking-wider text-[#FBF7EF] transition-colors group-hover:text-[#EBCF8F]">
            Atelier
          </span>
          <span className="mt-0.5 text-[9px] uppercase tracking-[0.34em] text-[#EBCF8F]/80">
            Tầm Xuân · Hà Nội
          </span>
        </Link>

        <nav
          aria-label="Điều hướng chính"
          className="hidden items-center gap-6 lg:flex"
        >
          {NAV_ITEMS.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="text-[11px] uppercase tracking-[0.16em] text-[#FBF7EF]/85 transition-colors hover:text-[#EBCF8F]"
            >
              {item.label}
            </Link>
          ))}
        </nav>

        <div className="flex flex-1 items-center justify-end gap-3 lg:flex-initial">
          {/* Live Meilisearch Search Box (200ms debounce) */}
          <div ref={searchBoxRef} className="relative w-full max-w-xs sm:w-64">
            <form onSubmit={handleSearchSubmit}>
              <input
                type="search"
                value={query}
                onFocus={() => {
                  if (query.trim()) setDropdownOpen(true);
                }}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Tìm lụa, blazer, đầm tiệc..."
                aria-label="Tìm kiếm trang phục"
                className="w-full rounded-full border border-[#EBCF8F]/35 bg-[#2A1E17] px-4 py-1.5 text-xs text-[#FBF7EF] placeholder-[#FBF7EF]/50 outline-none focus:border-[#EBCF8F]"
              />
            </form>

            {dropdownOpen && query.trim() ? (
              <div className="absolute right-0 left-0 top-full z-50 mt-2 overflow-hidden rounded-2xl border border-[#B08A4A]/40 bg-[#FBF7EF] text-[#2B2019] shadow-2xl">
                <div className="flex items-center justify-between border-b border-[#B08A4A]/15 px-3.5 py-2 text-[10px] uppercase tracking-[0.18em] text-[#8A672C]">
                  <span>Kết quả tức thì</span>
                  <span>{searching ? 'Đang tìm...' : `${results.length} mẫu`}</span>
                </div>

                {results.length > 0 ? (
                  <ul className="divide-y divide-[#B08A4A]/15">
                    {results.map((item) => (
                      <li key={item.id}>
                        <Link
                          href={`/san-pham/${item.slug}`}
                          onClick={() => setDropdownOpen(false)}
                          className="flex items-center justify-between gap-3 px-3.5 py-2.5 text-xs transition-colors hover:bg-[#F4EBDA]"
                        >
                          <div className="min-w-0">
                            <p className="truncate font-medium text-[#1C1410]">
                              {item.name}
                            </p>
                            <p className="truncate text-[11px] text-[#7A6A5B]">
                              {item.categoryName}
                              {item.isTryonEnabled ? ' · Thử AI' : ''}
                            </p>
                          </div>
                          <span className="shrink-0 font-editorial text-sm text-[#8A672C]">
                            {FORMAT_VND(item.minPriceVnd)}
                          </span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="px-4 py-3 text-xs text-[#7A6A5B]">
                    {searching
                      ? 'Đang tra cứu danh mục...'
                      : 'Chưa tìm thấy mẫu phù hợp. Nhấn Enter để mở bộ lọc đầy đủ.'}
                  </p>
                )}

                <Link
                  href={`/bo-suu-tap?q=${encodeURIComponent(query.trim())}`}
                  onClick={() => setDropdownOpen(false)}
                  className="block border-t border-[#B08A4A]/20 bg-[#F4EBDA]/80 px-4 py-2 text-center text-[11px] font-medium uppercase tracking-[0.16em] text-[#8A672C] hover:text-[#1C1410]"
                >
                  Xem toàn bộ kết quả
                </Link>
              </div>
            ) : null}
          </div>

          <Link
            href={user ? '/tai-khoan' : '/dang-nhap'}
            className="hidden rounded-full border border-[#FBF7EF]/30 px-4 py-1.5 text-[11px] uppercase tracking-[0.14em] text-[#FBF7EF]/90 transition-colors hover:border-[#EBCF8F] hover:text-[#EBCF8F] sm:inline-flex"
          >
            {user ? user.fullName : 'Đăng nhập'}
          </Link>

          <Link
            href="/thanh-toan"
            aria-label="Túi đồ và thanh toán"
            className="inline-flex items-center gap-1.5 rounded-full border border-[#EBCF8F]/60 px-4 py-1.5 text-[11px] uppercase tracking-[0.16em] text-[#EBCF8F] transition-colors hover:bg-[#B08A4A] hover:text-[#1C1410]"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              aria-hidden="true"
            >
              <path d="M6 8h12l-1 12H7L6 8Z" />
              <path d="M9 8V6a3 3 0 0 1 6 0v2" />
            </svg>
            <span className="hidden sm:inline">Túi đồ</span>
          </Link>
        </div>
      </div>

      <nav
        aria-label="Điều hướng di động"
        className="flex flex-wrap items-center justify-center gap-4 border-t border-[#B08A4A]/15 px-4 py-2 text-[10px] uppercase tracking-[0.15em] text-[#FBF7EF]/80 lg:hidden"
      >
        {NAV_ITEMS.map((item) => (
          <Link key={item.href} href={item.href} className="hover:text-[#EBCF8F]">
            {item.label}
          </Link>
        ))}
        <Link
          href={user ? '/tai-khoan' : '/dang-nhap'}
          className="text-[#EBCF8F]"
        >
          {user ? 'Tài khoản' : 'Đăng nhập'}
        </Link>
      </nav>
    </header>
  );
}
