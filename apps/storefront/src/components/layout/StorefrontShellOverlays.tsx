'use client';

import dynamic from 'next/dynamic';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import {
  TryOnMode,
  type CartDto,
  type PackagingOptionDto,
  type ProductSpuDto,
  type StorefrontBootstrapDto,
} from '@atelier/contracts';
import { StorefrontChatDrawer } from '@/components/chat/StorefrontChatDrawer';
import { QuickBagDrawer } from '@/features/drawer-bag/QuickBagDrawer';
import { apiFetch } from '@/lib/api-client';
import {
  FALLBACK_PRODUCTS,
  PACKAGING_TIERS,
  extractProductArray,
} from '@/lib/catalog-data';
import {
  emitCartUpdated,
  onOpenQuickBag,
  onOpenVirtualTryOn,
  refreshCartCount,
  type OpenTryOnOptions,
} from '@/lib/storefront-actions';

const VirtualTryOnModal = dynamic(
  () =>
    import('@/features/virtual-tryon/VirtualTryOnModal').then(
      (m) => m.VirtualTryOnModal,
    ),
  {
    ssr: false,
    loading: () => null,
  },
);

const FALLBACK_PACKAGING_OPTIONS: PackagingOptionDto[] = PACKAGING_TIERS.map(
  (pkg, index) => ({
    id: pkg.id,
    code: pkg.id,
    name: pkg.name,
    description: pkg.description,
    swatchHex: pkg.swatchHex,
    priceVnd: pkg.priceVnd,
    backAssetUrl: null,
    frontAssetUrl: null,
    isDefault: index === 0,
    sortOrder: index + 1,
  }),
);

export function StorefrontShellOverlays() {
  const pathname = usePathname();
  const [products, setProducts] = useState<ProductSpuDto[]>(FALLBACK_PRODUCTS);
  const [packagingOptions, setPackagingOptions] = useState<PackagingOptionDto[]>(
    FALLBACK_PACKAGING_OPTIONS,
  );
  const [catalogLoaded, setCatalogLoaded] = useState(false);

  // Global QuickBagDrawer state
  const [bagOpen, setBagOpen] = useState(false);
  const [quickProduct, setQuickProduct] = useState<ProductSpuDto | null>(null);

  // Global VirtualTryOnModal state
  const [tryOnOpen, setTryOnOpen] = useState(false);
  const [tryOnOpts, setTryOnOpts] = useState<OpenTryOnOptions>({
    mode: TryOnMode.SINGLE,
  });

  // Global Customer Stylist Chat Drawer state + Camera Active guard
  const [chatOpen, setChatOpen] = useState(false);
  const [cameraActive, setCameraActive] = useState(false);

  useEffect(() => {
    if (typeof document === 'undefined' || !document.body) {
      setCameraActive(pathname?.startsWith('/thu-do-ai') ?? false);
      return undefined;
    }

    const syncCameraActive = () => {
      const bodyActive =
        document.body.dataset.cameraActive === 'true' ||
        document.body.classList.contains('camera-active');
      const isTryOnRoute = Boolean(pathname?.startsWith('/thu-do-ai'));
      setCameraActive(bodyActive || isTryOnRoute);
    };

    syncCameraActive();

    const observer = new MutationObserver(syncCameraActive);
    observer.observe(document.body, {
      attributes: true,
      attributeFilter: ['data-camera-active', 'class'],
    });

    return () => {
      observer.disconnect();
    };
  }, [pathname]);

  // Subscribe to global custom events from SiteHeader, PDP, OutfitStudio, etc.
  useEffect(() => {
    const offBag = onOpenQuickBag((detail) => {
      setQuickProduct(detail.quickProduct ?? null);
      setTryOnOpen(false);
      setChatOpen(false);
      setBagOpen(true);
    });

    const offTryOn = onOpenVirtualTryOn((opts) => {
      setTryOnOpts({
        mode: opts.mode ?? TryOnMode.SINGLE,
        upper: opts.upper ?? null,
        lower: opts.lower ?? null,
        onePiece: opts.onePiece ?? null,
        outerwear: opts.outerwear ?? null,
      });
      setBagOpen(false);
      setChatOpen(false);
      setTryOnOpen(true);
    });

    return () => {
      offBag();
      offTryOn();
    };
  }, []);

  // Silently hydrate live BFF products & packaging options without ever blocking FALLBACK_PRODUCTS
  useEffect(() => {
    if (catalogLoaded || (!bagOpen && !tryOnOpen && !chatOpen)) return;

    let cancelled = false;
    void Promise.allSettled([
      apiFetch<StorefrontBootstrapDto>('/bff/v1/storefront/bootstrap', {
        skipAuthRefresh: true,
        timeoutMs: 3500,
      }),
      apiFetch<unknown>('/bff/v1/storefront/products?limit=24', {
        skipAuthRefresh: true,
        timeoutMs: 3500,
      }),
    ])
      .then(([bootSettled, listSettled]) => {
        if (cancelled) return;
        const bootRes = bootSettled.status === 'fulfilled' ? bootSettled.value : null;
        const listRes = listSettled.status === 'fulfilled' ? listSettled.value : null;

        if (bootRes?.ok && bootRes.data?.packagingOptions?.length) {
          setPackagingOptions(bootRes.data.packagingOptions);
        }
        const listProducts = listRes?.ok ? extractProductArray(listRes.data) : [];
        if (listProducts.length > 0) {
          setProducts(listProducts);
        } else if (bootRes?.ok && bootRes.data?.featuredProducts?.length) {
          setProducts(bootRes.data.featuredProducts);
        }
        setCatalogLoaded(true);
      })
      .catch(() => {
        if (!cancelled) {
          setCatalogLoaded(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [bagOpen, tryOnOpen, chatOpen, catalogLoaded]);

  const handleCartChange = (cart: CartDto | null) => {
    if (cart) {
      emitCartUpdated(cart);
    } else {
      refreshCartCount();
    }
  };

  const handleAddedFromTryOn = (cart?: CartDto | null) => {
    if (cart) {
      emitCartUpdated(cart);
    } else {
      refreshCartCount();
    }
    setTryOnOpen(false);
    setQuickProduct(null);
    setBagOpen(true);
  };

  return (
    <>
      <QuickBagDrawer
        open={bagOpen}
        onClose={() => {
          setBagOpen(false);
          setQuickProduct(null);
        }}
        quickProduct={quickProduct}
        packagingOptions={packagingOptions}
        onCartChange={handleCartChange}
      />

      {tryOnOpen ? (
        <VirtualTryOnModal
          open={tryOnOpen}
          onClose={() => setTryOnOpen(false)}
          initialMode={tryOnOpts.mode ?? TryOnMode.SINGLE}
          initialUpper={tryOnOpts.upper ?? null}
          initialLower={tryOnOpts.lower ?? null}
          initialOnePiece={tryOnOpts.onePiece ?? null}
          initialOuterwear={tryOnOpts.outerwear ?? null}
          products={products}
          onAddedToBag={handleAddedFromTryOn}
        />
      ) : null}

      <StorefrontChatDrawer
        open={chatOpen}
        onOpenChange={(nextOpen) => {
          if (nextOpen) {
            setBagOpen(false);
          }
          setChatOpen(nextOpen);
        }}
        hidden={tryOnOpen || cameraActive}
        products={products}
      />
    </>
  );
}
