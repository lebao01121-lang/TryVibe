import * as crypto from 'node:crypto';
import { HttpStatus, Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import {
  createEventEnvelope,
  ErrorCode,
  EVENT_NAMES,
  InventoryLedgerReason,
  ReservationStatus,
  type BatchAvailabilityRequest,
  type BatchAvailabilityResponse,
  type CommitReservationRequest,
  type InsufficientStockDetail,
  type InventoryLedgerEntryDto,
  type InventoryLedgerReason as InventoryLedgerReasonValue,
  type ReleaseReservationRequest,
  type ReservationStatus as ReservationStatusValue,
  type ReservationType as ReservationTypeValue,
  type ReservedStockLine,
  type ReserveStockRequest,
  type ReserveStockResponse,
  type SkuAvailabilityDto,
  type StockLevelAdminDto,
  type StockReservationAdminDto,
  type WarehouseDto,
  type WarehouseStockBreakdown,
  type WarehouseType as WarehouseTypeValue,
} from '@atelier/contracts';
import type { AtelierDbExecutor } from '@atelier/db-client';
import { createChildTraceparent, createLogger } from '@atelier/observability';
import { ApiDomainException } from '../common/api-exception';
import { INVENTORY_CONFIG_TOKEN, SERVICE_NAME, type InventoryConfig } from '../config/env';
import { InventoryDatabaseService } from '../infra/database.service';
import { InventoryRabbitMqService } from '../infra/rabbitmq.service';
import { InventoryRedisService } from '../infra/redis.service';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface WarehouseRow {
  id: string;
  code: string;
  name: string;
  type: WarehouseTypeValue;
  province_code: string;
  city: string;
  address: string | null;
  supports_2h_delivery: boolean;
  priority: number;
  is_active: boolean;
  created_at: Date | string;
}

interface StockLevelRow {
  sku_id: string;
  warehouse_id: string;
  product_id: string;
  sku_code: string | null;
  available_qty: number;
  reserved_qty: number;
  committed_qty: number;
  damaged_qty: number;
  safety_threshold: number;
  version: number;
  updated_at: Date | string;
}

interface StockLevelJoinedRow extends StockLevelRow {
  warehouse_code: string;
  warehouse_name: string;
  warehouse_type: WarehouseTypeValue;
  warehouse_priority: number;
}

interface ReservationRow {
  id: string;
  idempotency_key: string;
  reservation_type: ReservationTypeValue;
  reference_id: string;
  status: ReservationStatusValue;
  expires_at: Date | string;
  committed_at: Date | string | null;
  released_at: Date | string | null;
  created_at: Date | string;
}

interface ReservationItemJoinedRow {
  id: string;
  reservation_id: string;
  sku_id: string;
  warehouse_id: string;
  warehouse_code: string;
  qty: number;
}

interface LedgerJoinedRow {
  id: string;
  sku_id: string;
  warehouse_id: string;
  warehouse_code: string | null;
  delta_available: number;
  delta_reserved: number;
  delta_committed: number;
  balance_available_after: number;
  reason: InventoryLedgerReasonValue;
  reference_id: string | null;
  actor_id: string | null;
  note: string | null;
  created_at: Date | string;
}

export interface WarehouseAdminViewDto extends WarehouseDto {
  provinceCode: string;
  supports2hDelivery: boolean;
  totalAvailableQty: number;
  totalReservedQty: number;
  totalCommittedQty: number;
}

export interface LedgerAdminViewDto extends InventoryLedgerEntryDto {
  balanceAvailableAfter: number;
}

export interface ExpireSweepResult {
  expiredCount: number;
  expiredReservationIds: string[];
  expiredReferenceIds: string[];
  restoredSkus: Array<{ skuId: string; restoredQty: number; newAvailableQty: number }>;
}

export interface TestSetStockInput {
  skuId: string;
  availableQty: number;
  reservedQty?: number;
  committedQty?: number;
  damagedQty?: number;
  warehouseCode?: string;
  productId?: string;
}

export interface RmaRestockInput {
  skuId: string;
  qty: number;
  restockable: boolean;
  warehouseCode?: string;
  referenceId?: string;
  note?: string;
}

export interface RmaRestockResult {
  skuId: string;
  warehouseId: string;
  warehouseCode: string;
  qty: number;
  restockable: boolean;
  availableQty: number;
  damagedQty: number;
}

export interface StockLevelAdminExtendedDto extends StockLevelAdminDto {
  damagedQty: number;
}

export interface SyncCatalogSkuItem {
  skuId: string;
  skuCode?: string;
  productId: string;
  sizeCode?: string;
  defaultQty?: number;
}

export interface SyncCatalogSkusResult {
  receivedCount: number;
  insertedSkuCount: number;
  skippedExistingCount: number;
  totalDistinctSkus: number;
}

export interface InventoryOpsSummaryDto {
  totalSkus: number;
  lowStockCount: number;
  outOfStockCount: number;
  activeReservationsCount: number;
  totalAvailableQty: number;
  totalReservedQty: number;
  totalCommittedQty: number;
  totalDamagedQty: number;
  pendingAiDraftPosCount: number;
}

const FLAGSHIP_LOW_STOCK_M_CODES = new Set<string>(['AT-AOBLLI-C1-M', 'AT-AOPODE-C1-M']);

class InsufficientStockAbortError extends Error {
  constructor(readonly insufficientSkus: InsufficientStockDetail[]) {
    super('Insufficient stock during atomic reservation');
  }
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

@Injectable()
export class InventoryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = createLogger('@atelier/inventory:service');
  private expireTimer: ReturnType<typeof setInterval> | null = null;
  private expireSweepInFlight = false;

  constructor(
    @Inject(INVENTORY_CONFIG_TOKEN) private readonly config: InventoryConfig,
    private readonly db: InventoryDatabaseService,
    private readonly redis: InventoryRedisService,
    private readonly rabbitmq: InventoryRabbitMqService,
  ) {}

  onModuleInit(): void {
    this.expireTimer = setInterval(() => {
      void this.runExpireSweep().catch((error) => {
        this.logger.warn({ err: error }, 'Background reservation expire sweep failed');
      });
    }, this.config.expireSweepIntervalMs);
    if (typeof this.expireTimer.unref === 'function') {
      this.expireTimer.unref();
    }
  }

  onModuleDestroy(): void {
    if (this.expireTimer) {
      clearInterval(this.expireTimer);
      this.expireTimer = null;
    }
  }

  async getBatchAvailability(input: BatchAvailabilityRequest): Promise<BatchAvailabilityResponse> {
    const requestedUnique = [...new Set(input.skuIds.map((id) => id.trim()).filter(Boolean))];
    const validUuids = requestedUnique.filter((id) => UUID_REGEX.test(id));

    const rowsBySku = new Map<string, StockLevelJoinedRow[]>();
    if (validUuids.length > 0) {
      const params: unknown[] = [validUuids];
      let whFilter = '';
      if (input.warehouseCode && input.warehouseCode.trim()) {
        params.push(input.warehouseCode.trim().toUpperCase());
        whFilter = `AND UPPER(w.code) = $${params.length}`;
      }

      const res = await this.db.query<StockLevelJoinedRow>(
        `SELECT sl.*,
                w.code AS warehouse_code,
                w.name AS warehouse_name,
                w.type AS warehouse_type,
                w.priority AS warehouse_priority
         FROM stock_levels sl
         INNER JOIN warehouses w ON w.id = sl.warehouse_id
         WHERE sl.sku_id = ANY($1::uuid[])
           AND w.is_active = TRUE
           ${whFilter}
         ORDER BY sl.sku_id ASC, w.priority ASC, w.code ASC`,
        params,
      );

      for (const row of res.rows) {
        const list = rowsBySku.get(row.sku_id) ?? [];
        list.push(row);
        rowsBySku.set(row.sku_id, list);
      }
    }

    const items: Record<string, SkuAvailabilityDto> = {};
    const list: SkuAvailabilityDto[] = [];

    for (const skuId of requestedUnique) {
      const rows = rowsBySku.get(skuId) ?? [];
      let availableQty = 0;
      let reservedQty = 0;
      let committedQty = 0;
      let damagedQty = 0;
      let safetyThreshold = 3;
      let productId = skuId;
      const warehouses: WarehouseStockBreakdown[] = [];

      for (const row of rows) {
        const avail = Number(row.available_qty);
        const resv = Number(row.reserved_qty);
        const comm = Number(row.committed_qty);
        const dmg = Number(row.damaged_qty ?? 0);
        availableQty += avail;
        reservedQty += resv;
        committedQty += comm;
        damagedQty += dmg;
        safetyThreshold = Number(row.safety_threshold);
        productId = row.product_id;

        warehouses.push({
          warehouseId: row.warehouse_id,
          warehouseCode: row.warehouse_code,
          warehouseName: row.warehouse_name,
          warehouseType: row.warehouse_type,
          availableQty: avail,
          reservedQty: resv,
          committedQty: comm,
        });
      }

      const dto: SkuAvailabilityDto & { damagedQty: number } = {
        skuId,
        productId,
        availableQty,
        reservedQty,
        committedQty,
        damagedQty,
        inStock: availableQty > 0,
        lowStockWarning: availableQty >= 1 && availableQty <= safetyThreshold,
        safetyThreshold,
        warehouses,
      };
      items[skuId] = dto;
      list.push(dto);
    }

    return { items, list };
  }

  /**
   * Zero-oversell, zero-deadlock atomic stock reservation:
   * 1. Idempotency check (`idempotency_key`)
   * 2. Merge duplicates & deterministic ascending `skuId` lock ordering
   * 3. Fast Redis atomic Lua gate (`-- ATELIER_LUA_RESERVE`)
   * 4. Single ACID PostgreSQL transaction (`SELECT ... FOR UPDATE` + guarded `UPDATE ... AND available_qty >= $1`)
   */
  async reserveStock(
    input: ReserveStockRequest,
    correlationId: string,
  ): Promise<ReserveStockResponse> {
    // Step 1: Fast idempotency check
    const existing = await this.findReservationByIdempotencyKey(input.idempotencyKey);
    if (existing) {
      return existing;
    }

    // Step 2: Merge duplicate SKUs and sort lexicographically by skuId (zero deadlock)
    const mergedMap = new Map<string, number>();
    for (const line of input.items) {
      const skuId = line.skuId.trim();
      if (!UUID_REGEX.test(skuId)) {
        throw new ApiDomainException(
          HttpStatus.CONFLICT,
          ErrorCode.INSUFFICIENT_STOCK,
          `SKU ${skuId} không tồn tại trong hệ thống tồn kho.`,
          {
            insufficientSkus: [{ skuId, requestedQty: line.qty, availableQty: 0 }],
          },
        );
      }
      mergedMap.set(skuId, (mergedMap.get(skuId) ?? 0) + line.qty);
    }

    const sortedItems = [...mergedMap.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([skuId, qty]) => ({ skuId, qty }));

    // Step 3: Fast Redis atomic Lua gate (-- ATELIER_LUA_RESERVE)
    let redisDecremented = false;
    let redisOutcome = await this.redis.atomicReserve(sortedItems);

    if (redisOutcome.status === 'MISS') {
      await this.warmSkuCountersIfAbsent(sortedItems.map((i) => i.skuId));
      redisOutcome = await this.redis.atomicReserve(sortedItems);
    }

    if (redisOutcome.status === 'INSUFFICIENT') {
      throw new ApiDomainException(
        HttpStatus.CONFLICT,
        ErrorCode.INSUFFICIENT_STOCK,
        'Không đủ tồn kho khả dụng để giữ chỗ.',
        {
          insufficientSkus: redisOutcome.insufficientSkus,
        },
      );
    }

    if (redisOutcome.status === 'OK') {
      redisDecremented = true;
    }

    // Step 4: Single ACID PostgreSQL transaction in exact sorted skuId order
    try {
      const txResult = await this.db.transaction(async (tx) => {
        // Re-check idempotency inside transaction against concurrent identical retries
        const replay = await this.findReservationByIdempotencyKey(input.idempotencyKey, tx);
        if (replay) {
          return { response: replay, isReplay: true, outboxEntries: [] as Array<{ id: string; eventName: string; payload: Record<string, unknown> }>, availabilityAlerts: [] as Array<{ skuId: string; totalAvailable: number; safetyThreshold: number }> };
        }

        const whRes = await tx.query<WarehouseRow>(
          'SELECT * FROM warehouses WHERE is_active = TRUE ORDER BY priority ASC, code ASC',
        );
        const warehouseById = new Map<string, WarehouseRow>();
        for (const wh of whRes.rows) {
          warehouseById.set(wh.id, wh);
        }

        const preferredCode = input.preferredWarehouseCode?.trim().toUpperCase() ?? null;
        const allocatedLines: Array<{
          skuId: string;
          qty: number;
          warehouseId: string;
          warehouseCode: string;
          newAvailable: number;
          newReserved: number;
        }> = [];
        const availabilityAlerts: Array<{
          skuId: string;
          totalAvailable: number;
          safetyThreshold: number;
        }> = [];
        const shortages: InsufficientStockDetail[] = [];

        for (const item of sortedItems) {
          const lockedRowsRes = await tx.query<StockLevelRow>(
            `SELECT * FROM stock_levels
             WHERE sku_id = $1
             ORDER BY warehouse_id ASC
             FOR UPDATE`,
            [item.skuId],
          );

          const activeCandidates = lockedRowsRes.rows
            .filter((row) => warehouseById.has(row.warehouse_id))
            .map((row) => ({
              row,
              warehouse: warehouseById.get(row.warehouse_id)!,
            }));

          const totalAvail = activeCandidates.reduce(
            (sum, entry) => sum + Number(entry.row.available_qty),
            0,
          );

          if (totalAvail < item.qty) {
            shortages.push({
              skuId: item.skuId,
              requestedQty: item.qty,
              availableQty: totalAvail,
            });
            continue;
          }

          // Order candidate warehouses: preferred first, then highest available, then priority ASC
          activeCandidates.sort((a, b) => {
            if (preferredCode) {
              const aPref = a.warehouse.code.toUpperCase() === preferredCode ? 0 : 1;
              const bPref = b.warehouse.code.toUpperCase() === preferredCode ? 0 : 1;
              if (aPref !== bPref) return aPref - bPref;
            }
            const availDiff = Number(b.row.available_qty) - Number(a.row.available_qty);
            if (availDiff !== 0) return availDiff;
            return a.warehouse.priority - b.warehouse.priority;
          });

          // Prefer single warehouse allocation when possible; otherwise split across active warehouses
          const singleFit = activeCandidates.find(
            (entry) => Number(entry.row.available_qty) >= item.qty,
          );
          const plan: Array<{ warehouseId: string; warehouseCode: string; takeQty: number }> = [];

          if (singleFit) {
            plan.push({
              warehouseId: singleFit.warehouse.id,
              warehouseCode: singleFit.warehouse.code,
              takeQty: item.qty,
            });
          } else {
            let remaining = item.qty;
            for (const entry of activeCandidates) {
              const avail = Number(entry.row.available_qty);
              if (avail <= 0 || remaining <= 0) continue;
              const takeQty = Math.min(avail, remaining);
              plan.push({
                warehouseId: entry.warehouse.id,
                warehouseCode: entry.warehouse.code,
                takeQty,
              });
              remaining -= takeQty;
            }
          }

          let remainingTotalAfter = totalAvail;
          const safetyThreshold = Number(activeCandidates[0]?.row.safety_threshold ?? 3);

          for (const step of plan) {
            const updated = await tx.query<{
              available_qty: number;
              reserved_qty: number;
              version: number;
            }>(
              `UPDATE stock_levels
               SET available_qty = available_qty - $1,
                   reserved_qty = reserved_qty + $1,
                   version = version + 1,
                   updated_at = NOW()
               WHERE sku_id = $2
                 AND warehouse_id = $3
                 AND available_qty >= $1
               RETURNING available_qty, reserved_qty, version`,
              [step.takeQty, item.skuId, step.warehouseId],
            );

            if (updated.rows.length === 0) {
              shortages.push({
                skuId: item.skuId,
                requestedQty: item.qty,
                availableQty: Math.max(0, totalAvail),
              });
              break;
            }

            const newAvail = Number(updated.rows[0].available_qty);
            const newResv = Number(updated.rows[0].reserved_qty);
            remainingTotalAfter -= step.takeQty;

            allocatedLines.push({
              skuId: item.skuId,
              qty: step.takeQty,
              warehouseId: step.warehouseId,
              warehouseCode: step.warehouseCode,
              newAvailable: newAvail,
              newReserved: newResv,
            });
          }

          if (remainingTotalAfter <= safetyThreshold) {
            availabilityAlerts.push({
              skuId: item.skuId,
              totalAvailable: Math.max(0, remainingTotalAfter),
              safetyThreshold,
            });
          }
        }

        if (shortages.length > 0) {
          throw new InsufficientStockAbortError(shortages);
        }

        const reservationId = crypto.randomUUID();
        const expiresAtDate = new Date(Date.now() + input.ttlSeconds * 1000);
        const expiresAtIso = expiresAtDate.toISOString();

        await tx.query(
          `INSERT INTO stock_reservations (
            id, idempotency_key, reservation_type, reference_id, status, expires_at, created_at
          ) VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
          [
            reservationId,
            input.idempotencyKey,
            input.reservationType,
            input.referenceId,
            ReservationStatus.ACTIVE,
            expiresAtIso,
          ],
        );

        const responseItems: ReservedStockLine[] = [];

        for (const line of allocatedLines) {
          await tx.query(
            `INSERT INTO stock_reservation_items (id, reservation_id, sku_id, warehouse_id, qty)
             VALUES ($1, $2, $3, $4, $5)`,
            [crypto.randomUUID(), reservationId, line.skuId, line.warehouseId, line.qty],
          );

          await tx.query(
            `INSERT INTO inventory_ledger (
              id, sku_id, warehouse_id, delta_available, delta_reserved, delta_committed,
              balance_available_after, reason, reference_id, note, created_at
            ) VALUES ($1, $2, $3, $4, $5, 0, $6, $7, $8, $9, NOW())`,
            [
              crypto.randomUUID(),
              line.skuId,
              line.warehouseId,
              -line.qty,
              line.qty,
              line.newAvailable,
              InventoryLedgerReason.RESERVE,
              input.referenceId,
              `Giữ chỗ tồn kho (${input.reservationType}) tại ${line.warehouseCode}`,
            ],
          );

          responseItems.push({
            skuId: line.skuId,
            qty: line.qty,
            warehouseId: line.warehouseId,
            warehouseCode: line.warehouseCode,
          });
        }

        const outboxEntries: Array<{
          id: string;
          eventName: string;
          payload: Record<string, unknown>;
        }> = [];

        const reservedEnvelope = createEventEnvelope({
          eventName: EVENT_NAMES.INVENTORY_STOCK_RESERVED,
          producer: SERVICE_NAME,
          correlationId,
          idempotencyKey: `reserve:${reservationId}`,
          payload: {
            reservationId,
            orderId: input.referenceId,
            warehouseId: responseItems[0]?.warehouseId ?? 'MULTI',
            reservedItems: responseItems.map((i) => ({ skuCode: i.skuId, quantity: i.qty })),
            expiresAt: expiresAtIso,
          },
        });
        const reservedOutboxId = crypto.randomUUID();
        await tx.query(
          `INSERT INTO outbox_events (id, event_name, payload_jsonb, published, created_at)
           VALUES ($1, $2, $3::jsonb, FALSE, NOW())`,
          [reservedOutboxId, EVENT_NAMES.INVENTORY_STOCK_RESERVED, JSON.stringify(reservedEnvelope)],
        );
        outboxEntries.push({
          id: reservedOutboxId,
          eventName: EVENT_NAMES.INVENTORY_STOCK_RESERVED,
          payload: reservedEnvelope as unknown as Record<string, unknown>,
        });

        for (const alert of availabilityAlerts) {
          const outboxId = crypto.randomUUID();
          const availPayload = {
            eventId: crypto.randomUUID(),
            eventName: 'inventory.availability.changed',
            occurredAt: new Date().toISOString(),
            correlationId,
            producer: SERVICE_NAME,
            payload: {
              skuId: alert.skuId,
              availableQty: alert.totalAvailable,
              safetyThreshold: alert.safetyThreshold,
              inStock: alert.totalAvailable > 0,
              lowStockWarning:
                alert.totalAvailable >= 1 && alert.totalAvailable <= alert.safetyThreshold,
            },
          };
          await tx.query(
            `INSERT INTO outbox_events (id, event_name, payload_jsonb, published, created_at)
             VALUES ($1, $2, $3::jsonb, FALSE, NOW())`,
            [outboxId, 'inventory.availability.changed', JSON.stringify(availPayload)],
          );
          outboxEntries.push({
            id: outboxId,
            eventName: 'inventory.availability.changed',
            payload: availPayload,
          });
        }

        return {
          isReplay: false,
          outboxEntries,
          availabilityAlerts,
          response: {
            reservationId,
            referenceId: input.referenceId,
            status: ReservationStatus.ACTIVE,
            expiresAt: expiresAtIso,
            idempotentReplay: false,
            items: responseItems,
          } satisfies ReserveStockResponse,
        };
      });

      if (txResult.isReplay && redisDecremented) {
        await this.redis.atomicRelease(sortedItems);
      }

      if (!txResult.isReplay) {
        void this.publishOutboxEntries(txResult.outboxEntries);
        if (txResult.availabilityAlerts.length > 0) {
          void this.notifyCatalogAvailabilityChanged(txResult.availabilityAlerts, correlationId);
        }
      }

      return txResult.response;
    } catch (error) {
      if (redisDecremented) {
        await this.redis.atomicRelease(sortedItems);
        await this.resyncRedisCountersFromDb(sortedItems.map((i) => i.skuId));
      }

      if (error instanceof InsufficientStockAbortError) {
        throw new ApiDomainException(
          HttpStatus.CONFLICT,
          ErrorCode.INSUFFICIENT_STOCK,
          'Không đủ tồn kho khả dụng để giữ chỗ toàn bộ giỏ hàng.',
          {
            insufficientSkus: error.insufficientSkus,
          },
        );
      }

      // Handle rare concurrent unique constraint race on idempotency_key cleanly
      const pgErrCode = (error as { code?: string } | null)?.code;
      if (pgErrCode === '23505') {
        const replay = await this.findReservationByIdempotencyKey(input.idempotencyKey);
        if (replay) {
          return replay;
        }
      }

      throw error;
    }
  }

  async commitReservation(
    referenceIdOrId: string,
    _body?: CommitReservationRequest,
  ): Promise<ReserveStockResponse> {
    return this.db.transaction(async (tx) => {
      const resRowQuery = await tx.query<ReservationRow>(
        `SELECT * FROM stock_reservations
         WHERE reference_id = $1 OR id::text = $1
         ORDER BY created_at DESC
         LIMIT 1
         FOR UPDATE`,
        [referenceIdOrId],
      );

      if (resRowQuery.rows.length === 0) {
        throw new ApiDomainException(
          HttpStatus.NOT_FOUND,
          ErrorCode.RESERVATION_NOT_FOUND,
          `Không tìm thấy phiên giữ chỗ tồn kho cho mã "${referenceIdOrId}".`,
        );
      }

      const reservation = resRowQuery.rows[0];
      const items = await this.loadReservationItems(reservation.id, tx);

      if (reservation.status === ReservationStatus.COMMITTED) {
        return {
          reservationId: reservation.id,
          referenceId: reservation.reference_id,
          status: ReservationStatus.COMMITTED,
          expiresAt: toIso(reservation.expires_at),
          idempotentReplay: true,
          items,
        };
      }

      if (reservation.status !== ReservationStatus.ACTIVE) {
        throw new ApiDomainException(
          HttpStatus.CONFLICT,
          ErrorCode.CONFLICT,
          `Phiên giữ chỗ đang ở trạng thái ${reservation.status}, không thể xác nhận trừ kho.`,
        );
      }

      const sortedLines = [...items].sort((a, b) =>
        a.skuId.localeCompare(b.skuId) || a.warehouseId.localeCompare(b.warehouseId),
      );

      for (const line of sortedLines) {
        const updated = await tx.query<{ available_qty: number }>(
          `UPDATE stock_levels
           SET reserved_qty = GREATEST(0, reserved_qty - $1),
               committed_qty = committed_qty + $1,
               version = version + 1,
               updated_at = NOW()
           WHERE sku_id = $2 AND warehouse_id = $3
           RETURNING available_qty`,
          [line.qty, line.skuId, line.warehouseId],
        );

        const availAfter = Number(updated.rows[0]?.available_qty ?? 0);
        await tx.query(
          `INSERT INTO inventory_ledger (
            id, sku_id, warehouse_id, delta_available, delta_reserved, delta_committed,
            balance_available_after, reason, reference_id, note, created_at
          ) VALUES ($1, $2, $3, 0, $4, $5, $6, $7, $8, $9, NOW())`,
          [
            crypto.randomUUID(),
            line.skuId,
            line.warehouseId,
            -line.qty,
            line.qty,
            availAfter,
            InventoryLedgerReason.COMMIT,
            reservation.reference_id,
            `Xác nhận trừ kho chính thức tại ${line.warehouseCode}`,
          ],
        );
      }

      await tx.query(
        `UPDATE stock_reservations
         SET status = $1, committed_at = NOW()
         WHERE id = $2`,
        [ReservationStatus.COMMITTED, reservation.id],
      );

      return {
        reservationId: reservation.id,
        referenceId: reservation.reference_id,
        status: ReservationStatus.COMMITTED,
        expiresAt: toIso(reservation.expires_at),
        idempotentReplay: false,
        items,
      };
    });
  }

  async releaseReservation(
    referenceIdOrId: string,
    body?: ReleaseReservationRequest,
    correlationId: string = crypto.randomUUID(),
  ): Promise<ReserveStockResponse> {
    const ledgerReason: InventoryLedgerReasonValue =
      body?.reason ?? InventoryLedgerReason.CANCEL_RELEASE;

    const txOutcome = await this.db.transaction(async (tx) => {
      const resRowQuery = await tx.query<ReservationRow>(
        `SELECT * FROM stock_reservations
         WHERE reference_id = $1 OR id::text = $1
         ORDER BY created_at DESC
         LIMIT 1
         FOR UPDATE`,
        [referenceIdOrId],
      );

      if (resRowQuery.rows.length === 0) {
        throw new ApiDomainException(
          HttpStatus.NOT_FOUND,
          ErrorCode.RESERVATION_NOT_FOUND,
          `Không tìm thấy phiên giữ chỗ tồn kho cho mã "${referenceIdOrId}".`,
        );
      }

      const reservation = resRowQuery.rows[0];
      const items = await this.loadReservationItems(reservation.id, tx);

      if (
        reservation.status === ReservationStatus.RELEASED ||
        reservation.status === ReservationStatus.EXPIRED
      ) {
        return {
          alreadyReleased: true,
          restoredBySku: [] as Array<{ skuId: string; qty: number }>,
          response: {
            reservationId: reservation.id,
            referenceId: reservation.reference_id,
            status: reservation.status,
            expiresAt: toIso(reservation.expires_at),
            idempotentReplay: true,
            items,
          } satisfies ReserveStockResponse,
        };
      }

      if (reservation.status === ReservationStatus.COMMITTED) {
        throw new ApiDomainException(
          HttpStatus.CONFLICT,
          ErrorCode.CONFLICT,
          'Phiên giữ chỗ đã xác nhận trừ kho (COMMITTED), không thể giải phóng.',
        );
      }

      const sortedLines = [...items].sort((a, b) =>
        a.skuId.localeCompare(b.skuId) || a.warehouseId.localeCompare(b.warehouseId),
      );
      const restoredMap = new Map<string, number>();

      for (const line of sortedLines) {
        const updated = await tx.query<{ available_qty: number }>(
          `UPDATE stock_levels
           SET available_qty = available_qty + $1,
               reserved_qty = GREATEST(0, reserved_qty - $1),
               version = version + 1,
               updated_at = NOW()
           WHERE sku_id = $2 AND warehouse_id = $3
           RETURNING available_qty`,
          [line.qty, line.skuId, line.warehouseId],
        );

        const newAvail = Number(updated.rows[0]?.available_qty ?? line.qty);
        restoredMap.set(line.skuId, (restoredMap.get(line.skuId) ?? 0) + line.qty);

        await tx.query(
          `INSERT INTO inventory_ledger (
            id, sku_id, warehouse_id, delta_available, delta_reserved, delta_committed,
            balance_available_after, reason, reference_id, note, created_at
          ) VALUES ($1, $2, $3, $4, $5, 0, $6, $7, $8, $9, NOW())`,
          [
            crypto.randomUUID(),
            line.skuId,
            line.warehouseId,
            line.qty,
            -line.qty,
            newAvail,
            ledgerReason,
            reservation.reference_id,
            `Hoàn trả tồn kho giữ chỗ (${ledgerReason}) tại ${line.warehouseCode}`,
          ],
        );
      }

      await tx.query(
        `UPDATE stock_reservations
         SET status = $1, released_at = NOW()
         WHERE id = $2`,
        [ReservationStatus.RELEASED, reservation.id],
      );

      const restoredBySku = [...restoredMap.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([skuId, qty]) => ({ skuId, qty }));

      await tx.query(
        `INSERT INTO outbox_events (id, event_name, payload_jsonb, published, created_at)
         VALUES ($1, 'inventory.availability.changed', $2::jsonb, FALSE, NOW())`,
        [
          crypto.randomUUID(),
          JSON.stringify({
            eventId: crypto.randomUUID(),
            eventName: 'inventory.availability.changed',
            occurredAt: new Date().toISOString(),
            correlationId,
            producer: SERVICE_NAME,
            payload: {
              reason: ledgerReason,
              referenceId: reservation.reference_id,
              restoredBySku,
            },
          }),
        ],
      );

      return {
        alreadyReleased: false,
        restoredBySku,
        response: {
          reservationId: reservation.id,
          referenceId: reservation.reference_id,
          status: ReservationStatus.RELEASED,
          expiresAt: toIso(reservation.expires_at),
          idempotentReplay: false,
          items,
        } satisfies ReserveStockResponse,
      };
    });

    if (!txOutcome.alreadyReleased && txOutcome.restoredBySku.length > 0) {
      const ok = await this.redis.atomicRelease(txOutcome.restoredBySku);
      if (!ok) {
        await this.resyncRedisCountersFromDb(txOutcome.restoredBySku.map((i) => i.skuId));
      }
      void this.rabbitmq.publishDomainEvent('inventory.availability.changed', {
        eventName: 'inventory.availability.changed',
        correlationId,
        referenceId: txOutcome.response.referenceId,
        restoredBySku: txOutcome.restoredBySku,
      });
    }

    return txOutcome.response;
  }

  async runExpireSweep(correlationId: string = crypto.randomUUID()): Promise<ExpireSweepResult> {
    if (!this.db.isReady() || this.expireSweepInFlight) {
      return {
        expiredCount: 0,
        expiredReservationIds: [],
        expiredReferenceIds: [],
        restoredSkus: [],
      };
    }

    this.expireSweepInFlight = true;
    const expiredReservationIds: string[] = [];
    const expiredReferenceIds: string[] = [];
    const restoredTotalsBySku = new Map<string, number>();

    try {
      const candidates = await this.db.query<{ id: string; reference_id: string }>(
        `SELECT id, reference_id
         FROM stock_reservations
         WHERE status = 'ACTIVE' AND expires_at <= NOW()
         ORDER BY expires_at ASC
         LIMIT 100`,
      );

      for (const candidate of candidates.rows) {
        const expiredLines = await this.db.transaction(async (tx) => {
          const locked = await tx.query<ReservationRow>(
            `SELECT * FROM stock_reservations
             WHERE id = $1 AND status = 'ACTIVE' AND expires_at <= NOW()
             FOR UPDATE`,
            [candidate.id],
          );
          if (locked.rows.length === 0) {
            return null;
          }

          const items = await this.loadReservationItems(candidate.id, tx);
          const sortedLines = [...items].sort((a, b) =>
            a.skuId.localeCompare(b.skuId) || a.warehouseId.localeCompare(b.warehouseId),
          );

          for (const line of sortedLines) {
            const updated = await tx.query<{ available_qty: number }>(
              `UPDATE stock_levels
               SET available_qty = available_qty + $1,
                   reserved_qty = GREATEST(0, reserved_qty - $1),
                   version = version + 1,
                   updated_at = NOW()
               WHERE sku_id = $2 AND warehouse_id = $3
               RETURNING available_qty`,
              [line.qty, line.skuId, line.warehouseId],
            );

            const newAvail = Number(updated.rows[0]?.available_qty ?? line.qty);
            await tx.query(
              `INSERT INTO inventory_ledger (
                id, sku_id, warehouse_id, delta_available, delta_reserved, delta_committed,
                balance_available_after, reason, reference_id, note, created_at
              ) VALUES ($1, $2, $3, $4, $5, 0, $6, $7, $8, $9, NOW())`,
              [
                crypto.randomUUID(),
                line.skuId,
                line.warehouseId,
                line.qty,
                -line.qty,
                newAvail,
                InventoryLedgerReason.RELEASE_EXPIRED,
                candidate.reference_id,
                `Tự động nhả giữ chỗ quá hạn 15 phút tại ${line.warehouseCode}`,
              ],
            );
          }

          await tx.query(
            `UPDATE stock_reservations
             SET status = $1, released_at = NOW()
             WHERE id = $2`,
            [ReservationStatus.EXPIRED, candidate.id],
          );

          await tx.query(
            `INSERT INTO outbox_events (id, event_name, payload_jsonb, published, created_at)
             VALUES ($1, 'inventory.availability.changed', $2::jsonb, FALSE, NOW())`,
            [
              crypto.randomUUID(),
              JSON.stringify({
                eventId: crypto.randomUUID(),
                eventName: 'inventory.availability.changed',
                occurredAt: new Date().toISOString(),
                correlationId,
                producer: SERVICE_NAME,
                payload: {
                  reason: InventoryLedgerReason.RELEASE_EXPIRED,
                  reservationId: candidate.id,
                  referenceId: candidate.reference_id,
                  items: sortedLines,
                },
              }),
            ],
          );

          return sortedLines;
        });

        if (expiredLines) {
          expiredReservationIds.push(candidate.id);
          expiredReferenceIds.push(candidate.reference_id);

          const skuAgg = new Map<string, number>();
          for (const line of expiredLines) {
            skuAgg.set(line.skuId, (skuAgg.get(line.skuId) ?? 0) + line.qty);
            restoredTotalsBySku.set(
              line.skuId,
              (restoredTotalsBySku.get(line.skuId) ?? 0) + line.qty,
            );
          }

          const releaseBatch = [...skuAgg.entries()]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([skuId, qty]) => ({ skuId, qty }));
          const releasedRedis = await this.redis.atomicRelease(releaseBatch);
          if (!releasedRedis) {
            await this.resyncRedisCountersFromDb(releaseBatch.map((item) => item.skuId));
          }
        }
      }

      const affectedSkuIds = [...restoredTotalsBySku.keys()];
      const currentTotals = await this.fetchDbAvailableTotals(affectedSkuIds);
      const restoredSkus = affectedSkuIds.map((skuId) => ({
        skuId,
        restoredQty: restoredTotalsBySku.get(skuId) ?? 0,
        newAvailableQty: currentTotals.get(skuId) ?? 0,
      }));

      if (restoredSkus.length > 0) {
        const eventPayload = {
          eventId: crypto.randomUUID(),
          eventName: 'inventory.availability.changed',
          occurredAt: new Date().toISOString(),
          correlationId,
          producer: SERVICE_NAME,
          payload: {
            reason: InventoryLedgerReason.RELEASE_EXPIRED,
            expiredReservationIds,
            restoredSkus,
          },
        };
        void this.rabbitmq.publishDomainEvent('inventory.availability.changed', eventPayload);
        void this.notifyCatalogAvailabilityChanged(
          restoredSkus.map((r) => ({
            skuId: r.skuId,
            totalAvailable: r.newAvailableQty,
            safetyThreshold: 3,
          })),
          correlationId,
        );
      }

      return {
        expiredCount: expiredReservationIds.length,
        expiredReservationIds,
        expiredReferenceIds,
        restoredSkus,
      };
    } finally {
      this.expireSweepInFlight = false;
    }
  }

  async testSetStock(input: TestSetStockInput): Promise<{
    skuId: string;
    availableQty: number;
    reservedQty: number;
    redisSyncedQty: number;
  }> {
    this.assertNonProductionTestHelper();

    if (!UUID_REGEX.test(input.skuId)) {
      throw new ApiDomainException(
        HttpStatus.BAD_REQUEST,
        ErrorCode.VALIDATION_ERROR,
        'skuId phải là UUID hợp lệ.',
      );
    }

    const reservedQty = input.reservedQty ?? 0;
    const committedQty = input.committedQty ?? 0;

    const totalAvail = await this.db.transaction(async (tx) => {
      const targetCode = (input.warehouseCode?.trim() || 'HN_ATELIER').toUpperCase();
      const whRes = await tx.query<WarehouseRow>(
        'SELECT * FROM warehouses WHERE UPPER(code) = $1 LIMIT 1',
        [targetCode],
      );
      if (whRes.rows.length === 0) {
        throw new ApiDomainException(
          HttpStatus.NOT_FOUND,
          ErrorCode.NOT_FOUND,
          `Không tìm thấy kho ${targetCode}.`,
        );
      }
      const targetWh = whRes.rows[0];

      const existingRows = await tx.query<StockLevelRow>(
        'SELECT * FROM stock_levels WHERE sku_id = $1 FOR UPDATE',
        [input.skuId],
      );
      const productId = input.productId ?? existingRows.rows[0]?.product_id ?? input.skuId;
      const skuCode = existingRows.rows[0]?.sku_code ?? null;

      if (!input.warehouseCode) {
        // Zero out other warehouses so total across warehouses matches exact requested test stock
        await tx.query(
          `UPDATE stock_levels
           SET available_qty = 0,
               reserved_qty = 0,
               version = version + 1,
               updated_at = NOW()
           WHERE sku_id = $1 AND warehouse_id <> $2`,
          [input.skuId, targetWh.id],
        );
      }

      await tx.query(
        `INSERT INTO stock_levels (
          sku_id, warehouse_id, product_id, sku_code,
          available_qty, reserved_qty, committed_qty, damaged_qty,
          safety_threshold, version, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, 0, 3, 1, NOW())
        ON CONFLICT (sku_id, warehouse_id) DO UPDATE SET
          available_qty = EXCLUDED.available_qty,
          reserved_qty = EXCLUDED.reserved_qty,
          committed_qty = EXCLUDED.committed_qty,
          version = stock_levels.version + 1,
          updated_at = NOW()`,
        [input.skuId, targetWh.id, productId, skuCode, input.availableQty, reservedQty, committedQty],
      );

      await tx.query(
        `INSERT INTO inventory_ledger (
          id, sku_id, warehouse_id, delta_available, delta_reserved, delta_committed,
          balance_available_after, reason, reference_id, note, created_at
        ) VALUES ($1, $2, $3, 0, 0, 0, $4, $5, $6, $7, NOW())`,
        [
          crypto.randomUUID(),
          input.skuId,
          targetWh.id,
          input.availableQty,
          InventoryLedgerReason.ADJUSTMENT,
          'TEST_SET_STOCK',
          `Điều chỉnh tồn kho kiểm thử (available=${input.availableQty}, reserved=${reservedQty})`,
        ],
      );

      const sumRes = await tx.query<{ total_avail: number | string }>(
        'SELECT COALESCE(SUM(available_qty), 0)::int AS total_avail FROM stock_levels WHERE sku_id = $1',
        [input.skuId],
      );
      return Number(sumRes.rows[0]?.total_avail ?? input.availableQty);
    });

    await this.redis.setStockAvailable(input.skuId, totalAvail);

    return {
      skuId: input.skuId,
      availableQty: totalAvail,
      reservedQty,
      redisSyncedQty: totalAvail,
    };
  }

  async testExpireReservation(params: {
    referenceId?: string;
    reservationId?: string;
  }): Promise<{
    updatedCount: number;
    reservationId: string;
    referenceId: string;
    expiresAt: string;
  }> {
    this.assertNonProductionTestHelper();
    const lookupKey = params.referenceId?.trim() || params.reservationId?.trim();
    if (!lookupKey) {
      throw new ApiDomainException(
        HttpStatus.BAD_REQUEST,
        ErrorCode.VALIDATION_ERROR,
        'Cần cung cấp referenceId hoặc reservationId.',
      );
    }

    const updated = await this.db.query<ReservationRow>(
      `UPDATE stock_reservations
       SET expires_at = NOW() - INTERVAL '1 minute'
       WHERE (reference_id = $1 OR id::text = $1)
         AND status = 'ACTIVE'
       RETURNING *`,
      [lookupKey],
    );

    if (updated.rows.length === 0) {
      throw new ApiDomainException(
        HttpStatus.NOT_FOUND,
        ErrorCode.RESERVATION_NOT_FOUND,
        `Không tìm thấy phiên giữ chỗ ACTIVE cho "${lookupKey}".`,
      );
    }

    return {
      updatedCount: updated.rows.length,
      reservationId: updated.rows[0].id,
      referenceId: updated.rows[0].reference_id,
      expiresAt: toIso(updated.rows[0].expires_at),
    };
  }

  async listAdminWarehouses(): Promise<WarehouseAdminViewDto[]> {
    const res = await this.db.query<
      WarehouseRow & {
        total_available: number | string;
        total_reserved: number | string;
        total_committed: number | string;
      }
    >(
      `SELECT w.*,
              COALESCE(SUM(sl.available_qty), 0)::int AS total_available,
              COALESCE(SUM(sl.reserved_qty), 0)::int AS total_reserved,
              COALESCE(SUM(sl.committed_qty), 0)::int AS total_committed
       FROM warehouses w
       LEFT JOIN stock_levels sl ON sl.warehouse_id = w.id
       GROUP BY w.id
       ORDER BY w.priority ASC, w.code ASC`,
    );

    return res.rows.map((row) => ({
      id: row.id,
      code: row.code,
      name: row.name,
      warehouseType: row.type,
      provinceCode: row.province_code,
      city: row.city || row.province_code,
      address: row.address,
      supports2hDelivery: Boolean(row.supports_2h_delivery),
      isActive: Boolean(row.is_active),
      priority: Number(row.priority),
      createdAt: toIso(row.created_at),
      totalAvailableQty: Number(row.total_available),
      totalReservedQty: Number(row.total_reserved),
      totalCommittedQty: Number(row.total_committed),
    }));
  }

  async listAdminStockLevels(query: {
    warehouseCode?: string;
    lowStockOnly?: boolean;
    outOfStockOnly?: boolean;
    q?: string;
    limit?: number;
  }): Promise<StockLevelAdminExtendedDto[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (query.warehouseCode && query.warehouseCode.trim()) {
      params.push(query.warehouseCode.trim().toUpperCase());
      conditions.push(`UPPER(w.code) = $${params.length}`);
    }

    if (query.lowStockOnly) {
      conditions.push('sl.available_qty >= 1 AND sl.available_qty <= sl.safety_threshold');
    }

    if (query.outOfStockOnly) {
      conditions.push('sl.available_qty = 0');
    }

    if (query.q && query.q.trim()) {
      params.push(`%${query.q.trim()}%`);
      const p = `$${params.length}`;
      conditions.push(
        `(COALESCE(sl.sku_code, '') ILIKE ${p} OR sl.sku_id::text ILIKE ${p} OR sl.product_id::text ILIKE ${p} OR w.code ILIKE ${p} OR w.name ILIKE ${p})`,
      );
    }

    const limit = Math.min(Math.max(Number(query.limit ?? 250) || 250, 1), 500);
    params.push(limit);

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const res = await this.db.query<StockLevelJoinedRow>(
      `SELECT sl.*,
              w.code AS warehouse_code,
              w.name AS warehouse_name,
              w.type AS warehouse_type,
              w.priority AS warehouse_priority
       FROM stock_levels sl
       INNER JOIN warehouses w ON w.id = sl.warehouse_id
       ${whereClause}
       ORDER BY sl.available_qty ASC, w.priority ASC, COALESCE(sl.sku_code, sl.sku_id::text) ASC
       LIMIT $${params.length}`,
      params,
    );

    return res.rows.map((row) => {
      const avail = Number(row.available_qty);
      const threshold = Number(row.safety_threshold);
      return {
        id: `${row.sku_id}:${row.warehouse_id}`,
        skuId: row.sku_id,
        ...(row.sku_code ? { skuCode: row.sku_code } : {}),
        productId: row.product_id,
        warehouseId: row.warehouse_id,
        warehouseCode: row.warehouse_code,
        warehouseName: row.warehouse_name,
        availableQty: avail,
        reservedQty: Number(row.reserved_qty),
        committedQty: Number(row.committed_qty),
        damagedQty: Number(row.damaged_qty ?? 0),
        safetyThreshold: threshold,
        lowStockWarning: avail >= 1 && avail <= threshold,
        updatedAt: toIso(row.updated_at),
      };
    });
  }

  async rmaRestock(
    input: RmaRestockInput,
    correlationId: string = crypto.randomUUID(),
    traceparent?: string,
  ): Promise<RmaRestockResult> {
    if (!UUID_REGEX.test(input.skuId)) {
      throw new ApiDomainException(
        HttpStatus.BAD_REQUEST,
        ErrorCode.VALIDATION_ERROR,
        'skuId phải là UUID hợp lệ.',
      );
    }

    const txResult = await this.db.transaction(async (tx) => {
      const requestedCode = (input.warehouseCode?.trim() || 'HN_ATELIER').toUpperCase();
      const whRes = await tx.query<WarehouseRow>(
        'SELECT * FROM warehouses WHERE UPPER(code) = $1 OR is_active = TRUE ORDER BY CASE WHEN UPPER(code) = $1 THEN 0 ELSE 1 END, priority ASC LIMIT 1',
        [requestedCode],
      );
      if (whRes.rows.length === 0) {
        throw new ApiDomainException(
          HttpStatus.NOT_FOUND,
          ErrorCode.NOT_FOUND,
          'Không tìm thấy kho hợp lệ để hoàn nhập RMA.',
        );
      }
      const wh = whRes.rows[0];

      const existing = await tx.query<StockLevelRow>(
        'SELECT * FROM stock_levels WHERE sku_id = $1 AND warehouse_id = $2 FOR UPDATE',
        [input.skuId, wh.id],
      );
      const anySku =
        existing.rows[0] ??
        (
          await tx.query<StockLevelRow>(
            'SELECT * FROM stock_levels WHERE sku_id = $1 LIMIT 1',
            [input.skuId],
          )
        ).rows[0];

      const productId = anySku?.product_id ?? input.skuId;
      const skuCode = anySku?.sku_code ?? null;
      const addAvailable = input.restockable ? input.qty : 0;
      const addDamaged = input.restockable ? 0 : input.qty;

      const updated = await tx.query<{ available_qty: number; damaged_qty: number }>(
        `INSERT INTO stock_levels (
          sku_id, warehouse_id, product_id, sku_code,
          available_qty, reserved_qty, committed_qty, damaged_qty,
          safety_threshold, version, updated_at
        ) VALUES ($1, $2, $3, $4, $5, 0, 0, $6, 3, 1, NOW())
        ON CONFLICT (sku_id, warehouse_id) DO UPDATE SET
          available_qty = stock_levels.available_qty + EXCLUDED.available_qty,
          damaged_qty = stock_levels.damaged_qty + EXCLUDED.damaged_qty,
          version = stock_levels.version + 1,
          updated_at = NOW()
        RETURNING available_qty, damaged_qty`,
        [input.skuId, wh.id, productId, skuCode, addAvailable, addDamaged],
      );

      const newAvail = Number(updated.rows[0]?.available_qty ?? addAvailable);
      const newDamaged = Number(updated.rows[0]?.damaged_qty ?? addDamaged);

      await tx.query(
        `INSERT INTO inventory_ledger (
          id, sku_id, warehouse_id, delta_available, delta_reserved, delta_committed,
          balance_available_after, reason, reference_id, note, created_at
        ) VALUES ($1, $2, $3, $4, 0, 0, $5, $6, $7, $8, NOW())`,
        [
          crypto.randomUUID(),
          input.skuId,
          wh.id,
          addAvailable,
          newAvail,
          input.restockable
            ? InventoryLedgerReason.RMA_RESTOCK
            : InventoryLedgerReason.ADJUSTMENT,
          input.referenceId ?? 'RMA_RESTOCK',
          input.note ??
            (input.restockable
              ? `Hoàn nhập kho tái bán từ RMA (+${input.qty}) tại ${wh.code}`
              : `Ghi nhận hàng RMA lỗi/hỏng (+${input.qty} damaged) tại ${wh.code}`),
        ],
      );

      return {
        skuId: input.skuId,
        productId,
        skuCode: skuCode ?? input.skuId.slice(0, 12).toUpperCase(),
        warehouseId: wh.id,
        warehouseCode: wh.code,
        qty: input.qty,
        restockable: input.restockable,
        availableQty: newAvail,
        damagedQty: newDamaged,
      };
    });

    if (input.restockable) {
      const synced = await this.resyncRedisCountersFromDb([input.skuId]);
      const totalAvail = synced.get(input.skuId) ?? txResult.availableQty;
      if (this.config.catalogServiceUrl) {
        void fetch(`${this.config.catalogServiceUrl}/v1/catalog/internal/stock-replenished`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-internal-secret': this.config.internalServiceSecret,
            'X-Correlation-Id': correlationId,
            traceparent: createChildTraceparent(traceparent),
          },
          body: JSON.stringify({
            skuIds: [input.skuId],
            productIds: [txResult.productId],
            items: [
              {
                skuId: input.skuId,
                skuCode: txResult.skuCode,
                productId: txResult.productId,
                availableQty: totalAvail,
              },
            ],
          }),
        }).catch(() => undefined);
      }
    }

    return {
      skuId: txResult.skuId,
      warehouseId: txResult.warehouseId,
      warehouseCode: txResult.warehouseCode,
      qty: txResult.qty,
      restockable: txResult.restockable,
      availableQty: txResult.availableQty,
      damagedQty: txResult.damagedQty,
    };
  }

  /**
   * Idempotently inserts missing stock_levels across HN_ATELIER, HCM_SHOWROOM, CENTRAL_WH
   * for newly added catalog SKUs without ever overwriting existing rows.
   */
  async syncCatalogSkus(skus: SyncCatalogSkuItem[]): Promise<SyncCatalogSkusResult> {
    const insertedForRedis: Array<{ skuId: string; totalAvail: number }> = [];
    let insertedSkuCount = 0;
    let skippedExistingCount = 0;

    const totalDistinctSkus = await this.db.transaction(async (tx) => {
      const whRes = await tx.query<{ id: string; code: string }>(
        'SELECT id, code FROM warehouses WHERE is_active = TRUE ORDER BY priority ASC',
      );
      const whByCode = new Map<string, string>();
      for (const row of whRes.rows) {
        whByCode.set(row.code.toUpperCase(), row.id);
      }

      const hnId = whByCode.get('HN_ATELIER') ?? whRes.rows[0]?.id;
      const hcmId = whByCode.get('HCM_SHOWROOM') ?? hnId;
      const centralId = whByCode.get('CENTRAL_WH') ?? hnId;

      if (!hnId) {
        throw new ApiDomainException(
          HttpStatus.INTERNAL_SERVER_ERROR,
          ErrorCode.INTERNAL_ERROR,
          'Chưa có kho hoạt động để đồng bộ tồn kho SKU.',
        );
      }

      const seen = new Set<string>();
      for (const item of skus) {
        const skuId = item.skuId.trim();
        const productId = item.productId.trim();
        if (!UUID_REGEX.test(skuId) || !UUID_REGEX.test(productId) || seen.has(skuId)) {
          continue;
        }
        seen.add(skuId);

        const existing = await tx.query<{ cnt: string | number }>(
          'SELECT COUNT(*)::int AS cnt FROM stock_levels WHERE sku_id = $1',
          [skuId],
        );
        if (Number(existing.rows[0]?.cnt ?? 0) > 0) {
          skippedExistingCount += 1;
          continue;
        }

        const skuCode = item.skuCode?.trim() || skuId.slice(0, 12).toUpperCase();
        const isFlagshipLowM = FLAGSHIP_LOW_STOCK_M_CODES.has(skuCode.toUpperCase());

        let placements: Array<{ warehouseId: string; code: string; qty: number }>;
        let safetyThreshold: number;
        let totalAvail: number;

        if (isFlagshipLowM) {
          safetyThreshold = 10;
          totalAvail = 2;
          placements = [
            { warehouseId: hnId, code: 'HN_ATELIER', qty: 2 },
            ...(centralId && centralId !== hnId
              ? [{ warehouseId: centralId, code: 'CENTRAL_WH', qty: 0 }]
              : []),
          ];
        } else {
          const targetQty = Math.max(0, Math.floor(item.defaultQty ?? 18));
          safetyThreshold = 5;
          totalAvail = targetQty;
          const hnQty = Math.round(targetQty * 0.45);
          const hcmQty = hcmId && hcmId !== hnId ? Math.round(targetQty * 0.22) : 0;
          const centralQty = Math.max(0, targetQty - hnQty - hcmQty);

          placements = [{ warehouseId: hnId, code: 'HN_ATELIER', qty: hnQty }];
          if (hcmId && hcmId !== hnId) {
            placements.push({ warehouseId: hcmId, code: 'HCM_SHOWROOM', qty: hcmQty });
          }
          if (centralId && centralId !== hnId && centralId !== hcmId) {
            placements.push({ warehouseId: centralId, code: 'CENTRAL_WH', qty: centralQty });
          } else {
            placements[0].qty += centralQty;
          }
        }

        for (const p of placements) {
          await tx.query(
            `INSERT INTO stock_levels (
              sku_id, warehouse_id, product_id, sku_code,
              available_qty, reserved_qty, committed_qty, damaged_qty,
              safety_threshold, version, updated_at
            ) VALUES ($1, $2, $3, $4, $5, 0, 0, 0, $6, 1, NOW())
            ON CONFLICT (sku_id, warehouse_id) DO NOTHING`,
            [skuId, p.warehouseId, productId, skuCode, p.qty, safetyThreshold],
          );

          await tx.query(
            `INSERT INTO inventory_ledger (
              id, sku_id, warehouse_id, delta_available, delta_reserved, delta_committed,
              balance_available_after, reason, reference_id, note, created_at
            ) VALUES ($1, $2, $3, $4, 0, 0, $4, $5, $6, $7, NOW())`,
            [
              crypto.randomUUID(),
              skuId,
              p.warehouseId,
              p.qty,
              InventoryLedgerReason.INITIAL_SEED,
              'SYNC_CATALOG_SKUS',
              `Đồng bộ tồn kho danh mục ${skuCode} tại ${p.code}`,
            ],
          );
        }

        insertedSkuCount += 1;
        insertedForRedis.push({ skuId, totalAvail });
      }

      const distinctRes = await tx.query<{ cnt: string | number }>(
        'SELECT COUNT(DISTINCT sku_id)::int AS cnt FROM stock_levels',
      );
      return Number(distinctRes.rows[0]?.cnt ?? 0);
    });

    for (const entry of insertedForRedis) {
      await this.redis.setStockAvailable(entry.skuId, entry.totalAvail);
    }

    return {
      receivedCount: skus.length,
      insertedSkuCount,
      skippedExistingCount,
      totalDistinctSkus,
    };
  }

  async getOpsSummary(): Promise<InventoryOpsSummaryDto> {
    const [skuAggRes, activeResRes, aiPoRes] = await Promise.all([
      this.db.query<{
        total_skus: string | number;
        low_stock_count: string | number;
        out_of_stock_count: string | number;
        total_available_qty: string | number;
        total_reserved_qty: string | number;
        total_committed_qty: string | number;
        total_damaged_qty: string | number;
      }>(
        `WITH sku_totals AS (
           SELECT sku_id,
                  SUM(available_qty)::int AS avail,
                  SUM(reserved_qty)::int AS resv,
                  SUM(committed_qty)::int AS comm,
                  SUM(damaged_qty)::int AS dmg,
                  MAX(safety_threshold)::int AS threshold
           FROM stock_levels
           GROUP BY sku_id
         )
         SELECT COUNT(*)::int AS total_skus,
                COUNT(*) FILTER (WHERE avail >= 1 AND avail <= threshold)::int AS low_stock_count,
                COUNT(*) FILTER (WHERE avail = 0)::int AS out_of_stock_count,
                COALESCE(SUM(avail), 0)::int AS total_available_qty,
                COALESCE(SUM(resv), 0)::int AS total_reserved_qty,
                COALESCE(SUM(comm), 0)::int AS total_committed_qty,
                COALESCE(SUM(dmg), 0)::int AS total_damaged_qty
         FROM sku_totals`,
      ),
      this.db.query<{ cnt: string | number }>(
        "SELECT COUNT(*)::int AS cnt FROM stock_reservations WHERE status = 'ACTIVE'",
      ),
      this.db.query<{ cnt: string | number }>(
        "SELECT COUNT(*)::int AS cnt FROM purchase_orders WHERE status = 'NHAP_AI'",
      ),
    ]);

    const agg = skuAggRes.rows[0];
    return {
      totalSkus: Number(agg?.total_skus ?? 0),
      lowStockCount: Number(agg?.low_stock_count ?? 0),
      outOfStockCount: Number(agg?.out_of_stock_count ?? 0),
      activeReservationsCount: Number(activeResRes.rows[0]?.cnt ?? 0),
      totalAvailableQty: Number(agg?.total_available_qty ?? 0),
      totalReservedQty: Number(agg?.total_reserved_qty ?? 0),
      totalCommittedQty: Number(agg?.total_committed_qty ?? 0),
      totalDamagedQty: Number(agg?.total_damaged_qty ?? 0),
      pendingAiDraftPosCount: Number(aiPoRes.rows[0]?.cnt ?? 0),
    };
  }

  async listAdminReservations(query: {
    status?: string;
    referenceId?: string;
    limit?: number;
  }): Promise<StockReservationAdminDto[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (query.status && query.status.trim()) {
      params.push(query.status.trim().toUpperCase());
      conditions.push(`status = $${params.length}`);
    }

    if (query.referenceId && query.referenceId.trim()) {
      params.push(`%${query.referenceId.trim()}%`);
      conditions.push(`reference_id ILIKE $${params.length}`);
    }

    const limit = Math.min(Math.max(Number(query.limit ?? 100) || 100, 1), 300);
    params.push(limit);

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const res = await this.db.query<ReservationRow>(
      `SELECT * FROM stock_reservations
       ${whereClause}
       ORDER BY created_at DESC
       LIMIT $${params.length}`,
      params,
    );

    const out: StockReservationAdminDto[] = [];
    for (const row of res.rows) {
      const items = await this.loadReservationItems(row.id);
      out.push({
        id: row.id,
        referenceId: row.reference_id,
        reservationType: row.reservation_type,
        status: row.status,
        idempotencyKey: row.idempotency_key,
        warehouseId: items[0]?.warehouseId ?? null,
        warehouseCode: items[0]?.warehouseCode ?? null,
        items,
        expiresAt: toIso(row.expires_at),
        committedAt: row.committed_at ? toIso(row.committed_at) : null,
        releasedAt: row.released_at ? toIso(row.released_at) : null,
        createdAt: toIso(row.created_at),
      });
    }
    return out;
  }

  async listAdminLedger(query: {
    skuId?: string;
    warehouseCode?: string;
    reason?: string;
    referenceId?: string;
    limit?: number;
  }): Promise<LedgerAdminViewDto[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (query.skuId && UUID_REGEX.test(query.skuId.trim())) {
      params.push(query.skuId.trim());
      conditions.push(`l.sku_id = $${params.length}`);
    }

    if (query.warehouseCode && query.warehouseCode.trim()) {
      params.push(query.warehouseCode.trim().toUpperCase());
      conditions.push(`UPPER(w.code) = $${params.length}`);
    }

    if (query.reason && query.reason.trim()) {
      params.push(query.reason.trim().toUpperCase());
      conditions.push(`l.reason = $${params.length}`);
    }

    if (query.referenceId && query.referenceId.trim()) {
      params.push(`%${query.referenceId.trim()}%`);
      conditions.push(`COALESCE(l.reference_id, '') ILIKE $${params.length}`);
    }

    const limit = Math.min(Math.max(Number(query.limit ?? 100) || 100, 1), 500);
    params.push(limit);

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const res = await this.db.query<LedgerJoinedRow>(
      `SELECT l.*, w.code AS warehouse_code
       FROM inventory_ledger l
       LEFT JOIN warehouses w ON w.id = l.warehouse_id
       ${whereClause}
       ORDER BY l.created_at DESC
       LIMIT $${params.length}`,
      params,
    );

    return res.rows.map((row) => ({
      id: row.id,
      skuId: row.sku_id,
      warehouseId: row.warehouse_id,
      ...(row.warehouse_code ? { warehouseCode: row.warehouse_code } : {}),
      deltaAvailable: Number(row.delta_available),
      deltaReserved: Number(row.delta_reserved),
      deltaCommitted: Number(row.delta_committed),
      balanceAvailable: Math.max(0, Number(row.balance_available_after)),
      balanceAvailableAfter: Number(row.balance_available_after),
      reason: row.reason,
      referenceId: row.reference_id,
      actorId: row.actor_id,
      note: row.note,
      createdAt: toIso(row.created_at),
    }));
  }

  private assertNonProductionTestHelper(): void {
    if (this.config.nodeEnv === 'production') {
      throw new ApiDomainException(
        HttpStatus.FORBIDDEN,
        ErrorCode.FORBIDDEN,
        'Internal test helpers are disabled in production.',
      );
    }
  }

  private async findReservationByIdempotencyKey(
    idempotencyKey: string,
    executor?: AtelierDbExecutor,
  ): Promise<ReserveStockResponse | null> {
    const runner = executor ?? this.db;
    const res = await runner.query<ReservationRow>(
      'SELECT * FROM stock_reservations WHERE idempotency_key = $1 LIMIT 1',
      [idempotencyKey],
    );
    if (res.rows.length === 0) {
      return null;
    }
    const row = res.rows[0];
    const items = await this.loadReservationItems(row.id, runner);
    return {
      reservationId: row.id,
      referenceId: row.reference_id,
      status: row.status,
      expiresAt: toIso(row.expires_at),
      idempotentReplay: true,
      items,
    };
  }

  private async loadReservationItems(
    reservationId: string,
    executor?: AtelierDbExecutor,
  ): Promise<ReservedStockLine[]> {
    const runner = executor ?? this.db;
    const res = await runner.query<ReservationItemJoinedRow>(
      `SELECT sri.id, sri.reservation_id, sri.sku_id, sri.warehouse_id,
              w.code AS warehouse_code, sri.qty
       FROM stock_reservation_items sri
       INNER JOIN warehouses w ON w.id = sri.warehouse_id
       WHERE sri.reservation_id = $1
       ORDER BY sri.sku_id ASC, w.code ASC`,
      [reservationId],
    );

    return res.rows.map((row) => ({
      skuId: row.sku_id,
      qty: Number(row.qty),
      warehouseId: row.warehouse_id,
      warehouseCode: row.warehouse_code,
    }));
  }

  private async warmSkuCountersIfAbsent(skuIds: string[]): Promise<void> {
    const valid = skuIds.filter((id) => UUID_REGEX.test(id));
    if (valid.length === 0) {
      return;
    }
    const res = await this.db.query<{ sku_id: string; total_avail: number | string }>(
      `SELECT sku_id, COALESCE(SUM(available_qty), 0)::int AS total_avail
       FROM stock_levels
       WHERE sku_id = ANY($1::uuid[])
       GROUP BY sku_id`,
      [valid],
    );
    const map = new Map<string, number>();
    for (const row of res.rows) {
      map.set(row.sku_id, Number(row.total_avail));
    }
    for (const skuId of valid) {
      await this.redis.setStockIfAbsent(skuId, map.get(skuId) ?? 0);
    }
  }

  private async fetchDbAvailableTotals(skuIds: string[]): Promise<Map<string, number>> {
    const totals = new Map<string, number>();
    const valid = [...new Set(skuIds.filter((id) => UUID_REGEX.test(id)))];
    if (valid.length === 0) {
      return totals;
    }

    const res = await this.db.query<{ sku_id: string; total_avail: number | string }>(
      `SELECT sku_id, COALESCE(SUM(available_qty), 0)::int AS total_avail
       FROM stock_levels
       WHERE sku_id = ANY($1::uuid[])
       GROUP BY sku_id`,
      [valid],
    );
    for (const row of res.rows) {
      totals.set(row.sku_id, Number(row.total_avail));
    }
    for (const skuId of valid) {
      if (!totals.has(skuId)) {
        totals.set(skuId, 0);
      }
    }
    return totals;
  }

  private async resyncRedisCountersFromDb(skuIds: string[]): Promise<Map<string, number>> {
    const synced = await this.fetchDbAvailableTotals(skuIds);
    for (const [skuId, val] of synced.entries()) {
      await this.redis.setStockAvailable(skuId, val);
    }
    return synced;
  }

  private async publishOutboxEntries(
    entries: Array<{ id: string; eventName: string; payload: Record<string, unknown> }>,
  ): Promise<void> {
    for (const entry of entries) {
      const published = await this.rabbitmq.publishDomainEvent(entry.eventName, entry.payload);
      if (published) {
        await this.db
          .query('UPDATE outbox_events SET published = TRUE WHERE id = $1', [entry.id])
          .catch(() => undefined);
      }
    }
  }

  private async notifyCatalogAvailabilityChanged(
    alerts: Array<{ skuId: string; totalAvailable: number; safetyThreshold: number }>,
    correlationId: string,
  ): Promise<void> {
    if (!this.config.catalogServiceUrl || alerts.length === 0) {
      return;
    }
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 1500);
      try {
        await fetch(`${this.config.catalogServiceUrl}/v1/catalog/internal/inventory-changed`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Correlation-Id': correlationId,
          },
          body: JSON.stringify({ alerts }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeout);
      }
    } catch {
      // Non-blocking best-effort notification
    }
  }
}
