import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ErrorCode,
  InventoryLedgerReason,
  ReservationStatus,
  WarehouseType,
} from '@atelier/contracts';
import type { AtelierDbExecutor } from '@atelier/db-client';
import { ApiDomainException } from '../common/api-exception';
import type { InventoryConfig } from '../config/env';
import type { InventoryDatabaseService } from '../infra/database.service';
import type { InventoryRabbitMqService } from '../infra/rabbitmq.service';
import type { InventoryRedisService } from '../infra/redis.service';
import { InventoryService } from './inventory.service';

const WH_CENTRAL_ID = '10000000-0000-4000-8000-000000000001';
const WH_HN_ID = '10000000-0000-4000-8000-000000000002';
const WH_HCM_ID = '10000000-0000-4000-8000-000000000003';

const SKU_A = '20000000-0000-4000-8000-000000000001';
const SKU_B = '20000000-0000-4000-8000-000000000002';
const PROD_A = '30000000-0000-4000-8000-000000000001';
const PROD_B = '30000000-0000-4000-8000-000000000002';

interface MockWarehouse {
  id: string;
  code: string;
  name: string;
  type: WarehouseType;
  province_code: string;
  city: string;
  address: string | null;
  supports_2h_delivery: boolean;
  priority: number;
  is_active: boolean;
  created_at: string;
}

interface MockStockLevel {
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
  updated_at: string;
}

interface MockReservation {
  id: string;
  idempotency_key: string;
  reservation_type: 'CHECKOUT' | 'SIZE_EXCHANGE';
  reference_id: string;
  status: ReservationStatus;
  expires_at: string;
  committed_at: string | null;
  released_at: string | null;
  created_at: string;
}

interface MockReservationItem {
  id: string;
  reservation_id: string;
  sku_id: string;
  warehouse_id: string;
  qty: number;
}

interface MockLedger {
  id: string;
  sku_id: string;
  warehouse_id: string;
  delta_available: number;
  delta_reserved: number;
  delta_committed: number;
  delta_damaged: number;
  balance_available_after: number;
  before_qty: number | null;
  after_qty: number | null;
  reason: InventoryLedgerReason;
  reason_code: string | null;
  reference_id: string | null;
  transfer_ref: string | null;
  actor_id: string | null;
  actor_email: string | null;
  note: string | null;
  created_at: string;
}

interface DbState {
  warehouses: MockWarehouse[];
  stockLevels: MockStockLevel[];
  reservations: MockReservation[];
  reservationItems: MockReservationItem[];
  ledger: MockLedger[];
  outbox: Array<{ id: string; event_name: string; payload_jsonb: string; published: boolean }>;
  pendingAiPosCount: number;
}

function createInitialState(): DbState {
  const now = new Date().toISOString();
  return {
    warehouses: [
      {
        id: WH_CENTRAL_ID,
        code: 'CENTRAL_WH',
        name: 'Kho Tổng Trung Tâm Hà Nội',
        type: WarehouseType.CENTRAL,
        province_code: 'HN',
        city: 'Hà Nội',
        address: 'Long Biên, Hà Nội',
        supports_2h_delivery: false,
        priority: 1,
        is_active: true,
        created_at: now,
      },
      {
        id: WH_HN_ID,
        code: 'HN_ATELIER',
        name: 'Atelier Hà Nội',
        type: WarehouseType.SHOWROOM,
        province_code: 'HN',
        city: 'Hà Nội',
        address: '18 Phan Đình Phùng',
        supports_2h_delivery: true,
        priority: 2,
        is_active: true,
        created_at: now,
      },
      {
        id: WH_HCM_ID,
        code: 'HCM_SHOWROOM',
        name: 'Showroom TP.HCM',
        type: WarehouseType.SHOWROOM,
        province_code: 'HCM',
        city: 'TP. Hồ Chí Minh',
        address: '68 Đồng Khởi',
        supports_2h_delivery: true,
        priority: 3,
        is_active: true,
        created_at: now,
      },
    ],
    stockLevels: [
      {
        sku_id: SKU_A,
        warehouse_id: WH_CENTRAL_ID,
        product_id: PROD_A,
        sku_code: 'AT-BLZ-M',
        available_qty: 10,
        reserved_qty: 0,
        committed_qty: 0,
        damaged_qty: 1,
        safety_threshold: 3,
        version: 1,
        updated_at: now,
      },
      {
        sku_id: SKU_A,
        warehouse_id: WH_HN_ID,
        product_id: PROD_A,
        sku_code: 'AT-BLZ-M',
        available_qty: 4,
        reserved_qty: 0,
        committed_qty: 0,
        damaged_qty: 0,
        safety_threshold: 3,
        version: 1,
        updated_at: now,
      },
      {
        sku_id: SKU_B,
        warehouse_id: WH_CENTRAL_ID,
        product_id: PROD_B,
        sku_code: 'AT-SLK-S',
        available_qty: 2,
        reserved_qty: 0,
        committed_qty: 0,
        damaged_qty: 0,
        safety_threshold: 3,
        version: 1,
        updated_at: now,
      },
    ],
    reservations: [],
    reservationItems: [],
    ledger: [],
    outbox: [],
    pendingAiPosCount: 2,
  };
}

class InMemoryInventoryDb {
  public state: DbState;
  public ready = true;
  public queryLog: Array<{ sql: string; params: unknown[] }> = [];
  private txChain: Promise<unknown> = Promise.resolve();

  constructor(initial?: DbState) {
    this.state = initial ?? createInitialState();
  }

  isReady(): boolean {
    return this.ready;
  }

