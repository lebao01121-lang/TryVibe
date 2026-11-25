'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { io, type Socket } from 'socket.io-client';
import {
  FitType,
  Gender,
  HTTP_HEADERS,
  OutfitSlot,
  ProductStatus,
  SizeCode,
  StockStatusSummary,
  StretchLevel,
  TryOnGarmentCategory,
  TryOnMode,
  TryOnSource,
  type CartDto,
  type CartItemDto,
  type ProductSpuDto,
  type TryOnPoseLandmarks,
  type TryOnUploadUrlResponse,
} from '@atelier/contracts';
import {
  applyCameraActiveState,
  useCameraGpuGuard,
  useMotionState,
  useScrollLock,
} from '@atelier/motion-kit';
import {
  AnatomicalFitVisualizer,
  BODY_FIT_PREFERENCE_OPTIONS,
  BODY_PROFILE_UPDATED_EVENT,
  isCanonicalSizeCode,
  loadSharedBodyProfile,
  mapProfileFitToApiFit,
  saveSharedBodyProfile,
  type BodyProfileFitPreference,
  type CanonicalSizeCode,
  type ExtendedSizeRecommendResponse,
  type SharedBodyProfileV1,
} from '@/components/AnatomicalFitVisualizer';
import { showAtelierToast } from '@/components/AtelierToastProvider';
import {
  saveStudioSizeProfile,
  type StudioSizeProfile,
} from '@/features/outfit-studio/SizeGuideModal';
import { apiFetch, getStoredSession } from '@/lib/api-client';
import {
  FALLBACK_PRODUCTS,
  FORMAT_VND,
  getPrimaryVariantImage,
} from '@/lib/catalog-data';
import { getOrCreateGuestSessionId } from '@/lib/guest-session';
import {
  emitCartUpdated,
  loadActiveStudioOutfitSnapshot,
  loadCachedCartSnapshot,
  saveCachedCartSnapshot,
  type ActiveStudioOutfitSnapshot,
  type TryOnGarmentRef,
} from '@/lib/storefront-actions';
import { BeforeAfterSlider } from './BeforeAfterSlider';
import { CompactCompareBar, type SavedTryOnLook } from './CompactCompareBar';
import { OpticalTryOnScan } from './OpticalTryOnScan';
import { PhotoUploadGate } from './PhotoUploadGate';
import { SmartMirrorCamera } from './SmartMirrorCamera';
import styles from './tryon-modal.module.css';
import {
  QUICK_TRYON_MODELS,
  computeTryOnCacheKey,
  loadQuickModelAsSessionFrame,
  sessionPersonStore,
  synthesizeTryOn,
  type LightingPresetId,
  type QuickTryOnModelPreset,
  type SessionPersonFrame,
  type TryOnGarmentSlot,
  type TryOnSynthesisGarmentInput,
  type TryOnSynthesisResult,
} from './vton';
import {
  ATELIER_PHOM_BADGE,
  INSTANT_CACHE_BADGE,
  isAbortError,
  resolveProviderBadge,
} from './vton/tryOnSynthesisClient';
import type {
  NormalizedPoseLandmark,
  TryOnSynthesisMode,
  TryOnSynthesisProgress,
} from './vton/types';

export type { TryOnGarmentRef };

export interface VirtualTryOnModalProps {
  open: boolean;
  onClose?: () => void;
  initialMode?: TryOnMode;
  initialUpper?: TryOnGarmentRef | ProductSpuDto | null;
  initialLower?: TryOnGarmentRef | ProductSpuDto | null;
  initialOnePiece?: TryOnGarmentRef | ProductSpuDto | null;
  initialOuterwear?: TryOnGarmentRef | ProductSpuDto | null;
  products: ProductSpuDto[];
  onAddedToBag?: (cart?: CartDto) => void;
  embedded?: boolean;
}

type TryOnEngineMode = 'ar_mirror' | 'server_vton';
type InputTabId = 'camera' | 'upload' | 'presets';
type WardrobeSourceTab = 'cart' | 'studio' | 'catalog';

interface TryOnQuotaSnapshot {
  remainingQuota: number;
  dailyLimit: number;
  usedToday?: number;
  ipRemaining?: number;
  ipLimit?: number;
  backend?: string;
}

interface ServerVtonPortraitDraft {
  label: string;
  previewDataUrl: string;
  bytes: Uint8Array;
  contentType: 'image/jpeg' | 'image/png' | 'image/webp';
  sha256Hash: string;
  fileHeaderBase64: string;
  source: TryOnSource;
  poseLandmarks?: TryOnPoseLandmarks | null;
  uploadedTempImageId?: string;
  uploadedObjectKey?: string;
  uploadedPurgeAtMs?: number;
}

interface ServerVtonSessionResult {
  sessionId: string;
  resultUrl: string;
  providerUsed: string;
  providerDisplayBadge: string;
  cacheHit: boolean;
  expiresAtIso: string | null;
  purgeAtMs: number;
  remainingQuota: number | null;
  durationMs: number | null;
  usedSynthesizeFallback: boolean;
}

interface ServerVtonErrorBanner {
  code: string;
  message: string;
  quotaRefunded: boolean;
  remainingQuota: number | null;
}

const MAX_SERVER_VTON_BYTES = 10 * 1024 * 1024;
const SERVER_VTON_POLL_INTERVAL_MS = 1200;
const SERVER_VTON_TIMEOUT_MS = 55_000;
const SERVER_VTON_DEFAULT_TTL_SEC = 900;

function detectImageMimeFromBytes(
  bytes: Uint8Array,
): 'image/jpeg' | 'image/png' | 'image/webp' | null {
  if (bytes.length < 12) return null;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp';
  }
  return null;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, Math.min(bytes.length, i + chunkSize));
    binary += String.fromCharCode(...chunk);
  }
  return typeof btoa === 'function' ? btoa(binary) : '';
}

function dataUrlToUint8Array(dataUrl: string): Uint8Array | null {
  const commaIdx = dataUrl.indexOf(',');
  if (commaIdx < 0) return null;
  try {
    const raw = atob(dataUrl.slice(commaIdx + 1));
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i += 1) {
      bytes[i] = raw.charCodeAt(i);
    }
    return bytes;
  } catch {
    return null;
  }
}

async function computeSha256HexFromBytes(bytes: Uint8Array): Promise<string> {
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const copied = new Uint8Array(bytes.byteLength);
    copied.set(bytes);
    const digest = await crypto.subtle.digest('SHA-256', copied.buffer);
    return Array.from(new Uint8Array(digest), (b) =>
      b.toString(16).padStart(2, '0'),
    ).join('');
  }
  let h1 = 0x811c9dc5;
  let h2 = 0xdeadbeef;
  const step = Math.max(1, Math.floor(bytes.length / 4096));
  for (let i = 0; i < bytes.length; i += step) {
    const ch = bytes[i] ?? 0;
    h1 = Math.imul(h1 ^ ch, 0x01000193);
    h2 = Math.imul(h2 ^ ch, 2654435761);
  }
  const chunk = `${(h1 >>> 0).toString(16).padStart(8, '0')}${(h2 >>> 0)
    .toString(16)
    .padStart(8, '0')}`;
  return (chunk + chunk + chunk + chunk).slice(0, 64);
}

function toServerPoseLandmarks(
  landmarks?: NormalizedPoseLandmark[],
): TryOnPoseLandmarks | null {
  if (!landmarks || landmarks.length < 25) return null;
  const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
  const mapPoint = (idx: number) => {
    const pt = landmarks[idx];
    if (!pt || !Number.isFinite(pt.x) || !Number.isFinite(pt.y)) {
      return undefined;
    }
    return {
      x: clamp01(pt.x),
      y: clamp01(pt.y),
      visibility: clamp01(pt.visibility ?? 0.9),
    };
  };
  const nose = mapPoint(0);
  const leftShoulder = mapPoint(11);
  const rightShoulder = mapPoint(12);
  const leftHip = mapPoint(23);
  const rightHip = mapPoint(24);
  if (!nose && !leftShoulder && !rightShoulder) return null;
  return {
    ...(nose ? { nose } : {}),
    ...(leftShoulder ? { leftShoulder } : {}),
    ...(rightShoulder ? { rightShoulder } : {}),
    ...(leftHip ? { leftHip } : {}),
    ...(rightHip ? { rightHip } : {}),
  };
}

function resolveServerRealtimeUrl(): string {
  if (typeof window === 'undefined') {
    return '/realtime';
  }
  const explicit = process.env.NEXT_PUBLIC_REALTIME_URL?.trim();
  if (explicit) {
    return `${explicit.replace(/\/+$/, '')}/realtime`;
  }
  const { protocol, hostname, port } = window.location;
  if (port === '3000' && (hostname === '127.0.0.1' || hostname === 'localhost')) {
    return `${protocol}//${hostname}:4000/realtime`;
  }
  return '/realtime';
}

function parseExpiryToMs(iso: string | null | undefined): number {
  if (iso) {
    const parsed = Date.parse(iso);
    if (Number.isFinite(parsed) && parsed > Date.now()) {
      return parsed;
    }
  }
  return Date.now() + SERVER_VTON_DEFAULT_TTL_SEC * 1000;
}

