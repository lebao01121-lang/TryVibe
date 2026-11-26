#!/usr/bin/env node
/**
 * ============================================================================
 * TryVibe — 6-Season 1:1 Outfit-Bound Lookbook Synchronizer
 * (`scripts/sync-season-lookbook-outfits.mjs`)
 * ============================================================================
 * Guarantees absolute 1:1 visual & data binding (`1 Outfit Lookbook = Exact Worn SKUs`)
 * across all 6 seasons (`01` -> `06`):
 *   - Strict outfit formula validation:
 *       * TOP_BOTTOM_ACCESSORY          (TOP + BOTTOM + ACCESSORY)
 *       * ONE_PIECE_OUTERWEAR_ACCESSORY (ONE_PIECE + OUTERWEAR + ACCESSORY)
 *     Strictly forbids conflicting combinations (e.g. ONE_PIECE + TOP).
 *   - Processes 6 verified full-color editorial portraits (`960x1200` 4:5 WebP)
 *     into `apps/storefront/public/images/seasons-vitrine/lookbooks/<slug>-base.webp`,
 *     `infra/seeds/real-assets-cache/processed/seasons/<slug>.webp`,
 *     and `.local-minio/atelier-public/seed/season-<slug>.webp` (plus live MinIO check).
 *   - Generates clean `#EFE6D5` studio variant cards for `dam-midi-co-vuong-chiet-eo`
 *     (Season 05 ONE_PIECE) matching all existing studio cutouts.
 *   - Generates 18 pixel-accurate feathered RGBA segmentation masks
 *     (`apps/storefront/public/images/seasons-vitrine/masks/<slug>-mask-<slot>.png`)
 *     covering every worn garment & visible accessory with face/hair/skin protection.
 *   - Audits full-color chroma (0 B&W images) & dominant slot color alignment.
 *   - Writes `apps/storefront/public/images/seasons-vitrine/manifest.json` (v3.0.0).
 *   - Never resets DB volumes.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

const VITRINE_DIR = path.join(ROOT_DIR, 'apps', 'storefront', 'public', 'images', 'seasons-vitrine');
const RAW_CACHE_DIR = path.join(ROOT_DIR, 'infra', 'seeds', 'real-assets-cache', 'raw');
const PROCESSED_DIR = path.join(ROOT_DIR, 'infra', 'seeds', 'real-assets-cache', 'processed');
const LOCAL_MINIO_SEED_DIR = path.join(ROOT_DIR, '.local-minio', 'atelier-public', 'seed');

const DEBUG_SHEET_PATH = process.argv.includes('--debug-sheet')
  ? process.argv[process.argv.indexOf('--debug-sheet') + 1]
  : null;

/**
 * Canonical 6-Season 1:1 Outfit-Bound Definition.
 * Every season MUST strictly follow either:
 *   - TOP_BOTTOM_ACCESSORY:          [TOP, BOTTOM, ACCESSORY]
 *   - ONE_PIECE_OUTERWEAR_ACCESSORY: [ONE_PIECE, OUTERWEAR, ACCESSORY]
 * variants[0] MUST be the exact color worn by the model in the base lookbook portrait.
 */
