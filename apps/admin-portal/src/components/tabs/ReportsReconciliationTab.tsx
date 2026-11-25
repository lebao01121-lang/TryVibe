'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  InventoryLedgerReason,
  OrderStatus,
  Permission,
  PurchaseOrderCreatedSource,
  PurchaseOrderStatus,
  RmaType,
  canReadCostPrice,
  hasPermission,
  type GoodsReceiptDTO,
  type InventoryLedgerEntryDto,
  type OrderDTO,
  type PurchaseOrderDTO,
  type RmaRequestDTO,
  type Role,
  type SupplierDTO,
} from '@atelier/contracts';
import { adminFetch } from '@/lib/api-client';
import { emitPortalToast } from '../PortalToastBanner';

export interface ReportsReconciliationTabProps {
  roles: readonly Role[];
  darkMode?: boolean;
}

type OrderReconcileGroupKey = 'PAID_DELIVERED' | 'AWAITING_PAYMENT' | 'CANCELLED_LATE';
type PoStatusFilter = 'ALL' | 'NHAP_AI' | 'DA_XAC_NHAN' | 'HOAN_TAT';

function extractList<T>(data: unknown, keys: string[]): T[] {
  if (Array.isArray(data)) return data as T[];
  if (data && typeof data === 'object') {
    const rec = data as Record<string, unknown>;
    for (const key of keys) {
      if (Array.isArray(rec[key])) {
        return rec[key] as T[];
      }
    }
  }
  return [];
}

function formatVnd(amount: number): string {
  return `${new Intl.NumberFormat('vi-VN').format(Math.round(amount))}₫`;
}

function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    return new Intl.DateTimeFormat('vi-VN', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(iso));
  } catch {
    return iso.slice(0, 16);
  }
}

function escapeCsvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  let str = String(value);
  // Prevent Excel spreadsheet formula injection on string cells
  if (typeof value === 'string' && /^[=@+\t\r]/.test(str)) {
    str = `'${str}`;
  }
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function downloadUtf8BomCsv(
  filename: string,
  headers: string[],
  rows: Array<Array<string | number | null | undefined>>,
): void {
  const csvLines = [
    headers.map((h) => escapeCsvCell(h)).join(','),
    ...rows.map((row) => row.map((cell) => escapeCsvCell(cell)).join(',')),
  ];
  // Mandatory \uFEFF UTF-8 BOM so Vietnamese diacritics open cleanly in Excel
  const bomCsv = `\uFEFF${csvLines.join('\r\n')}`;
  const blob = new Blob([bomCsv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function classifyOrderBucket(status: OrderStatus): OrderReconcileGroupKey {
  if (
    status === OrderStatus.CONFIRMED ||
    status === OrderStatus.PACKING ||
    status === OrderStatus.SHIPPED ||
    status === OrderStatus.DELIVERED ||
    status === OrderStatus.COMPLETED
  ) {
    return 'PAID_DELIVERED';
  }
  if (
    status === OrderStatus.AWAITING_PAYMENT ||
    status === OrderStatus.PENDING_RESERVATION
  ) {
    return 'AWAITING_PAYMENT';
  }
  return 'CANCELLED_LATE';
}

function computePoTotalVnd(po: PurchaseOrderDTO): number | null {
  if (typeof po.totalCostVnd === 'number' && Number.isFinite(po.totalCostVnd)) {
    return po.totalCostVnd;
  }
  const hasLineCost = po.items.some((it) => typeof it.unitCostVnd === 'number');
  if (!hasLineCost) return null;
  return po.items.reduce(
    (sum, it) => sum + (it.lineCostVnd ?? (it.unitCostVnd ?? 0) * it.orderedQty),
    0,
  );
}

const LEDGER_REASON_VI: Record<InventoryLedgerReason, string> = {
  [InventoryLedgerReason.INITIAL_SEED]: 'Khởi tạo tồn',
  [InventoryLedgerReason.RESERVE]: 'Giữ chỗ (Reserve)',
  [InventoryLedgerReason.COMMIT]: 'Chốt đơn (Commit)',
  [InventoryLedgerReason.RELEASE_EXPIRED]: 'Tự nhả hết hạn 15p',
  [InventoryLedgerReason.CANCEL_RELEASE]: 'Hủy giữ chỗ',
  [InventoryLedgerReason.GRN_INBOUND]: 'Nhập kho GRN',
  [InventoryLedgerReason.RMA_RESTOCK]: 'Hoàn kho RMA',
  [InventoryLedgerReason.ADJUSTMENT]: 'Điều chỉnh thủ công',
  [InventoryLedgerReason.TRANSFER_OUT]: 'Xuất chuyển kho',
  [InventoryLedgerReason.TRANSFER_IN]: 'Nhập chuyển kho',
};

const ORDER_STATUS_VI: Record<OrderStatus, string> = {
  [OrderStatus.PENDING_RESERVATION]: 'Chờ giữ tồn',
  [OrderStatus.FAILED_OUT_OF_STOCK]: 'Hết hàng',
  [OrderStatus.AWAITING_PAYMENT]: 'Chờ thanh toán',
  [OrderStatus.CONFIRMED]: 'Đã xác nhận TT',
  [OrderStatus.PACKING]: 'Đang đóng gói',
  [OrderStatus.SHIPPED]: 'Đang giao vận',
  [OrderStatus.DELIVERED]: 'Đã giao',
  [OrderStatus.COMPLETED]: 'Hoàn tất',
  [OrderStatus.CANCELLED]: 'Đã hủy',
  [OrderStatus.LATE_PAYMENT_NEEDS_REFUND]: 'TT trễ · Cần hoàn tiền',
};

export function ReportsReconciliationTab({
  roles,
  darkMode = false,
}: ReportsReconciliationTabProps) {
  const canReadOrders = hasPermission(roles, Permission.ORDER_READ);
  const canReadPo = hasPermission(roles, Permission.INVENTORY_PO_READ);
  const canReadInventory = hasPermission(roles, Permission.INVENTORY_STOCK_READ);
  const showCostPrice = canReadCostPrice(roles);

  const [orders, setOrders] = useState<OrderDTO[]>([]);
  const [rmas, setRmas] = useState<RmaRequestDTO[]>([]);
  const [purchaseOrders, setPurchaseOrders] = useState<PurchaseOrderDTO[]>([]);
  const [goodsReceipts, setGoodsReceipts] = useState<GoodsReceiptDTO[]>([]);
  const [suppliers, setSuppliers] = useState<SupplierDTO[]>([]);
  const [ledger, setLedger] = useState<InventoryLedgerEntryDto[]>([]);

  const [loading, setLoading] = useState(true);
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);

  // Filters
  const [orderBucketFilter, setOrderBucketFilter] = useState<
    'ALL' | OrderReconcileGroupKey
  >('ALL');
  const [poStatusFilter, setPoStatusFilter] = useState<PoStatusFilter>('ALL');

  const loadReports = useCallback(
    async (notify = false) => {
      setLoading(true);
      setErrorBanner(null);

      const fetchPurchaseOrders = async () => {
        if (!canReadPo) return null;
        let res = await adminFetch<unknown>('/api/v1/admin/procurement/purchase-orders');
        if (!res.ok && res.status === 404) {
          res = await adminFetch<unknown>('/api/v1/admin/procurement/po');
        }
        return res;
      };

      const [ordersRes, rmaRes, poRes, grnRes, supRes, ledgerRes] = await Promise.all([
        canReadOrders
          ? adminFetch<unknown>('/api/v1/admin/orders?limit=250')
          : Promise.resolve(null),
        canReadOrders
          ? adminFetch<unknown>('/api/v1/admin/rma?limit=250')
          : Promise.resolve(null),
        fetchPurchaseOrders(),
        canReadPo
          ? adminFetch<unknown>('/api/v1/admin/procurement/goods-receipts')
          : Promise.resolve(null),
        canReadPo
          ? adminFetch<unknown>('/api/v1/admin/procurement/suppliers')
          : Promise.resolve(null),
        canReadInventory
          ? adminFetch<unknown>('/api/v1/admin/inventory/ledger?limit=250')
          : Promise.resolve(null),
      ]);

      if (ordersRes?.ok) {
        setOrders(extractList<OrderDTO>(ordersRes.data, ['items', 'orders', 'list']));
      }
      if (rmaRes?.ok) {
        setRmas(
          extractList<RmaRequestDTO>(rmaRes.data, ['items', 'rmas', 'requests', 'list']),
        );
      }
      if (poRes?.ok) {
        setPurchaseOrders(
          extractList<PurchaseOrderDTO>(poRes.data, ['items', 'purchaseOrders', 'list']),
        );
      }
      if (grnRes?.ok) {
        setGoodsReceipts(
          extractList<GoodsReceiptDTO>(grnRes.data, ['items', 'goodsReceipts', 'list']),
        );
      }
      if (supRes?.ok) {
        setSuppliers(
          extractList<SupplierDTO>(supRes.data, ['items', 'suppliers', 'list']),
        );
      }
      if (ledgerRes?.ok) {
        setLedger(
          extractList<InventoryLedgerEntryDto>(ledgerRes.data, ['items', 'ledger', 'list']),
        );
      }

      if (
        (!ordersRes || !ordersRes.ok) &&
        (!poRes || !poRes.ok) &&
        (!ledgerRes || !ledgerRes.ok)
      ) {
        setErrorBanner(
          'Chưa thể kết nối nguồn báo cáo doanh thu, PO B2B và sổ cái tồn kho từ BFF (:4000).',
        );
      }

      setLastSyncedAt(new Date().toISOString());
      setLoading(false);

      if (notify) {
        emitPortalToast({
          kind: 'success',
          title: 'BÁO CÁO & ĐỐI SOÁT',
          message: 'Đã làm mới dữ liệu đối soát đơn hàng, PO B2B và sổ cái kho.',
        });
      }
    },
    [canReadInventory, canReadOrders, canReadPo],
  );

  useEffect(() => {
    void loadReports(false);
  }, [loadReports]);

  const supplierMap = useMemo(() => {
    const map = new Map<string, SupplierDTO>();
    for (const s of suppliers) map.set(s.id, s);
    return map;
  }, [suppliers]);

  const grnCountByPoId = useMemo(() => {
    const map = new Map<string, { count: number; accepted: number; rejected: number }>();
    for (const grn of goodsReceipts) {
      const prev = map.get(grn.poId) ?? { count: 0, accepted: 0, rejected: 0 };
      prev.count += 1;
      prev.accepted += grn.totalAcceptedQty;
      prev.rejected += grn.totalRejectedQty;
      map.set(grn.poId, prev);
    }
    return map;
  }, [goodsReceipts]);

  // 4 Financial & SLA Summary Cards
  const financialSummary = useMemo(() => {
    const paidOrders = orders.filter(
      (o) => classifyOrderBucket(o.status) === 'PAID_DELIVERED',
    );
    const gmvVnd = paidOrders.reduce((sum, o) => sum + o.totalAmountVnd, 0);
    const aovVnd = paidOrders.length > 0 ? Math.round(gmvVnd / paidOrders.length) : 0;

    const rmaRatePct =
      orders.length > 0 ? Number(((rmas.length / orders.length) * 100).toFixed(1)) : 0;
    const sizeExchangeCount = rmas.filter(
      (r) => r.type === RmaType.SIZE_EXCHANGE,
    ).length;

    let totalPoVnd = 0;
    let hasAnyPoCost = false;
    const activePos = purchaseOrders.filter(
      (po) => po.status !== PurchaseOrderStatus.DA_HUY,
    );
    for (const po of activePos) {
      const cost = computePoTotalVnd(po);
      if (cost !== null) {
        totalPoVnd += cost;
        hasAnyPoCost = true;
      }
    }

    return {
      gmvVnd,
      aovVnd,
      paidOrderCount: paidOrders.length,
      totalOrderCount: orders.length,
      rmaCount: rmas.length,
      rmaRatePct,
      sizeExchangeCount,
      totalPoVnd,
      hasAnyPoCost: showCostPrice && hasAnyPoCost,
      activePoCount: activePos.length,
      grnCount: goodsReceipts.length,
    };
  }, [goodsReceipts.length, orders, purchaseOrders, rmas, showCostPrice]);

  // Order & Payment Reconciliation Grouped Rows
  const orderReconciliationBuckets = useMemo(() => {
    const defs: Array<{
      key: OrderReconcileGroupKey;
      label: string;
      statusTag: string;
      description: string;
    }> = [
      {
        key: 'PAID_DELIVERED',
        label: 'Đã thanh toán / Đã giao',
        statusTag: 'PAID / DELIVERED',
        description: 'CONFIRMED · PACKING · SHIPPED · DELIVERED · COMPLETED',
      },
      {
        key: 'AWAITING_PAYMENT',
        label: 'Chờ thanh toán / Giữ tồn 15p',
        statusTag: 'AWAITING_PAYMENT',
        description: 'AWAITING_PAYMENT · PENDING_RESERVATION',
      },
      {
        key: 'CANCELLED_LATE',
        label: 'Đã hủy / Thanh toán trễ cần hoàn',
        statusTag: 'CANCELLED / LATE_PAYMENT_NEEDS_REFUND',
        description: 'CANCELLED · FAILED_OUT_OF_STOCK · LATE_PAYMENT_NEEDS_REFUND',
      },
    ];

    const grandTotalVnd = Math.max(
      orders.reduce((s, o) => s + o.totalAmountVnd, 0),
      1,
    );

    return defs.map((def) => {
      const matched = orders.filter((o) => classifyOrderBucket(o.status) === def.key);
      const subtotalVnd = matched.reduce((s, o) => s + o.subtotalVnd, 0);
      const discountVnd = matched.reduce(
        (s, o) => s + o.voucherDiscountVnd + o.comboDiscountVnd,
        0,
      );
      const totalVnd = matched.reduce((s, o) => s + o.totalAmountVnd, 0);
      const lateCount = matched.filter(
        (o) => o.status === OrderStatus.LATE_PAYMENT_NEEDS_REFUND,
      ).length;

      const methodCounts = new Map<string, number>();
      for (const o of matched) {
        methodCounts.set(o.paymentMethod, (methodCounts.get(o.paymentMethod) ?? 0) + 1);
      }
      const methodSummary = Array.from(methodCounts.entries())
        .map(([m, c]) => `${m} (${c})`)
        .join(' · ');

      return {
        ...def,
        count: matched.length,
        subtotalVnd,
        discountVnd,
        totalVnd,
        lateCount,
        methodSummary: methodSummary || '—',
        sharePct: orders.length > 0 ? Math.round((totalVnd / grandTotalVnd) * 100) : 0,
      };
    });
  }, [orders]);

  const filteredOrders = useMemo(() => {
    if (orderBucketFilter === 'ALL') return orders;
    return orders.filter((o) => classifyOrderBucket(o.status) === orderBucketFilter);
  }, [orderBucketFilter, orders]);

  const filteredPurchaseOrders = useMemo(() => {
    return purchaseOrders.filter((po) => {
      if (poStatusFilter === 'ALL') return true;
      if (poStatusFilter === 'NHAP_AI') {
        return po.status === PurchaseOrderStatus.NHAP_AI;
      }
      if (poStatusFilter === 'DA_XAC_NHAN') {
        return (
          po.status === PurchaseOrderStatus.CHO_NCC_XAC_NHAN ||
          po.status === PurchaseOrderStatus.NCC_DA_XAC_NHAN ||
          po.status === PurchaseOrderStatus.HOAN_TAT_MOT_PHAN
        );
      }
      return po.status === PurchaseOrderStatus.HOAN_TAT;
    });
  }, [poStatusFilter, purchaseOrders]);

  // CSV Export Handlers (Real Client-Side UTF-8 BOM)
  const dateStamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');

  const handleExportOrdersCsv = () => {
    const headers = [
      'Mã đơn hàng',
      'Nhóm đối soát',
      'Trạng thái',
      'Khách hàng',
      'Email',
      'SĐT',
      'Thanh toán',
      'Vận chuyển',
      'Tạm tính (VND)',
      'Giảm giá (VND)',
      'Phí giao (VND)',
      'Tổng thanh toán (VND)',
      'Ngày tạo',
    ];
    const rows = orders.map((o) => [
      o.orderCode,
      classifyOrderBucket(o.status),
      ORDER_STATUS_VI[o.status] ?? o.status,
      o.shippingAddress?.recipientName ?? '',
      o.customerEmail ?? '',
      o.shippingAddress?.phone ?? '',
      o.paymentMethod,
      o.shippingMethod,
      o.subtotalVnd,
      o.voucherDiscountVnd + o.comboDiscountVnd,
      o.shippingFeeVnd,
      o.totalAmountVnd,
      o.createdAt,
    ]);
    downloadUtf8BomCsv(`tam-xuan-doi-soat-don-hang-${dateStamp}.csv`, headers, rows);
    emitPortalToast({
      kind: 'success',
      title: 'XUẤT CSV ĐƠN HÀNG',
      message: `Đã xuất ${rows.length} dòng đối soát đơn hàng (UTF-8 BOM chuẩn Excel tiếng Việt).`,
    });
  };

  const handleExportPoCsv = () => {
    const headers = [
      'Mã PO',
      'Nhà cung cấp',
      'Kho nhận',
      'Nguồn tạo',
      'Trạng thái PO',
      'Tổng SL đặt',
      'Tổng SL đã nhận',
      'Số phiếu GRN',
      'Tổng giá trị (VND)',
      'Ngày hẹn giao',
      'Ghi chú',
    ];
    const rows = purchaseOrders.map((po) => {
      const sup = supplierMap.get(po.supplierId);
      const grnInfo = grnCountByPoId.get(po.id);
      const totalVnd = computePoTotalVnd(po);
      return [
        po.poNumber,
        po.supplierName || sup?.name || po.supplierId,
        po.warehouseCode,
        po.createdSource,
        po.status,
        po.totalOrderedQty,
        po.totalReceivedQty,
        grnInfo?.count ?? 0,
        showCostPrice && totalVnd !== null ? totalVnd : 'Ẩn theo RBAC',
        po.confirmedDeliveryDate || po.expectedDeliveryDate,
        po.rationale ?? '',
      ];
    });
    downloadUtf8BomCsv(`tam-xuan-po-b2b-${dateStamp}.csv`, headers, rows);
    emitPortalToast({
      kind: 'success',
      title: 'XUẤT CSV PO B2B',
      message: `Đã xuất ${rows.length} đơn đặt hàng nhập B2B (UTF-8 BOM chuẩn Excel).`,
    });
  };

  const handleExportInventoryCsv = () => {
    const headers = [
      'ID sổ cái',
      'Mã kho',
      'SKU ID',
      'Lý do biến động',
      'Delta Available',
      'Delta Reserved',
      'Delta Committed',
      'Số dư Available',
      'Mã tham chiếu',
      'Ghi chú',
      'Thời gian',
    ];
    const rows = ledger.map((entry) => [
      entry.id,
      entry.warehouseCode ?? entry.warehouseId,
      entry.skuId,
      LEDGER_REASON_VI[entry.reason] ?? entry.reason,
      entry.deltaAvailable,
      entry.deltaReserved,
      entry.deltaCommitted,
      entry.balanceAvailable,
      entry.referenceId ?? '',
      entry.note ?? '',
      entry.createdAt,
    ]);
    downloadUtf8BomCsv(`tam-xuan-so-cai-ton-kho-${dateStamp}.csv`, headers, rows);
    emitPortalToast({
      kind: 'success',
      title: 'XUẤT CSV SỔ CÁI KHO',
      message: `Đã xuất ${rows.length} bút toán sổ cái tồn kho (UTF-8 BOM chuẩn Excel).`,
    });
  };

  // Theme tokens
  const cardCls = darkMode
    ? 'border-[#B08A4A]/30 bg-[#1A130E] text-[#FBF7EF]'
    : 'border-[#B08A4A]/25 bg-[#FFFDF9] text-[#1C1410]';
  const subCardCls = darkMode
    ? 'border-[#B08A4A]/25 bg-[#231912] text-[#FBF7EF]'
    : 'border-[#B08A4A]/20 bg-[#FBF7EF] text-[#1C1410]';
  const mutedCls = darkMode ? 'text-[#B4A391]' : 'text-[#7A6A5B]';
  const secondaryCls = darkMode ? 'text-[#DFD2C2]' : 'text-[#5C4B41]';
  const goldTextCls = darkMode ? 'text-[#EBCF8F]' : 'text-[#8A672C]';
  const tableHeadCls = darkMode
    ? 'border-b border-[#B08A4A]/25 bg-[#241A13] text-[#EBCF8F]'
    : 'border-b border-[#B08A4A]/20 bg-[#F4EBDA]/75 text-[#8A672C]';
  const rowHoverCls = darkMode ? 'hover:bg-[#251B14]' : 'hover:bg-[#FBF7EF]/85';

  const getBucketBadgeCls = (key: OrderReconcileGroupKey): string => {
    if (key === 'PAID_DELIVERED') {
      return darkMode
        ? 'border-emerald-500/40 bg-emerald-950/55 text-emerald-300'
        : 'border-[#2E6B47]/35 bg-[#EBF9F1] text-[#1E4B32]';
    }
    if (key === 'AWAITING_PAYMENT') {
      return darkMode
        ? 'border-amber-500/45 bg-amber-950/50 text-amber-300'
        : 'border-[#D9822B]/40 bg-[#FFF6E5] text-[#9A5B13]';
    }
    return darkMode
      ? 'border-rose-500/45 bg-rose-950/55 text-rose-300'
      : 'border-[#8B2E2E]/40 bg-[#FFF5F4] text-[#8B2E2E]';
  };

  const getPoStatusMeta = (status: PurchaseOrderStatus) => {
    switch (status) {
      case PurchaseOrderStatus.NHAP_AI:
        return {
          label: 'NHAP_AI · Chờ duyệt',
          cls: darkMode
            ? 'border-[#EBCF8F]/50 bg-[#2E2216] text-[#EBCF8F]'
            : 'border-[#B08A4A] bg-[#1C1410] text-[#EBCF8F]',
        };
      case PurchaseOrderStatus.CHO_NCC_XAC_NHAN:
        return {
          label: 'Chờ NCC xác nhận',
          cls: darkMode
            ? 'border-amber-500/45 bg-amber-950/50 text-amber-300'
            : 'border-[#D9822B]/45 bg-[#FFF6E5] text-[#9A5B13]',
        };
      case PurchaseOrderStatus.NCC_DA_XAC_NHAN:
        return {
          label: 'DA_XAC_NHAN · NCC chốt lịch',
          cls: darkMode
            ? 'border-sky-500/40 bg-sky-950/50 text-sky-300'
            : 'border-[#2E5A8B]/40 bg-[#F2F7FC] text-[#1E4066]',
        };
      case PurchaseOrderStatus.HOAN_TAT_MOT_PHAN:
        return {
          label: 'DA_XAC_NHAN · Nhập 1 phần',
          cls: darkMode
            ? 'border-amber-500/40 bg-amber-950/45 text-amber-300'
            : 'border-[#B08A4A]/55 bg-[#FFF8EB] text-[#8A5A12]',
        };
      case PurchaseOrderStatus.HOAN_TAT:
        return {
          label: 'HOAN_TAT · Đã nhập kho',
          cls: darkMode
            ? 'border-emerald-500/40 bg-emerald-950/55 text-emerald-300'
            : 'border-[#2E6B47]/40 bg-[#EBF9F1] text-[#1E4B32]',
        };
      default:
        return {
          label: 'DA_HUY',
          cls: darkMode
            ? 'border-[#7A6A5B]/40 bg-[#261E19] text-[#B4A391]'
            : 'border-[#7A6A5B]/35 bg-[#F4EBDA]/65 text-[#5C4B41]',
        };
    }
  };

  return (
    <div data-testid="reports-reconciliation-tab" className="space-y-6">
      {/* Header & Real UTF-8 BOM CSV Export Toolbar */}
      <section className={`rounded-3xl border p-6 ${cardCls}`}>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <p className={`ledger-eyebrow ${goldTextCls}`}>
              Financial Reporting, B2B Settlement &amp; UTF-8 BOM CSV Export
            </p>
            <h2 className="font-editorial mt-1 text-3xl font-normal tracking-tight">
              Báo cáo Doanh thu, Đối soát B2B &amp; Xuất CSV
            </h2>
            <p className={`mt-1 text-xs leading-relaxed ${mutedCls}`}>
              Đối soát dòng tiền đơn hàng, tỷ lệ đổi trả RMA, quyết toán đơn đặt hàng B2B
              &amp; GRN và xuất tệp <code>.csv</code> gắn mã nhận diện{' '}
              <code>UTF-8 BOM (\uFEFF)</code> mở chuẩn dấu tiếng Việt trên Excel.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {lastSyncedAt ? (
              <span className={`font-mono text-[11px] ${mutedCls}`}>
                Cập nhật: {formatDateTime(lastSyncedAt)}
              </span>
            ) : null}
            <button
              type="button"
              disabled={loading}
              onClick={() => void loadReports(true)}
              className={`rounded-full px-4 py-2 text-xs font-medium uppercase tracking-[0.14em] transition-opacity disabled:opacity-50 ${
                darkMode
                  ? 'bg-[#EBCF8F] text-[#1C1410] hover:bg-[#F5DDA7]'
                  : 'bg-[#1C1410] text-[#EBCF8F] hover:opacity-90'
              }`}
            >
              {loading ? 'Đang tổng hợp...' : 'Làm mới báo cáo'}
            </button>
          </div>
        </div>

        {errorBanner ? (
          <div
            role="alert"
            className={`mt-4 rounded-2xl border px-4 py-3 text-xs ${
              darkMode
                ? 'border-rose-500/45 bg-rose-950/40 text-rose-200'
                : 'border-[#8B2E2E]/35 bg-[#FFF5F4] text-[#8B2E2E]'
            }`}
          >
            {errorBanner}
          </div>
        ) : null}

        {/* UTF-8 BOM CSV Export Toolbar */}
        <div
          className={`mt-5 flex flex-wrap items-center justify-between gap-3 rounded-2xl border p-4 ${subCardCls}`}
        >
          <div>
            <p className={`font-mono text-[10px] font-semibold uppercase tracking-[0.16em] ${goldTextCls}`}>
              TRẠM XUẤT BÁO CÁO CSV · UTF-8 BOM EXCEL READY
            </p>
            <p className={`mt-0.5 text-xs ${secondaryCls}`}>
              Tải trực tiếp báo cáo kế toán, đối soát nhà cung cấp và sổ cái kho ngay trên
              trình duyệt.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              data-testid="export-orders-csv"
              onClick={handleExportOrdersCsv}
              className={`inline-flex items-center gap-1.5 rounded-full px-4 py-2 text-xs font-semibold transition-opacity hover:opacity-90 ${
                darkMode
                  ? 'bg-[#EBCF8F] text-[#1C1410]'
                  : 'bg-[#1C1410] text-[#EBCF8F]'
              }`}
            >
              ↓ Xuất CSV Đơn hàng ({orders.length})
            </button>

            <button
              type="button"
              data-testid="export-po-csv"
              onClick={handleExportPoCsv}
              className={`inline-flex items-center gap-1.5 rounded-full border px-4 py-2 text-xs font-semibold transition-colors ${
                darkMode
                  ? 'border-[#EBCF8F]/45 bg-[#1A130E] text-[#EBCF8F] hover:bg-[#2E2216]'
                  : 'border-[#B08A4A]/55 bg-white text-[#1C1410] hover:bg-[#F4EBDA]'
              }`}
            >
              ↓ Xuất CSV PO B2B ({purchaseOrders.length})
            </button>

            <button
              type="button"
              data-testid="export-inventory-csv"
              onClick={handleExportInventoryCsv}
              className={`inline-flex items-center gap-1.5 rounded-full border px-4 py-2 text-xs font-semibold transition-colors ${
                darkMode
                  ? 'border-[#B08A4A]/40 bg-[#1A130E] text-[#DFD2C2] hover:border-[#EBCF8F]'
                  : 'border-[#B08A4A]/45 bg-white text-[#5C4B41] hover:border-[#1C1410] hover:text-[#1C1410]'
              }`}
            >
              ↓ Xuất CSV Sổ cái Kho ({ledger.length})
            </button>
          </div>
        </div>

        {/* 4 Financial & SLA Summary Cards */}
        <div className="mt-5 grid grid-cols-1 gap-3.5 sm:grid-cols-2 xl:grid-cols-4">
          <div className={`rounded-2xl border p-4 ${subCardCls}`}>
            <p className={`text-[10px] font-semibold uppercase tracking-[0.16em] ${mutedCls}`}>
              Tổng Doanh thu (GMV)
            </p>
            <p className={`mt-1.5 font-mono text-2xl font-bold tabular-nums ${goldTextCls}`}>
              {formatVnd(financialSummary.gmvVnd)}
            </p>
            <p className={`mt-1.5 text-[11px] ${secondaryCls}`}>
              Từ <strong>{financialSummary.paidOrderCount}</strong> /{' '}
              {financialSummary.totalOrderCount} đơn hợp lệ
            </p>
          </div>

          <div className={`rounded-2xl border p-4 ${subCardCls}`}>
            <p className={`text-[10px] font-semibold uppercase tracking-[0.16em] ${mutedCls}`}>
              Giá trị Đơn TB (AOV)
            </p>
            <p className="mt-1.5 font-mono text-2xl font-bold tabular-nums">
              {formatVnd(financialSummary.aovVnd)}
            </p>
            <p className={`mt-1.5 text-[11px] ${secondaryCls}`}>
              Bình quân mỗi đơn thanh toán
            </p>
          </div>

          <div className={`rounded-2xl border p-4 ${subCardCls}`}>
            <p className={`text-[10px] font-semibold uppercase tracking-[0.16em] ${mutedCls}`}>
              Tỷ lệ Yêu cầu Đổi/Trả (RMA %)
            </p>
            <p
              className={`mt-1.5 font-mono text-2xl font-bold tabular-nums ${
                financialSummary.rmaRatePct >= 15
                  ? darkMode
                    ? 'text-rose-300'
                    : 'text-[#8B2E2E]'
                  : darkMode
                    ? 'text-emerald-300'
                    : 'text-[#1E4B32]'
              }`}
            >
              {financialSummary.rmaRatePct}%
            </p>
            <p className={`mt-1.5 text-[11px] ${secondaryCls}`}>
              <strong>{financialSummary.rmaCount}</strong> phiếu RMA (
              {financialSummary.sizeExchangeCount} đổi size)
            </p>
          </div>

          <div className={`rounded-2xl border p-4 ${subCardCls}`}>
            <p className={`text-[10px] font-semibold uppercase tracking-[0.16em] ${mutedCls}`}>
              Tổng Giá trị Đơn nhập B2B (PO)
            </p>
            <p className="mt-1.5 font-mono text-2xl font-bold tabular-nums">
              {financialSummary.hasAnyPoCost
                ? formatVnd(financialSummary.totalPoVnd)
                : showCostPrice
                  ? formatVnd(0)
                  : 'Ẩn (RBAC)'}
            </p>
            <p className={`mt-1.5 text-[11px] ${secondaryCls}`}>
              <strong>{financialSummary.activePoCount}</strong> PO hiệu lực ·{' '}
              {financialSummary.grnCount} biên bản GRN
            </p>
          </div>
        </div>
      </section>

      {/* Section 1: Order & Payment Reconciliation Table */}
      <section className={`overflow-hidden rounded-3xl border ${cardCls}`}>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#B08A4A]/20 px-6 py-4">
          <div>
            <p className={`ledger-eyebrow ${goldTextCls}`}>
              Order &amp; Payment Reconciliation · Đối soát theo Nhóm Trạng thái
            </p>
            <h3 className="font-editorial mt-0.5 text-2xl">
              Bảng Đối soát Doanh thu &amp; Thanh toán ({orders.length} đơn)
            </h3>
          </div>

          <div className="flex flex-wrap gap-1.5">
            {(
              [
                ['ALL', 'Tất cả nhóm'],
                ['PAID_DELIVERED', 'PAID / DELIVERED'],
                ['AWAITING_PAYMENT', 'AWAITING_PAYMENT'],
                ['CANCELLED_LATE', 'CANCELLED / LATE'],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setOrderBucketFilter(key)}
                className={`rounded-full px-3 py-1 font-mono text-[10px] transition-colors ${
                  orderBucketFilter === key
                    ? darkMode
                      ? 'bg-[#EBCF8F] font-semibold text-[#1C1410]'
                      : 'bg-[#1C1410] text-[#EBCF8F]'
                    : darkMode
                      ? 'border border-[#B08A4A]/30 bg-[#231912] text-[#DFD2C2]'
                      : 'border border-[#B08A4A]/30 bg-[#FBF7EF] text-[#5C4B41]'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* Grouped Reconciliation Matrix */}
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className={`text-[10px] uppercase tracking-[0.14em] ${tableHeadCls}`}>
              <tr>
                <th className="px-5 py-3">Nhóm trạng thái đối soát</th>
                <th className="px-4 py-3 text-right">Số đơn</th>
                <th className="px-4 py-3">Cổng thanh toán</th>
                <th className="px-4 py-3 text-right">Tạm tính</th>
                <th className="px-4 py-3 text-right">Voucher / Combo</th>
                <th className="px-4 py-3 text-right">Thực thu / Giá trị</th>
                <th className="px-5 py-3 text-right">Tỷ trọng</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#B08A4A]/15">
              {orderReconciliationBuckets.map((bucket) => (
                <tr key={bucket.key} className={`transition-colors ${rowHoverCls}`}>
                  <td className="px-5 py-3.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={`rounded-full border px-2.5 py-0.5 font-mono text-[10px] font-semibold ${getBucketBadgeCls(bucket.key)}`}
                      >
                        {bucket.statusTag}
                      </span>
                      <span className="font-semibold">{bucket.label}</span>
                    </div>
                    <p className={`mt-1 font-mono text-[10px] ${mutedCls}`}>
                      {bucket.description}
                      {bucket.lateCount > 0
                        ? ` · ⚠ ${bucket.lateCount} đơn thanh toán trễ cần hoàn`
                        : ''}
                    </p>
                  </td>
                  <td className="px-4 py-3.5 text-right font-mono font-semibold tabular-nums">
                    {bucket.count}
                  </td>
                  <td className={`px-4 py-3.5 font-mono text-[11px] ${secondaryCls}`}>
                    {bucket.methodSummary}
                  </td>
                  <td className="px-4 py-3.5 text-right font-mono tabular-nums">
                    {formatVnd(bucket.subtotalVnd)}
                  </td>
                  <td className={`px-4 py-3.5 text-right font-mono tabular-nums ${mutedCls}`}>
                    -{formatVnd(bucket.discountVnd)}
                  </td>
                  <td
                    className={`px-4 py-3.5 text-right font-mono font-semibold tabular-nums ${goldTextCls}`}
                  >
                    {formatVnd(bucket.totalVnd)}
                  </td>
                  <td className="px-5 py-3.5 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <div
                        className={`h-2 w-16 overflow-hidden rounded-full ${
                          darkMode ? 'bg-[#140E0A]' : 'bg-[#E9DFCE]'
                        }`}
                      >
                        <div
                          style={{ width: `${bucket.sharePct}%` }}
                          className={`h-full rounded-full ${
                            bucket.key === 'PAID_DELIVERED'
                              ? 'bg-emerald-600'
                              : bucket.key === 'AWAITING_PAYMENT'
                                ? 'bg-amber-500'
                                : 'bg-rose-600'
                          }`}
                        />
                      </div>
                      <span className="w-9 font-mono text-[11px] font-semibold tabular-nums">
                        {bucket.sharePct}%
                      </span>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Detailed Order Slice */}
        {filteredOrders.length > 0 ? (
          <div className="border-t border-[#B08A4A]/20 px-6 py-4">
            <p className={`mb-2.5 font-mono text-[10px] uppercase tracking-[0.14em] ${mutedCls}`}>
              Chi tiết giao dịch đối soát gần nhất ({Math.min(8, filteredOrders.length)} /{' '}
              {filteredOrders.length} đơn)
            </p>
            <div className="grid grid-cols-1 gap-2.5 md:grid-cols-2">
              {filteredOrders.slice(0, 8).map((ord) => {
                const bucketKey = classifyOrderBucket(ord.status);
                return (
                  <div
                    key={ord.id}
                    className={`flex items-center justify-between gap-3 rounded-2xl border px-4 py-2.5 text-xs ${subCardCls}`}
                  >
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="font-mono font-semibold">{ord.orderCode}</span>
                        <span
                          className={`rounded-full border px-2 py-0.5 text-[10px] ${getBucketBadgeCls(bucketKey)}`}
                        >
                          {ORDER_STATUS_VI[ord.status] ?? ord.status}
                        </span>
                      </div>
                      <p className={`mt-0.5 truncate text-[11px] ${mutedCls}`}>
                        {ord.shippingAddress?.recipientName} · {ord.paymentMethod} ·{' '}
                        {formatDateTime(ord.createdAt)}
                      </p>
                    </div>
                    <span className={`shrink-0 font-mono font-semibold tabular-nums ${goldTextCls}`}>
                      {formatVnd(ord.totalAmountVnd)}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        ) : null}
      </section>

      {/* Section 2: B2B Supplier PO & GRN Settlement Table */}
      <section className={`overflow-hidden rounded-3xl border ${cardCls}`}>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#B08A4A]/20 px-6 py-4">
          <div>
            <p className={`ledger-eyebrow ${goldTextCls}`}>
              B2B Supplier Purchase Orders &amp; GRN Settlement
            </p>
            <h3 className="font-editorial mt-0.5 text-2xl">
              Đối soát Đơn nhập B2B &amp; Nghiệm thu GRN ({filteredPurchaseOrders.length})
            </h3>
          </div>

          <div className="flex flex-wrap gap-1.5">
            {(
              [
                ['ALL', 'Tất cả PO'],
                ['NHAP_AI', 'NHAP_AI'],
                ['DA_XAC_NHAN', 'DA_XAC_NHAN'],
                ['HOAN_TAT', 'HOAN_TAT'],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setPoStatusFilter(key)}
                className={`rounded-full px-3 py-1 font-mono text-[10px] transition-colors ${
                  poStatusFilter === key
                    ? darkMode
                      ? 'bg-[#EBCF8F] font-semibold text-[#1C1410]'
                      : 'bg-[#1C1410] text-[#EBCF8F]'
                    : darkMode
                      ? 'border border-[#B08A4A]/30 bg-[#231912] text-[#DFD2C2]'
                      : 'border border-[#B08A4A]/30 bg-[#FBF7EF] text-[#5C4B41]'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {!canReadPo ? (
          <div className="p-6 text-xs">
            <p className={`rounded-2xl border p-4 ${subCardCls} ${mutedCls}`}>
              Vai trò hiện tại không có quyền <code>INVENTORY_PO_READ</code> để xem sổ
              quyết toán PO nhà cung cấp B2B.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className={`text-[10px] uppercase tracking-[0.14em] ${tableHeadCls}`}>
                <tr>
                  <th className="px-5 py-3">Nhà cung cấp</th>
                  <th className="px-4 py-3">Mã PO &amp; Kho</th>
                  <th className="px-4 py-3">Trạng thái</th>
                  <th className="px-4 py-3 text-right">Nghiệm thu GRN</th>
                  <th className="px-4 py-3 text-right">Tổng giá trị (VND)</th>
                  <th className="px-5 py-3 text-right">Ngày hẹn giao</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#B08A4A]/15">
                {filteredPurchaseOrders.length === 0 ? (
                  <tr>
                    <td colSpan={6} className={`px-6 py-8 text-center ${mutedCls}`}>
                      {loading
                        ? 'Đang tải danh sách PO B2B...'
                        : 'Chưa có đơn đặt hàng B2B nào khớp bộ lọc.'}
                    </td>
                  </tr>
                ) : (
                  filteredPurchaseOrders.map((po) => {
                    const supplier = supplierMap.get(po.supplierId);
                    const statusMeta = getPoStatusMeta(po.status);
                    const grnInfo = grnCountByPoId.get(po.id);
                    const poCost = computePoTotalVnd(po);

                    return (
                      <tr key={po.id} className={`transition-colors ${rowHoverCls}`}>
                        <td className="px-5 py-3">
                          <p className="font-semibold">
                            {po.supplierName || supplier?.name || po.supplierId.slice(0, 14)}
                          </p>
                          <p className={`font-mono text-[10px] ${mutedCls}`}>
                            {po.supplierCode || supplier?.code || 'SUPPLIER'}
                            {supplier ? ` · Lead ${supplier.leadTimeDays}d` : ''}
                          </p>
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="font-mono font-semibold">{po.poNumber}</span>
                            {po.createdSource === PurchaseOrderCreatedSource.AI_COPILOT ? (
                              <span
                                className={`rounded-full border px-2 py-0.5 font-mono text-[9px] ${
                                  darkMode
                                    ? 'border-[#EBCF8F]/40 bg-[#2E2216] text-[#EBCF8F]'
                                    : 'border-[#B08A4A]/45 bg-[#F4EBDA] text-[#8A672C]'
                                }`}
                              >
                                AI_COPILOT
                              </span>
                            ) : null}
                          </div>
                          <p className={`font-mono text-[10px] ${mutedCls}`}>
                            Kho: {po.warehouseCode} · {po.items.length} dòng SKU
                          </p>
                        </td>
                        <td className="px-4 py-3">
                          <span
                            className={`inline-flex rounded-full border px-2.5 py-0.5 font-mono text-[10px] font-medium ${statusMeta.cls}`}
                          >
                            {statusMeta.label}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-right font-mono tabular-nums">
                          <span className="font-semibold">
                            {po.totalReceivedQty}/{po.totalOrderedQty}
                          </span>
                          <p className={`text-[10px] ${mutedCls}`}>
                            {grnInfo ? `${grnInfo.count} GRN` : '0 GRN'}
                          </p>
                        </td>
                        <td
                          className={`px-4 py-3 text-right font-mono font-semibold tabular-nums ${goldTextCls}`}
                        >
                          {showCostPrice && poCost !== null
                            ? formatVnd(poCost)
                            : 'Ẩn (RBAC)'}
                        </td>
                        <td className="px-5 py-3 text-right font-mono text-[11px]">
                          {po.confirmedDeliveryDate || po.expectedDeliveryDate}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Section 3: Recent Inventory Ledger Snapshot */}
      <section className={`overflow-hidden rounded-3xl border ${cardCls}`}>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#B08A4A]/20 px-6 py-4">
          <div>
            <p className={`ledger-eyebrow ${goldTextCls}`}>
              Immutable Inventory Ledger Preview · Dữ liệu Xuất CSV Kho
            </p>
            <h3 className="font-editorial mt-0.5 text-2xl">
              Bút toán Biến động Tồn kho gần nhất ({ledger.length} bản ghi)
            </h3>
          </div>
          <span className={`font-mono text-[11px] ${mutedCls}`}>
            Hiển thị {Math.min(6, ledger.length)} bút toán mới nhất
          </span>
        </div>

        <div className="grid grid-cols-1 gap-3 p-5 md:grid-cols-2 xl:grid-cols-3">
          {ledger.length === 0 ? (
            <p className={`col-span-full rounded-2xl border p-6 text-center text-xs ${subCardCls} ${mutedCls}`}>
              {loading
                ? 'Đang tải sổ cái biến động tồn kho...'
                : 'Chưa có bút toán biến động tồn kho.'}
            </p>
          ) : (
            ledger.slice(0, 6).map((entry) => (
              <article
                key={entry.id}
                className={`rounded-2xl border p-3.5 text-xs ${subCardCls}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span
                    className={`rounded-full px-2.5 py-0.5 font-mono text-[10px] font-medium ${
                      darkMode
                        ? 'bg-[#140E0A] text-[#EBCF8F]'
                        : 'bg-[#1C1410] text-[#EBCF8F]'
                    }`}
                  >
                    {LEDGER_REASON_VI[entry.reason] ?? entry.reason}
                  </span>
                  <span className={`font-mono text-[10px] ${mutedCls}`}>
                    {entry.warehouseCode ?? 'CENTRAL_WH'}
                  </span>
                </div>
                <div className="mt-2 flex items-center justify-between gap-2 font-mono text-[11px]">
                  <span className="truncate">SKU {entry.skuId.slice(0, 12)}…</span>
                  <span
                    className={`font-semibold ${
                      entry.deltaAvailable < 0
                        ? darkMode
                          ? 'text-rose-300'
                          : 'text-[#8B2E2E]'
                        : entry.deltaAvailable > 0
                          ? darkMode
                            ? 'text-emerald-300'
                            : 'text-[#1E4B32]'
                          : mutedCls
                    }`}
                  >
                    Avl {entry.deltaAvailable > 0 ? `+${entry.deltaAvailable}` : entry.deltaAvailable}{' '}
                    → {entry.balanceAvailable}
                  </span>
                </div>
                <p className={`mt-1 truncate font-mono text-[10px] ${mutedCls}`}>
                  {formatDateTime(entry.createdAt)}
                  {entry.referenceId ? ` · ${entry.referenceId}` : ''}
                </p>
              </article>
            ))
          )}
        </div>
      </section>
    </div>
  );
}
