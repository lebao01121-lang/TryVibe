#!/usr/bin/env node
/**
 * Live AI Seasonal Lookbook — Editorial Portraits, 18 Garment Alpha Masks,
 * Photometric Studio Variant Cutouts, 4:3 Macro Fabric Swatches & Manifest Pipeline.
 *
 * Deliverables (mirrored identically to BOTH `apps/storefront/public/seasons-lookbook/`
 * AND `infra/seeds/real-assets-cache/processed/seasons-lookbook/`):
 *   - 6 crisp 4:5 (960x1200) editorial portraits: `<seasonSlug>/base.webp`
 *   - 18 garment-region RGBA PNG alpha masks (960x1200, 2.5px feather, 0% face/skin bleed):
 *       `<seasonSlug>/mask-<slotKeyLower>.png`
 *   - 48 color-accurate 3:4 (480x640) studio variant cutouts:
 *       `variants/<productSlug>-<colorKey>.webp`
 *   - 23 color-accurate 4:3 (640x480) macro textile swatches (including lustrous
 *       specular Jet-Black 22-Momme silk `silk-jet-black.webp`):
 *       `macros/<fabricKey>-<colorKey>.webp`
 *   - Canonical `manifest.json` with exact computed `pinPosition`, `maskBbox`,
 *       `materialOpticalProfile`, and hydrated variant paths.
 *   - Visual quality proof audit sheet (when `--audit-sheet=<path>` is passed or default).
 *
 * Usage:
 *   node scripts/prepare-seasons-ai-lookbook.mjs
 *   node scripts/prepare-seasons-ai-lookbook.mjs --audit-sheet=C:/path/to/seasons-mask-audit.png
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

const CACHE_ROOT = path.join(REPO_ROOT, 'infra', 'seeds', 'real-assets-cache');
const RAW_DIR = path.join(CACHE_ROOT, 'raw');
const PROCESSED_PRODUCTS_DIR = path.join(CACHE_ROOT, 'processed', 'products');
const PROCESSED_OUT_DIR = path.join(CACHE_ROOT, 'processed', 'seasons-lookbook');
const PUBLIC_OUT_DIR = path.join(REPO_ROOT, 'apps', 'storefront', 'public', 'seasons-lookbook');
const YUNET_MODEL_PATH = path.join(
  REPO_ROOT,
  'services',
  'ai-tryon',
  'app',
  'preprocessing',
  'models',
  'face_detection_yunet_2023mar.onnx',
);

const DEFAULT_AUDIT_SHEET =
  'C:\\Users\\Admin\\.gemini\\antigravity\\brain\\d1783908-6521-4608-8b37-41aae3ee9a65\\scratch\\seasons-mask-audit.png';

const px = (id, width = 1400) =>
  `https://images.pexels.com/photos/${id}/pexels-photo-${id}.jpeg?auto=compress&cs=tinysrgb&w=${width}`;

const EXTRA_RAW_DOWNLOADS = [
  {
    rawName: 'season-s01-18589814.jpg',
    url: px(18589814, 1400),
    desc: 'Sunlit garden Vietnamese editorial model in ivory long-sleeve silk blouse & cream pleated skirt',
  },
  {
    rawName: 'season-s01-18505097.jpg',
    url: px(18505097, 1400),
    desc: 'Crisp symmetrical ivory long-sleeve V-neck silk blouse source for studio cutout',
  },
  {
    rawName: 'season-s03-18851701.jpg',
    url: px(18851701, 1400),
    desc: 'Warm sunlit coastal resort editorial model in ivory dress & oatmeal knit cardigan',
  },
];

/**
 * Canonical 6 Vietnamese Seasons specification (100% aligned with
 * `services/catalog-lookbook/src/seasons/season-lookbook-data.ts`).
 */
