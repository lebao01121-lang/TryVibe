import { z } from 'zod';
import { FitPreference, FitPreferenceSchema } from './auth';
import { SizeCodeSchema } from './catalog';
import { Permission } from './rbac';
import { ProductFitStatsDtoSchema } from './reviews';

export const McpToolName = {
  // 4 Admin Copilot Tools
  VALIDATE_AND_PROCESS_GARMENT_IMAGE: 'validate_and_process_garment_image',
  GET_TRYON_DEMAND_SIGNALS: 'get_tryon_demand_signals',
  CREATE_PURCHASE_ORDER_DRAFT: 'create_purchase_order_draft',
  ANALYZE_REFUND_AND_SIZING_ISSUES: 'analyze_refund_and_sizing_issues',

  // 4 Read-Only Customer Stylist & Tier-0 Tools
  SEARCH_CATALOG_AND_SIZE_GUIDE: 'search_catalog_and_size_guide',
  GET_OUTFIT_COMPATIBILITY_ADVICE: 'get_outfit_compatibility_advice',
  CALCULATE_VERIFIED_SIZE: 'calculate_verified_size',
  SEARCH_IN_STOCK_OUTFITS: 'search_in_stock_outfits',
} as const;

export type McpToolName = (typeof McpToolName)[keyof typeof McpToolName];

export type McpToolMode = 'READ_ONLY' | 'MUTATING_DRAFT';
export type McpToolAudience = 'ADMIN' | 'CUSTOMER';

export const GroundedCitationSchema = z.object({
  sourceId: z.string().min(1),
  title: z.string().min(1),
  snippet: z.string().min(1),
  score: z.number().min(0),
});
export type GroundedCitation = z.infer<typeof GroundedCitationSchema>;

export const PurchaseOrderDraftStatusSchema = z.literal('NHAP_AI');
export type PurchaseOrderDraftStatus = z.infer<typeof PurchaseOrderDraftStatusSchema>;

// ----------------------------------------------------------------------------
// Admin Tool 1: validate_and_process_garment_image (MUTATING_DRAFT)
// ----------------------------------------------------------------------------
export const ValidateAndProcessGarmentImageInputSchema = z.object({
  productId: z.string().min(1),
  variantId: z.string().min(1).optional(),
  bucket: z.enum(['atelier-public', 'atelier-garments']),
  objectKey: z.string().min(1),
  targetUsage: z.enum(['TRYON_GARMENT', 'RACK_3D', 'OUTFIT_STUDIO']).default('TRYON_GARMENT'),
  operatorNote: z.string().max(300).optional(),
});
export type ValidateAndProcessGarmentImageInput = z.infer<
  typeof ValidateAndProcessGarmentImageInputSchema
>;

export const ValidateAndProcessGarmentImageOutputSchema = z.object({
  draftAssetId: z.string().min(1),
  productId: z.string().min(1),
  isValid: z.boolean(),
  qualityScore: z.number().min(0).max(100),
  detectedAspectRatio: z.string(),
  hasTransparentBackground: z.boolean(),
  suggestedGarmentCategory: z.enum(['UPPER_BODY', 'LOWER_BODY', 'DRESS', 'OUTERWEAR']),
  normalizedPreviewKey: z.string().min(1).optional(),
  autoAttachAsTryOnGarment: z.literal(false),
  requiresHumanApproval: z.literal(true),
  status: z.literal('NHAP_AI'),
  warnings: z.array(z.string()),
});
export type ValidateAndProcessGarmentImageOutput = z.infer<
  typeof ValidateAndProcessGarmentImageOutputSchema
>;

// ----------------------------------------------------------------------------
// Admin Tool 2: get_tryon_demand_signals (READ_ONLY)
// ----------------------------------------------------------------------------
export const GetTryOnDemandSignalsInputSchema = z.object({
  periodDays: z.number().int().min(1).max(90).default(14),
  categorySlug: z.string().optional(),
  limit: z.number().int().min(1).max(50).default(10),
});
export type GetTryOnDemandSignalsInput = z.infer<typeof GetTryOnDemandSignalsInputSchema>;

