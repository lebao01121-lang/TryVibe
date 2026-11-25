'use client';

import { useLenis } from 'lenis/react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent,
} from 'react';
import type { CartDto, UserSummaryDto } from '@atelier/contracts';
import { usePrefersReducedMotion } from '@atelier/motion-kit';
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
import {
  DiagonalSlashSvg,
  type NavJourneyVisualState,
} from './DiagonalSlashSvg';
import { SearchOverlay } from './SearchOverlay';
import styles from './SiteHeader.module.css';

export interface SiteHeaderProps {
  brandName?: string;
  brandSub?: string;
}

interface NavJourneyItem {
  readonly id:
    | 'rack'
    | 'occasion'
    | 'build'
    | 'seasons'
    | 'atelier'
    | 'contact';
  readonly href: `/#${string}`;
  readonly label: string;
  readonly stepText: string;
}

const NAV_JOURNEY_ITEMS: readonly NavJourneyItem[] = [
  { id: 'rack', href: '/#rack', label: 'Bộ sưu tập', stepText: '01/06' },
  { id: 'occasion', href: '/#occasion', label: 'Theo dịp', stepText: '02/06' },
  { id: 'build', href: '/#build', label: 'Phối đồ', stepText: '03/06' },
  { id: 'seasons', href: '/#seasons', label: 'Lịch BST', stepText: '04/06' },
  { id: 'atelier', href: '/#atelier', label: 'Xưởng may', stepText: '05/06' },
  { id: 'contact', href: '/#contact', label: 'Cửa hàng', stepText: '06/06' },
] as const;

function resolveSubpageActiveIndex(pathname: string): number {
  if (
    pathname === '/bo-suu-tap' ||
    pathname.startsWith('/bo-suu-tap/') ||
    pathname === '/san-pham' ||
    pathname.startsWith('/san-pham/')
  ) {
    return 0;
  }
  if (pathname === '/phoi-do' || pathname.startsWith('/phoi-do/')) {
    return 2;
  }
  return -1;
}

