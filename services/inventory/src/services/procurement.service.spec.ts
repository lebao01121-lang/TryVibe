import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ErrorCode,
  InventoryLedgerReason,
  PurchaseOrderCreatedSource,
  PurchaseOrderStatus,
  SupplierPayableStatus,
  SupplierStatus,
} from '@atelier/contracts';
import type { AtelierDbExecutor } from '@atelier/db-client';
import type { InventoryConfig } from '../config/env';
import type { InventoryDatabaseService } from '../infra/database.service';
import type { InventoryRabbitMqService } from '../infra/rabbitmq.service';
import type { InventoryRedisService } from '../infra/redis.service';
import { ProcurementService } from './procurement.service';

const SUP_A_ID = '40000000-0000-4000-8000-000000000001';
const SUP_B_ID = '40000000-0000-4000-8000-000000000002';
const WH_CENTRAL_ID = '10000000-0000-4000-8000-000000000001';
const SKU_1 = '20000000-0000-4000-8000-000000000001';
const SKU_2 = '20000000-0000-4000-8000-000000000002';
const PROD_1 = '30000000-0000-4000-8000-000000000001';
const PROD_2 = '30000000-0000-4000-8000-000000000002';

interface MockSupplier {
  id: string;
  code: string;
  name: string;
  contact_name: string | null;
  contact_email: string;
  contact_phone: string | null;
  address: string | null;
  lead_time_days: number;
  payment_terms_days: number;
  defect_rate_pct: number;
  status: SupplierStatus;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

interface MockPo {
  id: string;
  po_number: string;
  supplier_id: string;
  warehouse_id: string;
  status: PurchaseOrderStatus;
  created_source: 'USER' | 'AI_COPILOT';
  expected_delivery_date: string;
  confirmed_delivery_date: string | null;
  supplier_note: string | null;
  total_amount_vnd: number;
  notes: string | null;
  rationale: string | null;
  created_by: string | null;
  approved_by: string | null;
  approved_at: string | null;
  confirmed_by: string | null;
  confirmed_at: string | null;
  cancel_reason: string | null;
  cancelled_by: string | null;
  cancelled_at: string | null;
  supplier_rejection_reason: string | null;
  proposed_delivery_date: string | null;
  rejected_by: string | null;
  rejected_at: string | null;
  created_at: string;
  updated_at: string;
}

interface MockPoItem {
  id: string;
  po_id: string;
  sku_id: string;
  sku_code: string;
  product_id: string;
  product_name: string | null;
  ordered_qty: number;
  received_qty: number;
  received_accepted_qty: number;
  rejected_defect_qty: number;
  unit_cost_vnd: number;
}

interface MockGrn {
  id: string;
  grn_number: string;
  po_id: string;
  warehouse_id: string;
  inspected_by: string | null;
  notes: string | null;
  created_at: string;
}

interface MockGrnItem {
  id: string;
  grn_id: string;
  po_item_id: string;
  sku_id: string;
  received_qty: number;
  accepted_qty: number;
  rejected_defect_qty: number;
  batch_code: string;
}

interface MockPayable {
  id: string;
  supplier_id: string;
  grn_id: string;
  po_id: string;
  amount_payable_vnd: number;
  status: SupplierPayableStatus;
  due_date: string;
  bank_reference: string | null;
  paid_at: string | null;
  paid_by: string | null;
  settlement_note: string | null;
  created_at: string;
}

interface MockStock {
  sku_id: string;
  warehouse_id: string;
  product_id: string;
  sku_code: string;
  available_qty: number;
  damaged_qty: number;
}

interface ProcurementDbState {
  suppliers: MockSupplier[];
  warehouses: Array<{ id: string; code: string; name: string; is_active: boolean; priority: number }>;
  stockLevels: MockStock[];
  purchaseOrders: MockPo[];
  purchaseOrderItems: MockPoItem[];
  goodsReceipts: MockGrn[];
  goodsReceiptItems: MockGrnItem[];
  payables: MockPayable[];
  ledger: Array<{ sku_id: string; delta_available: number; reason: string; reference_id: string }>;
  outbox: Array<{ id: string; event_name: string; published: boolean }>;
}

function createProcurementState(): ProcurementDbState {
  const now = new Date().toISOString();
  return {
    suppliers: [
      {
        id: SUP_A_ID,
        code: 'SUP_A',
        name: 'Xưởng Dệt Lụa Bảo Lộc',
        contact_name: 'Nguyễn Minh',
        contact_email: 'supplier-a@atelier.vn',
        contact_phone: '0901112222',
        address: 'Bảo Lộc, Lâm Đồng',
        lead_time_days: 7,
        payment_terms_days: 30,
        defect_rate_pct: 1.5,
        status: SupplierStatus.ACTIVE,
        is_active: true,
        created_at: now,
        updated_at: now,
      },
      {
        id: SUP_B_ID,
        code: 'SUP_B',
        name: 'Xưởng May Linen Hà Nội',
        contact_name: 'Trần Lan',
        contact_email: 'supplier-b@atelier.vn',
        contact_phone: '0903334444',
        address: 'Hà Nội',
        lead_time_days: 5,
        payment_terms_days: 15,
        defect_rate_pct: 0.8,
        status: SupplierStatus.ACTIVE,
        is_active: true,
        created_at: now,
        updated_at: now,
      },
    ],
    warehouses: [
      { id: WH_CENTRAL_ID, code: 'CENTRAL_WH', name: 'Kho Tổng Trung Tâm', is_active: true, priority: 1 },
    ],
    stockLevels: [
      { sku_id: SKU_1, warehouse_id: WH_CENTRAL_ID, product_id: PROD_1, sku_code: 'AT-BLZ-M', available_qty: 2, damaged_qty: 0 },
      { sku_id: SKU_2, warehouse_id: WH_CENTRAL_ID, product_id: PROD_2, sku_code: 'AT-SLK-S', available_qty: 5, damaged_qty: 1 },
    ],
    purchaseOrders: [],
    purchaseOrderItems: [],
    goodsReceipts: [],
    goodsReceiptItems: [],
    payables: [],
    ledger: [],
    outbox: [],
  };
}

class InMemoryProcurementDb {
  public state: ProcurementDbState = createProcurementState();

