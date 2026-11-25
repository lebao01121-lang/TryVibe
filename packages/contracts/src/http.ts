import { z } from 'zod';
import {
  CategoryDtoSchema,
  HomepageCampaignDtoSchema,
  OccasionLookbookDtoSchema,
  PackagingOptionDtoSchema,
  ProductSpuDtoSchema,
  SeasonInteractiveLookbookSchema,
  SeasonalCollectionDtoSchema,
} from './catalog';

export const HTTP_HEADERS = {
  CORRELATION_ID: 'X-Correlation-Id',
  IDEMPOTENCY_KEY: 'Idempotency-Key',
  CSRF_TOKEN: 'X-CSRF-Token',
  GUEST_SESSION_ID: 'X-Guest-Session-Id',
  AUTHORIZATION: 'Authorization',
} as const;

export type HttpHeaderName = (typeof HTTP_HEADERS)[keyof typeof HTTP_HEADERS];

export const ErrorCode = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  IDEMPOTENCY_CONFLICT: 'IDEMPOTENCY_CONFLICT',
  INSUFFICIENT_STOCK: 'INSUFFICIENT_STOCK',
  RATE_LIMITED: 'RATE_LIMITED',
  AI_GUARDRAIL_BLOCKED: 'AI_GUARDRAIL_BLOCKED',
  AI_CIRCUIT_OPEN: 'AI_CIRCUIT_OPEN',
  DEPENDENCY_UNAVAILABLE: 'DEPENDENCY_UNAVAILABLE',
  INTERNAL_ERROR: 'INTERNAL_ERROR',

  // Phase 1 IAM & Media security error codes
  MFA_REQUIRED: 'MFA_REQUIRED',
  CSRF_INVALID: 'CSRF_INVALID',
  TOKEN_REUSE_DETECTED: 'TOKEN_REUSE_DETECTED',
  PERMISSION_REVOKED: 'PERMISSION_REVOKED',
  INVALID_MAGIC_BYTES: 'INVALID_MAGIC_BYTES',
  INVALID_ASPECT_OR_ALPHA: 'INVALID_ASPECT_OR_ALPHA',

  // Phase 4 Inventory, Cart & AI Try-On error codes
  QUOTA_EXCEEDED: 'QUOTA_EXCEEDED',
  PRIVACY_CONSENT_REQUIRED: 'PRIVACY_CONSENT_REQUIRED',
  BOOKMARK_LIMIT_EXCEEDED: 'BOOKMARK_LIMIT_EXCEEDED',
  RESERVATION_NOT_FOUND: 'RESERVATION_NOT_FOUND',
  POSE_TOO_CLOSE: 'POSE_TOO_CLOSE',

  // Phase 5 Order, Payment, Promo, RMA, B2B & Copilot error codes
  PAYMENT_SIGNATURE_INVALID: 'PAYMENT_SIGNATURE_INVALID',
  PAYMENT_AMOUNT_MISMATCH: 'PAYMENT_AMOUNT_MISMATCH',
  PROMOTION_INVALID: 'PROMOTION_INVALID',
  PROMOTION_EXHAUSTED: 'PROMOTION_EXHAUSTED',
  COD_RISK_DEPOSIT_REQUIRED: 'COD_RISK_DEPOSIT_REQUIRED',
  RMA_WINDOW_EXPIRED: 'RMA_WINDOW_EXPIRED',
  RMA_NOT_RETURNABLE: 'RMA_NOT_RETURNABLE',
  PO_DRAFT_FORBIDDEN_FOR_SUPPLIER: 'PO_DRAFT_FORBIDDEN_FOR_SUPPLIER',
  ORDER_NOT_DELIVERED: 'ORDER_NOT_DELIVERED',
  PROMPT_INJECTION_BLOCKED: 'PROMPT_INJECTION_BLOCKED',
  REFUND_EXCEEDS_BALANCE: 'REFUND_EXCEEDS_BALANCE',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export const ErrorCodeSchema = z.enum([
  ErrorCode.VALIDATION_ERROR,
  ErrorCode.UNAUTHORIZED,
  ErrorCode.FORBIDDEN,
  ErrorCode.NOT_FOUND,
  ErrorCode.CONFLICT,
  ErrorCode.IDEMPOTENCY_CONFLICT,
  ErrorCode.INSUFFICIENT_STOCK,
  ErrorCode.RATE_LIMITED,
  ErrorCode.AI_GUARDRAIL_BLOCKED,
  ErrorCode.AI_CIRCUIT_OPEN,
  ErrorCode.DEPENDENCY_UNAVAILABLE,
  ErrorCode.INTERNAL_ERROR,
  ErrorCode.MFA_REQUIRED,
  ErrorCode.CSRF_INVALID,
  ErrorCode.TOKEN_REUSE_DETECTED,
  ErrorCode.PERMISSION_REVOKED,
  ErrorCode.INVALID_MAGIC_BYTES,
  ErrorCode.INVALID_ASPECT_OR_ALPHA,
  ErrorCode.QUOTA_EXCEEDED,
  ErrorCode.PRIVACY_CONSENT_REQUIRED,
  ErrorCode.BOOKMARK_LIMIT_EXCEEDED,
  ErrorCode.RESERVATION_NOT_FOUND,
  ErrorCode.POSE_TOO_CLOSE,
  ErrorCode.PAYMENT_SIGNATURE_INVALID,
  ErrorCode.PAYMENT_AMOUNT_MISMATCH,
  ErrorCode.PROMOTION_INVALID,
  ErrorCode.PROMOTION_EXHAUSTED,
  ErrorCode.COD_RISK_DEPOSIT_REQUIRED,
  ErrorCode.RMA_WINDOW_EXPIRED,
  ErrorCode.RMA_NOT_RETURNABLE,
  ErrorCode.PO_DRAFT_FORBIDDEN_FOR_SUPPLIER,
  ErrorCode.ORDER_NOT_DELIVERED,
  ErrorCode.PROMPT_INJECTION_BLOCKED,
  ErrorCode.REFUND_EXCEEDS_BALANCE,
]);

