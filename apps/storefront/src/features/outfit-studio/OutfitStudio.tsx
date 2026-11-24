'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  HTTP_HEADERS,
  OutfitSlot,
  TryOnMode,
  type BatchAvailabilityResponse,
  type CartDto,
  type OutfitStudioPreviewResponse,
  type PackagingOptionDto,
  type ProductSpuDto,
  type SavedOutfitDto,
  type SkuAvailabilityDto,
} from '@atelier/contracts';
import { triggerParticleBurst } from '@atelier/motion-kit';
import { showAtelierToast } from '@/components/AtelierToastProvider';
import { apiFetch } from '@/lib/api-client';
import { FORMAT_VND, getPrimaryVariantImage } from '@/lib/catalog-data';
import {
  emitCartUpdated,
  refreshCartCount,
  saveActiveStudioOutfitSnapshot,
  type ActiveStudioOutfitSnapshot,
} from '@/lib/storefront-actions';
import {
  applyOutfitSlotSelection,
  getOrderedOutfitSelections,
  inferProductOutfitSlot,
  OUTFIT_SLOT_META,
  OUTFIT_SLOT_ORDER,
  removeOutfitSlot,
  renderOutfitCompositeSnapshot,
  resolveSelectionFromProduct,
  sortSkusCanonically,
  type OutfitSlotSelection,
  type OutfitSlotsMap,
} from './compositor';
import { GarmentLayerStage, type FlyInOrigin } from './GarmentLayerStage';
import styles from './outfit-studio.module.css';
import {
  computeHarmonyProducts,
  OUTFIT_PRESETS,
  resolvePresetSlots,
  type OutfitPresetId,
} from './presets';
import {
  loadSavedStudioSizeProfile,
  SizeGuideModal,
  type StudioSizeProfile,
} from './SizeGuideModal';
import { StudioGiftCard } from './StudioGiftCard';

export interface OutfitTryOnItemRef {
  productId: string;
  variantId?: string;
  skuId?: string;
  slug?: string;
  productName?: string;
  imageUrl?: string | null;
}

export interface OpenTryOnFromStudioPayload {
  mode: TryOnMode;
  upper?: OutfitTryOnItemRef | null;
  lower?: OutfitTryOnItemRef | null;
  onePiece?: OutfitTryOnItemRef | null;
  outerwear?: OutfitTryOnItemRef | null;
}

export interface OutfitStudioProps {
  products: ProductSpuDto[];
  packagingOptions: PackagingOptionDto[];
  initialShareCode?: string | null;
  onOpenBag?: () => void;
  onOpenTryOn?: (payload: OpenTryOnFromStudioPayload) => void;
}

type PackagingWithOptionalImage = PackagingOptionDto & {
  imageUrl?: string | null;
};

const GUEST_STORAGE_KEY = 'atelier_guest_session_id';
const LOCAL_SAVED_OUTFITS_KEY = 'atelier_saved_outfits_local_v1';
const DEFAULT_PRESET_ID: OutfitPresetId = 'evening-burgundy';

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

function resolvePackagingThumbnailUrl(pkg: PackagingOptionDto): string {
  const extended = pkg as PackagingWithOptionalImage;
  return (
    extended.imageUrl ||
    pkg.frontAssetUrl ||
    pkg.backAssetUrl ||
    `/packaging/${pkg.code}.webp`
  );
}

function isCutoutImageUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  return /flat|rack|cutout|layer/i.test(url);
}

function PackagingThumbnail({ pkg }: { pkg: PackagingOptionDto }) {
  const primarySrc = resolvePackagingThumbnailUrl(pkg);
  const fallbackSrc = `/packaging/${pkg.code}.webp`;
  const [src, setSrc] = useState(primarySrc);

  useEffect(() => {
    setSrc(primarySrc);
  }, [primarySrc]);

  return (
    <span
      className="relative flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-[#B08A4A]/25"
      style={{ backgroundColor: pkg.swatchHex || '#EFE6D5' }}
    >
      <img
        src={src}
        alt={pkg.name}
        width={44}
        height={44}
        decoding="async"
        onError={() => {
          if (src !== fallbackSrc) {
            setSrc(fallbackSrc);
          }
        }}
        className="h-full w-full object-cover"
      />
    </span>
  );
}