export const TryOnDemandSignalItemSchema = z.object({
  productId: z.string().min(1),
  productName: z.string().min(1),
  skuCode: z.string().min(1),
  size: z.string().min(1),
  tryOnSessions: z.number().int().nonnegative(),
  addToCartCount: z.number().int().nonnegative(),
  currentAvailableQty: z.number().int().nonnegative(),
  tryOnToCartRatePct: z.number().min(0).max(100),
  stockoutRisk: z.enum(['LOW', 'MEDIUM', 'HIGH']),
  cost_price: z.number().nonnegative().optional(),
});

export const GetTryOnDemandSignalsOutputSchema = z.object({
  periodDays: z.number().int().positive(),
  generatedAt: z.string().datetime(),
  signals: z.array(TryOnDemandSignalItemSchema),
  summary: z.string(),
  citations: z.array(GroundedCitationSchema),
});
export type GetTryOnDemandSignalsOutput = z.infer<typeof GetTryOnDemandSignalsOutputSchema>;

// ----------------------------------------------------------------------------
// Admin Tool 3: create_purchase_order_draft (MUTATING_DRAFT, locked NHAP_AI)
// ----------------------------------------------------------------------------
export const PurchaseOrderDraftLineInputSchema = z.object({
  skuCode: z.string().min(1),
  quantity: z.number().int().positive().max(10000),
  unitCostVnd: z.number().int().nonnegative().optional(),
});

export const CreatePurchaseOrderDraftInputSchema = z.object({
  supplierId: z.string().min(1),
  warehouseId: z.string().min(1).default('wh-hanoi-central'),
  expectedDeliveryDate: z.string().min(1),
  rationale: z.string().min(5).max(500),
  items: z.array(PurchaseOrderDraftLineInputSchema).min(1).max(50),
});
export type CreatePurchaseOrderDraftInput = z.infer<typeof CreatePurchaseOrderDraftInputSchema>;

export const CreatePurchaseOrderDraftOutputSchema = z.object({
  draftId: z.string().min(1),
  status: PurchaseOrderDraftStatusSchema,
  requiresHumanApproval: z.literal(true),
  createdByActorType: z.literal('AI_COPILOT'),
  supplierId: z.string().min(1),
  warehouseId: z.string().min(1),
  expectedDeliveryDate: z.string().min(1),
  totalQuantity: z.number().int().positive(),
  estimatedCostVnd: z.number().int().nonnegative().optional(),
  items: z.array(
    z.object({
      skuCode: z.string().min(1),
      quantity: z.number().int().positive(),
      cost_price: z.number().int().nonnegative().optional(),
    }),
  ),
  rationale: z.string(),
  createdAt: z.string().datetime(),
});
export type CreatePurchaseOrderDraftOutput = z.infer<typeof CreatePurchaseOrderDraftOutputSchema>;

// ----------------------------------------------------------------------------
// Admin Tool 4: analyze_refund_and_sizing_issues (READ_ONLY)
// ----------------------------------------------------------------------------
export const AnalyzeRefundAndSizingIssuesInputSchema = z.object({
  productId: z.string().min(1).optional(),
  periodDays: z.number().int().min(7).max(180).default(30),
  includeCustomerNotes: z.boolean().default(false),
  customerNotes: z.array(z.string()).max(20).optional(),
});
export type AnalyzeRefundAndSizingIssuesInput = z.infer<
  typeof AnalyzeRefundAndSizingIssuesInputSchema
>;

export const AnalyzeRefundAndSizingIssuesOutputSchema = z.object({
  periodDays: z.number().int().positive(),
  analyzedRmaCount: z.number().int().nonnegative(),
  returnRatePct: z.number().min(0).max(100),
  dominantIssue: z.enum(['RUNS_SMALL', 'RUNS_LARGE', 'TRUE_TO_SIZE', 'FABRIC_QUALITY', 'MIXED']),
  affectedSkus: z.array(
    z.object({
      productId: z.string().min(1),
      skuCode: z.string().min(1),
      exchangeCount: z.number().int().nonnegative(),
      dominantReason: z.string(),
    }),
  ),
  recommendations: z.array(z.string()),
  citations: z.array(GroundedCitationSchema),
});
export type AnalyzeRefundAndSizingIssuesOutput = z.infer<
  typeof AnalyzeRefundAndSizingIssuesOutputSchema
