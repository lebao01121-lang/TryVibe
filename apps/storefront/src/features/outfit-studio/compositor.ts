import { OutfitSlot, type ProductSpuDto } from '@atelier/contracts';
import { getPrimaryVariantImage } from '@/lib/catalog-data';
import {
  calibrateGarment,
  drawCalibratedGarment,
  drawInnerNecklineBackWrapShadow,
  drawStagePedestalContactShadow,
  type CalibratedGarment,
} from './autoCalibrateGarment';
import {
  getMannequinHalfWidthAt,
  MANNEQUIN_METRICS,
  toStageX,
  toStageY,
} from './mannequinMetrics';

/**
 * Editorial outfit composition z-index stack matching Atelier Studio spec.
 */
export const OUTFIT_LAYER_Z_INDEX = {
  PKG_BACK: 0,
  TOP: 10,
  BOTTOM: 20,
  ONE_PIECE: 20,
  OUTERWEAR: 30,
  ACCESSORY: 40,
  RIBBON_SEAL: 150,
  PKG_FRONT: 200,
} as const;

export type OutfitLayerKey = keyof typeof OUTFIT_LAYER_Z_INDEX;

export type OuterwearDrapeStyle = 'shoulder' | 'front';

export const CANONICAL_SIZE_ORDER = ['XS', 'S', 'M', 'L', 'XL'] as const;
export type CanonicalSizeCode = (typeof CANONICAL_SIZE_ORDER)[number];

const SIZE_SORT_RANK: Record<string, number> = {
  XS: 0,
  S: 1,
  M: 2,
  L: 3,
  XL: 4,
  XXL: 5,
  FREESIZE: 6,
};

/**
 * Returns a new SKU array sorted strictly in canonical XS · S · M · L · XL order.
 */
export function sortSkusCanonically<T extends { sizeCode: string }>(skus: readonly T[]): T[] {
  return [...skus].sort((a, b) => {
    const rankA = SIZE_SORT_RANK[a.sizeCode.toUpperCase()] ?? 99;
    const rankB = SIZE_SORT_RANK[b.sizeCode.toUpperCase()] ?? 99;
    if (rankA !== rankB) return rankA - rankB;
    return a.sizeCode.localeCompare(b.sizeCode);
  });
}

export interface OutfitSlotSelection {
  slot: OutfitSlot;
  productId: string;
  variantId: string;
  skuId: string;
  slug: string;
  productName: string;
  colorName: string;
  colorHex: string;
  sizeCode: string;
  imageUrl: string | null;
  backImageUrl?: string | null;
  drapeStyle?: OuterwearDrapeStyle;
  categoryLabel?: string;
  unitPriceVnd: number;
  qty: number;
}

export type OutfitSlotsMap = Partial<Record<OutfitSlot, OutfitSlotSelection>>;

export const OUTFIT_SLOT_META: Record<
  OutfitSlot,
  {
    label: string;
    shortLabel: string;
    zIndex: number;
    stageRect: { topPct: number; leftPct: number; widthPct: number; heightPct: number };
  }
> = {
  [OutfitSlot.TOP]: {
    label: 'Áo thân trên',
    shortLabel: 'Áo',
    zIndex: OUTFIT_LAYER_Z_INDEX.TOP,
    stageRect: { topPct: 17, leftPct: 22, widthPct: 56, heightPct: 38 },
  },
  [OutfitSlot.BOTTOM]: {
    label: 'Quần & Chân váy',
    shortLabel: 'Quần / Váy',
    zIndex: OUTFIT_LAYER_Z_INDEX.BOTTOM,
    stageRect: { topPct: 47, leftPct: 21, widthPct: 58, heightPct: 45 },
  },
  [OutfitSlot.ONE_PIECE]: {
    label: 'Đầm liền thân',
    shortLabel: 'Đầm liền',
    zIndex: OUTFIT_LAYER_Z_INDEX.ONE_PIECE,
    stageRect: { topPct: 16, leftPct: 18, widthPct: 64, heightPct: 74 },
  },
  [OutfitSlot.OUTERWEAR]: {
    label: 'Áo khoác & Blazer',
    shortLabel: 'Áo khoác',
    zIndex: OUTFIT_LAYER_Z_INDEX.OUTERWEAR,
    stageRect: { topPct: 15, leftPct: 14, widthPct: 72, heightPct: 48 },
  },
  [OutfitSlot.ACCESSORY]: {
    label: 'Phụ kiện điểm nhấn',
    shortLabel: 'Phụ kiện',
    zIndex: OUTFIT_LAYER_Z_INDEX.ACCESSORY,
    stageRect: { topPct: 54, leftPct: 62, widthPct: 30, heightPct: 26 },
  },
};