  private execSql<T>(state: DbState, sql: string, params: unknown[] = []): { rows: T[]; rowCount: number } {
    this.queryLog.push({ sql, params });
    const norm = sql.replace(/\s+/g, ' ').trim();
    const now = new Date().toISOString();

    // SELECT warehouses
    if (norm.startsWith('SELECT * FROM warehouses WHERE is_active = TRUE')) {
      const rows = state.warehouses
        .filter((w) => w.is_active)
        .sort((a, b) => a.priority - b.priority || a.code.localeCompare(b.code));
      return { rows: rows as unknown as T[], rowCount: rows.length };
    }
    if (norm.startsWith('SELECT id, code FROM warehouses WHERE is_active = TRUE')) {
      const rows = state.warehouses
        .filter((w) => w.is_active)
        .sort((a, b) => a.priority - b.priority)
        .map((w) => ({ id: w.id, code: w.code }));
      return { rows: rows as unknown as T[], rowCount: rows.length };
    }
    if (norm.startsWith('SELECT id FROM warehouses WHERE UPPER(code) = $1')) {
      const code = String(params[0]).toUpperCase();
      const rows = state.warehouses.filter((w) => w.code.toUpperCase() === code).map((w) => ({ id: w.id }));
      return { rows: rows as unknown as T[], rowCount: rows.length };
    }
    if (norm.startsWith('SELECT * FROM warehouses WHERE UPPER(code) = $1 OR is_active = TRUE')) {
      const code = String(params[0]).toUpperCase();
      const rows = state.warehouses
        .filter((w) => w.code.toUpperCase() === code || w.is_active)
        .sort((a, b) => (a.code.toUpperCase() === code ? 0 : 1) - (b.code.toUpperCase() === code ? 0 : 1) || a.priority - b.priority)
        .slice(0, 1);
      return { rows: rows as unknown as T[], rowCount: rows.length };
    }
    if (norm.startsWith('SELECT * FROM warehouses WHERE UPPER(code) = $1 LIMIT 1')) {
      const code = String(params[0]).toUpperCase();
      const rows = state.warehouses.filter((w) => w.code.toUpperCase() === code).slice(0, 1);
      return { rows: rows as unknown as T[], rowCount: rows.length };
    }
    if (norm.startsWith('SELECT * FROM warehouses WHERE UPPER(code) = ANY($1::text[])')) {
      const codes = (params[0] as string[]).map((c) => c.toUpperCase());
      const rows = state.warehouses
        .filter((w) => codes.includes(w.code.toUpperCase()))
        .sort((a, b) => a.id.localeCompare(b.id));
      return { rows: rows as unknown as T[], rowCount: rows.length };
    }
    if (norm.startsWith('SELECT w.*, COALESCE(SUM(sl.available_qty)')) {
      let filtered = [...state.warehouses];
      if (norm.includes('WHERE w.id = $1')) {
        filtered = filtered.filter((w) => w.id === params[0]);
      } else if (norm.includes('WHERE UPPER(w.code) = $1')) {
        filtered = filtered.filter((w) => w.code.toUpperCase() === String(params[0]).toUpperCase());
      }
      const rows = filtered
        .sort((a, b) => a.priority - b.priority || a.code.localeCompare(b.code))
        .map((w) => {
          const levels = state.stockLevels.filter((s) => s.warehouse_id === w.id);
          return {
            ...w,
            total_available: levels.reduce((s, r) => s + r.available_qty, 0),
            total_reserved: levels.reduce((s, r) => s + r.reserved_qty, 0),
            total_committed: levels.reduce((s, r) => s + r.committed_qty, 0),
          };
        });
      return { rows: rows as unknown as T[], rowCount: rows.length };
    }
    if (norm.startsWith('INSERT INTO warehouses')) {
      const row: MockWarehouse = {
        id: String(params[0]),
        code: String(params[1]),
        name: String(params[2]),
        type: params[3] as WarehouseType,
        province_code: String(params[4]),
        city: String(params[5]),
        address: (params[6] as string | null) ?? null,
        supports_2h_delivery: Boolean(params[7]),
        priority: Number(params[8]),
        is_active: Boolean(params[9]),
        created_at: now,
      };
      state.warehouses.push(row);
      return { rows: [row] as unknown as T[], rowCount: 1 };
    }
    if (norm.startsWith('UPDATE warehouses SET')) {
      const wh = state.warehouses.find((w) => w.id === params[8]);
      if (!wh) return { rows: [], rowCount: 0 };
      wh.name = String(params[0]);
      wh.type = params[1] as WarehouseType;
      wh.province_code = String(params[2]);
      wh.city = String(params[3]);
      wh.address = (params[4] as string | null) ?? null;
      wh.supports_2h_delivery = Boolean(params[5]);
      wh.priority = Number(params[6]);
      wh.is_active = Boolean(params[7]);
      return { rows: [wh] as unknown as T[], rowCount: 1 };
    }

    // SELECT stock_levels joined
    if (norm.startsWith('SELECT sl.*, w.code AS warehouse_code')) {
      let rows = state.stockLevels
        .map((sl) => {
          const w = state.warehouses.find((wh) => wh.id === sl.warehouse_id);
          return w
            ? {
                ...sl,
                warehouse_code: w.code,
                warehouse_name: w.name,
                warehouse_type: w.type,
                warehouse_priority: w.priority,
                _whActive: w.is_active,
              }
            : null;
        })
        .filter((r): r is NonNullable<typeof r> => r !== null);

      if (norm.includes('WHERE sl.sku_id = ANY($1::uuid[])')) {
        const ids = params[0] as string[];
        rows = rows.filter((r) => ids.includes(r.sku_id) && r._whActive);
        if (norm.includes('AND UPPER(w.code) = $2')) {
          rows = rows.filter((r) => r.warehouse_code.toUpperCase() === String(params[1]).toUpperCase());
        }
      } else if (norm.includes('WHERE sl.sku_id = $1')) {
        rows = rows.filter((r) => r.sku_id === params[0]);
        if (norm.includes('AND sl.warehouse_id = $2')) {
          rows = rows.filter((r) => r.warehouse_id === params[1]);
        }
      } else {
        // listAdminStockLevels
        if (norm.includes('sl.available_qty >= 1 AND sl.available_qty <= sl.safety_threshold')) {
          rows = rows.filter((r) => r.available_qty >= 1 && r.available_qty <= r.safety_threshold);
        }
        if (norm.includes('sl.available_qty = 0')) {
          rows = rows.filter((r) => r.available_qty === 0);
        }
        const whMatch = norm.match(/UPPER\(w\.code\) = \$(\d+)/);
        if (whMatch) {
          const code = String(params[Number(whMatch[1]) - 1]).toUpperCase();
          rows = rows.filter((r) => r.warehouse_code.toUpperCase() === code);
        }
      }
      return { rows: rows as unknown as T[], rowCount: rows.length };
    }

    // SELECT stock_levels simple
    if (norm.startsWith('SELECT * FROM stock_levels WHERE sku_id = $1 AND warehouse_id = ANY($2::uuid[])')) {
      const skuId = String(params[0]);
      const whIds = params[1] as string[];
      const rows = state.stockLevels
        .filter((r) => r.sku_id === skuId && whIds.includes(r.warehouse_id))
        .sort((a, b) => a.warehouse_id.localeCompare(b.warehouse_id));
      return { rows: rows as unknown as T[], rowCount: rows.length };
    }
    if (norm.startsWith('SELECT * FROM stock_levels WHERE sku_id = $1 AND warehouse_id = $2')) {
      const rows = state.stockLevels.filter(
        (r) => r.sku_id === params[0] && r.warehouse_id === params[1],
      );
      return { rows: rows as unknown as T[], rowCount: rows.length };
    }
    if (norm.startsWith('SELECT * FROM stock_levels WHERE sku_id = $1')) {
      const rows = state.stockLevels
        .filter((r) => r.sku_id === params[0])
        .sort((a, b) => a.warehouse_id.localeCompare(b.warehouse_id));
      return { rows: rows as unknown as T[], rowCount: rows.length };
    }
    if (norm.startsWith('SELECT sku_id, sku_code, product_id, safety_threshold FROM stock_levels WHERE sku_id = $1')) {
      const rows = state.stockLevels.filter((r) => r.sku_id === params[0]).slice(0, 1);
      return { rows: rows as unknown as T[], rowCount: rows.length };
    }
    if (norm.startsWith('SELECT sku_id, sku_code, product_id, safety_threshold FROM stock_levels WHERE UPPER(sku_code) = UPPER($1)')) {
      const code = String(params[0]).toUpperCase();
      const rows = state.stockLevels
        .filter((r) => (r.sku_code ?? '').toUpperCase() === code)
        .slice(0, 1);
      return { rows: rows as unknown as T[], rowCount: rows.length };
    }
    if (norm.startsWith('SELECT COUNT(*)::int AS cnt FROM stock_levels WHERE sku_id = $1')) {
      const cnt = state.stockLevels.filter((r) => r.sku_id === params[0]).length;
      return { rows: [{ cnt }] as unknown as T[], rowCount: 1 };
    }
    if (norm.startsWith('SELECT COUNT(DISTINCT sku_id)::int AS cnt FROM stock_levels')) {
      const cnt = new Set(state.stockLevels.map((r) => r.sku_id)).size;
      return { rows: [{ cnt }] as unknown as T[], rowCount: 1 };
    }
    if (norm.startsWith('SELECT sku_id, COALESCE(SUM(available_qty), 0)::int AS total_avail FROM stock_levels')) {
      const ids = params[0] as string[];
      const map = new Map<string, number>();
      for (const r of state.stockLevels) {
        if (ids.includes(r.sku_id)) {
          map.set(r.sku_id, (map.get(r.sku_id) ?? 0) + r.available_qty);
        }
      }
      const rows = [...map.entries()].map(([sku_id, total_avail]) => ({ sku_id, total_avail }));
      return { rows: rows as unknown as T[], rowCount: rows.length };
    }
    if (norm.startsWith('SELECT COALESCE(SUM(available_qty), 0)::int AS total_avail FROM stock_levels WHERE sku_id = $1')) {
      const total_avail = state.stockLevels
        .filter((r) => r.sku_id === params[0])
        .reduce((s, r) => s + r.available_qty, 0);
      return { rows: [{ total_avail }] as unknown as T[], rowCount: 1 };
    }

    // UPDATE stock_levels
    if (norm.startsWith('UPDATE stock_levels SET available_qty = available_qty - $1, reserved_qty = reserved_qty + $1')) {
      const qty = Number(params[0]);
      const row = state.stockLevels.find(
        (r) => r.sku_id === params[1] && r.warehouse_id === params[2] && r.available_qty >= qty,
      );
      if (!row) return { rows: [], rowCount: 0 };
      row.available_qty -= qty;
      row.reserved_qty += qty;
      row.version += 1;
      row.updated_at = now;
      return {
        rows: [{ available_qty: row.available_qty, reserved_qty: row.reserved_qty, version: row.version }] as unknown as T[],
        rowCount: 1,
      };
    }
    if (norm.startsWith('UPDATE stock_levels SET reserved_qty = GREATEST(0, reserved_qty - $1), committed_qty = committed_qty + $1')) {
      const qty = Number(params[0]);
      const row = state.stockLevels.find((r) => r.sku_id === params[1] && r.warehouse_id === params[2]);
      if (!row) return { rows: [], rowCount: 0 };
      row.reserved_qty = Math.max(0, row.reserved_qty - qty);
      row.committed_qty += qty;
      row.version += 1;
      row.updated_at = now;
      return { rows: [{ available_qty: row.available_qty }] as unknown as T[], rowCount: 1 };
    }
    if (norm.startsWith('UPDATE stock_levels SET available_qty = available_qty + $1, reserved_qty = GREATEST(0, reserved_qty - $1)')) {
      const qty = Number(params[0]);
      const row = state.stockLevels.find((r) => r.sku_id === params[1] && r.warehouse_id === params[2]);
      if (!row) return { rows: [], rowCount: 0 };
      row.available_qty += qty;
      row.reserved_qty = Math.max(0, row.reserved_qty - qty);
      row.version += 1;
      row.updated_at = now;
      return { rows: [{ available_qty: row.available_qty }] as unknown as T[], rowCount: 1 };
    }
    if (norm.startsWith('UPDATE stock_levels SET available_qty = available_qty - $1, version = version + 1')) {
      const qty = Number(params[0]);
      const row = state.stockLevels.find(
        (r) => r.sku_id === params[1] && r.warehouse_id === params[2] && r.available_qty >= qty,
      );
      if (!row) return { rows: [], rowCount: 0 };
      row.available_qty -= qty;
      row.version += 1;
      row.updated_at = now;
      return { rows: [row] as unknown as T[], rowCount: 1 };
    }
    if (norm.startsWith('UPDATE stock_levels SET available_qty = 0, reserved_qty = 0')) {
      for (const r of state.stockLevels) {
        if (r.sku_id === params[0] && r.warehouse_id !== params[1]) {
          r.available_qty = 0;
          r.reserved_qty = 0;
          r.version += 1;
        }
      }
      return { rows: [], rowCount: 1 };
    }
    if (norm.startsWith('UPDATE stock_levels SET safety_threshold = $1')) {
      const threshold = Number(params[0]);
      const skuId = String(params[1]);
      const whId = params[2] ? String(params[2]) : null;
      let count = 0;
      for (const r of state.stockLevels) {
        if (r.sku_id === skuId && (!whId || r.warehouse_id === whId)) {
          r.safety_threshold = threshold;
          r.version += 1;
          count += 1;
        }
      }
      return { rows: [], rowCount: count };
    }

    // INSERT INTO stock_levels (testSetStock / createAdjustment / createTransfer / rmaRestock / syncCatalogSkus)
    if (norm.startsWith('INSERT INTO stock_levels')) {
      const skuId = String(params[0]);
      const whId = String(params[1]);
      const productId = String(params[2]);
      const skuCode = (params[3] as string | null) ?? null;
      let row = state.stockLevels.find((r) => r.sku_id === skuId && r.warehouse_id === whId);

      if (norm.includes('ON CONFLICT (sku_id, warehouse_id) DO NOTHING')) {
        if (!row) {
          row = {
            sku_id: skuId,
            warehouse_id: whId,
            product_id: productId,
            sku_code: skuCode,
            available_qty: Number(params[4]),
            reserved_qty: 0,
            committed_qty: 0,
            damaged_qty: 0,
            safety_threshold: Number(params[5]),
            version: 1,
            updated_at: now,
          };
          state.stockLevels.push(row);
        }
        return { rows: [row] as unknown as T[], rowCount: 1 };
      }

      if (norm.includes('available_qty = stock_levels.available_qty + EXCLUDED.available_qty') && norm.includes('damaged_qty = stock_levels.damaged_qty + EXCLUDED.damaged_qty')) {
        // rmaRestock
        const addAvail = Number(params[4]);
        const addDmg = Number(params[5]);
        if (row) {
          row.available_qty += addAvail;
          row.damaged_qty += addDmg;
          row.version += 1;
          row.updated_at = now;
        } else {
          row = {
            sku_id: skuId,
            warehouse_id: whId,
            product_id: productId,
            sku_code: skuCode,
            available_qty: addAvail,
            reserved_qty: 0,
            committed_qty: 0,
            damaged_qty: addDmg,
            safety_threshold: 3,
            version: 1,
            updated_at: now,
          };
          state.stockLevels.push(row);
        }
        return { rows: [{ available_qty: row.available_qty, damaged_qty: row.damaged_qty }] as unknown as T[], rowCount: 1 };
      }

      if (norm.includes('available_qty = stock_levels.available_qty + EXCLUDED.available_qty')) {
        // transfer credit
        const qty = Number(params[4]);
        if (row) {
          row.available_qty += qty;
          row.version += 1;
          row.updated_at = now;
        } else {
          row = {
            sku_id: skuId,
            warehouse_id: whId,
            product_id: productId,
            sku_code: skuCode,
            available_qty: qty,
            reserved_qty: 0,
            committed_qty: 0,
            damaged_qty: 0,
            safety_threshold: Number(params[5] ?? 3),
            version: 1,
            updated_at: now,
          };
          state.stockLevels.push(row);
        }
        return { rows: [row] as unknown as T[], rowCount: 1 };
      }

      if (norm.includes('damaged_qty = EXCLUDED.damaged_qty')) {
        // createAdjustment
        const nextAvail = Number(params[4]);
        const nextDmg = Number(params[5]);
        if (row) {
          row.available_qty = nextAvail;
          row.damaged_qty = nextDmg;
          row.version += 1;
          row.updated_at = now;
        } else {
          row = {
            sku_id: skuId,
            warehouse_id: whId,
            product_id: productId,
            sku_code: skuCode,
            available_qty: nextAvail,
            reserved_qty: 0,
            committed_qty: 0,
            damaged_qty: nextDmg,
            safety_threshold: Number(params[6] ?? 3),
            version: 1,
            updated_at: now,
          };
          state.stockLevels.push(row);
        }
        return { rows: [row] as unknown as T[], rowCount: 1 };
      }

      // testSetStock
      const avail = Number(params[4]);
      const resv = Number(params[5]);
      const comm = Number(params[6]);
      if (row) {
        row.available_qty = avail;
        row.reserved_qty = resv;
        row.committed_qty = comm;
        row.version += 1;
        row.updated_at = now;
      } else {
        row = {
          sku_id: skuId,
          warehouse_id: whId,
          product_id: productId,
          sku_code: skuCode,
          available_qty: avail,
          reserved_qty: resv,
          committed_qty: comm,
          damaged_qty: 0,
          safety_threshold: 3,
          version: 1,
          updated_at: now,
        };
        state.stockLevels.push(row);
      }
      return { rows: [row] as unknown as T[], rowCount: 1 };
    }

    // stock_reservations
    if (norm.startsWith('SELECT * FROM stock_reservations WHERE idempotency_key = $1')) {
      const rows = state.reservations.filter((r) => r.idempotency_key === params[0]).slice(0, 1);
      return { rows: rows as unknown as T[], rowCount: rows.length };
    }
    if (norm.startsWith('SELECT * FROM stock_reservations WHERE reference_id = $1 OR id::text = $1')) {
      const rows = state.reservations
        .filter((r) => r.reference_id === params[0] || r.id === params[0])
        .slice(-1);
      return { rows: rows as unknown as T[], rowCount: rows.length };
    }
    if (norm.startsWith("SELECT id, reference_id FROM stock_reservations WHERE status = 'ACTIVE' AND expires_at <= NOW()")) {
      const nowMs = Date.now();
      const rows = state.reservations
        .filter((r) => r.status === ReservationStatus.ACTIVE && new Date(r.expires_at).getTime() <= nowMs)
        .map((r) => ({ id: r.id, reference_id: r.reference_id }));
      return { rows: rows as unknown as T[], rowCount: rows.length };
    }
    if (norm.startsWith("SELECT * FROM stock_reservations WHERE id = $1 AND status = 'ACTIVE' AND expires_at <= NOW()")) {
      const nowMs = Date.now();
      const rows = state.reservations.filter(
        (r) =>
          r.id === params[0] &&
          r.status === ReservationStatus.ACTIVE &&
          new Date(r.expires_at).getTime() <= nowMs,
      );
      return { rows: rows as unknown as T[], rowCount: rows.length };
    }
    if (norm.startsWith("SELECT COUNT(*)::int AS cnt FROM stock_reservations WHERE status = 'ACTIVE'")) {
      const cnt = state.reservations.filter((r) => r.status === ReservationStatus.ACTIVE).length;
      return { rows: [{ cnt }] as unknown as T[], rowCount: 1 };
    }
    if (norm.startsWith('SELECT * FROM stock_reservations')) {
      let rows = [...state.reservations];
      const statusMatch = norm.match(/status = \$(\d+)/);
      if (statusMatch) {
        rows = rows.filter((r) => r.status === params[Number(statusMatch[1]) - 1]);
      }
      return { rows: rows as unknown as T[], rowCount: rows.length };
    }
    if (norm.startsWith('INSERT INTO stock_reservations')) {
      const idem = String(params[1]);
      if (state.reservations.some((r) => r.idempotency_key === idem)) {
        const err = new Error('duplicate key') as Error & { code: string };
        err.code = '23505';
        throw err;
      }
      state.reservations.push({
        id: String(params[0]),
        idempotency_key: idem,
        reservation_type: params[2] as 'CHECKOUT' | 'SIZE_EXCHANGE',
        reference_id: String(params[3]),
        status: params[4] as ReservationStatus,
        expires_at: String(params[5]),
        committed_at: null,
        released_at: null,
        created_at: now,
      });
      return { rows: [], rowCount: 1 };
    }
    if (norm.startsWith("UPDATE stock_reservations SET expires_at = NOW() - INTERVAL '1 minute'")) {
      const key = String(params[0]);
      const row = state.reservations.find(
        (r) => (r.reference_id === key || r.id === key) && r.status === ReservationStatus.ACTIVE,
      );
      if (!row) return { rows: [], rowCount: 0 };
      row.expires_at = new Date(Date.now() - 60_000).toISOString();
      return { rows: [row] as unknown as T[], rowCount: 1 };
    }
    if (norm.startsWith('UPDATE stock_reservations SET status = $1')) {
      const row = state.reservations.find((r) => r.id === params[1]);
      if (row) {
        row.status = params[0] as ReservationStatus;
        if (row.status === ReservationStatus.COMMITTED) row.committed_at = now;
        else row.released_at = now;
      }
      return { rows: [], rowCount: row ? 1 : 0 };
    }

    // stock_reservation_items
    if (norm.startsWith('INSERT INTO stock_reservation_items')) {
      state.reservationItems.push({
        id: String(params[0]),
        reservation_id: String(params[1]),
        sku_id: String(params[2]),
        warehouse_id: String(params[3]),
        qty: Number(params[4]),
      });
      return { rows: [], rowCount: 1 };
    }
    if (norm.startsWith('SELECT sri.id, sri.reservation_id, sri.sku_id')) {
      const rows = state.reservationItems
        .filter((it) => it.reservation_id === params[0])
        .map((it) => ({
          ...it,
          warehouse_code: state.warehouses.find((w) => w.id === it.warehouse_id)?.code ?? 'UNKNOWN',
        }));
      return { rows: rows as unknown as T[], rowCount: rows.length };
    }

    // inventory_ledger
    if (norm.startsWith('INSERT INTO inventory_ledger')) {
      const hasTransferRef = norm.includes('transfer_ref');
      const hasReasonCode = norm.includes('reason_code');
      const entry: MockLedger = hasTransferRef
        ? {
            id: String(params[0]),
            sku_id: String(params[1]),
            warehouse_id: String(params[2]),
            delta_available: Number(params[3]),
            delta_reserved: 0,
            delta_committed: 0,
            delta_damaged: 0,
            balance_available_after: Number(params[4]),
            before_qty: Number(params[5]),
            after_qty: Number(params[6]),
            reason: params[7] as InventoryLedgerReason,
            reason_code: 'INTERNAL_TRANSFER',
            reference_id: String(params[8]),
            transfer_ref: String(params[8]),
            actor_id: (params[9] as string | null) ?? null,
            actor_email: (params[10] as string | null) ?? null,
            note: (params[11] as string | null) ?? null,
            created_at: now,
          }
        : hasReasonCode
          ? {
              id: String(params[0]),
              sku_id: String(params[1]),
              warehouse_id: String(params[2]),
              delta_available: Number(params[3]),
              delta_reserved: 0,
              delta_committed: 0,
              delta_damaged: Number(params[4]),
              balance_available_after: Number(params[5]),
              before_qty: Number(params[6]),
              after_qty: Number(params[7]),
              reason: params[8] as InventoryLedgerReason,
              reason_code: String(params[9]),
              reference_id: String(params[10]),
              transfer_ref: null,
              actor_id: (params[11] as string | null) ?? null,
              actor_email: (params[12] as string | null) ?? null,
              note: (params[13] as string | null) ?? null,
              created_at: now,
            }
          : {
              id: String(params[0]),
              sku_id: String(params[1]),
              warehouse_id: String(params[2]),
              delta_available: Number(params[3]),
              delta_reserved: 0,
              delta_committed: 0,
              delta_damaged: 0,
              balance_available_after: Number(params[4] ?? 0),
              before_qty: null,
              after_qty: null,
              reason: (params.find((p) =>
                Object.values(InventoryLedgerReason).includes(p as InventoryLedgerReason),
              ) ?? InventoryLedgerReason.ADJUSTMENT) as InventoryLedgerReason,
              reason_code: null,
              reference_id: null,
              transfer_ref: null,
              actor_id: null,
              actor_email: null,
              note: String(params[params.length - 1] ?? ''),
              created_at: now,
            };
      state.ledger.push(entry);
      return { rows: [{ created_at: now }] as unknown as T[], rowCount: 1 };
    }
    if (norm.startsWith('SELECT COUNT(*)::int AS cnt FROM inventory_ledger')) {
      return { rows: [{ cnt: state.ledger.length }] as unknown as T[], rowCount: 1 };
    }
    if (norm.startsWith('SELECT l.*, w.code AS warehouse_code')) {
      const rows = state.ledger.map((l) => ({
        ...l,
        warehouse_code: state.warehouses.find((w) => w.id === l.warehouse_id)?.code ?? null,
        sku_code: state.stockLevels.find((s) => s.sku_id === l.sku_id)?.sku_code ?? null,
      }));
      return { rows: rows as unknown as T[], rowCount: rows.length };
    }

    // outbox_events
    if (norm.startsWith('INSERT INTO outbox_events')) {
      state.outbox.push({
        id: String(params[0]),
        event_name: String(params[1] ?? 'inventory.availability.changed'),
        payload_jsonb: String(params[params.length - 1]),
        published: false,
      });
      return { rows: [], rowCount: 1 };
    }
    if (norm.startsWith('UPDATE outbox_events SET published = TRUE')) {
      const o = state.outbox.find((e) => e.id === params[0]);
      if (o) o.published = true;
      return { rows: [], rowCount: o ? 1 : 0 };
    }

    // getOpsSummary
    if (norm.startsWith('WITH sku_totals AS')) {
      const bySku = new Map<string, { avail: number; resv: number; comm: number; dmg: number; th: number }>();
      for (const r of state.stockLevels) {
        const cur = bySku.get(r.sku_id) ?? { avail: 0, resv: 0, comm: 0, dmg: 0, th: r.safety_threshold };
        cur.avail += r.available_qty;
        cur.resv += r.reserved_qty;
        cur.comm += r.committed_qty;
        cur.dmg += r.damaged_qty;
        cur.th = Math.max(cur.th, r.safety_threshold);
        bySku.set(r.sku_id, cur);
      }
      const list = [...bySku.values()];
      return {
        rows: [
          {
            total_skus: list.length,
            low_stock_count: list.filter((x) => x.avail >= 1 && x.avail <= x.th).length,
            out_of_stock_count: list.filter((x) => x.avail === 0).length,
            total_available_qty: list.reduce((s, x) => s + x.avail, 0),
            total_reserved_qty: list.reduce((s, x) => s + x.resv, 0),
            total_committed_qty: list.reduce((s, x) => s + x.comm, 0),
            total_damaged_qty: list.reduce((s, x) => s + x.dmg, 0),
          },
        ] as unknown as T[],
        rowCount: 1,
      };
    }
    if (norm.startsWith("SELECT COUNT(*)::int AS cnt FROM purchase_orders WHERE status = 'NHAP_AI'")) {
      return { rows: [{ cnt: state.pendingAiPosCount }] as unknown as T[], rowCount: 1 };
    }

    return { rows: [], rowCount: 0 };
  }

