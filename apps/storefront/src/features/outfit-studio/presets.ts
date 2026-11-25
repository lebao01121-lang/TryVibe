import { OutfitSlot, type ProductSpuDto } from '@atelier/contracts';
import {
  applyOutfitSlotSelection,
  inferProductOutfitSlot,
  resolveSelectionFromProduct,
  type OuterwearDrapeStyle,
  type OutfitSlotsMap,
} from './compositor';

export type OutfitPresetId = 'evening-burgundy' | 'modern-office' | 'morning-coffee';

export interface OutfitPresetItemSpec {
  slot: OutfitSlot;
  slug: string;
  drapeStyle?: OuterwearDrapeStyle;
  preferredColorKeywords?: readonly string[];
}

export interface OutfitPresetDefinition {
  id: OutfitPresetId;
  label: string;
  shortDescription: string;
  lightingMode: 'morning' | 'evening';
  items: readonly OutfitPresetItemSpec[];
}

export const OUTFIT_PRESETS: readonly OutfitPresetDefinition[] = [
  {
    id: 'evening-burgundy',
    label: 'Dạ Tiệc Đỏ Vang',
    shortDescription: 'Đầm lụa satin cổ đổ · Blazer khoác vai · Clutch Champagne',
    lightingMode: 'evening',
    items: [
      {
        slot: OutfitSlot.ONE_PIECE,
        slug: 'dam-du-tiec-lua-satin-co-do',
        preferredColorKeywords: ['đỏ', 'vang', 'rượu', 'burgundy', 'ruby'],
      },
      {
        slot: OutfitSlot.OUTERWEAR,
        slug: 'ao-blazer-linen-dang-suong',
        drapeStyle: 'shoulder',
        preferredColorKeywords: ['ngà', 'ivory', 'cát', 'kem'],
      },
      {
        slot: OutfitSlot.ACCESSORY,
        slug: 'vi-cam-tay-clutch-champagne',
        preferredColorKeywords: ['champagne', 'vàng', 'ngà'],
      },
    ],
  },
  {
    id: 'modern-office',
    label: 'Công Sở Thanh Lịch',
    shortDescription: 'Sơ mi lụa tơ tằm · Quần tây xếp ly · Blazer linen · Thắt lưng đồng',
    lightingMode: 'morning',
    items: [
      {
        slot: OutfitSlot.TOP,
        slug: 'ao-so-mi-lua-to-tam-tam-xuan',
        preferredColorKeywords: ['ngà', 'trắng', 'ivory', 'champagne'],
      },
      {
        slot: OutfitSlot.BOTTOM,
        slug: 'quan-tay-ong-suong-xep-ly-doi',
        preferredColorKeywords: ['cát', 'kem', 'sand', 'be'],
      },
      {
        slot: OutfitSlot.OUTERWEAR,
        slug: 'ao-blazer-linen-dang-suong',
        drapeStyle: 'front',
        preferredColorKeywords: ['cát', 'ngà', 'ivory', 'cacao'],
      },
      {
        slot: OutfitSlot.ACCESSORY,
        slug: 'that-lung-da-khoa-dong',
        preferredColorKeywords: ['cacao', 'nâu', 'đồng', 'espresso'],
      },
    ],
  },
  {
    id: 'morning-coffee',
    label: 'Cà Phê Sáng',
    shortDescription: 'Sơ mi lụa · Chân váy midi xếp ly · Cardigan Merino · Khăn lụa',
    lightingMode: 'morning',
    items: [
      {
        slot: OutfitSlot.TOP,
        slug: 'ao-so-mi-lua-to-tam-tam-xuan',
        preferredColorKeywords: ['ngà', 'champagne', 'trắng'],
      },
      {
        slot: OutfitSlot.BOTTOM,
        slug: 'chan-vay-xep-ly-midi-cap-cao',
        preferredColorKeywords: ['cát', 'be', 'nâu', 'kem'],
      },
      {
        slot: OutfitSlot.OUTERWEAR,
        slug: 'ao-cardigan-len-merino-khuy-sung',
        drapeStyle: 'shoulder',
        preferredColorKeywords: ['kem', 'ngà', 'yến mạch', 'cát'],
      },
      {
        slot: OutfitSlot.ACCESSORY,
        slug: 'khan-lua-hoa-tiet-tam-xuan',
        preferredColorKeywords: ['champagne', 'vàng', 'ngà', 'đỏ'],
      },
    ],
  },
] as const;

function pickPreferredVariantIndex(
  product: ProductSpuDto,
  keywords?: readonly string[],
): number {
  if (!keywords || keywords.length === 0 || product.variants.length <= 1) {
    return 0;
  }
  const idx = product.variants.findIndex((variant) => {
    const name = variant.colorName.toLowerCase();
    return keywords.some((kw) => name.includes(kw.toLowerCase()));
  });
  return idx >= 0 ? idx : 0;
}

/**
 * Resolves a curated preset into a ready-to-render OutfitSlotsMap from live catalog products,
 * matching exact slugs first and gracefully falling back to the first available piece in that slot.
 */
