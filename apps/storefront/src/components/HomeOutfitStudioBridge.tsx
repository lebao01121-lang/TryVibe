'use client';

import type { PackagingOptionDto, ProductSpuDto } from '@atelier/contracts';
import { LiveSizeAdvisor } from '@/components/LiveSizeAdvisor';
import { OutfitStudio } from '@/features/outfit-studio/OutfitStudio';
import {
  openQuickBagDrawer,
  openVirtualTryOnModal,
  type OpenTryOnOptions,
} from '@/lib/storefront-actions';

export interface HomeOutfitStudioBridgeProps {
  products: ProductSpuDto[];
  packagingOptions: PackagingOptionDto[];
  initialShareCode?: string | null;
  showSizeAdvisor?: boolean;
}

export function HomeOutfitStudioBridge({
  products,
  packagingOptions,
  initialShareCode = null,
  showSizeAdvisor = false,
}: HomeOutfitStudioBridgeProps) {
  const handleOpenBag = () => {
    openQuickBagDrawer(null);
  };

  const handleOpenTryOn = (opts: OpenTryOnOptions) => {
    openVirtualTryOnModal(opts);
  };

  return (
    <div data-nav-theme="light" className="bg-[#FBF7EF] text-[#2B2019]">
      <OutfitStudio
        products={products}
        packagingOptions={packagingOptions}
        initialShareCode={initialShareCode}
        onOpenBag={handleOpenBag}
        onOpenTryOn={handleOpenTryOn}
      />
      {showSizeAdvisor ? (
        <div
          data-nav-theme="light"
          className="mx-auto max-w-[1400px] px-4 pb-20 sm:px-6 lg:px-10"
        >
          <div className="overflow-hidden rounded-3xl">
            <LiveSizeAdvisor products={products} />
          </div>
        </div>
      ) : null}
    </div>
  );
}