export const OUTFIT_SLOT_ORDER: OutfitSlot[] = [
  OutfitSlot.TOP,
  OutfitSlot.BOTTOM,
  OutfitSlot.ONE_PIECE,
  OutfitSlot.OUTERWEAR,
  OutfitSlot.ACCESSORY,
];

/**
 * Maps a catalog ProductSpuDto into its natural OutfitSlot for Studio placement.
 */
export function inferProductOutfitSlot(product: ProductSpuDto): OutfitSlot {
  const cat = `${product.categorySlug ?? ''} ${product.categoryName ?? ''} ${product.slug} ${product.name}`.toLowerCase();

  if (
    cat.includes('phu-kien') ||
    cat.includes('phụ kiện') ||
    cat.includes('clutch') ||
    cat.includes('vi-cam-tay') ||
    cat.includes('ví cầm tay') ||
    cat.includes('khan-lua') ||
    cat.includes('khăn') ||
    cat.includes('khan') ||
    cat.includes('that-lung') ||
    cat.includes('thắt lưng') ||
    cat.includes('túi') ||
    cat.includes('tui-') ||
    cat.includes('accessory')
  ) {
    return OutfitSlot.ACCESSORY;
  }

  if (
    product.tryonGarmentCategory === 'OVERALL' ||
    cat.includes('dam-') ||
    cat.includes('đầm') ||
    cat.includes('vay-lien') ||
    cat.includes('ao-dai') ||
    cat.includes('áo dài')
  ) {
    return OutfitSlot.ONE_PIECE;
  }

  if (
    product.tryonGarmentCategory === 'LOWER' ||
    cat.includes('quan-') ||
    cat.includes('quần') ||
    cat.includes('chan-vay') ||
    cat.includes('chân váy') ||
    cat.includes('culottes')
  ) {
    return OutfitSlot.BOTTOM;
  }

  if (
    cat.includes('ao-khoac') ||
    cat.includes('áo khoác') ||
    cat.includes('ao-blazer') ||
    cat.includes('blazer') ||
    cat.includes('trench') ||
    cat.includes('tweed') ||
    cat.includes('cardigan')
  ) {
    return OutfitSlot.OUTERWEAR;
  }

  return OutfitSlot.TOP;
}

export interface BuildSelectionOptions {
  slot?: OutfitSlot;
  variantIndex?: number;
  preferredSkuId?: string;
  preferredSize?: string | null;
  drapeStyle?: OuterwearDrapeStyle;
}

/**
 * Builds a normalized OutfitSlotSelection from a ProductSpuDto with canonical
 * SKU sizing, front/back RGBA cutout resolution, and category metadata.
 */
export function resolveSelectionFromProduct(
  product: ProductSpuDto,
  options: BuildSelectionOptions = {},
): OutfitSlotSelection {
  const resolvedSlot = options.slot ?? inferProductOutfitSlot(product);
  const variantIdx =
    options.variantIndex !== undefined &&
    options.variantIndex >= 0 &&
    options.variantIndex < product.variants.length
      ? options.variantIndex
      : 0;
  const variant = product.variants[variantIdx] ?? product.variants[0];
  const sortedSkus = sortSkusCanonically(variant?.skus ?? []);

  const preferredById = options.preferredSkuId
    ? sortedSkus.find((s) => s.id === options.preferredSkuId)
    : undefined;
  const normalizedSize = options.preferredSize?.trim().toUpperCase();
  const preferredBySize = normalizedSize
    ? sortedSkus.find((s) => s.sizeCode.toUpperCase() === normalizedSize && s.inStock) ??
      sortedSkus.find((s) => s.sizeCode.toUpperCase() === normalizedSize)
    : undefined;
  const sku =
    preferredById ??
    preferredBySize ??
    sortedSkus.find((s) => s.sizeCode.toUpperCase() === 'M' && s.inStock) ??
    sortedSkus.find((s) => s.inStock) ??
    sortedSkus[0];

  const { flatUrl, lookbookUrl } = getPrimaryVariantImage(product, variantIdx);
  const imageUrl =
    variant?.studioLayerUrl ||
    variant?.rackFrontUrl ||
    variant?.tryonFlatPreviewUrl ||
    flatUrl ||
    lookbookUrl ||
    null;
  const backImageUrl = variant?.rackBackUrl || null;

  return {
    slot: resolvedSlot,
    productId: product.id,
    variantId: variant?.id ?? `${product.id}-default`,
    skuId: sku?.id ?? `${product.id}-sku`,
    slug: product.slug,
    productName: product.name,
    colorName: variant?.colorName ?? 'Tiêu chuẩn',
    colorHex: variant?.colorHex ?? '#EBD9B4',
    sizeCode: sku?.sizeCode ?? (normalizedSize || 'M'),
    imageUrl,
    backImageUrl,
    drapeStyle: options.drapeStyle,
    categoryLabel: product.categoryName || OUTFIT_SLOT_META[resolvedSlot].shortLabel,
    unitPriceVnd: sku?.salePriceVnd ?? product.minPriceVnd,
    qty: 1,
  };
}