export function resolvePresetSlots(
  presetId: OutfitPresetId,
  products: readonly ProductSpuDto[],
  preferredSize?: string | null,
): OutfitSlotsMap {
  const preset = OUTFIT_PRESETS.find((p) => p.id === presetId) ?? OUTFIT_PRESETS[0];
  if (!preset || products.length === 0) {
    return {};
  }

  const bySlug = new Map<string, ProductSpuDto>();
  for (const product of products) {
    bySlug.set(product.slug.toLowerCase(), product);
  }

  const usedProductIds = new Set<string>();
  let resolvedSlots: OutfitSlotsMap = {};

  for (const spec of preset.items) {
    const exact = bySlug.get(spec.slug.toLowerCase());
    const candidate =
      (exact && !usedProductIds.has(exact.id) ? exact : undefined) ??
      products.find(
        (p) => !usedProductIds.has(p.id) && inferProductOutfitSlot(p) === spec.slot,
      );

    if (!candidate) {
      continue;
    }

    usedProductIds.add(candidate.id);
    const variantIndex = pickPreferredVariantIndex(candidate, spec.preferredColorKeywords);
    const selection = resolveSelectionFromProduct(candidate, {
      slot: spec.slot,
      variantIndex,
      preferredSize,
      drapeStyle: spec.drapeStyle,
    });
    resolvedSlots = applyOutfitSlotSelection(resolvedSlots, selection);
  }

  return resolvedSlots;
}

export interface HarmonyProductsResult {
  anchorLabel: string;
  anchorColor: string;
  anchorColorHex: string;
  items: ProductSpuDto[];
}

const HARMONY_TONE_KEYWORDS = [
  'ngà',
  'kem',
  'ivory',
  'champagne',
  'cát',
  'sand',
  'be',
  'espresso',
  'cacao',
  'nâu',
  'đồng',
  'vàng',
  'bơ',
  'trắng',
  'linen',
  'yến mạch',
  'gold',
];

function isQuietLuxuryNeutralHex(hex: string): boolean {
  const clean = hex.replace('#', '');
  if (clean.length !== 6) return false;
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return false;

  // Warm ivory / champagne / sand (high luminance, warm R >= G >= B)
  const isWarmLight = r >= 185 && g >= 165 && b >= 125 && r >= b - 8;
  // Deep espresso / cocoa / bronze (low luminance, warm R >= G >= B)
  const isWarmDark = r <= 110 && g <= 85 && b <= 70 && r >= b;
  return isWarmLight || isWarmDark;
}

function productHasHarmonyTone(product: ProductSpuDto): boolean {
  return product.variants.some((variant) => {
    const colorLower = variant.colorName.toLowerCase();
    if (HARMONY_TONE_KEYWORDS.some((kw) => colorLower.includes(kw))) {
      return true;
    }
    return isQuietLuxuryNeutralHex(variant.colorHex);
  });
}

function compactAnchorLabel(productName: string): string {
  const words = productName.trim().split(/\s+/);
  if (words.length <= 4) return productName.trim();
  return words.slice(0, 4).join(' ');
}

/**
 * Computes stylist-recommended harmony pieces prioritizing complementary
 * OUTERWEAR & ACCESSORY items in Ivory / Champagne / Sand / Espresso tones
 * not yet placed on the mannequin.
 */
export function computeHarmonyProducts(
  products: readonly ProductSpuDto[],
  currentSlots: OutfitSlotsMap,
): HarmonyProductsResult {
  const anchor =
    currentSlots[OutfitSlot.ONE_PIECE] ??
    currentSlots[OutfitSlot.TOP] ??
    currentSlots[OutfitSlot.BOTTOM] ??
    currentSlots[OutfitSlot.OUTERWEAR] ??
    currentSlots[OutfitSlot.ACCESSORY] ??
    null;

  const anchorLabel = anchor ? compactAnchorLabel(anchor.productName) : 'Đầm Lụa TryVibe';
  const anchorColor = anchor ? anchor.colorName : 'Đỏ Rượu Vang';
  const anchorColorHex = anchor ? anchor.colorHex : '#6F1D2B';

  const activeProductIds = new Set(
    Object.values(currentSlots)
      .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
      .map((entry) => entry.productId),
  );

  const hasOnePiece = Boolean(currentSlots[OutfitSlot.ONE_PIECE]);
  const hasTop = Boolean(currentSlots[OutfitSlot.TOP]);
  const hasBottom = Boolean(currentSlots[OutfitSlot.BOTTOM]);
  const hasOuterwear = Boolean(currentSlots[OutfitSlot.OUTERWEAR]);
  const hasAccessory = Boolean(currentSlots[OutfitSlot.ACCESSORY]);

  const scored = products
    .filter((product) => !activeProductIds.has(product.id))
    .map((product, index) => {
      const slot = inferProductOutfitSlot(product);
      let score = 0;

      // Strongly prioritize complementary OUTERWEAR & ACCESSORY pieces
      if (slot === OutfitSlot.OUTERWEAR) {
        score += hasOuterwear ? 34 : 62;
      } else if (slot === OutfitSlot.ACCESSORY) {
        score += hasAccessory ? 32 : 60;
      } else if (slot === OutfitSlot.BOTTOM && hasTop && !hasBottom) {
        score += 48;
      } else if (slot === OutfitSlot.TOP && hasBottom && !hasTop) {
        score += 48;
      } else if (hasOnePiece && (slot === OutfitSlot.TOP || slot === OutfitSlot.BOTTOM)) {
        // Demote pieces that would mutually exclude the active one-piece anchor
        score -= 20;
      } else {
        score += 12;
      }

      // Boost Ivory / Champagne / Sand / Espresso palette harmony
      if (productHasHarmonyTone(product)) {
        score += 24;
      }

      return { product, score, index };
    })
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.index - b.index;
    });

  return {
    anchorLabel,
    anchorColor,
    anchorColorHex,
    items: scored.map((entry) => entry.product),
  };
}
