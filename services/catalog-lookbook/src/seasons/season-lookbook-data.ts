import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  MaterialOpticalProfile,
  ProductSpuDto,
  ProductVariantDto,
  SeasonalCollectionDto,
  SeasonInteractiveLookbook,
  SeasonOutfitFormula,
  SeasonWearableSlot,
  SeasonWearableSlotKey,
  SeasonWearableVariant,
} from '@atelier/contracts';

interface ManifestVariantEntry {
  colorKey?: string;
  colorName?: string;
  colorHex?: string;
  studioCutoutUrl?: string;
  macroSwatchUrl?: string;
  fabricSpecText?: string;
  prebakedSceneUrl?: string | null;
}

interface ManifestSlotEntry {
  slotKey?: SeasonWearableSlotKey;
  productSlug?: string;
  shortPinLabel?: string;
  defaultColorKey?: string;
  pinPosition?: { xPercent?: number; yPercent?: number };
  garmentRegionMask?: string;
  maskBbox?: { x?: number; y?: number; w?: number; h?: number };
  materialOpticalProfile?: Partial<MaterialOpticalProfile>;
  variants?: ManifestVariantEntry[];
}

interface ManifestSeasonEntry {
  seasonSlug?: string;
  slug?: string;
  order?: number;
  months?: string;
  name?: string;
  shortName?: string;
  materialHeadline?: string;
  note?: string;
  isCurrent?: boolean;
  outfitFormula?: SeasonOutfitFormula;
  defaultMacroSlotKey?: SeasonWearableSlotKey;
  baseEditorialImageUrl?: string;
  wearableSlots?: ManifestSlotEntry[];
  restyleCacheMap?: Record<string, string>;
}

interface CanonicalSlotFallback {
  slotKey: SeasonWearableSlotKey;
  productSlug: string;
  shortPinLabel: string;
  defaultColorKey: string;
  pinPosition: { xPercent: number; yPercent: number };
  garmentRegionMask: string;
  maskBbox: { x: number; y: number; w: number; h: number };
  materialOpticalProfile: MaterialOpticalProfile;
  variants: Array<{
    colorKey: string;
    colorName: string;
    colorHex: string;
    studioCutoutUrl: string;
    macroSwatchUrl: string;
    fabricSpecText: string;
    prebakedSceneUrl?: string | null;
  }>;
}

export interface CanonicalSeasonMetadata {
  slug: string;
  order: number;
  months: string;
  name: string;
  shortName: string;
  materialHeadline: string;
  note: string;
  isCurrent: boolean;
  outfitFormula: SeasonOutfitFormula;
  defaultMacroSlotKey: SeasonWearableSlotKey;
  baseEditorialImageUrl: string;
  wearableSlots: CanonicalSlotFallback[];
}

const SIZE_DISPLAY_ORDER: readonly string[] = [
  'XS',
  'S',
  'M',
  'L',
  'XL',
  'XXL',
  'FREESIZE',
];