  private joinPo(state: ProcurementDbState, po: MockPo) {
    const s = state.suppliers.find((x) => x.id === po.supplier_id)!;
    const w = state.warehouses.find((x) => x.id === po.warehouse_id)!;
    return {
      ...po,
      supplier_code: s.code,
      supplier_name: s.name,
      supplier_email: s.contact_email,
      warehouse_code: w.code,
    };
  }

  private exec<T>(state: ProcurementDbState, sql: string, params: unknown[] = []): { rows: T[]; rowCount: number } {
    const norm = sql.replace(/\s+/g, ' ').trim();
    const now = new Date().toISOString();

    // suppliers
    if (norm.startsWith('SELECT * FROM suppliers WHERE id = $1')) {
      const rows = state.suppliers.filter((s) => s.id === params[0]).slice(0, 1);
      return { rows: rows as unknown as T[], rowCount: rows.length };
    }
    if (norm.startsWith('SELECT * FROM suppliers WHERE UPPER(code) = UPPER($1) OR LOWER(contact_email)')) {
      const val = String(params[0]).toLowerCase();
      const rows = state.suppliers
        .filter((s) => s.code.toLowerCase() === val || s.contact_email.toLowerCase() === val)
        .slice(0, 1);
      return { rows: rows as unknown as T[], rowCount: rows.length };
    }
    if (norm.startsWith('SELECT * FROM suppliers WHERE UPPER(code) = UPPER($1) LIMIT 1')) {
      const val = String(params[0]).toUpperCase();
      const rows = state.suppliers.filter((s) => s.code.toUpperCase() === val).slice(0, 1);
      return { rows: rows as unknown as T[], rowCount: rows.length };
    }
    if (norm.startsWith('SELECT id FROM suppliers WHERE UPPER(code) = $1 AND id <> $2')) {
      const code = String(params[0]).toUpperCase();
      const rows = state.suppliers.filter((s) => s.code.toUpperCase() === code && s.id !== params[1]);
      return { rows: rows.map((s) => ({ id: s.id })) as unknown as T[], rowCount: rows.length };
    }
    if (norm.startsWith('SELECT id FROM suppliers WHERE UPPER(code) = $1')) {
      const code = String(params[0]).toUpperCase();
      const rows = state.suppliers.filter((s) => s.code.toUpperCase() === code);
      return { rows: rows.map((s) => ({ id: s.id })) as unknown as T[], rowCount: rows.length };
    }
    if (norm.startsWith('SELECT payment_terms_days FROM suppliers WHERE id = $1')) {
      const s = state.suppliers.find((x) => x.id === params[0]);
      return { rows: (s ? [{ payment_terms_days: s.payment_terms_days }] : []) as unknown as T[], rowCount: s ? 1 : 0 };
    }
    if (norm.startsWith('SELECT * FROM suppliers')) {
      return { rows: [...state.suppliers] as unknown as T[], rowCount: state.suppliers.length };
    }
    if (norm.startsWith('INSERT INTO suppliers')) {
      const row: MockSupplier = {
        id: String(params[0]),
        code: String(params[1]),
        name: String(params[2]),
        contact_name: (params[3] as string | null) ?? null,
        contact_email: String(params[4]),
        contact_phone: (params[5] as string | null) ?? null,
        address: (params[6] as string | null) ?? null,
        lead_time_days: Number(params[7]),
        payment_terms_days: Number(params[8]),
        defect_rate_pct: 0,
        status: params[9] as SupplierStatus,
        is_active: Boolean(params[10]),
        created_at: now,
        updated_at: now,
      };
      state.suppliers.push(row);
      return { rows: [row] as unknown as T[], rowCount: 1 };
    }
    if (norm.startsWith('UPDATE suppliers SET')) {
      const s = state.suppliers.find((x) => x.id === params[10]);
      if (!s) return { rows: [], rowCount: 0 };
      s.code = String(params[0]);
      s.name = String(params[1]);
      s.contact_name = (params[2] as string | null) ?? null;
      s.contact_email = String(params[3]);
      s.contact_phone = (params[4] as string | null) ?? null;
      s.address = (params[5] as string | null) ?? null;
      s.lead_time_days = Number(params[6]);
      s.payment_terms_days = Number(params[7]);
      s.status = params[8] as SupplierStatus;
      s.is_active = Boolean(params[9]);
      s.updated_at = now;
      return { rows: [s] as unknown as T[], rowCount: 1 };
    }

    // warehouses & stock_levels lookup
    if (norm.startsWith('SELECT id, code, name FROM warehouses WHERE UPPER(code) = $1')) {
      const code = String(params[0]).toUpperCase();
      const rows = state.warehouses.filter((w) => w.code.toUpperCase() === code).slice(0, 1);
      return { rows: rows as unknown as T[], rowCount: rows.length };
    }
    if (norm.startsWith('SELECT id, code, name FROM warehouses WHERE is_active = TRUE')) {
      const rows = state.warehouses.filter((w) => w.is_active).slice(0, 1);
      return { rows: rows as unknown as T[], rowCount: rows.length };
    }
    if (norm.startsWith('SELECT sku_id, sku_code, product_id FROM stock_levels WHERE sku_id = $1')) {
      const rows = state.stockLevels.filter((s) => s.sku_id === params[0]).slice(0, 1);
      return { rows: rows as unknown as T[], rowCount: rows.length };
    }
    if (norm.startsWith('SELECT sku_id, sku_code, product_id FROM stock_levels WHERE UPPER(sku_code) = UPPER($1)')) {
      const code = String(params[0]).toUpperCase();
      const rows = state.stockLevels.filter((s) => s.sku_code.toUpperCase() === code).slice(0, 1);
      return { rows: rows as unknown as T[], rowCount: rows.length };
    }
    if (norm.startsWith('SELECT sku_id, COALESCE(SUM(available_qty), 0)::int AS total_avail FROM stock_levels')) {
      const ids = params[0] as string[];
      const map = new Map<string, number>();
      for (const s of state.stockLevels) {
        if (ids.includes(s.sku_id)) map.set(s.sku_id, (map.get(s.sku_id) ?? 0) + s.available_qty);
      }
      const rows = [...map.entries()].map(([sku_id, total_avail]) => ({ sku_id, total_avail }));
      return { rows: rows as unknown as T[], rowCount: rows.length };
    }
    if (norm.startsWith('INSERT INTO stock_levels')) {
      const skuId = String(params[0]);
      const whId = String(params[1]);
      const acc = Number(params[4]);
      const rej = Number(params[5]);
      let row = state.stockLevels.find((s) => s.sku_id === skuId && s.warehouse_id === whId);
      if (row) {
        row.available_qty += acc;
        row.damaged_qty += rej;
      } else {
        row = {
          sku_id: skuId,
          warehouse_id: whId,
          product_id: String(params[2]),
          sku_code: String(params[3]),
          available_qty: acc,
          damaged_qty: rej,
        };
        state.stockLevels.push(row);
      }
      return { rows: [{ available_qty: row.available_qty, damaged_qty: row.damaged_qty }] as unknown as T[], rowCount: 1 };
    }

    // purchase_orders
    if (norm.startsWith('INSERT INTO purchase_orders')) {
      const po: MockPo = {
        id: String(params[0]),
        po_number: String(params[1]),
        supplier_id: String(params[2]),
        warehouse_id: String(params[3]),
        status: params[4] as PurchaseOrderStatus,
        created_source: params[5] as 'USER' | 'AI_COPILOT',
        expected_delivery_date: String(params[6]),
        confirmed_delivery_date: null,
        supplier_note: null,
        total_amount_vnd: Number(params[7]),
        notes: (params[8] as string | null) ?? null,
        rationale: (params[9] as string | null) ?? null,
        created_by: (params[10] as string | null) ?? null,
        approved_by: (params[11] as string | null) ?? null,
        approved_at: (params[12] as string | null) ?? null,
        confirmed_by: null,
        confirmed_at: null,
        cancel_reason: null,
        cancelled_by: null,
        cancelled_at: null,
        supplier_rejection_reason: null,
        proposed_delivery_date: null,
        rejected_by: null,
        rejected_at: null,
        created_at: now,
        updated_at: now,
      };
      state.purchaseOrders.push(po);
      return { rows: [], rowCount: 1 };
    }
    if (norm.startsWith('SELECT po.*, s.code AS supplier_code')) {
      let rows = [...state.purchaseOrders];
      if (norm.includes('WHERE po.id = $1')) {
        rows = rows.filter((p) => p.id === params[0]);
      } else if (norm.includes('WHERE po.po_number = $1')) {
        rows = rows.filter((p) => p.po_number === params[0]);
      } else {
        if (norm.includes("po.status <> 'NHAP_AI'")) {
          rows = rows.filter((p) => p.status !== PurchaseOrderStatus.NHAP_AI);
        }
        const statusMatch = norm.match(/po\.status = \$(\d+)/);
        if (statusMatch) rows = rows.filter((p) => p.status === params[Number(statusMatch[1]) - 1]);
        const supMatch = norm.match(/po\.supplier_id = \$(\d+)/);
        if (supMatch) rows = rows.filter((p) => p.supplier_id === params[Number(supMatch[1]) - 1]);
      }
      const joined = rows.map((p) => this.joinPo(state, p));
      return { rows: joined as unknown as T[], rowCount: joined.length };
    }
    if (norm.startsWith('UPDATE purchase_orders SET status = $1, approved_by = $2')) {
      const po = state.purchaseOrders.find((p) => p.id === params[2]);
      if (po) {
        po.status = params[0] as PurchaseOrderStatus;
        po.approved_by = (params[1] as string | null) ?? null;
        po.approved_at = now;
        po.updated_at = now;
      }
      return { rows: [], rowCount: po ? 1 : 0 };
    }
    if (norm.startsWith('UPDATE purchase_orders SET status = $1, cancel_reason = $2')) {
      const po = state.purchaseOrders.find((p) => p.id === params[3]);
      if (po) {
        po.status = params[0] as PurchaseOrderStatus;
        po.cancel_reason = String(params[1]);
        po.cancelled_by = (params[2] as string | null) ?? null;
        po.cancelled_at = now;
      }
      return { rows: [], rowCount: po ? 1 : 0 };
    }
    if (norm.startsWith('UPDATE purchase_orders SET status = $1, supplier_rejection_reason = $2')) {
      const po = state.purchaseOrders.find((p) => p.id === params[5] && p.supplier_id === params[6]);
      if (po) {
        po.status = params[0] as PurchaseOrderStatus;
        po.supplier_rejection_reason = String(params[1]);
        po.proposed_delivery_date = (params[2] as string | null) ?? null;
        po.supplier_note = String(params[3]);
        po.rejected_by = String(params[4]);
        po.rejected_at = now;
      }
      return { rows: [], rowCount: po ? 1 : 0 };
    }
    if (norm.startsWith('UPDATE purchase_orders SET status = $1, confirmed_delivery_date = $2')) {
      const po = state.purchaseOrders.find((p) => p.id === params[4] && p.supplier_id === params[5]);
      if (po) {
        po.status = params[0] as PurchaseOrderStatus;
        po.confirmed_delivery_date = String(params[1]);
        po.supplier_note = (params[2] as string | null) ?? null;
        po.confirmed_by = String(params[3]);
        po.confirmed_at = now;
      }
      return { rows: [], rowCount: po ? 1 : 0 };
    }
    if (norm.startsWith('UPDATE purchase_orders SET status = $1, updated_at = NOW() WHERE id = $2')) {
      const po = state.purchaseOrders.find((p) => p.id === params[1]);
      if (po) po.status = params[0] as PurchaseOrderStatus;
      return { rows: [], rowCount: po ? 1 : 0 };
    }

    // purchase_order_items
    if (norm.startsWith('INSERT INTO purchase_order_items')) {
      state.purchaseOrderItems.push({
        id: String(params[0]),
        po_id: String(params[1]),
        sku_id: String(params[2]),
        sku_code: String(params[3]),
        product_id: String(params[4]),
        product_name: (params[5] as string | null) ?? null,
        ordered_qty: Number(params[6]),
        received_qty: 0,
        received_accepted_qty: 0,
        rejected_defect_qty: 0,
        unit_cost_vnd: Number(params[7]),
      });
      return { rows: [], rowCount: 1 };
    }
    if (norm.startsWith('SELECT * FROM purchase_order_items WHERE po_id = $1')) {
      const rows = state.purchaseOrderItems.filter((it) => it.po_id === params[0]);
      return { rows: rows as unknown as T[], rowCount: rows.length };
    }
    if (norm.startsWith('UPDATE purchase_order_items SET received_qty')) {
      const it = state.purchaseOrderItems.find((x) => x.id === params[3]);
      if (it) {
        it.received_qty += Number(params[0]);
        it.received_accepted_qty += Number(params[1]);
        it.rejected_defect_qty += Number(params[2]);
      }
      return { rows: [], rowCount: it ? 1 : 0 };
    }

    // goods_receipts & items
    if (norm.startsWith('INSERT INTO goods_receipts')) {
      state.goodsReceipts.push({
        id: String(params[0]),
        grn_number: String(params[1]),
        po_id: String(params[2]),
        warehouse_id: String(params[3]),
        inspected_by: (params[4] as string | null) ?? null,
        notes: (params[5] as string | null) ?? null,
        created_at: now,
      });
      return { rows: [], rowCount: 1 };
    }
    if (norm.startsWith('INSERT INTO goods_receipt_items')) {
      state.goodsReceiptItems.push({
        id: String(params[0]),
        grn_id: String(params[1]),
        po_item_id: String(params[2]),
        sku_id: String(params[3]),
        received_qty: Number(params[4]),
        accepted_qty: Number(params[5]),
        rejected_defect_qty: Number(params[6]),
        batch_code: String(params[7]),
      });
      return { rows: [], rowCount: 1 };
    }
    if (norm.startsWith('SELECT gr.*, po.po_number, po.supplier_id, w.code AS warehouse_code')) {
      const rows = state.goodsReceipts
        .map((gr) => {
          const po = state.purchaseOrders.find((p) => p.id === gr.po_id)!;
          const w = state.warehouses.find((x) => x.id === gr.warehouse_id)!;
          return { ...gr, po_number: po.po_number, supplier_id: po.supplier_id, warehouse_code: w.code };
        })
        .filter((gr) => {
          const supMatch = norm.match(/po\.supplier_id = \$(\d+)/);
          if (supMatch && gr.supplier_id !== params[Number(supMatch[1]) - 1]) return false;
          return true;
        });
      return { rows: rows as unknown as T[], rowCount: rows.length };
    }
    if (norm.startsWith('SELECT * FROM goods_receipt_items WHERE grn_id = $1')) {
      const rows = state.goodsReceiptItems.filter((it) => it.grn_id === params[0]);
      return { rows: rows as unknown as T[], rowCount: rows.length };
    }

    // supplier_payables
    if (norm.startsWith('INSERT INTO supplier_payables')) {
      state.payables.push({
        id: String(params[0]),
        supplier_id: String(params[1]),
        grn_id: String(params[2]),
        po_id: String(params[3]),
        amount_payable_vnd: Number(params[4]),
        status: params[5] as SupplierPayableStatus,
        due_date: String(params[6]),
        bank_reference: null,
        paid_at: null,
        paid_by: null,
        settlement_note: null,
        created_at: now,
      });
      return { rows: [], rowCount: 1 };
    }
    if (norm.startsWith('SELECT id, amount_payable_vnd FROM supplier_payables WHERE grn_id = $1')) {
      const rows = state.payables.filter((p) => p.grn_id === params[0]).slice(0, 1);
      return { rows: rows as unknown as T[], rowCount: rows.length };
    }
    if (norm.startsWith('SELECT sp.*, po.po_number, gr.grn_number')) {
      let rows = state.payables.map((sp) => ({
        ...sp,
        po_number: state.purchaseOrders.find((p) => p.id === sp.po_id)?.po_number ?? null,
        grn_number: state.goodsReceipts.find((g) => g.id === sp.grn_id)?.grn_number ?? null,
        supplier_code: state.suppliers.find((s) => s.id === sp.supplier_id)?.code ?? null,
        supplier_name: state.suppliers.find((s) => s.id === sp.supplier_id)?.name ?? null,
      }));
      if (norm.includes('WHERE sp.id = $1')) {
        rows = rows.filter((r) => r.id === params[0]);
      } else {
        const supMatch = norm.match(/sp\.supplier_id = \$(\d+)/);
        if (supMatch) rows = rows.filter((r) => r.supplier_id === params[Number(supMatch[1]) - 1]);
        const statusMatch = norm.match(/sp\.status = \$(\d+)/);
        if (statusMatch) rows = rows.filter((r) => r.status === params[Number(statusMatch[1]) - 1]);
      }
      return { rows: rows as unknown as T[], rowCount: rows.length };
    }
    if (norm.startsWith('UPDATE supplier_payables SET status = $1')) {
      const p = state.payables.find((x) => x.id === params[5]);
      if (p) {
        p.status = params[0] as SupplierPayableStatus;
        p.bank_reference = String(params[1]);
        p.paid_at = String(params[2]);
        p.paid_by = (params[3] as string | null) ?? null;
        p.settlement_note = (params[4] as string | null) ?? null;
      }
      return { rows: [], rowCount: p ? 1 : 0 };
    }

    // ledger & outbox
    if (norm.startsWith('INSERT INTO inventory_ledger')) {
      state.ledger.push({
        sku_id: String(params[1]),
        delta_available: Number(params[3]),
        reason: String(params[5]),
        reference_id: String(params[6]),
      });
      return { rows: [], rowCount: 1 };
    }
    if (norm.startsWith('INSERT INTO outbox_events')) {
      state.outbox.push({ id: String(params[0]), event_name: String(params[1]), published: false });
      return { rows: [], rowCount: 1 };
    }
    if (norm.startsWith('UPDATE outbox_events SET published = TRUE')) {
      const e = state.outbox.find((x) => x.id === params[0]);
      if (e) e.published = true;
      return { rows: [], rowCount: e ? 1 : 0 };
    }

    return { rows: [], rowCount: 0 };
  }