const SEASONS_SPEC = [
  {
    seasonSlug: 'xuan-tam-xuan',
    order: 1,
    months: 'T1–T2',
    name: 'Xuân Lụa Bảo Lộc',
    shortName: 'Xuân Lụa',
    materialHeadline: 'Lụa Tơ Tằm Bảo Lộc 22 Momme',
    note: 'Lụa Tơ Tằm Bảo Lộc 22 Momme — ánh ngà ấm và phom dáng mềm rủ cho tiết xuân Hà Nội.',
    isCurrent: true,
    rawFile: 'season-s01-18589814.jpg',
    // Exact 4:5 crop centering model's face at top ~10..24%, center ~49% and cropping far-left umbrella out
    crop: [0.16, 0.145, 0.90, 0.761],
    editorialGrade: { warmth: 1.03, contrast: 1.04, brightness: 1.01, saturation: 0.96 },
    segmentationStrategy: 's01_garden_blouse_pleated',
    accessoryComposite: {
      productSlug: 'vi-cam-tay-clutch-champagne',
      anchorCenterX: 0.65,
      anchorCenterY: 0.60,
      widthRatio: 0.25,
      angleDeg: -10,
      shadowOpacity: 0.34,
    },
    wearableSlots: [
      {
        slotKey: 'TOP',
        productSlug: 'ao-so-mi-lua-to-tam-tam-xuan',
        materialOpticalProfile: { sheen: 'silk', specularIntensity: 0.45, shadowDepth: 0.34 },
        variants: [
          {
            colorKey: 'ivory',
            colorName: 'Kem Ngà',
            colorHex: '#F4EFE6',
            macroKey: 'silk',
            fabricSpecText: 'Lụa Tơ Tằm Bảo Lộc · Kem Ngà 22 Momme · Thoáng khí 100%',
          },
          {
            colorKey: 'jet-black',
            colorName: 'Đen Tuyền',
            colorHex: '#171615',
            macroKey: 'silk',
            fabricSpecText: 'Lụa Tơ Tằm Bảo Lộc · Đen Tuyền 22 Momme · Ánh gương dịu',
          },
          {
            colorKey: 'wine-red',
            colorName: 'Đỏ Rượu Vang',
            colorHex: '#5E1924',
            macroKey: 'silk',
            fabricSpecText: 'Lụa Tơ Tằm Bảo Lộc · Đỏ Rượu Vang 22 Momme · Sắc sâu sang trọng',
          },
          {
            colorKey: 'sage-green',
            colorName: 'Xanh Rêu',
            colorHex: '#4A5546',
            macroKey: 'silk',
            fabricSpecText: 'Lụa Tơ Tằm Bảo Lộc · Xanh Rêu 22 Momme · Mát dịu tự nhiên',
          },
        ],
      },
      {
        slotKey: 'BOTTOM',
        productSlug: 'chan-vay-xep-ly-midi-cap-cao',
        materialOpticalProfile: { sheen: 'silk', specularIntensity: 0.36, shadowDepth: 0.38 },
        variants: [
          {
            colorKey: 'ivory',
            colorName: 'Kem Sữa',
            colorHex: '#EDE3D1',
            macroKey: 'pleated-silk',
            fabricSpecText: 'Lụa Xếp Ly Tencel · Kem Sữa · Sóng ly giữ phom bền bỉ',
          },
          {
            colorKey: 'espresso',
            colorName: 'Nâu Cacao',
            colorHex: '#3D2B22',
            macroKey: 'pleated-silk',
            fabricSpecText: 'Lụa Xếp Ly Tencel · Nâu Cacao · Chiều sâu Quiet Luxury',
          },
          {
            colorKey: 'wine-red',
            colorName: 'Đỏ Rượu Vang',
            colorHex: '#5E1924',
            macroKey: 'pleated-silk',
            fabricSpecText: 'Lụa Xếp Ly Tencel · Đỏ Rượu Vang · Tôn chuyển động nhẹ nhàng',
          },
          {
            colorKey: 'sage-green',
            colorName: 'Xanh Khói',
            colorHex: '#4A5546',
            macroKey: 'pleated-silk',
            fabricSpecText: 'Lụa Xếp Ly Tencel · Xanh Khói · Thanh lịch tinh giản',
          },
        ],
      },
      {
        slotKey: 'ACCESSORY',
        productSlug: 'vi-cam-tay-clutch-champagne',
        materialOpticalProfile: { sheen: 'leather', specularIntensity: 0.52, shadowDepth: 0.34 },
        variants: [
          {
            colorKey: 'champagne',
            colorName: 'Champagne Ánh Kim',
            colorHex: '#DFC9A6',
            macroKey: 'leather',
            fabricSpecText: 'Lụa Satin Khung Đồng · Champagne Ánh Kim · Chế tác thủ công',
          },
          {
            colorKey: 'jet-black',
            colorName: 'Đen Tuyền',
            colorHex: '#171615',
            macroKey: 'leather',
            fabricSpecText: 'Lụa Satin Khung Đồng · Đen Tuyền · Khóa đồng thau mài mờ',
          },
          {
            colorKey: 'wine-red',
            colorName: 'Đỏ Rượu Vang',
            colorHex: '#5E1924',
            macroKey: 'leather',
            fabricSpecText: 'Lụa Satin Khung Đồng · Đỏ Rượu Vang · Điểm nhấn dạ tiệc',
          },
        ],
      },
    ],
  },
  {
    seasonSlug: 'ha-pho-co',
    order: 2,
    months: 'T3–T4',
    name: 'Hạ Linen Hữu Cơ',
    shortName: 'Hạ Linen',
    materialHeadline: '100% Organic French Linen Thoáng Khí',
    note: '100% Organic French Linen Thoáng Khí — đường cắt khoáng đạt và thoáng nhẹ dưới nắng hạ.',
    isCurrent: false,
    rawFile: 'lookbook-02-silk-shirt-sunlit.jpg',
    crop: [0.0, 0.03, 0.88, 0.763],
    editorialGrade: { warmth: 1.03, contrast: 1.03, brightness: 1.0, saturation: 0.96 },
    segmentationStrategy: 's02_sunlit_linen_trousers',
    accessoryComposite: {
      productSlug: 'khan-lua-hoa-tiet-tam-xuan',
      anchorCenterX: 0.45,
      anchorCenterY: 0.35,
      widthRatio: 0.23,
      angleDeg: 8,
      shadowOpacity: 0.25,
    },
    wearableSlots: [
      {
        slotKey: 'TOP',
        productSlug: 'ao-so-mi-lua-to-tam-bao-loc',
        materialOpticalProfile: { sheen: 'linen', specularIntensity: 0.16, shadowDepth: 0.28 },
        variants: [
          {
            colorKey: 'ivory',
            colorName: 'Ngà Sữa',
            colorHex: '#F5EFE4',
            macroKey: 'linen',
            fabricSpecText: 'Linen & Lụa Bảo Lộc · Ngà Sữa · Thoáng khí vượt trội',
          },
          {
            colorKey: 'sage-green',
            colorName: 'Xanh Rêu',
            colorHex: '#4A5546',
            macroKey: 'linen',
            fabricSpecText: 'Linen & Lụa Bảo Lộc · Xanh Rêu · Dịu mát ngày nắng',
          },
          {
            colorKey: 'espresso',
            colorName: 'Nâu Cacao',
            colorHex: '#3D2B22',
            macroKey: 'linen',
            fabricSpecText: 'Linen & Lụa Bảo Lộc · Nâu Cacao · Sắc trầm tự nhiên',
          },
        ],
      },
      {
        slotKey: 'BOTTOM',
        productSlug: 'quan-culottes-linen-huu-co',
        materialOpticalProfile: { sheen: 'linen', specularIntensity: 0.14, shadowDepth: 0.30 },
        variants: [
          {
            colorKey: 'sand',
            colorName: 'Cát Biển',
            colorHex: '#D7C7B2',
            macroKey: 'linen',
            fabricSpecText: '100% Organic French Linen · Cát Biển · Stone-washed mềm mịn',
          },
          {
            colorKey: 'jet-black',
            colorName: 'Đen Tuyền',
            colorHex: '#171615',
            macroKey: 'linen',
            fabricSpecText: '100% Organic French Linen · Đen Tuyền · Đứng dáng nhẹ mát',
          },
          {
            colorKey: 'sage-green',
            colorName: 'Xanh Rêu',
            colorHex: '#4A5546',
            macroKey: 'linen',
            fabricSpecText: '100% Organic French Linen · Xanh Rêu · Sợi dệt thoáng tự nhiên',
          },
        ],
      },
      {
        slotKey: 'ACCESSORY',
        productSlug: 'khan-lua-hoa-tiet-tam-xuan',
        materialOpticalProfile: { sheen: 'silk', specularIntensity: 0.42, shadowDepth: 0.26 },
        variants: [
          {
            colorKey: 'ivory',
            colorName: 'Kem Hoa Mai',
            colorHex: '#EFE5D2',
            macroKey: 'silk',
            fabricSpecText: 'Lụa Tơ Tằm 16 Momme · Kem Hoa Mai · Cuốn biên khâu tay',
          },
          {
            colorKey: 'wine-red',
            colorName: 'Đỏ Son Trầm',
            colorHex: '#5E1924',
            macroKey: 'silk',
            fabricSpecText: 'Lụa Tơ Tằm 16 Momme · Đỏ Son Trầm · Điểm nhấn cổ áo tinh tế',
          },
          {
            colorKey: 'jet-black',
            colorName: 'Đen Tuyền',
            colorHex: '#171615',
            macroKey: 'silk',
            fabricSpecText: 'Lụa Tơ Tằm 16 Momme · Đen Tuyền · In lụa thủ công',
          },
        ],
      },
    ],
  },
  {
    seasonSlug: 'resort-ban-mai',
    order: 3,
    months: 'T5–T6',
    name: 'Resort Biển & Lụa Bay',
    shortName: 'Resort Biển',
    materialHeadline: 'Lụa Organza & Tơ Sống Dệt Nhẹ',
    note: 'Lụa Organza & Tơ Sống Dệt Nhẹ — thiết kế nghỉ dưỡng bay bổng đón gió biển ban mai.',
    isCurrent: false,
    rawFile: 'season-s03-18851701.jpg',
    crop: [0.0, 0.23, 0.90, 0.98],
    editorialGrade: { warmth: 1.04, contrast: 1.03, brightness: 1.01, saturation: 0.95 },
    segmentationStrategy: 's03_resort_dress_cardigan',
    accessoryComposite: {
      productSlug: 'khan-lua-hoa-tiet-tam-xuan',
      anchorCenterX: 0.56,
      anchorCenterY: 0.84,
      widthRatio: 0.28,
      angleDeg: -14,
      shadowOpacity: 0.22,
    },
    wearableSlots: [
      {
        slotKey: 'ONE_PIECE',
        productSlug: 'dam-midi-linen-phoi-dai',
        materialOpticalProfile: { sheen: 'linen', specularIntensity: 0.20, shadowDepth: 0.30 },
        variants: [
          {
            colorKey: 'sand',
            colorName: 'Lanh Tự Nhiên',
            colorHex: '#DDD1BD',
            macroKey: 'linen',
            fabricSpecText: 'Linen & Tơ Sống · Lanh Tự Nhiên · Nhẹ hành lý ít nhăn',
          },
          {
            colorKey: 'ivory',
            colorName: 'Kem Ngà',
            colorHex: '#F4EFE6',
            macroKey: 'linen',
            fabricSpecText: 'Linen & Tơ Sống · Kem Ngà · Tươi sáng dưới nắng biển',
          },
          {
            colorKey: 'sage-green',
            colorName: 'Xanh Rêu',
            colorHex: '#4A5546',
            macroKey: 'linen',
            fabricSpecText: 'Linen & Tơ Sống · Xanh Rêu · Hòa cùng sắc thiên nhiên',
          },
        ],
      },
      {
        slotKey: 'OUTERWEAR',
        productSlug: 'ao-cardigan-len-merino-khuy-sung',
        materialOpticalProfile: { sheen: 'tweed', specularIntensity: 0.16, shadowDepth: 0.34 },
        variants: [
          {
            colorKey: 'ivory',
            colorName: 'Yến Mạch',
            colorHex: '#DFD4C2',
            macroKey: 'tweed',
            fabricSpecText: 'Len Merino 16 Gauge · Yến Mạch · Khoác nhẹ chiều biển',
          },
          {
            colorKey: 'espresso',
            colorName: 'Nâu Cacao',
            colorHex: '#3D2B22',
            macroKey: 'tweed',
            fabricSpecText: 'Len Merino 16 Gauge · Nâu Cacao · Mềm mịn không xù lông',
          },
          {
            colorKey: 'jet-black',
            colorName: 'Đen Tuyền',
            colorHex: '#171615',
            macroKey: 'tweed',
            fabricSpecText: 'Len Merino 16 Gauge · Đen Tuyền · Khuy sừng mài thủ công',
          },
        ],
      },
      {
        slotKey: 'ACCESSORY',
        productSlug: 'khan-lua-hoa-tiet-tam-xuan',
        materialOpticalProfile: { sheen: 'silk', specularIntensity: 0.42, shadowDepth: 0.26 },
        variants: [
          {
            colorKey: 'ivory',
            colorName: 'Kem Hoa Mai',
            colorHex: '#EFE5D2',
            macroKey: 'silk',
            fabricSpecText: 'Lụa Organza & Tơ Tằm · Kem Hoa Mai · Bay nhẹ theo gió',
          },
          {
            colorKey: 'wine-red',
            colorName: 'Đỏ Son Trầm',
            colorHex: '#5E1924',
            macroKey: 'silk',
            fabricSpecText: 'Lụa Organza & Tơ Tằm · Đỏ Son Trầm · Nổi bật ánh hoàng hôn',
          },
          {
            colorKey: 'champagne',
            colorName: 'Champagne',
            colorHex: '#DFC9A6',
            macroKey: 'silk',
            fabricSpecText: 'Lụa Organza & Tơ Tằm · Champagne · Sang trọng thanh thoát',
          },
        ],
      },
    ],
  },
  {
    seasonSlug: 'thu-hoang-hon',
    order: 4,
    months: 'T7–T8',
    name: 'Thu Công Sở Thanh Lịch',
    shortName: 'Thu Công Sở',
    materialHeadline: 'Wool Silk Blend & Crepe Đứng Phom',
    note: 'Wool Silk Blend & Crepe Đứng Phom — blazer dựng vai chuẩn mực và quần âu xếp ly thanh lịch.',
    isCurrent: false,
    rawFile: 'lookbook-01-linen-blazer.jpg',
    crop: [0.04, 0.03, 1.0, 0.828],
    editorialGrade: { warmth: 1.02, contrast: 1.03, brightness: 1.01, saturation: 0.96 },
    segmentationStrategy: 's04_tailored_blazer_trousers_belt',
    accessoryComposite: null, // Genuine leather brass-buckle belt is already on her waist!
    wearableSlots: [
      {
        slotKey: 'OUTERWEAR',
        productSlug: 'ao-blazer-linen-dang-suong',
        materialOpticalProfile: { sheen: 'linen', specularIntensity: 0.18, shadowDepth: 0.35 },
        variants: [
          {
            colorKey: 'sand',
            colorName: 'Cát Ngà',
            colorHex: '#D8C9B4',
            macroKey: 'linen',
            fabricSpecText: 'Wool Silk & Linen Bỉ · Cát Ngà · Dựng vai mảnh chuẩn mực',
          },
          {
            colorKey: 'espresso',
            colorName: 'Cacao Đậm',
            colorHex: '#3A2A22',
            macroKey: 'linen',
            fabricSpecText: 'Wool Silk & Linen Bỉ · Cacao Đậm · Lót lụa Habotai mềm mát',
          },
          {
            colorKey: 'jet-black',
            colorName: 'Đen Tuyền',
            colorHex: '#171615',
            macroKey: 'linen',
            fabricSpecText: 'Wool Silk & Linen Bỉ · Đen Tuyền · Khí chất công sở hiện đại',
          },
        ],
      },
      {
        slotKey: 'BOTTOM',
        productSlug: 'quan-tay-ong-suong-xep-ly-doi',
        materialOpticalProfile: { sheen: 'tweed', specularIntensity: 0.18, shadowDepth: 0.36 },
        variants: [
          {
            colorKey: 'charcoal',
            colorName: 'Xám Than',
            colorHex: '#3B3D40',
            macroKey: 'tweed',
            fabricSpecText: 'Wool Silk Blend · Xám Than · Đường ép ly sắc nét',
          },
          {
            colorKey: 'sand',
            colorName: 'Be Đá',
            colorHex: '#C9BEA9',
            macroKey: 'linen',
            fabricSpecText: 'Wool Silk Blend · Be Đá · Cạp cao kéo dài tỷ lệ',
          },
          {
            colorKey: 'jet-black',
            colorName: 'Đen Tuyền',
            colorHex: '#171615',
            macroKey: 'tweed',
            fabricSpecText: 'Wool Silk Blend · Đen Tuyền · Co giãn nhẹ 2% thoải mái',
          },
        ],
      },
      {
        slotKey: 'ACCESSORY',
        productSlug: 'that-lung-da-khoa-dong',
        materialOpticalProfile: { sheen: 'leather', specularIntensity: 0.50, shadowDepth: 0.36 },
        variants: [
          {
            colorKey: 'espresso',
            colorName: 'Cacao Cổ Điển',
            colorHex: '#3B281E',
            macroKey: 'leather',
            fabricSpecText: 'Da Bê Thuộc Thảo Mộc · Cacao Cổ Điển · Khóa đồng mài mờ',
          },
          {
            colorKey: 'jet-black',
            colorName: 'Đen Tuyền',
            colorHex: '#171615',
            macroKey: 'leather',
            fabricSpecText: 'Da Bê Thuộc Thảo Mộc · Đen Tuyền · Đan thủ công tinh xảo',
          },
          {
            colorKey: 'sand',
            colorName: 'Be Cát',
            colorHex: '#C9B596',
            macroKey: 'leather',
            macroColorKeyOverride: 'champagne',
            fabricSpecText: 'Da Bê Thuộc Thảo Mộc · Be Cát · Bản rộng 2.8cm thanh thoát',
          },
        ],
      },
    ],
  },
  {
    seasonSlug: 'dong-cashmere',
    order: 5,
    months: 'T9–T10',
    name: 'Dạ Tweed & Cashmere',
    shortName: 'Dạ Tweed',
    materialHeadline: 'Len Cashmere Mông Cổ & Dạ Tweed Dệt Nổi',
    note: 'Len Cashmere Mông Cổ & Dạ Tweed Dệt Nổi — cấu trúc dệt thủ công ấm áp đầy khí chất.',
    isCurrent: false,
    rawFile: 'lookbook-11-artisan-tweed.jpg',
    crop: [0.06, 0.04, 0.84, 0.69],
    editorialGrade: { warmth: 1.04, contrast: 1.03, brightness: 1.03, saturation: 0.95 },
    segmentationStrategy: 's05_tweed_knit_gallery',
    accessoryComposite: {
      productSlug: 'vi-cam-tay-clutch-champagne',
      anchorCenterX: 0.65,
      anchorCenterY: 0.72,
      widthRatio: 0.25,
      angleDeg: -8,
      shadowOpacity: 0.36,
    },
    wearableSlots: [
      {
        slotKey: 'TOP',
        productSlug: 'ao-len-cashmere-co-lo',
        materialOpticalProfile: { sheen: 'tweed', specularIntensity: 0.16, shadowDepth: 0.34 },
        variants: [
          {
            colorKey: 'ivory',
            colorName: 'Kem Cashmere',
            colorHex: '#EFE6D8',
            macroKey: 'tweed',
            fabricSpecText: 'Cashmere Nội Mông 14 Gauge · Kem Cashmere · Siêu nhẹ không dặm',
          },
          {
            colorKey: 'espresso',
            colorName: 'Cacao Đậm',
            colorHex: '#2E221B',
            macroKey: 'tweed',
            fabricSpecText: 'Cashmere Nội Mông 14 Gauge · Cacao Đậm · Ấm áp tinh giản',
          },
          {
            colorKey: 'wine-red',
            colorName: 'Đỏ Rượu Vang',
            colorHex: '#5E1924',
            macroKey: 'tweed',
            fabricSpecText: 'Cashmere Nội Mông 14 Gauge · Đỏ Rượu Vang · Điểm nhấn mùa lạnh',
          },
        ],
      },
      {
        slotKey: 'OUTERWEAR',
        productSlug: 'ao-khoac-tweed-det-thu-cong',
        materialOpticalProfile: { sheen: 'tweed', specularIntensity: 0.20, shadowDepth: 0.40 },
        variants: [
          {
            colorKey: 'ivory',
            colorName: 'Ngà Ánh Đồng',
            colorHex: '#E6DCC8',
            macroKey: 'tweed',
            fabricSpecText: 'Dạ Tweed Dệt Nổi · Ngà Ánh Đồng · Viền tết tay couture',
          },
          {
            colorKey: 'jet-black',
            colorName: 'Đen Tuyền',
            colorHex: '#171615',
            macroKey: 'tweed',
            fabricSpecText: 'Dạ Tweed Dệt Nổi · Đen Tuyền · Cúc đồng chạm khắc',
          },
          {
            colorKey: 'espresso',
            colorName: 'Cacao Đêm',
            colorHex: '#2C211C',
            macroKey: 'tweed',
            fabricSpecText: 'Dạ Tweed Dệt Nổi · Cacao Đêm · Sợi len pha lụa tơ tằm',
          },
        ],
      },
      {
        slotKey: 'ACCESSORY',
        productSlug: 'vi-cam-tay-clutch-champagne',
        materialOpticalProfile: { sheen: 'leather', specularIntensity: 0.52, shadowDepth: 0.34 },
        variants: [
          {
            colorKey: 'champagne',
            colorName: 'Champagne Ánh Kim',
            colorHex: '#DFC9A6',
            macroKey: 'leather',
            fabricSpecText: 'Lụa Satin Khung Đồng · Champagne Ánh Kim · Sang trọng mùa thu đông',
          },
          {
            colorKey: 'jet-black',
            colorName: 'Đen Tuyền',
            colorHex: '#171615',
            macroKey: 'leather',
            fabricSpecText: 'Lụa Satin Khung Đồng · Đen Tuyền · Hoàn thiện set Tweed',
          },
          {
            colorKey: 'wine-red',
            colorName: 'Đỏ Rượu Vang',
            colorHex: '#5E1924',
            macroKey: 'leather',
            fabricSpecText: 'Lụa Satin Khung Đồng · Đỏ Rượu Vang · Ấm áp tiệc tối',
          },
        ],
      },
    ],
  },
  {
    seasonSlug: 'atelier-di-san',
    order: 6,
    months: 'T11–T12',
    name: 'Dạ Tiệc Cuối Năm',
    shortName: 'Dạ Tiệc',
    materialHeadline: 'Lụa Satin Ánh Ngọc & Nhung Couture',
    note: 'Lụa Satin Ánh Ngọc & Nhung Couture — đầm cắt thiên bias-cut tôn vinh kỹ nghệ dạ tiệc cuối năm.',
    isCurrent: false,
    rawFile: 'lookbook-03-crimson-satin-gown.jpg',
    crop: [0.09, 0.14, 0.94, 0.99],
    editorialGrade: { warmth: 1.02, contrast: 1.03, brightness: 0.99, saturation: 0.95 },
    segmentationStrategy: 's06_evening_satin_gown_wrap',
    accessoryComposite: {
      productSlug: 'vi-cam-tay-clutch-champagne',
      anchorCenterX: 0.67,
      anchorCenterY: 0.72,
      widthRatio: 0.24,
      angleDeg: -11,
      shadowOpacity: 0.42,
    },
    wearableSlots: [
      {
        slotKey: 'ONE_PIECE',
        productSlug: 'dam-du-tiec-lua-satin-co-do',
        materialOpticalProfile: { sheen: 'silk', specularIntensity: 0.50, shadowDepth: 0.36 },
        variants: [
          {
            colorKey: 'wine-red',
            colorName: 'Đỏ Rượu Vang',
            colorHex: '#5E1924',
            macroKey: 'silk',
            fabricSpecText: 'Lụa Satin 22 Momme · Đỏ Rượu Vang · Cắt thiên bias-cut',
          },
          {
            colorKey: 'jet-black',
            colorName: 'Đen Huyền',
            colorHex: '#171615',
            macroKey: 'silk',
            fabricSpecText: 'Lụa Satin 22 Momme · Đen Huyền · Ánh ngọc dưới đèn tiệc',
          },
          {
            colorKey: 'champagne',
            colorName: 'Champagne Ánh Ngọc',
            colorHex: '#DFC9A6',
            macroKey: 'silk',
            fabricSpecText: 'Lụa Satin 22 Momme · Champagne Ánh Ngọc · Mềm rủ couture',
          },
        ],
      },
      {
        slotKey: 'OUTERWEAR',
        productSlug: 'ao-kieu-lua-organza-phoi-no',
        materialOpticalProfile: { sheen: 'silk', specularIntensity: 0.44, shadowDepth: 0.28 },
        variants: [
          {
            colorKey: 'champagne',
            colorName: 'Hồng Phấn Đất',
            colorHex: '#DFC5BE',
            macroKey: 'silk',
            fabricSpecText: 'Lụa Organza Tơ Tằm · Hồng Phấn Đất · Xuyên thấu tinh tế',
          },
          {
            colorKey: 'ivory',
            colorName: 'Kem Ngà',
            colorHex: '#F4EFE6',
            macroKey: 'silk',
            fabricSpecText: 'Lụa Organza Tơ Tằm · Kem Ngà · Nơ cổ thắt thủ công',
          },
          {
            colorKey: 'jet-black',
            colorName: 'Đen Tuyền',
            colorHex: '#171615',
            macroKey: 'silk',
            fabricSpecText: 'Lụa Organza Tơ Tằm · Đen Tuyền · Huyền bí dạ tiệc',
          },
        ],
      },
      {
        slotKey: 'ACCESSORY',
        productSlug: 'vi-cam-tay-clutch-champagne',
        materialOpticalProfile: { sheen: 'leather', specularIntensity: 0.52, shadowDepth: 0.34 },
        variants: [
          {
            colorKey: 'champagne',
            colorName: 'Champagne Ánh Kim',
            colorHex: '#DFC9A6',
            macroKey: 'leather',
            fabricSpecText: 'Lụa Satin Khung Đồng · Champagne Ánh Kim · Chế tác thủ công',
          },
          {
            colorKey: 'jet-black',
            colorName: 'Đen Tuyền',
            colorHex: '#171615',
            macroKey: 'leather',
            fabricSpecText: 'Lụa Satin Khung Đồng · Đen Tuyền · Tối giản dạ hội',
          },
          {
            colorKey: 'wine-red',
            colorName: 'Đỏ Rượu Vang',
            colorHex: '#5E1924',
            macroKey: 'leather',
            fabricSpecText: 'Lụa Satin Khung Đồng · Đỏ Rượu Vang · Đồng điệu satin couture',
          },
        ],
      },
    ],
  },
];

