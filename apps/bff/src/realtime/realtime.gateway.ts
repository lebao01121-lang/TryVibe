import { Inject, type OnModuleDestroy } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { createAdapter } from '@socket.io/redis-adapter';
import {
  ADMIN_PORTAL_ROLES,
  isMfaRequiredForRoles,
  Role,
  type JwtAccessPayload,
} from '@atelier/contracts';
import { createLogger, type Logger } from '@atelier/observability';
import Redis, { type RedisOptions } from 'ioredis';
import { Server, Socket } from 'socket.io';
import { HttpProxyService } from '../common/http-proxy.service';
import { BffRedisService } from '../common/redis.service';
import {
  BFF_CONFIG_TOKEN,
  BFF_SERVICE_NAME,
  DEFAULT_CORS_ORIGINS,
  type BffConfig,
} from '../config/env';
import { JwtVerifierService } from '../security/jwt-verifier.service';

export interface TryOnSubscribePayload {
  jobId?: string;
  sessionId?: string;
}

export interface OrderSubscribePayload {
  orderId?: string;
  orderCode?: string;
}

export interface RealtimeSocketAuthContext {
  isAuthenticated: boolean;
  user: JwtAccessPayload | null;
  guestSessionId: string | null;
  isAdmin: boolean;
  clientIp: string;
}

export type TryOnRealtimeEventName = 'tryon:progress' | 'tryon:completed' | 'tryon:failed';
export type OrderRealtimeEventName =
  | 'order:paid'
  | 'order:updated'
  | 'order:packed'
  | 'order:shipped'
  | 'order:delivered'
  | 'payment:late-alert';

export interface RoomSubscriptionResult {
  ok: boolean;
  room?: string;
  channel?: 'tryon' | 'order';
  targetId?: string;
  replayedCount?: number;
  error?: string;
  timestamp: string;
}

interface BufferedEvent {
  event: string;
  data: Record<string, unknown>;
  recordedAtMs: number;
}

const REPLAY_TTL_MS = 60_000;
const MAX_BUFFERED_EVENTS_PER_KEY = 10;
const UPSTREAM_AUTHZ_TIMEOUT_MS = 3_000;
const TRYON_REPLAY_KEY_PREFIX = 'atelier:ws:replay:tryon:';
const ORDER_REPLAY_KEY_PREFIX = 'atelier:ws:replay:order:';
const REDIS_ADAPTER_CONNECT_TIMEOUT_MS = 2_000;

// In-memory replay buffers used STRICTLY as fallback when Redis is disconnected
const recentTryOnEvents = new Map<string, BufferedEvent[]>();
const recentOrderEvents = new Map<string, BufferedEvent[]>();

// Shared Socket.io Redis Adapter coordinator across /realtime and / namespaces
let sharedRedisService: BffRedisService | null = null;
let sharedPubClient: Redis | null = null;
let sharedSubClient: Redis | null = null;
let sharedRedisAdapterAttached = false;
let sharedAdapterInitPromise: Promise<void> | null = null;
const attachedIoServers = new WeakSet<object>();

function sanitizeRedisUrl(raw: string): string {
  try {
    const parsed = new URL(raw);
    return `${parsed.protocol}//${parsed.hostname}:${parsed.port || '6379'}`;
  } catch {
    return 'redis://127.0.0.1:6379';
  }
}

