import { z } from 'zod';

export const TryOnSource = {
  CAMERA_MEDIAPIPE: 'CAMERA_MEDIAPIPE',
  STATIC_UPLOAD: 'STATIC_UPLOAD',
} as const;
export type TryOnSource = (typeof TryOnSource)[keyof typeof TryOnSource];
export const TryOnSourceSchema = z.enum([
  TryOnSource.CAMERA_MEDIAPIPE,
  TryOnSource.STATIC_UPLOAD,
]);

export const TryOnMode = {
  SINGLE: 'SINGLE',
  MIX_MATCH_OUTFIT: 'MIX_MATCH_OUTFIT',
} as const;
export type TryOnMode = (typeof TryOnMode)[keyof typeof TryOnMode];
export const TryOnModeSchema = z.enum([TryOnMode.SINGLE, TryOnMode.MIX_MATCH_OUTFIT]);

export const TryOnProviderType = {
  MOCK: 'MOCK',
  FAL_CATVTON: 'FAL_CATVTON',
  HF_GRADIO_VTON: 'HF_GRADIO_VTON',
  SMART_POSE_WARP: 'SMART_POSE_WARP',
  CACHE_HIT: 'CACHE_HIT',
} as const;
export type TryOnProviderType = (typeof TryOnProviderType)[keyof typeof TryOnProviderType];
export const TryOnProviderTypeSchema = z.enum([
  TryOnProviderType.MOCK,
  TryOnProviderType.FAL_CATVTON,
  TryOnProviderType.HF_GRADIO_VTON,
  TryOnProviderType.SMART_POSE_WARP,
  TryOnProviderType.CACHE_HIT,
]);

export const TryOnPosePointSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  visibility: z.number().min(0).max(1).optional(),
});
export type TryOnPosePoint = z.infer<typeof TryOnPosePointSchema>;

export const TryOnFaceBoxSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  w: z.number().min(0).max(1),
  h: z.number().min(0).max(1),
});
export type TryOnFaceBox = z.infer<typeof TryOnFaceBoxSchema>;

export const TryOnPoseLandmarksSchema = z.object({
  nose: TryOnPosePointSchema.optional(),
  leftShoulder: TryOnPosePointSchema.optional(),
  rightShoulder: TryOnPosePointSchema.optional(),
  leftHip: TryOnPosePointSchema.optional(),
  rightHip: TryOnPosePointSchema.optional(),
  chinY: z.number().min(0).max(1).optional(),
  faceBox: TryOnFaceBoxSchema.optional(),
});
export type TryOnPoseLandmarks = z.infer<typeof TryOnPoseLandmarksSchema>;

export const TryOnSessionStatus = {
  QUEUED: 'QUEUED',
  PROCESSING_STEP_1: 'PROCESSING_STEP_1',
  PROCESSING_STEP_2: 'PROCESSING_STEP_2',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
} as const;
export type TryOnSessionStatus = (typeof TryOnSessionStatus)[keyof typeof TryOnSessionStatus];
export const TryOnSessionStatusSchema = z.enum([
  TryOnSessionStatus.QUEUED,
  TryOnSessionStatus.PROCESSING_STEP_1,
  TryOnSessionStatus.PROCESSING_STEP_2,
  TryOnSessionStatus.COMPLETED,
  TryOnSessionStatus.FAILED,
]);

export const TryOnSignalType = {
  OPEN_MODAL: 'OPEN_MODAL',
  TRYON_COMPLETED: 'TRYON_COMPLETED',
  SIZE_ADVISED: 'SIZE_ADVISED',
  ADD_TO_CART_AFTER_TRYON: 'ADD_TO_CART_AFTER_TRYON',
} as const;
export type TryOnSignalType = (typeof TryOnSignalType)[keyof typeof TryOnSignalType];
export const TryOnSignalTypeSchema = z.enum([
  TryOnSignalType.OPEN_MODAL,
  TryOnSignalType.TRYON_COMPLETED,
  TryOnSignalType.SIZE_ADVISED,
  TryOnSignalType.ADD_TO_CART_AFTER_TRYON,
]);

export const TryOnUploadUrlRequestSchema = z.object({
  contentType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
  fileSizeBytes: z.number().int().positive().max(10_485_760),
  sha256Hash: z.string().min(16).max(128),
  source: TryOnSourceSchema,
  poseScore: z.number().min(0).max(1),
  privacyConsent: z.literal(true),
});
export type TryOnUploadUrlRequest = z.infer<typeof TryOnUploadUrlRequestSchema>;

export const TryOnUploadUrlResponseSchema = z.object({
  uploadUrl: z.string().url(),
  objectKey: z.string().min(1),
  tempImageId: z.string().min(1),
  expiresAt: z.string(),
  purgeAt: z.string(),
  remainingQuota: z.number().int().nonnegative(),
  dailyLimit: z.number().int().nonnegative(),
});
export type TryOnUploadUrlResponse = z.infer<typeof TryOnUploadUrlResponseSchema>;

