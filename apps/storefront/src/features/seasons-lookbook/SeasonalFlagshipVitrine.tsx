'use client';

import { useGSAP } from '@gsap/react';
import { useLenis } from 'lenis/react';
import Link from 'next/link';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import {
  HTTP_HEADERS,
  TryOnMode,
  type CartDto,
  type ProductSpuDto,
  type SeasonAiRestyleResponse,
  type SeasonalCollectionDto,
  type SeasonWearableSlot,
  type SeasonWearableVariant,
} from '@atelier/contracts';
import { usePrefersReducedMotion } from '@atelier/motion-kit';
import { apiFetch } from '@/lib/api-client';
import { FORMAT_VND } from '@/lib/catalog-data';
import { ensureGsapRegistered, gsap, ScrollTrigger } from '@/lib/gsap-setup';
import { getOrCreateGuestSessionId } from '@/lib/guest-session';
import {
  emitCartUpdated,
  openQuickBagDrawer,
  openVirtualTryOnModal,
  type OpenTryOnOptions,
  type TryOnGarmentRef,
} from '@/lib/storefront-actions';
import {
  getMacroFallbackUrl,
  getOccasionMacroFallbackUrl,
  getSeasonLookbookFallbackUrl,
  getSeasonMaskFallbackUrl,
  getVariantDefaultFallbackUrl,
  hasSlotPhotometricCoverage,
  InteractiveAiLookbookStage,
  resolveSeasonsVitrineUrl,
  type ScanBeamTrigger,
  type SeasonChapterView,
  type SeasonWearableSlotView,
  type SeasonWearableVariantView,
  type WearableSlotKey,
} from './InteractiveAiLookbookStage';
import { PhotometricLookbookCache } from './photometric-recolor';
import styles from './seasons-vitrine.module.css';

export interface SeasonalFlagshipVitrineProps {
  seasons: SeasonalCollectionDto[];
}

const CANONICAL_SIZES = ['XS', 'S', 'M', 'L', 'XL'] as const;

const ACCESSORY_SLOT_LABELS: Record<WearableSlotKey, string> = {
  TOP: 'Thiết kế thân trên',
  BOTTOM: 'Thiết kế thân dưới',
  ONE_PIECE: 'Thiết kế chủ đạo',
  OUTERWEAR: 'Áo khoác đồng bộ',
  ACCESSORY: 'Phụ kiện hoàn thiện',
};

interface CanonicalSeasonPreset {
  slug: string;
  order: number;
  months: string;
  name: string;
  shortName: string;
  materialHeadline: string;
  note: string;
  isCurrent: boolean;
  totalDesigns: number;
  baseEditorialImageUrl: string;
  wearableSlots: SeasonWearableSlotView[];
}