function formatMmSsCountdown(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const mins = Math.floor(safe / 60);
  const secs = safe % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function readStringField(
  obj: Record<string, unknown>,
  ...keys: string[]
): string | null {
  for (const key of keys) {
    const val = obj[key];
    if (typeof val === 'string' && val.trim().length > 0) {
      return val.trim();
    }
  }
  return null;
}

function readNumberField(
  obj: Record<string, unknown>,
  ...keys: string[]
): number | null {
  for (const key of keys) {
    const val = obj[key];
    if (typeof val === 'number' && Number.isFinite(val)) {
      return val;
    }
    if (typeof val === 'string' && val.trim().length > 0) {
      const parsed = Number(val);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return null;
}

interface SlotSelection {
  productId: string;
  variantIdx: number;
}

type ActiveSlots = Partial<Record<TryOnGarmentSlot, SlotSelection>>;

interface ActiveGarmentSpec {
  slot: TryOnGarmentSlot;
  product: ProductSpuDto;
  productId: string;
  variantId: string;
  variantIdx: number;
  skuId: string;
  slug: string;
  name: string;
  colorName: string;
  colorHex: string;
  garmentImageUrl: string;
  priceVnd: number;
}

const GUEST_STORAGE_KEY = 'atelier_guest_session_id';
const CANONICAL_SIZES = ['XS', 'S', 'M', 'L', 'XL'] as const;
const MAX_SAVED_LOOKS = 3;

const SLOT_ORDER: readonly TryOnGarmentSlot[] = [
  'upper',
  'lower',
  'onePiece',
  'outerwear',
];

const SLOT_LABELS: Record<TryOnGarmentSlot, string> = {
  upper: 'Áo',
  lower: 'Quần/Váy',
  onePiece: 'Đầm',
  outerwear: 'Áo khoác',
};

const FIT_BADGE_LABELS: Record<string, string> = {
  SLIM: 'SLIM',
  REGULAR: 'REGULAR',
  RELAXED: 'RELAXED',
  OVERSIZE: 'RELAXED',
};

const BODY_FIT_PREF_VN: Record<BodyProfileFitPreference, string> = {
  SNUG: 'Ôm vừa',
  TRUE_TO_SIZE: 'Chuẩn phom',
  RELAXED: 'Thoải mái',
};

const INPUT_TABS: ReadonlyArray<{
  id: InputTabId;
  label: string;
  shortLabel: string;
  testId: string;
}> = [
  {
    id: 'camera',
    label: 'Gương Camera Thông Minh',
    shortLabel: 'Gương Camera',
    testId: 'tryon-tab-camera',
  },
  {
    id: 'upload',
    label: 'Tải Ảnh Của Bạn',
    shortLabel: 'Tải Ảnh',
    testId: 'tryon-tab-upload',
  },
  {
    id: 'presets',
    label: 'Dáng Mẫu Thử Nhanh',
    shortLabel: 'Dáng Mẫu',
    testId: 'tryon-tab-presets',
  },
];

const CATEGORY_FILTER_OPTIONS: ReadonlyArray<{
  id: 'ALL' | TryOnGarmentSlot;
  label: string;
}> = [
  { id: 'ALL', label: 'Tất cả' },
  { id: 'upper', label: 'Áo' },
  { id: 'lower', label: 'Quần / Váy' },
  { id: 'onePiece', label: 'Đầm' },
  { id: 'outerwear', label: 'Áo khoác' },
];

function getGuestHeader(): Record<string, string> {
  if (typeof window === 'undefined') return {};
  try {
    let guestId = window.localStorage.getItem(GUEST_STORAGE_KEY);
    if (!guestId) {
      guestId =
        typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? `guest-${crypto.randomUUID()}`
          : `guest-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      window.localStorage.setItem(GUEST_STORAGE_KEY, guestId);
    }
    return { [HTTP_HEADERS.GUEST_SESSION_ID]: guestId };
  } catch {
    return {};
  }
}

function isAccessoryProduct(product: ProductSpuDto): boolean {
  const text =
    `${product.categorySlug ?? ''} ${product.categoryName ?? ''} ${product.slug} ${product.name}`.toLowerCase();
  return (
    text.includes('phu-kien') ||
    text.includes('phụ kiện') ||
    text.includes('clutch') ||
    text.includes('vi-cam-tay') ||
    text.includes('ví cầm tay') ||
    text.includes('khan-lua') ||
    text.includes('khăn') ||
    text.includes('that-lung') ||
    text.includes('thắt lưng') ||
    text.includes('tui-') ||
    text.includes('accessory')
  );
}

function inferGarmentSlot(product: ProductSpuDto): TryOnGarmentSlot {
  const text =
    `${product.categorySlug ?? ''} ${product.categoryName ?? ''} ${product.slug} ${product.name}`.toLowerCase();

  if (
    product.tryonGarmentCategory === TryOnGarmentCategory.OVERALL ||
    text.includes('dam-') ||
    text.includes('đầm') ||
    text.includes('vay-lien') ||
    text.includes('ao-dai') ||
    text.includes('áo dài')
  ) {
    return 'onePiece';
  }

  if (
    product.tryonGarmentCategory === TryOnGarmentCategory.LOWER ||
    text.includes('quan-') ||
    text.includes('quần') ||
    text.includes('chan-vay') ||
    text.includes('chân váy') ||
    text.includes('culottes')
  ) {
    return 'lower';
  }

  if (
    text.includes('ao-khoac') ||
    text.includes('áo khoác') ||
    text.includes('ao-blazer') ||
    text.includes('blazer') ||
    text.includes('trench') ||
    text.includes('tweed') ||
    text.includes('cardigan') ||
    text.includes('mang-to') ||
    text.includes('măng tô')
  ) {
    return 'outerwear';
  }

  return 'upper';
}

function mapSlotToOutfitSlot(slot: TryOnGarmentSlot): OutfitSlot {
  if (slot === 'lower') return OutfitSlot.BOTTOM;
  if (slot === 'onePiece') return OutfitSlot.ONE_PIECE;
  if (slot === 'outerwear') return OutfitSlot.OUTERWEAR;
  return OutfitSlot.TOP;
}

function resolveProductFromRef(
  ref: TryOnGarmentRef | ProductSpuDto | null | undefined,
  products: ProductSpuDto[],
): ProductSpuDto | null {
  if (!ref) return null;
  if ('id' in ref && 'variants' in ref) {
    return products.find((p) => p.id === ref.id) ?? ref;
  }
  return (
    products.find((p) => p.id === ref.productId) ??
    (ref.slug ? products.find((p) => p.slug === ref.slug) : undefined) ??
    null
  );
}

function resolveVariantIdxFromRef(
  ref: TryOnGarmentRef | ProductSpuDto | null | undefined,
  product: ProductSpuDto | null,
): number {
  if (!ref || !product) return 0;
  if ('variantId' in ref && ref.variantId) {
    const found = product.variants.findIndex((v) => v.id === ref.variantId);
    if (found >= 0) return found;
  }
  return 0;
}

function synthesizeProductFromCartItem(item: CartItemDto): ProductSpuDto {
  const slot = item.slot;
  const tryonCat =
    slot === OutfitSlot.ONE_PIECE
      ? TryOnGarmentCategory.OVERALL
      : slot === OutfitSlot.BOTTOM
        ? TryOnGarmentCategory.LOWER
        : TryOnGarmentCategory.UPPER;

  const img = item.imageUrl || null;
  const now = new Date().toISOString();

  return {
    id: item.productId,
    categoryId: 'cat-cart',
    categorySlug:
      slot === OutfitSlot.OUTERWEAR
        ? 'ao-khoac'
        : slot === OutfitSlot.BOTTOM
          ? 'quan-chan-vay'
          : slot === OutfitSlot.ONE_PIECE
            ? 'dam-du-tiec'
            : 'ao-so-mi',
    categoryName: 'Trong giỏ hàng',
    slug: item.slug,
    name: item.productName,
    subtitle: `${item.colorName} · Size ${item.sizeCode}`,
    brandName: 'Tầm Xuân Atelier',
    description: item.productName,
    fabricComposition: 'Chất liệu Atelier cao cấp',
    fitType: FitType.REGULAR,
    stretchLevel: StretchLevel.LIGHT,
    fabricWeight: '210gsm',
    gender: Gender.WOMEN,
    isTryonEnabled: true,
    tryonGarmentCategory: tryonCat,
    tryonFlatAssetUrl: img,
    fitCalibrationNote: null,
    minPriceVnd: item.unitPriceVnd,
    stockStatusSummary: item.inStock
      ? StockStatusSummary.IN_STOCK
      : StockStatusSummary.OUT_OF_STOCK,
    status: ProductStatus.PUBLISHED,
    sizeChartId: null,
    sizeChart: null,
    occasionSlugs: [],
    seasonSlugs: [],
    variants: [
      {
        id: item.variantId,
        productId: item.productId,
        colorName: item.colorName,
        colorHex: item.colorHex || '#EBD9B4',
        lookbookMainUrl: img,
        rackFrontAssetId: null,
        rackBackAssetId: null,
        rackFrontUrl: img,
        rackBackUrl: null,
        studioLayerAssetId: null,
        studioLayerUrl: img,
        tryonFlatPreviewUrl: img,
        layerSpecJsonb: null,
        skus: [
          {
            id: item.skuId,
            variantId: item.variantId,
            skuCode: `${item.slug}-${item.sizeCode}`,
            sizeCode: (CANONICAL_SIZES.includes(
              item.sizeCode as (typeof CANONICAL_SIZES)[number],
            )
              ? item.sizeCode
              : SizeCode.M) as SizeCode,
            basePriceVnd: item.unitPriceVnd,
            salePriceVnd: item.unitPriceVnd,
            weightGrams: 340,
            inStock: item.inStock,
            isReturnable: true,
          },
        ],
      },
    ],
    createdAt: now,
    updatedAt: now,
  };
}

function buildActiveGarmentSpec(
  slot: TryOnGarmentSlot,
  product: ProductSpuDto,
  variantIdx: number,
  selectedSizeCode: string,
): ActiveGarmentSpec {
  const safeIdx =
    variantIdx >= 0 && variantIdx < product.variants.length ? variantIdx : 0;
  const variant = product.variants[safeIdx] ?? product.variants[0];
  const { flatUrl, lookbookUrl } = getPrimaryVariantImage(product, safeIdx);

  const garmentImageUrl =
    variant?.studioLayerUrl ||
    variant?.rackFrontUrl ||
    variant?.tryonFlatPreviewUrl ||
    flatUrl ||
    lookbookUrl;

  const sku =
    variant?.skus.find((s) => s.sizeCode === selectedSizeCode && s.inStock) ??
    variant?.skus.find((s) => s.sizeCode === selectedSizeCode) ??
    variant?.skus.find((s) => s.inStock) ??
    variant?.skus[0];

  return {
    slot,
    product,
    productId: product.id,
    variantId: variant?.id ?? `${product.id}-default`,
    variantIdx: safeIdx,
    skuId: sku?.id ?? `${product.id}-sku`,
    slug: product.slug,
    name: product.name,
    colorName: variant?.colorName ?? 'Nguyên bản',
    colorHex: variant?.colorHex ?? '#EBD9B4',
    garmentImageUrl,
    priceVnd: sku?.salePriceVnd ?? sku?.basePriceVnd ?? product.minPriceVnd,
  };
}

function buildLocalFallbackCart(
  previous: CartDto | null,
  itemsToAdd: ActiveGarmentSpec[],
  selectedSizeCode: string,
): CartDto {
  const existingItems = previous?.items ? [...previous.items] : [];
  const bundleGroupId =
    itemsToAdd.length >= 2 ? `tryon-bundle-${Date.now()}` : null;

  for (const spec of itemsToAdd) {
    const existingIdx = existingItems.findIndex(
      (i) => i.skuId === spec.skuId && i.variantId === spec.variantId,
    );
    if (existingIdx >= 0) {
      const curr = existingItems[existingIdx]!;
      const nextQty = curr.qty + 1;
      existingItems[existingIdx] = {
        ...curr,
        qty: nextQty,
        lineTotalVnd: nextQty * curr.unitPriceVnd,
      };
    } else {
      existingItems.push({
        id: `local-${spec.skuId}-${Date.now()}`,
        skuId: spec.skuId,
        productId: spec.productId,
        variantId: spec.variantId,
        slug: spec.slug,
        productName: spec.name,
        colorName: spec.colorName,
        colorHex: spec.colorHex,
        sizeCode: selectedSizeCode,
        imageUrl: spec.garmentImageUrl,
        qty: 1,
        unitPriceVnd: spec.priceVnd,
        lineTotalVnd: spec.priceVnd,
        slot: mapSlotToOutfitSlot(spec.slot),
        bundleGroupId,
        fromAiTryon: true,
        inStock: true,
        availableQty: 5,
        lowStockWarning: false,
      });
    }
  }

  const totalQty = existingItems.reduce((sum, i) => sum + i.qty, 0);
  const subtotalVnd = existingItems.reduce((sum, i) => sum + i.lineTotalVnd, 0);
  const packagingPriceVnd = previous?.packagingPriceVnd ?? 0;
  const comboDiscountPct = previous?.comboDiscountPct ?? 0;
  const comboDiscountVnd = previous?.comboDiscountVnd ?? 0;
  const freeShipThresholdVnd = previous?.freeShipThresholdVnd ?? 2_000_000;

  return {
    cartKey: previous?.cartKey ?? `local-cart-${Date.now()}`,
    items: existingItems,
    packagingOptionId: previous?.packagingOptionId ?? null,
    packagingName: previous?.packagingName ?? null,
    packagingPriceVnd,
    giftNote: previous?.giftNote ?? null,
    subtotalVnd,
    comboDiscountPct,
    comboDiscountVnd,
    totalVnd: Math.max(0, subtotalVnd - comboDiscountVnd) + packagingPriceVnd,
    totalQty,
    freeShipThresholdVnd,
    remainingForFreeShipVnd: Math.max(0, freeShipThresholdVnd - subtotalVnd),
    updatedAt: new Date().toISOString(),
  };
}

function formatProviderBadge(result: TryOnSynthesisResult | null): string {
  if (!result) return ATELIER_PHOM_BADGE;
  return resolveProviderBadge(
    result.provider,
    result.providerBadge,
    result.cacheHit,
  );
}

export function VirtualTryOnModal({
  open,
  onClose,
  initialMode,
  initialUpper,
  initialLower,
  initialOnePiece,
  initialOuterwear,
  products,
  onAddedToBag,
  embedded = false,
}: VirtualTryOnModalProps) {
  const isActive = open || Boolean(embedded);

  // Strict GPU & Scroll Protection while studio is active
  useMotionState();
  useCameraGpuGuard(isActive);
  useScrollLock(isActive);

  // Client portal mount guard
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  // Embedded `/thu-do-ai` QuickBagDrawer z-index handshake (`#order.on` has z-85)
  const [quickBagDrawerOpen, setQuickBagDrawerOpen] = useState(false);
  useEffect(() => {
    if (!embedded || typeof document === 'undefined') {
      setQuickBagDrawerOpen(false);
      return undefined;
    }

    const syncDrawerState = () => {
      const drawer = document.getElementById('order');
      setQuickBagDrawerOpen(Boolean(drawer?.classList.contains('on')));
    };

    syncDrawerState();

    const observer = new MutationObserver(syncDrawerState);
    const drawer = document.getElementById('order');
    if (drawer) {
      observer.observe(drawer, {
        attributes: true,
        attributeFilter: ['class'],
      });
    } else {
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class'],
      });
    }

    return () => {
      observer.disconnect();
    };
  }, [embedded]);

  // Ensure `document.body.dataset.cameraActive` cleans up cleanly on unmount/close
  useEffect(() => {
    if (typeof document === 'undefined' || !document.body) return undefined;
    if (isActive) {
      applyCameraActiveState(true);
      document.body.dataset.cameraActive = 'true';
    } else {
      applyCameraActiveState(false);
      delete document.body.dataset.cameraActive;
    }
    return () => {
      if (typeof document !== 'undefined' && document.body) {
        applyCameraActiveState(false);
        delete document.body.dataset.cameraActive;
      }
    };
  }, [isActive]);

  // Catalog with FALLBACK_PRODUCTS safety net
  const allProducts = useMemo(() => {
    const base = products.length > 0 ? products : FALLBACK_PRODUCTS;
    const wearable = base.filter(
      (p) =>
        !isAccessoryProduct(p) &&
        p.tryonGarmentCategory !== TryOnGarmentCategory.NONE,
    );
    return wearable.length > 0 ? wearable : base;
  }, [products]);

  const productById = useMemo(() => {
    const map = new Map<string, ProductSpuDto>();
    for (const p of allProducts) {
      map.set(p.id, p);
    }
    return map;
  }, [allProducts]);

  // Engine Mode Switch: AR Mirror (Stage 1/2/3 intact) vs Server VTON (:4009)
  const [engineMode, setEngineMode] = useState<TryOnEngineMode>('ar_mirror');

  // Server VTON (:4009) State: Privacy Consent, Quota, Presigned Upload, Socket.io + Polling, Telemetry
  const [serverQuota, setServerQuota] = useState<TryOnQuotaSnapshot | null>(null);
  const [serverQuotaLoading, setServerQuotaLoading] = useState(false);
  const [serverPrivacyConsent, setServerPrivacyConsent] = useState(false);
  const [serverPortrait, setServerPortrait] =
    useState<ServerVtonPortraitDraft | null>(null);
  const [serverFileError, setServerFileError] = useState<string | null>(null);
  const [serverRunning, setServerRunning] = useState(false);
  const [serverProgress, setServerProgress] =
    useState<TryOnSynthesisProgress | null>(null);
  const [serverResult, setServerResult] =
    useState<ServerVtonSessionResult | null>(null);
  const [serverErrorBanner, setServerErrorBanner] =
    useState<ServerVtonErrorBanner | null>(null);
  const [serverPurgeSeconds, setServerPurgeSeconds] = useState<number>(
    SERVER_VTON_DEFAULT_TTL_SEC,
  );
  const [serverPurgedNotice, setServerPurgedNotice] = useState(false);
  const serverFileInputRef = useRef<HTMLInputElement | null>(null);
  const serverAbortRef = useRef<AbortController | null>(null);
  const serverSocketRef = useRef<Socket | null>(null);
  const serverPollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Input Mode & Locked Session Person Frame ("Chụp 1 Lần — Mặc Thử Cả Tủ Đồ")
  const [inputTab, setInputTab] = useState<InputTabId>('camera');
  const [selectedPresetId, setSelectedPresetId] = useState<string>(
    QUICK_TRYON_MODELS[1]?.id ?? QUICK_TRYON_MODELS[0]!.id,
  );
  const [personFrame, setPersonFrame] = useState<SessionPersonFrame | null>(null);
  const [loadingPresetId, setLoadingPresetId] = useState<string | null>(null);
  const [remainingSeconds, setRemainingSeconds] = useState<number>(900);
  const [lightingPreset, setLightingPreset] =
    useState<LightingPresetId>('atelier');

  // Synthesis pipeline state
  const [synthesizing, setSynthesizing] = useState(false);
  const [scanStepIndex, setScanStepIndex] = useState(0);
  const [synthesisProgress, setSynthesisProgress] =
    useState<TryOnSynthesisProgress | null>(null);
  const [synthesisError, setSynthesisError] = useState<string | null>(null);
  const [synthesisResult, setSynthesisResult] =
    useState<TryOnSynthesisResult | null>(null);
  const synthesisReqIdRef = useRef(0);
  const activeAbortControllerRef = useRef<AbortController | null>(null);

  // Wardrobe & Garment Selection State
  const [tryOnMode, setTryOnMode] = useState<TryOnMode>(
    initialMode ??
      (initialUpper && (initialLower || initialOuterwear)
        ? TryOnMode.MIX_MATCH_OUTFIT
        : TryOnMode.SINGLE),
  );
  const [activeSlots, setActiveSlots] = useState<ActiveSlots>({});
  const [focusedSlot, setFocusedSlot] = useState<TryOnGarmentSlot>('upper');
  const [wardrobeSource, setWardrobeSource] =
    useState<WardrobeSourceTab>('catalog');
  const [slotFilter, setSlotFilter] = useState<'ALL' | TryOnGarmentSlot>('ALL');

  // Hydrated Cart & Active Studio Outfit Snapshots
  const [cartSnapshot, setCartSnapshot] = useState<CartDto | null>(null);
  const [studioSnapshot, setStudioSnapshot] =
    useState<ActiveStudioOutfitSnapshot | null>(null);

  // Honest Body Profile (`atelier_body_profile_v1`) & Live Size Recommendation
  const [bodyProfile, setBodyProfile] = useState<SharedBodyProfileV1 | null>(
    null,
  );
  const [sizeRecommendation, setSizeRecommendation] =
    useState<ExtendedSizeRecommendResponse | null>(null);
  const [sizeRecLoading, setSizeRecLoading] = useState(false);
  const [selectedSizeCode, setSelectedSizeCode] = useState<string>('M');
  const [showMeasureEditor, setShowMeasureEditor] = useState(false);
  const [showFitVisualizer, setShowFitVisualizer] = useState(false);
  const [editShowOptional3, setEditShowOptional3] = useState(false);
  const [editHeightCm, setEditHeightCm] = useState(163);
  const [editWeightKg, setEditWeightKg] = useState(52);
  const [editBustCm, setEditBustCm] = useState('');
  const [editWaistCm, setEditWaistCm] = useState('');
  const [editHipCm, setEditHipCm] = useState('');
  const [editFitPref, setEditFitPref] =
    useState<BodyProfileFitPreference>('TRUE_TO_SIZE');

  // Compact Left-Bottom Saved Looks Comparison Bar (Max 3)
  const [savedLooks, setSavedLooks] = useState<SavedTryOnLook[]>([]);
  const [viewingSavedLook, setViewingSavedLook] =
    useState<SavedTryOnLook | null>(null);

  // Checkout Conversion CTA state
  const [addingToCart, setAddingToCart] = useState(false);
  const [cartNotice, setCartNotice] = useState<string | null>(null);

  const cleanupServerVtonTransport = useCallback(() => {
    if (serverPollTimerRef.current !== null) {
      clearInterval(serverPollTimerRef.current);
      serverPollTimerRef.current = null;
    }
    if (serverSocketRef.current) {
      try {
        serverSocketRef.current.removeAllListeners();
        serverSocketRef.current.disconnect();
      } catch {
        // Ignore disconnect errors
      }
      serverSocketRef.current = null;
    }
    if (serverAbortRef.current) {
      serverAbortRef.current.abort();
      serverAbortRef.current = null;
    }
  }, []);

  const fetchServerVtonQuota = useCallback(async () => {
    setServerQuotaLoading(true);
    const res = await apiFetch<TryOnQuotaSnapshot>(
      '/bff/v1/storefront/tryon/quota',
      {
        headers: getGuestHeader(),
        skipAuthRefresh: true,
        timeoutMs: 4500,
      },
    );
    if (res.ok && res.data && typeof res.data.remainingQuota === 'number') {
      setServerQuota(res.data);
    }
    setServerQuotaLoading(false);
  }, []);

  // Hydrate live daily free quota from GET /bff/v1/storefront/tryon/quota on modal open / mode switch
  useEffect(() => {
    if (!isActive) return;
    void fetchServerVtonQuota();
  }, [isActive, engineMode, fetchServerVtonQuota]);

  // Clear session frame & abort any in-flight synthesis when studio closes
  useEffect(() => {
    if (!isActive) {
      if (activeAbortControllerRef.current) {
        activeAbortControllerRef.current.abort();
        activeAbortControllerRef.current = null;
      }
      cleanupServerVtonTransport();
      sessionPersonStore.clearFrame(true);
      setPersonFrame(null);
      setSynthesizing(false);
      setSynthesisProgress(null);
      setSynthesisError(null);
      setSynthesisResult(null);
      setServerRunning(false);
      setServerProgress(null);
      setServerResult(null);
      setServerErrorBanner(null);
      setServerPortrait(null);
      setServerFileError(null);
      setServerPurgedNotice(false);
      setViewingSavedLook(null);
      setShowMeasureEditor(false);
      setShowFitVisualizer(false);
    }
    return () => {
      cleanupServerVtonTransport();
    };
  }, [cleanupServerVtonTransport, isActive]);

  // Live 15:00 -> 00:00 hard-purge countdown for Server VTON result
  useEffect(() => {
    if (!isActive || !serverResult) return undefined;
    const syncRemaining = () => {
      const secs = Math.max(
        0,
        Math.floor((serverResult.purgeAtMs - Date.now()) / 1000),
      );
      setServerPurgeSeconds(secs);
      if (secs <= 0) {
        setServerResult(null);
        setServerPortrait((prev) =>
          prev
            ? {
                ...prev,
                uploadedTempImageId: undefined,
                uploadedObjectKey: undefined,
                uploadedPurgeAtMs: undefined,
              }
            : null,
        );
        setServerPurgedNotice(true);
        showAtelierToast(
          'Ảnh Server VTON đã được tự động xóa cứng sau 15 phút bảo mật.',
          'gold',
        );
      }
    };
    syncRemaining();
    const timer = window.setInterval(syncRemaining, 1000);
    return () => window.clearInterval(timer);
  }, [isActive, serverResult]);

  // Subscribe to 15-minute auto-purge session store & countdown timer
  useEffect(() => {
    if (!isActive) return undefined;

    const syncFromStore = () => {
      const live = sessionPersonStore.getFrame();
      if (!live) {
        setPersonFrame((prev) => {
          if (prev) {
            showAtelierToast(
              'Ảnh phiên đã tự động xóa sau 15 phút để bảo vệ quyền riêng tư của bạn.',
              'gold',
            );
          }
          return null;
        });
        setSynthesisResult(null);
        setRemainingSeconds(0);
      } else {
        setRemainingSeconds(sessionPersonStore.getRemainingSeconds());
      }
    };

    const unsub = sessionPersonStore.subscribe(syncFromStore);
    const timer = window.setInterval(() => {
      const live = sessionPersonStore.getFrame();
      if (live) {
        setRemainingSeconds(sessionPersonStore.getRemainingSeconds());
      }
    }, 1000);

    return () => {
      unsub();
      window.clearInterval(timer);
    };
  }, [isActive]);

  // Hydrate shared body profile (`atelier_body_profile_v1`), studio outfit snapshot & cart on open
  useEffect(() => {
    if (!isActive) return undefined;

    const applyProfile = (saved: SharedBodyProfileV1 | null) => {
      setBodyProfile(saved);
      if (saved) {
        if (saved.recommendedSize) {
          setSelectedSizeCode(saved.recommendedSize);
        }
        setEditHeightCm(saved.heightCm);
        setEditWeightKg(saved.weightKg);
        setEditBustCm(saved.bustCm ? String(saved.bustCm) : '');
        setEditWaistCm(saved.waistCm ? String(saved.waistCm) : '');
        setEditHipCm(saved.hipCm ? String(saved.hipCm) : '');
        setEditFitPref(saved.fitPreference);
      } else {
        setSizeRecommendation(null);
        setShowFitVisualizer(false);
      }
    };

    applyProfile(loadSharedBodyProfile());

    const onProfileUpdated = (event: Event) => {
      const detail = (event as CustomEvent<SharedBodyProfileV1>).detail;
      applyProfile(detail ?? loadSharedBodyProfile());
    };
    window.addEventListener(BODY_PROFILE_UPDATED_EVENT, onProfileUpdated);

    setStudioSnapshot(loadActiveStudioOutfitSnapshot());

    const cachedCart = loadCachedCartSnapshot();
    if (cachedCart) {
      setCartSnapshot(cachedCart);
    }

    let cancelled = false;
    void apiFetch<CartDto>('/bff/v1/cart', {
      headers: getGuestHeader(),
      skipAuthRefresh: true,
      timeoutMs: 3500,
    }).then((res) => {
      if (cancelled) return;
      if (res.ok && res.data) {
        setCartSnapshot(res.data);
        saveCachedCartSnapshot(res.data);
      }
    });

    return () => {
      cancelled = true;
      window.removeEventListener(BODY_PROFILE_UPDATED_EVENT, onProfileUpdated);
    };
  }, [isActive]);

  // Synchronize initial garment selections on open / props update
  useEffect(() => {
    if (!isActive || allProducts.length === 0) return;

    const initUp = resolveProductFromRef(initialUpper, allProducts);
    const initLow = resolveProductFromRef(initialLower, allProducts);
    const initOne = resolveProductFromRef(initialOnePiece, allProducts);
    const initOut = resolveProductFromRef(initialOuterwear, allProducts);

    const nextSlots: ActiveSlots = {};
    if (initOne) {
      nextSlots.onePiece = {
        productId: initOne.id,
        variantIdx: resolveVariantIdxFromRef(initialOnePiece, initOne),
      };
    } else {
      if (initUp) {
        const inferred = inferGarmentSlot(initUp);
        const targetSlot: TryOnGarmentSlot =
          inferred === 'outerwear' && !initOut ? 'outerwear' : 'upper';
        nextSlots[targetSlot] = {
          productId: initUp.id,
          variantIdx: resolveVariantIdxFromRef(initialUpper, initUp),
        };
      }
      if (initLow) {
        nextSlots.lower = {
          productId: initLow.id,
          variantIdx: resolveVariantIdxFromRef(initialLower, initLow),
        };
      }
    }

    if (initOut) {
      nextSlots.outerwear = {
        productId: initOut.id,
        variantIdx: resolveVariantIdxFromRef(initialOuterwear, initOut),
      };
    }

    const slotKeys = Object.keys(nextSlots) as TryOnGarmentSlot[];
    if (slotKeys.length === 0) {
      const defaultProduct =
        allProducts.find((p) => p.variants.length > 1) ?? allProducts[0]!;
      const defaultSlot = inferGarmentSlot(defaultProduct);
      nextSlots[defaultSlot] = { productId: defaultProduct.id, variantIdx: 0 };
      setFocusedSlot(defaultSlot);
      setTryOnMode(initialMode ?? TryOnMode.SINGLE);
    } else {
      setFocusedSlot(slotKeys[0]!);
      if (initialMode) {
        setTryOnMode(initialMode);
      } else {
        setTryOnMode(
          slotKeys.length >= 2 ? TryOnMode.MIX_MATCH_OUTFIT : TryOnMode.SINGLE,
        );
      }
    }

    setActiveSlots(nextSlots);
    setCartNotice(null);
  }, [
    allProducts,
    initialLower,
    initialMode,
    initialOnePiece,
    initialOuterwear,
    initialUpper,
    isActive,
  ]);

  // Escape key closes measurement/fit popover first, then studio
  useEffect(() => {
    if (!isActive || !onClose) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (showMeasureEditor || showFitVisualizer) {
        setShowMeasureEditor(false);
        setShowFitVisualizer(false);
        return;
      }
      onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isActive, onClose, showFitVisualizer, showMeasureEditor]);

  // Build Wardrobe Source Collections: Cart, Studio, Catalog
  const cartProducts = useMemo<ProductSpuDto[]>(() => {
    const items = cartSnapshot?.items ?? [];
    const seen = new Set<string>();
    const list: ProductSpuDto[] = [];
    for (const item of items) {
      if (seen.has(item.productId)) continue;
      seen.add(item.productId);
      const matched =
        productById.get(item.productId) ??
        allProducts.find((p) => p.slug === item.slug);
      if (matched) {
        if (!isAccessoryProduct(matched)) list.push(matched);
      } else if (item.slot !== OutfitSlot.ACCESSORY) {
        list.push(synthesizeProductFromCartItem(item));
      }
    }
    return list;
  }, [allProducts, cartSnapshot, productById]);

  const studioProducts = useMemo<ProductSpuDto[]>(() => {
    const seen = new Set<string>();
    const list: ProductSpuDto[] = [];

    const addRef = (
      ref: TryOnGarmentRef | ProductSpuDto | null | undefined,
    ) => {
      const resolved = resolveProductFromRef(ref, allProducts);
      if (resolved && !seen.has(resolved.id) && !isAccessoryProduct(resolved)) {
        seen.add(resolved.id);
        list.push(resolved);
      }
    };

    addRef(initialOnePiece);
    addRef(initialUpper);
    addRef(initialLower);
    addRef(initialOuterwear);

    if (studioSnapshot?.slots) {
      for (const entry of Object.values(studioSnapshot.slots)) {
        if (!entry) continue;
        const resolved =
          productById.get(entry.productId) ??
          allProducts.find((p) => p.slug === entry.slug);
        if (
          resolved &&
          !seen.has(resolved.id) &&
          !isAccessoryProduct(resolved)
        ) {
          seen.add(resolved.id);
          list.push(resolved);
        }
      }
    }

    return list;
  }, [
    allProducts,
    initialLower,
    initialOnePiece,
    initialOuterwear,
    initialUpper,
    productById,
    studioSnapshot,
  ]);

  const extendedProductById = useMemo(() => {
    const map = new Map<string, ProductSpuDto>(productById);
    for (const p of cartProducts) {
      if (!map.has(p.id)) map.set(p.id, p);
    }
    for (const p of studioProducts) {
      if (!map.has(p.id)) map.set(p.id, p);
    }
    return map;
  }, [cartProducts, productById, studioProducts]);

  const displayedWardrobeProducts = useMemo(() => {
    const base =
      wardrobeSource === 'cart'
        ? cartProducts
        : wardrobeSource === 'studio'
          ? studioProducts
          : allProducts;
    if (wardrobeSource !== 'catalog' || slotFilter === 'ALL') {
      return base;
    }
    return base.filter((p) => inferGarmentSlot(p) === slotFilter);
  }, [allProducts, cartProducts, slotFilter, studioProducts, wardrobeSource]);

  const activeGarmentSpecs = useMemo<ActiveGarmentSpec[]>(() => {
    const specs: ActiveGarmentSpec[] = [];
    for (const slot of SLOT_ORDER) {
      const sel = activeSlots[slot];
      if (!sel) continue;
      const product = extendedProductById.get(sel.productId);
      if (!product) continue;
      specs.push(
        buildActiveGarmentSpec(slot, product, sel.variantIdx, selectedSizeCode),
      );
    }
    return specs;
  }, [activeSlots, extendedProductById, selectedSizeCode]);

  const synthesisGarments = useMemo<TryOnSynthesisGarmentInput[]>(
    () =>
      activeGarmentSpecs.map((spec) => ({
        productId: spec.productId,
        variantId: spec.variantId,
        slot: spec.slot,
        name: spec.name,
        garmentImageUrl: spec.garmentImageUrl,
        colorHex: spec.colorHex,
        colorName: spec.colorName,
      })),
    [activeGarmentSpecs],
  );

  const activeProductIds = useMemo(
    () => new Set(activeGarmentSpecs.map((spec) => spec.productId)),
    [activeGarmentSpecs],
  );

  const focusedSpec = useMemo(() => {
    return (
      activeGarmentSpecs.find((s) => s.slot === focusedSlot) ??
      activeGarmentSpecs[0] ??
      null
    );
  }, [activeGarmentSpecs, focusedSlot]);

  const totalOutfitPriceVnd = useMemo(
    () => activeGarmentSpecs.reduce((sum, spec) => sum + spec.priceVnd, 0),
    [activeGarmentSpecs],
  );

  const selectedGarmentsPip = useMemo(
    () =>
      activeGarmentSpecs.map((spec) => ({
        productId: spec.productId,
        name: spec.name,
        imageUrl: spec.garmentImageUrl,
        colorName: spec.colorName,
      })),
    [activeGarmentSpecs],
  );

  const activeGarmentSummaryText = useMemo(
    () =>
      activeGarmentSpecs
        .map((spec) => `${spec.name} · ${spec.colorName}`)
        .join(' + '),
    [activeGarmentSpecs],
  );

  // Fetch live crowd-calibrated size recommendation ONLY when user has saved `atelier_body_profile_v1`
  useEffect(() => {
    if (!isActive || !bodyProfile || !focusedSpec?.product) {
      return undefined;
    }
    let cancelled = false;
    setSizeRecLoading(true);

    const payload: Record<string, unknown> = {
      productId: focusedSpec.product.id,
      productSlug: focusedSpec.product.slug,
      slug: focusedSpec.product.slug,
      heightCm: bodyProfile.heightCm,
      weightKg: bodyProfile.weightKg,
      fitPreference: bodyProfile.fitPreference,
    };
    if (bodyProfile.bustCm && bodyProfile.bustCm >= 50) {
      payload.bustCm = bodyProfile.bustCm;
    }
    if (bodyProfile.waistCm && bodyProfile.waistCm >= 40) {
      payload.waistCm = bodyProfile.waistCm;
    }
    if (bodyProfile.hipCm && bodyProfile.hipCm >= 50) {
      payload.hipCm = bodyProfile.hipCm;
    }

    void apiFetch<ExtendedSizeRecommendResponse>(
      '/bff/v1/storefront/size-recommend',
      {
        method: 'POST',
        skipAuthRefresh: true,
        timeoutMs: 4500,
        body: JSON.stringify(payload),
      },
    ).then((res) => {
      if (cancelled) return;
      setSizeRecLoading(false);
      if (res.ok && res.data) {
        setSizeRecommendation(res.data);
        if (isCanonicalSizeCode(res.data.recommendedSize)) {
          setSelectedSizeCode(res.data.recommendedSize);
        }
      }
    });

    return () => {
      cancelled = true;
    };
  }, [bodyProfile, focusedSpec?.product, isActive]);

  const recommendedSizeLabel: CanonicalSizeCode | null =
    sizeRecommendation && isCanonicalSizeCode(sizeRecommendation.recommendedSize)
      ? sizeRecommendation.recommendedSize
      : bodyProfile?.recommendedSize ?? null;
  const recommendedFitLabel = bodyProfile
    ? BODY_FIT_PREF_VN[bodyProfile.fitPreference]
    : null;

  // Determine whether current tab shows Result View (<BeforeAfterSlider />) or Input Gate
  const isShowingResultStage = Boolean(
    personFrame &&
      ((inputTab === 'camera' && personFrame.source === 'camera') ||
        (inputTab === 'upload' && personFrame.source === 'upload') ||
        (inputTab === 'presets' && personFrame.source === 'preset')),
  );

  // Lock a newly captured / uploaded / preset SessionPersonFrame
  const commitSessionPersonFrame = useCallback((frame: SessionPersonFrame) => {
    const stored = sessionPersonStore.setFrame(frame);
    setPersonFrame(stored);
    setRemainingSeconds(sessionPersonStore.getRemainingSeconds());
    setViewingSavedLook(null);
  }, []);

  // Load one of the 4 curated Vietnamese studio model presets as locked 768x1024 frame
  const handleSelectQuickModel = useCallback(
    async (preset: QuickTryOnModelPreset) => {
      setSelectedPresetId(preset.id);
      setLoadingPresetId(preset.id);
      setViewingSavedLook(null);
      try {
        const frame = await loadQuickModelAsSessionFrame(preset);
        commitSessionPersonFrame(frame);
      } finally {
        setLoadingPresetId((curr) => (curr === preset.id ? null : curr));
      }
    },
    [commitSessionPersonFrame],
  );

  // Switch between the 3 Input Mode Tabs cleanly
  const handleSwitchInputTab = useCallback(
    (nextTab: InputTabId) => {
      setInputTab(nextTab);
      setViewingSavedLook(null);
      if (nextTab === 'presets') {
        const currentPreset =
          QUICK_TRYON_MODELS.find((m) => m.id === selectedPresetId) ??
          QUICK_TRYON_MODELS[0]!;
        if (
          personFrame?.source !== 'preset' ||
          personFrame.presetId !== currentPreset.id
        ) {
          void handleSelectQuickModel(currentPreset);
        }
      }
    },
    [handleSelectQuickModel, personFrame, selectedPresetId],
  );

  const isOutfitMode =
    tryOnMode === TryOnMode.MIX_MATCH_OUTFIT && synthesisGarments.length >= 2;
  const synthesisMode: TryOnSynthesisMode = isOutfitMode ? 'OUTFIT' : 'SINGLE';

  // Cancel active Stage 2 synthesis cleanly without clearing the locked SessionPersonFrame
  const handleCancelSynthesis = useCallback(() => {
    const controller = activeAbortControllerRef.current;
    activeAbortControllerRef.current = null;
    synthesisReqIdRef.current += 1;
    if (controller) {
      controller.abort();
    }
    setSynthesizing(false);
    setSynthesisProgress(null);
    setSynthesisError(null);
    showAtelierToast(
      'Đã hủy tác vụ ướm thử AI — ảnh dáng của bạn vẫn được giữ nguyên.',
      'gold',
    );
  }, []);

  // Trigger Stage 2 Realtime VTON synthesis whenever locked personFrame, garments, mode, or lighting changes in AR Mirror mode
  useEffect(() => {
    if (
      !isActive ||
      engineMode !== 'ar_mirror' ||
      !isShowingResultStage ||
      !personFrame ||
      synthesisGarments.length === 0
    ) {
      return undefined;
    }

    const reqId = synthesisReqIdRef.current + 1;
    synthesisReqIdRef.current = reqId;
    const controller = new AbortController();
    activeAbortControllerRef.current = controller;
    let cancelled = false;
    const expectedStepTotal =
      synthesisMode === 'OUTFIT' ? Math.max(1, synthesisGarments.length) : 1;

    void (async () => {
      const cacheKey = await computeTryOnCacheKey(
        personFrame.frameHash,
        synthesisGarments,
        lightingPreset,
      );
      if (cancelled || synthesisReqIdRef.current !== reqId) return;

      const cachedHit = sessionPersonStore.getCachedResult(cacheKey);
      if (cachedHit) {
        // Instant < 150ms SHA-256 cache hit — NO optical scan overlay flash!
        if (activeAbortControllerRef.current === controller) {
          activeAbortControllerRef.current = null;
        }
        setSynthesizing(false);
        setSynthesisProgress(null);
        setSynthesisError(null);
        setSynthesisResult({
          ...cachedHit,
          cacheKey,
          cacheHit: true,
          providerBadge: INSTANT_CACHE_BADGE,
        });
        return;
      }

      // Cache miss -> display cancelable golden OpticalTryOnScan with realtime progress
      setSynthesisError(null);
      setScanStepIndex(0);
      setSynthesisProgress({
        status: 'QUEUED',
        progressPct: 5,
        stageLabel: 'Đang xếp hàng xử lý phòng thử đồ AI...',
        stepCurrent: 1,
        stepTotal: expectedStepTotal,
      });
      setSynthesizing(true);

      try {
        const result = await synthesizeTryOn({
          personFrame,
          garments: synthesisGarments,
          lightingPreset,
          mode: synthesisMode,
          signal: controller.signal,
          onStageChange: (stageIdx) => {
            if (!cancelled && synthesisReqIdRef.current === reqId) {
              setScanStepIndex(stageIdx);
            }
          },
          onProgress: (update) => {
            if (!cancelled && synthesisReqIdRef.current === reqId) {
              setSynthesisProgress(update);
            }
          },
        });

        if (!cancelled && synthesisReqIdRef.current === reqId) {
          if (activeAbortControllerRef.current === controller) {
            activeAbortControllerRef.current = null;
          }
          setSynthesisResult(result);
          setSynthesisProgress(null);
          setSynthesisError(null);
          setSynthesizing(false);
        }
      } catch (err) {
        if (activeAbortControllerRef.current === controller) {
          activeAbortControllerRef.current = null;
        }
        if (!cancelled && synthesisReqIdRef.current === reqId) {
          setSynthesizing(false);
          setSynthesisProgress(null);
          if (!isAbortError(err)) {
            const msg =
              err instanceof Error && err.message.trim().length > 0
                ? err.message
                : 'Không thể hoàn tất ướm thử AI. Vui lòng thử lại sau giây lát.';
            setSynthesisError(msg);
            showAtelierToast(msg, 'warning');
          }
        }
      }
    })();

    return () => {
      cancelled = true;
      if (activeAbortControllerRef.current === controller) {
        activeAbortControllerRef.current = null;
      }
      controller.abort();
    };
  }, [
    engineMode,
    isActive,
    isShowingResultStage,
    lightingPreset,
    personFrame,
    synthesisGarments,
    synthesisMode,
  ]);

  // ============================================================================
  // Server VTON (:4009) Handlers: Magic Bytes Validation -> Presigned PUT ->
  // POST /sessions (with /synthesize CORS fallback) -> Socket.io + HTTP Polling
  // ============================================================================

  const handleServerVtonSelectFile = useCallback(async (file: File) => {
    setServerFileError(null);
    setServerErrorBanner(null);
    setServerPurgedNotice(false);

    if (file.size <= 0) {
      setServerFileError('Tệp ảnh rỗng — vui lòng chọn ảnh chân dung hợp lệ.');
      return;
    }
    if (file.size > MAX_SERVER_VTON_BYTES) {
      setServerFileError(
        'Ảnh vượt quá giới hạn 10MB — vui lòng chọn ảnh dung lượng nhẹ hơn.',
      );
      return;
    }

    try {
      const arrayBuf = await file.arrayBuffer();
      const bytes = new Uint8Array(arrayBuf);
      const detectedMime = detectImageMimeFromBytes(bytes);
      if (!detectedMime) {
        setServerFileError(
          'Magic Bytes không hợp lệ — hệ thống chỉ chấp nhận ảnh JPEG, PNG hoặc WebP thực.',
        );
        return;
      }

      const sha256Hash = await computeSha256HexFromBytes(bytes);
      const headerSample = bytes.subarray(0, Math.min(bytes.length, 64));
      const fileHeaderBase64 = `data:${detectedMime};base64,${bytesToBase64(headerSample)}`;
      const previewDataUrl = `data:${detectedMime};base64,${bytesToBase64(bytes)}`;

      setServerPortrait({
        label: file.name.slice(0, 42) || 'Ảnh chân dung của bạn',
        previewDataUrl,
        bytes,
        contentType: detectedMime,
        sha256Hash,
        fileHeaderBase64,
        source: TryOnSource.STATIC_UPLOAD,
        poseLandmarks: null,
      });
      setServerResult(null);
      setViewingSavedLook(null);
    } catch {
      setServerFileError('Không thể đọc dữ liệu tệp ảnh. Vui lòng thử ảnh khác.');
    }
  }, []);

  const handleServerVtonImportCurrentFrame = useCallback(async () => {
    if (!personFrame) return;
    setServerFileError(null);
    setServerErrorBanner(null);
    setServerPurgedNotice(false);

    const bytes = dataUrlToUint8Array(personFrame.dataUrl);
    if (!bytes) {
      setServerFileError('Không thể chuyển đổi khung ảnh hiện tại sang định dạng nhị phân.');
      return;
    }
    const detectedMime = detectImageMimeFromBytes(bytes) ?? 'image/jpeg';
    const sha256Hash = await computeSha256HexFromBytes(bytes);
    const headerSample = bytes.subarray(0, Math.min(bytes.length, 64));
    const fileHeaderBase64 = `data:${detectedMime};base64,${bytesToBase64(headerSample)}`;

    setServerPortrait({
      label: personFrame.label,
      previewDataUrl: personFrame.dataUrl,
      bytes,
      contentType: detectedMime,
      sha256Hash,
      fileHeaderBase64,
      source:
        personFrame.source === 'camera'
          ? TryOnSource.CAMERA_MEDIAPIPE
          : TryOnSource.STATIC_UPLOAD,
      poseLandmarks: toServerPoseLandmarks(personFrame.poseLandmarks),
    });
    setServerResult(null);
    setViewingSavedLook(null);
  }, [personFrame]);

  const handleCancelServerVton = useCallback(() => {
    const activeJobId = serverProgress?.jobId;
    cleanupServerVtonTransport();
    setServerRunning(false);
    setServerProgress(null);
    if (activeJobId) {
      void apiFetch<unknown>(
        `/bff/v1/tryon/jobs/${encodeURIComponent(activeJobId)}/cancel`,
        {
          method: 'POST',
          headers: getGuestHeader(),
          skipAuthRefresh: true,
          timeoutMs: 4000,
          body: JSON.stringify({ reason: 'USER_CANCELLED' }),
        },
      ).then(() => {
        void fetchServerVtonQuota();
      });
    }
    showAtelierToast('Đã hủy phiên Server VTON.', 'gold');
  }, [cleanupServerVtonTransport, fetchServerVtonQuota, serverProgress?.jobId]);

  const monitorServerVtonSession = useCallback(
    (opts: {
      sessionId: string;
      pollEndpoint: string;
      totalSteps: number;
      usedSynthesizeFallback: boolean;
      controller: AbortController;
    }) => {
      const {
        sessionId,
        pollEndpoint,
        totalSteps,
        usedSynthesizeFallback,
        controller,
      } = opts;

      let settled = false;
      let pollInFlight = false;
      let highestPct = 15;

      const finishCleanup = () => {
        if (serverPollTimerRef.current !== null) {
          clearInterval(serverPollTimerRef.current);
          serverPollTimerRef.current = null;
        }
        if (serverSocketRef.current) {
          try {
            serverSocketRef.current.removeAllListeners();
            serverSocketRef.current.disconnect();
          } catch {
            // Ignore cleanup errors
          }
          serverSocketRef.current = null;
        }
        if (serverAbortRef.current === controller) {
          serverAbortRef.current = null;
        }
      };

      const applyTelemetryUpdate = (
        raw: unknown,
        forcedEvent?: 'progress' | 'completed' | 'failed',
      ) => {
        if (settled || controller.signal.aborted) return;
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
        const data = raw as Record<string, unknown>;

        const evtSessionId = readStringField(data, 'sessionId', 'jobId');
        if (evtSessionId && evtSessionId !== sessionId) return;

        const remainingQuota = readNumberField(
          data,
          'remainingQuota',
          'quotaRemaining',
        );
        if (remainingQuota !== null) {
          setServerQuota((prev) =>
            prev
              ? { ...prev, remainingQuota }
              : { remainingQuota, dailyLimit: Math.max(5, remainingQuota) },
          );
        }

        const rawStatus = (readStringField(data, 'status') ?? '').toUpperCase();
        const isCompleted =
          forcedEvent === 'completed' || rawStatus === 'COMPLETED';
        const isFailed =
          forcedEvent === 'failed' ||
          rawStatus === 'FAILED' ||
          rawStatus === 'CANCELLED';

        if (isFailed) {
          settled = true;
          finishCleanup();
          setServerRunning(false);
          setServerProgress(null);

          const errorCode =
            readStringField(data, 'errorCode', 'code') ?? 'VTON_PROVIDER_ERROR';
          const isPoseClose = errorCode.toUpperCase() === 'POSE_TOO_CLOSE';
          const quotaRefunded =
            data.quotaRefunded === true ||
            isPoseClose ||
            rawStatus === 'FAILED';
          const rawMsg =
            readStringField(data, 'errorMessage', 'message', 'stepMessage') ??
            (isPoseClose
              ? 'Ảnh chụp quá gần khuôn mặt — Đã tự động hoàn trả lại +1 lượt thử đồ AI.'
              : 'Không thể hoàn tất phiên Server VTON lúc này — Đã tự động hoàn trả +1 lượt thử đồ AI.');

          setServerErrorBanner({
            code: errorCode.toUpperCase(),
            message: rawMsg,
            quotaRefunded,
            remainingQuota,
          });
          void fetchServerVtonQuota();
          return;
        }

        const resultUrl = readStringField(
          data,
          'resultUrl',
          'resultImageUrl',
        );
        if (isCompleted && resultUrl) {
          settled = true;
          finishCleanup();
          const providerUsed =
            readStringField(data, 'providerUsed', 'provider') ??
            'SMART_POSE_WARP';
          const cacheHit =
            data.cacheHit === true || providerUsed.toUpperCase() === 'CACHE_HIT';
          const providerDisplayBadge =
            readStringField(data, 'providerDisplayBadge', 'providerBadge') ??
            (cacheHit
              ? '⚡ CACHE_HIT · 0đ · Không trừ quota'
              : `✦ Server VTON · ${providerUsed}`);
          const expiresAtIso = readStringField(data, 'purgeAt', 'expiresAt');
          const purgeAtMs = parseExpiryToMs(expiresAtIso);
          const durationMs = readNumberField(data, 'totalDurationMs', 'durationMs');

          setServerResult({
            sessionId,
            resultUrl,
            providerUsed,
            providerDisplayBadge,
            cacheHit,
            expiresAtIso,
            purgeAtMs,
            remainingQuota,
            durationMs,
            usedSynthesizeFallback,
          });
          setServerPurgeSeconds(
            Math.max(0, Math.floor((purgeAtMs - Date.now()) / 1000)),
          );
          setServerPurgedNotice(false);
          setServerErrorBanner(null);
          setServerRunning(false);
          setServerProgress(null);
          void fetchServerVtonQuota();
          return;
        }

        const pct = readNumberField(data, 'progressPct', 'progress');
        if (pct !== null) {
          highestPct = Math.max(highestPct, Math.min(98, Math.round(pct)));
        }
        const stepOrder = Math.max(
          1,
          Math.round(readNumberField(data, 'stepOrder', 'stepCurrent') ?? 1),
        );
        const reportedTotal = Math.max(
          1,
          Math.round(
            readNumberField(data, 'totalSteps', 'stepTotal') ?? totalSteps,
          ),
        );
        const stepMsg =
          readStringField(data, 'stepMessage', 'stageLabel', 'message') ??
          'Đang xử lý ghép vải trên máy chủ AI VTON (:4009)...';

        setServerProgress({
          jobId: sessionId,
          status: 'PROCESSING',
          progressPct: highestPct,
          stageLabel: stepMsg,
          stepCurrent: Math.min(stepOrder, reportedTotal),
          stepTotal: reportedTotal,
        });
      };

      // 1. Authenticated Socket.io realtime subscription (`tryon:subscribe`)
      if (typeof window !== 'undefined') {
        try {
          const session = getStoredSession();
          const guestSessionId = getOrCreateGuestSessionId();
          const socket = io(resolveServerRealtimeUrl(), {
            path: '/socket.io/',
            transports: ['websocket', 'polling'],
            withCredentials: true,
            auth: {
              ...(session?.accessToken ? { token: session.accessToken } : {}),
              guestSessionId,
            },
            reconnection: true,
            reconnectionAttempts: 2,
            reconnectionDelay: 800,
            timeout: 6000,
          });
          serverSocketRef.current = socket;

          socket.on('connect', () => {
            if (settled) return;
            socket.emit('tryon:subscribe', { sessionId, jobId: sessionId });
          });
          socket.on('tryon:progress', (payload: unknown) =>
            applyTelemetryUpdate(payload, 'progress'),
          );
          socket.on('tryon:completed', (payload: unknown) =>
            applyTelemetryUpdate(payload, 'completed'),
          );
          socket.on('tryon:failed', (payload: unknown) =>
            applyTelemetryUpdate(payload, 'failed'),
          );
          socket.on('connect_error', () => {
            // Silent fallback to HTTP polling
          });
        } catch {
          // Silent fallback to HTTP polling
        }
      }

      // 2. Parallel HTTP Polling fallback (`GET /bff/v1/storefront/tryon/sessions/:id`)
      const pollOnce = async () => {
        if (settled || pollInFlight || controller.signal.aborted) return;
        pollInFlight = true;
        try {
          const pollRes = await apiFetch<Record<string, unknown>>(pollEndpoint, {
            method: 'GET',
            headers: getGuestHeader(),
            skipAuthRefresh: true,
            timeoutMs: 6000,
            signal: controller.signal,
          });
          if (pollRes.ok && pollRes.data) {
            applyTelemetryUpdate(pollRes.data);
          }
        } catch {
          // Retry on next interval
        } finally {
          pollInFlight = false;
        }
      };

      serverPollTimerRef.current = setInterval(() => {
        void pollOnce();
      }, SERVER_VTON_POLL_INTERVAL_MS);
      void pollOnce();

      // Safety timeout guard
      const timeoutHandle = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        finishCleanup();
        setServerRunning(false);
        setServerProgress(null);
        setServerErrorBanner({
          code: 'SERVER_VTON_TIMEOUT',
          message:
            'Máy chủ AI VTON (:4009) phản hồi quá thời gian chờ. Nếu phiên lỗi, lượt thử AI sẽ được hoàn trả tự động.',
          quotaRefunded: false,
          remainingQuota: serverQuota?.remainingQuota ?? null,
        });
        void fetchServerVtonQuota();
      }, SERVER_VTON_TIMEOUT_MS);

      controller.signal.addEventListener(
        'abort',
        () => {
          window.clearTimeout(timeoutHandle);
          settled = true;
          finishCleanup();
        },
        { once: true },
      );
    },
    [fetchServerVtonQuota, serverQuota?.remainingQuota],
  );

  const handleRunServerVton = useCallback(async () => {
    if (!serverPrivacyConsent) {
      setServerFileError(
        'Vui lòng tích chọn đồng ý bảo mật 15 phút (privacyConsent = true) trước khi tải ảnh lên.',
      );
      return;
    }
    if (!serverPortrait) {
      setServerFileError(
        'Vui lòng chọn ảnh chân dung (JPEG/PNG/WebP <= 10MB) hoặc dùng khung ảnh hiện tại.',
      );
      return;
    }
    if (activeGarmentSpecs.length === 0) {
      setServerFileError('Vui lòng chọn ít nhất 1 thiết kế trong Tủ đồ Atelier.');
      return;
    }

    cleanupServerVtonTransport();
    const controller = new AbortController();
    serverAbortRef.current = controller;

    setServerFileError(null);
    setServerErrorBanner(null);
    setServerPurgedNotice(false);
    setViewingSavedLook(null);
    setServerRunning(true);

    const upperSpec = activeGarmentSpecs.find(
      (s) => s.slot === 'upper' || s.slot === 'outerwear',
    );
    const lowerSpec = activeGarmentSpecs.find((s) => s.slot === 'lower');
    const onePieceSpec = activeGarmentSpecs.find((s) => s.slot === 'onePiece');
    const sessionMode: TryOnMode =
      tryOnMode === TryOnMode.MIX_MATCH_OUTFIT &&
      !onePieceSpec &&
      Boolean(upperSpec && lowerSpec)
        ? TryOnMode.MIX_MATCH_OUTFIT
        : TryOnMode.SINGLE;
    const expectedSteps = sessionMode === TryOnMode.MIX_MATCH_OUTFIT ? 2 : 1;

    setServerProgress({
      status: 'QUEUED',
      progressPct: 8,
      stageLabel: 'Đang xin cấp liên kết Presigned tải lên phân vùng riêng tư...',
      stepCurrent: 1,
      stepTotal: expectedSteps,
    });

    const runSynthesizeFallback = async (fallbackReason: string) => {
      if (controller.signal.aborted) return;
      setServerProgress({
        status: 'QUEUED',
        progressPct: 18,
        stageLabel: `${fallbackReason} Đang gửi trực tiếp qua BFF Server VTON...`,
        stepCurrent: 1,
        stepTotal: expectedSteps,
      });

      const synthRes = await apiFetch<Record<string, unknown>>(
        '/bff/v1/tryon/synthesize',
        {
          method: 'POST',
          headers: getGuestHeader(),
          skipAuthRefresh: true,
          timeoutMs: 25_000,
          signal: controller.signal,
          body: JSON.stringify({
            personImageDataUrl: serverPortrait.previewDataUrl,
            personFrameHash: serverPortrait.sha256Hash,
            mode:
              sessionMode === TryOnMode.MIX_MATCH_OUTFIT ? 'OUTFIT' : 'SINGLE',
            lightingPreset,
            privacyConsent: true,
            garments: synthesisGarments.map((g) => ({
              productId: g.productId,
              variantId: g.variantId,
              slot: g.slot,
              name: g.name,
              garmentImageUrl: g.garmentImageUrl,
              cleanGarmentUrl768x1024: g.garmentImageUrl,
              colorHex: g.colorHex,
              colorName: g.colorName,
            })),
          }),
        },
      );

      if (controller.signal.aborted) return;

      if (!synthRes.ok || !synthRes.data) {
        setServerRunning(false);
        setServerProgress(null);
        setServerErrorBanner({
          code: synthRes.error?.code ?? 'SERVER_VTON_ERROR',
          message:
            synthRes.error?.message ||
            'Không thể kết nối máy chủ AI VTON (:4009). Vui lòng thử lại sau giây lát.',
          quotaRefunded: false,
          remainingQuota: serverQuota?.remainingQuota ?? null,
        });
        void fetchServerVtonQuota();
        return;
      }

      const data = synthRes.data;
      const rawStatus = (readStringField(data, 'status') ?? '').toUpperCase();
      const remainingQuota = readNumberField(
        data,
        'remainingQuota',
        'quotaRemaining',
      );
      if (remainingQuota !== null) {
        setServerQuota((prev) =>
          prev
            ? { ...prev, remainingQuota }
            : { remainingQuota, dailyLimit: Math.max(5, remainingQuota) },
        );
      }

      const immediateResultUrl = readStringField(
        data,
        'resultUrl',
        'resultImageUrl',
      );
      if (
        (rawStatus === 'COMPLETED' || rawStatus === 'SYNTHESIZED') &&
        immediateResultUrl
      ) {
        const providerUsed =
          readStringField(data, 'providerUsed', 'provider') ??
          (data.cacheHit === true ? 'CACHE_HIT' : 'SMART_POSE_WARP');
        const cacheHit =
          data.cacheHit === true ||
          providerUsed.toUpperCase() === 'CACHE_HIT';
        const expiresAtIso = readStringField(data, 'purgeAt', 'expiresAt');
        const purgeAtMs = parseExpiryToMs(expiresAtIso);
        setServerResult({
          sessionId:
            readStringField(data, 'sessionId', 'jobId') ?? `synth-${Date.now()}`,
          resultUrl: immediateResultUrl,
          providerUsed,
          providerDisplayBadge:
            readStringField(data, 'providerDisplayBadge', 'providerBadge') ??
            (cacheHit
              ? '⚡ CACHE_HIT · 0đ · Không trừ quota'
              : `✦ Server VTON · ${providerUsed}`),
          cacheHit,
          expiresAtIso,
          purgeAtMs,
          remainingQuota,
          durationMs: readNumberField(data, 'durationMs', 'totalDurationMs'),
          usedSynthesizeFallback: true,
        });
        setServerPurgeSeconds(
          Math.max(0, Math.floor((purgeAtMs - Date.now()) / 1000)),
        );
        setServerRunning(false);
        setServerProgress(null);
        void fetchServerVtonQuota();
        return;
      }

      const jobId = readStringField(data, 'jobId', 'sessionId');
      if (jobId) {
        monitorServerVtonSession({
          sessionId: jobId,
          pollEndpoint: `/bff/v1/tryon/jobs/${encodeURIComponent(jobId)}`,
          totalSteps: expectedSteps,
          usedSynthesizeFallback: true,
          controller,
        });
        return;
      }

      setServerRunning(false);
      setServerProgress(null);
      setServerErrorBanner({
        code: 'LOCAL_PREVIEW_ONLY',
        message:
          'Dịch vụ AI VTON máy chủ (:4009) đang tạm ngoại tuyến. Quý khách có thể chuyển sang "Gương Căn Dáng & AR Trực Tiếp" để ướm thử ngay.',
        quotaRefunded: false,
        remainingQuota: serverQuota?.remainingQuota ?? null,
      });
    };

    try {
      let tempImageId = serverPortrait.uploadedTempImageId;
      let objectKey = serverPortrait.uploadedObjectKey;
      const reuseExistingUpload = Boolean(
        tempImageId &&
          objectKey &&
          serverPortrait.uploadedPurgeAtMs &&
          serverPortrait.uploadedPurgeAtMs - Date.now() > 60_000,
      );

      if (!reuseExistingUpload) {
        // Step 1: Request Presigned PUT URL from /bff/v1/storefront/tryon/upload-url
        const uploadUrlRes = await apiFetch<TryOnUploadUrlResponse>(
          '/bff/v1/storefront/tryon/upload-url',
          {
            method: 'POST',
            headers: getGuestHeader(),
            skipAuthRefresh: true,
            timeoutMs: 12_000,
            signal: controller.signal,
            body: JSON.stringify({
              contentType: serverPortrait.contentType,
              fileSizeBytes: serverPortrait.bytes.byteLength,
              sha256Hash: serverPortrait.sha256Hash,
              source: serverPortrait.source,
              poseScore: 0.94,
              privacyConsent: true,
              fileHeaderBase64: serverPortrait.fileHeaderBase64,
            }),
          },
        );

        if (controller.signal.aborted) return;

        if (!uploadUrlRes.ok || !uploadUrlRes.data) {
          if (uploadUrlRes.status === 429 || uploadUrlRes.status === 400) {
            setServerRunning(false);
            setServerProgress(null);
            setServerErrorBanner({
              code: uploadUrlRes.error?.code ?? 'UPLOAD_URL_REJECTED',
              message:
                uploadUrlRes.error?.message ||
                'Không thể tạo liên kết tải ảnh (vui lòng kiểm tra định dạng ảnh hoặc hạn mức lượt thử trong ngày).',
              quotaRefunded: false,
              remainingQuota: serverQuota?.remainingQuota ?? null,
            });
            void fetchServerVtonQuota();
            return;
          }
          await runSynthesizeFallback('Chuyển kênh dự phòng.');
          return;
        }

        const {
          uploadUrl,
          objectKey: nextObjectKey,
          tempImageId: nextTempImageId,
          purgeAt,
          remainingQuota,
          dailyLimit,
        } = uploadUrlRes.data;

        setServerQuota((prev) => ({
          ...(prev ?? {}),
          remainingQuota,
          dailyLimit,
        }));

        // Step 2: Direct binary PUT to private MinIO bucket (`atelier-private-tryon`)
        setServerProgress({
          status: 'QUEUED',
          progressPct: 16,
          stageLabel:
            'Đang tải ảnh chân dung lên kho riêng tư atelier-private-tryon...',
          stepCurrent: 1,
          stepTotal: expectedSteps,
        });

        let directPutSucceeded = false;
        try {
          const uploadBytes = new Uint8Array(serverPortrait.bytes.byteLength);
          uploadBytes.set(serverPortrait.bytes);
          const putResponse = await fetch(uploadUrl, {
            method: 'PUT',
            headers: { 'Content-Type': serverPortrait.contentType },
            body: new Blob([uploadBytes.buffer], {
              type: serverPortrait.contentType,
            }),
            signal: controller.signal,
          });
          directPutSucceeded = putResponse.ok;
        } catch {
          directPutSucceeded = false;
        }

        if (controller.signal.aborted) return;

        if (!directPutSucceeded) {
          // Graceful fallback when browser CORS blocks direct MinIO PUT
          await runSynthesizeFallback(
            'Trình duyệt hạn chế tải trực tiếp MinIO CORS.',
          );
          return;
        }

        tempImageId = nextTempImageId;
        objectKey = nextObjectKey;
        const uploadedPurgeAtMs = parseExpiryToMs(purgeAt);
        setServerPortrait((prev) =>
          prev
            ? {
                ...prev,
                uploadedTempImageId: nextTempImageId,
                uploadedObjectKey: nextObjectKey,
                uploadedPurgeAtMs,
              }
            : null,
        );
      }

      // Step 3: Create Server VTON Session (`POST /bff/v1/storefront/tryon/sessions`)
      setServerProgress({
        status: 'QUEUED',
        progressPct: 24,
        stageLabel: 'Đang kiểm tra bộ nhớ đệm SHA-256 & xếp hàng Server VTON...',
        stepCurrent: 1,
        stepTotal: expectedSteps,
      });

      const sessionPayload: Record<string, unknown> = {
        tempImageId,
        objectKey,
        sha256Hash: serverPortrait.sha256Hash,
        mode: sessionMode,
        privacyConsent: true,
        ...(serverPortrait.poseLandmarks
          ? { poseLandmarks: serverPortrait.poseLandmarks }
          : {}),
      };

      if (onePieceSpec) {
        sessionPayload.onePieceProductId = onePieceSpec.productId;
        sessionPayload.onePieceVariantId = onePieceSpec.variantId;
      } else {
        if (upperSpec) {
          sessionPayload.upperProductId = upperSpec.productId;
          sessionPayload.upperVariantId = upperSpec.variantId;
        }
        if (lowerSpec) {
          sessionPayload.lowerProductId = lowerSpec.productId;
          sessionPayload.lowerVariantId = lowerSpec.variantId;
        }
      }

      const sessionRes = await apiFetch<Record<string, unknown>>(
        '/bff/v1/storefront/tryon/sessions',
        {
          method: 'POST',
          headers: getGuestHeader(),
          skipAuthRefresh: true,
          timeoutMs: 30_000,
          signal: controller.signal,
          body: JSON.stringify(sessionPayload),
        },
      );

      if (controller.signal.aborted) return;

      if (!sessionRes.ok || !sessionRes.data) {
        if (sessionRes.status === 404 && reuseExistingUpload) {
          // Cached tempImageId expired/purged on server — clear cached keys and retry fallback
          setServerPortrait((prev) =>
            prev
              ? {
                  ...prev,
                  uploadedTempImageId: undefined,
                  uploadedObjectKey: undefined,
                  uploadedPurgeAtMs: undefined,
                }
              : null,
          );
          await runSynthesizeFallback('Ảnh tạm đã hết hạn 15 phút.');
          return;
        }

        const errCode = (sessionRes.error?.code ?? 'SESSION_FAILED').toUpperCase();
        setServerRunning(false);
        setServerProgress(null);
        setServerErrorBanner({
          code: errCode,
          message:
            sessionRes.error?.message ||
            'Không thể khởi tạo phiên Server VTON. Vui lòng thử lại.',
          quotaRefunded: errCode === 'POSE_TOO_CLOSE',
          remainingQuota: serverQuota?.remainingQuota ?? null,
        });
        void fetchServerVtonQuota();
        return;
      }

      const sData = sessionRes.data;
      const remainingQuota = readNumberField(
        sData,
        'remainingQuota',
        'quotaRemaining',
      );
      if (remainingQuota !== null) {
        setServerQuota((prev) =>
          prev
            ? { ...prev, remainingQuota }
            : { remainingQuota, dailyLimit: Math.max(5, remainingQuota) },
        );
      }

      const sessionId =
        readStringField(sData, 'sessionId', 'jobId') ?? `sess-${Date.now()}`;
      const rawStatus = (readStringField(sData, 'status') ?? '').toUpperCase();
      const cacheHit =
        sData.cacheHit === true ||
        (readStringField(sData, 'providerUsed') ?? '').toUpperCase() ===
          'CACHE_HIT';
      const immediateResultUrl = readStringField(
        sData,
        'resultUrl',
        'resultImageUrl',
      );

      // Immediate HTTP 200 CACHE_HIT (0đ, ZERO quota deduction!)
      if (rawStatus === 'COMPLETED' && immediateResultUrl) {
        const providerUsed =
          readStringField(sData, 'providerUsed') ??
          (cacheHit ? 'CACHE_HIT' : 'SMART_POSE_WARP');
        const expiresAtIso = readStringField(sData, 'purgeAt', 'expiresAt');
        const purgeAtMs = parseExpiryToMs(expiresAtIso);
        setServerResult({
          sessionId,
          resultUrl: immediateResultUrl,
          providerUsed,
          providerDisplayBadge:
            readStringField(sData, 'providerDisplayBadge', 'providerBadge') ??
            (cacheHit
              ? '⚡ CACHE_HIT · 0đ · Không trừ quota'
              : `✦ Server VTON · ${providerUsed}`),
          cacheHit,
          expiresAtIso,
          purgeAtMs,
          remainingQuota,
          durationMs: readNumberField(sData, 'durationMs', 'totalDurationMs'),
          usedSynthesizeFallback: false,
        });
        setServerPurgeSeconds(
          Math.max(0, Math.floor((purgeAtMs - Date.now()) / 1000)),
        );
        setServerRunning(false);
        setServerProgress(null);
        void fetchServerVtonQuota();
        return;
      }

      // HTTP 202 QUEUED -> Authenticated Socket.io + HTTP Polling (`GET /bff/v1/storefront/tryon/sessions/:id`)
      monitorServerVtonSession({
        sessionId,
        pollEndpoint: `/bff/v1/storefront/tryon/sessions/${encodeURIComponent(sessionId)}`,
        totalSteps:
          Math.max(
            1,
            Math.round(readNumberField(sData, 'totalSteps') ?? expectedSteps),
          ),
        usedSynthesizeFallback: false,
        controller,
      });
    } catch (err) {
      if (isAbortError(err) || controller.signal.aborted) return;
      await runSynthesizeFallback('Kết nối tải trực tiếp tạm gián đoạn.');
    }
  }, [
    activeGarmentSpecs,
    cleanupServerVtonTransport,
    fetchServerVtonQuota,
    lightingPreset,
    monitorServerVtonSession,
    serverPortrait,
    serverPrivacyConsent,
    serverQuota?.remainingQuota,
    synthesisGarments,
    tryOnMode,
  ]);

  // Mode & Wardrobe selection handlers (NEVER clear locked SessionPersonFrame!)
  const handleSwitchTryOnMode = useCallback(
    (nextMode: TryOnMode) => {
      setTryOnMode(nextMode);
      setViewingSavedLook(null);
      if (nextMode === TryOnMode.SINGLE) {
        const keep = focusedSpec ?? activeGarmentSpecs[0];
        if (keep) {
          setActiveSlots({
            [keep.slot]: {
              productId: keep.productId,
              variantIdx: keep.variantIdx,
            },
          });
          setFocusedSlot(keep.slot);
        }
        return;
      }

      setActiveSlots((prev) => {
        const next: ActiveSlots = { ...prev };
        const keys = Object.keys(next) as TryOnGarmentSlot[];
        if (keys.length >= 2) return next;

        const hasOnePiece = Boolean(next.onePiece);
        const hasUpper = Boolean(next.upper);
        const hasLower = Boolean(next.lower);
        const hasOuterwear = Boolean(next.outerwear);

        const findBySlot = (slot: TryOnGarmentSlot) =>
          allProducts.find((p) => inferGarmentSlot(p) === slot);

        if (hasOnePiece && !hasOuterwear) {
          const outer = findBySlot('outerwear');
          if (outer) next.outerwear = { productId: outer.id, variantIdx: 0 };
        } else if ((hasUpper || hasOuterwear) && !hasLower && !hasOnePiece) {
          const lower = findBySlot('lower');
          if (lower) next.lower = { productId: lower.id, variantIdx: 0 };
          if (!hasUpper && hasOuterwear) {
            const upper = findBySlot('upper');
            if (upper) next.upper = { productId: upper.id, variantIdx: 0 };
          }
        } else if (hasLower && !hasUpper && !hasOuterwear) {
          const upper = findBySlot('upper') ?? findBySlot('outerwear');
          if (upper) {
            next[inferGarmentSlot(upper)] = {
              productId: upper.id,
              variantIdx: 0,
            };
          }
        } else if (keys.length === 0) {
          const upper = findBySlot('upper') ?? allProducts[0];
          const lower = findBySlot('lower');
          if (upper) {
            next[inferGarmentSlot(upper)] = {
              productId: upper.id,
              variantIdx: 0,
            };
          }
          if (lower) next.lower = { productId: lower.id, variantIdx: 0 };
        }
        return next;
      });
    },
    [activeGarmentSpecs, allProducts, focusedSpec],
  );

  const handleWearProduct = useCallback(
    (product: ProductSpuDto) => {
      const slot = inferGarmentSlot(product);
      setCartNotice(null);
      setViewingSavedLook(null);

      if (tryOnMode === TryOnMode.SINGLE) {
        setActiveSlots({
          [slot]: { productId: product.id, variantIdx: 0 },
        });
        setFocusedSlot(slot);
        return;
      }

      setActiveSlots((prev) => {
        const next: ActiveSlots = { ...prev };
        if (slot === 'onePiece') {
          delete next.upper;
          delete next.lower;
          next.onePiece = { productId: product.id, variantIdx: 0 };
        } else if (slot === 'upper' || slot === 'lower') {
          delete next.onePiece;
          next[slot] = { productId: product.id, variantIdx: 0 };
        } else {
          next.outerwear = { productId: product.id, variantIdx: 0 };
        }
        return next;
      });
      setFocusedSlot(slot);
    },
    [tryOnMode],
  );

  const handleApplyEntireStudioOutfit = useCallback(() => {
    if (studioProducts.length === 0) return;
    const next: ActiveSlots = {};
    for (const product of studioProducts) {
      const slot = inferGarmentSlot(product);
      if (slot === 'onePiece') {
        delete next.upper;
        delete next.lower;
        next.onePiece = { productId: product.id, variantIdx: 0 };
      } else if (slot === 'upper' || slot === 'lower') {
        if (!next.onePiece) {
          next[slot] = { productId: product.id, variantIdx: 0 };
        }
      } else {
        next.outerwear = { productId: product.id, variantIdx: 0 };
      }
    }
    const keys = Object.keys(next) as TryOnGarmentSlot[];
    if (keys.length === 0) return;
    setActiveSlots(next);
    setFocusedSlot(keys[0]!);
    setViewingSavedLook(null);
    setTryOnMode(
      keys.length >= 2 ? TryOnMode.MIX_MATCH_OUTFIT : TryOnMode.SINGLE,
    );
  }, [studioProducts]);

  const handleRemoveSlot = useCallback(
    (slot: TryOnGarmentSlot) => {
      if (activeGarmentSpecs.length <= 1) return;
      setViewingSavedLook(null);
      setActiveSlots((prev) => {
        const next = { ...prev };
        delete next[slot];
        return next;
      });
      if (focusedSlot === slot) {
        const remaining = activeGarmentSpecs.find((s) => s.slot !== slot);
        if (remaining) setFocusedSlot(remaining.slot);
      }
    },
    [activeGarmentSpecs, focusedSlot],
  );

  const handleSelectColorSwatch = useCallback(
    (variantIdx: number) => {
      if (!focusedSpec) return;
      setViewingSavedLook(null);
      setActiveSlots((prev) => ({
        ...prev,
        [focusedSpec.slot]: {
          productId: focusedSpec.productId,
          variantIdx,
        },
      }));
    },
    [focusedSpec],
  );

  const handleSaveMeasurementsInline = useCallback(async () => {
    const parsedBust =
      editBustCm && Number(editBustCm) >= 50 ? Number(editBustCm) : undefined;
    const parsedWaist =
      editWaistCm && Number(editWaistCm) >= 40 ? Number(editWaistCm) : undefined;
    const parsedHip =
      editHipCm && Number(editHipCm) >= 50 ? Number(editHipCm) : undefined;

    setSizeRecLoading(true);
    let recSize: CanonicalSizeCode = 'M';
    let liveResult: ExtendedSizeRecommendResponse | null = null;

    if (focusedSpec?.product) {
      const payload: Record<string, unknown> = {
        productId: focusedSpec.product.id,
        productSlug: focusedSpec.product.slug,
        slug: focusedSpec.product.slug,
        heightCm: editHeightCm,
        weightKg: editWeightKg,
        fitPreference: editFitPref,
      };
      if (parsedBust) payload.bustCm = parsedBust;
      if (parsedWaist) payload.waistCm = parsedWaist;
      if (parsedHip) payload.hipCm = parsedHip;

      const res = await apiFetch<ExtendedSizeRecommendResponse>(
        '/bff/v1/storefront/size-recommend',
        {
          method: 'POST',
          skipAuthRefresh: true,
          timeoutMs: 6000,
          body: JSON.stringify(payload),
        },
      );
      if (res.ok && res.data) {
        liveResult = res.data;
        if (isCanonicalSizeCode(res.data.recommendedSize)) {
          recSize = res.data.recommendedSize;
        }
      }
    }

    const nextSharedProfile: SharedBodyProfileV1 = {
      heightCm: editHeightCm,
      weightKg: editWeightKg,
      ...(parsedBust ? { bustCm: parsedBust } : {}),
      ...(parsedWaist ? { waistCm: parsedWaist } : {}),
      ...(parsedHip ? { hipCm: parsedHip } : {}),
      fitPreference: editFitPref,
      recommendedSize: recSize,
      updatedAt: Date.now(),
    };

    saveSharedBodyProfile(nextSharedProfile);
    // Keep Outfit Studio profile mirrored ONLY on explicit user save
    const studioMirror: StudioSizeProfile = {
      heightCm: editHeightCm,
      weightKg: editWeightKg,
      bustCm: parsedBust ?? liveResult?.estimatedMeasurements?.bustCm ?? 84,
      waistCm: parsedWaist ?? liveResult?.estimatedMeasurements?.waistCm ?? 66,
      hipCm: parsedHip ?? liveResult?.estimatedMeasurements?.hipCm ?? 90,
      fitPreference: mapProfileFitToApiFit(editFitPref),
      recommendedSize: recSize,
      updatedAt: new Date(nextSharedProfile.updatedAt).toISOString(),
    };
    saveStudioSizeProfile(studioMirror);

    setBodyProfile(nextSharedProfile);
    if (liveResult) {
      setSizeRecommendation(liveResult);
    }
    setSelectedSizeCode(recSize);
    setSizeRecLoading(false);
    setShowMeasureEditor(false);
    setShowFitVisualizer(Boolean(liveResult));
    showAtelierToast(
      liveResult?.crowdAdjusted && liveResult.crowdAdjustmentReason
        ? `Size ${recSize} — ${liveResult.crowdAdjustmentReason}`
        : `Đã lưu số đo ${editHeightCm}cm · ${editWeightKg}kg — đồng bộ Size ${recSize} vào giỏ hàng.`,
      'gold',
    );
  }, [
    editBustCm,
    editFitPref,
    editHeightCm,
    editHipCm,
    editWaistCm,
    editWeightKg,
    focusedSpec?.product,
  ]);

  // Compact Compare Bar Actions
  const displayAfterImageUrl =
    viewingSavedLook?.resultDataUrl ??
    (engineMode === 'server_vton'
      ? serverResult?.resultUrl ?? serverPortrait?.previewDataUrl ?? null
      : synthesisResult?.resultDataUrl ?? personFrame?.dataUrl ?? null);

  const canSaveCurrent = Boolean(
    (engineMode === 'server_vton'
      ? Boolean(serverResult?.resultUrl && !serverRunning)
      : Boolean(
          isShowingResultStage &&
            synthesisResult?.resultDataUrl &&
            !synthesizing,
        )) && savedLooks.length < MAX_SAVED_LOOKS,
  );

  const handleSaveCurrentLook = useCallback(() => {
    const activeResultUrl =
      engineMode === 'server_vton'
        ? serverResult?.resultUrl
        : synthesisResult?.resultDataUrl;
    if (!activeResultUrl) return;
    if (savedLooks.length >= MAX_SAVED_LOOKS) {
      showAtelierToast(
        'Khay đối chiếu đã đủ 3/3 bộ — xóa bớt 1 bộ để lưu thêm.',
        'warning',
      );
      return;
    }

    const title =
      activeGarmentSpecs.length >= 2
        ? `Bộ phối ${activeGarmentSpecs.length} món`
        : focusedSpec?.name ?? 'Thiết kế Atelier';
    const subtitle = focusedSpec
      ? `${focusedSpec.colorName} · Size ${selectedSizeCode}`
      : `Size ${selectedSizeCode}`;

    const newLook: SavedTryOnLook = {
      id: `look-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      title,
      subtitle,
      priceVnd: totalOutfitPriceVnd,
      resultDataUrl: activeResultUrl,
      createdAt: Date.now(),
      garmentSummary: activeGarmentSummaryText || title,
    };

    setSavedLooks((prev) => [...prev, newLook].slice(0, MAX_SAVED_LOOKS));
    showAtelierToast(
      `Đã lưu "${title}" vào khay đối chiếu (${savedLooks.length + 1}/${MAX_SAVED_LOOKS}).`,
      'gold',
    );
  }, [
    activeGarmentSpecs.length,
    activeGarmentSummaryText,
    engineMode,
    focusedSpec,
    savedLooks.length,
    selectedSizeCode,
    serverResult?.resultUrl,
    synthesisResult?.resultDataUrl,
    totalOutfitPriceVnd,
  ]);

  const handleRemoveSavedLook = useCallback((id: string) => {
    setSavedLooks((prev) => prev.filter((item) => item.id !== id));
    setViewingSavedLook((prev) => (prev?.id === id ? null : prev));
  }, []);

  const handleRetakePhoto = useCallback(() => {
    if (engineMode === 'server_vton') {
      cleanupServerVtonTransport();
      setServerRunning(false);
      setServerProgress(null);
      setServerResult(null);
      setServerErrorBanner(null);
      setServerPortrait(null);
      setServerFileError(null);
      setServerPurgedNotice(false);
      setViewingSavedLook(null);
      return;
    }
    if (activeAbortControllerRef.current) {
      activeAbortControllerRef.current.abort();
      activeAbortControllerRef.current = null;
    }
    synthesisReqIdRef.current += 1;
    setSynthesizing(false);
    setSynthesisProgress(null);
    setSynthesisError(null);
    setViewingSavedLook(null);
    setSynthesisResult(null);
    if (inputTab === 'presets') {
      sessionPersonStore.clearFrame(false);
      setPersonFrame(null);
      setInputTab('upload');
      return;
    }
    sessionPersonStore.clearFrame(false);
    setPersonFrame(null);
  }, [cleanupServerVtonTransport, engineMode, inputTab]);

  const handleDownloadResult = useCallback(() => {
    if (!displayAfterImageUrl || typeof document === 'undefined') return;
    const anchor = document.createElement('a');
    anchor.href = displayAfterImageUrl;
    anchor.download = `tam-xuan-atelier-tryon-${selectedSizeCode.toLowerCase()}.webp`;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
  }, [displayAfterImageUrl, selectedSizeCode]);

  // High-Conversion Sticky Buy CTA -> adds exact SKU (color + size) to cart, fires `fromAiTryOn: true` / `THEM_GIO_SAU_THU` AI Funnel telemetry & opens QuickBagDrawer
  const handleAddToBag = useCallback(async () => {
    if (activeGarmentSpecs.length === 0 || addingToCart) return;
    setAddingToCart(true);
    setCartNotice(null);

    const activeTryOnSessionId =
      engineMode === 'server_vton'
        ? serverResult?.sessionId ?? undefined
        : synthesisResult?.jobId ?? undefined;

    try {
      let cartResult: CartDto | null = null;
      let ok = false;

      if (activeGarmentSpecs.length >= 2) {
        const res = await apiFetch<CartDto>('/bff/v1/cart/outfit-bundle', {
          method: 'POST',
          headers: getGuestHeader(),
          skipAuthRefresh: true,
          timeoutMs: 6000,
          body: JSON.stringify({
            ...(activeTryOnSessionId ? { sessionId: activeTryOnSessionId } : {}),
            items: activeGarmentSpecs.map((item) => ({
              skuId: item.skuId,
              productId: item.productId,
              variantId: item.variantId,
              sizeCode: selectedSizeCode,
              quantity: 1,
              slot: mapSlotToOutfitSlot(item.slot),
              fromAiTryOn: true,
              tuPhongThuDoAi: true,
              ...(activeTryOnSessionId
                ? { sessionId: activeTryOnSessionId }
                : {}),
            })),
          }),
        });
        ok = res.ok;
        cartResult = res.data;
      } else {
        const target = activeGarmentSpecs[0]!;
        const res = await apiFetch<CartDto>('/bff/v1/cart/items', {
          method: 'POST',
          headers: getGuestHeader(),
          skipAuthRefresh: true,
          timeoutMs: 6000,
          body: JSON.stringify({
            skuId: target.skuId,
            productId: target.productId,
            variantId: target.variantId,
            sizeCode: selectedSizeCode,
            quantity: 1,
            slot: mapSlotToOutfitSlot(target.slot),
            fromAiTryOn: true,
            tuPhongThuDoAi: true,
            ...(activeTryOnSessionId
              ? { sessionId: activeTryOnSessionId }
              : {}),
          }),
        });
        ok = res.ok;
        cartResult = res.data;
      }

      // When cart BFF is unreachable, still emit THEM_GIO_SAU_THU conversion signal directly
      if (!ok) {
        void Promise.allSettled(
          activeGarmentSpecs.map((item) =>
            apiFetch<unknown>('/bff/v1/storefront/tryon/signals', {
              method: 'POST',
              headers: getGuestHeader(),
              skipAuthRefresh: true,
              timeoutMs: 3500,
              body: JSON.stringify({
                productId: item.productId,
                skuId: item.skuId,
                sizeCode: selectedSizeCode,
                ...(activeTryOnSessionId
                  ? { sessionId: activeTryOnSessionId }
                  : {}),
                signalType: 'THEM_GIO_SAU_THU',
                eventType: 'THEM_GIO_SAU_THU',
              }),
            }),
          ),
        );
      }

      const finalCart =
        ok && cartResult
          ? cartResult
          : buildLocalFallbackCart(
              cartSnapshot,
              activeGarmentSpecs,
              selectedSizeCode,
            );

      setCartSnapshot(finalCart);
      saveCachedCartSnapshot(finalCart);
      emitCartUpdated(finalCart);

      const successText =
        activeGarmentSpecs.length >= 2
          ? `Đã thêm bộ phối ${activeGarmentSpecs.length} món (Size ${selectedSizeCode}) vào giỏ hàng.`
          : `Đã thêm ${activeGarmentSpecs[0]!.name} · ${activeGarmentSpecs[0]!.colorName} (Size ${selectedSizeCode}) vào giỏ hàng.`;

      setCartNotice(successText);
      showAtelierToast(
        ok
          ? 'Đã thêm thiết kế từ Phòng Thử Đồ AI vào giỏ hàng!'
          : 'Đã lưu thiết kế vào túi đồ tạm — sẵn sàng đồng bộ.',
        ok ? 'success' : 'gold',
      );
      onAddedToBag?.(finalCart);
    } catch {
      const localCart = buildLocalFallbackCart(
        cartSnapshot,
        activeGarmentSpecs,
        selectedSizeCode,
      );
      setCartSnapshot(localCart);
      saveCachedCartSnapshot(localCart);
      emitCartUpdated(localCart);
      setCartNotice('Đã lưu thiết kế vào túi đồ tạm của phiên hiện tại.');
      showAtelierToast('Đã lưu thiết kế vào túi đồ tạm.', 'gold');
      onAddedToBag?.(localCart);
    } finally {
      setAddingToCart(false);
    }
  }, [
    activeGarmentSpecs,
    addingToCart,
    cartSnapshot,
    engineMode,
    onAddedToBag,
    selectedSizeCode,
    serverResult?.sessionId,
    synthesisResult?.jobId,
  ]);

  if (!isActive) {
    return null;
  }

  const stageBackdropClass =
    lightingPreset === 'morning'
      ? styles.stageBackdropMorning
      : lightingPreset === 'evening'
        ? styles.stageBackdropEvening
        : styles.stageBackdropAtelier;

  const focusedProduct = focusedSpec?.product ?? null;
  const focusedVariantIdx = focusedSpec?.variantIdx ?? 0;
  const focusedVariant = focusedProduct
    ? focusedProduct.variants[focusedVariantIdx] ?? focusedProduct.variants[0]
    : null;

  // Strictly ordered canonical sizes: XS · S · M · L · XL
  const availableSizes = (() => {
    const skus = focusedVariant?.skus ?? [];
    return CANONICAL_SIZES.map((code) => {
      const match = skus.find((s) => s.sizeCode === code);
      return {
        sizeCode: code,
        inStock: match ? match.inStock : skus.length === 0,
      };
    });
  })();

  const formattedPrice = FORMAT_VND(totalOutfitPriceVnd);
  const ctaLabel = addingToCart
    ? 'ĐANG THÊM VÀO GIỎ HÀNG...'
    : tryOnMode === TryOnMode.MIX_MATCH_OUTFIT && activeGarmentSpecs.length >= 2
      ? `THÊM CẢ BỘ VÀO GIỎ (${activeGarmentSpecs.length} MÓN) · ${formattedPrice}`
      : `THÊM VÀO GIỎ HÀNG · ${formattedPrice}`;

  const studioShell = (
    <div
      data-testid="virtual-tryon-modal"
      data-lenis-prevent=""
      role={embedded ? 'region' : 'dialog'}
      aria-modal={embedded ? undefined : true}
      aria-label="Phòng Thử Đồ AI Tầm Xuân"
      className={`${styles.studioPortalLayer} ${
        embedded && quickBagDrawerOpen ? styles.studioPortalLayerBehindDrawer : ''
      }`}
    >
      {/* 1. Dedicated 64px Espresso Top Bar — 100% Unclipped, Zero SiteHeader Overlap */}
      <header
        data-testid="tryon-top-bar"
        className={`${styles.studioTopBar} flex items-center justify-between gap-3 px-4 sm:px-6`}
      >
        <div className="min-w-0">
          <p
            data-testid="tryon-header-eyebrow"
            className="truncate text-[10px] font-medium tracking-[0.22em] uppercase text-[#EBCF8F]"
          >
            PHÒNG THỬ ĐỒ AI · VIRTUAL TRY-ON ATELIER
          </p>
          <h2
            data-testid="tryon-header-title"
            className="font-editorial truncate text-xl leading-tight font-light text-[#FBF7EF] sm:text-2xl"
          >
            Ướm thử trực tiếp trên vóc dáng thật
          </h2>
        </div>

        <div className="flex shrink-0 items-center gap-2.5">
          <span
            data-testid="tryon-privacy-badge"
            className="inline-flex items-center gap-1.5 rounded-full border border-[#B08A4A]/45 bg-[#221813] px-3 py-1 text-[10px] font-medium tracking-[0.12em] uppercase text-[#EBCF8F]"
          >
            <span aria-hidden="true">🔒</span>
            <span>TỰ ĐỘNG XÓA ẢNH SAU 15 PHÚT</span>
          </span>

          {onClose ? (
            <button
              type="button"
              data-testid="tryon-close-btn"
              onClick={onClose}
              aria-label="Đóng phòng thử"
              className="inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-[#EBCF8F]/50 bg-[#241A14] px-3.5 py-1.5 text-[11px] font-medium text-[#FBF7EF] transition-colors hover:border-[#EBCF8F] hover:bg-[#EBCF8F] hover:text-[#1C1410]"
            >
              <span aria-hidden="true">✕</span>
              <span className="hidden sm:inline">Đóng phòng thử</span>
            </button>
          ) : null}
        </div>
      </header>

      {/* 2. Main 2-Column 100svh Atelier Studio Layout */}
      <div className="grid min-h-0 flex-1 grid-cols-1 overflow-hidden lg:grid-cols-[minmax(0,1.08fr)_minmax(400px,0.92fr)]">
        {/* LEFT COLUMN — Engine Mode Switch + Input Tabs / Server VTON + 3:4 Stage + Compare Bar */}
        <section
          aria-label="Sân khấu Phòng Thử Đồ AI"
          className="flex min-h-0 flex-col gap-2 overflow-hidden border-b border-[#B08A4A]/20 px-3 py-2.5 sm:px-5 sm:py-3 lg:border-r lg:border-b-0"
        >
          {/* Stage Engine Mode Switch: Gương Căn Dáng & AR Trực Tiếp vs Thử Ảnh AI Chuyên Sâu (Server VTON) + Live Quota Badge */}
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-2">
            <div
              role="group"
              aria-label="Chọn chế độ phòng thử đồ"
              className="inline-flex w-full items-center gap-1 rounded-full border border-[#B08A4A]/40 bg-[#140E0B] p-1 sm:w-auto"
            >
              <button
                type="button"
                data-testid="tryon-engine-ar-mirror"
                aria-pressed={engineMode === 'ar_mirror'}
                onClick={() => {
                  setEngineMode('ar_mirror');
                  setViewingSavedLook(null);
                }}
                className={`flex-1 cursor-pointer rounded-full border border-transparent px-3 py-1 text-[10.5px] font-medium tracking-[0.03em] whitespace-nowrap transition-all sm:flex-initial ${
                  engineMode === 'ar_mirror'
                    ? styles.goldPillActive
                    : 'text-[#FBF7EF]/78 hover:text-[#EBCF8F]'
                }`}
              >
                Gương Căn Dáng &amp; AR Trực Tiếp
              </button>
              <button
                type="button"
                data-testid="tryon-engine-server-vton"
                aria-pressed={engineMode === 'server_vton'}
                onClick={() => {
                  setEngineMode('server_vton');
                  setViewingSavedLook(null);
                }}
                className={`flex-1 cursor-pointer rounded-full border border-transparent px-3 py-1 text-[10.5px] font-medium tracking-[0.03em] whitespace-nowrap transition-all sm:flex-initial ${
                  engineMode === 'server_vton'
                    ? styles.goldPillActive
                    : 'text-[#FBF7EF]/78 hover:text-[#EBCF8F]'
                }`}
              >
                ✦ Thử Ảnh AI Chuyên Sâu (Server VTON)
              </button>
            </div>

            <span
              data-testid="tryon-daily-quota-badge"
              className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-[#B08A4A]/40 bg-[#221813] px-2.5 py-1 font-mono text-[10px] text-[#EBCF8F]"
            >
              <span
                className={`h-1.5 w-1.5 rounded-full ${
                  serverQuota && serverQuota.remainingQuota === 0
                    ? 'bg-amber-400'
                    : 'bg-emerald-400'
                }`}
              />
              {serverQuota ? (
                <span>
                  Còn {serverQuota.remainingQuota}/{serverQuota.dailyLimit} lượt
                  AI hôm nay
                </span>
              ) : serverQuotaLoading ? (
                <span>Đang tải hạn mức AI...</span>
              ) : (
                <span>Hạn mức AI miễn phí mỗi ngày</span>
              )}
            </span>
          </div>

          {/* 3 Practical Input Mode Tabs (shown in AR Mirror mode) */}
          {engineMode === 'ar_mirror' ? (
            <div className="flex shrink-0 items-center justify-between gap-2">
              <div
                role="tablist"
                aria-label="Chọn nguồn ảnh thử đồ"
                className="inline-flex w-full items-center gap-1 rounded-full border border-[#B08A4A]/32 bg-[#140E0B] p-1 sm:w-auto"
              >
                {INPUT_TABS.map((tab) => {
                  const active = inputTab === tab.id;
                  return (
                    <button
                      key={tab.id}
                      type="button"
                      role="tab"
                      aria-selected={active}
                      data-testid={tab.testId}
                      onClick={() => handleSwitchInputTab(tab.id)}
                      className={`flex-1 cursor-pointer rounded-full border border-transparent px-3 py-1.5 text-[11px] font-medium tracking-[0.04em] whitespace-nowrap transition-all sm:flex-initial ${
                        active
                          ? styles.goldPillActive
                          : 'text-[#FBF7EF]/78 hover:text-[#EBCF8F]'
                      }`}
                    >
                      <span className="hidden sm:inline">{tab.label}</span>
                      <span className="sm:hidden">{tab.shortLabel}</span>
                    </button>
                  );
                })}
              </div>

              {personFrame ? (
                <span
                  data-testid="tryon-session-frame-badge"
                  className="hidden shrink-0 items-center gap-1.5 rounded-full border border-[#B08A4A]/30 bg-[#221813] px-2.5 py-1 text-[10px] text-[#EBD9B4]/88 xl:inline-flex"
                >
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                  <span className="max-w-[180px] truncate">
                    Khung đã khóa · {personFrame.label}
                  </span>
                </span>
              ) : null}
            </div>
          ) : null}

          {/* 4 Curated Vietnamese Studio Quick-TryOn Model Cards (when AR Mirror + Dáng Mẫu Thử Nhanh is active) */}
          {engineMode === 'ar_mirror' && inputTab === 'presets' ? (
            <div
              data-testid="tryon-preset-models-strip"
              className={`shrink-0 ${styles.presetStripGrid}`}
            >
              {QUICK_TRYON_MODELS.map((preset) => {
                const isSelected =
                  selectedPresetId === preset.id &&
                  personFrame?.source === 'preset';
                const isLoading = loadingPresetId === preset.id;
                return (
                  <button
                    key={preset.id}
                    type="button"
                    data-testid={`tryon-preset-model-${preset.id}`}
                    data-preset-id={preset.id}
                    aria-pressed={isSelected}
                    onClick={() => void handleSelectQuickModel(preset)}
                    className={`group flex cursor-pointer items-center gap-2 rounded-xl border p-1.5 text-left transition-all ${
                      isSelected
                        ? 'border-[#EBCF8F] bg-[#2D2119] ring-1 ring-[#EBCF8F]/70'
                        : 'border-[#B08A4A]/28 bg-[#1D1511] hover:border-[#EBCF8F]/70'
                    }`}
                  >
                    <div className="relative h-12 w-9 shrink-0 overflow-hidden rounded-lg bg-[#140E0B]">
                      <img
                        src={preset.imageUrl}
                        alt={`${preset.name} (${preset.subtitle})`}
                        className="h-full w-full object-cover object-top transition-transform duration-300 group-hover:scale-105"
                      />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[11px] font-medium text-[#FBF7EF]">
                        {preset.name}
                      </p>
                      <p className="truncate text-[9.5px] text-[#EBCF8F]/85">
                        {preset.heightCm >= 100
                          ? `${Math.floor(preset.heightCm / 100)}m${String(preset.heightCm % 100).padStart(2, '0')}`
                          : `${preset.heightCm}cm`}{' '}
                        · {preset.weightKg}kg
                      </p>
                      <p className="truncate text-[9px] text-[#FBF7EF]/60">
                        {isLoading
                          ? 'Đang tải...'
                          : `Cỡ ${preset.recommendedSize}`}
                      </p>
                    </div>
                  </button>
                );
              })}
            </div>
          ) : null}

          {/* Main 3:4 Stage Viewport (`flex-1 min-h-0` — fits cleanly inside 100svh) */}
          <div
            data-testid="tryon-stage-viewport"
            data-engine-mode={engineMode}
            data-cache-hit={
              engineMode === 'server_vton'
                ? serverResult
                  ? String(serverResult.cacheHit)
                  : undefined
                : synthesisResult
                  ? String(synthesisResult.cacheHit)
                  : undefined
            }
            data-provider={
              engineMode === 'server_vton'
                ? serverResult?.providerUsed ?? undefined
                : synthesisResult?.provider ?? undefined
            }
            data-job-id={
              engineMode === 'server_vton'
                ? serverResult?.sessionId ?? serverProgress?.jobId ?? undefined
                : synthesisResult?.jobId ?? synthesisProgress?.jobId ?? undefined
            }
            data-step-total={
              engineMode === 'server_vton'
                ? serverProgress?.stepTotal !== undefined
                  ? String(serverProgress.stepTotal)
                  : undefined
                : synthesisResult?.stepTotal !== undefined
                  ? String(synthesisResult.stepTotal)
                  : synthesisProgress?.stepTotal !== undefined
                    ? String(synthesisProgress.stepTotal)
                    : undefined
            }
            data-provider-badge={
              engineMode === 'server_vton'
                ? serverResult?.providerDisplayBadge ?? undefined
                : synthesisResult
                  ? formatProviderBadge(synthesisResult)
                  : undefined
            }
            data-clean-collar={
              synthesisResult
                ? String(synthesisResult.cleanCollarApplied)
                : undefined
            }
            className={`${styles.stageFrameShell} ${stageBackdropClass} p-2`}
          >
            {engineMode === 'server_vton' ? (
              <div
                data-testid="server-vton-panel"
                className="relative flex h-full w-full flex-col items-center justify-center overflow-hidden"
              >
                {/* Hidden native file picker for Server VTON */}
                <input
                  ref={serverFileInputRef}
                  type="file"
                  data-testid="server-vton-file-input"
                  accept="image/jpeg,image/png,image/webp"
                  className="sr-only"
                  onChange={(event) => {
                    const picked = event.target.files?.[0];
                    event.target.value = '';
                    if (picked) {
                      void handleServerVtonSelectFile(picked);
                    }
                  }}
                />

                {serverResult && serverPortrait ? (
                  <div className="relative flex h-full w-full flex-col items-center justify-center gap-2">
                    {/* Explicit Server VTON :4009 Telemetry Strip (CACHE_HIT 0đ + Hard-Purge 15:00->00:00 + Re-run action) */}
                    <div className="flex w-full max-w-[420px] shrink-0 flex-wrap items-center justify-between gap-1.5 rounded-xl border border-[#B08A4A]/35 bg-[#16100C]/92 px-3 py-1.5 text-[10px]">
                      <div className="flex flex-wrap items-center gap-1.5">
                        {serverResult.cacheHit ||
                        serverResult.providerUsed.toUpperCase() ===
                          'CACHE_HIT' ? (
                          <span
                            data-testid="tryon-cache-hit-badge"
                            className="inline-flex items-center gap-1 rounded-full border border-[#EBCF8F]/75 bg-[#2B2019] px-2.5 py-0.5 font-semibold text-[#EBCF8F]"
                          >
                            <span>⚡</span>
                            <span>CACHE_HIT · 0đ · Không trừ quota</span>
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 rounded-full border border-[#B08A4A]/45 bg-[#221813] px-2 py-0.5 text-[#F4EBDA]">
                            <span>✦</span>
                            <span>{serverResult.providerUsed}</span>
                          </span>
                        )}

                        <span
                          data-testid="tryon-hard-purge-countdown"
                          className="inline-flex items-center gap-1 rounded-full border border-[#B08A4A]/35 bg-[#1C1410] px-2 py-0.5 font-mono text-[#EBCF8F]"
                        >
                          <span aria-hidden="true">⏱</span>
                          <span>
                            Xóa cứng sau {formatMmSsCountdown(serverPurgeSeconds)}
                          </span>
                        </span>
                      </div>

                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          data-testid="server-vton-rerun-btn"
                          disabled={serverRunning}
                          onClick={() => void handleRunServerVton()}
                          className="cursor-pointer rounded-full border border-[#EBCF8F]/60 bg-[#2B2019] px-2.5 py-0.5 text-[10px] font-medium text-[#EBCF8F] transition-colors hover:bg-[#EBCF8F] hover:text-[#1C1410] disabled:opacity-50"
                        >
                          Thử mẫu đang chọn
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setServerResult(null);
                            setServerErrorBanner(null);
                          }}
                          className="cursor-pointer text-[10px] text-[#FBF7EF]/70 underline underline-offset-2 hover:text-[#EBCF8F]"
                        >
                          Đổi ảnh
                        </button>
                      </div>
                    </div>

                    {serverErrorBanner ? (
                      <div
                        role="alert"
                        data-testid={
                          serverErrorBanner.code === 'POSE_TOO_CLOSE'
                            ? 'tryon-pose-too-close-banner'
                            : 'tryon-quota-refund-banner'
                        }
                        className="flex w-full max-w-[420px] shrink-0 items-start justify-between gap-2 rounded-xl border border-amber-400/55 bg-amber-950/75 px-3 py-2 text-left text-[10.5px] text-amber-100"
                      >
                        <div className="min-w-0 flex-1">
                          <p className="font-semibold text-[#EBCF8F]">
                            {serverErrorBanner.code === 'POSE_TOO_CLOSE'
                              ? 'Ảnh quá gần khung hình (POSE_TOO_CLOSE)'
                              : 'Thông báo phiên Server VTON'}
                            {serverErrorBanner.quotaRefunded
                              ? ' · Đã hoàn +1 lượt AI'
                              : ''}
                          </p>
                          <p className="mt-0.5 leading-snug">
                            {serverErrorBanner.message}
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={() => setServerErrorBanner(null)}
                          aria-label="Đóng thông báo"
                          className="shrink-0 cursor-pointer text-[#EBCF8F] hover:text-white"
                        >
                          ✕
                        </button>
                      </div>
                    ) : null}

                    <div className="relative min-h-0 w-full flex-1 flex items-center justify-center">
                      <BeforeAfterSlider
                        beforeImageUrl={serverPortrait.previewDataUrl}
                        afterImageUrl={
                          viewingSavedLook?.resultDataUrl ??
                          serverResult.resultUrl
                        }
                        lightingPreset={lightingPreset}
                        onLightingPresetChange={(nextPreset) => {
                          setViewingSavedLook(null);
                          setLightingPreset(nextPreset);
                        }}
                        remainingSeconds={serverPurgeSeconds}
                        providerBadge={
                          serverResult.cacheHit
                            ? '⚡ CACHE_HIT · 0đ (Không trừ lượt)'
                            : serverResult.providerDisplayBadge
                        }
                        garmentSummary={
                          viewingSavedLook
                            ? `Đang xem lại: ${viewingSavedLook.title}`
                            : activeGarmentSummaryText
                        }
                      />

                      <OpticalTryOnScan
                        visible={serverRunning}
                        progress={serverProgress}
                        onCancel={handleCancelServerVton}
                      />
                    </div>
                  </div>
                ) : (
                  <div className="relative flex aspect-[3/4] h-full max-h-full max-w-full flex-col justify-between overflow-y-auto rounded-2xl border border-[#B08A4A]/42 bg-[#1C1410]/94 p-4 text-[#FBF7EF] shadow-[0_24px_64px_-24px_rgba(0,0,0,0.9)]">
                    {/* Top Privacy & Private Bucket Header */}
                    <div className="space-y-1.5 text-center">
                      <span className="inline-flex items-center gap-1.5 rounded-full border border-[#EBCF8F]/45 bg-[#2B2019] px-3 py-0.5 text-[9.5px] font-medium tracking-[0.14em] uppercase text-[#EBCF8F]">
                        <span aria-hidden="true">🔒</span>
                        <span>
                          Server VTON · Kho riêng tư atelier-private-tryon (15:00)
                        </span>
                      </span>
                      <h3 className="font-editorial text-xl font-medium text-[#FBF7EF]">
                        Thử Ảnh AI Chuyên Sâu (Server VTON)
                      </h3>
                      <p className="text-[11px] leading-relaxed text-[#EBD9B4]/78">
                        Tải ảnh qua Presigned URL an toàn, xác thực Magic Bytes,
                        bộ nhớ đệm SHA-256 (0đ khi thử lại) và tự động xóa cứng
                        sau 15 phút.
                      </p>
                    </div>

                    {/* Automatic +1 Quota Refund Banner on POSE_TOO_CLOSE / Failure */}
                    {serverErrorBanner ? (
                      <div
                        role="alert"
                        data-testid={
                          serverErrorBanner.code === 'POSE_TOO_CLOSE'
                            ? 'tryon-pose-too-close-banner'
                            : 'tryon-quota-refund-banner'
                        }
                        className="my-2 rounded-xl border border-amber-400/55 bg-amber-950/65 p-3 text-left text-[11px] text-amber-100"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <p className="font-semibold text-[#EBCF8F]">
                            {serverErrorBanner.code === 'POSE_TOO_CLOSE'
                              ? 'Ảnh quá gần khung hình (POSE_TOO_CLOSE)'
                              : 'Thông báo phiên Server VTON'}
                          </p>
                          {serverErrorBanner.quotaRefunded ? (
                            <span
                              data-testid="tryon-quota-refund-pill"
                              className="shrink-0 rounded-full border border-emerald-400/50 bg-emerald-950/70 px-2 py-0.5 font-mono text-[9.5px] font-semibold text-emerald-200"
                            >
                              +1 lượt đã hoàn
                            </span>
                          ) : null}
                        </div>
                        <p className="mt-1 leading-snug">
                          {serverErrorBanner.message}
                        </p>
                        {serverErrorBanner.code === 'POSE_TOO_CLOSE' ? (
                          <p className="mt-1 text-[10px] text-amber-200/90">
                            Gợi ý: Đứng lùi lại 80cm–1m để lộ rõ hai vai và thân
                            trên, sau đó chọn lại ảnh (lượt thử miễn phí của bạn
                            đã được hoàn lại +1).
                          </p>
                        ) : null}
                      </div>
                    ) : null}

                    {serverPurgedNotice ? (
                      <div
                        role="status"
                        className="my-1.5 rounded-xl border border-[#B08A4A]/45 bg-[#2B2019]/90 px-3 py-2 text-center text-[11px] text-[#EBCF8F]"
                      >
                        ⏱ Ảnh phiên trước đã tự động xóa cứng sau 15:00 theo cam
                        kết quyền riêng tư. Vui lòng chọn lại ảnh mới.
                      </div>
                    ) : null}

                    {/* Portrait Preview or Picker */}
                    <div className="my-2 flex flex-1 flex-col items-center justify-center gap-2.5">
                      {serverPortrait ? (
                        <div className="flex w-full items-center gap-3 rounded-xl border border-[#EBCF8F]/40 bg-[#241A14] p-2.5">
                          <div className="aspect-[3/4] w-16 shrink-0 overflow-hidden rounded-lg border border-[#B08A4A]/40 bg-[#140E0B]">
                            <img
                              src={serverPortrait.previewDataUrl}
                              alt="Ảnh chân dung đã sẵn sàng cho Server VTON"
                              className="h-full w-full object-cover"
                            />
                          </div>
                          <div className="min-w-0 flex-1 text-left">
                            <p className="truncate text-xs font-medium text-[#FBF7EF]">
                              {serverPortrait.label}
                            </p>
                            <p className="mt-0.5 font-mono text-[10px] text-[#EBCF8F]/85">
                              {serverPortrait.contentType.replace('image/', '').toUpperCase()}{' '}
                              · {(serverPortrait.bytes.byteLength / 1024).toFixed(0)} KB ·
                              SHA-256 đã xác thực
                            </p>
                            <button
                              type="button"
                              disabled={serverRunning}
                              onClick={() => serverFileInputRef.current?.click()}
                              className="mt-1.5 cursor-pointer text-[10.5px] text-[#EBCF8F] underline underline-offset-2 hover:text-white disabled:opacity-50"
                            >
                              Chọn ảnh khác
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="flex w-full flex-col items-center gap-2 rounded-xl border border-dashed border-[#B08A4A]/45 bg-[#16100C]/80 px-4 py-4 text-center">
                          <p className="text-xs text-[#F4EBDA]/88">
                            Chọn ảnh chân dung chính diện (JPEG, PNG, WebP ≤ 10MB)
                          </p>
                          <div className="flex flex-wrap items-center justify-center gap-2">
                            <button
                              type="button"
                              data-testid="server-vton-upload-btn"
                              disabled={!serverPrivacyConsent || serverRunning}
                              onClick={() => serverFileInputRef.current?.click()}
                              className="cursor-pointer rounded-full border border-[#EBCF8F]/70 bg-[#2B2019] px-4 py-1.5 text-[11px] font-medium text-[#EBCF8F] transition-colors hover:bg-[#EBCF8F] hover:text-[#1C1410] disabled:cursor-not-allowed disabled:opacity-45"
                            >
                              Chọn ảnh từ thiết bị
                            </button>
                            {personFrame ? (
                              <button
                                type="button"
                                data-testid="server-vton-use-current-frame-btn"
                                disabled={!serverPrivacyConsent || serverRunning}
                                onClick={() =>
                                  void handleServerVtonImportCurrentFrame()
                                }
                                className="cursor-pointer rounded-full border border-[#B08A4A]/50 bg-[#1C1410] px-3.5 py-1.5 text-[11px] text-[#F4EBDA] transition-colors hover:border-[#EBCF8F] hover:text-[#EBCF8F] disabled:cursor-not-allowed disabled:opacity-45"
                              >
                                Dùng ảnh khung hiện tại
                              </button>
                            ) : null}
                          </div>
                        </div>
                      )}

                      {serverFileError ? (
                        <p
                          role="alert"
                          data-testid="server-vton-file-error"
                          className="w-full rounded-lg border border-amber-400/45 bg-amber-950/50 px-3 py-1.5 text-center text-[10.5px] text-amber-100"
                        >
                          {serverFileError}
                        </p>
                      ) : null}
                    </div>

                    {/* Mandatory Privacy Consent Checkbox + Run CTA */}
                    <div className="space-y-2.5 border-t border-[#B08A4A]/25 pt-2.5">
                      <label className="flex cursor-pointer items-start gap-2.5 rounded-xl border border-[#B08A4A]/32 bg-[#241A14]/85 p-2.5 text-left text-[10.5px] leading-snug text-[#F4EBDA]/90">
                        <input
                          type="checkbox"
                          data-testid="server-vton-privacy-checkbox"
                          checked={serverPrivacyConsent}
                          onChange={(e) => {
                            setServerPrivacyConsent(e.target.checked);
                            if (e.target.checked) setServerFileError(null);
                          }}
                          className="mt-0.5 h-4 w-4 shrink-0 accent-[#EBCF8F]"
                        />
                        <span>
                          Tôi đồng ý tải ảnh lên kho riêng tư{' '}
                          <strong className="font-mono text-[#EBCF8F]">
                            atelier-private-tryon
                          </strong>{' '}
                          để thử đồ AI và xác nhận ảnh sẽ tự động xóa cứng sau{' '}
                          <strong className="text-[#EBCF8F]">15 phút</strong>.
                        </span>
                      </label>

                      <button
                        type="button"
                        data-testid="server-vton-start-btn"
                        disabled={
                          !serverPrivacyConsent ||
                          !serverPortrait ||
                          serverRunning ||
                          activeGarmentSpecs.length === 0
                        }
                        onClick={() => void handleRunServerVton()}
                        className={`w-full cursor-pointer rounded-full px-4 py-2.5 text-[11px] tracking-[0.12em] uppercase disabled:cursor-not-allowed disabled:opacity-45 ${styles.ctaGoldButton}`}
                      >
                        {serverRunning
                          ? 'ĐANG XỬ LÝ SERVER VTON...'
                          : `✦ CHẠY THỬ ẢNH AI CHUYÊN SÂU (${activeGarmentSpecs.length} MÓN)`}
                      </button>
                    </div>

                    <OpticalTryOnScan
                      visible={serverRunning}
                      progress={serverProgress}
                      onCancel={handleCancelServerVton}
                    />
                  </div>
                )}
              </div>
            ) : isShowingResultStage && personFrame && displayAfterImageUrl ? (
              <div className="relative flex h-full w-full items-center justify-center">
                <BeforeAfterSlider
                  beforeImageUrl={personFrame.dataUrl}
                  afterImageUrl={displayAfterImageUrl}
                  lightingPreset={lightingPreset}
                  onLightingPresetChange={(nextPreset) => {
                    setViewingSavedLook(null);
                    setLightingPreset(nextPreset);
                  }}
                  remainingSeconds={remainingSeconds}
                  providerBadge={formatProviderBadge(synthesisResult)}
                  garmentSummary={
                    viewingSavedLook
                      ? `Đang xem lại: ${viewingSavedLook.title}`
                      : activeGarmentSummaryText
                  }
                />

                {synthesisError && !synthesizing ? (
                  <div
                    role="alert"
                    data-testid="tryon-synthesis-error"
                    className="absolute inset-x-4 top-14 z-30 mx-auto flex max-w-[360px] items-start justify-between gap-2 rounded-xl border border-[#EBCF8F]/45 bg-[#1C1410]/94 px-3.5 py-2.5 text-[11px] text-[#F4EBDA] shadow-2xl backdrop-blur-md"
                  >
                    <span className="leading-snug">{synthesisError}</span>
                    <button
                      type="button"
                      onClick={() => setSynthesisError(null)}
                      aria-label="Đóng thông báo lỗi"
                      className="shrink-0 cursor-pointer text-[#EBCF8F] hover:text-white"
                    >
                      ✕
                    </button>
                  </div>
                ) : null}

                <OpticalTryOnScan
                  visible={synthesizing}
                  stepIndex={scanStepIndex}
                  progress={synthesisProgress}
                  onCancel={handleCancelSynthesis}
                />
              </div>
            ) : inputTab === 'camera' ? (
              <SmartMirrorCamera
                selectedGarments={selectedGarmentsPip}
                onFrameCaptured={commitSessionPersonFrame}
                onFallbackToUpload={() => handleSwitchInputTab('upload')}
                onFallbackToPresets={() => handleSwitchInputTab('presets')}
              />
            ) : inputTab === 'upload' ? (
              <PhotoUploadGate
                onFrameCaptured={commitSessionPersonFrame}
                onSwitchToPresets={() => handleSwitchInputTab('presets')}
              />
            ) : (
              <div className="relative flex h-full w-full items-center justify-center">
                <OpticalTryOnScan visible stepIndex={0} />
              </div>
            )}
          </div>

          {/* Left-Bottom Compact Compare Bar (directly beneath 3:4 stage) */}
          <div className="shrink-0">
            <CompactCompareBar
              savedLooks={savedLooks}
              activeLookId={viewingSavedLook?.id ?? null}
              canSaveCurrent={canSaveCurrent}
              onSaveCurrent={handleSaveCurrentLook}
              onSelectLook={(look) => setViewingSavedLook(look)}
              onRemoveLook={handleRemoveSavedLook}
              onRetakePhoto={handleRetakePhoto}
              onDownloadResult={handleDownloadResult}
              canDownload={Boolean(
                displayAfterImageUrl &&
                  (engineMode === 'server_vton'
                    ? Boolean(serverResult?.resultUrl)
                    : isShowingResultStage),
              )}
            />
          </div>
        </section>

        {/* RIGHT COLUMN — High-Conversion Wardrobe + Compact Variant/Size + Sticky Buy CTA */}
        <aside
          aria-label="Tủ đồ Atelier và đặt mua trực tiếp"
          className="flex min-h-0 flex-col overflow-hidden bg-[#1D1511]"
        >
          {/* Top Pinned Wardrobe Controls (`shrink-0`) */}
          <div className="shrink-0 space-y-2 border-b border-[#B08A4A]/20 px-4 pt-3 pb-2.5">
            {/* Row 1: Mode Switch (Thử 1 món | Phối cả bộ) + Active count */}
            <div className="flex items-center justify-between gap-2">
              <div
                role="group"
                aria-label="Kiểu ướm thử"
                className="inline-flex rounded-full border border-[#B08A4A]/30 bg-[#140E0B] p-0.5"
              >
                <button
                  type="button"
                  data-testid="tryon-mode-single"
                  aria-pressed={tryOnMode === TryOnMode.SINGLE}
                  onClick={() => handleSwitchTryOnMode(TryOnMode.SINGLE)}
                  className={`cursor-pointer rounded-full px-3 py-1 text-[11px] font-medium transition-colors ${
                    tryOnMode === TryOnMode.SINGLE
                      ? 'bg-[#EBCF8F] text-[#1C1410]'
                      : 'text-[#FBF7EF]/75 hover:text-[#EBCF8F]'
                  }`}
                >
                  Thử 1 món
                </button>
                <button
                  type="button"
                  data-testid="tryon-mode-outfit"
                  aria-pressed={tryOnMode === TryOnMode.MIX_MATCH_OUTFIT}
                  onClick={() =>
                    handleSwitchTryOnMode(TryOnMode.MIX_MATCH_OUTFIT)
                  }
                  className={`cursor-pointer rounded-full px-3 py-1 text-[11px] font-medium transition-colors ${
                    tryOnMode === TryOnMode.MIX_MATCH_OUTFIT
                      ? 'bg-[#EBCF8F] text-[#1C1410]'
                      : 'text-[#FBF7EF]/75 hover:text-[#EBCF8F]'
                  }`}
                >
                  Phối cả bộ
                </button>
              </div>

              <span className="font-mono text-[10px] text-[#EBCF8F]/85">
                Đang chọn {activeGarmentSpecs.length} món
              </span>
            </div>

            {/* Active Outfit Slot Chips (when Phối cả bộ) */}
            {tryOnMode === TryOnMode.MIX_MATCH_OUTFIT &&
            activeGarmentSpecs.length > 0 ? (
              <div
                data-testid="tryon-active-slot-chips"
                className="flex flex-wrap gap-1.5"
              >
                {activeGarmentSpecs.map((spec) => {
                  const isFocused = focusedSpec?.slot === spec.slot;
                  return (
                    <div
                      key={spec.slot}
                      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[10px] transition-colors ${
                        isFocused
                          ? 'border-[#EBCF8F] bg-[#EBCF8F]/18 text-[#EBCF8F]'
                          : 'border-[#B08A4A]/30 bg-[#17110E] text-[#FBF7EF]/82'
                      }`}
                    >
                      <button
                        type="button"
                        onClick={() => setFocusedSlot(spec.slot)}
                        className="max-w-[140px] cursor-pointer truncate text-left"
                      >
                        <strong className="font-medium">
                          {SLOT_LABELS[spec.slot]}:
                        </strong>{' '}
                        {spec.name}
                      </button>
                      {activeGarmentSpecs.length > 1 ? (
                        <button
                          type="button"
                          onClick={() => handleRemoveSlot(spec.slot)}
                          aria-label={`Bỏ ${SLOT_LABELS[spec.slot]}`}
                          className="ml-0.5 cursor-pointer text-[#EBCF8F]/75 hover:text-white"
                        >
                          ×
                        </button>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            ) : null}

            {/* Row 2: Wardrobe Source Tabs (Trong Giỏ Hàng · Bộ Đang Phối · Tủ Đồ Atelier) */}
            <div
              role="tablist"
              aria-label="Nguồn tủ đồ"
              className="grid grid-cols-3 gap-1 rounded-xl border border-[#B08A4A]/22 bg-[#140E0B] p-1"
            >
              <button
                type="button"
                role="tab"
                aria-selected={wardrobeSource === 'cart'}
                data-testid="wardrobe-source-cart"
                onClick={() => setWardrobeSource('cart')}
                className={`cursor-pointer truncate rounded-lg px-2 py-1.5 text-[10px] font-medium transition-colors ${
                  wardrobeSource === 'cart'
                    ? 'bg-[#EBCF8F] text-[#1C1410]'
                    : 'text-[#FBF7EF]/75 hover:text-[#EBCF8F]'
                }`}
              >
                Trong Giỏ Hàng ({cartProducts.length})
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={wardrobeSource === 'studio'}
                data-testid="wardrobe-source-studio"
                onClick={() => setWardrobeSource('studio')}
                className={`cursor-pointer truncate rounded-lg px-2 py-1.5 text-[10px] font-medium transition-colors ${
                  wardrobeSource === 'studio'
                    ? 'bg-[#EBCF8F] text-[#1C1410]'
                    : 'text-[#FBF7EF]/75 hover:text-[#EBCF8F]'
                }`}
              >
                Bộ Đang Phối ({studioProducts.length})
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={wardrobeSource === 'catalog'}
                data-testid="wardrobe-source-catalog"
                onClick={() => setWardrobeSource('catalog')}
                className={`cursor-pointer truncate rounded-lg px-2 py-1.5 text-[10px] font-medium transition-colors ${
                  wardrobeSource === 'catalog'
                    ? 'bg-[#EBCF8F] text-[#1C1410]'
                    : 'text-[#FBF7EF]/75 hover:text-[#EBCF8F]'
                }`}
              >
                Tủ Đồ Atelier ({allProducts.length})
              </button>
            </div>

            {/* Row 3: Category Quick Filters (Tất cả · Áo · Quần / Váy · Đầm · Áo khoác) */}
            {wardrobeSource === 'catalog' ? (
              <div className="flex flex-wrap gap-1">
                {CATEGORY_FILTER_OPTIONS.map((opt) => (
                  <button
                    key={opt.id}
                    type="button"
                    data-testid={`wardrobe-filter-${opt.id.toLowerCase()}`}
                    aria-pressed={slotFilter === opt.id}
                    onClick={() => setSlotFilter(opt.id)}
                    className={`cursor-pointer rounded-full border px-2.5 py-0.5 text-[10px] transition-colors ${
                      slotFilter === opt.id
                        ? 'border-[#EBCF8F]/75 bg-[#EBCF8F]/16 text-[#EBCF8F]'
                        : 'border-[#B08A4A]/22 text-[#FBF7EF]/68 hover:text-[#EBCF8F]'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            ) : wardrobeSource === 'studio' && studioProducts.length >= 2 ? (
              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={handleApplyEntireStudioOutfit}
                  className="cursor-pointer rounded-full border border-[#EBCF8F]/55 bg-[#1C1410] px-3 py-1 text-[10px] font-medium text-[#EBCF8F] transition-colors hover:bg-[#EBCF8F] hover:text-[#1C1410]"
                >
                  Mặc cả bộ đang phối ({studioProducts.length} món)
                </button>
              </div>
            ) : null}
          </div>

          {/* ONLY This Middle 3:4 Garment Grid Scrolls (`flex-1 min-h-0 overflow-y-auto`) */}
          <div
            data-testid="tryon-wardrobe-grid-scroll"
            data-lenis-prevent=""
            className={`min-h-0 flex-1 overflow-y-auto px-4 py-2.5 ${styles.atelierScroll}`}
          >
            {displayedWardrobeProducts.length === 0 ? (
              <div className="flex h-full min-h-[160px] flex-col items-center justify-center rounded-xl border border-dashed border-[#B08A4A]/25 bg-[#16100C]/70 px-4 py-6 text-center">
                <p className="text-xs text-[#FBF7EF]/72">
                  {wardrobeSource === 'cart'
                    ? 'Giỏ hàng hiện chưa có thiết kế nào.'
                    : 'Chưa có bộ phối nào được lưu từ Phòng Phối Đồ.'}
                </p>
                <button
                  type="button"
                  onClick={() => setWardrobeSource('catalog')}
                  className="mt-2.5 cursor-pointer rounded-full border border-[#EBCF8F]/55 px-3.5 py-1 text-[10px] tracking-[0.14em] uppercase text-[#EBCF8F] transition-colors hover:bg-[#EBCF8F] hover:text-[#1C1410]"
                >
                  Mở Tủ Đồ Atelier
                </button>
              </div>
            ) : (
              <div className={styles.wardrobeGrid}>
                {displayedWardrobeProducts.map((product) => {
                  const isWorn = activeProductIds.has(product.id);
                  const thumbUrl =
                    product.variants[0]?.rackFrontUrl ||
                    product.variants[0]?.tryonFlatPreviewUrl ||
                    getPrimaryVariantImage(product, 0).flatUrl;
                  const fitBadge =
                    FIT_BADGE_LABELS[product.fitType] ?? 'REGULAR';

                  return (
                    <button
                      key={product.id}
                      type="button"
                      data-testid={`wardrobe-card-${product.slug}`}
                      aria-pressed={isWorn}
                      onClick={() => handleWearProduct(product)}
                      className={`group flex cursor-pointer flex-col overflow-hidden rounded-xl border text-left transition-all ${
                        isWorn
                          ? 'border-[#EBCF8F] bg-[#2D211A] ring-1 ring-[#EBCF8F]/75'
                          : 'border-[#B08A4A]/25 bg-[#17110E] hover:border-[#EBCF8F]/70'
                      }`}
                    >
                      <div className="relative aspect-[3/4] w-full overflow-hidden bg-[#F5EFE4]/95 p-1.5">
                        <img
                          src={thumbUrl}
                          alt={product.name}
                          loading="lazy"
                          className="h-full w-full object-contain transition-transform duration-300 group-hover:scale-[1.04]"
                        />
                        <span className="absolute top-1 left-1 rounded bg-[#1C1410]/82 px-1.5 py-0.5 text-[8px] font-medium tracking-[0.1em] text-[#EBCF8F]">
                          {fitBadge}
                        </span>
                        {isWorn ? (
                          <span className="absolute top-1 right-1 flex h-4 w-4 items-center justify-center rounded-full bg-[#EBCF8F] text-[9px] font-bold text-[#1C1410]">
                            ✓
                          </span>
                        ) : null}
                      </div>
                      <div className="p-1.5">
                        <p className="truncate text-[10.5px] font-medium text-[#FBF7EF]">
                          {product.name}
                        </p>
                        <p className="font-mono text-[9.5px] text-[#EBCF8F]">
                          {FORMAT_VND(product.minPriceVnd)}
                        </p>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Compact Variant & Size Panel (Pinned directly above Sticky CTA) */}
          {focusedProduct ? (
            <div className="relative shrink-0 space-y-2 border-t border-[#B08A4A]/22 bg-[#231914] px-4 py-2.5">
              {/* Inline Measurement Editor Popover (never pushes Buy CTA off-screen) */}
              {showMeasureEditor ? (
                <div
                  data-testid="tryon-measurements-popover"
                  className="absolute right-3 bottom-full left-3 z-30 mb-2 rounded-2xl border border-[#EBCF8F]/45 bg-[#1B130F]/98 p-3.5 shadow-[0_24px_60px_-14px_rgba(0,0,0,0.9)] backdrop-blur-xl"
                >
                  <div className="mb-2 flex items-center justify-between">
                    <p className="text-[10px] font-medium tracking-[0.18em] uppercase text-[#EBCF8F]">
                      ✦ Tính chuẩn Size trong 5 giây
                    </p>
                    <button
                      type="button"
                      onClick={() => setShowMeasureEditor(false)}
                      className="cursor-pointer text-xs text-[#FBF7EF]/70 hover:text-[#EBCF8F]"
                    >
                      ✕ Đóng
                    </button>
                  </div>

                  <div className="grid grid-cols-2 gap-2.5 text-[11px]">
                    <label className="block">
                      <span className="flex justify-between text-[10px] text-[#FBF7EF]/75">
                        <span>Chiều cao</span>
                        <strong className="font-mono text-[#EBCF8F]">
                          {editHeightCm}cm
                        </strong>
                      </span>
                      <input
                        type="range"
                        data-testid="tryon-height-slider"
                        min={145}
                        max={190}
                        value={editHeightCm}
                        onChange={(e) => setEditHeightCm(Number(e.target.value))}
                        className={`mt-1 w-full ${styles.rangeGold}`}
                      />
                    </label>
                    <label className="block">
                      <span className="flex justify-between text-[10px] text-[#FBF7EF]/75">
                        <span>Cân nặng</span>
                        <strong className="font-mono text-[#EBCF8F]">
                          {editWeightKg}kg
                        </strong>
                      </span>
                      <input
                        type="range"
                        data-testid="tryon-weight-slider"
                        min={40}
                        max={95}
                        value={editWeightKg}
                        onChange={(e) => setEditWeightKg(Number(e.target.value))}
                        className={`mt-1 w-full ${styles.rangeGold}`}
                      />
                    </label>
                  </div>

                  <div className="mt-2">
                    <button
                      type="button"
                      onClick={() => setEditShowOptional3((prev) => !prev)}
                      className="cursor-pointer text-[10px] text-[#EBCF8F]/85 underline underline-offset-2 hover:text-[#EBCF8F]"
                    >
                      {editShowOptional3
                        ? 'Ẩn số đo 3 vòng tùy chọn'
                        : '+ Thêm số đo 3 vòng Ngực · Eo · Hông (tùy chọn)'}
                    </button>

                    {editShowOptional3 ? (
                      <div className="mt-1.5 grid grid-cols-3 gap-2 text-[10px]">
                        <label className="block">
                          <span className="text-[#FBF7EF]/70">Ngực (cm)</span>
                          <input
                            type="number"
                            min={60}
                            max={150}
                            placeholder="Ước tính"
                            value={editBustCm}
                            onChange={(e) => setEditBustCm(e.target.value)}
                            className="mt-0.5 w-full rounded-lg border border-[#B08A4A]/35 bg-[#140E0B] px-2 py-1 font-mono text-xs text-[#FBF7EF] outline-none focus:border-[#EBCF8F]"
                          />
                        </label>
                        <label className="block">
                          <span className="text-[#FBF7EF]/70">Eo (cm)</span>
                          <input
                            type="number"
                            min={45}
                            max={140}
                            placeholder="Ước tính"
                            value={editWaistCm}
                            onChange={(e) => setEditWaistCm(e.target.value)}
                            className="mt-0.5 w-full rounded-lg border border-[#B08A4A]/35 bg-[#140E0B] px-2 py-1 font-mono text-xs text-[#FBF7EF] outline-none focus:border-[#EBCF8F]"
                          />
                        </label>
                        <label className="block">
                          <span className="text-[#FBF7EF]/70">Hông (cm)</span>
                          <input
                            type="number"
                            min={65}
                            max={160}
                            placeholder="Ước tính"
                            value={editHipCm}
                            onChange={(e) => setEditHipCm(e.target.value)}
                            className="mt-0.5 w-full rounded-lg border border-[#B08A4A]/35 bg-[#140E0B] px-2 py-1 font-mono text-xs text-[#FBF7EF] outline-none focus:border-[#EBCF8F]"
                          />
                        </label>
                      </div>
                    ) : null}
                  </div>

                  <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2">
                    <div className="flex gap-1">
                      {BODY_FIT_PREFERENCE_OPTIONS.map((opt) => (
                        <button
                          key={opt.value}
                          type="button"
                          onClick={() => setEditFitPref(opt.value)}
                          className={`cursor-pointer rounded-full border px-2.5 py-0.5 text-[10px] ${
                            editFitPref === opt.value
                              ? 'border-[#EBCF8F] bg-[#EBCF8F] text-[#1C1410]'
                              : 'border-[#B08A4A]/30 text-[#FBF7EF]/75'
                          }`}
                        >
                          {opt.label}
                        </button>
                      ))}
                    </div>
                    <button
                      type="button"
                      data-testid="tryon-apply-measurements-btn"
                      disabled={sizeRecLoading}
                      onClick={() => void handleSaveMeasurementsInline()}
                      className="cursor-pointer rounded-full bg-[#EBCF8F] px-3.5 py-1 text-[10px] font-semibold text-[#1C1410] hover:brightness-105 disabled:opacity-50"
                    >
                      {sizeRecLoading ? 'Đang tính...' : 'Tính & Lưu Size'}
                    </button>
                  </div>
                </div>
              ) : null}

              {/* Floating 4-Zone <AnatomicalFitVisualizer /> Popover (never pushes Buy CTA off-screen) */}
              {!showMeasureEditor &&
              showFitVisualizer &&
              bodyProfile &&
              sizeRecommendation ? (
                <div
                  data-testid="tryon-fit-visualizer-popover"
                  className="absolute right-3 bottom-full left-3 z-30 mb-2 max-h-[min(560px,70vh)] overflow-y-auto rounded-2xl border border-[#EBCF8F]/45 bg-[#16100C]/98 p-2.5 shadow-[0_24px_60px_-14px_rgba(0,0,0,0.92)] backdrop-blur-xl"
                >
                  <div className="mb-1.5 flex items-center justify-between px-1">
                    <span className="text-[10px] font-medium tracking-[0.14em] uppercase text-[#EBCF8F]">
                      {focusedProduct.name} · {bodyProfile.heightCm}cm /{' '}
                      {bodyProfile.weightKg}kg
                    </span>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          setShowFitVisualizer(false);
                          setShowMeasureEditor(true);
                        }}
                        className="cursor-pointer text-[10px] text-[#EBCF8F] underline underline-offset-2"
                      >
                        Đổi số đo
                      </button>
                      <button
                        type="button"
                        onClick={() => setShowFitVisualizer(false)}
                        className="cursor-pointer text-xs text-[#FBF7EF]/70 hover:text-[#EBCF8F]"
                      >
                        ✕
                      </button>
                    </div>
                  </div>
                  <AnatomicalFitVisualizer
                    recommendedSize={recommendedSizeLabel ?? 'M'}
                    selectedSize={
                      isCanonicalSizeCode(selectedSizeCode)
                        ? selectedSizeCode
                        : 'M'
                    }
                    onSelectSize={(nextSize) => setSelectedSizeCode(nextSize)}
                    fitZones={sizeRecommendation.fitZones}
                    allSizesFitZones={sizeRecommendation.allSizesFitZones}
                    availableSizes={availableSizes}
                    estimatedMeasurements={
                      sizeRecommendation.estimatedMeasurements
                    }
                    rationaleVi={sizeRecommendation.rationaleVi}
                    crowdAdjusted={Boolean(sizeRecommendation.crowdAdjusted)}
                    crowdAdjustmentReason={
                      sizeRecommendation.crowdAdjustmentReason ?? null
                    }
                    theme="dark"
                    compact
                  />
                </div>
              ) : null}

              {/* Color Swatches */}
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-[10px] font-medium tracking-[0.14em] uppercase text-[#EBCF8F]">
                  Màu sắc:{' '}
                  <span className="text-[#FBF7EF]">
                    {focusedVariant?.colorName ?? 'Nguyên bản'}
                  </span>
                </p>

                <div className="flex flex-wrap items-center gap-1.5">
                  {focusedProduct.variants.map((variant, idx) => {
                    const active = idx === focusedVariantIdx;
                    return (
                      <button
                        key={variant.id}
                        type="button"
                        data-testid={`tryon-color-swatch-${idx}`}
                        data-color-name={variant.colorName}
                        aria-pressed={active}
                        onClick={() => handleSelectColorSwatch(idx)}
                        className={`inline-flex cursor-pointer items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[10.5px] transition-all ${
                          active
                            ? 'border-[#EBCF8F] bg-[#EBCF8F]/16 text-[#EBCF8F]'
                            : 'border-[#B08A4A]/30 bg-[#17110E] text-[#FBF7EF]/82 hover:border-[#EBCF8F]/65'
                        }`}
                      >
                        <span
                          className="h-3 w-3 rounded-full border border-white/25 shadow-inner"
                          style={{ backgroundColor: variant.colorHex }}
                        />
                        <span>{variant.colorName}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Strictly Ordered Canonical Size Pills (XS · S · M · L · XL) + Inline Size Advisor */}
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div
                  data-testid="tryon-size-list"
                  className="flex flex-wrap items-center gap-1.5"
                >
                  {availableSizes.map((sku) => {
                    const selected = selectedSizeCode === sku.sizeCode;
                    return (
                      <button
                        key={sku.sizeCode}
                        type="button"
                        data-testid={`tryon-size-btn-${sku.sizeCode}`}
                        disabled={!sku.inStock}
                        aria-pressed={selected}
                        onClick={() => setSelectedSizeCode(sku.sizeCode)}
                        className={`min-w-[36px] cursor-pointer rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors ${
                          selected
                            ? 'border-[#EBCF8F] bg-[#EBCF8F] text-[#1C1410]'
                            : !sku.inStock
                              ? 'cursor-not-allowed border-white/10 text-white/30 line-through'
                              : 'border-[#B08A4A]/38 bg-[#17110E] text-[#FBF7EF]/88 hover:border-[#EBCF8F]'
                        }`}
                      >
                        {sku.sizeCode}
                      </button>
                    );
                  })}
                </div>

                <div
                  data-testid="tryon-size-recommendation"
                  className="flex flex-wrap items-center gap-1.5 text-[10.5px] text-[#FBF7EF]/85"
                >
                  {bodyProfile && recommendedSizeLabel ? (
                    <>
                      <span>
                        Cỡ thực tế:{' '}
                        <strong className="text-[#EBCF8F]">
                          Size {recommendedSizeLabel}
                        </strong>
                        {recommendedFitLabel ? ` · ${recommendedFitLabel}` : ''}
                      </span>
                      {sizeRecommendation ? (
                        <button
                          type="button"
                          data-testid="tryon-toggle-fit-visualizer-btn"
                          onClick={() => {
                            setShowMeasureEditor(false);
                            setShowFitVisualizer((prev) => !prev);
                          }}
                          className={`shrink-0 cursor-pointer rounded-full border px-2 py-0.5 text-[10px] font-medium transition-colors ${
                            showFitVisualizer
                              ? 'border-[#EBCF8F] bg-[#EBCF8F] text-[#1C1410]'
                              : 'border-[#EBCF8F]/55 bg-[#2A1E17] text-[#EBCF8F] hover:bg-[#EBCF8F] hover:text-[#1C1410]'
                          }`}
                        >
                          4 vùng phom
                        </button>
                      ) : null}
                      <button
                        type="button"
                        data-testid="tryon-edit-measurements-btn"
                        onClick={() => {
                          setShowFitVisualizer(false);
                          setShowMeasureEditor((prev) => !prev);
                        }}
                        className="shrink-0 cursor-pointer rounded-full border border-[#B08A4A]/45 bg-[#17110E] px-2 py-0.5 text-[10px] font-medium text-[#EBCF8F] transition-colors hover:border-[#EBCF8F] hover:bg-[#2C2018]"
                      >
                        Chỉnh số đo
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      data-testid="tryon-calculate-size-cta"
                      onClick={() => {
                        setShowFitVisualizer(false);
                        setShowMeasureEditor((prev) => !prev);
                      }}
                      className="cursor-pointer rounded-full border border-[#EBCF8F]/65 bg-[#2A1E17] px-3 py-1 text-[10px] font-medium text-[#EBCF8F] transition-colors hover:bg-[#EBCF8F] hover:text-[#1C1410]"
                    >
                      ✦ Tính chuẩn Size của bạn trong 5 giây
                    </button>
                  )}
                </div>
              </div>
            </div>
          ) : null}

          {/* Sticky High-Conversion Try-On Conversion Bar (`flex-shrink: 0`, ALWAYS visible!) */}
          <div
            data-testid="tryon-conversion-bar"
            className="shrink-0 border-t border-[#B08A4A]/32 bg-[#18110D] px-4 py-3"
          >
            <div className="mb-2 flex items-baseline justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate text-[11px] font-medium text-[#FBF7EF]">
                  {tryOnMode === TryOnMode.MIX_MATCH_OUTFIT &&
                  activeGarmentSpecs.length >= 2
                    ? `Bộ phối ${activeGarmentSpecs.length} món · Size ${selectedSizeCode}`
                    : `${focusedProduct?.name ?? 'Thiết kế Atelier'} · ${focusedVariant?.colorName ?? 'Nguyên bản'} · Size ${selectedSizeCode}`}
                </p>
              </div>
              <p
                data-testid="tryon-conversion-price"
                className="font-editorial shrink-0 text-xl font-semibold text-[#EBCF8F]"
              >
                {formattedPrice}
              </p>
            </div>

            <button
              type="button"
              data-testid="tryon-add-to-bag-btn"
              disabled={addingToCart || activeGarmentSpecs.length === 0}
              onClick={() => void handleAddToBag()}
              className={`w-full cursor-pointer rounded-full px-5 py-2.5 text-xs tracking-[0.12em] uppercase disabled:cursor-not-allowed disabled:opacity-50 ${styles.ctaGoldButton}`}
            >
              {ctaLabel}
            </button>

            {cartNotice ? (
              <p
                role="status"
                data-testid="tryon-cart-notice"
                className="mt-1.5 truncate text-center text-[10.5px] text-[#EBCF8F]"
              >
                {cartNotice}
              </p>
            ) : null}
          </div>
        </aside>
      </div>
    </div>
  );

  // Modal renders into top-level `document.body` portal (`z-index: 1200`) for complete z-index isolation
  if (!embedded && mounted && typeof document !== 'undefined') {
    return createPortal(studioShell, document.body);
  }

  return studioShell;
}
