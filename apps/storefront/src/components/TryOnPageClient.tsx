'use client';

import dynamic from 'next/dynamic';
import {
  TryOnGarmentCategory,
  TryOnMode,
  type CartDto,
  type ProductSpuDto,
} from '@atelier/contracts';
import { FALLBACK_PRODUCTS } from '@/lib/catalog-data';
import {
  emitCartUpdated,
  openQuickBagDrawer,
  refreshCartCount,
  type TryOnGarmentRef,
} from '@/lib/storefront-actions';

function TryOnStudioSkeleton() {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-label="Đang khởi tạo Phòng Thử Đồ 3D AR"
      className="relative mx-auto flex min-h-[640px] w-full max-w-[1280px] flex-col overflow-hidden rounded-3xl border border-[#B08A4A]/35 bg-[#1C1410] text-[#FBF7EF] shadow-2xl"
    >
      <div className="flex items-center justify-between border-b border-[#B08A4A]/22 bg-[#231914]/96 px-5 py-3.5">
        <div className="space-y-1.5">
          <p className="text-[10px] font-medium tracking-[0.22em] uppercase text-[#EBCF8F]">
            PHÒNG THỬ ĐỒ 3D AR · VIRTUAL TRY-ON ATELIER
          </p>
          <div className="h-5 w-64 animate-pulse rounded-full bg-[#3A2B22]" />
        </div>
        <div className="h-8 w-28 animate-pulse rounded-full border border-[#B08A4A]/30 bg-[#2A1E17]" />
      </div>

      <div className="grid flex-1 gap-6 p-6 lg:grid-cols-[1.35fr_0.85fr]">
        <div className="flex flex-col items-center justify-center rounded-2xl border border-[#B08A4A]/20 bg-gradient-to-b from-[#2A1E17] via-[#1C1410] to-[#150F0C] p-8 text-center">
          <div className="mb-5 flex h-16 w-16 items-center justify-center rounded-full border border-[#B08A4A]/45 bg-[#231914] font-editorial text-xl tracking-wider text-[#EBCF8F]">
            T&amp;X
          </div>
          <p className="font-editorial text-2xl font-light text-[#FBF7EF]">
            Đang chuẩn bị Gương Thử Đồ 3D...
          </p>
          <p className="mt-2 max-w-sm text-xs leading-relaxed text-[#C9B8A3]">
            Khởi tạo không gian ánh sáng Atelier và mô hình dựng phom 3D trực
            tiếp trên thiết bị của bạn.
          </p>
          <div className="mt-6 h-1 w-48 overflow-hidden rounded-full bg-[#3A2B22]">
            <div className="h-full w-1/2 animate-pulse rounded-full bg-[#EBCF8F]/75" />
          </div>
        </div>

        <div className="flex flex-col gap-4 rounded-2xl border border-[#B08A4A]/20 bg-[#231914]/75 p-5">
          <div className="h-4 w-36 animate-pulse rounded bg-[#3A2B22]" />
          <div className="grid grid-cols-2 gap-3">
            <div className="h-32 animate-pulse rounded-xl bg-[#2A1E17]" />
            <div className="h-32 animate-pulse rounded-xl bg-[#2A1E17]" />
            <div className="h-32 animate-pulse rounded-xl bg-[#2A1E17]" />
            <div className="h-32 animate-pulse rounded-xl bg-[#2A1E17]" />
          </div>
          <div className="mt-auto h-11 w-full animate-pulse rounded-full bg-[#B08A4A]/25" />
        </div>
      </div>
    </div>
  );
}

const VirtualTryOnModal = dynamic(
  () =>
    import('@/features/virtual-tryon/VirtualTryOnModal').then(
      (m) => m.VirtualTryOnModal,
    ),
  {
    ssr: false,
    loading: () => <TryOnStudioSkeleton />,
  },
);

export interface TryOnPageClientProps {
  products: ProductSpuDto[];
  initialSlug?: string | null;
  initialVariantId?: string | null;
}

function isOuterwearProduct(product: ProductSpuDto | null): boolean {
  if (!product) return false;
  const text = `${product.categorySlug ?? ''} ${product.categoryName ?? ''} ${product.slug} ${product.name}`.toLowerCase();
  return (
    text.includes('blazer') ||
    text.includes('trench') ||
    text.includes('jacket') ||
    text.includes('coat') ||
    text.includes('ao-khoac') ||
    text.includes('áo khoác') ||
    text.includes('măng tô') ||
    text.includes('mang-to') ||
    text.includes('cardigan') ||
    text.includes('gile') ||
    text.includes('outerwear')
  );
}

export function TryOnPageClient({
  products,
  initialSlug = null,
  initialVariantId = null,
}: TryOnPageClientProps) {
  const effectiveProducts = products.length > 0 ? products : FALLBACK_PRODUCTS;

  const matchedProduct =
    (initialSlug ? effectiveProducts.find((p) => p.slug === initialSlug) : null) ??
    effectiveProducts.find((p) => p.isTryonEnabled) ??
    effectiveProducts[0] ??
    null;

  const matchedVariant =
    (initialVariantId
      ? matchedProduct?.variants.find((v) => v.id === initialVariantId)
      : null) ?? matchedProduct?.variants[0];

  const initialRef: TryOnGarmentRef | null = matchedProduct
    ? {
        productId: matchedProduct.id,
        variantId: matchedVariant?.id,
        skuId:
          matchedVariant?.skus.find((s) => s.inStock)?.id ??
          matchedVariant?.skus[0]?.id,
        slug: matchedProduct.slug,
      }
    : null;

  const isOnePiece =
    matchedProduct?.tryonGarmentCategory === TryOnGarmentCategory.OVERALL;
  const isLower =
    matchedProduct?.tryonGarmentCategory === TryOnGarmentCategory.LOWER;
  const isOuterwear =
    !isOnePiece && !isLower && isOuterwearProduct(matchedProduct);

  const handleAddedToBag = (cart?: CartDto | null) => {
    if (cart) {
      emitCartUpdated(cart);
    } else {
      refreshCartCount();
    }
    openQuickBagDrawer(null);
  };

  return (
    <VirtualTryOnModal
      open
      embedded
      products={effectiveProducts}
      initialMode={TryOnMode.SINGLE}
      initialUpper={!isOnePiece && !isLower && !isOuterwear ? initialRef : null}
      initialLower={isLower ? initialRef : null}
      initialOnePiece={isOnePiece ? initialRef : null}
      initialOuterwear={isOuterwear ? initialRef : null}
      onAddedToBag={handleAddedToBag}
    />
  );
}
