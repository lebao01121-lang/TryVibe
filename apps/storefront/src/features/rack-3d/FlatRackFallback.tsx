'use client';

import Link from 'next/link';
import type { RackGarmentItemDto, RackGarmentVariantDto } from '@atelier/contracts';
import { FORMAT_VND } from '@/lib/catalog-data';

const ALL_STANDARD_SIZES = ['XS', 'S', 'M', 'L', 'XL'] as const;

export interface FlatRackFallbackProps {
  items: RackGarmentItemDto[];
  activeIndex: number;
  activeVariants: Record<string, number>;
  showBackMap: Record<string, boolean>;
  reasonLabel?: string;
  onSelectIndex: (index: number) => void;
  onSelectVariant: (productId: string, variantIndex: number) => void;
  onToggleBack: (productId: string) => void;
}

export function createEditorialGarmentSvg(
  name: string,
  colorHex: string,
  sideLabel: string,
): string {
  const safeName = name.replace(/[<>&"']/g, '');
  const safeHex = /^#[0-9a-fA-F]{3,8}$/.test(colorHex) ? colorHex : '#EBD9B4';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="600" viewBox="0 0 400 600">
    <defs>
      <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${safeHex}" stop-opacity="0.95"/>
        <stop offset="100%" stop-color="${safeHex}" stop-opacity="0.72"/>
      </linearGradient>
    </defs>
    <path d="M188 46 C188 30 212 30 212 46 C212 58 200 62 200 72" fill="none" stroke="#D9B26A" stroke-width="5" stroke-linecap="round"/>
    <path d="M120 110 Q200 66 280 110" fill="none" stroke="#D9B26A" stroke-width="6" stroke-linecap="round"/>
    <path d="M122 114 L168 92 L232 92 L278 114 L322 232 L274 252 L254 186 L266 518 L134 518 L146 186 L126 252 L78 232 Z" fill="url(#g)" stroke="#EBCF8F" stroke-opacity="0.65" stroke-width="2.5"/>
    <text x="200" y="556" text-anchor="middle" fill="#EBCF8F" font-size="13" letter-spacing="3" font-family="serif">${sideLabel}</text>
    <text x="200" y="578" text-anchor="middle" fill="#FBF7EF" fill-opacity="0.78" font-size="12" font-family="sans-serif">${safeName.slice(0, 28)}</text>
  </svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export function resolveVariantCutoutUrl(
  item: RackGarmentItemDto,
  variant: RackGarmentVariantDto | undefined,
  showBack: boolean,
): string {
  const colorHex = variant?.colorHex ?? '#EBD9B4';
  if (showBack) {
    return (
      variant?.backCutoutUrl ||
      variant?.frontCutoutUrl ||
      variant?.lookbookMainUrl ||
      variant?.tryonFlatPreviewUrl ||
      createEditorialGarmentSvg(item.name, colorHex, 'MẶT SAU')
    );
  }
  return (
    variant?.frontCutoutUrl ||
    variant?.lookbookMainUrl ||
    variant?.tryonFlatPreviewUrl ||
    createEditorialGarmentSvg(item.name, colorHex, 'MẶT TRƯỚC')
  );
}

export function FlatRackFallback({
  items,
  activeIndex,
  activeVariants,
  showBackMap,
  reasonLabel,
  onSelectIndex,
  onSelectVariant,
  onToggleBack,
}: FlatRackFallbackProps) {
  if (items.length === 0) {
    return null;
  }

  const safeIdx = Math.max(0, Math.min(activeIndex, items.length - 1));
  const activeItem = items[safeIdx] ?? items[0];
  const activeVarIdx = activeVariants[activeItem.productId] ?? 0;
  const activeVariant = activeItem.variants[activeVarIdx] ?? activeItem.variants[0];
  const isBack = Boolean(showBackMap[activeItem.productId]);
  const frontUrl = resolveVariantCutoutUrl(activeItem, activeVariant, false);
  const backUrl = resolveVariantCutoutUrl(activeItem, activeVariant, true);
  const hasDistinctBack = Boolean(activeVariant?.backCutoutUrl);
  const inStockSet = new Set<string>(activeVariant?.inStockSizes ?? []);

  const sizeList =
    activeVariant && activeVariant.inStockSizes.length > 0
      ? Array.from(
          new Set<string>([...ALL_STANDARD_SIZES, ...activeVariant.inStockSizes]),
        )
      : [...ALL_STANDARD_SIZES];

  const handlePrev = () => {
    onSelectIndex((safeIdx - 1 + items.length) % items.length);
  };

  const handleNext = () => {
    onSelectIndex((safeIdx + 1) % items.length);
  };

  return (
    <div className="relative z-10 mx-auto flex min-h-[100svh] max-w-7xl flex-col justify-between px-4 pt-24 pb-12 sm:px-6 lg:px-10">
      {/* Header + Prev/Next */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="eyebrow">Bộ sưu tập · Giá treo thanh đồng</p>
          <h2 className="h2">
            Chọn một dáng,
            <br />
            <em>thiết kế sẽ bước ra.</em>
          </h2>
          {reasonLabel ? (
            <p className="mt-2 text-xs tracking-[0.14em] text-[#EBCF8F]/70">
              {reasonLabel}
            </p>
          ) : null}
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handlePrev}
            aria-label="Thiết kế trước"
            className="flex h-10 w-10 items-center justify-center rounded-full border border-[#EBCF8F]/40 bg-[#241A14]/70 text-[#EBCF8F] transition-colors hover:border-[#EBCF8F] hover:bg-[#EBCF8F]/15"
          >
            ←
          </button>
          <span className="px-2 text-xs tracking-[0.22em] text-[#FBF7EF]/75">
            {String(safeIdx + 1).padStart(2, '0')} / {String(items.length).padStart(2, '0')}
          </span>
          <button
            type="button"
            onClick={handleNext}
            aria-label="Thiết kế kế tiếp"
            className="flex h-10 w-10 items-center justify-center rounded-full border border-[#EBCF8F]/40 bg-[#241A14]/70 text-[#EBCF8F] transition-colors hover:border-[#EBCF8F] hover:bg-[#EBCF8F]/15"
          >
            →
          </button>
        </div>
      </div>

      {/* Brass Rail + 2D Editorial Garment Stage + Frosted Card */}
      <div className="mt-8 grid items-center gap-8 lg:grid-cols-[1.25fr_380px]">
        <div className="relative flex flex-col items-center">
          {/* Brass horizontal bar */}
          <div
            className="relative mb-2 h-2 w-full max-w-xl rounded-full"
            style={{
              background:
                'linear-gradient(180deg, #f3dfae 0%, #d9b26a 45%, #8a672c 100%)',
              boxShadow: '0 6px 24px rgba(0, 0, 0, 0.55)',
            }}
            aria-hidden="true"
          >
            <span className="absolute top-1/2 left-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-[#f3dfae] bg-[#241A14]" />
          </div>

          {/* 3D CSS Y-Flip Container for Active Garment */}
          <div
            className="relative mx-auto w-full max-w-[300px] sm:max-w-[340px]"
            style={{ perspective: '1200px' }}
            data-cursor="view"
            data-cursor-label="XOAY"
            onClick={() => onToggleBack(activeItem.productId)}
          >
            <div
              className="relative aspect-[2/3] w-full transition-transform duration-700"
              style={{
                transformStyle: 'preserve-3d',
                transform: isBack ? 'rotateY(180deg)' : 'rotateY(0deg)',
              }}
            >
              {/* Front Face */}
              <div
                className="absolute inset-0 flex items-center justify-center overflow-hidden rounded-3xl border border-[#EBCF8F]/20 bg-[#1B130E]/60 p-4 shadow-2xl"
                style={{ backfaceVisibility: 'hidden' }}
              >
                <img
                  key={`${activeItem.productId}-${activeVariant?.id ?? 'default'}-front`}
                  src={frontUrl}
                  alt={`${activeItem.name} — Mặt trước`}
                  className="h-full w-full object-contain transition-opacity duration-500"
                />
              </div>

              {/* Back Face */}
              <div
                className="absolute inset-0 flex items-center justify-center overflow-hidden rounded-3xl border border-[#EBCF8F]/35 bg-[#1B130E]/70 p-4 shadow-2xl"
                style={{
                  backfaceVisibility: 'hidden',
                  transform: 'rotateY(180deg)',
                }}
              >
                <img
                  key={`${activeItem.productId}-${activeVariant?.id ?? 'default'}-back`}
                  src={backUrl}
                  alt={`${activeItem.name} — Mặt sau`}
                  className="h-full w-full object-contain transition-opacity duration-500"
                />
                {!hasDistinctBack ? (
                  <span className="absolute bottom-3 rounded-full bg-[#1C1410]/85 px-3 py-1 text-[10px] tracking-[0.18em] uppercase text-[#EBCF8F]">
                    Góc sau · Phom dáng
                  </span>
                ) : null}
              </div>
            </div>
          </div>

          {/* Quick Rail Thumbnail Strip */}
          <div className="mt-5 flex max-w-full items-center gap-2.5 overflow-x-auto pb-1">
            {items.map((item, idx) => {
              const vIdx = activeVariants[item.productId] ?? 0;
              const v = item.variants[vIdx] ?? item.variants[0];
              const thumb = resolveVariantCutoutUrl(item, v, false);
              const selected = idx === safeIdx;
              return (
                <button
                  key={item.productId}
                  type="button"
                  onClick={() => onSelectIndex(idx)}
                  aria-label={`Chọn ${item.name}`}
                  aria-pressed={selected}
                  className={`h-16 w-12 shrink-0 overflow-hidden rounded-xl border p-1 transition-all ${
                    selected
                      ? 'scale-105 border-[#EBCF8F] bg-[#2C1F17]'
                      : 'border-[#EBCF8F]/20 bg-[#1C1410]/65 opacity-65 hover:opacity-100'
                  }`}
                >
                  <img
                    src={thumb}
                    alt={item.name}
                    className="h-full w-full object-contain"
                  />
                </button>
              );
            })}
          </div>
        </div>

        {/* Frosted Commerce Card (.rack__card) */}
        <aside className="rack__card w-full" id="rackCard">
          <div className="flex items-center justify-between gap-2">
            <p className="rack__idx">
              <b>{String(safeIdx + 1).padStart(2, '0')}</b> /{' '}
              <span>{String(items.length).padStart(2, '0')}</span>
            </p>
            <button
              type="button"
              onClick={() => onToggleBack(activeItem.productId)}
              aria-pressed={isBack}
              className="rounded-full border border-[#EBCF8F]/40 bg-[#1C1410]/65 px-3 py-1 text-[10px] tracking-[0.16em] uppercase text-[#EBCF8F] transition-colors hover:border-[#EBCF8F]"
            >
              {isBack ? 'Xem Mặt trước' : 'Mặt trước / Mặt sau'}
            </button>
          </div>

          <h3 className="rack__name">{activeItem.name}</h3>
          <p className="rack__flowers">{activeItem.fabricComposition}</p>

          {/* Color Swatches */}
          {activeItem.variants.length > 0 ? (
            <div className="mt-4 flex flex-wrap items-center gap-2">
              {activeItem.variants.map((variant, vIdx) => {
                const selected = vIdx === activeVarIdx;
                return (
                  <button
                    key={variant.id}
                    type="button"
                    title={variant.colorName}
                    aria-label={`Chọn màu ${variant.colorName}`}
                    aria-pressed={selected}
                    onClick={() => onSelectVariant(activeItem.productId, vIdx)}
                    className={`h-6 w-6 rounded-full border transition-transform ${
                      selected
                        ? 'scale-110 border-[#EBCF8F] ring-2 ring-[#B08A4A]'
                        : 'border-[#FBF7EF]/35 hover:scale-105'
                    }`}
                    style={{ backgroundColor: variant.colorHex }}
                  />
                );
              })}
              <span className="ml-1 text-xs text-[#EBCF8F]/85">
                {activeVariant?.colorName}
              </span>
            </div>
          ) : null}

          {/* In-Stock Size Pills */}
          <div className="mt-4">
            <p className="mb-1.5 text-[10px] tracking-[0.2em] uppercase text-[#FBF7EF]/55">
              Cỡ sẵn có
            </p>
            <div className="flex flex-wrap gap-1.5">
              {sizeList.map((sz) => {
                const available = inStockSet.has(sz);
                return (
                  <span
                    key={sz}
                    className={`inline-flex min-w-[34px] items-center justify-center rounded-full border px-2.5 py-0.5 text-[11px] tracking-[0.1em] ${
                      available
                        ? 'border-[#EBCF8F]/50 bg-[#EBCF8F]/10 text-[#FBF7EF]'
                        : 'border-[#FBF7EF]/15 text-[#FBF7EF]/35 line-through'
                    }`}
                  >
                    {sz}
                  </span>
                );
              })}
            </div>
          </div>

          <p className="rack__price">
            <small>Từ</small>
            {FORMAT_VND(activeItem.minPriceVnd)}
          </p>

          <div className="flex flex-wrap gap-2.5">
            <Link
              href={`/san-pham/${activeItem.slug}`}
              className="btn btn--line text-[#EBCF8F]"
            >
              Xem chi tiết
            </Link>
            {activeItem.isTryonEnabled ? (
              <Link
                href={`/thu-do-ai?slug=${encodeURIComponent(activeItem.slug)}`}
                className="inline-flex items-center rounded-full border border-[#FBF7EF]/35 px-4 py-2 text-[11px] tracking-[0.16em] uppercase text-[#FBF7EF]/90 transition-colors hover:border-[#EBCF8F] hover:text-[#EBCF8F]"
              >
                Ướm thử AI
              </Link>
            ) : null}
          </div>
        </aside>
      </div>

      {/* Dot Pagination */}
      <div className="mt-6 flex items-center justify-center gap-2" role="tablist" aria-label="Chọn mẫu trên giá treo">
        {items.map((item, idx) => {
          const selected = idx === safeIdx;
          return (
            <button
              key={item.productId}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-label={`Mẫu ${idx + 1}: ${item.name}`}
              onClick={() => onSelectIndex(idx)}
              className={`h-1.5 rounded-full transition-all ${
                selected ? 'w-6 bg-[#B08A4A]' : 'w-1.5 bg-[#EBCF8F]/35 hover:bg-[#EBCF8F]/65'
              }`}
            />
          );
        })}
      </div>
    </div>
  );
}
