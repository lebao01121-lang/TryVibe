'use client';

import { useGSAP } from '@gsap/react';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { useMotionState, usePrefersReducedMotion } from '@atelier/motion-kit';
import { ensureGsapRegistered, gsap } from '@/lib/gsap-setup';
import { useAdaptivePerformance } from '@/lib/performance/AdaptivePerformanceProvider';
import {
  renderPhotometricSceneToCanvas,
  type HydratedSeasonScene,
  type MaterialOpticalProfile,
  type PhotometricLookbookCache,
  type PhotometricRecolorSlotRequest,
} from './photometric-recolor';
import styles from './seasons-vitrine.module.css';

export type WearableSlotKey =
  | 'TOP'
  | 'BOTTOM'
  | 'ONE_PIECE'
  | 'OUTERWEAR'
  | 'ACCESSORY';

export interface SeasonWearableVariantView {
  variantId: string;
  skuDefaultId: string;
  colorKey: string;
  colorName: string;
  colorHex: string;
  inStockSizes: string[];
  /** Optional map of sizeCode -> exact skuId for live cart checkout */
  skuBySize?: Record<string, string>;
  studioCutoutUrl: string;
  macroSwatchUrl: string;
  fabricSpecText: string;
  prebakedSceneUrl?: string | null;
}

export interface SeasonWearableSlotView {
  slotKey: WearableSlotKey;
  productId: string;
  productSlug: string;
  productName: string;
  basePriceVnd: number;
  pinPosition: { xPercent: number; yPercent: number };
  garmentRegionMask: string;
  maskBbox?: { x: number; y: number; w: number; h: number };
  materialOpticalProfile: MaterialOpticalProfile;
  fallbackImageUrl?: string;
  variants: SeasonWearableVariantView[];
}

export const SEASONS_VITRINE_BASE = '/images/seasons-vitrine';
const LEGACY_LOOKBOOK_SEGMENT = ['seasons', 'lookbook'].join('-');
const LEGACY_LOOKBOOK_PREFIX = `/${LEGACY_LOOKBOOK_SEGMENT}/`;
export const FALLBACK_DEFAULT_LOOKBOOK_URL = `${SEASONS_VITRINE_BASE}/lookbooks/xuan-tam-xuan-base.webp`;

const LEGACY_VI_COLOR_KEY_MAP: Record<string, string> = {
  'kem-nga': 'ivory',
  'den-tuyen': 'jet-black',
  'do-ruou-vang': 'wine-red',
  'xanh-reu': 'sage-green',
  'nau-cacao': 'espresso',
};

export function getSeasonLookbookFallbackUrl(seasonSlug: string): string {
  const safeSlug = (seasonSlug || 'xuan-tam-xuan').trim().toLowerCase();
  return `${SEASONS_VITRINE_BASE}/lookbooks/${safeSlug}-base.webp`;
}

export function getSeasonMaskFallbackUrl(
  seasonSlug: string,
  slotKey: string,
): string {
  const safeSlug = (seasonSlug || 'xuan-tam-xuan').trim().toLowerCase();
  const safeSlot = (slotKey || 'top').trim().toLowerCase();
  return `${SEASONS_VITRINE_BASE}/masks/${safeSlug}-mask-${safeSlot}.png`;
}

export function getVariantDefaultFallbackUrl(productSlug: string): string {
  const safeSlug = (
    productSlug || 'ao-so-mi-lua-to-tam-tam-xuan'
  )
    .trim()
    .toLowerCase();
  return `${SEASONS_VITRINE_BASE}/variants/${safeSlug}-default.webp`;
}

const VERIFIED_MACRO_COLORS_BY_SHEEN: Record<string, ReadonlySet<string>> = {
  silk: new Set(['ivory', 'jet-black', 'wine-red', 'sage-green', 'champagne']),
  linen: new Set(['ivory', 'sage-green', 'espresso', 'sand', 'jet-black']),
  tweed: new Set(['ivory', 'espresso', 'jet-black', 'charcoal', 'wine-red']),
  leather: new Set(['champagne', 'jet-black', 'wine-red', 'espresso']),
};

export function getMacroFallbackUrl(sheen?: string, colorKey?: string): string {
  const normalizedSheen =
    sheen === 'linen' || sheen === 'tweed' || sheen === 'leather' || sheen === 'silk'
      ? sheen
      : 'silk';
  const rawColor = (colorKey || '').trim().toLowerCase();
  const mappedColor = LEGACY_VI_COLOR_KEY_MAP[rawColor] ?? rawColor;
  const defaultColorBySheen: Record<string, string> = {
    silk: 'ivory',
    linen: 'sand',
    tweed: 'ivory',
    leather: 'espresso',
  };
  const validColors = VERIFIED_MACRO_COLORS_BY_SHEEN[normalizedSheen];
  const finalColor =
    mappedColor && validColors?.has(mappedColor)
      ? mappedColor
      : defaultColorBySheen[normalizedSheen] || 'ivory';
  return `${SEASONS_VITRINE_BASE}/macros/${normalizedSheen}-${finalColor}.webp`;
}

