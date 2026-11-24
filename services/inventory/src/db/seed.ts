import { createHash } from 'node:crypto';
import {
  InventoryLedgerReason,
  SizeCode,
  SupplierStatus,
  WarehouseType,
  type WarehouseType as WarehouseTypeValue,
} from '@atelier/contracts';
import type { AtelierDbClient } from '@atelier/db-client';

export const SUPPLIER_A_ID = '11111111-1111-4111-8111-111111111101';
export const SUPPLIER_B_ID = '22222222-2222-4222-8222-222222222202';
export const SUPPLIER_C_ID = '33333333-3333-4333-8333-333333333303';

export interface SupplierSeedSpec {
  id: string;
  code: string;
  name: string;
  contactEmail: string;
  leadTimeDays: number;
  defectRatePct: number;
}

export const SUPPLIERS_SEED: readonly SupplierSeedSpec[] = [
  {
    id: SUPPLIER_A_ID,
    code: 'SUP-A-SILK',
    name: 'Atelier Silk Partner A (Lụa Bảo Lộc)',
    contactEmail: 'supplier-a@atelier.local',
    leadTimeDays: 5,
    defectRatePct: 1.2,
  },
  {
    id: SUPPLIER_B_ID,
    code: 'SUP-B-LINEN',
    name: 'Maison Linen Partner B (Linen & Wool)',
    contactEmail: 'supplier-b@atelier.local',
    leadTimeDays: 7,
    defectRatePct: 2.1,
  },
  {
    id: SUPPLIER_C_ID,
    code: 'SUP-C-ATELIER',
    name: 'Atelier Couture Partner C (Tweed & Dệt Kim)',
    contactEmail: 'supplier-c@atelier.local',
    leadTimeDays: 6,
    defectRatePct: 0.9,
  },
] as const;

/**
 * Matches the EXACT deterministic UUID formula from
 * `services/catalog-lookbook/src/seed/catalog-seed.ts` so all 100 SKU UUIDs
 * and 12 Product UUIDs align 1:1 across isolated databases.
 */
