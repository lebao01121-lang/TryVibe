'use client';

import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  PurchaseOrderCreatedSource,
  PurchaseOrderStatus,
  SupplierPayableStatus,
  type GoodsReceiptDTO,
  type PurchaseOrderDTO,
  type StockLevelAdminDto,
  type SupplierDTO,
  type SupplierPayableDTO,
} from '@atelier/contracts';
import { adminFetch } from '@/lib/api-client';

function extractList<T>(data: unknown): T[] {
  if (Array.isArray(data)) return data as T[];
  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    for (const key of [
      'items',
      'list',
      'rows',
      'suppliers',
      'purchaseOrders',
      'goodsReceipts',
      'payables',
    ]) {
      if (Array.isArray(obj[key])) {
        return obj[key] as T[];
      }
    }
  }
  return [];
}

const FORMAT_VND = (amount: number): string =>
  `${new Intl.NumberFormat('vi-VN').format(amount)}₫`;

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

const PO_STATUS_BADGES: Record<
  PurchaseOrderStatus,
  { label: string; cls: string }
> = {
  [PurchaseOrderStatus.NHAP_AI]: {
    label: 'NHAP_AI · Chờ duyệt nội bộ',
    cls: 'border-[#B08A4A] bg-[#1C1410] text-[#EBCF8F]',
  },
  [PurchaseOrderStatus.CHO_NCC_XAC_NHAN]: {
    label: 'Chờ NCC xác nhận',
    cls: 'border-[#D9822B]/45 bg-[#FFF6E5] text-[#9A5B13]',
  },
  [PurchaseOrderStatus.NCC_DA_XAC_NHAN]: {
    label: 'NCC đã xác nhận',
    cls: 'border-[#2E5A8B]/40 bg-[#F2F7FC] text-[#1E4066]',
  },
  [PurchaseOrderStatus.HOAN_TAT_MOT_PHAN]: {
    label: 'Nhập một phần',
    cls: 'border-[#B08A4A]/55 bg-[#FFF8EB] text-[#8A5A12]',
  },
  [PurchaseOrderStatus.HOAN_TAT]: {
    label: 'Hoàn tất nhập kho',
    cls: 'border-[#2E6B47]/40 bg-[#F2FBF6] text-[#1E4B32]',
  },
  [PurchaseOrderStatus.DA_HUY]: {
    label: 'Đã hủy',
    cls: 'border-[#7A6A5B]/35 bg-[#F4EBDA]/60 text-[#5C4B41]',
  },
};

interface GrnDraftLine {
  poItemId: string;
  skuId: string;
  skuCode: string;
  orderedQty: number;
  alreadyAccepted: number;
  receivedQty: number;
  acceptedQty: number;
  rejectedDefectQty: number;
  batchCode: string;
}