>;

// ----------------------------------------------------------------------------
// Customer Tool 1 (Read-Only): search_catalog_and_size_guide
// ----------------------------------------------------------------------------
export const SearchCatalogAndSizeGuideInputSchema = z.object({
  query: z.string().min(1).max(300),
  occasion: z.string().max(64).optional(),
  preferredSize: z.string().max(16).optional(),
  heightCm: z.number().min(130).max(220).optional(),
  weightKg: z.number().min(30).max(160).optional(),
  maxPriceVnd: z.number().int().positive().optional(),
  limit: z.number().int().min(1).max(12).default(5),
});
export type SearchCatalogAndSizeGuideInput = z.infer<typeof SearchCatalogAndSizeGuideInputSchema>;

export const CatalogSearchResultItemSchema = z.object({
  productId: z.string().min(1),
  slug: z.string().min(1),
  name: z.string().min(1),
  fabric: z.string(),
  priceVnd: z.number().int().nonnegative(),
  availableSizes: z.array(z.string()),
  fitType: z.enum(['SLIM', 'REGULAR', 'RELAXED', 'OVERSIZE']),
  tryOnEnabled: z.boolean(),
});

export const SearchCatalogAndSizeGuideOutputSchema = z.object({
  items: z.array(CatalogSearchResultItemSchema),
  recommendedSize: z.string().optional(),
  fitAdvice: z.string(),
  citations: z.array(GroundedCitationSchema),
});
export type SearchCatalogAndSizeGuideOutput = z.infer<typeof SearchCatalogAndSizeGuideOutputSchema>;

// ----------------------------------------------------------------------------
// Customer Tool 2 (Read-Only): get_outfit_compatibility_advice
// ----------------------------------------------------------------------------
export const GetOutfitCompatibilityAdviceInputSchema = z.object({
  selectedProductIds: z.array(z.string().min(1)).min(1).max(6),
  occasion: z.string().max(64).optional(),
  season: z.string().max(64).optional(),
  customerNote: z.string().max(300).optional(),
});
export type GetOutfitCompatibilityAdviceInput = z.infer<
  typeof GetOutfitCompatibilityAdviceInputSchema
>;

export const GetOutfitCompatibilityAdviceOutputSchema = z.object({
  compatibilityScore: z.number().min(0).max(100),
  colorHarmonyNote: z.string(),
  fabricPairingNote: z.string(),
  comboDiscountPct: z.number().min(0).max(50),
  suggestedPairings: z.array(
    z.object({
      productId: z.string().min(1),
      name: z.string().min(1),
      slotCategory: z.enum(['TOP', 'BOTTOM', 'ONE_PIECE', 'OUTERWEAR', 'ACCESSORY']),
      reason: z.string(),
    }),
  ),
  citations: z.array(GroundedCitationSchema),
});
export type GetOutfitCompatibilityAdviceOutput = z.infer<
  typeof GetOutfitCompatibilityAdviceOutputSchema
>;

// ----------------------------------------------------------------------------
// Customer Tool 3 (Tier-0 Read-Only): calculate_verified_size
// ----------------------------------------------------------------------------
export const CalculateVerifiedSizeInputSchema = z
  .object({
    productId: z.string().min(1).optional(),
    productSlug: z.string().min(1).optional(),
    heightCm: z.number().min(120).max(230),
    weightKg: z.number().min(25).max(200),
    bustCm: z.number().min(50).max(180).nullable().optional(),
    waistCm: z.number().min(40).max(170).nullable().optional(),
    hipCm: z.number().min(50).max(190).nullable().optional(),
    shoulderCm: z.number().min(28).max(70).nullable().optional(),
    fitPreference: FitPreferenceSchema.default(FitPreference.REGULAR),
  })
  .refine((v) => Boolean(v.productId || v.productSlug), {
    message: 'Either productId or productSlug is required',
  });
export type CalculateVerifiedSizeInput = z.infer<typeof CalculateVerifiedSizeInputSchema>;

