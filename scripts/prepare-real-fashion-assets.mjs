#!/usr/bin/env node
/**
 * Real Fashion Photography Downloader & Neural Cutout Orchestrator.
 *
 * 1. Downloads verified high-resolution real fashion, atelier, seasonal,
 *    and packaging photography into `infra/seeds/real-assets-cache/raw/`
 *    (idempotent with retry & byte-size/MIME validation).
 * 2. Invokes `services/ai-tryon/.venv/Scripts/python.exe scripts/remove_bg_cutout.py --batch ...`
 *    to generate true neural alpha-matted WebP cutouts (with Edge Color Padding
 *    and hanger alignment at y = 151px / hangerAnchorY = 0.14) and editorial WebPs
 *    into `infra/seeds/real-assets-cache/processed/`.
 * 3. Copies the 1920x1080 hero editorial poster to BOTH:
 *      - `infra/seeds/real-assets-cache/processed/campaign/atelier-hero-poster.webp`
 *      - `apps/storefront/public/media/atelier-hero-poster.webp`
 * 4. Writes `infra/seeds/real-assets-cache/processed/manifest.json` indexed by
 *    exact catalog slugs, seasons, campaign steps, and packaging codes.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

const CACHE_ROOT = path.join(REPO_ROOT, 'infra', 'seeds', 'real-assets-cache');
const RAW_DIR = path.join(CACHE_ROOT, 'raw');
const PROCESSED_DIR = path.join(CACHE_ROOT, 'processed');
const STOREFRONT_MEDIA_DIR = path.join(REPO_ROOT, 'apps', 'storefront', 'public', 'media');
const STOREFRONT_MACRO_DIR = path.join(REPO_ROOT, 'apps', 'storefront', 'public', 'occasion-macro');
const STOREFRONT_PACKAGING_DIR = path.join(REPO_ROOT, 'apps', 'storefront', 'public', 'packaging');

async function loadSharp() {
  const candidates = [
    pathToFileURL(
      path.join(REPO_ROOT, 'services', 'catalog-lookbook', 'node_modules', 'sharp', 'lib', 'index.js'),
    ).href,
    'sharp',
  ];
  for (const modPath of candidates) {
    try {
      const mod = await import(modPath);
      return mod.default ?? mod;
    } catch {
      // try next candidate
    }
  }
  throw new Error('Could not load sharp for editorial lookbook & macro processing.');
}

const px = (id, width = 1400) =>
  `https://images.pexels.com/photos/${id}/pexels-photo-${id}.jpeg?auto=compress&cs=tinysrgb&w=${width}`;
const un = (photoId, width = 1400) =>
  `https://images.unsplash.com/photo-${photoId}?auto=format&fit=crop&w=${width}&q=88`;

// Curated & visually verified high-res real photography catalog
const ASSET_SPEC = {
  hero: {
    id: 'atelier-hero-poster',
    rawName: 'hero-atelier-couture.jpg',
    url: px(41067766, 2000), // Warm golden haute couture atelier with dress mannequins & draped gowns (ZERO roses)
    width: 1920,
    height: 1080,
    biasX: 0.5,
    biasY: 0.48,
    quality: 90,
  },

  atelierSteps: [
    {
      key: 'step1',
      id: 'atelier-step-1-fabric',
      rawName: 'atelier-step1-silk-folds.jpg',
      url: px(4938328, 1400), // Lustrous champagne-gold silk satin folds close-up
      width: 960,
      height: 1200,
      biasX: 0.5,
      biasY: 0.5,
    },
    {
      key: 'step2',
      id: 'atelier-step-2-pattern',
      rawName: 'atelier-step2-pattern-cutting.jpg',
      url: px(8527250, 1400), // Atelier dressmakers drafting & cutting bespoke paper pattern on tailor table
      width: 960,
      height: 1200,
      biasX: 0.55,
      biasY: 0.45,
    },
    {
      key: 'step3',
      id: 'atelier-step-3-tailoring',
      rawName: 'atelier-step3-hand-stitching.jpg',
      url: px(33078826, 1400), // Master tailor meticulously hand-crafting garment in couture workshop
      width: 960,
      height: 1200,
      biasX: 0.52,
      biasY: 0.42,
    },
    {
      key: 'step4',
      id: 'atelier-step-4-packaging',
      rawName: 'atelier-step4-luxury-boxes.jpg',
      url: px(7309442, 1400), // Sunlit minimalist ivory/kraft atelier gift boxes on natural linen
      width: 960,
      height: 1200,
      biasX: 0.5,
      biasY: 0.55,
    },
  ],

  seasons: [
    {
      slug: 'xuan-tam-xuan',
      rawName: 'season-xuan-tam-xuan.jpg',
      url: px(8497561, 1400), // Warm golden-hour spring editorial blazer & tailored trousers
      biasY: 0.25,
    },
    {
      slug: 'ha-pho-co',
      rawName: 'season-ha-pho-co.jpg',
      url: px(29613991, 1400), // Heritage Hoi An mossy ochre wall with flowing crimson silk Ao Dai
      biasY: 0.28,
    },
    {
      slug: 'thu-hoang-hon',
      rawName: 'season-thu-hoang-hon.jpg',
      url: un('1618333453525-81f8582b1a3d', 1400), // Warm autumn sunset camel overcoat editorial
      biasY: 0.25,
    },
    {
      slug: 'dong-cashmere',
      rawName: 'season-dong-cashmere.jpg',
      url: px(10955939, 1400), // Winter snow atmospheric tailored dark wool overcoat editorial
      biasY: 0.22,
    },
    {
      slug: 'resort-ban-mai',
      rawName: 'season-resort-ban-mai.jpg',
      url: px(37017989, 1400), // Morning ivory resort linen silhouettes by coastal limestone cliffs
      biasY: 0.28,
    },
    {
      slug: 'atelier-di-san',
      rawName: 'season-atelier-di-san.jpg',
      url: px(29435486, 1400), // Fine-art heritage silk Ao Dai couture portrait
      biasY: 0.22,
    },
  ],

  packaging: [
    {
      code: 'tui-vai-linen-moc',
      rawName: 'pkg-linen-drawstring-dustbag.jpg',
      url: px(3850539, 1400), // Natural raw cotton-linen drawstring dustbag on clean light marble
      crop: [0.12, 0.04, 0.94, 0.96],
      biasX: 0.52,
      biasY: 0.52,
      warmth: {
        brightness: 1.02,
        saturation: 0.92,
        overlayHex: '#F2E9D8',
        overlayAlpha: 0.12,
      },
    },
    {
      code: 'hop-lua-co-dien',
      rawName: 'pkg-ivory-silk-box.jpg',
      url: px(7309442, 1400), // Sunlit minimalist ivory atelier rigid gift box on white linen
      crop: [0.14, 0.33, 0.86, 0.71],
      biasX: 0.48,
      biasY: 0.52,
      warmth: {
        brightness: 1.06,
        saturation: 0.86,
        overlayHex: '#FBF7EF',
        overlayAlpha: 0.14,
      },
    },
    {
      code: 'hop-qua-khac-ten-gold',
      rawName: 'pkg-obsidian-gold-ribbon-box.jpg',
      url: px(5872362, 1400), // Luxury matte black/espresso rigid gift box with champagne-gold silk ribbon bow
      crop: [0.06, 0.22, 0.58, 0.96],
      biasX: 0.5,
      biasY: 0.56,
      warmth: {
        brightness: 0.96,
        saturation: 0.82,
        recomb: [
          [1.05, 0.02, 0.0],
          [0.01, 1.0, 0.0],
          [0.0, 0.0, 0.84],
        ],
      },
    },
  ],

  // Crisp 512x544 Macro Fabric Detail textures for #occasion MacroFabricInset
  occasionMacros: [
    {
      key: 'silk-pearl-cuff',
      rawName: 'macro-silk-pearl-cuff.jpg',
      url: px(40436865, 1400), // Lustrous silk satin cuff fold with 3 diagonal covered pearl buttons
      crop: [0.06, 0.0, 0.94, 0.62],
      biasX: 0.52,
      biasY: 0.34,
      warmth: {
        brightness: 1.03,
        saturation: 0.92,
        recomb: [
          [1.045, 0.015, 0.0],
          [0.01, 1.005, 0.0],
          [0.0, 0.0, 0.91],
        ],
        overlayHex: '#EFE6D5',
        overlayAlpha: 0.14,
      },
    },
    {
      key: 'pleated-silk',
      rawName: 'atelier-step1-silk-folds.jpg',
      url: px(4938328, 1400), // Warm champagne-bronze pleated crepe-silk folds
      crop: [0.04, 0.08, 0.96, 0.94],
      biasX: 0.5,
      biasY: 0.55,
      warmth: {
        brightness: 1.04,
        saturation: 0.94,
        overlayHex: '#EFE6D5',
        overlayAlpha: 0.08,
      },
    },
    {
      key: 'cashmere-knit',
      rawName: 'macro-cashmere-knit.jpg',
      url: px(7232403, 1400), // Soft oatmeal/beige merino & cashmere knitted wool texture
      crop: [0.05, 0.08, 0.95, 0.92],
      biasX: 0.5,
      biasY: 0.5,
      warmth: {
        brightness: 1.01,
        saturation: 0.98,
        overlayHex: '#EFE6D5',
        overlayAlpha: 0.06,
      },
    },
    {
      key: 'organic-linen',
      rawName: 'macro-organic-linen.jpg',
      url: px(30618181, 1400), // Natural undyed warm beige woven organic linen folds
      crop: [0.04, 0.06, 0.96, 0.94],
      biasX: 0.5,
      biasY: 0.5,
      warmth: {
        brightness: 1.03,
        saturation: 0.96,
        overlayHex: '#EFE6D5',
        overlayAlpha: 0.06,
      },
    },
    {
      key: 'artisan-tweed',
      rawName: 'prod-11-artisan-tweed-jacket-woven.jpg',
      url: 'https://upload.wikimedia.org/wikipedia/commons/9/9c/Donegal_tweed_norfolk_jacket.jpg', // High-res authentic woven Donegal tweed texture & horn button detail
      crop: [0.22, 0.24, 0.72, 0.68],
      biasX: 0.5,
      biasY: 0.5,
      warmth: {
        brightness: 1.05,
        saturation: 0.92,
        recomb: [
          [1.04, 0.01, 0.0],
          [0.01, 1.01, 0.0],
          [0.0, 0.0, 0.92],
        ],
        overlayHex: '#EFE6D5',
        overlayAlpha: 0.12,
      },
    },
    {
      key: 'silk-satin-champagne',
      rawName: 'macro-silk-satin-champagne.jpg',
      url: px(7232398, 1400), // Luminous warm champagne silk satin drape folds
      crop: [0.10, 0.02, 0.90, 0.98],
      biasX: 0.5,
      biasY: 0.5,
      warmth: {
        brightness: 1.02,
        saturation: 0.96,
        overlayHex: '#EFE6D5',
        overlayAlpha: 0.06,
      },
    },
    {
      key: 'silk-satin-crimson',
      rawName: 'macro-silk-satin-champagne.jpg',
      url: px(7232398, 1400), // Deep burgundy-ruby couture silk satin drape
      crop: [0.10, 0.02, 0.90, 0.98],
      biasX: 0.5,
      biasY: 0.5,
      warmth: {
        tintHex: '#8A1922',
        brightness: 0.54,
        saturation: 1.42,
        linear: [1.18, -14],
      },
    },
  ],

  // All 20 catalog products matching exact slugs & color variants from catalog-seed.ts
  products: [
    {
      slug: 'ao-blazer-linen-dang-suong',
      slot: 'OUTERWEAR',
      rawName: 'prod-01-linen-blazer-ghost.jpg',
      url: 'https://upload.wikimedia.org/wikipedia/commons/4/40/Navy_Blazer_%2851011161195%29.jpg', // Full-length unclipped studio tailored blazer (lapels, sleeves, pockets, rounded hem)
      cutoutMode: 'isnet',
      cutoutCrop: [0.22, 0.195, 0.78, 0.96],
      lookbookCrop: [0.15, 0.10, 0.85, 0.99],
      baseTintHex: '#D8C9B4',
      baseTintStrength: 0.92,
      lookbookBiasY: 0.45,
      lookbookEditorial: {
        rawName: 'lookbook-01-linen-blazer.jpg',
        url: px(31971098, 1400), // Quiet-luxury editorial woman in sand-beige tailored blazer & ivory linen trousers by sheer curtains
        biasX: 0.5,
        biasY: 0.18,
        warmth: {
          brightness: 1.02,
          saturation: 0.96,
          overlayHex: '#EFE6D5',
          overlayAlpha: 0.06,
        },
      },
      variants: [
        { index: 0, colorName: 'Cát Ngà', colorHex: '#D8C9B4' },
        { index: 1, colorName: 'Cacao Đậm', colorHex: '#3A2A22' },
      ],
    },
    {
      slug: 'ao-so-mi-lua-to-tam-tam-xuan',
      slot: 'TOP',
      rawName: 'prod-02-silk-shirt-ghost.jpg',
      url: 'https://framemark.vam.ac.uk/collections/2021MU5598/full/!1600,1600/0/default.jpg', // Straight 0° symmetrical studio ivory silk button-down shirt (zero limbs/straps)
      cutoutMode: 'isnet',
      cutoutCrop: [0.01, 0.08, 0.99, 0.94],
      baseTintHex: '#EFE7DA',
      baseTintStrength: 0.35,
      lookbookBiasY: 0.22,
      lookbookEditorial: {
        rawName: 'lookbook-02-silk-shirt-sunlit.jpg',
        url: px(5664544, 1400), // Warm morning sunlight editorial portrait: champagne-ivory silk blouse & cream tailored trousers on sunlit rattan terrace chair
        crop: [0.02, 0.0, 0.98, 0.96],
        biasX: 0.5,
        biasY: 0.18,
        warmth: {
          brightness: 1.01,
          saturation: 0.98,
          recomb: [
            [1.025, 0.008, 0.0],
            [0.005, 1.005, 0.0],
            [0.0, 0.0, 0.955],
          ],
          overlayHex: '#EFE6D5',
          overlayAlpha: 0.08,
        },
      },
      variants: [
        { index: 0, colorName: 'Trắng Ngà', colorHex: '#EFE7DA' },
        { index: 1, colorName: 'Champagne Ấm', colorHex: '#DFCAA6' },
      ],
    },
    {
      slug: 'dam-du-tiec-lua-satin-co-do',
      slot: 'ONE_PIECE',
      rawName: 'prod-03-crimson-satin-gown-ghost.jpg',
      url: 'https://framemark.vam.ac.uk/collections/2017KC2455/full/!1600,1600/0/default.jpg', // Straight 0° symmetrical sculpted bias-draped silk evening gown on invisible mannequin (zero hand notch, zero shoe tip)
      cutoutMode: 'cloth:full',
      cutoutCrop: [0.10, 0.10, 0.90, 0.92],
      baseTintHex: '#781822',
      baseTintStrength: 0.94,
      lookbookBiasY: 0.18,
      lookbookEditorial: {
        rawName: 'lookbook-03-crimson-satin-gown.jpg',
        url: px(35288353, 1400), // Haute couture editorial portrait: lustrous crimson silk satin dress against warm bronze-espresso studio backdrop
        biasX: 0.5,
        biasY: 0.2,
        warmth: {
          brightness: 0.98,
          saturation: 0.96,
          recomb: [
            [1.01, 0.0, 0.0],
            [0.0, 0.98, 0.0],
            [0.0, 0.0, 0.95],
          ],
        },
      },
      variants: [
        { index: 0, colorName: 'Đỏ Rượu Vang', colorHex: '#6E262B' },
        { index: 1, colorName: 'Đen Huyền', colorHex: '#201B19' },
      ],
    },
    {
      slug: 'quan-tay-ong-suong-xep-ly-doi',
      slot: 'BOTTOM',
      rawName: 'prod-04-charcoal-pleated-trousers-ghost.jpg',
      url: 'https://framemark.vam.ac.uk/collections/2018LC2216/full/!1600,1600/0/default.jpg', // Straight 0° symmetrical charcoal double-pleated wide-leg tailored trousers flat studio (zero hands/feet)
      cutoutMode: 'isnet',
      cutoutCrop: [0.04, 0.02, 0.96, 0.98],
      baseTintHex: '#3B3D40',
      baseTintStrength: 0.30,
      lookbookBiasY: 0.35,
      erodePx: 1,
      lookbookEditorial: {
        rawName: 'lookbook-04-tailored-trousers.jpg',
        url: px(7959844, 1400), // Modern tailoring office editorial: tailored charcoal trousers & blazer in sunlit cream studio
        crop: [0.06, 0.14, 0.88, 0.98],
        biasX: 0.44,
        biasY: 0.3,
        warmth: {
          brightness: 1.02,
          saturation: 0.95,
          overlayHex: '#EFE6D5',
          overlayAlpha: 0.07,
        },
      },
      variants: [
        { index: 0, colorName: 'Xám Than', colorHex: '#3B3D40' },
        { index: 1, colorName: 'Be Đá', colorHex: '#C9BEA9' },
      ],
    },
    {
      slug: 'chan-vay-xep-ly-midi-cap-cao',
      slot: 'BOTTOM',
      rawName: 'prod-05-cream-pleated-midi-skirt-ghost.jpg',
      url: 'https://upload.wikimedia.org/wikipedia/commons/7/78/Brown_Wool_Doll_Skirt_and_White_Silk_Doll_Blouse_-_DPLA_-_77afeb3a07dd36ec7f362577b87fa1ad_%28page_2%29.jpg', // Straight 0° symmetrical knife-pleated A-line midi skirt flat studio
      cutoutMode: 'isnet',
      cutoutCrop: [0.08, 0.06, 0.92, 0.94],
      baseTintHex: '#EAE0CE',
      baseTintStrength: 0.94,
      lookbookBiasY: 0.45,
      lookbookEditorial: {
        rawName: 'lookbook-05-pleated-midi-skirt.jpg',
        url: px(5393765, 1400), // Sunlit atelier editorial: flowing cream pleated midi skirt & warm beige ribbed knit in linen studio
        crop: [0.04, 0.04, 0.96, 1.0],
        biasX: 0.52,
        biasY: 0.46,
        warmth: {
          brightness: 1.02,
          saturation: 0.95,
          recomb: [
            [1.03, 0.01, 0.0],
            [0.005, 1.005, 0.0],
            [0.0, 0.0, 0.94],
          ],
          overlayHex: '#EFE6D5',
          overlayAlpha: 0.11,
        },
      },
      variants: [
        { index: 0, colorName: 'Kem Sữa', colorHex: '#EDE3D1' },
        { index: 1, colorName: 'Xanh Khói', colorHex: '#617172' },
      ],
    },
    {
      slug: 'ao-khoac-trench-gabardine-co-dien',
      slot: 'OUTERWEAR',
      rawName: 'prod-06-khaki-trench-coat-ghost.jpg',
      url: 'https://framemark.vam.ac.uk/collections/2012FK3654/full/!1600,1600/0/default.jpg', // Straight 0° symmetrical double-breasted trench coat on studio form
      cutoutMode: 'cloth:attire',
      cutoutCrop: [0.12, 0.08, 0.88, 0.96],
      baseTintHex: '#BDA686',
      baseTintStrength: 0.72,
      lookbookBiasY: 0.32,
      lookbookEditorial: {
        rawName: 'prod-06-khaki-trench-coat.jpg',
        url: px(14790509, 1400), // Preserved original editorial lookbook
        biasX: 0.5,
        biasY: 0.32,
      },
      variants: [
        { index: 0, colorName: 'Kaki Cổ Điển', colorHex: '#BDA686' },
        { index: 1, colorName: 'Ô Liu Trầm', colorHex: '#59604D' },
      ],
    },
    {
      slug: 'ao-kieu-lua-organza-phoi-no',
      slot: 'TOP',
      rawName: 'prod-07-organza-satin-blouse-ghost.jpg',
      url: 'https://framemark.vam.ac.uk/collections/2012FN2696/full/!1600,1600/0/default.jpg', // Straight 0° symmetrical silk tie-neck studio blouse
      cutoutMode: 'isnet',
      cutoutCrop: [0.05, 0.215, 0.95, 0.745],
      baseTintHex: '#DFC5BE',
      baseTintStrength: 0.90,
      lookbookBiasY: 0.26,
      lookbookEditorial: {
        rawName: 'lookbook-07-organza-blouse.jpg',
        url: px(5276137, 1400), // Fine-art atelier editorial: woman in draped ivory silk-organza wrap blouse against warm sand plaster wall
        crop: [0.04, 0.06, 0.96, 0.94],
        biasX: 0.5,
        biasY: 0.26,
        warmth: {
          brightness: 1.03,
          saturation: 0.96,
          overlayHex: '#EFE6D5',
          overlayAlpha: 0.07,
        },
      },
      variants: [
        { index: 0, colorName: 'Hồng Phấn Đất', colorHex: '#DFC5BE' },
      ],
    },
    {
      slug: 'dam-midi-co-vuong-chiet-eo',
      slot: 'ONE_PIECE',
      rawName: 'prod-08-ivory-midi-dress-ghost.jpg',
      url: 'https://framemark.vam.ac.uk/collections/2018LA1412/full/!1600,1600/0/default.jpg', // Straight 0° symmetrical sleeveless cinched-waist midi dress on invisible mannequin
      cutoutMode: 'cloth:full',
      cutoutCrop: [0.16, 0.16, 0.84, 0.92],
      baseTintHex: '#F3ECE0',
      baseTintStrength: 0.94,
      lookbookBiasY: 0.25,
      lookbookEditorial: {
        rawName: 'lookbook-08-ivory-midi-dress.jpg',
        url: px(39706907, 1400), // Golden-hour sunlit editorial: lustrous pearl-ivory cinched-waist satin midi dress
        crop: [0.0, 0.14, 0.88, 1.0],
        biasX: 0.38,
        biasY: 0.36,
        warmth: {
          brightness: 1.03,
          saturation: 0.95,
          overlayHex: '#EFE6D5',
          overlayAlpha: 0.08,
        },
      },
      variants: [
        { index: 0, colorName: 'Trắng Ngọc', colorHex: '#F3ECE0' },
        { index: 1, colorName: 'Nâu Espresso', colorHex: '#46332A' },
      ],
    },
    {
      slug: 'ao-cardigan-len-merino-khuy-sung',
      slot: 'OUTERWEAR',
      rawName: 'prod-09-merino-cardigan-ghost.jpg',
      url: 'https://framemark.vam.ac.uk/collections/2013GV4418/full/!1600,1600/0/default.jpg', // Straight 0° symmetrical V-neck button-front merino knit cardigan flat studio
      cutoutMode: 'isnet',
      cutoutCrop: [0.04, 0.04, 0.96, 0.96],
      baseTintHex: '#DFD4C2',
      baseTintStrength: 0.90,
      lookbookBiasY: 0.26,
      lookbookEditorial: {
        rawName: 'lookbook-09-merino-cardigan.jpg',
        url: px(12811533, 1400), // Warm cream studio portrait: ribbed merino knit cardigan with lustrous buttons
        crop: [0.02, 0.02, 0.98, 0.98],
        biasX: 0.5,
        biasY: 0.26,
        warmth: {
          brightness: 1.01,
          saturation: 0.94,
          recomb: [
            [1.035, 0.012, 0.0],
            [0.008, 1.005, 0.0],
            [0.0, 0.0, 0.925],
          ],
          overlayHex: '#EFE6D5',
          overlayAlpha: 0.12,
        },
      },
      variants: [
        { index: 0, colorName: 'Yến Mạch', colorHex: '#DFD4C2' },
      ],
    },
    {
      slug: 'quan-culottes-linen-huu-co',
      slot: 'BOTTOM',
      rawName: 'prod-10-linen-culottes-ghost.jpg',
      url: 'https://framemark.vam.ac.uk/collections/2018LB9226/full/!1600,1600/0/default.jpg', // Straight 0° symmetrical sand-beige wide linen trousers flat studio (zero limbs/shoes)
      cutoutMode: 'isnet',
      cutoutCrop: [0.10, 0.02, 0.90, 0.98],
      baseTintHex: '#D7C7B2',
      baseTintStrength: 0.35,
      lookbookBiasY: 0.35,
      lookbookEditorial: {
        rawName: 'lookbook-10-linen-culottes.jpg',
        url: px(18173600, 1400), // Monochromatic warm sand studio editorial: wide-leg beige linen trousers & ivory linen tailoring
        crop: [0.02, 0.0, 0.98, 0.98],
        biasX: 0.5,
        biasY: 0.25,
        warmth: {
          brightness: 1.05,
          saturation: 0.93,
          overlayHex: '#EFE6D5',
          overlayAlpha: 0.14,
        },
      },
      variants: [
        { index: 0, colorName: 'Cát Biển', colorHex: '#D7C7B2' },
      ],
    },
    {
      slug: 'ao-khoac-tweed-det-thu-cong',
      slot: 'OUTERWEAR',
      rawName: 'prod-11-artisan-tweed-jacket-woven.jpg',
      url: 'https://upload.wikimedia.org/wikipedia/commons/9/9c/Donegal_tweed_norfolk_jacket.jpg', // Clean front-facing symmetrical woven Donegal tweed jacket (cutout preserved)
      cutoutMode: 'isnet',
      cutoutCrop: [0.0, 0.036, 1.0, 0.96],
      lookbookCrop: [0.0, 0.036, 1.0, 0.96],
      baseTintHex: '#DCC8A6',
      baseTintStrength: 0.72,
      lookbookBiasY: 0.45,
      lookbookEditorial: {
        rawName: 'lookbook-11-artisan-tweed.jpg',
        url: px(35021432, 1400), // Luxury Parisian tweed jacket editorial against carved stone architecture & oak atelier doors
        crop: [0.04, 0.04, 0.96, 0.88],
        biasX: 0.5,
        biasY: 0.2,
        warmth: {
          brightness: 1.02,
          saturation: 0.95,
          overlayHex: '#EFE6D5',
          overlayAlpha: 0.06,
        },
      },
      variants: [
        { index: 0, colorName: 'Ngà Ánh Đồng', colorHex: '#E6DCC8' },
        { index: 1, colorName: 'Cacao Đêm', colorHex: '#2C211C' },
      ],
    },
    {
      slug: 'ao-polo-det-kim-bong-ai-cap',
      slot: 'TOP',
      rawName: 'prod-12-navy-knit-polo.jpg',
      url: px(38010898, 1400), // Deep navy Egyptian cotton knit polo shirt
      cutoutMode: 'cloth:upper',
      cutoutCrop: [0.12, 0.28, 0.88, 0.84],
      lookbookBiasY: 0.24,
      lookbookEditorial: {
        rawName: 'prod-12-navy-knit-polo.jpg',
        url: px(38010898, 1400), // Warm-lifted editorial framing of navy Egyptian cotton knit polo & ivory trousers
        biasX: 0.5,
        biasY: 0.22,
        warmth: {
          brightness: 1.05,
          saturation: 0.95,
          overlayHex: '#EFE6D5',
          overlayAlpha: 0.07,
        },
      },
      variants: [
        { index: 0, colorName: 'Xanh Navy Trầm', colorHex: '#24303C' },
      ],
    },
    {
      slug: 'ao-so-mi-lua-to-tam-bao-loc',
      slot: 'TOP',
      rawName: 'prod-13-bao-loc-silk-shirt.jpg',
      url: px(22441295, 1400), // Pure ivory-milk silk/linen shirt hanging on wooden hanger in studio
      cutoutMode: 'isnet',
      cutoutCrop: [0.16, 0.29, 0.84, 0.80],
      lookbookBiasY: 0.35,
      variants: [
        { index: 0, colorName: 'Ngà Sữa', colorHex: '#F5EFE4' },
        { index: 1, colorName: 'Hồng Cánh Sen', colorHex: '#E6D0CC' },
      ],
    },
    {
      slug: 'ao-dai-cach-tan-gam-lua',
      slot: 'ONE_PIECE',
      rawName: 'prod-14-silk-brocade-ao-dai-ghost.jpg',
      url: 'https://upload.wikimedia.org/wikipedia/commons/1/1c/Trang_ph%E1%BB%A5c_Kinh.jpg', // Straight 0° museum silk brocade Vietnamese Ao Dai on upright mannequin (zero crossed arms)
      cutoutMode: 'cloth:attire',
      cutoutCrop: [0.12, 0.42, 0.50, 0.99],
      baseTintHex: '#E5CFA3',
      baseTintStrength: 0.48,
      lookbookBiasY: 0.18,
      lookbookEditorial: {
        rawName: 'prod-14-silk-brocade-ao-dai.jpg',
        url: px(15662546, 1400), // Preserved original editorial lookbook
        biasX: 0.5,
        biasY: 0.18,
      },
      variants: [
        { index: 0, colorName: 'Vàng Champagne', colorHex: '#E5CFA3' },
        { index: 1, colorName: 'Đỏ Son Trầm', colorHex: '#822F32' },
      ],
    },
    {
      slug: 'trench-coat-kaki-co-dien',
      slot: 'OUTERWEAR',
      rawName: 'prod-15-sand-trench-coat-ghost.jpg',
      url: 'https://framemark.vam.ac.uk/collections/2012FK3654/full/!1600,1600/0/default.jpg', // Straight 0° symmetrical camel-sand double-breasted trench coat on studio form
      cutoutMode: 'cloth:attire',
      cutoutCrop: [0.12, 0.08, 0.88, 0.96],
      baseTintHex: '#C7B293',
      baseTintStrength: 0.78,
      lookbookBiasY: 0.32,
      lookbookEditorial: {
        rawName: 'prod-15-sand-trench-coat.jpg',
        url: px(13973198, 1400), // Preserved original editorial lookbook
        biasX: 0.5,
        biasY: 0.32,
      },
      variants: [
        { index: 0, colorName: 'Kaki Cát', colorHex: '#C7B293' },
      ],
    },
    {
      slug: 'chan-vay-lua-vat-cheo',
      slot: 'BOTTOM',
      rawName: 'prod-16-champagne-silk-skirt-ghost.jpg',
      url: 'https://framemark.vam.ac.uk/collections/2020MN5029/full/!1600,1600/0/default.jpg', // Straight 0° symmetrical champagne-ivory silk midi skirt studio flat
      cutoutMode: 'isnet',
      cutoutCrop: [0.14, 0.02, 0.86, 0.98],
      baseTintHex: '#E9DBBE',
      baseTintStrength: 0.45,
      lookbookBiasY: 0.50,
      lookbookEditorial: {
        rawName: 'prod-16-champagne-silk-skirt.jpg',
        url: px(6046219, 1400), // Preserved original editorial lookbook
        biasX: 0.5,
        biasY: 0.5,
      },
      variants: [
        { index: 0, colorName: 'Sâm Panh Ngà', colorHex: '#E9DBBE' },
        { index: 1, colorName: 'Nâu Cacao', colorHex: '#3D2B22' },
      ],
    },
    {
      slug: 'dam-midi-linen-phoi-dai',
      slot: 'ONE_PIECE',
      rawName: 'prod-17-belted-linen-midi-dress-ghost.jpg',
      url: 'https://upload.wikimedia.org/wikipedia/commons/a/ad/Jurk_%28ST655_1_01%29_-_Kostuum_-_Japon_-_MoMu_Antwerp.jpg', // Straight 0° symmetrical MoMu Antwerp belted midi dress on ghost mannequin (zero hair/limbs)
      cutoutMode: 'cloth:full',
      cutoutCrop: [0.12, 0.14, 0.88, 0.86],
      baseTintHex: '#DDD1BD',
      baseTintStrength: 0.93,
      lookbookBiasY: 0.28,
      lookbookEditorial: {
        rawName: 'lookbook-17-linen-midi-dress.jpg',
        url: px(13816069, 1400), // Studio editorial: sand-beige cinched-waist linen midi dress
        crop: [0.06, 0.0, 0.94, 0.92],
        biasX: 0.5,
        biasY: 0.08,
        warmth: {
          brightness: 1.02,
          saturation: 0.95,
          recomb: [
            [1.04, 0.015, 0.0],
            [0.01, 1.005, 0.0],
            [0.0, 0.0, 0.91],
          ],
          overlayHex: '#EFE6D5',
          overlayAlpha: 0.14,
        },
      },
      variants: [
        { index: 0, colorName: 'Lanh Tự Nhiên', colorHex: '#DDD1BD' },
      ],
    },
    {
      slug: 'ao-khoac-tweed-nut-dong',
      slot: 'OUTERWEAR',
      rawName: 'prod-18-brass-button-tweed-ghost.jpg',
      url: 'https://framemark.vam.ac.uk/collections/2009CD4248/full/!1600,1600/0/default.jpg', // Straight 0° symmetrical woven tweed tailored jacket on invisible mannequin
      cutoutMode: 'cloth:upper',
      cutoutCrop: [0.14, 0.14, 0.86, 0.57],
      baseTintHex: '#ECE3D3',
      baseTintStrength: 0.86,
      lookbookBiasY: 0.36,
      lookbookEditorial: {
        rawName: 'prod-18-brass-button-tweed.jpg',
        url: px(18999070, 1400), // Preserved original editorial lookbook
        biasX: 0.5,
        biasY: 0.36,
      },
      variants: [
        { index: 0, colorName: 'Kem Dệt Vàng', colorHex: '#ECE3D3' },
      ],
    },
    {
      slug: 'quan-ong-suong-wool-blend',
      slot: 'BOTTOM',
      rawName: 'prod-19-smoky-wool-trousers-ghost.jpg',
      url: 'https://framemark.vam.ac.uk/collections/2020MR1561/full/!1600,1600/0/default.jpg', // Straight 0° symmetrical wide-leg wool-blend trousers flat studio
      cutoutMode: 'isnet',
      cutoutCrop: [0.06, 0.02, 0.94, 0.98],
      baseTintHex: '#52463E',
      baseTintStrength: 0.85,
      lookbookBiasY: 0.36,
      lookbookEditorial: {
        rawName: 'prod-19-smoky-wool-trousers.jpg',
        url: px(5393448, 1400), // Preserved original editorial lookbook
        biasX: 0.5,
        biasY: 0.36,
      },
      variants: [
        { index: 0, colorName: 'Nâu Khói', colorHex: '#52463E' },
      ],
    },
    {
      slug: 'ao-len-cashmere-co-lo',
      slot: 'TOP',
      rawName: 'prod-20-cashmere-turtleneck-ghost.jpg',
      url: 'https://upload.wikimedia.org/wikipedia/commons/e/ea/Jersei-coll-alt.jpg', // Full-frame unclipped studio ghost-mannequin ribbed knit turtleneck sweater
      cutoutMode: 'isnet',
      cutoutCrop: [0.02, 0.02, 0.98, 0.99],
      baseTintHex: '#EFE6D8',
      baseTintStrength: 0.86,
      lookbookBiasY: 0.48,
      variants: [
        { index: 0, colorName: 'Kem Cashmere', colorHex: '#EFE6D8' },
        { index: 1, colorName: 'Cacao Đậm', colorHex: '#2E221B' },
      ],
    },
    {
      slug: 'vi-cam-tay-clutch-champagne',
      slot: 'ACCESSORY',
      rawName: 'prod-21-champagne-clutch.jpg',
      url: px(28387111, 1400), // Beaded champagne-gold evening minaudiere clutch with jeweled clasp
      cutoutMode: 'isnet',
      cutoutCrop: [0.14, 0.30, 0.86, 0.805],
      lookbookCrop: [0.05, 0.12, 0.95, 0.94],
      baseTintHex: '#DFCAA6',
      baseTintStrength: 0.22,
      lookbookBiasY: 0.52,
      erodePx: 1,
      variants: [
        { index: 0, colorName: 'Champagne Ánh Kim', colorHex: '#DFCAA6' },
        { index: 1, colorName: 'Nâu Espresso', colorHex: '#2A1E17' },
      ],
    },
    {
      slug: 'khan-lua-hoa-tiet-tam-xuan',
      slot: 'ACCESSORY',
      rawName: 'prod-22-silk-floral-scarf.jpg',
      url: px(36455711, 1400), // Knotted printed silk scarf isolated cleanly by isnet
      cutoutMode: 'isnet',
      cutoutCrop: [0.01, 0.30, 0.90, 0.79],
      lookbookCrop: [0.0, 0.22, 0.96, 0.86],
      baseTintHex: '#EFE5D2',
      baseTintStrength: 0.32,
      lookbookBiasY: 0.5,
      erodePx: 1,
      variants: [
        { index: 0, colorName: 'Kem Hoa Mai', colorHex: '#EFE5D2' },
        { index: 1, colorName: 'Đỏ Son Trầm', colorHex: '#843133' },
      ],
    },
    {
      slug: 'that-lung-da-khoa-dong',
      slot: 'ACCESSORY',
      rawName: 'prod-23-leather-brass-belt.jpg',
      url: 'https://upload.wikimedia.org/wikipedia/commons/7/79/Riem_%28ST657_5_01%29_-_Kostuum_Accessoire_-_Ceintuur_-_MoMu_Antwerp.jpg', // Clean white-studio handcrafted woven leather belt
      cutoutMode: 'isnet',
      cutoutCrop: [0.10, 0.08, 0.85, 0.92],
      lookbookCrop: [0.04, 0.02, 0.96, 0.98],
      baseTintHex: '#3B281E',
      baseTintStrength: 0.68,
      lookbookBiasY: 0.5,
      erodePx: 1,
      variants: [
        { index: 0, colorName: 'Cacao Cổ Điển', colorHex: '#3B281E' },
        { index: 1, colorName: 'Be Cát', colorHex: '#C9B596' },
      ],
    },
  ],
};

function findPythonExecutable() {
  const candidates = [
    path.join(REPO_ROOT, 'services', 'ai-tryon', '.venv', 'Scripts', 'python.exe'),
    path.join(REPO_ROOT, 'services', 'ai-tryon', '.venv', 'bin', 'python'),
    process.env.PYTHON_BIN,
    'python',
  ].filter(Boolean);

  for (const cand of candidates) {
    if (cand === 'python' || fs.existsSync(cand)) {
      return cand;
    }
  }
  throw new Error('Could not find Python executable with rembg installed.');
}

async function downloadWithRetry(url, destPath, label, maxAttempts = 3) {
  if (fs.existsSync(destPath) && fs.statSync(destPath).size >= 25_000) {
    return { cached: true, size: fs.statSync(destPath).size };
  }

  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  let lastErr = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'MaisonAtelierAssetPipeline/1.0 (+https://localhost)',
          Accept: 'image/jpeg,image/webp,image/png,*/*',
        },
        signal: AbortSignal.timeout(20_000),
      });
      const contentType = res.headers.get('content-type') || '';
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} (${label})`);
      }
      if (!contentType.startsWith('image/')) {
        throw new Error(`Invalid MIME ${contentType} (${label})`);
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 25_000) {
        throw new Error(`Image too small: ${buf.length} bytes (${label})`);
      }
      fs.writeFileSync(destPath, buf);
      return { cached: false, size: buf.length };
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, 800 * attempt));
      }
    }
  }
  throw new Error(`Failed downloading ${label} from ${url}: ${lastErr?.message || lastErr}`);
}

function parseHexColor(hex) {
  const clean = hex.replace('#', '').trim();
  return {
    r: Number.parseInt(clean.slice(0, 2), 16),
    g: Number.parseInt(clean.slice(2, 4), 16),
    b: Number.parseInt(clean.slice(4, 6), 16),
  };
}

async function renderHarmonizedEditorialWebp(sharp, opts) {
  const {
    inputPath,
    outputPaths,
    width,
    height,
    crop = null,
    biasX = 0.5,
    biasY = 0.25,
    warmth = null,
    quality = 90,
  } = opts;

  const orientedBuf = await sharp(inputPath).rotate().toBuffer();
  const meta = await sharp(orientedBuf).metadata();
  const srcW = meta.width;
  const srcH = meta.height;

  let baseX = 0;
  let baseY = 0;
  let baseW = srcW;
  let baseH = srcH;
  if (crop && crop.length === 4) {
    baseX = Math.max(0, Math.min(srcW - 2, Math.round(crop[0] * srcW)));
    baseY = Math.max(0, Math.min(srcH - 2, Math.round(crop[1] * srcH)));
    const x1 = Math.max(baseX + 2, Math.min(srcW, Math.round(crop[2] * srcW)));
    const y1 = Math.max(baseY + 2, Math.min(srcH, Math.round(crop[3] * srcH)));
    baseW = x1 - baseX;
    baseH = y1 - baseY;
  }

  // Exact focal-biased aspect-fill crop
  const targetRatio = width / height;
  const curRatio = baseW / baseH;
  let extX = baseX;
  let extY = baseY;
  let extW = baseW;
  let extH = baseH;
  if (curRatio > targetRatio) {
    extW = Math.max(2, Math.round(baseH * targetRatio));
    const maxShift = Math.max(0, baseW - extW);
    extX = baseX + Math.round(maxShift * biasX);
  } else {
    extH = Math.max(2, Math.round(baseW / targetRatio));
    const maxShift = Math.max(0, baseH - extH);
    extY = baseY + Math.round(maxShift * biasY);
  }

  let pipeline = sharp(orientedBuf)
    .extract({ left: extX, top: extY, width: extW, height: extH })
    .resize(width, height, { kernel: 'lanczos3' });

  if (warmth) {
    if (warmth.tintHex) {
      pipeline = pipeline.tint(parseHexColor(warmth.tintHex));
    }
    if (warmth.recomb) {
      pipeline = pipeline.recomb(warmth.recomb);
    }
    if (warmth.brightness || warmth.saturation) {
      pipeline = pipeline.modulate({
        brightness: warmth.brightness ?? 1.0,
        saturation: warmth.saturation ?? 1.0,
      });
    }
    if (warmth.linear) {
      pipeline = pipeline.linear(warmth.linear[0], warmth.linear[1]);
    }
    if (warmth.overlayHex && warmth.overlayAlpha) {
      const rgb = parseHexColor(warmth.overlayHex);
      const washBuf = await sharp({
        create: {
          width,
          height,
          channels: 4,
          background: { r: rgb.r, g: rgb.g, b: rgb.b, alpha: warmth.overlayAlpha },
        },
      })
        .png()
        .toBuffer();
      pipeline = pipeline.composite([{ input: washBuf, blend: 'over' }]);
    }
  }

  const outBuf = await pipeline
    .sharpen({ sigma: 0.55 })
    .webp({ quality, effort: 5 })
    .toBuffer();

  for (const outPath of outputPaths) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, outBuf);
  }
  return outBuf.length;
}

function toPosixRel(fromDir, absPath) {
  return path.relative(fromDir, absPath).replace(/\\/g, '/');
}

async function main() {
  fs.mkdirSync(RAW_DIR, { recursive: true });
  fs.mkdirSync(PROCESSED_DIR, { recursive: true });
  fs.mkdirSync(STOREFRONT_MEDIA_DIR, { recursive: true });
  fs.mkdirSync(STOREFRONT_MACRO_DIR, { recursive: true });
  fs.mkdirSync(STOREFRONT_PACKAGING_DIR, { recursive: true });

  const sharp = await loadSharp();

  // Build deduplicated download list
  const downloads = new Map();
  const register = (rawName, url, label) => {
    const dest = path.join(RAW_DIR, rawName);
    if (!downloads.has(rawName)) {
      downloads.set(rawName, { rawName, url, dest, label });
    }
    return dest;
  };

  const heroRaw = register(ASSET_SPEC.hero.rawName, ASSET_SPEC.hero.url, 'hero');
  const stepRaws = ASSET_SPEC.atelierSteps.map((s) => ({
    ...s,
    rawPath: register(s.rawName, s.url, `atelier:${s.key}`),
  }));
  const seasonRaws = ASSET_SPEC.seasons.map((s) => ({
    ...s,
    rawPath: register(s.rawName, s.url, `season:${s.slug}`),
  }));
  const pkgRaws = ASSET_SPEC.packaging.map((p) => ({
    ...p,
    rawPath: register(p.rawName, p.url, `packaging:${p.code}`),
  }));
  const macroRaws = ASSET_SPEC.occasionMacros.map((m) => ({
    ...m,
    rawPath: register(m.rawName, m.url, `macro:${m.key}`),
  }));
  const prodRaws = ASSET_SPEC.products.map((p) => ({
    ...p,
    rawPath: register(p.rawName, p.url, `product:${p.slug}`),
    lookbookRawPath: p.lookbookEditorial
      ? register(
          p.lookbookEditorial.rawName,
          p.lookbookEditorial.url,
          `lookbook:${p.slug}`,
        )
      : null,
  }));

  console.log(`[prepare] Verifying & downloading ${downloads.size} high-res real photos...`);
  const items = Array.from(downloads.values());
  let downloaded = 0;
  let cached = 0;
  const concurrency = 8;
  let cursor = 0;

  async function worker() {
    while (cursor < items.length) {
      const item = items[cursor++];
      const res = await downloadWithRetry(item.url, item.dest, item.label);
      if (res.cached) cached++;
      else downloaded++;
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  console.log(`[prepare] Raw photos ready: ${downloaded} downloaded, ${cached} cached (${items.length} total).`);

  // Prepare batch jobs for Python neural cutout & editorial pipeline
  const campaignDir = path.join(PROCESSED_DIR, 'campaign');
  const seasonsDir = path.join(PROCESSED_DIR, 'seasons');
  const packagingDir = path.join(PROCESSED_DIR, 'packaging');
  const productsDir = path.join(PROCESSED_DIR, 'products');

  const heroOut = path.join(campaignDir, 'atelier-hero-poster.webp');

  const editorialJobs = [
    {
      kind: 'hero',
      id: ASSET_SPEC.hero.id,
      input: heroRaw,
      output: heroOut,
      width: ASSET_SPEC.hero.width,
      height: ASSET_SPEC.hero.height,
      biasX: ASSET_SPEC.hero.biasX,
      biasY: ASSET_SPEC.hero.biasY,
      quality: ASSET_SPEC.hero.quality,
    },
    ...stepRaws.map((s) => ({
      kind: 'atelier',
      id: s.key,
      input: s.rawPath,
      output: path.join(campaignDir, `${s.id}.webp`),
      width: s.width,
      height: s.height,
      biasX: s.biasX ?? 0.5,
      biasY: s.biasY ?? 0.45,
      quality: 88,
    })),
    ...seasonRaws.map((s) => ({
      kind: 'season',
      id: s.slug,
      input: s.rawPath,
      output: path.join(seasonsDir, `${s.slug}.webp`),
      width: 900,
      height: 1200,
      biasX: 0.5,
      biasY: s.biasY ?? 0.25,
      quality: 88,
    })),
  ];

  const packagingJobs = pkgRaws.map((p) => ({
    code: p.code,
    input: p.rawPath,
    outDir: packagingDir,
    crop: p.crop ?? null,
    tintHex: p.tintHex ?? null,
    tintStrength: p.tintStrength ?? 0,
  }));

  const productJobs = prodRaws.map((p) => ({
    slug: p.slug,
    input: p.rawPath,
    outDir: path.join(productsDir, p.slug),
    cutoutMode: p.cutoutMode,
    cutoutCrop: p.cutoutCrop ?? null,
    lookbookCrop: p.lookbookCrop ?? null,
    lookbookBiasY: p.lookbookBiasY ?? 0.25,
    baseTintHex: p.baseTintHex ?? null,
    baseTintStrength: p.baseTintStrength ?? 0,
    erodePx: p.erodePx ?? 1,
    variants: p.variants,
  }));

  const onlyArg = process.argv.find((a) => a.startsWith('--only='));
  const lookbookOnly = process.argv.includes('--lookbook-only');
  const onlySet = onlyArg
    ? new Set(
        onlyArg
          .slice('--only='.length)
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      )
    : null;

  const batchJobPath = path.join(CACHE_ROOT, 'batch-jobs.json');
  const reportPath = path.join(CACHE_ROOT, 'batch-report.json');

  const filteredEditorial = onlySet ? editorialJobs.filter((j) => onlySet.has(j.id)) : editorialJobs;
  const filteredPackaging = []; // 360x360 square studio packaging photos are rendered cleanly by Sharp below
  const filteredProducts = onlySet ? productJobs.filter((j) => onlySet.has(j.slug)) : productJobs;
  const partialReportPath = onlySet ? path.join(CACHE_ROOT, 'batch-report-partial.json') : reportPath;

  const hasPythonWork =
    !lookbookOnly &&
    (filteredEditorial.length > 0 ||
      filteredPackaging.length > 0 ||
      filteredProducts.length > 0);

  if (hasPythonWork) {
    fs.writeFileSync(
      batchJobPath,
      JSON.stringify(
        {
          editorial: filteredEditorial,
          packaging: filteredPackaging,
          products: filteredProducts,
          reportOutput: partialReportPath,
        },
        null,
        2,
      ) + '\n',
      'utf8',
    );

    const pythonExe = findPythonExecutable();
    const pyScript = path.join(REPO_ROOT, 'scripts', 'remove_bg_cutout.py');
    console.log(
      `[prepare] Running neural cutout pipeline: ${pythonExe}${onlySet ? ` (only=${Array.from(onlySet).join(',')})` : ''}`,
    );
    const run = spawnSync(pythonExe, [pyScript, '--batch', batchJobPath], {
      cwd: REPO_ROOT,
      stdio: 'inherit',
    });
    if (run.status !== 0) {
      throw new Error(`remove_bg_cutout.py failed with exit code ${run.status}`);
    }
  }

  // Merge partial report into full batch-report.json when --only is used
  let report;
  if (hasPythonWork && onlySet && fs.existsSync(reportPath)) {
    const prev = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    const next = JSON.parse(fs.readFileSync(partialReportPath, 'utf8'));
    const mergeBy = (arrPrev, arrNext, key) => {
      const m = new Map(arrPrev.map((x) => [x[key], x]));
      for (const item of arrNext) m.set(item[key], item);
      return Array.from(m.values());
    };
    report = {
      editorial: mergeBy(prev.editorial || [], next.editorial || [], 'id'),
      packaging: mergeBy(prev.packaging || [], next.packaging || [], 'code'),
      products: mergeBy(prev.products || [], next.products || [], 'slug'),
    };
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
  } else {
    report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  }

  // Render dedicated warm-harmonized 900x1200 editorial lookbook WebPs for ALL variants
  // (primary v0 + secondary v1..vN so NO stale off-mood v1 photo ever leaks while preserving clean RGBA cutouts!)
  const editorialTargets = prodRaws.filter(
    (p) => p.lookbookEditorial && (!onlySet || onlySet.has(p.slug)),
  );
  for (const prod of editorialTargets) {
    const ed = prod.lookbookEditorial;
    const outputPaths = [
      path.join(productsDir, prod.slug, `${prod.slug}-lookbook-3x4.webp`),
    ];
    for (const v of prod.variants || []) {
      const vIdx = Number(v.index ?? 0);
      if (vIdx > 0) {
        outputPaths.push(
          path.join(productsDir, prod.slug, `${prod.slug}-v${vIdx}-lookbook-3x4.webp`),
        );
      }
    }
    const bytes = await renderHarmonizedEditorialWebp(sharp, {
      inputPath: prod.lookbookRawPath,
      outputPaths,
      width: 900,
      height: 1200,
      crop: ed.crop ?? null,
      biasX: ed.biasX ?? 0.5,
      biasY: ed.biasY ?? 0.25,
      warmth: ed.warmth ?? null,
      quality: 90,
    });
    console.log(
      `[lookbook] ${prod.slug} -> 900x1200 (${bytes} bytes, ${outputPaths.length} variant file(s))`,
    );
  }

  // Render crisp 360x360 Signature Packaging studio WebPs to BOTH processed cache & storefront public/packaging/
  const packagingMap = {};
  for (const pkg of pkgRaws) {
    const cacheOut = path.join(packagingDir, `${pkg.code}.webp`);
    const publicOut = path.join(STOREFRONT_PACKAGING_DIR, `${pkg.code}.webp`);
    const bytes = await renderHarmonizedEditorialWebp(sharp, {
      inputPath: pkg.rawPath,
      outputPaths: [cacheOut, publicOut],
      width: 360,
      height: 360,
      crop: pkg.crop ?? null,
      biasX: pkg.biasX ?? 0.5,
      biasY: pkg.biasY ?? 0.5,
      warmth: pkg.warmth ?? null,
      quality: 90,
    });
    const rel = toPosixRel(PROCESSED_DIR, cacheOut);
    packagingMap[pkg.code] = {
      image: rel,
      front: rel,
      back: rel,
      width: 360,
      height: 360,
    };
    console.log(`[packaging] ${pkg.code} -> 360x360 (${bytes} bytes)`);
  }

  // Render crisp 512x544 Occasion Macro Fabric Detail WebPs to BOTH processed cache & storefront public mirror
  const occasionMacroDir = path.join(PROCESSED_DIR, 'occasion-macro');
  const occasionMacrosMap = {};
  for (const macro of macroRaws) {
    const cacheOut = path.join(occasionMacroDir, `${macro.key}.webp`);
    const publicOut = path.join(STOREFRONT_MACRO_DIR, `${macro.key}.webp`);
    const bytes = await renderHarmonizedEditorialWebp(sharp, {
      inputPath: macro.rawPath,
      outputPaths: [cacheOut, publicOut],
      width: 512,
      height: 544,
      crop: macro.crop ?? null,
      biasX: macro.biasX ?? 0.5,
      biasY: macro.biasY ?? 0.5,
      warmth: macro.warmth ?? null,
      quality: 90,
    });
    occasionMacrosMap[macro.key] = toPosixRel(PROCESSED_DIR, cacheOut);
    console.log(`[macro] ${macro.key} -> 512x544 (${bytes} bytes)`);
  }

  // Copy hero poster to storefront public/media/atelier-hero-poster.webp
  const storefrontHeroDest = path.join(STOREFRONT_MEDIA_DIR, 'atelier-hero-poster.webp');
  if (fs.existsSync(heroOut)) {
    fs.copyFileSync(heroOut, storefrontHeroDest);
    console.log(`[prepare] Copied hero poster to ${path.relative(REPO_ROOT, storefrontHeroDest)}`);
  }

  // Remove stale rose-desk.* if ever restored
  for (const stale of ['rose-desk.mp4', 'rose-desk.webm']) {
    const p = path.join(STOREFRONT_MEDIA_DIR, stale);
    if (fs.existsSync(p)) {
      fs.unlinkSync(p);
    }
  }

  // Build canonical manifest.json aligned with SeedAssetGenerator (services/catalog-lookbook/src/seed/asset-generator.ts)

  const atelierStepsMap = {};
  for (const s of stepRaws) {
    atelierStepsMap[s.key] = toPosixRel(PROCESSED_DIR, path.join(campaignDir, `${s.id}.webp`));
  }

  const seasonsMap = {};
  for (const s of seasonRaws) {
    seasonsMap[s.slug] = toPosixRel(PROCESSED_DIR, path.join(seasonsDir, `${s.slug}.webp`));
  }

  const productsMap = {};
  for (const prod of report.products) {
    const mappedVariants = prod.variants.map((v) => ({
      index: v.variantIndex,
      variantIndex: v.variantIndex,
      colorName: v.colorName,
      colorHex: v.colorHex,
      rackFront: toPosixRel(PROCESSED_DIR, v.rackFront),
      rackBack: toPosixRel(PROCESSED_DIR, v.rackBack),
      tryonFlat: toPosixRel(PROCESSED_DIR, v.tryonFlat),
      lookbookMain: toPosixRel(PROCESSED_DIR, v.lookbookMain),
      rackCoverage: v.rackMetrics.coverage,
      rackTopY: v.rackMetrics.topY,
      flatCoverage: v.flatMetrics.coverage,
    }));
    const v0 = mappedVariants[0];
    productsMap[prod.slug] = {
      slug: prod.slug,
      hangerAnchorX: prod.hangerAnchorX,
      hangerAnchorY: prod.hangerAnchorY,
      rackFront: v0.rackFront,
      rackBack: v0.rackBack,
      tryonFlat: v0.tryonFlat,
      lookbookMain: v0.lookbookMain,
      variants: mappedVariants,
    };
  }

  const heroRel = toPosixRel(PROCESSED_DIR, heroOut);
  const manifest = {
    version: '3.1.0-real-photography',
    generatedAt: new Date().toISOString(),
    hangerAnchorX: 0.5,
    hangerAnchorY: 0.14,
    heroPoster: heroRel,
    campaign: {
      heroPoster: heroRel,
      step1: atelierStepsMap.step1,
      step2: atelierStepsMap.step2,
      step3: atelierStepsMap.step3,
      step4: atelierStepsMap.step4,
      atelierSteps: atelierStepsMap,
    },
    seasons: seasonsMap,
    packaging: packagingMap,
    occasionMacros: occasionMacrosMap,
    products: productsMap,
  };

  const manifestPath = path.join(PROCESSED_DIR, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  console.log(`[prepare] Wrote manifest: ${path.relative(REPO_ROOT, manifestPath)}`);
}

main().catch((err) => {
  console.error('[prepare] ERROR:', err);
  process.exit(1);
});