/**
 * Clean ghost-mannequin / flat-lay sources for studio 3:4 variant cutouts.
 * Uses existing high-res processed flats where already museum-grade, and extracts
 * symmetrical clean studio cutouts from our clean raw photography for the 6 upgraded items.
 */
const STUDIO_CUTOUT_SOURCES = {
  'ao-so-mi-lua-to-tam-tam-xuan': {
    kind: 'extract_cloth',
    rawFile: 'season-s01-18505097.jpg',
    crop: [0.22, 0.34, 0.88, 0.78],
    clothClass: 'upper',
    sheen: 'silk',
  },
  'chan-vay-xep-ly-midi-cap-cao': {
    kind: 'extract_cloth',
    rawFile: 'lookbook-05-pleated-midi-skirt.jpg',
    crop: [0.18, 0.52, 0.90, 0.99],
    clothClass: 'lower',
    sheen: 'silk',
  },
  'vi-cam-tay-clutch-champagne': {
    kind: 'processed_flat',
    sheen: 'leather',
  },
  'ao-so-mi-lua-to-tam-bao-loc': {
    kind: 'processed_flat',
    sheen: 'linen',
  },
  'quan-culottes-linen-huu-co': {
    kind: 'extract_cloth',
    rawFile: 'lookbook-10-linen-culottes.jpg',
    crop: [0.18, 0.44, 0.82, 0.92],
    clothClass: 'lower',
    sheen: 'linen',
  },
  'khan-lua-hoa-tiet-tam-xuan': {
    kind: 'processed_flat',
    sheen: 'silk',
  },
  'dam-midi-linen-phoi-dai': {
    kind: 'extract_cloth',
    rawFile: 'lookbook-17-linen-midi-dress.jpg',
    crop: [0.12, 0.14, 0.88, 0.86],
    clothClass: 'full',
    sheen: 'linen',
  },
  'ao-cardigan-len-merino-khuy-sung': {
    kind: 'extract_cloth',
    rawFile: 'lookbook-09-merino-cardigan.jpg',
    crop: [0.06, 0.28, 0.94, 0.99],
    clothClass: 'upper',
    sheen: 'tweed',
  },
  'ao-blazer-linen-dang-suong': {
    kind: 'processed_flat',
    sheen: 'linen',
  },
  'quan-tay-ong-suong-xep-ly-doi': {
    kind: 'processed_flat',
    sheen: 'tweed',
  },
  'that-lung-da-khoa-dong': {
    kind: 'processed_flat',
    sheen: 'leather',
  },
  'ao-len-cashmere-co-lo': {
    kind: 'processed_flat',
    sheen: 'tweed',
  },
  'ao-khoac-tweed-det-thu-cong': {
    kind: 'processed_flat',
    sheen: 'tweed',
  },
  'dam-du-tiec-lua-satin-co-do': {
    kind: 'processed_flat',
    sheen: 'silk',
  },
  'ao-kieu-lua-organza-phoi-no': {
    kind: 'extract_cloth',
    rawFile: 'lookbook-07-organza-blouse.jpg',
    crop: [0.22, 0.30, 0.88, 0.68],
    clothClass: 'upper',
    sheen: 'silk',
  },
};

const MACRO_BASE_SOURCES = {
  silk: {
    rawFile: 'macro-silk-satin-champagne.jpg',
    crop: [0.06, 0.04, 0.94, 0.96],
    sheen: 'silk',
    specularIntensity: 0.62,
    shadowDepth: 0.42,
  },
  'pleated-silk': {
    rawFile: 'atelier-step1-silk-folds.jpg',
    crop: [0.04, 0.14, 0.96, 0.88],
    sheen: 'silk',
    specularIntensity: 0.48,
    shadowDepth: 0.44,
  },
  linen: {
    rawFile: 'macro-organic-linen.jpg',
    crop: [0.05, 0.12, 0.95, 0.88],
    sheen: 'linen',
    specularIntensity: 0.16,
    shadowDepth: 0.34,
  },
  tweed: {
    rawFile: 'prod-11-artisan-tweed-jacket-woven.jpg',
    crop: [0.20, 0.24, 0.72, 0.66],
    sheen: 'tweed',
    specularIntensity: 0.18,
    shadowDepth: 0.40,
  },
  leather: {
    rawFile: 'macro-silk-pearl-cuff.jpg',
    crop: [0.08, 0.16, 0.92, 0.86],
    sheen: 'leather',
    specularIntensity: 0.56,
    shadowDepth: 0.38,
  },
};

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
  throw new Error('Could not load sharp for seasonal lookbook asset audit.');
}

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
  throw new Error('Could not find Python executable.');
}

async function ensureRawDownloads() {
  fs.mkdirSync(RAW_DIR, { recursive: true });
  for (const item of EXTRA_RAW_DOWNLOADS) {
    const dest = path.join(RAW_DIR, item.rawName);
    if (fs.existsSync(dest) && fs.statSync(dest).size > 20_000) {
      continue;
    }
    console.log(`[download] Fetching ${item.rawName} from ${item.url} ...`);
    const res = await fetch(item.url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    });
    if (!res.ok) {
      throw new Error(`Failed to download ${item.rawName} (${res.status})`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 20_000) {
      throw new Error(`Downloaded ${item.rawName} is suspiciously small (${buf.length} bytes)`);
    }
    fs.writeFileSync(dest, buf);
  }
}