export const CalculateVerifiedSizeOutputSchema = z.object({
  productId: z.string().min(1),
  productSlug: z.string().min(1),
  recommendedSize: SizeCodeSchema,
  confidence: z.number().min(0).max(1),
  crowdAdjusted: z.boolean(),
  crowdAdjustmentReason: z.string().nullable(),
  fitNotes: z.array(z.string()),
  fitStats: ProductFitStatsDtoSchema.nullable().optional(),
  alternatives: z.array(
    z.object({
      sizeCode: SizeCodeSchema,
      reason: z.string(),
    }),
  ),
  citations: z.array(GroundedCitationSchema),
});
export type CalculateVerifiedSizeOutput = z.infer<typeof CalculateVerifiedSizeOutputSchema>;

// ----------------------------------------------------------------------------
// Customer Tool 4 (Tier-0 Read-Only): search_in_stock_outfits
// ----------------------------------------------------------------------------
export const SearchInStockOutfitsInputSchema = z.object({
  query: z.string().max(300).optional(),
  occasion: z.string().max(64).optional(),
  season: z.string().max(64).optional(),
  size: SizeCodeSchema.optional(),
  maxBudgetVnd: z.number().int().positive().optional(),
  tryOnOnly: z.boolean().default(false),
  limit: z.number().int().min(1).max(24).default(6),
});
export type SearchInStockOutfitsInput = z.infer<typeof SearchInStockOutfitsInputSchema>;

export const SearchInStockOutfitsOutputSchema = z.object({
  items: z.array(
    z.object({
      productId: z.string().min(1),
      slug: z.string().min(1),
      name: z.string().min(1),
      categorySlug: z.string().min(1),
      minPriceVnd: z.number().int().nonnegative(),
      inStockSizes: z.array(SizeCodeSchema),
      isTryonEnabled: z.boolean(),
      lookbookMainUrl: z.string().nullable(),
    }),
  ),
  totalMatched: z.number().int().nonnegative(),
  appliedFilters: z.record(z.unknown()),
  citations: z.array(GroundedCitationSchema),
});
export type SearchInStockOutfitsOutput = z.infer<typeof SearchInStockOutfitsOutputSchema>;

export interface McpToolSchemaDefinition<
  TInput extends z.ZodTypeAny = z.ZodTypeAny,
  TOutput extends z.ZodTypeAny = z.ZodTypeAny,
> {
  readonly name: McpToolName;
  readonly audience: McpToolAudience;
  readonly mode: McpToolMode;
  readonly description: string;
  readonly requiredPermissions: readonly Permission[];
  readonly input: TInput;
  readonly output: TOutput;
}

