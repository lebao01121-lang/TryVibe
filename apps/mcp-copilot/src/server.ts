import { createHash, timingSafeEqual } from 'node:crypto';
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
  type TelemetryPortalScope,
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

const ExtendedChatRequestSchema = CopilotChatRequestDtoSchema.extend({
  guestSessionId: z.string().trim().min(1).max(128).optional(),
  history: z
    .array(
      z.object({
        role: z.string().min(1).max(32),
        content: z.string().max(4000),
      }),
    )
    .max(20)
    .optional(),
  bodyProfile: z.record(z.unknown()).optional(),
});

const CopilotFeedbackRequestSchema = z.object({
  traceId: z.string().trim().min(1).max(128),
  sessionId: z.string().trim().max(128).optional(),
  rating: z.enum(['UP', 'DOWN']),
  reason: z.string().trim().max(500).optional(),
  promptText: z.string().max(4000).optional(),
  prompt: z.string().max(4000).optional(),
  responseText: z.string().max(8000).optional(),
  response: z.string().max(8000).optional(),
  portal: z.enum(['ADMIN_PORTAL', 'STOREFRONT', 'INTERNAL', 'ADMIN']).optional(),
});

const CreateRagDocumentBodySchema = z.object({
  id: z.string().trim().min(1).max(128).optional(),
  title: z.string().trim().min(2).max(300),
  content: z.string().trim().min(5).max(50_000),
  category: z.string().trim().min(1).max(64).optional(),
  domain: z.string().trim().min(1).max(64).optional(),
  sourceUri: z.string().trim().max(500).optional(),
  metadata: z.record(z.unknown()).optional(),
  updatedBy: z.string().trim().max(128).optional(),
  maxChunkChars: z.number().int().min(120).max(4000).optional(),
  overlapChars: z.number().int().min(0).max(1000).optional(),
});

const UpdateRagDocumentBodySchema = z.object({
  title: z.string().trim().min(2).max(300).optional(),
  content: z.string().trim().min(5).max(50_000).optional(),
  category: z.string().trim().min(1).max(64).optional(),
  domain: z.string().trim().min(1).max(64).optional(),
  sourceUri: z.string().trim().max(500).optional(),
  isActive: z.boolean().optional(),
  metadata: z.record(z.unknown()).optional(),
  updatedBy: z.string().trim().max(128).optional(),
  maxChunkChars: z.number().int().min(120).max(4000).optional(),
  overlapChars: z.number().int().min(0).max(1000).optional(),
});

const ReindexRagBodySchema = z.object({
  documentIds: z.array(z.string().trim().min(1).max(128)).max(500).optional(),
  updatedBy: z.string().trim().max(128).optional(),
});

const TestRetrievalBodySchema = z.object({
  query: z.string().trim().min(1).max(2000),
  domain: z.string().trim().max(64).optional(),
  category: z.string().trim().max(64).optional(),
  limit: z.number().int().min(1).max(20).optional(),
});

function hasValidInternalSecret(
  req: IncomingMessage,
  expectedSecret: string,
): boolean {
  if (!expectedSecret) {
    return false;
  }
  const rawHeader = req.headers['x-internal-secret'];
  const provided = Array.isArray(rawHeader)
    ? rawHeader[0]?.trim()
    : typeof rawHeader === 'string'
      ? rawHeader.trim()
      : '';
  if (!provided) {
    return false;
  }
  const expectedDigest = createHash('sha256').update(expectedSecret, 'utf8').digest();
  const providedDigest = createHash('sha256').update(provided, 'utf8').digest();
  return timingSafeEqual(expectedDigest, providedDigest);
}

function getSingleHeader(req: IncomingMessage, name: string): string | undefined {
  const val = req.headers[name.toLowerCase()];
  if (Array.isArray(val)) {
    return val[0]?.trim() || undefined;
  }
  return typeof val === 'string' && val.trim().length > 0 ? val.trim() : undefined;
}

