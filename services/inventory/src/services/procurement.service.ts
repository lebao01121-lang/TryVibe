import * as crypto from 'node:crypto';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import {
  createEventEnvelope,
  ErrorCode,
  EVENT_NAMES,
  InventoryLedgerReason,
  PurchaseOrderCreatedSource,
  PurchaseOrderStatus,
  SupplierPayableStatus,
  type ConfirmPurchaseOrderBySupplierDTO,
  type CreateGoodsReceiptDTO,
  type CreatePurchaseOrderDTO,
  type GoodsReceiptDTO,
  type PurchaseOrderDTO,
  type PurchaseOrderItemDTO,
  type PurchaseOrderStatus as PurchaseOrderStatusValue,
  type SupplierDTO,
  type SupplierPayableDTO,
  type SupplierPayableStatus as SupplierPayableStatusValue,
  type SupplierStatus as SupplierStatusValue,
} from '@atelier/contracts';
import type { AtelierDbExecutor } from '@atelier/db-client';
import { createChildTraceparent, createLogger } from '@atelier/observability';
import { ApiDomainException } from '../common/api-exception';
import { INVENTORY_CONFIG_TOKEN, SERVICE_NAME, type InventoryConfig } from '../config/env';
import { InventoryDatabaseService } from '../infra/database.service';
import { InventoryRabbitMqService } from '../infra/rabbitmq.service';
import { InventoryRedisService } from '../infra/redis.service';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const WAREHOUSE_CODE_ALIASES: Record<string, string> = {
  WH_HN_CENTRAL: 'CENTRAL_WH',
  HN_CENTRAL: 'CENTRAL_WH',
  CENTRAL: 'CENTRAL_WH',
  CENTRAL_WH: 'CENTRAL_WH',
  WH_HN: 'HN_ATELIER',
  HN: 'HN_ATELIER',
  HN_ATELIER: 'HN_ATELIER',
  WH_HCM: 'HCM_SHOWROOM',
  HCM: 'HCM_SHOWROOM',
  HCM_SHOWROOM: 'HCM_SHOWROOM',
};

interface SupplierRow {
  id: string;
  code: string;
  name: string;
  contact_email: string;
  lead_time_days: number;
  defect_rate_pct: string | number;
  status: SupplierStatusValue;
}

interface WarehouseRow {
  id: string;
  code: string;
  name: string;
}

