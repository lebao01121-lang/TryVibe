'use client';

import Link from 'next/link';
import type { RackGarmentItemDto, RackGarmentVariantDto } from '@atelier/contracts';
import { FORMAT_VND } from '@/lib/catalog-data';

const ALL_STANDARD_SIZES = ['XS', 'S', 'M', 'L', 'XL'] as const;

export interface RackBagFeedback {
  productId: string;
  kind: 'success' | 'error';
  message: string;
}

export interface FlatRackFallbackProps {
  items: RackGarmentItemDto[];
  activeIndex: number;
  activeVariants: Record<string, number>;
  selectedSizes: Record<string, string>;
  showBackMap: Record<string, boolean>;
  recommendedSize?: string | null;
  addingProductId?: string | null;
  bagFeedback?: RackBagFeedback | null;
  reasonLabel?: string;
  onSelectIndex: (index: number) => void;
  onSelectVariant: (productId: string, variantIndex: number) => void;
  onSelectSize: (productId: string, sizeCode: string) => void;
  onToggleBack: (productId: string) => void;
  onAddToBag: (item: RackGarmentItemDto) => void;
  onOpenTryOn: (item: RackGarmentItemDto) => void;
  onEnable3DRack?: () => void;
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
  selectedSizes,
  showBackMap,
  recommendedSize = null,
  addingProductId = null,
  bagFeedback = null,
  reasonLabel,
  onSelectIndex,
  onSelectVariant,
  onSelectSize,
  onToggleBack,
  onAddToBag,
  onOpenTryOn,
  onEnable3DRack,
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
  const inStockSet = new Set<string>(
    activeVariant?.inStockSizes?.length
      ? activeVariant.inStockSizes
      : (activeVariant?.skus ?? []).filter((s) => s.inStock).map((s) => s.sizeCode),
  );

  const sizeList =
    activeVariant && activeVariant.inStockSizes.length > 0
      ? Array.from(
          new Set<string>([...ALL_STANDARD_SIZES, ...activeVariant.inStockSizes]),
        )
      : [...ALL_STANDARD_SIZES];

  const activeSize =
    selectedSizes[activeItem.productId] ||
    (recommendedSize && inStockSet.has(recommendedSize) ? recommendedSize : '') ||
    activeVariant?.skus.find((s) => s.inStock)?.sizeCode ||
    activeVariant?.inStockSizes[0] ||
    'M';

  const activeSku =
    activeVariant?.skus.find((s) => s.sizeCode === activeSize && s.inStock) ??
    activeVariant?.skus.find((s) => s.sizeCode === activeSize) ??
    activeVariant?.skus.find((s) => s.inStock) ??
    activeVariant?.skus[0];

  const displayPriceVnd =
    activeSku?.salePriceVnd ?? activeSku?.basePriceVnd ?? activeItem.minPriceVnd;
  const isAdding = addingProductId === activeItem.productId;
  const canAddToBag = Boolean(activeSku?.inStock || inStockSet.has(activeSize));
  const activeFeedback =
    bagFeedback && bagFeedback.productId === activeItem.productId
      ? bagFeedback
      : null;

  const handlePrev = () => {
    onSelectIndex((safeIdx - 1 + items.length) % items.length);
  };

  const handleNext = () => {
    onSelectIndex((safeIdx + 1) % items.length);
  };