const CANONICAL_SEASON_PRESETS: CanonicalSeasonPreset[] = [
  {
    slug: 'xuan-tam-xuan',
    order: 1,
    months: 'T1–T2',
    name: 'Xuân Lụa Bảo Lộc',
    shortName: 'XUÂN LỤA',
    materialHeadline: 'Lụa Tơ Tằm Bảo Lộc 22 Momme',
    note: 'Tơ tằm dệt nổi ánh ngọc và phom cổ đổ mềm rủ thanh thoát.',
    isCurrent: true,
    totalDesigns: 12,
    baseEditorialImageUrl: '/images/seasons-vitrine/lookbooks/xuan-tam-xuan-base.webp',
    wearableSlots: [
      {
        slotKey: 'TOP',
        productId: 'prod-ao-so-mi-lua-tam-xuan',
        productSlug: 'ao-so-mi-lua-to-tam-tam-xuan',
        productName: 'Áo Sơ Mi Lụa Tơ Tằm Tầm Xuân',
        basePriceVnd: 1_850_000,
        pinPosition: { xPercent: 56, yPercent: 34 },
        garmentRegionMask: '/images/seasons-vitrine/masks/xuan-tam-xuan-mask-top.png',
        maskBbox: { x: 0.28, y: 0.22, w: 0.44, h: 0.28 },
        materialOpticalProfile: {
          sheen: 'silk',
          specularIntensity: 0.45,
          shadowDepth: 0.34,
        },
        variants: [
          {
            variantId: 'var-s01-top-ivory',
            skuDefaultId: 'sku-s01-top-ivory-m',
            colorKey: 'ivory',
            colorName: 'Kem Ngà',
            colorHex: '#F4EFE6',
            inStockSizes: ['XS', 'S', 'M', 'L', 'XL'],
            studioCutoutUrl:
              '/images/seasons-vitrine/variants/ao-so-mi-lua-to-tam-tam-xuan-ivory.webp',
            macroSwatchUrl: '/images/seasons-vitrine/macros/silk-ivory.webp',
            fabricSpecText:
              'Lụa Tơ Tằm Bảo Lộc · Kem Ngà 22 Momme · Thoáng khí 100%',
          },
          {
            variantId: 'var-s01-top-jet-black',
            skuDefaultId: 'sku-s01-top-jet-black-m',
            colorKey: 'jet-black',
            colorName: 'Đen Tuyền',
            colorHex: '#171615',
            inStockSizes: ['XS', 'S', 'M', 'L', 'XL'],
            studioCutoutUrl:
              '/images/seasons-vitrine/variants/ao-so-mi-lua-to-tam-tam-xuan-jet-black.webp',
            macroSwatchUrl: '/images/seasons-vitrine/macros/silk-jet-black.webp',
            fabricSpecText:
              'Lụa Tơ Tằm Bảo Lộc · Đen Tuyền 22 Momme · Ánh gương dịu',
          },
          {
            variantId: 'var-s01-top-wine-red',
            skuDefaultId: 'sku-s01-top-wine-red-m',
            colorKey: 'wine-red',
            colorName: 'Đỏ Rượu Vang',
            colorHex: '#5E1924',
            inStockSizes: ['XS', 'S', 'M', 'L'],
            studioCutoutUrl:
              '/images/seasons-vitrine/variants/ao-so-mi-lua-to-tam-tam-xuan-wine-red.webp',
            macroSwatchUrl: '/images/seasons-vitrine/macros/silk-wine-red.webp',
            fabricSpecText:
              'Lụa Tơ Tằm Bảo Lộc · Đỏ Rượu Vang 22 Momme · Sắc sâu sang trọng',
          },
          {
            variantId: 'var-s01-top-sage-green',
            skuDefaultId: 'sku-s01-top-sage-green-m',
            colorKey: 'sage-green',
            colorName: 'Xanh Rêu',
            colorHex: '#4A5546',
            inStockSizes: ['S', 'M', 'L', 'XL'],
            studioCutoutUrl:
              '/images/seasons-vitrine/variants/ao-so-mi-lua-to-tam-tam-xuan-sage-green.webp',
            macroSwatchUrl: '/images/seasons-vitrine/macros/silk-sage-green.webp',
            fabricSpecText:
              'Lụa Tơ Tằm Bảo Lộc · Xanh Rêu 22 Momme · Mát dịu tự nhiên',
          },
        ],
      },
      {
        slotKey: 'BOTTOM',
        productId: 'prod-chan-vay-xep-ly-midi',
        productSlug: 'chan-vay-xep-ly-midi-cap-cao',
        productName: 'Chân Váy Xếp Ly Midi Cạp Cao',
        basePriceVnd: 2_150_000,
        pinPosition: { xPercent: 48, yPercent: 56 },
        garmentRegionMask: '/images/seasons-vitrine/masks/xuan-tam-xuan-mask-bottom.png',
        maskBbox: { x: 0.24, y: 0.48, w: 0.52, h: 0.4 },
        materialOpticalProfile: {
          sheen: 'silk',
          specularIntensity: 0.36,
          shadowDepth: 0.38,
        },
        variants: [
          {
            variantId: 'var-s01-bot-ivory',
            skuDefaultId: 'sku-s01-bot-ivory-m',
            colorKey: 'ivory',
            colorName: 'Kem Sữa',
            colorHex: '#EDE3D1',
            inStockSizes: ['XS', 'S', 'M', 'L', 'XL'],
            studioCutoutUrl:
              '/images/seasons-vitrine/variants/chan-vay-xep-ly-midi-cap-cao-ivory.webp',
            macroSwatchUrl: '/images/seasons-vitrine/macros/pleated-silk-ivory.webp',
            fabricSpecText:
              'Lụa Xếp Ly Tencel · Kem Sữa · Sóng ly giữ phom bền bỉ',
          },
          {
            variantId: 'var-s01-bot-espresso',
            skuDefaultId: 'sku-s01-bot-espresso-m',
            colorKey: 'espresso',
            colorName: 'Nâu Cacao',
            colorHex: '#3D2B22',
            inStockSizes: ['XS', 'S', 'M', 'L'],
            studioCutoutUrl:
              '/images/seasons-vitrine/variants/chan-vay-xep-ly-midi-cap-cao-espresso.webp',
            macroSwatchUrl: '/images/seasons-vitrine/macros/pleated-silk-espresso.webp',
            fabricSpecText:
              'Lụa Xếp Ly Tencel · Nâu Cacao · Chiều sâu Quiet Luxury',
          },
          {
            variantId: 'var-s01-bot-wine-red',
            skuDefaultId: 'sku-s01-bot-wine-red-m',
            colorKey: 'wine-red',
            colorName: 'Đỏ Rượu Vang',
            colorHex: '#5E1924',
            inStockSizes: ['S', 'M', 'L'],
            studioCutoutUrl:
              '/images/seasons-vitrine/variants/chan-vay-xep-ly-midi-cap-cao-wine-red.webp',
            macroSwatchUrl: '/images/seasons-vitrine/macros/pleated-silk-wine-red.webp',
            fabricSpecText:
              'Lụa Xếp Ly Tencel · Đỏ Rượu Vang · Tôn chuyển động nhẹ nhàng',
          },
          {
            variantId: 'var-s01-bot-sage-green',
            skuDefaultId: 'sku-s01-bot-sage-green-m',
            colorKey: 'sage-green',
            colorName: 'Xanh Khói',
            colorHex: '#4A5546',
            inStockSizes: ['S', 'M', 'L'],
            studioCutoutUrl:
              '/images/seasons-vitrine/variants/chan-vay-xep-ly-midi-cap-cao-sage-green.webp',
            macroSwatchUrl: '/images/seasons-vitrine/macros/pleated-silk-sage-green.webp',
            fabricSpecText:
              'Lụa Xếp Ly Tencel · Xanh Khói · Thanh lịch tinh giản',
          },
        ],
      },
      {
        slotKey: 'ACCESSORY',
        productId: 'prod-vi-cam-tay-clutch',
        productSlug: 'vi-cam-tay-clutch-champagne',
        productName: 'Ví Cầm Tay Clutch Champagne',
        basePriceVnd: 1_290_000,
        pinPosition: { xPercent: 42, yPercent: 74 },
        garmentRegionMask: '/images/seasons-vitrine/masks/xuan-tam-xuan-mask-accessory.png',
        maskBbox: { x: 0, y: 0, w: 0, h: 0 },
        materialOpticalProfile: {
          sheen: 'leather',
          specularIntensity: 0.52,
          shadowDepth: 0.34,
        },
        variants: [
          {
            variantId: 'var-s01-acc-champagne',
            skuDefaultId: 'sku-s01-acc-champagne-f',
            colorKey: 'champagne',
            colorName: 'Champagne Ánh Kim',
            colorHex: '#DFC9A6',
            inStockSizes: ['S', 'M', 'L'],
            studioCutoutUrl:
              '/images/seasons-vitrine/variants/vi-cam-tay-clutch-champagne-champagne.webp',
            macroSwatchUrl: '/images/seasons-vitrine/macros/leather-champagne.webp',
            fabricSpecText:
              'Lụa Satin Khung Đồng · Champagne Ánh Kim · Chế tác thủ công',
          },
          {
            variantId: 'var-s01-acc-jet-black',
            skuDefaultId: 'sku-s01-acc-jet-black-f',
            colorKey: 'jet-black',
            colorName: 'Đen Tuyền',
            colorHex: '#171615',
            inStockSizes: ['S', 'M', 'L'],
            studioCutoutUrl:
              '/images/seasons-vitrine/variants/vi-cam-tay-clutch-champagne-jet-black.webp',
            macroSwatchUrl: '/images/seasons-vitrine/macros/leather-jet-black.webp',
            fabricSpecText:
              'Lụa Satin Khung Đồng · Đen Tuyền · Khóa đồng thau mài mờ',
          },
          {
            variantId: 'var-s01-acc-wine-red',
            skuDefaultId: 'sku-s01-acc-wine-red-f',
            colorKey: 'wine-red',
            colorName: 'Đỏ Rượu Vang',
            colorHex: '#5E1924',
            inStockSizes: ['S', 'M', 'L'],
            studioCutoutUrl:
              '/images/seasons-vitrine/variants/vi-cam-tay-clutch-champagne-wine-red.webp',
            macroSwatchUrl: '/images/seasons-vitrine/macros/leather-wine-red.webp',
            fabricSpecText:
              'Lụa Satin Khung Đồng · Đỏ Rượu Vang · Điểm nhấn dạ tiệc',
          },
        ],
      },
    ],
  },
  {
    slug: 'ha-pho-co',
    order: 2,
    months: 'T3–T4',
    name: 'Hạ Linen Hữu Cơ',
    shortName: 'HẠ LINEN',
    materialHeadline: '100% Organic French Linen Thoáng Khí',
    note: 'Sợi linen hữu cơ dệt thưa màu cát ngà, dịu mát dưới nắng hạ.',
    isCurrent: false,
    totalDesigns: 10,
    baseEditorialImageUrl: '/images/seasons-vitrine/lookbooks/ha-pho-co-base.webp',
    wearableSlots: [],
  },
  {
    slug: 'resort-ban-mai',
    order: 3,
    months: 'T5–T6',
    name: 'Resort Biển & Lụa Bay',
    shortName: 'RESORT BIỂN',
    materialHeadline: 'Lụa Organza & Tơ Sống Dệt Nhẹ',
    note: 'Đầm bias-cut bay nhẹ ôm chuyển động cùng gió biển ban mai.',
    isCurrent: false,
    totalDesigns: 9,
    baseEditorialImageUrl: '/images/seasons-vitrine/lookbooks/resort-ban-mai-base.webp',
    wearableSlots: [],
  },
  {
    slug: 'thu-hoang-hon',
    order: 4,
    months: 'T7–T8',
    name: 'Thu Công Sở Thanh Lịch',
    shortName: 'THU CÔNG SỞ',
    materialHeadline: 'Wool Silk Blend & Crepe Đứng Phom',
    note: 'Blazer may đo mềm vai phối quần tây xếp ly đôi chuẩn tỷ lệ.',
    isCurrent: false,
    totalDesigns: 11,
    baseEditorialImageUrl: '/images/seasons-vitrine/lookbooks/thu-hoang-hon-base.webp',
    wearableSlots: [],
  },
  {
    slug: 'dong-cashmere',
    order: 5,
    months: 'T9–T10',
    name: 'Dạ Tweed & Cashmere',
    shortName: 'DẠ TWEED & CASHMERE',
    materialHeadline: 'Len Cashmere Mông Cổ & Dạ Tweed Dệt Nổi',
    note: 'Dạ tweed dệt tay kết hợp len cashmere giữ ấm thanh mảnh.',
    isCurrent: false,
    totalDesigns: 10,
    baseEditorialImageUrl: '/images/seasons-vitrine/lookbooks/dong-cashmere-base.webp',
    wearableSlots: [],
  },
  {
    slug: 'atelier-di-san',
    order: 6,
    months: 'T11–T12',
    name: 'Dạ Tiệc Cuối Năm',
    shortName: 'DẠ TIỆC CUỐI NĂM',
    materialHeadline: 'Lụa Satin Ánh Ngọc & Nhung Couture',
    note: 'Sắc ngọc trai, cacao trầm và ánh champagne cho đêm dạ tiệc.',
    isCurrent: false,
    totalDesigns: 14,
    baseEditorialImageUrl: '/images/seasons-vitrine/lookbooks/atelier-di-san-base.webp',
    wearableSlots: [],
  },
];

const PRESET_BY_SLUG = new Map<string, CanonicalSeasonPreset>(
  CANONICAL_SEASON_PRESETS.map((p) => [p.slug, p]),
);

function buildSkuMapForVariant(
  heroProducts: ProductSpuDto[] | undefined,
  productSlug: string,
  variantId: string,
): { skuBySize: Record<string, string>; resolvedProductId?: string; resolvedVariantId?: string } {
  const skuBySize: Record<string, string> = {};
  if (!heroProducts || heroProducts.length === 0) {
    return { skuBySize };
  }
  const product = heroProducts.find((p) => p.slug === productSlug);
  if (!product) {
    return { skuBySize };
  }
  const matchedVariant =
    product.variants.find((v) => v.id === variantId) ?? product.variants[0];
  if (matchedVariant) {
    for (const sku of matchedVariant.skus) {
      if (sku.sizeCode) {
        skuBySize[sku.sizeCode.toUpperCase()] = sku.id;
      }
    }
  }
  return {
    skuBySize,
    resolvedProductId: product.id,
    resolvedVariantId: matchedVariant?.id,
  };
}