export function getOccasionMacroFallbackUrl(sheen?: string): string {
  if (sheen === 'linen') return '/occasion-macro/organic-linen.webp';
  if (sheen === 'tweed') return '/occasion-macro/artisan-tweed.webp';
  if (sheen === 'leather') return '/occasion-macro/silk-satin-champagne.webp';
  return '/occasion-macro/silk-pearl-cuff.webp';
}

export function resolveSeasonsVitrineUrl(
  rawUrl: string | null | undefined,
  fallbackUrl: string,
): string {
  const trimmed = typeof rawUrl === 'string' ? rawUrl.trim() : '';
  if (!trimmed) return fallbackUrl;

  if (!trimmed.startsWith(LEGACY_LOOKBOOK_PREFIX)) {
    return trimmed;
  }

  const rel = trimmed.slice(LEGACY_LOOKBOOK_PREFIX.length);

  if (rel.startsWith('macros/')) {
    let filename = rel.slice('macros/'.length);
    for (const [viKey, enKey] of Object.entries(LEGACY_VI_COLOR_KEY_MAP)) {
      filename = filename.replace(`-${viKey}.webp`, `-${enKey}.webp`);
    }
    return `${SEASONS_VITRINE_BASE}/macros/${filename}`;
  }

  if (rel.startsWith('variants/')) {
    let filename = rel.slice('variants/'.length);
    for (const [viKey, enKey] of Object.entries(LEGACY_VI_COLOR_KEY_MAP)) {
      filename = filename.replace(`-${viKey}.webp`, `-${enKey}.webp`);
    }
    return `${SEASONS_VITRINE_BASE}/variants/${filename}`;
  }

  const baseMatch = /^([^/]+)\/base\.webp$/i.exec(rel);
  if (baseMatch?.[1]) {
    return `${SEASONS_VITRINE_BASE}/lookbooks/${baseMatch[1]}-base.webp`;
  }

  const maskMatch = /^([^/]+)\/mask-([^/]+)\.png$/i.exec(rel);
  if (maskMatch?.[1] && maskMatch[2]) {
    return `${SEASONS_VITRINE_BASE}/masks/${maskMatch[1]}-mask-${maskMatch[2]}.png`;
  }

  return fallbackUrl;
}

export interface SeasonChapterView {
  id: string;
  slug: string;
  order: number;
  orderLabel: string;
  months: string;
  name: string;
  shortName: string;
  materialHeadline: string;
  note: string;
  isCurrent: boolean;
  totalDesigns: number;
  baseEditorialImageUrl: string;
  wearableSlots: SeasonWearableSlotView[];
  restyleCacheMap: Record<string, string>;
}

export interface ScanBeamTrigger {
  slotKey: WearableSlotKey;
  maskBbox?: { x: number; y: number; w: number; h: number };
  seq: number;
}

export interface InteractiveAiLookbookStageProps {
  season: SeasonChapterView;
  transitionDirection: 1 | -1;
  cache: PhotometricLookbookCache;
  selectedColorBySlot: Record<string, string>;
  hoveredSlotKey: WearableSlotKey | null;
  openPopoverSlotKey: WearableSlotKey | null;
  scanTrigger: ScanBeamTrigger | null;
  serverSceneUrl: string | null;
  serverCacheHit: boolean;
  isRestylingServer: boolean;
  onHoverSlot: (slotKey: WearableSlotKey | null) => void;
  onTogglePopover: (slotKey: WearableSlotKey | null) => void;
  onSelectSlotVariant: (
    slot: SeasonWearableSlotView,
    variant: SeasonWearableVariantView,
  ) => void;
  onOpenSetTryOn: () => void;
}

const SLOT_SHORT_LABEL_VI: Record<WearableSlotKey, string> = {
  TOP: 'Áo thân trên',
  BOTTOM: 'Chân váy / Quần',
  ONE_PIECE: 'Đầm liền thân',
  OUTERWEAR: 'Áo khoác',
  ACCESSORY: 'Phụ kiện',
};

function resolvePinLabel(slot: SeasonWearableSlotView): string {
  const nameLower = slot.productName.toLowerCase();
  let shortNoun = SLOT_SHORT_LABEL_VI[slot.slotKey];
  if (slot.slotKey === 'TOP') {
    if (nameLower.includes('lụa')) shortNoun = 'Áo lụa';
    else if (nameLower.includes('len') || nameLower.includes('cashmere')) shortNoun = 'Áo len';
    else if (nameLower.includes('sơ mi')) shortNoun = 'Áo sơ mi';
  } else if (slot.slotKey === 'BOTTOM') {
    if (nameLower.includes('chân váy')) shortNoun = 'Chân váy';
    else if (nameLower.includes('quần')) shortNoun = 'Quần âu';
  } else if (slot.slotKey === 'ONE_PIECE') {
    shortNoun = 'Đầm liền';
  } else if (slot.slotKey === 'OUTERWEAR') {
    if (nameLower.includes('blazer')) shortNoun = 'Blazer';
    else if (nameLower.includes('tweed')) shortNoun = 'Áo Tweed';
    else if (nameLower.includes('cardigan')) shortNoun = 'Cardigan';
    else shortNoun = 'Áo khoác';
  } else if (slot.slotKey === 'ACCESSORY') {
    shortNoun = 'Phụ kiện';
  }
  const colorCount = Math.max(1, slot.variants.length);
  return `${shortNoun} · ${colorCount} màu`;
}

