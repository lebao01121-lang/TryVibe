import type { CartDto, ProductSpuDto, TryOnMode } from '@atelier/contracts';

export interface TryOnGarmentRef {
  productId: string;
  variantId?: string;
  skuId?: string;
  slug?: string;
  productName?: string;
  imageUrl?: string | null;
}

export interface OpenTryOnOptions {
  mode?: TryOnMode;
  upper?: TryOnGarmentRef | null;
  lower?: TryOnGarmentRef | null;
  onePiece?: TryOnGarmentRef | null;
  outerwear?: TryOnGarmentRef | null;
}

export type ActiveStudioOutfitSlotKey =
  | 'TOP'
  | 'BOTTOM'
  | 'ONE_PIECE'
  | 'OUTERWEAR'
  | 'ACCESSORY';

export interface ActiveStudioOutfitSlotEntry {
  productId: string;
  variantId?: string;
  skuId?: string;
  slug: string;
  productName: string;
  colorName?: string;
  sizeCode?: string;
  imageUrl?: string | null;
}

export interface ActiveStudioOutfitSnapshot {
  updatedAt: string;
  slots: Partial<Record<ActiveStudioOutfitSlotKey, ActiveStudioOutfitSlotEntry>>;
}

export interface OpenQuickBagDetail {
  quickProduct?: ProductSpuDto | null;
}

export const ACTIVE_STUDIO_OUTFIT_STORAGE_KEY = 'atelier_active_studio_outfit_v1';
export const CACHED_CART_STORAGE_KEY = 'atelier_cached_cart_v1';

const EVT_OPEN_BAG = 'atelier:open-quick-bag';
const EVT_OPEN_TRYON = 'atelier:open-virtual-tryon';
const EVT_CART_UPDATED = 'atelier:cart-updated';
const EVT_REFRESH_CART = 'atelier:refresh-cart';

export function saveActiveStudioOutfitSnapshot(
  snapshot: ActiveStudioOutfitSnapshot | null,
): void {
  if (typeof window === 'undefined') return;
  try {
    if (!snapshot) {
      window.localStorage.removeItem(ACTIVE_STUDIO_OUTFIT_STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(
      ACTIVE_STUDIO_OUTFIT_STORAGE_KEY,
      JSON.stringify(snapshot),
    );
  } catch {
    // Ignore storage quota / private mode errors
  }
}

export function loadActiveStudioOutfitSnapshot(): ActiveStudioOutfitSnapshot | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(ACTIVE_STUDIO_OUTFIT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ActiveStudioOutfitSnapshot | null;
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      typeof parsed.updatedAt !== 'string' ||
      !parsed.slots ||
      typeof parsed.slots !== 'object'
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function saveCachedCartSnapshot(cart: CartDto | null): void {
  if (typeof window === 'undefined') return;
  try {
    if (!cart) {
      window.localStorage.removeItem(CACHED_CART_STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(CACHED_CART_STORAGE_KEY, JSON.stringify(cart));
  } catch {
    // Ignore storage quota / private mode errors
  }
}

export function loadCachedCartSnapshot(): CartDto | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(CACHED_CART_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CartDto | null;
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function openQuickBagDrawer(quickProduct?: ProductSpuDto | null): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent<OpenQuickBagDetail>(EVT_OPEN_BAG, {
      detail: { quickProduct: quickProduct ?? null },
    }),
  );
}

export function openVirtualTryOnModal(opts: OpenTryOnOptions = {}): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent<OpenTryOnOptions>(EVT_OPEN_TRYON, {
      detail: opts,
    }),
  );
}

export function emitCartUpdated(cart: CartDto | null): void {
  saveCachedCartSnapshot(cart);
  if (typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent<CartDto | null>(EVT_CART_UPDATED, {
      detail: cart,
    }),
  );
}

export function refreshCartCount(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(EVT_REFRESH_CART));
}

export function onOpenQuickBag(
  handler: (detail: OpenQuickBagDetail) => void,
): () => void {
  if (typeof window === 'undefined') return () => {};
  const listener = (event: Event) => {
    const custom = event as CustomEvent<OpenQuickBagDetail>;
    handler(custom.detail ?? {});
  };
  window.addEventListener(EVT_OPEN_BAG, listener);
  return () => window.removeEventListener(EVT_OPEN_BAG, listener);
}

export function onOpenVirtualTryOn(
  handler: (opts: OpenTryOnOptions) => void,
): () => void {
  if (typeof window === 'undefined') return () => {};
  const listener = (event: Event) => {
    const custom = event as CustomEvent<OpenTryOnOptions>;
    handler(custom.detail ?? {});
  };
  window.addEventListener(EVT_OPEN_TRYON, listener);
  return () => window.removeEventListener(EVT_OPEN_TRYON, listener);
}

export function onCartUpdated(
  handler: (cart: CartDto | null) => void,
): () => void {
  if (typeof window === 'undefined') return () => {};
  const listener = (event: Event) => {
    const custom = event as CustomEvent<CartDto | null>;
    handler(custom.detail ?? null);
  };
  window.addEventListener(EVT_CART_UPDATED, listener);
  return () => window.removeEventListener(EVT_CART_UPDATED, listener);
}

export function onRefreshCartCount(handler: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  window.addEventListener(EVT_REFRESH_CART, handler);
  return () => window.removeEventListener(EVT_REFRESH_CART, handler);
}
