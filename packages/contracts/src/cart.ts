import { z } from 'zod';

export const OutfitSlot = {
  TOP: 'TOP',
  BOTTOM: 'BOTTOM',
  ONE_PIECE: 'ONE_PIECE',
  OUTERWEAR: 'OUTERWEAR',
  ACCESSORY: 'ACCESSORY',
} as const;
export type OutfitSlot = (typeof OutfitSlot)[keyof typeof OutfitSlot];
export const OutfitSlotSchema = z.enum([
  OutfitSlot.TOP,
  OutfitSlot.BOTTOM,
  OutfitSlot.ONE_PIECE,
  OutfitSlot.OUTERWEAR,
  OutfitSlot.ACCESSORY,
]);

export const CartItemDtoSchema = z.object({
  id: z.string().min(1),
  skuId: z.string().min(1),
  productId: z.string().min(1),
  variantId: z.string().min(1),
  slug: z.string().min(1),
  productName: z.string().min(1),
  colorName: z.string().min(1),
  colorHex: z.string().min(4).max(16),
  sizeCode: z.string().min(1),
  imageUrl: z.string().nullable(),
  slot: OutfitSlotSchema.nullable(),
  unitPriceVnd: z.number().int().nonnegative(),
  qty: z.number().int().positive(),
  lineTotalVnd: z.number().int().nonnegative(),
  bundleGroupId: z.string().nullable(),
  fromAiTryon: z.boolean(),
  availableQty: z.number().int().nonnegative(),
  inStock: z.boolean(),
  lowStockWarning: z.boolean(),
});
export type CartItemDto = z.infer<typeof CartItemDtoSchema>;

export const CartDtoSchema = z.object({
  cartKey: z.string().min(1),
  items: z.array(CartItemDtoSchema),
  packagingOptionId: z.string().nullable(),
  packagingName: z.string().nullable(),
  packagingPriceVnd: z.number().int().nonnegative(),
  giftNote: z.string().max(140).nullable(),
  subtotalVnd: z.number().int().nonnegative(),
  comboDiscountPct: z.number().min(0).max(100),
  comboDiscountVnd: z.number().int().nonnegative(),
  totalVnd: z.number().int().nonnegative(),
  totalQty: z.number().int().nonnegative(),
  freeShipThresholdVnd: z.number().int().nonnegative(),
  remainingForFreeShipVnd: z.number().int().nonnegative(),
  updatedAt: z.string(),
});
export type CartDto = z.infer<typeof CartDtoSchema>;

export const AddCartItemSchema = z.object({
  skuId: z.string().min(1),
  productId: z.string().min(1).optional(),
  variantId: z.string().min(1).optional(),
  qty: z.number().int().positive().max(99).default(1),
  slot: OutfitSlotSchema.nullable().optional(),
  fromAiTryon: z.boolean().default(false),
  bundleGroupId: z.string().min(1).nullable().optional(),
});
export type AddCartItemRequest = z.infer<typeof AddCartItemSchema>;

export const UpdateCartItemSchema = z.object({
  qty: z.number().int().min(0).max(99),
});
export type UpdateCartItemRequest = z.infer<typeof UpdateCartItemSchema>;

export const AddOutfitBundleItemSchema = z.object({
  skuId: z.string().min(1),
  productId: z.string().min(1).optional(),
  variantId: z.string().min(1).optional(),
  qty: z.number().int().positive().max(99).default(1),
  slot: OutfitSlotSchema,
  fromAiTryon: z.boolean().default(false),
});

export const AddOutfitBundleSchema = z.object({
  items: z.array(AddOutfitBundleItemSchema).min(1).max(10),
  packagingOptionId: z.string().min(1).nullable().optional(),
  giftNote: z.string().max(140).nullable().optional(),
});
export type AddOutfitBundleRequest = z.infer<typeof AddOutfitBundleSchema>;

export const UpdateCartPackagingSchema = z.object({
  packagingOptionId: z.string().min(1).nullable().optional(),
  giftNote: z.string().max(140).nullable().optional(),
});
export type UpdateCartPackagingRequest = z.infer<typeof UpdateCartPackagingSchema>;

export const MergeCartRequestSchema = z.object({
  guestSessionId: z.string().min(1),
});
export type MergeCartRequest = z.infer<typeof MergeCartRequestSchema>;

export const OutfitStudioSlotItemSchema = z.object({
  slot: OutfitSlotSchema,
  productId: z.string().min(1),
  variantId: z.string().min(1),
  skuId: z.string().min(1),
  slug: z.string().optional(),
  productName: z.string().optional(),
  colorName: z.string().optional(),
  colorHex: z.string().optional(),
  sizeCode: z.string().optional(),
  imageUrl: z.string().nullable().optional(),
  unitPriceVnd: z.number().int().nonnegative().optional(),
  qty: z.number().int().positive().max(99).default(1),
  availableQty: z.number().int().nonnegative().optional(),
  inStock: z.boolean().optional(),
  lowStockWarning: z.boolean().optional(),
});
export type OutfitStudioSlotItem = z.infer<typeof OutfitStudioSlotItemSchema>;

export const OutfitStudioPreviewRequestSchema = z.object({
  items: z.array(OutfitStudioSlotItemSchema).min(1).max(10),
  packagingOptionId: z.string().min(1).nullable().optional(),
  giftNote: z.string().max(140).nullable().optional(),
});
export type OutfitStudioPreviewRequest = z.infer<typeof OutfitStudioPreviewRequestSchema>;

export const OutfitStudioPreviewResponseSchema = z.object({
  items: z.array(OutfitStudioSlotItemSchema),
  distinctSlotCount: z.number().int().nonnegative(),
  subtotalVnd: z.number().int().nonnegative(),
  comboDiscountPct: z.number().min(0).max(100),
  comboDiscountVnd: z.number().int().nonnegative(),
  packagingOptionId: z.string().nullable(),
  packagingPriceVnd: z.number().int().nonnegative(),
  totalVnd: z.number().int().nonnegative(),
  giftNote: z.string().max(140).nullable(),
  allInStock: z.boolean(),
  lowStockItems: z.array(
    z.object({
      skuId: z.string().min(1),
      productName: z.string().optional(),
      availableQty: z.number().int().nonnegative(),
    }),
  ),
});
export type OutfitStudioPreviewResponse = z.infer<typeof OutfitStudioPreviewResponseSchema>;

export const CreateSavedOutfitSchema = z.object({
  title: z.string().trim().min(1).max(120),
  slots: z.array(OutfitStudioSlotItemSchema).min(1).max(10),
  packagingOptionId: z.string().min(1).nullable().optional(),
  giftNote: z.string().max(140).nullable().optional(),
  previewUrl: z.string().nullable().optional(),
});
export type CreateSavedOutfitRequest = z.infer<typeof CreateSavedOutfitSchema>;

export const SavedOutfitDtoSchema = z.object({
  id: z.string().min(1),
  userId: z.string().nullable(),
  shareCode: z.string().min(1),
  title: z.string().min(1),
  slots: z.array(OutfitStudioSlotItemSchema),
  packagingOptionId: z.string().nullable(),
  giftNote: z.string().max(140).nullable(),
  previewUrl: z.string().nullable(),
  createdAt: z.string(),
});
export type SavedOutfitDto = z.infer<typeof SavedOutfitDtoSchema>;
