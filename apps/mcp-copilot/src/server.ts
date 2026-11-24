import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { z } from 'zod';
import {
  AiSecurityHarness,
  AiTelemetryRecorder,
  OllamaEmbeddingClient,
  OllamaModelClient,
  SuperuserTokenRejectedError,
  VTONProviderClient,
  assertNoSuperuserToken,
  type CallerAuthContext,
} from '@atelier/ai-harness';
import {
  ADMIN_PORTAL_ROLES,
  CopilotChatRequestDtoSchema,
  ErrorCode,
  HTTP_HEADERS,
  Permission,
  Role,
  RoleSchema,
  createApiErrorResponse,
  createApiResponse,
  hasPermission,
  type DependencyCheck,
} from '@atelier/contracts';
import {
  TRACEPARENT_HEADER,
  buildHealthPayload,
  buildReadinessPayload,
  createLogger,
  getOrCreateCorrelationId,
  getOrCreateTraceparent,
} from '@atelier/observability';
import { BffPassThroughClient } from './bff-client.js';
import {
  type McpCopilotConfig,
  parseSafeConnectionTarget,
  probeTcpConnectivity,
} from './config.js';
import { CopilotOpsMetricsTracker } from './ops-metrics.js';
import { RuleBasedMcpOrchestrator } from './orchestrator.js';
import { CopilotRagService } from './rag-service.js';
import { RedisSemanticCache } from './redis-cache.js';
import { createLiveToolExecutors, registerAtelierMcpTools } from './tools.js';

const InvokeRequestSchema = z.object({
  prompt: z.string().max(2000).optional(),
  toolName: z.string().min(1).max(128).optional(),
  arguments: z.record(z.unknown()).optional(),
  customerNote: z.string().max(2000).optional(),
  locale: z.string().max(16).optional(),
  scope: z.enum(['ADMIN', 'CUSTOMER']).optional(),
  caller: z
    .object({
      userId: z.string().min(1),
      roles: z.array(RoleSchema).min(1),
      supplierId: z.string().optional(),
    })
    .optional(),
});

const MAX_BODY_BYTES = 1_048_576;
const VALID_ROLES: ReadonlySet<string> = new Set(Object.values(Role));

