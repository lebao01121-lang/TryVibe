import { z } from 'zod';

export const MediaAssetType = {
  RACK_CUTOUT_2_3: 'RACK_CUTOUT_2_3',
  STUDIO_LAYER_2_3: 'STUDIO_LAYER_2_3',
  PACKAGING_LAYER: 'PACKAGING_LAYER',
  TRYON_FLAT_3_4: 'TRYON_FLAT_3_4',
  LOOKBOOK_PHOTO: 'LOOKBOOK_PHOTO',
  HERO_VIDEO: 'HERO_VIDEO',
} as const;
export type MediaAssetType = (typeof MediaAssetType)[keyof typeof MediaAssetType];
export const MediaAssetTypeSchema = z.enum([
  MediaAssetType.RACK_CUTOUT_2_3,
  MediaAssetType.STUDIO_LAYER_2_3,
  MediaAssetType.PACKAGING_LAYER,
  MediaAssetType.TRYON_FLAT_3_4,
  MediaAssetType.LOOKBOOK_PHOTO,
  MediaAssetType.HERO_VIDEO,
]);

export const MediaAssetStatus = {
  PENDING: 'PENDING',
  READY: 'READY',
  REJECTED: 'REJECTED',
} as const;
export type MediaAssetStatus = (typeof MediaAssetStatus)[keyof typeof MediaAssetStatus];
export const MediaAssetStatusSchema = z.enum([
  MediaAssetStatus.PENDING,
  MediaAssetStatus.READY,
  MediaAssetStatus.REJECTED,
]);

export const AssetSpatialMetadataDtoSchema = z.object({
  assetId: z.string().min(1),
  hangerAnchorX: z.number().min(0).max(1),
  hangerAnchorY: z.number().min(0).max(1),
  boundingBoxJsonb: z.record(z.unknown()).nullable(),
  layerZHint: z.number().int().nullable(),
  updatedAt: z.string(),
});
export type AssetSpatialMetadataDto = z.infer<typeof AssetSpatialMetadataDtoSchema>;

export const UpdateSpatialMetadataSchema = z.object({
  hangerAnchorX: z.number().min(0).max(1),
  hangerAnchorY: z.number().min(0).max(1),
  boundingBoxJsonb: z.record(z.unknown()).nullable().optional(),
  layerZHint: z.number().int().nullable().optional(),
});
export type UpdateSpatialMetadataRequest = z.infer<typeof UpdateSpatialMetadataSchema>;

export const MediaVariantEntrySchema = z.union([
  z.string(),
  z.object({
    key: z.string().min(1),
    url: z.string().min(1),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
    mimeType: z.string().optional(),
    sizeBytes: z.number().int().nonnegative().optional(),
  }),
]);
export type MediaVariantEntry = z.infer<typeof MediaVariantEntrySchema>;

export const MediaAssetDtoSchema = z.object({
  id: z.string().min(1),
  assetType: MediaAssetTypeSchema,
  bucketName: z.string().min(1),
  originalKey: z.string().min(1),
  publicUrl: z.string().optional(),
  variants: z.record(MediaVariantEntrySchema),
  mimeType: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  hasAlpha: z.boolean(),
  dominantHex: z.string().nullable(),
  uploadedBy: z.string().nullable(),
  supplierId: z.string().nullable(),
  status: MediaAssetStatusSchema,
  rejectionReason: z.string().nullable(),
  spatialMetadata: AssetSpatialMetadataDtoSchema.nullable(),
  createdAt: z.string(),
});
export type MediaAssetDto = z.infer<typeof MediaAssetDtoSchema>;

export const PresignUploadRequestSchema = z.object({
  assetType: MediaAssetTypeSchema,
  fileName: z.string().trim().min(1).max(255),
  mimeType: z.string().trim().min(1).max(120),
  sizeBytes: z
    .number()
    .int()
    .positive()
    .max(25 * 1024 * 1024),
  supplierId: z.string().min(1).nullable().optional(),
});
export type PresignUploadRequest = z.infer<typeof PresignUploadRequestSchema>;

export const PresignUploadResponseSchema = z.object({
  assetId: z.string().min(1),
  bucketName: z.string().min(1),
  objectKey: z.string().min(1),
  uploadUrl: z.string().url(),
  method: z.literal('PUT'),
  expiresInSeconds: z.number().int().positive(),
  requiredHeaders: z.record(z.string()),
});
export type PresignUploadResponse = z.infer<typeof PresignUploadResponseSchema>;

export const FinalizeMediaRequestSchema = z.object({
  assetId: z.string().min(1),
  hangerAnchorX: z.number().min(0).max(1).optional(),
  hangerAnchorY: z.number().min(0).max(1).optional(),
  boundingBoxJsonb: z.record(z.unknown()).nullable().optional(),
  layerZHint: z.number().int().optional(),
});
export type FinalizeMediaRequest = z.infer<typeof FinalizeMediaRequestSchema>;