function buildSocketIoRedisOptions(redisUrl: string): RedisOptions {
  let host = '127.0.0.1';
  let port = 6379;
  let password: string | undefined;
  let db = 0;

  try {
    const parsed = new URL(redisUrl);
    host = parsed.hostname || '127.0.0.1';
    port = parsed.port ? Number(parsed.port) : 6379;
    if (parsed.password) {
      password = decodeURIComponent(parsed.password);
    }
    const pathDb = parsed.pathname.replace(/^\//, '');
    if (pathDb && /^\d+$/.test(pathDb)) {
      db = Number(pathDb);
    }
  } catch {
    // Keep defaults if URL is malformed
  }

  if (!password && process.env.REDIS_PASSWORD) {
    password = process.env.REDIS_PASSWORD;
  }

  return {
    host,
    port,
    db,
    ...(password ? { password } : {}),
    lazyConnect: true,
    connectTimeout: REDIS_ADAPTER_CONNECT_TIMEOUT_MS,
    maxRetriesPerRequest: 2,
    enableReadyCheck: false,
    retryStrategy(times: number): number | null {
      if (times > 5) {
        return null;
      }
      return Math.min(times * 250, 1500);
    },
  };
}

function resolveIoServer(serverOrNamespace: unknown): Server | null {
  if (!serverOrNamespace || typeof serverOrNamespace !== 'object') {
    return null;
  }
  const candidate = serverOrNamespace as Record<string, unknown>;
  if (typeof candidate.adapter === 'function') {
    return serverOrNamespace as Server;
  }
  if (
    candidate.server &&
    typeof candidate.server === 'object' &&
    typeof (candidate.server as Record<string, unknown>).adapter === 'function'
  ) {
    return candidate.server as Server;
  }
  return null;
}

function isRedisClientLive(client: Redis | null): boolean {
  return Boolean(client && (client.status === 'ready' || client.status === 'connect'));
}

export function isSocketIoRedisAdapterActive(): boolean {
  return (
    sharedRedisAdapterAttached &&
    isRedisClientLive(sharedPubClient) &&
    isRedisClientLive(sharedSubClient)
  );
}

async function safelyCloseRedisClient(client: Redis | null): Promise<void> {
  if (!client) {
    return;
  }
  try {
    if (client.status === 'ready' || client.status === 'connect') {
      await client.quit();
    } else {
      client.disconnect();
    }
  } catch {
    try {
      client.disconnect();
    } catch {
      // Ignore shutdown disconnect error
    }
  }
}

function pushBufferedEvent(
  store: Map<string, BufferedEvent[]>,
  key: string,
  event: string,
  data: Record<string, unknown>,
  recordedAtMs = Date.now(),
): void {
  const now = Date.now();
  if (store.size > 150) {
    for (const [k, list] of store.entries()) {
      const last = list[list.length - 1];
      if (!last || now - last.recordedAtMs > REPLAY_TTL_MS) {
        store.delete(k);
      }
    }
  }
  const existing = store.get(key) ?? [];
  existing.push({ event, data, recordedAtMs });
  if (existing.length > MAX_BUFFERED_EVENTS_PER_KEY) {
    existing.splice(0, existing.length - MAX_BUFFERED_EVENTS_PER_KEY);
  }
  store.set(key, existing);
}

function getFreshBufferedEvents(
  store: Map<string, BufferedEvent[]>,
  key: string,
): BufferedEvent[] {
  const list = store.get(key);
  if (!list || list.length === 0) {
    return [];
  }
  const now = Date.now();
  const fresh = list.filter((item) => now - item.recordedAtMs <= REPLAY_TTL_MS);
  if (fresh.length === 0) {
    store.delete(key);
    return [];
  }
  return fresh;
}

function parseFreshRedisReplayEntries(rawEntries: string[]): BufferedEvent[] {
  const now = Date.now();
  const parsed: BufferedEvent[] = [];
  for (const raw of rawEntries) {
    try {
      const item = JSON.parse(raw) as Partial<BufferedEvent>;
      if (
        item &&
        typeof item.event === 'string' &&
        item.data &&
        typeof item.data === 'object' &&
        !Array.isArray(item.data) &&
        typeof item.recordedAtMs === 'number' &&
        now - item.recordedAtMs <= REPLAY_TTL_MS
      ) {
        parsed.push({
          event: item.event,
          data: item.data as Record<string, unknown>,
          recordedAtMs: item.recordedAtMs,
        });
      }
    } catch {
      // Skip malformed entry
    }
  }
  return parsed;
}

export async function recordTryOnEventForReplay(
  sessionId: string,
  event: TryOnRealtimeEventName,
  payload: Record<string, unknown>,
  redisOverride?: BffRedisService,
): Promise<Record<string, unknown>> {
  const data: Record<string, unknown> = {
    sessionId,
    event,
    ...payload,
  };
  const recordedAtMs = Date.now();
  const entry: BufferedEvent = { event, data, recordedAtMs };
  const redis = redisOverride ?? sharedRedisService;
  const persisted = redis
    ? await redis.pushReplayEventSafe(
        `${TRYON_REPLAY_KEY_PREFIX}${sessionId}`,
        JSON.stringify(entry),
        MAX_BUFFERED_EVENTS_PER_KEY,
        REPLAY_TTL_MS,
      )
    : false;

  if (!persisted) {
    pushBufferedEvent(recentTryOnEvents, sessionId, event, data, recordedAtMs);
  }
  return data;
}

export async function recordOrderEventForReplay(
  keys: string[],
  event: OrderRealtimeEventName,
  payload: Record<string, unknown>,
  redisOverride?: BffRedisService,
): Promise<Record<string, unknown>> {
  const data: Record<string, unknown> = {
    event,
    ...payload,
  };
  const recordedAtMs = Date.now();
  const entry: BufferedEvent = { event, data, recordedAtMs };
  const serialized = JSON.stringify(entry);
  const redis = redisOverride ?? sharedRedisService;
  const uniqueKeys = Array.from(new Set(keys.map((k) => k.trim()).filter((k) => k.length > 0)));

  await Promise.all(
    uniqueKeys.map(async (key) => {
      const persisted = redis
        ? await redis.pushReplayEventSafe(
            `${ORDER_REPLAY_KEY_PREFIX}${key}`,
            serialized,
            MAX_BUFFERED_EVENTS_PER_KEY,
            REPLAY_TTL_MS,
          )
        : false;
      if (!persisted) {
        pushBufferedEvent(recentOrderEvents, key, event, data, recordedAtMs);
      }
    }),
  );

  return data;
}

function extractTargetId(
  payload: TryOnSubscribePayload | OrderSubscribePayload | string | undefined,
  keys: readonly ('sessionId' | 'jobId' | 'orderId' | 'orderCode')[],
): string {
  if (typeof payload === 'string') {
    return payload.trim();
  }
  if (!payload || typeof payload !== 'object') {
    return '';
  }
  const record = payload as Record<string, unknown>;
  for (const key of keys) {
    const raw = record[key];
    if (typeof raw === 'string' && raw.trim().length > 0) {
      return raw.trim();
    }
  }
  return '';
}

function extractHandshakeCookie(cookieHeader: string | undefined, cookieNames: readonly string[]): string | null {
  if (!cookieHeader || typeof cookieHeader !== 'string') {
    return null;
  }
  const wanted = new Set(cookieNames);
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) {
      continue;
    }
    const name = part.slice(0, idx).trim();
    if (wanted.has(name)) {
      try {
        const val = decodeURIComponent(part.slice(idx + 1).trim()).trim();
        if (val.length > 0) {
          return val;
        }
      } catch {
        const raw = part.slice(idx + 1).trim();
        if (raw.length > 0) {
          return raw;
        }
      }
    }
  }
  return null;
}

