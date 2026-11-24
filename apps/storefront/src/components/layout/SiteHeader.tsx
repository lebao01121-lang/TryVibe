'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import type { CartDto, UserSummaryDto } from '@atelier/contracts';
import { MagneticButton } from '@/components/motion/MagneticButton';
import {
  apiFetch,
  getStoredSession,
  subscribeSession,
} from '@/lib/api-client';
import {
  onCartUpdated,
  onRefreshCartCount,
  openQuickBagDrawer,
} from '@/lib/storefront-actions';
import { SearchOverlay } from './SearchOverlay';

export interface SiteHeaderProps {
  brandName?: string;
  brandSub?: string;
}

const HOME_ANCHOR_LINKS = [
  { href: '/#rack', label: 'Bộ sưu tập' },
  { href: '/#occasion', label: 'Theo dịp' },
  { href: '/#build', label: 'Phối đồ' },
  { href: '/#seasons', label: 'Lịch BST' },
  { href: '/#atelier', label: 'Xưởng may' },
  { href: '/bo-suu-tap', label: 'Cửa hàng' },
] as const;

export function SiteHeader({
  brandName = 'Tầm Xuân',
  brandSub = 'Fashion Atelier',
}: SiteHeaderProps) {
  const pathname = usePathname();
  const [isLight, setIsLight] = useState(pathname !== '/');
  const [searchOpen, setSearchOpen] = useState(false);
  const [user, setUser] = useState<UserSummaryDto | null>(null);
  const [cartQty, setCartQty] = useState(0);

  const loadCartCount = useCallback(async () => {
    const res = await apiFetch<CartDto>('/bff/v1/storefront/cart', {
      skipAuthRefresh: true,
      timeoutMs: 4000,
    });
    if (res.ok && res.data && typeof res.data.totalQty === 'number') {
      setCartQty(res.data.totalQty);
    }
  }, []);

  useEffect(() => {
    const syncUser = () => {
      setUser(getStoredSession()?.user ?? null);
      void loadCartCount();
    };
    syncUser();
    const unsubSession = subscribeSession(syncUser);
    const unsubCart = onCartUpdated((cart) => {
      if (cart && typeof cart.totalQty === 'number') {
        setCartQty(cart.totalQty);
      } else {
        void loadCartCount();
      }
    });
    const unsubRefresh = onRefreshCartCount(() => {
      void loadCartCount();
    });

    return () => {
      unsubSession();
      unsubCart();
      unsubRefresh();
    };
  }, [loadCartCount]);

  // Global keyboard shortcuts: '/' and 'Cmd/Ctrl + K' to open SearchOverlay
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const isInputFocused =
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.tagName === 'SELECT' ||
        target?.isContentEditable;

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setSearchOpen((prev) => !prev);
        return;
      }

      if (event.key === '/' && !isInputFocused && !searchOpen) {
        event.preventDefault();
        setSearchOpen(true);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [searchOpen]);

  useEffect(() => {
    const queryThemedSections = () =>
      Array.from(document.querySelectorAll<HTMLElement>('[data-nav-theme]'));

    const pickThemeFromViewport = () => {
      const liveSections = queryThemedSections();
      if (liveSections.length === 0) {
        setIsLight(pathname !== '/');
        return;
      }

      const probeY = 64;
      // Check innermost/most-specific section first so nested sections override outer frames
      for (let i = liveSections.length - 1; i >= 0; i -= 1) {
        const sec = liveSections[i]!;
        const rect = sec.getBoundingClientRect();
        if (rect.height > 0 && rect.top <= probeY && rect.bottom > probeY) {
          setIsLight(sec.dataset.navTheme === 'light');
          return;
        }
      }
      setIsLight(liveSections[0]?.dataset.navTheme === 'light');
    };

    const handleCustomNavTheme = (event: Event) => {
      const detail = (
        event as CustomEvent<{ theme?: 'light' | 'dark' } | null>
      ).detail;
      if (detail?.theme === 'light' || detail?.theme === 'dark') {
        setIsLight(detail.theme === 'light');
        return;
      }
      pickThemeFromViewport();
    };

    const observedSections = new WeakSet<HTMLElement>();
    const intersectionObserver = new IntersectionObserver(
      () => {
        pickThemeFromViewport();
      },
      {
        rootMargin: '-64px 0px -82% 0px',
        threshold: [0, 0.1, 0.5],
      },
    );

    const registerThemedSections = () => {
      for (const sec of queryThemedSections()) {
        if (!observedSections.has(sec)) {
          observedSections.add(sec);
          intersectionObserver.observe(sec);
        }
      }
    };

    registerThemedSections();
    pickThemeFromViewport();

    let rafId: number | null = null;
    const scheduleSync = () => {
      if (rafId !== null) return;
      rafId = window.requestAnimationFrame(() => {
        rafId = null;
        registerThemedSections();
        pickThemeFromViewport();
      });
    };

    const mutationObserver = new MutationObserver(() => {
      registerThemedSections();
      pickThemeFromViewport();
      scheduleSync();
    });

    const observeTarget = document.querySelector('main') ?? document.body;
    mutationObserver.observe(observeTarget, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-nav-theme'],
    });

    window.addEventListener('scroll', pickThemeFromViewport, { passive: true });
    window.addEventListener('resize', pickThemeFromViewport, { passive: true });
    window.addEventListener('hashchange', scheduleSync, { passive: true });
    window.addEventListener('atelier:nav-theme', handleCustomNavTheme);

    return () => {
      if (rafId !== null) {
        window.cancelAnimationFrame(rafId);
      }
      intersectionObserver.disconnect();
      mutationObserver.disconnect();
      window.removeEventListener('scroll', pickThemeFromViewport);
      window.removeEventListener('resize', pickThemeFromViewport);
      window.removeEventListener('hashchange', scheduleSync);
      window.removeEventListener('atelier:nav-theme', handleCustomNavTheme);
    };
  }, [pathname]);

  return (
    <>
      <header className={`nav ${isLight ? 'is-light' : ''}`}>
        <Link className="nav__brand" href={pathname === '/' ? '/#top' : '/'}>
          {brandName}
          <small>{brandSub}</small>
        </Link>

        <nav className="nav__links" aria-label="Điều hướng chính">
          {HOME_ANCHOR_LINKS.map((item) => (
            <Link key={item.href} href={item.href}>
              {item.label}
            </Link>
          ))}
        </nav>

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => setSearchOpen(true)}
            aria-label="Mở tìm kiếm (Phím / hoặc Ctrl+K)"
            title="Tìm kiếm (Phím / hoặc Ctrl+K)"
            className="inline-flex h-9 items-center gap-2 rounded-full border border-current/35 px-3 text-xs transition-colors hover:border-current"
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
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.5-3.5" />
            </svg>
            <kbd className="hidden font-mono text-[10px] opacity-70 sm:inline">
              /
            </kbd>
          </button>

          <Link
            href={user ? '/tai-khoan' : '/dang-nhap'}
            className="hidden text-[11px] uppercase tracking-[0.16em] opacity-85 hover:opacity-100 sm:inline-block"
          >
            {user ? user.fullName : 'Tài khoản'}
          </Link>

          <button
            type="button"
            onClick={() => openQuickBagDrawer(null)}
            aria-label={
              cartQty > 0
                ? `Mở túi đồ (${cartQty} sản phẩm)`
                : 'Mở túi đồ'
            }
            title="Túi đồ Atelier"
            className="relative inline-flex h-9 w-9 items-center justify-center rounded-full border border-current/35 text-xs transition-colors hover:border-current"
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
            {cartQty > 0 ? (
              <span
                data-testid="header-cart-badge"
                className="absolute -top-1.5 -right-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-[#B08A4A] px-1 font-mono text-[10px] font-semibold leading-none text-[#1C1410] shadow-sm"
              >
                {cartQty > 99 ? '99+' : cartQty}
              </span>
            ) : null}
          </button>

          <MagneticButton
            href="/thu-do-ai"
            className="nav__cta"
            cursorLabel="Thử AI"
          >
            Thử đồ AI
          </MagneticButton>
        </div>
      </header>

      <SearchOverlay open={searchOpen} onClose={() => setSearchOpen(false)} />
    </>
  );
}