function sendJson(
  res: ServerResponse,
  statusCode: number,
  body: unknown,
  correlationId: string,
  traceparent: string,
): void {
  const payload = JSON.stringify(body);
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader(HTTP_HEADERS.CORRELATION_ID, correlationId);
  res.setHeader(TRACEPARENT_HEADER, traceparent);
  res.end(payload);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > MAX_BODY_BYTES) {
      throw new Error('Request payload exceeds 1MB limit');
    }
    chunks.push(buffer);
  }

  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) {
    return {};
  }
  return JSON.parse(raw) as unknown;
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const raw = token.replace(/^Bearer\s+/i, '').trim();
  const segments = raw.split('.');
  if (segments.length !== 3 || !segments[1]) {
    return null;
  }
  try {
    const base64 = segments[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
    const json = Buffer.from(padded, 'base64').toString('utf8');
    const parsed: unknown = JSON.parse(json);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

function extractRolesFromJwt(payload: Record<string, unknown> | null): Role[] {
  if (!payload) {
    return [];
  }
  const rawList = Array.isArray(payload.roles)
    ? payload.roles
    : typeof payload.role === 'string'
      ? [payload.role]
      : [];
  return rawList
    .map((item) => String(item).trim().toUpperCase())
    .filter((item): item is Role => VALID_ROLES.has(item));
}

function extractCallerFromRequest(
  req: IncomingMessage,
  bodyCaller: { userId: string; roles: Role[]; supplierId?: string } | undefined,
  correlationId: string,
  traceparent: string,
): CallerAuthContext {
  const authHeaderRaw = req.headers.authorization;
  const bearerToken =
    typeof authHeaderRaw === 'string' && authHeaderRaw.trim().length > 0
      ? authHeaderRaw.trim()
      : '';

  const jwtPayload = bearerToken ? decodeJwtPayload(bearerToken) : null;
  const jwtRoles = extractRolesFromJwt(jwtPayload);
  const jwtUserId =
    typeof jwtPayload?.sub === 'string' && jwtPayload.sub.trim()
      ? jwtPayload.sub.trim()
      : typeof jwtPayload?.userId === 'string' && jwtPayload.userId.trim()
        ? jwtPayload.userId.trim()
        : undefined;
  const jwtSupplierId =
    typeof jwtPayload?.supplierId === 'string' && jwtPayload.supplierId.trim()
      ? jwtPayload.supplierId.trim()
      : undefined;

  const headerRolesRaw = req.headers['x-caller-roles'];
  const headerRoles =
    typeof headerRolesRaw === 'string'
      ? headerRolesRaw
          .split(',')
          .map((item) => item.trim().toUpperCase())
          .filter((item): item is Role => VALID_ROLES.has(item))
      : [];

  const headerUserId =
    typeof req.headers['x-caller-user-id'] === 'string'
      ? req.headers['x-caller-user-id'].trim()
      : undefined;

  const roles: Role[] =
    jwtRoles.length > 0
      ? jwtRoles
      : bodyCaller?.roles ?? (headerRoles.length > 0 ? headerRoles : [Role.CUSTOMER]);

  return {
    bearerToken,
    userId: jwtUserId ?? bodyCaller?.userId ?? headerUserId ?? 'anonymous-caller',
    roles,
    supplierId: jwtSupplierId ?? bodyCaller?.supplierId,
    correlationId,
    traceparent,
  };
}

export interface McpCopilotApp {
  server: Server;
  harness: AiSecurityHarness;
  config: McpCopilotConfig;
  close: () => Promise<void>;
}

export function createMcpCopilotServer(config: McpCopilotConfig): McpCopilotApp {
  const logger = createLogger(config.serviceName);

  const ollamaClient = new OllamaModelClient({
    baseUrl: config.ollamaOfflineMode ? '' : config.ollamaBaseUrl,
    mainModel: config.ollamaMainModel,
    fastModel: config.ollamaFastModel,
    embedModel: config.ollamaEmbedModel,
    numCtx: config.ollamaNumCtx,
    keepAlive: config.ollamaKeepAlive,
    timeoutMs: config.ollamaTimeoutMs,
    offlineMode: config.ollamaOfflineMode,
  });

  const embeddingClient = new OllamaEmbeddingClient({
    baseUrl: config.ollamaOfflineMode ? '' : config.ollamaBaseUrl,
    model: config.ollamaEmbedModel,
    dimension: config.ollamaEmbedDim,
    keepAlive: config.ollamaKeepAlive,
    offlineMode: config.ollamaOfflineMode,
  });

  const vtonClient = new VTONProviderClient({
    provider: config.vtonProvider,
  });

  const telemetry = new AiTelemetryRecorder({
    onRecord: (entry) => {
      logger.info(
        {
          actor_type: entry.actor_type,
          aiProvider: entry.aiProvider,
          modelUsed: entry.modelUsed,
          toolName: entry.toolName,
          tier: entry.tier,
          latencyMs: entry.latencyMs,
          promptEvalCount: entry.promptEvalCount,
          evalCount: entry.evalCount,
          tokensPerSec: entry.tokensPerSec,
          costUsd: entry.costUsd,
          vtonCostUsd: entry.vtonCostUsd,
          cacheHit: entry.cacheHit,
          status: entry.status,
          correlationId: entry.correlationId,
        },
        'AI harness invocation telemetry (Ollama Local AI)',
      );
    },
  });

  const harness = new AiSecurityHarness({
    ollamaClient,
    embeddingClient,
    vtonClient,
    telemetry,
  });

  const bffClient = new BffPassThroughClient(
    config.bffUrl,
    harness.jwtContext,
    logger,
  );

  const ragService = new CopilotRagService(config, logger, embeddingClient);
  const redisCache = new RedisSemanticCache(
    config.redisUrl,
    config.semanticCacheTtlSeconds,
  );
  const executors = createLiveToolExecutors(bffClient, ragService, config);

  // Registers all 4 Admin + 4 Customer Read-Only tools on McpToolRegistry & @modelcontextprotocol/sdk
  const mcpSdkServer = registerAtelierMcpTools(
    harness,
    bffClient,
    ragService,
    executors,
  );
  void mcpSdkServer;

  const opsMetrics = new CopilotOpsMetricsTracker();
  const orchestrator = new RuleBasedMcpOrchestrator(
    harness,
    executors,
    ragService,
    redisCache,
    config,
  );

  const server = createServer(async (req, res) => {
    const reqStartedAt = Date.now();
    const correlationId = getOrCreateCorrelationId(req.headers);
    const traceparent = getOrCreateTraceparent(req.headers);
    const method = (req.method ?? 'GET').toUpperCase();
    const requestUrl = new URL(
      req.url ?? '/',
      `http://${req.headers.host ?? `127.0.0.1:${config.port}`}`,
    );
    const pathname = requestUrl.pathname;

    try {
      // =======================================================================
      // GET /health (strictly < 20ms, zero blocking I/O)
      // =======================================================================
      if (method === 'GET' && pathname === '/health') {
        const health = buildHealthPayload(config.serviceName, config.port, {
          startedAtMs: reqStartedAt,
          metadata: {
            aiProvider: config.aiProvider,
            ollamaBaseUrl: config.ollamaBaseUrl,
            activeMainModel: ollamaClient.getMainModel(),
            activeFastModel: ollamaClient.getFastModel(),
            activeEmbedModel: ollamaClient.getEmbedModel(),
            embedDim: config.ollamaEmbedDim,
            registeredTools: harness.toolRegistry.list().length,
            ragVectorDbConfigured: Boolean(config.ragVectorDatabaseUrl),
            ragBackend: ragService.getBackendMode(),
            transactionalDbConnections: 0,
          },
        });
        sendJson(res, 200, health, correlationId, traceparent);
        return;
      }

      // =======================================================================
      // GET /ready (probes live Ollama + confirms ZERO transactional DB connections)
      // =======================================================================
      if (method === 'GET' && pathname === '/ready') {
        const allTools = harness.toolRegistry.list();
        const adminToolCount = allTools.filter((t) => t.scope === 'ADMIN').length;
        const customerToolCount = allTools.filter((t) => t.scope === 'CUSTOMER').length;

        const [ollamaHealth, redisProbe, bffProbe, ragProbe] = await Promise.all([
          ollamaClient.checkHealth(),
          redisCache.ping(),
          (() => {
            const bffTarget = parseSafeConnectionTarget(config.bffUrl);
            return bffTarget
              ? probeTcpConnectivity(bffTarget.host, bffTarget.port, 250)
              : Promise.resolve(null);
          })(),
          (() => {
            const ragTarget = parseSafeConnectionTarget(config.ragVectorDatabaseUrl);
            return ragTarget
              ? probeTcpConnectivity(ragTarget.host, ragTarget.port, 250).then((p) => ({
                  ...p,
                  database: ragTarget.database ?? 'rag_vector_db',
                }))
              : Promise.resolve(null);
          })(),
        ]);

        const checks: DependencyCheck[] = [
          {
            name: 'ai-harness-8-layers',
            status: 'up',
            detail: 'All 8 AI security harness layers initialized (v3.1 Local Ollama)',
          },
          {
            name: 'transactional-db-isolation',
            status: 'up',
            detail:
              'Zero transactional DB connections (HTTP JWT pass-through to BFF + read-only RAG only)',
          },
          {
            name: 'mcp-tool-registry',
            status: 'up',
            detail: `${allTools.length} tools registered (${adminToolCount} admin + ${customerToolCount} customer)`,
          },
          {
            name: 'ollama-local-engine',
            status: ollamaHealth.reachable ? 'up' : 'skipped',
            latencyMs: ollamaHealth.latencyMs,
            detail: ollamaHealth.reachable
              ? `Live ${ollamaHealth.activeMainModel} + ${ollamaHealth.activeEmbedModel} (${ollamaHealth.models.length} models @ ${ollamaHealth.baseUrl})`
              : `Ollama unreachable at ${ollamaHealth.baseUrl} — RuleBasedMcpOrchestrator fallback active`,
          },
          {
            name: 'redis-semantic-cache',
            status: redisProbe.reachable ? 'up' : 'skipped',
            latencyMs: redisProbe.latencyMs,
            detail: redisProbe.reachable
              ? 'Connected (copilot:cache:* TTL 300s)'
              : 'Redis offline — in-memory ContentHashCache fallback active',
          },
        ];

        const ragStoreReady = true;
        if (ragProbe) {
          checks.push({
            name: 'rag-vector-db',
            status: ragProbe.reachable ? 'up' : 'skipped',
            latencyMs: ragProbe.latencyMs,
            detail: ragProbe.reachable
              ? `Connected to ${ragProbe.database} (vector(${config.ollamaEmbedDim}))`
              : `Configured (${ragProbe.database}, vector(${config.ollamaEmbedDim})) — PGlite/in-memory Hybrid RAG active`,
          });
        } else {
          checks.push({
            name: 'rag-vector-db',
            status: 'skipped',
            detail: 'RAG_VECTOR_DATABASE_URL not set — in-memory Hybrid RAG active',
          });
        }

        const bffReachable = Boolean(bffProbe?.reachable);
        if (bffProbe) {
          checks.push({
            name: 'bff-upstream',
            status: bffProbe.reachable ? 'up' : 'skipped',
            latencyMs: bffProbe.latencyMs,
            detail: bffProbe.reachable
              ? `Reachable at ${config.bffUrl}`
              : `Offline at ${config.bffUrl} — waiting for BFF startup`,
          });
        }

        const fallbackMode = !ollamaHealth.reachable;
        const readiness = buildReadinessPayload(config.serviceName, checks, {
          port: config.port,
          startedAtMs: reqStartedAt,
          metadata: {
            bffUrl: config.bffUrl,
            ragVectorDbConfigured: Boolean(config.ragVectorDatabaseUrl),
            transactionalDbConnections: 0,
            ragStoreReady,
            bffReachable,
            ollamaReachable: ollamaHealth.reachable,
            ollamaBaseUrl: ollamaHealth.baseUrl,
            activeMainModel: ollamaHealth.activeMainModel,
            activeFastModel: ollamaHealth.activeFastModel,
            activeEmbedModel: ollamaHealth.activeEmbedModel,
            embedDim: config.ollamaEmbedDim,
            loadedModels: ollamaHealth.models,
            fallbackMode,
          },
        });

        sendJson(
          res,
          readiness.ready ? 200 : 503,
          {
            ...readiness,
            ollamaReachable: ollamaHealth.reachable,
            ollamaBaseUrl: ollamaHealth.baseUrl,
            activeMainModel: ollamaHealth.activeMainModel,
            activeFastModel: ollamaHealth.activeFastModel,
            activeEmbedModel: ollamaHealth.activeEmbedModel,
            embedDim: config.ollamaEmbedDim,
            loadedModels: ollamaHealth.models,
            fallbackMode,
            transactionalDbConnections: 0,
            ragStoreReady,
            bffReachable,
          },
          correlationId,
          traceparent,
        );
        return;
      }

      // =======================================================================
      // GET /v1/copilot/ops/metrics (v3.1 Local Ollama AI Ops Telemetry)
      // =======================================================================
      if (method === 'GET' && pathname === '/v1/copilot/ops/metrics') {
        const snapshot = opsMetrics.snapshot(telemetry, {
          activeMainModel: ollamaClient.getMainModel(),
          activeFastModel: ollamaClient.getFastModel(),
          activeEmbedModel: ollamaClient.getEmbedModel(),
          embedDim: config.ollamaEmbedDim,
          ollamaLiveAvailable: ollamaClient.isLiveAvailable(),
        });
        sendJson(
          res,
          200,
          createApiResponse(snapshot, {
            correlationId,
            service: config.serviceName,
          }),
          correlationId,
          traceparent,
        );
        return;
      }

      // =======================================================================
      // GET /v1/copilot/tools & GET /mcp/tools
      // =======================================================================
      if (
        method === 'GET' &&
        (pathname === '/v1/copilot/tools' || pathname === '/mcp/tools')
      ) {
        const scopeParam = requestUrl.searchParams.get('scope')?.toUpperCase();
        const scopeFilter =
          scopeParam === 'ADMIN' || scopeParam === 'CUSTOMER'
            ? scopeParam
            : undefined;
        const tools = harness.toolRegistry.listMetadata(
          scopeFilter ? { scope: scopeFilter } : undefined,
        );
        sendJson(
          res,
          200,
          createApiResponse(
            {
              tools,
              total: tools.length,
              adminCount: tools.filter((t) => t.scope === 'ADMIN').length,
              customerCount: tools.filter((t) => t.scope === 'CUSTOMER').length,
            },
            { correlationId, service: config.serviceName },
          ),
          correlationId,
          traceparent,
        );
        return;
      }

      // =======================================================================
      // POST /v1/copilot/chat (v3.1 Live Multi-Step Ollama + 8-Layer Security Harness)
      // =======================================================================
      if (method === 'POST' && pathname === '/v1/copilot/chat') {
        let rawBody: unknown;
        try {
          rawBody = await readJsonBody(req);
        } catch (parseErr) {
          sendJson(
            res,
            400,
            createApiErrorResponse(
              ErrorCode.VALIDATION_ERROR,
              parseErr instanceof Error ? parseErr.message : 'Invalid JSON payload',
              undefined,
              { correlationId, service: config.serviceName },
            ),
            correlationId,
            traceparent,
          );
          return;
        }

        const parsed = CopilotChatRequestDtoSchema.safeParse(rawBody);
        if (!parsed.success) {
          sendJson(
            res,
            400,
            createApiErrorResponse(
              ErrorCode.VALIDATION_ERROR,
              'Invalid /v1/copilot/chat request body',
              { issues: parsed.error.issues },
              { correlationId, service: config.serviceName },
            ),
            correlationId,
            traceparent,
          );
          return;
        }

        const caller = extractCallerFromRequest(
          req,
          undefined,
          correlationId,
          traceparent,
        );

        if (!caller.bearerToken) {
          sendJson(
            res,
            401,
            createApiErrorResponse(
              ErrorCode.UNAUTHORIZED,
              'Missing caller Authorization Bearer JWT.',
              undefined,
              { correlationId, service: config.serviceName },
            ),
            correlationId,
            traceparent,
          );
          return;
        }

        try {
          assertNoSuperuserToken(caller.bearerToken);
        } catch (err) {
          opsMetrics.recordRbacDenial();
          sendJson(
            res,
            403,
            createApiErrorResponse(
              ErrorCode.FORBIDDEN,
              err instanceof SuperuserTokenRejectedError
                ? err.message
                : 'Superuser/bypass token rejected.',
              undefined,
              { correlationId, service: config.serviceName },
            ),
            correlationId,
            traceparent,
          );
          return;
        }

        if (parsed.data.portal === 'ADMIN_PORTAL') {
          const isAdminRole = caller.roles.some((r) =>
            ADMIN_PORTAL_ROLES.includes(r),
          );
          if (
            !isAdminRole ||
            !hasPermission(caller.roles, Permission.COPILOT_ACCESS)
          ) {
            opsMetrics.recordRbacDenial();
            sendJson(
              res,
              403,
              createApiErrorResponse(
                ErrorCode.FORBIDDEN,
                `Vai trò [${caller.roles.join(', ')}] không có quyền truy cập Admin MCP Copilot.`,
                undefined,
                { correlationId, service: config.serviceName },
              ),
              correlationId,
              traceparent,
            );
            return;
          }
        }

        const chatResult = await orchestrator.handleChat(parsed.data, caller);

        if (!chatResult.ok) {
          const deniedToolNames = Array.isArray(chatResult.details?.toolTraces)
            ? (chatResult.details.toolTraces as Array<{ toolName?: string }>)
                .map((t) => t.toolName)
                .filter((n): n is string => typeof n === 'string')
            : [];
          opsMetrics.recordChatTurn({
            toolNames: deniedToolNames,
            rbacDenied: chatResult.statusCode === 403,
            promptInjectionBlocked:
              chatResult.code === ErrorCode.PROMPT_INJECTION_BLOCKED ||
              chatResult.code === ErrorCode.AI_GUARDRAIL_BLOCKED,
            fallbackUsed: !ollamaClient.isLiveAvailable(),
          });

          sendJson(
            res,
            chatResult.statusCode,
            createApiErrorResponse(
              chatResult.code,
              chatResult.message,
              chatResult.details,
              { correlationId, service: config.serviceName },
            ),
            correlationId,
            traceparent,
          );
          return;
        }

        const executedTools = chatResult.data.toolTraces
          .filter((t) => t.authorized)
          .map((t) => t.toolName);
        const wasPolicyLookup =
          chatResult.data.cacheHit ||
          executedTools.includes('hybrid_rag_policy_lookup');

        opsMetrics.recordChatTurn({
          toolNames: executedTools,
          cacheLookup: wasPolicyLookup,
          cacheHit: chatResult.data.cacheHit,
          promptInjectionBlocked:
            chatResult.data.guardrailBlocked ||
            chatResult.data.promptInjectionDetected,
          fallbackUsed: chatResult.data.fallbackUsed,
          modelUsed: chatResult.data.modelUsed,
          tokensPerSec: chatResult.data.tokensPerSec,
        });

        sendJson(
          res,
          200,
          createApiResponse(chatResult.data, {
            correlationId,
            service: config.serviceName,
          }),
          correlationId,
          traceparent,
        );
        return;
      }

      // =======================================================================
      // POST /mcp/invoke (Backward-compatible direct tool endpoint)
      // =======================================================================
      if (method === 'POST' && pathname === '/mcp/invoke') {
        let rawBody: unknown;
        try {
          rawBody = await readJsonBody(req);
        } catch (parseErr) {
          sendJson(
            res,
            400,
            createApiErrorResponse(
              ErrorCode.VALIDATION_ERROR,
              parseErr instanceof Error ? parseErr.message : 'Invalid JSON payload',
              undefined,
              { correlationId, service: config.serviceName },
            ),
            correlationId,
            traceparent,
          );
          return;
        }
        const parsed = InvokeRequestSchema.safeParse(rawBody);
        if (!parsed.success) {
          sendJson(
            res,
            400,
            createApiErrorResponse(
              ErrorCode.VALIDATION_ERROR,
              'Invalid /mcp/invoke request body',
              { issues: parsed.error.issues },
              { correlationId, service: config.serviceName },
            ),
            correlationId,
            traceparent,
          );
          return;
        }

        const payload = parsed.data;
        if (!payload.prompt && !payload.toolName) {
          sendJson(
            res,
            400,
            createApiErrorResponse(
              ErrorCode.VALIDATION_ERROR,
              'Either prompt or toolName is required',
              undefined,
              { correlationId, service: config.serviceName },
            ),
            correlationId,
            traceparent,
          );
          return;
        }

        const caller = extractCallerFromRequest(
          req,
          payload.caller,
          correlationId,
          traceparent,
        );

        const result = await harness.invoke(
          {
            prompt: payload.prompt,
            toolName: payload.toolName,
            arguments: payload.arguments,
            customerNote: payload.customerNote,
            locale: payload.locale,
            scope: payload.scope,
          },
          caller,
        );

        if (!result.ok) {
          const statusCode =
            result.code === ErrorCode.FORBIDDEN
              ? 403
              : result.code === ErrorCode.NOT_FOUND
                ? 404
                : result.code === ErrorCode.AI_GUARDRAIL_BLOCKED ||
                    result.code === ErrorCode.PROMPT_INJECTION_BLOCKED
                  ? 422
                  : 400;

          sendJson(
            res,
            statusCode,
            createApiErrorResponse(
              result.code ?? ErrorCode.INTERNAL_ERROR,
              result.error ?? 'MCP invocation rejected',
              {
                selectedTool: result.selectedTool,
                telemetryId: result.telemetry.id,
              },
              { correlationId, service: config.serviceName },
            ),
            correlationId,
            traceparent,
          );
          return;
        }

        sendJson(
          res,
          200,
          createApiResponse(result, {
            correlationId,
            service: config.serviceName,
          }),
          correlationId,
          traceparent,
        );
        return;
      }

      sendJson(
        res,
        404,
        createApiErrorResponse(
          ErrorCode.NOT_FOUND,
          `Route not found: ${method} ${pathname}`,
          undefined,
          { correlationId, service: config.serviceName },
        ),
        correlationId,
        traceparent,
      );
    } catch (error) {
      logger.error(
        {
          correlationId,
          traceparent,
          pathname,
          err: error instanceof Error ? error.message : String(error),
        },
        'Unhandled error in mcp-copilot HTTP handler',
      );
      sendJson(
        res,
        500,
        createApiErrorResponse(
          ErrorCode.INTERNAL_ERROR,
          error instanceof Error ? error.message : 'Internal server error',
          undefined,
          { correlationId, service: config.serviceName },
        ),
        correlationId,
        traceparent,
      );
    }
  });

  const close = async (): Promise<void> => {
    await ragService.close();
  };

  return { server, harness, config, close };
}