function normalizeGuestSessionId(raw: unknown): string | null {
  if (typeof raw !== 'string') {
    return null;
  }
  const trimmed = raw.trim();
  if (trimmed.length < 4 || trimmed.length > 128) {
    return null;
  }
  return trimmed;
}

function extractBearerTokenFromHandshake(client: Socket): string | null {
  const authRecord =
    client.handshake?.auth && typeof client.handshake.auth === 'object'
      ? (client.handshake.auth as Record<string, unknown>)
      : {};

  const authToken = authRecord.token;
  if (typeof authToken === 'string' && authToken.trim().length > 0) {
    const trimmed = authToken.trim();
    return trimmed.toLowerCase().startsWith('bearer ') ? trimmed.slice(7).trim() || null : trimmed;
  }

  const rawAuthHeader = client.handshake?.headers?.authorization;
  const authHeader = Array.isArray(rawAuthHeader) ? rawAuthHeader[0] : rawAuthHeader;
  if (typeof authHeader === 'string' && authHeader.trim().toLowerCase().startsWith('bearer ')) {
    const token = authHeader.trim().slice(7).trim();
    return token.length > 0 ? token : null;
  }

  return null;
}

function extractGuestSessionFromHandshake(client: Socket): string | null {
  const authRecord =
    client.handshake?.auth && typeof client.handshake.auth === 'object'
      ? (client.handshake.auth as Record<string, unknown>)
      : {};

  const fromAuth = normalizeGuestSessionId(authRecord.guestSessionId);
  if (fromAuth) {
    return fromAuth;
  }

  const rawHeader = client.handshake?.headers?.['x-guest-session-id'];
  const fromHeader = normalizeGuestSessionId(Array.isArray(rawHeader) ? rawHeader[0] : rawHeader);
  if (fromHeader) {
    return fromHeader;
  }

  const rawCookieHeader = client.handshake?.headers?.cookie;
  const cookieStr = Array.isArray(rawCookieHeader) ? rawCookieHeader.join('; ') : rawCookieHeader;
  const fromCookie = normalizeGuestSessionId(
    extractHandshakeCookie(cookieStr, ['atelier_guest_session', 'atelier_guest_session_id']),
  );
  return fromCookie;
}

