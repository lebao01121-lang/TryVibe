#!/usr/bin/env node
/**
 * `#seasons` Flagship Vitrine — Local Real Photography Pipeline
 * ---------------------------------------------------------------------------
 * Builds 100% REAL fashion & textile photography assets under:
 *   `apps/storefront/public/images/seasons-vitrine/`
 *
 * Deliverables:
 *   1. `lookbooks/<seasonSlug>-base.webp` — 6 editorial heroes (4:5, 960x1200 WebP)
 *   2. `masks/<seasonSlug>-mask-<slot>.png` — 18 feathered garment region masks (960x1200 RGBA PNG, 0% face/skin bleed)
 *   3. `macros/<fabricKey>-<colorKey>.webp` — 23 real textile macro swatches (4:3, 800x600 WebP)
 *   4. `variants/<productSlug>-<colorKey>.webp` + `variants/<productSlug>-default.webp`
 *      — 63 studio product & accessory cards on warm Atelier cream backdrop (3:4, 720x960 WebP)
 *   5. `manifest.json` — canonical metadata with exact neural `pinPosition` & `maskBbox`
 *   6. Visual proof contact sheet (`--contact-sheet=<path>`)
 *
 * Usage:
 *   node scripts/prepare-seasons-vitrine-assets.mjs
 *   node scripts/prepare-seasons-vitrine-assets.mjs --contact-sheet=C:/path/to/seasons-assets-check.png
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
const OCCASION_MACRO_DIR = path.join(REPO_ROOT, 'apps', 'storefront', 'public', 'occasion-macro');
const PUBLIC_VITRINE_DIR = path.join(REPO_ROOT, 'apps', 'storefront', 'public', 'images', 'seasons-vitrine');
const YUNET_MODEL_PATH = path.join(
  REPO_ROOT,
  'services',
  'ai-tryon',
  'app',
  'preprocessing',
  'models',
  'face_detection_yunet_2023mar.onnx',
);

const DEFAULT_CONTACT_SHEET =
  'C:\\Users\\Admin\\.gemini\\antigravity\\brain\\d1783908-6521-4608-8b37-41aae3ee9a65\\scratch\\seasons-assets-check.png';

/**
 * Canonical 6 Vietnamese Seasons — aligned 1-to-1 with
 * `services/catalog-lookbook/src/seasons/season-lookbook-data.ts`.
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
            preserveOriginal: true,
            harmonyBlend: 0.10,
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
            preserveOriginal: true,
            harmonyBlend: 0.14,
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
            preserveOriginal: true,
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
            preserveOriginal: true,
            harmonyBlend: 0.10,
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
            preserveOriginal: true,
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
            preserveOriginal: true,
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
            preserveOriginal: true,
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
            preserveOriginal: true,
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
            preserveOriginal: true,
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
    accessoryComposite: null,
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
            preserveOriginal: true,
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
            preserveOriginal: true,
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
            preserveOriginal: true,
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
            preserveOriginal: true,
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
            preserveOriginal: true,
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
            preserveOriginal: true,
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
            preserveOriginal: true,
            harmonyBlend: 0.12,
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
            preserveOriginal: true,
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
            preserveOriginal: true,
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
 * Clean ghost-mannequin / flat-lay studio product cutouts (all 15 unique products).
 * Every product has a museum-grade clean RGBA flat-3x4.webp on disk.
 * Accessories use `isAccessory: true` so they sit centered inside the 4:3 middle safe band
 * of the 720x960 (3:4) studio card (zero clipping in both 3:4 and 4:3 `object-fit: cover` frames!).
 */
const PRODUCT_CARD_SOURCES = {
  'ao-so-mi-lua-to-tam-tam-xuan': { sheen: 'silk', isAccessory: false, defaultColorKey: 'ivory' },
  'chan-vay-xep-ly-midi-cap-cao': { sheen: 'silk', isAccessory: false, defaultColorKey: 'ivory' },
  'vi-cam-tay-clutch-champagne': { sheen: 'leather', isAccessory: true, defaultColorKey: 'champagne' },
  'ao-so-mi-lua-to-tam-bao-loc': { sheen: 'linen', isAccessory: false, defaultColorKey: 'ivory' },
  'quan-culottes-linen-huu-co': { sheen: 'linen', isAccessory: false, defaultColorKey: 'sand' },
  'khan-lua-hoa-tiet-tam-xuan': { sheen: 'silk', isAccessory: true, defaultColorKey: 'ivory' },
  'dam-midi-linen-phoi-dai': { sheen: 'linen', isAccessory: false, defaultColorKey: 'sand' },
  'ao-cardigan-len-merino-khuy-sung': {
    sheen: 'tweed',
    isAccessory: false,
    defaultColorKey: 'ivory',
    cleanInnerCreamGap: true,
  },
  'ao-blazer-linen-dang-suong': { sheen: 'linen', isAccessory: false, defaultColorKey: 'sand' },
  'quan-tay-ong-suong-xep-ly-doi': { sheen: 'tweed', isAccessory: false, defaultColorKey: 'charcoal' },
  'that-lung-da-khoa-dong': { sheen: 'leather', isAccessory: true, defaultColorKey: 'espresso' },
  'ao-len-cashmere-co-lo': { sheen: 'tweed', isAccessory: false, defaultColorKey: 'ivory' },
  'ao-khoac-tweed-det-thu-cong': { sheen: 'tweed', isAccessory: false, defaultColorKey: 'ivory' },
  'dam-du-tiec-lua-satin-co-do': { sheen: 'silk', isAccessory: false, defaultColorKey: 'wine-red' },
  'ao-kieu-lua-organza-phoi-no': {
    sheen: 'silk',
    isAccessory: false,
    defaultColorKey: 'champagne',
    trimBottomPx: 22,
  },
};

/**
 * Real high-resolution macro textile photography sources.
 * Prefers full-res raw originals with fallback to `apps/storefront/public/occasion-macro/*.webp`.
 */
