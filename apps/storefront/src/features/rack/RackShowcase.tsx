'use client';

import { useGSAP } from '@gsap/react';
import Link from 'next/link';
import { useRef, useState } from 'react';
import type { ProductSpuDto } from '@atelier/contracts';
import { MagneticButton } from '@/components/motion/MagneticButton';
import { FORMAT_VND, getPrimaryVariantImage } from '@/lib/catalog-data';
import { ensureGsapRegistered, gsap } from '@/lib/gsap-setup';

type RackFilterKey =
  | 'all'
  | 'tryon'
  | 'ao-blazer'
  | 'quan-chan-vay'
  | 'dam-du-tiec';

const FILTER_PILLS: Array<{ key: RackFilterKey; label: string }> = [
  { key: 'all', label: 'Tất cả' },
  { key: 'tryon', label: 'Hỗ trợ Thử đồ AI' },
  { key: 'ao-blazer', label: 'Áo & Blazer' },
  { key: 'quan-chan-vay', label: 'Quần & Chân váy' },
  { key: 'dam-du-tiec', label: 'Đầm' },
];

export interface RackShowcaseProps {
  products: ProductSpuDto[];
}

export function RackShowcase({ products }: RackShowcaseProps) {
  const sectionRef = useRef<HTMLElement | null>(null);
  const [filter, setFilter] = useState<RackFilterKey>('all');
  const [activeIndex, setActiveIndex] = useState(0);
  const [variantByProduct, setVariantByProduct] = useState<Record<string, number>>({});

  const filtered = products.filter((p) => {
    if (filter === 'all') return true;
    if (filter === 'tryon') return p.isTryonEnabled;
    if (filter === 'ao-blazer') {
      return (
        p.categorySlug === 'ao-blazer' ||
        p.categorySlug === 'ao-so-mi' ||
        p.categorySlug === 'ao-khoac'
      );
    }
    return p.categorySlug === filter;
  });

  const safeIndex =
    filtered.length > 0 ? Math.min(activeIndex, filtered.length - 1) : 0;
  const activeProduct = filtered[safeIndex] ?? products[0];
  const activeVariantIdx = activeProduct
    ? variantByProduct[activeProduct.id] ?? 0
    : 0;

  useGSAP(
    () => {
      ensureGsapRegistered();
      gsap.fromTo(
        '.rack__card',
        { opacity: 0.72, y: 8 },
        { opacity: 1, y: 0, duration: 0.45, ease: 'power3.out' },
      );
    },
    { scope: sectionRef, dependencies: [safeIndex, filter] },
  );

  return (
    <section
      ref={sectionRef}
      className="rack py-24 lg:py-28"
      id="rack"
      data-nav-theme="dark"
    >
      <div className="rack__wall" aria-hidden="true" />

      <div className="relative z-10 mx-auto max-w-7xl px-6 lg:px-10">
        <div className="flex flex-col justify-between gap-6 lg:flex-row lg:items-end">
          <div>
            <p className="eyebrow">Bộ sưu tập · Giá treo thanh đồng</p>
            <h2 className="h2">
              Chọn một dáng,
              <br />
              <em>thiết kế sẽ bước ra.</em>
            </h2>
          </div>

          <div className="flex flex-wrap gap-2">
            {FILTER_PILLS.map((pill) => {
              const selected = pill.key === filter;
              return (
                <button
                  key={pill.key}
                  type="button"
                  onClick={() => {
                    setFilter(pill.key);
                    setActiveIndex(0);
                  }}
                  className={`rounded-full px-4 py-2 text-xs transition-colors ${
                    selected
                      ? 'bg-[#EBCF8F] font-medium text-[#1C1410]'
                      : 'border border-[#EBCF8F]/35 bg-[#241A14]/70 text-[#FBF7EF]/85 hover:border-[#EBCF8F]'
                  }`}
                >
                  {pill.label}
                </button>
              );
            })}
          </div>
        </div>

        <div className="mt-12 grid items-start gap-8 lg:grid-cols-[1.55fr_360px]">
          {/* Interactive 2:3 Cutout & 3:4 Flat-Lay Hover Cross-Fade Gallery */}
          <div className="grid gap-5 sm:grid-cols-2 md:grid-cols-3">
            {filtered.slice(0, 6).map((product, idx) => {
              const varIdx = variantByProduct[product.id] ?? 0;
              const { lookbookUrl, flatUrl } = getPrimaryVariantImage(
                product,
                varIdx,
              );
              const rackCutoutUrl =
                product.variants[varIdx]?.rackFrontUrl || lookbookUrl;
              const isSelected = idx === safeIndex;

              return (
                <article
                  key={product.id}
                  onMouseEnter={() => setActiveIndex(idx)}
                  onFocus={() => setActiveIndex(idx)}
                  data-cursor="view"
                  data-cursor-label={product.isTryonEnabled ? 'Thử AI' : 'Xem'}
                  className={`group flex flex-col rounded-3xl border p-3 transition-all ${
                    isSelected
                      ? 'border-[#EBCF8F]/70 bg-[#2A1E17]/85 shadow-2xl'
                      : 'border-[#B08A4A]/25 bg-[#221812]/65 hover:border-[#EBCF8F]/50'
                  }`}
                >
                  <div className="relative aspect-[2/3] overflow-hidden rounded-2xl bg-[#160F0C]">
                    <Link
                      href={`/san-pham/${product.slug}`}
                      className="block h-full w-full"
                    >
                      <img
                        src={rackCutoutUrl}
                        alt={`${product.name} — Ảnh giá treo 2:3`}
                        className="h-full w-full object-contain p-2 transition-opacity duration-500 group-hover:opacity-0"
                      />
                      <img
                        src={flatUrl}
                        alt={`${product.name} — Ảnh phẳng 3:4`}
                        className="absolute inset-0 h-full w-full bg-[#F8F4EC] object-contain p-2 opacity-0 transition-opacity duration-500 group-hover:opacity-100"
                      />
                    </Link>

                    {product.isTryonEnabled ? (
                      <Link
                        href={`/san-pham/${product.slug}?tryon=1`}
                        className="absolute right-2.5 bottom-2.5 rounded-full border border-[#EBCF8F]/60 bg-[#1C1410]/90 px-3 py-1 text-[10px] uppercase tracking-[0.16em] text-[#EBCF8F]"
                      >
                        Ướm thử AI
                      </Link>
                    ) : null}
                  </div>

                  <div className="mt-3 flex items-center justify-between gap-2 px-1">
                    <Link
                      href={`/san-pham/${product.slug}`}
                      className="truncate font-editorial text-xl text-[#FBF7EF] hover:text-[#EBCF8F]"
                    >
                      {product.name}
                    </Link>
                    <span className="shrink-0 font-editorial text-base text-[#EBCF8F]">
                      {FORMAT_VND(product.minPriceVnd)}
                    </span>
                  </div>
                </article>
              );
            })}
          </div>

          {/* Frosted Glass Featured Rack Card (.rack__card) */}
          {activeProduct ? (
            <aside className="rack__card lg:sticky lg:top-28" id="rackCard">
              <p className="rack__idx">
                <b>{String(safeIndex + 1).padStart(2, '0')}</b> /{' '}
                <span>{String(filtered.length || products.length).padStart(2, '0')}</span>
              </p>
              <h3 className="rack__name">{activeProduct.name}</h3>
              <p className="rack__flowers">{activeProduct.fabricComposition}</p>

              <div className="mt-4 flex flex-wrap items-center gap-2">
                {activeProduct.variants.map((variant, vIdx) => (
                  <button
                    key={variant.id}
                    type="button"
                    title={variant.colorName}
                    aria-label={`Màu ${variant.colorName}`}
                    onClick={() =>
                      setVariantByProduct((prev) => ({
                        ...prev,
                        [activeProduct.id]: vIdx,
                      }))
                    }
                    className={`h-5 w-5 rounded-full border transition-transform ${
                      vIdx === activeVariantIdx
                        ? 'scale-110 border-[#EBCF8F] ring-2 ring-[#B08A4A]'
                        : 'border-[#FBF7EF]/35'
                    }`}
                    style={{ backgroundColor: variant.colorHex }}
                  />
                ))}
                <span className="text-xs text-[#EBCF8F]/80">
                  {activeProduct.variants[activeVariantIdx]?.colorName}
                </span>
              </div>

              <p className="rack__price">
                <small>Từ</small>
                {FORMAT_VND(activeProduct.minPriceVnd)}
              </p>

              <div className="flex flex-wrap gap-3">
                <MagneticButton
                  href={`/san-pham/${activeProduct.slug}`}
                  className="btn btn--line text-[#EBCF8F]"
                  cursorLabel="Chọn"
                >
                  Xem &amp; Chọn Size
                </MagneticButton>
                {activeProduct.isTryonEnabled ? (
                  <Link
                    href={`/san-pham/${activeProduct.slug}?tryon=1`}
                    className="inline-flex items-center rounded-full border border-[#FBF7EF]/30 px-4 py-2 text-[11px] uppercase tracking-[0.16em] text-[#FBF7EF]/85 hover:border-[#EBCF8F] hover:text-[#EBCF8F]"
                  >
                    Thử đồ AI
                  </Link>
                ) : null}
              </div>
            </aside>
          ) : null}
        </div>
      </div>
    </section>
  );
}