  return (
    <div
      data-testid="flat-rack-fallback"
      className="relative z-10 mx-auto flex min-h-[100svh] w-full max-w-7xl flex-col justify-between overflow-x-hidden px-4 pt-20 pb-8 sm:px-6 lg:px-10"
    >
      {/* Header + Prev/Next */}
      <div className="flex w-full min-w-0 flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <p className="eyebrow">Bộ sưu tập · Giá treo thanh đồng</p>
          <h2 className="h2 !text-[clamp(28px,3.2vw,46px)] !leading-[1.06]">
            Chọn một dáng,
            <br />
            <em>thiết kế sẽ bước ra.</em>
          </h2>
          {reasonLabel ? (
            <div className="mt-1.5 flex flex-wrap items-center gap-3">
              <p className="text-xs tracking-[0.14em] text-[#EBCF8F]/75">
                {reasonLabel}
              </p>
              {onEnable3DRack ? (
                <button
                  type="button"
                  data-testid="rack-enable-3d-btn"
                  onClick={onEnable3DRack}
                  className="rounded-full border border-[#EBCF8F]/50 bg-[#2A1E17]/85 px-3 py-1 text-[10px] font-medium tracking-[0.14em] uppercase text-[#EBCF8F] transition-colors hover:border-[#EBCF8F] hover:bg-[#EBCF8F]/15"
                >
                  ↻ Bật lại Giá treo 3D
                </button>
              ) : null}
            </div>
          ) : null}
        </div>

        <div className="flex shrink-0 items-center gap-2">
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
      <div className="mt-4 grid w-full min-w-0 items-center gap-6 lg:grid-cols-[minmax(0,1fr)_390px]">
        <div className="relative flex w-full min-w-0 flex-col items-center">
          {/* Brass horizontal bar */}
          <div
            className="relative mb-2 h-2 w-full max-w-lg rounded-full"
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
          <button
            type="button"
            className="relative mx-auto w-full max-w-[260px] cursor-pointer text-left"
            style={{ perspective: '1200px' }}
            data-cursor="view"
            data-cursor-label="XOAY"
            aria-label={isBack ? 'Lật xem mặt trước thiết kế' : 'Lật xem mặt sau thiết kế'}
            aria-pressed={isBack}
            onClick={() => onToggleBack(activeItem.productId)}
          >
            <div
              data-testid="flat-rack-flip-stage"
              data-flipped={isBack ? 'true' : 'false'}
              className="relative aspect-[2/3] w-full transition-transform duration-700"
              style={{
                transformStyle: 'preserve-3d',
                transform: isBack ? 'rotateY(180deg)' : 'rotateY(0deg)',
              }}
            >
              {/* Front Face */}
              <div
                className="absolute inset-0 flex items-center justify-center overflow-hidden rounded-3xl border border-[#EBCF8F]/20 bg-[#1B130E]/60 p-3 shadow-2xl"
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
                className="absolute inset-0 flex items-center justify-center overflow-hidden rounded-3xl border border-[#EBCF8F]/35 bg-[#1B130E]/70 p-3 shadow-2xl"
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
          </button>

          {/* Quick Rail Thumbnail Strip */}
          <div className="mt-4 flex w-full max-w-full min-w-0 items-center gap-2 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
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
                  className={`h-14 w-11 shrink-0 overflow-hidden rounded-xl border p-1 transition-all ${
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
        <aside className="rack__card w-full min-w-0" id="rackCard">
          <div className="flex items-center justify-between gap-2">
            <p className="rack__idx">
              <b id="rcIdx">{String(safeIdx + 1).padStart(2, '0')}</b> /{' '}
              <span id="rcTotal">{String(items.length).padStart(2, '0')}</span>
            </p>
            <button
              type="button"
              data-testid="rack-flip-btn"
              onClick={() => onToggleBack(activeItem.productId)}
              aria-pressed={isBack}
              className="rounded-full border border-[#EBCF8F]/45 bg-[#1C1410]/70 px-3 py-1 text-[10px] tracking-[0.16em] uppercase text-[#EBCF8F] transition-colors hover:border-[#EBCF8F] hover:bg-[#EBCF8F]/15"
            >
              {isBack ? '↻ Mặt sau · Lật trước' : '↻ Mặt trước / sau'}
            </button>
          </div>

          <h3 className="rack__name" id="rcName">
            {activeItem.name}
          </h3>
          <p className="rack__flowers" id="rcFlowers">
            {activeItem.fabricComposition}
          </p>

          {/* Color Swatches */}
          {activeItem.variants.length > 0 ? (
            <div className="mt-4 flex flex-wrap items-center gap-2">
              {activeItem.variants.map((variant, vIdx) => {
                const selected = vIdx === activeVarIdx;
                return (
                  <button
                    key={variant.id}
                    type="button"
                    data-testid="rack-swatch-btn"
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

          {/* Interactive Size Selector */}
          <div className="mt-4">
            <div className="mb-1.5 flex items-center justify-between gap-2">
              <p className="text-[10px] tracking-[0.2em] uppercase text-[#FBF7EF]/60">
                Chọn kích cỡ · {activeSize}
              </p>
              {recommendedSize && inStockSet.has(recommendedSize) ? (
                <span className="text-[10px] text-[#EBCF8F]/85">
                  Hồ sơ: Size {recommendedSize}
                </span>
              ) : null}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {sizeList.map((sz) => {
                const available = inStockSet.has(sz);
                const selected = activeSize === sz;
                return (
                  <button
                    key={sz}
                    type="button"
                    data-testid="rack-size-btn"
                    disabled={!available}
                    aria-pressed={selected}
                    onClick={() => onSelectSize(activeItem.productId, sz)}
                    className={`inline-flex min-w-[36px] items-center justify-center rounded-full border px-2.5 py-1 text-[11px] tracking-[0.1em] transition-colors ${
                      selected
                        ? 'border-[#EBCF8F] bg-[#EBCF8F] font-medium text-[#1C1410]'
                        : available
                          ? 'border-[#EBCF8F]/50 bg-[#EBCF8F]/10 text-[#FBF7EF] hover:border-[#EBCF8F]'
                          : 'cursor-not-allowed border-[#FBF7EF]/15 text-[#FBF7EF]/35 line-through'
                    }`}
                  >
                    {sz}
                  </button>
                );
              })}
            </div>
          </div>

          <p className="rack__price" id="rcPrice">
            <small>Từ</small>
            {FORMAT_VND(displayPriceVnd)}
          </p>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              data-testid="rack-add-to-bag-btn"
              disabled={isAdding || !canAddToBag}
              onClick={() => onAddToBag(activeItem)}
              className="inline-flex flex-1 items-center justify-center rounded-full bg-[#EBCF8F] px-4 py-2.5 text-[11px] font-medium tracking-[0.16em] uppercase text-[#1C1410] transition-opacity hover:opacity-90 disabled:opacity-45"
            >
              {isAdding ? 'Đang thêm...' : '+ Thêm vào giỏ'}
            </button>
            {activeItem.isTryonEnabled ? (
              <button
                type="button"
                data-testid="rack-tryon-btn"
                onClick={() => onOpenTryOn(activeItem)}
                className="inline-flex items-center justify-center rounded-full border border-[#EBCF8F]/60 bg-[#2A1E17]/85 px-4 py-2.5 text-[11px] font-medium tracking-[0.14em] uppercase text-[#EBCF8F] transition-colors hover:border-[#EBCF8F] hover:bg-[#EBCF8F]/15"
              >
                ✦ Ướm thử AI
              </button>
            ) : null}
          </div>

          <div className="mt-2.5 flex items-center justify-between gap-2">
            <Link
              href={`/san-pham/${activeItem.slug}`}
              className="text-[11px] tracking-[0.16em] uppercase text-[#EBCF8F]/85 underline underline-offset-4 transition-colors hover:text-[#EBCF8F]"
            >
              Xem thiết kế →
            </Link>
            {activeSku?.skuCode ? (
              <span className="font-mono text-[10px] text-[#FBF7EF]/45">
                {activeSku.skuCode}
              </span>
            ) : null}
          </div>

          {activeFeedback ? (
            <p
              role="status"
              className={`mt-3 rounded-xl border px-3 py-2 text-[11px] ${
                activeFeedback.kind === 'success'
                  ? 'border-[#EBCF8F]/45 bg-[#2A1E17]/85 text-[#EBCF8F]'
                  : 'border-[#C96B5B]/55 bg-[#2A1815]/90 text-[#F4B8AE]'
              }`}
            >
              {activeFeedback.message}
            </p>
          ) : null}
        </aside>
      </div>

      {/* Dot Pagination */}
      <div
        className="mt-4 flex max-w-full flex-wrap items-center justify-center gap-2"
        role="tablist"
        aria-label="Chọn mẫu trên giá treo"
      >
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