function extractClientIpFromHandshake(client: Socket): string {
  const xff = client.handshake?.headers?.['x-forwarded-for'];
  const raw = Array.isArray(xff) ? xff[0] : xff;
  if (typeof raw === 'string' && raw.trim().length > 0) {
    return raw.split(',')[0]?.trim() || '127.0.0.1';
  }
  return client.handshake?.address || '127.0.0.1';
}

function isMfaSatisfiedForUser(user: JwtAccessPayload): boolean {
  return !isMfaRequiredForRoles(user.roles) || user.mfaVerified === true;
}

function isVerifiedAdminUser(user: JwtAccessPayload | null): boolean {
  if (!user) {
    return false;
  }
  const hasAdminRole = user.roles.some((role) => ADMIN_PORTAL_ROLES.includes(role));
  return hasAdminRole && isMfaSatisfiedForUser(user);
}

function isOrderAdminOrStaff(user: JwtAccessPayload | null): boolean {
  if (!user || !isMfaSatisfiedForUser(user)) {
    return false;
  }
  return (
    user.roles.includes(Role.SUPER_ADMIN) ||
    user.roles.includes(Role.ORDER_STAFF) ||
    user.roles.includes(Role.WAREHOUSE_MANAGER)
  );
}

function isTryOnAdminUser(user: JwtAccessPayload | null): boolean {
  if (!user || !isMfaSatisfiedForUser(user)) {
    return false;
  }
  return (
    user.roles.includes(Role.SUPER_ADMIN) ||
    user.roles.includes(Role.CATALOG_AI_OPERATOR)
  );
}

function extractUpstreamDataObject(body: unknown): Record<string, unknown> | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return null;
  }
  const rec = body as Record<string, unknown>;
  if (rec.data && typeof rec.data === 'object' && !Array.isArray(rec.data)) {
    return rec.data as Record<string, unknown>;
  }
  return rec;
}

abstract class BaseRealtimeGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy
{
  @WebSocketServer()
  server!: Server;

  protected readonly logger: Logger = createLogger(BFF_SERVICE_NAME);
  protected abstract readonly namespaceLabel: string;

  constructor(
    protected readonly config: BffConfig,
    protected readonly jwtVerifier: JwtVerifierService,
    protected readonly proxy: HttpProxyService,
    protected readonly redis: BffRedisService,
  ) {
    sharedRedisService = redis;
  }

  afterInit(server: Server): void {
    const ioServer = resolveIoServer(server);
    if (!ioServer) {
      this.logger.warn(
        { namespace: this.namespaceLabel },
        'Could not resolve root Socket.io Server instance for Redis adapter attachment',
      );
      return;
    }

    if (!this.config.socketIoRedisEnabled) {
      this.logger.info(
        { namespace: this.namespaceLabel },
        'SOCKET_IO_REDIS_ENABLED=false — Socket.io running on default in-memory adapter',
      );
      return;
    }

    if (attachedIoServers.has(ioServer)) {
      return;
    }
    attachedIoServers.add(ioServer);

    sharedAdapterInitPromise = this.attachRedisAdapterOnce(ioServer);
    void sharedAdapterInitPromise;
  }