export interface ApiError {
  code: ErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

export interface ApiMeta {
  correlationId?: string;
  timestamp: string;
  service?: string;
}

export interface ApiResponse<T> {
  success: boolean;
  data: T | null;
  error: ApiError | null;
  meta: ApiMeta;
}

export interface PaginationMeta {
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
  hasNext: boolean;
  hasPrevious: boolean;
}

export const PagePaginationSchema = z.object({
  page: z.number().int().positive(),
  limit: z.number().int().positive(),
  total: z.number().int().nonnegative(),
  totalPages: z.number().int().nonnegative(),
});
export type PagePagination = z.infer<typeof PagePaginationSchema>;

export interface PaginatedResponse<T> {
  success: boolean;
  data: T[];
  pagination: PaginationMeta;
  error: ApiError | null;
  meta: ApiMeta;
}

export function createApiResponse<T>(
  data: T,
  meta: Partial<ApiMeta> = {},
): ApiResponse<T> {
  return {
    success: true,
    data,
    error: null,
    meta: {
      timestamp: new Date().toISOString(),
      ...meta,
    },
  };
}

export function createApiErrorResponse<T = never>(
  code: ErrorCode,
  message: string,
  details?: Record<string, unknown>,
  meta: Partial<ApiMeta> = {},
): ApiResponse<T> {
  return {
    success: false,
    data: null,
    error: {
      code,
      message,
      ...(details ? { details } : {}),
    },
    meta: {
      timestamp: new Date().toISOString(),
      ...meta,
    },
  };
}

export type HealthStatus = 'ok' | 'degraded' | 'down';

export interface DependencyCheck {
  name: string;
  status: 'up' | 'down' | 'skipped';
  latencyMs?: number;
  detail?: string;
}

export interface HealthResponse {
  status: HealthStatus;
  service: string;
  port: number;
  version: string;
  uptimeSeconds: number;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

export interface ReadinessResponse {
  status: HealthStatus;
  ready: boolean;
  service: string;
  port?: number;
  checks: DependencyCheck[];
  timestamp: string;
  metadata?: Record<string, unknown>;
}

export const StorefrontCampaignSummarySchema = z.object({
  code: z.string(),
  title: z.string(),
  subtitle: z.string(),
  eyebrow: z.string(),
  heroVideoUrl: z.string().optional(),
  heroPosterUrl: z.string().optional(),
  ctaLabel: z.string(),
  serviceNote: z.string(),
});

export type StorefrontCampaignSummary = z.infer<typeof StorefrontCampaignSummarySchema>;

export const StorefrontOccasionSummarySchema = z.object({
  key: z.string(),
  slug: z.string().optional(),
  name: z.string(),
  tagline: z.string(),
  themeBg: z.string(),
  themeInk: z.string(),
  themeAccent: z.string(),
  isDark: z.boolean(),
  itemCount: z.number().int().nonnegative(),
});

export type StorefrontOccasionSummary = z.infer<typeof StorefrontOccasionSummarySchema>;

export const StorefrontSeasonSummarySchema = z.object({
  slug: z.string(),
  months: z.string(),
  name: z.string(),
  shortName: z.string().optional(),
  materialHeadline: z.string().optional(),
  note: z.string(),
  isCurrent: z.boolean(),
  isCurrentSeason: z.boolean().optional(),
  coverAssetUrl: z.string().nullable().optional(),
  productCount: z.number().int().nonnegative().optional(),
  interactiveLookbook: SeasonInteractiveLookbookSchema.nullable().optional(),
  heroProducts: z.array(ProductSpuDtoSchema).optional(),
});

export type StorefrontSeasonSummary = z.infer<typeof StorefrontSeasonSummarySchema>;

export const StorefrontBootstrapDtoSchema = z.object({
  brand: z.string(),
  platformVersion: z.string(),
  campaign: StorefrontCampaignSummarySchema,
  rackPreviewCount: z.number().int().nonnegative(),
  occasions: z.array(StorefrontOccasionSummarySchema),
  seasonalCollections: z.array(StorefrontSeasonSummarySchema),
  serviceStatus: z.object({
    bff: z.enum(['ok', 'degraded']),
    aiTryOnMode: z.enum(['mock', 'fal', 'auto', 'pose_warp', 'hf_gradio']),
    phase: z.string(),
  }),
  generatedAt: z.string(),

  // Phase 1 & Phase 2 backward-compatible rich bootstrap extensions
  featuredProducts: z.array(ProductSpuDtoSchema).optional(),
  categories: z.array(CategoryDtoSchema).optional(),
  occasionLookbooks: z.array(OccasionLookbookDtoSchema).optional(),
  seasons: z.array(SeasonalCollectionDtoSchema).optional(),
  packagingOptions: z.array(PackagingOptionDtoSchema).optional(),
  homepageCampaign: HomepageCampaignDtoSchema.nullable().optional(),
  servicesStatus: z.record(z.enum(['ok', 'degraded', 'down'])).optional(),
});

export type StorefrontBootstrapDto = z.infer<typeof StorefrontBootstrapDtoSchema>;
