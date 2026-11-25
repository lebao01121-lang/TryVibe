import { z } from 'zod';

export const BiAnalyticsRange = {
  D7: '7d',
  D30: '30d',
  D90: '90d',
} as const;
export type BiAnalyticsRange = (typeof BiAnalyticsRange)[keyof typeof BiAnalyticsRange];
export const BiAnalyticsRangeSchema = z.enum([
  BiAnalyticsRange.D7,
  BiAnalyticsRange.D30,
  BiAnalyticsRange.D90,
]);

export const BiSeriesPointDtoSchema = z.object({
  date: z.string().min(1),
  netRevenueVnd: z.number().int().nonnegative(),
  refundedVnd: z.number().int().nonnegative(),
  orderCount: z.number().int().nonnegative(),
  rmaCount: z.number().int().nonnegative(),
  /** Layer 5 Redacted when caller lacks cost-price permission. */
  cogsVnd: z.number().int().nonnegative().optional(),
  grossMarginVnd: z.number().int().optional(),
  grossMarginPct: z.number().optional(),
});
export type BiSeriesPointDto = z.infer<typeof BiSeriesPointDtoSchema>;

export const BiTopSkuDtoSchema = z.object({
  skuId: z.string().min(1),
  skuCode: z.string().min(1),
  productId: z.string().min(1),
  productName: z.string().min(1),
  unitsSold: z.number().int().nonnegative(),
  netRevenueVnd: z.number().int().nonnegative(),
  /** Layer 5 Redacted when caller lacks cost-price permission. */
  cogsVnd: z.number().int().nonnegative().optional(),
  grossMarginVnd: z.number().int().optional(),
  grossMarginPct: z.number().optional(),
});
export type BiTopSkuDto = z.infer<typeof BiTopSkuDtoSchema>;

export const BiHighRmaSkuDtoSchema = z.object({
  skuId: z.string().min(1),
  skuCode: z.string().min(1),
  productId: z.string().min(1),
  productName: z.string().min(1),
  unitsSold: z.number().int().nonnegative(),
  rmaCount: z.number().int().nonnegative(),
  rmaRatePct: z.number().min(0).max(100),
  dominantReasonCode: z.string().min(1),
});
export type BiHighRmaSkuDto = z.infer<typeof BiHighRmaSkuDtoSchema>;

export const BiAnalyticsSummaryDtoSchema = z.object({
  range: BiAnalyticsRangeSchema,
  from: z.string().min(1),
  to: z.string().min(1),
  costDataRedacted: z.boolean(),
  netRevenueVnd: z.number().int().nonnegative(),
  grossRevenueVnd: z.number().int().nonnegative().optional(),
  refundedVnd: z.number().int().nonnegative(),
  orderCount: z.number().int().nonnegative(),
  completedOrderCount: z.number().int().nonnegative().optional(),
  cancelledOrderCount: z.number().int().nonnegative().optional(),
  rmaCount: z.number().int().nonnegative(),
  rmaRatePct: z.number().min(0).max(100).optional(),
  /** Layer 5 Redacted when caller lacks cost-price permission. */
  cogsVnd: z.number().int().nonnegative().optional(),
  totalCogsVnd: z.number().int().nonnegative().optional(),
  grossMarginVnd: z.number().int().optional(),
  grossMarginPct: z.number().optional(),
  series: z.array(BiSeriesPointDtoSchema),
  topSkus: z.array(BiTopSkuDtoSchema),
  highRmaSkus: z.array(BiHighRmaSkuDtoSchema),
  generatedAt: z.string(),
});
export type BiAnalyticsSummaryDto = z.infer<typeof BiAnalyticsSummaryDtoSchema>;
export type BiAnalyticsSummaryDTO = BiAnalyticsSummaryDto;