export const McpToolSchemas = {
  [McpToolName.VALIDATE_AND_PROCESS_GARMENT_IMAGE]: {
    name: McpToolName.VALIDATE_AND_PROCESS_GARMENT_IMAGE,
    audience: 'ADMIN' as const,
    mode: 'MUTATING_DRAFT' as const,
    description:
      'Validate flat garment image dimensions/alpha and generate a normalized preview draft requiring human approval (never auto-attaches).',
    requiredPermissions: [Permission.CATALOG_MEDIA_PROCESS, Permission.COPILOT_ACCESS] as const,
    input: ValidateAndProcessGarmentImageInputSchema,
    output: ValidateAndProcessGarmentImageOutputSchema,
  },
  [McpToolName.GET_TRYON_DEMAND_SIGNALS]: {
    name: McpToolName.GET_TRYON_DEMAND_SIGNALS,
    audience: 'ADMIN' as const,
    mode: 'READ_ONLY' as const,
    description:
      'Read-only analytics of AI Virtual Try-On demand vs inventory availability to detect restock opportunities.',
    requiredPermissions: [Permission.TRYON_SIGNALS_READ, Permission.COPILOT_ACCESS] as const,
    input: GetTryOnDemandSignalsInputSchema,
    output: GetTryOnDemandSignalsOutputSchema,
  },
  [McpToolName.CREATE_PURCHASE_ORDER_DRAFT]: {
    name: McpToolName.CREATE_PURCHASE_ORDER_DRAFT,
    audience: 'ADMIN' as const,
    mode: 'MUTATING_DRAFT' as const,
    description:
      'Create a supplier Purchase Order draft strictly locked to status NHAP_AI awaiting Warehouse Manager human approval.',
    requiredPermissions: [Permission.INVENTORY_PO_CREATE, Permission.COPILOT_ACCESS] as const,
    input: CreatePurchaseOrderDraftInputSchema,
    output: CreatePurchaseOrderDraftOutputSchema,
  },
  [McpToolName.ANALYZE_REFUND_AND_SIZING_ISSUES]: {
    name: McpToolName.ANALYZE_REFUND_AND_SIZING_ISSUES,
    audience: 'ADMIN' as const,
    mode: 'READ_ONLY' as const,
    description:
      'Read-only root-cause analysis of RMA returns, size exchanges, and sanitized customer fit feedback.',
    requiredPermissions: [Permission.ORDER_READ, Permission.COPILOT_ACCESS] as const,
    input: AnalyzeRefundAndSizingIssuesInputSchema,
    output: AnalyzeRefundAndSizingIssuesOutputSchema,
  },
  [McpToolName.SEARCH_CATALOG_AND_SIZE_GUIDE]: {
    name: McpToolName.SEARCH_CATALOG_AND_SIZE_GUIDE,
    audience: 'CUSTOMER' as const,
    mode: 'READ_ONLY' as const,
    description:
      'Read-only storefront catalog lookup and personalized size guide recommendation based on customer body profile.',
    requiredPermissions: [Permission.CATALOG_PRODUCT_READ] as const,
    input: SearchCatalogAndSizeGuideInputSchema,
    output: SearchCatalogAndSizeGuideOutputSchema,
  },
  [McpToolName.GET_OUTFIT_COMPATIBILITY_ADVICE]: {
    name: McpToolName.GET_OUTFIT_COMPATIBILITY_ADVICE,
    audience: 'CUSTOMER' as const,
    mode: 'READ_ONLY' as const,
    description:
      'Read-only stylist compatibility scoring and Mix & Match pairing recommendations for selected garments.',
    requiredPermissions: [Permission.CATALOG_PRODUCT_READ] as const,
    input: GetOutfitCompatibilityAdviceInputSchema,
    output: GetOutfitCompatibilityAdviceOutputSchema,
  },
  [McpToolName.CALCULATE_VERIFIED_SIZE]: {
    name: McpToolName.CALCULATE_VERIFIED_SIZE,
    audience: 'CUSTOMER' as const,
    mode: 'READ_ONLY' as const,
    description:
      'Tier-0 deterministic size recommendation calibrated against size chart, stretch level, and verified buyer fit statistics.',
    requiredPermissions: [Permission.CATALOG_PRODUCT_READ] as const,
    input: CalculateVerifiedSizeInputSchema,
    output: CalculateVerifiedSizeOutputSchema,
  },
  [McpToolName.SEARCH_IN_STOCK_OUTFITS]: {
    name: McpToolName.SEARCH_IN_STOCK_OUTFITS,
    audience: 'CUSTOMER' as const,
    mode: 'READ_ONLY' as const,
    description:
      'Tier-0 deterministic lookup of currently in-stock garments filtered by occasion, season, size, budget, and Try-On readiness.',
    requiredPermissions: [Permission.CATALOG_PRODUCT_READ] as const,
    input: SearchInStockOutfitsInputSchema,
    output: SearchInStockOutfitsOutputSchema,
  },
} as const satisfies Record<McpToolName, McpToolSchemaDefinition>;

// ============================================================================
// Phase 5: Admin MCP Copilot Chat, Action Cards & Execution Trace Contracts
// ============================================================================

export const CopilotActionCardType = {
  PO_DRAFT_CREATED: 'PO_DRAFT_CREATED',
  GARMENT_IMAGE_PROCESSED: 'GARMENT_IMAGE_PROCESSED',
  SIZING_ADJUSTMENT_PROPOSAL: 'SIZING_ADJUSTMENT_PROPOSAL',
  CLEARANCE_CAMPAIGN_DRAFT: 'CLEARANCE_CAMPAIGN_DRAFT',
} as const;
export type CopilotActionCardType =
  (typeof CopilotActionCardType)[keyof typeof CopilotActionCardType];