  async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<{ rows: T[]; rowCount: number }> {
    return this.exec<T>(this.state, sql, params);
  }

  async transaction<T>(fn: (tx: AtelierDbExecutor) => Promise<T>): Promise<T> {
    const snap = structuredClone(this.state);
    const tx = {
      query: async <R = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
        this.exec<R>(snap, sql, params),
    } as unknown as AtelierDbExecutor;
    const res = await fn(tx);
    this.state = snap;
    return res;
  }
}

function createProcurementHarness() {
  const db = new InMemoryProcurementDb();
  const redis = {
    setStockAvailable: vi.fn(async () => true),
  } as unknown as InventoryRedisService;
  const rabbitmq = {
    publishDomainEvent: vi.fn(async () => true),
  } as unknown as InventoryRabbitMqService;
  const config: InventoryConfig = {
    serviceName: '@atelier/inventory',
    boundedContext: 'inventory',
    port: 4004,
    nodeEnv: 'test',
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

  const service = new ProcurementService(
    config,
    db as unknown as InventoryDatabaseService,
    redis,
    rabbitmq,
  );
  return { service, db, redis, rabbitmq };
}

describe('ProcurementService — Multi-SKU PO, Supplier Ownership Lock & GRN Defect Split', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('calculates multi-SKU PO totals accurately, enforces AI NHAP_AI lock, and enforces supplier ownership lock on reject/confirm', async () => {
    const { service } = createProcurementHarness();

    // 1. AI Copilot draft PO is strictly locked to NHAP_AI
    const aiPo = await service.createPurchaseOrder(
      {
        supplierId: SUP_A_ID,
        warehouseCode: 'WH_HN_CENTRAL',
        expectedDeliveryDate: '2026-12-05',
        createdSource: PurchaseOrderCreatedSource.AI_COPILOT,
        rationale: 'Tồn kho thấp dưới safety threshold',
        items: [
          { skuId: SKU_1, skuCode: 'AT-BLZ-M', orderedQty: 20, unitCostVnd: 500_000 },
          { skuId: 'AT-SLK-S', orderedQty: 10, unitCostVnd: 800_000 },
        ],
      },
      { forceAiDraft: true, actorId: 'ai-copilot', correlationId: 'corr-po-1' },
    );

    expect(aiPo.status).toBe(PurchaseOrderStatus.NHAP_AI);
    expect(aiPo.requiresHumanApproval).toBe(true);
    expect(aiPo.createdSource).toBe(PurchaseOrderCreatedSource.AI_COPILOT);
    expect(aiPo.warehouseCode).toBe('CENTRAL_WH');
    // 20 * 500_000 + 10 * 800_000 = 18_000_000 VND
    expect(aiPo.totalAmountVnd).toBe(18_000_000);
    expect(aiPo.totalOrderedQty).toBe(30);

    // Supplier MUST NOT see or access NHAP_AI draft
    expect(await service.listPartnerPurchaseOrders(SUP_A_ID)).toEqual([]);
    expect(await service.listPartnerPurchaseOrders(SUP_A_ID, PurchaseOrderStatus.NHAP_AI)).toEqual([]);
    await expect(service.getPartnerPurchaseOrder(SUP_A_ID, aiPo.id)).rejects.toMatchObject({
      code: ErrorCode.PO_DRAFT_FORBIDDEN_FOR_SUPPLIER,
    });
    await expect(
      service.rejectPartnerPurchaseOrder(
        SUP_A_ID,
        aiPo.id,
        { reason: 'Cannot deliver' },
        { correlationId: 'corr-rej-draft' },
      ),
    ).rejects.toMatchObject({ code: ErrorCode.PO_DRAFT_FORBIDDEN_FOR_SUPPLIER });

    // Human submits NHAP_AI -> CHO_NCC_XAC_NHAN
    const submitted = await service.submitPurchaseOrder(aiPo.id, {
      actorId: 'wh-mgr-1',
      correlationId: 'corr-sub',
    });
    expect(submitted.status).toBe(PurchaseOrderStatus.CHO_NCC_XAC_NHAN);

    // Supplier ownership lock: SUP_B CANNOT reject or confirm SUP_A's PO!
    await expect(
      service.rejectPartnerPurchaseOrder(
        SUP_B_ID,
        aiPo.id,
        { reason: 'Cross-tenant reject attempt' },
        { correlationId: 'corr-idor' },
      ),
    ).rejects.toMatchObject({ code: ErrorCode.FORBIDDEN });

    await expect(
      service.confirmPartnerPurchaseOrder(
        SUP_B_ID,
        aiPo.id,
        { confirmedDeliveryDate: '2026-12-06' },
        { correlationId: 'corr-idor-2' },
      ),
    ).rejects.toMatchObject({ code: ErrorCode.FORBIDDEN });

    // SUP_A confirms PO cleanly
    const confirmed = await service.confirmPartnerPurchaseOrder(
      SUP_A_ID,
      aiPo.id,
      { confirmedDeliveryDate: '2026-12-06', supplierNote: 'Đủ nguyên liệu' },
      { actorId: 'sup-user-a', correlationId: 'corr-conf' },
    );
    expect(confirmed.status).toBe(PurchaseOrderStatus.NCC_DA_XAC_NHAN);

    // SUP_A can also reject another PO with proposed delivery date
    const po2 = await service.createPurchaseOrder(
      {
        supplierId: SUP_A_ID,
        warehouseCode: 'CENTRAL_WH',
        expectedDeliveryDate: '2026-12-08',
        createdSource: PurchaseOrderCreatedSource.USER,
        items: [{ skuId: SKU_1, orderedQty: 5, unitCostVnd: 500_000 }],
      },
      { forceAiDraft: false, actorId: 'admin-1', correlationId: 'corr-po-2' },
    );
    const rejected = await service.rejectPartnerPurchaseOrder(
      SUP_A_ID,
      po2.id,
      { reason: 'Xưởng quá tải tuần này', proposedDeliveryDate: '2026-12-15' },
      { actorId: 'sup-user-a', correlationId: 'corr-rej' },
    );
    expect(rejected.after.status).toBe(PurchaseOrderStatus.SUPPLIER_REJECTED);
    expect(rejected.after.proposedDeliveryDate).toBe('2026-12-15');
  });

  it('enforces GRN defect-split formula: updates available vs damaged balances and computes payable strictly on acceptedQty', async () => {
    const { service, db } = createProcurementHarness();

    const po = await service.createPurchaseOrder(
      {
        supplierId: SUP_A_ID,
        warehouseCode: 'CENTRAL_WH',
        expectedDeliveryDate: '2026-12-05',
        createdSource: PurchaseOrderCreatedSource.USER,
        items: [
          { skuId: SKU_1, skuCode: 'AT-BLZ-M', orderedQty: 20, unitCostVnd: 500_000 },
          { skuId: SKU_2, skuCode: 'AT-SLK-S', orderedQty: 10, unitCostVnd: 800_000 },
        ],
      },
      { forceAiDraft: false, actorId: 'wh-mgr-1', correlationId: 'corr-grn-po' },
    );

    const item1 = po.items.find((i) => i.skuId === SKU_1)!;
    const item2 = po.items.find((i) => i.skuId === SKU_2)!;

    // Hard validation: acceptedQty + rejectedDefectQty > receivedQty MUST fail
    await expect(
      service.createGoodsReceipt(
        {
          poId: po.id,
          warehouseCode: 'CENTRAL_WH',
          items: [
            {
              poItemId: item1.id,
              skuId: SKU_1,
              receivedQty: 10,
              acceptedQty: 8,
              rejectedDefectQty: 3, // 8 + 3 = 11 > 10
              batchCode: 'BATCH-ERR',
            },
          ],
        },
        { actorId: 'wh-mgr-1', correlationId: 'corr-err' },
      ),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_ERROR });

    // Valid Defect Split GRN #1:
    // SKU_1: received 20 -> accepted 17, rejectedDefect 3 (unitCost 500,000 -> 8,500,000 payable)
    // SKU_2: received 10 -> accepted 10, rejectedDefect 0 (unitCost 800,000 -> 8,000,000 payable)
    const grn1 = await service.createGoodsReceipt(
      {
        poId: po.id,
        warehouseCode: 'CENTRAL_WH',
        note: '3 áo blazer lỗi đường chỉ',
        items: [
          {
            poItemId: item1.id,
            skuId: SKU_1,
            receivedQty: 20,
            acceptedQty: 17,
            rejectedDefectQty: 3,
            batchCode: 'LOT-2026-A1',
          },
          {
            poItemId: item2.id,
            skuId: SKU_2,
            receivedQty: 10,
            acceptedQty: 10,
            rejectedDefectQty: 0,
            batchCode: 'LOT-2026-A2',
          },
        ],
      },
      { actorId: 'wh-mgr-1', correlationId: 'corr-grn-1' },
    );

    expect(grn1.totalAcceptedQty).toBe(27);
    expect(grn1.totalRejectedQty).toBe(3);
    // Payable strictly on acceptedQty: 17*500k + 10*800k = 16,500,000 (NOT 18,000,000!)
    expect(grn1.payableAmountVnd).toBe(16_500_000);
    expect(grn1.poStatus).toBe(PurchaseOrderStatus.HOAN_TAT_MOT_PHAN);

    // Check stock balances: SKU_1 started (avail=2, dmg=0) -> (avail=19, dmg=3)
    const stock1 = db.state.stockLevels.find((s) => s.sku_id === SKU_1)!;
    const stock2 = db.state.stockLevels.find((s) => s.sku_id === SKU_2)!;
    expect(stock1.available_qty).toBe(19);
    expect(stock1.damaged_qty).toBe(3);
    expect(stock2.available_qty).toBe(15);
    expect(stock2.damaged_qty).toBe(1);

    // Ledger strictly logs acceptedQty for GRN_INBOUND
    expect(
      db.state.ledger.find((l) => l.sku_id === SKU_1 && l.reason === InventoryLedgerReason.GRN_INBOUND)?.delta_available,
    ).toBe(17);

    // Second GRN accepting remaining 3 units completes the PO -> HOAN_TAT
    const grn2 = await service.createGoodsReceipt(
      {
        poId: po.id,
        warehouseCode: 'CENTRAL_WH',
        items: [
          {
            poItemId: item1.id,
            skuId: SKU_1,
            receivedQty: 3,
            acceptedQty: 3,
            rejectedDefectQty: 0,
            batchCode: 'LOT-2026-A3',
          },
        ],
      },
      { actorId: 'wh-mgr-1', correlationId: 'corr-grn-2' },
    );
    expect(grn2.payableAmountVnd).toBe(1_500_000);
    expect(grn2.poStatus).toBe(PurchaseOrderStatus.HOAN_TAT);

    // List GRNs & Payables + Mark Payable Paid
    const grnList = await service.listGoodsReceipts({ supplierId: SUP_A_ID });
    expect(grnList).toHaveLength(2);

    const payables = await service.listPayables({ supplierId: SUP_A_ID, status: SupplierPayableStatus.UNPAID });
    expect(payables).toHaveLength(2);

    const settled = await service.markPayablePaid(
      grn1.payableId!,
      { bankReference: 'VCB-FT20261125-001', note: 'Thanh toán đợt 1', actorId: 'admin-1' },
      { correlationId: 'corr-pay' },
    );
    expect(settled.before.status).toBe(SupplierPayableStatus.UNPAID);
    expect(settled.after.status).toBe(SupplierPayableStatus.PAID);
    expect(settled.after.bankReference).toBe('VCB-FT20261125-001');

    // Double-paying same payable throws CONFLICT
    await expect(
      service.markPayablePaid(
        grn1.payableId!,
        { bankReference: 'VCB-DUP' },
        { correlationId: 'corr-pay-dup' },
      ),
    ).rejects.toMatchObject({ code: ErrorCode.CONFLICT });
  });

  it('supports supplier CRUD, PO cancellation guards, and non-UUID filters cleanly', async () => {
    const { service } = createProcurementHarness();

    expect((await service.listSuppliers()).length).toBe(2);

    const created = await service.createSupplier({
      code: 'sup_c',
      name: 'Xưởng Tweed Đà Lạt',
      contactEmail: 'SUP-C@ATELIER.VN',
      leadTimeDays: 10,
      paymentTermsDays: 45,
    });
    expect(created.code).toBe('SUP_C');
    expect(created.contactEmail).toBe('sup-c@atelier.vn');

    // Duplicate supplier code rejected
    await expect(
      service.createSupplier({ code: 'SUP_C', name: 'Dup', contactEmail: 'dup@atelier.vn' }),
    ).rejects.toMatchObject({ code: ErrorCode.CONFLICT });

    // Invalid supplier code rejected
    await expect(
      service.createSupplier({ code: '!', name: 'Bad', contactEmail: 'bad@atelier.vn' }),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_ERROR });

    const updated = await service.updateSupplier('SUP_C', { status: SupplierStatus.SUSPENDED });
    expect(updated.after.isActive).toBe(false);

    // Create & cancel PO
    const po = await service.createPurchaseOrder(
      {
        supplierId: SUP_B_ID,
        warehouseCode: 'CENTRAL_WH',
        expectedDeliveryDate: '2026-12-10',
        createdSource: PurchaseOrderCreatedSource.USER,
        items: [{ skuId: SKU_1, orderedQty: 5, unitCostVnd: 400_000 }],
      },
      { forceAiDraft: false, actorId: 'admin-1', correlationId: 'corr-cancel-1' },
    );

    const cancelled = await service.cancelPurchaseOrder(
      po.id,
      { reason: 'Đổi kế hoạch bộ sưu tập', actorId: 'admin-1' },
      { correlationId: 'corr-cancel-2' },
    );
    expect(cancelled.after.status).toBe(PurchaseOrderStatus.CANCELLED);

    // Cannot cancel already cancelled PO or create GRN for it
    await expect(
      service.cancelPurchaseOrder(po.id, { reason: 'again' }, { correlationId: 'c3' }),
    ).rejects.toMatchObject({ code: ErrorCode.CONFLICT });
    await expect(
      service.createGoodsReceipt(
        {
          poId: po.id,
          warehouseCode: 'CENTRAL_WH',
          items: [{ poItemId: po.items[0]!.id, skuId: SKU_1, receivedQty: 1, acceptedQty: 1, rejectedDefectQty: 0, batchCode: 'B1' }],
        },
        { correlationId: 'c4' },
      ),
    ).rejects.toMatchObject({ code: ErrorCode.CONFLICT });

    expect(await service.getPurchaseOrderById(po.poNumber)).toMatchObject({ id: po.id });
    expect(await service.listPurchaseOrders({ supplierId: 'not-a-uuid' })).toEqual([]);
    expect(await service.listGoodsReceipts({ supplierId: 'not-a-uuid' })).toEqual([]);
    expect(await service.listPayables({ supplierId: 'not-a-uuid' })).toEqual([]);
  });
});
