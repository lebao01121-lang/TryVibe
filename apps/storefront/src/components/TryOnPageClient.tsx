'use client';

import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import { useCallback } from 'react';
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
      aria-label="Đang khởi tạo Phòng Thử Đồ AI"
      className="fixed inset-0 z-[1200] flex h-[100svh] w-screen flex-col overflow-hidden bg-[#18120E] text-[#FBF7EF]"
    >
      <div className="flex h-16 shrink-0 items-center justify-between border-b border-[#B08A4A]/22 bg-[#18120E] px-5">
        <div className="space-y-1">
          <p className="text-[10px] font-medium tracking-[0.22em] uppercase text-[#EBCF8F]">
            PHÒNG THỬ ĐỒ AI · VIRTUAL TRY-ON ATELIER
          </p>
          <p className="font-editorial text-xl font-light text-[#FBF7EF]">
            Ướm thử trực tiếp trên vóc dáng thật
          </p>
        </div>
        <div className="h-8 w-48 animate-pulse rounded-full border border-[#B08A4A]/30 bg-[#241A14]" />
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 p-4 lg:grid-cols-[minmax(0,1.1fr)_minmax(380px,0.9fr)]">
        <div className="flex flex-col items-center justify-center rounded-2xl border border-[#B08A4A]/22 bg-gradient-to-b from-[#241A14] via-[#1C1410] to-[#140E0B] p-8 text-center">
          <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-full border border-[#B08A4A]/45 bg-[#1F1712] font-editorial text-lg tracking-wider text-[#EBCF8F]">
            T&amp;V
          </div>
          <p className="font-editorial text-2xl font-light text-[#FBF7EF]">
            Đang chuẩn bị Phòng Thử Đồ AI...
          </p>
          <p className="mt-2 max-w-sm text-xs leading-relaxed text-[#C9B8A3]">
            Khởi tạo Gương Camera Thông Minh, ánh sáng Atelier và bảo mật tự động xóa ảnh sau 15 phút.
          </p>
          <div className="mt-5 h-1 w-44 overflow-hidden rounded-full bg-[#3A2B22]">
            <div className="h-full w-1/2 animate-pulse rounded-full bg-[#EBCF8F]/75" />
          </div>
        </div>

        <div className="flex flex-col gap-3 rounded-2xl border border-[#B08A4A]/20 bg-[#1F1713] p-4">
          <div className="h-8 w-full animate-pulse rounded-xl bg-[#2A1E17]" />
          <div className="grid flex-1 grid-cols-3 gap-2">
            <div className="aspect-[3/4] animate-pulse rounded-xl bg-[#2A1E17]" />
            <div className="aspect-[3/4] animate-pulse rounded-xl bg-[#2A1E17]" />
            <div className="aspect-[3/4] animate-pulse rounded-xl bg-[#2A1E17]" />
          </div>
          <div className="h-12 w-full animate-pulse rounded-full bg-[#B08A4A]/30" />
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
  const router = useRouter();
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

  const handleClose = useCallback(() => {
    if (typeof window !== 'undefined' && window.history.length > 1) {
      router.back();
    } else {
      router.push('/');
    }
  }, [router]);

  const handleAddedToBag = useCallback((cart?: CartDto | null) => {
    if (cart) {
      emitCartUpdated(cart);
    } else {
      refreshCartCount();
    }
    openQuickBagDrawer(null);
  }, []);

  return (
    <VirtualTryOnModal
      open
      embedded
      onClose={handleClose}
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