function getSectionScrollContainer(id: string): HTMLElement | null {
  const el = document.getElementById(id);
  if (!el) return null;
  // GSAP ScrollTrigger pinned sections live inside `.pin-spacer`; reading the
  // spacer gives the full pinned scroll span and true document top.
  return el.closest<HTMLElement>('.pin-spacer') ?? el;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

/**
 * Eased intra-section progress curve: keeps the gold bottom progress tip
 * visually anchored near the active link's horizontal center throughout most
 * of the section, then glides smoothly toward the next link near the boundary.
 */
function easeJourneyIntraProgress(t: number): number {
  const clamped = clamp01(t);
  if (clamped <= 0.72) {
    return (clamped / 0.72) * 0.16;
  }
  const tail = (clamped - 0.72) / 0.28;
  return 0.16 + tail * tail * (3 - 2 * tail) * 0.68;
}

export function SiteHeader({
  brandName = 'Tầm Xuân',
  brandSub = 'Fashion Atelier',
}: SiteHeaderProps) {
  const pathname = usePathname();
  const lenis = useLenis();
  const reducedMotion = usePrefersReducedMotion();

  const initialActive =
    pathname === '/' ? -1 : resolveSubpageActiveIndex(pathname);

  const [isLight, setIsLight] = useState(pathname !== '/');
  const [activeIndex, setActiveIndex] = useState<number>(initialActive);
  const [searchOpen, setSearchOpen] = useState(false);
  const [user, setUser] = useState<UserSummaryDto | null>(null);
  const [cartQty, setCartQty] = useState(0);

  const activeIndexRef = useRef<number>(initialActive);
  const linkRefs = useRef<Array<HTMLAnchorElement | null>>([]);
  const progressBarRef = useRef<HTMLDivElement | null>(null);
  const journeySyncRef = useRef<(() => void) | null>(null);

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

  // Live dark/light header theme sync via [data-nav-theme] sections
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

  // Lenis scroll callback feeds directly into the rAF-throttled journey sync
  useLenis(() => {
    journeySyncRef.current?.();
  });

  // Zero-rerender GSAP-pinned scroll-spy + GPU bottom journey progress line
  useEffect(() => {
    const getLinkCenterNorm = (index: number, viewportWidth: number): number => {
      const linkEl = linkRefs.current[index];
      if (linkEl) {
        const rect = linkEl.getBoundingClientRect();
        if (rect.width > 0 && viewportWidth > 0) {
          return clamp01((rect.left + rect.width / 2) / viewportWidth);
        }
      }
      return clamp01((index + 1) / NAV_JOURNEY_ITEMS.length);
    };

    const applyProgressScale = (scale: number) => {
      const bar = progressBarRef.current;
      if (!bar) return;
      const clamped = clamp01(scale);
      bar.style.transform =
        clamped === 0 ? 'scaleX(0)' : `scaleX(${clamped.toFixed(5)})`;
    };

    const commitActiveIndex = (nextIndex: number) => {
      if (nextIndex !== activeIndexRef.current) {
        activeIndexRef.current = nextIndex;
        setActiveIndex(nextIndex);
      }
    };

    let rafId: number | null = null;

    const evaluateJourney = () => {
      const viewportWidth = window.innerWidth || 1;
      const viewportHeight = window.innerHeight || 1;

      if (pathname !== '/') {
        const subpageIndex = resolveSubpageActiveIndex(pathname);
        commitActiveIndex(subpageIndex);
        applyProgressScale(
          subpageIndex >= 0
            ? getLinkCenterNorm(subpageIndex, viewportWidth)
            : 0,
        );
        return;
      }

      const viewportTriggerY = viewportHeight * 0.38;
      const scrollY = window.scrollY;
      const docHeight = document.documentElement.scrollHeight;
      const maxScroll = Math.max(0, docHeight - viewportHeight);

      const rects: Array<DOMRect | null> = NAV_JOURNEY_ITEMS.map((item) => {
        const container = getSectionScrollContainer(item.id);
        if (!container) return null;
        const rect = container.getBoundingClientRect();
        return rect.height > 0 ? rect : null;
      });

      const lastIdx = NAV_JOURNEY_ITEMS.length - 1;
      const isAtPageBottom =
        maxScroll > viewportHeight * 0.5 && scrollY >= maxScroll - 10;

      let nextIndex = -1;
      if (isAtPageBottom) {
        nextIndex = lastIdx;
      } else {
        for (let i = 0; i < rects.length; i += 1) {
          const rect = rects[i];
          if (rect && rect.top <= viewportTriggerY) {
            nextIndex = i;
          }
        }
      }

      commitActiveIndex(nextIndex);

      if (nextIndex < 0) {
        applyProgressScale(0);
        return;
      }

      const currentCenter = getLinkCenterNorm(nextIndex, viewportWidth);
      const currentRect = rects[nextIndex];

      if (nextIndex === lastIdx) {
        if (isAtPageBottom || !currentRect) {
          applyProgressScale(1);
          return;
        }
        const contactStartScroll = Math.max(
          0,
          scrollY + currentRect.top - viewportTriggerY,
        );
        const contactSpan = Math.max(1, maxScroll - contactStartScroll);
        const contactProgress = clamp01(
          (scrollY - contactStartScroll) / contactSpan,
        );
        applyProgressScale(
          currentCenter + contactProgress * (1 - currentCenter),
        );
        return;
      }

      // Find next mounted section rect for smooth intra-section interpolation
      let nextRect: DOMRect | null = null;
      for (let j = nextIndex + 1; j < rects.length; j += 1) {
        if (rects[j]) {
          nextRect = rects[j]!;
          break;
        }
      }

      const nextCenter = getLinkCenterNorm(nextIndex + 1, viewportWidth);
      if (currentRect && nextRect) {
        const span = Math.max(1, nextRect.top - currentRect.top);
        const rawProgress = clamp01(
          (viewportTriggerY - currentRect.top) / span,
        );
        const eased = easeJourneyIntraProgress(rawProgress);
        applyProgressScale(
          currentCenter + eased * (nextCenter - currentCenter),
        );
      } else {
        applyProgressScale(currentCenter);
      }
    };

    const scheduleEvaluate = () => {
      if (rafId !== null) return;
      rafId = window.requestAnimationFrame(() => {
        rafId = null;
        evaluateJourney();
      });
    };

    journeySyncRef.current = scheduleEvaluate;

    // Immediate sync + font-load re-measure for exact link center alignment
    evaluateJourney();
    scheduleEvaluate();

    let fontsCancelled = false;
    if (typeof document !== 'undefined' && document.fonts?.ready) {
      void document.fonts.ready.then(() => {
        if (!fontsCancelled) {
          scheduleEvaluate();
        }
      });
    }

    const observeTarget = document.querySelector('main') ?? document.body;

    const mutationObserver = new MutationObserver(() => {
      scheduleEvaluate();
    });
    mutationObserver.observe(observeTarget, {
      childList: true,
      subtree: true,
    });

    const resizeObserver =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(() => {
            scheduleEvaluate();
          })
        : null;
    if (resizeObserver) {
      resizeObserver.observe(observeTarget);
      if (document.body && document.body !== observeTarget) {
        resizeObserver.observe(document.body);
      }
    }

    window.addEventListener('scroll', scheduleEvaluate, { passive: true });
    window.addEventListener('resize', scheduleEvaluate, { passive: true });
    window.addEventListener('hashchange', scheduleEvaluate, { passive: true });

    return () => {
      fontsCancelled = true;
      journeySyncRef.current = null;
      if (rafId !== null) {
        window.cancelAnimationFrame(rafId);
      }
      mutationObserver.disconnect();
      resizeObserver?.disconnect();
      window.removeEventListener('scroll', scheduleEvaluate);
      window.removeEventListener('resize', scheduleEvaluate);
      window.removeEventListener('hashchange', scheduleEvaluate);
    };
  }, [pathname]);

  // Honor cross-page hash navigation (e.g. from /bo-suu-tap -> /#occasion)
  useEffect(() => {
    if (pathname !== '/' || typeof window === 'undefined') return;
    const rawHash = window.location.hash.replace(/^#/, '');
    if (!rawHash) return;
    const matched = NAV_JOURNEY_ITEMS.some((item) => item.id === rawHash);
    if (!matched) return;

    const timerId = window.setTimeout(() => {
      const targetEl = getSectionScrollContainer(rawHash);
      if (!targetEl) return;
      const prefersReduced =
        reducedMotion ||
        window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (lenis) {
        lenis.scrollTo(targetEl, {
          offset: 0,
          immediate: prefersReduced,
          duration: prefersReduced ? undefined : 1.0,
        });
      } else {
        const top = Math.max(
          0,
          targetEl.getBoundingClientRect().top + window.scrollY,
        );
        window.scrollTo({
          top,
          behavior: prefersReduced ? 'auto' : 'smooth',
        });
      }
    }, 120);

    return () => window.clearTimeout(timerId);
  }, [pathname, lenis, reducedMotion]);

  const handleJourneyClick = useCallback(
    (event: MouseEvent<HTMLAnchorElement>, item: NavJourneyItem) => {
      if (pathname !== '/') {
        return;
      }

      const targetEl = getSectionScrollContainer(item.id);
      if (!targetEl) {
        return;
      }

      event.preventDefault();
      const prefersReduced =
        reducedMotion ||
        window.matchMedia('(prefers-reduced-motion: reduce)').matches;

      if (lenis) {
        if (prefersReduced) {
          lenis.scrollTo(targetEl, { offset: 0, immediate: true });
        } else {
          lenis.scrollTo(targetEl, { offset: 0, duration: 1.15 });
        }
      } else {
        const targetTop = Math.max(
          0,
          targetEl.getBoundingClientRect().top + window.scrollY,
        );
        window.scrollTo({
          top: targetTop,
          behavior: prefersReduced ? 'auto' : 'smooth',
        });
      }

      if (window.history?.replaceState) {
        window.history.replaceState(null, '', `/#${item.id}`);
      }
    },
    [lenis, pathname, reducedMotion],
  );

  const handleBrandClick = useCallback(
    (event: MouseEvent<HTMLAnchorElement>) => {
      if (pathname !== '/') {
        return;
      }
      event.preventDefault();
      const prefersReduced =
        reducedMotion ||
        window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (lenis) {
        if (prefersReduced) {
          lenis.scrollTo(0, { immediate: true });
        } else {
          lenis.scrollTo(0, { duration: 1.0 });
        }
      } else {
        window.scrollTo({
          top: 0,
          behavior: prefersReduced ? 'auto' : 'smooth',
        });
      }
      if (window.history?.replaceState) {
        window.history.replaceState(null, '', '/');
      }
    },
    [lenis, pathname, reducedMotion],
  );

  const isScrolledDark = activeIndex >= 0 && !isLight;

  if (pathname === '/thu-do-ai' || pathname.startsWith('/thu-do-ai/')) {
    return null;
  }

  return (
    <>
      <header
        className={`nav ${isLight ? 'is-light' : ''} ${isScrolledDark ? styles.navScrolledDark : ''}`}
      >
        <Link
          className="nav__brand"
          href={pathname === '/' ? '/#top' : '/'}
          onClick={handleBrandClick}
        >
          {brandName}
          <small>{brandSub}</small>
        </Link>

        <nav
          className={`nav__links ${styles.navLinks} ${isLight ? styles.navLinksLight : ''}`}
          aria-label="Điều hướng chính"
        >
          {NAV_JOURNEY_ITEMS.map((item, index) => {
            const isActive = activeIndex === index;
            const isPassed = activeIndex > index;
            const navState: NavJourneyVisualState = isActive
              ? 'active'
              : isPassed
                ? 'passed'
                : 'upcoming';

            return (
              <Link
                key={item.id}
                ref={(node) => {
                  linkRefs.current[index] = node;
                }}
                href={item.href}
                onClick={(event) => handleJourneyClick(event, item)}
                data-testid={`nav-journey-item-${item.id}`}
                data-nav-state={navState}
                aria-current={isActive ? 'location' : undefined}
                className={styles.journeyLink}
              >
                <span
                  className={styles.stepBadge}
                  data-testid={isActive ? 'nav-step-badge' : undefined}
                  aria-hidden="true"
                >
                  {item.stepText}
                </span>

                <DiagonalSlashSvg
                  itemId={item.id}
                  state={navState}
                  isLight={isLight}
                />

                <span className={styles.journeyLabel}>{item.label}</span>
              </Link>
            );
          })}
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

        <div
          className={`${styles.journeyTrack} ${activeIndex >= 0 ? styles.journeyTrackVisible : ''} ${isLight ? styles.journeyTrackLight : ''}`}
          aria-hidden="true"
        />

        <div
          ref={progressBarRef}
          data-testid="nav-journey-progress"
          className={`nav__journey-progress ${styles.journeyProgress} ${isLight ? styles.journeyProgressLight : ''}`}
          aria-hidden="true"
        />
      </header>

      <SearchOverlay open={searchOpen} onClose={() => setSearchOpen(false)} />
    </>
  );
}
