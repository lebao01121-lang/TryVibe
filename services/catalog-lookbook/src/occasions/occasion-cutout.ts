/**
 * Curated occasion lookbook product slugs that ship dedicated pure-alpha
 * 1080x1440 frameless editorial cutouts under:
 *   - `apps/storefront/public/occasion-cutouts/<slug>-cutout-3x4.webp`
 *   - `infra/seeds/real-assets-cache/processed/occasion-cutouts/<slug>-cutout-3x4.webp`
 *   - MinIO `atelier-public/seed/occasion-cutout-<slug>.webp`
 */
export const OCCASION_CUTOUT_SLUGS = [
  'dam-du-tiec-lua-satin-co-do',
  'ao-kieu-lua-organza-phoi-no',
  'dam-midi-co-vuong-chiet-eo',
  'ao-khoac-tweed-det-thu-cong',
  'ao-blazer-linen-dang-suong',
  'ao-so-mi-lua-to-tam-tam-xuan',
  'quan-tay-ong-suong-xep-ly-doi',
  'chan-vay-xep-ly-midi-cap-cao',
  'ao-cardigan-len-merino-khuy-sung',
  'quan-culottes-linen-huu-co',
  'ao-polo-det-kim-bong-ai-cap',
  'dam-midi-linen-phoi-dai',
  'ao-khoac-trench-gabardine-co-dien',
] as const;

export type OccasionCutoutSlug = (typeof OCCASION_CUTOUT_SLUGS)[number];

const OCCASION_CUTOUT_SLUG_SET: ReadonlySet<string> = new Set(
  OCCASION_CUTOUT_SLUGS,
);

export function resolveOccasionCutoutUrl(slug: string): string | null {
  const normalized = slug.trim();
  if (!normalized) {
    return null;
  }
  if (!OCCASION_CUTOUT_SLUG_SET.has(normalized)) {
    return null;
  }
  return `/occasion-cutouts/${normalized}-cutout-3x4.webp`;
}