export const CopilotActionCardTypeSchema = z.enum([
  CopilotActionCardType.PO_DRAFT_CREATED,
  CopilotActionCardType.GARMENT_IMAGE_PROCESSED,
  CopilotActionCardType.SIZING_ADJUSTMENT_PROPOSAL,
  CopilotActionCardType.CLEARANCE_CAMPAIGN_DRAFT,
]);

export const CopilotActionCardSchema = z.object({
  id: z.string().min(1),
  type: CopilotActionCardTypeSchema,
  title: z.string().min(1),
  summary: z.string().min(1),
  status: z.literal('NHAP_AI'),
  requiresHumanApproval: z.literal(true),
  entityId: z.string().nullable(),
  entityType: z.string().nullable(),
  payload: z.record(z.unknown()),
  approveEndpoint: z.string().nullable().optional(),
  createdAt: z.string(),
});
export type CopilotActionCard = z.infer<typeof CopilotActionCardSchema>;

export const ToolExecutionTraceSchema = z.object({
  toolName: z.string().min(1),
  mode: z.enum(['READ_ONLY', 'MUTATING_DRAFT']),
  tier: z.number().int().min(0).max(2),
  authorized: z.boolean(),
  cacheHit: z.boolean(),
  latencyMs: z.number().nonnegative(),
  promptTokens: z.number().int().nonnegative().optional(),
  completionTokens: z.number().int().nonnegative().optional(),
  estimatedCostUsd: z.number().nonnegative().optional(),
  errorCode: z.string().nullable().optional(),
  executedAt: z.string(),
});
export type ToolExecutionTrace = z.infer<typeof ToolExecutionTraceSchema>;

export const CopilotChatRequestDtoSchema = z.object({
  message: z.string().trim().min(1).max(2000),
  sessionId: z.string().min(1).optional(),
  portal: z.enum(['ADMIN_PORTAL', 'STOREFRONT']).default('ADMIN_PORTAL'),
  context: z.record(z.unknown()).optional(),
  bypassCache: z.boolean().optional(),
});
export type CopilotChatRequestDTO = z.infer<typeof CopilotChatRequestDtoSchema>;
export type CopilotChatRequestDto = CopilotChatRequestDTO;

export const OllamaAiProviderSchema = z.enum(['ollama', 'rule_fallback']);
export type OllamaAiProvider = z.infer<typeof OllamaAiProviderSchema>;

export const OllamaTelemetrySchema = z.object({
  aiProvider: OllamaAiProviderSchema.optional(),
  modelUsed: z.string().optional(),
  embedModel: z.string().optional(),
  promptEvalCount: z.number().int().nonnegative().optional(),
  evalCount: z.number().int().nonnegative().optional(),
  tokensPerSec: z.number().nonnegative().optional(),
  totalDurationMs: z.number().nonnegative().optional(),
  costUsd: z.number().nonnegative().optional(),
});
export type OllamaTelemetry = z.infer<typeof OllamaTelemetrySchema>;

export const CopilotChatResponseDtoSchema = z.object({
  reply: z.string(),
  sessionId: z.string().min(1),
  tierUsed: z.number().int().min(0).max(2),
  modelUsed: z.string(),
  fallbackUsed: z.boolean(),
  cacheHit: z.boolean(),
  guardrailBlocked: z.boolean(),
  guardrailReason: z.string().nullable(),
  actionCards: z.array(CopilotActionCardSchema),
  toolTraces: z.array(ToolExecutionTraceSchema),
  citations: z.array(GroundedCitationSchema),
  correlationId: z.string().min(1),
  createdAt: z.string(),
  ollamaTelemetry: OllamaTelemetrySchema.optional(),
  aiProvider: OllamaAiProviderSchema.optional(),
  embedModel: z.string().optional(),
  promptEvalCount: z.number().int().nonnegative().optional(),
  evalCount: z.number().int().nonnegative().optional(),
  tokensPerSec: z.number().nonnegative().optional(),
  totalDurationMs: z.number().nonnegative().optional(),
  costUsd: z.number().nonnegative().optional(),
});
export type CopilotChatResponseDTO = z.infer<typeof CopilotChatResponseDtoSchema>;
export type CopilotChatResponseDto = CopilotChatResponseDTO;
