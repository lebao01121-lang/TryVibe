import { ErrorCode, type McpToolName } from '@atelier/contracts';
import {
  OllamaEmbeddingClient,
  OllamaModelClient,
  VTONProviderClient,
} from './layer1-models';
import { PromptRegistry } from './layer2-prompts';
import {
  HybridRagRetriever,
  InMemoryKeywordProvider,
  InMemorySemanticProvider,
} from './layer3-rag';
import { McpToolRegistry } from './layer4-mcp-registry';
import {
  JwtPassThroughContext,
  authorizeToolCall,
  redactRestrictedFields,
  type CallerAuthContext,
} from './layer5-authz';
import {
  detectPromptInjection,
  enforceHumanInTheLoop,
  maskPii,
  sanitizeCustomerNote,
  sanitizeCustomerNoteWithMeta,
} from './layer6-guardrails';
import {
  ThreeTierAiRouter,
  type RouterDecision,
} from './layer7-cache-router';
import {
  AiTelemetryRecorder,
  type AiTelemetryRecord,
} from './layer8-telemetry-eval';

export interface AiHarnessOptions {
  ollamaClient?: OllamaModelClient;
  embeddingClient?: OllamaEmbeddingClient;
  vtonClient?: VTONProviderClient;
  promptRegistry?: PromptRegistry;
  ragRetriever?: HybridRagRetriever;
  toolRegistry?: McpToolRegistry;
  jwtContext?: JwtPassThroughContext;
  router?: ThreeTierAiRouter;
  telemetry?: AiTelemetryRecorder;
}

export interface HarnessInvocationRequest {
  prompt?: string;
  toolName?: string;
  arguments?: Record<string, unknown>;
  customerNote?: string;
  locale?: string;
  scope?: 'ADMIN' | 'CUSTOMER';
}

export interface HarnessInvocationResult {
  ok: boolean;
  code?: ErrorCode;
  error?: string;
  selectedTool: string;
  classification?: 'READ_ONLY' | 'MUTATING_DRAFT';
  routing?: RouterDecision;
  sanitizedCustomerNote?: string;
  maskedPrompt?: string;
  data?: unknown;
  telemetry: AiTelemetryRecord;
}

export class AiSecurityHarness {
  public readonly ollamaClient: OllamaModelClient;
  public readonly embeddingClient: OllamaEmbeddingClient;
  public readonly vtonClient: VTONProviderClient;
  public readonly promptRegistry: PromptRegistry;
  public readonly ragRetriever: HybridRagRetriever;
  public readonly toolRegistry: McpToolRegistry;
  public readonly jwtContext: JwtPassThroughContext;
  public readonly router: ThreeTierAiRouter;
  public readonly telemetry: AiTelemetryRecorder;

  constructor(options: AiHarnessOptions = {}) {
    this.ollamaClient = options.ollamaClient ?? new OllamaModelClient();
    this.embeddingClient =
      options.embeddingClient ??
      new OllamaEmbeddingClient({
        baseUrl: this.ollamaClient.isOfflineMode()
          ? ''
          : this.ollamaClient.getBaseUrl(),
        model: this.ollamaClient.getEmbedModel(),
        offlineMode: this.ollamaClient.isOfflineMode(),
      });
    this.vtonClient = options.vtonClient ?? new VTONProviderClient();
    this.promptRegistry = options.promptRegistry ?? new PromptRegistry();
    this.ragRetriever =
      options.ragRetriever ??
      new HybridRagRetriever({
        semanticProvider: new InMemorySemanticProvider(),
        keywordProvider: new InMemoryKeywordProvider(),
      });
    this.toolRegistry = options.toolRegistry ?? new McpToolRegistry();
    this.jwtContext = options.jwtContext ?? new JwtPassThroughContext();
    this.router =
      options.router ??
      new ThreeTierAiRouter({
        ollamaClient: this.ollamaClient,
        promptRegistry: this.promptRegistry,
      });
    this.telemetry = options.telemetry ?? new AiTelemetryRecorder();
  }