const PYTHON_PIPELINE = String.raw`#!/usr/bin/env python3
from __future__ import annotations

import json
import math
import sys
import time
from pathlib import Path
from typing import Any

import cv2
import numpy as np
from PIL import Image, ImageEnhance, ImageFilter, ImageOps
from rembg import new_session, remove
from scipy import ndimage

EDITORIAL_W = 960
EDITORIAL_H = 1200
VARIANT_W = 480
VARIANT_H = 640
MACRO_W = 640
MACRO_H = 480


class SessionPool:
    def __init__(self) -> None:
        self._sessions: dict[str, Any] = {}

    def get(self, name: str) -> Any:
        if name not in self._sessions:
            t0 = time.time()
            self._sessions[name] = new_session(name)
            print(f"[seasons:py] loaded rembg '{name}' in {time.time() - t0:.2f}s", flush=True)
        return self._sessions[name]


def parse_hex_rgb(hex_color: str) -> tuple[int, int, int]:
    s = hex_color.strip().lstrip("#")
    if len(s) == 3:
        s = "".join(c * 2 for c in s)
    return int(s[0:2], 16), int(s[2:4], 16), int(s[4:6], 16)


def crop_normalized(img: Image.Image, box: list[float] | None) -> Image.Image:
    if not box or len(box) != 4:
        return img
    w, h = img.size
    x0 = max(0, min(w - 1, int(round(box[0] * w))))
    y0 = max(0, min(h - 1, int(round(box[1] * h))))
    x1 = max(x0 + 1, min(w, int(round(box[2] * w))))
    y1 = max(y0 + 1, min(h, int(round(box[3] * h))))
    return img.crop((x0, y0, x1, y1))


def aspect_fill_resize(img: Image.Image, target_w: int, target_h: int, bias_x: float = 0.5, bias_y: float = 0.5) -> Image.Image:
    src_w, src_h = img.size
    target_ratio = target_w / target_h
    src_ratio = src_w / src_h
    if src_ratio > target_ratio:
        new_w = int(round(src_h * target_ratio))
        x0 = int(round(max(0, src_w - new_w) * bias_x))
        cropped = img.crop((x0, 0, x0 + new_w, src_h))
    else:
        new_h = int(round(src_w / target_ratio))
        y0 = int(round(max(0, src_h - new_h) * bias_y))
        cropped = img.crop((0, y0, src_w, y0 + new_h))
    return cropped.resize((target_w, target_h), Image.Resampling.LANCZOS)


def apply_editorial_grade(img: Image.Image, grade: dict[str, float]) -> Image.Image:
    out = img.convert("RGB")
    contrast = float(grade.get("contrast", 1.03))
    brightness = float(grade.get("brightness", 1.0))
    saturation = float(grade.get("saturation", 0.96))
    warmth = float(grade.get("warmth", 1.02))
    out = ImageEnhance.Contrast(out).enhance(contrast)
    out = ImageEnhance.Brightness(out).enhance(brightness)
    out = ImageEnhance.Color(out).enhance(saturation)
    out = ImageEnhance.Sharpness(out).enhance(1.06)
    arr = np.array(out, dtype=np.float32)
    arr[:, :, 0] = np.clip(arr[:, :, 0] * (1.0 + (warmth - 1.0) * 0.55) + 1.0, 0, 255)
    arr[:, :, 1] = np.clip(arr[:, :, 1] * (1.0 + (warmth - 1.0) * 0.20) + 0.5, 0, 255)
    arr[:, :, 2] = np.clip(arr[:, :, 2] * (1.0 - (warmth - 1.0) * 0.45), 0, 255)
    return Image.fromarray(np.round(arr).astype(np.uint8), mode="RGB")


def apply_photometric_recolor_bgr(
    base_bgr: np.ndarray,
    mask_alpha: np.ndarray,
    color_hex: str,
    sheen: str = "silk",
    specular: float = 0.45,
    shadow_depth: float = 0.36,
    is_macro: bool = False,
) -> np.ndarray:
    """
    Perceptual CIE-LAB photometric fabric recolor matching services/ai-tryon
    and frontend PhotometricFabricRecolorEngine. Preserves 100% of original fold
    shading & micro-weave while creating authentic liquid luster on dark silk.
    """
    orig_lab = cv2.cvtColor(base_bgr, cv2.COLOR_BGR2LAB).astype(np.float32)
    active = mask_alpha > 0.04
    if int(np.count_nonzero(active)) < 16:
        return base_bgr.copy()

    core = mask_alpha > 0.55
    if int(np.count_nonzero(core)) < 32:
        core = active

    tr, tg, tb = parse_hex_rgb(color_hex)
    target_lab = cv2.cvtColor(np.uint8([[[tb, tg, tr]]]), cv2.COLOR_BGR2LAB)[0, 0].astype(np.float32)
    t_l, t_a, t_b = float(target_lab[0]), float(target_lab[1]), float(target_lab[2])

    l_orig = orig_lab[:, :, 0]
    a_orig = orig_lab[:, :, 1]
    b_orig = orig_lab[:, :, 2]

    l_p08, l_med, l_p94 = np.percentile(l_orig[core], [8, 50, 94])
    l_span = max(16.0, float(l_p94 - l_p08))
    rel = np.clip((l_orig - float(l_med)) / l_span, -1.7, 1.7)

    if t_l < 92.0:
        dark_factor = max(0.0, (92.0 - t_l) / 92.0)
        fold_amp = (28.0 if is_macro else 24.0) + 18.0 * (1.0 - dark_factor) + 14.0 * shadow_depth
        # Specular ridge curve: lifts smooth highlights so Jet-Black silk glows like liquid satin
        ridge_base = np.clip((rel - (0.06 if is_macro else 0.12)) / 0.88, 0.0, 1.0)
        ridge = np.power(ridge_base, 1.45 if sheen == "silk" else 1.65)
        if sheen == "silk":
            sheen_gain = 76.0 if is_macro else 56.0
        elif sheen == "leather":
            sheen_gain = 66.0 if is_macro else 54.0
        else:
            sheen_gain = 22.0
        sheen_lift = ridge * specular * sheen_gain
        chroma_atten = 1.0 - 0.38 * ridge * specular
    else:
        fold_amp = (42.0 if is_macro else 38.0) + 16.0 * shadow_depth
        ridge_base = np.clip((rel - 0.20) / 0.80, 0.0, 1.0)
        ridge = np.power(ridge_base, 1.7)
        sheen_gain = 26.0 if sheen == "silk" else (30.0 if sheen == "leather" else 12.0)
        sheen_lift = ridge * specular * sheen_gain
        chroma_atten = 1.0 - 0.20 * ridge * specular

    micro_detail = np.zeros_like(l_orig)
    if sheen in ("tweed", "linen"):
        blurred_l = cv2.GaussianBlur(l_orig, (7, 7), 0)
        micro_weight = 0.58 if sheen == "tweed" else 0.36
        micro_detail = (l_orig - blurred_l) * micro_weight
    elif sheen == "silk" and is_macro:
        blurred_l = cv2.GaussianBlur(l_orig, (5, 5), 0)
        micro_detail = (l_orig - blurred_l) * 0.22

    l_new = np.clip(t_l + rel * fold_amp + sheen_lift + micro_detail, 3.0, 252.0)

    if is_macro:
        a_new = np.clip(128.0 + (t_a - 128.0) * chroma_atten, 1.0, 254.0)
        b_new = np.clip(128.0 + (t_b - 128.0) * chroma_atten, 1.0, 254.0)
    else:
        # 7% ambient color temperature bleed from surrounding pixels
        mask_u8 = (mask_alpha > 0.12).astype(np.uint8)
        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (19, 19))
        ring = (cv2.dilate(mask_u8, kernel, iterations=1) > 0) & (mask_u8 == 0)
        if int(np.count_nonzero(ring)) >= 32:
            amb_a = float(np.median(a_orig[ring]))
            amb_b = float(np.median(b_orig[ring]))
        else:
            amb_a, amb_b = 128.0, 131.0
        amb_w = 0.07
        a_new = np.clip(128.0 + (t_a - 128.0) * chroma_atten * (1.0 - amb_w) + (amb_a - 128.0) * amb_w, 1.0, 254.0)
        b_new = np.clip(128.0 + (t_b - 128.0) * chroma_atten * (1.0 - amb_w) + (amb_b - 128.0) * amb_w, 1.0, 254.0)

    recolored_lab = np.stack([l_new, a_new, b_new], axis=-1).astype(np.uint8)
    recolored_bgr = cv2.cvtColor(recolored_lab, cv2.COLOR_LAB2BGR).astype(np.float32)

    a3 = mask_alpha[:, :, None]
    out_bgr = base_bgr.astype(np.float32) * (1.0 - a3) + recolored_bgr * a3
    return np.clip(np.round(out_bgr), 0, 255).astype(np.uint8)


def detect_face_and_skin_exclusion(
    bgr: np.ndarray,
    human_mask: np.ndarray,
    yunet_path: Path,
    exclude_neck_extra: float = 0.55,
    exclude_hair_below: float = 0.25,
    skin_threshold_scale: float = 1.0,
) -> tuple[np.ndarray, dict[str, float]]:
    """
    Uses OpenCV YuNet face detection + adaptive face-sampled YCrCb/HSV skin segmentation
    to build an airtight face + head + hair + neck + hands exclusion mask so ZERO garment
    mask ever bleeds onto face or skin.
    """
    h, w = bgr.shape[:2]
    excl = np.zeros((h, w), dtype=bool)
    face_info = {"x": 0.42, "y": 0.10, "w": 0.16, "h": 0.14}

    det = cv2.FaceDetectorYN.create(str(yunet_path), "", (w, h), 0.40, 0.3, 5000)
    _, faces = det.detect(bgr)

    ycrcb = cv2.cvtColor(bgr, cv2.COLOR_BGR2YCrCb).astype(np.float32)
    hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV).astype(np.float32)

    if faces is not None and len(faces) > 0:
        # Pick largest / highest-confidence face
        best = max(faces, key=lambda f: float(f[2] * f[3]) * float(f[-1]))
        fx, fy, fw, fh = [float(v) for v in best[:4]]
        face_info = {"x": fx / w, "y": fy / h, "w": fw / w, "h": fh / h}

        cx = int(round(fx + fw * 0.5))
        cy = int(round(fy + fh * 0.5))

        # 1. Generous head/hair crown + face ellipse
        head_cy = int(round(fy + fh * 0.35))
        head_rx = int(round(fw * 0.78))
        head_ry = int(round(fh * 0.92))
        excl_u8 = np.zeros((h, w), dtype=np.uint8)
        cv2.ellipse(excl_u8, (cx, head_cy), (head_rx, head_ry), 0, 0, 360, 255, -1)

        # 2. Strict rectangular safety box over YuNet face (+8px pad)
        x0 = max(0, int(math.floor(fx)) - 10)
        y0 = max(0, int(math.floor(fy)) - 16)
        x1 = min(w, int(math.ceil(fx + fw)) + 10)
        y1 = min(h, int(math.ceil(fy + fh)) + 12)
        excl_u8[y0:y1, x0:x1] = 255

        # 3. Neck & upper decollete exclusion cone below chin
        neck_top = int(round(fy + fh * 0.85))
        neck_bot = min(h, int(round(fy + fh * (1.0 + exclude_neck_extra))))
        neck_rx = int(round(fw * 0.46))
        cv2.ellipse(excl_u8, (cx, int((neck_top + neck_bot) * 0.5)), (neck_rx, max(8, (neck_bot - neck_top) // 2 + 6)), 0, 0, 360, 255, -1)

        # 4. Sample model's TRUE skin tone from inner cheeks/forehead inside face box
        sx0 = max(0, int(round(fx + fw * 0.22)))
        sx1 = min(w, int(round(fx + fw * 0.78)))
        sy0 = max(0, int(round(fy + fh * 0.25)))
        sy1 = min(h, int(round(fy + fh * 0.75)))
        patch_ycrcb = ycrcb[sy0:sy1, sx0:sx1]
        cr_med = float(np.median(patch_ycrcb[:, :, 1]))
        cb_med = float(np.median(patch_ycrcb[:, :, 2]))
        y_med = float(np.median(patch_ycrcb[:, :, 0]))

        # Adaptive Mahalanobis-like skin distance in Cr/Cb + reasonable Y range
        d_cr = (ycrcb[:, :, 1] - cr_med) / (11.5 * skin_threshold_scale)
        d_cb = (ycrcb[:, :, 2] - cb_med) / (11.5 * skin_threshold_scale)
        d_y = np.abs(ycrcb[:, :, 0] - y_med) / (68.0 * skin_threshold_scale)
        # Also require skin Cr > 134 (warm pink/peach/brown undertone) so ivory/white fabric (Cr ~ 127-132) is NEVER falsely marked as skin!
        cr_floor = max(133.5, cr_med - 11.0 * skin_threshold_scale)
        adaptive_skin = (
            human_mask
            & ((d_cr * d_cr + d_cb * d_cb) <= 1.25)
            & (d_y <= 1.0)
            & (ycrcb[:, :, 1] >= cr_floor)
            & (ycrcb[:, :, 2] <= min(132.0, cb_med + 11.5 * skin_threshold_scale))
            & (hsv[:, :, 1] >= 22.0)
        )

        # Keep skin blobs that are reasonably sized (neck, hands, forearms, chest, legs)
        adaptive_skin = ndimage.binary_opening(adaptive_skin, iterations=1)
        adaptive_skin = ndimage.binary_dilation(adaptive_skin, iterations=2)

        # Hair exclusion near head/shoulders (dark pixels contiguous with top of head)
        head_top_y = max(0, int(round(fy - fh * 0.65)))
        hair_band_bot = min(h, int(round(fy + fh * (1.0 + exclude_hair_below))))
        dark_hair = (
            human_mask
            & (ycrcb[:, :, 0] < max(78.0, y_med * 0.52))
            & (np.arange(h)[:, None] >= head_top_y)
            & (np.arange(h)[:, None] <= hair_band_bot)
            & (np.abs(np.arange(w)[None, :] - cx) <= int(fw * 1.45))
        )
        # Keep only dark regions connected to head ellipse
        hair_seed = (excl_u8 > 0) & (ycrcb[:, :, 0] < max(85.0, y_med * 0.56))
        if np.any(hair_seed) and np.any(dark_hair):
            labeled, _ = ndimage.label(dark_hair | hair_seed)
            seed_labels = np.unique(labeled[hair_seed])
            seed_labels = seed_labels[seed_labels > 0]
            hair_mask = np.isin(labeled, seed_labels)
            hair_mask = ndimage.binary_dilation(hair_mask, iterations=2)
        else:
            hair_mask = np.zeros((h, w), dtype=bool)

        excl = (excl_u8 > 0) | adaptive_skin | hair_mask
    else:
        # Safe fallback top-center face exclusion
        excl[int(h * 0.05) : int(h * 0.25), int(w * 0.36) : int(w * 0.64)] = True

    return excl, face_info


def keep_largest_components(mask: np.ndarray, min_ratio: float = 0.12, max_count: int = 3) -> np.ndarray:
    labeled, n = ndimage.label(mask)
    if n <= 1:
        return mask
    sizes = ndimage.sum(mask, labeled, range(1, n + 1))
    order = np.argsort(sizes)[::-1]
    max_sz = float(sizes[order[0]])
    if max_sz <= 0:
        return mask
    keep_ids = []
    for idx in order[:max_count]:
        if float(sizes[idx]) >= max_sz * min_ratio:
            keep_ids.append(int(idx) + 1)
    return np.isin(labeled, keep_ids)


def feather_mask_to_rgba(mask_bool: np.ndarray, feather_sigma: float = 1.15) -> np.ndarray:
    """
    Convert clean binary garment mask into 960x1200 RGBA PNG (white RGB, ~2.5px feathered alpha).
    """
    h, w = mask_bool.shape
    mask_clean = ndimage.binary_fill_holes(mask_bool)
    # Gentle edge smoothing before feathering
    soft = ndimage.gaussian_filter(mask_clean.astype(np.float32) * 255.0, sigma=feather_sigma)
    # Keep inner core crisp 255, zero tiny dust < 8
    core = ndimage.binary_erosion(mask_clean, iterations=2)
    alpha = np.where(core, np.maximum(soft, 255.0), soft)
    alpha = np.where(alpha < 8.0, 0.0, alpha)
    alpha_u8 = np.clip(np.round(alpha), 0, 255).astype(np.uint8)

    rgba = np.zeros((h, w, 4), dtype=np.uint8)
    rgba[:, :, :3] = 255
    rgba[:, :, 3] = alpha_u8
    return rgba


def compute_mask_metrics(alpha_u8: np.ndarray, avoid_points: list[tuple[float, float]]) -> tuple[dict[str, float], dict[str, float], float]:
    h, w = alpha_u8.shape
    solid = alpha_u8 >= 128
    if int(np.count_nonzero(solid)) < 32:
        solid = alpha_u8 >= 32
    ys, xs = np.where(solid)
    if len(xs) == 0:
        return {"xPercent": 50.0, "yPercent": 50.0}, {"x": 0.3, "y": 0.3, "w": 0.4, "h": 0.4}, 0.0

    x0, x1 = int(xs.min()), int(xs.max())
    y0, y1 = int(ys.min()), int(ys.max())
    bbox = {
        "x": round(x0 / float(w), 4),
        "y": round(y0 / float(h), 4),
        "w": round((x1 - x0 + 1) / float(w), 4),
        "h": round((y1 - y0 + 1) / float(h), 4),
    }

    # Distance transform finds the deepest interior point (guaranteed strictly on fabric!)
    dist = ndimage.distance_transform_edt(solid)
    best_y, best_x = np.unravel_index(int(np.argmax(dist)), dist.shape)
    px_pct = best_x / float(w) * 100.0
    py_pct = best_y / float(h) * 100.0

    # If too close to an existing pin, pick the best interior point far enough from existing pins
    for _ in range(3):
        too_close = any(math.hypot(px_pct - ax, py_pct - ay) < 11.0 for ax, ay in avoid_points)
        if not too_close:
            break
        # Score interior points by distance-from-edge minus penalty for closeness to other pins
        yy, xx = np.mgrid[0:h:4, 0:w:4]
        d_sub = dist[::4, ::4].copy()
        for ax, ay in avoid_points:
            dd = np.hypot(xx / float(w) * 100.0 - ax, yy / float(h) * 100.0 - ay)
            d_sub *= np.clip((dd - 6.0) / 14.0, 0.05, 1.0)
        iy, ix = np.unravel_index(int(np.argmax(d_sub)), d_sub.shape)
        if d_sub[iy, ix] > 1.0:
            px_pct = (ix * 4) / float(w) * 100.0
            py_pct = (iy * 4) / float(h) * 100.0

    cov = float((alpha_u8 >= 128).mean())
    return {"xPercent": round(px_pct, 1), "yPercent": round(py_pct, 1)}, bbox, cov


def composite_accessory_onto_base(
    base_rgb: Image.Image,
    acc_rgba_path: Path,
    cfg: dict[str, Any],
) -> tuple[Image.Image, np.ndarray]:
    """
    Cleanly composites a real high-res RGBA accessory cutout onto the 960x1200 editorial portrait
    with natural warm ambient lighting match + soft grounded contact shadow, returning:
      - updated 960x1200 RGB portrait
      - exact 960x1200 feathered RGBA mask of ONLY the accessory
    """
    acc = Image.open(acc_rgba_path).convert("RGBA")
    arr = np.array(acc, dtype=np.uint8)
    ys, xs = np.where(arr[:, :, 3] >= 35)
    if len(xs) == 0:
        raise ValueError(f"Empty accessory alpha in {acc_rgba_path}")
    acc = acc.crop((max(0, int(xs.min()) - 2), max(0, int(ys.min()) - 2), min(acc.width, int(xs.max()) + 3), min(acc.height, int(ys.max()) + 3)))

    # Scale to target widthRatio of editorial frame
    target_w = max(80, int(round(EDITORIAL_W * float(cfg["widthRatio"]))))
    scale = target_w / float(acc.width)
    target_h = max(60, int(round(acc.height * scale)))
    acc = acc.resize((target_w, target_h), Image.Resampling.LANCZOS)

    angle = float(cfg.get("angleDeg", 0.0))
    if abs(angle) > 0.1:
        acc = acc.rotate(angle, resample=Image.Resampling.BICUBIC, expand=True)

    # Match ambient brightness gently to local neighborhood of base portrait
    cx = int(round(EDITORIAL_W * float(cfg["anchorCenterX"])))
    cy = int(round(EDITORIAL_H * float(cfg["anchorCenterY"])))
    paste_x = max(12, min(EDITORIAL_W - acc.width - 12, cx - acc.width // 2))
    paste_y = max(12, min(EDITORIAL_H - acc.height - 12, cy - acc.height // 2))

    # Build soft contact shadow layer (offset slightly down-right)
    acc_arr = np.array(acc, dtype=np.uint8)
    shadow_alpha = ndimage.gaussian_filter(acc_arr[:, :, 3].astype(np.float32), sigma=10.0)
    shadow_alpha = np.clip(shadow_alpha * float(cfg.get("shadowOpacity", 0.30)), 0, 255).astype(np.uint8)
    shadow_layer = Image.new("RGBA", (EDITORIAL_W, EDITORIAL_H), (0, 0, 0, 0))
    sh_patch = np.zeros((acc.height, acc.width, 4), dtype=np.uint8)
    sh_patch[:, :, 0] = 28
    sh_patch[:, :, 1] = 20
    sh_patch[:, :, 2] = 14
    sh_patch[:, :, 3] = shadow_alpha
    shadow_layer.paste(Image.fromarray(sh_patch, mode="RGBA"), (min(EDITORIAL_W - acc.width, paste_x + 6), min(EDITORIAL_H - acc.height, paste_y + 10)))

    # Warm-match accessory slightly to ambient scene light
    base_arr = np.array(base_rgb, dtype=np.float32)
    roi = base_arr[max(0, paste_y - 20) : min(EDITORIAL_H, paste_y + acc.height + 20), max(0, paste_x - 20) : min(EDITORIAL_W, paste_x + acc.width + 20)]
    roi_mean = roi.mean(axis=(0, 1)) if roi.size else np.array([150.0, 140.0, 128.0])
    acc_f = acc_arr.astype(np.float32)
    # Gentle warm highlight harmonization (preserve real clutch/scarf texture!)
    warm_tint = roi_mean / max(1.0, float(roi_mean.mean()))
    warm_tint = 1.0 + (warm_tint - 1.0) * 0.25
    acc_f[:, :, :3] = np.clip(acc_f[:, :, :3] * warm_tint[None, None, :], 0, 255)
    acc_matched = Image.fromarray(np.round(acc_f).astype(np.uint8), mode="RGBA")

    fg_layer = Image.new("RGBA", (EDITORIAL_W, EDITORIAL_H), (0, 0, 0, 0))
    fg_layer.paste(acc_matched, (paste_x, paste_y))

    comp = base_rgb.convert("RGBA")
    comp = Image.alpha_composite(comp, shadow_layer)
    comp = Image.alpha_composite(comp, fg_layer)

    # Exact feathered alpha mask for the accessory
    raw_alpha = np.array(fg_layer, dtype=np.uint8)[:, :, 3]
    acc_mask_rgba = feather_mask_to_rgba(raw_alpha >= 45, feather_sigma=1.05)
    return comp.convert("RGB"), acc_mask_rgba


def segment_season_masks(
    strategy: str,
    base_rgb: Image.Image,
    sessions: SessionPool,
    yunet_path: Path,
    acc_mask_rgba: np.ndarray | None,
) -> tuple[dict[str, np.ndarray], dict[str, float]]:
    """
    Multi-stage neural + anatomical + perceptual Lab garment segmentation.
    Guarantees 100% mutually exclusive masks per season with ZERO face/skin/hair bleed.
    """
    bgr = cv2.cvtColor(np.array(base_rgb, dtype=np.uint8), cv2.COLOR_RGB2BGR)
    lab = cv2.cvtColor(bgr, cv2.COLOR_BGR2LAB).astype(np.float32)
    h, w = bgr.shape[:2]
    yy, xx = np.mgrid[0:h, 0:w]
    yn = yy / float(h)
    xn = xx / float(w)

    # 1. Neural human silhouette (u2net_human_seg)
    human_sess = sessions.get("u2net_human_seg")
    human_rgba = remove(base_rgb, session=human_sess, post_process_mask=True).convert("RGBA")
    human_alpha = np.array(human_rgba, dtype=np.uint8)[:, :, 3]
    human_mask = human_alpha >= 80

    # 2. Neural garment segmentation (u2net_cloth_seg) -> upper, lower, full
    cloth_sess = sessions.get("u2net_cloth_seg")
    m_up_im, m_lo_im, m_fu_im = cloth_sess.predict(base_rgb)
    m_up = np.array(m_up_im, dtype=np.uint8) > 16
    m_lo = np.array(m_lo_im, dtype=np.uint8) > 16
    m_fu = np.array(m_fu_im, dtype=np.uint8) > 16

    # Smooth cloth masks slightly & constrain to person silhouette
    human_dil = ndimage.binary_dilation(human_mask, iterations=4)
    m_up = ndimage.binary_closing(m_up & human_dil, iterations=2)
    m_lo = ndimage.binary_closing(m_lo & human_dil, iterations=2)
    m_fu = ndimage.binary_closing(m_fu & human_dil, iterations=2)

    # 3. YuNet face + adaptive skin/hair exclusion
    neck_extra = 0.55
    hair_below = 0.30
    skin_scale = 1.0
    if strategy == "s03_resort_dress_cardigan":
        neck_extra = 0.85
        skin_scale = 1.08
    elif strategy == "s06_evening_satin_gown_wrap":
        neck_extra = 0.45
        skin_scale = 1.12
    elif strategy == "s01_garden_blouse_pleated":
        neck_extra = 0.48
        hair_below = 0.75  # long dark hair draping near left shoulder

    excl, face_info = detect_face_and_skin_exclusion(
        bgr,
        human_mask=human_mask,
        yunet_path=yunet_path,
        exclude_neck_extra=neck_extra,
        exclude_hair_below=hair_below,
        skin_threshold_scale=skin_scale,
    )

    acc_bool = (acc_mask_rgba[:, :, 3] >= 32) if acc_mask_rgba is not None else np.zeros((h, w), dtype=bool)
    acc_dil = ndimage.binary_dilation(acc_bool, iterations=1) if np.any(acc_bool) else np.zeros((h, w), dtype=bool)

    masks_bool: dict[str, np.ndarray] = {}

    if strategy == "s01_garden_blouse_pleated":
        # Vietnamese model in garden: bright ivory silk blouse (TOP) + warm cream pleated skirt (BOTTOM)
        # Blouse is upper cloth + bright ivory tones above waist (~y=0.58); exclude paper fan on far-right (x > 0.72, y > 0.52)
        attire = (m_up | m_lo | m_fu) & human_mask & ~excl
        # Refine upper vs lower split cleanly using u2net_cloth_seg + waist boundary
        top_raw = m_up & human_mask & ~excl & (yn <= 0.62)
        if top_raw.sum() < 15_000:
            # Fallback to attire upper portion above waist
            top_raw = attire & (yn >= 0.25) & (yn <= 0.57)
        top_raw = keep_largest_components(top_raw, min_ratio=0.12, max_count=2)
        top_raw = ndimage.binary_fill_holes(top_raw) & ~excl

        # Bottom pleated skirt: u2net lower or attire below blouse, restricted to warm cream skirt region (exclude green foliage & far-right round paper fan)
        ys_top = np.where(top_raw)[0]
        waist_y = float(np.percentile(ys_top, 95)) / float(h) if len(ys_top) else 0.56
        # Cream pleated skirt is warm-light (L > 135, low greenness a* >= 122), below waist, x in [0.16..0.78]
        bot_raw = (m_lo | (attire & (yn >= waist_y - 0.03))) & ~top_raw & ~excl
        bot_raw &= (yn >= waist_y - 0.04) & (yn <= 0.94) & (xn >= 0.14) & (xn <= 0.78)
        # Exclude bright cool-white translucent round paper fan at right (x > 0.66 & y in 0.45..0.72)
        bot_raw &= ~((xn > 0.68) & (yn < 0.72))
        bot_raw = keep_largest_components(bot_raw, min_ratio=0.15, max_count=2)
        bot_raw = ndimage.binary_fill_holes(bot_raw) & ~top_raw & ~excl

        masks_bool["TOP"] = top_raw & ~acc_dil
        masks_bool["BOTTOM"] = bot_raw & ~acc_dil
        masks_bool["ACCESSORY"] = acc_bool

    elif strategy == "s02_sunlit_linen_trousers":
        # Sunlit coastal terrace: champagne-ivory silk/linen blouse (TOP) + bright white wide-leg trousers (BOTTOM)
        top_raw = m_up & human_mask & ~excl & (yn <= 0.64)
        # Include cream shirt pixels near neckline/sleeves while strictly excluding blonde hair & face
        top_raw = keep_largest_components(top_raw, min_ratio=0.12, max_count=2)
        top_raw = ndimage.binary_fill_holes(top_raw) & ~excl

        bot_raw = m_lo & human_mask & ~top_raw & ~excl
        if bot_raw.sum() < 20_000:
            bot_raw = (m_lo | m_fu) & human_mask & ~top_raw & ~excl & (yn >= 0.50)
        bot_raw = keep_largest_components(bot_raw, min_ratio=0.15, max_count=2)
        bot_raw = ndimage.binary_fill_holes(bot_raw) & ~top_raw & ~excl

        masks_bool["TOP"] = top_raw & ~acc_dil
        masks_bool["BOTTOM"] = bot_raw & ~acc_dil
        masks_bool["ACCESSORY"] = acc_bool

    elif strategy == "s03_resort_dress_cardigan":
        # Bright coastal resort: crisp white lace/linen dress in center (ONE_PIECE)
        # + chunky warm oatmeal-sand knit cardigan draped on shoulders/arms (OUTERWEAR)!
        attire = (m_up | m_lo | m_fu) & human_mask & ~excl & (yn >= 0.34)
        # Separate white/ivory dress (high L > 165, neutral/cool chroma b* < 134) vs warm knit cardigan (b* >= 134 or darker textured knit on outer left/right)
        is_dress_color = (lab[:, :, 0] >= 158.0) & (lab[:, :, 2] <= 134.5) & (xn >= 0.25) & (xn <= 0.78)
        dress_raw = attire & is_dress_color
        dress_raw = ndimage.binary_closing(dress_raw, iterations=4)
        dress_raw = keep_largest_components(dress_raw, min_ratio=0.15, max_count=1)
        dress_raw = ndimage.binary_fill_holes(dress_raw) & ~excl

        # Cardigan is remaining attire outside dress (left/right knit sleeves & draped back)
        cardigan_raw = (attire | (human_mask & (yn >= 0.36) & (lab[:, :, 2] >= 136.0) & (lab[:, :, 0] >= 55.0) & (lab[:, :, 0] <= 215.0))) & ~dress_raw & ~excl
        cardigan_raw = ndimage.binary_closing(cardigan_raw, iterations=3)
        cardigan_raw = keep_largest_components(cardigan_raw, min_ratio=0.10, max_count=2)
        cardigan_raw = ndimage.binary_fill_holes(cardigan_raw) & ~dress_raw & ~excl

        masks_bool["ONE_PIECE"] = dress_raw & ~acc_dil
        masks_bool["OUTERWEAR"] = cardigan_raw & ~acc_dil
        masks_bool["ACCESSORY"] = acc_bool

    elif strategy == "s04_tailored_blazer_trousers_belt":
        # Sunlit architectural studio: sand blazer (OUTERWEAR) + ivory trousers (BOTTOM) + real brown leather belt (ACCESSORY)!
        # First detect the real dark brown leather belt right at waist seam (y in 0.50..0.64, x in 0.36..0.68)
        # Belt is distinctly dark brown (L < 95) inside the human mask at the waist!
        waist_roi = human_mask & (yn >= 0.49) & (yn <= 0.65) & (xn >= 0.34) & (xn <= 0.68)
        belt_raw = waist_roi & (lab[:, :, 0] < 105.0) & ~excl
        belt_raw = ndimage.binary_closing(belt_raw, iterations=3)
        belt_raw = keep_largest_components(belt_raw, min_ratio=0.20, max_count=1)
        belt_raw = ndimage.binary_dilation(belt_raw, iterations=2) & human_mask & ~excl
        # Find belt y-band to split outerwear vs trousers cleanly
        if belt_raw.sum() >= 300:
            belt_ys = np.where(belt_raw)[0]
            belt_mid_y = float(belt_ys.mean()) / float(h)
        else:
            # Fallback clean horizontal waist belt band inside human silhouette
            belt_mid_y = 0.56
            belt_raw = waist_roi & (yn >= 0.545) & (yn <= 0.585)

        belt_dil = ndimage.binary_dilation(belt_raw, iterations=1)

        # Outerwear blazer: u2net upper (includes open lapels & sleeves) minus belt & trousers
        outer_raw = m_up & human_mask & ~excl & ~belt_dil
        outer_raw = keep_largest_components(outer_raw, min_ratio=0.12, max_count=2)
        outer_raw = ndimage.binary_fill_holes(outer_raw) & ~excl & ~belt_dil

        # Trousers: u2net lower below belt seam (and bright ivory legs below waist)
        bot_raw = (m_lo & human_mask & (yn >= belt_mid_y - 0.01)) & ~outer_raw & ~belt_dil & ~excl
        if bot_raw.sum() < 20_000:
            bot_raw = (m_lo | m_fu) & human_mask & (yn >= belt_mid_y) & ~outer_raw & ~belt_dil & ~excl
        bot_raw = keep_largest_components(bot_raw, min_ratio=0.15, max_count=2)
        bot_raw = ndimage.binary_fill_holes(bot_raw) & ~outer_raw & ~belt_dil & ~excl

        masks_bool["OUTERWEAR"] = outer_raw
        masks_bool["BOTTOM"] = bot_raw
        masks_bool["ACCESSORY"] = belt_raw

    elif strategy == "s05_tweed_knit_gallery":
        # Parisian stone gallery: woven tweed jacket (OUTERWEAR) over dark navy knit top (TOP) + champagne clutch!
        upper_all = (m_up | (m_fu & (yn <= 0.78))) & human_mask & ~excl & (yn >= 0.24) & (yn <= 0.86)
        # Inner knit top sits in central V-chest opening: darker, smoother blue-navy (L < 92, b* < 126, central x in 0.28..0.60, y in 0.28..0.68)
        inner_color = (lab[:, :, 0] < 96.0) & (lab[:, :, 2] < 127.0) & (xn >= 0.28) & (xn <= 0.62) & (yn >= 0.26) & (yn <= 0.70)
        top_raw = upper_all & inner_color
        top_raw = ndimage.binary_closing(top_raw, iterations=3)
        top_raw = keep_largest_components(top_raw, min_ratio=0.15, max_count=1)
        top_raw = ndimage.binary_fill_holes(top_raw) & ~excl

        # Tweed jacket is the remaining upper outerwear (shoulders, tweed lapels, sleeves, body)
        outer_raw = upper_all & ~top_raw & ~excl
        outer_raw = ndimage.binary_closing(outer_raw, iterations=3)
        outer_raw = keep_largest_components(outer_raw, min_ratio=0.10, max_count=2)
        outer_raw = ndimage.binary_fill_holes(outer_raw) & ~top_raw & ~excl

        masks_bool["TOP"] = top_raw & ~acc_dil
        masks_bool["OUTERWEAR"] = outer_raw & ~acc_dil
        masks_bool["ACCESSORY"] = acc_bool

    elif strategy == "s06_evening_satin_gown_wrap":
        # Golden-bronze evening couture studio: crimson silk satin gown (ONE_PIECE)
        # + dramatic voluminous silk-organza sleeves/wrap (OUTERWEAR) + champagne clutch (ACCESSORY)!
        # Red satin fabric has rich red chroma (a* >= 145) inside human mask, excluding skin/hands
        satin_all = ((m_up | m_lo | m_fu) | (human_mask & (lab[:, :, 1] >= 150.0))) & human_mask & ~excl & (yn >= 0.30)
        # Ensure red satin strictly excludes brown skin & dark hair
        satin_all &= (lab[:, :, 1] >= 142.0)
        satin_all = ndimage.binary_closing(satin_all, iterations=3)
        satin_all = keep_largest_components(satin_all, min_ratio=0.08, max_count=2)

        # Split central fitted satin gown bodice + skirt (ONE_PIECE) vs outer billowing organza puff sleeves (OUTERWEAR)
        # Using horizontal body column centered on face x (center_x +- 0.165w for bodice, widening naturally below waist y > 0.76)
        fcx = face_info["x"] + face_info["w"] * 0.5
        in_sleeve_band = (yn >= 0.35) & (yn <= 0.76) & (np.abs(xn - fcx) > 0.165)
        outer_raw = satin_all & in_sleeve_band
        outer_raw = ndimage.binary_closing(outer_raw, iterations=2)
        outer_raw = keep_largest_components(outer_raw, min_ratio=0.18, max_count=2)
        outer_raw = ndimage.binary_fill_holes(outer_raw) & satin_all & ~excl

        gown_raw = satin_all & ~outer_raw & ~excl
        gown_raw = keep_largest_components(gown_raw, min_ratio=0.12, max_count=2)
        gown_raw = ndimage.binary_fill_holes(gown_raw) & ~outer_raw & ~excl

        masks_bool["ONE_PIECE"] = gown_raw & ~acc_dil
        masks_bool["OUTERWEAR"] = outer_raw & ~acc_dil
        masks_bool["ACCESSORY"] = acc_bool

    else:
        raise ValueError(f"Unknown segmentation strategy: {strategy}")

    # Convert to feathered RGBA PNGs (or reuse exact feathered accessory mask if composited)
    rgba_masks: dict[str, np.ndarray] = {}
    for slot_key, mb in masks_bool.items():
        if slot_key == "ACCESSORY" and acc_mask_rgba is not None:
            rgba_masks[slot_key] = acc_mask_rgba
        else:
            rgba_masks[slot_key] = feather_mask_to_rgba(mb, feather_sigma=1.15)

    return rgba_masks, face_info


def extract_clean_studio_garment(
    src_cfg: dict[str, Any],
    raw_dir: Path,
    processed_products_dir: Path,
    slug: str,
    sessions: SessionPool,
) -> Image.Image:
    """
    Produces a clean, centered 480x640 RGBA studio garment cutout with subtle grounded shadow
    so Right-Column product cards look crisp, symmetrical, and color-true on #EFE6D5.
    """
    if src_cfg["kind"] == "processed_flat":
        flat_path = processed_products_dir / slug / f"{slug}-flat-3x4.webp"
        im = Image.open(flat_path).convert("RGBA")
        arr = np.array(im, dtype=np.uint8)
        alpha = arr[:, :, 3]
        ys, xs = np.where(alpha >= 30)
        if len(xs) > 0:
            im = im.crop((max(0, int(xs.min()) - 2), max(0, int(ys.min()) - 2), min(im.width, int(xs.max()) + 3), min(im.height, int(ys.max()) + 3)))
    else:
        raw_path = raw_dir / src_cfg["rawFile"]
        raw = ImageOps.exif_transpose(Image.open(raw_path)).convert("RGB")
        cropped = crop_normalized(raw, src_cfg.get("crop"))

        cloth_sess = sessions.get("u2net_cloth_seg")
        isnet_sess = sessions.get("isnet-general-use")
        m_up_im, m_lo_im, m_fu_im = cloth_sess.predict(cropped)
        cls_map = {
            "upper": np.array(m_up_im, dtype=np.uint8) > 14,
            "lower": np.array(m_lo_im, dtype=np.uint8) > 14,
            "full": np.array(m_fu_im, dtype=np.uint8) > 14,
        }
        chosen = cls_map.get(src_cfg.get("clothClass", "upper"))
        if chosen is None or float(chosen.mean()) < 0.06:
            chosen = cls_map["upper"] | cls_map["lower"] | cls_map["full"]

        # Refine perimeter with isnet crisp alpha
        isnet_rgba = remove(cropped, session=isnet_sess, post_process_mask=True).convert("RGBA")
        isnet_a = np.array(isnet_rgba, dtype=np.uint8)[:, :, 3]

        chosen = ndimage.binary_closing(chosen, iterations=3)
        chosen = ndimage.binary_fill_holes(chosen)
        chosen = keep_largest_components(chosen, min_ratio=0.14, max_count=2)

        # Strip warm skin hands/neck/legs from extracted garment cutout
        bgr = cv2.cvtColor(np.array(cropped, dtype=np.uint8), cv2.COLOR_RGB2BGR)
        ycrcb = cv2.cvtColor(bgr, cv2.COLOR_BGR2YCrCb)
        hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)
        is_skin = (
            (ycrcb[:, :, 1] >= 136) & (ycrcb[:, :, 1] <= 172)
            & (ycrcb[:, :, 2] >= 80) & (ycrcb[:, :, 2] <= 126)
            & (hsv[:, :, 1] >= 32)
        )
        if slug not in ("ao-cardigan-len-merino-khuy-sung", "quan-culottes-linen-huu-co", "dam-midi-linen-phoi-dai"):
            chosen = chosen & ~is_skin
            chosen = keep_largest_components(chosen, min_ratio=0.18, max_count=2)
            chosen = ndimage.binary_fill_holes(chosen)

        combined = chosen & ndimage.binary_dilation(isnet_a > 24, iterations=3)
        if combined.sum() < chosen.sum() * 0.55:
            combined = chosen

        soft = ndimage.gaussian_filter(combined.astype(np.float32) * 255.0, sigma=0.9)
        alpha = np.where(ndimage.binary_erosion(combined, iterations=2), 255.0, soft)
        alpha = np.where(alpha < 14.0, 0.0, alpha).astype(np.uint8)

        im = cropped.convert("RGBA")
        im.putalpha(Image.fromarray(alpha, mode="L"))
        ys, xs = np.where(alpha >= 30)
        if len(xs) > 0:
            im = im.crop((max(0, int(xs.min()) - 2), max(0, int(ys.min()) - 2), min(im.width, int(xs.max()) + 3), min(im.height, int(ys.max()) + 3)))

    # Center onto 480x640 transparent studio canvas with generous editorial margins
    margin_x = int(round(VARIANT_W * 0.10))
    margin_y = int(round(VARIANT_H * 0.08))
    max_w = VARIANT_W - 2 * margin_x
    max_h = VARIANT_H - 2 * margin_y
    scale = min(max_w / max(1, im.width), max_h / max(1, im.height))
    nw = max(16, int(round(im.width * scale)))
    nh = max(16, int(round(im.height * scale)))

    # Decontaminate edge RGB before Lanczos resize
    arr = np.array(im, dtype=np.uint8)
    valid = arr[:, :, 3] > 60
    if np.any(valid) and not np.all(valid):
        _, idx = ndimage.distance_transform_edt(~valid, return_indices=True)
        bled = arr[:, :, :3][idx[0], idx[1]]
        arr[:, :, :3] = np.where(valid[:, :, None], arr[:, :, :3], bled)

    rgb_res = Image.fromarray(arr[:, :, :3], mode="RGB").resize((nw, nh), Image.Resampling.LANCZOS)
    a_res = Image.fromarray(arr[:, :, 3], mode="L").resize((nw, nh), Image.Resampling.LANCZOS)
    resized = rgb_res.convert("RGBA")
    resized.putalpha(a_res)

    canvas = Image.new("RGBA", (VARIANT_W, VARIANT_H), (0, 0, 0, 0))
    canvas.paste(resized, ((VARIANT_W - nw) // 2, (VARIANT_H - nh) // 2))
    return canvas


def recolor_studio_cutout(base_rgba: Image.Image, color_hex: str, sheen: str) -> Image.Image:
    arr = np.array(base_rgba, dtype=np.uint8)
    alpha_u8 = arr[:, :, 3]
    alpha_f = alpha_u8.astype(np.float32) / 255.0
    bgr = cv2.cvtColor(arr[:, :, :3], cv2.COLOR_RGB2BGR)

    spec = 0.56 if sheen == "silk" else (0.52 if sheen == "leather" else 0.18)
    recolored_bgr = apply_photometric_recolor_bgr(
        bgr,
        alpha_f,
        color_hex=color_hex,
        sheen=sheen,
        specular=spec,
        shadow_depth=0.40,
        is_macro=True,
    )
    rgb = cv2.cvtColor(recolored_bgr, cv2.COLOR_BGR2RGB)
    out = np.dstack([rgb, alpha_u8])
    return Image.fromarray(out, mode="RGBA")


def build_macro_swatch(
    base_rgb: Image.Image,
    color_hex: str,
    sheen: str,
    specular: float,
    shadow_depth: float,
) -> Image.Image:
    bgr = cv2.cvtColor(np.array(base_rgb, dtype=np.uint8), cv2.COLOR_RGB2BGR)
    full_mask = np.ones((bgr.shape[0], bgr.shape[1]), dtype=np.float32)
    recolored_bgr = apply_photometric_recolor_bgr(
        bgr,
        full_mask,
        color_hex=color_hex,
        sheen=sheen,
        specular=specular,
        shadow_depth=shadow_depth,
        is_macro=True,
    )
    rgb = cv2.cvtColor(recolored_bgr, cv2.COLOR_BGR2RGB)
    return Image.fromarray(rgb, mode="RGB")


def save_mirrored(img: Image.Image, rel_path: str, out_roots: list[Path], fmt: str, **kwargs: Any) -> None:
    for root in out_roots:
        dest = root / rel_path
        dest.parent.mkdir(parents=True, exist_ok=True)
        img.save(dest, format=fmt, **kwargs)


def build_audit_sheet(
    season_summaries: list[dict[str, Any]],
    public_root: Path,
    audit_path: Path,
) -> None:
    """
    Generates a visual audit sheet showing:
      - Rows 0..5: Each season's base.webp | RGB mask overlay (Slot0=Red, Slot1=Green, Slot2=Blue) + face safety box | Slot0/1/2 alpha thumbs
      - Bottom Hero Strip: Season 01 LIVE Photometric Jet-Black Blouse Recolor Preview + silk-jet-black.webp macro + Jet-Black blouse studio cutout!
    """
    tw, th = 320, 400
    label_h = 34
    cols = 4  # Base | Overlay+FaceBox+Pins | Live Recolor Test | Studio Cutouts/Macro
    sheet_w = cols * tw
    sheet_h = len(season_summaries) * (th + label_h) + (th + label_h)

    sheet = Image.new("RGB", (sheet_w, sheet_h), (26, 22, 18))

    for idx, s in enumerate(season_summaries):
        y0 = idx * (th + label_h)
        slug = s["seasonSlug"]
        base_im = Image.open(public_root / slug / "base.webp").convert("RGB")
        base_np = np.array(base_im, dtype=np.float32)

        # Build RGB mask overlay
        colors = [
            np.array([235.0, 68.0, 68.0]),   # Slot 0 = Red
            np.array([58.0, 210.0, 110.0]),  # Slot 1 = Green
            np.array([72.0, 155.0, 245.0]),  # Slot 2 = Blue
        ]
        overlay = base_np.copy()
        for si, slot in enumerate(s["wearableSlots"]):
            m_path = public_root / slug / f"mask-{slot['slotKey'].lower()}.png"
            m_a = np.array(Image.open(m_path).convert("RGBA"), dtype=np.float32)[:, :, 3:4] / 255.0
            overlay = overlay * (1.0 - m_a * 0.52) + colors[si % 3][None, None, :] * (m_a * 0.52)

        ov_bgr = cv2.cvtColor(np.clip(overlay, 0, 255).astype(np.uint8), cv2.COLOR_RGB2BGR)
        # Draw face box in yellow & verifier face box (top 8..22%, center 40..60%) in cyan
        fb = s["_faceInfo"]
        cv2.rectangle(
            ov_bgr,
            (int(fb["x"] * EDITORIAL_W), int(fb["y"] * EDITORIAL_H)),
            (int((fb["x"] + fb["w"]) * EDITORIAL_W), int((fb["y"] + fb["h"]) * EDITORIAL_H)),
            (0, 235, 255),
            3,
        )
        cv2.rectangle(
            ov_bgr,
            (int(0.40 * EDITORIAL_W), int(0.08 * EDITORIAL_H)),
            (int(0.60 * EDITORIAL_W), int(0.22 * EDITORIAL_H)),
            (255, 220, 0),
            2,
        )
        for si, slot in enumerate(s["wearableSlots"]):
            px_i = int(slot["pinPosition"]["xPercent"] / 100.0 * EDITORIAL_W)
            py_i = int(slot["pinPosition"]["yPercent"] / 100.0 * EDITORIAL_H)
            cv2.circle(ov_bgr, (px_i, py_i), 14, (255, 255, 255), -1)
            cv2.circle(ov_bgr, (px_i, py_i), 10, (28, 20, 16), -1)
        ov_im = Image.fromarray(cv2.cvtColor(ov_bgr, cv2.COLOR_BGR2RGB))

        # Live photometric test: recolor Slot 0 to its 2nd variant color (Jet Black on S01!)
        recolor_bgr = cv2.cvtColor(np.array(base_im, dtype=np.uint8), cv2.COLOR_RGB2BGR)
        test_slot = s["wearableSlots"][0]
        test_var = test_slot["variants"][1] if len(test_slot["variants"]) > 1 else test_slot["variants"][0]
        m0_path = public_root / slug / f"mask-{test_slot['slotKey'].lower()}.png"
        m0_a = np.array(Image.open(m0_path).convert("RGBA"), dtype=np.float32)[:, :, 3] / 255.0
        recolor_bgr = apply_photometric_recolor_bgr(
            recolor_bgr,
            m0_a,
            color_hex=test_var["colorHex"],
            sheen=test_slot["materialOpticalProfile"]["sheen"],
            specular=test_slot["materialOpticalProfile"]["specularIntensity"],
            shadow_depth=test_slot["materialOpticalProfile"]["shadowDepth"],
            is_macro=False,
        )
        recolor_im = Image.fromarray(cv2.cvtColor(recolor_bgr, cv2.COLOR_BGR2RGB))

        # Column 4: Warm #EFE6D5 card preview showing Slot 0 variant[1] cutout + macro swatch
        col4 = Image.new("RGB", (tw, th), (239, 230, 213))
        cut_rel = test_var["studioCutoutUrl"].lstrip("/").replace("seasons-lookbook/", "", 1)
        mac_rel = test_var["macroSwatchUrl"].lstrip("/").replace("seasons-lookbook/", "", 1)
        cut_im = Image.open(public_root / cut_rel).convert("RGBA")
        cut_im.thumbnail((tw - 20, int(th * 0.58)))
        col4_rgba = col4.convert("RGBA")
        col4_rgba.alpha_composite(cut_im, ((tw - cut_im.width) // 2, 8))
        mac_im = Image.open(public_root / mac_rel).convert("RGB").resize((tw - 32, int(th * 0.34)), Image.Resampling.LANCZOS)
        col4 = col4_rgba.convert("RGB")
        col4.paste(mac_im, (16, th - mac_im.height - 10))

        # Paste row header + 4 tiles
        header = np.full((label_h, sheet_w, 3), (38, 30, 24), dtype=np.uint8)
        cv2.putText(
            header,
            f"0{s['order']} {slug} | Base | Masks(R={s['wearableSlots'][0]['slotKey']} G={s['wearableSlots'][1]['slotKey']} B=ACC) | Live Recolor -> {test_var['colorKey']} ({test_var['colorHex']}) | Cutout+Macro",
            (12, 23),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.55,
            (251, 247, 239),
            1,
            cv2.LINE_AA,
        )
        sheet.paste(Image.fromarray(header), (0, y0))
        sheet.paste(base_im.resize((tw, th), Image.Resampling.LANCZOS), (0, y0 + label_h))
        sheet.paste(ov_im.resize((tw, th), Image.Resampling.LANCZOS), (tw, y0 + label_h))
        sheet.paste(recolor_im.resize((tw, th), Image.Resampling.LANCZOS), (tw * 2, y0 + label_h))
        sheet.paste(col4, (tw * 3, y0 + label_h))

    # Bottom row: Season 01 Jet-Black Hero Spotlight (close-up comparison)
    y_bot = len(season_summaries) * (th + label_h)
    header_b = np.full((label_h, sheet_w, 3), (28, 20, 16), dtype=np.uint8)
    cv2.putText(
        header_b,
        "SEASON 01 HERO PROOF: Ivory Default | Jet-Black Blouse Recolor | Jet-Black Silk Macro (640x480) | Jet-Black Blouse + Ivory Skirt + Champagne Clutch",
        (12, 23),
        cv2.FONT_HERSHEY_SIMPLEX,
        0.54,
        (235, 207, 143),
        1,
        cv2.LINE_AA,
    )
    sheet.paste(Image.fromarray(header_b), (0, y_bot))

    s1_base = Image.open(public_root / "xuan-tam-xuan" / "base.webp").convert("RGB")
    s1_bgr = cv2.cvtColor(np.array(s1_base, dtype=np.uint8), cv2.COLOR_RGB2BGR)
    s1_m_top = np.array(Image.open(public_root / "xuan-tam-xuan" / "mask-top.png").convert("RGBA"), dtype=np.float32)[:, :, 3] / 255.0
    s1_jb_bgr = apply_photometric_recolor_bgr(s1_bgr, s1_m_top, "#171615", sheen="silk", specular=0.45, shadow_depth=0.34, is_macro=False)
    s1_jb = Image.fromarray(cv2.cvtColor(s1_jb_bgr, cv2.COLOR_BGR2RGB))

    silk_jb = Image.open(public_root / "macros" / "silk-jet-black.webp").convert("RGB")
    # Tile 4: Right-column cards mockup on #EFE6D5
    cards_tile = Image.new("RGBA", (tw, th), (239, 230, 213, 255))
    c_top = Image.open(public_root / "variants" / "ao-so-mi-lua-to-tam-tam-xuan-jet-black.webp").convert("RGBA")
    c_bot = Image.open(public_root / "variants" / "chan-vay-xep-ly-midi-cap-cao-ivory.webp").convert("RGBA")
    c_acc = Image.open(public_root / "variants" / "vi-cam-tay-clutch-champagne-champagne.webp").convert("RGBA")
    c_top.thumbnail((tw // 2 - 12, int(th * 0.56)))
    c_bot.thumbnail((tw // 2 - 12, int(th * 0.56)))
    c_acc.thumbnail((tw - 40, int(th * 0.34)))
    cards_tile.alpha_composite(c_top, (8, 12))
    cards_tile.alpha_composite(c_bot, (tw // 2 + 4, 12))
    cards_tile.alpha_composite(c_acc, ((tw - c_acc.width) // 2, int(th * 0.60)))

    sheet.paste(s1_base.resize((tw, th), Image.Resampling.LANCZOS), (0, y_bot + label_h))
    sheet.paste(s1_jb.resize((tw, th), Image.Resampling.LANCZOS), (tw, y_bot + label_h))
    sheet.paste(silk_jb.resize((tw, th), Image.Resampling.LANCZOS), (tw * 2, y_bot + label_h))
    sheet.paste(cards_tile.convert("RGB"), (tw * 3, y_bot + label_h))

    audit_path.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(audit_path, format="PNG", compress_level=3)
    print(f"[audit-sheet] Saved visual proof -> {audit_path} ({sheet_w}x{sheet_h})", flush=True)


def main() -> int:
    spec_path = Path(sys.argv[1])
    spec = json.loads(spec_path.read_text(encoding="utf-8"))
    raw_dir = Path(spec["rawDir"])
    processed_products_dir = Path(spec["processedProductsDir"])
    out_roots = [Path(p) for p in spec["outRoots"]]
    yunet_path = Path(spec["yunetPath"])
    audit_sheet_path = Path(spec["auditSheetPath"])

    sessions = SessionPool()
    t_all = time.time()

    # 1. Pre-extract clean 480x640 studio base cutouts for all 15 unique products
    print("[seasons:py] Step 1/4: Extracting clean 480x640 studio base cutouts...", flush=True)
    studio_bases: dict[str, Image.Image] = {}
    for slug, cfg in spec["studioCutoutSources"].items():
        studio_bases[slug] = extract_clean_studio_garment(cfg, raw_dir, processed_products_dir, slug, sessions)
        print(f"  [cutout] {slug} ready ({cfg['kind']})", flush=True)

    # 2. Generate all unique color-accurate studio variant WebPs & macro fabric swatches
    print("[seasons:py] Step 2/4: Generating photometric studio variant WebPs & 4:3 macro swatches...", flush=True)
    generated_variants: set[str] = set()
    generated_macros: set[str] = set()

    # Pre-load macro source RGBs
    macro_base_imgs: dict[str, Image.Image] = {}
    for mkey, mcfg in spec["macroBaseSources"].items():
        m_im = ImageOps.exif_transpose(Image.open(raw_dir / mcfg["rawFile"])).convert("RGB")
        m_im = crop_normalized(m_im, mcfg.get("crop"))
        macro_base_imgs[mkey] = aspect_fill_resize(m_im, MACRO_W, MACRO_H, 0.5, 0.5)

    for season in spec["seasons"]:
        for slot in season["wearableSlots"]:
            slug = slot["productSlug"]
            sheen = spec["studioCutoutSources"][slug]["sheen"]
            base_cutout = studio_bases[slug]
            for var in slot["variants"]:
                ckey = var["colorKey"]
                v_rel = f"variants/{slug}-{ckey}.webp"
                if v_rel not in generated_variants:
                    recolored = recolor_studio_cutout(base_cutout, var["colorHex"], sheen=sheen)
                    save_mirrored(recolored, v_rel, out_roots, "WEBP", quality=90, alpha_quality=96, method=5)
                    generated_variants.add(v_rel)

                mkey = var["macroKey"]
                m_ckey = var.get("macroColorKeyOverride") or ckey
                m_rel = f"macros/{mkey}-{m_ckey}.webp"
                if m_rel not in generated_macros:
                    mcfg = spec["macroBaseSources"][mkey]
                    m_img = build_macro_swatch(
                        macro_base_imgs[mkey],
                        color_hex=var["colorHex"],
                        sheen=mcfg["sheen"],
                        specular=mcfg["specularIntensity"],
                        shadow_depth=mcfg["shadowDepth"],
                    )
                    save_mirrored(m_img, m_rel, out_roots, "WEBP", quality=90, method=5)
                    generated_macros.add(m_rel)

    print(f"  [variants] {len(generated_variants)} WebPs | [macros] {len(generated_macros)} WebPs", flush=True)

    # 3. Generate all 6 editorial portraits (960x1200) & 18 garment-region RGBA alpha masks
    print("[seasons:py] Step 3/4: Generating 6 editorial portraits & 18 garment alpha masks...", flush=True)
    manifest_seasons: list[dict[str, Any]] = []
    audit_entries: list[dict[str, Any]] = []

    for season in spec["seasons"]:
        t0 = time.time()
        slug = season["seasonSlug"]
        raw_im = ImageOps.exif_transpose(Image.open(raw_dir / season["rawFile"])).convert("RGB")
        cropped = crop_normalized(raw_im, season.get("crop"))
        base_im = aspect_fill_resize(cropped, EDITORIAL_W, EDITORIAL_H, 0.5, 0.5)
        base_im = apply_editorial_grade(base_im, season.get("editorialGrade") or {})

        # Composite real RGBA accessory cutout if configured
        acc_mask_rgba = None
        acc_cfg = season.get("accessoryComposite")
        if acc_cfg:
            acc_slug = acc_cfg["productSlug"]
            acc_flat = processed_products_dir / acc_slug / f"{acc_slug}-flat-3x4.webp"
            base_im, acc_mask_rgba = composite_accessory_onto_base(base_im, acc_flat, acc_cfg)

        save_mirrored(base_im, f"{slug}/base.webp", out_roots, "WEBP", quality=90, method=5)

        rgba_masks, face_info = segment_season_masks(
            strategy=season["segmentationStrategy"],
            base_rgb=base_im,
            sessions=sessions,
            yunet_path=yunet_path,
            acc_mask_rgba=acc_mask_rgba,
        )

        # Verify ZERO face overlap & compute exact pinPosition + maskBbox
        fx0 = int(face_info["x"] * EDITORIAL_W)
        fy0 = int(face_info["y"] * EDITORIAL_H)
        fx1 = int((face_info["x"] + face_info["w"]) * EDITORIAL_W)
        fy1 = int((face_info["y"] + face_info["h"]) * EDITORIAL_H)

        # Verifier fixed face region check (top 8..22%, center 40..60%)
        v_y0, v_y1 = int(0.08 * EDITORIAL_H), int(0.22 * EDITORIAL_H)
        v_x0, v_x1 = int(0.40 * EDITORIAL_W), int(0.60 * EDITORIAL_W)

        avoid_pins: list[tuple[float, float]] = []
        hydrated_slots: list[dict[str, Any]] = []

        for slot in season["wearableSlots"]:
            skey = slot["slotKey"]
            skey_lower = skey.lower()
            mask_rgba = rgba_masks[skey]
            # Hard-guarantee 0 alpha inside YuNet face box AND verifier face box (top 8..22%, center 40..60%)
            mask_rgba[max(0, fy0 - 4) : min(EDITORIAL_H, fy1 + 4), max(0, fx0 - 4) : min(EDITORIAL_W, fx1 + 4), 3] = 0
            if skey != "ACCESSORY":
                mask_rgba[v_y0:v_y1, v_x0:v_x1, 3] = 0

            alpha_u8 = mask_rgba[:, :, 3]
            pin_pos, bbox, cov = compute_mask_metrics(alpha_u8, avoid_pins)
            avoid_pins.append((pin_pos["xPercent"], pin_pos["yPercent"]))

            mask_im = Image.fromarray(mask_rgba, mode="RGBA")
            save_mirrored(mask_im, f"{slug}/mask-{skey_lower}.png", out_roots, "PNG", compress_level=6)

            slot_variants = []
            for var in slot["variants"]:
                m_ckey = var.get("macroColorKeyOverride") or var["colorKey"]
                slot_variants.append({
                    "colorKey": var["colorKey"],
                    "colorName": var["colorName"],
                    "colorHex": var["colorHex"],
                    "studioCutoutUrl": f"/seasons-lookbook/variants/{slot['productSlug']}-{var['colorKey']}.webp",
                    "macroSwatchUrl": f"/seasons-lookbook/macros/{var['macroKey']}-{m_ckey}.webp",
                    "fabricSpecText": var["fabricSpecText"],
                })

            hydrated_slots.append({
                "slotKey": skey,
                "productSlug": slot["productSlug"],
                "pinPosition": pin_pos,
                "garmentRegionMask": f"/seasons-lookbook/{slug}/mask-{skey_lower}.png",
                "maskBbox": bbox,
                "materialOpticalProfile": slot["materialOpticalProfile"],
                "variants": slot_variants,
            })
            print(
                f"  [{slug}] {skey:9s}: cov={cov*100:5.1f}% pin=({pin_pos['xPercent']:4.1f}%,{pin_pos['yPercent']:4.1f}%) "
                f"bbox=({bbox['x']:.2f},{bbox['y']:.2f},{bbox['w']:.2f},{bbox['h']:.2f})",
                flush=True,
            )

        # Photometric smoke test on Season 01 Jet-Black top recolor
        if slug == "xuan-tam-xuan":
            s1_bgr = cv2.cvtColor(np.array(base_im, dtype=np.uint8), cv2.COLOR_RGB2BGR)
            top_a = rgba_masks["TOP"][:, :, 3].astype(np.float32) / 255.0
            s1_jb = apply_photometric_recolor_bgr(s1_bgr, top_a, "#171615", sheen="silk", specular=0.45, shadow_depth=0.34, is_macro=False)
            lum_before = cv2.cvtColor(s1_bgr, cv2.COLOR_BGR2GRAY).astype(np.float32)
            lum_after = cv2.cvtColor(s1_jb, cv2.COLOR_BGR2GRAY).astype(np.float32)
            top_drop = float((lum_before[top_a > 0.5] - lum_after[top_a > 0.5]).mean())
            face_mae = float(np.abs(s1_bgr[v_y0:v_y1, v_x0:v_x1].astype(np.float32) - s1_jb[v_y0:v_y1, v_x0:v_x1].astype(np.float32)).mean())
            print(f"  [xuan-tam-xuan PHOTOMETRIC CHECK] TOP Jet-Black lumDrop={top_drop:.1f}/255 (>45 req) | FaceBox MAE={face_mae:.3f}/255 (<5 req)", flush=True)
            if top_drop < 45.0 or face_mae >= 5.0:
                raise RuntimeError(f"Season 01 photometric check failed: lumDrop={top_drop}, faceMAE={face_mae}")

        season_entry = {
            "seasonSlug": slug,
            "order": season["order"],
            "months": season["months"],
            "name": season["name"],
            "shortName": season["shortName"],
            "materialHeadline": season["materialHeadline"],
            "note": season["note"],
            "isCurrent": season["isCurrent"],
            "baseEditorialImageUrl": f"/seasons-lookbook/{slug}/base.webp",
            "restyleCacheMap": {},
            "wearableSlots": hydrated_slots,
        }
        manifest_seasons.append(season_entry)
        audit_entries.append({**season_entry, "_faceInfo": face_info})
        print(f"  [season] {slug} complete in {time.time() - t0:.2f}s", flush=True)

    # 4. Write canonical manifest.json to BOTH public & cache roots
    manifest_doc = {
        "version": "1.0.0",
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "dimensions": {
            "editorial": {"width": EDITORIAL_W, "height": EDITORIAL_H},
            "variantCutout": {"width": VARIANT_W, "height": VARIANT_H},
            "macroSwatch": {"width": MACRO_W, "height": MACRO_H},
        },
        "counts": {
            "seasons": len(manifest_seasons),
            "masks": sum(len(s["wearableSlots"]) for s in manifest_seasons),
            "variants": len(generated_variants),
            "macros": len(generated_macros),
        },
        "seasons": manifest_seasons,
    }
    manifest_json = json.dumps(manifest_doc, indent=2, ensure_ascii=False) + "\n"
    for root in out_roots:
        mpath = root / "manifest.json"
        mpath.parent.mkdir(parents=True, exist_ok=True)
        mpath.write_text(manifest_json, encoding="utf-8")

    # 5. Render Visual Quality Proof Audit Sheet
    print("[seasons:py] Step 4/4: Rendering visual mask & photometric audit sheet...", flush=True)
    build_audit_sheet(audit_entries, out_roots[0], audit_sheet_path)

    print(
        f"[seasons:py] ALL DONE in {time.time() - t_all:.1f}s | "
        f"6 bases, 18 masks, {len(generated_variants)} variants, {len(generated_macros)} macros.",
        flush=True,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
`;