/**
 * Pure mutual-exclusion state transition for the Outfit Studio:
 * - Selecting `ONE_PIECE` automatically removes `TOP` & `BOTTOM`
 *   while preserving `OUTERWEAR` & `ACCESSORY`.
 * - Selecting `TOP` or `BOTTOM` automatically removes `ONE_PIECE`
 *   while preserving `OUTERWEAR` & `ACCESSORY`.
 * - Selecting `OUTERWEAR` defaults `drapeStyle` to `'shoulder'` when paired with
 *   `ONE_PIECE`, and `'front'` otherwise (unless explicitly provided).
 * - Selecting `ACCESSORY` updates only its own slot.
 */
export function applyOutfitSlotSelection(
  currentSlots: OutfitSlotsMap,
  item: OutfitSlotSelection,
): OutfitSlotsMap {
  const next: OutfitSlotsMap = { ...currentSlots };

  if (item.slot === OutfitSlot.ONE_PIECE) {
    delete next[OutfitSlot.TOP];
    delete next[OutfitSlot.BOTTOM];
    next[OutfitSlot.ONE_PIECE] = item;
    const existingOuterwear = next[OutfitSlot.OUTERWEAR];
    if (existingOuterwear && !existingOuterwear.drapeStyle) {
      next[OutfitSlot.OUTERWEAR] = {
        ...existingOuterwear,
        drapeStyle: 'shoulder',
      };
    }
    return next;
  }

  if (item.slot === OutfitSlot.TOP || item.slot === OutfitSlot.BOTTOM) {
    delete next[OutfitSlot.ONE_PIECE];
    next[item.slot] = item;
    return next;
  }

  if (item.slot === OutfitSlot.OUTERWEAR) {
    const resolvedDrape: OuterwearDrapeStyle =
      item.drapeStyle ?? (next[OutfitSlot.ONE_PIECE] ? 'shoulder' : 'front');
    next[OutfitSlot.OUTERWEAR] = {
      ...item,
      drapeStyle: resolvedDrape,
    };
    return next;
  }

  next[item.slot] = item;
  return next;
}

export function removeOutfitSlot(
  currentSlots: OutfitSlotsMap,
  slot: OutfitSlot,
): OutfitSlotsMap {
  const next: OutfitSlotsMap = { ...currentSlots };
  delete next[slot];
  return next;
}

export function getOrderedOutfitSelections(
  slots: OutfitSlotsMap,
): OutfitSlotSelection[] {
  return OUTFIT_SLOT_ORDER.map((slot) => slots[slot]).filter(
    (entry): entry is OutfitSlotSelection => Boolean(entry),
  );
}

export interface CompositeRenderInput {
  slots: OutfitSlotsMap;
  packagingName?: string | null;
  packagingSwatchHex?: string | null;
  isWrapped?: boolean;
  giftNote?: string | null;
}

function loadBitmapOrImage(
  url: string,
): Promise<CanvasImageSource | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