export interface ResolvedHotspotPinLayout {
  slotKey: WearableSlotKey;
  xPercent: number;
  yPercent: number;
  reverse: boolean;
}

const PIN_SAFE_MIN_X = 22;
const PIN_SAFE_MAX_X = 78;
const PIN_SAFE_MIN_Y = 26;
const PIN_SAFE_MAX_Y = 76;
const PIN_MIN_GAP_Y = 14;
const PIN_FLIP_RIGHT_X = 44;
const PIN_FLIP_LEFT_X = 56;
const MIN_MASK_BBOX_SPAN = 0.005;
const MIN_MASK_PIXEL_COUNT = 16;

export function hasMaskBboxCoverage(
  bbox?: { x: number; y: number; w: number; h: number } | null,
): boolean {
  if (!bbox) return false;
  return (
    Number.isFinite(bbox.w) &&
    Number.isFinite(bbox.h) &&
    bbox.w >= MIN_MASK_BBOX_SPAN &&
    bbox.h >= MIN_MASK_BBOX_SPAN
  );
}

export function hasSlotPhotometricCoverage(
  slot: SeasonWearableSlotView,
  hydratedScene: HydratedSeasonScene | null,
  seasonSlug: string,
): boolean {
  // Explicit zero-area maskBbox from manifest/API indicates non-worn accessory (empty mask)
  if (slot.maskBbox && !hasMaskBboxCoverage(slot.maskBbox)) {
    return false;
  }

  // Once masks are hydrated for this season, rely on actual non-empty mask pixel coverage
  if (hydratedScene && hydratedScene.seasonSlug === seasonSlug) {
    const layer = hydratedScene.masks.get(slot.slotKey);
    return Boolean(layer && layer.pixelCount >= MIN_MASK_PIXEL_COUNT);
  }

  // Before hydration completes, avoid assuming a synthetic box for non-worn ACCESSORY slots
  if (slot.slotKey === 'ACCESSORY') {
    return hasMaskBboxCoverage(slot.maskBbox);
  }

  return true;
}

export function solveNonOverlappingHotspotPins(
  slots: SeasonWearableSlotView[],
): Map<WearableSlotKey, ResolvedHotspotPinLayout> {
  const layoutBySlot = new Map<WearableSlotKey, ResolvedHotspotPinLayout>();
  if (slots.length === 0) return layoutBySlot;

  const sorted = slots
    .map((slot, origIndex) => {
      const rawX = Number.isFinite(slot.pinPosition?.xPercent)
        ? slot.pinPosition.xPercent
        : 50;
      const rawY = Number.isFinite(slot.pinPosition?.yPercent)
        ? slot.pinPosition.yPercent
        : 50;
      return {
        slotKey: slot.slotKey,
        origIndex,
        x: Math.max(PIN_SAFE_MIN_X, Math.min(PIN_SAFE_MAX_X, rawX)),
        y: Math.max(PIN_SAFE_MIN_Y, Math.min(PIN_SAFE_MAX_Y, rawY)),
      };
    })
    .sort((a, b) => a.y - b.y || a.origIndex - b.origIndex);

  const count = sorted.length;
  const effectiveGap =
    count > 1
      ? Math.min(PIN_MIN_GAP_Y, (PIN_SAFE_MAX_Y - PIN_SAFE_MIN_Y) / (count - 1))
      : 0;

  if (count > 1) {
    // 1. Iterative symmetric relaxation preserves proximity to each garment's true Y anchor
    for (let iter = 0; iter < 10; iter += 1) {
      let moved = false;
      for (let k = 1; k < count; k += 1) {
        const prev = sorted[k - 1]!;
        const curr = sorted[k]!;
        const delta = curr.y - prev.y;
        if (delta < effectiveGap) {
          const push = (effectiveGap - delta) * 0.5;
          prev.y = Math.max(PIN_SAFE_MIN_Y, prev.y - push);
          curr.y = Math.min(PIN_SAFE_MAX_Y, curr.y + push);
          moved = true;
        }
      }
      if (!moved) break;
    }

    // 2. Exact forward & backward projection guarantees strict MIN_GAP_Y inside [26, 76]
    for (let k = 1; k < count; k += 1) {
      const minAllowed = sorted[k - 1]!.y + effectiveGap;
      if (sorted[k]!.y < minAllowed) {
        sorted[k]!.y = minAllowed;
      }
    }
    if (sorted[count - 1]!.y > PIN_SAFE_MAX_Y) {
      sorted[count - 1]!.y = PIN_SAFE_MAX_Y;
      for (let k = count - 2; k >= 0; k -= 1) {
        const maxAllowed = sorted[k + 1]!.y - effectiveGap;
        if (sorted[k]!.y > maxAllowed) {
          sorted[k]!.y = maxAllowed;
        }
      }
    }
    if (sorted[0]!.y < PIN_SAFE_MIN_Y) {
      sorted[0]!.y = PIN_SAFE_MIN_Y;
      for (let k = 1; k < count; k += 1) {
        const minAllowed = sorted[k - 1]!.y + effectiveGap;
        if (sorted[k]!.y < minAllowed) {
          sorted[k]!.y = minAllowed;
        }
      }
    }
  }

  let prevReverse: boolean | null = null;
  for (let idx = 0; idx < count; idx += 1) {
    const item = sorted[idx]!;
    let reverse: boolean;
    if (item.x > PIN_FLIP_LEFT_X) {
      reverse = true;
    } else if (item.x < PIN_FLIP_RIGHT_X) {
      reverse = false;
    } else {
      reverse = prevReverse === null ? idx % 2 === 1 : !prevReverse;
    }

    // Keep pill extending away from stage borders so text never clips at any viewport width
    const safeX = reverse
      ? Math.max(PIN_FLIP_RIGHT_X, Math.min(PIN_SAFE_MAX_X, item.x))
      : Math.max(PIN_SAFE_MIN_X, Math.min(PIN_FLIP_LEFT_X, item.x));

    prevReverse = reverse;
    layoutBySlot.set(item.slotKey, {
      slotKey: item.slotKey,
      xPercent: Number(safeX.toFixed(2)),
      yPercent: Number(item.y.toFixed(2)),
      reverse,
    });
  }

  return layoutBySlot;
}

