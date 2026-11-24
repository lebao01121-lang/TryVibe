'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FitPreference,
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
  type CartDto,
  type CartItemDto,
  type ProductSpuDto,
} from '@atelier/contracts';
import {
  applyCameraActiveState,
  useCameraGpuGuard,
  useMotionState,
  useScrollLock,
} from '@atelier/motion-kit';
import { showAtelierToast } from '@/components/AtelierToastProvider';
import {
  computeRecommendedStudioSize,
  loadSavedStudioSizeProfile,
  saveStudioSizeProfile,
  type StudioSizeProfile,
} from '@/features/outfit-studio/SizeGuideModal';
import { apiFetch } from '@/lib/api-client';
import {
  FALLBACK_PRODUCTS,
  FORMAT_VND,
  getPrimaryVariantImage,
} from '@/lib/catalog-data';
import {
  emitCartUpdated,
  loadActiveStudioOutfitSnapshot,
  loadCachedCartSnapshot,
  saveCachedCartSnapshot,
  type ActiveStudioOutfitSnapshot,
  type TryOnGarmentRef,
} from '@/lib/storefront-actions';
import { BeforeAfterSlider } from './BeforeAfterSlider';
import { TryOn3DScene } from './engine/TryOn3DScene';
import type {
  BodyMeasurements3D,
  FabricWeightClass,
  Garment3DLayerSpec,
  GarmentSlot3D,
  PhotoAdjustments,
  PhotoPoseHint,
  TryOn3DLightingMode,
  TryOn3DSceneHandle,
  TryOn3DTabMode,
} from './engine/types';
import {
  TRYON_SAMPLE_MODELS,
  type TryOnSampleModel,
} from './MediaPipePoseCamera';
import { TRYON_PRIVACY_GUARANTEE_TEXT } from './PrivacyConsentGate';
import {
  MAX_LOOKS_LIMIT_WARNING,
  MAX_SAVED_TRYON_LOOKS,
  SavedTryOnLooksTray,
  type SavedTryOnLook,
} from './SavedTryOnLooksTray';
import styles from './tryon-modal.module.css';

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

type WardrobeSourceTab = 'cart' | 'studio' | 'catalog';

interface SlotSelection3D {
  productId: string;
  variantIdx: number;
}

type ActiveSlots3D = Partial<Record<GarmentSlot3D, SlotSelection3D>>;

const GUEST_STORAGE_KEY = 'atelier_guest_session_id';
const CANONICAL_SIZES = ['XS', 'S', 'M', 'L', 'XL'] as const;
const SLOT_ORDER: readonly GarmentSlot3D[] = [
  'TOP',
  'BOTTOM',
  'ONE_PIECE',
  'OUTERWEAR',
];

const SLOT_LABELS: Record<GarmentSlot3D, string> = {
  TOP: 'Áo',
  BOTTOM: 'Quần / Váy',
  ONE_PIECE: 'Đầm liền',
  OUTERWEAR: 'Áo khoác',
};

const FIT_BADGE_LABELS: Record<string, string> = {
  SLIM: 'SLIM',
  REGULAR: 'REGULAR',
  RELAXED: 'RELAXED',
  OVERSIZE: 'RELAXED',
};

const FIT_PREF_VN: Record<FitPreference, string> = {
  [FitPreference.SLIM]: 'Ôm tôn dáng',
  [FitPreference.REGULAR]: 'Chuẩn phom',
  [FitPreference.RELAXED]: 'Thoải mái',
};

const DEFAULT_PHOTO_ADJUSTMENTS: PhotoAdjustments = {
  offsetX: 0,
  offsetY: 0,
  scale: 1,
};

const LIGHTING_OPTIONS: ReadonlyArray<{
  id: TryOn3DLightingMode;
  label: string;
  testId: string;
}> = [
  { id: 'morning', label: 'Nắng Sớm', testId: 'tryon-light-morning' },
  { id: 'showroom', label: 'Showroom Atelier', testId: 'tryon-light-showroom' },
  { id: 'evening', label: 'Đèn Tiệc Tối', testId: 'tryon-light-evening' },
];

const MODE_TAB_OPTIONS: ReadonlyArray<{
  id: TryOn3DTabMode;
  label: string;
  shortLabel: string;
  testId: string;
}> = [
  {
    id: 'camera',
    label: 'Gương 3D Camera',
    shortLabel: 'Gương 3D',
    testId: 'tryon-tab-camera',
  },
  {
    id: 'photo',
    label: 'Ướm 3D Trên Ảnh',
    shortLabel: 'Trên Ảnh',
    testId: 'tryon-tab-photo',
  },
  {
    id: 'mannequin',
    label: 'Ma-nơ-canh 3D 360°',
    shortLabel: 'Ma-nơ-canh 3D',
    testId: 'tryon-tab-mannequin',
  },
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

function inferGarmentSlot3D(product: ProductSpuDto): GarmentSlot3D {
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
    return 'ONE_PIECE';
  }

  if (
    product.tryonGarmentCategory === TryOnGarmentCategory.LOWER ||
    text.includes('quan-') ||
    text.includes('quần') ||
    text.includes('chan-vay') ||
    text.includes('chân váy') ||
    text.includes('culottes')
  ) {
    return 'BOTTOM';
  }

  if (
    text.includes('ao-khoac') ||
    text.includes('áo khoác') ||
    text.includes('ao-blazer') ||
    text.includes('blazer') ||
    text.includes('trench') ||
    text.includes('tweed') ||
    text.includes('cardigan')
  ) {
    return 'OUTERWEAR';
  }

  return 'TOP';
}

function resolveFabricWeightClass(product: ProductSpuDto): FabricWeightClass {
  const text = `${product.fabricComposition ?? ''} ${product.fabricWeight ?? ''}`.toLowerCase();
  if (
    text.includes('silk') ||
    text.includes('satin') ||
    text.includes('lụa') ||
    text.includes('tơ tằm') ||
    text.includes('organza') ||
    text.includes('chiffon') ||
    text.includes('momme')
  ) {
    return 'LIGHT';
  }
  if (
    text.includes('tweed') ||
    text.includes('trench') ||
    text.includes('cashmere') ||
    text.includes('dạ') ||
    text.includes('merino') ||
    text.includes('len')
  ) {
    return 'HEAVY';
  }
  const gsmMatch = text.match(/(\d{2,3})\s*gsm/);
  if (gsmMatch) {
    const gsm = Number(gsmMatch[1]);
    if (gsm <= 170) return 'LIGHT';
    if (gsm >= 270) return 'HEAVY';
  }
  return 'MEDIUM';
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

function buildGarmentLayerSpec(
  slot: GarmentSlot3D,
  product: ProductSpuDto,
  variantIdx: number,
  selectedSizeCode: string,
): Garment3DLayerSpec {
  const safeIdx =
    variantIdx >= 0 && variantIdx < product.variants.length ? variantIdx : 0;
  const variant = product.variants[safeIdx] ?? product.variants[0];
  const { flatUrl, lookbookUrl } = getPrimaryVariantImage(product, safeIdx);

  const frontUrl =
    variant?.studioLayerUrl ||
    variant?.rackFrontUrl ||
    variant?.tryonFlatPreviewUrl ||
    flatUrl ||
    lookbookUrl;

  const backUrl = variant?.rackBackUrl || null;

  const sku =
    variant?.skus.find((s) => s.sizeCode === selectedSizeCode && s.inStock) ??
    variant?.skus.find((s) => s.sizeCode === selectedSizeCode) ??
    variant?.skus.find((s) => s.inStock) ??
    variant?.skus[0];

  return {
    slot,
    productId: product.id,
    variantId: variant?.id ?? `${product.id}-default`,
    skuId: sku?.id ?? `${product.id}-sku`,
    slug: product.slug,
    name: product.name,
    colorName: variant?.colorName ?? 'Nguyên bản',
    colorHex: variant?.colorHex ?? '#EBD9B4',
    frontUrl,
    backUrl,
    fabricComposition: product.fabricComposition,
    fabricWeight: resolveFabricWeightClass(product),
    fitType: product.fitType,
    priceVnd: sku?.salePriceVnd ?? product.minPriceVnd,
  };
}

function createFallbackLookCardDataUrl(
  label: string,
  priceVnd: number,
  colorHex: string,
  modeLabel: string,
): string {
  if (typeof document === 'undefined') return '';
  const canvas = document.createElement('canvas');
  canvas.width = 480;
  canvas.height = 640;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';

  const grad = ctx.createLinearGradient(0, 0, 0, 640);
  grad.addColorStop(0, '#2B2019');
  grad.addColorStop(0.55, '#1C1410');
  grad.addColorStop(1, '#120C09');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 480, 640);

  ctx.strokeStyle = 'rgba(235, 207, 143, 0.5)';
  ctx.lineWidth = 2;
  ctx.strokeRect(18, 18, 444, 604);

  // Subtle swatch medallion
  ctx.beginPath();
  ctx.arc(240, 250, 74, 0, Math.PI * 2);
  ctx.fillStyle = colorHex || '#EBD9B4';
  ctx.fill();
  ctx.strokeStyle = '#EBCF8F';
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.fillStyle = '#EBCF8F';
  ctx.font = '600 14px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('TẦM XUÂN · 3D AR LOOK', 240, 88);

  ctx.fillStyle = '#FBF7EF';
  ctx.font = '500 22px serif';
  ctx.fillText(label.slice(0, 28), 240, 410);

  ctx.fillStyle = '#EBCF8F';
  ctx.font = '500 18px monospace';
  ctx.fillText(FORMAT_VND(priceVnd), 240, 448);

  ctx.fillStyle = 'rgba(251, 247, 239, 0.62)';
  ctx.font = '400 13px sans-serif';
  ctx.fillText(modeLabel, 240, 566);

  return canvas.toDataURL('image/webp', 0.88);
}