  public async invoke(
    request: HarnessInvocationRequest,
    caller: CallerAuthContext,
  ): Promise<HarnessInvocationResult> {
    const startedAt = Date.now();
    const rawPrompt = request.prompt ?? '';
    const maskedPrompt = rawPrompt ? maskPii(rawPrompt) : undefined;
    const sanitizedCustomerNote =
      request.customerNote !== undefined
        ? sanitizeCustomerNote(request.customerNote)
        : undefined;

    // Layer 6: Prompt injection scanning on customer note AND raw prompt
    const textToInspect = [
      request.customerNote ?? '',
      rawPrompt,
      typeof request.arguments?.customerNote === 'string'
        ? request.arguments.customerNote
        : '',
      typeof request.arguments?.operatorNote === 'string'
        ? request.arguments.operatorNote
        : '',
      ...(Array.isArray(request.arguments?.customerNotes)
        ? request.arguments.customerNotes.filter(
            (n): n is string => typeof n === 'string',
          )
        : []),
    ]
      .filter(Boolean)
      .join('\n');

    if (textToInspect) {
      const scan = detectPromptInjection(textToInspect);
      if (scan.blocked) {
        const telemetry = this.telemetry.record({
          userId: caller.userId,
          roles: caller.roles,
          toolName: request.toolName ?? 'guardrail_blocked',
          tier: 0,
          latencyMs: Date.now() - startedAt,
          aiProvider: 'ollama',
          modelUsed: 'layer6-guardrail',
          correlationId: caller.correlationId,
          status: 'BLOCKED_GUARDRAIL',
          metadata: { matchedRules: scan.matchedRules, severity: scan.severity },
        });

        return {
          ok: false,
          code: ErrorCode.AI_GUARDRAIL_BLOCKED,
          error: `Prompt injection detected and blocked (${scan.matchedRules.join(', ')}).`,
          selectedTool: request.toolName ?? 'guardrail_blocked',
          sanitizedCustomerNote,
          maskedPrompt,
          telemetry,
        };
      }
    }

    // Layer 7: Three-tier routing (0-token deterministic -> fast classifier -> local Ollama w/ RuleBasedFallback)
    const primaryRole = caller.roles[0] ?? 'CUSTOMER';
    const routing = await this.router.route({
      prompt: maskedPrompt ?? request.toolName ?? '',
      role: primaryRole,
      scope: request.scope,
      explicitToolName: request.toolName,
      locale: request.locale,
    });

    const selectedToolName = routing.selectedTool;
    const registeredTool = this.toolRegistry.get(selectedToolName);

    // Layer 5: RBAC + Pass-through JWT check (rejects superuser tokens and unauthorized roles)
    const authDecision = authorizeToolCall(
      registeredTool ?? (selectedToolName as McpToolName),
      caller,
    );

    if (!authDecision.allowed) {
      const telemetry = this.telemetry.record({
        userId: caller.userId,
        roles: caller.roles,
        toolName: selectedToolName,
        tier: routing.tier,
        latencyMs: Date.now() - startedAt,
        aiProvider: routing.aiProvider,
        modelUsed: routing.modelUsed,
        promptEvalCount: routing.promptEvalCount,
        evalCount: routing.evalCount,
        tokensPerSec: routing.tokensPerSec,
        correlationId: caller.correlationId,
        status: 'BLOCKED_RBAC',
        usedFallback: routing.usedFallback,
        metadata: { reason: authDecision.reason },
      });

      return {
        ok: false,
        code: authDecision.code ?? ErrorCode.FORBIDDEN,
        error: authDecision.reason,
        selectedTool: selectedToolName,
        routing,
        sanitizedCustomerNote,
        maskedPrompt,
        telemetry,
      };
    }

    if (!registeredTool) {
      const telemetry = this.telemetry.record({
        userId: caller.userId,
        roles: caller.roles,
        toolName: selectedToolName,
        tier: routing.tier,
        latencyMs: Date.now() - startedAt,
        aiProvider: routing.aiProvider,
        modelUsed: routing.modelUsed,
        correlationId: caller.correlationId,
        status: 'ERROR',
      });

      return {
        ok: false,
        code: ErrorCode.NOT_FOUND,
        error: `MCP tool "${selectedToolName}" is not registered.`,
        selectedTool: selectedToolName,
        routing,
        telemetry,
      };
    }

    // Execute inside Layer 5 AsyncLocalStorage JWT pass-through context
    try {
      const result = await this.jwtContext.run(caller, async () => {
        const inputArgs: Record<string, unknown> = {
          ...(request.arguments ?? {}),
        };
        if (
          request.customerNote !== undefined &&
          inputArgs.customerNote !== undefined
        ) {
          inputArgs.customerNote = sanitizeCustomerNoteWithMeta(
            request.customerNote,
          ).innerText;
        }

        const rawOutput = await this.toolRegistry.execute(
          selectedToolName,
          inputArgs,
          {
            userId: caller.userId,
            roles: caller.roles,
            supplierId: caller.supplierId,
            correlationId: caller.correlationId,
            jwtToken: caller.bearerToken,
          },
        );

        let safeOutput: unknown = rawOutput;
        if (
          registeredTool.classification === 'MUTATING_DRAFT' &&
          safeOutput !== null &&
          typeof safeOutput === 'object' &&
          !Array.isArray(safeOutput)
        ) {
          safeOutput = enforceHumanInTheLoop(
            safeOutput as Record<string, unknown>,
          );
        }

        return redactRestrictedFields(safeOutput, caller.roles);
      });

      const telemetry = this.telemetry.record({
        userId: caller.userId,
        roles: caller.roles,
        toolName: selectedToolName,
        tier: routing.tier,
        latencyMs: Date.now() - startedAt,
        aiProvider: routing.aiProvider,
        modelUsed: routing.modelUsed,
        promptEvalCount: routing.promptEvalCount,
        evalCount: routing.evalCount,
        tokensPerSec: routing.tokensPerSec,
        correlationId: caller.correlationId,
        status: 'SUCCESS',
        usedFallback: routing.usedFallback,
      });

      return {
        ok: true,
        selectedTool: selectedToolName,
        classification: registeredTool.classification,
        routing,
        sanitizedCustomerNote,
        maskedPrompt,
        data: result,
        telemetry,
      };
    } catch (error) {
      const telemetry = this.telemetry.record({
        userId: caller.userId,
        roles: caller.roles,
        toolName: selectedToolName,
        tier: routing.tier,
        latencyMs: Date.now() - startedAt,
        aiProvider: routing.aiProvider,
        modelUsed: routing.modelUsed,
        promptEvalCount: routing.promptEvalCount,
        evalCount: routing.evalCount,
        tokensPerSec: routing.tokensPerSec,
        correlationId: caller.correlationId,
        status: 'ERROR',
        usedFallback: routing.usedFallback,
        metadata: {
          error: error instanceof Error ? error.message : String(error),
        },
      });

      return {
        ok: false,
        code: ErrorCode.VALIDATION_ERROR,
        error: error instanceof Error ? error.message : String(error),
        selectedTool: selectedToolName,
        classification: registeredTool.classification,
        routing,
        sanitizedCustomerNote,
        maskedPrompt,
        telemetry,
      };
    }
  }
}