const MACRO_BASE_SOURCES = {
  silk: {
    rawFile: 'macro-silk-satin-champagne.jpg',
    fallbackMacro: 'silk-satin-champagne.webp',
    crop: [0.06, 0.04, 0.94, 0.96],
    sheen: 'silk',
    specularIntensity: 0.62,
    shadowDepth: 0.42,
  },
  'pleated-silk': {
    rawFile: 'atelier-step1-silk-folds.jpg',
    fallbackMacro: 'pleated-silk.webp',
    crop: [0.04, 0.14, 0.96, 0.88],
    sheen: 'silk',
    specularIntensity: 0.48,
    shadowDepth: 0.44,
  },
  linen: {
    rawFile: 'macro-organic-linen.jpg',
    fallbackMacro: 'organic-linen.webp',
    crop: [0.05, 0.12, 0.95, 0.88],
    sheen: 'linen',
    specularIntensity: 0.16,
    shadowDepth: 0.34,
  },
  tweed: {
    rawFile: 'prod-11-artisan-tweed-jacket-woven.jpg',
    fallbackMacro: 'artisan-tweed.webp',
    crop: [0.20, 0.24, 0.72, 0.66],
    sheen: 'tweed',
    specularIntensity: 0.18,
    shadowDepth: 0.40,
  },
  leather: {
    rawFile: 'macro-silk-pearl-cuff.jpg',
    fallbackMacro: 'silk-pearl-cuff.webp',
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
  throw new Error('Could not load sharp for seasons vitrine asset verification.');
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
  throw new Error('Could not find Python executable with OpenCV/PIL/rembg.');
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
from PIL import Image, ImageEnhance, ImageOps
from rembg import new_session, remove
from scipy import ndimage

EDITORIAL_W = 960
EDITORIAL_H = 1200
VARIANT_W = 720
VARIANT_H = 960
MACRO_W = 800
MACRO_H = 600

URL_PREFIX = "/images/seasons-vitrine"


class SessionPool:
    def __init__(self) -> None:
        self._sessions: dict[str, Any] = {}

    def get(self, name: str) -> Any:
        if name not in self._sessions:
            t0 = time.time()
            self._sessions[name] = new_session(name)
            print(f"[vitrine:py] loaded rembg '{name}' in {time.time() - t0:.2f}s", flush=True)
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


def aspect_fill_resize(
    img: Image.Image,
    target_w: int,
    target_h: int,
    bias_x: float = 0.5,
    bias_y: float = 0.5,
) -> Image.Image:
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


def build_atelier_studio_backdrop(w: int, h: int) -> Image.Image:
    """
    Subtle warm Atelier studio cream backdrop (#EFE6D5 base with soft warm radial glow
    #F6EFE2 at upper-center and refined studio vignette #E6DAC4 toward corners).
    """
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    nx = (xx / float(w) - 0.50) * 1.65
    ny = (yy / float(h) - 0.44) * 1.55
    dist = np.sqrt(nx * nx + ny * ny)
    t = np.clip(dist / 1.25, 0.0, 1.0)
    t = t * t * (3.0 - 2.0 * t)  # smoothstep

    center_rgb = np.array([245.0, 238.0, 224.0], dtype=np.float32)  # #F5EEE0
    edge_rgb = np.array([232.0, 221.0, 201.0], dtype=np.float32)    # #E8DDC9
    bg = center_rgb[None, None, :] * (1.0 - t[:, :, None]) + edge_rgb[None, None, :] * t[:, :, None]
    return Image.fromarray(np.clip(np.round(bg), 0, 255).astype(np.uint8), mode="RGB")


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
    Perceptual CIE-LAB photometric fabric recoloring preserving 100% of natural fold
    shading, pleats, buttons, & micro-weave with realistic specular luster on dark silk.
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
    h, w = bgr.shape[:2]
    excl = np.zeros((h, w), dtype=bool)
    face_info = {"x": 0.42, "y": 0.10, "w": 0.16, "h": 0.14}

    det = cv2.FaceDetectorYN.create(str(yunet_path), "", (w, h), 0.40, 0.3, 5000)
    _, faces = det.detect(bgr)

    ycrcb = cv2.cvtColor(bgr, cv2.COLOR_BGR2YCrCb).astype(np.float32)
    hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV).astype(np.float32)

    if faces is not None and len(faces) > 0:
        best = max(faces, key=lambda f: float(f[2] * f[3]) * float(f[-1]))
        fx, fy, fw, fh = [float(v) for v in best[:4]]
        face_info = {"x": fx / w, "y": fy / h, "w": fw / w, "h": fh / h}

        cx = int(round(fx + fw * 0.5))
        head_cy = int(round(fy + fh * 0.35))
        head_rx = int(round(fw * 0.78))
        head_ry = int(round(fh * 0.92))
        excl_u8 = np.zeros((h, w), dtype=np.uint8)
        cv2.ellipse(excl_u8, (cx, head_cy), (head_rx, head_ry), 0, 0, 360, 255, -1)

        x0 = max(0, int(math.floor(fx)) - 10)
        y0 = max(0, int(math.floor(fy)) - 16)
        x1 = min(w, int(math.ceil(fx + fw)) + 10)
        y1 = min(h, int(math.ceil(fy + fh)) + 12)
        excl_u8[y0:y1, x0:x1] = 255

        neck_top = int(round(fy + fh * 0.85))
        neck_bot = min(h, int(round(fy + fh * (1.0 + exclude_neck_extra))))
        neck_rx = int(round(fw * 0.46))
        cv2.ellipse(
            excl_u8,
            (cx, int((neck_top + neck_bot) * 0.5)),
            (neck_rx, max(8, (neck_bot - neck_top) // 2 + 6)),
            0,
            0,
            360,
            255,
            -1,
        )

        sx0 = max(0, int(round(fx + fw * 0.22)))
        sx1 = min(w, int(round(fx + fw * 0.78)))
        sy0 = max(0, int(round(fy + fh * 0.25)))
        sy1 = min(h, int(round(fy + fh * 0.75)))
        patch_ycrcb = ycrcb[sy0:sy1, sx0:sx1]
        cr_med = float(np.median(patch_ycrcb[:, :, 1]))
        cb_med = float(np.median(patch_ycrcb[:, :, 2]))
        y_med = float(np.median(patch_ycrcb[:, :, 0]))

        d_cr = (ycrcb[:, :, 1] - cr_med) / (11.5 * skin_threshold_scale)
        d_cb = (ycrcb[:, :, 2] - cb_med) / (11.5 * skin_threshold_scale)
        d_y = np.abs(ycrcb[:, :, 0] - y_med) / (68.0 * skin_threshold_scale)
        cr_floor = max(133.5, cr_med - 11.0 * skin_threshold_scale)
        adaptive_skin = (
            human_mask
            & ((d_cr * d_cr + d_cb * d_cb) <= 1.25)
            & (d_y <= 1.0)
            & (ycrcb[:, :, 1] >= cr_floor)
            & (ycrcb[:, :, 2] <= min(132.0, cb_med + 11.5 * skin_threshold_scale))
            & (hsv[:, :, 1] >= 22.0)
        )
        adaptive_skin = ndimage.binary_opening(adaptive_skin, iterations=1)
        adaptive_skin = ndimage.binary_dilation(adaptive_skin, iterations=2)

        head_top_y = max(0, int(round(fy - fh * 0.65)))
        hair_band_bot = min(h, int(round(fy + fh * (1.0 + exclude_hair_below))))
        dark_hair = (
            human_mask
            & (ycrcb[:, :, 0] < max(78.0, y_med * 0.52))
            & (np.arange(h)[:, None] >= head_top_y)
            & (np.arange(h)[:, None] <= hair_band_bot)
            & (np.abs(np.arange(w)[None, :] - cx) <= int(fw * 1.45))
        )
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
    h, w = mask_bool.shape
    mask_clean = ndimage.binary_fill_holes(mask_bool)
    soft = ndimage.gaussian_filter(mask_clean.astype(np.float32) * 255.0, sigma=feather_sigma)
    core = ndimage.binary_erosion(mask_clean, iterations=2)
    alpha = np.where(core, np.maximum(soft, 255.0), soft)
    alpha = np.where(alpha < 8.0, 0.0, alpha)
    alpha_u8 = np.clip(np.round(alpha), 0, 255).astype(np.uint8)

    rgba = np.zeros((h, w, 4), dtype=np.uint8)
    rgba[:, :, :3] = 255
    rgba[:, :, 3] = alpha_u8
    return rgba


def compute_mask_metrics(
    alpha_u8: np.ndarray,
    avoid_points: list[tuple[float, float]],
) -> tuple[dict[str, float], dict[str, float], float]:
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

    dist = ndimage.distance_transform_edt(solid)
    best_y, best_x = np.unravel_index(int(np.argmax(dist)), dist.shape)
    px_pct = best_x / float(w) * 100.0
    py_pct = best_y / float(h) * 100.0

    for _ in range(3):
        too_close = any(math.hypot(px_pct - ax, py_pct - ay) < 11.0 for ax, ay in avoid_points)
        if not too_close:
            break
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
    acc = Image.open(acc_rgba_path).convert("RGBA")
    arr = np.array(acc, dtype=np.uint8)
    ys, xs = np.where(arr[:, :, 3] >= 35)
    if len(xs) == 0:
        raise ValueError(f"Empty accessory alpha in {acc_rgba_path}")
    acc = acc.crop((
        max(0, int(xs.min()) - 2),
        max(0, int(ys.min()) - 2),
        min(acc.width, int(xs.max()) + 3),
        min(acc.height, int(ys.max()) + 3),
    ))

    target_w = max(80, int(round(EDITORIAL_W * float(cfg["widthRatio"]))))
    scale = target_w / float(acc.width)
    target_h = max(60, int(round(acc.height * scale)))
    acc = acc.resize((target_w, target_h), Image.Resampling.LANCZOS)

    angle = float(cfg.get("angleDeg", 0.0))
    if abs(angle) > 0.1:
        acc = acc.rotate(angle, resample=Image.Resampling.BICUBIC, expand=True)

    cx = int(round(EDITORIAL_W * float(cfg["anchorCenterX"])))
    cy = int(round(EDITORIAL_H * float(cfg["anchorCenterY"])))
    paste_x = max(12, min(EDITORIAL_W - acc.width - 12, cx - acc.width // 2))
    paste_y = max(12, min(EDITORIAL_H - acc.height - 12, cy - acc.height // 2))

    acc_arr = np.array(acc, dtype=np.uint8)
    shadow_alpha = ndimage.gaussian_filter(acc_arr[:, :, 3].astype(np.float32), sigma=10.0)
    shadow_alpha = np.clip(shadow_alpha * float(cfg.get("shadowOpacity", 0.30)), 0, 255).astype(np.uint8)
    shadow_layer = Image.new("RGBA", (EDITORIAL_W, EDITORIAL_H), (0, 0, 0, 0))
    sh_patch = np.zeros((acc.height, acc.width, 4), dtype=np.uint8)
    sh_patch[:, :, 0] = 28
    sh_patch[:, :, 1] = 20
    sh_patch[:, :, 2] = 14
    sh_patch[:, :, 3] = shadow_alpha
    shadow_layer.paste(
        Image.fromarray(sh_patch, mode="RGBA"),
        (min(EDITORIAL_W - acc.width, paste_x + 6), min(EDITORIAL_H - acc.height, paste_y + 10)),
    )

    base_arr = np.array(base_rgb, dtype=np.float32)
    roi = base_arr[
        max(0, paste_y - 20) : min(EDITORIAL_H, paste_y + acc.height + 20),
        max(0, paste_x - 20) : min(EDITORIAL_W, paste_x + acc.width + 20),
    ]
    roi_mean = roi.mean(axis=(0, 1)) if roi.size else np.array([150.0, 140.0, 128.0])
    acc_f = acc_arr.astype(np.float32)
    warm_tint = roi_mean / max(1.0, float(roi_mean.mean()))
    warm_tint = 1.0 + (warm_tint - 1.0) * 0.25
    acc_f[:, :, :3] = np.clip(acc_f[:, :, :3] * warm_tint[None, None, :], 0, 255)
    acc_matched = Image.fromarray(np.round(acc_f).astype(np.uint8), mode="RGBA")

    fg_layer = Image.new("RGBA", (EDITORIAL_W, EDITORIAL_H), (0, 0, 0, 0))
    fg_layer.paste(acc_matched, (paste_x, paste_y))

    comp = base_rgb.convert("RGBA")
    comp = Image.alpha_composite(comp, shadow_layer)
    comp = Image.alpha_composite(comp, fg_layer)

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
    bgr = cv2.cvtColor(np.array(base_rgb, dtype=np.uint8), cv2.COLOR_RGB2BGR)
    lab = cv2.cvtColor(bgr, cv2.COLOR_BGR2LAB).astype(np.float32)
    h, w = bgr.shape[:2]
    yy, xx = np.mgrid[0:h, 0:w]
    yn = yy / float(h)
    xn = xx / float(w)

    human_sess = sessions.get("u2net_human_seg")
    human_rgba = remove(base_rgb, session=human_sess, post_process_mask=True).convert("RGBA")
    human_alpha = np.array(human_rgba, dtype=np.uint8)[:, :, 3]
    human_mask = human_alpha >= 80

    cloth_sess = sessions.get("u2net_cloth_seg")
    m_up_im, m_lo_im, m_fu_im = cloth_sess.predict(base_rgb)
    m_up = np.array(m_up_im, dtype=np.uint8) > 16
    m_lo = np.array(m_lo_im, dtype=np.uint8) > 16
    m_fu = np.array(m_fu_im, dtype=np.uint8) > 16

    human_dil = ndimage.binary_dilation(human_mask, iterations=4)
    m_up = ndimage.binary_closing(m_up & human_dil, iterations=2)
    m_lo = ndimage.binary_closing(m_lo & human_dil, iterations=2)
    m_fu = ndimage.binary_closing(m_fu & human_dil, iterations=2)

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
        hair_below = 0.75

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
        attire = (m_up | m_lo | m_fu) & human_mask & ~excl
        top_raw = m_up & human_mask & ~excl & (yn <= 0.62)
        if top_raw.sum() < 15_000:
            top_raw = attire & (yn >= 0.25) & (yn <= 0.57)
        top_raw = keep_largest_components(top_raw, min_ratio=0.12, max_count=2)
        top_raw = ndimage.binary_fill_holes(top_raw) & ~excl

        ys_top = np.where(top_raw)[0]
        waist_y = float(np.percentile(ys_top, 95)) / float(h) if len(ys_top) else 0.56
        bot_raw = (m_lo | (attire & (yn >= waist_y - 0.03))) & ~top_raw & ~excl
        bot_raw &= (yn >= waist_y - 0.04) & (yn <= 0.94) & (xn >= 0.14) & (xn <= 0.78)
        bot_raw &= ~((xn > 0.68) & (yn < 0.72))
        bot_raw = keep_largest_components(bot_raw, min_ratio=0.15, max_count=2)
        bot_raw = ndimage.binary_fill_holes(bot_raw) & ~top_raw & ~excl

        masks_bool["TOP"] = top_raw & ~acc_dil
        masks_bool["BOTTOM"] = bot_raw & ~acc_dil
        masks_bool["ACCESSORY"] = acc_bool

    elif strategy == "s02_sunlit_linen_trousers":
        top_raw = m_up & human_mask & ~excl & (yn <= 0.64)
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
        attire = (m_up | m_lo | m_fu) & human_mask & ~excl & (yn >= 0.34)
        is_dress_color = (lab[:, :, 0] >= 158.0) & (lab[:, :, 2] <= 134.5) & (xn >= 0.25) & (xn <= 0.78)
        dress_raw = attire & is_dress_color
        dress_raw = ndimage.binary_closing(dress_raw, iterations=4)
        dress_raw = keep_largest_components(dress_raw, min_ratio=0.15, max_count=1)
        dress_raw = ndimage.binary_fill_holes(dress_raw) & ~excl

        cardigan_raw = (
            attire
            | (human_mask & (yn >= 0.36) & (lab[:, :, 2] >= 136.0) & (lab[:, :, 0] >= 55.0) & (lab[:, :, 0] <= 215.0))
        ) & ~dress_raw & ~excl
        cardigan_raw = ndimage.binary_closing(cardigan_raw, iterations=3)
        cardigan_raw = keep_largest_components(cardigan_raw, min_ratio=0.10, max_count=2)
        cardigan_raw = ndimage.binary_fill_holes(cardigan_raw) & ~dress_raw & ~excl

        masks_bool["ONE_PIECE"] = dress_raw & ~acc_dil
        masks_bool["OUTERWEAR"] = cardigan_raw & ~acc_dil
        masks_bool["ACCESSORY"] = acc_bool

    elif strategy == "s04_tailored_blazer_trousers_belt":
        # Re-build strict face/head/neck + hands-only exclusion so warm sand-beige blazer is NEVER eaten as skin!
        strict_excl, face_info = detect_face_and_skin_exclusion(
            bgr,
            human_mask=human_mask,
            yunet_path=yunet_path,
            exclude_neck_extra=0.45,
            exclude_hair_below=0.20,
            skin_threshold_scale=0.72,
        )
        # Keep full head/neck exclusion above collar (yn < 0.31) + right-hand over hip (xn > 0.56 & yn in 0.58..0.79) + left fingers (xn in 0.36..0.49 & yn in 0.77..0.90)
        head_band = yn <= 0.31
        hands_band = (
            ((xn >= 0.56) & (xn <= 0.75) & (yn >= 0.58) & (yn <= 0.79))
            | ((xn >= 0.36) & (xn <= 0.50) & (yn >= 0.77) & (yn <= 0.90))
        )
        excl = (strict_excl & (head_band | hands_band))

        # Detect the genuine dark brown leather belt cleanly across waist seam (y in 0.57..0.67, x in 0.42..0.69)
        waist_roi = human_mask & (yn >= 0.57) & (yn <= 0.67) & (xn >= 0.42) & (xn <= 0.69)
        belt_raw = waist_roi & (lab[:, :, 0] < 118.0) & ~excl
        belt_raw = ndimage.binary_closing(belt_raw, iterations=3)
        belt_raw = keep_largest_components(belt_raw, min_ratio=0.15, max_count=2)
        belt_raw = ndimage.binary_dilation(belt_raw, iterations=2) & human_mask & ~excl
        if belt_raw.sum() >= 300:
            belt_ys = np.where(belt_raw)[0]
            belt_mid_y = float(belt_ys.mean()) / float(h)
        else:
            belt_mid_y = 0.625
            belt_raw = waist_roi & (yn >= 0.605) & (yn <= 0.645)

        belt_dil = ndimage.binary_dilation(belt_raw, iterations=1)
        # Outerwear blazer: u2net upper (or human_mask upper torso above trousers) minus face/neck/hands/belt
        outer_raw = (m_up | (m_fu & (yn <= belt_mid_y + 0.16))) & human_mask & ~excl & ~belt_dil
        # Exclude lower trousers below belt inside waist-to-hem region (ivory bright trousers L > 185 & b* < 140 below belt_mid_y)
        trouser_zone = m_lo & human_mask & (yn >= belt_mid_y) & (xn >= 0.41) & (xn <= 0.74)
        outer_raw = outer_raw & ~trouser_zone
        outer_raw = ndimage.binary_closing(outer_raw, iterations=3)
        outer_raw = keep_largest_components(outer_raw, min_ratio=0.10, max_count=2)
        outer_raw = ndimage.binary_fill_holes(outer_raw) & ~excl & ~belt_dil

        # Ivory pleated trousers cleanly below belt seam
        bot_raw = (m_lo & human_mask & (yn >= belt_mid_y - 0.01)) & ~outer_raw & ~belt_dil & ~excl
        if bot_raw.sum() < 20_000:
            bot_raw = (m_lo | m_fu) & human_mask & (yn >= belt_mid_y) & ~outer_raw & ~belt_dil & ~excl
        bot_raw = ndimage.binary_closing(bot_raw, iterations=3)
        bot_raw = keep_largest_components(bot_raw, min_ratio=0.12, max_count=2)
        bot_raw = ndimage.binary_fill_holes(bot_raw) & ~outer_raw & ~belt_dil & ~excl

        masks_bool["OUTERWEAR"] = outer_raw
        masks_bool["BOTTOM"] = bot_raw
        masks_bool["ACCESSORY"] = belt_raw

    elif strategy == "s05_tweed_knit_gallery":
        upper_all = (m_up | (m_fu & (yn <= 0.78))) & human_mask & ~excl & (yn >= 0.24) & (yn <= 0.86)
        inner_color = (
            (lab[:, :, 0] < 96.0)
            & (lab[:, :, 2] < 127.0)
            & (xn >= 0.28)
            & (xn <= 0.62)
            & (yn >= 0.26)
            & (yn <= 0.70)
        )
        top_raw = upper_all & inner_color
        top_raw = ndimage.binary_closing(top_raw, iterations=3)
        top_raw = keep_largest_components(top_raw, min_ratio=0.15, max_count=1)
        top_raw = ndimage.binary_fill_holes(top_raw) & ~excl

        outer_raw = upper_all & ~top_raw & ~excl
        outer_raw = ndimage.binary_closing(outer_raw, iterations=3)
        outer_raw = keep_largest_components(outer_raw, min_ratio=0.10, max_count=2)
        outer_raw = ndimage.binary_fill_holes(outer_raw) & ~top_raw & ~excl

        masks_bool["TOP"] = top_raw & ~acc_dil
        masks_bool["OUTERWEAR"] = outer_raw & ~acc_dil
        masks_bool["ACCESSORY"] = acc_bool

    elif strategy == "s06_evening_satin_gown_wrap":
        satin_all = ((m_up | m_lo | m_fu) | (human_mask & (lab[:, :, 1] >= 150.0))) & human_mask & ~excl & (yn >= 0.30)
        satin_all &= lab[:, :, 1] >= 142.0
        satin_all = ndimage.binary_closing(satin_all, iterations=3)
        satin_all = keep_largest_components(satin_all, min_ratio=0.08, max_count=2)

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

    rgba_masks: dict[str, np.ndarray] = {}
    for slot_key, mb in masks_bool.items():
        if slot_key == "ACCESSORY" and acc_mask_rgba is not None:
            rgba_masks[slot_key] = acc_mask_rgba
        else:
            rgba_masks[slot_key] = feather_mask_to_rgba(mb, feather_sigma=1.15)

    return rgba_masks, face_info


def prepare_clean_product_cutout(
    processed_products_dir: Path,
    slug: str,
    cfg: dict[str, Any],
) -> Image.Image:
    """
    Loads clean RGBA flat-3x4 cutout, removes optional stray fringe/gap,
    decontaminates edge RGB, and returns tightly cropped high-res RGBA cutout.
    """
    flat_path = processed_products_dir / slug / f"{slug}-flat-3x4.webp"
    if not flat_path.exists():
        flat_path = processed_products_dir / slug / f"{slug}-rack-2x3.webp"
    im = Image.open(flat_path).convert("RGBA")
    arr = np.array(im, dtype=np.uint8)

    if cfg.get("cleanInnerCreamGap"):
        # Clean smooth flat pale-cream gap between left sleeve and torso on cardigan flat cutout
        rgb_f = arr[:, :, :3].astype(np.float32)
        gray = 0.299 * rgb_f[:, :, 0] + 0.587 * rgb_f[:, :, 1] + 0.114 * rgb_f[:, :, 2]
        blur_g = cv2.GaussianBlur(gray, (9, 9), 0)
        local_var = cv2.GaussianBlur((gray - blur_g) ** 2, (9, 9), 0)
        h_im, w_im = gray.shape
        yy, xx = np.mgrid[0:h_im, 0:w_im]
        # Only target smooth uniform bright cream strip in inner-left arm gap
        smooth_cream = (
            (arr[:, :, 3] > 20)
            & (gray > 235.0)
            & (local_var < 12.0)
            & (xx > int(w_im * 0.18))
            & (xx < int(w_im * 0.34))
            & (yy > int(h_im * 0.28))
            & (yy < int(h_im * 0.72))
        )
        smooth_cream = ndimage.binary_dilation(smooth_cream, iterations=2)
        arr[smooth_cream, 3] = 0

    alpha = arr[:, :, 3]
    ys, xs = np.where(alpha >= 28)
    if len(xs) == 0:
        raise ValueError(f"Empty cutout alpha for {slug}")
    y1 = int(ys.max()) + 1
    trim_bottom = int(cfg.get("trimBottomPx", 0))
    if trim_bottom > 0 and (y1 - int(ys.min())) > trim_bottom + 60:
        y1 = max(int(ys.min()) + 60, y1 - trim_bottom)

    x0 = max(0, int(xs.min()) - 2)
    y0 = max(0, int(ys.min()) - 2)
    x1 = min(arr.shape[1], int(xs.max()) + 3)
    y1 = min(arr.shape[0], y1)

    cropped = arr[y0:y1, x0:x1].copy()
    valid = cropped[:, :, 3] > 60
    if np.any(valid) and not np.all(valid):
        _, idx = ndimage.distance_transform_edt(~valid, return_indices=True)
        bled = cropped[:, :, :3][idx[0], idx[1]]
        cropped[:, :, :3] = np.where(valid[:, :, None], cropped[:, :, :3], bled)

    return Image.fromarray(cropped, mode="RGBA")


def render_studio_variant_card(
    cutout_rgba: Image.Image,
    backdrop_rgb: Image.Image,
    color_hex: str,
    sheen: str,
    is_accessory: bool,
    preserve_original: bool = False,
    harmony_blend: float = 0.0,
) -> Image.Image:
    """
    Photometrically recolors opaque garment pixels (or preserves original when default
    color matches) and composites cleanly centered onto the 720x960 Atelier cream studio
    backdrop with soft grounded drop shadow.
    """
    arr = np.array(cutout_rgba, dtype=np.uint8)
    alpha_u8 = arr[:, :, 3]
    alpha_f = alpha_u8.astype(np.float32) / 255.0
    orig_rgb = arr[:, :, :3]

    if preserve_original:
        if harmony_blend > 0.01:
            bgr = cv2.cvtColor(orig_rgb, cv2.COLOR_RGB2BGR)
            spec = 0.50 if sheen == "silk" else (0.48 if sheen == "leather" else 0.18)
            recol_bgr = apply_photometric_recolor_bgr(
                bgr,
                alpha_f,
                color_hex=color_hex,
                sheen=sheen,
                specular=spec,
                shadow_depth=0.38,
                is_macro=True,
            )
            recol_rgb = cv2.cvtColor(recol_bgr, cv2.COLOR_BGR2RGB).astype(np.float32)
            blended = orig_rgb.astype(np.float32) * (1.0 - harmony_blend) + recol_rgb * harmony_blend
            final_rgb = np.clip(np.round(blended), 0, 255).astype(np.uint8)
        else:
            final_rgb = orig_rgb
    else:
        bgr = cv2.cvtColor(orig_rgb, cv2.COLOR_RGB2BGR)
        spec = 0.56 if sheen == "silk" else (0.52 if sheen == "leather" else 0.18)
        recol_bgr = apply_photometric_recolor_bgr(
            bgr,
            alpha_f,
            color_hex=color_hex,
            sheen=sheen,
            specular=spec,
            shadow_depth=0.40,
            is_macro=True,
        )
        final_rgb = cv2.cvtColor(recol_bgr, cv2.COLOR_BGR2RGB)

    # Fit cleanly centered inside 720x960 (accessories stay inside middle 4:3 safe band!)
    if is_accessory:
        max_w = int(round(VARIANT_W * 0.80))
        max_h = int(round(VARIANT_H * 0.46))  # strictly inside 720x540 center 4:3 band!
    else:
        max_w = int(round(VARIANT_W * 0.80))
        max_h = int(round(VARIANT_H * 0.82))

    scale = min(max_w / max(1, cutout_rgba.width), max_h / max(1, cutout_rgba.height))
    nw = max(32, int(round(cutout_rgba.width * scale)))
    nh = max(32, int(round(cutout_rgba.height * scale)))

    rgb_res = Image.fromarray(final_rgb, mode="RGB").resize((nw, nh), Image.Resampling.LANCZOS)
    a_res = Image.fromarray(alpha_u8, mode="L").resize((nw, nh), Image.Resampling.LANCZOS)
    fg = rgb_res.convert("RGBA")
    fg.putalpha(a_res)

    paste_x = (VARIANT_W - nw) // 2
    paste_y = (VARIANT_H - nh) // 2

    # Soft studio contact drop shadow on warm Atelier cream paper
    a_np = np.array(a_res, dtype=np.float32)
    sh_alpha = ndimage.gaussian_filter(a_np, sigma=14.0)
    sh_alpha = np.clip(sh_alpha * 0.16, 0, 255).astype(np.uint8)
    sh_patch = np.zeros((nh, nw, 4), dtype=np.uint8)
    sh_patch[:, :, 0] = 44
    sh_patch[:, :, 1] = 32
    sh_patch[:, :, 2] = 22
    sh_patch[:, :, 3] = sh_alpha

    shadow_layer = Image.new("RGBA", (VARIANT_W, VARIANT_H), (0, 0, 0, 0))
    shadow_layer.paste(
        Image.fromarray(sh_patch, mode="RGBA"),
        (min(VARIANT_W - nw, paste_x + 4), min(VARIANT_H - nh, paste_y + 12)),
    )

    fg_layer = Image.new("RGBA", (VARIANT_W, VARIANT_H), (0, 0, 0, 0))
    fg_layer.paste(fg, (paste_x, paste_y))

    comp = backdrop_rgb.convert("RGBA")
    comp = Image.alpha_composite(comp, shadow_layer)
    comp = Image.alpha_composite(comp, fg_layer)
    return comp.convert("RGB")


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


def save_image(img: Image.Image, dest: Path, fmt: str, **kwargs: Any) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    img.save(dest, format=fmt, **kwargs)


def put_label_strip(w: int, h: int, text: str, bg=(34, 26, 20), fg=(248, 241, 228)) -> Image.Image:
    strip = np.full((h, w, 3), bg, dtype=np.uint8)
    cv2.putText(strip, text, (14, int(h * 0.68)), cv2.FONT_HERSHEY_SIMPLEX, 0.56, fg, 1, cv2.LINE_AA)
    return Image.fromarray(strip, mode="RGB")


def build_contact_sheet(
    season_entries: list[dict[str, Any]],
    out_dir: Path,
    contact_sheet_path: Path,
) -> None:
    """
    Builds a crisp high-res visual contact sheet showing:
      - Row 1: All 6 Editorial Lookbooks (01..06, 960x1200 scaled cleanly)
      - Row 2: All 6 Seasons Mask Overlay + Pins (R=Slot0, G=Slot1, B=Slot2, zero face bleed check)
      - Row 3: 6 Real Macro Fabric Swatches (including Silk Ivory, Linen Sand, Tweed Charcoal, Silk Jet-Black, Silk Wine-Red, Leather Espresso)
      - Row 4: Season 04's 3 Studio Product Cards (Default + Alternate Recolored Swatches!)
    """
    cols = 6
    tw = 240
    look_h = 300
    mac_h = 180
    card_h = 320
    lbl_h = 34
    sub_h = 26

    sheet_w = cols * tw
    sheet_h = (
        lbl_h + look_h + sub_h
        + lbl_h + look_h + sub_h
        + lbl_h + mac_h + sub_h
        + lbl_h + card_h + sub_h
    )
    sheet = Image.new("RGB", (sheet_w, sheet_h), (24, 19, 15))
    y = 0

    # Row 1: 6 Editorial Lookbooks
    sheet.paste(put_label_strip(sheet_w, lbl_h, "ROW 1 - ALL 6 SEASONAL EDITORIAL LOOKBOOKS (960x1200 WebP)"), (0, y))
    y += lbl_h
    for i, s in enumerate(season_entries):
        slug = s["seasonSlug"]
        im = Image.open(out_dir / "lookbooks" / f"{slug}-base.webp").convert("RGB")
        sheet.paste(im.resize((tw, look_h), Image.Resampling.LANCZOS), (i * tw, y))
        sheet.paste(put_label_strip(tw, sub_h, f"0{s['order']} {slug}", bg=(44, 34, 26), fg=(235, 207, 143)), (i * tw, y + look_h))
    y += look_h + sub_h

    # Row 2: 6 Mask Overlays + Pins
    sheet.paste(put_label_strip(sheet_w, lbl_h, "ROW 2 - 18 GARMENT MASKS OVERLAY (R=Slot0, G=Slot1, B=Acc) + NEURAL PINS (0% FACE BLEED)"), (0, y))
    y += lbl_h
    colors = [
        np.array([235.0, 68.0, 68.0]),
        np.array([58.0, 210.0, 110.0]),
        np.array([72.0, 155.0, 245.0]),
    ]
    for i, s in enumerate(season_entries):
        slug = s["seasonSlug"]
        base_np = np.array(Image.open(out_dir / "lookbooks" / f"{slug}-base.webp").convert("RGB"), dtype=np.float32)
        overlay = base_np.copy()
        for si, slot in enumerate(s["wearableSlots"]):
            m_path = out_dir / "masks" / f"{slug}-mask-{slot['slotKey'].lower()}.png"
            m_a = np.array(Image.open(m_path).convert("RGBA"), dtype=np.float32)[:, :, 3:4] / 255.0
            overlay = overlay * (1.0 - m_a * 0.50) + colors[si % 3][None, None, :] * (m_a * 0.50)
        ov_bgr = cv2.cvtColor(np.clip(overlay, 0, 255).astype(np.uint8), cv2.COLOR_RGB2BGR)
        for slot in s["wearableSlots"]:
            px_i = int(slot["pinPosition"]["xPercent"] / 100.0 * EDITORIAL_W)
            py_i = int(slot["pinPosition"]["yPercent"] / 100.0 * EDITORIAL_H)
            cv2.circle(ov_bgr, (px_i, py_i), 15, (255, 255, 255), -1)
            cv2.circle(ov_bgr, (px_i, py_i), 10, (28, 20, 16), -1)
        ov_im = Image.fromarray(cv2.cvtColor(ov_bgr, cv2.COLOR_BGR2RGB))
        sheet.paste(ov_im.resize((tw, look_h), Image.Resampling.LANCZOS), (i * tw, y))
        sheet.paste(put_label_strip(tw, sub_h, f"0{s['order']} 3 Masks + Pins", bg=(44, 34, 26), fg=(220, 212, 198)), (i * tw, y + look_h))
    y += look_h + sub_h

    # Row 3: 6 Representative Macro Fabric Swatches
    sheet.paste(put_label_strip(sheet_w, lbl_h, "ROW 3 - REAL MACRO FABRIC SWATCHES (800x600 WebP)"), (0, y))
    y += lbl_h
    macro_picks = [
        ("silk-ivory.webp", "silk-ivory"),
        ("linen-sand.webp", "linen-sand"),
        ("tweed-charcoal.webp", "tweed-charcoal"),
        ("leather-espresso.webp", "leather-espresso"),
        ("tweed-ivory.webp", "tweed-ivory"),
        ("silk-wine-red.webp", "silk-wine-red"),
    ]
    for i, (fname, cap) in enumerate(macro_picks):
        im = Image.open(out_dir / "macros" / fname).convert("RGB")
        sheet.paste(im.resize((tw, mac_h), Image.Resampling.LANCZOS), (i * tw, y))
        sheet.paste(put_label_strip(tw, sub_h, cap, bg=(44, 34, 26), fg=(235, 207, 143)), (i * tw, y + mac_h))
    y += mac_h + sub_h

    # Row 4: Season 04 Product Cards (3 Defaults + 3 Alternate Recolors)
    sheet.paste(put_label_strip(sheet_w, lbl_h, "ROW 4 - SEASON 04 PRODUCT & ACCESSORY CARDS (720x960 WebP ON #EFE6D5 ATELIER STUDIO BACKDROP)"), (0, y))
    y += lbl_h
    card_picks = [
        ("ao-blazer-linen-dang-suong-sand.webp", "S04 Blazer Sand"),
        ("quan-tay-ong-suong-xep-ly-doi-charcoal.webp", "S04 Trousers Charcoal"),
        ("that-lung-da-khoa-dong-espresso.webp", "S04 Belt Espresso"),
        ("ao-blazer-linen-dang-suong-espresso.webp", "S04 Blazer Espresso"),
        ("quan-tay-ong-suong-xep-ly-doi-sand.webp", "S04 Trousers Sand"),
        ("that-lung-da-khoa-dong-jet-black.webp", "S04 Belt Jet-Black"),
    ]
    for i, (fname, cap) in enumerate(card_picks):
        im = Image.open(out_dir / "variants" / fname).convert("RGB")
        sheet.paste(im.resize((tw, card_h), Image.Resampling.LANCZOS), (i * tw, y))
        sheet.paste(put_label_strip(tw, sub_h, cap, bg=(44, 34, 26), fg=(235, 207, 143)), (i * tw, y + card_h))

    contact_sheet_path.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(contact_sheet_path, format="PNG", compress_level=3)
    print(f"[contact-sheet] Saved visual check -> {contact_sheet_path} ({sheet_w}x{sheet_h})", flush=True)


def main() -> int:
    spec_path = Path(sys.argv[1])
    spec = json.loads(spec_path.read_text(encoding="utf-8"))
    raw_dir = Path(spec["rawDir"])
    processed_products_dir = Path(spec["processedProductsDir"])
    occasion_macro_dir = Path(spec["occasionMacroDir"])
    out_dir = Path(spec["outDir"])
    yunet_path = Path(spec["yunetPath"])
    contact_sheet_path = Path(spec["contactSheetPath"])

    only_season = spec.get("onlySeason")
    existing_manifest_by_slug: dict[str, Any] = {}
    existing_manifest_path = out_dir / "manifest.json"
    if only_season and existing_manifest_path.exists():
        prev_doc = json.loads(existing_manifest_path.read_text(encoding="utf-8"))
        for prev_s in prev_doc.get("seasons", []):
            existing_manifest_by_slug[prev_s["seasonSlug"]] = prev_s

    sessions = SessionPool()
    t_all = time.time()

    backdrop_rgb = build_atelier_studio_backdrop(VARIANT_W, VARIANT_H)

    generated_variants: set[str] = set()
    generated_defaults: set[str] = set()
    generated_macros: set[str] = set()

    if not only_season:
        # 1. Load clean studio cutouts for all 15 unique products
        print("[vitrine:py] Step 1/4: Loading 15 clean RGBA studio product cutouts...", flush=True)
        product_cutouts: dict[str, Image.Image] = {}
        for slug, cfg in spec["productCardSources"].items():
            product_cutouts[slug] = prepare_clean_product_cutout(processed_products_dir, slug, cfg)
            print(f"  [cutout] {slug} ({product_cutouts[slug].width}x{product_cutouts[slug].height})", flush=True)

        # 2. Build all variant cards (720x960 WebP) + default cards + 23 macro swatches (800x600 WebP)
        print("[vitrine:py] Step 2/4: Generating 720x960 studio variant cards & 800x600 macro fabric swatches...", flush=True)
        macro_base_imgs: dict[str, Image.Image] = {}
        for mkey, mcfg in spec["macroBaseSources"].items():
            raw_src = raw_dir / mcfg["rawFile"]
            if raw_src.exists():
                m_im = ImageOps.exif_transpose(Image.open(raw_src)).convert("RGB")
                m_im = crop_normalized(m_im, mcfg.get("crop"))
            else:
                m_im = Image.open(occasion_macro_dir / mcfg["fallbackMacro"]).convert("RGB")
            macro_base_imgs[mkey] = aspect_fill_resize(m_im, MACRO_W, MACRO_H, 0.5, 0.5)

        for season in spec["seasons"]:
            for slot in season["wearableSlots"]:
                slug = slot["productSlug"]
                p_cfg = spec["productCardSources"][slug]
                base_cutout = product_cutouts[slug]
                for var in slot["variants"]:
                    ckey = var["colorKey"]
                    v_rel = f"variants/{slug}-{ckey}.webp"
                    if v_rel not in generated_variants:
                        card_img = render_studio_variant_card(
                            base_cutout,
                            backdrop_rgb,
                            color_hex=var["colorHex"],
                            sheen=p_cfg["sheen"],
                            is_accessory=bool(p_cfg["isAccessory"]),
                            preserve_original=bool(var.get("preserveOriginal", False)),
                            harmony_blend=float(var.get("harmonyBlend", 0.0)),
                        )
                        save_image(card_img, out_dir / v_rel, "WEBP", quality=91, method=5)
                        generated_variants.add(v_rel)

                        # Also generate <productSlug>-default.webp from primary default color
                        if ckey == p_cfg["defaultColorKey"] and slug not in generated_defaults:
                            def_rel = f"variants/{slug}-default.webp"
                            save_image(card_img, out_dir / def_rel, "WEBP", quality=91, method=5)
                            generated_defaults.add(slug)

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
                        save_image(m_img, out_dir / m_rel, "WEBP", quality=91, method=5)
                        generated_macros.add(m_rel)

        print(
            f"  [cards] {len(generated_variants)} color variants + {len(generated_defaults)} defaults | "
            f"[macros] {len(generated_macros)} WebPs",
            flush=True,
        )
    else:
        for season in spec["seasons"]:
            for slot in season["wearableSlots"]:
                slug = slot["productSlug"]
                generated_defaults.add(slug)
                for var in slot["variants"]:
                    generated_variants.add(f"variants/{slug}-{var['colorKey']}.webp")
                    m_ckey = var.get("macroColorKeyOverride") or var["colorKey"]
                    generated_macros.add(f"macros/{var['macroKey']}-{m_ckey}.webp")

    # 3. Generate all 6 editorial lookbooks (960x1200 WebP) & 18 garment masks (960x1200 PNG)
    print("[vitrine:py] Step 3/4: Generating editorial lookbooks & feathered garment masks...", flush=True)
    manifest_seasons: list[dict[str, Any]] = []

    for season in spec["seasons"]:
        slug = season["seasonSlug"]
        if only_season and slug != only_season and slug in existing_manifest_by_slug:
            manifest_seasons.append(existing_manifest_by_slug[slug])
            continue
        t0 = time.time()
        raw_im = ImageOps.exif_transpose(Image.open(raw_dir / season["rawFile"])).convert("RGB")
        cropped = crop_normalized(raw_im, season.get("crop"))
        base_im = aspect_fill_resize(cropped, EDITORIAL_W, EDITORIAL_H, 0.5, 0.5)
        base_im = apply_editorial_grade(base_im, season.get("editorialGrade") or {})

        acc_mask_rgba = None
        acc_cfg = season.get("accessoryComposite")
        if acc_cfg:
            acc_slug = acc_cfg["productSlug"]
            acc_flat = processed_products_dir / acc_slug / f"{acc_slug}-flat-3x4.webp"
            base_im, acc_mask_rgba = composite_accessory_onto_base(base_im, acc_flat, acc_cfg)

        save_image(base_im, out_dir / "lookbooks" / f"{slug}-base.webp", "WEBP", quality=91, method=5)

        rgba_masks, face_info = segment_season_masks(
            strategy=season["segmentationStrategy"],
            base_rgb=base_im,
            sessions=sessions,
            yunet_path=yunet_path,
            acc_mask_rgba=acc_mask_rgba,
        )

        fx0 = int(face_info["x"] * EDITORIAL_W)
        fy0 = int(face_info["y"] * EDITORIAL_H)
        fx1 = int((face_info["x"] + face_info["w"]) * EDITORIAL_W)
        fy1 = int((face_info["y"] + face_info["h"]) * EDITORIAL_H)

        v_y0, v_y1 = int(0.08 * EDITORIAL_H), int(0.22 * EDITORIAL_H)
        v_x0, v_x1 = int(0.40 * EDITORIAL_W), int(0.60 * EDITORIAL_W)

        avoid_pins: list[tuple[float, float]] = []
        hydrated_slots: list[dict[str, Any]] = []

        for slot in season["wearableSlots"]:
            skey = slot["slotKey"]
            skey_lower = skey.lower()
            mask_rgba = rgba_masks[skey]
            mask_rgba[max(0, fy0 - 4) : min(EDITORIAL_H, fy1 + 4), max(0, fx0 - 4) : min(EDITORIAL_W, fx1 + 4), 3] = 0
            if skey != "ACCESSORY":
                mask_rgba[v_y0:v_y1, v_x0:v_x1, 3] = 0

            alpha_u8 = mask_rgba[:, :, 3]
            pin_pos, bbox, cov = compute_mask_metrics(alpha_u8, avoid_pins)
            avoid_pins.append((pin_pos["xPercent"], pin_pos["yPercent"]))

            mask_im = Image.fromarray(mask_rgba, mode="RGBA")
            save_image(mask_im, out_dir / "masks" / f"{slug}-mask-{skey_lower}.png", "PNG", compress_level=6)

            slot_variants = []
            for var in slot["variants"]:
                m_ckey = var.get("macroColorKeyOverride") or var["colorKey"]
                slot_variants.append({
                    "colorKey": var["colorKey"],
                    "colorName": var["colorName"],
                    "colorHex": var["colorHex"],
                    "studioCutoutUrl": f"{URL_PREFIX}/variants/{slot['productSlug']}-{var['colorKey']}.webp",
                    "macroSwatchUrl": f"{URL_PREFIX}/macros/{var['macroKey']}-{m_ckey}.webp",
                    "fabricSpecText": var["fabricSpecText"],
                })

            hydrated_slots.append({
                "slotKey": skey,
                "productSlug": slot["productSlug"],
                "pinPosition": pin_pos,
                "garmentRegionMask": f"{URL_PREFIX}/masks/{slug}-mask-{skey_lower}.png",
                "maskBbox": bbox,
                "materialOpticalProfile": slot["materialOpticalProfile"],
                "variants": slot_variants,
            })
            print(
                f"  [{slug}] {skey:9s}: cov={cov*100:5.1f}% pin=({pin_pos['xPercent']:4.1f}%,{pin_pos['yPercent']:4.1f}%) "
                f"bbox=({bbox['x']:.2f},{bbox['y']:.2f},{bbox['w']:.2f},{bbox['h']:.2f})",
                flush=True,
            )

        season_entry = {
            "seasonSlug": slug,
            "order": season["order"],
            "months": season["months"],
            "name": season["name"],
            "shortName": season["shortName"],
            "materialHeadline": season["materialHeadline"],
            "note": season["note"],
            "isCurrent": season["isCurrent"],
            "baseEditorialImageUrl": f"{URL_PREFIX}/lookbooks/{slug}-base.webp",
            "restyleCacheMap": {},
            "wearableSlots": hydrated_slots,
        }
        manifest_seasons.append(season_entry)
        print(f"  [season] {slug} complete in {time.time() - t0:.2f}s", flush=True)

    # 4. Write canonical manifest.json
    manifest_doc = {
        "version": "2.0.0",
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "urlPrefix": URL_PREFIX,
        "dimensions": {
            "lookbook": {"width": EDITORIAL_W, "height": EDITORIAL_H},
            "mask": {"width": EDITORIAL_W, "height": EDITORIAL_H},
            "variantCard": {"width": VARIANT_W, "height": VARIANT_H},
            "macroSwatch": {"width": MACRO_W, "height": MACRO_H},
        },
        "counts": {
            "lookbooks": len(manifest_seasons),
            "masks": sum(len(s["wearableSlots"]) for s in manifest_seasons),
            "variants": len(generated_variants),
            "defaultVariants": len(generated_defaults),
            "macros": len(generated_macros),
        },
        "seasons": manifest_seasons,
    }
    (out_dir / "manifest.json").write_text(
        json.dumps(manifest_doc, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )

    # 5. Render contact sheet
    print("[vitrine:py] Step 4/4: Rendering visual contact sheet...", flush=True)
    build_contact_sheet(manifest_seasons, out_dir, contact_sheet_path)

    print(
        f"[vitrine:py] ALL DONE in {time.time() - t_all:.1f}s | "
        f"6 lookbooks, 18 masks, {len(generated_variants)}+{len(generated_defaults)} variants, {len(generated_macros)} macros.",
        flush=True,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
`;

async function verifyGeneratedAssets(sharp) {
  const manifestPath = path.join(PUBLIC_VITRINE_DIR, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (!Array.isArray(manifest.seasons) || manifest.seasons.length !== 6) {
    throw new Error(`Expected 6 seasons in manifest.json, got ${manifest.seasons?.length}`);
  }

  const publicRoot = path.join(REPO_ROOT, 'apps', 'storefront', 'public');
  const checked = new Set();

  async function assertAsset(url, expectedW, expectedH, expectFormat, expectAlpha = false) {
    if (!url.startsWith('/images/seasons-vitrine/')) {
      throw new Error(`Unexpected URL prefix: ${url}`);
    }
    if (checked.has(url)) return;
    const diskPath = path.join(publicRoot, url.replace(/^\//, ''));
    if (!fs.existsSync(diskPath)) {
      throw new Error(`Missing asset on disk: ${diskPath}`);
    }
    const stat = fs.statSync(diskPath);
    if (stat.size <= 2048) {
      throw new Error(`Asset too small (${stat.size}B <= 2048B): ${diskPath}`);
    }
    const meta = await sharp(diskPath).metadata();
    if (meta.width !== expectedW || meta.height !== expectedH || meta.format !== expectFormat) {
      throw new Error(
        `Invalid metadata for ${url}: got ${meta.width}x${meta.height} ${meta.format}, expected ${expectedW}x${expectedH} ${expectFormat}`,
      );
    }
    if (expectAlpha && !meta.hasAlpha) {
      throw new Error(`Expected alpha channel on ${url}`);
    }
    checked.add(url);
  }

  const productSlugs = new Set();
  for (const season of manifest.seasons) {
    await assertAsset(season.baseEditorialImageUrl, 960, 1200, 'webp');
    for (const slot of season.wearableSlots) {
      productSlugs.add(slot.productSlug);
      await assertAsset(slot.garmentRegionMask, 960, 1200, 'png', true);
      for (const variant of slot.variants) {
        await assertAsset(variant.studioCutoutUrl, 720, 960, 'webp');
        await assertAsset(variant.macroSwatchUrl, 800, 600, 'webp');
      }
    }
  }
  for (const slug of productSlugs) {
    await assertAsset(`/images/seasons-vitrine/variants/${slug}-default.webp`, 720, 960, 'webp');
  }

  console.log(
    `[sharp-verify] PASS: ${checked.size} unique local photography & mask files verified (>2KB, exact dimensions).`,
  );
}

async function main() {
  const sheetArg = process.argv.find((a) => a.startsWith('--contact-sheet='));
  const contactSheetPath = sheetArg ? sheetArg.slice('--contact-sheet='.length) : DEFAULT_CONTACT_SHEET;
  const onlySeasonArg = process.argv.find((a) => a.startsWith('--only-season='));
  const onlySeason = onlySeasonArg ? onlySeasonArg.slice('--only-season='.length) : null;

  fs.mkdirSync(PUBLIC_VITRINE_DIR, { recursive: true });

  const sharp = await loadSharp();
  const pythonExe = findPythonExecutable();

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-seasons-vitrine-'));
  const pyScriptPath = path.join(tmpDir, 'build_seasons_vitrine.py');
  const specPath = path.join(tmpDir, 'spec.json');

  try {
    fs.writeFileSync(pyScriptPath, PYTHON_PIPELINE, 'utf8');
    fs.writeFileSync(
      specPath,
      JSON.stringify(
        {
          rawDir: RAW_DIR,
          processedProductsDir: PROCESSED_PRODUCTS_DIR,
          occasionMacroDir: OCCASION_MACRO_DIR,
          outDir: PUBLIC_VITRINE_DIR,
          yunetPath: YUNET_MODEL_PATH,
          contactSheetPath,
          onlySeason,
          seasons: SEASONS_SPEC,
          productCardSources: PRODUCT_CARD_SOURCES,
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
      throw new Error(`Python vitrine photography pipeline failed with exit code ${run.status}`);
    }

    await verifyGeneratedAssets(sharp);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('[seasons-vitrine-assets] FATAL:', err);
  process.exit(1);
});