  async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<{ rows: T[]; rowCount: number }> {
    return this.execSql<T>(this.state, sql, params);
  }

  async transaction<T>(fn: (tx: AtelierDbExecutor) => Promise<T>): Promise<T> {
    // Serialize transactions just like PostgreSQL row locks to verify anti-oversell under Promise.all
    const run = this.txChain.then(async () => {
      const snapshot: DbState = structuredClone(this.state);
      const txExecutor = {
        query: async <R = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
          this.execSql<R>(snapshot, sql, params),
      } as unknown as AtelierDbExecutor;
      const result = await fn(txExecutor);
      this.state = snapshot;
      return result;
    });
    this.txChain = run.catch(() => undefined);
    return run;
  }
}

function createHarness(options: { nodeEnv?: string; redisMode?: 'UNAVAILABLE' | 'LIVE' } = {}) {
  const db = new InMemoryInventoryDb();
  const redisCounters = new Map<string, number>();

  const redis = {
    atomicReserve: vi.fn(
      async (
        items: Array<{ skuId: string; qty: number }>,
      ): Promise<Awaited<ReturnType<InventoryRedisService['atomicReserve']>>> => {
      if (options.redisMode !== 'LIVE') {
        return { status: 'UNAVAILABLE' };
      }
      for (const item of items) {
        if (!redisCounters.has(item.skuId)) return { status: 'MISS', missingKey: item.skuId };
      }
      const shortages = items
        .map((item) => ({ skuId: item.skuId, requestedQty: item.qty, availableQty: redisCounters.get(item.skuId) ?? 0 }))
        .filter((s) => s.availableQty < s.requestedQty);
      if (shortages.length > 0) {
        return { status: 'INSUFFICIENT', insufficientSkus: shortages };
      }
      for (const item of items) {
        redisCounters.set(item.skuId, (redisCounters.get(item.skuId) ?? 0) - item.qty);
      }
      return { status: 'OK' };
    }),
    atomicRelease: vi.fn(async (items: Array<{ skuId: string; qty: number }>) => {
      for (const item of items) {
        redisCounters.set(item.skuId, (redisCounters.get(item.skuId) ?? 0) + item.qty);
      }
      return true;
    }),
    setStockIfAbsent: vi.fn(async (skuId: string, qty: number) => {
      if (!redisCounters.has(skuId)) redisCounters.set(skuId, qty);
      return true;
    }),
    setStockAvailable: vi.fn(async (skuId: string, qty: number) => {
      redisCounters.set(skuId, qty);
      return true;
    }),
  } as unknown as InventoryRedisService;

  const rabbitmq = {
    publishDomainEvent: vi.fn(async () => true),
  } as unknown as InventoryRabbitMqService;

  const config: InventoryConfig = {
    serviceName: '@atelier/inventory',
    boundedContext: 'inventory',
    port: 4004,
    nodeEnv: options.nodeEnv ?? 'test',
    repoRoot: '.',
    database: {
      envVar: 'INVENTORY_DATABASE_URL',
      url: 'postgresql://localhost/inventory_db',
      configured: false,
      targetDatabase: 'inventory_db',
      host: '127.0.0.1',
      port: 5432,
    },
    redis: { url: 'redis://127.0.0.1:6379', configured: false },
    rabbitmq: { url: 'amqp://127.0.0.1:5672', configured: false },
    internalServiceSecret: 'test-secret',
    authCustomerServiceUrl: '',
    notifyReviewServiceUrl: '',
    catalogServiceUrl: '',
    allowedOrigins: [],
    expireSweepIntervalMs: 60_000,
    infra: { redisConfigured: false, rabbitmqConfigured: false },
  };

  const service = new InventoryService(
    config,
    db as unknown as InventoryDatabaseService,
    redis,
    rabbitmq,
  );

  return { service, db, redis, rabbitmq, redisCounters };
}