function normalizeMonthsCompact(rawMonths: string, fallbackMonths: string): string {
  const trimmed = rawMonths.trim();
  if (!trimmed) return fallbackMonths;
  if (/^T\d+/i.test(trimmed)) return trimmed;
  const nums = trimmed.match(/\d+/g);
  if (nums && nums.length >= 2) {
    return `T${nums[0]}–T${nums[1]}`;
  }
  return fallbackMonths || trimmed;
}

function extractHeroProductFallbackImage(
  product: ProductSpuDto | undefined,
): string | undefined {
  if (!product) return undefined;
  const extended = product as ProductSpuDto & {
    frontWebpUrl?: string | null;
    imageUrl?: string | null;
  };
  const primaryVariant = product.variants[0];
  const candidates = [
    extended.frontWebpUrl,
    extended.imageUrl,
    primaryVariant?.rackFrontUrl,
    primaryVariant?.lookbookMainUrl,
    primaryVariant?.tryonFlatPreviewUrl,
    product.tryonFlatAssetUrl,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  return undefined;
}

function normalizeSeasonChapters(
  seasons: SeasonalCollectionDto[],
): SeasonChapterView[] {
  const sourceList: SeasonalCollectionDto[] =
    seasons && seasons.length > 0
      ? seasons
      : CANONICAL_SEASON_PRESETS.map((p) => ({
          id: `season-${p.slug}`,
          slug: p.slug,
          months: p.months,
          name: p.name,
          shortName: p.shortName,
          materialHeadline: p.materialHeadline,
          note: p.note,
          coverAssetUrl: p.baseEditorialImageUrl,
          isCurrent: p.isCurrent,
          isCurrentSeason: p.isCurrent,
          isNow: p.isCurrent,
          sortOrder: p.order,
          productSlugs: p.wearableSlots.map((s) => s.productSlug),
          productCount: p.totalDesigns,
        }));

  return sourceList.slice(0, 6).map((raw, idx) => {
    const preset = PRESET_BY_SLUG.get(raw.slug) ?? CANONICAL_SEASON_PRESETS[idx];
    const order = raw.sortOrder || preset?.order || idx + 1;
    const orderLabel = String(order).padStart(2, '0');
    const lookbook = raw.interactiveLookbook ?? null;
    const heroProducts = raw.heroProducts ?? [];
    const localSeasonLookbookUrl = getSeasonLookbookFallbackUrl(raw.slug);

    const rawSlots: Array<SeasonWearableSlot | SeasonWearableSlotView> =
      lookbook?.wearableSlots && lookbook.wearableSlots.length > 0
        ? lookbook.wearableSlots
        : preset?.wearableSlots ?? [];

    const wearableSlots: SeasonWearableSlotView[] = rawSlots.map((slot) => {
      const firstHero = heroProducts.find((p) => p.slug === slot.productSlug);
      const heroFallbackImageUrl = extractHeroProductFallbackImage(firstHero);
      const defaultVariantFallbackUrl = getVariantDefaultFallbackUrl(
        slot.productSlug,
      );

      const normalizedVariants: SeasonWearableVariantView[] = slot.variants.map(
        (v: SeasonWearableVariant | SeasonWearableVariantView) => {
          const skuInfo = buildSkuMapForVariant(
            heroProducts,
            slot.productSlug,
            v.variantId ?? '',
          );
          const backendSizeMap =
            'sizeSkuMap' in v && v.sizeSkuMap ? v.sizeSkuMap : undefined;
          const mergedSkuBySize: Record<string, string> = {
            ...skuInfo.skuBySize,
            ...(backendSizeMap
              ? Object.fromEntries(
                  Object.entries(backendSizeMap).map(([k, val]) => [
                    k.toUpperCase(),
                    val,
                  ]),
                )
              : {}),
          };
          const inStockSizes =
            v.inStockSizes && v.inStockSizes.length > 0
              ? v.inStockSizes
              : Object.keys(mergedSkuBySize).length > 0
                ? Object.keys(mergedSkuBySize)
                : ['XS', 'S', 'M', 'L', 'XL'];

          const resolvedStudioUrl = resolveSeasonsVitrineUrl(
            v.studioCutoutUrl,
            heroFallbackImageUrl || defaultVariantFallbackUrl,
          );
          const resolvedMacroUrl = resolveSeasonsVitrineUrl(
            v.macroSwatchUrl,
            getMacroFallbackUrl(slot.materialOpticalProfile?.sheen, v.colorKey),
          );
          const resolvedPrebaked = v.prebakedSceneUrl
            ? resolveSeasonsVitrineUrl(v.prebakedSceneUrl, '') || null
            : null;

          return {
            variantId:
              v.variantId ||
              skuInfo.resolvedVariantId ||
              `${slot.productSlug}-${v.colorKey}`,
            skuDefaultId:
              v.skuDefaultId ||
              mergedSkuBySize['M'] ||
              Object.values(mergedSkuBySize)[0] ||
              `sku-${slot.productSlug}-${v.colorKey}`,
            colorKey: v.colorKey,
            colorName: v.colorName,
            colorHex: v.colorHex,
            inStockSizes,
            skuBySize: mergedSkuBySize,
            studioCutoutUrl: resolvedStudioUrl,
            macroSwatchUrl: resolvedMacroUrl,
            fabricSpecText: v.fabricSpecText,
            prebakedSceneUrl: resolvedPrebaked,
          };
        },
      );

      return {
        slotKey: slot.slotKey,
        productId: slot.productId || firstHero?.id || `prod-${slot.productSlug}`,
        productSlug: slot.productSlug,
        productName: slot.productName || firstHero?.name || slot.productSlug,
        basePriceVnd: slot.basePriceVnd || firstHero?.minPriceVnd || 1_850_000,
        pinPosition: slot.pinPosition,
        garmentRegionMask: resolveSeasonsVitrineUrl(
          slot.garmentRegionMask,
          getSeasonMaskFallbackUrl(raw.slug, slot.slotKey),
        ),
        maskBbox: slot.maskBbox,
        materialOpticalProfile: slot.materialOpticalProfile,
        fallbackImageUrl: heroFallbackImageUrl,
        variants: normalizedVariants,
      };
    });

    const isCurrent = Boolean(
      raw.isCurrentSeason ?? raw.isCurrent ?? raw.isNow ?? preset?.isCurrent,
    );

    const normalizedRestyleCacheMap: Record<string, string> = {};
    if (lookbook?.restyleCacheMap) {
      for (const [k, url] of Object.entries(lookbook.restyleCacheMap)) {
        const resolved = resolveSeasonsVitrineUrl(url, '');
        if (resolved) {
          normalizedRestyleCacheMap[k] = resolved;
        }
      }
    }

    return {
      id: raw.id,
      slug: raw.slug,
      order,
      orderLabel,
      months: normalizeMonthsCompact(raw.months, preset?.months ?? `T${idx * 2 + 1}–T${idx * 2 + 2}`),
      name: raw.name || preset?.name || `Mùa ${orderLabel}`,
      shortName: (
        raw.shortName ||
        lookbook?.shortName ||
        preset?.shortName ||
        raw.name
      ).toUpperCase(),
      materialHeadline:
        raw.materialHeadline ||
        lookbook?.materialHeadline ||
        preset?.materialHeadline ||
        raw.note,
      note: raw.note || preset?.note || '',
      isCurrent,
      totalDesigns:
        lookbook?.totalDesigns ||
        raw.productCount ||
        preset?.totalDesigns ||
        12,
      baseEditorialImageUrl: resolveSeasonsVitrineUrl(
        lookbook?.baseEditorialImageUrl ||
          preset?.baseEditorialImageUrl ||
          raw.coverAssetUrl,
        localSeasonLookbookUrl,
      ),
      wearableSlots,
      restyleCacheMap: normalizedRestyleCacheMap,
    };
  });
}

function buildComboKey(
  slots: SeasonWearableSlotView[],
  selectedBySlot: Record<string, string>,
): string {
  return [...slots]
    .sort((a, b) => a.slotKey.localeCompare(b.slotKey))
    .map((slot) => {
      const ck = selectedBySlot[slot.slotKey] ?? slot.variants[0]?.colorKey ?? 'default';
      return `${slot.slotKey}:${ck}`;
    })
    .join('|');
}

function buildTryOnOptionsForSlot(
  slot: SeasonWearableSlotView,
  variant: SeasonWearableVariantView,
): OpenTryOnOptions {
  const ref: TryOnGarmentRef = {
    productId: slot.productId,
    variantId: variant.variantId,
    skuId: variant.skuDefaultId,
    slug: slot.productSlug,
  };
  if (slot.slotKey === 'ONE_PIECE') {
    return { mode: TryOnMode.SINGLE, onePiece: ref };
  }
  if (slot.slotKey === 'BOTTOM') {
    return { mode: TryOnMode.SINGLE, lower: ref };
  }
  return { mode: TryOnMode.SINGLE, upper: ref };
}

function buildTryOnOptionsForSeasonSet(
  season: SeasonChapterView,
  selectedBySlot: Record<string, string>,
): OpenTryOnOptions {
  const makeRef = (slot: SeasonWearableSlotView): TryOnGarmentRef => {
    const ck = selectedBySlot[slot.slotKey] ?? slot.variants[0]?.colorKey;
    const variant =
      slot.variants.find((v) => v.colorKey === ck) ?? slot.variants[0];
    return {
      productId: slot.productId,
      variantId: variant?.variantId,
      skuId: variant?.skuDefaultId,
      slug: slot.productSlug,
    };
  };

  const onePieceSlot = season.wearableSlots.find((s) => s.slotKey === 'ONE_PIECE');
  const upperSlot =
    season.wearableSlots.find((s) => s.slotKey === 'TOP') ??
    season.wearableSlots.find((s) => s.slotKey === 'OUTERWEAR');
  const lowerSlot = season.wearableSlots.find((s) => s.slotKey === 'BOTTOM');

  if (upperSlot && lowerSlot) {
    return {
      mode: TryOnMode.MIX_MATCH_OUTFIT,
      upper: makeRef(upperSlot),
      lower: makeRef(lowerSlot),
    };
  }
  if (onePieceSlot) {
    return {
      mode: TryOnMode.SINGLE,
      onePiece: makeRef(onePieceSlot),
      upper: upperSlot ? makeRef(upperSlot) : null,
    };
  }
  if (upperSlot) {
    return { mode: TryOnMode.SINGLE, upper: makeRef(upperSlot) };
  }
  if (lowerSlot) {
    return { mode: TryOnMode.SINGLE, lower: makeRef(lowerSlot) };
  }
  return { mode: TryOnMode.SINGLE };
}

interface VitrineSafeImageProps {
  src: string;
  fallbackUrls: string[];
  alt: string;
  className?: string;
  ariaHidden?: boolean;
  loading?: 'eager' | 'lazy';
  decoding?: 'async' | 'sync' | 'auto';
  onFallbackActiveChange?: (isFallback: boolean) => void;
}

function VitrineSafeImage({
  src,
  fallbackUrls,
  alt,
  className,
  ariaHidden,
  loading,
  decoding = 'async',
  onFallbackActiveChange,
}: VitrineSafeImageProps) {
  const imgRef = useRef<HTMLImageElement | null>(null);
  const candidates = useMemo(() => {
    const dedup: string[] = [];
    for (const candidate of [src, ...fallbackUrls]) {
      const trimmed = candidate.trim();
      if (trimmed && !dedup.includes(trimmed)) {
        dedup.push(trimmed);
      }
    }
    return dedup;
  }, [src, fallbackUrls]);

  const candidatesKey = candidates.join('|');
  const [attemptIdx, setAttemptIdx] = useState(0);

  useEffect(() => {
    setAttemptIdx(0);
  }, [candidatesKey]);

  const activeSrc =
    candidates[Math.min(attemptIdx, Math.max(0, candidates.length - 1))] ?? '';
  const isUsingFallback = attemptIdx > 0;

  useEffect(() => {
    onFallbackActiveChange?.(isUsingFallback);
  }, [isUsingFallback, onFallbackActiveChange]);

  const advanceCandidate = useCallback(() => {
    setAttemptIdx((prev) =>
      prev + 1 < candidates.length ? prev + 1 : prev,
    );
  }, [candidates.length]);

  useEffect(() => {
    const img = imgRef.current;
    if (img && img.complete && img.naturalWidth === 0) {
      advanceCandidate();
    }
  }, [activeSrc, advanceCandidate]);

  if (!activeSrc) return null;

  return (
    <img
      ref={imgRef}
      src={activeSrc}
      alt={ariaHidden ? '' : alt}
      aria-hidden={ariaHidden}
      className={className}
      loading={loading}
      decoding={decoding}
      onError={advanceCandidate}
    />
  );
}

export function SeasonalFlagshipVitrine({
  seasons,
}: SeasonalFlagshipVitrineProps) {
  const sectionRef = useRef<HTMLElement | null>(null);
  const scrollTriggerRef = useRef<ScrollTrigger | null>(null);
  const manualJumpLockUntilRef = useRef<number>(0);
  const scanSeqRef = useRef<number>(0);
  const restyleSeqRef = useRef<number>(0);
  const clientRestyleCacheRef = useRef<Map<string, { url: string; cacheHit: boolean }>>(
    new Map(),
  );

  // Singleton photometric cache scoped to this vitrine instance, pruned to ±1 chapters & disposed on unmount
  const photometricCacheRef = useRef<PhotometricLookbookCache | null>(null);
  if (!photometricCacheRef.current) {
    photometricCacheRef.current = new PhotometricLookbookCache();
  }

  const lenis = useLenis();
  const reducedMotion = usePrefersReducedMotion();

  const chapters = useMemo(() => normalizeSeasonChapters(seasons), [seasons]);

  const initialIdx = useMemo(() => {
    const currentIdx = chapters.findIndex((c) => c.isCurrent);
    return currentIdx >= 0 ? currentIdx : 0;
  }, [chapters]);

  const [activeSeasonIdx, setActiveSeasonIdx] = useState<number>(initialIdx);
  const [transitionDirection, setTransitionDirection] = useState<1 | -1>(1);
  const [chapterProgress, setChapterProgress] = useState<number>(1);
  const [hoveredSlotKey, setHoveredSlotKey] = useState<WearableSlotKey | null>(null);
  const [openPopoverSlotKey, setOpenPopoverSlotKey] =
    useState<WearableSlotKey | null>(null);
  const [openSizePickerSlotKey, setOpenSizePickerSlotKey] =
    useState<WearableSlotKey | null>(null);
  const [addingSlotKey, setAddingSlotKey] = useState<WearableSlotKey | null>(null);
  const [cartFeedback, setCartFeedback] = useState<string | null>(null);

  // Per-season cumulative slot color selections: seasonSlug -> { slotKey -> colorKey }
  const [selectedColorsBySeason, setSelectedColorsBySeason] = useState<
    Record<string, Record<string, string>>
  >({});

  // Per-season active macro swatch pointer (updates immediately on ANY garment color change)
  const [activeMacroBySeason, setActiveMacroBySeason] = useState<
    Record<string, { slotKey: WearableSlotKey; colorKey: string }>
  >({});

  const [scanTrigger, setScanTrigger] = useState<ScanBeamTrigger | null>(null);
  const [serverRestyleState, setServerRestyleState] = useState<{
    comboKey: string;
    sceneImageUrl: string | null;
    cacheHit: boolean;
    loading: boolean;
  }>({
    comboKey: '',
    sceneImageUrl: null,
    cacheHit: false,
    loading: false,
  });

  // Track previous macro URL for silky crossfade
  const [macroTransition, setMacroTransition] = useState<{
    currentUrl: string;
    prevUrl: string | null;
  }>({ currentUrl: '', prevUrl: null });
  const [macroUsingFallback, setMacroUsingFallback] = useState<boolean>(false);

  const safeIdx =
    chapters.length > 0
      ? Math.max(0, Math.min(activeSeasonIdx, chapters.length - 1))
      : 0;
  const activeSeason = chapters[safeIdx] ?? chapters[0];
  const nextSeasonIdx = chapters.length > 0 ? (safeIdx + 1) % chapters.length : 0;
  const nextSeason = chapters[nextSeasonIdx];

  // Dispose offscreen photometric buffers & ImageBitmaps cleanly on unmount
  useEffect(() => {
    const cache = photometricCacheRef.current;
    return () => {
      cache?.dispose();
    };
  }, []);

  // Pre-hydrate active season & adjacent seasons (±1) and prune outside window
  useEffect(() => {
    const cache = photometricCacheRef.current;
    if (!cache || chapters.length === 0) return;

    const orderedSlugs = chapters.map((c) => c.slug);
    cache.pruneOutsideWindow(safeIdx, orderedSlugs);

    const windowIndices = [safeIdx, safeIdx + 1, safeIdx - 1].filter(
      (i) => i >= 0 && i < chapters.length,
    );
    for (const i of windowIndices) {
      const ch = chapters[i]!;
      const maskInputs = ch.wearableSlots.map((slot) => ({
        slotKey: slot.slotKey,
        garmentRegionMask: slot.garmentRegionMask,
        materialOpticalProfile: slot.materialOpticalProfile,
      }));
      void cache.hydrateSeason(ch.slug, ch.baseEditorialImageUrl, maskInputs);
    }
  }, [chapters, safeIdx]);

  // Keep SiteHeader in crisp light theme whenever #seasons is in view
  useEffect(() => {
    const sectionEl = sectionRef.current;
    if (!sectionEl || typeof window === 'undefined') return undefined;

    const syncLightHeader = () => {
      const rect = sectionEl.getBoundingClientRect();
      if (rect.top <= 64 && rect.bottom > 64) {
        window.dispatchEvent(
          new CustomEvent('atelier:nav-theme', { detail: { theme: 'light' } }),
        );
      }
    };

    syncLightHeader();
    window.addEventListener('scroll', syncLightHeader, { passive: true });
    return () => window.removeEventListener('scroll', syncLightHeader);
  }, [safeIdx]);

  // Desktop (>= 1024px) Pinned 6-Chapter Vertical ScrollTrigger with gentle chapter plateaus
  useGSAP(
    () => {
      ensureGsapRegistered();
      scrollTriggerRef.current = null;
      const sectionEl = sectionRef.current;
      if (!sectionEl || chapters.length <= 1 || reducedMotion) {
        return;
      }

      const mm = gsap.matchMedia();
      mm.add('(min-width: 1024px)', () => {
        const count = chapters.length;
        const st = ScrollTrigger.create({
          trigger: sectionEl,
          start: 'top top',
          end: () => `+=${Math.round(window.innerHeight * Math.max(1, count - 1))}`,
          pin: true,
          anticipatePin: 1,
          invalidateOnRefresh: true,
          snap: {
            snapTo: (value: number) => {
              if (count <= 1) return 0;
              if (value <= 0.03) return 0;
              if (value >= 0.97) return 1;
              const nearest = Math.min(count - 1, Math.round(value * (count - 1)));
              return nearest / (count - 1);
            },
            duration: { min: 0.25, max: 0.5 },
            delay: 0.26,
            ease: 'power2.inOut',
          },
          onUpdate: (self) => {
            if (performance.now() < manualJumpLockUntilRef.current) {
              return;
            }
            const progress = self.progress;
            const scaled = progress * (count - 1);
            const next = Math.min(count - 1, Math.round(scaled));
            const localFrac = Math.max(
              0.15,
              Math.min(1, scaled - Math.max(0, next - 0.5)),
            );
            setChapterProgress(localFrac);
            setActiveSeasonIdx((prev) => {
              if (prev === next) return prev;
              setTransitionDirection(next > prev ? 1 : -1);
              setOpenPopoverSlotKey(null);
              setOpenSizePickerSlotKey(null);
              return next;
            });
          },
        });
        scrollTriggerRef.current = st;

        return () => {
          scrollTriggerRef.current = null;
        };
      });

      return () => {
        mm.revert();
        scrollTriggerRef.current = null;
      };
    },
    {
      scope: sectionRef,
      dependencies: [chapters.length, reducedMotion],
    },
  );

  const selectedColorBySlot = useMemo<Record<string, string>>(() => {
    if (!activeSeason) return {};
    return selectedColorsBySeason[activeSeason.slug] ?? {};
  }, [activeSeason, selectedColorsBySeason]);

  const activeComboKey = useMemo(
    () =>
      activeSeason
        ? buildComboKey(activeSeason.wearableSlots, selectedColorBySlot)
        : '',
    [activeSeason, selectedColorBySlot],
  );

  // Resolve current DynamicMacroSwatchCard variant
  const activeMacroData = useMemo(() => {
    if (!activeSeason || activeSeason.wearableSlots.length === 0) {
      return {
        imageUrl: activeSeason?.baseEditorialImageUrl ?? '',
        colorKey: '',
        colorName: '',
        colorHex: '#F4EFE6',
        sheen: 'silk',
        specText: activeSeason?.materialHeadline ?? '',
      };
    }

    const pointer = activeMacroBySeason[activeSeason.slug];
    const targetSlot =
      (pointer
        ? activeSeason.wearableSlots.find((s) => s.slotKey === pointer.slotKey)
        : undefined) ?? activeSeason.wearableSlots[0]!;

    const targetColorKey =
      pointer?.colorKey ??
      selectedColorBySlot[targetSlot.slotKey] ??
      targetSlot.variants[0]?.colorKey;

    const targetVariant =
      targetSlot.variants.find((v) => v.colorKey === targetColorKey) ??
      targetSlot.variants[0];

    const sheen = targetSlot.materialOpticalProfile?.sheen ?? 'silk';
    const colorKey = targetVariant?.colorKey ?? '';

    return {
      imageUrl:
        targetVariant?.macroSwatchUrl ||
        getMacroFallbackUrl(sheen, colorKey),
      colorKey,
      colorName: targetVariant?.colorName ?? '',
      colorHex: targetVariant?.colorHex ?? '#F4EFE6',
      sheen,
      specText:
        targetVariant?.fabricSpecText ||
        `${activeSeason.materialHeadline}${targetVariant ? ` · ${targetVariant.colorName}` : ''}`,
    };
  }, [activeMacroBySeason, activeSeason, selectedColorBySlot]);

  // Smooth crossfade state for DynamicMacroSwatchCard
  useEffect(() => {
    if (!activeMacroData.imageUrl) return;
    setMacroTransition((prev) => {
      if (prev.currentUrl === activeMacroData.imageUrl) return prev;
      return {
        prevUrl: prev.currentUrl || null,
        currentUrl: activeMacroData.imageUrl,
      };
    });
  }, [activeMacroData.imageUrl]);

  const handleJumpToSeason = useCallback(
    (targetIdx: number) => {
      const count = chapters.length;
      if (count === 0) return;
      const clamped = Math.max(0, Math.min(targetIdx, count - 1));
      setTransitionDirection(clamped >= safeIdx ? 1 : -1);
      setActiveSeasonIdx(clamped);
      setChapterProgress(1);
      setOpenPopoverSlotKey(null);
      setOpenSizePickerSlotKey(null);
      setCartFeedback(null);

      const st = scrollTriggerRef.current;
      if (st && !reducedMotion && count > 1) {
        manualJumpLockUntilRef.current = performance.now() + 780;
        const targetScroll =
          st.start + (clamped / (count - 1)) * (st.end - st.start);
        if (lenis) {
          lenis.scrollTo(targetScroll, { duration: 0.65 });
        } else {
          window.scrollTo({ top: targetScroll, behavior: 'smooth' });
        }
      }
    },
    [chapters.length, lenis, reducedMotion, safeIdx],
  );

  // Core 4-Way Real-Time Recolor Handler (Canvas Popover <-> Right Cards <-> Macro Swatch <-> BFF AI Restyle)
  const handleSelectSlotVariant = useCallback(
    (slot: SeasonWearableSlotView, variant: SeasonWearableVariantView) => {
      if (!activeSeason) return;

      const seasonSlug = activeSeason.slug;
      const prevSeasonSelection = selectedColorsBySeason[seasonSlug] ?? {};
      const nextSeasonSelection: Record<string, string> = {
        ...prevSeasonSelection,
        [slot.slotKey]: variant.colorKey,
      };

      setSelectedColorsBySeason((prev) => ({
        ...prev,
        [seasonSlug]: nextSeasonSelection,
      }));

      setActiveMacroBySeason((prev) => ({
        ...prev,
        [seasonSlug]: {
          slotKey: slot.slotKey,
          colorKey: variant.colorKey,
        },
      }));

      // 1. Fire 0.48s golden AiOpticalScanBeam ONLY when the slot has actual painted mask pixels
      // (Non-worn ACCESSORY slots with empty masks still update Right Card + Left Macro Swatch cleanly
      // without drawing a distracting rectangular scan box over empty dress fabric.)
      const cachedScene = photometricCacheRef.current?.getCached(seasonSlug) ?? null;
      const slotHasMask = hasSlotPhotometricCoverage(slot, cachedScene, seasonSlug);
      if (slotHasMask) {
        const nextScanSeq = ++scanSeqRef.current;
        setScanTrigger({
          slotKey: slot.slotKey,
          maskBbox: slot.maskBbox,
          seq: nextScanSeq,
        });
      }

      // 2. Check if all masked garment slots are back to default colors
      const allMaskedDefault = activeSeason.wearableSlots.every((s) => {
        if (!hasSlotPhotometricCoverage(s, cachedScene, seasonSlug)) {
          return true;
        }
        const chosen = nextSeasonSelection[s.slotKey] ?? s.variants[0]?.colorKey;
        return chosen === s.variants[0]?.colorKey;
      });

      const comboKey = buildComboKey(
        activeSeason.wearableSlots,
        nextSeasonSelection,
      );

      if (allMaskedDefault) {
        setServerRestyleState({
          comboKey,
          sceneImageUrl: null,
          cacheHit: false,
          loading: false,
        });
        return;
      }

      // Non-worn accessory change does not alter lookbook pixels; keep existing garment render intact
      if (!slotHasMask) {
        setServerRestyleState((prev) =>
          prev.sceneImageUrl ? { ...prev, comboKey } : prev,
        );
        return;
      }

      // Check local or manifest prebaked cache first
      const cacheLookupKey = `${seasonSlug}|${comboKey}`;
      const localCached = clientRestyleCacheRef.current.get(cacheLookupKey);
      if (localCached) {
        setServerRestyleState({
          comboKey,
          sceneImageUrl: localCached.url,
          cacheHit: true,
          loading: false,
        });
        return;
      }

      const prebakedUrl =
        activeSeason.restyleCacheMap[comboKey] ?? variant.prebakedSceneUrl ?? null;

      // 3. Asynchronously invoke POST /bff/v1/seasons/:slug/ai-restyle (Redis 7-day cached)
      const reqSeq = ++restyleSeqRef.current;
      setServerRestyleState({
        comboKey,
        sceneImageUrl: prebakedUrl,
        cacheHit: Boolean(prebakedUrl),
        loading: true,
      });

      const selections = activeSeason.wearableSlots.map((s) => {
        const chosenKey = nextSeasonSelection[s.slotKey] ?? s.variants[0]?.colorKey;
        const chosenVar =
          s.variants.find((v) => v.colorKey === chosenKey) ?? s.variants[0]!;
        return {
          slotKey: s.slotKey,
          productId: s.productId,
          variantId: chosenVar.variantId,
          colorHex: chosenVar.colorHex,
          colorKey: chosenVar.colorKey,
        };
      });

      void apiFetch<SeasonAiRestyleResponse>(
        `/bff/v1/seasons/${encodeURIComponent(seasonSlug)}/ai-restyle`,
        {
          method: 'POST',
          skipAuthRefresh: true,
          timeoutMs: 6500,
          body: JSON.stringify({ selections }),
        },
      ).then((res) => {
        if (reqSeq !== restyleSeqRef.current) return;
        if (res.ok && res.data?.status === 'COMPLETED' && res.data.sceneImageUrl) {
          const resolvedSceneUrl = resolveSeasonsVitrineUrl(
            res.data.sceneImageUrl,
            '',
          );
          if (resolvedSceneUrl) {
            clientRestyleCacheRef.current.set(cacheLookupKey, {
              url: resolvedSceneUrl,
              cacheHit: res.data.cacheHit,
            });
            setServerRestyleState({
              comboKey,
              sceneImageUrl: resolvedSceneUrl,
              cacheHit: res.data.cacheHit,
              loading: false,
            });
          } else {
            setServerRestyleState((prev) =>
              prev.comboKey === comboKey ? { ...prev, loading: false } : prev,
            );
          }
        } else {
          setServerRestyleState((prev) =>
            prev.comboKey === comboKey ? { ...prev, loading: false } : prev,
          );
        }
      });
    },
    [activeSeason, selectedColorsBySeason],
  );

  // Instant Quick-Buy Size Selection -> POST /bff/v1/storefront/cart/items -> Open QuickBagDrawer
  const handleAddSlotSizeToCart = useCallback(
    async (
      slot: SeasonWearableSlotView,
      variant: SeasonWearableVariantView,
      sizeCode: string,
    ) => {
      setAddingSlotKey(slot.slotKey);
      setCartFeedback(null);

      const resolvedSkuId =
        variant.skuBySize?.[sizeCode.toUpperCase()] ?? variant.skuDefaultId;

      const res = await apiFetch<CartDto>('/bff/v1/storefront/cart/items', {
        method: 'POST',
        headers: {
          [HTTP_HEADERS.GUEST_SESSION_ID]: getOrCreateGuestSessionId(),
        },
        body: JSON.stringify({
          skuId: resolvedSkuId,
          productId: slot.productId,
          variantId: variant.variantId,
          qty: 1,
          fromAiTryon: false,
        }),
      });

      setAddingSlotKey(null);
      setOpenSizePickerSlotKey(null);

      if (res.ok && res.data) {
        emitCartUpdated(res.data);
        setCartFeedback(
          `Đã thêm ${slot.productName} (${variant.colorName} · ${sizeCode}) vào túi.`,
        );
        openQuickBagDrawer(null);
      } else {
        setCartFeedback(
          res.error?.message || 'Không thể thêm vào túi hàng lúc này.',
        );
      }
    },
    [],
  );

  const handleOpenSetTryOn = useCallback(() => {
    if (!activeSeason) return;
    openVirtualTryOnModal(
      buildTryOnOptionsForSeasonSet(activeSeason, selectedColorBySlot),
    );
  }, [activeSeason, selectedColorBySlot]);

  if (!activeSeason) {
    return null;
  }

  const standingSlots = activeSeason.wearableSlots.slice(0, 2);
  const highlightSlot = activeSeason.wearableSlots[2] ?? null;

  const activeServerSceneUrl =
    serverRestyleState.comboKey === activeComboKey
      ? serverRestyleState.sceneImageUrl
      : null;

  const peekNudgeStyle: CSSProperties = reducedMotion
    ? {}
    : {
        transform: `translateY(${((1 - chapterProgress) * 3).toFixed(1)}px)`,
      };

  return (
    <section
      ref={sectionRef}
      id="seasons"
      data-nav-theme="light"
      className={styles.section}
      aria-label="Lịch Bộ Sưu Tập 6 Mùa Atelier Tương Tác AI"
    >
      <div className={styles.stage}>
        {/* Signal 1: Top 6-Season Interactive Timeline Bar */}
        <div
          data-testid="season-timeline-bar"
          role="tablist"
          aria-label="Chọn bộ sưu tập theo 6 mùa"
          className={styles.timelineBar}
        >
          {chapters.map((chapter, idx) => {
            const isActive = idx === safeIdx;
            return (
              <button
                key={chapter.slug}
                type="button"
                role="tab"
                aria-selected={isActive}
                data-testid={`season-tab-${idx}`}
                data-season-slug={chapter.slug}
                className={`${styles.timelineTab} ${
                  isActive ? styles.timelineTabActive : ''
                }`}
                onClick={() => handleJumpToSeason(idx)}
              >
                <span className={styles.timelineNum}>{chapter.orderLabel}</span>
                <span className={styles.timelineMeta}>
                  <span className={styles.timelineMonths}>{chapter.months}</span>
                  <span className={styles.timelineTitle}>
                    {chapter.shortName}
                    {chapter.isCurrent ? (
                      <span className={styles.timelineCurrentTag}>
                        (ĐANG MỞ BÁN)
                      </span>
                    ) : null}
                  </span>
                </span>
                {isActive ? (
                  <span
                    className={styles.timelineProgressTrack}
                    aria-hidden="true"
                  >
                    <span
                      className={styles.timelineProgressFill}
                      style={{
                        transform: `scaleX(${Math.max(0.2, Math.min(1, chapterProgress)).toFixed(3)})`,
                      }}
                    />
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>

        {/* Main 12-Column Commerce Lookbook Area */}
        <div className={styles.mainArea}>
          {/* Signal 2: Left Vertical Progress Rail (01..06) */}
          <nav
            className={styles.verticalRail}
            aria-label="Tiến độ 6 mùa bộ sưu tập"
            data-testid="season-vertical-rail"
          >
            {chapters.map((chapter, idx) => {
              const isActive = idx === safeIdx;
              return (
                <div key={chapter.slug} className="flex flex-col items-center">
                  <button
                    type="button"
                    aria-label={`Chuyển đến mùa ${chapter.orderLabel} ${chapter.name}`}
                    aria-current={isActive ? 'step' : undefined}
                    className={`${styles.railDotBtn} ${
                      isActive ? styles.railDotBtnActive : ''
                    }`}
                    onClick={() => handleJumpToSeason(idx)}
                  >
                    <span className={styles.railPip} aria-hidden="true" />
                    <span className={styles.railNum}>{chapter.orderLabel}</span>
                  </button>
                  {idx < chapters.length - 1 ? (
                    <span className={styles.railLine} aria-hidden="true" />
                  ) : null}
                </div>
              );
            })}
          </nav>

          <div className={styles.grid12}>
            {/* LEFT COLUMN (3/12): Editorial Identity + DynamicMacroSwatchCard */}
            <div className={styles.leftCol}>
              <div className={styles.leftTopBlock}>
                <div className={styles.eyebrowRow}>
                  <p className={styles.eyebrowText}>
                    MÙA {activeSeason.orderLabel} · TƯƠNG TÁC AI TRỰC TIẾP
                  </p>
                  {activeSeason.isCurrent ? (
                    <span className={styles.currentPill}>ĐANG MỞ BÁN</span>
                  ) : null}
                </div>

                <h2 className={styles.displayTitle}>
                  Mùa nào
                  <br />
                  <em>chất liệu nấy.</em>
                </h2>

                <p className={styles.seasonMaterialLine}>
                  <strong>{activeSeason.name}</strong> —{' '}
                  {activeSeason.materialHeadline}
                </p>

                {/* DynamicMacroSwatchCard (4:3, live crossfade synced with any garment color change) */}
                <div
                  data-testid="season-macro-swatch"
                  className={styles.macroCard}
                >
                  <div className={styles.macroFrame}>
                    {macroTransition.prevUrl &&
                    macroTransition.prevUrl !== macroTransition.currentUrl ? (
                      <img
                        src={macroTransition.prevUrl}
                        alt=""
                        aria-hidden="true"
                        className={`${styles.macroImg} ${styles.macroImgPrev}`}
                        onError={() => {
                          setMacroTransition((prev) => ({
                            ...prev,
                            prevUrl: null,
                          }));
                        }}
                      />
                    ) : null}
                    <VitrineSafeImage
                      key={activeMacroData.imageUrl}
                      src={activeMacroData.imageUrl}
                      fallbackUrls={[
                        getMacroFallbackUrl(
                          activeMacroData.sheen,
                          activeMacroData.colorKey,
                        ),
                        getOccasionMacroFallbackUrl(activeMacroData.sheen),
                        getSeasonLookbookFallbackUrl(activeSeason.slug),
                      ]}
                      alt={`Cận cảnh sợi vải ${activeMacroData.specText}`}
                      className={`${styles.macroImg} ${styles.macroImgActive}`}
                      onFallbackActiveChange={setMacroUsingFallback}
                    />
                    {macroUsingFallback && activeMacroData.colorHex ? (
                      <span
                        className={styles.macroFallbackTint}
                        style={{ backgroundColor: activeMacroData.colorHex }}
                        aria-hidden="true"
                      />
                    ) : null}
                    {activeMacroData.colorName ? (
                      <span className={styles.macroColorBadge}>
                        <span
                          className={styles.macroColorDot}
                          style={{ backgroundColor: activeMacroData.colorHex }}
                          aria-hidden="true"
                        />
                        <span>{activeMacroData.colorName}</span>
                      </span>
                    ) : null}
                  </div>
                  <p className={styles.macroSpecText}>
                    {activeMacroData.specText}
                  </p>
                </div>
              </div>

              <div className={styles.leftFooter}>
                <Link
                  href={`/bo-suu-tap/${encodeURIComponent(activeSeason.slug)}`}
                  className={styles.collectionLink}
                >
                  <span>
                    XEM TRỌN BỘ {activeSeason.totalDesigns} THIẾT KẾ
                  </span>
                  <span aria-hidden="true">→</span>
                </Link>

                {nextSeason ? (
                  <div className={styles.scrollPromptRow}>
                    <button
                      type="button"
                      className={styles.scrollPromptBtn}
                      onClick={() => handleJumpToSeason(nextSeasonIdx)}
                    >
                      <span>
                        CUỘN TIẾP · MÙA {nextSeason.orderLabel}{' '}
                        {nextSeason.shortName} ↓
                      </span>
                    </button>
                  </div>
                ) : null}
              </div>
            </div>

            {/* CENTER COLUMN (5/12): InteractiveAiLookbookStage */}
            <div className={styles.centerCol}>
              <InteractiveAiLookbookStage
                season={activeSeason}
                transitionDirection={transitionDirection}
                cache={photometricCacheRef.current}
                selectedColorBySlot={selectedColorBySlot}
                hoveredSlotKey={hoveredSlotKey}
                openPopoverSlotKey={openPopoverSlotKey}
                scanTrigger={scanTrigger}
                serverSceneUrl={activeServerSceneUrl}
                serverCacheHit={
                  serverRestyleState.comboKey === activeComboKey &&
                  serverRestyleState.cacheHit
                }
                isRestylingServer={
                  serverRestyleState.comboKey === activeComboKey &&
                  serverRestyleState.loading
                }
                onHoverSlot={setHoveredSlotKey}
                onTogglePopover={setOpenPopoverSlotKey}
                onSelectSlotVariant={handleSelectSlotVariant}
                onOpenSetTryOn={handleOpenSetTryOn}
              />
            </div>

            {/* RIGHT COLUMN (4/12): TÙY CHỈNH TRANG PHỤC ĐẠI DIỆN */}
            <div className={styles.rightCol}>
              <div className={styles.rightHeader}>
                <p className={styles.rightEyebrow}>
                  TÙY CHỈNH TRANG PHỤC ĐẠI DIỆN
                </p>
              </div>

              <div className={styles.cardsWrap}>
                {/* Top Row: 2 Standing 3:4 Product Cards */}
                <div className={styles.standingRow}>
                  {standingSlots.map((slot, cardIndex) => {
                    const activeColorKey =
                      selectedColorBySlot[slot.slotKey] ??
                      slot.variants[0]?.colorKey;
                    const activeVariant =
                      slot.variants.find((v) => v.colorKey === activeColorKey) ??
                      slot.variants[0];
                    if (!activeVariant) return null;

                    const isHighlighted = hoveredSlotKey === slot.slotKey;
                    const isSizeOpen = openSizePickerSlotKey === slot.slotKey;
                    const isAdding = addingSlotKey === slot.slotKey;

                    return (
                      <article
                        key={`${activeSeason.slug}-${slot.slotKey}`}
                        data-testid={`season-product-card-${cardIndex}`}
                        data-slot-key={slot.slotKey}
                        data-active-color={activeVariant.colorKey}
                        className={`${styles.productCard} ${
                          isHighlighted ? styles.productCardHighlighted : ''
                        }`}
                        onMouseEnter={() => setHoveredSlotKey(slot.slotKey)}
                        onMouseLeave={() => setHoveredSlotKey(null)}
                      >
                        <div className={styles.productThumbBox}>
                          <VitrineSafeImage
                            src={
                              activeVariant.studioCutoutUrl ||
                              slot.fallbackImageUrl ||
                              getVariantDefaultFallbackUrl(slot.productSlug)
                            }
                            fallbackUrls={[
                              getVariantDefaultFallbackUrl(slot.productSlug),
                              ...(slot.fallbackImageUrl
                                ? [slot.fallbackImageUrl]
                                : []),
                              getSeasonLookbookFallbackUrl(activeSeason.slug),
                            ]}
                            alt={`${slot.productName} — ${activeVariant.colorName}`}
                            className={styles.productThumbImg}
                          />
                          <button
                            type="button"
                            data-testid={`season-card-tryon-${cardIndex}`}
                            className={styles.cardTryOnPill}
                            onClick={() =>
                              openVirtualTryOnModal(
                                buildTryOnOptionsForSlot(slot, activeVariant),
                              )
                            }
                          >
                            <span
                              className={styles.tryOnSparkle}
                              aria-hidden="true"
                            >
                              ✦
                            </span>
                            <span>Thử AI</span>
                          </button>
                        </div>

                        <Link
                          href={`/san-pham/${encodeURIComponent(slot.productSlug)}`}
                          className={styles.productTitle}
                        >
                          {slot.productName}
                        </Link>

                        <p className={styles.productMetaPrice}>
                          {activeVariant.colorName} ·{' '}
                          {FORMAT_VND(slot.basePriceVnd)}
                        </p>

                        <div className={styles.productActionsRow}>
                          <div
                            className={styles.cardSwatchList}
                            role="group"
                            aria-label={`Chọn màu ${slot.productName}`}
                          >
                            {slot.variants.map((variant) => {
                              const isSelected =
                                variant.colorKey === activeVariant.colorKey;
                              return (
                                <button
                                  key={variant.colorKey}
                                  type="button"
                                  data-testid={`season-card-swatch-${slot.slotKey}-${variant.colorKey}`}
                                  data-slot-key={slot.slotKey}
                                  data-color-key={variant.colorKey}
                                  data-color-hex={variant.colorHex}
                                  aria-pressed={isSelected}
                                  aria-label={`Đổi màu ${slot.productName}: ${variant.colorName}`}
                                  title={variant.colorName}
                                  className={`${styles.cardSwatchDot} ${
                                    isSelected ? styles.cardSwatchDotActive : ''
                                  }`}
                                  onClick={() =>
                                    handleSelectSlotVariant(slot, variant)
                                  }
                                >
                                  <span
                                    className={styles.cardSwatchFill}
                                    style={{
                                      backgroundColor: variant.colorHex,
                                    }}
                                  />
                                </button>
                              );
                            })}
                          </div>

                          <button
                            type="button"
                            data-testid={`season-card-buy-${cardIndex}`}
                            className={styles.quickBuyBtn}
                            onClick={() =>
                              setOpenSizePickerSlotKey(
                                isSizeOpen ? null : slot.slotKey,
                              )
                            }
                          >
                            + Chọn mua
                          </button>
                        </div>

                        {isSizeOpen ? (
                          <div
                            className={styles.sizePickerBar}
                            data-testid={`season-size-picker-${cardIndex}`}
                          >
                            <span className={styles.sizePickerLabel}>Cỡ:</span>
                            {CANONICAL_SIZES.map((size) => {
                              const inStock =
                                activeVariant.inStockSizes.length === 0 ||
                                activeVariant.inStockSizes.includes(size) ||
                                activeVariant.inStockSizes.includes('FREESIZE');
                              return (
                                <button
                                  key={size}
                                  type="button"
                                  disabled={!inStock || isAdding}
                                  data-testid={`season-size-pill-${cardIndex}-${size}`}
                                  className={styles.sizePillBtn}
                                  onClick={() =>
                                    void handleAddSlotSizeToCart(
                                      slot,
                                      activeVariant,
                                      size,
                                    )
                                  }
                                >
                                  {size}
                                </button>
                              );
                            })}
                            <button
                              type="button"
                              className={styles.sizePickerCancel}
                              aria-label="Đóng chọn cỡ"
                              onClick={() => setOpenSizePickerSlotKey(null)}
                            >
                              ×
                            </button>
                          </div>
                        ) : null}
                      </article>
                    );
                  })}
                </div>

                {/* Bottom Row: 1 Horizontal Accessory / Highlight Card */}
                {highlightSlot
                  ? (() => {
                      const activeColorKey =
                        selectedColorBySlot[highlightSlot.slotKey] ??
                        highlightSlot.variants[0]?.colorKey;
                      const activeVariant =
                        highlightSlot.variants.find(
                          (v) => v.colorKey === activeColorKey,
                        ) ?? highlightSlot.variants[0];
                      if (!activeVariant) return null;

                      const isHighlighted =
                        hoveredSlotKey === highlightSlot.slotKey;
                      const isSizeOpen =
                        openSizePickerSlotKey === highlightSlot.slotKey;
                      const isAdding = addingSlotKey === highlightSlot.slotKey;

                      return (
                        <article
                          key={`${activeSeason.slug}-${highlightSlot.slotKey}`}
                          data-testid="season-product-card-2"
                          data-slot-key={highlightSlot.slotKey}
                          data-active-color={activeVariant.colorKey}
                          className={`${styles.accessoryCard} ${
                            isHighlighted ? styles.accessoryCardHighlighted : ''
                          }`}
                          onMouseEnter={() =>
                            setHoveredSlotKey(highlightSlot.slotKey)
                          }
                          onMouseLeave={() => setHoveredSlotKey(null)}
                        >
                          <div className={styles.accessoryThumbBox}>
                            <VitrineSafeImage
                              src={
                                activeVariant.studioCutoutUrl ||
                                highlightSlot.fallbackImageUrl ||
                                getVariantDefaultFallbackUrl(
                                  highlightSlot.productSlug,
                                )
                              }
                              fallbackUrls={[
                                getVariantDefaultFallbackUrl(
                                  highlightSlot.productSlug,
                                ),
                                ...(highlightSlot.fallbackImageUrl
                                  ? [highlightSlot.fallbackImageUrl]
                                  : []),
                                getSeasonLookbookFallbackUrl(activeSeason.slug),
                              ]}
                              alt={`${highlightSlot.productName} — ${activeVariant.colorName}`}
                              className={styles.accessoryThumbImg}
                            />
                          </div>

                          <div className={styles.accessoryInfo}>
                            <p className={styles.accessoryTag}>
                              {ACCESSORY_SLOT_LABELS[highlightSlot.slotKey]}
                            </p>
                            <Link
                              href={`/san-pham/${encodeURIComponent(highlightSlot.productSlug)}`}
                              className={styles.productTitle}
                            >
                              {highlightSlot.productName}
                            </Link>
                            <p className={styles.productMetaPrice}>
                              {activeVariant.colorName} ·{' '}
                              {FORMAT_VND(highlightSlot.basePriceVnd)}
                            </p>

                            <div className={styles.accessoryBtnRow}>
                              <div
                                className={styles.cardSwatchList}
                                role="group"
                                aria-label={`Chọn màu ${highlightSlot.productName}`}
                              >
                                {highlightSlot.variants.map((variant) => {
                                  const isSelected =
                                    variant.colorKey === activeVariant.colorKey;
                                  return (
                                    <button
                                      key={variant.colorKey}
                                      type="button"
                                      data-testid={`season-card-swatch-${highlightSlot.slotKey}-${variant.colorKey}`}
                                      data-slot-key={highlightSlot.slotKey}
                                      data-color-key={variant.colorKey}
                                      data-color-hex={variant.colorHex}
                                      aria-pressed={isSelected}
                                      aria-label={`Đổi màu ${highlightSlot.productName}: ${variant.colorName}`}
                                      title={variant.colorName}
                                      className={`${styles.cardSwatchDot} ${
                                        isSelected
                                          ? styles.cardSwatchDotActive
                                          : ''
                                      }`}
                                      onClick={() =>
                                        handleSelectSlotVariant(
                                          highlightSlot,
                                          variant,
                                        )
                                      }
                                    >
                                      <span
                                        className={styles.cardSwatchFill}
                                        style={{
                                          backgroundColor: variant.colorHex,
                                        }}
                                      />
                                    </button>
                                  );
                                })}
                              </div>

                              <button
                                type="button"
                                data-testid="season-card-tryon-2"
                                className={styles.accessoryTryOnBtn}
                                onClick={() =>
                                  openVirtualTryOnModal(
                                    buildTryOnOptionsForSlot(
                                      highlightSlot,
                                      activeVariant,
                                    ),
                                  )
                                }
                              >
                                <span aria-hidden="true">✦</span>
                                <span>Thử AI</span>
                              </button>

                              <button
                                type="button"
                                data-testid="season-card-buy-2"
                                className={styles.quickBuyBtn}
                                onClick={() =>
                                  setOpenSizePickerSlotKey(
                                    isSizeOpen ? null : highlightSlot.slotKey,
                                  )
                                }
                              >
                                + Chọn mua
                              </button>
                            </div>

                            {isSizeOpen ? (
                              <div
                                className={styles.sizePickerBar}
                                data-testid="season-size-picker-2"
                              >
                                <span className={styles.sizePickerLabel}>
                                  Cỡ:
                                </span>
                                {CANONICAL_SIZES.map((size) => {
                                  const inStock =
                                    activeVariant.inStockSizes.length === 0 ||
                                    activeVariant.inStockSizes.includes(size) ||
                                    activeVariant.inStockSizes.includes(
                                      'FREESIZE',
                                    );
                                  return (
                                    <button
                                      key={size}
                                      type="button"
                                      disabled={!inStock || isAdding}
                                      data-testid={`season-size-pill-2-${size}`}
                                      className={styles.sizePillBtn}
                                      onClick={() =>
                                        void handleAddSlotSizeToCart(
                                          highlightSlot,
                                          activeVariant,
                                          size,
                                        )
                                      }
                                    >
                                      {size}
                                    </button>
                                  );
                                })}
                                <button
                                  type="button"
                                  className={styles.sizePickerCancel}
                                  aria-label="Đóng chọn cỡ"
                                  onClick={() => setOpenSizePickerSlotKey(null)}
                                >
                                  ×
                                </button>
                              </div>
                            ) : null}
                          </div>
                        </article>
                      );
                    })()
                  : null}
              </div>

              {cartFeedback ? (
                <p className={styles.cartFeedback} role="status">
                  {cartFeedback}
                </p>
              ) : null}
            </div>
          </div>
        </div>

        {/* Signal 3: Bottom NextSeasonPeekStrip (34px editorial peek bar) */}
        {nextSeason ? (
          <button
            type="button"
            data-testid="season-next-peek"
            className={styles.nextPeekStrip}
            style={peekNudgeStyle}
            onClick={() => handleJumpToSeason(nextSeasonIdx)}
          >
            <span>
              MÙA {nextSeason.orderLabel} · {nextSeason.months}{' '}
              {nextSeason.name.toUpperCase()}
            </span>
            <span className={styles.nextPeekArrow} aria-hidden="true">
              ↓
            </span>
          </button>
        ) : null}
      </div>
    </section>
  );
}