function drawRoundedRectPath(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function drawGoldMannequinSilhouette(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  options: {
    occludeTorsoCage: boolean;
    coveredMaxBottomY: number;
  },
): void {
  const cx = toStageX(MANNEQUIN_METRICS.centerX);
  const yFinial = toStageY(MANNEQUIN_METRICS.yFinial);
  const yNeckBase = toStageY(MANNEQUIN_METRICS.yNeckBase);
  const hwNeck = (MANNEQUIN_METRICS.wNeck * MANNEQUIN_METRICS.width) * 0.5;
  const yWaist = toStageY(MANNEQUIN_METRICS.yWaist);
  const hwWaist = getMannequinHalfWidthAt(MANNEQUIN_METRICS.yWaist) * MANNEQUIN_METRICS.width;
  const yTorsoEnd = toStageY(MANNEQUIN_METRICS.yTorsoEnd);
  const yStandEnd = toStageY(MANNEQUIN_METRICS.yStandEnd);

  ctx.save();
  ctx.strokeStyle = 'rgba(176, 138, 74, 0.42)';
  ctx.fillStyle = 'rgba(235, 207, 143, 0.1)';
  ctx.lineWidth = 1.6;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // Layer A (top): Turned wooden neck finial & collarbone
  ctx.beginPath();
  ctx.arc(cx, yFinial - 24, 5.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  ctx.beginPath();
  ctx.ellipse(cx, yFinial + 13, 19, 4.2, 0, 0, Math.PI * 2);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(cx - hwNeck + 3, yFinial + 20);
  ctx.lineTo(cx - hwNeck, yNeckBase);
  ctx.quadraticCurveTo(cx, yNeckBase + 9, cx + hwNeck, yNeckBase);
  ctx.lineTo(cx + hwNeck - 3, yFinial + 20);
  ctx.stroke();

  // Layer B: Torso form (drawn only when not occluded by a full outfit)
  if (!options.occludeTorsoCage) {
    const steps = 40;
    ctx.beginPath();
    for (let i = 0; i <= steps; i += 1) {
      const yNorm =
        MANNEQUIN_METRICS.yNeckBase +
        ((MANNEQUIN_METRICS.yTorsoEnd - MANNEQUIN_METRICS.yNeckBase) * i) / steps;
      const hw = getMannequinHalfWidthAt(yNorm) * MANNEQUIN_METRICS.width;
      const yPx = toStageY(yNorm);
      if (i === 0) ctx.moveTo(cx - hw, yPx);
      else ctx.lineTo(cx - hw, yPx);
    }
    const endHw = getMannequinHalfWidthAt(MANNEQUIN_METRICS.yTorsoEnd) * MANNEQUIN_METRICS.width;
    ctx.quadraticCurveTo(cx, yTorsoEnd + 16, cx + endHw, yTorsoEnd);
    for (let i = steps - 1; i >= 0; i -= 1) {
      const yNorm =
        MANNEQUIN_METRICS.yNeckBase +
        ((MANNEQUIN_METRICS.yTorsoEnd - MANNEQUIN_METRICS.yNeckBase) * i) / steps;
      const hw = getMannequinHalfWidthAt(yNorm) * MANNEQUIN_METRICS.width;
      ctx.lineTo(cx + hw, toStageY(yNorm));
    }
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Waist ribbon line
    ctx.beginPath();
    ctx.moveTo(cx - hwWaist, yWaist);
    ctx.quadraticCurveTo(cx, yWaist + 8, cx + hwWaist, yWaist);
    ctx.stroke();
  }

  // Layer A (bottom): Pedestal & scrolled tripod stand clipped below garment hems
  const clipStartY =
    Math.max(
      MANNEQUIN_METRICS.yTorsoEnd,
      options.coveredMaxBottomY > 0
        ? options.coveredMaxBottomY - 0.01
        : MANNEQUIN_METRICS.yTorsoEnd,
    ) * MANNEQUIN_METRICS.height;

  ctx.save();
  ctx.beginPath();
  ctx.rect(0, clipStartY, MANNEQUIN_METRICS.width, MANNEQUIN_METRICS.height - clipStartY);
  ctx.clip();

  const hubY = yStandEnd - 86;
  ctx.beginPath();
  ctx.moveTo(cx - 2.5, yTorsoEnd + 16);
  ctx.lineTo(cx - 2.5, hubY);
  ctx.moveTo(cx + 2.5, yTorsoEnd + 16);
  ctx.lineTo(cx + 2.5, hubY);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(cx - 5, hubY + 10);
  ctx.quadraticCurveTo(cx - 42, hubY + 46, cx - 78, yStandEnd - 8);
  ctx.moveTo(cx + 5, hubY + 10);
  ctx.quadraticCurveTo(cx + 42, hubY + 46, cx + 78, yStandEnd - 8);
  ctx.moveTo(cx, hubY + 12);
  ctx.lineTo(cx, yStandEnd);
  ctx.stroke();

  ctx.restore();
  ctx.restore();
}

function drawFallbackGarmentVector(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  colorHex: string,
  label: string,
): void {
  const safeHex = /^#[0-9a-fA-F]{3,8}$/.test(colorHex) ? colorHex : '#EBD9B4';
  ctx.save();
  drawRoundedRectPath(ctx, x, y, w, h, 18);
  ctx.fillStyle = safeHex;
  ctx.globalAlpha = 0.88;
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.strokeStyle = '#B08A4A';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.fillStyle = '#2B2019';
  ctx.font = '500 16px Georgia, serif';
  ctx.textAlign = 'center';
  ctx.fillText(label.slice(0, 22), x + w / 2, y + h - 20);
  ctx.restore();
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result);
      } else {
        reject(new Error('Failed to encode snapshot'));
      }
    };
    reader.onerror = () => reject(new Error('FileReader error'));
    reader.readAsDataURL(blob);
  });
}