export const CANONICAL_SEASONS_METADATA: Readonly<Record<string, CanonicalSeasonMetadata>> = {
  'xuan-tam-xuan': {
    slug: 'xuan-tam-xuan',
    order: 1,
    months: 'T1–T2',
    name: 'Xuân Lụa Bảo Lộc',
    shortName: 'Xuân Lụa',
    materialHeadline: 'Lụa Tơ Tằm Bảo Lộc 22 Momme',
    note: 'Lụa Tơ Tằm Bảo Lộc 22 Momme — áo sơ mi lụa kem ngà phối chân váy xếp ly kem sữa và ví clutch champagne.',
    isCurrent: true,
    outfitFormula: 'TOP_BOTTOM_ACCESSORY',
    defaultMacroSlotKey: 'TOP',
    baseEditorialImageUrl: '/images/seasons-vitrine/lookbooks/xuan-tam-xuan-base.webp',
    wearableSlots: [
      {
        slotKey: 'TOP',
        productSlug: 'ao-so-mi-lua-to-tam-tam-xuan',
        shortPinLabel: 'Áo Sơ Mi Lụa',
        defaultColorKey: 'ivory',
        pinPosition: { xPercent: 52.0, yPercent: 34.0 },
        garmentRegionMask: '/images/seasons-vitrine/masks/xuan-tam-xuan-mask-top.png',
        maskBbox: { x: 0.3479, y: 0.2133, w: 0.3083, h: 0.3442 },
        materialOpticalProfile: { sheen: 'silk', specularIntensity: 0.45, shadowDepth: 0.34 },
        variants: [
          {
            colorKey: 'ivory',
            colorName: 'Kem Ngà',
            colorHex: '#F4EFE6',
            studioCutoutUrl: '/images/seasons-vitrine/variants/ao-so-mi-lua-to-tam-tam-xuan-ivory.webp',
            macroSwatchUrl: '/images/seasons-vitrine/macros/silk-ivory.webp',
            fabricSpecText: 'Lụa Tơ Tằm Bảo Lộc · Kem Ngà 22 Momme · Thoáng khí 100%',
          },
          {
            colorKey: 'jet-black',
            colorName: 'Đen Tuyền',
            colorHex: '#171615',
            studioCutoutUrl: '/images/seasons-vitrine/variants/ao-so-mi-lua-to-tam-tam-xuan-jet-black.webp',
            macroSwatchUrl: '/images/seasons-vitrine/macros/silk-jet-black.webp',
            fabricSpecText: 'Lụa Tơ Tằm Bảo Lộc · Đen Tuyền 22 Momme · Ánh gương dịu',
          },
          {
            colorKey: 'wine-red',
            colorName: 'Đỏ Rượu Vang',
            colorHex: '#5E1924',
            studioCutoutUrl: '/images/seasons-vitrine/variants/ao-so-mi-lua-to-tam-tam-xuan-wine-red.webp',
            macroSwatchUrl: '/images/seasons-vitrine/macros/silk-wine-red.webp',
            fabricSpecText: 'Lụa Tơ Tằm Bảo Lộc · Đỏ Rượu Vang 22 Momme · Sắc sâu sang trọng',
          },
          {
            colorKey: 'sage-green',
            colorName: 'Xanh Rêu',
            colorHex: '#4A5546',
            studioCutoutUrl: '/images/seasons-vitrine/variants/ao-so-mi-lua-to-tam-tam-xuan-sage-green.webp',
            macroSwatchUrl: '/images/seasons-vitrine/macros/silk-sage-green.webp',
            fabricSpecText: 'Lụa Tơ Tằm Bảo Lộc · Xanh Rêu 22 Momme · Mát dịu tự nhiên',
          },
        ],
      },
      {
        slotKey: 'BOTTOM',
        productSlug: 'chan-vay-xep-ly-midi-cap-cao',
        shortPinLabel: 'Chân Váy Xếp Ly',
        defaultColorKey: 'ivory',
        pinPosition: { xPercent: 56.0, yPercent: 72.0 },
        garmentRegionMask: '/images/seasons-vitrine/masks/xuan-tam-xuan-mask-bottom.png',
        maskBbox: { x: 0.3417, y: 0.4392, w: 0.3333, h: 0.4175 },
        materialOpticalProfile: { sheen: 'silk', specularIntensity: 0.36, shadowDepth: 0.38 },
        variants: [
          {
            colorKey: 'ivory',
            colorName: 'Kem Sữa',
            colorHex: '#EDE3D1',
            studioCutoutUrl: '/images/seasons-vitrine/variants/chan-vay-xep-ly-midi-cap-cao-ivory.webp',
            macroSwatchUrl: '/images/seasons-vitrine/macros/pleated-silk-ivory.webp',
            fabricSpecText: 'Lụa Xếp Ly Tencel · Kem Sữa · Sóng ly giữ phom bền bỉ',
          },
          {
            colorKey: 'espresso',
            colorName: 'Nâu Cacao',
            colorHex: '#3D2B22',
            studioCutoutUrl: '/images/seasons-vitrine/variants/chan-vay-xep-ly-midi-cap-cao-espresso.webp',
            macroSwatchUrl: '/images/seasons-vitrine/macros/pleated-silk-espresso.webp',
            fabricSpecText: 'Lụa Xếp Ly Tencel · Nâu Cacao · Chiều sâu Quiet Luxury',
          },
          {
            colorKey: 'wine-red',
            colorName: 'Đỏ Rượu Vang',
            colorHex: '#5E1924',
            studioCutoutUrl: '/images/seasons-vitrine/variants/chan-vay-xep-ly-midi-cap-cao-wine-red.webp',
            macroSwatchUrl: '/images/seasons-vitrine/macros/pleated-silk-wine-red.webp',
            fabricSpecText: 'Lụa Xếp Ly Tencel · Đỏ Rượu Vang · Tôn chuyển động nhẹ nhàng',
          },
          {
            colorKey: 'sage-green',
            colorName: 'Xanh Khói',
            colorHex: '#4A5546',
            studioCutoutUrl: '/images/seasons-vitrine/variants/chan-vay-xep-ly-midi-cap-cao-sage-green.webp',
            macroSwatchUrl: '/images/seasons-vitrine/macros/pleated-silk-sage-green.webp',
            fabricSpecText: 'Lụa Xếp Ly Tencel · Xanh Khói · Thanh lịch tinh giản',
          },
        ],
      },
      {
        slotKey: 'ACCESSORY',
        productSlug: 'vi-cam-tay-clutch-champagne',
        shortPinLabel: 'Ví Clutch',
        defaultColorKey: 'champagne',
        pinPosition: { xPercent: 44.0, yPercent: 56.0 },
        garmentRegionMask: '/images/seasons-vitrine/masks/xuan-tam-xuan-mask-accessory.png',
        maskBbox: { x: 0.3854, y: 0.5117, w: 0.1365, h: 0.0717 },
        materialOpticalProfile: { sheen: 'leather', specularIntensity: 0.52, shadowDepth: 0.34 },
        variants: [
          {
            colorKey: 'champagne',
            colorName: 'Champagne Ánh Kim',
            colorHex: '#DFC9A6',
            studioCutoutUrl: '/images/seasons-vitrine/variants/vi-cam-tay-clutch-champagne-champagne.webp',
            macroSwatchUrl: '/images/seasons-vitrine/macros/leather-champagne.webp',
            fabricSpecText: 'Lụa Satin Khung Đồng · Champagne Ánh Kim · Chế tác thủ công',
          },
          {
            colorKey: 'jet-black',
            colorName: 'Đen Tuyền',
            colorHex: '#171615',
            studioCutoutUrl: '/images/seasons-vitrine/variants/vi-cam-tay-clutch-champagne-jet-black.webp',
            macroSwatchUrl: '/images/seasons-vitrine/macros/leather-jet-black.webp',
            fabricSpecText: 'Lụa Satin Khung Đồng · Đen Tuyền · Khóa đồng thau mài mờ',
          },
          {
            colorKey: 'wine-red',
            colorName: 'Đỏ Rượu Vang',
            colorHex: '#5E1924',
            studioCutoutUrl: '/images/seasons-vitrine/variants/vi-cam-tay-clutch-champagne-wine-red.webp',
            macroSwatchUrl: '/images/seasons-vitrine/macros/leather-wine-red.webp',
            fabricSpecText: 'Lụa Satin Khung Đồng · Đỏ Rượu Vang · Điểm nhấn dạ tiệc',
          },
        ],
      },
    ],
  },
  'ha-pho-co': {
    slug: 'ha-pho-co',
    order: 2,
    months: 'T3–T4',
    name: 'Hạ Linen Hữu Cơ',
    shortName: 'Hạ Linen',
    materialHeadline: '100% Organic French Linen Thoáng Khí',
    note: '100% Organic French Linen Thoáng Khí — áo sơ mi ngà sữa phối quần culottes linen cát biển và khăn lụa hoa mai.',
    isCurrent: false,
    outfitFormula: 'TOP_BOTTOM_ACCESSORY',
    defaultMacroSlotKey: 'TOP',
    baseEditorialImageUrl: '/images/seasons-vitrine/lookbooks/ha-pho-co-base.webp',
    wearableSlots: [
      {
        slotKey: 'TOP',
        productSlug: 'ao-so-mi-lua-to-tam-bao-loc',
        shortPinLabel: 'Áo Sơ Mi Bảo Lộc',
        defaultColorKey: 'ivory',
        pinPosition: { xPercent: 39.0, yPercent: 49.0 },
        garmentRegionMask: '/images/seasons-vitrine/masks/ha-pho-co-mask-top.png',
        maskBbox: { x: 0.224, y: 0.28, w: 0.575, h: 0.3383 },
        materialOpticalProfile: { sheen: 'linen', specularIntensity: 0.16, shadowDepth: 0.28 },
        variants: [
          {
            colorKey: 'ivory',
            colorName: 'Ngà Sữa',
            colorHex: '#F5EFE4',
            studioCutoutUrl: '/images/seasons-vitrine/variants/ao-so-mi-lua-to-tam-bao-loc-ivory.webp',
            macroSwatchUrl: '/images/seasons-vitrine/macros/linen-ivory.webp',
            fabricSpecText: 'Linen & Lụa Bảo Lộc · Ngà Sữa · Thoáng khí vượt trội',
          },
          {
            colorKey: 'sage-green',
            colorName: 'Xanh Rêu',
            colorHex: '#4A5546',
            studioCutoutUrl: '/images/seasons-vitrine/variants/ao-so-mi-lua-to-tam-bao-loc-sage-green.webp',
            macroSwatchUrl: '/images/seasons-vitrine/macros/linen-sage-green.webp',
            fabricSpecText: 'Linen & Lụa Bảo Lộc · Xanh Rêu · Dịu mát ngày nắng',
          },
          {
            colorKey: 'espresso',
            colorName: 'Nâu Cacao',
            colorHex: '#3D2B22',
            studioCutoutUrl: '/images/seasons-vitrine/variants/ao-so-mi-lua-to-tam-bao-loc-espresso.webp',
            macroSwatchUrl: '/images/seasons-vitrine/macros/linen-espresso.webp',
            fabricSpecText: 'Linen & Lụa Bảo Lộc · Nâu Cacao · Sắc trầm tự nhiên',
          },
        ],
      },
      {
        slotKey: 'BOTTOM',
        productSlug: 'quan-culottes-linen-huu-co',
        shortPinLabel: 'Quần Culottes Linen',
        defaultColorKey: 'sand',
        pinPosition: { xPercent: 50.0, yPercent: 76.0 },
        garmentRegionMask: '/images/seasons-vitrine/masks/ha-pho-co-mask-bottom.png',
        maskBbox: { x: 0.3083, y: 0.6083, w: 0.4062, h: 0.3892 },
        materialOpticalProfile: { sheen: 'linen', specularIntensity: 0.14, shadowDepth: 0.30 },
        variants: [
          {
            colorKey: 'sand',
            colorName: 'Cát Biển',
            colorHex: '#D7C7B2',
            studioCutoutUrl: '/images/seasons-vitrine/variants/quan-culottes-linen-huu-co-sand.webp',
            macroSwatchUrl: '/images/seasons-vitrine/macros/linen-sand.webp',
            fabricSpecText: '100% Organic French Linen · Cát Biển · Stone-washed mềm mịn',
          },
          {
            colorKey: 'jet-black',
            colorName: 'Đen Tuyền',
            colorHex: '#171615',
            studioCutoutUrl: '/images/seasons-vitrine/variants/quan-culottes-linen-huu-co-jet-black.webp',
            macroSwatchUrl: '/images/seasons-vitrine/macros/linen-jet-black.webp',
            fabricSpecText: '100% Organic French Linen · Đen Tuyền · Đứng dáng nhẹ mát',
          },
          {
            colorKey: 'sage-green',
            colorName: 'Xanh Rêu',
            colorHex: '#4A5546',
            studioCutoutUrl: '/images/seasons-vitrine/variants/quan-culottes-linen-huu-co-sage-green.webp',
            macroSwatchUrl: '/images/seasons-vitrine/macros/linen-sage-green.webp',
            fabricSpecText: '100% Organic French Linen · Xanh Rêu · Sợi dệt thoáng tự nhiên',
          },
        ],
      },
      {
        slotKey: 'ACCESSORY',
        productSlug: 'khan-lua-hoa-tiet-tam-xuan',
        shortPinLabel: 'Khăn Lụa Họa Tiết',
        defaultColorKey: 'ivory',
        pinPosition: { xPercent: 60.0, yPercent: 34.0 },
        garmentRegionMask: '/images/seasons-vitrine/masks/ha-pho-co-mask-accessory.png',
        maskBbox: { x: 0.4594, y: 0.2392, w: 0.2323, h: 0.3775 },
        materialOpticalProfile: { sheen: 'silk', specularIntensity: 0.42, shadowDepth: 0.26 },
        variants: [
          {
            colorKey: 'ivory',
            colorName: 'Kem Hoa Mai',
            colorHex: '#EFE5D2',
            studioCutoutUrl: '/images/seasons-vitrine/variants/khan-lua-hoa-tiet-tam-xuan-ivory.webp',
            macroSwatchUrl: '/images/seasons-vitrine/macros/silk-ivory.webp',
            fabricSpecText: 'Lụa Tơ Tằm 16 Momme · Kem Hoa Mai · Cuốn biên khâu tay',
          },
          {
            colorKey: 'wine-red',
            colorName: 'Đỏ Son Trầm',
            colorHex: '#5E1924',
            studioCutoutUrl: '/images/seasons-vitrine/variants/khan-lua-hoa-tiet-tam-xuan-wine-red.webp',
            macroSwatchUrl: '/images/seasons-vitrine/macros/silk-wine-red.webp',
            fabricSpecText: 'Lụa Tơ Tằm 16 Momme · Đỏ Son Trầm · Điểm nhấn cổ áo tinh tế',
          },
          {
            colorKey: 'jet-black',
            colorName: 'Đen Tuyền',
            colorHex: '#171615',
            studioCutoutUrl: '/images/seasons-vitrine/variants/khan-lua-hoa-tiet-tam-xuan-jet-black.webp',
            macroSwatchUrl: '/images/seasons-vitrine/macros/silk-jet-black.webp',
            fabricSpecText: 'Lụa Tơ Tằm 16 Momme · Đen Tuyền · In lụa thủ công',
          },
        ],
      },
    ],
  },
  'resort-ban-mai': {
    slug: 'resort-ban-mai',
    order: 3,
    months: 'T5–T6',
    name: 'Resort Biển & Lụa Bay',
    shortName: 'Resort Biển',
    materialHeadline: 'Linen Tự Nhiên & Len Merino Mỏng Nhẹ',
    note: 'Linen & Tơ Sống dệt thoáng kết hợp cardigan Merino khoác nhẹ đón gió biển ban mai.',
    isCurrent: false,
    outfitFormula: 'ONE_PIECE_OUTERWEAR_ACCESSORY',
    defaultMacroSlotKey: 'ONE_PIECE',
    baseEditorialImageUrl: '/images/seasons-vitrine/lookbooks/resort-ban-mai-base.webp',
    wearableSlots: [
      {
        slotKey: 'ONE_PIECE',
        productSlug: 'dam-midi-linen-phoi-dai',
        shortPinLabel: 'Đầm Midi Linen',
        defaultColorKey: 'sand',
        pinPosition: { xPercent: 54.0, yPercent: 64.0 },
        garmentRegionMask: '/images/seasons-vitrine/masks/resort-ban-mai-mask-one_piece.png',
        maskBbox: { x: 0.1292, y: 0.2242, w: 0.7208, h: 0.7633 },
        materialOpticalProfile: { sheen: 'linen', specularIntensity: 0.20, shadowDepth: 0.30 },
        variants: [
          {
            colorKey: 'sand',
            colorName: 'Lanh Tự Nhiên',
            colorHex: '#DDD1BD',
            studioCutoutUrl: '/images/seasons-vitrine/variants/dam-midi-linen-phoi-dai-sand.webp',
            macroSwatchUrl: '/images/seasons-vitrine/macros/linen-sand.webp',
            fabricSpecText: 'Linen & Tơ Sống · Lanh Tự Nhiên · Nhẹ hành lý ít nhăn',
          },
          {
            colorKey: 'ivory',
            colorName: 'Kem Ngà',
            colorHex: '#F4EFE6',
            studioCutoutUrl: '/images/seasons-vitrine/variants/dam-midi-linen-phoi-dai-ivory.webp',
            macroSwatchUrl: '/images/seasons-vitrine/macros/linen-ivory.webp',
            fabricSpecText: 'Linen & Tơ Sống · Kem Ngà · Tươi sáng dưới nắng biển',
          },
          {
            colorKey: 'sage-green',
            colorName: 'Xanh Rêu',
            colorHex: '#4A5546',
            studioCutoutUrl: '/images/seasons-vitrine/variants/dam-midi-linen-phoi-dai-sage-green.webp',
            macroSwatchUrl: '/images/seasons-vitrine/macros/linen-sage-green.webp',
            fabricSpecText: 'Linen & Tơ Sống · Xanh Rêu · Hòa cùng sắc thiên nhiên',
          },
        ],
      },
      {
        slotKey: 'OUTERWEAR',
        productSlug: 'ao-cardigan-len-merino-khuy-sung',
        shortPinLabel: 'Cardigan Merino',
        defaultColorKey: 'ivory',
        pinPosition: { xPercent: 31.0, yPercent: 46.0 },
        garmentRegionMask: '/images/seasons-vitrine/masks/resort-ban-mai-mask-outerwear.png',
        maskBbox: { x: 0.1531, y: 0.2483, w: 0.6208, h: 0.6042 },
        materialOpticalProfile: { sheen: 'tweed', specularIntensity: 0.16, shadowDepth: 0.34 },
        variants: [
          {
            colorKey: 'ivory',
            colorName: 'Yến Mạch',
            colorHex: '#DFD4C2',
            studioCutoutUrl: '/images/seasons-vitrine/variants/ao-cardigan-len-merino-khuy-sung-ivory.webp',
            macroSwatchUrl: '/images/seasons-vitrine/macros/tweed-ivory.webp',
            fabricSpecText: 'Len Merino 16 Gauge · Yến Mạch · Khoác nhẹ chiều biển',
          },
          {
            colorKey: 'espresso',
            colorName: 'Nâu Cacao',
            colorHex: '#3D2B22',
            studioCutoutUrl: '/images/seasons-vitrine/variants/ao-cardigan-len-merino-khuy-sung-espresso.webp',
            macroSwatchUrl: '/images/seasons-vitrine/macros/tweed-espresso.webp',
            fabricSpecText: 'Len Merino 16 Gauge · Nâu Cacao · Mềm mịn không xù lông',
          },
          {
            colorKey: 'jet-black',
            colorName: 'Đen Tuyền',
            colorHex: '#171615',
            studioCutoutUrl: '/images/seasons-vitrine/variants/ao-cardigan-len-merino-khuy-sung-jet-black.webp',
            macroSwatchUrl: '/images/seasons-vitrine/macros/tweed-jet-black.webp',
            fabricSpecText: 'Len Merino 16 Gauge · Đen Tuyền · Khuy sừng mài thủ công',
          },
        ],
      },
      {
        slotKey: 'ACCESSORY',
        productSlug: 'khan-lua-hoa-tiet-tam-xuan',
        shortPinLabel: 'Khăn Lụa Họa Tiết',
        defaultColorKey: 'ivory',
        pinPosition: { xPercent: 56.0, yPercent: 27.0 },
        garmentRegionMask: '/images/seasons-vitrine/masks/resort-ban-mai-mask-accessory.png',
        maskBbox: { x: 0.4396, y: 0.1992, w: 0.2698, h: 0.1625 },
        materialOpticalProfile: { sheen: 'silk', specularIntensity: 0.42, shadowDepth: 0.26 },
        variants: [
          {
            colorKey: 'ivory',
            colorName: 'Kem Hoa Mai',
            colorHex: '#EFE5D2',
            studioCutoutUrl: '/images/seasons-vitrine/variants/khan-lua-hoa-tiet-tam-xuan-ivory.webp',
            macroSwatchUrl: '/images/seasons-vitrine/macros/silk-ivory.webp',
            fabricSpecText: 'Lụa Organza & Tơ Tằm · Kem Hoa Mai · Bay nhẹ theo gió',
          },
          {
            colorKey: 'wine-red',
            colorName: 'Đỏ Son Trầm',
            colorHex: '#5E1924',
            studioCutoutUrl: '/images/seasons-vitrine/variants/khan-lua-hoa-tiet-tam-xuan-wine-red.webp',
            macroSwatchUrl: '/images/seasons-vitrine/macros/silk-wine-red.webp',
            fabricSpecText: 'Lụa Organza & Tơ Tằm · Đỏ Son Trầm · Nổi bật ánh hoàng hôn',
          },
          {
            colorKey: 'champagne',
            colorName: 'Champagne',
            colorHex: '#DFC9A6',
            studioCutoutUrl: '/images/seasons-vitrine/variants/khan-lua-hoa-tiet-tam-xuan-champagne.webp',
            macroSwatchUrl: '/images/seasons-vitrine/macros/silk-champagne.webp',
            fabricSpecText: 'Lụa Organza & Tơ Tằm · Champagne · Sang trọng thanh thoát',
          },
        ],
      },
    ],
  },
  'thu-hoang-hon': {
    slug: 'thu-hoang-hon',
    order: 4,
    months: 'T7–T8',
    name: 'Thu Công Sở Thanh Lịch',
    shortName: 'Thu Công Sở',
    materialHeadline: 'Lụa Organza & Wool Silk Blend Đứng Phom',
    note: 'Áo lụa Organza kem ngà phối quần tây xếp ly đôi xám than và thắt lưng da khóa đồng chuẩn mực công sở.',
    isCurrent: false,
    outfitFormula: 'TOP_BOTTOM_ACCESSORY',
    defaultMacroSlotKey: 'TOP',
    baseEditorialImageUrl: '/images/seasons-vitrine/lookbooks/thu-hoang-hon-base.webp',
    wearableSlots: [
      {
        slotKey: 'TOP',
        productSlug: 'ao-kieu-lua-organza-phoi-no',
        shortPinLabel: 'Áo Lụa Organza',
        defaultColorKey: 'ivory',
        pinPosition: { xPercent: 47.0, yPercent: 29.0 },
        garmentRegionMask: '/images/seasons-vitrine/masks/thu-hoang-hon-mask-top.png',
        maskBbox: { x: 0.3792, y: 0.19, w: 0.3135, h: 0.2208 },
        materialOpticalProfile: { sheen: 'silk', specularIntensity: 0.44, shadowDepth: 0.28 },
        variants: [
          {
            colorKey: 'ivory',
            colorName: 'Kem Ngà',
            colorHex: '#F4EFE6',
            studioCutoutUrl: '/images/seasons-vitrine/variants/ao-kieu-lua-organza-phoi-no-ivory.webp',
            macroSwatchUrl: '/images/seasons-vitrine/macros/silk-ivory.webp',
            fabricSpecText: 'Lụa Organza Tơ Tằm · Kem Ngà · Nẹp cổ thanh lịch công sở',
          },
          {
            colorKey: 'champagne',
            colorName: 'Hồng Phấn Đất',
            colorHex: '#DFC5BE',
            studioCutoutUrl: '/images/seasons-vitrine/variants/ao-kieu-lua-organza-phoi-no-champagne.webp',
            macroSwatchUrl: '/images/seasons-vitrine/macros/silk-champagne.webp',
            fabricSpecText: 'Lụa Organza Tơ Tằm · Hồng Phấn Đất · Xuyên thấu tinh tế',
          },
          {
            colorKey: 'jet-black',
            colorName: 'Đen Tuyền',
            colorHex: '#171615',
            studioCutoutUrl: '/images/seasons-vitrine/variants/ao-kieu-lua-organza-phoi-no-jet-black.webp',
            macroSwatchUrl: '/images/seasons-vitrine/macros/silk-jet-black.webp',
            fabricSpecText: 'Lụa Organza Tơ Tằm · Đen Tuyền · Sắc nét chuẩn mực',
          },
        ],
      },
      {
        slotKey: 'BOTTOM',
        productSlug: 'quan-tay-ong-suong-xep-ly-doi',
        shortPinLabel: 'Quần Tây Xếp Ly',
        defaultColorKey: 'charcoal',
        pinPosition: { xPercent: 48.0, yPercent: 68.0 },
        garmentRegionMask: '/images/seasons-vitrine/masks/thu-hoang-hon-mask-bottom.png',
        maskBbox: { x: 0.3521, y: 0.4525, w: 0.3042, h: 0.5442 },
        materialOpticalProfile: { sheen: 'tweed', specularIntensity: 0.18, shadowDepth: 0.36 },
        variants: [
          {
            colorKey: 'charcoal',
            colorName: 'Xám Than',
            colorHex: '#3B3D40',
            studioCutoutUrl: '/images/seasons-vitrine/variants/quan-tay-ong-suong-xep-ly-doi-charcoal.webp',
            macroSwatchUrl: '/images/seasons-vitrine/macros/tweed-charcoal.webp',
            fabricSpecText: 'Wool Silk Blend · Xám Than · Đường ép ly đôi sắc nét',
          },
          {
            colorKey: 'sand',
            colorName: 'Be Đá',
            colorHex: '#C9BEA9',
            studioCutoutUrl: '/images/seasons-vitrine/variants/quan-tay-ong-suong-xep-ly-doi-sand.webp',
            macroSwatchUrl: '/images/seasons-vitrine/macros/linen-sand.webp',
            fabricSpecText: 'Wool Silk Blend · Be Đá · Cạp cao kéo dài tỷ lệ',
          },
          {
            colorKey: 'jet-black',
            colorName: 'Đen Tuyền',
            colorHex: '#171615',
            studioCutoutUrl: '/images/seasons-vitrine/variants/quan-tay-ong-suong-xep-ly-doi-jet-black.webp',
            macroSwatchUrl: '/images/seasons-vitrine/macros/tweed-jet-black.webp',
            fabricSpecText: 'Wool Silk Blend · Đen Tuyền · Co giãn nhẹ 2% thoải mái',
          },
        ],
      },
      {
        slotKey: 'ACCESSORY',
        productSlug: 'that-lung-da-khoa-dong',
        shortPinLabel: 'Thắt Lưng Da',
        defaultColorKey: 'espresso',
        pinPosition: { xPercent: 52.0, yPercent: 44.0 },
        garmentRegionMask: '/images/seasons-vitrine/masks/thu-hoang-hon-mask-accessory.png',
        maskBbox: { x: 0.3698, y: 0.3792, w: 0.2344, h: 0.0775 },
        materialOpticalProfile: { sheen: 'leather', specularIntensity: 0.50, shadowDepth: 0.36 },
        variants: [
          {
            colorKey: 'espresso',
            colorName: 'Cacao Cổ Điển',
            colorHex: '#3B281E',
            studioCutoutUrl: '/images/seasons-vitrine/variants/that-lung-da-khoa-dong-espresso.webp',
            macroSwatchUrl: '/images/seasons-vitrine/macros/leather-espresso.webp',
            fabricSpecText: 'Da Bê Thuộc Thảo Mộc · Cacao Cổ Điển · Khóa đồng mài mờ',
          },
          {
            colorKey: 'jet-black',
            colorName: 'Đen Tuyền',
            colorHex: '#171615',
            studioCutoutUrl: '/images/seasons-vitrine/variants/that-lung-da-khoa-dong-jet-black.webp',
            macroSwatchUrl: '/images/seasons-vitrine/macros/leather-jet-black.webp',
            fabricSpecText: 'Da Bê Thuộc Thảo Mộc · Đen Tuyền · Đan thủ công tinh xảo',
          },
          {
            colorKey: 'sand',
            colorName: 'Be Cát',
            colorHex: '#C9B596',
            studioCutoutUrl: '/images/seasons-vitrine/variants/that-lung-da-khoa-dong-sand.webp',
            macroSwatchUrl: '/images/seasons-vitrine/macros/leather-champagne.webp',
            fabricSpecText: 'Da Bê Thuộc Thảo Mộc · Be Cát · Bản rộng 2.8cm thanh thoát',
          },
        ],
      },
    ],
  },
  'dong-cashmere': {
    slug: 'dong-cashmere',
    order: 5,
    months: 'T9–T10',
    name: 'Dạ Tweed & Cashmere',
    shortName: 'Dạ Tweed',
    materialHeadline: 'Dạ Tweed Dệt Nổi Thủ Công & Đầm Midi Chiết Eo',
    note: 'Áo khoác Dạ Tweed dệt thủ công khoác ngoài đầm midi cổ vuông chiết eo trắng ngọc đầy khí chất.',
    isCurrent: false,
    outfitFormula: 'ONE_PIECE_OUTERWEAR_ACCESSORY',
    defaultMacroSlotKey: 'OUTERWEAR',
    baseEditorialImageUrl: '/images/seasons-vitrine/lookbooks/dong-cashmere-base.webp',
    wearableSlots: [
      {
        slotKey: 'ONE_PIECE',
        productSlug: 'dam-midi-co-vuong-chiet-eo',
        shortPinLabel: 'Đầm Midi Cổ Vuông',
        defaultColorKey: 'ivory',
        pinPosition: { xPercent: 52.0, yPercent: 51.0 },
        garmentRegionMask: '/images/seasons-vitrine/masks/dong-cashmere-mask-one_piece.png',
        maskBbox: { x: 0.3438, y: 0.265, w: 0.3521, h: 0.725 },
        materialOpticalProfile: { sheen: 'linen', specularIntensity: 0.24, shadowDepth: 0.32 },
        variants: [
          {
            colorKey: 'ivory',
            colorName: 'Trắng Ngọc',
            colorHex: '#F3ECE0',
            studioCutoutUrl: '/images/seasons-vitrine/variants/dam-midi-co-vuong-chiet-eo-ivory.webp',
            macroSwatchUrl: '/images/seasons-vitrine/macros/linen-ivory.webp',
            fabricSpecText: 'Tơ Linen Ép Phom · Trắng Ngọc · Cổ vuông hàng khuy bất đối xứng',
          },
          {
            colorKey: 'espresso',
            colorName: 'Nâu Espresso',
            colorHex: '#46332A',
            studioCutoutUrl: '/images/seasons-vitrine/variants/dam-midi-co-vuong-chiet-eo-espresso.webp',
            macroSwatchUrl: '/images/seasons-vitrine/macros/linen-espresso.webp',
            fabricSpecText: 'Tơ Linen Ép Phom · Nâu Espresso · Chiết eo chuẩn couture',
          },
          {
            colorKey: 'jet-black',
            colorName: 'Đen Tuyền',
            colorHex: '#171615',
            studioCutoutUrl: '/images/seasons-vitrine/variants/dam-midi-co-vuong-chiet-eo-jet-black.webp',
            macroSwatchUrl: '/images/seasons-vitrine/macros/linen-jet-black.webp',
            fabricSpecText: 'Tơ Linen Ép Phom · Đen Tuyền · Thanh mảnh sang trọng',
          },
        ],
      },
      {
        slotKey: 'OUTERWEAR',
        productSlug: 'ao-khoac-tweed-det-thu-cong',
        shortPinLabel: 'Áo Khoác Tweed',
        defaultColorKey: 'ivory',
        pinPosition: { xPercent: 65.0, yPercent: 35.0 },
        garmentRegionMask: '/images/seasons-vitrine/masks/dong-cashmere-mask-outerwear.png',
        maskBbox: { x: 0.2583, y: 0.1958, w: 0.5042, h: 0.4217 },
        materialOpticalProfile: { sheen: 'tweed', specularIntensity: 0.20, shadowDepth: 0.40 },
        variants: [
          {
            colorKey: 'ivory',
            colorName: 'Ngà Ánh Đồng',
            colorHex: '#E6DCC8',
            studioCutoutUrl: '/images/seasons-vitrine/variants/ao-khoac-tweed-det-thu-cong-ivory.webp',
            macroSwatchUrl: '/images/seasons-vitrine/macros/tweed-ivory.webp',
            fabricSpecText: 'Dạ Tweed Dệt Nổi · Ngà Ánh Đồng · Viền tết tay couture',
          },
          {
            colorKey: 'jet-black',
            colorName: 'Đen Tuyền',
            colorHex: '#171615',
            studioCutoutUrl: '/images/seasons-vitrine/variants/ao-khoac-tweed-det-thu-cong-jet-black.webp',
            macroSwatchUrl: '/images/seasons-vitrine/macros/tweed-jet-black.webp',
            fabricSpecText: 'Dạ Tweed Dệt Nổi · Đen Tuyền · Cúc đồng chạm khắc',
          },
          {
            colorKey: 'espresso',
            colorName: 'Cacao Đêm',
            colorHex: '#2C211C',
            studioCutoutUrl: '/images/seasons-vitrine/variants/ao-khoac-tweed-det-thu-cong-espresso.webp',
            macroSwatchUrl: '/images/seasons-vitrine/macros/tweed-espresso.webp',
            fabricSpecText: 'Dạ Tweed Dệt Nổi · Cacao Đêm · Sợi len pha lụa tơ tằm',
          },
        ],
      },
      {
        slotKey: 'ACCESSORY',
        productSlug: 'vi-cam-tay-clutch-champagne',
        shortPinLabel: 'Ví Clutch',
        defaultColorKey: 'jet-black',
        pinPosition: { xPercent: 41.0, yPercent: 69.0 },
        garmentRegionMask: '/images/seasons-vitrine/masks/dong-cashmere-mask-accessory.png',
        maskBbox: { x: 0.3052, y: 0.63, w: 0.1875, h: 0.1317 },
        materialOpticalProfile: { sheen: 'leather', specularIntensity: 0.52, shadowDepth: 0.34 },
        variants: [
          {
            colorKey: 'jet-black',
            colorName: 'Đen Tuyền',
            colorHex: '#171615',
            studioCutoutUrl: '/images/seasons-vitrine/variants/vi-cam-tay-clutch-champagne-jet-black.webp',
            macroSwatchUrl: '/images/seasons-vitrine/macros/leather-jet-black.webp',
            fabricSpecText: 'Lụa Satin Khung Đồng · Đen Tuyền · Hoàn thiện set Dạ Tweed',
          },
          {
            colorKey: 'champagne',
            colorName: 'Champagne Ánh Kim',
            colorHex: '#DFC9A6',
            studioCutoutUrl: '/images/seasons-vitrine/variants/vi-cam-tay-clutch-champagne-champagne.webp',
            macroSwatchUrl: '/images/seasons-vitrine/macros/leather-champagne.webp',
            fabricSpecText: 'Lụa Satin Khung Đồng · Champagne Ánh Kim · Sang trọng mùa thu đông',
          },
          {
            colorKey: 'wine-red',
            colorName: 'Đỏ Rượu Vang',
            colorHex: '#5E1924',
            studioCutoutUrl: '/images/seasons-vitrine/variants/vi-cam-tay-clutch-champagne-wine-red.webp',
            macroSwatchUrl: '/images/seasons-vitrine/macros/leather-wine-red.webp',
            fabricSpecText: 'Lụa Satin Khung Đồng · Đỏ Rượu Vang · Ấm áp tiệc tối',
          },
        ],
      },
    ],
  },
  'atelier-di-san': {
    slug: 'atelier-di-san',
    order: 6,
    months: 'T11–T12',
    name: 'Dạ Tiệc Cuối Năm',
    shortName: 'Dạ Tiệc',
    materialHeadline: 'Lụa Satin Ánh Ngọc & Nhung Couture',
    note: 'Đầm dự tiệc lụa satin đỏ rượu vang cắt thiên bias-cut khoác hờ blazer cát ngà và ví clutch champagne.',
    isCurrent: false,
    outfitFormula: 'ONE_PIECE_OUTERWEAR_ACCESSORY',
    defaultMacroSlotKey: 'ONE_PIECE',
    baseEditorialImageUrl: '/images/seasons-vitrine/lookbooks/atelier-di-san-base.webp',
    wearableSlots: [
      {
        slotKey: 'ONE_PIECE',
        productSlug: 'dam-du-tiec-lua-satin-co-do',
        shortPinLabel: 'Đầm Satin Cổ Đổ',
        defaultColorKey: 'wine-red',
        pinPosition: { xPercent: 47.0, yPercent: 71.0 },
        garmentRegionMask: '/images/seasons-vitrine/masks/atelier-di-san-mask-one_piece.png',
        maskBbox: { x: 0.3187, y: 0.2133, w: 0.3427, h: 0.7492 },
        materialOpticalProfile: { sheen: 'silk', specularIntensity: 0.50, shadowDepth: 0.36 },
        variants: [
          {
            colorKey: 'wine-red',
            colorName: 'Đỏ Rượu Vang',
            colorHex: '#5E1924',
            studioCutoutUrl: '/images/seasons-vitrine/variants/dam-du-tiec-lua-satin-co-do-wine-red.webp',
            macroSwatchUrl: '/images/seasons-vitrine/macros/silk-wine-red.webp',
            fabricSpecText: 'Lụa Satin 22 Momme · Đỏ Rượu Vang · Cắt thiên bias-cut',
          },
          {
            colorKey: 'jet-black',
            colorName: 'Đen Huyền',
            colorHex: '#171615',
            studioCutoutUrl: '/images/seasons-vitrine/variants/dam-du-tiec-lua-satin-co-do-jet-black.webp',
            macroSwatchUrl: '/images/seasons-vitrine/macros/silk-jet-black.webp',
            fabricSpecText: 'Lụa Satin 22 Momme · Đen Huyền · Ánh ngọc dưới đèn tiệc',
          },
          {
            colorKey: 'champagne',
            colorName: 'Champagne Ánh Ngọc',
            colorHex: '#DFC9A6',
            studioCutoutUrl: '/images/seasons-vitrine/variants/dam-du-tiec-lua-satin-co-do-champagne.webp',
            macroSwatchUrl: '/images/seasons-vitrine/macros/silk-champagne.webp',
            fabricSpecText: 'Lụa Satin 22 Momme · Champagne Ánh Ngọc · Mềm rủ couture',
          },
        ],
      },
      {
        slotKey: 'OUTERWEAR',
        productSlug: 'ao-blazer-linen-dang-suong',
        shortPinLabel: 'Blazer Kem Ngà',
        defaultColorKey: 'sand',
        pinPosition: { xPercent: 36.0, yPercent: 34.0 },
        garmentRegionMask: '/images/seasons-vitrine/masks/atelier-di-san-mask-outerwear.png',
        maskBbox: { x: 0.3073, y: 0.2033, w: 0.4156, h: 0.3492 },
        materialOpticalProfile: { sheen: 'linen', specularIntensity: 0.22, shadowDepth: 0.34 },
        variants: [
          {
            colorKey: 'sand',
            colorName: 'Cát Ngà',
            colorHex: '#D8C9B4',
            studioCutoutUrl: '/images/seasons-vitrine/variants/ao-blazer-linen-dang-suong-sand.webp',
            macroSwatchUrl: '/images/seasons-vitrine/macros/linen-sand.webp',
            fabricSpecText: 'Linen Bỉ & Lót Lụa Habotai · Cát Ngà · Khoác hờ dạ tiệc thanh lịch',
          },
          {
            colorKey: 'espresso',
            colorName: 'Cacao Đậm',
            colorHex: '#3A2A22',
            studioCutoutUrl: '/images/seasons-vitrine/variants/ao-blazer-linen-dang-suong-espresso.webp',
            macroSwatchUrl: '/images/seasons-vitrine/macros/linen-espresso.webp',
            fabricSpecText: 'Linen Bỉ & Lót Lụa Habotai · Cacao Đậm · Phom dựng vai mềm',
          },
          {
            colorKey: 'jet-black',
            colorName: 'Đen Tuyền',
            colorHex: '#171615',
            studioCutoutUrl: '/images/seasons-vitrine/variants/ao-blazer-linen-dang-suong-jet-black.webp',
            macroSwatchUrl: '/images/seasons-vitrine/macros/linen-jet-black.webp',
            fabricSpecText: 'Linen Bỉ & Lót Lụa Habotai · Đen Tuyền · Khí chất dạ hội',
          },
        ],
      },
      {
        slotKey: 'ACCESSORY',
        productSlug: 'vi-cam-tay-clutch-champagne',
        shortPinLabel: 'Ví Clutch',
        defaultColorKey: 'champagne',
        pinPosition: { xPercent: 59.0, yPercent: 54.0 },
        garmentRegionMask: '/images/seasons-vitrine/masks/atelier-di-san-mask-accessory.png',
        maskBbox: { x: 0.5521, y: 0.4925, w: 0.0625, h: 0.0675 },
        materialOpticalProfile: { sheen: 'leather', specularIntensity: 0.52, shadowDepth: 0.34 },
        variants: [
          {
            colorKey: 'champagne',
            colorName: 'Champagne Ánh Kim',
            colorHex: '#DFC9A6',
            studioCutoutUrl: '/images/seasons-vitrine/variants/vi-cam-tay-clutch-champagne-champagne.webp',
            macroSwatchUrl: '/images/seasons-vitrine/macros/leather-champagne.webp',
            fabricSpecText: 'Lụa Satin Khung Đồng · Champagne Ánh Kim · Chế tác thủ công',
          },
          {
            colorKey: 'jet-black',
            colorName: 'Đen Tuyền',
            colorHex: '#171615',
            studioCutoutUrl: '/images/seasons-vitrine/variants/vi-cam-tay-clutch-champagne-jet-black.webp',
            macroSwatchUrl: '/images/seasons-vitrine/macros/leather-jet-black.webp',
            fabricSpecText: 'Lụa Satin Khung Đồng · Đen Tuyền · Tối giản dạ hội',
          },
          {
            colorKey: 'wine-red',
            colorName: 'Đỏ Rượu Vang',
            colorHex: '#5E1924',
            studioCutoutUrl: '/images/seasons-vitrine/variants/vi-cam-tay-clutch-champagne-wine-red.webp',
            macroSwatchUrl: '/images/seasons-vitrine/macros/leather-wine-red.webp',
            fabricSpecText: 'Lụa Satin Khung Đồng · Đỏ Rượu Vang · Đồng điệu satin couture',
          },
        ],
      },
    ],
  },
};