describe('InventoryService — Anti-Oversell, Expiry Reclamation, Adjustment & Transfer', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('prevents overselling under concurrent reservation race and keeps available_qty >= 0', async () => {
    const { service, db } = createHarness({ redisMode: 'LIVE' });

    // SKU_B has exactly 2 available units in CENTRAL_WH; 5 concurrent buyers each request 1 unit
    const attempts = await Promise.allSettled(
      Array.from({ length: 5 }, (_, idx) =>
        service.reserveStock(
          {
            idempotencyKey: `race-key-${idx}`,
            referenceId: `order-race-${idx}`,
            reservationType: 'CHECKOUT',
            ttlSeconds: 900,
            items: [{ skuId: SKU_B, qty: 1 }],
          },
          `corr-race-${idx}`,
        ),
      ),
    );

    const fulfilled = attempts.filter((r) => r.status === 'fulfilled');
    const rejected = attempts.filter((r) => r.status === 'rejected');

    expect(fulfilled).toHaveLength(2);
    expect(rejected).toHaveLength(3);
    for (const rej of rejected) {
      const err = (rej as PromiseRejectedResult).reason as ApiDomainException;
      expect(err).toBeInstanceOf(ApiDomainException);
      expect(err.code).toBe(ErrorCode.INSUFFICIENT_STOCK);
    }

    const rowB = db.state.stockLevels.find((s) => s.sku_id === SKU_B)!;
    expect(rowB.available_qty).toBe(0);
    expect(rowB.reserved_qty).toBe(2);
  });

  it('supports idempotent reservation replay, multi-warehouse split allocation, commit, and release', async () => {
    const { service, db } = createHarness();

    // SKU_A has 10 in CENTRAL_WH + 4 in HN_ATELIER = 14 total; reserve 12 -> splits across both warehouses
    const res1 = await service.reserveStock(
      {
        idempotencyKey: 'idem-split-1',
        referenceId: 'order-split-1',
        reservationType: 'CHECKOUT',
        ttlSeconds: 900,
        preferredWarehouseCode: 'HN_ATELIER',
        items: [
          { skuId: SKU_A, qty: 7 },
          { skuId: SKU_A, qty: 5 }, // duplicate line merged -> 12
        ],
      },
      'corr-1',
    );

    expect(res1.status).toBe(ReservationStatus.ACTIVE);
    expect(res1.idempotentReplay).toBe(false);
    expect(res1.items).toHaveLength(2);
    expect(res1.items.reduce((s, it) => s + it.qty, 0)).toBe(12);

    // Idempotent replay does NOT double-decrement stock
    const replay = await service.reserveStock(
      {
        idempotencyKey: 'idem-split-1',
        referenceId: 'order-split-1',
        reservationType: 'CHECKOUT',
        ttlSeconds: 900,
        items: [{ skuId: SKU_A, qty: 12 }],
      },
      'corr-1',
    );
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.reservationId).toBe(res1.reservationId);

    // Invalid non-UUID SKU throws INSUFFICIENT_STOCK
    await expect(
      service.reserveStock(
        {
          idempotencyKey: 'idem-bad-sku',
          referenceId: 'order-bad',
          reservationType: 'CHECKOUT',
          ttlSeconds: 900,
          items: [{ skuId: 'not-a-uuid', qty: 1 }],
        },
        'corr-bad',
      ),
    ).rejects.toMatchObject({ code: ErrorCode.INSUFFICIENT_STOCK });

    // Commit reservation -> COMMITTED + idempotent replay
    const committed = await service.commitReservation('order-split-1');
    expect(committed.status).toBe(ReservationStatus.COMMITTED);
    expect(committed.idempotentReplay).toBe(false);

    const committedReplay = await service.commitReservation('order-split-1');
    expect(committedReplay.idempotentReplay).toBe(true);

    // Cannot release already COMMITTED reservation
    await expect(service.releaseReservation('order-split-1')).rejects.toMatchObject({
      code: ErrorCode.CONFLICT,
    });

    // Reserve SKU_B and release it cleanly
    const resB = await service.reserveStock(
      {
        idempotencyKey: 'idem-release-b',
        referenceId: 'order-release-b',
        reservationType: 'CHECKOUT',
        ttlSeconds: 900,
        items: [{ skuId: SKU_B, qty: 2 }],
      },
      'corr-rel',
    );
    expect(db.state.stockLevels.find((s) => s.sku_id === SKU_B)!.available_qty).toBe(0);

    const released = await service.releaseReservation(resB.reservationId);
    expect(released.status).toBe(ReservationStatus.RELEASED);
    expect(db.state.stockLevels.find((s) => s.sku_id === SKU_B)!.available_qty).toBe(2);

    const releasedReplay = await service.releaseReservation(resB.reservationId);
    expect(releasedReplay.idempotentReplay).toBe(true);
  });

  it('reclaims 15-minute expired reservations and restores available_qty with RELEASE_EXPIRED ledger entry', async () => {
    const { service, db } = createHarness();

    const reserved = await service.reserveStock(
      {
        idempotencyKey: 'idem-exp-1',
        referenceId: 'order-exp-1',
        reservationType: 'CHECKOUT',
        ttlSeconds: 900,
        items: [{ skuId: SKU_B, qty: 2 }],
      },
      'corr-exp',
    );
    expect(db.state.stockLevels.find((s) => s.sku_id === SKU_B)!.available_qty).toBe(0);

    // Force expire via test helper
    const expiredMarker = await service.testExpireReservation({ referenceId: 'order-exp-1' });
    expect(expiredMarker.reservationId).toBe(reserved.reservationId);

    // Run sweeper -> reclaims all 2 units
    const sweep = await service.runExpireSweep('corr-sweep');
    expect(sweep.expiredCount).toBe(1);
    expect(sweep.expiredReservationIds).toEqual([reserved.reservationId]);
    expect(sweep.restoredSkus).toEqual([{ skuId: SKU_B, restoredQty: 2, newAvailableQty: 2 }]);

    const rowB = db.state.stockLevels.find((s) => s.sku_id === SKU_B)!;
    expect(rowB.available_qty).toBe(2);
    expect(rowB.reserved_qty).toBe(0);
    expect(
      db.state.ledger.some((l) => l.reason === InventoryLedgerReason.RELEASE_EXPIRED && l.delta_available === 2),
    ).toBe(true);

    // Sweeper returns empty when DB is not ready
    db.ready = false;
    expect((await service.runExpireSweep()).expiredCount).toBe(0);
  });

  it('validates manual ADJUSTMENT against negative available/damaged stock and writes immutable ledger entries', async () => {
    const { service, db } = createHarness();

    // Reject zero adjustment
    await expect(
      service.createAdjustment({ sku: SKU_A, warehouseCode: 'CENTRAL_WH', deltaAvailable: 0, deltaDamaged: 0, reasonCode: 'AUDIT' }),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_ERROR });

    // Reject negative resulting available_qty
    await expect(
      service.createAdjustment({ sku: SKU_A, warehouseCode: 'WH_HN_CENTRAL', deltaAvailable: -15, reasonCode: 'CYCLE_COUNT' }),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_ERROR });

    // Reject negative resulting damaged_qty
    await expect(
      service.createAdjustment({ sku: SKU_A, warehouseCode: 'CENTRAL_WH', deltaDamaged: -5, reasonCode: 'SCRAP' }),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_ERROR });

    // Valid adjustment via alias + SKU code
    const adj = await service.createAdjustment({
      sku: 'AT-BLZ-M',
      warehouseCode: 'WH_HN_CENTRAL',
      deltaAvailable: 5,
      deltaDamaged: -1,
      reasonCode: 'cycle_count',
      actorId: 'admin-1',
      actorEmail: 'warehouse@atelier.vn',
    });

    expect(adj.before.availableQty).toBe(10);
    expect(adj.after.availableQty).toBe(15);
    expect(adj.before.damagedQty).toBe(1);
    expect(adj.after.damagedQty).toBe(0);
    expect(adj.ledgerEntry.reason).toBe(InventoryLedgerReason.ADJUSTMENT);
    expect(adj.ledgerEntry.reasonCode).toBe('CYCLE_COUNT');
    expect(adj.ledgerEntry.referenceId).toMatch(/^ADJ-/);
    expect(db.state.ledger.some((l) => l.id === adj.ledgerEntry.id)).toBe(true);
  });

  it('executes atomic inter-warehouse transfer (CENTRAL_WH -> HN_ATELIER) with deadlock-safe lock order and paired ledger rows', async () => {
    const { service, db } = createHarness();

    // Reject same warehouse (even via alias)
    await expect(
      service.createTransfer({
        sku: SKU_A,
        fromWarehouseCode: 'WH_HN_CENTRAL',
        toWarehouseCode: 'CENTRAL_WH',
        quantity: 2,
      }),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_ERROR });

    // Reject non-positive quantity
    await expect(
      service.createTransfer({
        sku: SKU_A,
        fromWarehouseCode: 'CENTRAL_WH',
        toWarehouseCode: 'HN_ATELIER',
        quantity: 0,
      }),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_ERROR });

    // Reject insufficient stock
    await expect(
      service.createTransfer({
        sku: SKU_A,
        fromWarehouseCode: 'HN_ATELIER',
        toWarehouseCode: 'CENTRAL_WH',
        quantity: 99,
      }),
    ).rejects.toMatchObject({ code: ErrorCode.INSUFFICIENT_STOCK });

    // Valid transfer CENTRAL_WH (10) -> HN_ATELIER (4), qty 3 => (7) & (7)
    const trf = await service.createTransfer({
      sku: SKU_A,
      fromWarehouseCode: 'CENTRAL_WH',
      toWarehouseCode: 'HN_ATELIER',
      quantity: 3,
      note: 'Bổ sung trưng bày Showroom HN',
      actorEmail: 'warehouse@atelier.vn',
    });

    expect(trf.transferRef).toMatch(/^TRF-/);
    expect(trf.fromBefore.availableQty).toBe(10);
    expect(trf.fromAfter.availableQty).toBe(7);
    expect(trf.toBefore.availableQty).toBe(4);
    expect(trf.toAfter.availableQty).toBe(7);

    const [outEntry, inEntry] = trf.ledgerEntries;
    expect(outEntry.reason).toBe(InventoryLedgerReason.TRANSFER_OUT);
    expect(outEntry.deltaAvailable).toBe(-3);
    expect(inEntry.reason).toBe(InventoryLedgerReason.TRANSFER_IN);
    expect(inEntry.deltaAvailable).toBe(3);
    expect(outEntry.transferRef).toBe(trf.transferRef);
    expect(inEntry.transferRef).toBe(trf.transferRef);

    // Verify deterministic ascending warehouse_id lock query was issued
    const lockQuery = db.queryLog.find((q) => q.sql.includes('ORDER BY warehouse_id ASC') && q.sql.includes('FOR UPDATE'));
    expect(lockQuery).toBeDefined();
    expect(lockQuery?.params[1]).toEqual([WH_CENTRAL_ID, WH_HN_ID].sort());
  });

  it('supports availability queries, warehouses CRUD, safety threshold, RMA restock, catalog sync, ops summary & admin views', async () => {
    const { service } = createHarness();

    const avail = await service.getBatchAvailability({ skuIds: [SKU_A, SKU_B] });
    expect(avail.items[SKU_A]?.availableQty).toBe(14);
    expect(avail.items[SKU_B]?.lowStockWarning).toBe(true);

    const createdWh = await service.createWarehouse({
      code: 'DN_HUB',
      name: 'Kho Đà Nẵng',
      city: 'Đà Nẵng',
    });
    expect(createdWh.provinceCode).toBe('DN');

    const updatedWh = await service.updateWarehouse('DN_HUB', { name: 'Kho Miền Trung', isActive: false });
    expect(updatedWh.after.name).toBe('Kho Miền Trung');
    expect(updatedWh.after.isActive).toBe(false);

    const thresholdRes = await service.updateSafetyThreshold({ sku: SKU_A, safetyThreshold: 8 });
    expect(thresholdRes.updatedRows).toHaveLength(2);
    expect(thresholdRes.updatedRows.every((r) => r.safetyThreshold === 8)).toBe(true);

    const restockGood = await service.rmaRestock({ skuId: SKU_A, qty: 2, restockable: true, warehouseCode: 'HN_ATELIER' });
    expect(restockGood.availableQty).toBe(6);

    const restockBad = await service.rmaRestock({ skuId: SKU_A, qty: 1, restockable: false, warehouseCode: 'HN_ATELIER' });
    expect(restockBad.damagedQty).toBe(1);

    const syncRes = await service.syncCatalogSkus([
      { skuId: SKU_A, productId: PROD_A, skuCode: 'AT-BLZ-M' }, // existing -> skipped
      { skuId: '20000000-0000-4000-8000-000000000099', productId: PROD_A, skuCode: 'AT-AOBLLI-C1-M' }, // flagship low stock
      { skuId: '20000000-0000-4000-8000-000000000098', productId: PROD_B, skuCode: 'AT-NEW-L', defaultQty: 20 },
    ]);
    expect(syncRes.skippedExistingCount).toBe(1);
    expect(syncRes.insertedSkuCount).toBe(2);

    const testSet = await service.testSetStock({ skuId: SKU_B, availableQty: 9 });
    expect(testSet.availableQty).toBe(9);

    const summary = await service.getOpsSummary();
    expect(summary.totalSkus).toBeGreaterThanOrEqual(3);
    expect(summary.pendingAiDraftPosCount).toBe(2);

    expect((await service.listAdminWarehouses()).length).toBeGreaterThanOrEqual(4);
    expect((await service.listAdminStockLevels({ lowStockOnly: false })).length).toBeGreaterThan(0);
    expect(await service.listAdminReservations({})).toEqual([]);
    expect((await service.listAdminLedger({ page: 1, limit: 20 })).items.length).toBeGreaterThan(0);

    service.onModuleInit();
    service.onModuleDestroy();

    // Production guard for testSetStock
    const prodHarness = createHarness({ nodeEnv: 'production' });
    await expect(
      prodHarness.service.testSetStock({ skuId: SKU_A, availableQty: 5 }),
    ).rejects.toMatchObject({ code: ErrorCode.FORBIDDEN });
  });
});
