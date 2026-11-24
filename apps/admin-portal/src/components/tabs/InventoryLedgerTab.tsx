'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  InventoryLedgerReason,
  ReservationStatus,
  WarehouseType,
  type InventoryLedgerEntryDto,
  type StockLevelAdminDto,
  type StockReservationAdminDto,
  type WarehouseDto,
} from '@atelier/contracts';
import { adminFetch } from '@/lib/api-client';

function extractList<T>(data: unknown): T[] {
  if (Array.isArray(data)) return data as T[];
  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    for (const key of ['items', 'list', 'rows', 'warehouses', 'reservations', 'ledger']) {
      if (Array.isArray(obj[key])) {
        return obj[key] as T[];
      }
    }
  }
  return [];
}

function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    return new Intl.DateTimeFormat('vi-VN', {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).format(new Date(iso));
  } catch {
    return iso.slice(0, 19);
  }
}

function formatSignedDelta(value: number): string {
  if (value > 0) return `+${value}`;
  return String(value);
}

const RESERVATION_STATUS_META: Record<
  ReservationStatus,
  { label: string; className: string }
> = {
  [ReservationStatus.ACTIVE]: {
    label: 'ACTIVE · Đang giữ chỗ',
    className: 'border-[#B08A4A]/55 bg-[#FFF8EB] text-[#8A5A12]',
  },
  [ReservationStatus.COMMITTED]: {
    label: 'COMMITTED · Đã chốt đơn',
    className: 'border-[#2E6B47]/40 bg-[#F2FBF6] text-[#1E4B32]',
  },
  [ReservationStatus.EXPIRED]: {
    label: 'EXPIRED · Hết hạn 15p',
    className: 'border-[#7A6A5B]/35 bg-[#F4EBDA]/65 text-[#5C4B41]',
  },
  [ReservationStatus.RELEASED]: {
    label: 'RELEASED · Đã hoàn tồn',
    className: 'border-[#5C4B41]/35 bg-[#F8F5F0] text-[#5C4B41]',
  },
};

const LEDGER_REASON_LABELS: Record<InventoryLedgerReason, string> = {
  [InventoryLedgerReason.INITIAL_SEED]: 'Khởi tạo tồn',
  [InventoryLedgerReason.RESERVE]: 'Giữ chỗ (Reserve)',
  [InventoryLedgerReason.COMMIT]: 'Chốt đơn (Commit)',
  [InventoryLedgerReason.RELEASE_EXPIRED]: 'Tự nhả hết hạn',
  [InventoryLedgerReason.CANCEL_RELEASE]: 'Hủy giữ chỗ',
  [InventoryLedgerReason.GRN_INBOUND]: 'Nhập kho GRN',
  [InventoryLedgerReason.RMA_RESTOCK]: 'Hoàn kho RMA',
  [InventoryLedgerReason.ADJUSTMENT]: 'Điều chỉnh thủ công',
};

type StockStatusFilter = 'ALL' | 'LOW' | 'OUT' | 'RESERVED';
type ReservationStatusFilter = 'ALL' | ReservationStatus;