  private async attachRedisAdapterOnce(ioServer: Server): Promise<void> {
    const options = buildSocketIoRedisOptions(this.config.redisUrl);
    const pubClient = new Redis(options);
    const subClient = pubClient.duplicate();

    const onClientError = (role: 'pub' | 'sub') => (err: Error) => {
      this.logger.warn(
        {
          role,
          redisUrl: sanitizeRedisUrl(this.config.redisUrl),
          err: err.message,
        },
        'Socket.io Redis adapter client error',
      );
    };

    pubClient.on('error', onClientError('pub'));
    subClient.on('error', onClientError('sub'));

    let connectTimer: NodeJS.Timeout | null = null;
    try {
      await Promise.race([
        Promise.all([pubClient.connect(), subClient.connect()]).then(async () => {
          const pong = await pubClient.ping();
          if (pong !== 'PONG') {
            throw new Error(`Unexpected Redis PING reply: ${String(pong)}`);
          }
        }),
        new Promise<never>((_, reject) => {
          connectTimer = setTimeout(
            () => reject(new Error(`Redis adapter connect timeout (${REDIS_ADAPTER_CONNECT_TIMEOUT_MS}ms)`)),
            REDIS_ADAPTER_CONNECT_TIMEOUT_MS + 500,
          );
        }),
      ]);

      ioServer.adapter(createAdapter(pubClient, subClient));
      sharedPubClient = pubClient;
      sharedSubClient = subClient;
      sharedRedisAdapterAttached = true;

      this.logger.info(
        {
          redisUrl: sanitizeRedisUrl(this.config.redisUrl),
          namespaces: ['/realtime', '/'],
        },
        'Socket.io @socket.io/redis-adapter attached (multi-instance pub/sub active)',
      );
    } catch (error) {
      sharedRedisAdapterAttached = false;
      await Promise.all([
        safelyCloseRedisClient(pubClient),
        safelyCloseRedisClient(subClient),
      ]);
      this.logger.warn(
        {
          redisUrl: sanitizeRedisUrl(this.config.redisUrl),
          err: error instanceof Error ? error.message : String(error),
        },
        'Redis unreachable for @socket.io/redis-adapter — staying gracefully on default in-memory Socket.io adapter',
      );
    } finally {
      if (connectTimer) {
        clearTimeout(connectTimer);
      }
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (sharedAdapterInitPromise) {
      await sharedAdapterInitPromise.catch(() => undefined);
    }
    const pub = sharedPubClient;
    const sub = sharedSubClient;
    sharedPubClient = null;
    sharedSubClient = null;
    sharedRedisAdapterAttached = false;
    sharedAdapterInitPromise = null;

    if (pub || sub) {
      await Promise.all([safelyCloseRedisClient(pub), safelyCloseRedisClient(sub)]);
      this.logger.info('Closed Socket.io Redis adapter pub/sub clients cleanly');
    }
  }

  isRedisAdapterActive(): boolean {
    return isSocketIoRedisAdapterActive();
  }

  protected async readTryOnReplayEvents(sessionId: string): Promise<BufferedEvent[]> {
    const rawList = await this.redis.getReplayEventsSafe(`${TRYON_REPLAY_KEY_PREFIX}${sessionId}`);
    if (rawList !== null) {
      return parseFreshRedisReplayEntries(rawList);
    }
    return getFreshBufferedEvents(recentTryOnEvents, sessionId);
  }

  protected async readOrderReplayEvents(key: string): Promise<BufferedEvent[]> {
    const rawList = await this.redis.getReplayEventsSafe(`${ORDER_REPLAY_KEY_PREFIX}${key}`);
    if (rawList !== null) {
      return parseFreshRedisReplayEntries(rawList);
    }
    return getFreshBufferedEvents(recentOrderEvents, key);
  }

  handleConnection(client: Socket): void {
    void this.resolveSocketAuth(client).then((auth) => {
      this.logger.info(
        {
          socketId: client.id,
          namespace: this.namespaceLabel,
          isAuthenticated: auth.isAuthenticated,
          userId: auth.user?.sub ?? null,
          hasGuestSession: Boolean(auth.guestSessionId),
          isAdmin: auth.isAdmin,
        },
        'Realtime client connected',
      );
    });
  }

  handleDisconnect(client: Socket): void {
    this.logger.info(
      { socketId: client.id, namespace: this.namespaceLabel },
      'Realtime client disconnected',
    );
  }

  protected resolveSocketAuth(client: Socket): Promise<RealtimeSocketAuthContext> {
    const data = client.data as Record<string, unknown>;
    const cachedPromise = data._authPromise as Promise<RealtimeSocketAuthContext> | undefined;
    if (cachedPromise) {
      return cachedPromise;
    }

    const promise = this.authenticateSocket(client);
    data._authPromise = promise;
    return promise;
  }

  private async authenticateSocket(client: Socket): Promise<RealtimeSocketAuthContext> {
    const bearerToken = extractBearerTokenFromHandshake(client);
    const guestSessionId = extractGuestSessionFromHandshake(client);
    const clientIp = extractClientIpFromHandshake(client);

    let user: JwtAccessPayload | null = null;
    if (bearerToken) {
      try {
        user = await this.jwtVerifier.verifyAccessToken(bearerToken);
      } catch (error) {
        this.logger.warn(
          {
            socketId: client.id,
            namespace: this.namespaceLabel,
            err: error instanceof Error ? error.message : String(error),
          },
          'Rejected invalid JWT during Socket.io handshake',
        );
        user = null;
      }
    }

    const isAdmin = isVerifiedAdminUser(user);
    const isAuthenticated = Boolean(user || guestSessionId);
    const authContext: RealtimeSocketAuthContext = {
      isAuthenticated,
      user,
      guestSessionId,
      isAdmin,
      clientIp,
    };

    const data = client.data as Record<string, unknown>;
    data.auth = authContext;
    data.user = user;
    data.guestSessionId = guestSessionId;
    data.isAdmin = isAdmin;
    data.isAuthenticated = isAuthenticated;

    return authContext;
  }

  @SubscribeMessage('tryon:subscribe')
  async handleTryOnSubscribe(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: TryOnSubscribePayload | string | undefined,
  ): Promise<RoomSubscriptionResult> {
    const targetId = extractTargetId(payload, ['sessionId', 'jobId']);

    if (!targetId || targetId.length > 128) {
      return {
        ok: false,
        channel: 'tryon',
        error: 'A valid sessionId or jobId is required to subscribe to try-on updates.',
        timestamp: new Date().toISOString(),
      };
    }

    const auth = await this.resolveSocketAuth(client);
    if (!auth.isAuthenticated) {
      this.logger.warn(
        { socketId: client.id, namespace: this.namespaceLabel, targetId },
        'Blocked unauthenticated tryon:subscribe attempt',
      );
      return {
        ok: false,
        channel: 'tryon',
        targetId,
        error: 'FORBIDDEN: Unauthorized try-on subscription.',
        timestamp: new Date().toISOString(),
      };
    }

    const authorized = await this.verifyTryOnOwnership(targetId, auth);
    if (!authorized) {
      this.logger.warn(
        {
          socketId: client.id,
          namespace: this.namespaceLabel,
          targetId,
          userId: auth.user?.sub ?? null,
          hasGuestSession: Boolean(auth.guestSessionId),
        },
        'Blocked unauthorized cross-user tryon:subscribe attempt',
      );
      return {
        ok: false,
        channel: 'tryon',
        targetId,
        error: 'FORBIDDEN: Unauthorized try-on subscription.',
        timestamp: new Date().toISOString(),
      };
    }

    const room = `tryon:${targetId}`;
    await client.join(room);

    const buffered = await this.readTryOnReplayEvents(targetId);
    for (const item of buffered) {
      client.emit(item.event, item.data);
    }

    this.logger.info(
      {
        socketId: client.id,
        namespace: this.namespaceLabel,
        room,
        userId: auth.user?.sub ?? null,
        replayedCount: buffered.length,
      },
      'Client joined AI Try-On realtime room',
    );

    return {
      ok: true,
      channel: 'tryon',
      room,
      targetId,
      replayedCount: buffered.length,
      timestamp: new Date().toISOString(),
    };
  }

  @SubscribeMessage('order:subscribe')
  async handleOrderSubscribe(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: OrderSubscribePayload | string | undefined,
  ): Promise<RoomSubscriptionResult> {
    const targetId = extractTargetId(payload, ['orderCode', 'orderId']);

    if (!targetId || targetId.length > 128) {
      return {
        ok: false,
        channel: 'order',
        error: 'A valid orderId or orderCode is required to subscribe to order updates.',
        timestamp: new Date().toISOString(),
      };
    }

    const auth = await this.resolveSocketAuth(client);
    if (!auth.isAuthenticated) {
      this.logger.warn(
        { socketId: client.id, namespace: this.namespaceLabel, targetId },
        'Blocked unauthenticated order:subscribe attempt',
      );
      return {
        ok: false,
        channel: 'order',
        targetId,
        error: 'FORBIDDEN: Unauthorized order subscription.',
        timestamp: new Date().toISOString(),
      };
    }

    const altTargetId =
      payload && typeof payload === 'object'
        ? extractTargetId(payload, ['orderId', 'orderCode'])
        : '';
    const order = await this.fetchOrderForAuthorization(
      targetId,
      altTargetId && altTargetId !== targetId && altTargetId.length <= 128
        ? altTargetId
        : undefined,
    );

    if (!order || !this.isAuthorizedForOrder(order, auth)) {
      this.logger.warn(
        {
          socketId: client.id,
          namespace: this.namespaceLabel,
          targetId,
          userId: auth.user?.sub ?? null,
          hasGuestSession: Boolean(auth.guestSessionId),
        },
        'Blocked unauthorized order:subscribe attempt',
      );
      return {
        ok: false,
        channel: 'order',
        targetId,
        error: 'FORBIDDEN: Unauthorized order subscription.',
        timestamp: new Date().toISOString(),
      };
    }

    const verifiedOrderCode =
      typeof order.orderCode === 'string' && order.orderCode.trim().length > 0
        ? order.orderCode.trim()
        : targetId;
    const verifiedOrderId =
      typeof order.id === 'string' && order.id.trim().length > 0
        ? order.id.trim()
        : null;

    const verifiedKeys = Array.from(
      new Set([verifiedOrderCode, ...(verifiedOrderId ? [verifiedOrderId] : [])]),
    );
    const primaryRoom = `order:${verifiedOrderCode}`;
    for (const key of verifiedKeys) {
      await client.join(`order:${key}`);
    }

    const seenReplay = new Set<string>();
    let replayedCount = 0;
    for (const key of verifiedKeys) {
      const buffered = await this.readOrderReplayEvents(key);
      for (const item of buffered) {
        const dedupeKey = `${item.event}:${item.recordedAtMs}`;
        if (seenReplay.has(dedupeKey)) {
          continue;
        }
        seenReplay.add(dedupeKey);
        client.emit(item.event, item.data);
        replayedCount += 1;
      }
    }

    this.logger.info(
      {
        socketId: client.id,
        namespace: this.namespaceLabel,
        room: primaryRoom,
        userId: auth.user?.sub ?? null,
        replayedCount,
      },
      'Client joined Order realtime room',
    );

    return {
      ok: true,
      channel: 'order',
      room: primaryRoom,
      targetId: verifiedOrderCode,
      replayedCount,
      timestamp: new Date().toISOString(),
    };
  }

  private async fetchOrderForAuthorization(
    primaryId: string,
    fallbackId?: string,
  ): Promise<Record<string, unknown> | null> {
    const candidates = fallbackId ? [primaryId, fallbackId] : [primaryId];
    for (const candidate of candidates) {
      const res = await this.proxy.request({
        method: 'GET',
        url: `${this.config.orderRmaServiceUrl}/v1/orders/${encodeURIComponent(candidate)}`,
        timeoutMs: UPSTREAM_AUTHZ_TIMEOUT_MS,
        extraHeaders: {
          'x-internal-secret': this.config.internalServiceSecret,
        },
      });
      if (res.ok) {
        const orderObj = extractUpstreamDataObject(res.body);
        if (orderObj && (typeof orderObj.id === 'string' || typeof orderObj.orderCode === 'string')) {
          return orderObj;
        }
      }
      if (res.status !== 404) {
        return null;
      }
    }
    return null;
  }

  private isAuthorizedForOrder(
    order: Record<string, unknown>,
    auth: RealtimeSocketAuthContext,
  ): boolean {
    if (isOrderAdminOrStaff(auth.user)) {
      return true;
    }

    const orderUserId =
      typeof order.userId === 'string' && order.userId.trim().length > 0
        ? order.userId.trim()
        : null;
    const orderGuestSessionId =
      typeof order.guestSessionId === 'string' && order.guestSessionId.trim().length > 0
        ? order.guestSessionId.trim()
        : null;

    if (orderUserId) {
      return Boolean(
        auth.user && auth.user.sub.toLowerCase() === orderUserId.toLowerCase(),
      );
    }

    if (orderGuestSessionId) {
      return Boolean(auth.guestSessionId && auth.guestSessionId === orderGuestSessionId);
    }

    return false;
  }

  private async verifyTryOnOwnership(
    targetId: string,
    auth: RealtimeSocketAuthContext,
  ): Promise<boolean> {
    const callerHeaders: Record<string, string | undefined> = {
      ...(auth.user ? { 'x-user-id': auth.user.sub } : {}),
      ...(isTryOnAdminUser(auth.user) && auth.user
        ? { 'x-actor-roles': auth.user.roles.join(',') }
        : {}),
      ...(auth.guestSessionId ? { 'x-guest-session-id': auth.guestSessionId } : {}),
      'x-client-ip': auth.clientIp,
    };

    const sessionRes = await this.proxy.request({
      method: 'GET',
      url: `${this.config.aiTryonServiceUrl}/v1/tryon/sessions/${encodeURIComponent(targetId)}`,
      timeoutMs: UPSTREAM_AUTHZ_TIMEOUT_MS,
      extraHeaders: callerHeaders,
    });

    if (sessionRes.ok) {
      return true;
    }
    if (sessionRes.status === 403) {
      return false;
    }

    if (sessionRes.status === 404) {
      const jobRes = await this.proxy.request({
        method: 'GET',
        url: `${this.config.aiTryonServiceUrl}/v1/tryon/jobs/${encodeURIComponent(targetId)}`,
        timeoutMs: UPSTREAM_AUTHZ_TIMEOUT_MS,
        extraHeaders: callerHeaders,
      });
      return jobRes.ok;
    }

    return false;
  }

  emitTryOnEvent(
    sessionId: string,
    event: TryOnRealtimeEventName,
    data: Record<string, unknown>,
  ): void {
    if (!this.server) {
      return;
    }
    const room = `tryon:${sessionId}`;
    this.server.to(room).emit(event, data);
  }

  emitOrderEvent(
    keys: string[],
    event: OrderRealtimeEventName,
    data: Record<string, unknown>,
  ): void {
    if (!this.server) {
      return;
    }
    const uniqueRooms = Array.from(
      new Set(keys.filter((k) => k.trim().length > 0).map((k) => `order:${k.trim()}`)),
    );
    if (uniqueRooms.length === 0) {
      return;
    }
    let broadcaster = this.server.to(uniqueRooms[0]);
    for (let i = 1; i < uniqueRooms.length; i += 1) {
      broadcaster = broadcaster.to(uniqueRooms[i]);
    }
    broadcaster.emit(event, data);
  }
}

@WebSocketGateway({
  namespace: '/realtime',
  cors: {
    origin: [...DEFAULT_CORS_ORIGINS],
    credentials: true,
  },
})
export class RealtimeGateway extends BaseRealtimeGateway {
  protected readonly namespaceLabel = '/realtime';

  constructor(
    @Inject(BFF_CONFIG_TOKEN) config: BffConfig,
    @Inject(JwtVerifierService) jwtVerifier: JwtVerifierService,
    @Inject(HttpProxyService) proxy: HttpProxyService,
    @Inject(BffRedisService) redis: BffRedisService,
  ) {
    super(config, jwtVerifier, proxy, redis);
  }
}

@WebSocketGateway({
  namespace: '/',
  cors: {
    origin: [...DEFAULT_CORS_ORIGINS],
    credentials: true,
  },
})
export class RootRealtimeGateway extends BaseRealtimeGateway {
  protected readonly namespaceLabel = '/';

  constructor(
    @Inject(BFF_CONFIG_TOKEN) config: BffConfig,
    @Inject(JwtVerifierService) jwtVerifier: JwtVerifierService,
    @Inject(HttpProxyService) proxy: HttpProxyService,
    @Inject(BffRedisService) redis: BffRedisService,
  ) {
    super(config, jwtVerifier, proxy, redis);
  }
}