export function catalogDeterministicUuid(seedKey: string): string {
  const hex = createHash('sha256').update(`atelier-catalog-v3:${seedKey}`).digest('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    `8${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join('-');
}

export function inventoryDeterministicUuid(seedKey: string): string {
  const hex = createHash('sha256').update(`atelier-inventory-v3:${seedKey}`).digest('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    `8${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join('-');
}

const SIZES_STANDARD: readonly SizeCode[] = [
  SizeCode.XS,
  SizeCode.S,
  SizeCode.M,
  SizeCode.L,
  SizeCode.XL,
];

interface CatalogSeedProductRef {
  slug: string;
  variantCount: number;
}

const CATALOG_PRODUCTS_REF: readonly CatalogSeedProductRef[] = [
  { slug: 'ao-blazer-linen-dang-suong', variantCount: 2 },
  { slug: 'ao-so-mi-lua-to-tam-tam-xuan', variantCount: 2 },
  { slug: 'dam-du-tiec-lua-satin-co-do', variantCount: 2 },
  { slug: 'quan-tay-ong-suong-xep-ly-doi', variantCount: 2 },
  { slug: 'chan-vay-xep-ly-midi-cap-cao', variantCount: 2 },
  { slug: 'ao-khoac-trench-gabardine-co-dien', variantCount: 2 },
  { slug: 'ao-kieu-lua-organza-phoi-no', variantCount: 1 },
  { slug: 'dam-midi-co-vuong-chiet-eo', variantCount: 2 },
  { slug: 'ao-cardigan-len-merino-khuy-sung', variantCount: 1 },
  { slug: 'quan-culottes-linen-huu-co', variantCount: 1 },
  { slug: 'ao-khoac-tweed-det-thu-cong', variantCount: 2 },
  { slug: 'ao-polo-det-kim-bong-ai-cap', variantCount: 1 },
] as const;

export interface WarehouseSeedSpec {
  id: string;
  code: 'HN_ATELIER' | 'HCM_SHOWROOM' | 'CENTRAL_WH';
  name: string;
  type: WarehouseTypeValue;
  provinceCode: string;
  city: string;
  address: string;
  supports2hDelivery: boolean;
  priority: number;
}

export const WAREHOUSES_SEED: readonly WarehouseSeedSpec[] = [
  {
    id: inventoryDeterministicUuid('warehouse:HN_ATELIER'),
    code: 'HN_ATELIER',
    name: 'Atelier Flagship Hà Nội',
    type: WarehouseType.SHOWROOM,
    provinceCode: 'HN',
    city: 'Hà Nội',
    address: '28 Phố Tràng Tiền, Quận Hoàn Kiếm, Hà Nội',
    supports2hDelivery: true,
    priority: 1,
  },
  {
    id: inventoryDeterministicUuid('warehouse:HCM_SHOWROOM'),
    code: 'HCM_SHOWROOM',
    name: 'Showroom Thảo Điền TP.HCM',
    type: WarehouseType.SHOWROOM,
    provinceCode: 'HCM',
    city: 'TP. Hồ Chí Minh',
    address: '14 Xuân Thủy, Thảo Điền, TP. Thủ Đức, TP.HCM',
    supports2hDelivery: true,
    priority: 2,
  },
  {
    id: inventoryDeterministicUuid('warehouse:CENTRAL_WH'),
    code: 'CENTRAL_WH',
    name: 'Kho Trung Tâm Miền Bắc',
    type: WarehouseType.CENTRAL,
    provinceCode: 'HN',
    city: 'Hà Nội',
    address: 'Khu Công Nghiệp Long Biên, Quận Long Biên, Hà Nội',
    supports2hDelivery: false,
    priority: 3,
  },
] as const;

export interface SeedSkuSpec {
  skuId: string;
  productId: string;
  skuCode: string;
  slug: string;
  variantIndex: number;
  sizeCode: SizeCode;
  hnQty: number;
  hcmQty: number;
  centralQty: number;
  safetyThreshold: number;
}

const LOW_STOCK_KEYS = new Set<string>([
  'ao-blazer-linen-dang-suong:0:XL',
  'dam-du-tiec-lua-satin-co-do:0:XS',
]);

/**
 * Phase 5 flagship Size M SKUs seeded at available_qty = 2, safety_threshold = 10
 * so MCP Copilot demand-signal restock PO workflows trigger deterministically.
 */
const FLAGSHIP_LOW_STOCK_M_KEYS = new Set<string>([
  'ao-polo-det-kim-bong-ai-cap:0:M', // AT-AOPODE-C1-M
  'ao-blazer-linen-dang-suong:0:M', // AT-AOBLLI-C1-M
]);

const OUT_OF_STOCK_KEYS = new Set<string>(['ao-polo-det-kim-bong-ai-cap:0:XL']);

export function buildSeedSkuSpecs(): SeedSkuSpec[] {
  const specs: SeedSkuSpec[] = [];
  let seq = 0;

  for (const prod of CATALOG_PRODUCTS_REF) {
    const productId = catalogDeterministicUuid(`product:${prod.slug}`);
    const slugCode = prod.slug
      .split('-')
      .slice(0, 3)
      .map((seg) => seg.slice(0, 2).toUpperCase())
      .join('');

    for (let vIdx = 0; vIdx < prod.variantCount; vIdx += 1) {
      for (const sizeCode of SIZES_STANDARD) {
        const skuId = catalogDeterministicUuid(`sku:${prod.slug}:${vIdx}:${sizeCode}`);
        const skuCode = `AT-${slugCode}-C${vIdx + 1}-${sizeCode}`;
        const key = `${prod.slug}:${vIdx}:${sizeCode}`;

        let hnQty: number;
        let hcmQty: number;
        let centralQty: number;
        let safetyThreshold = 3;

        if (OUT_OF_STOCK_KEYS.has(key)) {
          hnQty = 0;
          hcmQty = 0;
          centralQty = 0;
        } else if (FLAGSHIP_LOW_STOCK_M_KEYS.has(key)) {
          hnQty = 2;
          hcmQty = 0;
          centralQty = 0;
          safetyThreshold = 10;
        } else if (LOW_STOCK_KEYS.has(key)) {
          hnQty = 2;
          hcmQty = 0;
          centralQty = 0;
        } else {
          // Deterministic healthy stock total in [15..25] distributed across HN_ATELIER, CENTRAL_WH, HCM_SHOWROOM
          const totalHealthy = 15 + (seq % 11); // 15..25
          hnQty = Math.min(10, Math.max(6, Math.floor(totalHealthy * 0.45)));
          hcmQty = seq % 3 === 0 ? 3 : 2;
          centralQty = Math.max(0, totalHealthy - hnQty - hcmQty);
        }

        specs.push({
          skuId,
          productId,
          skuCode,
          slug: prod.slug,
          variantIndex: vIdx,
          sizeCode,
          hnQty,
          hcmQty,
          centralQty,
          safetyThreshold,
        });
        seq += 1;
      }
    }
  }

  return specs;
}

export interface InventorySeedSummary {
  skipped: boolean;
  warehousesCount: number;
  suppliersCount: number;
  skusCount: number;
  stockLevelRows: number;
  lowStockSkus: number;
  outOfStockSkus: number;
}

async function seedSuppliersIdempotent(db: AtelierDbClient): Promise<number> {
  let created = 0;
  for (const sup of SUPPLIERS_SEED) {
    const res = await db.query<{ id: string }>(
      `INSERT INTO suppliers (
        id, code, name, contact_email, lead_time_days, defect_rate_pct, status, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name,
        contact_email = EXCLUDED.contact_email,
        lead_time_days = EXCLUDED.lead_time_days,
        defect_rate_pct = EXCLUDED.defect_rate_pct
      RETURNING id`,
      [
        sup.id,
        sup.code,
        sup.name,
        sup.contactEmail,
        sup.leadTimeDays,
        sup.defectRatePct,
        SupplierStatus.ACTIVE,
      ],
    );
    if (res.rows.length > 0) {
      created += 1;
    }
  }
  return created;
}

export async function seedInventoryDatabase(db: AtelierDbClient): Promise<InventorySeedSummary> {
  const existingSuppliersCheck = await db.query<{ cnt: string | number }>(
    'SELECT COUNT(*)::int AS cnt FROM suppliers',
  );
  const hadSuppliersBefore = Number(existingSuppliersCheck.rows[0]?.cnt ?? 0);
  await seedSuppliersIdempotent(db);

  const whCheck = await db.query<{ cnt: string | number }>(
    'SELECT COUNT(*)::int AS cnt FROM warehouses',
  );
  const existingWh = Number(whCheck.rows[0]?.cnt ?? 0);

  const stockCheck = await db.query<{ cnt: string | number }>(
    'SELECT COUNT(DISTINCT sku_id)::int AS cnt FROM stock_levels',
  );
  const existingDistinctSkus = Number(stockCheck.rows[0]?.cnt ?? 0);

  const allSkus = buildSeedSkuSpecs();

  if (existingWh >= WAREHOUSES_SEED.length && existingDistinctSkus >= allSkus.length) {
    // One-time idempotent Phase 5 upgrade for pre-existing Phase 4 DBs:
    // ensure flagship Size M SKUs have safety_threshold = 10 & available_qty = 2.
    if (hadSuppliersBefore === 0) {
      const hnRes = await db.query<{ id: string }>(
        "SELECT id FROM warehouses WHERE code = 'HN_ATELIER' LIMIT 1",
      );
      const hnId = hnRes.rows[0]?.id;
      for (const spec of allSkus) {
        if (!FLAGSHIP_LOW_STOCK_M_KEYS.has(`${spec.slug}:${spec.variantIndex}:${spec.sizeCode}`)) {
          continue;
        }
        await db.query(
          `UPDATE stock_levels
           SET safety_threshold = 10,
               available_qty = CASE WHEN warehouse_id = $2 THEN 2 ELSE 0 END,
               updated_at = NOW()
           WHERE sku_id = $1`,
          [spec.skuId, hnId ?? ''],
        );
      }
    }

    return {
      skipped: true,
      warehousesCount: existingWh,
      suppliersCount: SUPPLIERS_SEED.length,
      skusCount: existingDistinctSkus,
      stockLevelRows: existingDistinctSkus * 2,
      lowStockSkus: LOW_STOCK_KEYS.size + FLAGSHIP_LOW_STOCK_M_KEYS.size,
      outOfStockSkus: OUT_OF_STOCK_KEYS.size,
    };
  }

  for (const wh of WAREHOUSES_SEED) {
    await db.query(
      `INSERT INTO warehouses (
        id, code, name, type, province_code, city, address,
        supports_2h_delivery, priority, is_active, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, TRUE, NOW())
      ON CONFLICT (code) DO UPDATE SET
        name = EXCLUDED.name,
        city = EXCLUDED.city,
        address = EXCLUDED.address,
        supports_2h_delivery = EXCLUDED.supports_2h_delivery,
        priority = EXCLUDED.priority`,
      [
        wh.id,
        wh.code,
        wh.name,
        wh.type,
        wh.provinceCode,
        wh.city,
        wh.address,
        wh.supports2hDelivery,
        wh.priority,
      ],
    );
  }

  const whIdByCode = new Map<string, string>();
  const whRows = await db.query<{ id: string; code: string }>('SELECT id, code FROM warehouses');
  for (const row of whRows.rows) {
    whIdByCode.set(row.code, row.id);
  }

  const hnId = whIdByCode.get('HN_ATELIER')!;
  const hcmId = whIdByCode.get('HCM_SHOWROOM')!;
  const centralId = whIdByCode.get('CENTRAL_WH')!;

  let stockLevelRows = 0;

  for (const sku of allSkus) {
    const placements: Array<{ warehouseId: string; code: string; qty: number }> = [
      { warehouseId: hnId, code: 'HN_ATELIER', qty: sku.hnQty },
      { warehouseId: centralId, code: 'CENTRAL_WH', qty: sku.centralQty },
    ];
    if (sku.hcmQty > 0) {
      placements.push({ warehouseId: hcmId, code: 'HCM_SHOWROOM', qty: sku.hcmQty });
    }

    for (const placement of placements) {
      const inserted = await db.query<{ sku_id: string }>(
        `INSERT INTO stock_levels (
          sku_id, warehouse_id, product_id, sku_code,
          available_qty, reserved_qty, committed_qty, damaged_qty,
          safety_threshold, version, updated_at
        ) VALUES ($1, $2, $3, $4, $5, 0, 0, 0, $6, 1, NOW())
        ON CONFLICT (sku_id, warehouse_id) DO NOTHING
        RETURNING sku_id`,
        [
          sku.skuId,
          placement.warehouseId,
          sku.productId,
          sku.skuCode,
          placement.qty,
          sku.safetyThreshold,
        ],
      );

      if (inserted.rows.length > 0) {
        stockLevelRows += 1;
        const ledgerId = inventoryDeterministicUuid(
          `ledger:seed:${sku.skuId}:${placement.code}`,
        );
        await db.query(
          `INSERT INTO inventory_ledger (
            id, sku_id, warehouse_id, delta_available, delta_reserved, delta_committed,
            balance_available_after, reason, reference_id, note, created_at
          ) VALUES ($1, $2, $3, $4, 0, 0, $4, $5, $6, $7, NOW())
          ON CONFLICT (id) DO NOTHING`,
          [
            ledgerId,
            sku.skuId,
            placement.warehouseId,
            placement.qty,
            InventoryLedgerReason.INITIAL_SEED,
            'SEED_INITIAL_V3',
            `Khởi tạo tồn kho ${sku.skuCode} tại ${placement.code}`,
          ],
        );
      }
    }
  }

  return {
    skipped: false,
    warehousesCount: WAREHOUSES_SEED.length,
    suppliersCount: SUPPLIERS_SEED.length,
    skusCount: allSkus.length,
    stockLevelRows,
    lowStockSkus: LOW_STOCK_KEYS.size + FLAGSHIP_LOW_STOCK_M_KEYS.size,
    outOfStockSkus: OUT_OF_STOCK_KEYS.size,
  };
}
