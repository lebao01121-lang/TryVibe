import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { createLogger, type Logger } from '@atelier/observability';
import { Server, Socket } from 'socket.io';
import { BFF_SERVICE_NAME, DEFAULT_CORS_ORIGINS } from '../config/env';

export interface TryOnSubscribePayload {
  jobId?: string;
  sessionId?: string;
}

export interface OrderSubscribePayload {
  orderId?: string;
  orderCode?: string;
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
const recentTryOnEvents = new Map<string, BufferedEvent[]>();
const recentOrderEvents = new Map<string, BufferedEvent[]>();

function pushBufferedEvent(
  store: Map<string, BufferedEvent[]>,
  key: string,
  event: string,
  data: Record<string, unknown>,
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
  existing.push({ event, data, recordedAtMs: now });
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

export function recordTryOnEventForReplay(
  sessionId: string,
  event: TryOnRealtimeEventName,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const data: Record<string, unknown> = {
    sessionId,
    event,
    ...payload,
  };
  pushBufferedEvent(recentTryOnEvents, sessionId, event, data);
  return data;
}

export function recordOrderEventForReplay(
  keys: string[],
  event: OrderRealtimeEventName,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const data: Record<string, unknown> = {
    event,
    ...payload,
  };
  for (const key of keys) {
    if (key.trim().length > 0) {
      pushBufferedEvent(recentOrderEvents, key.trim(), event, data);
    }
  }
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

abstract class BaseRealtimeGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server!: Server;

  protected readonly logger: Logger = createLogger(BFF_SERVICE_NAME);
  protected abstract readonly namespaceLabel: string;

  handleConnection(client: Socket): void {
    this.logger.info(
      { socketId: client.id, namespace: this.namespaceLabel },
      'Realtime client connected',
    );
  }

  handleDisconnect(client: Socket): void {
    this.logger.info(
      { socketId: client.id, namespace: this.namespaceLabel },
      'Realtime client disconnected',
    );
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

    const room = `tryon:${targetId}`;
    await client.join(room);

    const buffered = getFreshBufferedEvents(recentTryOnEvents, targetId);
    for (const item of buffered) {
      client.emit(item.event, item.data);
    }

    this.logger.info(
      { socketId: client.id, namespace: this.namespaceLabel, room, replayedCount: buffered.length },
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

    const room = `order:${targetId}`;
    await client.join(room);

    // If caller passed both orderId and orderCode, join both rooms cleanly
    if (payload && typeof payload === 'object') {
      const altId =
        typeof payload.orderId === 'string' && payload.orderId.trim() !== targetId
          ? payload.orderId.trim()
          : undefined;
      if (altId && altId.length <= 128) {
        await client.join(`order:${altId}`);
      }
    }

    const buffered = getFreshBufferedEvents(recentOrderEvents, targetId);
    for (const item of buffered) {
      client.emit(item.event, item.data);
    }

    this.logger.info(
      { socketId: client.id, namespace: this.namespaceLabel, room, replayedCount: buffered.length },
      'Client joined Order realtime room',
    );

    return {
      ok: true,
      channel: 'order',
      room,
      targetId,
      replayedCount: buffered.length,
      timestamp: new Date().toISOString(),
    };
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
}
