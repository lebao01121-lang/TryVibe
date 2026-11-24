export const OCCASION_MACRO_KEYS = [
  'silk-pearl-cuff',
  'pleated-silk',
  'cashmere-knit',
  'organic-linen',
  'artisan-tweed',
  'silk-satin-champagne',
  'silk-satin-crimson',
] as const;

export type OccasionMacroKey = (typeof OCCASION_MACRO_KEYS)[number];

/**
 * Deterministic fabric macro detail mapping for every curated Atelier product.
 * Mirrors static WebP files under `apps/storefront/public/occasion-macro/<key>.webp`
 * and MinIO `seed/occasion-macro-<key>.webp`.
 */
export const OCCASION_MACRO_BY_PRODUCT_SLUG: Readonly<
  Record<string, OccasionMacroKey>
> = {
  // Silk shirts (pearl-button ivory Bảo Lộc silk cuff macro)
  'ao-so-mi-lua-to-tam-tam-xuan': 'silk-pearl-cuff',
  'ao-so-mi-lua-to-tam-bao-loc': 'silk-pearl-cuff',

  // Pleated silk & bias-cut skirts
  'chan-vay-xep-ly-midi-cap-cao': 'pleated-silk',
  'chan-vay-lua-vat-cheo': 'pleated-silk',

  // Cashmere, Merino & knitwear
  'ao-cardigan-len-merino-khuy-sung': 'cashmere-knit',
  'ao-len-cashmere-co-lo': 'cashmere-knit',
  'ao-polo-det-kim-bong-ai-cap': 'cashmere-knit',

  // Organic linen blazers, culottes, resort dresses & cotton gabardine trenches
  'ao-blazer-linen-dang-suong': 'organic-linen',
  'quan-culottes-linen-huu-co': 'organic-linen',
  'dam-midi-linen-phoi-dai': 'organic-linen',
  'ao-khoac-trench-gabardine-co-dien': 'organic-linen',
  'trench-coat-kaki-co-dien': 'organic-linen',

  // Woven Donegal tweed & tailored wool
  'ao-khoac-tweed-det-thu-cong': 'artisan-tweed',
  'ao-khoac-tweed-nut-dong': 'artisan-tweed',
  'quan-tay-ong-suong-xep-ly-doi': 'artisan-tweed',
  'quan-ong-suong-wool-blend': 'artisan-tweed',

  // Luminous silk satin & organza (evening, bridal, resort)
  'dam-du-tiec-lua-satin-co-do': 'silk-satin-crimson',
  'ao-kieu-lua-organza-phoi-no': 'silk-satin-champagne',
  'dam-midi-co-vuong-chiet-eo': 'silk-satin-champagne',
  'ao-dai-cach-tan-gam-lua': 'silk-satin-champagne',
};

export function resolveOccasionMacroKey(
  slug: string,
  fabricComposition?: string | null,
): OccasionMacroKey {
  const exact = OCCASION_MACRO_BY_PRODUCT_SLUG[slug];
  if (exact) {
    return exact;
  }

  const haystack = `${slug} ${fabricComposition ?? ''}`.toLowerCase();
  if (haystack.includes('tweed') || haystack.includes('wool')) {
    return 'artisan-tweed';
  }
  if (
    haystack.includes('cashmere') ||
    haystack.includes('merino') ||
    haystack.includes('cardigan') ||
    haystack.includes('det-kim') ||
    haystack.includes('len')
  ) {
    return 'cashmere-knit';
  }
  if (haystack.includes('xep-ly') || haystack.includes('pleat')) {
    return 'pleated-silk';
  }
  if (
    haystack.includes('linen') ||
    haystack.includes('gabardine') ||
    haystack.includes('culottes') ||
    haystack.includes('kaki')
  ) {
    return 'organic-linen';
  }
  if (haystack.includes('so-mi') || haystack.includes('shirt')) {
    return 'silk-pearl-cuff';
  }
  if (haystack.includes('du-tiec') || haystack.includes('crimson')) {
    return 'silk-satin-crimson';
  }
  return 'silk-satin-champagne';
}

export function resolveOccasionMacroImageUrl(
  slug: string,
  fabricComposition?: string | null,
): string {
  const key = resolveOccasionMacroKey(slug, fabricComposition);
  return `/occasion-macro/${key}.webp`;
}
