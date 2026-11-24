'use client';

import {
  TryOnGarmentCategory,
  TryOnMode,
  type CartDto,
  type ProductSpuDto,
} from '@atelier/contracts';
import { VirtualTryOnModal } from '@/features/virtual-tryon/VirtualTryOnModal';
import { FALLBACK_PRODUCTS } from '@/lib/catalog-data';
import {
  emitCartUpdated,
  openQuickBagDrawer,
  refreshCartCount,
  type TryOnGarmentRef,
} from '@/lib/storefront-actions';

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
