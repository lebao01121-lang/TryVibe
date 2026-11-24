import type { CartItemDto, OutfitSlot } from '@atelier/contracts';
import { FREE_SHIP_THRESHOLD_VND } from '../config/env';

/**
 * Combo Set Discount Rule:
 * - >= 3 distinct outfit slots (TOP, BOTTOM, ONE_PIECE, OUTERWEAR, ACCESSORY) -> 10%
 * - === 2 distinct outfit slots -> 5%
 * - < 2 distinct outfit slots -> 0%
 */
export function computeComboDiscountPct(distinctSlotCount: number): number {
  if (distinctSlotCount >= 3) {
    return 10;
  }
  if (distinctSlotCount === 2) {
    return 5;
  }
  return 0;
}

export function countDistinctSlots(slots: Array<OutfitSlot | null | undefined>): number {
  const unique = new Set<OutfitSlot>();
  for (const slot of slots) {
    if (slot) {
      unique.add(slot);
    }
  }
  return unique.size;
}

export interface CartTotalsSummary {
  subtotalVnd: number;
  comboDiscountPct: number;
  comboDiscountVnd: number;
  totalVnd: number;
  totalQty: number;
  freeShipThresholdVnd: number;
  remainingForFreeShipVnd: number;
}

export function computeCartTotals(
  items: readonly CartItemDto[],
  packagingPriceVnd: number,
  freeShipThresholdVnd: number = FREE_SHIP_THRESHOLD_VND,
): CartTotalsSummary {
  let subtotalVnd = 0;
  let totalQty = 0;
  const bundleGroups = new Map<string, CartItemDto[]>();

  for (const item of items) {
    subtotalVnd += item.lineTotalVnd;
    totalQty += item.qty;
    if (item.bundleGroupId) {
      const group = bundleGroups.get(item.bundleGroupId) ?? [];
      group.push(item);
      bundleGroups.set(item.bundleGroupId, group);
    }
  }

  let comboDiscountVnd = 0;
  let maxActiveComboPct = 0;

  for (const groupItems of bundleGroups.values()) {
    const distinctSlots = countDistinctSlots(groupItems.map((i) => i.slot));
    const pct = computeComboDiscountPct(distinctSlots);
    if (pct > 0) {
      const groupSubtotal = groupItems.reduce((sum, i) => sum + i.lineTotalVnd, 0);
      comboDiscountVnd += Math.round((groupSubtotal * pct) / 100);
      if (pct > maxActiveComboPct) {
        maxActiveComboPct = pct;
      }
    }
  }

  const netMerchandiseVnd = Math.max(0, subtotalVnd - comboDiscountVnd);
  const safePackagingPrice = Math.max(0, Math.round(packagingPriceVnd));
  const totalVnd = netMerchandiseVnd + safePackagingPrice;
  const remainingForFreeShipVnd = Math.max(0, freeShipThresholdVnd - netMerchandiseVnd);

  return {
    subtotalVnd,
    comboDiscountPct: maxActiveComboPct,
    comboDiscountVnd,
    totalVnd,
    totalQty,
    freeShipThresholdVnd,
    remainingForFreeShipVnd,
  };
}