/**
 * Composites selected garments using the unified MANNEQUIN_METRICS &
 * AutoFitMannequinEngine into a crisp 600×900 preview data URL via
 * OffscreenCanvas (with standard HTMLCanvasElement fallback).
 */
export async function renderOutfitCompositeSnapshot(
  input: CompositeRenderInput,
): Promise<string | null> {
  if (typeof window === 'undefined') {
    return null;
  }

  const width = MANNEQUIN_METRICS.width;
  const height = MANNEQUIN_METRICS.height;

  let offscreen: OffscreenCanvas | null = null;
  let fallbackCanvas: HTMLCanvasElement | null = null;
  let ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null = null;

  if (typeof OffscreenCanvas !== 'undefined') {
    try {
      offscreen = new OffscreenCanvas(width, height);
      ctx = offscreen.getContext('2d');
    } catch {
      offscreen = null;
    }
  }

  if (!ctx && typeof document !== 'undefined') {
    fallbackCanvas = document.createElement('canvas');
    fallbackCanvas.width = width;
    fallbackCanvas.height = height;
    ctx = fallbackCanvas.getContext('2d');
  }

  if (!ctx) {
    return null;
  }

  // Warm Ivory editorial backdrop
  const bgGrad = ctx.createRadialGradient(300, 340, 45, 300, 450, 520);
  bgGrad.addColorStop(0, '#FFFDF9');
  bgGrad.addColorStop(1, '#F3EBDD');
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, width, height);

  // Subtle Atelier framing hairline (or packaging box backdrop when wrapped)
  const pkgHex =
    input.packagingSwatchHex && /^#[0-9a-fA-F]{3,8}$/.test(input.packagingSwatchHex)
      ? input.packagingSwatchHex
      : '#E8DEC8';
  ctx.save();
  drawRoundedRectPath(ctx, 32, 36, 536, 820, 26);
  if (input.isWrapped) {
    ctx.fillStyle = pkgHex;
    ctx.globalAlpha = 0.34;
    ctx.fill();
    ctx.globalAlpha = 1;
  }
  ctx.strokeStyle = 'rgba(176, 138, 74, 0.42)';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.restore();

  // Calibrate active garment layers on unified MANNEQUIN_METRICS
  const ordered = getOrderedOutfitSelections(input.slots);
  const hasOnePiece = Boolean(input.slots[OutfitSlot.ONE_PIECE]);
  const hasPairedBottom = Boolean(input.slots[OutfitSlot.BOTTOM]);

  const calibratedMap = new Map<OutfitSlot, CalibratedGarment>();
  for (const item of ordered) {
    if (!item.imageUrl) continue;
    const cal = await calibrateGarment({
      imageUrl: item.imageUrl,
      slot: item.slot,
      slug: item.slug,
      productName: item.productName,
      drapeStyle: item.drapeStyle,
      face: 'front',
      hasOnePiece,
      hasPairedBottom,
    });
    if (cal) {
      calibratedMap.set(item.slot, cal);
    }
  }

  const maxGarmentBottomY = ordered.reduce((maxY, item) => {
    if (item.slot === OutfitSlot.ACCESSORY) return maxY;
    const cal = calibratedMap.get(item.slot);
    return cal ? Math.max(maxY, cal.bounds.bottomY) : maxY;
  }, 0);

  const occludeTorsoCage = Boolean(
    hasOnePiece ||
      (input.slots[OutfitSlot.TOP] && input.slots[OutfitSlot.BOTTOM]),
  );

  // 2-Layer dynamically occluded gold dressmaker mannequin behind garment layers
  drawGoldMannequinSilhouette(ctx, {
    occludeTorsoCage,
    coveredMaxBottomY: maxGarmentBottomY,
  });

  if (maxGarmentBottomY > 0) {
    drawStagePedestalContactShadow(ctx, maxGarmentBottomY);
  }

  const primaryUpper =
    calibratedMap.get(OutfitSlot.ONE_PIECE) ??
    calibratedMap.get(OutfitSlot.TOP) ??
    calibratedMap.get(OutfitSlot.OUTERWEAR) ??
    null;
  if (primaryUpper) {
    drawInnerNecklineBackWrapShadow(ctx, primaryUpper);
  }

  const bufferCanvas =
    typeof document !== 'undefined'
      ? Object.assign(document.createElement('canvas'), { width, height })
      : null;

  for (const item of ordered) {
    const cal = calibratedMap.get(item.slot);
    if (cal) {
      drawCalibratedGarment(ctx, cal, { bufferCanvas });
    } else {
      const meta = OUTFIT_SLOT_META[item.slot];
      const x = (meta.stageRect.leftPct / 100) * width;
      const y = (meta.stageRect.topPct / 100) * height;
      const w = (meta.stageRect.widthPct / 100) * width;
      const h = (meta.stageRect.heightPct / 100) * height;
      const source = item.imageUrl ? await loadBitmapOrImage(item.imageUrl) : null;
      if (source) {
        ctx.save();
        ctx.drawImage(source, x, y, w, h);
        ctx.restore();
      } else {
        drawFallbackGarmentVector(ctx, x, y, w, h, item.colorHex, item.productName);
      }
    }
  }

  // Layer 150: RIBBON_SEAL & Layer 200: PKG_FRONT editorial signature band
  if (input.isWrapped) {
    ctx.save();
    ctx.fillStyle = 'rgba(28, 20, 16, 0.88)';
    drawRoundedRectPath(ctx, 64, 718, 472, 96, 18);
    ctx.fill();
    ctx.strokeStyle = '#EBCF8F';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Wax seal circle
    ctx.beginPath();
    ctx.arc(300, 718, 22, 0, Math.PI * 2);
    ctx.fillStyle = '#B08A4A';
    ctx.fill();
    ctx.strokeStyle = '#FBF7EF';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.fillStyle = '#FBF7EF';
    ctx.font = '600 13px Georgia, serif';
    ctx.textAlign = 'center';
    ctx.fillText('T&V', 300, 723);

    ctx.fillStyle = '#EBCF8F';
    ctx.font = '500 11px sans-serif';
    ctx.fillText(
      (input.packagingName || 'Hộp Signature TryVibe Atelier').toUpperCase(),
      300,
      768,
    );

    if (input.giftNote && input.giftNote.trim()) {
      ctx.fillStyle = '#FBF7EF';
      ctx.font = 'italic 16px Georgia, serif';
      ctx.fillText(`“${input.giftNote.trim().slice(0, 48)}”`, 300, 796);
    }
    ctx.restore();
  }

  // Crisp editorial footer watermark
  ctx.save();
  ctx.strokeStyle = 'rgba(176, 138, 74, 0.35)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(150, 854);
  ctx.lineTo(450, 854);
  ctx.stroke();

  ctx.fillStyle = '#8A672C';
  ctx.font = '600 11px Georgia, serif';
  ctx.textAlign = 'center';
  ctx.fillText('TRYVIBE · MIX & MATCH STUDIO', 300, 875);
  ctx.restore();

  if (offscreen && typeof offscreen.convertToBlob === 'function') {
    try {
      const blob = await offscreen.convertToBlob({ type: 'image/png' });
      return await blobToDataUrl(blob);
    } catch {
      // Fall through if convertToBlob is blocked by tainted CORS image
    }
  }

  if (fallbackCanvas) {
    try {
      return fallbackCanvas.toDataURL('image/png');
    } catch {
      return null;
    }
  }

  return null;
}