function resolveDefaultMaskBbox(
  slotKey: WearableSlotKey,
  pin: { xPercent: number; yPercent: number },
): { x: number; y: number; w: number; h: number } {
  if (slotKey === 'TOP' || slotKey === 'OUTERWEAR') {
    return { x: 0.2, y: 0.24, w: 0.6, h: 0.34 };
  }
  if (slotKey === 'BOTTOM') {
    return { x: 0.16, y: 0.5, w: 0.68, h: 0.44 };
  }
  if (slotKey === 'ONE_PIECE') {
    return { x: 0.18, y: 0.24, w: 0.64, h: 0.68 };
  }
  const cx = Math.max(0.18, Math.min(0.82, pin.xPercent / 100));
  const cy = Math.max(0.2, Math.min(0.84, pin.yPercent / 100));
  return {
    x: Math.max(0.05, cx - 0.16),
    y: Math.max(0.05, cy - 0.14),
    w: 0.32,
    h: 0.28,
  };
}

export function InteractiveAiLookbookStage({
  season,
  transitionDirection,
  cache,
  selectedColorBySlot,
  hoveredSlotKey,
  openPopoverSlotKey,
  scanTrigger,
  serverSceneUrl,
  serverCacheHit,
  isRestylingServer,
  onHoverSlot,
  onTogglePopover,
  onSelectSlotVariant,
  onOpenSetTryOn,
}: InteractiveAiLookbookStageProps) {
  const stageContainerRef = useRef<HTMLDivElement | null>(null);
  const curtainLayerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const fallbackImgRef = useRef<HTMLImageElement | null>(null);
  const prevSeasonSlugRef = useRef<string | null>(null);

  const { cameraActive } = useMotionState();
  const reducedMotion = usePrefersReducedMotion();
  const { isLowPower, tier: perfTier } = useAdaptivePerformance();
  const [isPageHidden, setIsPageHidden] = useState(false);

  useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    const handleVisibility = () => {
      setIsPageHidden(document.hidden);
    };
    handleVisibility();
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, []);

  const localBaseFallbackUrl = getSeasonLookbookFallbackUrl(season.slug);
  const resolvedBaseUrl = resolveSeasonsVitrineUrl(
    season.baseEditorialImageUrl,
    localBaseFallbackUrl,
  );

  const baseImgCandidates = useMemo(
    () =>
      Array.from(
        new Set(
          [resolvedBaseUrl, localBaseFallbackUrl, FALLBACK_DEFAULT_LOOKBOOK_URL].filter(
            (u) => u.length > 0,
          ),
        ),
      ),
    [localBaseFallbackUrl, resolvedBaseUrl],
  );

  const [baseImgAttemptIdx, setBaseImgAttemptIdx] = useState<number>(0);

  useEffect(() => {
    setBaseImgAttemptIdx(0);
  }, [resolvedBaseUrl, season.slug]);

  const activeFallbackImgSrc =
    baseImgCandidates[
      Math.min(baseImgAttemptIdx, Math.max(0, baseImgCandidates.length - 1))
    ] ?? FALLBACK_DEFAULT_LOOKBOOK_URL;

  const advanceFallbackImg = useCallback(() => {
    setBaseImgAttemptIdx((prev) =>
      prev + 1 < baseImgCandidates.length ? prev + 1 : prev,
    );
  }, [baseImgCandidates.length]);

  useEffect(() => {
    const img = fallbackImgRef.current;
    if (img && img.complete && img.naturalWidth === 0) {
      advanceFallbackImg();
    }
  }, [activeFallbackImgSrc, advanceFallbackImg]);

  const [hydratedScene, setHydratedScene] = useState<HydratedSeasonScene | null>(
    () => cache.getCached(season.slug),
  );
  const [verifiedServerOverlayUrl, setVerifiedServerOverlayUrl] = useState<string | null>(
    null,
  );
  const [scanActiveKey, setScanActiveKey] = useState<number>(0);

  // Hydrate base photograph & all slot masks for active season into PhotometricLookbookCache
  useEffect(() => {
    let cancelled = false;
    const cached = cache.getCached(season.slug);
    if (
      cached &&
      (cached.baseUrl === resolvedBaseUrl || cached.baseUrl === localBaseFallbackUrl)
    ) {
      setHydratedScene(cached);
      return;
    }

    const maskInputs = season.wearableSlots.map((slot) => ({
      slotKey: slot.slotKey,
      garmentRegionMask: resolveSeasonsVitrineUrl(
        slot.garmentRegionMask,
        getSeasonMaskFallbackUrl(season.slug, slot.slotKey),
      ),
      materialOpticalProfile: slot.materialOpticalProfile,
    }));

    const hydrateWithLocalFallback = async () => {
      let scene = await cache.hydrateSeason(season.slug, resolvedBaseUrl, maskInputs);
      if (!scene && resolvedBaseUrl !== localBaseFallbackUrl) {
        scene = await cache.hydrateSeason(
          season.slug,
          localBaseFallbackUrl,
          maskInputs,
        );
      }
      if (!cancelled && scene) {
        setHydratedScene(scene);
      }
    };

    void hydrateWithLocalFallback();

    return () => {
      cancelled = true;
    };
  }, [cache, localBaseFallbackUrl, resolvedBaseUrl, season.slug, season.wearableSlots]);

  // Compute mathematically separated, non-overlapping hotspot pin positions across the 4:5 stage
  const resolvedPinLayouts = useMemo(
    () => solveNonOverlappingHotspotPins(season.wearableSlots),
    [season.wearableSlots],
  );

  // Build cumulative photometric slot recolor requests (skipping non-worn empty-mask slots)
  const slotRequests = useMemo<PhotometricRecolorSlotRequest[]>(() => {
    return season.wearableSlots.map((slot) => {
      const defaultVariant = slot.variants[0];
      const activeKey =
        selectedColorBySlot[slot.slotKey] ?? defaultVariant?.colorKey ?? '';
      const activeVariant =
        slot.variants.find((v) => v.colorKey === activeKey) ?? defaultVariant;
      const hasMask = hasSlotPhotometricCoverage(
        slot,
        hydratedScene,
        season.slug,
      );
      const isDefaultColor =
        !hasMask ||
        !activeVariant ||
        (defaultVariant != null && activeVariant.colorKey === defaultVariant.colorKey);

      return {
        slotKey: slot.slotKey,
        targetHex: activeVariant?.colorHex ?? '#F4EFE6',
        isDefaultColor,
        materialOpticalProfile: slot.materialOpticalProfile,
      };
    });
  }, [hydratedScene, season.slug, season.wearableSlots, selectedColorBySlot]);

  const hasAnyCustomColor = useMemo(
    () => slotRequests.some((r) => !r.isDefaultColor),
    [slotRequests],
  );

  // Render HiDPI photometric scene immediately (0ms lag) whenever scene, colors, or hover changes
  const paintCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (
      !canvas ||
      !hydratedScene ||
      hydratedScene.seasonSlug !== season.slug ||
      (typeof document !== 'undefined' && document.hidden)
    ) {
      return;
    }
    const dpr = isLowPower
      ? 1
      : Math.min(
          typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1,
          2,
        );
    renderPhotometricSceneToCanvas(canvas, hydratedScene, slotRequests, {
      hoveredSlotKey,
      maxDpr: dpr,
    });
  }, [hydratedScene, hoveredSlotKey, isLowPower, season.slug, slotRequests]);

  useEffect(() => {
    if (isPageHidden) return;
    paintCanvas();
  }, [isPageHidden, paintCanvas]);

  // Keep canvas crisp on container resize
  useEffect(() => {
    const el = stageContainerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(() => {
      paintCanvas();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [paintCanvas]);

  // Safely preload distinct server-cached AI restyle image before crossfading (guarantees 0 brokenImgs)
  useEffect(() => {
    const resolvedServerUrl = serverSceneUrl
      ? resolveSeasonsVitrineUrl(serverSceneUrl, '')
      : '';
    if (!resolvedServerUrl || !hasAnyCustomColor) {
      setVerifiedServerOverlayUrl(null);
      return;
    }
    if (
      resolvedServerUrl === resolvedBaseUrl ||
      resolvedServerUrl === localBaseFallbackUrl
    ) {
      setVerifiedServerOverlayUrl(null);
      return;
    }

    let cancelled = false;
    const preloader = new Image();
    preloader.decoding = 'async';
    if (
      resolvedServerUrl.startsWith('http://') ||
      resolvedServerUrl.startsWith('https://')
    ) {
      preloader.crossOrigin = 'anonymous';
    }
    preloader.onload = () => {
      if (!cancelled && preloader.naturalWidth > 0) {
        setVerifiedServerOverlayUrl(resolvedServerUrl);
      }
    };
    preloader.onerror = () => {
      if (!cancelled) {
        setVerifiedServerOverlayUrl(null);
      }
    };
    preloader.src = resolvedServerUrl;

    return () => {
      cancelled = true;
    };
  }, [hasAnyCustomColor, localBaseFallbackUrl, resolvedBaseUrl, serverSceneUrl]);

  // Trigger 0.48s AiOpticalScanBeam on masked garment color selection (auto-skipped for empty accessory masks)
  useEffect(() => {
    if (
      !scanTrigger ||
      cameraActive ||
      reducedMotion ||
      isLowPower ||
      isPageHidden
    ) {
      setScanActiveKey(0);
      return;
    }
    const matchedSlot = season.wearableSlots.find(
      (s) => s.slotKey === scanTrigger.slotKey,
    );
    const hasCoverage =
      matchedSlot != null &&
      hasSlotPhotometricCoverage(matchedSlot, hydratedScene, season.slug) &&
      (scanTrigger.maskBbox == null || hasMaskBboxCoverage(scanTrigger.maskBbox));

    if (!hasCoverage) {
      setScanActiveKey(0);
      return;
    }

    setScanActiveKey(scanTrigger.seq);
    const timer = window.setTimeout(() => {
      setScanActiveKey((prev) => (prev === scanTrigger.seq ? 0 : prev));
    }, 520);
    return () => window.clearTimeout(timer);
  }, [
    cameraActive,
    hydratedScene,
    isLowPower,
    isPageHidden,
    reducedMotion,
    scanTrigger,
    season.slug,
    season.wearableSlots,
  ]);

  // Vertical silk curtain reveal on season chapter switch (`0.65s power3.out`)
  useGSAP(
    () => {
      ensureGsapRegistered();
      const curtainEl = curtainLayerRef.current;
      if (!curtainEl) return;

      const prevSlug = prevSeasonSlugRef.current;
      prevSeasonSlugRef.current = season.slug;

      if (
        !prevSlug ||
        prevSlug === season.slug ||
        reducedMotion ||
        cameraActive ||
        isLowPower ||
        isPageHidden
      ) {
        gsap.set(curtainEl, { clipPath: 'inset(0% 0% 0% 0% round 12px)' });
        return;
      }

      const startInset =
        transitionDirection >= 0
          ? 'inset(100% 0% 0% 0% round 12px)'
          : 'inset(0% 0% 100% 0% round 12px)';

      gsap.fromTo(
        curtainEl,
        { clipPath: startInset },
        {
          clipPath: 'inset(0% 0% 0% 0% round 12px)',
          duration: 0.65,
          ease: 'power3.out',
          overwrite: 'auto',
        },
      );
    },
    {
      scope: stageContainerRef,
      dependencies: [
        season.slug,
        transitionDirection,
        reducedMotion,
        cameraActive,
        isLowPower,
        isPageHidden,
      ],
    },
  );

  // Close swatch popover on Escape or outside click
  useEffect(() => {
    if (!openPopoverSlotKey) return undefined;

    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onTogglePopover(null);
      }
    };

    const handlePointerDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      if (
        target.closest('[data-testid="season-swatch-popover"]') ||
        target.closest('[data-hotspot-pin="true"]')
      ) {
        return;
      }
      onTogglePopover(null);
    };

    window.addEventListener('keydown', handleKey);
    document.addEventListener('mousedown', handlePointerDown);
    return () => {
      window.removeEventListener('keydown', handleKey);
      document.removeEventListener('mousedown', handlePointerDown);
    };
  }, [openPopoverSlotKey, onTogglePopover]);

  const activePopoverSlot = useMemo(
    () =>
      openPopoverSlotKey
        ? season.wearableSlots.find((s) => s.slotKey === openPopoverSlotKey) ?? null
        : null,
    [openPopoverSlotKey, season.wearableSlots],
  );

  const activePopoverHasMask = useMemo(
    () =>
      activePopoverSlot
        ? hasSlotPhotometricCoverage(
            activePopoverSlot,
            hydratedScene,
            season.slug,
          )
        : false,
    [activePopoverSlot, hydratedScene, season.slug],
  );

  const activeScanStyle = useMemo<CSSProperties | null>(() => {
    if (!scanTrigger || scanActiveKey === 0) return null;
    const matchedSlot = season.wearableSlots.find(
      (s) => s.slotKey === scanTrigger.slotKey,
    );
    if (
      !matchedSlot ||
      !hasSlotPhotometricCoverage(matchedSlot, hydratedScene, season.slug)
    ) {
      return null;
    }

    let bbox: { x: number; y: number; w: number; h: number } | null = null;
    const hydratedLayer =
      hydratedScene && hydratedScene.seasonSlug === season.slug
        ? hydratedScene.masks.get(scanTrigger.slotKey)
        : undefined;

    if (
      hydratedLayer &&
      hydratedLayer.pixelCount >= MIN_MASK_PIXEL_COUNT &&
      hydratedScene &&
      hydratedScene.width > 0 &&
      hydratedScene.height > 0
    ) {
      const { minX, minY, maxX, maxY } = hydratedLayer.bounds;
      bbox = {
        x: minX / hydratedScene.width,
        y: minY / hydratedScene.height,
        w: (maxX - minX + 1) / hydratedScene.width,
        h: (maxY - minY + 1) / hydratedScene.height,
      };
    } else if (hasMaskBboxCoverage(scanTrigger.maskBbox)) {
      bbox = scanTrigger.maskBbox!;
    } else if (hasMaskBboxCoverage(matchedSlot.maskBbox)) {
      bbox = matchedSlot.maskBbox!;
    } else if (scanTrigger.slotKey !== 'ACCESSORY') {
      bbox = resolveDefaultMaskBbox(
        scanTrigger.slotKey,
        matchedSlot.pinPosition ?? { xPercent: 50, yPercent: 45 },
      );
    }

    if (!bbox || !hasMaskBboxCoverage(bbox)) return null;

    return {
      left: `${(Math.max(0, Math.min(0.92, bbox.x)) * 100).toFixed(2)}%`,
      top: `${(Math.max(0, Math.min(0.92, bbox.y)) * 100).toFixed(2)}%`,
      width: `${(Math.max(0.12, Math.min(1 - bbox.x, bbox.w)) * 100).toFixed(2)}%`,
      height: `${(Math.max(0.12, Math.min(1 - bbox.y, bbox.h)) * 100).toFixed(2)}%`,
    };
  }, [hydratedScene, scanActiveKey, scanTrigger, season.slug, season.wearableSlots]);

  const popoverAnchorStyle = useMemo<CSSProperties>(() => {
    if (!activePopoverSlot) return {};
    const solvedPin = resolvedPinLayouts.get(activePopoverSlot.slotKey);
    const xPercent = solvedPin?.xPercent ?? activePopoverSlot.pinPosition.xPercent;
    const yPercent = solvedPin?.yPercent ?? activePopoverSlot.pinPosition.yPercent;
    const placeLeft = solvedPin ? solvedPin.reverse : xPercent > PIN_FLIP_LEFT_X;

    // Pixel-aware clamp guarantees zero clipping outside left/right/top/bottom stage bounds
    // and keeps clear vertical headroom above the bottom-right Try-On AI CTA pill.
    const desiredLeft = placeLeft
      ? `calc(${xPercent.toFixed(2)}% - 244px)`
      : `calc(${xPercent.toFixed(2)}% + 18px)`;

    return {
      left: `max(10px, min(${desiredLeft}, calc(100% - 236px)))`,
      top: `max(12px, min(calc(${yPercent.toFixed(2)}% - 64px), calc(100% - 224px)))`,
    };
  }, [activePopoverSlot, resolvedPinLayouts]);

  const sceneReady =
    hydratedScene !== null && hydratedScene.seasonSlug === season.slug;

  return (
    <div
      ref={stageContainerRef}
      className={styles.aiStageFrame}
      data-season-slug={season.slug}
      data-restyle-ready={sceneReady ? 'true' : 'false'}
      data-restyle-cache-hit={serverCacheHit ? 'true' : 'false'}
      data-restyle-loading={isRestylingServer ? 'true' : 'false'}
      data-restyle-server-url={verifiedServerOverlayUrl ?? ''}
    >
      <div ref={curtainLayerRef} className={styles.aiStageCurtain}>
        {/* Instant editorial base fallback visible only until canvas finishes pixel hydration */}
        {!sceneReady ? (
          <img
            ref={fallbackImgRef}
            src={activeFallbackImgSrc}
            alt={`${season.name} — ${season.materialHeadline}`}
            className={styles.aiFallbackImg}
            loading="eager"
            decoding="async"
            onError={advanceFallbackImg}
          />
        ) : null}

        {/* Primary HiDPI Photometric Multi-Layer Recoloring Canvas */}
        <canvas
          ref={canvasRef}
          data-testid="season-ai-canvas"
          data-perf-tier={perfTier}
          data-canvas-dpr={isLowPower ? '1' : 'auto'}
          className={styles.aiCanvas}
          aria-label={`Lookbook AI tương tác mùa ${season.name}`}
        />

        {/* Optional crossfaded server/Redis cached photometric render (paused on hover so golden mask glow stays crisp) */}
        {verifiedServerOverlayUrl && !hoveredSlotKey ? (
          <img
            src={verifiedServerOverlayUrl}
            alt=""
            aria-hidden="true"
            className={styles.aiServerOverlay}
          />
        ) : null}

        {/* Subtle warm bottom vignette for legibility of bottom-right Try-On pill */}
        <div className={styles.aiStageBottomGradient} aria-hidden="true" />

        {/* AiOpticalScanBeam: 0.48s golden vertical light beam strictly over garment maskBbox */}
        {activeScanStyle && !cameraActive && !isLowPower && !isPageHidden ? (
          <div
            key={`scan-${scanActiveKey}`}
            className={styles.scanBeamRegion}
            style={activeScanStyle}
            data-testid="season-ai-scan-beam"
            aria-hidden="true"
          >
            <div className={styles.scanBeamBar} />
            <div className={styles.scanBeamShimmer} />
          </div>
        ) : null}

        {/* Interactive WearableHotspotPins on ALL wearable slots (anti-collision solved) */}
        {season.wearableSlots.map((slot) => {
          const isOpen = openPopoverSlotKey === slot.slotKey;
          const isHovered = hoveredSlotKey === slot.slotKey;
          const pinLayout = resolvedPinLayouts.get(slot.slotKey) ?? {
            slotKey: slot.slotKey,
            xPercent: Math.max(
              PIN_SAFE_MIN_X,
              Math.min(PIN_SAFE_MAX_X, slot.pinPosition.xPercent),
            ),
            yPercent: Math.max(
              PIN_SAFE_MIN_Y,
              Math.min(PIN_SAFE_MAX_Y, slot.pinPosition.yPercent),
            ),
            reverse: slot.pinPosition.xPercent > PIN_FLIP_LEFT_X,
          };
          const pinLabel = resolvePinLabel(slot);
          const activeColorKey =
            selectedColorBySlot[slot.slotKey] ?? slot.variants[0]?.colorKey;
          const activeVariant =
            slot.variants.find((v) => v.colorKey === activeColorKey) ??
            slot.variants[0];

          return (
            <button
              key={`${season.slug}-${slot.slotKey}`}
              type="button"
              data-hotspot-pin="true"
              data-testid={`season-hotspot-${slot.slotKey.toLowerCase()}`}
              data-slot-key={slot.slotKey}
              data-pin-x={pinLayout.xPercent}
              data-pin-y={pinLayout.yPercent}
              data-pin-reverse={pinLayout.reverse ? 'true' : 'false'}
              aria-expanded={isOpen}
              aria-label={`Tùy chỉnh màu ${slot.productName} (${activeVariant?.colorName ?? ''})`}
              className={`${styles.hotspotPin} ${isOpen ? styles.hotspotPinActive : ''} ${
                isHovered ? styles.hotspotPinHovered : ''
              } ${pinLayout.reverse ? styles.hotspotPinReverse : ''}`}
              style={{
                left: `${pinLayout.xPercent}%`,
                top: `${pinLayout.yPercent}%`,
              }}
              onMouseEnter={() => onHoverSlot(slot.slotKey)}
              onMouseLeave={() => onHoverSlot(null)}
              onFocus={() => onHoverSlot(slot.slotKey)}
              onBlur={() => onHoverSlot(null)}
              onClick={() => onTogglePopover(isOpen ? null : slot.slotKey)}
            >
              <span className={styles.hotspotDot} aria-hidden="true">
                <span className={styles.hotspotPlus}>+</span>
              </span>
              <span className={styles.hotspotPill}>{pinLabel}</span>
            </button>
          );
        })}

        {/* Floating AiContextSwatchPopover anchored beside active garment hotspot */}
        {activePopoverSlot ? (
          <div
            data-testid="season-swatch-popover"
            data-slot-key={activePopoverSlot.slotKey}
            role="dialog"
            aria-label={`Chọn màu AI cho ${activePopoverSlot.productName}`}
            className={styles.swatchPopover}
            style={popoverAnchorStyle}
          >
            <div className={styles.swatchPopoverHead}>
              <div className={styles.swatchPopoverTitles}>
                <p className={styles.swatchPopoverName}>
                  {activePopoverSlot.productName}
                </p>
                <p className={styles.swatchPopoverSub}>
                  {!activePopoverHasMask
                    ? 'Phối phụ kiện đồng bộ · Chọn sắc độ'
                    : scanActiveKey > 0 || isRestylingServer
                      ? 'Đang đổi ngữ cảnh AI'
                      : 'Đang đổi ngữ cảnh AI · Chọn sắc độ vải'}
                </p>
              </div>
              <button
                type="button"
                className={styles.swatchPopoverClose}
                aria-label="Đóng bảng màu"
                onClick={() => onTogglePopover(null)}
              >
                ×
              </button>
            </div>

            <div className={styles.swatchPopoverGrid}>
              {activePopoverSlot.variants.map((variant) => {
                const activeColorKey =
                  selectedColorBySlot[activePopoverSlot.slotKey] ??
                  activePopoverSlot.variants[0]?.colorKey;
                const isSelected = variant.colorKey === activeColorKey;
                return (
                  <button
                    key={variant.colorKey}
                    type="button"
                    data-testid={`season-popover-swatch-${activePopoverSlot.slotKey.toLowerCase()}-${variant.colorKey}`}
                    data-color-hex={variant.colorHex}
                    data-color-key={variant.colorKey}
                    aria-pressed={isSelected}
                    aria-label={`${variant.colorName} (${variant.colorHex})`}
                    title={variant.colorName}
                    className={`${styles.popoverSwatchBtn} ${
                      isSelected ? styles.popoverSwatchBtnActive : ''
                    }`}
                    onClick={() => onSelectSlotVariant(activePopoverSlot, variant)}
                  >
                    <span
                      className={styles.popoverSwatchCircle}
                      style={{ backgroundColor: variant.colorHex }}
                    />
                  </button>
                );
              })}
            </div>

            <p className={styles.swatchPopoverColorLabel}>
              {(
                activePopoverSlot.variants.find(
                  (v) =>
                    v.colorKey ===
                    (selectedColorBySlot[activePopoverSlot.slotKey] ??
                      activePopoverSlot.variants[0]?.colorKey),
                ) ?? activePopoverSlot.variants[0]
              )?.colorName ?? ''}
            </p>
          </div>
        ) : null}

        {/* Bottom-right Espresso CTA Pill: ✦ Ướm thử set này AI */}
        <button
          type="button"
          data-testid="season-tryon-set-btn"
          className={styles.tryOnSetPill}
          onClick={onOpenSetTryOn}
        >
          <span className={styles.tryOnSparkle} aria-hidden="true">
            ✦
          </span>
          <span>Ướm thử set này AI</span>
        </button>
      </div>
    </div>
  );
}