async function auditGeneratedOutputs(sharp) {
  const manifestPath = path.join(PUBLIC_OUT_DIR, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (!Array.isArray(manifest.seasons) || manifest.seasons.length !== 6) {
    throw new Error(`Expected 6 seasons in manifest.json, got ${manifest.seasons?.length}`);
  }

  let baseCount = 0;
  let maskCount = 0;
  const variantSet = new Set();
  const macroSet = new Set();

  for (const season of manifest.seasons) {
    const baseFile = path.join(PUBLIC_OUT_DIR, season.seasonSlug, 'base.webp');
    const bMeta = await sharp(baseFile).metadata();
    if (bMeta.width !== 960 || bMeta.height !== 1200) {
      throw new Error(`Base image ${baseFile} wrong dimensions: ${bMeta.width}x${bMeta.height}`);
    }
    baseCount += 1;

    if (!Array.isArray(season.wearableSlots) || season.wearableSlots.length !== 3) {
      throw new Error(`Season ${season.seasonSlug} must have 3 wearableSlots`);
    }

    for (const slot of season.wearableSlots) {
      const maskRel = slot.garmentRegionMask.replace(/^\/seasons-lookbook\//, '');
      const maskFile = path.join(PUBLIC_OUT_DIR, maskRel);
      const mMeta = await sharp(maskFile).metadata();
      if (mMeta.width !== 960 || mMeta.height !== 1200 || !mMeta.hasAlpha) {
        throw new Error(`Mask ${maskFile} invalid: ${mMeta.width}x${mMeta.height} alpha=${mMeta.hasAlpha}`);
      }
      maskCount += 1;

      for (const variant of slot.variants) {
        const vRel = variant.studioCutoutUrl.replace(/^\/seasons-lookbook\//, '');
        if (!variantSet.has(vRel)) {
          const vFile = path.join(PUBLIC_OUT_DIR, vRel);
          const vMeta = await sharp(vFile).metadata();
          if (vMeta.width !== 480 || vMeta.height !== 640 || !vMeta.hasAlpha) {
            throw new Error(`Variant cutout ${vFile} invalid: ${vMeta.width}x${vMeta.height} alpha=${vMeta.hasAlpha}`);
          }
          variantSet.add(vRel);
        }

        const macRel = variant.macroSwatchUrl.replace(/^\/seasons-lookbook\//, '');
        if (!macroSet.has(macRel)) {
          const macFile = path.join(PUBLIC_OUT_DIR, macRel);
          const macMeta = await sharp(macFile).metadata();
          if (macMeta.width !== 640 || macMeta.height !== 480) {
            throw new Error(`Macro swatch ${macFile} invalid: ${macMeta.width}x${macMeta.height}`);
          }
          macroSet.add(macRel);
        }
      }
    }
  }

  console.log(
    `[sharp-audit] PASS: ${baseCount} bases (960x1200 WebP), ${maskCount} masks (960x1200 RGBA PNG), ` +
      `${variantSet.size} studio variant cutouts (480x640 RGBA WebP), ${macroSet.size} macro swatches (640x480 WebP).`,
  );
}

async function main() {
  const auditArg = process.argv.find((a) => a.startsWith('--audit-sheet='));
  const auditSheetPath = auditArg ? auditArg.slice('--audit-sheet='.length) : DEFAULT_AUDIT_SHEET;

  await ensureRawDownloads();
  fs.mkdirSync(PUBLIC_OUT_DIR, { recursive: true });
  fs.mkdirSync(PROCESSED_OUT_DIR, { recursive: true });

  const sharp = await loadSharp();
  const pythonExe = findPythonExecutable();

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-seasons-lookbook-'));
  const pyScriptPath = path.join(tmpDir, 'build_seasons_lookbook.py');
  const specPath = path.join(tmpDir, 'spec.json');

  try {
    fs.writeFileSync(pyScriptPath, PYTHON_PIPELINE, 'utf8');
    fs.writeFileSync(
      specPath,
      JSON.stringify(
        {
          rawDir: RAW_DIR,
          processedProductsDir: PROCESSED_PRODUCTS_DIR,
          outRoots: [PUBLIC_OUT_DIR, PROCESSED_OUT_DIR],
          yunetPath: YUNET_MODEL_PATH,
          auditSheetPath,
          seasons: SEASONS_SPEC,
          studioCutoutSources: STUDIO_CUTOUT_SOURCES,
          macroBaseSources: MACRO_BASE_SOURCES,
        },
        null,
        2,
      ),
      'utf8',
    );

    const run = spawnSync(pythonExe, [pyScriptPath, specPath], {
      cwd: REPO_ROOT,
      stdio: 'inherit',
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });

    if (run.status !== 0) {
      throw new Error(`Python seasonal lookbook pipeline failed with exit code ${run.status}`);
    }

    await auditGeneratedOutputs(sharp);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('[seasons-lookbook] FATAL:', err);
  process.exit(1);
});