export const CreateTryOnSessionRequestSchema = z.object({
  tempImageId: z.string().min(1),
  objectKey: z.string().min(1),
  sha256Hash: z.string().min(16).max(128),
  mode: TryOnModeSchema,
  upperProductId: z.string().min(1).optional(),
  upperVariantId: z.string().min(1).optional(),
  lowerProductId: z.string().min(1).optional(),
  lowerVariantId: z.string().min(1).optional(),
  onePieceProductId: z.string().min(1).optional(),
  onePieceVariantId: z.string().min(1).optional(),
  privacyConsent: z.literal(true),
  simulateFailure: z.boolean().optional(),
  poseLandmarks: TryOnPoseLandmarksSchema.nullable().optional(),
});
export type CreateTryOnSessionRequest = z.infer<typeof CreateTryOnSessionRequestSchema>;

export const CreateTryOnSessionResponseSchema = z.object({
  sessionId: z.string().min(1),
  status: TryOnSessionStatusSchema,
  providerUsed: TryOnProviderTypeSchema,
  providerDisplayBadge: z.string().nullable().optional(),
  totalSteps: z.number().int().positive(),
  cacheHit: z.boolean(),
  resultUrl: z.string().nullable().optional(),
  errorCode: z.string().nullable().optional(),
  expiresAt: z.string().nullable().optional(),
  remainingQuota: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative().optional(),
});
export type CreateTryOnSessionResponse = z.infer<typeof CreateTryOnSessionResponseSchema>;

export const TryOnSessionStatusDtoSchema = z.object({
  sessionId: z.string().min(1),
  status: TryOnSessionStatusSchema,
  mode: TryOnModeSchema,
  providerUsed: TryOnProviderTypeSchema,
  providerDisplayBadge: z.string().nullable().optional(),
  progressPct: z.number().int().min(0).max(100),
  stepOrder: z.number().int().nonnegative(),
  totalSteps: z.number().int().positive(),
  stepMessage: z.string(),
  resultUrl: z.string().nullable(),
  errorCode: z.string().nullable().optional(),
  errorMessage: z.string().nullable(),
  expiresAt: z.string().nullable(),
  purgeAt: z.string().nullable(),
  totalDurationMs: z.number().int().nonnegative().nullable(),
  remainingQuota: z.number().int().nonnegative(),
  createdAt: z.string(),
  completedAt: z.string().nullable(),
});
export type TryOnSessionStatusDto = z.infer<typeof TryOnSessionStatusDtoSchema>;

export const TryOnRealtimeEventSchema = z.object({
  sessionId: z.string().min(1),
  event: z.enum(['tryon:progress', 'tryon:completed', 'tryon:failed']),
  status: TryOnSessionStatusSchema.optional(),
  providerUsed: TryOnProviderTypeSchema.optional(),
  providerDisplayBadge: z.string().nullable().optional(),
  progressPct: z.number().int().min(0).max(100).optional(),
  stepOrder: z.number().int().nonnegative().optional(),
  totalSteps: z.number().int().positive().optional(),
  stepMessage: z.string().optional(),
  resultUrl: z.string().nullable().optional(),
  errorCode: z.string().nullable().optional(),
  errorMessage: z.string().nullable().optional(),
  remainingQuota: z.number().int().nonnegative().optional(),
  expiresAt: z.string().nullable().optional(),
  durationMs: z.number().int().nonnegative().optional(),
});
export type TryOnRealtimeEvent = z.infer<typeof TryOnRealtimeEventSchema>;

export const TryOnBookmarkDtoSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  userId: z.string().nullable().optional(),
  guestSessionId: z.string().nullable().optional(),
  upperSkuId: z.string().nullable(),
  lowerSkuId: z.string().nullable(),
  onePieceSkuId: z.string().nullable(),
  label: z.string().nullable(),
  resultUrl: z.string().nullable(),
  expiresAt: z.string().nullable().optional(),
  createdAt: z.string(),
});
export type TryOnBookmarkDto = z.infer<typeof TryOnBookmarkDtoSchema>;

export const CreateTryOnBookmarkSchema = z.object({
  sessionId: z.string().min(1),
  upperSkuId: z.string().min(1).nullable().optional(),
  lowerSkuId: z.string().min(1).nullable().optional(),
  onePieceSkuId: z.string().min(1).nullable().optional(),
  label: z.string().trim().max(120).optional(),
});
export type CreateTryOnBookmarkRequest = z.infer<typeof CreateTryOnBookmarkSchema>;

export const TryOnSignalRequestSchema = z.object({
  productId: z.string().min(1),
  skuId: z.string().min(1).optional(),
  sessionId: z.string().min(1).optional(),
  signalType: TryOnSignalTypeSchema,
});
export type TryOnSignalRequest = z.infer<typeof TryOnSignalRequestSchema>;