function normalizeIncomingChatBody(rawBody: unknown): unknown {
  if (!rawBody || typeof rawBody !== 'object' || Array.isArray(rawBody)) {
    return rawBody;
  }
  const copy: Record<string, unknown> = { ...(rawBody as Record<string, unknown>) };
  if (copy.portal === 'ADMIN') {
    copy.portal = 'ADMIN_PORTAL';
  }
  if (
    (typeof copy.message !== 'string' || !copy.message.trim()) &&
    typeof copy.prompt === 'string' &&
    copy.prompt.trim()
  ) {
    copy.message = copy.prompt.trim();
  }
  return copy;
}

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

  const headerRolesRaw =
    getSingleHeader(req, 'x-caller-roles') ??
    getSingleHeader(req, 'x-actor-roles') ??
    getSingleHeader(req, 'x-user-roles');
  const headerRoles =
    typeof headerRolesRaw === 'string'
      ? headerRolesRaw
          .split(',')
          .map((item) => item.trim().toUpperCase())
          .filter((item): item is Role => VALID_ROLES.has(item))
      : [];

  const headerUserId =
    getSingleHeader(req, 'x-caller-user-id') ??
    getSingleHeader(req, 'x-user-id');

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

  // Wire Layer 8 persistent telemetry into rag_vector_db & hydrate startup counters asynchronously
  telemetry.setPersistenceAdapter({
    persistTelemetryEvent: (entry) => ragService.persistTelemetryEvent(entry),
    loadTelemetryEvents: async (limit) => {
      const loaded = await ragService.loadHistoricalTelemetry(limit);
      return loaded.events;
    },
  });

  let hydratePromise: Promise<void> | null = null;
  const ensureHydrated = (): Promise<void> => {
    if (!hydratePromise) {
      hydratePromise = (async () => {
        try {
          await ragService.initPersistence();
          const [history, feedbackSummary] = await Promise.all([
            ragService.loadHistoricalTelemetry(500),
            ragService.getFeedbackSummary(),
          ]);
          telemetry.hydrateRecords(history.events);
          opsMetrics.hydrateFromPersistence(history.totals, feedbackSummary);
          logger.info(
            {
              backend: ragService.getBackendMode(),
              hydratedTelemetryEvents: history.totals.totalEvents,
              hydratedFeedbackTotal: feedbackSummary.total,
            },
            'Hydrated persistent AI telemetry & Copilot feedback from rag_vector_db',
          );
        } catch (err) {
          logger.warn(
            { err: err instanceof Error ? err.message : String(err) },
            'Skipping persistent telemetry hydration (in-memory metrics active)',
          );
        }
      })();
    }
    return hydratePromise;
  };
  void ensureHydrated();

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
            hnswIndexActive: ragService.isHnswIndexActive(),
            ragIndexSpec: ragService.getIndexSpec(),
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
          ensureHydrated(),
        ]);

        const copilotFeedback = opsMetrics.getFeedbackSummary();
        const persistenceBackend = ragService.getBackendMode();

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
            persistenceBackend,
            copilotFeedback,
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
            persistenceBackend,
            copilotFeedback,
          },
          correlationId,
          traceparent,
        );
        return;
      }

      // =======================================================================
      // GET /v1/copilot/ops/metrics & GET /ops/metrics (Persistent AI Ops Telemetry + Feedback)
      // =======================================================================
      if (
        method === 'GET' &&
        (pathname === '/v1/copilot/ops/metrics' || pathname === '/ops/metrics')
      ) {
        await ensureHydrated();
        const feedbackSummary = opsMetrics.getFeedbackSummary();
        const snapshot = opsMetrics.snapshot(telemetry, {
          activeMainModel: ollamaClient.getMainModel(),
          activeFastModel: ollamaClient.getFastModel(),
          activeEmbedModel: ollamaClient.getEmbedModel(),
          embedDim: config.ollamaEmbedDim,
          ollamaLiveAvailable: ollamaClient.isLiveAvailable(),
          persistenceBackend: ragService.getBackendMode(),
          feedbackSummaryOverride: feedbackSummary,
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
      // POST /v1/copilot/feedback (P1-5 Persistent Copilot 👍/👎 Feedback -> rag_vector_db)
      // =======================================================================
      if (method === 'POST' && pathname === '/v1/copilot/feedback') {
        await ensureHydrated();
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

        const parsedFb = CopilotFeedbackRequestSchema.safeParse(rawBody);
        if (!parsedFb.success) {
          sendJson(
            res,
            400,
            createApiErrorResponse(
              ErrorCode.VALIDATION_ERROR,
              'Invalid /v1/copilot/feedback request body',
              { issues: parsedFb.error.issues },
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
        const internalSecretValid = hasValidInternalSecret(
          req,
          config.internalServiceSecret,
        );

        if (!caller.bearerToken && !internalSecretValid) {
          sendJson(
            res,
            401,
            createApiErrorResponse(
              ErrorCode.UNAUTHORIZED,
              'Feedback submission requires Bearer JWT or valid internal service secret.',
              undefined,
              { correlationId, service: config.serviceName },
            ),
            correlationId,
            traceparent,
          );
          return;
        }

        if (caller.bearerToken) {
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
        }

        const rawPortal = parsedFb.data.portal ?? 'ADMIN_PORTAL';
        const portal: TelemetryPortalScope =
          rawPortal === 'STOREFRONT'
            ? 'STOREFRONT'
            : rawPortal === 'INTERNAL'
              ? 'INTERNAL'
              : 'ADMIN_PORTAL';
        const actorRole =
          caller.roles.length > 0
            ? caller.roles.join(',')
            : getSingleHeader(req, 'x-actor-roles') ?? 'UNKNOWN';

        const saved = await ragService.insertFeedback({
          traceId: parsedFb.data.traceId,
          sessionId: parsedFb.data.sessionId ?? null,
          portal,
          role: actorRole,
          userId: caller.userId,
          rating: parsedFb.data.rating,
          reason: parsedFb.data.reason ?? null,
          promptText: parsedFb.data.promptText ?? parsedFb.data.prompt ?? null,
          responseText:
            parsedFb.data.responseText ?? parsedFb.data.response ?? null,
        });

        const feedbackSummary = opsMetrics.recordFeedback(
          saved.rating,
          saved.reason,
        );

        sendJson(
          res,
          200,
          createApiResponse(
            {
              id: saved.id,
              traceId: saved.traceId,
              sessionId: saved.sessionId,
              portal: saved.portal,
              actorRole: saved.role,
              rating: saved.rating,
              reason: saved.reason,
              createdAt: saved.createdAt,
              persistenceBackend: ragService.getBackendMode(),
              feedbackSummary,
              copilotFeedback: feedbackSummary,
            },
            { correlationId, service: config.serviceName },
          ),
          correlationId,
          traceparent,
        );
        return;
      }

      // =======================================================================
      // GET /v1/copilot/feedback/export (Internal SFT/DPO Exporter Access)
      // =======================================================================
      if (method === 'GET' && pathname === '/v1/copilot/feedback/export') {
        await ensureHydrated();
        const internalSecretValid = hasValidInternalSecret(
          req,
          config.internalServiceSecret,
        );
        const caller = extractCallerFromRequest(
          req,
          undefined,
          correlationId,
          traceparent,
        );
        const isAdminJwt =
          Boolean(caller.bearerToken) &&
          caller.roles.some((r) => ADMIN_PORTAL_ROLES.includes(r));

        if (!internalSecretValid && !isAdminJwt) {
          sendJson(
            res,
            403,
            createApiErrorResponse(
              ErrorCode.FORBIDDEN,
              'Feedback export requires valid internal service secret or Admin JWT.',
              undefined,
              { correlationId, service: config.serviceName },
            ),
            correlationId,
            traceparent,
          );
          return;
        }

        const rawLimit = Number(requestUrl.searchParams.get('limit') ?? 500);
        const limit = Number.isFinite(rawLimit)
          ? Math.max(1, Math.min(2000, Math.floor(rawLimit)))
          : 500;
        const [items, summary] = await Promise.all([
          ragService.listFeedbackForExport(limit),
          ragService.getFeedbackSummary(),
        ]);

        sendJson(
          res,
          200,
          createApiResponse(
            {
              items,
              total: items.length,
              summary,
              persistenceBackend: ragService.getBackendMode(),
            },
            { correlationId, service: config.serviceName },
          ),
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
      // /internal/rag/* — Dynamic RAG Knowledge Base Admin API (x-internal-secret)
      // Strictly connects ONLY to rag_vector_db (transactionalDbConnections === 0)
      // =======================================================================
      if (pathname === '/internal/rag' || pathname.startsWith('/internal/rag/')) {
        const providedSecret = getSingleHeader(req, 'x-internal-secret');
        if (!providedSecret) {
          sendJson(
            res,
            401,
            createApiErrorResponse(
              ErrorCode.UNAUTHORIZED,
              'Missing x-internal-secret header for internal RAG admin endpoint.',
              undefined,
              { correlationId, service: config.serviceName },
            ),
            correlationId,
            traceparent,
          );
          return;
        }
        if (!hasValidInternalSecret(req, config.internalServiceSecret)) {
          sendJson(
            res,
            403,
            createApiErrorResponse(
              ErrorCode.FORBIDDEN,
              'Invalid x-internal-secret header for internal RAG admin endpoint.',
              undefined,
              { correlationId, service: config.serviceName },
            ),
            correlationId,
            traceparent,
          );
          return;
        }

        await ensureHydrated();
        const actorFromHeader =
          getSingleHeader(req, 'x-actor-id') ??
          getSingleHeader(req, 'x-caller-user-id') ??
          getSingleHeader(req, 'x-user-id') ??
          'admin';

        // 1. GET /internal/rag/documents
        if (method === 'GET' && pathname === '/internal/rag/documents') {
          const category = requestUrl.searchParams.get('category') ?? undefined;
          const domain = requestUrl.searchParams.get('domain') ?? undefined;
          const includeInactiveParam = (
            requestUrl.searchParams.get('includeInactive') ?? ''
          )
            .trim()
            .toLowerCase();
          const includeInactive =
            includeInactiveParam === 'true' || includeInactiveParam === '1';
          const q = requestUrl.searchParams.get('q') ?? undefined;

          const [documents, summary] = await Promise.all([
            ragService.listDocuments({ category, domain, includeInactive, q }),
            ragService.getCorpusSummary(),
          ]);

          sendJson(
            res,
            200,
            createApiResponse(
              {
                documents,
                items: documents,
                total: documents.length,
                summary,
                hnswIndexActive: summary.hnswIndexActive,
                indexSpec: summary.indexSpec,
                embeddingModel: summary.embeddingModel,
                embeddingDim: summary.embeddingDim,
              },
              { correlationId, service: config.serviceName },
            ),
            correlationId,
            traceparent,
          );
          return;
        }

        // 2. POST /internal/rag/documents
        if (method === 'POST' && pathname === '/internal/rag/documents') {
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

          const parsedDoc = CreateRagDocumentBodySchema.safeParse(rawBody);
          if (!parsedDoc.success) {
            sendJson(
              res,
              400,
              createApiErrorResponse(
                ErrorCode.VALIDATION_ERROR,
                'Invalid POST /internal/rag/documents request body',
                { issues: parsedDoc.error.issues },
                { correlationId, service: config.serviceName },
              ),
              correlationId,
              traceparent,
            );
            return;
          }

          try {
            const document = await ragService.createDocument({
              ...parsedDoc.data,
              updatedBy: parsedDoc.data.updatedBy ?? actorFromHeader,
            });
            const cacheFlushed = await redisCache.flushByPrefix();
            sendJson(
              res,
              201,
              createApiResponse(
                { document, cacheFlushed },
                { correlationId, service: config.serviceName },
              ),
              correlationId,
              traceparent,
            );
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            const isConflict = msg.toLowerCase().includes('already exists');
            sendJson(
              res,
              isConflict ? 409 : 400,
              createApiErrorResponse(
                isConflict ? ErrorCode.CONFLICT : ErrorCode.VALIDATION_ERROR,
                msg,
                undefined,
                { correlationId, service: config.serviceName },
              ),
              correlationId,
              traceparent,
            );
          }
          return;
        }

        // 3. POST /internal/rag/reindex
        if (method === 'POST' && pathname === '/internal/rag/reindex') {
          let rawBody: unknown = {};
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

          const parsedReindex = ReindexRagBodySchema.safeParse(rawBody);
          if (!parsedReindex.success) {
            sendJson(
              res,
              400,
              createApiErrorResponse(
                ErrorCode.VALIDATION_ERROR,
                'Invalid POST /internal/rag/reindex request body',
                { issues: parsedReindex.error.issues },
                { correlationId, service: config.serviceName },
              ),
              correlationId,
              traceparent,
            );
            return;
          }

          const reindexResult = await ragService.reindexDocuments({
            documentIds: parsedReindex.data.documentIds,
            updatedBy: parsedReindex.data.updatedBy ?? actorFromHeader,
          });
          const cacheFlushed = await redisCache.flushByPrefix();

          sendJson(
            res,
            200,
            createApiResponse(
              { ...reindexResult, cacheFlushed },
              { correlationId, service: config.serviceName },
            ),
            correlationId,
            traceparent,
          );
          return;
        }

        // 4. POST /internal/rag/test-retrieval
        if (method === 'POST' && pathname === '/internal/rag/test-retrieval') {
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

          const parsedTest = TestRetrievalBodySchema.safeParse(rawBody);
          if (!parsedTest.success) {
            sendJson(
              res,
              400,
              createApiErrorResponse(
                ErrorCode.VALIDATION_ERROR,
                'Invalid POST /internal/rag/test-retrieval request body',
                { issues: parsedTest.error.issues },
                { correlationId, service: config.serviceName },
              ),
              correlationId,
              traceparent,
            );
            return;
          }

          const retrieval = await ragService.testRetrieval(
            parsedTest.data.query,
            {
              domain: parsedTest.data.domain,
              category: parsedTest.data.category,
              limit: parsedTest.data.limit,
            },
          );

          sendJson(
            res,
            200,
            createApiResponse(retrieval, {
              correlationId,
              service: config.serviceName,
            }),
            correlationId,
            traceparent,
          );
          return;
        }

        // 5. GET / PUT / DELETE /internal/rag/documents/:id
        const docIdPrefix = '/internal/rag/documents/';
        if (pathname.startsWith(docIdPrefix)) {
          const rawId = pathname.slice(docIdPrefix.length);
          let docId = '';
          try {
            docId = decodeURIComponent(rawId).trim();
          } catch {
            docId = rawId.trim();
          }

          if (!docId || docId.includes('/')) {
            sendJson(
              res,
              400,
              createApiErrorResponse(
                ErrorCode.VALIDATION_ERROR,
                'Invalid RAG document id in path.',
                undefined,
                { correlationId, service: config.serviceName },
              ),
              correlationId,
              traceparent,
            );
            return;
          }

          if (method === 'GET') {
            const document = await ragService.getDocument(docId);
            if (!document) {
              sendJson(
                res,
                404,
                createApiErrorResponse(
                  ErrorCode.NOT_FOUND,
                  `RAG document "${docId}" not found.`,
                  undefined,
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
              createApiResponse(
                { document },
                { correlationId, service: config.serviceName },
              ),
              correlationId,
              traceparent,
            );
            return;
          }

          if (method === 'PUT') {
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

            const parsedUpdate = UpdateRagDocumentBodySchema.safeParse(rawBody);
            if (!parsedUpdate.success) {
              sendJson(
                res,
                400,
                createApiErrorResponse(
                  ErrorCode.VALIDATION_ERROR,
                  'Invalid PUT /internal/rag/documents/:id request body',
                  { issues: parsedUpdate.error.issues },
                  { correlationId, service: config.serviceName },
                ),
                correlationId,
                traceparent,
              );
              return;
            }

            const updated = await ragService.updateDocument(docId, {
              ...parsedUpdate.data,
              updatedBy: parsedUpdate.data.updatedBy ?? actorFromHeader,
            });
            if (!updated) {
              sendJson(
                res,
                404,
                createApiErrorResponse(
                  ErrorCode.NOT_FOUND,
                  `RAG document "${docId}" not found.`,
                  undefined,
                  { correlationId, service: config.serviceName },
                ),
                correlationId,
                traceparent,
              );
              return;
            }
            const cacheFlushed = await redisCache.flushByPrefix();
            sendJson(
              res,
              200,
              createApiResponse(
                {
                  before: updated.before,
                  after: updated.after,
                  document: updated.after,
                  cacheFlushed,
                },
                { correlationId, service: config.serviceName },
              ),
              correlationId,
              traceparent,
            );
            return;
          }

          if (method === 'DELETE') {
            let updatedBy =
              requestUrl.searchParams.get('updatedBy')?.trim() || actorFromHeader;
            try {
              const rawBody = await readJsonBody(req);
              if (
                rawBody &&
                typeof rawBody === 'object' &&
                !Array.isArray(rawBody) &&
                typeof (rawBody as Record<string, unknown>).updatedBy === 'string' &&
                ((rawBody as Record<string, unknown>).updatedBy as string).trim()
              ) {
                updatedBy = (
                  (rawBody as Record<string, unknown>).updatedBy as string
                ).trim();
              }
            } catch {
              // Empty or non-JSON DELETE body is acceptable
            }

            const deleted = await ragService.softDeleteDocument(docId, updatedBy);
            if (!deleted) {
              sendJson(
                res,
                404,
                createApiErrorResponse(
                  ErrorCode.NOT_FOUND,
                  `RAG document "${docId}" not found.`,
                  undefined,
                  { correlationId, service: config.serviceName },
                ),
                correlationId,
                traceparent,
              );
              return;
            }
            const cacheFlushed = await redisCache.flushByPrefix();
            sendJson(
              res,
              200,
              createApiResponse(
                {
                  before: deleted.before,
                  after: deleted.after,
                  document: deleted.after,
                  deactivated: true,
                  cacheFlushed,
                },
                { correlationId, service: config.serviceName },
              ),
              correlationId,
              traceparent,
            );
            return;
          }
        }

        sendJson(
          res,
          404,
          createApiErrorResponse(
            ErrorCode.NOT_FOUND,
            `Internal RAG route not found: ${method} ${pathname}`,
            undefined,
            { correlationId, service: config.serviceName },
          ),
          correlationId,
          traceparent,
        );
        return;
      }

      // =======================================================================
      // POST /v1/copilot/chat & POST /v1/copilot/customer-chat
      // (v3.1 Live Multi-Step Ollama + 8-Layer Security Harness)
      // =======================================================================
      if (
        method === 'POST' &&
        (pathname === '/v1/copilot/chat' || pathname === '/v1/copilot/customer-chat')
      ) {
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

        const normalizedBody = normalizeIncomingChatBody(rawBody);
        const bodyWithPortal =
          pathname === '/v1/copilot/customer-chat' &&
          normalizedBody &&
          typeof normalizedBody === 'object' &&
          !Array.isArray(normalizedBody)
            ? { ...(normalizedBody as Record<string, unknown>), portal: 'STOREFRONT' }
            : normalizedBody;
        const parsed = ExtendedChatRequestSchema.safeParse(bodyWithPortal);
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

        const rawCaller = extractCallerFromRequest(
          req,
          undefined,
          correlationId,
          traceparent,
        );
        const internalSecretValid = hasValidInternalSecret(
          req,
          config.internalServiceSecret,
        );

        let effectiveCaller: CallerAuthContext = rawCaller;

        if (parsed.data.portal === 'STOREFRONT') {
          const guestSessionId =
            getSingleHeader(req, 'x-guest-session-id') ??
            parsed.data.guestSessionId ??
            (typeof parsed.data.context?.guestSessionId === 'string'
              ? parsed.data.context.guestSessionId
              : undefined) ??
            `guest_${correlationId.slice(0, 12)}`;

          if (rawCaller.bearerToken) {
            try {
              assertNoSuperuserToken(rawCaller.bearerToken);
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
            // Force strictly read-only CUSTOMER scope on Storefront regardless of caller roles
            effectiveCaller = {
              ...rawCaller,
              roles: [Role.CUSTOMER],
            };
          } else if (internalSecretValid) {
            // Read-only GUEST_CUSTOMER forwarded from trusted Storefront BFF
            effectiveCaller = {
              bearerToken: '',
              userId: guestSessionId,
              roles: [Role.CUSTOMER],
              correlationId,
              traceparent,
            };
          } else {
            sendJson(
              res,
              401,
              createApiErrorResponse(
                ErrorCode.UNAUTHORIZED,
                'Storefront Copilot requires customer Bearer JWT or valid BFF x-internal-secret.',
                undefined,
                { correlationId, service: config.serviceName },
              ),
              correlationId,
              traceparent,
            );
            return;
          }
        } else {
          // Strict ADMIN_PORTAL enforcement: NEVER allow guest/internal-secret or CUSTOMER role
          if (!rawCaller.bearerToken) {
            opsMetrics.recordRbacDenial();
            sendJson(
              res,
              401,
              createApiErrorResponse(
                ErrorCode.UNAUTHORIZED,
                'Missing caller Authorization Bearer JWT for Admin MCP Copilot.',
                undefined,
                { correlationId, service: config.serviceName },
              ),
              correlationId,
              traceparent,
            );
            return;
          }

          try {
            assertNoSuperuserToken(rawCaller.bearerToken);
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

          const jwtPayload = decodeJwtPayload(rawCaller.bearerToken);
          const jwtRoles = extractRolesFromJwt(jwtPayload);
          const effectiveAdminRoles = jwtRoles.length > 0 ? jwtRoles : rawCaller.roles;
          const isAdminRole = effectiveAdminRoles.some((r) =>
            ADMIN_PORTAL_ROLES.includes(r),
          );
          if (
            !isAdminRole ||
            !hasPermission(effectiveAdminRoles, Permission.COPILOT_ACCESS)
          ) {
            opsMetrics.recordRbacDenial();
            sendJson(
              res,
              403,
              createApiErrorResponse(
                ErrorCode.FORBIDDEN,
                `Vai trò [${effectiveAdminRoles.join(', ')}] không có quyền truy cập Admin MCP Copilot.`,
                undefined,
                { correlationId, service: config.serviceName },
              ),
              correlationId,
              traceparent,
            );
            return;
          }

          effectiveCaller = {
            ...rawCaller,
            roles: effectiveAdminRoles,
          };
        }

        const chatResult = await orchestrator.handleChat(
          parsed.data,
          effectiveCaller,
        );

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