export function InventoryLedgerTab() {
  const [warehouses, setWarehouses] = useState<WarehouseDto[]>([]);
  const [stockLevels, setStockLevels] = useState<StockLevelAdminDto[]>([]);
  const [reservations, setReservations] = useState<StockReservationAdminDto[]>(
    [],
  );
  const [ledger, setLedger] = useState<InventoryLedgerEntryDto[]>([]);

  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);

  // Filters
  const [selectedWarehouseCode, setSelectedWarehouseCode] =
    useState<string>('ALL');
  const [searchQuery, setSearchQuery] = useState('');
  const [stockStatusFilter, setStockStatusFilter] =
    useState<StockStatusFilter>('ALL');
  const [reservationFilter, setReservationFilter] =
    useState<ReservationStatusFilter>('ALL');

  const loadAllInventoryData = useCallback(async () => {
    setLoading(true);
    setErrorMessage(null);

    const [whRes, stockRes, resvRes, ledgerRes] = await Promise.all([
      adminFetch<unknown>('/api/v1/admin/inventory/warehouses'),
      adminFetch<unknown>('/api/v1/admin/inventory/stock-levels'),
      adminFetch<unknown>('/api/v1/admin/inventory/reservations'),
      adminFetch<unknown>('/api/v1/admin/inventory/ledger'),
    ]);

    const failed = [whRes, stockRes, resvRes, ledgerRes].find((r) => !r.ok);
    if (failed && !whRes.ok && !stockRes.ok) {
      setErrorMessage(
        failed.error?.message ||
          'Không thể tải dữ liệu tồn kho đa kho. Kiểm tra quyền WAREHOUSE_MANAGER / SUPER_ADMIN và dịch vụ inventory (:4004).',
      );
    }

    if (whRes.ok) setWarehouses(extractList<WarehouseDto>(whRes.data));
    if (stockRes.ok)
      setStockLevels(extractList<StockLevelAdminDto>(stockRes.data));
    if (resvRes.ok)
      setReservations(extractList<StockReservationAdminDto>(resvRes.data));
    if (ledgerRes.ok)
      setLedger(extractList<InventoryLedgerEntryDto>(ledgerRes.data));

    setLastSyncedAt(new Date().toISOString());
    setLoading(false);
  }, []);

  useEffect(() => {
    void loadAllInventoryData();
  }, [loadAllInventoryData]);

  // Per-warehouse aggregate metrics
  const warehouseStatsMap = useMemo(() => {
    const map = new Map<
      string,
      {
        skuRows: number;
        available: number;
        reserved: number;
        committed: number;
        lowStockCount: number;
        outOfStockCount: number;
      }
    >();

    for (const row of stockLevels) {
      const curr = map.get(row.warehouseCode) ?? {
        skuRows: 0,
        available: 0,
        reserved: 0,
        committed: 0,
        lowStockCount: 0,
        outOfStockCount: 0,
      };
      curr.skuRows += 1;
      curr.available += row.availableQty;
      curr.reserved += row.reservedQty;
      curr.committed += row.committedQty;
      if (row.availableQty === 0) {
        curr.outOfStockCount += 1;
      } else if (row.availableQty <= 3 || row.lowStockWarning) {
        curr.lowStockCount += 1;
      }
      map.set(row.warehouseCode, curr);
    }
    return map;
  }, [stockLevels]);

  const kpiTotals = useMemo(() => {
    let available = 0;
    let reserved = 0;
    let committed = 0;
    let lowStockCount = 0;
    let outOfStockCount = 0;

    for (const row of stockLevels) {
      if (
        selectedWarehouseCode !== 'ALL' &&
        row.warehouseCode !== selectedWarehouseCode
      ) {
        continue;
      }
      available += row.availableQty;
      reserved += row.reservedQty;
      committed += row.committedQty;
      if (row.availableQty === 0) {
        outOfStockCount += 1;
      } else if (row.availableQty <= 3 || row.lowStockWarning) {
        lowStockCount += 1;
      }
    }

    return {
      available,
      reserved,
      committed,
      lowStockCount,
      outOfStockCount,
    };
  }, [stockLevels, selectedWarehouseCode]);

  const filteredStockLevels = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return stockLevels.filter((row) => {
      if (
        selectedWarehouseCode !== 'ALL' &&
        row.warehouseCode !== selectedWarehouseCode
      ) {
        return false;
      }
      if (stockStatusFilter === 'OUT' && row.availableQty !== 0) {
        return false;
      }
      if (
        stockStatusFilter === 'LOW' &&
        !(
          row.availableQty >= 1 &&
          (row.availableQty <= 3 || row.lowStockWarning)
        )
      ) {
        return false;
      }
      if (stockStatusFilter === 'RESERVED' && row.reservedQty <= 0) {
        return false;
      }
      if (q) {
        const hay = [
          row.skuCode ?? '',
          row.skuId,
          row.productId,
          row.warehouseCode,
          row.warehouseName,
        ]
          .join(' ')
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [stockLevels, selectedWarehouseCode, stockStatusFilter, searchQuery]);

  const filteredReservations = useMemo(() => {
    return reservations.filter((item) => {
      if (
        reservationFilter !== 'ALL' &&
        item.status !== reservationFilter
      ) {
        return false;
      }
      if (
        selectedWarehouseCode !== 'ALL' &&
        item.warehouseCode &&
        item.warehouseCode !== selectedWarehouseCode &&
        !item.items.some((li) => li.warehouseCode === selectedWarehouseCode)
      ) {
        return false;
      }
      return true;
    });
  }, [reservations, reservationFilter, selectedWarehouseCode]);

  const filteredLedger = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return ledger
      .filter((entry) => {
        if (
          selectedWarehouseCode !== 'ALL' &&
          entry.warehouseCode &&
          entry.warehouseCode !== selectedWarehouseCode
        ) {
          return false;
        }
        if (q) {
          const hay = [
            entry.skuId,
            entry.warehouseCode ?? '',
            entry.reason,
            entry.referenceId ?? '',
            entry.note ?? '',
          ]
            .join(' ')
            .toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      })
      .slice(0, 60);
  }, [ledger, selectedWarehouseCode, searchQuery]);

  return (
    <div className="space-y-8">
      {/* Header & Multi-Warehouse Pills */}
      <section className="rounded-3xl border border-[#B08A4A]/30 bg-white p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="ledger-eyebrow text-[#8A672C]">
              Multi-Warehouse Inventory &amp; Soft Reservations Ledger
            </p>
            <h2 className="font-editorial mt-1 text-3xl text-[#1C1410]">
              Tồn kho đa kho &amp; Nhật ký Giữ chỗ 15 phút
            </h2>
            <p className="mt-1 text-xs text-[#7A6A5B]">
              Theo dõi thời gian thực <code>Available / Reserved / Committed</code>{' '}
              trên các kho chuẩn (<code>HN_ATELIER</code>,{' '}
              <code>HCM_SHOWROOM</code>, <code>CENTRAL_WH</code>), giữ chỗ mềm
              15 phút và sổ cái biến động bất biến.
            </p>
          </div>

          <div className="flex items-center gap-3">
            {lastSyncedAt ? (
              <span className="font-mono text-[11px] text-[#7A6A5B]">
                Đồng bộ: {formatDateTime(lastSyncedAt)}
              </span>
            ) : null}
            <button
              type="button"
              disabled={loading}
              onClick={() => void loadAllInventoryData()}
              className="rounded-full bg-[#1C1410] px-5 py-2 text-xs uppercase tracking-[0.16em] text-[#EBCF8F] hover:opacity-90 disabled:opacity-50"
            >
              {loading ? 'Đang tải...' : 'Làm mới tồn kho'}
            </button>
          </div>
        </div>

        {errorMessage ? (
          <div
            role="alert"
            className="mt-4 rounded-2xl border border-[#8B2E2E]/35 bg-[#FFF5F4] px-4 py-3 text-xs text-[#8B2E2E]"
          >
            {errorMessage}
          </div>
        ) : null}

        {/* Warehouse Summary Filter Pills */}
        <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <button
            type="button"
            onClick={() => setSelectedWarehouseCode('ALL')}
            className={`rounded-2xl border p-4 text-left transition-colors ${
              selectedWarehouseCode === 'ALL'
                ? 'border-[#1C1410] bg-[#1C1410] text-[#FBF7EF]'
                : 'border-[#B08A4A]/30 bg-[#FBF7EF] text-[#1C1410] hover:border-[#8A672C]'
            }`}
          >
            <div className="flex items-center justify-between text-[10px] uppercase tracking-[0.16em]">
              <span className="font-mono">ALL_WAREHOUSES</span>
              <span>{warehouses.length} kho</span>
            </div>
            <p className="font-editorial mt-1 text-xl">Toàn hệ thống kho</p>
            <p className="mt-1 font-mono text-[11px] opacity-80">
              {stockLevels.length} bản ghi SKU
            </p>
          </button>

          {warehouses.map((wh) => {
            const active = selectedWarehouseCode === wh.code;
            const stats = warehouseStatsMap.get(wh.code);
            return (
              <button
                key={wh.id}
                type="button"
                onClick={() => setSelectedWarehouseCode(wh.code)}
                className={`rounded-2xl border p-4 text-left transition-colors ${
                  active
                    ? 'border-[#1C1410] bg-[#1C1410] text-[#FBF7EF]'
                    : 'border-[#B08A4A]/30 bg-[#FBF7EF] text-[#1C1410] hover:border-[#8A672C]'
                }`}
              >
                <div className="flex items-center justify-between text-[10px] uppercase tracking-[0.14em]">
                  <span className="font-mono font-semibold text-[#B08A4A]">
                    {wh.code}
                  </span>
                  <span>
                    {wh.warehouseType === WarehouseType.CENTRAL
                      ? 'Kho tổng'
                      : 'Showroom'}
                  </span>
                </div>
                <p className="mt-1 truncate text-sm font-medium">{wh.name}</p>
                <p className="mt-1 font-mono text-[11px] opacity-80">
                  Avl {stats?.available ?? 0} · Res {stats?.reserved ?? 0} · Com{' '}
                  {stats?.committed ?? 0}
                </p>
              </button>
            );
          })}
        </div>

        {/* KPI Totals Strip */}
        <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-5">
          <div className="rounded-2xl border border-[#B08A4A]/20 bg-[#FBF7EF] p-3.5">
            <p className="text-[10px] uppercase tracking-[0.14em] text-[#7A6A5B]">
              Sẵn bán (Available)
            </p>
            <p className="mt-1 font-mono text-2xl font-semibold text-[#1C1410]">
              {kpiTotals.available}
            </p>
          </div>
          <div className="rounded-2xl border border-[#B08A4A]/30 bg-[#FFF8EB] p-3.5">
            <p className="text-[10px] uppercase tracking-[0.14em] text-[#8A5A12]">
              Đang giữ chỗ (Reserved)
            </p>
            <p className="mt-1 font-mono text-2xl font-semibold text-[#8A5A12]">
              {kpiTotals.reserved}
            </p>
          </div>
          <div className="rounded-2xl border border-[#2E6B47]/25 bg-[#F2FBF6] p-3.5">
            <p className="text-[10px] uppercase tracking-[0.14em] text-[#1E4B32]">
              Đã chốt đơn (Committed)
            </p>
            <p className="mt-1 font-mono text-2xl font-semibold text-[#1E4B32]">
              {kpiTotals.committed}
            </p>
          </div>
          <div className="rounded-2xl border border-[#D9822B]/35 bg-[#FFF6E5] p-3.5">
            <p className="text-[10px] uppercase tracking-[0.14em] text-[#9A5B13]">
              Sắp hết (1–3 chiếc)
            </p>
            <p className="mt-1 font-mono text-2xl font-semibold text-[#9A5B13]">
              {kpiTotals.lowStockCount}
            </p>
          </div>
          <div className="rounded-2xl border border-[#8B2E2E]/35 bg-[#FFF5F4] p-3.5">
            <p className="text-[10px] uppercase tracking-[0.14em] text-[#8B2E2E]">
              Hết hàng (0)
            </p>
            <p className="mt-1 font-mono text-2xl font-semibold text-[#8B2E2E]">
              {kpiTotals.outOfStockCount}
            </p>
          </div>
        </div>
      </section>

      {/* Searchable & Filterable SKU Stock Table */}
      <section className="rounded-3xl border border-[#B08A4A]/30 bg-white p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="ledger-eyebrow text-[#8A672C]">
              Bảng tồn kho theo SKU &amp; Kho ({filteredStockLevels.length} dòng)
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <input
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Tìm theo SKU code, SKU UUID, kho..."
              className="w-64 rounded-full border border-[#B08A4A]/40 bg-[#FBF7EF] px-4 py-1.5 text-xs text-[#1C1410] outline-none focus:border-[#1C1410]"
            />

            {(
              [
                ['ALL', 'Tất cả'],
                ['LOW', 'Sắp hết (1–3)'],
                ['OUT', 'Hết hàng (0)'],
                ['RESERVED', 'Đang giữ chỗ'],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setStockStatusFilter(key)}
                className={`rounded-full px-3.5 py-1.5 text-[11px] transition-colors ${
                  stockStatusFilter === key
                    ? 'bg-[#1C1410] text-[#EBCF8F]'
                    : 'border border-[#B08A4A]/35 bg-[#FBF7EF] text-[#5C4B41]'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-[#B08A4A]/25 bg-[#F4EBDA]/65 text-[10px] uppercase tracking-[0.14em] text-[#8A672C]">
              <tr>
                <th className="px-3.5 py-3">Kho</th>
                <th className="px-3.5 py-3">SKU</th>
                <th className="px-3.5 py-3 text-right">Available</th>
                <th className="px-3.5 py-3 text-right">Reserved</th>
                <th className="px-3.5 py-3 text-right">Committed</th>
                <th className="px-3.5 py-3 text-right">Ngưỡng an toàn</th>
                <th className="px-3.5 py-3">Trạng thái</th>
                <th className="px-3.5 py-3">Cập nhật</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#B08A4A]/15">
              {filteredStockLevels.length === 0 ? (
                <tr>
                  <td
                    colSpan={8}
                    className="px-4 py-8 text-center text-xs text-[#7A6A5B]"
                  >
                    {loading
                      ? 'Đang tải bảng tồn kho...'
                      : 'Không có dòng SKU nào khớp bộ lọc hiện tại.'}
                  </td>
                </tr>
              ) : (
                filteredStockLevels.slice(0, 120).map((row) => {
                  const isOut = row.availableQty === 0;
                  const isLow =
                    !isOut &&
                    (row.availableQty <= 3 || row.lowStockWarning);

                  return (
                    <tr key={row.id} className="hover:bg-[#FBF7EF]/70">
                      <td className="px-3.5 py-2.5">
                        <span className="rounded-md bg-[#F4EBDA] px-2 py-0.5 font-mono text-[11px] font-medium text-[#1C1410]">
                          {row.warehouseCode}
                        </span>
                      </td>
                      <td className="px-3.5 py-2.5 font-mono">
                        <p className="font-semibold text-[#1C1410]">
                          {row.skuCode || row.skuId.slice(0, 12)}
                        </p>
                        <p className="text-[10px] text-[#7A6A5B]">
                          {row.skuId.slice(0, 18)}…
                        </p>
                      </td>
                      <td className="px-3.5 py-2.5 text-right font-mono font-semibold text-[#1C1410]">
                        {row.availableQty}
                      </td>
                      <td className="px-3.5 py-2.5 text-right font-mono text-[#8A5A12]">
                        {row.reservedQty}
                      </td>
                      <td className="px-3.5 py-2.5 text-right font-mono text-[#1E4B32]">
                        {row.committedQty}
                      </td>
                      <td className="px-3.5 py-2.5 text-right font-mono text-[#7A6A5B]">
                        {row.safetyThreshold}
                      </td>
                      <td className="px-3.5 py-2.5">
                        {isOut ? (
                          <span className="inline-flex rounded-full border border-[#8B2E2E]/40 bg-[#FFF5F4] px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-[#8B2E2E]">
                            Out of Stock
                          </span>
                        ) : isLow ? (
                          <span className="inline-flex rounded-full border border-[#D9822B]/45 bg-[#FFF6E5] px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-[#9A5B13]">
                            Low Stock · Còn {row.availableQty}
                          </span>
                        ) : (
                          <span className="inline-flex rounded-full border border-[#2E6B47]/35 bg-[#F2FBF6] px-2.5 py-0.5 text-[10px] font-medium uppercase tracking-[0.1em] text-[#1E4B32]">
                            Ổn định
                          </span>
                        )}
                      </td>
                      <td className="px-3.5 py-2.5 font-mono text-[11px] text-[#7A6A5B]">
                        {formatDateTime(row.updatedAt)}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Bottom 2-Column Operational Panels: Soft Reservations & Inventory Ledger Audit Feed */}
      <div className="grid gap-6 xl:grid-cols-2">
        {/* 15-Minute Soft Reservations Panel */}
        <section className="rounded-3xl border border-[#B08A4A]/30 bg-white p-6">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="ledger-eyebrow text-[#8A672C]">
                15-Minute Soft Reservations ({filteredReservations.length})
              </p>
              <h3 className="font-editorial mt-0.5 text-2xl text-[#1C1410]">
                Phiếu giữ chỗ tạm thời
              </h3>
            </div>

            <div className="flex flex-wrap gap-1.5">
              {(
                [
                  'ALL',
                  ReservationStatus.ACTIVE,
                  ReservationStatus.COMMITTED,
                  ReservationStatus.EXPIRED,
                  ReservationStatus.RELEASED,
                ] as const
              ).map((st) => (
                <button
                  key={st}
                  type="button"
                  onClick={() => setReservationFilter(st)}
                  className={`rounded-full px-2.5 py-1 font-mono text-[10px] transition-colors ${
                    reservationFilter === st
                      ? 'bg-[#1C1410] text-[#EBCF8F]'
                      : 'border border-[#B08A4A]/30 bg-[#FBF7EF] text-[#5C4B41]'
                  }`}
                >
                  {st}
                </button>
              ))}
            </div>
          </div>

          <div className="mt-4 max-h-96 space-y-3 overflow-y-auto pr-1">
            {filteredReservations.length === 0 ? (
              <p className="rounded-2xl border border-[#B08A4A]/20 bg-[#FBF7EF] p-6 text-center text-xs text-[#7A6A5B]">
                Chưa có phiếu giữ chỗ nào trong bộ lọc hiện tại.
              </p>
            ) : (
              filteredReservations.map((resv) => {
                const badge = RESERVATION_STATUS_META[resv.status];
                return (
                  <article
                    key={resv.id}
                    className="rounded-2xl border border-[#B08A4A]/20 bg-[#FBF7EF]/75 p-4 text-xs"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-mono font-semibold text-[#1C1410]">
                        {resv.referenceId}
                      </span>
                      <span
                        className={`rounded-full border px-2.5 py-0.5 font-mono text-[10px] font-medium ${badge.className}`}
                      >
                        {badge.label}
                      </span>
                    </div>

                    <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-[#5C4B41]">
                      <span className="rounded bg-white px-2 py-0.5 font-mono">
                        {resv.reservationType}
                      </span>
                      <span>Hết hạn: {formatDateTime(resv.expiresAt)}</span>
                      <span>Tạo: {formatDateTime(resv.createdAt)}</span>
                    </div>

                    {resv.items.length > 0 ? (
                      <ul className="mt-2 space-y-1 font-mono text-[11px] text-[#2B2019]">
                        {resv.items.map((line, idx) => (
                          <li key={`${resv.id}-${line.skuId}-${idx}`}>
                            • {line.warehouseCode} · {line.skuId.slice(0, 14)}… ×{' '}
                            <strong>{line.qty}</strong>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </article>
                );
              })
            )}
          </div>
        </section>

        {/* Chronological Inventory Ledger Audit Feed */}
        <section className="rounded-3xl border border-[#B08A4A]/30 bg-white p-6">
          <div>
            <p className="ledger-eyebrow text-[#8A672C]">
              Immutable Inventory Ledger ({filteredLedger.length})
            </p>
            <h3 className="font-editorial mt-0.5 text-2xl text-[#1C1410]">
              Nhật ký biến động tồn kho
            </h3>
          </div>

          <div className="mt-4 max-h-96 space-y-2.5 overflow-y-auto pr-1">
            {filteredLedger.length === 0 ? (
              <p className="rounded-2xl border border-[#B08A4A]/20 bg-[#FBF7EF] p-6 text-center text-xs text-[#7A6A5B]">
                Chưa có dòng sổ cái nào khớp bộ lọc.
              </p>
            ) : (
              filteredLedger.map((entry) => (
                <article
                  key={entry.id}
                  className="rounded-2xl border border-[#B08A4A]/20 bg-[#FBF7EF]/75 p-3.5 text-xs"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="rounded-full bg-[#1C1410] px-2.5 py-0.5 font-mono text-[10px] text-[#EBCF8F]">
                        {LEDGER_REASON_LABELS[entry.reason] ?? entry.reason}
                      </span>
                      {entry.warehouseCode ? (
                        <span className="font-mono text-[11px] text-[#8A672C]">
                          {entry.warehouseCode}
                        </span>
                      ) : null}
                    </div>
                    <span className="font-mono text-[10px] text-[#7A6A5B]">
                      {formatDateTime(entry.createdAt)}
                    </span>
                  </div>

                  <div className="mt-2 flex flex-wrap items-center justify-between gap-2 font-mono text-[11px]">
                    <span className="text-[#1C1410]">
                      SKU {entry.skuId.slice(0, 14)}…
                    </span>
                    <div className="flex items-center gap-3">
                      <span
                        className={
                          entry.deltaAvailable < 0
                            ? 'text-[#8B2E2E]'
                            : entry.deltaAvailable > 0
                              ? 'text-[#1E4B32]'
                              : 'text-[#7A6A5B]'
                        }
                      >
                        Avl {formatSignedDelta(entry.deltaAvailable)}
                      </span>
                      <span className="text-[#8A5A12]">
                        Res {formatSignedDelta(entry.deltaReserved)}
                      </span>
                      <span className="text-[#1E4B32]">
                        Com {formatSignedDelta(entry.deltaCommitted)}
                      </span>
                      <span className="rounded bg-white px-2 py-0.5 font-semibold text-[#1C1410]">
                        Số dư: {entry.balanceAvailable}
                      </span>
                    </div>
                  </div>

                  {entry.referenceId || entry.note ? (
                    <p className="mt-1.5 text-[11px] text-[#5C4B41]">
                      {entry.referenceId ? `Ref: ${entry.referenceId}` : ''}
                      {entry.referenceId && entry.note ? ' · ' : ''}
                      {entry.note ?? ''}
                    </p>
                  ) : null}
                </article>
              ))
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