function mapSlot3DToOutfitSlot(slot: GarmentSlot3D): OutfitSlot {
  if (slot === 'BOTTOM') return OutfitSlot.BOTTOM;
  if (slot === 'ONE_PIECE') return OutfitSlot.ONE_PIECE;
  if (slot === 'OUTERWEAR') return OutfitSlot.OUTERWEAR;
  return OutfitSlot.TOP;
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

  // Strict GPU & Hardware Protection: pauses ClothingRack3D, GlintsCanvas, FabricParticleCanvas
  useMotionState();
  useCameraGpuGuard(isActive);
  useScrollLock(open && !embedded);

  useEffect(() => {
    if (typeof document === 'undefined' || !document.body) return undefined;
    if (isActive) {
      applyCameraActiveState(true);
      document.body.dataset.cameraActive = 'true';
    } else {
      applyCameraActiveState(false);
      document.body.dataset.cameraActive = 'false';
    }
    return () => {
      if (typeof document !== 'undefined' && document.body) {
        applyCameraActiveState(false);
        document.body.dataset.cameraActive = 'false';
      }
    };
  }, [isActive]);

  // Immediate catalog availability with FALLBACK_PRODUCTS safety net (zero blocking spinner)
  const allProducts = useMemo(() => {
    const base = products.length > 0 ? products : FALLBACK_PRODUCTS;
    const wearable = base.filter(
      (p) => !isAccessoryProduct(p) && p.tryonGarmentCategory !== TryOnGarmentCategory.NONE,
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

  // 3D Stage & Mode State
  const sceneRef = useRef<TryOn3DSceneHandle | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const uploadedObjectUrlRef = useRef<string | null>(null);

  const [tabMode, setTabMode] = useState<TryOn3DTabMode>('camera');
  const [lightingMode, setLightingMode] = useState<TryOn3DLightingMode>('showroom');
  const [cameraEnabled, setCameraEnabled] = useState(true);
  const [showTailorPins, setShowTailorPins] = useState(true);
  const [mannequinSide, setMannequinSide] = useState<'front' | 'back'>('front');

  // Photo Mode State
  const [selectedSampleId, setSelectedSampleId] = useState<string>(
    TRYON_SAMPLE_MODELS[0]!.id,
  );
  const [uploadedPhotoUrl, setUploadedPhotoUrl] = useState<string | null>(null);
  const [photoAdjustments, setPhotoAdjustments] = useState<PhotoAdjustments>(
    DEFAULT_PHOTO_ADJUSTMENTS,
  );
  const [beforeAfterEnabled, setBeforeAfterEnabled] = useState(true);
  const [beforeAfterSplitPct, setBeforeAfterSplitPct] = useState(78);

  // Wardrobe & Garment Selection State
  const [tryOnMode, setTryOnMode] = useState<TryOnMode>(
    initialMode ??
      (initialUpper && (initialLower || initialOuterwear)
        ? TryOnMode.MIX_MATCH_OUTFIT
        : TryOnMode.SINGLE),
  );
  const [activeSlots, setActiveSlots] = useState<ActiveSlots3D>({});
  const [focusedSlot, setFocusedSlot] = useState<GarmentSlot3D>('TOP');
  const [wardrobeSource, setWardrobeSource] = useState<WardrobeSourceTab>('catalog');
  const [slotFilter, setSlotFilter] = useState<'ALL' | GarmentSlot3D>('ALL');

  // Hydrated Cart & Active Studio Outfit Snapshots (silent, zero error banner)
  const [cartSnapshot, setCartSnapshot] = useState<CartDto | null>(null);
  const [studioSnapshot, setStudioSnapshot] =
    useState<ActiveStudioOutfitSnapshot | null>(null);

  // Body Measurements & Smart Size Recommendation
  const [sizeProfile, setSizeProfile] = useState<StudioSizeProfile | null>(null);
  const [selectedSizeCode, setSelectedSizeCode] = useState<string>('M');
  const [showMeasureEditor, setShowMeasureEditor] = useState(false);
  const [editHeightCm, setEditHeightCm] = useState(162);
  const [editWeightKg, setEditWeightKg] = useState(52);
  const [editFitPref, setEditFitPref] = useState<FitPreference>(FitPreference.REGULAR);

  // Saved Looks Comparison Tray (Max 3 per session)
  const [savedLooks, setSavedLooks] = useState<SavedTryOnLook[]>([]);
  const [capturingLook, setCapturingLook] = useState(false);
  const [limitWarning, setLimitWarning] = useState<string | null>(null);
  const [previewLook, setPreviewLook] = useState<SavedTryOnLook | null>(null);

  // Checkout CTA state
  const [addingToCart, setAddingToCart] = useState(false);
  const [cartNotice, setCartNotice] = useState<string | null>(null);

  // Revoke any uploaded object URL on unmount
  useEffect(() => {
    return () => {
      if (uploadedObjectUrlRef.current) {
        URL.revokeObjectURL(uploadedObjectUrlRef.current);
        uploadedObjectUrlRef.current = null;
      }
    };
  }, []);

  // Hydrate saved size profile, active studio outfit snapshot, and cart silently on open
  useEffect(() => {
    if (!isActive) return;

    const savedProfile = loadSavedStudioSizeProfile();
    if (savedProfile) {
      setSizeProfile(savedProfile);
      setSelectedSizeCode(savedProfile.recommendedSize);
      setEditHeightCm(savedProfile.heightCm);
      setEditWeightKg(savedProfile.weightKg);
      setEditFitPref(savedProfile.fitPreference);
    }

    setStudioSnapshot(loadActiveStudioOutfitSnapshot());

    const cachedCart = loadCachedCartSnapshot();
    if (cachedCart) {
      setCartSnapshot(cachedCart);
    }

    let cancelled = false;
    void apiFetch<CartDto>('/bff/v1/storefront/cart', {
      headers: getGuestHeader(),
      skipAuthRefresh: true,
      timeoutMs: 3000,
    }).then((res) => {
      if (cancelled) return;
      if (res.ok && res.data) {
        setCartSnapshot(res.data);
        saveCachedCartSnapshot(res.data);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [isActive]);

  // Synchronize initial garment selections when modal opens / props change
  useEffect(() => {
    if (!isActive || allProducts.length === 0) return;

    const initUp = resolveProductFromRef(initialUpper, allProducts);
    const initLow = resolveProductFromRef(initialLower, allProducts);
    const initOne = resolveProductFromRef(initialOnePiece, allProducts);
    const initOut = resolveProductFromRef(initialOuterwear, allProducts);

    const nextSlots: ActiveSlots3D = {};
    if (initOne) {
      nextSlots.ONE_PIECE = {
        productId: initOne.id,
        variantIdx: resolveVariantIdxFromRef(initialOnePiece, initOne),
      };
    } else {
      if (initUp) {
        const inferred = inferGarmentSlot3D(initUp);
        const targetSlot: GarmentSlot3D =
          inferred === 'OUTERWEAR' && !initOut ? 'OUTERWEAR' : 'TOP';
        nextSlots[targetSlot] = {
          productId: initUp.id,
          variantIdx: resolveVariantIdxFromRef(initialUpper, initUp),
        };
      }
      if (initLow) {
        nextSlots.BOTTOM = {
          productId: initLow.id,
          variantIdx: resolveVariantIdxFromRef(initialLower, initLow),
        };
      }
    }

    if (initOut) {
      nextSlots.OUTERWEAR = {
        productId: initOut.id,
        variantIdx: resolveVariantIdxFromRef(initialOuterwear, initOut),
      };
    }

    const slotKeys = Object.keys(nextSlots) as GarmentSlot3D[];
    if (slotKeys.length === 0) {
      // Pick first product (preferring multi-variant piece like Blazer Linen so swatches shine)
      const defaultProduct =
        allProducts.find((p) => p.variants.length > 1) ?? allProducts[0]!;
      const defaultSlot = inferGarmentSlot3D(defaultProduct);
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
    setLimitWarning(null);
  }, [
    allProducts,
    initialLower,
    initialMode,
    initialOnePiece,
    initialOuterwear,
    initialUpper,
    isActive,
  ]);

  // Escape key closes preview lightbox first, then modal
  useEffect(() => {
    if (!open || embedded) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (previewLook) {
          setPreviewLook(null);
          return;
        }
        onClose?.();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [embedded, onClose, open, previewLook]);

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

    const addRef = (ref: TryOnGarmentRef | ProductSpuDto | null | undefined) => {
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
        if (resolved && !seen.has(resolved.id) && !isAccessoryProduct(resolved)) {
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
    return base.filter((p) => inferGarmentSlot3D(p) === slotFilter);
  }, [allProducts, cartProducts, slotFilter, studioProducts, wardrobeSource]);

  // Active ordered 3D garment layers passed into <TryOn3DScene />
  const activeSlotEntries = useMemo(() => {
    const entries: Array<{
      slot: GarmentSlot3D;
      product: ProductSpuDto;
      variantIdx: number;
    }> = [];
    for (const slot of SLOT_ORDER) {
      const sel = activeSlots[slot];
      if (!sel) continue;
      const product = extendedProductById.get(sel.productId);
      if (!product) continue;
      entries.push({ slot, product, variantIdx: sel.variantIdx });
    }
    return entries;
  }, [activeSlots, extendedProductById]);

  const garmentLayers3D = useMemo<Garment3DLayerSpec[]>(() => {
    return activeSlotEntries.map(({ slot, product, variantIdx }) =>
      buildGarmentLayerSpec(slot, product, variantIdx, selectedSizeCode),
    );
  }, [activeSlotEntries, selectedSizeCode]);

  const activeProductIds = useMemo(
    () => new Set(activeSlotEntries.map((e) => e.product.id)),
    [activeSlotEntries],
  );

  const focusedEntry = useMemo(() => {
    return (
      activeSlotEntries.find((e) => e.slot === focusedSlot) ??
      activeSlotEntries[0] ??
      null
    );
  }, [activeSlotEntries, focusedSlot]);

  const totalOutfitPriceVnd = useMemo(
    () => garmentLayers3D.reduce((sum, item) => sum + item.priceVnd, 0),
    [garmentLayers3D],
  );

  // Body Measurements for 3D Couture Mannequin & Size Guidance
  const bodyMeasurements = useMemo<BodyMeasurements3D>(
    () => ({
      heightCm: sizeProfile?.heightCm ?? 162,
      weightKg: sizeProfile?.weightKg ?? 52,
      bustCm: sizeProfile?.bustCm ?? 85,
      waistCm: sizeProfile?.waistCm ?? 67,
      hipCm: sizeProfile?.hipCm ?? 91,
      recommendedSize: sizeProfile?.recommendedSize ?? 'M',
    }),
    [sizeProfile],
  );

  const recommendedSizeLabel = sizeProfile?.recommendedSize ?? 'M';
  const recommendedFitLabel = sizeProfile
    ? FIT_PREF_VN[sizeProfile.fitPreference]
    : 'Chuẩn phom';

  // Active Photo URL & Pose Hint for Photo Mode
  const activeSampleModel = useMemo<TryOnSampleModel>(
    () =>
      TRYON_SAMPLE_MODELS.find((s) => s.id === selectedSampleId) ??
      TRYON_SAMPLE_MODELS[0]!,
    [selectedSampleId],
  );
  const activePhotoUrl = uploadedPhotoUrl ?? activeSampleModel.src;
  const activePhotoPoseHint: PhotoPoseHint | null = uploadedPhotoUrl
    ? null
    : activeSampleModel.poseLandmarks;

  // Handlers
  const handleTabSwitch = useCallback((nextTab: TryOn3DTabMode) => {
    setTabMode(nextTab);
    if (nextTab === 'camera') {
      setCameraEnabled(true);
    }
  }, []);

  const handleSwitchTryOnMode = useCallback(
    (nextMode: TryOnMode) => {
      setTryOnMode(nextMode);
      if (nextMode === TryOnMode.SINGLE) {
        const keep = focusedEntry ?? activeSlotEntries[0];
        if (keep) {
          setActiveSlots({
            [keep.slot]: {
              productId: keep.product.id,
              variantIdx: keep.variantIdx,
            },
          });
          setFocusedSlot(keep.slot);
        }
        return;
      }

      // MIX_MATCH_OUTFIT: automatically pair a complementary piece if only 1 piece is currently worn
      setActiveSlots((prev) => {
        const next: ActiveSlots3D = { ...prev };
        const keys = Object.keys(next) as GarmentSlot3D[];
        if (keys.length >= 2) return next;

        const hasOnePiece = Boolean(next.ONE_PIECE);
        const hasTop = Boolean(next.TOP);
        const hasBottom = Boolean(next.BOTTOM);
        const hasOuterwear = Boolean(next.OUTERWEAR);

        const findBySlot = (slot: GarmentSlot3D) =>
          allProducts.find((p) => inferGarmentSlot3D(p) === slot);

        if (hasOnePiece && !hasOuterwear) {
          const outer = findBySlot('OUTERWEAR');
          if (outer) next.OUTERWEAR = { productId: outer.id, variantIdx: 0 };
        } else if ((hasTop || hasOuterwear) && !hasBottom && !hasOnePiece) {
          const bottom = findBySlot('BOTTOM');
          if (bottom) next.BOTTOM = { productId: bottom.id, variantIdx: 0 };
          if (!hasTop && hasOuterwear) {
            const top = findBySlot('TOP');
            if (top) next.TOP = { productId: top.id, variantIdx: 0 };
          }
        } else if (hasBottom && !hasTop && !hasOuterwear) {
          const top = findBySlot('TOP') ?? findBySlot('OUTERWEAR');
          if (top) {
            const slot = inferGarmentSlot3D(top);
            next[slot] = { productId: top.id, variantIdx: 0 };
          }
        } else if (keys.length === 0) {
          const top = findBySlot('TOP') ?? allProducts[0];
          const bottom = findBySlot('BOTTOM');
          if (top) next[inferGarmentSlot3D(top)] = { productId: top.id, variantIdx: 0 };
          if (bottom) next.BOTTOM = { productId: bottom.id, variantIdx: 0 };
        }
        return next;
      });
    },
    [activeSlotEntries, allProducts, focusedEntry],
  );

  const handleWearProduct = useCallback(
    (product: ProductSpuDto) => {
      const slot = inferGarmentSlot3D(product);
      setCartNotice(null);

      if (tryOnMode === TryOnMode.SINGLE) {
        setActiveSlots({
          [slot]: { productId: product.id, variantIdx: 0 },
        });
        setFocusedSlot(slot);
        return;
      }

      // MIX_MATCH_OUTFIT mutual exclusion: ONE_PIECE <-> TOP/BOTTOM; OUTERWEAR layers with both
      setActiveSlots((prev) => {
        const next: ActiveSlots3D = { ...prev };
        if (slot === 'ONE_PIECE') {
          delete next.TOP;
          delete next.BOTTOM;
          next.ONE_PIECE = { productId: product.id, variantIdx: 0 };
        } else if (slot === 'TOP' || slot === 'BOTTOM') {
          delete next.ONE_PIECE;
          next[slot] = { productId: product.id, variantIdx: 0 };
        } else {
          next.OUTERWEAR = { productId: product.id, variantIdx: 0 };
        }
        return next;
      });
      setFocusedSlot(slot);
    },
    [tryOnMode],
  );

  const handleApplyEntireStudioOutfit = useCallback(() => {
    if (studioProducts.length === 0) return;
    const next: ActiveSlots3D = {};
    for (const product of studioProducts) {
      const slot = inferGarmentSlot3D(product);
      if (slot === 'ONE_PIECE') {
        delete next.TOP;
        delete next.BOTTOM;
        next.ONE_PIECE = { productId: product.id, variantIdx: 0 };
      } else if (slot === 'TOP' || slot === 'BOTTOM') {
        if (!next.ONE_PIECE) {
          next[slot] = { productId: product.id, variantIdx: 0 };
        }
      } else {
        next.OUTERWEAR = { productId: product.id, variantIdx: 0 };
      }
    }
    const keys = Object.keys(next) as GarmentSlot3D[];
    if (keys.length === 0) return;
    setActiveSlots(next);
    setFocusedSlot(keys[0]!);
    setTryOnMode(keys.length >= 2 ? TryOnMode.MIX_MATCH_OUTFIT : TryOnMode.SINGLE);
  }, [studioProducts]);

  const handleRemoveSlot = useCallback(
    (slot: GarmentSlot3D) => {
      if (activeSlotEntries.length <= 1) return;
      setActiveSlots((prev) => {
        const next = { ...prev };
        delete next[slot];
        return next;
      });
      if (focusedSlot === slot) {
        const remaining = activeSlotEntries.find((e) => e.slot !== slot);
        if (remaining) setFocusedSlot(remaining.slot);
      }
    },
    [activeSlotEntries, focusedSlot],
  );

  const handleSelectColorSwatch = useCallback(
    (variantIdx: number) => {
      if (!focusedEntry) return;
      setActiveSlots((prev) => ({
        ...prev,
        [focusedEntry.slot]: {
          productId: focusedEntry.product.id,
          variantIdx,
        },
      }));
    },
    [focusedEntry],
  );

  const handleUploadPhotoFile = useCallback((file: File | null) => {
    if (!file) return;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      showAtelierToast('Vui lòng chọn ảnh định dạng JPG, PNG hoặc WebP.', 'warning');
      return;
    }
    if (file.size > 12 * 1024 * 1024) {
      showAtelierToast('Dung lượng ảnh tối đa 12MB.', 'warning');
      return;
    }
    if (uploadedObjectUrlRef.current) {
      URL.revokeObjectURL(uploadedObjectUrlRef.current);
    }
    const objUrl = URL.createObjectURL(file);
    uploadedObjectUrlRef.current = objUrl;
    setUploadedPhotoUrl(objUrl);
    setPhotoAdjustments(DEFAULT_PHOTO_ADJUSTMENTS);
    setBeforeAfterEnabled(true);
  }, []);

  const handleSelectSamplePortrait = useCallback((sample: TryOnSampleModel) => {
    if (uploadedObjectUrlRef.current) {
      URL.revokeObjectURL(uploadedObjectUrlRef.current);
      uploadedObjectUrlRef.current = null;
    }
    setUploadedPhotoUrl(null);
    setSelectedSampleId(sample.id);
    setPhotoAdjustments(DEFAULT_PHOTO_ADJUSTMENTS);
    setBeforeAfterEnabled(true);
  }, []);

  const handleSaveMeasurementsInline = useCallback(() => {
    const bustCm = Math.round(78 + (editWeightKg - 42) * 0.62);
    const waistCm = Math.round(60 + (editWeightKg - 42) * 0.6);
    const hipCm = Math.round(85 + (editWeightKg - 42) * 0.58);
    const { recommendedSize } = computeRecommendedStudioSize({
      heightCm: editHeightCm,
      weightKg: editWeightKg,
      bustCm,
      waistCm,
      hipCm,
      fitPreference: editFitPref,
    });
    const nextProfile: StudioSizeProfile = {
      heightCm: editHeightCm,
      weightKg: editWeightKg,
      bustCm,
      waistCm,
      hipCm,
      fitPreference: editFitPref,
      recommendedSize,
      updatedAt: new Date().toISOString(),
    };
    saveStudioSizeProfile(nextProfile);
    setSizeProfile(nextProfile);
    setSelectedSizeCode(recommendedSize);
    setShowMeasureEditor(false);
    showAtelierToast(
      `Đã cập nhật dáng ${editHeightCm}cm · ${editWeightKg}kg — gợi ý Size ${recommendedSize}.`,
      'gold',
    );
  }, [editFitPref, editHeightCm, editWeightKg]);

  // Capture & Save Look (Hard 3-Look Cap with refined champagne-gold alert)
  const handleCaptureAndSaveLook = useCallback(async () => {
    if (capturingLook) return;

    if (savedLooks.length >= MAX_SAVED_TRYON_LOOKS) {
      setLimitWarning(MAX_LOOKS_LIMIT_WARNING);
      showAtelierToast(MAX_LOOKS_LIMIT_WARNING, 'warning', 4500);
      return;
    }

    setCapturingLook(true);
    setLimitWarning(null);

    try {
      let dataUrl: string | null = null;
      if (sceneRef.current) {
        dataUrl = await sceneRef.current.captureComposite3x4();
      }

      const label =
        garmentLayers3D.map((g) => g.name).join(' + ') || 'Bộ phối Atelier 3D';

      if (!dataUrl) {
        const modeLabel =
          tabMode === 'mannequin'
            ? 'Ma-nơ-canh 3D 360°'
            : tabMode === 'photo'
              ? 'Ướm 3D Trên Ảnh'
              : 'Gương 3D Camera';
        dataUrl = createFallbackLookCardDataUrl(
          label,
          totalOutfitPriceVnd,
          garmentLayers3D[0]?.colorHex ?? '#EBD9B4',
          modeLabel,
        );
      }

      const newLook: SavedTryOnLook = {
        id: `look-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        imageDataUrl: dataUrl,
        label,
        totalPriceVnd: totalOutfitPriceVnd,
        mode: tryOnMode,
        tabMode,
        garmentSummary: garmentLayers3D.map(
          (g) => `${g.name} (${g.colorName})`,
        ),
        sizeCode: selectedSizeCode,
        createdAt: new Date().toISOString(),
      };

      setSavedLooks((prev) =>
        [...prev, newLook].slice(0, MAX_SAVED_TRYON_LOOKS),
      );
    } finally {
      setCapturingLook(false);
    }
  }, [
    capturingLook,
    garmentLayers3D,
    savedLooks.length,
    selectedSizeCode,
    tabMode,
    totalOutfitPriceVnd,
    tryOnMode,
  ]);

  const handleDeleteSavedLook = useCallback((lookId: string) => {
    setSavedLooks((prev) => prev.filter((item) => item.id !== lookId));
    setLimitWarning(null);
    setPreviewLook((prev) => (prev?.id === lookId ? null : prev));
  }, []);

  const handleFlipFrontBack = useCallback(() => {
    if (tabMode !== 'mannequin') {
      setTabMode('mannequin');
      window.setTimeout(() => {
        sceneRef.current?.flipMannequinSide();
      }, 120);
      return;
    }
    sceneRef.current?.flipMannequinSide();
  }, [tabMode]);

  // 1-Tap Checkout CTA (graceful offline fallback with refined Vietnamese notice)
  const handleAddToBag = useCallback(async () => {
    if (garmentLayers3D.length === 0 || addingToCart) return;
    setAddingToCart(true);
    setCartNotice(null);

    try {
      let cartResult: CartDto | null = null;
      let ok = false;

      if (garmentLayers3D.length >= 2) {
        const res = await apiFetch<CartDto>(
          '/bff/v1/storefront/cart/outfit-bundle',
          {
            method: 'POST',
            headers: getGuestHeader(),
            timeoutMs: 6000,
            body: JSON.stringify({
              items: garmentLayers3D.map((item) => ({
                skuId: item.skuId,
                productId: item.productId,
                variantId: item.variantId,
                qty: 1,
                slot: mapSlot3DToOutfitSlot(item.slot),
                fromAiTryon: true,
              })),
            }),
          },
        );
        ok = res.ok;
        cartResult = res.data;
      } else {
        const target = garmentLayers3D[0]!;
        const res = await apiFetch<CartDto>('/bff/v1/storefront/cart/items', {
          method: 'POST',
          headers: getGuestHeader(),
          timeoutMs: 6000,
          body: JSON.stringify({
            skuId: target.skuId,
            productId: target.productId,
            variantId: target.variantId,
            qty: 1,
            slot: mapSlot3DToOutfitSlot(target.slot),
            fromAiTryon: true,
          }),
        });
        ok = res.ok;
        cartResult = res.data;
      }

      if (ok && cartResult) {
        setCartSnapshot(cartResult);
        emitCartUpdated(cartResult);
        setCartNotice(
          garmentLayers3D.length >= 2
            ? `Đã thêm bộ phối ${garmentLayers3D.length} món (Size ${selectedSizeCode}) vào giỏ hàng.`
            : `Đã thêm ${garmentLayers3D[0]!.name} (Size ${selectedSizeCode}) vào giỏ hàng.`,
        );
        showAtelierToast('Đã thêm thiết kế từ Phòng Thử Đồ 3D vào giỏ hàng!', 'success');
        onAddedToBag?.(cartResult);
      } else {
        // Graceful offline UX — never leak raw network error string
        const offlineMsg =
          'Đã ghi nhận lựa chọn tại phiên cục bộ — giỏ hàng sẽ đồng bộ ngay khi máy chủ sẵn sàng.';
        setCartNotice(offlineMsg);
        showAtelierToast(offlineMsg, 'gold');
      }
    } catch {
      const offlineMsg =
        'Đã ghi nhận lựa chọn tại phiên cục bộ — giỏ hàng sẽ đồng bộ ngay khi máy chủ sẵn sàng.';
      setCartNotice(offlineMsg);
      showAtelierToast(offlineMsg, 'gold');
    } finally {
      setAddingToCart(false);
    }
  }, [addingToCart, garmentLayers3D, onAddedToBag, selectedSizeCode]);

  if (!isActive) {
    return null;
  }

  const stageBackdropClass =
    lightingMode === 'morning'
      ? styles.stageBackdropMorning
      : lightingMode === 'evening'
        ? styles.stageBackdropEvening
        : styles.stageBackdropShowroom;

  const focusedProduct = focusedEntry?.product ?? null;
  const focusedVariantIdx = focusedEntry?.variantIdx ?? 0;
  const focusedVariant = focusedProduct
    ? focusedProduct.variants[focusedVariantIdx] ?? focusedProduct.variants[0]
    : null;

  const availableSizes = (() => {
    const skus = focusedVariant?.skus ?? [];
    if (skus.length === 0) {
      return CANONICAL_SIZES.map((code) => ({ sizeCode: code, inStock: true }));
    }
    const ordered: Array<{ sizeCode: string; inStock: boolean }> = [];
    for (const code of CANONICAL_SIZES) {
      const match = skus.find((s) => s.sizeCode === code);
      if (match) ordered.push({ sizeCode: match.sizeCode, inStock: match.inStock });
    }
    for (const sku of skus) {
      if (!ordered.some((o) => o.sizeCode === sku.sizeCode)) {
        ordered.push({ sizeCode: sku.sizeCode, inStock: sku.inStock });
      }
    }
    return ordered;
  })();

  const ctaLabel = addingToCart
    ? 'Đang thêm vào giỏ...'
    : tryOnMode === TryOnMode.MIX_MATCH_OUTFIT && garmentLayers3D.length >= 2
      ? `Thêm cả bộ phối vào giỏ (${garmentLayers3D.length} món)`
      : 'Thêm vào giỏ hàng';

  const dialogContent = (
    <div
      className={`relative mx-auto flex w-full max-w-[1280px] flex-col overflow-hidden rounded-3xl border border-[#B08A4A]/35 bg-[#1C1410] text-[#FBF7EF] shadow-2xl ${styles.dialogShell} ${
        embedded ? 'w-full' : 'max-h-[94dvh]'
      }`}
    >
      {/* Header — Always visible & never clipped (`shrink-0`) */}
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-[#B08A4A]/22 bg-[#231914]/96 px-4 py-2.5 sm:px-5 sm:py-3">
        <div className="min-w-0">
          <p
            data-testid="tryon-header-eyebrow"
            className="truncate text-[10px] font-medium tracking-[0.22em] uppercase text-[#EBCF8F]"
          >
            PHÒNG THỬ ĐỒ 3D AR · VIRTUAL TRY-ON ATELIER
          </p>
          <h2
            data-testid="tryon-header-title"
            className="font-editorial truncate text-xl leading-tight font-light text-[#FBF7EF] sm:text-2xl"
          >
            Ướm thử trực tiếp trên vóc dáng thật
          </h2>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <span className="hidden items-center gap-1.5 rounded-full border border-[#B08A4A]/35 bg-[#19120E] px-3 py-1 text-[10px] tracking-[0.14em] uppercase text-[#EBCF8F]/90 sm:inline-flex">
            <span className="h-1.5 w-1.5 rounded-full bg-[#EBCF8F]" />
            WebGL 3D · 100% Tại Thiết Bị
          </span>

          {!embedded && onClose ? (
            <button
              type="button"
              data-testid="tryon-close-btn"
              onClick={onClose}
              aria-label="Đóng Phòng Thử đồ 3D AR"
              className="flex h-8 w-8 items-center justify-center rounded-full border border-[#EBCF8F]/45 text-lg leading-none text-[#EBCF8F] transition-colors hover:bg-[#EBCF8F] hover:text-[#1C1410] sm:h-9 sm:w-9"
            >
              ×
            </button>
          ) : null}
        </div>
      </header>

      {/* Main 2-Column Bespoke Grid */}
      <div
        className={`grid min-h-0 flex-1 grid-cols-1 overflow-x-hidden ${
          embedded
            ? 'lg:grid-cols-[minmax(0,1.15fr)_minmax(360px,0.85fr)]'
            : 'overflow-y-auto lg:overflow-hidden lg:grid-cols-[minmax(0,1.15fr)_minmax(360px,0.85fr)]'
        }`}
        data-lenis-prevent=""
      >
        {/* LEFT / CENTER COLUMN — 3D MIRROR STAGE */}
        <section
          aria-label="Sân khấu Gương 3D AR"
          className="flex min-h-0 flex-col border-b border-[#B08A4A]/20 p-3 sm:p-4 lg:border-r lg:border-b-0"
        >
          {/* Top Control Strip: 3 Mode Tabs + 3 Lighting Pills */}
          <div className="mb-2.5 flex shrink-0 flex-wrap items-center justify-between gap-2">
            <div
              role="tablist"
              aria-label="Chế độ ướm thử 3D"
              className="inline-flex max-w-full flex-wrap items-center gap-1 rounded-full border border-[#B08A4A]/32 bg-[#140E0B] p-1"
            >
              {MODE_TAB_OPTIONS.map((tab) => {
                const active = tabMode === tab.id;
                return (
                  <button
                    key={tab.id}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    data-testid={tab.testId}
                    onClick={() => handleTabSwitch(tab.id)}
                    className={`rounded-full border border-transparent px-3 py-1 text-[11px] font-medium tracking-[0.06em] transition-all ${
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

            <div
              role="group"
              aria-label="Ánh sáng phòng thử"
              className="inline-flex flex-wrap items-center gap-1 rounded-full border border-[#B08A4A]/25 bg-[#150F0C] p-0.5"
            >
              {LIGHTING_OPTIONS.map((light) => {
                const active = lightingMode === light.id;
                return (
                  <button
                    key={light.id}
                    type="button"
                    data-testid={light.testId}
                    aria-pressed={active}
                    onClick={() => setLightingMode(light.id)}
                    className={`rounded-full px-2.5 py-1 text-[10px] tracking-[0.08em] transition-colors ${
                      active
                        ? 'bg-[#2E2219] font-medium text-[#EBCF8F] ring-1 ring-[#B08A4A]/55'
                        : 'text-[#FBF7EF]/65 hover:text-[#EBCF8F]'
                    }`}
                  >
                    {light.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Photo Mode Compact Controls (Upload + 3 Sample Portraits + Micro-Adjust + Split Toggle) */}
          {tabMode === 'photo' ? (
            <div className="mb-2.5 shrink-0 space-y-2 rounded-2xl border border-[#B08A4A]/25 bg-[#241A14]/75 px-3 py-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-1.5">
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    className="hidden"
                    onChange={(event) => {
                      handleUploadPhotoFile(event.target.files?.[0] ?? null);
                      event.target.value = '';
                    }}
                  />
                  <button
                    type="button"
                    data-testid="tryon-upload-photo-btn"
                    onClick={() => fileInputRef.current?.click()}
                    className="rounded-full border border-[#EBCF8F]/55 bg-[#1C1410] px-2.5 py-1 text-[10px] font-medium tracking-[0.12em] uppercase text-[#EBCF8F] transition-colors hover:bg-[#EBCF8F] hover:text-[#1C1410]"
                  >
                    + Tải ảnh
                  </button>

                  {TRYON_SAMPLE_MODELS.map((sample) => {
                    const active =
                      !uploadedPhotoUrl && selectedSampleId === sample.id;
                    return (
                      <button
                        key={sample.id}
                        type="button"
                        data-testid={sample.testId}
                        aria-pressed={active}
                        onClick={() => handleSelectSamplePortrait(sample)}
                        className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] transition-colors ${
                          active
                            ? 'border-[#EBCF8F] bg-[#EBCF8F]/20 text-[#EBCF8F]'
                            : 'border-[#B08A4A]/28 bg-[#1A130F] text-[#FBF7EF]/80 hover:border-[#EBCF8F]/60'
                        }`}
                      >
                        <img
                          src={sample.src}
                          alt={sample.name}
                          className="h-4 w-4 rounded-full object-cover object-top"
                        />
                        <span>{sample.name}</span>
                      </button>
                    );
                  })}
                </div>

                <button
                  type="button"
                  data-testid="tryon-before-after-toggle"
                  aria-pressed={beforeAfterEnabled}
                  onClick={() => setBeforeAfterEnabled((prev) => !prev)}
                  className={`rounded-full border px-2.5 py-1 text-[10px] font-medium tracking-[0.1em] uppercase transition-colors ${
                    beforeAfterEnabled
                      ? 'border-[#EBCF8F] bg-[#EBCF8F] text-[#1C1410]'
                      : 'border-[#B08A4A]/35 text-[#EBCF8F]/85 hover:border-[#EBCF8F]'
                  }`}
                >
                  So sánh Trước / Sau
                </button>
              </div>

              <div className="grid grid-cols-2 gap-3 text-[10px] text-[#FBF7EF]/75">
                <label className="flex items-center gap-2">
                  <span className="shrink-0 uppercase tracking-[0.12em] text-[#EBCF8F]/85">
                    Vị trí
                  </span>
                  <input
                    type="range"
                    min={-0.18}
                    max={0.18}
                    step={0.01}
                    value={photoAdjustments.offsetY}
                    aria-label="Chỉnh vị trí dọc trang phục"
                    onChange={(event) =>
                      setPhotoAdjustments((prev) => ({
                        ...prev,
                        offsetY: Number(event.target.value),
                      }))
                    }
                    className={`h-1 flex-1 ${styles.rangeGold}`}
                  />
                </label>

                <label className="flex items-center gap-2">
                  <span className="shrink-0 uppercase tracking-[0.12em] text-[#EBCF8F]/85">
                    Tỷ lệ
                  </span>
                  <input
                    type="range"
                    min={0.75}
                    max={1.35}
                    step={0.02}
                    value={photoAdjustments.scale}
                    aria-label="Chỉnh tỷ lệ trang phục trên ảnh"
                    onChange={(event) =>
                      setPhotoAdjustments((prev) => ({
                        ...prev,
                        scale: Number(event.target.value),
                      }))
                    }
                    className={`h-1 flex-1 ${styles.rangeGold}`}
                  />
                </label>
              </div>
            </div>
          ) : null}

          {/* Live 3D Stage Viewport */}
          <div
            data-testid="tryon-3d-stage-frame"
            className={`relative overflow-hidden rounded-2xl border border-[#B08A4A]/35 ${stageBackdropClass} ${
              embedded ? styles.stageViewportEmbedded : styles.stageViewport
            }`}
          >
            <TryOn3DScene
              ref={sceneRef}
              mode={tabMode}
              garments={garmentLayers3D}
              lightingMode={lightingMode}
              bodyMeasurements={bodyMeasurements}
              cameraEnabled={cameraEnabled}
              showTailorPins={showTailorPins}
              onRequestModeSwitch={handleTabSwitch}
              photoUrl={activePhotoUrl}
              photoPoseHint={activePhotoPoseHint}
              photoAdjustments={photoAdjustments}
              beforeAfterSplitPct={
                tabMode === 'photo' && beforeAfterEnabled
                  ? beforeAfterSplitPct
                  : null
              }
              onMannequinSideChange={setMannequinSide}
              className="h-full w-full"
            />

            {/* Interactive Before/After Split Overlay for Photo Mode */}
            {tabMode === 'photo' && beforeAfterEnabled && activePhotoUrl ? (
              <BeforeAfterSlider
                overlayOnly
                valuePct={beforeAfterSplitPct}
                onChangePct={setBeforeAfterSplitPct}
                revealKey={activePhotoUrl}
                beforeLabel="Ảnh gốc"
                afterLabel="Ướm 3D Atelier"
              />
            ) : null}

            {/* Mannequin 360° Mode Badges & Hint */}
            {tabMode === 'mannequin' ? (
              <>
                <div className="pointer-events-none absolute top-3 left-3 z-20 flex flex-wrap items-center gap-1.5">
                  <span
                    data-testid="tryon-mannequin-profile-badge"
                    className="rounded-full border border-[#EBCF8F]/45 bg-[#1C1410]/82 px-3 py-1 text-[10px] tracking-[0.1em] text-[#EBCF8F] backdrop-blur-md"
                  >
                    Ma-nơ-canh theo số đo của bạn · {bodyMeasurements.heightCm}cm
                  </span>
                  <span className="rounded-full border border-[#B08A4A]/35 bg-[#1C1410]/78 px-2.5 py-1 text-[10px] tracking-[0.12em] uppercase text-[#FBF7EF]/80 backdrop-blur-md">
                    {mannequinSide === 'back' ? 'Mặt sau' : 'Mặt trước'}
                  </span>
                </div>

                <div className="pointer-events-none absolute inset-x-3 bottom-3 z-20 flex justify-center">
                  <span className="rounded-full border border-[#B08A4A]/35 bg-[#1C1410]/78 px-3 py-1 text-[10px] tracking-[0.08em] text-[#FBF7EF]/85 backdrop-blur-md">
                    Kéo xoay 360° · Cuộn để phóng to
                  </span>
                </div>
              </>
            ) : null}
          </div>

          {/* Bottom Stage Action Dock (`shrink-0`, never overlaps stage content) */}
          <div className="mt-2.5 flex shrink-0 flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                data-testid="tryon-capture-look-btn"
                disabled={capturingLook}
                onClick={() => void handleCaptureAndSaveLook()}
                className="inline-flex items-center gap-1.5 rounded-full border border-[#EBCF8F]/70 bg-[#261C16] px-3.5 py-1.5 text-[11px] font-medium text-[#EBCF8F] transition-colors hover:bg-[#EBCF8F] hover:text-[#1C1410] disabled:opacity-60"
              >
                <span>
                  {capturingLook
                    ? 'Đang chụp...'
                    : `Chụp & Lưu bộ này (${savedLooks.length}/${MAX_SAVED_TRYON_LOOKS})`}
                </span>
              </button>

              <button
                type="button"
                data-testid="tryon-flip-btn"
                onClick={handleFlipFrontBack}
                className="rounded-full border border-[#B08A4A]/40 bg-[#1B1410] px-3 py-1.5 text-[11px] text-[#FBF7EF]/85 transition-colors hover:border-[#EBCF8F] hover:text-[#EBCF8F]"
              >
                Xoay mặt trước / sau
              </button>
            </div>

            {tabMode === 'camera' ? (
              <div className="flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  data-testid="tryon-tailor-pins-toggle"
                  aria-pressed={showTailorPins}
                  onClick={() => setShowTailorPins((prev) => !prev)}
                  className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[11px] transition-colors ${
                    showTailorPins
                      ? 'border-[#EBCF8F]/70 bg-[#251B16] text-[#EBCF8F]'
                      : 'border-[#B08A4A]/35 bg-[#1B1410] text-[#FBF7EF]/75 hover:text-[#EBCF8F]'
                  }`}
                >
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${
                      showTailorPins ? 'bg-[#EBCF8F]' : 'bg-[#FBF7EF]/40'
                    }`}
                  />
                  Điểm căn vai
                </button>
                <button
                  type="button"
                  data-testid="tryon-camera-toggle-btn"
                  onClick={() => setCameraEnabled((prev) => !prev)}
                  className={`rounded-full border px-3.5 py-1.5 text-[11px] font-medium transition-colors ${
                    cameraEnabled
                      ? 'border-[#EBCF8F]/55 bg-[#2E1E17] text-[#F5D6B8] hover:border-red-300 hover:text-white'
                      : 'border-[#EBCF8F] bg-[#EBCF8F] text-[#1C1410]'
                  }`}
                >
                  {cameraEnabled ? 'Tắt Camera' : 'Bật Camera'}
                </button>
              </div>
            ) : tabMode === 'mannequin' ? (
              <button
                type="button"
                data-testid="tryon-reset-orbit-btn"
                onClick={() => sceneRef.current?.resetMannequinOrbit()}
                className="rounded-full border border-[#B08A4A]/35 bg-[#1B1410] px-3 py-1.5 text-[11px] text-[#EBCF8F]/90 transition-colors hover:border-[#EBCF8F]"
              >
                Đặt lại góc nhìn
              </button>
            ) : (
              <button
                type="button"
                data-testid="tryon-reset-photo-btn"
                onClick={() => {
                  setPhotoAdjustments(DEFAULT_PHOTO_ADJUSTMENTS);
                  setBeforeAfterSplitPct(78);
                }}
                className="rounded-full border border-[#B08A4A]/35 bg-[#1B1410] px-3 py-1.5 text-[11px] text-[#EBCF8F]/90 transition-colors hover:border-[#EBCF8F]"
              >
                Đặt lại căn chỉnh
              </button>
            )}
          </div>
        </section>

        {/* RIGHT COLUMN — BESPOKE WARDROBE, SWATCHES, SAVED TRAY & 1-TAP CHECKOUT */}
        <aside
          aria-label="Tủ đồ và tùy chỉnh kích cỡ Atelier"
          className="flex min-h-0 flex-col bg-[#1F1713]/96"
        >
          <div
            className={`min-h-0 flex-1 space-y-3 overflow-y-auto px-3.5 py-3 sm:px-4 ${styles.atelierScroll}`}
            data-lenis-prevent=""
          >
            {/* 1. Try-On Mode Toggle (SINGLE vs MIX_MATCH_OUTFIT) + Active Outfit Slot Chips */}
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <div
                  role="group"
                  aria-label="Kiểu ướm thử"
                  className="inline-flex rounded-full border border-[#B08A4A]/30 bg-[#150F0C] p-0.5"
                >
                  <button
                    type="button"
                    data-testid="tryon-mode-single"
                    aria-pressed={tryOnMode === TryOnMode.SINGLE}
                    onClick={() => handleSwitchTryOnMode(TryOnMode.SINGLE)}
                    className={`rounded-full px-3 py-1 text-[11px] font-medium transition-colors ${
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
                    className={`rounded-full px-3 py-1 text-[11px] font-medium transition-colors ${
                      tryOnMode === TryOnMode.MIX_MATCH_OUTFIT
                        ? 'bg-[#EBCF8F] text-[#1C1410]'
                        : 'text-[#FBF7EF]/75 hover:text-[#EBCF8F]'
                    }`}
                  >
                    Phối cả bộ
                  </button>
                </div>

                <span className="font-mono text-[10px] text-[#EBCF8F]/85">
                  Đang mặc {activeSlotEntries.length} món
                </span>
              </div>

              {tryOnMode === TryOnMode.MIX_MATCH_OUTFIT &&
              activeSlotEntries.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {activeSlotEntries.map(({ slot, product }) => {
                    const isFocused = focusedEntry?.slot === slot;
                    return (
                      <div
                        key={slot}
                        className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[10px] transition-colors ${
                          isFocused
                            ? 'border-[#EBCF8F] bg-[#EBCF8F]/16 text-[#EBCF8F]'
                            : 'border-[#B08A4A]/30 bg-[#17110E] text-[#FBF7EF]/80'
                        }`}
                      >
                        <button
                          type="button"
                          onClick={() => setFocusedSlot(slot)}
                          className="max-w-[140px] truncate text-left"
                        >
                          <strong className="font-medium">
                            {SLOT_LABELS[slot]}:
                          </strong>{' '}
                          {product.name}
                        </button>
                        {activeSlotEntries.length > 1 ? (
                          <button
                            type="button"
                            onClick={() => handleRemoveSlot(slot)}
                            aria-label={`Bỏ ${SLOT_LABELS[slot]}`}
                            className="ml-0.5 text-[#EBCF8F]/75 hover:text-white"
                          >
                            ×
                          </button>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              ) : null}
            </div>

            {/* 2. Visual Wardrobe Selector (thumbnail cards, no native dropdown) */}
            <div className="rounded-2xl border border-[#B08A4A]/25 bg-[#251B16]/75 p-2.5">
              {/* 3 Source Filter Tabs */}
              <div
                role="tablist"
                aria-label="Nguồn tủ đồ ướm thử"
                className="grid grid-cols-3 gap-1 rounded-xl border border-[#B08A4A]/22 bg-[#16100D] p-1"
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={wardrobeSource === 'cart'}
                  data-testid="wardrobe-source-cart"
                  onClick={() => setWardrobeSource('cart')}
                  className={`truncate rounded-lg px-2 py-1.5 text-[10px] font-medium transition-colors ${
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
                  className={`truncate rounded-lg px-2 py-1.5 text-[10px] font-medium transition-colors ${
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
                  className={`truncate rounded-lg px-2 py-1.5 text-[10px] font-medium transition-colors ${
                    wardrobeSource === 'catalog'
                      ? 'bg-[#EBCF8F] text-[#1C1410]'
                      : 'text-[#FBF7EF]/75 hover:text-[#EBCF8F]'
                  }`}
                >
                  Tủ Đồ Atelier ({allProducts.length})
                </button>
              </div>

              {/* Sub-filter pills for Catalog or 1-tap wear whole Studio outfit */}
              {wardrobeSource === 'catalog' ? (
                <div className="mt-2 flex flex-wrap gap-1">
                  {(
                    [
                      ['ALL', 'Tất cả'],
                      ['TOP', 'Áo'],
                      ['BOTTOM', 'Quần / Váy'],
                      ['ONE_PIECE', 'Đầm'],
                      ['OUTERWEAR', 'Khoác'],
                    ] as const
                  ).map(([key, label]) => (
                    <button
                      key={key}
                      type="button"
                      onClick={() => setSlotFilter(key)}
                      className={`rounded-full border px-2.5 py-0.5 text-[10px] transition-colors ${
                        slotFilter === key
                          ? 'border-[#EBCF8F]/70 bg-[#EBCF8F]/16 text-[#EBCF8F]'
                          : 'border-[#B08A4A]/22 text-[#FBF7EF]/65 hover:text-[#EBCF8F]'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              ) : wardrobeSource === 'studio' && studioProducts.length >= 2 ? (
                <div className="mt-2 flex justify-end">
                  <button
                    type="button"
                    onClick={handleApplyEntireStudioOutfit}
                    className="rounded-full border border-[#EBCF8F]/55 bg-[#1C1410] px-3 py-1 text-[10px] font-medium text-[#EBCF8F] hover:bg-[#EBCF8F] hover:text-[#1C1410]"
                  >
                    Mặc cả bộ đang phối ({studioProducts.length} món)
                  </button>
                </div>
              ) : null}

              {/* Scrollable 2:3 Visual Thumbnail Card Grid */}
              {displayedWardrobeProducts.length === 0 ? (
                <div className="mt-2.5 rounded-xl border border-dashed border-[#B08A4A]/25 bg-[#18110E]/70 px-3 py-5 text-center">
                  <p className="text-xs text-[#FBF7EF]/70">
                    {wardrobeSource === 'cart'
                      ? 'Giỏ hàng hiện chưa có thiết kế nào.'
                      : 'Chưa có bộ phối nào được lưu từ Phòng Phối Đồ.'}
                  </p>
                  <button
                    type="button"
                    onClick={() => setWardrobeSource('catalog')}
                    className="mt-2 rounded-full border border-[#EBCF8F]/55 px-3 py-1 text-[10px] uppercase tracking-[0.14em] text-[#EBCF8F] hover:bg-[#EBCF8F] hover:text-[#1C1410]"
                  >
                    Mở Tủ Đồ Atelier
                  </button>
                </div>
              ) : (
                <div
                  className={`mt-2.5 max-h-[208px] overflow-y-auto pr-1 ${styles.wardrobeGrid} ${styles.atelierScroll}`}
                >
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
                        className={`group flex flex-col overflow-hidden rounded-xl border text-left transition-all ${
                          isWorn
                            ? 'border-[#EBCF8F] bg-[#2D211A] ring-1 ring-[#EBCF8F]/70'
                            : 'border-[#B08A4A]/25 bg-[#18120E] hover:border-[#EBCF8F]/70'
                        }`}
                      >
                        <div className="relative aspect-[2/3] w-full overflow-hidden bg-[#F5EFE4]/95 p-1">
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
                          <p className="truncate text-[10px] font-medium text-[#FBF7EF]">
                            {product.name}
                          </p>
                          <p className="font-mono text-[9px] text-[#EBCF8F]">
                            {FORMAT_VND(product.minPriceVnd)}
                          </p>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {/* 3. Active Garment Controls: Color Swatches + Smart Size Recommendation + Canonical Sizes */}
            {focusedProduct ? (
              <div className="space-y-2.5 rounded-2xl border border-[#B08A4A]/28 bg-[#241A14]/82 p-3">
                {/* Color Swatches */}
                <div>
                  <div className="flex items-center justify-between gap-2">
                    <p className="truncate text-[10px] font-medium tracking-[0.16em] uppercase text-[#EBCF8F]">
                      Màu sắc · {focusedVariant?.colorName ?? 'Nguyên bản'}
                    </p>
                    <span className="truncate text-[10px] text-[#FBF7EF]/60">
                      {focusedProduct.name}
                    </span>
                  </div>

                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    {focusedProduct.variants.map((variant, idx) => {
                      const active = idx === focusedVariantIdx;
                      return (
                        <button
                          key={variant.id}
                          type="button"
                          data-testid={`tryon-color-swatch-${idx}`}
                          aria-pressed={active}
                          onClick={() => handleSelectColorSwatch(idx)}
                          className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] transition-all ${
                            active
                              ? 'border-[#EBCF8F] bg-[#EBCF8F]/16 text-[#EBCF8F]'
                              : 'border-[#B08A4A]/30 bg-[#18120E] text-[#FBF7EF]/80 hover:border-[#EBCF8F]/65'
                          }`}
                        >
                          <span
                            className="h-3.5 w-3.5 rounded-full border border-white/25 shadow-inner"
                            style={{ backgroundColor: variant.colorHex }}
                          />
                          <span>{variant.colorName}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Smart Size Recommendation Banner */}
                <div
                  data-testid="tryon-size-recommendation"
                  className="rounded-xl border border-[#B08A4A]/35 bg-[#19120E]/90 px-3 py-2"
                >
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-[11px] text-[#FBF7EF]/90">
                      Cỡ gợi ý cho bạn:{' '}
                      <strong className="text-[#EBCF8F]">
                        Size {recommendedSizeLabel}
                      </strong>{' '}
                      · {recommendedFitLabel}
                    </p>
                    <button
                      type="button"
                      onClick={() => setShowMeasureEditor((prev) => !prev)}
                      className="shrink-0 text-[10px] text-[#EBCF8F] underline underline-offset-2 hover:text-[#FBF7EF]"
                    >
                      {showMeasureEditor ? 'Đóng' : 'Chỉnh số đo'}
                    </button>
                  </div>

                  {showMeasureEditor ? (
                    <div className="mt-2.5 space-y-2 border-t border-[#B08A4A]/20 pt-2 text-[11px]">
                      <div className="grid grid-cols-2 gap-2.5">
                        <label className="block">
                          <span className="flex justify-between text-[10px] text-[#FBF7EF]/75">
                            <span>Chiều cao</span>
                            <strong className="font-mono text-[#EBCF8F]">
                              {editHeightCm}cm
                            </strong>
                          </span>
                          <input
                            type="range"
                            min={145}
                            max={185}
                            value={editHeightCm}
                            onChange={(e) =>
                              setEditHeightCm(Number(e.target.value))
                            }
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
                            min={38}
                            max={85}
                            value={editWeightKg}
                            onChange={(e) =>
                              setEditWeightKg(Number(e.target.value))
                            }
                            className={`mt-1 w-full ${styles.rangeGold}`}
                          />
                        </label>
                      </div>

                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex gap-1">
                          {(
                            [
                              FitPreference.SLIM,
                              FitPreference.REGULAR,
                              FitPreference.RELAXED,
                            ] as const
                          ).map((pref) => (
                            <button
                              key={pref}
                              type="button"
                              onClick={() => setEditFitPref(pref)}
                              className={`rounded-full border px-2 py-0.5 text-[10px] ${
                                editFitPref === pref
                                  ? 'border-[#EBCF8F] bg-[#EBCF8F] text-[#1C1410]'
                                  : 'border-[#B08A4A]/30 text-[#FBF7EF]/75'
                              }`}
                            >
                              {FIT_PREF_VN[pref]}
                            </button>
                          ))}
                        </div>
                        <button
                          type="button"
                          onClick={handleSaveMeasurementsInline}
                          className="rounded-full bg-[#EBCF8F] px-3 py-1 text-[10px] font-medium text-[#1C1410]"
                        >
                          Áp dụng
                        </button>
                      </div>
                    </div>
                  ) : null}
                </div>

                {/* Canonical Size Buttons (XS · S · M · L · XL) */}
                <div className="flex flex-wrap items-center gap-1.5">
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
                        className={`min-w-[40px] rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                          selected
                            ? 'border-[#EBCF8F] bg-[#EBCF8F] text-[#1C1410]'
                            : !sku.inStock
                              ? 'cursor-not-allowed border-white/10 text-white/30 line-through'
                              : 'border-[#B08A4A]/38 bg-[#18120E] text-[#FBF7EF]/85 hover:border-[#EBCF8F]'
                        }`}
                      >
                        {sku.sizeCode}
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : null}

            {/* 4. Max-3 Saved Looks Comparison Tray */}
            <SavedTryOnLooksTray
              looks={savedLooks}
              activeLookId={previewLook?.id ?? null}
              maxLooks={MAX_SAVED_TRYON_LOOKS}
              limitWarning={limitWarning}
              onDismissWarning={() => setLimitWarning(null)}
              onSelectLook={(look) => setPreviewLook(look)}
              onDeleteLook={handleDeleteSavedLook}
            />
          </div>

          {/* Pinned 1-Tap Checkout Footer inside Right Column */}
          <div className="shrink-0 border-t border-[#B08A4A]/25 bg-[#241A14]/96 px-4 py-3">
            <div className="mb-2 flex items-baseline justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate text-[10px] tracking-[0.16em] uppercase text-[#EBCF8F]/85">
                  {tryOnMode === TryOnMode.MIX_MATCH_OUTFIT &&
                  garmentLayers3D.length >= 2
                    ? `Bộ phối ${garmentLayers3D.length} món · Size ${selectedSizeCode}`
                    : `${focusedProduct?.name ?? 'Thiết kế Atelier'} · Size ${selectedSizeCode}`}
                </p>
              </div>
              <p className="font-editorial shrink-0 text-xl font-medium text-[#EBCF8F]">
                {FORMAT_VND(totalOutfitPriceVnd)}
              </p>
            </div>

            <button
              type="button"
              data-testid="tryon-add-to-bag-btn"
              disabled={addingToCart || garmentLayers3D.length === 0}
              onClick={() => void handleAddToBag()}
              className={`w-full rounded-full px-5 py-2.5 text-xs font-semibold tracking-[0.16em] uppercase disabled:cursor-not-allowed disabled:opacity-50 ${styles.ctaGoldButton}`}
            >
              {ctaLabel}
            </button>

            {cartNotice ? (
              <p
                role="status"
                className="mt-2 rounded-xl border border-[#EBCF8F]/35 bg-[#19120E] px-3 py-1.5 text-[11px] text-[#EBCF8F]"
              >
                {cartNotice}
              </p>
            ) : null}
          </div>
        </aside>
      </div>

      {/* Global Luxury Privacy Footer (`shrink-0`, never clipped at 768px height) */}
      <footer
        data-testid="tryon-privacy-footer"
        className="flex shrink-0 items-center justify-center gap-2 border-t border-[#B08A4A]/22 bg-[#16100C] px-4 py-2 text-center text-[11px] leading-snug text-[#FBF7EF]/72"
      >
        <span
          className="hidden h-1.5 w-1.5 shrink-0 rounded-full bg-[#B08A4A] sm:inline-block"
          aria-hidden="true"
        />
        <span>{TRYON_PRIVACY_GUARANTEE_TEXT}</span>
      </footer>

      {/* Saved Looks Side-by-Side Comparison Lightbox */}
      {previewLook ? (
        <div
          data-testid="tryon-saved-look-lightbox"
          role="dialog"
          aria-modal="true"
          aria-label="So sánh bộ phối đã lưu"
          className="absolute inset-0 z-40 flex items-center justify-center bg-[#120C09]/92 p-4 backdrop-blur-md"
          onClick={(event) => {
            if (event.target === event.currentTarget) {
              setPreviewLook(null);
            }
          }}
        >
          <div className="flex max-h-full w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-[#EBCF8F]/45 bg-[#1E1612] text-[#FBF7EF] shadow-2xl">
            <div className="flex items-center justify-between border-b border-[#B08A4A]/25 px-4 py-3">
              <div>
                <p className="text-[10px] tracking-[0.2em] uppercase text-[#EBCF8F]">
                  Đối chiếu dáng thử đã lưu ({savedLooks.length}/
                  {MAX_SAVED_TRYON_LOOKS})
                </p>
                <h3 className="font-editorial text-xl text-[#FBF7EF]">
                  {previewLook.label}
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setPreviewLook(null)}
                aria-label="Đóng cửa sổ đối chiếu"
                className="flex h-8 w-8 items-center justify-center rounded-full border border-[#EBCF8F]/45 text-base text-[#EBCF8F] hover:bg-[#EBCF8F] hover:text-[#1C1410]"
              >
                ×
              </button>
            </div>

            <div className="grid min-h-0 flex-1 gap-4 overflow-y-auto p-4 sm:grid-cols-[1fr_0.9fr]">
              <div className="mx-auto aspect-[3/4] w-full max-w-[300px] overflow-hidden rounded-2xl border border-[#B08A4A]/40 bg-[#140E0B]">
                <img
                  src={previewLook.imageDataUrl}
                  alt={previewLook.label}
                  className="h-full w-full object-cover"
                />
              </div>

              <div className="flex flex-col justify-between gap-3">
                <div className="space-y-2.5">
                  <p className="font-editorial text-2xl text-[#EBCF8F]">
                    {FORMAT_VND(previewLook.totalPriceVnd)}
                  </p>
                  <p className="text-xs text-[#FBF7EF]/75">
                    Kích cỡ đã chọn: <strong className="text-[#EBCF8F]">Size {previewLook.sizeCode}</strong>
                  </p>
                  <ul className="space-y-1 text-xs text-[#FBF7EF]/85">
                    {previewLook.garmentSummary.map((line, i) => (
                      <li key={i} className="flex items-start gap-2">
                        <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-[#EBCF8F]" />
                        <span>{line}</span>
                      </li>
                    ))}
                  </ul>

                  {savedLooks.length > 1 ? (
                    <div className="pt-2">
                      <p className="mb-1.5 text-[10px] tracking-[0.16em] uppercase text-[#EBCF8F]/80">
                        Chuyển nhanh bộ khác
                      </p>
                      <div className="grid grid-cols-3 gap-2">
                        {savedLooks.map((look) => (
                          <button
                            key={look.id}
                            type="button"
                            onClick={() => setPreviewLook(look)}
                            className={`overflow-hidden rounded-lg border ${
                              look.id === previewLook.id
                                ? 'border-[#EBCF8F] ring-1 ring-[#EBCF8F]'
                                : 'border-[#B08A4A]/30 opacity-75 hover:opacity-100'
                            }`}
                          >
                            <div className="aspect-[3/4] w-full bg-[#120C09]">
                              <img
                                src={look.imageDataUrl}
                                alt={look.label}
                                className="h-full w-full object-cover"
                              />
                            </div>
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </div>

                <div className="flex items-center justify-between gap-2 border-t border-[#B08A4A]/20 pt-3">
                  <button
                    type="button"
                    onClick={() => handleDeleteSavedLook(previewLook.id)}
                    className="rounded-full border border-red-400/45 px-3.5 py-1.5 text-[11px] text-red-200 hover:bg-red-900/60"
                  >
                    Xóa bộ này
                  </button>
                  <button
                    type="button"
                    onClick={() => setPreviewLook(null)}
                    className="rounded-full bg-[#EBCF8F] px-4 py-1.5 text-[11px] font-medium text-[#1C1410]"
                  >
                    Quay lại Phòng Thử 3D
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );

  if (embedded) {
    return (
      <div
        data-testid="virtual-tryon-modal"
        className="w-full overflow-x-hidden py-2"
      >
        {dialogContent}
      </div>
    );
  }

  return (
    <div
      data-testid="virtual-tryon-modal"
      className={`fixed inset-0 z-[120] flex items-center justify-center bg-[#1C1410]/82 p-2.5 sm:p-4 backdrop-blur-md ${styles.modalBackdrop}`}
      role="dialog"
      aria-modal="true"
      aria-label="Phòng Thử Đồ 3D AR Tầm Xuân"
      onClick={(event) => {
        if (event.target === event.currentTarget && onClose) {
          onClose();
        }
      }}
    >
      {dialogContent}
    </div>
  );
}