export const CANONICAL_SEASONS_OUTFIT_PLAN = [
  {
    seasonSlug: 'xuan-tam-xuan',
    order: 1,
    months: 'T1–T2',
    name: 'Xuân Lụa Bảo Lộc',
    shortName: 'Xuân Lụa',
    materialHeadline: 'Lụa Tơ Tằm Bảo Lộc 22 Momme',
    note: 'Lụa Tơ Tằm Bảo Lộc 22 Momme — ánh ngà ấm và phom dáng mềm rủ cho tiết xuân Hà Nội.',
    isCurrent: true,
    outfitFormula: 'TOP_BOTTOM_ACCESSORY',
    defaultMacroSlotKey: 'TOP',
    rawSourceFile: 'season-outfit-xuan-tam-xuan.jpg',
    cropTopFrac: 0.025,
    wearableSlots: [
      {
        slotKey: 'TOP',
        productSlug: 'ao-so-mi-lua-to-tam-tam-xuan',
        shortPinLabel: 'Áo Sơ Mi Lụa',
        pinPosition: { xPercent: 52.0, yPercent: 34.0 },
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
        pinPosition: { xPercent: 56.0, yPercent: 72.0 },
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
        pinPosition: { xPercent: 44.0, yPercent: 56.0 },
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
  {
    seasonSlug: 'ha-pho-co',
    order: 2,
    months: 'T3–T4',
    name: 'Hạ Linen Hữu Cơ',
    shortName: 'Hạ Linen',
    materialHeadline: '100% Organic French Linen Thoáng Khí',
    note: '100% Organic French Linen Thoáng Khí — đường cắt khoáng đạt và thoáng nhẹ dưới nắng hạ.',
    isCurrent: false,
    outfitFormula: 'TOP_BOTTOM_ACCESSORY',
    defaultMacroSlotKey: 'TOP',
    rawSourceFile: 'season-outfit-ha-pho-co.jpg',
    cropTopFrac: 0.04,
    wearableSlots: [
      {
        slotKey: 'TOP',
        productSlug: 'ao-so-mi-lua-to-tam-bao-loc',
        shortPinLabel: 'Áo Sơ Mi Bảo Lộc',
        pinPosition: { xPercent: 39.0, yPercent: 49.0 },
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
        pinPosition: { xPercent: 50.0, yPercent: 76.0 },
        materialOpticalProfile: { sheen: 'linen', specularIntensity: 0.14, shadowDepth: 0.3 },
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
        pinPosition: { xPercent: 60.0, yPercent: 34.0 },
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
  {
    seasonSlug: 'resort-ban-mai',
    order: 3,
    months: 'T5–T6',
    name: 'Resort Biển & Lụa Bay',
    shortName: 'Resort Biển',
    materialHeadline: 'Linen Tự Nhiên & Len Merino Mỏng Nhẹ',
    note: 'Linen & Tơ Sống dệt thoáng kết hợp cardigan Merino khoác nhẹ đón gió biển ban mai.',
    isCurrent: false,
    outfitFormula: 'ONE_PIECE_OUTERWEAR_ACCESSORY',
    defaultMacroSlotKey: 'ONE_PIECE',
    rawSourceFile: 'season-outfit-resort-ban-mai.jpg',
    cropTopFrac: 0.03,
    wearableSlots: [
      {
        slotKey: 'ONE_PIECE',
        productSlug: 'dam-midi-linen-phoi-dai',
        shortPinLabel: 'Đầm Midi Linen',
        pinPosition: { xPercent: 54.0, yPercent: 64.0 },
        materialOpticalProfile: { sheen: 'linen', specularIntensity: 0.2, shadowDepth: 0.3 },
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
        pinPosition: { xPercent: 31.0, yPercent: 46.0 },
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
        pinPosition: { xPercent: 56.0, yPercent: 27.0 },
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
  {
    seasonSlug: 'thu-hoang-hon',
    order: 4,
    months: 'T7–T8',
    name: 'Thu Công Sở Thanh Lịch',
    shortName: 'Thu Công Sở',
    materialHeadline: 'Lụa Organza & Wool Silk Blend Đứng Phom',
    note: 'Áo lụa Organza kem ngà phối quần tây xếp ly đôi xám than và thắt lưng da khóa đồng chuẩn mực công sở.',
    isCurrent: false,
    outfitFormula: 'TOP_BOTTOM_ACCESSORY',
    defaultMacroSlotKey: 'TOP',
    rawSourceFile: 'season-outfit-thu-hoang-hon.jpg',
    cropTopFrac: 0.02,
    wearableSlots: [
      {
        slotKey: 'TOP',
        productSlug: 'ao-kieu-lua-organza-phoi-no',
        shortPinLabel: 'Áo Lụa Organza',
        pinPosition: { xPercent: 47.0, yPercent: 29.0 },
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
        pinPosition: { xPercent: 48.0, yPercent: 68.0 },
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
        pinPosition: { xPercent: 52.0, yPercent: 44.0 },
        materialOpticalProfile: { sheen: 'leather', specularIntensity: 0.5, shadowDepth: 0.36 },
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
  {
    seasonSlug: 'dong-cashmere',
    order: 5,
    months: 'T9–T10',
    name: 'Dạ Tweed & Cashmere',
    shortName: 'Dạ Tweed',
    materialHeadline: 'Dạ Tweed Dệt Nổi Thủ Công & Đầm Midi Chiết Eo',
    note: 'Áo khoác Dạ Tweed dệt thủ công khoác ngoài đầm midi cổ vuông chiết eo trắng ngọc đầy khí chất.',
    isCurrent: false,
    outfitFormula: 'ONE_PIECE_OUTERWEAR_ACCESSORY',
    defaultMacroSlotKey: 'OUTERWEAR',
    rawSourceFile: 'season-outfit-dong-cashmere.jpg',
    cropTopFrac: 0.02,
    wearableSlots: [
      {
        slotKey: 'ONE_PIECE',
        productSlug: 'dam-midi-co-vuong-chiet-eo',
        shortPinLabel: 'Đầm Midi Cổ Vuông',
        pinPosition: { xPercent: 52.0, yPercent: 51.0 },
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
        pinPosition: { xPercent: 65.0, yPercent: 35.0 },
        materialOpticalProfile: { sheen: 'tweed', specularIntensity: 0.2, shadowDepth: 0.4 },
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
        pinPosition: { xPercent: 41.0, yPercent: 69.0 },
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
  {
    seasonSlug: 'atelier-di-san',
    order: 6,
    months: 'T11–T12',
    name: 'Dạ Tiệc Cuối Năm',
    shortName: 'Dạ Tiệc',
    materialHeadline: 'Lụa Satin Ánh Ngọc & Nhung Couture',
    note: 'Đầm dự tiệc lụa satin đỏ rượu vang cắt thiên bias-cut khoác hờ blazer cát ngà và ví clutch champagne.',
    isCurrent: false,
    outfitFormula: 'ONE_PIECE_OUTERWEAR_ACCESSORY',
    defaultMacroSlotKey: 'ONE_PIECE',
    rawSourceFile: 'season-outfit-atelier-di-san.jpg',
    cropTopFrac: 0.04,
    wearableSlots: [
      {
        slotKey: 'ONE_PIECE',
        productSlug: 'dam-du-tiec-lua-satin-co-do',
        shortPinLabel: 'Đầm Satin Cổ Đổ',
        pinPosition: { xPercent: 47.0, yPercent: 71.0 },
        materialOpticalProfile: { sheen: 'silk', specularIntensity: 0.5, shadowDepth: 0.36 },
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
        pinPosition: { xPercent: 36.0, yPercent: 34.0 },
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
        pinPosition: { xPercent: 59.0, yPercent: 54.0 },
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
];

function validateOutfitPlan(seasons) {
  for (const s of seasons) {
    const keys = s.wearableSlots.map((slot) => slot.slotKey);
    const hasOnePiece = keys.includes('ONE_PIECE');
    const hasTop = keys.includes('TOP');
    const hasBottom = keys.includes('BOTTOM');
    const hasOuterwear = keys.includes('OUTERWEAR');
    const hasAccessory = keys.includes('ACCESSORY');

    if (hasOnePiece && (hasTop || hasBottom)) {
      throw new Error(`Invalid conflicting outfit in ${s.seasonSlug}: ${keys.join(' + ')}`);
    }
    const validSeparate =
      s.outfitFormula === 'TOP_BOTTOM_ACCESSORY' &&
      keys.length === 3 &&
      keys[0] === 'TOP' &&
      keys[1] === 'BOTTOM' &&
      keys[2] === 'ACCESSORY';
    const validDress =
      s.outfitFormula === 'ONE_PIECE_OUTERWEAR_ACCESSORY' &&
      keys.length === 3 &&
      keys[0] === 'ONE_PIECE' &&
      keys[1] === 'OUTERWEAR' &&
      keys[2] === 'ACCESSORY';

    if (!validSeparate && !validDress) {
      throw new Error(
        `Season ${s.seasonSlug} violates strict formula (${s.outfitFormula}): [${keys.join(', ')}] (hasOuter=${hasOuterwear}, hasAcc=${hasAccessory})`,
      );
    }
  }
}

function resolvePythonBin() {
  const winVenv = path.join(ROOT_DIR, 'services', 'ai-tryon', '.venv', 'Scripts', 'python.exe');
  if (fs.existsSync(winVenv)) return winVenv;
  const nixVenv = path.join(ROOT_DIR, 'services', 'ai-tryon', '.venv', 'bin', 'python');
  if (fs.existsSync(nixVenv)) return nixVenv;
  return process.platform === 'win32' ? 'python' : 'python3';
}

const PYTHON_PIPELINE = String.raw`
import json
import math
import os
import sys
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFilter
from scipy import ndimage

cfg = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
ROOT = Path(cfg["rootDir"])
VITRINE = Path(cfg["vitrineDir"])
RAW_DIR = Path(cfg["rawDir"])
PROC_DIR = Path(cfg["processedDir"])
MINIO_SEED_DIR = Path(cfg["minioSeedDir"])
DEBUG_SHEET = cfg.get("debugSheetPath")

LOOKBOOK_W, LOOKBOOK_H = 960, 1200
VARIANT_W, VARIANT_H = 720, 960

(VITRINE / "lookbooks").mkdir(parents=True, exist_ok=True)
(VITRINE / "masks").mkdir(parents=True, exist_ok=True)
(VITRINE / "variants").mkdir(parents=True, exist_ok=True)
(PROC_DIR / "seasons").mkdir(parents=True, exist_ok=True)
if MINIO_SEED_DIR.parent.exists():
    MINIO_SEED_DIR.mkdir(parents=True, exist_ok=True)


def hex_to_rgb(hex_str: str) -> tuple[int, int, int]:
    h = hex_str.strip().lstrip("#")
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    return int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)


def rgb_to_hex(rgb: tuple[float, float, float]) -> str:
    r, g, b = [max(0, min(255, int(round(v)))) for v in rgb]
    return f"#{r:02X}{g:02X}{b:02X}"


def crop_to_4x5(im: Image.Image, top_frac: float) -> Image.Image:
    im = im.convert("RGB")
    w, h = im.size
    target_ratio = LOOKBOOK_W / LOOKBOOK_H  # 0.8
    cur_ratio = w / float(h)
    if cur_ratio < target_ratio:
        # Tall image (e.g. 3:4 = 0.75) -> crop height cleanly using top_frac
        crop_h = int(round(w / target_ratio))
        max_top = max(0, h - crop_h)
        y0 = int(round(max(0.0, min(1.0, top_frac / max(1e-5, (h - crop_h) / float(h)))) * max_top))
        y0 = max(0, min(max_top, int(round(h * top_frac))))
        im = im.crop((0, y0, w, y0 + crop_h))
    elif cur_ratio > target_ratio:
        crop_w = int(round(h * target_ratio))
        x0 = max(0, (w - crop_w) // 2)
        im = im.crop((x0, 0, x0 + crop_w, h))
    return im.resize((LOOKBOOK_W, LOOKBOOK_H), Image.Resampling.LANCZOS)


def keep_largest_components(mask: np.ndarray, min_ratio: float = 0.08, max_count: int = 2) -> np.ndarray:
    labeled, n = ndimage.label(mask)
    if n <= 0:
        return np.zeros_like(mask, dtype=bool)
    counts = np.bincount(labeled.ravel())
    counts[0] = 0
    order = np.argsort(counts)[::-1]
    top_count = counts[order[0]]
    if top_count <= 0:
        return np.zeros_like(mask, dtype=bool)
    out = np.zeros_like(mask, dtype=bool)
    kept = 0
    for cid in order:
        if cid == 0 or counts[cid] <= 0:
            break
        if kept < max_count and counts[cid] >= top_count * min_ratio:
            out |= (labeled == cid)
            kept += 1
        elif kept >= max_count:
            break
    return out


def soft_alpha_to_rgba(alpha_f: np.ndarray) -> Image.Image:
    a = np.clip(np.round(alpha_f * 255.0), 0, 255).astype(np.uint8)
    rgba = np.zeros((a.shape[0], a.shape[1], 4), dtype=np.uint8)
    rgba[:, :, 0] = 255
    rgba[:, :, 1] = 255
    rgba[:, :, 2] = 255
    rgba[:, :, 3] = a
    return Image.fromarray(rgba, mode="RGBA")


def feather_mask(mask_bool: np.ndarray, sigma: float = 2.2) -> np.ndarray:
    if not np.any(mask_bool):
        return np.zeros(mask_bool.shape, dtype=np.float32)
    f = mask_bool.astype(np.float32)
    f = ndimage.gaussian_filter(f, sigma=sigma)
    # Keep solid interior, soft 2.2px edge feather
    f = np.clip((f - 0.12) / 0.80, 0.0, 1.0)
    return f


def compute_mask_bbox(alpha_f: np.ndarray) -> dict:
    ys, xs = np.where(alpha_f >= 0.15)
    if len(xs) < 20:
        return {"x": 0.0, "y": 0.0, "w": 0.0, "h": 0.0}
    h, w = alpha_f.shape
    x0, x1 = int(xs.min()), int(xs.max())
    y0, y1 = int(ys.min()), int(ys.max())
    return {
        "x": round(x0 / float(w), 4),
        "y": round(y0 / float(h), 4),
        "w": round((x1 - x0 + 1) / float(w), 4),
        "h": round((y1 - y0 + 1) / float(h), 4),
    }


def run_grabcut_mask(
    rgb: np.ndarray,
    init_mask: np.ndarray,
    iters: int = 5,
    scale: float = 0.5,
) -> np.ndarray:
    """Runs OpenCV GrabCut initialized with explicit GC_BGD/GC_FGD/GC_PR_* mask at reduced res."""
    h, w = rgb.shape[:2]
    sw = max(32, int(round(w * scale)))
    sh = max(32, int(round(h * scale)))
    bgr = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
    bgr_s = cv2.resize(bgr, (sw, sh), interpolation=cv2.INTER_AREA)
    m_s = cv2.resize(init_mask.astype(np.uint8), (sw, sh), interpolation=cv2.INTER_NEAREST)
    if not (np.any(m_s == cv2.GC_FGD) or np.any(m_s == cv2.GC_PR_FGD)):
        return np.zeros((h, w), dtype=bool)
    if not (np.any(m_s == cv2.GC_BGD) or np.any(m_s == cv2.GC_PR_BGD)):
        return np.zeros((h, w), dtype=bool)
    bgd = np.zeros((1, 65), np.float64)
    fgd = np.zeros((1, 65), np.float64)
    cv2.grabCut(bgr_s, m_s, None, bgd, fgd, iters, cv2.GC_INIT_WITH_MASK)
    fg_s = ((m_s == cv2.GC_FGD) | (m_s == cv2.GC_PR_FGD)).astype(np.uint8)
    fg = cv2.resize(fg_s, (w, h), interpolation=cv2.INTER_LINEAR) > 0
    return fg


def compute_skin_lab_hsv(rgb: np.ndarray):
    bgr = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
    ycrcb = cv2.cvtColor(bgr, cv2.COLOR_BGR2YCrCb)
    hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)
    lab = cv2.cvtColor(bgr, cv2.COLOR_BGR2LAB).astype(np.float32)
    cr = ycrcb[:, :, 1]
    cb = ycrcb[:, :, 2]
    # Strict skin detector: require true skin redness (Cr >= 144 & Lab a* >= 137) so warm sunlit ivory/beige fabric is NEVER falsely marked as skin
    skin = (
        (cr >= 144) & (cr <= 176)
        & (cb >= 82) & (cb <= 122)
        & (lab[:, :, 1] >= 137) & (lab[:, :, 1] <= 165)
        & (hsv[:, :, 1] >= 48) & (hsv[:, :, 1] <= 178)
        & (hsv[:, :, 2] >= 70)
    )
    skin = ndimage.binary_opening(skin, iterations=2)
    skin = ndimage.binary_dilation(skin, iterations=1)
    return skin, lab, hsv


def segment_season_masks(slug: str, rgb: np.ndarray) -> dict[str, np.ndarray]:
    h, w = rgb.shape[:2]
    yy, xx = np.mgrid[0:h, 0:w]
    yn = yy / float(h)
    xn = xx / float(w)
    skin, lab, hsv = compute_skin_lab_hsv(rgb)

    if slug == "xuan-tam-xuan":
        # Full-body standing woman (x 0.33..0.69, y 0.06..0.95)
        init = np.full((h, w), cv2.GC_PR_BGD, dtype=np.uint8)
        init[(xn < 0.27) | (xn > 0.74) | (yn < 0.04) | (yn > 0.96)] = cv2.GC_BGD
        init[(xn >= 0.33) & (xn <= 0.69) & (yn >= 0.07) & (yn <= 0.87)] = cv2.GC_PR_FGD
        init[(xn >= 0.45) & (xn <= 0.56) & (yn >= 0.09) & (yn <= 0.20)] = cv2.GC_FGD
        init[(xn >= 0.42) & (xn <= 0.60) & (yn >= 0.25) & (yn <= 0.42)] = cv2.GC_FGD
        init[(xn >= 0.40) & (xn <= 0.63) & (yn >= 0.49) & (yn <= 0.81)] = cv2.GC_FGD
        fg = run_grabcut_mask(rgb, init, iters=6)
        fg = ndimage.binary_closing(fg, iterations=4)
        fg = ndimage.binary_fill_holes(fg)
        fg = keep_largest_components(fg, min_ratio=0.15, max_count=1)

        head_excl = (yn < 0.215)
        hands_excl = skin & (yn > 0.48) & (yn < 0.61)

        # ACCESSORY: champagne beaded clutch held horizontally at waist/hip (x 0.37..0.52, y 0.508..0.585)
        hands_excl = skin & (yn > 0.50) & (yn < 0.60) & ((xn < 0.42) | (xn > 0.50))
        clutch_box = (xn >= 0.385) & (xn <= 0.52) & (yn >= 0.512) & (yn <= 0.582)
        gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY).astype(np.float32)
        tex = cv2.GaussianBlur(np.abs(gray - cv2.GaussianBlur(gray, (9, 9), 0)), (9, 9), 0)
        clutch = clutch_box & fg & ~hands_excl & ((tex >= 5.0) | (lab[:, :, 0] < 210))
        clutch = ndimage.binary_closing(clutch, iterations=4)
        clutch = keep_largest_components(clutch, min_ratio=0.25, max_count=1)
        clutch = ndimage.binary_fill_holes(clutch) & clutch_box & ~hands_excl

        # TOP: bright ivory silk shirt (torso y 0.215..0.44 + left/right sleeves down to y 0.55)
        top_torso = fg & ~head_excl & ~skin & ~clutch & (yn >= 0.215) & (yn <= 0.44)
        top_left_sleeve = fg & ~skin & ~clutch & (yn > 0.435) & (yn <= 0.555) & (xn >= 0.34) & (xn <= 0.415) & (lab[:, :, 0] >= 188)
        top_right_sleeve = fg & ~skin & ~clutch & (yn > 0.435) & (yn <= 0.53) & (xn >= 0.59) & (xn <= 0.665) & (lab[:, :, 0] >= 172)
        top = ndimage.binary_closing(top_torso | top_left_sleeve | top_right_sleeve, iterations=3)
        top = keep_largest_components(top, min_ratio=0.08, max_count=2)
        top = ndimage.binary_fill_holes(top) & fg & ~skin & ~clutch & ~head_excl

        # BOTTOM: cream pleated midi skirt (full width x 0.33..0.69, y 0.44..0.855)
        bottom = fg & ~top & ~clutch & ~hands_excl & ~skin & (yn >= 0.44) & (yn <= 0.855)
        bottom = ndimage.binary_closing(bottom, iterations=5)
        bottom = keep_largest_components(bottom, min_ratio=0.25, max_count=1)
        bottom = ndimage.binary_fill_holes(bottom) & fg & ~top & ~clutch & ~skin

        return {
            "TOP": feather_mask(top),
            "BOTTOM": feather_mask(bottom),
            "ACCESSORY": feather_mask(clutch, sigma=1.8),
        }

    if slug == "ha-pho-co":
        # Medium portrait: milk-white shirt (y 0.27..0.62) + sand culottes (y 0.61..1.0) + golden silk scarf
        init = np.full((h, w), cv2.GC_PR_BGD, dtype=np.uint8)
        init[(xn < 0.16) | (xn > 0.83) | (yn < 0.02)] = cv2.GC_BGD
        init[(xn >= 0.22) & (xn <= 0.79) & (yn >= 0.04) & (yn <= 0.99)] = cv2.GC_PR_FGD
        init[(xn >= 0.36) & (xn <= 0.66) & (yn >= 0.32) & (yn <= 0.96)] = cv2.GC_FGD
        fg = run_grabcut_mask(rgb, init, iters=5)
        fg = ndimage.binary_closing(fg, iterations=4)
        fg = ndimage.binary_fill_holes(fg)
        fg = keep_largest_components(fg, min_ratio=0.15, max_count=1)

        head_excl = (yn < 0.25)

        # ACCESSORY: warm golden-yellow & terracotta silk scarf at neck/right chest (tight ROI + chroma)
        scarf_roi = (xn >= 0.46) & (xn <= 0.69) & (yn >= 0.24) & (yn <= 0.615)
        # Distinguish rich yellow/coral silk from neutral cream/shadowed white blouse
        scarf_color = (hsv[:, :, 1] >= 75) & ((lab[:, :, 2] >= 146) | (lab[:, :, 1] >= 139))
        scarf = scarf_roi & fg & scarf_color & ~(skin & (yn < 0.275))
        scarf = ndimage.binary_closing(scarf, iterations=4)
        scarf = keep_largest_components(scarf, min_ratio=0.18, max_count=1)
        scarf = ndimage.binary_fill_holes(scarf) & scarf_roi & fg

        # TOP: milk-white short-sleeve blouse (dedicated GrabCut on y 0.26..0.63)
        t_init = np.full((h, w), cv2.GC_BGD, dtype=np.uint8)
        t_init[(xn >= 0.20) & (xn <= 0.80) & (yn >= 0.26) & (yn <= 0.64)] = cv2.GC_PR_BGD
        t_init[(xn >= 0.23) & (xn <= 0.78) & (yn >= 0.28) & (yn <= 0.61)] = cv2.GC_PR_FGD
        t_init[(xn >= 0.29) & (xn <= 0.50) & (yn >= 0.34) & (yn <= 0.57)] = cv2.GC_FGD
        t_init[(xn >= 0.68) & (xn <= 0.76) & (yn >= 0.36) & (yn <= 0.56)] = cv2.GC_FGD
        t_init[scarf | skin | head_excl | (yn > 0.62)] = cv2.GC_BGD
        top = run_grabcut_mask(rgb, t_init, iters=5) & ~scarf & ~skin & ~head_excl & (yn <= 0.625)
        top = ndimage.binary_closing(top, iterations=4)
        top = keep_largest_components(top, min_ratio=0.12, max_count=2)
        top = ndimage.binary_fill_holes(top) & ~scarf & ~skin & ~head_excl & (yn <= 0.625)

        # BOTTOM: warm sand-beige linen culottes (dedicated GrabCut on y 0.58..1.0)
        b_init = np.full((h, w), cv2.GC_BGD, dtype=np.uint8)
        b_init[(xn >= 0.27) & (xn <= 0.76) & (yn >= 0.59) & (yn <= 0.998)] = cv2.GC_PR_BGD
        b_init[(xn >= 0.32) & (xn <= 0.72) & (yn >= 0.61) & (yn <= 0.998)] = cv2.GC_PR_FGD
        b_init[(xn >= 0.37) & (xn <= 0.66) & (yn >= 0.64) & (yn <= 0.97)] = cv2.GC_FGD
        b_init[top | scarf | (skin & (xn < 0.35)) | (yn < 0.60)] = cv2.GC_BGD
        bottom = run_grabcut_mask(rgb, b_init, iters=5) & ~top & ~scarf & ~(skin & (xn < 0.36)) & (yn >= 0.60)
        bottom = ndimage.binary_closing(bottom, iterations=5)
        bottom = keep_largest_components(bottom, min_ratio=0.25, max_count=1)
        bottom = ndimage.binary_fill_holes(bottom) & ~top & ~scarf & ~(skin & (xn < 0.36))

        return {
            "TOP": feather_mask(top),
            "BOTTOM": feather_mask(bottom),
            "ACCESSORY": feather_mask(scarf, sigma=1.8),
        }

    if slug == "resort-ban-mai":
        # Full seaside silhouette: oatmeal cardigan draped over shoulders + striped linen midi dress + neck scarf
        init = np.full((h, w), cv2.GC_PR_BGD, dtype=np.uint8)
        init[(xn < 0.13) | (xn > 0.89) | (yn < 0.03)] = cv2.GC_BGD
        init[(xn >= 0.16) & (xn <= 0.86) & (yn >= 0.06) & (yn <= 0.99)] = cv2.GC_PR_FGD
        # Definite foreground cores across bodice, flaring skirt & left cardigan wing
        init[(xn >= 0.41) & (xn <= 0.62) & (yn >= 0.28) & (yn <= 0.54)] = cv2.GC_FGD
        init[(xn >= 0.37) & (xn <= 0.72) & (yn >= 0.56) & (yn <= 0.95)] = cv2.GC_FGD
        init[(xn >= 0.22) & (xn <= 0.34) & (yn >= 0.44) & (yn <= 0.78)] = cv2.GC_FGD
        fg = run_grabcut_mask(rgb, init, iters=6)
        fg = ndimage.binary_closing(fg, iterations=4)
        fg = ndimage.binary_fill_holes(fg)
        fg = keep_largest_components(fg, min_ratio=0.15, max_count=1)

        head_excl = (yn < 0.21)

        # ACCESSORY: yellow-terracotta silk scarf knotted at neck
        scarf_roi = (xn >= 0.44) & (xn <= 0.72) & (yn >= 0.20) & (yn <= 0.36)
        scarf = scarf_roi & fg & (hsv[:, :, 1] >= 52) & (lab[:, :, 2] >= 140)
        scarf = ndimage.binary_closing(scarf, iterations=3)
        scarf = keep_largest_components(scarf, min_ratio=0.20, max_count=1)
        scarf = ndimage.binary_fill_holes(scarf) & fg

        # Attire excludes head, scarf, and exposed arms/hands
        hands_arms = skin & (yn > 0.56) & ((xn < 0.36) | (xn > 0.67))
        attire = fg & ~head_excl & ~scarf & ~hands_arms & ~(skin & (yn < 0.27)) & (yn >= 0.225) & (yn <= 0.985)

        # Smooth diagonal cardigan-vs-dress boundaries matching exact shoulder drape geometry
        left_seam = np.where(yn < 0.56, 0.42 - (yn - 0.24) * 0.14, 0.375 - (yn - 0.56) * 0.22)
        right_seam = np.where(yn < 0.56, 0.60 + (yn - 0.24) * 0.16, 0.65 + (yn - 0.56) * 0.26)
        outer_zone = (
            ((xn < left_seam) & (yn >= 0.23) & (yn <= 0.85))
            | ((xn > right_seam) & (yn >= 0.25) & (yn <= 0.76))
        )
        outer = attire & outer_zone
        outer = ndimage.binary_closing(outer, iterations=4)
        outer = keep_largest_components(outer, min_ratio=0.10, max_count=2)
        outer = ndimage.binary_fill_holes(outer) & attire

        one_piece = attire & ~outer
        one_piece = ndimage.binary_closing(one_piece, iterations=5)
        one_piece = keep_largest_components(one_piece, min_ratio=0.25, max_count=1)
        one_piece = ndimage.binary_fill_holes(one_piece) & attire & ~outer

        return {
            "ONE_PIECE": feather_mask(one_piece),
            "OUTERWEAR": feather_mask(outer),
            "ACCESSORY": feather_mask(scarf, sigma=1.8),
        }

    if slug == "thu-hoang-hon":
        head_excl = (yn < 0.19)

        # ACCESSORY: espresso woven leather belt at waist (x 0.37..0.63, y 0.38..0.455)
        belt_roi = (xn >= 0.37) & (xn <= 0.63) & (yn >= 0.38) & (yn <= 0.455)
        belt = belt_roi & (lab[:, :, 0] < 130) & (lab[:, :, 1] >= 129) & (lab[:, :, 2] >= 131)
        belt = ndimage.binary_closing(belt, iterations=3)
        belt = keep_largest_components(belt, min_ratio=0.25, max_count=1)
        belt = ndimage.binary_fill_holes(belt)

        # TOP: bright warm-ivory silk organza short-sleeve blouse (dedicated GrabCut)
        t_init = np.full((h, w), cv2.GC_BGD, dtype=np.uint8)
        t_init[(xn >= 0.29) & (xn <= 0.71) & (yn >= 0.185) & (yn <= 0.42)] = cv2.GC_PR_BGD
        t_init[(xn >= 0.32) & (xn <= 0.68) & (yn >= 0.195) & (yn <= 0.405)] = cv2.GC_PR_FGD
        t_init[(xn >= 0.39) & (xn <= 0.60) & (yn >= 0.22) & (yn <= 0.375)] = cv2.GC_FGD
        t_init[belt | skin | head_excl | (yn > 0.41)] = cv2.GC_BGD
        top = run_grabcut_mask(rgb, t_init, iters=6) & ~belt & ~skin & ~head_excl & (yn >= 0.19) & (yn <= 0.415)
        top = ndimage.binary_closing(top, iterations=4)
        top = keep_largest_components(top, min_ratio=0.18, max_count=1)
        top = ndimage.binary_fill_holes(top) & ~belt & ~skin & ~head_excl

        # BOTTOM: dark charcoal double-pleated wide-leg wool trousers (dedicated GrabCut + dark chroma)
        b_init = np.full((h, w), cv2.GC_BGD, dtype=np.uint8)
        b_init[(xn >= 0.33) & (xn <= 0.68) & (yn >= 0.42) & (yn <= 0.998)] = cv2.GC_PR_BGD
        b_init[(xn >= 0.35) & (xn <= 0.65) & (yn >= 0.43) & (yn <= 0.998)] = cv2.GC_PR_FGD
        b_init[(xn >= 0.39) & (xn <= 0.62) & (yn >= 0.46) & (yn <= 0.96)] = cv2.GC_FGD
        # Exclude bare forearms at sides
        left_arm = (xn < 0.365) & (yn < 0.66)
        b_init[belt | top | skin | left_arm | (yn < 0.425)] = cv2.GC_BGD
        bottom = run_grabcut_mask(rgb, b_init, iters=6) & ~belt & ~top & ~skin & ~left_arm & (yn >= 0.42) & (lab[:, :, 0] <= 125)
        bottom = ndimage.binary_closing(bottom, iterations=6)
        bottom = keep_largest_components(bottom, min_ratio=0.25, max_count=1)
        bottom = ndimage.binary_fill_holes(bottom) & ~belt & ~top & ~skin & ~left_arm

        return {
            "TOP": feather_mask(top),
            "BOTTOM": feather_mask(bottom),
            "ACCESSORY": feather_mask(belt, sigma=1.6),
        }

    if slug == "dong-cashmere":
        head_excl = (yn < 0.19)

        # ACCESSORY: jet-black beaded clutch held at lower-left hip (x 0.30..0.50, y 0.60..0.76)
        clutch_roi = (xn >= 0.30) & (xn <= 0.50) & (yn >= 0.60) & (yn <= 0.76)
        clutch = clutch_roi & (lab[:, :, 0] < 72) & ~skin
        clutch = ndimage.binary_closing(clutch, iterations=4)
        clutch = keep_largest_components(clutch, min_ratio=0.25, max_count=1)
        clutch = ndimage.binary_fill_holes(clutch) & ~skin

        # OUTERWEAR: textured tweed jacket draped on BOTH shoulders/flanks (dedicated dual-core GrabCut)
        o_init = np.full((h, w), cv2.GC_BGD, dtype=np.uint8)
        o_init[(xn >= 0.24) & (xn <= 0.78) & (yn >= 0.19) & (yn <= 0.66)] = cv2.GC_PR_BGD
        o_init[(xn >= 0.25) & (xn <= 0.43) & (yn >= 0.20) & (yn <= 0.64)] = cv2.GC_PR_FGD
        o_init[(xn >= 0.57) & (xn <= 0.76) & (yn >= 0.20) & (yn <= 0.64)] = cv2.GC_PR_FGD
        # Strong FG seeds on BOTH left and right tweed panels
        o_init[(xn >= 0.30) & (xn <= 0.40) & (yn >= 0.26) & (yn <= 0.57)] = cv2.GC_FGD
        o_init[(xn >= 0.61) & (xn <= 0.71) & (yn >= 0.26) & (yn <= 0.57)] = cv2.GC_FGD
        # Definite BGD on center smooth white dress bodice & neck
        o_init[(xn >= 0.43) & (xn <= 0.57) & (yn >= 0.25) & (yn <= 0.66)] = cv2.GC_BGD
        o_init[skin | clutch | head_excl | (yn > 0.65)] = cv2.GC_BGD
        outer = run_grabcut_mask(rgb, o_init, iters=6) & ~skin & ~clutch & ~head_excl & (yn <= 0.65)
        outer = ndimage.binary_closing(outer, iterations=4)
        outer = keep_largest_components(outer, min_ratio=0.18, max_count=2)
        outer = ndimage.binary_fill_holes(outer) & ~skin & ~clutch & ~head_excl

        # ONE_PIECE: pearl-ivory square-neck midi dress (center bodice + full lower midi skirt)
        d_init = np.full((h, w), cv2.GC_BGD, dtype=np.uint8)
        d_init[(xn >= 0.32) & (xn <= 0.70) & (yn >= 0.24) & (yn <= 0.99)] = cv2.GC_PR_BGD
        d_init[(xn >= 0.41) & (xn <= 0.60) & (yn >= 0.25) & (yn <= 0.62)] = cv2.GC_PR_FGD
        d_init[(xn >= 0.35) & (xn <= 0.68) & (yn >= 0.60) & (yn <= 0.985)] = cv2.GC_PR_FGD
        d_init[(xn >= 0.44) & (xn <= 0.57) & (yn >= 0.29) & (yn <= 0.56)] = cv2.GC_FGD
        d_init[(xn >= 0.41) & (xn <= 0.64) & (yn >= 0.66) & (yn <= 0.95)] = cv2.GC_FGD
        d_init[outer | clutch | skin | (yn < 0.245)] = cv2.GC_BGD
        one_piece = run_grabcut_mask(rgb, d_init, iters=6) & ~outer & ~clutch & ~skin & (yn >= 0.245) & (yn <= 0.99)
        one_piece = ndimage.binary_closing(one_piece, iterations=5)
        one_piece = keep_largest_components(one_piece, min_ratio=0.20, max_count=1)
        one_piece = ndimage.binary_fill_holes(one_piece) & ~outer & ~clutch & ~skin

        return {
            "ONE_PIECE": feather_mask(one_piece),
            "OUTERWEAR": feather_mask(outer),
            "ACCESSORY": feather_mask(clutch, sigma=1.8),
        }

    if slug == "atelier-di-san":
        head_excl = (yn < 0.205)

        # ONE_PIECE: deep burgundy wine-red draped satin evening gown (unmistakable crimson Lab a*)
        gown_roi = (yn >= 0.242) & (yn <= 0.942) & (xn >= 0.34) & (xn <= 0.65)
        is_burgundy = (lab[:, :, 1] >= 145) & (lab[:, :, 0] >= 22) & (lab[:, :, 0] <= 150) & ~skin
        gown = gown_roi & is_burgundy & ~head_excl
        gown = ndimage.binary_opening(gown, iterations=2)
        gown = ndimage.binary_closing(gown, iterations=5)
        gown = keep_largest_components(gown, min_ratio=0.20, max_count=1)
        gown = ndimage.binary_fill_holes(gown) & gown_roi & ~skin

        # ACCESSORY: champagne gold beaded clutch held at right-center hip (x 0.545..0.635, y 0.49..0.575)
        c_init = np.full((h, w), cv2.GC_BGD, dtype=np.uint8)
        c_init[(xn >= 0.535) & (xn <= 0.645) & (yn >= 0.48) & (yn <= 0.585)] = cv2.GC_PR_BGD
        c_init[(xn >= 0.555) & (xn <= 0.625) & (yn >= 0.50) & (yn <= 0.568)] = cv2.GC_PR_FGD
        c_init[(xn >= 0.57) & (xn <= 0.61) & (yn >= 0.515) & (yn <= 0.555)] = cv2.GC_FGD
        c_init[gown] = cv2.GC_BGD
        clutch = run_grabcut_mask(rgb, c_init, iters=5, scale=0.75) & ~gown & (lab[:, :, 0] >= 105)
        clutch = ndimage.binary_closing(clutch, iterations=3)
        clutch = keep_largest_components(clutch, min_ratio=0.25, max_count=1)
        clutch = ndimage.binary_fill_holes(clutch) & ~gown

        # OUTERWEAR: warm ivory-sand tailored blazer draped over BOTH shoulders (dedicated GrabCut)
        o_init = np.full((h, w), cv2.GC_BGD, dtype=np.uint8)
        o_init[(xn >= 0.29) & (xn <= 0.74) & (yn >= 0.205) & (yn <= 0.59)] = cv2.GC_PR_BGD
        o_init[(xn >= 0.30) & (xn <= 0.43) & (yn >= 0.215) & (yn <= 0.56)] = cv2.GC_PR_FGD
        o_init[(xn >= 0.58) & (xn <= 0.73) & (yn >= 0.215) & (yn <= 0.56)] = cv2.GC_PR_FGD
        o_init[(xn >= 0.33) & (xn <= 0.40) & (yn >= 0.25) & (yn <= 0.48)] = cv2.GC_FGD
        o_init[(xn >= 0.62) & (xn <= 0.69) & (yn >= 0.25) & (yn <= 0.48)] = cv2.GC_FGD
        o_init[gown | clutch | skin | head_excl] = cv2.GC_BGD
        outer = run_grabcut_mask(rgb, o_init, iters=6) & ~gown & ~clutch & ~skin & ~head_excl & (lab[:, :, 0] >= 120)
        outer = ndimage.binary_closing(outer, iterations=4)
        outer = keep_largest_components(outer, min_ratio=0.18, max_count=2)
        outer = ndimage.binary_fill_holes(outer) & ~gown & ~clutch & ~skin & ~head_excl

        # Ensure gown excludes clutch, blazer & hands cleanly
        gown = gown & ~clutch & ~outer & ~(skin & (yn > 0.48) & (yn < 0.60))

        return {
            "ONE_PIECE": feather_mask(gown),
            "OUTERWEAR": feather_mask(outer),
            "ACCESSORY": feather_mask(clutch, sigma=1.8),
        }

    raise ValueError(f"Unsupported season slug: {slug}")


def build_cream_studio_backdrop(w: int, h: int) -> Image.Image:
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    nx = (xx / float(w) - 0.5) * 2.0
    ny = (yy / float(h) - 0.46) * 2.0
    r2 = np.clip(nx * nx * 0.85 + ny * ny * 0.72, 0.0, 1.8)
    # Warm Quiet Luxury cream #EFE6D5 -> soft studio edge vignette #E5DAC6
    base = np.array([239.0, 230.0, 213.0], dtype=np.float32)
    edge = np.array([227.0, 215.0, 195.0], dtype=np.float32)
    t = np.clip(r2 / 1.45, 0.0, 1.0)[:, :, None]
    bg = np.clip(np.round(base * (1.0 - t) + edge * t), 0, 255).astype(np.uint8)
    return Image.fromarray(bg, mode="RGB")


def recolor_rgba_garment(orig_rgb: np.ndarray, alpha_f: np.ndarray, target_hex: str) -> np.ndarray:
    tr, tg, tb = hex_to_rgb(target_hex)
    tgt_bgr = np.uint8([[[tb, tg, tr]]])
    tgt_lab = cv2.cvtColor(tgt_bgr, cv2.COLOR_BGR2LAB)[0, 0].astype(np.float32)

    orig_bgr = cv2.cvtColor(orig_rgb, cv2.COLOR_RGB2BGR)
    lab = cv2.cvtColor(orig_bgr, cv2.COLOR_BGR2LAB).astype(np.float32)

    valid = alpha_f >= 0.25
    if not np.any(valid):
        return orig_rgb.copy()

    src_l = lab[:, :, 0]
    mean_l = float(np.mean(src_l[valid]))
    tgt_l = float(tgt_lab[0])
    # Preserve shading & folds while shifting to target tone cleanly
    l_scale = max(0.32, min(1.15, (tgt_l + 12.0) / max(30.0, mean_l + 12.0)))
    new_l = np.clip((src_l - mean_l) * max(0.55, l_scale) + tgt_l, 4.0, 250.0)
    new_a = np.full_like(src_l, tgt_lab[1])
    new_b = np.full_like(src_l, tgt_lab[2])

    out_lab = np.stack([new_l, new_a, new_b], axis=-1).astype(np.uint8)
    out_bgr = cv2.cvtColor(out_lab, cv2.COLOR_LAB2BGR)
    return cv2.cvtColor(out_bgr, cv2.COLOR_BGR2RGB)


def generate_missing_studio_variants():
    """Creates clean 720x960 #EFE6D5 studio cards for dam-midi-co-vuong-chiet-eo."""
    slug = "dam-midi-co-vuong-chiet-eo"
    src_path = PROC_DIR / "products" / slug / f"{slug}-rack-2x3.webp"
    if not src_path.exists():
        raise FileNotFoundError(f"Missing source cutout for {slug}: {src_path}")

    im = Image.open(src_path).convert("RGBA")
    arr = np.array(im, dtype=np.uint8)
    # Remove tiny stray border artifacts & dark halo fringe
    solid = keep_largest_components(arr[:, :, 3] >= 90, min_ratio=0.25, max_count=1)
    solid = ndimage.binary_erosion(solid, iterations=1)
    solid = ndimage.binary_fill_holes(solid)
    soft_a = ndimage.gaussian_filter(solid.astype(np.float32), sigma=0.9)
    arr[:, :, 3] = np.clip(np.round(np.minimum(arr[:, :, 3] / 255.0, soft_a) * 255.0), 0, 255).astype(np.uint8)
    ys, xs = np.where(arr[:, :, 3] >= 24)
    x0, x1 = max(0, int(xs.min()) - 2), min(arr.shape[1], int(xs.max()) + 3)
    y0, y1 = max(0, int(ys.min()) - 2), min(arr.shape[0], int(ys.max()) + 3)
    cropped = arr[y0:y1, x0:x1].copy()

    # Decontaminate alpha border
    valid = cropped[:, :, 3] > 180
    if np.any(valid) and not np.all(valid):
        _, idx = ndimage.distance_transform_edt(~valid, return_indices=True)
        bled = cropped[:, :, :3][idx[0], idx[1]]
        cropped[:, :, :3] = np.where(valid[:, :, None], cropped[:, :, :3], bled)

    cutout = Image.fromarray(cropped, mode="RGBA")
    backdrop = build_cream_studio_backdrop(VARIANT_W, VARIANT_H)

    targets = [
        ("ivory", "#F3ECE0", True),
        ("default", "#F3ECE0", True),
        ("espresso", "#46332A", False),
        ("jet-black", "#171615", False),
    ]

    max_w = int(round(VARIANT_W * 0.76))
    max_h = int(round(VARIANT_H * 0.82))
    scale = min(max_w / max(1, cutout.width), max_h / max(1, cutout.height))
    nw = max(32, int(round(cutout.width * scale)))
    nh = max(32, int(round(cutout.height * scale)))
    ox = (VARIANT_W - nw) // 2
    oy = (VARIANT_H - nh) // 2

    for color_key, color_hex, preserve in targets:
        c_arr = np.array(cutout, dtype=np.uint8)
        alpha_f = c_arr[:, :, 3].astype(np.float32) / 255.0
        rgb_final = c_arr[:, :, :3] if preserve else recolor_rgba_garment(c_arr[:, :, :3], alpha_f, color_hex)
        rgba_final = np.dstack([rgb_final, c_arr[:, :, 3]])
        fg_im = Image.fromarray(rgba_final, mode="RGBA").resize((nw, nh), Image.Resampling.LANCZOS)

        canvas = backdrop.copy().convert("RGBA")
        # Soft grounded shadow
        shadow_a = fg_im.split()[3].point(lambda p: int(p * 0.18))
        shadow = Image.new("RGBA", (nw, nh), (54, 40, 26, 0))
        shadow.putalpha(shadow_a)
        shadow = shadow.filter(ImageFilter.GaussianBlur(radius=14))
        canvas.alpha_composite(shadow, (ox + 6, oy + 14))
        canvas.alpha_composite(fg_im, (ox, oy))

        out_path = VITRINE / "variants" / f"{slug}-{color_key}.webp"
        canvas.convert("RGB").save(out_path, "WEBP", quality=92, method=5)
        print(f"  [VARIANT] Generated {out_path.name}")


generate_missing_studio_variants()

manifest_seasons = []
audit_rows = []
debug_tiles = []

for season in cfg["seasons"]:
    slug = season["seasonSlug"]
    raw_path = RAW_DIR / season["rawSourceFile"]
    if not raw_path.exists():
        raise FileNotFoundError(f"Missing raw lookbook source: {raw_path}")

    raw_im = Image.open(raw_path)
    lookbook_im = crop_to_4x5(raw_im, float(season.get("cropTopFrac", 0.03)))
    rgb = np.array(lookbook_im, dtype=np.uint8)

    # Full-color verification (0 B&W images allowed!)
    hsv_check = cv2.cvtColor(cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR), cv2.COLOR_BGR2HSV)
    mean_sat = float(np.mean(hsv_check[:, :, 1]))
    p90_sat = float(np.percentile(hsv_check[:, :, 1], 90))
    if mean_sat < 18.0 or p90_sat < 45.0:
        raise RuntimeError(f"FAIL grayscale/low-color detected on {slug}: mean_sat={mean_sat:.1f}, p90_sat={p90_sat:.1f}")

    # Save 960x1200 WebP to ALL 3 authoritative locations so Storefront, Seed Cache & MinIO are 100% synced!
    lb_vitrine_path = VITRINE / "lookbooks" / f"{slug}-base.webp"
    lb_proc_path = PROC_DIR / "seasons" / f"{slug}.webp"
    lb_proc_legacy = PROC_DIR / "seasons" / f"season-{slug}.webp"
    lookbook_im.save(lb_vitrine_path, "WEBP", quality=92, method=5)
    lookbook_im.save(lb_proc_path, "WEBP", quality=92, method=5)
    lookbook_im.save(lb_proc_legacy, "WEBP", quality=92, method=5)
    if MINIO_SEED_DIR.exists():
        lookbook_im.save(MINIO_SEED_DIR / f"season-{slug}.webp", "WEBP", quality=92, method=5)

    # Segment per-slot masks
    slot_masks = segment_season_masks(slug, rgb)
    manifest_slots = []

    debug_img = lookbook_im.copy().convert("RGBA")
    tint_colors = [
        (210, 145, 55, 85),
        (55, 145, 190, 85),
        (195, 65, 95, 105),
    ]

    for s_idx, slot in enumerate(season["wearableSlots"]):
        s_key = slot["slotKey"]
        alpha_f = slot_masks[s_key]
        mask_im = soft_alpha_to_rgba(alpha_f)
        mask_rel = f"/images/seasons-vitrine/masks/{slug}-mask-{s_key.lower()}.png"
        mask_path = VITRINE / "masks" / f"{slug}-mask-{s_key.lower()}.png"
        mask_im.save(mask_path, "PNG", optimize=True)

        bbox = compute_mask_bbox(alpha_f)
        px_count = int(np.sum(alpha_f >= 0.25))
        if px_count > 0:
            dom_rgb = tuple(np.mean(rgb[alpha_f >= 0.25], axis=0).tolist())
            dom_hex = rgb_to_hex(dom_rgb)
        else:
            dom_hex = "#000000"

        v0 = slot["variants"][0]
        # Verify studio cutout exists on disk
        v0_disk = ROOT / "apps" / "storefront" / "public" / v0["studioCutoutUrl"].lstrip("/")
        if not v0_disk.exists():
            raise FileNotFoundError(f"Missing studio cutout for {slug}/{s_key}: {v0_disk}")

        # Overlay debug tint + pin dot
        overlay_arr = np.zeros((LOOKBOOK_H, LOOKBOOK_W, 4), dtype=np.uint8)
        tc = tint_colors[s_idx % len(tint_colors)]
        overlay_arr[:, :, 0] = tc[0]
        overlay_arr[:, :, 1] = tc[1]
        overlay_arr[:, :, 2] = tc[2]
        overlay_arr[:, :, 3] = np.clip(np.round(alpha_f * tc[3]), 0, 255).astype(np.uint8)
        debug_img = Image.alpha_composite(debug_img, Image.fromarray(overlay_arr, mode="RGBA"))

        manifest_slots.append({
            "slotKey": s_key,
            "productSlug": slot["productSlug"],
            "shortPinLabel": slot["shortPinLabel"],
            "defaultColorKey": v0["colorKey"],
            "pinPosition": slot["pinPosition"],
            "garmentRegionMask": mask_rel,
            "maskBbox": bbox,
            "materialOpticalProfile": slot["materialOpticalProfile"],
            "variants": slot["variants"],
        })

        audit_rows.append({
            "season": slug,
            "slot": s_key,
            "product": slot["productSlug"],
            "px": px_count,
            "dominantOnModel": dom_hex,
            "cardColor": v0["colorHex"],
            "cardColorName": v0["colorName"],
            "pin": slot["pinPosition"],
            "meanSat": round(mean_sat, 1),
        })

    # Draw pin markers on debug tile
    draw = ImageDraw.Draw(debug_img)
    for slot in season["wearableSlots"]:
        px = int(round(slot["pinPosition"]["xPercent"] / 100.0 * LOOKBOOK_W))
        py = int(round(slot["pinPosition"]["yPercent"] / 100.0 * LOOKBOOK_H))
        draw.ellipse((px - 14, py - 14, px + 14, py + 14), fill=(251, 247, 239, 245), outline=(176, 138, 74, 255), width=4)
        draw.rectangle((px + 18, py - 16, min(LOOKBOOK_W - 8, px + 260), py + 16), fill=(28, 20, 16, 210))
        draw.text((px + 26, py - 8), f"{slot['slotKey']}: {slot['shortPinLabel']}", fill=(251, 247, 239, 255))
    debug_tiles.append(debug_img.convert("RGB").resize((480, 600), Image.Resampling.LANCZOS))

    manifest_seasons.append({
        "seasonSlug": slug,
        "order": season["order"],
        "months": season["months"],
        "name": season["name"],
        "shortName": season["shortName"],
        "materialHeadline": season["materialHeadline"],
        "note": season["note"],
        "isCurrent": season["isCurrent"],
        "outfitFormula": season["outfitFormula"],
        "defaultMacroSlotKey": season["defaultMacroSlotKey"],
        "baseEditorialImageUrl": f"/images/seasons-vitrine/lookbooks/{slug}-base.webp",
        "restyleCacheMap": {},
        "wearableSlots": manifest_slots,
    })

if DEBUG_SHEET and len(debug_tiles) == 6:
    sheet = Image.new("RGB", (480 * 3, 600 * 2), (251, 247, 239))
    for i, tile in enumerate(debug_tiles):
        sheet.paste(tile, ((i % 3) * 480, (i // 3) * 600))
    Path(DEBUG_SHEET).parent.mkdir(parents=True, exist_ok=True)
    sheet.save(DEBUG_SHEET, "JPEG", quality=88)
    print(f"[DEBUG] Saved 6-season mask & pin verification contact sheet to {DEBUG_SHEET}")

manifest = {
    "version": "3.0.0",
    "generatedAt": cfg["generatedAt"],
    "urlPrefix": "/images/seasons-vitrine",
    "dimensions": {
        "lookbook": {"width": LOOKBOOK_W, "height": LOOKBOOK_H},
        "mask": {"width": LOOKBOOK_W, "height": LOOKBOOK_H},
        "variantCard": {"width": VARIANT_W, "height": VARIANT_H},
        "macroSwatch": {"width": 800, "height": 600},
    },
    "counts": {
        "lookbooks": len(manifest_seasons),
        "masks": sum(len(s["wearableSlots"]) for s in manifest_seasons),
        "variants": sum(len(sl["variants"]) for s in manifest_seasons for sl in s["wearableSlots"]),
    },
    "seasons": manifest_seasons,
}

manifest_path = VITRINE / "manifest.json"
manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(f"[OK] Wrote {manifest_path} (v3.0.0, {len(manifest_seasons)} seasons, {manifest['counts']['masks']} masks)")
print(json.dumps({"audit": audit_rows}, ensure_ascii=False, indent=2))
`;

async function main() {
  validateOutfitPlan(CANONICAL_SEASONS_OUTFIT_PLAN);
  console.log('[OK] All 6 seasons passed strict Outfit-Bound Formula validation (0 conflicting slots).');

  const tmpCfg = path.join(os.tmpdir(), `tryvibe-sync-seasons-${Date.now()}.json`);
  const tmpPy = path.join(os.tmpdir(), `tryvibe-sync-seasons-${Date.now()}.py`);
  fs.writeFileSync(
    tmpCfg,
    JSON.stringify(
      {
        rootDir: ROOT_DIR,
        vitrineDir: VITRINE_DIR,
        rawDir: RAW_CACHE_DIR,
        processedDir: PROCESSED_DIR,
        minioSeedDir: LOCAL_MINIO_SEED_DIR,
        debugSheetPath: DEBUG_SHEET_PATH,
        generatedAt: new Date().toISOString(),
        seasons: CANONICAL_SEASONS_OUTFIT_PLAN,
      },
      null,
      2,
    ),
    'utf8',
  );
  fs.writeFileSync(tmpPy, PYTHON_PIPELINE, 'utf8');

  try {
    const pyBin = resolvePythonBin();
    const res = spawnSync(pyBin, [tmpPy, tmpCfg], {
      cwd: ROOT_DIR,
      stdio: 'inherit',
      windowsHide: true,
    });
    if (res.status !== 0) {
      throw new Error(`Python sync pipeline exited with code ${res.status}`);
    }
  } finally {
    fs.rmSync(tmpCfg, { force: true });
    fs.rmSync(tmpPy, { force: true });
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (isMain) {
  main().catch((err) => {
    console.error('[ERR] sync-season-lookbook-outfits:', err);
    process.exit(1);
  });
}
