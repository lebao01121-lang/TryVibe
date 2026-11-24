'use client';

import Link from 'next/link';
import type { ProductSpuDto } from '@atelier/contracts';
import { getPrimaryVariantImage, type SeasonDrop } from '@/lib/catalog-data';

export interface SeasonLookbookTrackProps {
  seasons: SeasonDrop[];
  products: ProductSpuDto[];
}

export function SeasonLookbookTrack({
  seasons,
  products,
}: SeasonLookbookTrackProps) {
  return (
    <section
      className="seasons py-24 lg:py-28"
      id="seasons"
      data-nav-theme="light"
    >
      <div className="mx-auto max-w-7xl px-6 lg:px-10">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="eyebrow">Lịch Bộ Sưu Tập · 6 Mùa Atelier</p>
            <h2 className="h2">
              Mùa nào
              <br />
              <em>chất liệu nấy.</em>
            </h2>
          </div>
          <Link
            href="/bo-suu-tap"
            className="text-xs uppercase tracking-[0.2em] text-[#8A672C] underline underline-offset-4"
          >
            Xem toàn bộ Lookbook →
          </Link>
        </div>

        <div className="mt-10 flex gap-6 overflow-x-auto pb-6 snap-x snap-mandatory">
          {seasons.map((season, index) => {
            const matchedProduct =
              products.find((p) => p.seasonSlugs.includes(season.slug)) ??
              products[index % Math.max(1, products.length)];
            const { lookbookUrl } = matchedProduct
              ? getPrimaryVariantImage(matchedProduct, 0)
              : { lookbookUrl: '' };

            return (
              <Link
                key={season.slug}
                href={`/bo-suu-tap?season=${encodeURIComponent(season.slug)}`}
                data-cursor="view"
                data-cursor-label="Xem"
                className="scard w-[260px] shrink-0 snap-start sm:w-[300px]"
              >
                <div className="scard__frame">
                  {season.isCurrent ? (
                    <span className="scard__now">Đang mở bán</span>
                  ) : null}
                  {lookbookUrl ? (
                    <img
                      src={lookbookUrl}
                      alt={season.title}
                      className="h-full w-full object-cover transition-transform duration-700 hover:scale-105"
                    />
                  ) : null}
                </div>
                <p className="scard__m">{season.months}</p>
                <h3 className="scard__n">{season.title}</h3>
                <p className="scard__t">{season.note}</p>
              </Link>
            );
          })}
        </div>
      </div>
    </section>
  );
}
