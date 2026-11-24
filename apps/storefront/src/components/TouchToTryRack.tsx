'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { ProductSpuDto } from '@atelier/contracts';
import { FORMAT_VND, getPrimaryVariantImage } from '@/lib/catalog-data';

type RackFilterKey = 'all' | 'tryon' | 'ao-blazer' | 'quan-chan-vay' | 'dam-du-tiec';

const FILTER_PILLS: Array<{ key: RackFilterKey; label: string }> = [
  { key: 'all', label: 'Tất cả' },
  { key: 'tryon', label: 'Hỗ trợ Thử đồ AI' },
  { key: 'ao-blazer', label: 'Áo & Blazer' },
  { key: 'quan-chan-vay', label: 'Quần & Chân váy' },
  { key: 'dam-du-tiec', label: 'Đầm' },
];

export interface TouchToTryRackProps {
  products: ProductSpuDto[];
}

export function TouchToTryRack({ products }: TouchToTryRackProps) {
  const [activeFilter, setActiveFilter] = useState<RackFilterKey>('all');
  const [selectedVariantByProduct, setSelectedVariantByProduct] = useState<
    Record<string, number>
  >({});

  const visibleProducts = products.filter((product) => {
    if (activeFilter === 'all') return true;
    if (activeFilter === 'tryon') return product.isTryonEnabled;
    if (activeFilter === 'ao-blazer') {
      return (
        product.categorySlug === 'ao-blazer' ||
        product.categorySlug === 'ao-so-mi' ||
        product.categorySlug === 'ao-khoac'
      );
    }
    return product.categorySlug === activeFilter;
  });

  return (
    <section className="mx-auto max-w-7xl px-6 py-16 lg:px-10">
      <div className="flex flex-col justify-between gap-5 md:flex-row md:items-end">
        <div>
          <p className="atelier-eyebrow text-[#8A672C]">
            Kệ Thời Trang Tương Tác · Lookbook ↔ 3:4 Flat-Lay
          </p>
          <h2 className="font-editorial mt-2 text-4xl font-light text-[#2B2019] lg:text-5xl">
            Chạm Để Mặc Thử
          </h2>
          <p className="mt-2 max-w-2xl text-sm text-[#7A6A5B]">
            Di chuột qua từng thiết kế để chuyển mượt từ ảnh Lookbook sang ảnh
            phẳng 3:4 chuẩn hóa cho phòng thử đồ AI.
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          {FILTER_PILLS.map((pill) => {
            const active = pill.key === activeFilter;
            return (
              <button
                key={pill.key}
                type="button"
                onClick={() => setActiveFilter(pill.key)}
                className={`rounded-full px-4 py-2 text-xs transition-colors ${
                  active
                    ? 'bg-[#1C1410] text-[#EBCF8F]'
                    : 'border border-[#B08A4A]/35 bg-[#FBF7EF] text-[#2B2019] hover:border-[#8A672C]'
                }`}
              >
                {pill.label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="mt-8 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
        {visibleProducts.slice(0, 8).map((product) => {
          const variantIndex = selectedVariantByProduct[product.id] ?? 0;
          const activeVariant =
            product.variants[variantIndex] ?? product.variants[0];
          const { lookbookUrl, flatUrl } = getPrimaryVariantImage(
            product,
            variantIndex,
          );
          const availableSizesCount =
            activeVariant?.skus.filter((sku) => sku.inStock).length ?? 0;

          return (
            <article
              key={product.id}
              className="group flex flex-col rounded-3xl border border-[#B08A4A]/25 bg-[#FBF7EF] p-3.5 transition-all hover:border-[#8A672C] hover:shadow-xl"
            >
              <div className="relative aspect-[3/4] overflow-hidden rounded-2xl bg-[#241A14]">
                <Link
                  href={`/san-pham/${product.slug}`}
                  className="block h-full w-full"
                >
                  <img
                    src={lookbookUrl}
                    alt={`${product.name} — Ảnh Lookbook`}
                    className="h-full w-full object-cover transition-opacity duration-500 group-hover:opacity-0"
                  />
                  <img
                    src={flatUrl}
                    alt={`${product.name} — Ảnh phẳng 3:4 thử đồ AI`}
                    className="absolute inset-0 h-full w-full object-contain bg-[#F8F4EC] opacity-0 transition-opacity duration-500 group-hover:opacity-100"
                  />
                </Link>

                {product.isTryonEnabled ? (
                  <Link
                    href={`/san-pham/${product.slug}?tryon=1`}
                    className="absolute right-3 bottom-3 rounded-full border border-[#EBCF8F]/60 bg-[#1C1410]/90 px-3.5 py-1.5 text-[10px] font-medium uppercase tracking-[0.18em] text-[#EBCF8F] backdrop-blur-sm transition-transform group-hover:scale-105"
                  >
                    Ướm thử AI
                  </Link>
                ) : null}

                <span className="absolute top-3 left-3 rounded-full bg-[#1C1410]/80 px-2.5 py-1 text-[10px] uppercase tracking-[0.16em] text-[#FBF7EF]">
                  {product.categoryName}
                </span>
              </div>

              <div className="mt-4 flex flex-1 flex-col justify-between px-1">
                <div>
                  <Link
                    href={`/san-pham/${product.slug}`}
                    className="font-editorial block text-2xl leading-tight text-[#1C1410] transition-colors hover:text-[#8A672C]"
                  >
                    {product.name}
                  </Link>
                  <p className="mt-1 line-clamp-1 text-xs text-[#7A6A5B]">
                    {product.fabricComposition}
                  </p>
                </div>

                <div className="mt-3 flex items-center justify-between gap-2 pt-2">
                  <div className="flex items-center gap-1.5">
                    {product.variants.map((variant, idx) => (
                      <button
                        key={variant.id}
                        type="button"
                        title={variant.colorName}
                        aria-label={`Chọn màu ${variant.colorName}`}
                        onClick={() =>
                          setSelectedVariantByProduct((prev) => ({
                            ...prev,
                            [product.id]: idx,
                          }))
                        }
                        className={`h-4 w-4 rounded-full border transition-transform ${
                          idx === variantIndex
                            ? 'scale-110 border-[#1C1410] ring-1 ring-[#B08A4A]'
                            : 'border-[#2B2019]/30'
                        }`}
                        style={{ backgroundColor: variant.colorHex }}
                      />
                    ))}
                    <span className="ml-1 text-[11px] text-[#7A6A5B]">
                      {availableSizesCount} cỡ
                    </span>
                  </div>

                  <span className="font-editorial text-xl text-[#8A672C]">
                    {FORMAT_VND(product.minPriceVnd)}
                  </span>
                </div>
              </div>
            </article>
          );
        })}
      </div>

      {visibleProducts.length === 0 ? (
        <p className="mt-8 rounded-2xl border border-[#B08A4A]/25 bg-[#F4EBDA]/50 p-6 text-center text-sm text-[#7A6A5B]">
          Không có thiết kế phù hợp bộ lọc hiện tại. Vui lòng chọn danh mục khác.
        </p>
      ) : null}
    </section>
  );
}