let cachedManifestPath: string | null = null;
let cachedManifestMtimeMs = -1;
let cachedManifestBySlug: Map<string, ManifestSeasonEntry> = new Map();

const VITRINE_URL_PREFIX = '/images/seasons-vitrine/';

function pickVerifiedVitrineUrl(
  candidate: string | null | undefined,
  fallback: string,
): string {
  const trimmed = typeof candidate === 'string' ? candidate.trim() : '';
  if (trimmed.startsWith(VITRINE_URL_PREFIX)) {
    return trimmed;
  }
  return fallback;
}

function resolveManifestCandidatePaths(): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();
  const roots = [
    process.cwd(),
    path.resolve(__dirname, '../../../..'),
    path.resolve(__dirname, '../../../../..'),
    path.resolve(process.cwd(), '../..'),
  ];
  for (const root of roots) {
    for (const rel of ['apps/storefront/public/images/seasons-vitrine/manifest.json']) {
      const full = path.resolve(root, rel);
      if (!seen.has(full)) {
        seen.add(full);
        candidates.push(full);
      }
    }
  }
  return candidates;
}

function parseManifestEntries(raw: unknown): Map<string, ManifestSeasonEntry> {
  const map = new Map<string, ManifestSeasonEntry>();
  if (!raw || typeof raw !== 'object') {
    return map;
  }

  let list: ManifestSeasonEntry[] = [];
  if (Array.isArray(raw)) {
    list = raw as ManifestSeasonEntry[];
  } else {
    const obj = raw as Record<string, unknown>;
    if (Array.isArray(obj.seasons)) {
      list = obj.seasons as ManifestSeasonEntry[];
    } else if (Array.isArray(obj.items)) {
      list = obj.items as ManifestSeasonEntry[];
    } else {
      for (const [key, val] of Object.entries(obj)) {
        if (val && typeof val === 'object' && !Array.isArray(val)) {
          const entry = val as ManifestSeasonEntry;
          list.push({
            ...entry,
            seasonSlug: entry.seasonSlug ?? entry.slug ?? key,
          });
        }
      }
    }
  }

  for (const item of list) {
    const slug = (item.seasonSlug ?? item.slug ?? '').trim();
    if (slug) {
      map.set(slug, item);
    }
  }
  return map;
}

