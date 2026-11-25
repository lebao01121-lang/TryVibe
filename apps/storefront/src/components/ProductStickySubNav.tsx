'use client';

import { useEffect, useState, type MouseEvent } from 'react';
import { FORMAT_VND } from '@/lib/catalog-data';

export interface ProductStickySubNavProps {
  productName: string;
  priceVnd: number;
  colorName?: string;
  isTryonEnabled: boolean;
  totalReviews?: number;
  sentinelId?: string;
  onOpenTryOn: () => void;
  onJumpToSizeAdvisor: () => void;
  onJumpToBuy: () => void;
}

type ActiveSectionKey = 'overview' | 'size-advisor' | 'reviews';

function findFirstSection(ids: readonly string[]): HTMLElement | null {
  for (const id of ids) {
    const el = document.getElementById(id);
    if (el) return el;
  }
  return null;
}

export function ProductStickySubNav({
  productName,
  priceVnd,
  colorName,
  isTryonEnabled,
  totalReviews = 0,
  sentinelId = 'pdp-hero-sentinel',
  onOpenTryOn,
  onJumpToSizeAdvisor,
  onJumpToBuy,
}: ProductStickySubNavProps) {
  const [visible, setVisible] = useState(false);
  const [activeSection, setActiveSection] =
    useState<ActiveSectionKey>('overview');

  useEffect(() => {
    const sentinel = document.getElementById(sentinelId);

    const evaluateScroll = () => {
      if (sentinel) {
        const rect = sentinel.getBoundingClientRect();
        setVisible(rect.bottom <= 92);
      } else {
        setVisible(window.scrollY > 360);
      }

      const reviewsEl = findFirstSection(['pdp-reviews', 'danh-gia-do-vua']);
      const advisorEl = findFirstSection(['pdp-size-advisor', 'co-van-size-ai']);
      if (reviewsEl && reviewsEl.getBoundingClientRect().top <= 220) {
        setActiveSection('reviews');
      } else if (advisorEl && advisorEl.getBoundingClientRect().top <= 220) {
        setActiveSection('size-advisor');
      } else {
        setActiveSection('overview');
      }
    };

    evaluateScroll();

    let observer: IntersectionObserver | null = null;
    if (sentinel && typeof IntersectionObserver !== 'undefined') {
      observer = new IntersectionObserver(
        (entries) => {
          const entry = entries[0];
          if (!entry) return;
          setVisible(!entry.isIntersecting && entry.boundingClientRect.bottom <= 92);
        },
        {
          rootMargin: '-88px 0px 0px 0px',
          threshold: [0, 0.05],
        },
      );
      observer.observe(sentinel);
    }

    window.addEventListener('scroll', evaluateScroll, { passive: true });

    return () => {
      observer?.disconnect();
      window.removeEventListener('scroll', evaluateScroll);
    };
  }, [sentinelId]);

  const scrollToSections = (
    event: MouseEvent<HTMLAnchorElement>,
    candidateIds: readonly string[],
    nextKey: ActiveSectionKey,
    afterClick?: () => void,
  ) => {
    event.preventDefault();
    afterClick?.();
    setActiveSection(nextKey);
    const el = findFirstSection(candidateIds);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  return (
    <div
      data-testid="pdp-sticky-subnav"
      role="region"
      aria-label="Thanh điều hướng nhanh sản phẩm"
      aria-hidden={!visible}
      className={`fixed right-0 left-0 top-[72px] z-[55] border-b border-[#B08A4A]/25 bg-[#FBF7EF]/95 shadow-[0_10px_30px_rgba(28,20,16,0.08)] backdrop-blur-md transition-all duration-300 ${
        visible
          ? 'pointer-events-auto translate-y-0 opacity-100'
          : 'pointer-events-none -translate-y-3 opacity-0'
      }`}
    >
      <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-6 py-3 lg:px-10">
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-3">
            <p className="font-editorial truncate text-xl font-normal text-[#1C1410] lg:text-2xl">
              {productName}
            </p>
            <span className="hidden shrink-0 font-editorial text-lg text-[#8A672C] sm:inline">
              {FORMAT_VND(priceVnd)}
            </span>
          </div>
          {colorName ? (
            <p className="hidden text-[11px] text-[#7A6A5B] md:block">
              Tông màu đang chọn: {colorName}
            </p>
          ) : null}
        </div>

        <nav
          aria-label="Mục nội dung sản phẩm"
          className="hidden items-center gap-5 text-[11px] uppercase tracking-[0.16em] text-[#5C4B41] lg:flex"
        >
          <a
            href="#pdp-overview"
            tabIndex={visible ? 0 : -1}
            onClick={(e) => scrollToSections(e, ['pdp-overview'], 'overview')}
            className={`transition-colors hover:text-[#8A672C] ${
              activeSection === 'overview' ? 'font-medium text-[#1C1410]' : ''
            }`}
          >
            Tổng quan
          </a>
          <span aria-hidden="true" className="text-[#B08A4A]/50">
            ·
          </span>
          <a
            href="#pdp-size-advisor"
            tabIndex={visible ? 0 : -1}
            onClick={(e) =>
              scrollToSections(
                e,
                ['pdp-size-advisor', 'co-van-size-ai'],
                'size-advisor',
                onJumpToSizeAdvisor,
              )
            }
            className={`transition-colors hover:text-[#8A672C] ${
              activeSection === 'size-advisor' ? 'font-medium text-[#1C1410]' : ''
            }`}
          >
            Cố vấn Size AI
          </a>
          <span aria-hidden="true" className="text-[#B08A4A]/50">
            ·
          </span>
          <a
            href="#pdp-reviews"
            tabIndex={visible ? 0 : -1}
            onClick={(e) =>
              scrollToSections(
                e,
                ['pdp-reviews', 'danh-gia-do-vua'],
                'reviews',
              )
            }
            className={`transition-colors hover:text-[#8A672C] ${
              activeSection === 'reviews' ? 'font-medium text-[#1C1410]' : ''
            }`}
          >
            Đánh giá độ vừa{totalReviews > 0 ? ` (${totalReviews})` : ''}
          </a>
        </nav>

        <div className="flex shrink-0 items-center gap-2">
          {isTryonEnabled ? (
            <button
              type="button"
              data-testid="sticky-tryon-btn"
              tabIndex={visible ? 0 : -1}
              onClick={onOpenTryOn}
              className="rounded-full border border-[#8A672C] bg-[#F4EBDA] px-4 py-2 text-[11px] font-medium uppercase tracking-[0.14em] text-[#1C1410] transition-colors hover:bg-[#1C1410] hover:text-[#EBCF8F]"
            >
              ✦ Ướm thử AI
            </button>
          ) : null}
          <button
            type="button"
            data-testid="sticky-buy-btn"
            tabIndex={visible ? 0 : -1}
            onClick={onJumpToBuy}
            className="rounded-full bg-[#1C1410] px-5 py-2 text-[11px] font-medium uppercase tracking-[0.16em] text-[#EBCF8F] transition-opacity hover:opacity-90"
          >
            + Chọn mua
          </button>
        </div>
      </div>
    </div>
  );
}
