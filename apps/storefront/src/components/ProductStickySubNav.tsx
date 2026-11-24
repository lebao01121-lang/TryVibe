'use client';

import { useEffect, useState } from 'react';
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

  useEffect(() => {
    const sentinel = document.getElementById(sentinelId);
    if (!sentinel) return;

    const evaluate = () => {
      const rect = sentinel.getBoundingClientRect();
      setVisible(rect.bottom <= 92);
    };

    evaluate();

    const observer = new IntersectionObserver(
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
    window.addEventListener('scroll', evaluate, { passive: true });

    return () => {
      observer.disconnect();
      window.removeEventListener('scroll', evaluate);
    };
  }, [sentinelId]);

  const scrollToSection = (sectionId: string) => {
    const el = document.getElementById(sectionId);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  return (
    <div
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
          <button
            type="button"
            tabIndex={visible ? 0 : -1}
            onClick={() => scrollToSection('pdp-overview')}
            className="transition-colors hover:text-[#8A672C]"
          >
            Tổng quan
          </button>
          <button
            type="button"
            tabIndex={visible ? 0 : -1}
            onClick={() => {
              onJumpToSizeAdvisor();
              scrollToSection('co-van-size-ai');
            }}
            className="transition-colors hover:text-[#8A672C]"
          >
            Cố vấn Size AI
          </button>
          <button
            type="button"
            tabIndex={visible ? 0 : -1}
            onClick={() => scrollToSection('danh-gia-do-vua')}
            className="transition-colors hover:text-[#8A672C]"
          >
            Đánh giá độ vừa{totalReviews > 0 ? ` (${totalReviews})` : ''}
          </button>
        </nav>

        <div className="flex shrink-0 items-center gap-2">
          {isTryonEnabled ? (
            <button
              type="button"
              tabIndex={visible ? 0 : -1}
              onClick={onOpenTryOn}
              className="rounded-full border border-[#8A672C] bg-[#F4EBDA] px-4 py-2 text-[11px] font-medium uppercase tracking-[0.14em] text-[#1C1410] transition-colors hover:bg-[#1C1410] hover:text-[#EBCF8F]"
            >
              Ướm thử AI
            </button>
          ) : null}
          <button
            type="button"
            tabIndex={visible ? 0 : -1}
            onClick={onJumpToBuy}
            className="rounded-full bg-[#1C1410] px-5 py-2 text-[11px] font-medium uppercase tracking-[0.16em] text-[#EBCF8F] transition-opacity hover:opacity-90"
          >
            Chọn mua
          </button>
        </div>
      </div>
    </div>
  );
}