export function OutfitStudio({
  products,
  packagingOptions,
  initialShareCode,
  onOpenBag,
  onOpenTryOn,
}: OutfitStudioProps) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const flySeqRef = useRef(0);
  const itemCardRefs = useRef<Partial<Record<OutfitSlot, HTMLLIElement | null>>>({});
  const highlightTimerRef = useRef<number | null>(null);
  const mutualToastTimerRef = useRef<number | null>(null);
  const userClearedRef = useRef(false);
  const didAutoPresetRef = useRef(Boolean(!initialShareCode && products.length > 0));

  // Initial SSR-safe 3-piece default preset ("Dạ Tiệc Đỏ Vang")
  const [slots, setSlots] = useState<OutfitSlotsMap>(() => {
    if (!initialShareCode && products.length > 0) {
      return resolvePresetSlots(DEFAULT_PRESET_ID, products, null);
    }
    return {};
  });
  const [activePresetId, setActivePresetId] = useState<OutfitPresetId | null>(() =>
    !initialShareCode && products.length > 0 ? DEFAULT_PRESET_ID : null,
  );
  const [activeSlotTab, setActiveSlotTab] = useState<'ALL' | OutfitSlot>('ALL');
  const [harmonyMode, setHarmonyMode] = useState(false);
  const [cardVariantIdxMap, setCardVariantIdxMap] = useState<Record<string, number>>({});
  const [draggingProductId, setDraggingProductId] = useState<string | null>(null);

  // Stage interactive tool states
  const [lightingMode, setLightingMode] = useState<'morning' | 'evening'>('morning');
  const [viewSide, setViewSide] = useState<'front' | 'back'>('front');
  const [loupeEnabled, setLoupeEnabled] = useState(false);
  const [flyOrigin, setFlyOrigin] = useState<FlyInOrigin | null>(null);
  const [isFinalized, setIsFinalized] = useState(false);
  const [snapshotUrl, setSnapshotUrl] = useState<string | null>(null);
  const [highlightedSlot, setHighlightedSlot] = useState<OutfitSlot | null>(null);

  // Size profile modal state (persisted in localStorage)
  const [sizeModalOpen, setSizeModalOpen] = useState(false);
  const [sizeProfile, setSizeProfile] = useState<StudioSizeProfile | null>(null);

  // Packaging & handwritten gift card
  const [selectedPkgId, setSelectedPkgId] = useState<string>(
    packagingOptions.find((p) => p.isDefault)?.id ?? packagingOptions[0]?.id ?? '',
  );
  const [giftNote, setGiftNote] = useState('');

  // Live BFF states
  const [availabilityMap, setAvailabilityMap] = useState<
    Record<string, SkuAvailabilityDto>
  >({});
  const [previewData, setPreviewData] = useState<OutfitStudioPreviewResponse | null>(
    null,
  );
  const [isPreviewLoading, setIsPreviewLoading] = useState(false);
  const [isAddingBundle, setIsAddingBundle] = useState(false);
  const [isSavingShare, setIsSavingShare] = useState(false);
  const [shareResult, setShareResult] = useState<{
    shareCode: string;
    shareUrl: string;
    copied: boolean;
  } | null>(null);
  const [mutualBanner, setMutualBanner] = useState<string | null>(null);
  const [statusFeedback, setStatusFeedback] = useState<string | null>(null);
  const [restoredTitle, setRestoredTitle] = useState<string | null>(null);

  // Cleanup timers on unmount
  useEffect(() => {
    return () => {
      if (highlightTimerRef.current !== null) {
        window.clearTimeout(highlightTimerRef.current);
      }
      if (mutualToastTimerRef.current !== null) {
        window.clearTimeout(mutualToastTimerRef.current);
      }
    };
  }, []);

  // Load saved local size profile after hydration
  useEffect(() => {
    const saved = loadSavedStudioSizeProfile();
    if (saved) {
      setSizeProfile(saved);
    }
  }, []);

  // Auto-load default 3-piece preset ("Dạ Tiệc Đỏ Vang") whenever products arrive asynchronously
  // and user hasn't explicitly clicked "Làm lại", cleared items, or opened a shared link
  useEffect(() => {
    if (
      initialShareCode ||
      userClearedRef.current ||
      didAutoPresetRef.current ||
      products.length === 0
    ) {
      return;
    }
    const saved = loadSavedStudioSizeProfile();
    const resolved = resolvePresetSlots(
      DEFAULT_PRESET_ID,
      products,
      saved?.recommendedSize ?? null,
    );
    if (Object.keys(resolved).length > 0) {
      didAutoPresetRef.current = true;
      setSlots(resolved);
      setActivePresetId(DEFAULT_PRESET_ID);
    }
  }, [initialShareCode, products]);

  // Keep selected packaging valid if packagingOptions updates
  useEffect(() => {
    if (packagingOptions.length === 0) return;
    setSelectedPkgId((prev) => {
      if (prev && packagingOptions.some((pkg) => pkg.id === prev)) {
        return prev;
      }
      return packagingOptions.find((pkg) => pkg.isDefault)?.id ?? packagingOptions[0]!.id;
    });
  }, [packagingOptions]);

  // Persist active Studio outfit combination to localStorage for the 3D Virtual Try-On Mirror
  useEffect(() => {
    const snapshotSlots: ActiveStudioOutfitSnapshot['slots'] = {};
    for (const slotKey of OUTFIT_SLOT_ORDER) {
      const sel = slots[slotKey];
      if (!sel) continue;
      snapshotSlots[slotKey] = {
        productId: sel.productId,
        variantId: sel.variantId,
        skuId: sel.skuId,
        slug: sel.slug,
        productName: sel.productName,
        colorName: sel.colorName,
        sizeCode: sel.sizeCode,
        imageUrl: sel.imageUrl ?? null,
      };
    }
    saveActiveStudioOutfitSnapshot({
      updatedAt: new Date().toISOString(),
      slots: snapshotSlots,
    });
  }, [slots]);

  const productById = useMemo(() => {
    const map = new Map<string, ProductSpuDto>();
    for (const p of products) {
      map.set(p.id, p);
    }
    return map;
  }, [products]);

  const productsBySlot = useMemo(() => {
    const grouped: Record<OutfitSlot, ProductSpuDto[]> = {
      [OutfitSlot.TOP]: [],
      [OutfitSlot.BOTTOM]: [],
      [OutfitSlot.ONE_PIECE]: [],
      [OutfitSlot.OUTERWEAR]: [],
      [OutfitSlot.ACCESSORY]: [],
    };
    for (const product of products) {
      const slot = inferProductOutfitSlot(product);
      grouped[slot].push(product);
    }
    return grouped;
  }, [products]);

  const harmonyResult = useMemo(
    () => computeHarmonyProducts(products, slots),
    [products, slots],
  );

  const harmonyTopIds = useMemo(
    () => new Set(harmonyResult.items.slice(0, 6).map((item) => item.id)),
    [harmonyResult.items],
  );

  const visibleProducts = useMemo(() => {
    const baseList =
      activeSlotTab === 'ALL' ? products : productsBySlot[activeSlotTab];

    if (!harmonyMode) {
      return baseList;
    }

    const harmonyRank = new Map<string, number>();
    harmonyResult.items.forEach((item, idx) => {
      harmonyRank.set(item.id, idx);
    });

    return [...baseList].sort((a, b) => {
      const slotA = inferProductOutfitSlot(a);
      const slotB = inferProductOutfitSlot(b);
      const boostA =
        slotA === OutfitSlot.OUTERWEAR || slotA === OutfitSlot.ACCESSORY ? 0 : 1;
      const boostB =
        slotB === OutfitSlot.OUTERWEAR || slotB === OutfitSlot.ACCESSORY ? 0 : 1;
      const rankA = harmonyRank.get(a.id) ?? 999;
      const rankB = harmonyRank.get(b.id) ?? 999;
      if (activeSlotTab === 'ALL' && boostA !== boostB) {
        return boostA - boostB;
      }
      return rankA - rankB;
    });
  }, [activeSlotTab, harmonyMode, harmonyResult.items, products, productsBySlot]);

  const orderedSelections = useMemo(() => getOrderedOutfitSelections(slots), [slots]);

  const activePackaging = useMemo(
    () =>
      packagingOptions.find((pkg) => pkg.id === selectedPkgId) ??
      packagingOptions[0] ??
      null,
    [packagingOptions, selectedPkgId],
  );

  const showMutualBanner = useCallback((message: string) => {
    setMutualBanner(message);
    showAtelierToast(message, 'gold', 3400);
    if (mutualToastTimerRef.current !== null) {
      window.clearTimeout(mutualToastTimerRef.current);
    }
    mutualToastTimerRef.current = window.setTimeout(() => {
      setMutualBanner(null);
      mutualToastTimerRef.current = null;
    }, 4500);
  }, []);

  // Restore shared outfit when `initialShareCode` is passed (e.g. /phoi-do?share=XXXX)
  useEffect(() => {
    if (!initialShareCode) return;
    let cancelled = false;

    const loadShared = async () => {
      const res = await apiFetch<SavedOutfitDto>(
        `/bff/v1/storefront/outfits/share/${encodeURIComponent(initialShareCode)}`,
        {
          headers: getGuestHeader(),
          skipAuthRefresh: true,
        },
      );
      if (cancelled || !res.ok || !res.data) return;

      let restored: OutfitSlotsMap = {};
      for (const slotItem of res.data.slots) {
        const prod = productById.get(slotItem.productId);
        const selection: OutfitSlotSelection = prod
          ? resolveSelectionFromProduct(prod, {
              slot: slotItem.slot,
              variantIndex: Math.max(
                0,
                prod.variants.findIndex((v) => v.id === slotItem.variantId),
              ),
              preferredSkuId: slotItem.skuId,
            })
          : {
              slot: slotItem.slot,
              productId: slotItem.productId,
              variantId: slotItem.variantId,
              skuId: slotItem.skuId,
              slug: slotItem.slug ?? '',
              productName: slotItem.productName ?? 'Thiết kế Tầm Xuân',
              colorName: slotItem.colorName ?? 'Tiêu chuẩn',
              colorHex: slotItem.colorHex ?? '#EBD9B4',
              sizeCode: slotItem.sizeCode ?? 'M',
              imageUrl: slotItem.imageUrl ?? null,
              backImageUrl: null,
              unitPriceVnd: slotItem.unitPriceVnd ?? 0,
              qty: slotItem.qty ?? 1,
            };
        restored = applyOutfitSlotSelection(restored, selection);
      }

      setSlots(restored);
      setActivePresetId(null);
      if (res.data.packagingOptionId) {
        setSelectedPkgId(res.data.packagingOptionId);
      }
      if (res.data.giftNote) {
        setGiftNote(res.data.giftNote);
      }
      setRestoredTitle(res.data.title);
      setStatusFeedback(
        `Đã khôi phục bộ phối “${res.data.title}” (#${res.data.shareCode}).`,
      );
    };

    void loadShared();
    return () => {
      cancelled = true;
    };
  }, [initialShareCode, productById]);

  // Fetch real multi-warehouse batch availability for all SKUs of selected products
  useEffect(() => {
    const skuIds = new Set<string>();
    for (const sel of orderedSelections) {
      skuIds.add(sel.skuId);
      const prod = productById.get(sel.productId);
      if (prod) {
        for (const variant of prod.variants) {
          for (const sku of variant.skus) {
            skuIds.add(sku.id);
          }
        }
      }
    }

    if (skuIds.size === 0) return;
    let cancelled = false;

    const loadStock = async () => {
      const res = await apiFetch<BatchAvailabilityResponse>(
        '/bff/v1/storefront/inventory/batch-availability',
        {
          method: 'POST',
          headers: getGuestHeader(),
          skipAuthRefresh: true,
          body: JSON.stringify({ skuIds: Array.from(skuIds) }),
        },
      );
      if (cancelled || !res.ok || !res.data) return;
      setAvailabilityMap((prev) => ({ ...prev, ...res.data!.items }));
    };

    void loadStock();
    return () => {
      cancelled = true;
    };
  }, [orderedSelections, productById]);

  // Fetch live server-calculated Combo discount (-5% for 2 items, -10% for >= 3 items)
  useEffect(() => {
    if (orderedSelections.length === 0) {
      setPreviewData(null);
      return;
    }

    let cancelled = false;
    setIsPreviewLoading(true);

    const timer = window.setTimeout(async () => {
      const res = await apiFetch<OutfitStudioPreviewResponse>(
        '/bff/v1/storefront/outfit-studio/preview',
        {
          method: 'POST',
          headers: getGuestHeader(),
          skipAuthRefresh: true,
          body: JSON.stringify({
            items: orderedSelections.map((item) => ({
              slot: item.slot,
              productId: item.productId,
              variantId: item.variantId,
              skuId: item.skuId,
              slug: item.slug,
              productName: item.productName,
              colorName: item.colorName,
              colorHex: item.colorHex,
              sizeCode: item.sizeCode,
              imageUrl: item.imageUrl,
              unitPriceVnd: item.unitPriceVnd,
              qty: item.qty,
            })),
            packagingOptionId: activePackaging?.id ?? null,
            giftNote: giftNote.trim() || null,
          }),
        },
      );

      if (cancelled) return;
      setIsPreviewLoading(false);
      if (res.ok && res.data) {
        setPreviewData(res.data);
      }
    }, 180);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [orderedSelections, activePackaging?.id, giftNote]);

  // Local fallback math while preview request is in flight or BFF offline
  const localTotals = useMemo(() => {
    const subtotalVnd = orderedSelections.reduce(
      (sum, item) => sum + item.unitPriceVnd * item.qty,
      0,
    );
    const count = orderedSelections.length;
    const comboDiscountPct = count >= 3 ? 10 : count === 2 ? 5 : 0;
    const comboDiscountVnd = Math.round((subtotalVnd * comboDiscountPct) / 100);
    const packagingPriceVnd = activePackaging?.priceVnd ?? 0;
    const totalVnd = Math.max(0, subtotalVnd - comboDiscountVnd + packagingPriceVnd);
    return {
      subtotalVnd,
      comboDiscountPct,
      comboDiscountVnd,
      packagingPriceVnd,
      totalVnd,
    };
  }, [orderedSelections, activePackaging]);

  const effectiveSubtotal = previewData?.subtotalVnd ?? localTotals.subtotalVnd;
  const effectiveDiscountPct =
    previewData?.comboDiscountPct ?? localTotals.comboDiscountPct;
  const effectiveDiscountVnd =
    previewData?.comboDiscountVnd ?? localTotals.comboDiscountVnd;
  const effectivePackagingPrice =
    previewData?.packagingPriceVnd ?? localTotals.packagingPriceVnd;
  const effectiveTotal = previewData?.totalVnd ?? localTotals.totalVnd;

  // Combo progress bar presentation (33% -> 66% -> 100% shimmer)
  const comboProgress = useMemo(() => {
    const count = orderedSelections.length;
    if (count >= 3) {
      return {
        pct: 100,
        unlockedMax: true,
        label: `Đã mở khóa ưu đãi -10% Combo ${count} Món`,
      };
    }
    if (count === 2) {
      return {
        pct: 66,
        unlockedMax: false,
        label: 'Đã mở khóa ưu đãi -5% · Thêm 1 món nữa nhận ngay -10%',
      };
    }
    return {
      pct: 33,
      unlockedMax: false,
      label: 'Phối thêm 1 thiết kế để mở khóa ưu đãi -5% Combo',
    };
  }, [orderedSelections.length]);

  const placeProductOnStage = useCallback(
    (
      product: ProductSpuDto,
      originCoords?: { clientX: number; clientY: number } | null,
      explicitVariantIdx?: number,
    ) => {
      const slot = inferProductOutfitSlot(product);
      const chosenVariantIdx =
        explicitVariantIdx ?? cardVariantIdxMap[product.id] ?? 0;
      const selection = resolveSelectionFromProduct(product, {
        slot,
        variantIndex: chosenVariantIdx,
        preferredSize: sizeProfile?.recommendedSize ?? null,
      });

      userClearedRef.current = false;
      setIsFinalized(false);
      setActivePresetId(null);
      setShareResult(null);
      setStatusFeedback(null);

      setSlots((prev) => {
        if (
          slot === OutfitSlot.ONE_PIECE &&
          (prev[OutfitSlot.TOP] || prev[OutfitSlot.BOTTOM])
        ) {
          showMutualBanner(
            'Đã chuyển sang phom Đầm liền — giữ nguyên Áo khoác & Phụ kiện',
          );
        } else if (
          (slot === OutfitSlot.TOP || slot === OutfitSlot.BOTTOM) &&
          prev[OutfitSlot.ONE_PIECE]
        ) {
          showMutualBanner(
            'Đã chuyển sang phom Phối rời — giữ nguyên Áo khoác & Phụ kiện',
          );
        }
        return applyOutfitSlotSelection(prev, selection);
      });

      if (originCoords) {
        flySeqRef.current += 1;
        setFlyOrigin({
          slot,
          key: flySeqRef.current,
          clientX: originCoords.clientX,
          clientY: originCoords.clientY,
        });
      }
    },
    [cardVariantIdxMap, showMutualBanner, sizeProfile?.recommendedSize],
  );

  const handlePickProduct = useCallback(
    (product: ProductSpuDto, triggerEl: HTMLElement | null) => {
      const rect = triggerEl?.getBoundingClientRect();
      placeProductOnStage(
        product,
        rect
          ? {
              clientX: rect.left + rect.width * 0.5,
              clientY: rect.top + rect.height * 0.5,
            }
          : null,
      );
    },
    [placeProductOnStage],
  );

  const handleDropProduct = useCallback(
    (productId: string, clientX: number, clientY: number) => {
      setDraggingProductId(null);
      const product = productById.get(productId);
      if (!product) return;
      placeProductOnStage(product, { clientX, clientY });
    },
    [placeProductOnStage, productById],
  );

  const handleRemoveSlot = useCallback((slot: OutfitSlot) => {
    setIsFinalized(false);
    setActivePresetId(null);
    setShareResult(null);
    setSlots((prev) => {
      const next = removeOutfitSlot(prev, slot);
      if (Object.keys(next).length === 0) {
        userClearedRef.current = true;
      }
      return next;
    });
  }, []);

  const handleChangeVariantOrSku = useCallback(
    (
      slot: OutfitSlot,
      product: ProductSpuDto,
      variantIndex: number,
      skuId?: string,
    ) => {
      setIsFinalized(false);
      setCardVariantIdxMap((prev) => ({ ...prev, [product.id]: variantIndex }));
      setSlots((prev) => {
        const existing = prev[slot];
        const updated = resolveSelectionFromProduct(product, {
          slot,
          variantIndex,
          preferredSkuId: skuId,
          preferredSize: skuId ? undefined : existing?.sizeCode ?? sizeProfile?.recommendedSize,
          drapeStyle: existing?.drapeStyle,
        });
        return applyOutfitSlotSelection(prev, updated);
      });
    },
    [sizeProfile?.recommendedSize],
  );

  const handleSelectPreset = useCallback(
    (presetId: OutfitPresetId) => {
      const preset = OUTFIT_PRESETS.find((item) => item.id === presetId);
      const resolved = resolvePresetSlots(
        presetId,
        products,
        sizeProfile?.recommendedSize ?? null,
      );
      userClearedRef.current = false;
      setIsFinalized(false);
      setShareResult(null);
      setStatusFeedback(null);
      setViewSide('front');
      setSlots(resolved);
      setActivePresetId(presetId);
      if (preset) {
        setLightingMode(preset.lightingMode);
      }
    },
    [products, sizeProfile?.recommendedSize],
  );

  const handleToggleOuterwearDrape = useCallback(() => {
    setIsFinalized(false);
    setSlots((prev) => {
      const outer = prev[OutfitSlot.OUTERWEAR];
      if (!outer) return prev;
      const currentDrape =
        outer.drapeStyle ?? (prev[OutfitSlot.ONE_PIECE] ? 'shoulder' : 'front');
      return {
        ...prev,
        [OutfitSlot.OUTERWEAR]: {
          ...outer,
          drapeStyle: currentDrape === 'shoulder' ? 'front' : 'shoulder',
        },
      };
    });
  }, []);

  const handleStagePinClick = useCallback((slot: OutfitSlot) => {
    const cardEl = itemCardRefs.current[slot];
    if (cardEl) {
      cardEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
    setHighlightedSlot(slot);
    if (highlightTimerRef.current !== null) {
      window.clearTimeout(highlightTimerRef.current);
    }
    highlightTimerRef.current = window.setTimeout(() => {
      setHighlightedSlot(null);
      highlightTimerRef.current = null;
    }, 1450);
  }, []);

  const handleSelectPackaging = useCallback(
    (pkg: PackagingOptionDto) => {
      setSelectedPkgId(pkg.id);
      if (pkg.priceVnd > 0 && stageRef.current) {
        const rect = stageRef.current.getBoundingClientRect();
        triggerParticleBurst(
          rect.left + rect.width * 0.5,
          rect.top + rect.height * 0.45,
          24,
        );
      }
    },
    [],
  );

  const handleSaveSizeProfile = useCallback(
    (profile: StudioSizeProfile) => {
      setSizeProfile(profile);
      setSlots((prev) => {
        const next: OutfitSlotsMap = { ...prev };
        for (const slot of OUTFIT_SLOT_ORDER) {
          const entry = next[slot];
          if (!entry) continue;
          const product = productById.get(entry.productId);
          if (!product) continue;
          const vIdx = Math.max(
            0,
            product.variants.findIndex((v) => v.id === entry.variantId),
          );
          const variant = product.variants[vIdx] ?? product.variants[0];
          const matchingSku = variant?.skus.find(
            (s) =>
              s.sizeCode.toUpperCase() === profile.recommendedSize.toUpperCase() &&
              (availabilityMap[s.id]?.inStock ?? s.inStock),
          );
          if (matchingSku) {
            next[slot] = {
              ...entry,
              skuId: matchingSku.id,
              sizeCode: matchingSku.sizeCode,
              unitPriceVnd: matchingSku.salePriceVnd ?? entry.unitPriceVnd,
            };
          }
        }
        return next;
      });
      showAtelierToast(
        `Đã lưu hồ sơ số đo — gợi ý Size ${profile.recommendedSize} cho bộ phối.`,
        'success',
      );
    },
    [availabilityMap, productById],
  );

  const handleOpenTryOnOutfit = useCallback(() => {
    if (orderedSelections.length === 0) return;
    const upperSel = slots[OutfitSlot.TOP] ?? null;
    const lowerSel = slots[OutfitSlot.BOTTOM] ?? null;
    const onePieceSel = slots[OutfitSlot.ONE_PIECE] ?? null;
    const outerwearSel = slots[OutfitSlot.OUTERWEAR] ?? null;

    const toRef = (sel: OutfitSlotSelection | null): OutfitTryOnItemRef | null =>
      sel
        ? {
            productId: sel.productId,
            variantId: sel.variantId,
            skuId: sel.skuId,
            slug: sel.slug,
            productName: sel.productName,
            imageUrl: sel.imageUrl,
          }
        : null;

    onOpenTryOn?.({
      mode: TryOnMode.MIX_MATCH_OUTFIT,
      upper: toRef(upperSel),
      lower: toRef(lowerSel),
      onePiece: toRef(onePieceSel),
      outerwear: toRef(outerwearSel),
    });
  }, [onOpenTryOn, orderedSelections.length, slots]);

  const handleSaveAndShare = useCallback(async () => {
    if (orderedSelections.length === 0 || isSavingShare) return;
    setIsSavingShare(true);
    setStatusFeedback(null);

    const compositeDataUrl = await renderOutfitCompositeSnapshot({
      slots,
      packagingName: activePackaging?.name,
      packagingSwatchHex: activePackaging?.swatchHex,
      isWrapped: false,
      giftNote,
    });
    if (compositeDataUrl) {
      setSnapshotUrl(compositeDataUrl);
    }

    const title = orderedSelections
      .map((s) => s.productName.split(' ').slice(0, 3).join(' '))
      .join(' + ')
      .slice(0, 110);

    const res = await apiFetch<SavedOutfitDto>('/bff/v1/storefront/outfits', {
      method: 'POST',
      headers: getGuestHeader(),
      skipAuthRefresh: true,
      body: JSON.stringify({
        title: title || 'Set đồ Tầm Xuân Atelier',
        slots: orderedSelections.map((item) => ({
          slot: item.slot,
          productId: item.productId,
          variantId: item.variantId,
          skuId: item.skuId,
          slug: item.slug,
          productName: item.productName,
          colorName: item.colorName,
          colorHex: item.colorHex,
          sizeCode: item.sizeCode,
          imageUrl: item.imageUrl,
          unitPriceVnd: item.unitPriceVnd,
          qty: item.qty,
        })),
        packagingOptionId: activePackaging?.id ?? null,
        giftNote: giftNote.trim() || null,
        previewUrl: null,
      }),
    });

    const origin = typeof window !== 'undefined' ? window.location.origin : '';
    let shareCode = '';
    let shareUrl = '';

    if (res.ok && res.data) {
      shareCode = res.data.shareCode;
      const path = `/phoi-do?share=${encodeURIComponent(shareCode)}`;
      shareUrl = origin ? `${origin}${path}` : path;
    } else {
      // Graceful localStorage fallback so guest users still keep their curated outfit
      shareCode = `TX-${Date.now().toString(36).toUpperCase().slice(-6)}`;
      const path = `/phoi-do?share=${encodeURIComponent(shareCode)}`;
      shareUrl = origin ? `${origin}${path}` : path;
      try {
        const existingRaw = window.localStorage.getItem(LOCAL_SAVED_OUTFITS_KEY);
        const list = existingRaw ? (JSON.parse(existingRaw) as unknown[]) : [];
        const updated = [
          {
            shareCode,
            title: title || 'Set đồ Tầm Xuân Atelier',
            slots: orderedSelections,
            packagingOptionId: activePackaging?.id ?? null,
            giftNote: giftNote.trim() || null,
            savedAt: new Date().toISOString(),
          },
          ...list.slice(0, 9),
        ];
        window.localStorage.setItem(LOCAL_SAVED_OUTFITS_KEY, JSON.stringify(updated));
      } catch {
        // Ignore storage write errors
      }
    }

    let copied = false;
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(shareUrl);
        copied = true;
      } catch {
        copied = false;
      }
    }

    setIsSavingShare(false);
    setShareResult({ shareCode, shareUrl, copied });
    const toastMessage = copied
      ? `Đã lưu bộ phối #${shareCode} và sao chép liên kết chia sẻ.`
      : `Đã lưu bộ phối #${shareCode} sẵn sàng chia sẻ.`;
    setStatusFeedback(toastMessage);
    showAtelierToast(toastMessage, 'success');
  }, [activePackaging, giftNote, isSavingShare, orderedSelections, slots]);

  const handleCopyShareLink = useCallback(async () => {
    if (!shareResult) return;
    try {
      await navigator.clipboard.writeText(shareResult.shareUrl);
      setShareResult((prev) => (prev ? { ...prev, copied: true } : prev));
      showAtelierToast('Đã sao chép liên kết bộ phối.', 'gold');
    } catch {
      setStatusFeedback(`Sao chép thủ công: ${shareResult.shareUrl}`);
    }
  }, [shareResult]);

  const handleAddBundleToCart = useCallback(async () => {
    if (orderedSelections.length === 0 || isAddingBundle) return;

    // Verify stock availability before starting wrap ritual
    const outOfStockItem = orderedSelections.find((sel) => {
      const info = availabilityMap[sel.skuId];
      return info ? !info.inStock || info.availableQty === 0 : false;
    });
    if (outOfStockItem) {
      const msg = `Thiết kế “${outOfStockItem.productName}” (Size ${outOfStockItem.sizeCode}) tạm hết hàng — vui lòng chọn cỡ khác.`;
      setStatusFeedback(msg);
      showAtelierToast(msg, 'warning');
      return;
    }

    setIsAddingBundle(true);
    setLoupeEnabled(false);
    setViewSide('front');
    setStatusFeedback(null);
    setIsFinalized(true);

    if (stageRef.current) {
      const rect = stageRef.current.getBoundingClientRect();
      triggerParticleBurst(
        rect.left + rect.width * 0.5,
        rect.top + rect.height * 0.44,
        42,
      );
    }

    const ritualTimer = new Promise<void>((resolve) => {
      window.setTimeout(resolve, 900);
    });

    const snapshotPromise = renderOutfitCompositeSnapshot({
      slots,
      packagingName: activePackaging?.name,
      packagingSwatchHex: activePackaging?.swatchHex,
      isWrapped: true,
      giftNote,
    });

    const bundleRequest = apiFetch<CartDto>(
      '/bff/v1/storefront/cart/outfit-bundle',
      {
        method: 'POST',
        headers: getGuestHeader(),
        body: JSON.stringify({
          items: orderedSelections.map((sel) => ({
            skuId: sel.skuId,
            productId: sel.productId,
            variantId: sel.variantId,
            qty: sel.qty,
            slot: sel.slot,
            fromAiTryon: false,
          })),
          packagingOptionId: activePackaging?.id ?? null,
          giftNote: giftNote.trim() || null,
        }),
      },
    );

    const [, snapshotData, res] = await Promise.all([
      ritualTimer,
      snapshotPromise,
      bundleRequest,
    ]);

    if (snapshotData) {
      setSnapshotUrl(snapshotData);
    }

    setIsAddingBundle(false);
    if (res.ok) {
      if (res.data) {
        emitCartUpdated(res.data);
      } else {
        refreshCartCount();
      }
      const successMsg =
        effectiveDiscountPct > 0
          ? `Đã thêm bộ ${orderedSelections.length} món vào giỏ kèm ưu đãi Combo -${effectiveDiscountPct}%.`
          : 'Đã thêm bộ trang phục vào giỏ hàng Atelier.';
      setStatusFeedback(successMsg);
      showAtelierToast(successMsg, 'success');
      onOpenBag?.();
    } else {
      setIsFinalized(false);
      const errMsg =
        res.error?.message || 'Không thể thêm bộ đồ vào giỏ lúc này.';
      setStatusFeedback(errMsg);
      showAtelierToast(errMsg, 'error');
    }
  }, [
    activePackaging,
    availabilityMap,
    effectiveDiscountPct,
    giftNote,
    isAddingBundle,
    onOpenBag,
    orderedSelections,
    slots,
  ]);

  const handleReset = useCallback(() => {
    userClearedRef.current = true;
    setSlots({});
    setActivePresetId(null);
    setIsFinalized(false);
    setSnapshotUrl(null);
    setShareResult(null);
    setStatusFeedback(null);
    setMutualBanner(null);
    setLoupeEnabled(false);
    setViewSide('front');
  }, []);

  return (
    <section
      id="build"
      data-nav-theme="light"
      className={`build ${styles.studioSection} relative pt-10 pb-28 lg:py-16`}
    >
      <div className="mx-auto max-w-[1400px] px-4 sm:px-6 lg:px-8">
        {restoredTitle ? (
          <div className="mb-5 flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-[#B08A4A]/40 bg-[#FBF7EF] px-4 py-2.5 text-xs text-[#2B2019]">
            <span>
              Đang xem bộ phối được chia sẻ: <strong>{restoredTitle}</strong>
            </span>
            <button
              type="button"
              onClick={() => setRestoredTitle(null)}
              className="text-[11px] tracking-[0.16em] uppercase text-[#8A672C] underline"
            >
              Ẩn thông báo
            </button>
          </div>
        ) : null}

        {/* 3-Column Quiet Luxury Outfit Studio Grid */}
        <div className={styles.studioGrid}>
          {/* LEFT COLUMN: Luxury Copy, 6 Category Pills, Stylist Harmony Banner, 2-Col 3:4 Cards, Size Profile */}
          <div className="build__left flex flex-col">
            <p className="eyebrow">XƯỞNG PHỐI ĐỒ CÁ NHÂN · MIX &amp; MATCH</p>
            <h2
              className="h2 !mt-2.5 !text-[clamp(30px,3.1vw,48px)] !leading-[1.03] text-[#1C1410]"
              style={{ textWrap: 'balance' }}
            >
              Bạn chọn dáng,
              <br />
              <em>xưởng phối thành bộ.</em>
            </h2>

            {/* 6 Filter Pills */}
            <div
              role="tablist"
              aria-label="Lọc thiết kế theo nhóm trang phục"
              className="mt-4 flex flex-wrap gap-1.5"
            >
              <button
                type="button"
                role="tab"
                data-testid="studio-tab-ALL"
                aria-selected={activeSlotTab === 'ALL'}
                onClick={() => setActiveSlotTab('ALL')}
                className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[11px] font-medium tracking-[0.08em] uppercase transition-all ${
                  activeSlotTab === 'ALL'
                    ? 'bg-[#1C1410] text-[#FBF7EF] shadow-sm'
                    : 'border border-[#B08A4A]/30 bg-[#FAF5EC] text-[#2B2019] hover:border-[#B08A4A] hover:bg-white'
                }`}
              >
                <span>TẤT CẢ ({products.length})</span>
                {activeSlotTab === 'ALL' ? (
                  <span
                    aria-hidden="true"
                    className="h-1.5 w-1.5 rounded-full bg-[#B08A4A]"
                  />
                ) : null}
              </button>

              {OUTFIT_SLOT_ORDER.map((slot) => {
                const active = activeSlotTab === slot;
                const filled = Boolean(slots[slot]);
                return (
                  <button
                    key={slot}
                    type="button"
                    role="tab"
                    data-testid={`studio-tab-${slot}`}
                    aria-selected={active}
                    onClick={() => setActiveSlotTab(slot)}
                    className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[11px] font-medium tracking-[0.06em] transition-all ${
                      active
                        ? 'bg-[#1C1410] text-[#FBF7EF] shadow-sm'
                        : 'border border-[#B08A4A]/30 bg-[#FAF5EC] text-[#2B2019] hover:border-[#B08A4A] hover:bg-white'
                    }`}
                  >
                    <span>{OUTFIT_SLOT_META[slot].shortLabel}</span>
                    {active ? (
                      <span
                        aria-hidden="true"
                        className="h-1.5 w-1.5 rounded-full bg-[#B08A4A]"
                      />
                    ) : filled ? (
                      <span
                        aria-hidden="true"
                        className="h-1.5 w-1.5 rounded-full bg-[#B08A4A]/70"
                      />
                    ) : null}
                  </button>
                );
              })}
            </div>

            {/* Stylist Harmony Banner */}
            <button
              type="button"
              data-testid="stylist-harmony-banner"
              aria-pressed={harmonyMode}
              onClick={() => setHarmonyMode((prev) => !prev)}
              className={`${styles.harmonyBanner} ${
                harmonyMode ? styles.harmonyBannerActive : ''
              } mt-3 flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-[12px] leading-snug text-[#2B2019]`}
            >
              <span className="min-w-0 flex-1">
                <span className="mr-1 text-[#8A672C]" aria-hidden="true">
                  ✦
                </span>
                Gợi ý phối hợp sắc độ cùng{' '}
                <strong className="font-semibold text-[#1C1410]">
                  {harmonyResult.anchorLabel}
                </strong>{' '}
                <span className="text-[#5C4B3E]">
                  ({harmonyResult.anchorColor})
                </span>
              </span>
              <span
                className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium tracking-[0.08em] uppercase ${
                  harmonyMode
                    ? 'bg-[#1C1410] text-[#EBCF8F]'
                    : 'bg-[#FBF7EF]/85 text-[#8A672C]'
                }`}
              >
                {harmonyMode ? 'Đang lọc' : 'Ưu tiên'}
              </span>
            </button>

            {/* Mutual Exclusion Subtle Toast Banner */}
            {mutualBanner ? (
              <div
                role="status"
                data-testid="studio-mutual-exclusion-banner"
                className="mt-2.5 rounded-[10px] border border-[#B08A4A]/40 bg-[#FFFDF8] px-3 py-2 text-[11.5px] text-[#5C4B3E] shadow-xs"
              >
                {mutualBanner}
              </div>
            ) : null}

            {/* 2-Column 3:4 Portrait Wardrobe Grid */}
            <ul
              data-lenis-prevent=""
              className={`${styles.wardrobeScroll} mt-3.5 grid max-h-[540px] grid-cols-2 gap-3.5 overflow-y-auto pr-1.5 pb-1`}
            >
              {visibleProducts.length === 0 ? (
                <li className="col-span-2 rounded-2xl border border-dashed border-[#B08A4A]/35 bg-[#FAF5EC] px-4 py-8 text-center text-xs text-[#7A6A5B]">
                  Chưa có thiết kế trong nhóm này — chọn nhóm khác hoặc nhấn TẤT CẢ.
                </li>
              ) : (
                visibleProducts.map((product) => {
                  const slot = inferProductOutfitSlot(product);
                  const selectedInSlot = slots[slot]?.productId === product.id;
                  const activeVarIdx = cardVariantIdxMap[product.id] ?? 0;
                  const activeVariant =
                    product.variants[activeVarIdx] ?? product.variants[0];
                  const { flatUrl, lookbookUrl } = getPrimaryVariantImage(
                    product,
                    activeVarIdx,
                  );
                  const thumbSrc =
                    activeVariant?.studioLayerUrl ||
                    activeVariant?.tryonFlatPreviewUrl ||
                    flatUrl ||
                    lookbookUrl;
                  const isCutout = isCutoutImageUrl(thumbSrc);
                  const isHarmonyPick =
                    harmonyMode && !selectedInSlot && harmonyTopIds.has(product.id);

                  return (
                    <li
                      key={product.id}
                      draggable
                      onDragStart={(e) => {
                        e.dataTransfer.setData('text/plain', product.id);
                        e.dataTransfer.setData(
                          'application/x-atelier-product-id',
                          product.id,
                        );
                        e.dataTransfer.effectAllowed = 'copy';
                        setDraggingProductId(product.id);
                      }}
                      onDragEnd={() => setDraggingProductId(null)}
                      data-testid={`studio-product-card-${product.slug}`}
                      className={`${styles.garmentCard} ${
                        selectedInSlot ? styles.garmentCardActive : ''
                      } ${isHarmonyPick ? styles.garmentCardHarmony : ''} cursor-grab p-1.5 active:cursor-grabbing`}
                    >
                      {/* Top 3:4 Warm Studio Frame */}
                      <div
                        role="button"
                        tabIndex={0}
                        onClick={(e) => handlePickProduct(product, e.currentTarget)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            handlePickProduct(product, e.currentTarget);
                          }
                        }}
                        data-cursor="view"
                        data-cursor-label={selectedInSlot ? 'ĐỔI' : 'PHỐI'}
                        className={`${styles.garmentFrame} group cursor-pointer focus-visible:outline-2 focus-visible:outline-[#B08A4A]`}
                      >
                        <img
                          src={thumbSrc}
                          alt={product.name}
                          crossOrigin={
                            thumbSrc && /^https?:\/\/(127\.0\.0\.1|localhost):9000\//i.test(thumbSrc)
                              ? 'anonymous'
                              : undefined
                          }
                          decoding="async"
                          draggable={false}
                          className={`h-full w-full transition-transform duration-300 group-hover:scale-[1.03] ${
                            isCutout ? 'object-contain p-2' : 'object-cover'
                          }`}
                        />

                        {/* Slot micro-tag at top-left */}
                        <span className="pointer-events-none absolute top-2 left-2 rounded-full bg-[#FBF7EF]/88 px-2 py-0.5 text-[9px] font-medium tracking-[0.14em] uppercase text-[#8A672C] backdrop-blur-xs">
                          {OUTFIT_SLOT_META[slot].shortLabel}
                        </span>

                        {isHarmonyPick ? (
                          <span className="pointer-events-none absolute top-2 right-2 rounded-full bg-[#1C1410]/85 px-1.5 py-0.5 text-[9px] font-medium text-[#EBCF8F]">
                            ✦ Hợp tông
                          </span>
                        ) : null}

                        {/* Interactive mini color swatch dots at bottom-left */}
                        {product.variants.length > 0 ? (
                          <div
                            className="absolute bottom-2 left-2 z-10 flex items-center gap-1 rounded-full border border-[#B08A4A]/25 bg-[#FBF7EF]/88 px-1.5 py-1 backdrop-blur-xs"
                            onClick={(e) => e.stopPropagation()}
                          >
                            {product.variants.slice(0, 4).map((variant, vIdx) => {
                              const isActiveColor = vIdx === activeVarIdx;
                              return (
                                <button
                                  key={variant.id}
                                  type="button"
                                  title={variant.colorName}
                                  aria-label={`Xem màu ${variant.colorName} của ${product.name}`}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setCardVariantIdxMap((prev) => ({
                                      ...prev,
                                      [product.id]: vIdx,
                                    }));
                                    if (selectedInSlot) {
                                      handleChangeVariantOrSku(slot, product, vIdx);
                                    }
                                  }}
                                  className={`h-3 w-3 rounded-full border transition-transform ${
                                    isActiveColor
                                      ? 'scale-115 border-[#1C1410] ring-1 ring-[#B08A4A]'
                                      : 'border-black/20 hover:scale-110'
                                  }`}
                                  style={{ backgroundColor: variant.colorHex }}
                                />
                              );
                            })}
                          </div>
                        ) : null}
                      </div>

                      {/* Card Footer: 2-line balanced name, price & 28x28 circular + / ✓ button */}
                      <div className="flex flex-1 flex-col justify-between px-1.5 pt-2 pb-1">
                        <p className="line-clamp-2 min-h-[34px] text-[13px] leading-[1.32] font-semibold text-[#1C1410]">
                          {product.name}
                        </p>

                        <div className="mt-2 flex items-center justify-between gap-2">
                          <span className="text-[12.5px] font-medium text-[#5C4B3E]">
                            {FORMAT_VND(product.minPriceVnd)}
                          </span>

                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              if (selectedInSlot) {
                                handleRemoveSlot(slot);
                              } else {
                                handlePickProduct(product, e.currentTarget);
                              }
                            }}
                            aria-label={
                              selectedInSlot
                                ? `Bỏ ${product.name} khỏi bộ phối`
                                : `Thêm ${product.name} vào bộ phối`
                            }
                            aria-pressed={selectedInSlot}
                            className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-sm font-medium transition-all ${
                              selectedInSlot
                                ? 'bg-[#B08A4A] text-[#FFFDF8] shadow-xs hover:bg-[#8A672C]'
                                : 'bg-[#1C1410] text-[#FBF7EF] hover:bg-[#B08A4A] hover:text-[#1C1410]'
                            }`}
                          >
                            {selectedInSlot ? '✓' : '+'}
                          </button>
                        </div>
                      </div>
                    </li>
                  );
                })
              )}
            </ul>

            {/* Bottom-Left ⚯ HỒ SƠ SỐ ĐO Trigger Button */}
            <button
              type="button"
              data-testid="studio-size-profile-btn"
              onClick={() => setSizeModalOpen(true)}
              className="mt-3.5 flex w-full items-center justify-between gap-3 rounded-[14px] border border-[#B08A4A]/38 bg-[#FAF5EC] px-4 py-3 text-left transition-all hover:border-[#B08A4A] hover:bg-[#FFFDF8] hover:shadow-xs"
            >
              <span className="flex items-center gap-2 text-[12px] font-medium tracking-[0.08em] text-[#1C1410]">
                <span className="text-base text-[#8A672C]" aria-hidden="true">
                  ⚯
                </span>
                {sizeProfile ? (
                  <span>
                    Số đo của bạn ·{' '}
                    <strong className="font-semibold text-[#8A672C]">
                      Gợi ý Size {sizeProfile.recommendedSize}
                    </strong>
                  </span>
                ) : (
                  <span className="uppercase tracking-[0.14em]">
                    HỒ SƠ SỐ ĐO
                  </span>
                )}
              </span>
              <span className="shrink-0 text-[11px] font-medium text-[#8A672C] underline underline-offset-2">
                {sizeProfile ? 'Chỉnh sửa' : 'Tư vấn cỡ'}
              </span>
            </button>
          </div>

          {/* CENTER COLUMN: Interactive Atelier Mannequin Stage */}
          <GarmentLayerStage
            slots={slots}
            activePackaging={activePackaging}
            isFinalized={isFinalized}
            flyOrigin={flyOrigin}
            snapshotDataUrl={snapshotUrl}
            activePresetId={activePresetId}
            lightingMode={lightingMode}
            viewSide={viewSide}
            loupeEnabled={loupeEnabled}
            isDragOver={Boolean(draggingProductId)}
            onSelectPreset={handleSelectPreset}
            onChangeLighting={setLightingMode}
            onToggleViewSide={() =>
              setViewSide((prev) => (prev === 'front' ? 'back' : 'front'))
            }
            onToggleLoupe={() => setLoupeEnabled((prev) => !prev)}
            onTriggerTryOn={handleOpenTryOnOutfit}
            onPinClick={handleStagePinClick}
            onToggleOuterwearDrape={handleToggleOuterwearDrape}
            onRemoveSlot={handleRemoveSlot}
            onDropProduct={handleDropProduct}
            stageContainerRef={stageRef}
          />

          {/* RIGHT COLUMN: Selected Items, Combo Progress, Packaging, -4deg Gift Card, Totals & CTA */}
          <aside
            className={`build__side ${styles.configPanel} flex flex-col gap-4 p-5`}
          >
            {/* Header */}
            <div className="flex items-center justify-between gap-2">
              <p className="text-[11px] font-semibold tracking-[0.2em] uppercase text-[#8A672C]">
                BỘ PHỐI CỦA BẠN · {orderedSelections.length} MÓN
              </p>
              {orderedSelections.length > 0 ? (
                <button
                  type="button"
                  data-testid="studio-reset-btn"
                  onClick={handleReset}
                  className="text-[11px] font-medium tracking-[0.14em] uppercase text-[#7A6A5B] underline underline-offset-2 transition-colors hover:text-[#1C1410]"
                >
                  LÀM LẠI
                </button>
              ) : null}
            </div>

            {/* Combo Unlock Progress Bar */}
            <div
              data-testid="combo-unlock-bar"
              data-combo-pct={comboProgress.pct}
              className="rounded-2xl border border-[#B08A4A]/28 bg-[#F4EBDA]/65 px-3.5 py-2.5"
            >
              <div className="flex items-center justify-between gap-2 text-[11.5px] leading-snug text-[#2B2019]">
                <span className={comboProgress.unlockedMax ? 'font-semibold text-[#1C1410]' : ''}>
                  {comboProgress.unlockedMax ? '✦ ' : ''}
                  {comboProgress.label}
                </span>
                <span className="shrink-0 font-mono text-[10.5px] font-semibold text-[#8A672C]">
                  {comboProgress.pct}%
                </span>
              </div>
              <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-[#E5D7BF]">
                <div
                  className={`h-full rounded-full ${
                    comboProgress.unlockedMax
                      ? styles.comboFillUnlocked
                      : styles.comboFillBase
                  }`}
                  style={{ width: `${comboProgress.pct}%` }}
                />
              </div>
            </div>

            {/* Selected Garment Config Cards */}
            {orderedSelections.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-[#B08A4A]/35 bg-white/70 px-4 py-6 text-center">
                <p className="font-editorial text-xl italic text-[#5C4B3E]">
                  Chọn thiết kế bên trái hoặc nhấn bộ phối gợi ý trên sân khấu.
                </p>
                <p className="mt-1 text-[11.5px] text-[#7A6A5B]">
                  Phối từ 2 món giảm ngay -5%, từ 3 món nhận ưu đãi -10% Combo Atelier.
                </p>
              </div>
            ) : (
              <ul className="space-y-2.5">
                {orderedSelections.map((sel) => {
                  const product = productById.get(sel.productId);
                  const currentVariantIdx = product
                    ? Math.max(
                        0,
                        product.variants.findIndex((v) => v.id === sel.variantId),
                      )
                    : 0;
                  const currentVariant = product?.variants[currentVariantIdx];
                  const canonicalSkus = currentVariant
                    ? sortSkusCanonically(currentVariant.skus)
                    : [];
                  const stockInfo = availabilityMap[sel.skuId];
                  const isLowStock =
                    Boolean(stockInfo) &&
                    stockInfo!.availableQty >= 1 &&
                    stockInfo!.availableQty <= 3;
                  const isOutSelected =
                    Boolean(stockInfo) &&
                    (!stockInfo!.inStock || stockInfo!.availableQty === 0);
                  const isHighlighted = highlightedSlot === sel.slot;

                  return (
                    <li
                      key={`${sel.slot}-${sel.productId}`}
                      ref={(el) => {
                        itemCardRefs.current[sel.slot] = el;
                      }}
                      data-testid={`studio-item-card-${sel.slot}`}
                      className={`rounded-[14px] border border-[#B08A4A]/24 bg-white p-3 transition-all ${
                        isHighlighted ? styles.itemCardPulse : ''
                      }`}
                    >
                      {/* Row 1: Product Name + Price + Remove Button */}
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <span className="block text-[9.5px] font-medium tracking-[0.16em] uppercase text-[#8A672C]">
                            {OUTFIT_SLOT_META[sel.slot].shortLabel} · {sel.colorName}
                          </span>
                          <p className="mt-0.5 line-clamp-2 font-editorial text-[16px] leading-tight font-medium text-[#1C1410]">
                            {sel.productName}
                          </p>
                        </div>

                        <div className="flex shrink-0 items-center gap-1.5">
                          <span className="font-editorial text-[15px] font-semibold text-[#2B2019]">
                            {FORMAT_VND(sel.unitPriceVnd)}
                          </span>
                          <button
                            type="button"
                            onClick={() => handleRemoveSlot(sel.slot)}
                            aria-label={`Bỏ ${sel.productName}`}
                            className="flex h-6 w-6 items-center justify-center rounded-full text-sm text-[#7A6A5B] transition-colors hover:bg-[#F4EBDA] hover:text-[#1C1410]"
                          >
                            ×
                          </button>
                        </div>
                      </div>

                      {/* Row 2: Canonical XS · S · M · L · XL Pills (left) + Color Dots (right) */}
                      <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2">
                        {product && canonicalSkus.length > 0 ? (
                          <div
                            className="flex flex-wrap items-center gap-1"
                            data-testid={`studio-size-pills-${sel.slot}`}
                          >
                            {canonicalSkus.map((sku) => {
                              const skuAvail = availabilityMap[sku.id];
                              const isOut = skuAvail
                                ? !skuAvail.inStock || skuAvail.availableQty === 0
                                : !sku.inStock;
                              const isSelected = sku.id === sel.skuId;
                              return (
                                <button
                                  key={sku.id}
                                  type="button"
                                  data-size-code={sku.sizeCode}
                                  disabled={isOut}
                                  onClick={() =>
                                    handleChangeVariantOrSku(
                                      sel.slot,
                                      product,
                                      currentVariantIdx,
                                      sku.id,
                                    )
                                  }
                                  className={`min-w-[28px] rounded-full border px-2 py-0.5 text-[10.5px] font-medium tracking-[0.06em] transition-colors ${
                                    isSelected
                                      ? 'border-[#1C1410] bg-[#1C1410] text-[#FBF7EF]'
                                      : isOut
                                        ? 'cursor-not-allowed border-black/10 text-[#9B8C7D] line-through opacity-35'
                                        : 'border-[#B08A4A]/35 bg-[#FBF7EF] text-[#2B2019] hover:border-[#8A672C]'
                                  }`}
                                >
                                  {sku.sizeCode}
                                </button>
                              );
                            })}
                          </div>
                        ) : (
                          <span className="rounded-full border border-[#B08A4A]/35 bg-[#FBF7EF] px-2 py-0.5 text-[10.5px] font-medium text-[#2B2019]">
                            {sel.sizeCode}
                          </span>
                        )}

                        {product && product.variants.length > 0 ? (
                          <div className="flex items-center gap-1.5">
                            {product.variants.map((variant, vIdx) => (
                              <button
                                key={variant.id}
                                type="button"
                                title={variant.colorName}
                                aria-label={`Đổi sang màu ${variant.colorName}`}
                                onClick={() =>
                                  handleChangeVariantOrSku(sel.slot, product, vIdx)
                                }
                                className={`h-4 w-4 rounded-full border transition-transform ${
                                  vIdx === currentVariantIdx
                                    ? 'scale-110 border-[#1C1410] ring-1 ring-[#B08A4A]'
                                    : 'border-black/20 hover:scale-110'
                                }`}
                                style={{ backgroundColor: variant.colorHex }}
                              />
                            ))}
                          </div>
                        ) : null}
                      </div>

                      {/* Real Stock Alert (Amber <= 3 or Out of Stock) */}
                      {isLowStock || stockInfo?.lowStockWarning ? (
                        <p className="mt-2 inline-flex items-center gap-1 rounded-full bg-amber-100/90 px-2.5 py-0.5 text-[10.5px] font-medium text-amber-900">
                          Chỉ còn {stockInfo!.availableQty} chiếc
                        </p>
                      ) : isOutSelected ? (
                        <p className="mt-2 inline-flex items-center gap-1 rounded-full bg-red-100 px-2.5 py-0.5 text-[10.5px] font-medium text-red-900">
                          Tạm hết hàng cỡ {sel.sizeCode}
                        </p>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}

            {/* Signature Packaging Selector with Real 44x44 Thumbnails */}
            <div className="border-t border-[#B08A4A]/20 pt-3.5">
              <p className="mb-2.5 text-[11px] font-medium tracking-[0.2em] uppercase text-[#8A672C]">
                Đóng gói Signature
              </p>
              <div
                role="radiogroup"
                aria-label="Chọn kiểu đóng gói Signature"
                className="space-y-2"
              >
                {packagingOptions.map((pkg) => {
                  const selected = pkg.id === activePackaging?.id;
                  return (
                    <button
                      key={pkg.id}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      data-testid={`studio-packaging-${pkg.code}`}
                      onClick={() => handleSelectPackaging(pkg)}
                      className={`flex w-full items-center gap-3 rounded-xl border p-2 text-left transition-all ${
                        selected
                          ? 'border-[#B08A4A] bg-[#FFFDF8] ring-1 ring-[#B08A4A]/45 shadow-xs'
                          : 'border-[#B08A4A]/22 bg-white/75 hover:border-[#B08A4A]/55 hover:bg-white'
                      }`}
                    >
                      <PackagingThumbnail pkg={pkg} />

                      <div className="min-w-0 flex-1">
                        <span className="block text-[12.5px] leading-snug font-medium text-[#1C1410]">
                          {pkg.name}
                        </span>
                        <span className="mt-0.5 block text-[11px] font-medium text-[#8A672C]">
                          {pkg.priceVnd > 0
                            ? `+${FORMAT_VND(pkg.priceVnd)}`
                            : 'Miễn phí'}
                        </span>
                      </div>

                      <span
                        aria-hidden="true"
                        className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${
                          selected
                            ? 'border-[#1C1410] bg-[#1C1410]'
                            : 'border-[#B08A4A]/45 bg-transparent'
                        }`}
                      >
                        {selected ? (
                          <span className="h-1.5 w-1.5 rounded-full bg-[#EBCF8F]" />
                        ) : null}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* -4deg Handwritten Dancing Script Gift Card */}
            <div className="border-t border-[#B08A4A]/20 pt-3.5">
              <StudioGiftCard value={giftNote} onChange={setGiftNote} />
            </div>

            {/* Financial Summary Breakdown */}
            <div className="space-y-1.5 border-t border-[#B08A4A]/20 pt-3.5 text-[12.5px] text-[#5C4B3E]">
              <div className="flex justify-between gap-2">
                <span>Tạm tính ({orderedSelections.length} thiết kế)</span>
                <span className="font-medium text-[#2B2019]">
                  {FORMAT_VND(effectiveSubtotal)}
                </span>
              </div>

              {orderedSelections.length >= 2 && effectiveDiscountPct > 0 ? (
                <div className="flex justify-between gap-2 font-medium text-[#8A672C]">
                  <span>Ưu đãi Combo (−{effectiveDiscountPct}%)</span>
                  <span>−{FORMAT_VND(effectiveDiscountVnd)}</span>
                </div>
              ) : null}

              <div className="flex justify-between gap-2">
                <span>Đóng gói Signature</span>
                <span className="font-medium text-[#2B2019]">
                  {effectivePackagingPrice > 0
                    ? `+${FORMAT_VND(effectivePackagingPrice)}`
                    : 'Miễn phí'}
                </span>
              </div>

              <div className="flex items-baseline justify-between gap-2 pt-2.5">
                <span className="text-[10.5px] font-semibold tracking-[0.18em] uppercase text-[#6B5B4C]">
                  TỔNG BỘ PHỐI{isPreviewLoading ? ' · ...' : ''}
                </span>
                <div className="flex items-center gap-2">
                  <b className="font-editorial text-[28px] leading-none font-semibold text-[#1C1410] xl:text-[32px]">
                    {orderedSelections.length > 0 ? FORMAT_VND(effectiveTotal) : '—'}
                  </b>
                  {orderedSelections.length >= 2 && effectiveDiscountPct > 0 ? (
                    <span className="rounded-full bg-[#1C1410] px-2 py-0.5 text-[10px] font-semibold text-[#EBCF8F]">
                      -{effectiveDiscountPct}%
                    </span>
                  ) : null}
                </div>
              </div>
            </div>

            {/* Action Bar: Circular 48x48 ♡ Save/Share + Primary Gold THÊM CẢ BỘ VÀO GIỎ */}
            <div className="flex items-center gap-2.5 pt-1">
              <button
                type="button"
                data-testid="studio-save-share-btn"
                disabled={orderedSelections.length === 0 || isSavingShare}
                onClick={() => void handleSaveAndShare()}
                aria-label="Lưu và chia sẻ bộ phối"
                title="Lưu & chia sẻ bộ phối"
                className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full border border-[#B08A4A]/55 bg-white text-xl text-[#8A672C] transition-all hover:border-[#1C1410] hover:bg-[#1C1410] hover:text-[#EBCF8F] disabled:cursor-not-allowed disabled:opacity-45"
              >
                {isSavingShare ? '…' : shareResult ? '♥' : '♡'}
              </button>

              <button
                type="button"
                data-testid="studio-add-bundle-btn"
                disabled={orderedSelections.length === 0 || isAddingBundle}
                onClick={() => void handleAddBundleToCart()}
                className="btn btn--gold h-12 flex-1 !px-5 !py-0 !text-[12px] !font-medium !tracking-[0.14em] disabled:cursor-not-allowed disabled:opacity-45"
              >
                {isAddingBundle
                  ? 'Đang đóng hộp bộ phối...'
                  : 'THÊM CẢ BỘ VÀO GIỎ'}
              </button>
            </div>

            {/* Share Result Strip */}
            {shareResult ? (
              <div
                data-testid="studio-share-result"
                className="rounded-2xl border border-[#B08A4A]/40 bg-white p-3 text-xs"
              >
                <p className="text-[10px] font-medium tracking-[0.18em] uppercase text-[#8A672C]">
                  Liên kết chia sẻ · #{shareResult.shareCode}
                </p>
                <div className="mt-1.5 flex items-center gap-2">
                  <input
                    type="text"
                    readOnly
                    value={shareResult.shareUrl}
                    aria-label="Đường dẫn chia sẻ bộ phối"
                    className="min-w-0 flex-1 rounded-lg border border-[#B08A4A]/30 bg-[#FBF7EF] px-2.5 py-1.5 font-mono text-[11px] text-[#2B2019]"
                  />
                  <button
                    type="button"
                    onClick={() => void handleCopyShareLink()}
                    className="shrink-0 rounded-lg bg-[#1C1410] px-3 py-1.5 text-[10px] tracking-[0.14em] uppercase text-[#EBCF8F]"
                  >
                    {shareResult.copied ? 'Đã chép' : 'Sao chép'}
                  </button>
                </div>
              </div>
            ) : null}

            {statusFeedback ? (
              <p
                role="status"
                data-testid="studio-status-feedback"
                className="rounded-xl border border-[#B08A4A]/35 bg-[#F4EBDA]/80 px-3 py-2 text-xs text-[#2B2019]"
              >
                {statusFeedback}
              </p>
            ) : null}
          </aside>
        </div>
      </div>

      {/* Responsive Mobile (< 1024px) Sticky Bottom Summary Bar */}
      <div
        data-testid="studio-mobile-summary-bar"
        className="fixed inset-x-0 bottom-0 z-[65] flex items-center justify-between gap-3 border-t border-[#B08A4A]/35 bg-[#FBF7EF]/96 px-4 py-3 shadow-[0_-10px_28px_-12px_rgba(28,20,16,0.25)] backdrop-blur-md lg:hidden"
      >
        <div className="min-w-0">
          <p className="text-[10px] font-medium tracking-[0.16em] uppercase text-[#8A672C]">
            {orderedSelections.length} món
            {orderedSelections.length >= 2 && effectiveDiscountPct > 0
              ? ` · Combo -${effectiveDiscountPct}%`
              : ''}
          </p>
          <p className="font-editorial text-2xl leading-none font-semibold text-[#1C1410]">
            {orderedSelections.length > 0 ? FORMAT_VND(effectiveTotal) : '0₫'}
          </p>
        </div>

        <button
          type="button"
          disabled={orderedSelections.length === 0 || isAddingBundle}
          onClick={() => void handleAddBundleToCart()}
          className="btn btn--gold shrink-0 !px-4 !py-2.5 !text-[11px] !font-medium !tracking-[0.12em] disabled:cursor-not-allowed disabled:opacity-45"
        >
          {isAddingBundle ? 'Đang đóng hộp...' : 'THÊM CẢ BỘ VÀO GIỎ'}
        </button>
      </div>

      {/* Size Profile Modal */}
      <SizeGuideModal
        open={sizeModalOpen}
        initialProfile={sizeProfile}
        onClose={() => setSizeModalOpen(false)}
        onSaveProfile={handleSaveSizeProfile}
      />
    </section>
  );
}