export function ProcurementTab() {
  const [suppliers, setSuppliers] = useState<SupplierDTO[]>([]);
  const [purchaseOrders, setPurchaseOrders] = useState<PurchaseOrderDTO[]>([]);
  const [goodsReceipts, setGoodsReceipts] = useState<GoodsReceiptDTO[]>([]);
  const [payables, setPayables] = useState<SupplierPayableDTO[]>([]);
  const [stockLevels, setStockLevels] = useState<StockLevelAdminDto[]>([]);

  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{
    kind: 'success' | 'error';
    message: string;
  } | null>(null);

  // Manual PO Creation Form state
  const [showCreatePo, setShowCreatePo] = useState(false);
  const [poSupplierId, setPoSupplierId] = useState('');
  const [poWarehouseCode, setPoWarehouseCode] = useState('CENTRAL_WH');
  const [poExpectedDate, setPoExpectedDate] = useState(() => {
    const d = new Date(Date.now() + 7 * 86_400_000);
    return d.toISOString().slice(0, 10);
  });
  const [poSkuId, setPoSkuId] = useState('');
  const [poOrderedQty, setPoOrderedQty] = useState(20);
  const [poUnitCostVnd, setPoUnitCostVnd] = useState(650000);
  const [poRationale, setPoRationale] = useState(
    'Bổ sung định kỳ các size chủ lực cho showroom & kho trung tâm.',
  );

  // Partial / Defect GRN Form state
  const [selectedGrnPoId, setSelectedGrnPoId] = useState('');
  const [grnNote, setGrnNote] = useState('');
  const [grnLines, setGrnLines] = useState<GrnDraftLine[]>([]);

  const loadAll = useCallback(async () => {
    setLoading(true);
    const [supRes, poRes, grnRes, payRes, stockRes] = await Promise.all([
      adminFetch<unknown>('/api/v1/admin/procurement/suppliers'),
      adminFetch<unknown>('/api/v1/admin/procurement/purchase-orders'),
      adminFetch<unknown>('/api/v1/admin/procurement/goods-receipts'),
      adminFetch<unknown>('/api/v1/admin/procurement/payables'),
      adminFetch<unknown>('/api/v1/admin/inventory/stock-levels'),
    ]);

    const supList = supRes.ok ? extractList<SupplierDTO>(supRes.data) : [];
    const poList = poRes.ok ? extractList<PurchaseOrderDTO>(poRes.data) : [];
    const grnList = grnRes.ok ? extractList<GoodsReceiptDTO>(grnRes.data) : [];
    const payList = payRes.ok
      ? extractList<SupplierPayableDTO>(payRes.data)
      : [];
    const stockList = stockRes.ok
      ? extractList<StockLevelAdminDto>(stockRes.data)
      : [];

    setSuppliers(supList);
    setPurchaseOrders(poList);
    setGoodsReceipts(grnList);
    setPayables(payList);
    setStockLevels(stockList);

    if (!poSupplierId && supList.length > 0) {
      setPoSupplierId(supList[0]!.id);
    }
    if (!poSkuId && stockList.length > 0) {
      setPoSkuId(stockList[0]!.skuId);
    }

    if (!poRes.ok && !supRes.ok) {
      setFeedback({
        kind: 'error',
        message:
          poRes.error?.message ||
          'Chưa thể tải dữ liệu Thu mua B2B. Kiểm tra quyền WAREHOUSE_MANAGER / SUPER_ADMIN.',
      });
    }
    setLoading(false);
  }, [poSkuId, poSupplierId]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const supplierMap = useMemo(() => {
    const map = new Map<string, SupplierDTO>();
    for (const s of suppliers) map.set(s.id, s);
    return map;
  }, [suppliers]);

  const uniqueSkus = useMemo(() => {
    const seen = new Map<string, StockLevelAdminDto>();
    for (const row of stockLevels) {
      if (!seen.has(row.skuId)) seen.set(row.skuId, row);
    }
    return Array.from(seen.values());
  }, [stockLevels]);

  const receivablePos = useMemo(
    () =>
      purchaseOrders.filter(
        (po) =>
          po.status === PurchaseOrderStatus.NCC_DA_XAC_NHAN ||
          po.status === PurchaseOrderStatus.HOAN_TAT_MOT_PHAN,
      ),
    [purchaseOrders],
  );

  // Sync GRN draft lines when selected PO changes
  const handleSelectGrnPo = (poId: string) => {
    setSelectedGrnPoId(poId);
    const targetPo = purchaseOrders.find((p) => p.id === poId);
    if (!targetPo) {
      setGrnLines([]);
      return;
    }
    const batchDefault = `BATCH-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`;
    setGrnLines(
      targetPo.items.map((item) => {
        const remaining = Math.max(0, item.orderedQty - item.acceptedQty);
        return {
          poItemId: item.id,
          skuId: item.skuId,
          skuCode: item.skuCode,
          orderedQty: item.orderedQty,
          alreadyAccepted: item.acceptedQty,
          receivedQty: remaining || 1,
          acceptedQty: remaining || 1,
          rejectedDefectQty: 0,
          batchCode: batchDefault,
        };
      }),
    );
  };

  const handleSubmitPoToSupplier = async (po: PurchaseOrderDTO) => {
    setBusyId(`submit-${po.id}`);
    setFeedback(null);

    const res = await adminFetch<unknown>(
      `/api/v1/admin/procurement/purchase-orders/${encodeURIComponent(po.id)}/submit`,
      { method: 'POST', body: JSON.stringify({}) },
    );

    if (res.ok) {
      setFeedback({
        kind: 'success',
        message: `Đã duyệt & phát hành ${po.poNumber} sang Partner Portal (CHO_NCC_XAC_NHAN).`,
      });
      await loadAll();
    } else {
      setFeedback({
        kind: 'error',
        message:
          res.error?.message || `Không thể duyệt phát hành ${po.poNumber}.`,
      });
    }
    setBusyId(null);
  };

  const handleCreateManualPo = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!poSupplierId || !poSkuId) {
      setFeedback({
        kind: 'error',
        message: 'Vui lòng chọn Nhà cung cấp và SKU cần đặt nhập.',
      });
      return;
    }

    setBusyId('create-po');
    setFeedback(null);

    const selectedSku = uniqueSkus.find((s) => s.skuId === poSkuId);

    const res = await adminFetch<PurchaseOrderDTO>(
      '/api/v1/admin/procurement/purchase-orders',
      {
        method: 'POST',
        body: JSON.stringify({
          supplierId: poSupplierId,
          warehouseCode: poWarehouseCode,
          expectedDeliveryDate: poExpectedDate,
          rationale: poRationale.trim() || undefined,
          createdSource: PurchaseOrderCreatedSource.USER,
          items: [
            {
              skuId: poSkuId,
              skuCode: selectedSku?.skuCode,
              orderedQty: Number(poOrderedQty),
              unitCostVnd: Number(poUnitCostVnd),
            },
          ],
        }),
      },
    );

    if (res.ok) {
      setFeedback({
        kind: 'success',
        message: `Đã tạo đơn nhập hàng ${res.data?.poNumber ?? ''} thành công.`,
      });
      setShowCreatePo(false);
      await loadAll();
    } else {
      setFeedback({
        kind: 'error',
        message: res.error?.message || 'Tạo đơn nhập hàng thủ công thất bại.',
      });
    }
    setBusyId(null);
  };

  const updateGrnLine = (
    idx: number,
    patch: Partial<Pick<GrnDraftLine, 'receivedQty' | 'acceptedQty' | 'rejectedDefectQty' | 'batchCode'>>,
  ) => {
    setGrnLines((prev) =>
      prev.map((line, i) => {
        if (i !== idx) return line;
        const next = { ...line, ...patch };
        if (patch.receivedQty !== undefined) {
          const r = Math.max(1, patch.receivedQty);
          const rej = Math.min(r, next.rejectedDefectQty);
          next.receivedQty = r;
          next.rejectedDefectQty = rej;
          next.acceptedQty = r - rej;
        } else if (patch.acceptedQty !== undefined) {
          const acc = Math.min(next.receivedQty, Math.max(0, patch.acceptedQty));
          next.acceptedQty = acc;
          next.rejectedDefectQty = Math.max(0, next.receivedQty - acc);
        } else if (patch.rejectedDefectQty !== undefined) {
          const rej = Math.min(
            next.receivedQty,
            Math.max(0, patch.rejectedDefectQty),
          );
          next.rejectedDefectQty = rej;
          next.acceptedQty = Math.max(0, next.receivedQty - rej);
        }
        return next;
      }),
    );
  };

  const handleSubmitGrn = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const targetPo = purchaseOrders.find((p) => p.id === selectedGrnPoId);
    if (!targetPo || grnLines.length === 0) return;

    setBusyId('create-grn');
    setFeedback(null);

    const res = await adminFetch<GoodsReceiptDTO>(
      '/api/v1/admin/procurement/goods-receipts',
      {
        method: 'POST',
        body: JSON.stringify({
          poId: targetPo.id,
          warehouseCode: targetPo.warehouseCode,
          note: grnNote.trim() || undefined,
          items: grnLines.map((l) => ({
            poItemId: l.poItemId,
            skuId: l.skuId,
            receivedQty: l.receivedQty,
            acceptedQty: l.acceptedQty,
            rejectedDefectQty: l.rejectedDefectQty,
            batchCode: l.batchCode.trim() || 'BATCH-01',
          })),
        }),
      },
    );

    if (res.ok) {
      const totalAcc = grnLines.reduce((s, l) => s + l.acceptedQty, 0);
      const totalRej = grnLines.reduce((s, l) => s + l.rejectedDefectQty, 0);
      setFeedback({
        kind: 'success',
        message: `Đã lập biên bản GRN ${res.data?.grnNumber ?? ''}: +${totalAcc} đạt chuẩn nhập kho, +${totalRej} lỗi trả xưởng — công nợ NCC & trạng thái mở bán Storefront đã được đồng bộ.`,
      });
      setSelectedGrnPoId('');
      setGrnLines([]);
      setGrnNote('');
      await loadAll();
    } else {
      setFeedback({
        kind: 'error',
        message:
          res.error?.message ||
          'Lập phiếu nghiệm thu GRN thất bại. Kiểm tra số lượng accepted + rejected = received.',
      });
    }
    setBusyId(null);
  };

  const unpaidTotalVnd = useMemo(
    () =>
      payables
        .filter((p) => p.status === SupplierPayableStatus.UNPAID)
        .reduce((sum, p) => sum + p.amountPayableVnd, 0),
    [payables],
  );

  const aiDraftPos = useMemo(
    () =>
      purchaseOrders.filter((p) => p.status === PurchaseOrderStatus.NHAP_AI),
    [purchaseOrders],
  );

  return (
    <div className="space-y-8">
      {/* Section 1: Purchase Order Ledger */}
      <section className="rounded-3xl border border-[#B08A4A]/30 bg-white p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="ledger-eyebrow text-[#8A672C]">
              B2B Procurement · PO → Partial/Defect GRN → Supplier Payables
            </p>
            <h2 className="font-editorial mt-1 text-3xl text-[#1C1410]">
              Sổ Đơn Đặt Hàng Nhập (Purchase Orders · {purchaseOrders.length})
            </h2>
            <p className="mt-1 text-xs text-[#7A6A5B]">
              Các bản nháp <code>NHAP_AI</code> từ MCP Copilot bị khóa nội bộ và
              chỉ hiển thị cho Đối tác sau khi Quản lý kho nhấn{' '}
              <strong>&ldquo;Duyệt gửi Đối tác&rdquo;</strong>.
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setShowCreatePo((prev) => !prev)}
              className="rounded-full border border-[#1C1410] bg-[#FBF7EF] px-4 py-2 text-xs font-medium text-[#1C1410] hover:bg-[#1C1410] hover:text-[#EBCF8F]"
            >
              {showCreatePo ? 'Đóng form PO' : '+ Tạo PO thủ công'}
            </button>
            <button
              type="button"
              disabled={loading}
              onClick={() => void loadAll()}
              className="rounded-full bg-[#1C1410] px-5 py-2 text-xs uppercase tracking-[0.16em] text-[#EBCF8F] disabled:opacity-50"
            >
              {loading ? 'Đang tải...' : 'Làm mới'}
            </button>
          </div>
        </div>

        {feedback ? (
          <div
            role="status"
            className={`mt-4 rounded-2xl border px-4 py-3 text-xs ${
              feedback.kind === 'success'
                ? 'border-[#2E6B47]/35 bg-[#F2FBF6] text-[#1E4B32]'
                : 'border-[#8B2E2E]/35 bg-[#FFF5F4] text-[#8B2E2E]'
            }`}
          >
            {feedback.message}
          </div>
        ) : null}

        {aiDraftPos.length > 0 ? (
          <div className="mt-4 rounded-2xl border border-[#B08A4A] bg-[#1C1410] p-4 text-xs text-[#FBF7EF]">
            <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-[#EBCF8F]">
              NHAP_AI HUMAN-IN-THE-LOOP · {aiDraftPos.length} BẢN NHÁP TỪ AI
              COPILOT ĐANG CHỜ DUYỆT
            </p>
            <p className="mt-1 text-[#FBF7EF]/80">
              Đối tác chưa thể nhìn thấy các đơn này trên Partner Portal cho tới
              khi bạn duyệt phát hành.
            </p>
          </div>
        ) : null}

        {/* Manual PO Form */}
        {showCreatePo ? (
          <form
            onSubmit={handleCreateManualPo}
            className="mt-5 grid gap-4 rounded-2xl border border-[#B08A4A]/35 bg-[#FBF7EF] p-5 text-xs md:grid-cols-3"
          >
            <label className="block">
              <span className="uppercase tracking-[0.14em] text-[#8A672C]">
                Nhà cung cấp
              </span>
              <select
                value={poSupplierId}
                onChange={(e) => setPoSupplierId(e.target.value)}
                required
                className="mt-1 w-full rounded-xl border border-[#B08A4A]/35 bg-white px-3 py-2 text-xs"
              >
                {suppliers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.code} · {s.name} (Lead {s.leadTimeDays}d)
                  </option>
                ))}
              </select>
            </label>

            <label className="block">
              <span className="uppercase tracking-[0.14em] text-[#8A672C]">
                Kho nhận hàng
              </span>
              <select
                value={poWarehouseCode}
                onChange={(e) => setPoWarehouseCode(e.target.value)}
                className="mt-1 w-full rounded-xl border border-[#B08A4A]/35 bg-white px-3 py-2 text-xs"
              >
                <option value="CENTRAL_WH">CENTRAL_WH (Kho Trung Tâm)</option>
                <option value="HN_ATELIER">HN_ATELIER (Showroom Hà Nội)</option>
                <option value="HCM_SHOWROOM">HCM_SHOWROOM (Showroom HCM)</option>
              </select>
            </label>

            <label className="block">
              <span className="uppercase tracking-[0.14em] text-[#8A672C]">
                Ngày dự kiến giao
              </span>
              <input
                type="date"
                required
                value={poExpectedDate}
                onChange={(e) => setPoExpectedDate(e.target.value)}
                className="mt-1 w-full rounded-xl border border-[#B08A4A]/35 bg-white px-3 py-2 font-mono text-xs"
              />
            </label>

            <label className="block md:col-span-2">
              <span className="uppercase tracking-[0.14em] text-[#8A672C]">
                SKU cần đặt nhập
              </span>
              <select
                value={poSkuId}
                onChange={(e) => setPoSkuId(e.target.value)}
                required
                className="mt-1 w-full rounded-xl border border-[#B08A4A]/35 bg-white px-3 py-2 font-mono text-xs"
              >
                {uniqueSkus.map((sku) => (
                  <option key={sku.skuId} value={sku.skuId}>
                    {sku.skuCode || sku.skuId.slice(0, 14)} · Avl:{' '}
                    {sku.availableQty}
                  </option>
                ))}
              </select>
            </label>

            <div className="grid grid-cols-2 gap-2">
              <label className="block">
                <span className="uppercase tracking-[0.14em] text-[#8A672C]">
                  SL đặt
                </span>
                <input
                  type="number"
                  min={1}
                  max={10000}
                  value={poOrderedQty}
                  onChange={(e) => setPoOrderedQty(Number(e.target.value))}
                  className="mt-1 w-full rounded-xl border border-[#B08A4A]/35 bg-white px-3 py-2 font-mono text-xs"
                />
              </label>
              <label className="block">
                <span className="uppercase tracking-[0.14em] text-[#8A672C]">
                  Đơn giá nhập (₫)
                </span>
                <input
                  type="number"
                  min={0}
                  step={10000}
                  value={poUnitCostVnd}
                  onChange={(e) => setPoUnitCostVnd(Number(e.target.value))}
                  className="mt-1 w-full rounded-xl border border-[#B08A4A]/35 bg-white px-3 py-2 font-mono text-xs"
                />
              </label>
            </div>

            <label className="block md:col-span-3">
              <span className="uppercase tracking-[0.14em] text-[#8A672C]">
                Lý do đặt nhập
              </span>
              <input
                type="text"
                value={poRationale}
                onChange={(e) => setPoRationale(e.target.value)}
                className="mt-1 w-full rounded-xl border border-[#B08A4A]/35 bg-white px-3 py-2 text-xs"
              />
            </label>

            <div className="md:col-span-3 flex justify-end">
              <button
                type="submit"
                disabled={busyId === 'create-po'}
                className="rounded-full bg-[#1C1410] px-6 py-2 text-xs font-medium uppercase tracking-[0.16em] text-[#EBCF8F]"
              >
                {busyId === 'create-po'
                  ? 'Đang tạo PO...'
                  : 'Tạo đơn nhập hàng'}
              </button>
            </div>
          </form>
        ) : null}

        {/* PO List */}
        <div className="mt-5 space-y-3">
          {purchaseOrders.length === 0 ? (
            <p className="rounded-2xl border border-[#B08A4A]/20 bg-[#FBF7EF] p-8 text-center text-xs text-[#7A6A5B]">
              {loading
                ? 'Đang tải danh sách PO...'
                : 'Chưa có đơn đặt hàng nhập nào.'}
            </p>
          ) : (
            purchaseOrders.map((po) => {
              const badge = PO_STATUS_BADGES[po.status];
              const supplier = supplierMap.get(po.supplierId);
              const isAiDraft = po.status === PurchaseOrderStatus.NHAP_AI;

              return (
                <article
                  key={po.id}
                  className={`rounded-2xl border p-4 text-xs ${
                    isAiDraft
                      ? 'border-[#B08A4A] bg-[#FFFDF8] shadow-sm'
                      : 'border-[#B08A4A]/25 bg-[#FBF7EF]/65'
                  }`}
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-sm font-bold text-[#1C1410]">
                          {po.poNumber}
                        </span>
                        <span
                          className={`rounded-full border px-2.5 py-0.5 font-mono text-[10px] font-medium ${badge.cls}`}
                        >
                          {badge.label}
                        </span>
                        {po.createdSource ===
                        PurchaseOrderCreatedSource.AI_COPILOT ? (
                          <span className="rounded-full border border-[#B08A4A]/45 bg-[#F4EBDA] px-2.5 py-0.5 font-mono text-[10px] text-[#8A672C]">
                            AI_COPILOT
                          </span>
                        ) : null}
                      </div>

                      <p className="text-[11px] text-[#5C4B41]">
                        NCC:{' '}
                        <strong>
                          {po.supplierName ||
                            supplier?.name ||
                            po.supplierId.slice(0, 12)}
                        </strong>{' '}
                        · Kho: <code>{po.warehouseCode}</code> · Dự kiến giao:{' '}
                        <span className="font-mono">
                          {po.confirmedDeliveryDate || po.expectedDeliveryDate}
                        </span>
                        {po.totalCostVnd != null
                          ? ` · Tổng giá nhập: ${FORMAT_VND(po.totalCostVnd)}`
                          : ''}
                      </p>

                      {po.rationale ? (
                        <p className="text-[11px] text-[#7A6A5B]">
                          Ghi chú: {po.rationale}
                        </p>
                      ) : null}
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      {isAiDraft ? (
                        <button
                          type="button"
                          disabled={busyId === `submit-${po.id}`}
                          onClick={() => void handleSubmitPoToSupplier(po)}
                          className="rounded-full bg-[#1C1410] px-4 py-2 text-[11px] font-medium uppercase tracking-[0.14em] text-[#EBCF8F] hover:opacity-90 disabled:opacity-50"
                        >
                          {busyId === `submit-${po.id}`
                            ? 'Đang duyệt...'
                            : 'Duyệt gửi Đối tác'}
                        </button>
                      ) : null}

                      {(po.status === PurchaseOrderStatus.NCC_DA_XAC_NHAN ||
                        po.status === PurchaseOrderStatus.HOAN_TAT_MOT_PHAN) ? (
                        <button
                          type="button"
                          onClick={() => handleSelectGrnPo(po.id)}
                          className="rounded-full border border-[#1E4B32] bg-[#F2FBF6] px-4 py-1.5 text-[11px] font-medium text-[#1E4B32] hover:bg-[#1E4B32] hover:text-white"
                        >
                          Lập phiếu nhập GRN
                        </button>
                      ) : null}
                    </div>
                  </div>

                  {po.items.length > 0 ? (
                    <div className="mt-3 grid gap-1.5 border-t border-[#B08A4A]/15 pt-2.5 sm:grid-cols-2">
                      {po.items.map((item) => (
                        <div
                          key={item.id}
                          className="flex items-center justify-between rounded-xl bg-white px-3 py-1.5 font-mono text-[11px]"
                        >
                          <span>
                            {item.skuCode} · Đặt {item.orderedQty} (Đã nhận đạt:{' '}
                            {item.acceptedQty})
                          </span>
                          <span className="text-[#8A672C]">
                            {item.unitCostVnd != null
                              ? `${FORMAT_VND(item.unitCostVnd)}/sp`
                              : '[RBAC]'}
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </article>
              );
            })
          )}
        </div>
      </section>

      {/* Section 2: Partial / Defect Goods Receipt Note (GRN) Form */}
      <section className="rounded-3xl border border-[#B08A4A]/30 bg-white p-6">
        <p className="ledger-eyebrow text-[#8A672C]">
          Partial / Defect Goods Receipt (GRN) · Nghiệm thu nhập kho
        </p>
        <h3 className="font-editorial mt-1 text-3xl text-[#1C1410]">
          Lập Biên bản Nghiệm thu Nhập kho &amp; Tách hàng lỗi
        </h3>
        <p className="mt-1 text-xs text-[#7A6A5B]">
          Số lượng <strong>Đạt chuẩn (acceptedQty)</strong> cộng vào{' '}
          <code>availableQty</code> và tự động mở bán lại trên Storefront /
          Meilisearch; <strong>Lỗi trả xưởng (rejectedDefectQty)</strong> ghi
          vào <code>damagedQty</code> và không tính vào công nợ nhà cung cấp.
        </p>

        <form onSubmit={handleSubmitGrn} className="mt-5 space-y-4 text-xs">
          <div className="grid gap-3 md:grid-cols-2">
            <label className="block">
              <span className="uppercase tracking-[0.14em] text-[#8A672C]">
                Chọn PO đã được NCC xác nhận ({receivablePos.length})
              </span>
              <select
                value={selectedGrnPoId}
                onChange={(e) => handleSelectGrnPo(e.target.value)}
                className="mt-1 w-full rounded-xl border border-[#B08A4A]/35 bg-[#FBF7EF] px-3 py-2 text-xs"
              >
                <option value="">-- Chọn đơn đặt hàng để nghiệm thu --</option>
                {receivablePos.map((po) => (
                  <option key={po.id} value={po.id}>
                    {po.poNumber} · {po.warehouseCode} · {po.status}
                  </option>
                ))}
              </select>
            </label>

            <label className="block">
              <span className="uppercase tracking-[0.14em] text-[#8A672C]">
                Ghi chú kiểm nhập kho
              </span>
              <input
                type="text"
                value={grnNote}
                onChange={(e) => setGrnNote(e.target.value)}
                placeholder="VD: Kiểm lô vải lụa sáng nay, phát hiện 2 chiếc lỗi đường may..."
                className="mt-1 w-full rounded-xl border border-[#B08A4A]/35 bg-[#FBF7EF] px-3 py-2 text-xs"
              />
            </label>
          </div>

          {grnLines.length > 0 ? (
            <div className="space-y-2.5">
              {grnLines.map((line, idx) => (
                <div
                  key={line.poItemId}
                  className="grid gap-3 rounded-2xl border border-[#B08A4A]/25 bg-[#FBF7EF] p-4 md:grid-cols-5"
                >
                  <div>
                    <p className="font-mono font-semibold text-[#1C1410]">
                      {line.skuCode}
                    </p>
                    <p className="text-[11px] text-[#7A6A5B]">
                      Đặt {line.orderedQty} · Đã nhập {line.alreadyAccepted}
                    </p>
                  </div>

                  <label className="block">
                    <span className="text-[10px] uppercase tracking-[0.12em] text-[#5C4B41]">
                      Thực nhận (receivedQty)
                    </span>
                    <input
                      type="number"
                      min={1}
                      value={line.receivedQty}
                      onChange={(e) =>
                        updateGrnLine(idx, {
                          receivedQty: Number(e.target.value),
                        })
                      }
                      className="mt-1 w-full rounded-xl border border-[#B08A4A]/35 bg-white px-2.5 py-1.5 font-mono text-xs"
                    />
                  </label>

                  <label className="block">
                    <span className="text-[10px] uppercase tracking-[0.12em] text-[#1E4B32]">
                      Đạt chuẩn (acceptedQty)
                    </span>
                    <input
                      type="number"
                      min={0}
                      max={line.receivedQty}
                      value={line.acceptedQty}
                      onChange={(e) =>
                        updateGrnLine(idx, {
                          acceptedQty: Number(e.target.value),
                        })
                      }
                      className="mt-1 w-full rounded-xl border border-[#2E6B47]/40 bg-[#F2FBF6] px-2.5 py-1.5 font-mono text-xs font-semibold text-[#1E4B32]"
                    />
                  </label>

                  <label className="block">
                    <span className="text-[10px] uppercase tracking-[0.12em] text-[#8B2E2E]">
                      Lỗi trả xưởng (rejected)
                    </span>
                    <input
                      type="number"
                      min={0}
                      max={line.receivedQty}
                      value={line.rejectedDefectQty}
                      onChange={(e) =>
                        updateGrnLine(idx, {
                          rejectedDefectQty: Number(e.target.value),
                        })
                      }
                      className="mt-1 w-full rounded-xl border border-[#8B2E2E]/35 bg-[#FFF5F4] px-2.5 py-1.5 font-mono text-xs font-semibold text-[#8B2E2E]"
                    />
                  </label>

                  <label className="block">
                    <span className="text-[10px] uppercase tracking-[0.12em] text-[#8A672C]">
                      Mã lô (batchCode)
                    </span>
                    <input
                      type="text"
                      required
                      value={line.batchCode}
                      onChange={(e) =>
                        updateGrnLine(idx, { batchCode: e.target.value })
                      }
                      className="mt-1 w-full rounded-xl border border-[#B08A4A]/35 bg-white px-2.5 py-1.5 font-mono text-xs"
                    />
                  </label>
                </div>
              ))}

              <div className="flex justify-end">
                <button
                  type="submit"
                  disabled={busyId === 'create-grn'}
                  className="rounded-full bg-[#1C1410] px-6 py-2.5 text-xs font-medium uppercase tracking-[0.16em] text-[#EBCF8F] disabled:opacity-50"
                >
                  {busyId === 'create-grn'
                    ? 'Đang ghi sổ kho & công nợ...'
                    : 'Xác nhận nhập kho GRN'}
                </button>
              </div>
            </div>
          ) : null}
        </form>

        {/* Recent GRNs */}
        {goodsReceipts.length > 0 ? (
          <div className="mt-6 border-t border-[#B08A4A]/20 pt-5">
            <p className="ledger-eyebrow text-[#8A672C]">
              Biên bản GRN gần đây ({goodsReceipts.length})
            </p>
            <div className="mt-3 grid gap-2.5 sm:grid-cols-2">
              {goodsReceipts.slice(0, 8).map((grn) => (
                <div
                  key={grn.id}
                  className="rounded-2xl border border-[#B08A4A]/20 bg-[#FBF7EF]/70 p-3.5 text-xs"
                >
                  <div className="flex items-center justify-between font-mono">
                    <strong className="text-[#1C1410]">{grn.grnNumber}</strong>
                    <span className="text-[10px] text-[#7A6A5B]">
                      {formatDateTime(grn.createdAt)}
                    </span>
                  </div>
                  <p className="mt-1 font-mono text-[11px]">
                    <span className="text-[#1E4B32]">
                      Đạt chuẩn: +{grn.totalAcceptedQty}
                    </span>{' '}
                    ·{' '}
                    <span className="text-[#8B2E2E]">
                      Lỗi: {grn.totalRejectedQty}
                    </span>
                    {grn.payableAmountVnd != null
                      ? ` · Công nợ: ${FORMAT_VND(grn.payableAmountVnd)}`
                      : ''}
                  </p>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </section>

      {/* Section 3: Supplier Payables Table */}
      <section className="rounded-3xl border border-[#B08A4A]/30 bg-white p-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="ledger-eyebrow text-[#8A672C]">
              Supplier Payables Ledger · Công nợ theo số lượng Đạt chuẩn
            </p>
            <h3 className="font-editorial mt-1 text-3xl text-[#1C1410]">
              Đối soát Công nợ Nhà cung cấp ({payables.length})
            </h3>
          </div>
          <div className="rounded-2xl border border-[#B08A4A]/30 bg-[#FBF7EF] px-4 py-2.5 text-right">
            <p className="text-[10px] uppercase tracking-[0.14em] text-[#7A6A5B]">
              Tổng công nợ UNPAID
            </p>
            <p className="font-editorial text-2xl text-[#1C1410]">
              {FORMAT_VND(unpaidTotalVnd)}
            </p>
          </div>
        </div>

        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-[#B08A4A]/25 bg-[#F4EBDA]/65 text-[10px] uppercase tracking-[0.14em] text-[#8A672C]">
              <tr>
                <th className="px-4 py-3">Nhà cung cấp</th>
                <th className="px-4 py-3">GRN / PO</th>
                <th className="px-4 py-3 text-right">
                  Công nợ (acceptedQty × unitCost)
                </th>
                <th className="px-4 py-3">Hạn thanh toán</th>
                <th className="px-4 py-3">Trạng thái</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#B08A4A]/15">
              {payables.length === 0 ? (
                <tr>
                  <td
                    colSpan={5}
                    className="px-4 py-8 text-center text-xs text-[#7A6A5B]"
                  >
                    Chưa có phiếu công nợ nào phát sinh.
                  </td>
                </tr>
              ) : (
                payables.map((pay) => {
                  const sup = supplierMap.get(pay.supplierId);
                  return (
                    <tr key={pay.id}>
                      <td className="px-4 py-3 font-medium text-[#1C1410]">
                        {sup ? `${sup.code} · ${sup.name}` : pay.supplierId}
                      </td>
                      <td className="px-4 py-3 font-mono text-[11px] text-[#5C4B41]">
                        GRN {pay.grnId.slice(0, 10)}…
                      </td>
                      <td className="px-4 py-3 text-right font-mono font-semibold text-[#1C1410]">
                        {FORMAT_VND(pay.amountPayableVnd)}
                      </td>
                      <td className="px-4 py-3 font-mono text-[11px] text-[#7A6A5B]">
                        {pay.dueDate}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`rounded-full border px-2.5 py-0.5 font-mono text-[10px] font-semibold ${
                            pay.status === SupplierPayableStatus.PAID
                              ? 'border-[#2E6B47]/40 bg-[#F2FBF6] text-[#1E4B32]'
                              : 'border-[#D9822B]/45 bg-[#FFF6E5] text-[#9A5B13]'
                          }`}
                        >
                          {pay.status}
                        </span>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