export function loadSeasonsManifestBySlug(): Map<string, ManifestSeasonEntry> {
  const candidates = resolveManifestCandidatePaths();
  let foundPath: string | null = null;
  let foundMtime = -1;

  for (const candidate of candidates) {
    try {
      const stat = fs.statSync(candidate);
      if (stat.isFile()) {
        foundPath = candidate;
        foundMtime = stat.mtimeMs;
        break;
      }
    } catch {
      // keep trying
    }
  }

  if (!foundPath) {
    return cachedManifestBySlug;
  }

  if (foundPath === cachedManifestPath && foundMtime === cachedManifestMtimeMs) {
    return cachedManifestBySlug;
  }

  try {
    const text = fs.readFileSync(foundPath, 'utf8');
    const parsed = JSON.parse(text) as unknown;
    cachedManifestBySlug = parseManifestEntries(parsed);
    cachedManifestPath = foundPath;
    cachedManifestMtimeMs = foundMtime;
  } catch {
    // Keep previous valid cache or empty map on transient partial write
  }

  return cachedManifestBySlug;
}

function hexLuminance(hex: string): number {
  const clean = hex.replace(/^#/, '').trim();
  if (clean.length !== 6) return 128;
  const r = Number.parseInt(clean.slice(0, 2), 16);
  const g = Number.parseInt(clean.slice(2, 4), 16);
  const b = Number.parseInt(clean.slice(4, 6), 16);
  if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) return 128;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function pickClosestDbVariant(
  dbProduct: ProductSpuDto | undefined,
  colorHex: string,
  colorName: string,
): ProductVariantDto | undefined {
  if (!dbProduct || dbProduct.variants.length === 0) {
    return undefined;
  }
  if (dbProduct.variants.length === 1) {
    return dbProduct.variants[0];
  }

  const normalizedName = colorName.trim().toLowerCase();
  const byName = dbProduct.variants.find(
    (v) => v.colorName.trim().toLowerCase() === normalizedName,
  );
  if (byName) {
    return byName;
  }

  const targetLum = hexLuminance(colorHex);
  let best = dbProduct.variants[0];
  let bestDiff = Math.abs(hexLuminance(best.colorHex) - targetLum);
  for (let i = 1; i < dbProduct.variants.length; i += 1) {
    const candidate = dbProduct.variants[i];
    const diff = Math.abs(hexLuminance(candidate.colorHex) - targetLum);
    if (diff < bestDiff) {
      best = candidate;
      bestDiff = diff;
    }
  }
  return best;
}

function sortSizesCanonically(sizes: readonly string[]): string[] {
  const unique = Array.from(new Set(sizes));
  return unique.sort((a, b) => {
    const ia = SIZE_DISPLAY_ORDER.indexOf(a);
    const ib = SIZE_DISPLAY_ORDER.indexOf(b);
    if (ia === -1 && ib === -1) return a.localeCompare(b);
    if (ia === -1) return 1;
    if (ib === -1) return -1;
    return ia - ib;
  });
}

function pickDefaultSkuId(dbVariant: ProductVariantDto | undefined, fallbackId: string): string {
  if (!dbVariant || dbVariant.skus.length === 0) {
    return fallbackId;
  }
  const inStock = dbVariant.skus.filter((s) => s.inStock);
  const pool = inStock.length > 0 ? inStock : dbVariant.skus;
  const preferred =
    pool.find((s) => s.sizeCode === 'M') ??
    pool.find((s) => s.sizeCode === 'S') ??
    pool[0];
  return preferred?.id ?? fallbackId;
}

function buildSizeSkuMap(dbVariant: ProductVariantDto | undefined): Record<string, string> {
  const map: Record<string, string> = {};
  if (!dbVariant) return map;
  for (const sku of dbVariant.skus) {
    if (!map[sku.sizeCode] || sku.inStock) {
      map[sku.sizeCode] = sku.id;
    }
  }
  return map;
}

function resolveOutfitFormulaFromSlots(
  slots: readonly SeasonWearableSlot[],
  explicitFormula?: SeasonOutfitFormula,
): SeasonOutfitFormula {
  const keys = slots.map((s) => s.slotKey);
  const hasOnePiece = keys.includes('ONE_PIECE');
  const hasTopOrBottom = keys.includes('TOP') || keys.includes('BOTTOM');
  if (hasOnePiece && hasTopOrBottom) {
    throw new Error(
      `Invalid Outfit-Bound season slots: cannot mix ONE_PIECE with TOP/BOTTOM (${keys.join(' + ')})`,
    );
  }
  if (
    explicitFormula === 'TOP_BOTTOM_ACCESSORY' ||
    explicitFormula === 'ONE_PIECE_OUTERWEAR_ACCESSORY'
  ) {
    return explicitFormula;
  }
  return hasOnePiece ? 'ONE_PIECE_OUTERWEAR_ACCESSORY' : 'TOP_BOTTOM_ACCESSORY';
}

function sanitizeSlotKey(raw: unknown, fallback: SeasonWearableSlotKey): SeasonWearableSlotKey {
  if (
    raw === 'TOP' ||
    raw === 'BOTTOM' ||
    raw === 'ONE_PIECE' ||
    raw === 'OUTERWEAR' ||
    raw === 'ACCESSORY'
  ) {
    return raw;
  }
  return fallback;
}

function sanitizeOpticalProfile(
  raw: Partial<MaterialOpticalProfile> | undefined,
  fallback: MaterialOpticalProfile,
): MaterialOpticalProfile {
  const sheen =
    raw?.sheen === 'silk' ||
    raw?.sheen === 'linen' ||
    raw?.sheen === 'tweed' ||
    raw?.sheen === 'leather'
      ? raw.sheen
      : fallback.sheen;
  const specularIntensity =
    typeof raw?.specularIntensity === 'number' && Number.isFinite(raw.specularIntensity)
      ? raw.specularIntensity
      : fallback.specularIntensity;
  const shadowDepth =
    typeof raw?.shadowDepth === 'number' && Number.isFinite(raw.shadowDepth)
      ? raw.shadowDepth
      : fallback.shadowDepth;
  return { sheen, specularIntensity, shadowDepth };
}

export interface SeasonSwatchEntry {
  name: string;
  hex: string;
  fabricNote?: string | null;
  colorKey?: string | null;
  sheen?: string | null;
}

export interface SeasonDbRow {
  id: string;
  slug: string;
  months: string;
  title: string;
  season_tag?: string | null;
  subtitle: string;
  palette_hex?: string | null;
  hero_image_url: string | null;
  is_current: boolean;
  sort_order: number;
  code?: string | null;
  short_name?: string | null;
  material_headline?: string | null;
  swatches_jsonb?: unknown;
  palette_jsonb?: unknown;
  lookbook_meta_jsonb?: unknown;
  spu_ids_jsonb?: unknown;
  product_slugs_jsonb?: unknown;
  is_active?: boolean | null;
  updated_at?: Date | string | null;
}

export interface HydratedSeasonCollectionDto extends SeasonalCollectionDto {
  code: string;
  subtitle: string;
  seasonTag: string;
  seasonOrder: number;
  paletteHex: string;
  heroImageUrl: string | null;
  swatches: SeasonSwatchEntry[];
  paletteJsonb: SeasonSwatchEntry[];
  lookbookMeta: Record<string, unknown>;
  spuIds: string[];
  isActive: boolean;
  updatedAt?: string;
}

function parseSeasonJson<T>(raw: unknown, fallback: T): T {
  if (raw === null || raw === undefined) {
    return fallback;
  }
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  }
  return raw as T;
}