interface PurchaseOrderJoinedRow {
  id: string;
  po_number: string;
  supplier_id: string;
  supplier_code: string;
  supplier_name: string;
  supplier_email: string;
  warehouse_id: string;
  warehouse_code: string;
  status: PurchaseOrderStatusValue;
  created_source: 'USER' | 'AI_COPILOT';
  expected_delivery_date: string;
  confirmed_delivery_date: string | null;
  supplier_note: string | null;
  total_amount_vnd: string | number;
  notes: string | null;
  rationale: string | null;
  created_by: string | null;
  approved_by: string | null;
  approved_at: Date | string | null;
  confirmed_by: string | null;
  confirmed_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface PurchaseOrderItemRow {
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
  unit_cost_vnd: string | number;
}

interface GoodsReceiptJoinedRow {
  id: string;
  grn_number: string;
  po_id: string;
  po_number: string;
  supplier_id: string;
  warehouse_id: string;
  warehouse_code: string;
  inspected_by: string | null;
  notes: string | null;
  created_at: Date | string;
}

interface GoodsReceiptItemRow {
  id: string;
  grn_id: string;
  po_item_id: string;
  sku_id: string;
  received_qty: number;
  accepted_qty: number;
  rejected_defect_qty: number;
  batch_code: string;
}

interface SupplierPayableRow {
  id: string;
  supplier_id: string;
  grn_id: string;
  po_id: string;
  amount_payable_vnd: string | number;
  status: SupplierPayableStatusValue;
  due_date: string;
  created_at: Date | string;
}

export interface PurchaseOrderExtendedDto extends PurchaseOrderDTO {
  totalAmountVnd: number;
  notes: string | null;
}

export interface GoodsReceiptExtendedDto extends GoodsReceiptDTO {
  poStatus?: PurchaseOrderStatusValue;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function formatDateYmd(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function generateDocumentNumber(prefix: 'PO' | 'GRN'): string {
  const ymd = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const suffix = crypto.randomBytes(3).toString('hex').toUpperCase();
  return `${prefix}-${ymd}-${suffix}`;
}

@Injectable()
export class ProcurementService {
  private readonly logger = createLogger('@atelier/inventory:procurement');

  constructor(
    @Inject(INVENTORY_CONFIG_TOKEN) private readonly config: InventoryConfig,
    private readonly db: InventoryDatabaseService,
    private readonly redis: InventoryRedisService,
    private readonly rabbitmq: InventoryRabbitMqService,
  ) {}

  async listSuppliers(): Promise<SupplierDTO[]> {
    const res = await this.db.query<SupplierRow>(
      'SELECT * FROM suppliers ORDER BY code ASC',
    );
    return res.rows.map((row) => ({
      id: row.id,
      code: row.code,
      name: row.name,
      contactEmail: row.contact_email,
      leadTimeDays: Number(row.lead_time_days),
      defectRatePct: Number(row.defect_rate_pct),
      status: row.status,
    }));
  }

  async listPurchaseOrders(filters: {
    status?: string;
    supplierId?: string;
    createdSource?: string;
    excludeAiDraft?: boolean;
  }): Promise<PurchaseOrderExtendedDto[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filters.excludeAiDraft) {
      conditions.push(`po.status <> '${PurchaseOrderStatus.NHAP_AI}'`);
    }

    if (filters.status && filters.status.trim()) {
      params.push(filters.status.trim().toUpperCase());
      conditions.push(`po.status = $${params.length}`);
    }

    if (filters.supplierId && filters.supplierId.trim()) {
      if (!UUID_REGEX.test(filters.supplierId.trim())) {
        return [];
      }
      params.push(filters.supplierId.trim());
      conditions.push(`po.supplier_id = $${params.length}`);
    }

    if (filters.createdSource && filters.createdSource.trim()) {
      params.push(filters.createdSource.trim().toUpperCase());
      conditions.push(`po.created_source = $${params.length}`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const res = await this.db.query<PurchaseOrderJoinedRow>(
      `SELECT po.*,
              s.code AS supplier_code,
              s.name AS supplier_name,
              s.contact_email AS supplier_email,
              w.code AS warehouse_code
       FROM purchase_orders po
       INNER JOIN suppliers s ON s.id = po.supplier_id
       INNER JOIN warehouses w ON w.id = po.warehouse_id
       ${whereClause}
       ORDER BY po.created_at DESC
       LIMIT 200`,
      params,
    );

    const out: PurchaseOrderExtendedDto[] = [];
    for (const row of res.rows) {
      out.push(await this.hydratePurchaseOrder(row));
    }
    return out;
  }

  async getPurchaseOrderById(idOrNumber: string): Promise<PurchaseOrderExtendedDto> {
    const row = await this.fetchPurchaseOrderJoinedRow(idOrNumber);
    if (!row) {
      throw new ApiDomainException(
        HttpStatus.NOT_FOUND,
        ErrorCode.NOT_FOUND,
        `Không tìm thấy đơn đặt hàng nhập (PO) "${idOrNumber}".`,
      );
    }
    return this.hydratePurchaseOrder(row);
  }

  async createPurchaseOrder(
    input: CreatePurchaseOrderDTO & { status?: PurchaseOrderStatusValue },
    opts: {
      forceAiDraft: boolean;
      actorId?: string | null;
      correlationId: string;
      traceparent?: string;
    },
  ): Promise<PurchaseOrderExtendedDto> {
    const targetStatus: PurchaseOrderStatusValue = opts.forceAiDraft
      ? PurchaseOrderStatus.NHAP_AI
      : input.status === PurchaseOrderStatus.NHAP_AI
        ? PurchaseOrderStatus.NHAP_AI
        : PurchaseOrderStatus.CHO_NCC_XAC_NHAN;

    const createdSource = opts.forceAiDraft
      ? PurchaseOrderCreatedSource.AI_COPILOT
      : PurchaseOrderCreatedSource.USER;

    const created = await this.db.transaction(async (tx) => {
      const supplier = await this.resolveSupplier(tx, input.supplierId);
      const warehouse = await this.resolveWarehouse(tx, input.warehouseCode);

      const poId = crypto.randomUUID();
      const poNumber = generateDocumentNumber('PO');
      const expectedDate =
        input.expectedDeliveryDate?.trim() ||
        formatDateYmd(new Date(Date.now() + supplier.lead_time_days * 86_400_000));

      let totalAmountVnd = 0;
      const preparedItems: Array<{
        id: string;
        skuId: string;
        skuCode: string;
        productId: string;
        productName: string | null;
        orderedQty: number;
        unitCostVnd: number;
      }> = [];

      for (const rawItem of input.items) {
        const resolvedSku = await this.resolveSkuMetadata(tx, rawItem.skuId, rawItem.skuCode);
        const unitCost = Math.max(0, Math.round(rawItem.unitCostVnd));
        totalAmountVnd += rawItem.orderedQty * unitCost;
        preparedItems.push({
          id: crypto.randomUUID(),
          skuId: resolvedSku.skuId,
          skuCode: resolvedSku.skuCode,
          productId: resolvedSku.productId,
          productName: rawItem.productName ?? null,
          orderedQty: rawItem.orderedQty,
          unitCostVnd: unitCost,
        });
      }

      const approvedBy =
        targetStatus === PurchaseOrderStatus.CHO_NCC_XAC_NHAN ? (opts.actorId ?? null) : null;
      const approvedAt =
        targetStatus === PurchaseOrderStatus.CHO_NCC_XAC_NHAN ? new Date().toISOString() : null;

      await tx.query(
        `INSERT INTO purchase_orders (
          id, po_number, supplier_id, warehouse_id, status, created_source,
          expected_delivery_date, total_amount_vnd, notes, rationale,
          created_by, approved_by, approved_at, created_at, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6,
          $7, $8, $9, $10,
          $11, $12, $13, NOW(), NOW()
        )`,
        [
          poId,
          poNumber,
          supplier.id,
          warehouse.id,
          targetStatus,
          createdSource,
          expectedDate,
          totalAmountVnd,
          input.note ?? null,
          input.rationale ?? input.note ?? null,
          opts.actorId ?? null,
          approvedBy,
          approvedAt,
        ],
      );

      for (const item of preparedItems) {
        await tx.query(
          `INSERT INTO purchase_order_items (
            id, po_id, sku_id, sku_code, product_id, product_name,
            ordered_qty, received_qty, received_accepted_qty, rejected_defect_qty, unit_cost_vnd
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, 0, 0, 0, $8)`,
          [
            item.id,
            poId,
            item.skuId,
            item.skuCode,
            item.productId,
            item.productName,
            item.orderedQty,
            item.unitCostVnd,
          ],
        );
      }

      const row = await this.fetchPurchaseOrderJoinedRow(poId, tx);
      if (!row) {
        throw new Error('Failed to reload newly created Purchase Order');
      }
      const dto = await this.hydratePurchaseOrder(row, tx);
      return { dto, supplierEmail: supplier.contact_email, supplierName: supplier.name };
    });

    if (opts.forceAiDraft) {
      await this.recordAuthAuditLog({
        actorId: opts.actorId ?? null,
        actorType: 'AI_COPILOT',
        action: 'PO_DRAFT_CREATED',
        targetType: 'purchase_order',
        targetId: created.dto.id,
        metadataJson: {
          poNumber: created.dto.poNumber,
          supplierId: created.dto.supplierId,
          status: PurchaseOrderStatus.NHAP_AI,
          createdSource: PurchaseOrderCreatedSource.AI_COPILOT,
          totalCostVnd: created.dto.totalCostVnd ?? 0,
          itemCount: created.dto.items.length,
        },
        correlationId: opts.correlationId,
        traceparent: opts.traceparent,
      });
    } else if (targetStatus === PurchaseOrderStatus.CHO_NCC_XAC_NHAN) {
      await this.notifyAndAuditSubmittedPo(
        created.dto,
        created.supplierEmail,
        created.supplierName,
        opts.actorId ?? null,
        opts.correlationId,
        opts.traceparent,
      );
    }

    return created.dto;
  }

  async submitPurchaseOrder(
    poIdOrNumber: string,
    opts: { actorId?: string | null; correlationId: string; traceparent?: string },
  ): Promise<PurchaseOrderExtendedDto> {
    const result = await this.db.transaction(async (tx) => {
      const existing = await this.fetchPurchaseOrderJoinedRow(poIdOrNumber, tx, true);
      if (!existing) {
        throw new ApiDomainException(
          HttpStatus.NOT_FOUND,
          ErrorCode.NOT_FOUND,
          `Không tìm thấy đơn đặt hàng nhập (PO) "${poIdOrNumber}".`,
        );
      }

      if (existing.status === PurchaseOrderStatus.CHO_NCC_XAC_NHAN) {
        const dto = await this.hydratePurchaseOrder(existing, tx);
        return {
          dto,
          supplierEmail: existing.supplier_email,
          supplierName: existing.supplier_name,
          wasAlreadySubmitted: true,
        };
      }

      if (existing.status !== PurchaseOrderStatus.NHAP_AI) {
        throw new ApiDomainException(
          HttpStatus.CONFLICT,
          ErrorCode.CONFLICT,
          `Không thể duyệt gửi PO đang ở trạng thái ${existing.status}.`,
        );
      }

      await tx.query(
        `UPDATE purchase_orders
         SET status = $1,
             approved_by = $2,
             approved_at = NOW(),
             updated_at = NOW()
         WHERE id = $3`,
        [PurchaseOrderStatus.CHO_NCC_XAC_NHAN, opts.actorId ?? null, existing.id],
      );

      const reloaded = await this.fetchPurchaseOrderJoinedRow(existing.id, tx);
      if (!reloaded) {
        throw new Error('Failed to reload submitted Purchase Order');
      }
      const dto = await this.hydratePurchaseOrder(reloaded, tx);
      return {
        dto,
        supplierEmail: reloaded.supplier_email,
        supplierName: reloaded.supplier_name,
        wasAlreadySubmitted: false,
      };
    });

    if (!result.wasAlreadySubmitted) {
      await this.notifyAndAuditSubmittedPo(
        result.dto,
        result.supplierEmail,
        result.supplierName,
        opts.actorId ?? null,
        opts.correlationId,
        opts.traceparent,
      );
    }

    return result.dto;
  }

  async createGoodsReceipt(
    input: CreateGoodsReceiptDTO,
    opts: { actorId?: string | null; correlationId: string; traceparent?: string },
  ): Promise<GoodsReceiptExtendedDto> {
    // Hard validation: acceptedQty + rejectedDefectQty <= receivedQty
    for (const item of input.items) {
      if (
        item.receivedQty <= 0 ||
        item.acceptedQty < 0 ||
        item.rejectedDefectQty < 0 ||
        item.acceptedQty + item.rejectedDefectQty > item.receivedQty
      ) {
        throw new ApiDomainException(
          HttpStatus.BAD_REQUEST,
          ErrorCode.VALIDATION_ERROR,
          `Số lượng nhập kho không hợp lệ cho SKU ${item.skuId}: acceptedQty (${item.acceptedQty}) + rejectedDefectQty (${item.rejectedDefectQty}) phải <= receivedQty (${item.receivedQty}).`,
        );
      }
    }

    const txOutcome = await this.db.transaction(async (tx) => {
      const poRow = await this.fetchPurchaseOrderJoinedRow(input.poId, tx, true);
      if (!poRow) {
        throw new ApiDomainException(
          HttpStatus.NOT_FOUND,
          ErrorCode.NOT_FOUND,
          `Không tìm thấy đơn đặt hàng nhập (PO) "${input.poId}".`,
        );
      }

      if (
        poRow.status === PurchaseOrderStatus.NHAP_AI ||
        poRow.status === PurchaseOrderStatus.DA_HUY
      ) {
        throw new ApiDomainException(
          HttpStatus.CONFLICT,
          ErrorCode.CONFLICT,
          `Không thể tạo phiếu nhập kho (GRN) cho PO đang ở trạng thái ${poRow.status}.`,
        );
      }

      const warehouse = input.warehouseCode
        ? await this.resolveWarehouse(tx, input.warehouseCode)
        : { id: poRow.warehouse_id, code: poRow.warehouse_code, name: poRow.warehouse_code };

      const poItemsRes = await tx.query<PurchaseOrderItemRow>(
        'SELECT * FROM purchase_order_items WHERE po_id = $1 ORDER BY sku_id ASC',
        [poRow.id],
      );
      const poItemById = new Map<string, PurchaseOrderItemRow>();
      const poItemBySkuId = new Map<string, PurchaseOrderItemRow>();
      for (const item of poItemsRes.rows) {
        poItemById.set(item.id, item);
        poItemBySkuId.set(item.sku_id, item);
      }

      const grnId = crypto.randomUUID();
      const grnNumber = generateDocumentNumber('GRN');

      await tx.query(
        `INSERT INTO goods_receipts (id, grn_number, po_id, warehouse_id, inspected_by, notes, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
        [grnId, grnNumber, poRow.id, warehouse.id, opts.actorId ?? null, input.note ?? null],
      );

      // Sort items by skuId ASC for deadlock-free stock_levels locking
      const sortedItems = [...input.items].sort((a, b) => a.skuId.localeCompare(b.skuId));

      let totalAcceptedQty = 0;
      let totalRejectedQty = 0;
      let payableAmountVnd = 0;
      const replenishedSkus: Array<{
        skuId: string;
        skuCode: string;
        productId: string;
        acceptedQty: number;
      }> = [];

      for (const line of sortedItems) {
        const poItem = poItemById.get(line.poItemId) ?? poItemBySkuId.get(line.skuId);
        if (!poItem) {
          throw new ApiDomainException(
            HttpStatus.BAD_REQUEST,
            ErrorCode.VALIDATION_ERROR,
            `Không tìm thấy dòng sản phẩm PO tương ứng với poItemId=${line.poItemId} / skuId=${line.skuId}.`,
          );
        }

        await tx.query(
          `INSERT INTO goods_receipt_items (
            id, grn_id, po_item_id, sku_id, received_qty, accepted_qty, rejected_defect_qty, batch_code
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            crypto.randomUUID(),
            grnId,
            poItem.id,
            poItem.sku_id,
            line.receivedQty,
            line.acceptedQty,
            line.rejectedDefectQty,
            line.batchCode,
          ],
        );

        // Lock & update stock_levels atomically: available_qty += acceptedQty, damaged_qty += rejectedDefectQty
        const stockUpsert = await tx.query<{ available_qty: number; damaged_qty: number }>(
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
          [
            poItem.sku_id,
            warehouse.id,
            poItem.product_id,
            poItem.sku_code,
            line.acceptedQty,
            line.rejectedDefectQty,
          ],
        );

        const newAvail = Number(stockUpsert.rows[0]?.available_qty ?? line.acceptedQty);

        await tx.query(
          `INSERT INTO inventory_ledger (
            id, sku_id, warehouse_id, delta_available, delta_reserved, delta_committed,
            balance_available_after, reason, reference_id, actor_id, note, created_at
          ) VALUES ($1, $2, $3, $4, 0, 0, $5, $6, $7, $8, $9, NOW())`,
          [
            crypto.randomUUID(),
            poItem.sku_id,
            warehouse.id,
            line.acceptedQty,
            newAvail,
            InventoryLedgerReason.GRN_INBOUND,
            grnNumber,
            opts.actorId ?? null,
            `Nhập kho ${grnNumber} (PO ${poRow.po_number}) lô ${line.batchCode}: nhận ${line.receivedQty}, đạt ${line.acceptedQty}, lỗi ${line.rejectedDefectQty}`,
          ],
        );

        await tx.query(
          `UPDATE purchase_order_items
           SET received_qty = received_qty + $1,
               received_accepted_qty = received_accepted_qty + $2,
               rejected_defect_qty = rejected_defect_qty + $3
           WHERE id = $4`,
          [line.receivedQty, line.acceptedQty, line.rejectedDefectQty, poItem.id],
        );

        totalAcceptedQty += line.acceptedQty;
        totalRejectedQty += line.rejectedDefectQty;
        payableAmountVnd += line.acceptedQty * Number(poItem.unit_cost_vnd);

        replenishedSkus.push({
          skuId: poItem.sku_id,
          skuCode: poItem.sku_code,
          productId: poItem.product_id,
          acceptedQty: line.acceptedQty,
        });
      }

      const updatedPoItems = await tx.query<PurchaseOrderItemRow>(
        'SELECT * FROM purchase_order_items WHERE po_id = $1',
        [poRow.id],
      );
      const allCompleted = updatedPoItems.rows.every(
        (item) => Number(item.received_accepted_qty) >= Number(item.ordered_qty),
      );
      const nextPoStatus: PurchaseOrderStatusValue = allCompleted
        ? PurchaseOrderStatus.HOAN_TAT
        : PurchaseOrderStatus.HOAN_TAT_MOT_PHAN;

      await tx.query(
        'UPDATE purchase_orders SET status = $1, updated_at = NOW() WHERE id = $2',
        [nextPoStatus, poRow.id],
      );

      const payableId = crypto.randomUUID();
      const dueDate = formatDateYmd(new Date(Date.now() + 30 * 86_400_000));
      await tx.query(
        `INSERT INTO supplier_payables (
          id, supplier_id, grn_id, po_id, amount_payable_vnd, status, due_date, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
        [
          payableId,
          poRow.supplier_id,
          grnId,
          poRow.id,
          payableAmountVnd,
          SupplierPayableStatus.UNPAID,
          dueDate,
        ],
      );

      const replenishedEnvelope = createEventEnvelope({
        eventName: EVENT_NAMES.INVENTORY_STOCK_REPLENISHED,
        producer: SERVICE_NAME,
        correlationId: opts.correlationId,
        idempotencyKey: `grn:${grnId}`,
        payload: {
          grnId,
          poId: poRow.id,
          warehouseId: warehouse.id,
          supplierId: poRow.supplier_id,
          items: replenishedSkus.map((s) => ({
            skuCode: s.skuCode,
            receivedQty: Math.max(1, s.acceptedQty),
          })),
          replenishedAt: new Date().toISOString(),
        },
      });
      const outboxId = crypto.randomUUID();
      await tx.query(
        `INSERT INTO outbox_events (id, event_name, payload_jsonb, published, created_at)
         VALUES ($1, $2, $3::jsonb, FALSE, NOW())`,
        [outboxId, EVENT_NAMES.INVENTORY_STOCK_REPLENISHED, JSON.stringify(replenishedEnvelope)],
      );

      const grnDto: GoodsReceiptExtendedDto = {
        id: grnId,
        grnNumber,
        poId: poRow.id,
        poNumber: poRow.po_number,
        supplierId: poRow.supplier_id,
        warehouseCode: warehouse.code,
        receivedByUserId: opts.actorId ?? null,
        note: input.note ?? null,
        totalAcceptedQty,
        totalRejectedQty,
        payableId,
        payableAmountVnd,
        poStatus: nextPoStatus,
        items: sortedItems,
        createdAt: new Date().toISOString(),
      };

      return {
        grnDto,
        replenishedSkus,
        outboxId,
        replenishedEnvelope,
      };
    });

    // Sync exact Redis totals from DB for all replenished SKUs
    const skuIds = [...new Set(txOutcome.replenishedSkus.map((s) => s.skuId))];
    const totalAvailMap = await this.syncRedisAvailableFromDb(skuIds);

    // Notify catalog-lookbook synchronously (short timeout, non-fatal) so Storefront & Meilisearch
    // immediately mark replenished SKUs back In Stock
    await this.notifyCatalogStockReplenished(
      txOutcome.replenishedSkus.map((s) => ({
        skuId: s.skuId,
        skuCode: s.skuCode,
        productId: s.productId,
        availableQty: totalAvailMap.get(s.skuId) ?? s.acceptedQty,
      })),
      opts.correlationId,
      opts.traceparent,
    );

    void this.rabbitmq
      .publishDomainEvent(
        EVENT_NAMES.INVENTORY_STOCK_REPLENISHED,
        txOutcome.replenishedEnvelope as unknown as Record<string, unknown>,
      )
      .then((published) => {
        if (published) {
          void this.db
            .query('UPDATE outbox_events SET published = TRUE WHERE id = $1', [txOutcome.outboxId])
            .catch(() => undefined);
        }
      });

    return txOutcome.grnDto;
  }

  async listGoodsReceipts(filters: {
    supplierId?: string;
    poId?: string;
  }): Promise<GoodsReceiptDTO[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filters.supplierId && filters.supplierId.trim()) {
      if (!UUID_REGEX.test(filters.supplierId.trim())) {
        return [];
      }
      params.push(filters.supplierId.trim());
      conditions.push(`po.supplier_id = $${params.length}`);
    }

    if (filters.poId && filters.poId.trim()) {
      params.push(filters.poId.trim());
      conditions.push(`(gr.po_id::text = $${params.length} OR po.po_number = $${params.length})`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const res = await this.db.query<GoodsReceiptJoinedRow>(
      `SELECT gr.*, po.po_number, po.supplier_id, w.code AS warehouse_code
       FROM goods_receipts gr
       INNER JOIN purchase_orders po ON po.id = gr.po_id
       INNER JOIN warehouses w ON w.id = gr.warehouse_id
       ${whereClause}
       ORDER BY gr.created_at DESC
       LIMIT 200`,
      params,
    );

    const out: GoodsReceiptDTO[] = [];
    for (const row of res.rows) {
      const itemsRes = await this.db.query<GoodsReceiptItemRow>(
        'SELECT * FROM goods_receipt_items WHERE grn_id = $1 ORDER BY sku_id ASC',
        [row.id],
      );
      const payableRes = await this.db.query<{ id: string; amount_payable_vnd: string | number }>(
        'SELECT id, amount_payable_vnd FROM supplier_payables WHERE grn_id = $1 LIMIT 1',
        [row.id],
      );
      const items = itemsRes.rows.map((it) => ({
        poItemId: it.po_item_id,
        skuId: it.sku_id,
        receivedQty: Number(it.received_qty),
        acceptedQty: Number(it.accepted_qty),
        rejectedDefectQty: Number(it.rejected_defect_qty),
        batchCode: it.batch_code,
      }));
      const totalAcceptedQty = items.reduce((sum, it) => sum + it.acceptedQty, 0);
      const totalRejectedQty = items.reduce((sum, it) => sum + it.rejectedDefectQty, 0);
      const payable = payableRes.rows[0];

      out.push({
        id: row.id,
        grnNumber: row.grn_number,
        poId: row.po_id,
        poNumber: row.po_number,
        supplierId: row.supplier_id,
        warehouseCode: row.warehouse_code,
        receivedByUserId: row.inspected_by,
        note: row.notes,
        totalAcceptedQty,
        totalRejectedQty,
        payableId: payable?.id ?? null,
        payableAmountVnd: payable ? Number(payable.amount_payable_vnd) : 0,
        items,
        createdAt: toIso(row.created_at),
      });
    }

    return out;
  }

  async listPayables(filters: {
    supplierId?: string;
    poId?: string;
    status?: string;
  }): Promise<SupplierPayableDTO[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filters.supplierId && filters.supplierId.trim()) {
      if (!UUID_REGEX.test(filters.supplierId.trim())) {
        return [];
      }
      params.push(filters.supplierId.trim());
      conditions.push(`supplier_id = $${params.length}`);
    }

    if (filters.poId && filters.poId.trim()) {
      params.push(filters.poId.trim());
      conditions.push(`po_id::text = $${params.length}`);
    }

    if (filters.status && filters.status.trim()) {
      params.push(filters.status.trim().toUpperCase());
      conditions.push(`status = $${params.length}`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const res = await this.db.query<SupplierPayableRow>(
      `SELECT * FROM supplier_payables
       ${whereClause}
       ORDER BY created_at DESC
       LIMIT 200`,
      params,
    );

    return res.rows.map((row) => ({
      id: row.id,
      supplierId: row.supplier_id,
      grnId: row.grn_id,
      poId: row.po_id,
      amountPayableVnd: Number(row.amount_payable_vnd),
      status: row.status,
      dueDate: row.due_date,
      createdAt: toIso(row.created_at),
    }));
  }

  // ============================================================================
  // Partner B2B Strict Row-Level Isolated Operations
  // ============================================================================

  async listPartnerPurchaseOrders(
    supplierId: string,
    status?: string,
  ): Promise<PurchaseOrderExtendedDto[]> {
    if (status && status.trim().toUpperCase() === PurchaseOrderStatus.NHAP_AI) {
      return [];
    }
    return this.listPurchaseOrders({
      supplierId,
      status,
      excludeAiDraft: true,
    });
  }

  async getPartnerPurchaseOrder(
    supplierId: string,
    poIdOrNumber: string,
  ): Promise<PurchaseOrderExtendedDto> {
    const row = await this.fetchPurchaseOrderJoinedRow(poIdOrNumber);
    if (!row || row.supplier_id !== supplierId) {
      throw new ApiDomainException(
        HttpStatus.NOT_FOUND,
        ErrorCode.NOT_FOUND,
        'Không tìm thấy đơn đặt hàng thuộc nhà cung cấp hiện tại.',
      );
    }

    if (row.status === PurchaseOrderStatus.NHAP_AI) {
      throw new ApiDomainException(
        HttpStatus.FORBIDDEN,
        ErrorCode.PO_DRAFT_FORBIDDEN_FOR_SUPPLIER,
        'Đơn hàng đang ở trạng thái bản nháp nội bộ (NHAP_AI), nhà cung cấp không được phép truy cập.',
      );
    }

    return this.hydratePurchaseOrder(row);
  }

  async confirmPartnerPurchaseOrder(
    supplierId: string,
    poIdOrNumber: string,
    input: ConfirmPurchaseOrderBySupplierDTO,
    opts: { actorId?: string | null; correlationId: string },
  ): Promise<PurchaseOrderExtendedDto> {
    const updated = await this.db.transaction(async (tx) => {
      const row = await this.fetchPurchaseOrderJoinedRow(poIdOrNumber, tx, true);
      if (!row || row.supplier_id !== supplierId) {
        throw new ApiDomainException(
          HttpStatus.FORBIDDEN,
          ErrorCode.FORBIDDEN,
          'Bạn không có quyền xác nhận đơn đặt hàng này.',
        );
      }

      if (row.status === PurchaseOrderStatus.NHAP_AI) {
        throw new ApiDomainException(
          HttpStatus.FORBIDDEN,
          ErrorCode.PO_DRAFT_FORBIDDEN_FOR_SUPPLIER,
          'Không thể xác nhận bản nháp AI (NHAP_AI) chưa được quản trị viên duyệt gửi.',
        );
      }

      if (row.status === PurchaseOrderStatus.NCC_DA_XAC_NHAN) {
        return this.hydratePurchaseOrder(row, tx);
      }

      if (row.status !== PurchaseOrderStatus.CHO_NCC_XAC_NHAN) {
        throw new ApiDomainException(
          HttpStatus.CONFLICT,
          ErrorCode.CONFLICT,
          `PO đang ở trạng thái ${row.status}, không thể xác nhận lại.`,
        );
      }

      await tx.query(
        `UPDATE purchase_orders
         SET status = $1,
             confirmed_delivery_date = $2,
             supplier_note = $3,
             confirmed_by = $4,
             confirmed_at = NOW(),
             updated_at = NOW()
         WHERE id = $5 AND supplier_id = $6 AND status = $7`,
        [
          PurchaseOrderStatus.NCC_DA_XAC_NHAN,
          input.confirmedDeliveryDate,
          input.supplierNote ?? null,
          opts.actorId ?? supplierId,
          row.id,
          supplierId,
          PurchaseOrderStatus.CHO_NCC_XAC_NHAN,
        ],
      );

      const reloaded = await this.fetchPurchaseOrderJoinedRow(row.id, tx);
      if (!reloaded) {
        throw new Error('Failed to reload confirmed Purchase Order');
      }
      return this.hydratePurchaseOrder(reloaded, tx);
    });

    const confirmedEnvelope = createEventEnvelope({
      eventName: EVENT_NAMES.PROCUREMENT_PO_CONFIRMED,
      producer: SERVICE_NAME,
      correlationId: opts.correlationId,
      idempotencyKey: `po-confirmed:${updated.id}`,
      payload: {
        poId: updated.id,
        poNumber: updated.poNumber,
        supplierId: updated.supplierId,
        confirmedBySupplierUserId: opts.actorId ?? supplierId,
        confirmedDeliveryDate: input.confirmedDeliveryDate,
        confirmedAt: new Date().toISOString(),
      },
    });
    void this.rabbitmq.publishDomainEvent(
      EVENT_NAMES.PROCUREMENT_PO_CONFIRMED,
      confirmedEnvelope as unknown as Record<string, unknown>,
    );

    return updated;
  }

  // ============================================================================
  // Private Helpers
  // ============================================================================

  private async fetchPurchaseOrderJoinedRow(
    idOrNumber: string,
    executor?: AtelierDbExecutor,
    forUpdate = false,
  ): Promise<PurchaseOrderJoinedRow | null> {
    const runner = executor ?? this.db;
    const isUuid = UUID_REGEX.test(idOrNumber);
    const whereClause = isUuid ? 'po.id = $1' : 'po.po_number = $1';
    const lockClause = forUpdate ? 'FOR UPDATE OF po' : '';

    const res = await runner.query<PurchaseOrderJoinedRow>(
      `SELECT po.*,
              s.code AS supplier_code,
              s.name AS supplier_name,
              s.contact_email AS supplier_email,
              w.code AS warehouse_code
       FROM purchase_orders po
       INNER JOIN suppliers s ON s.id = po.supplier_id
       INNER JOIN warehouses w ON w.id = po.warehouse_id
       WHERE ${whereClause}
       LIMIT 1
       ${lockClause}`,
      [idOrNumber],
    );
    return res.rows[0] ?? null;
  }

  private async hydratePurchaseOrder(
    row: PurchaseOrderJoinedRow,
    executor?: AtelierDbExecutor,
  ): Promise<PurchaseOrderExtendedDto> {
    const runner = executor ?? this.db;
    const itemsRes = await runner.query<PurchaseOrderItemRow>(
      'SELECT * FROM purchase_order_items WHERE po_id = $1 ORDER BY sku_code ASC',
      [row.id],
    );

    const items: PurchaseOrderItemDTO[] = itemsRes.rows.map((it) => {
      const unitCostVnd = Number(it.unit_cost_vnd);
      const orderedQty = Number(it.ordered_qty);
      return {
        id: it.id,
        poId: it.po_id,
        skuId: it.sku_id,
        skuCode: it.sku_code,
        productName: it.product_name,
        orderedQty,
        receivedQty: Number(it.received_qty),
        acceptedQty: Number(it.received_accepted_qty),
        rejectedDefectQty: Number(it.rejected_defect_qty),
        unitCostVnd,
        lineCostVnd: orderedQty * unitCostVnd,
      };
    });

    const totalOrderedQty = items.reduce((sum, it) => sum + it.orderedQty, 0);
    const totalReceivedQty = items.reduce((sum, it) => sum + it.receivedQty, 0);
    const totalAmountVnd = Number(row.total_amount_vnd);

    return {
      id: row.id,
      poNumber: row.po_number,
      supplierId: row.supplier_id,
      supplierCode: row.supplier_code,
      supplierName: row.supplier_name,
      warehouseCode: row.warehouse_code,
      status: row.status,
      createdSource: row.created_source,
      requiresHumanApproval: row.status === PurchaseOrderStatus.NHAP_AI,
      expectedDeliveryDate: row.expected_delivery_date,
      confirmedDeliveryDate: row.confirmed_delivery_date,
      rationale: row.rationale,
      supplierNote: row.supplier_note,
      notes: row.notes,
      totalOrderedQty,
      totalReceivedQty,
      totalCostVnd: totalAmountVnd,
      totalAmountVnd,
      approvedByUserId: row.approved_by,
      approvedAt: row.approved_at ? toIso(row.approved_at) : null,
      confirmedBySupplierUserId: row.confirmed_by,
      confirmedAt: row.confirmed_at ? toIso(row.confirmed_at) : null,
      items,
      createdAt: toIso(row.created_at),
      updatedAt: toIso(row.updated_at),
    };
  }

  private async resolveSupplier(
    tx: AtelierDbExecutor,
    supplierIdOrCode: string,
  ): Promise<SupplierRow> {
    const trimmed = supplierIdOrCode.trim();
    const isUuid = UUID_REGEX.test(trimmed);
    const res = await tx.query<SupplierRow>(
      isUuid
        ? 'SELECT * FROM suppliers WHERE id = $1 LIMIT 1'
        : 'SELECT * FROM suppliers WHERE UPPER(code) = UPPER($1) OR LOWER(contact_email) = LOWER($1) LIMIT 1',
      [trimmed],
    );
    if (res.rows.length === 0) {
      throw new ApiDomainException(
        HttpStatus.NOT_FOUND,
        ErrorCode.NOT_FOUND,
        `Không tìm thấy nhà cung cấp "${supplierIdOrCode}".`,
      );
    }
    return res.rows[0];
  }

  private async resolveWarehouse(
    tx: AtelierDbExecutor,
    rawCode?: string,
  ): Promise<WarehouseRow> {
    const upper = (rawCode?.trim() || 'CENTRAL_WH').toUpperCase();
    const mapped = WAREHOUSE_CODE_ALIASES[upper] ?? upper;

    const exact = await tx.query<WarehouseRow>(
      'SELECT id, code, name FROM warehouses WHERE UPPER(code) = $1 LIMIT 1',
      [mapped],
    );
    if (exact.rows.length > 0) {
      return exact.rows[0];
    }

    const fallback = await tx.query<WarehouseRow>(
      'SELECT id, code, name FROM warehouses WHERE is_active = TRUE ORDER BY priority ASC LIMIT 1',
    );
    if (fallback.rows.length === 0) {
      throw new ApiDomainException(
        HttpStatus.NOT_FOUND,
        ErrorCode.NOT_FOUND,
        'Không tìm thấy kho hợp lệ trong hệ thống.',
      );
    }
    return fallback.rows[0];
  }

  private async resolveSkuMetadata(
    tx: AtelierDbExecutor,
    rawSkuId: string,
    rawSkuCode?: string,
  ): Promise<{ skuId: string; skuCode: string; productId: string }> {
    const trimmed = rawSkuId.trim();
    if (UUID_REGEX.test(trimmed)) {
      const byId = await tx.query<{ sku_id: string; sku_code: string | null; product_id: string }>(
        'SELECT sku_id, sku_code, product_id FROM stock_levels WHERE sku_id = $1 LIMIT 1',
        [trimmed],
      );
      if (byId.rows.length > 0) {
        return {
          skuId: byId.rows[0].sku_id,
          skuCode: rawSkuCode?.trim() || byId.rows[0].sku_code || trimmed.slice(0, 12).toUpperCase(),
          productId: byId.rows[0].product_id,
        };
      }
      return {
        skuId: trimmed,
        skuCode: rawSkuCode?.trim() || trimmed.slice(0, 12).toUpperCase(),
        productId: trimmed,
      };
    }

    // Lookup by sku_code if caller passed a SKU code in skuId
    const lookupCode = rawSkuCode?.trim() || trimmed;
    const byCode = await tx.query<{ sku_id: string; sku_code: string | null; product_id: string }>(
      'SELECT sku_id, sku_code, product_id FROM stock_levels WHERE UPPER(sku_code) = UPPER($1) LIMIT 1',
      [lookupCode],
    );
    if (byCode.rows.length > 0) {
      return {
        skuId: byCode.rows[0].sku_id,
        skuCode: byCode.rows[0].sku_code || lookupCode,
        productId: byCode.rows[0].product_id,
      };
    }

    throw new ApiDomainException(
      HttpStatus.BAD_REQUEST,
      ErrorCode.VALIDATION_ERROR,
      `Không tìm thấy SKU "${rawSkuId}" trong danh mục tồn kho.`,
    );
  }

  private async syncRedisAvailableFromDb(skuIds: string[]): Promise<Map<string, number>> {
    const map = new Map<string, number>();
    const valid = skuIds.filter((id) => UUID_REGEX.test(id));
    if (valid.length === 0) {
      return map;
    }

    const res = await this.db.query<{ sku_id: string; total_avail: number | string }>(
      `SELECT sku_id, COALESCE(SUM(available_qty), 0)::int AS total_avail
       FROM stock_levels
       WHERE sku_id = ANY($1::uuid[])
       GROUP BY sku_id`,
      [valid],
    );
    for (const row of res.rows) {
      const val = Number(row.total_avail);
      map.set(row.sku_id, val);
      await this.redis.setStockAvailable(row.sku_id, val);
    }
    return map;
  }

  private async notifyAndAuditSubmittedPo(
    po: PurchaseOrderExtendedDto,
    supplierEmail: string,
    supplierName: string,
    actorId: string | null,
    correlationId: string,
    traceparent?: string,
  ): Promise<void> {
    await this.recordAuthAuditLog({
      actorId,
      actorType: 'USER',
      action: 'PO_SUBMITTED',
      targetType: 'purchase_order',
      targetId: po.id,
      metadataJson: {
        poNumber: po.poNumber,
        supplierId: po.supplierId,
        supplierEmail,
        status: po.status,
        totalAmountVnd: po.totalAmountVnd,
      },
      correlationId,
      traceparent,
    });

    await this.notifySupplierPoSubmitted({
      eventId: `po-submitted:${po.id}`,
      poNumber: po.poNumber,
      supplierEmail,
      supplierName,
      expectedDeliveryDate: po.expectedDeliveryDate,
      totalAmountVnd: po.totalAmountVnd,
      items: po.items.map((it) => ({
        skuId: it.skuId,
        skuCode: it.skuCode,
        orderedQty: it.orderedQty,
        unitCostVnd: it.unitCostVnd ?? 0,
      })),
      correlationId,
      traceparent,
    });

    const submittedEnvelope = createEventEnvelope({
      eventName: EVENT_NAMES.PROCUREMENT_PO_SUBMITTED,
      producer: SERVICE_NAME,
      correlationId,
      idempotencyKey: `po-submitted:${po.id}`,
      payload: {
        poId: po.id,
        poNumber: po.poNumber,
        supplierId: po.supplierId,
        approvedByUserId: actorId ?? 'system',
        items: po.items.map((it) => ({
          skuCode: it.skuCode,
          orderedQty: it.orderedQty,
        })),
        expectedDeliveryDate: po.expectedDeliveryDate,
        submittedAt: new Date().toISOString(),
      },
    });
    void this.rabbitmq.publishDomainEvent(
      EVENT_NAMES.PROCUREMENT_PO_SUBMITTED,
      submittedEnvelope as unknown as Record<string, unknown>,
    );
  }

  private async recordAuthAuditLog(params: {
    actorId: string | null;
    actorType: 'USER' | 'AI_COPILOT' | 'SYSTEM';
    action: string;
    targetType: string;
    targetId: string;
    metadataJson: Record<string, unknown>;
    correlationId: string;
    traceparent?: string;
  }): Promise<void> {
    if (!this.config.authCustomerServiceUrl) {
      return;
    }
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2500);
      try {
        await fetch(`${this.config.authCustomerServiceUrl}/internal/auth/audit-logs`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-internal-secret': this.config.internalServiceSecret,
            'X-Correlation-Id': params.correlationId,
            traceparent: createChildTraceparent(params.traceparent),
          },
          body: JSON.stringify(params),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeout);
      }
    } catch (error) {
      this.logger.warn(
        { err: error, action: params.action, targetId: params.targetId },
        'Failed to forward procurement audit log to auth-customer (non-fatal)',
      );
    }
  }

  private async notifySupplierPoSubmitted(params: {
    eventId: string;
    poNumber: string;
    supplierEmail: string;
    supplierName: string;
    expectedDeliveryDate: string;
    totalAmountVnd: number;
    items: Array<{ skuId: string; skuCode: string; orderedQty: number; unitCostVnd: number }>;
    correlationId: string;
    traceparent?: string;
  }): Promise<void> {
    if (!this.config.notifyReviewServiceUrl) {
      return;
    }
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);
      try {
        await fetch(`${this.config.notifyReviewServiceUrl}/internal/notify/po-submitted`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-internal-secret': this.config.internalServiceSecret,
            'X-Correlation-Id': params.correlationId,
            traceparent: createChildTraceparent(params.traceparent),
          },
          body: JSON.stringify(params),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeout);
      }
    } catch (error) {
      this.logger.warn(
        { err: error, poNumber: params.poNumber },
        'Failed to notify supplier PO email via notify-review (non-fatal)',
      );
    }
  }

  private async notifyCatalogStockReplenished(
    items: Array<{ skuId: string; skuCode: string; productId: string; availableQty: number }>,
    correlationId: string,
    traceparent?: string,
  ): Promise<void> {
    if (!this.config.catalogServiceUrl || items.length === 0) {
      return;
    }
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);
      try {
        await fetch(`${this.config.catalogServiceUrl}/v1/catalog/internal/stock-replenished`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-internal-secret': this.config.internalServiceSecret,
            'X-Correlation-Id': correlationId,
            traceparent: createChildTraceparent(traceparent),
          },
          body: JSON.stringify({
            skuIds: [...new Set(items.map((i) => i.skuId))],
            productIds: [...new Set(items.map((i) => i.productId))],
            items,
          }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeout);
      }
    } catch (error) {
      this.logger.warn(
        { err: error, count: items.length },
        'Failed to notify catalog-lookbook stock-replenished (non-fatal)',
      );
    }
  }
}
