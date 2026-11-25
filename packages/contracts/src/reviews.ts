import { z } from 'zod';

export const FitFeedback = {
  RUNS_SMALL: 'RUNS_SMALL',
  TRUE_TO_SIZE: 'TRUE_TO_SIZE',
  RUNS_LARGE: 'RUNS_LARGE',
} as const;
export type FitFeedback = (typeof FitFeedback)[keyof typeof FitFeedback];
export const FitFeedbackSchema = z.enum([
  FitFeedback.RUNS_SMALL,
  FitFeedback.TRUE_TO_SIZE,
  FitFeedback.RUNS_LARGE,
]);

export const ReviewModerationStatus = {
  APPROVED: 'APPROVED',
  PENDING: 'PENDING',
  REJECTED: 'REJECTED',
} as const;
export type ReviewModerationStatus =
  (typeof ReviewModerationStatus)[keyof typeof ReviewModerationStatus];
export const ReviewModerationStatusSchema = z.enum([
  ReviewModerationStatus.APPROVED,
  ReviewModerationStatus.PENDING,
  ReviewModerationStatus.REJECTED,
]);

export const NotificationChannel = {
  EMAIL: 'EMAIL',
  ZALO_ZNS: 'ZALO_ZNS',
  SMS: 'SMS',
} as const;
export type NotificationChannel = (typeof NotificationChannel)[keyof typeof NotificationChannel];
export const NotificationChannelSchema = z.enum([
  NotificationChannel.EMAIL,
  NotificationChannel.ZALO_ZNS,
  NotificationChannel.SMS,
]);

export const ProductFitStatsDtoSchema = z.object({
  productId: z.string().min(1),
  runsSmallPct: z.number().min(0).max(100),
  trueToSizePct: z.number().min(0).max(100),
  runsLargePct: z.number().min(0).max(100),
  totalReviews: z.number().int().nonnegative(),
  averageRating: z.number().min(0).max(5),
  dominantFeedback: FitFeedbackSchema,
});
export type ProductFitStatsDto = z.infer<typeof ProductFitStatsDtoSchema>;

export const ReviewSentimentLabel = {
  POSITIVE: 'POSITIVE',
  NEUTRAL: 'NEUTRAL',
  NEGATIVE: 'NEGATIVE',
} as const;
export type ReviewSentimentLabel =
  (typeof ReviewSentimentLabel)[keyof typeof ReviewSentimentLabel];
export const ReviewSentimentLabelSchema = z.enum([
  ReviewSentimentLabel.POSITIVE,
  ReviewSentimentLabel.NEUTRAL,
  ReviewSentimentLabel.NEGATIVE,
]);

export const VerifiedReviewDtoSchema = z.object({
  id: z.string().min(1),
  orderId: z.string().min(1).nullable(),
  orderItemId: z.string().min(1).nullable(),
  productId: z.string().min(1),
  skuId: z.string().min(1),
  userId: z.string().min(1),
  reviewerName: z.string().min(1),
  rating: z.number().int().min(1).max(5),
  fitFeedback: FitFeedbackSchema,
  reviewerHeightCm: z.number().min(120).max(230).nullable(),
  reviewerWeightKg: z.number().min(25).max(200).nullable(),
  sizePurchased: z.string().min(1),
  comment: z.string(),
  photoUrls: z.array(z.string()),
  sentimentScore: z.number().min(-1).max(1).nullable(),
  sentimentLabel: ReviewSentimentLabelSchema.nullable().optional(),
  moderationStatus: ReviewModerationStatusSchema,
  isHidden: z.boolean().optional(),
  moderationNote: z.string().nullable().optional(),
  moderatedBy: z.string().nullable().optional(),
  moderatedAt: z.string().nullable().optional(),
  createdAt: z.string(),
});
export type VerifiedReviewDto = z.infer<typeof VerifiedReviewDtoSchema>;

export const CreateReviewRequestSchema = z.object({
  productId: z.string().min(1),
  skuId: z.string().min(1),
  orderId: z.string().min(1).optional(),
  orderItemId: z.string().min(1).optional(),
  rating: z.number().int().min(1).max(5),
  fitFeedback: FitFeedbackSchema,
  reviewerHeightCm: z.number().min(120).max(230),
  reviewerWeightKg: z.number().min(25).max(200),
  sizePurchased: z.string().trim().min(1).max(16),
  comment: z.string().trim().min(1).max(2000),
  photoUrls: z.array(z.string().min(1)).max(6).optional(),
});
export type CreateReviewRequest = z.infer<typeof CreateReviewRequestSchema>;

export const ProductReviewsResponseDtoSchema = z.object({
  productId: z.string().min(1),
  fitStats: ProductFitStatsDtoSchema,
  reviews: z.array(VerifiedReviewDtoSchema),
  total: z.number().int().nonnegative(),
});
export type ProductReviewsResponseDto = z.infer<typeof ProductReviewsResponseDtoSchema>;

// ----------------------------------------------------------------------------
// Stage P2.1: Review Moderation & Notification Logs DTOs
// ----------------------------------------------------------------------------

export const ModerateReviewDtoSchema = z.object({
  isHidden: z.boolean().optional(),
  moderationStatus: z
    .enum(['VISIBLE', 'HIDDEN', 'APPROVED', 'PENDING', 'REJECTED'])
    .optional(),
  moderationNote: z.string().max(500).nullable().optional(),
  moderatedBy: z.string().trim().max(140).optional(),
});
export type ModerateReviewDto = z.infer<typeof ModerateReviewDtoSchema>;

export const AdminReviewsQuerySchema = z.object({
  rating: z.coerce.number().int().min(1).max(5).optional(),
  sentiment: ReviewSentimentLabelSchema.optional(),
  sentimentLabel: ReviewSentimentLabelSchema.optional(),
  isHidden: z.union([z.boolean(), z.string()]).optional(),
  q: z.string().trim().optional(),
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
});
export type AdminReviewsQuery = z.infer<typeof AdminReviewsQuerySchema>;

export const NotificationLogDtoSchema = z.object({
  id: z.string().min(1),
  eventId: z.string().min(1),
  channel: NotificationChannelSchema,
  recipient: z.string().min(1),
  templateCode: z.string().min(1),
  subject: z.string().nullable().optional(),
  payload: z.record(z.unknown()).nullable().optional(),
  status: z.string().min(1),
  retryCount: z.number().int().nonnegative(),
  sentAt: z.string().nullable(),
  createdAt: z.string(),
});
export type NotificationLogDto = z.infer<typeof NotificationLogDtoSchema>;

export const NotificationLogsQuerySchema = z.object({
  channel: z.string().trim().optional(),
  status: z.string().trim().optional(),
  q: z.string().trim().optional(),
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
});
export type NotificationLogsQuery = z.infer<typeof NotificationLogsQuerySchema>;