function normalizeSwatchesList(raw: unknown): SeasonSwatchEntry[] {
  const parsed = parseSeasonJson<unknown>(raw, []);
  if (!Array.isArray(parsed)) {
    return [];
  }
  const out: SeasonSwatchEntry[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const name = String(rec.name ?? rec.colorName ?? rec.label ?? '').trim();
    const hex = String(rec.hex ?? rec.colorHex ?? '').trim();
    if (!name && !hex) continue;
    out.push({
      name: name || hex,
      hex: hex || '#B08A4A',
      ...(rec.fabricNote !== undefined
        ? { fabricNote: rec.fabricNote === null ? null : String(rec.fabricNote) }
        : {}),
      ...(rec.colorKey !== undefined
        ? { colorKey: rec.colorKey === null ? null : String(rec.colorKey) }
        : {}),
      ...(rec.sheen !== undefined
        ? { sheen: rec.sheen === null ? null : String(rec.sheen) }
        : {}),
    });
  }
  return out;
}

export function hydrateSeasonCollectionDto(
  row: SeasonDbRow,
  cleanProducts: readonly ProductSpuDto[],
  manifestBySlug: Map<string, ManifestSeasonEntry>,
): HydratedSeasonCollectionDto {
  const canonical = CANONICAL_SEASONS_METADATA[row.slug];
  const manifest = manifestBySlug.get(row.slug);
  const productBySlug = new Map<string, ProductSpuDto>(
    cleanProducts.map((p) => [p.slug, p]),
  );
  const productById = new Map<string, ProductSpuDto>(
    cleanProducts.map((p) => [p.id, p]),
  );

  const dbSpuIds = parseSeasonJson<unknown[]>(row.spu_ids_jsonb, [])
    .filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
  const dbProductSlugs = parseSeasonJson<unknown[]>(row.product_slugs_jsonb, [])
    .filter((v): v is string => typeof v === 'string' && v.trim().length > 0);

  const dbLinkedProducts: ProductSpuDto[] = [];
  const seenDbProdIds = new Set<string>();
  for (const spuId of dbSpuIds) {
    const prod = productById.get(spuId);
    if (prod && !seenDbProdIds.has(prod.id)) {
      seenDbProdIds.add(prod.id);
      dbLinkedProducts.push(prod);
    }
  }
  for (const pSlug of dbProductSlugs) {
    const prod = productBySlug.get(pSlug);
    if (prod && !seenDbProdIds.has(prod.id)) {
      seenDbProdIds.add(prod.id);
      dbLinkedProducts.push(prod);
    }
  }

  const seasonMatchedProducts = cleanProducts.filter((p) =>
    p.seasonSlugs.includes(row.slug),
  );

  const sourceSlots: Array<{
    manifestSlot?: ManifestSlotEntry;
    fallbackSlot: CanonicalSlotFallback;
  }> = [];

  if (manifest?.wearableSlots && manifest.wearableSlots.length > 0) {
    manifest.wearableSlots.forEach((ms, idx) => {
      const fb =
        canonical?.wearableSlots.find(
          (c) => c.slotKey === ms.slotKey || c.productSlug === ms.productSlug,
        ) ??
        canonical?.wearableSlots[idx] ??
        CANONICAL_SEASONS_METADATA['xuan-tam-xuan'].wearableSlots[
          idx % CANONICAL_SEASONS_METADATA['xuan-tam-xuan'].wearableSlots.length
        ];
      sourceSlots.push({ manifestSlot: ms, fallbackSlot: fb });
    });
  } else if (canonical) {
    for (const fb of canonical.wearableSlots) {
      sourceSlots.push({ fallbackSlot: fb });
    }
  }

  const wearableSlots: SeasonWearableSlot[] = [];
  const heroProductsMap = new Map<string, ProductSpuDto>();

  // Prioritize explicitly linked DB SPUs when present
  for (const prod of dbLinkedProducts) {
    heroProductsMap.set(prod.slug, prod);
  }

  for (const { manifestSlot, fallbackSlot } of sourceSlots) {
    const slotKey = sanitizeSlotKey(manifestSlot?.slotKey, fallbackSlot.slotKey);
    const desiredSlug = (manifestSlot?.productSlug || fallbackSlot.productSlug).trim();
    const dbProduct =
      productBySlug.get(desiredSlug) ??
      seasonMatchedProducts[wearableSlots.length] ??
      cleanProducts[0];

    if (dbProduct) {
      heroProductsMap.set(dbProduct.slug, dbProduct);
    }

    const rawVariants =
      manifestSlot?.variants && manifestSlot.variants.length > 0
        ? manifestSlot.variants
        : fallbackSlot.variants;

    const hydratedVariants: SeasonWearableVariant[] = rawVariants.map((mv, vIdx) => {
      const fbVar = fallbackSlot.variants[vIdx] ?? fallbackSlot.variants[0];
      const colorKey = (mv.colorKey || fbVar.colorKey || `variant-${vIdx}`).trim();
      const colorName = (mv.colorName || fbVar.colorName || 'Kem Ngà').trim();
      const colorHex = (mv.colorHex || fbVar.colorHex || '#F4EFE6').trim();
      const dbVariant = pickClosestDbVariant(dbProduct, colorHex, colorName);
      const fallbackVariantId = dbVariant?.id ?? `season-${row.slug}-${slotKey.toLowerCase()}-${colorKey}`;
      const skuDefaultId = pickDefaultSkuId(dbVariant, `sku-${fallbackVariantId}`);
      const sizeSkuMap = buildSizeSkuMap(dbVariant);

      const rawSizes = dbVariant
        ? dbVariant.skus.filter((s) => s.inStock).map((s) => s.sizeCode)
        : ['XS', 'S', 'M', 'L', 'XL'];
      const inStockSizes = sortSizesCanonically(
        rawSizes.length > 0 ? rawSizes : ['XS', 'S', 'M', 'L', 'XL'],
      );

      const studioCutoutUrl = pickVerifiedVitrineUrl(
        mv.studioCutoutUrl,
        pickVerifiedVitrineUrl(
          fbVar.studioCutoutUrl,
          `${VITRINE_URL_PREFIX}variants/${desiredSlug}-default.webp`,
        ),
      );

      const macroSwatchUrl = pickVerifiedVitrineUrl(
        mv.macroSwatchUrl,
        pickVerifiedVitrineUrl(
          fbVar.macroSwatchUrl,
          `${VITRINE_URL_PREFIX}macros/silk-ivory.webp`,
        ),
      );

      const fabricSpecText =
        (mv.fabricSpecText && mv.fabricSpecText.trim()) ||
        fbVar.fabricSpecText ||
        dbProduct?.fabricComposition ||
        canonical?.materialHeadline ||
        'Lụa Tơ Tằm Tự Nhiên Atelier';

      return {
        variantId: fallbackVariantId,
        skuDefaultId,
        ...(Object.keys(sizeSkuMap).length > 0 ? { sizeSkuMap } : {}),
        colorKey,
        colorName,
        colorHex,
        inStockSizes,
        studioCutoutUrl,
        macroSwatchUrl,
        fabricSpecText,
        prebakedSceneUrl: mv.prebakedSceneUrl ?? fbVar.prebakedSceneUrl ?? null,
      };
    });

    const firstSku = dbProduct?.variants[0]?.skus[0];
    const basePriceVnd =
      dbProduct?.minPriceVnd ??
      firstSku?.salePriceVnd ??
      firstSku?.basePriceVnd ??
      1_850_000;

    const pinPosition = {
      xPercent:
        typeof manifestSlot?.pinPosition?.xPercent === 'number'
          ? manifestSlot.pinPosition.xPercent
          : fallbackSlot.pinPosition.xPercent,
      yPercent:
        typeof manifestSlot?.pinPosition?.yPercent === 'number'
          ? manifestSlot.pinPosition.yPercent
          : fallbackSlot.pinPosition.yPercent,
    };

    const maskBbox = {
      x:
        typeof manifestSlot?.maskBbox?.x === 'number'
          ? manifestSlot.maskBbox.x
          : fallbackSlot.maskBbox.x,
      y:
        typeof manifestSlot?.maskBbox?.y === 'number'
          ? manifestSlot.maskBbox.y
          : fallbackSlot.maskBbox.y,
      w:
        typeof manifestSlot?.maskBbox?.w === 'number'
          ? manifestSlot.maskBbox.w
          : fallbackSlot.maskBbox.w,
      h:
        typeof manifestSlot?.maskBbox?.h === 'number'
          ? manifestSlot.maskBbox.h
          : fallbackSlot.maskBbox.h,
    };

    const shortPinLabel =
      (manifestSlot?.shortPinLabel && manifestSlot.shortPinLabel.trim()) ||
      fallbackSlot.shortPinLabel;
    const defaultColorKey =
      (manifestSlot?.defaultColorKey && manifestSlot.defaultColorKey.trim()) ||
      fallbackSlot.defaultColorKey ||
      hydratedVariants[0]?.colorKey;

    wearableSlots.push({
      slotKey,
      productId: dbProduct?.id ?? `product-${desiredSlug}`,
      productSlug: dbProduct?.slug ?? desiredSlug,
      productName: dbProduct?.name ?? desiredSlug,
      shortPinLabel,
      defaultColorKey,
      basePriceVnd: Math.max(0, Math.round(basePriceVnd)),
      pinPosition,
      garmentRegionMask: pickVerifiedVitrineUrl(
        manifestSlot?.garmentRegionMask,
        fallbackSlot.garmentRegionMask,
      ),
      maskBbox,
      materialOpticalProfile: sanitizeOpticalProfile(
        manifestSlot?.materialOpticalProfile,
        fallbackSlot.materialOpticalProfile,
      ),
      variants: hydratedVariants,
    });
  }

  // Ensure heroProducts includes season-matched products (and falls back only for canonical seasons with no explicit DB links)
  for (const prod of seasonMatchedProducts) {
    if (heroProductsMap.size >= 4 && dbLinkedProducts.length === 0) break;
    heroProductsMap.set(prod.slug, prod);
  }
  if (canonical && dbLinkedProducts.length === 0) {
    for (const prod of cleanProducts) {
      if (heroProductsMap.size >= 3) break;
      heroProductsMap.set(prod.slug, prod);
    }
  }
  const heroProducts = Array.from(heroProductsMap.values()).slice(0, 6);

  const allSeasonSlugs = Array.from(
    new Set([
      ...dbLinkedProducts.map((p) => p.slug),
      ...dbProductSlugs,
      ...heroProducts.map((p) => p.slug),
      ...seasonMatchedProducts.map((p) => p.slug),
    ]),
  );
  const allSpuIds = Array.from(
    new Set([
      ...dbSpuIds,
      ...dbLinkedProducts.map((p) => p.id),
      ...seasonMatchedProducts.map((p) => p.id),
    ]),
  );

  const shortName =
    (row.short_name && row.short_name.trim()) ||
    (manifest?.shortName && manifest.shortName.trim()) ||
    canonical?.shortName ||
    row.title;
  const materialHeadline =
    (row.material_headline && row.material_headline.trim()) ||
    (manifest?.materialHeadline && manifest.materialHeadline.trim()) ||
    canonical?.materialHeadline ||
    row.subtitle;

  const rawHeroUrl =
    typeof row.hero_image_url === 'string' ? row.hero_image_url.trim() : '';
  const isLegacySeedSeasonUrl =
    rawHeroUrl.includes(`/seed/season-${row.slug}.webp`) ||
    rawHeroUrl.includes(`/seasons/season-${row.slug}.webp`);
  const canonicalVitrineBaseUrl = pickVerifiedVitrineUrl(
    manifest?.baseEditorialImageUrl,
    pickVerifiedVitrineUrl(
      canonical?.baseEditorialImageUrl,
      `${VITRINE_URL_PREFIX}lookbooks/${row.slug}-base.webp`,
    ),
  );
  // Always bind the interactive lookbook stage to the 1:1 Outfit-Bound portrait aligned with masks & pins
  const baseEditorialImageUrl =
    rawHeroUrl && !isLegacySeedSeasonUrl ? rawHeroUrl : canonicalVitrineBaseUrl;

  const restyleCacheMap: Record<string, string> = {};
  if (manifest?.restyleCacheMap && typeof manifest.restyleCacheMap === 'object') {
    for (const [k, v] of Object.entries(manifest.restyleCacheMap)) {
      if (typeof v === 'string' && v.trim()) {
        restyleCacheMap[k] = v.trim();
      }
    }
  }

  const outfitFormula =
    wearableSlots.length > 0
      ? resolveOutfitFormulaFromSlots(
          wearableSlots,
          manifest?.outfitFormula ?? canonical?.outfitFormula,
        )
      : undefined;
  const defaultMacroSlotKey =
    manifest?.defaultMacroSlotKey ??
    canonical?.defaultMacroSlotKey ??
    wearableSlots[0]?.slotKey;

  const interactiveLookbook: SeasonInteractiveLookbook | null =
    wearableSlots.length > 0
      ? {
          baseEditorialImageUrl,
          materialHeadline,
          shortName,
          totalDesigns: Math.max(allSeasonSlugs.length, wearableSlots.length),
          outfitFormula,
          defaultMacroSlotKey,
          wearableSlots,
          restyleCacheMap,
        }
      : null;

  const dbSwatches = normalizeSwatchesList(row.swatches_jsonb);
  const dbPalette = normalizeSwatchesList(row.palette_jsonb);
  let effectiveSwatches: SeasonSwatchEntry[] =
    dbSwatches.length > 0 ? dbSwatches : dbPalette;
  if (effectiveSwatches.length === 0) {
    const derivedMap = new Map<string, SeasonSwatchEntry>();
    for (const slot of wearableSlots) {
      for (const variant of slot.variants) {
        const key = variant.colorHex.toUpperCase();
        if (!derivedMap.has(key)) {
          derivedMap.set(key, {
            name: variant.colorName,
            hex: variant.colorHex,
            fabricNote: variant.fabricSpecText,
            colorKey: variant.colorKey,
            sheen: slot.materialOpticalProfile.sheen,
          });
        }
      }
    }
    effectiveSwatches =
      derivedMap.size > 0
        ? Array.from(derivedMap.values())
        : [
            {
              name: row.season_tag || row.title,
              hex: row.palette_hex || '#B08A4A',
              fabricNote: materialHeadline,
            },
          ];
  }

  const rawMeta = parseSeasonJson<Record<string, unknown>>(row.lookbook_meta_jsonb, {});
  const lookbookMeta: Record<string, unknown> =
    rawMeta && typeof rawMeta === 'object' && !Array.isArray(rawMeta) ? rawMeta : {};

  const isCurrent = Boolean(row.is_current);
  const sortOrder = Number(row.sort_order ?? 0);
  const coverUrl =
    rawHeroUrl && !isLegacySeedSeasonUrl ? rawHeroUrl : baseEditorialImageUrl;

  return {
    id: row.id,
    code: (row.code && row.code.trim()) || row.slug,
    slug: row.slug,
    months: row.months || canonical?.months || 'T1–T2',
    name: row.title || canonical?.name || row.slug,
    subtitle: row.subtitle || canonical?.note || '',
    shortName,
    materialHeadline,
    seasonTag: row.season_tag || shortName,
    paletteHex: row.palette_hex || effectiveSwatches[0]?.hex || '#B08A4A',
    note: row.subtitle || canonical?.note || '',
    coverAssetUrl: coverUrl,
    heroImageUrl: coverUrl,
    launchAt: null,
    endAt: null,
    isCurrent,
    isCurrentSeason: isCurrent,
    isNow: isCurrent,
    isActive: row.is_active !== false,
    sortOrder,
    seasonOrder: sortOrder,
    swatches: effectiveSwatches,
    paletteJsonb: effectiveSwatches,
    lookbookMeta,
    spuIds: allSpuIds,
    productSlugs: allSeasonSlugs,
    productCount: allSeasonSlugs.length,
    featuredProductSlugs: allSeasonSlugs.slice(0, 4),
    interactiveLookbook,
    heroProducts,
    ...(row.updated_at
      ? {
          updatedAt:
            row.updated_at instanceof Date
              ? row.updated_at.toISOString()
              : String(row.updated_at),
        }
      : {}),
  };
}
