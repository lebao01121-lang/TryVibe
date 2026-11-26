'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from 'react';
import {
  PurchaseOrderCreatedSource,
  PurchaseOrderStatus,
  SupplierPayableStatus,
  SupplierStatus,
  type GoodsReceiptDTO,
  type PurchaseOrderDTO,
  type Role,
  type StockLevelAdminDto,
  type SupplierDTO,
  type SupplierPayableDTO,
  type WarehouseDto,
} from '@atelier/contracts';
import {
  AnimatedTelemetryNumber,
  LiveStreamProgressBar,
} from '@atelier/motion-kit';
import { adminFetch, extractList } from '@/lib/api-client';
import { emitPortalToast } from '../PortalToastBanner';

export interface ProcurementTabProps {
  roles?: readonly Role[];
  darkMode?: boolean;
  onRefreshOverview?: () => void;
}

interface ExtendedSupplier extends SupplierDTO {
  isActive?: boolean;
}

interface ExtendedPurchaseOrder extends Omit<PurchaseOrderDTO, 'status'> {
  status: string;
  cancelReason?: string | null;
  cancelledAt?: string | null;
  supplierRejectionReason?: string | null;
  rejectionReason?: string | null;
  proposedDeliveryDate?: string | null;
  rejectedAt?: string | null;
}

interface ExtendedPayable extends SupplierPayableDTO {
  poNumber?: string | null;
  grnNumber?: string | null;
  bankReference?: string | null;
  paymentReference?: string | null;
  paidAt?: string | null;
  settlementNote?: string | null;
  note?: string | null;
}

interface PoDraftLine {
  rowId: string;
  skuId: string;
  skuCode: string;
  orderedQty: number;
  unitCostVnd: number;
}

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

const FORMAT_VND = (amount: number): string =>
  `${new Intl.NumberFormat('vi-VN').format(Math.round(amount))}₫`;

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

const PO_STATUS_BADGES: Record<string, { label: string; cls: string }> = {
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
  CANCELLED: {
    label: 'Đã hủy',
    cls: 'border-[#7A6A5B]/35 bg-[#F4EBDA]/60 text-[#5C4B41]',
  },
  SUPPLIER_REJECTED: {
    label: 'NCC từ chối · Cần xử lý',
    cls: 'border-[#8B2E2E]/45 bg-[#FFF5F4] text-[#8B2E2E] font-semibold',
  },
  REJECTED_BY_SUPPLIER: {
    label: 'NCC từ chối · Cần xử lý',
    cls: 'border-[#8B2E2E]/45 bg-[#FFF5F4] text-[#8B2E2E] font-semibold',
  },
  NCC_TU_CHOI: {
    label: 'NCC từ chối · Cần xử lý',
    cls: 'border-[#8B2E2E]/45 bg-[#FFF5F4] text-[#8B2E2E] font-semibold',
  },
};

function makePoLine(
  skuId = '',
  skuCode = '',
  orderedQty = 20,
  unitCostVnd = 650_000,
): PoDraftLine {
  return {
    rowId: `po-line-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    skuId,
    skuCode,
    orderedQty,
    unitCostVnd,
  };
}

export function ProcurementTab({ onRefreshOverview }: ProcurementTabProps) {
  const [suppliers, setSuppliers] = useState<ExtendedSupplier[]>([]);
  const [purchaseOrders, setPurchaseOrders] = useState<ExtendedPurchaseOrder[]>(
    [],
  );
  const [goodsReceipts, setGoodsReceipts] = useState<GoodsReceiptDTO[]>([]);
  const [payables, setPayables] = useState<ExtendedPayable[]>([]);
  const [stockLevels, setStockLevels] = useState<StockLevelAdminDto[]>([]);
  const [warehouses, setWarehouses] = useState<WarehouseDto[]>([]);

  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{
    kind: 'success' | 'error';
    message: string;
  } | null>(null);

  // Multi-SKU PO Creation Builder state
  const [showCreatePo, setShowCreatePo] = useState(false);
  const [poSupplierId, setPoSupplierId] = useState('');
  const [poWarehouseCode, setPoWarehouseCode] = useState('CENTRAL_WH');
  const [poExpectedDate, setPoExpectedDate] = useState(() => {
    const d = new Date(Date.now() + 7 * 86_400_000);
    return d.toISOString().slice(0, 10);
  });
  const [poItems, setPoItems] = useState<PoDraftLine[]>([makePoLine()]);
  const [poRationale, setPoRationale] = useState(
    'Bổ sung định kỳ các size chủ lực cho showroom & kho trung tâm.',
  );

  // Supplier CRUD Modal state
  const [showSupplierModal, setShowSupplierModal] = useState(false);
  const [editingSupplierId, setEditingSupplierId] = useState<string | null>(
    null,
  );
  const [supCode, setSupCode] = useState('');
  const [supName, setSupName] = useState('');
  const [supContactName, setSupContactName] = useState('');
  const [supContactEmail, setSupContactEmail] = useState('');
  const [supContactPhone, setSupContactPhone] = useState('');
  const [supAddress, setSupAddress] = useState('');
  const [supLeadTimeDays, setSupLeadTimeDays] = useState(7);
  const [supPaymentTermsDays, setSupPaymentTermsDays] = useState(30);
  const [supIsActive, setSupIsActive] = useState(true);

  // Cancel PO Modal state
  const [cancellingPo, setCancellingPo] =
    useState<ExtendedPurchaseOrder | null>(null);
  const [cancelPoReason, setCancelPoReason] = useState('');

  // Mark Paid Modal state
  const [markingPayable, setMarkingPayable] = useState<ExtendedPayable | null>(
    null,
  );
  const [bankReference, setBankReference] = useState('');
  const [paidAtDate, setPaidAtDate] = useState(() =>
    new Date().toISOString().slice(0, 10),
  );
  const [settlementNote, setSettlementNote] = useState('');

  // Partial / Defect GRN Form state
  const [selectedGrnPoId, setSelectedGrnPoId] = useState('');
  const [grnNote, setGrnNote] = useState('');
  const [grnLines, setGrnLines] = useState<GrnDraftLine[]>([]);

  const loadAll = useCallback(async () => {
    setLoading(true);
    const [supRes, poRes, grnRes, payRes, stockRes, whRes] = await Promise.all([
      adminFetch<unknown>('/api/v1/admin/procurement/suppliers'),
      adminFetch<unknown>('/api/v1/admin/procurement/purchase-orders'),
      adminFetch<unknown>('/api/v1/admin/procurement/goods-receipts'),
      adminFetch<unknown>('/api/v1/admin/procurement/payables'),
      adminFetch<unknown>('/api/v1/admin/inventory/stock-levels'),
      adminFetch<unknown>('/api/v1/admin/inventory/warehouses'),
    ]);

    const supList = supRes.ok
      ? extractList<ExtendedSupplier>(supRes.data, ['items', 'suppliers', 'list'])
      : [];
    const poList = poRes.ok
      ? extractList<ExtendedPurchaseOrder>(poRes.data, [
          'items',
          'purchaseOrders',
          'list',
        ])
      : [];
    const grnList = grnRes.ok
      ? extractList<GoodsReceiptDTO>(grnRes.data, [
          'items',
          'goodsReceipts',
          'list',
        ])
      : [];
    const payList = payRes.ok
      ? extractList<ExtendedPayable>(payRes.data, ['items', 'payables', 'list'])
      : [];
    const stockList = stockRes.ok
      ? extractList<StockLevelAdminDto>(stockRes.data, [
          'items',
          'stockLevels',
          'list',
        ])
      : [];
    const whList = whRes.ok
      ? extractList<WarehouseDto>(whRes.data, ['items', 'warehouses', 'list'])
      : [];

    setSuppliers(supList);
    setPurchaseOrders(poList);
    setGoodsReceipts(grnList);
    setPayables(payList);
    setStockLevels(stockList);
    setWarehouses(whList);

    if (supList.length > 0) {
      setPoSupplierId((prev) => prev || supList[0]!.id);
    }
    if (stockList.length > 0) {
      const first = stockList[0]!;
      setPoItems((prev) =>
        prev.map((line, idx) =>
          idx === 0 && !line.skuId
            ? {
                ...line,
                skuId: first.skuId,
                skuCode: first.skuCode || first.skuId,
              }
            : line,
        ),
      );
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
  }, []);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const supplierMap = useMemo(() => {
    const map = new Map<string, ExtendedSupplier>();
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

  // Live Multi-SKU PO Totals
  const poBuilderTotals = useMemo(() => {
    let totalQty = 0;
    let grandTotalVnd = 0;
    for (const line of poItems) {
      const qty = Math.max(0, Number(line.orderedQty) || 0);
      const cost = Math.max(0, Number(line.unitCostVnd) || 0);
      totalQty += qty;
      grandTotalVnd += qty * cost;
    }
    return { totalQty, grandTotalVnd };
  }, [poItems]);

  const handleAddPoLine = () => {
    const usedIds = new Set(poItems.map((i) => i.skuId));
    const nextSku =
      uniqueSkus.find((s) => !usedIds.has(s.skuId)) ?? uniqueSkus[0];
    setPoItems((prev) => [
      ...prev,
      makePoLine(
        nextSku?.skuId ?? '',
        nextSku?.skuCode ?? nextSku?.skuId ?? '',
        10,
        650_000,
      ),
    ]);
  };

  const handleRemovePoLine = (rowId: string) => {
    setPoItems((prev) =>
      prev.length <= 1 ? prev : prev.filter((item) => item.rowId !== rowId),
    );
  };

  const handleUpdatePoLine = (
    rowId: string,
    patch: Partial<Omit<PoDraftLine, 'rowId'>>,
  ) => {
    setPoItems((prev) =>
      prev.map((line) => (line.rowId === rowId ? { ...line, ...patch } : line)),
    );
  };

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

  const handleSubmitPoToSupplier = async (po: ExtendedPurchaseOrder) => {
    setBusyId(`submit-${po.id}`);
    setFeedback(null);

    const res = await adminFetch<unknown>(
      `/api/v1/admin/procurement/purchase-orders/${encodeURIComponent(po.id)}/submit`,
      { method: 'POST', body: JSON.stringify({}) },
    );

    if (res.ok) {
      const msg = `Đã duyệt & phát hành ${po.poNumber} sang Partner Portal (CHO_NCC_XAC_NHAN).`;
      setFeedback({ kind: 'success', message: msg });
      emitPortalToast({ kind: 'success', title: 'PHÁT HÀNH PO', message: msg });
      await loadAll();
      onRefreshOverview?.();
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
    const validLines = poItems.filter(
      (l) => (l.skuId.trim() || l.skuCode.trim()) && Number(l.orderedQty) > 0,
    );
    if (!poSupplierId || validLines.length === 0) {
      setFeedback({
        kind: 'error',
        message: 'Vui lòng chọn Nhà cung cấp và ít nhất 1 dòng SKU hợp lệ.',
      });
      return;
    }

    setBusyId('create-po');
    setFeedback(null);

    const payloadItems = validLines.map((line) => {
      const matched = uniqueSkus.find((s) => s.skuId === line.skuId);
      const skuCode = line.skuCode || matched?.skuCode || line.skuId;
      return {
        skuId: line.skuId || skuCode,
        skuCode,
        sku: skuCode,
        orderedQty: Number(line.orderedQty),
        quantity: Number(line.orderedQty),
        unitCostVnd: Number(line.unitCostVnd),
      };
    });

    const res = await adminFetch<ExtendedPurchaseOrder>(
      '/api/v1/admin/procurement/purchase-orders',
      {
        method: 'POST',
        body: JSON.stringify({
          supplierId: poSupplierId,
          warehouseCode: poWarehouseCode,
          expectedDeliveryDate: poExpectedDate,
          rationale: poRationale.trim() || undefined,
          createdSource: PurchaseOrderCreatedSource.USER,
          items: payloadItems,
        }),
      },
    );

    if (res.ok) {
      const msg = `Đã tạo đơn nhập hàng đa SKU ${res.data?.poNumber ?? ''} (${payloadItems.length} dòng · ${FORMAT_VND(poBuilderTotals.grandTotalVnd)}).`;
      setFeedback({ kind: 'success', message: msg });
      emitPortalToast({ kind: 'success', title: 'TẠO PO MỚI', message: msg });
      setShowCreatePo(false);
      const first = uniqueSkus[0];
      setPoItems([
        makePoLine(first?.skuId ?? '', first?.skuCode ?? first?.skuId ?? ''),
      ]);
      await loadAll();
      onRefreshOverview?.();
    } else {
      setFeedback({
        kind: 'error',
        message: res.error?.message || 'Tạo đơn nhập hàng thủ công thất bại.',
      });
    }
    setBusyId(null);
  };

  const handleConfirmCancelPo = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!cancellingPo) return;
    if (cancelPoReason.trim().length < 3) {
      setFeedback({
        kind: 'error',
        message: 'Vui lòng nhập lý do hủy PO (tối thiểu 3 ký tự).',
      });
      return;
    }

    setBusyId(`cancel-${cancellingPo.id}`);
    setFeedback(null);

    const res = await adminFetch<unknown>(
      `/api/v1/admin/procurement/purchase-orders/${encodeURIComponent(cancellingPo.id)}/cancel`,
      {
        method: 'POST',
        body: JSON.stringify({ reason: cancelPoReason.trim() }),
      },
    );

    if (res.ok) {
      const msg = `Đã hủy đơn đặt hàng ${cancellingPo.poNumber}.`;
      setFeedback({ kind: 'success', message: msg });
      emitPortalToast({ kind: 'info', title: 'HỦY PO', message: msg });
      setCancellingPo(null);
      setCancelPoReason('');
      await loadAll();
      onRefreshOverview?.();
    } else {
      setFeedback({
        kind: 'error',
        message:
          res.error?.message || `Không thể hủy PO ${cancellingPo.poNumber}.`,
      });
    }
    setBusyId(null);
  };

  // Supplier CRUD handlers
  const resetSupplierForm = () => {
    setEditingSupplierId(null);
    setSupCode('');
    setSupName('');
    setSupContactName('');
    setSupContactEmail('');
    setSupContactPhone('');
    setSupAddress('');
    setSupLeadTimeDays(7);
    setSupPaymentTermsDays(30);
    setSupIsActive(true);
  };

  const startEditSupplier = (sup: ExtendedSupplier) => {
    setEditingSupplierId(sup.id);
    setSupCode(sup.code);
    setSupName(sup.name);
    setSupContactName(sup.contactName ?? '');
    setSupContactEmail(sup.contactEmail ?? '');
    setSupContactPhone(sup.contactPhone ?? '');
    setSupAddress(sup.address ?? '');
    setSupLeadTimeDays(sup.leadTimeDays ?? 7);
    setSupPaymentTermsDays(sup.paymentTermsDays ?? 30);
    setSupIsActive(
      sup.isActive !== undefined
        ? sup.isActive
        : sup.status === SupplierStatus.ACTIVE,
    );
  };

  const handleSaveSupplier = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!supCode.trim() || !supName.trim() || !supContactEmail.trim()) {
      setFeedback({
        kind: 'error',
        message: 'Mã NCC, Tên NCC và Email liên hệ là bắt buộc.',
      });
      return;
    }

    setBusyId('save-supplier');
    setFeedback(null);
    const isEdit = Boolean(editingSupplierId);
    const url = isEdit
      ? `/api/v1/admin/procurement/suppliers/${encodeURIComponent(editingSupplierId!)}`
      : '/api/v1/admin/procurement/suppliers';

    const res = await adminFetch<ExtendedSupplier>(url, {
      method: isEdit ? 'PATCH' : 'POST',
      body: JSON.stringify({
        code: supCode.trim().toUpperCase(),
        name: supName.trim(),
        contactName: supContactName.trim() || undefined,
        contactEmail: supContactEmail.trim(),
        contactPhone: supContactPhone.trim() || undefined,
        address: supAddress.trim() || undefined,
        leadTimeDays: Math.max(1, Number(supLeadTimeDays) || 7),
        paymentTermsDays: Math.max(0, Number(supPaymentTermsDays) || 30),
        isActive: supIsActive,
        status: supIsActive ? SupplierStatus.ACTIVE : SupplierStatus.SUSPENDED,
      }),
    });

    if (res.ok) {
      const msg = isEdit
        ? `Đã cập nhật nhà cung cấp ${supCode.trim().toUpperCase()}.`
        : `Đã thêm mới nhà cung cấp ${supCode.trim().toUpperCase()} (${supName.trim()}).`;
      emitPortalToast({
        kind: 'success',
        title: 'NHÀ CUNG CẤP B2B',
        message: msg,
      });
      resetSupplierForm();
      await loadAll();
    } else {
      setFeedback({
        kind: 'error',
        message: res.error?.message || 'Không thể lưu thông tin nhà cung cấp.',
      });
    }
    setBusyId(null);
  };

  // Mark Paid handler
  const handleConfirmMarkPaid = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!markingPayable) return;
    if (!bankReference.trim()) {
      setFeedback({
        kind: 'error',
        message: 'Vui lòng nhập mã giao dịch chuyển khoản ngân hàng (bankReference).',
      });
      return;
    }

    setBusyId(`mark-paid-${markingPayable.id}`);
    setFeedback(null);

    const paidAtIso = paidAtDate
      ? new Date(`${paidAtDate}T12:00:00.000Z`).toISOString()
      : new Date().toISOString();

    const res = await adminFetch<unknown>(
      `/api/v1/admin/procurement/payables/${encodeURIComponent(markingPayable.id)}/mark-paid`,
      {
        method: 'POST',
        body: JSON.stringify({
          bankReference: bankReference.trim(),
          paidAt: paidAtIso,
          note: settlementNote.trim() || undefined,
        }),
      },
    );

    if (res.ok) {
      const msg = `Đã tất toán công nợ ${FORMAT_VND(markingPayable.amountPayableVnd)} (Ref: ${bankReference.trim()}).`;
      setFeedback({ kind: 'success', message: msg });
      emitPortalToast({
        kind: 'success',
        title: 'TẤT TOÁN CÔNG NỢ',
        message: msg,
      });
      setMarkingPayable(null);
      setBankReference('');
      setSettlementNote('');
      await loadAll();
      onRefreshOverview?.();
    } else {
      setFeedback({
        kind: 'error',
        message: res.error?.message || 'Tất toán công nợ thất bại.',
      });
    }
    setBusyId(null);
  };

  const updateGrnLine = (
    idx: number,
    patch: Partial<
      Pick<
        GrnDraftLine,
        'receivedQty' | 'acceptedQty' | 'rejectedDefectQty' | 'batchCode'
      >
    >,
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
      const msg = `Đã lập biên bản GRN ${res.data?.grnNumber ?? ''}: +${totalAcc} đạt chuẩn nhập kho, +${totalRej} lỗi trả xưởng — công nợ NCC & Storefront đã đồng bộ.`;
      setFeedback({ kind: 'success', message: msg });
      emitPortalToast({ kind: 'success', title: 'NGHIỆM THU GRN', message: msg });
      setSelectedGrnPoId('');
      setGrnLines([]);
      setGrnNote('');
      await loadAll();
      onRefreshOverview?.();
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
    <div data-testid="procurement-tab" className="space-y-8">
      {/* Section 1: Purchase Order Ledger */}
      <section className="rounded-3xl border border-[#B08A4A]/30 bg-white p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="ledger-eyebrow text-[#8A672C]">
              B2B Procurement · Multi-SKU PO → Partial/Defect GRN → Supplier
              Payables
            </p>
            <h2 className="font-editorial mt-1 text-3xl text-[#1C1410]">
              Sổ Đơn Đặt Hàng Nhập (Purchase Orders ·{' '}
              <AnimatedTelemetryNumber value={purchaseOrders.length} />)
            </h2>
            <p className="mt-1 text-xs text-[#7A6A5B]">
              Hỗ trợ lập PO đa dòng SKU, duyệt bản nháp <code>NHAP_AI</code> từ
              MCP Copilot, quản lý nhà cung cấp, hủy PO và tất toán công nợ đối
              tác (Chờ tất toán:{' '}
              <strong className="font-mono text-[#8A672C]">
                <AnimatedTelemetryNumber value={unpaidTotalVnd} format="vnd" />
              </strong>
              ).
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              data-testid="btn-toggle-multi-sku-po"
              onClick={() => setShowCreatePo((prev) => !prev)}
              className="rounded-full bg-[#1C1410] px-4 py-2 text-xs font-medium text-[#EBCF8F] hover:opacity-90"
            >
              {showCreatePo ? 'Đóng form PO' : '+ Tạo PO đa SKU'}
            </button>
            <button
              type="button"
              data-testid="btn-open-supplier-crud"
              onClick={() => {
                resetSupplierForm();
                setShowSupplierModal(true);
              }}
              className="rounded-full border border-[#1C1410] bg-[#FBF7EF] px-4 py-2 text-xs font-medium text-[#1C1410] hover:bg-[#1C1410] hover:text-[#EBCF8F]"
            >
              Nhà cung cấp ({suppliers.length})
            </button>
            <button
              type="button"
              disabled={loading}
              onClick={() => void loadAll()}
              className="rounded-full border border-[#B08A4A]/45 px-4 py-2 text-xs text-[#8A672C] hover:bg-[#F4EBDA] disabled:opacity-50"
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

        {/* Multi-SKU Dynamic PO Creation Builder */}
        {showCreatePo ? (
          <form
            onSubmit={handleCreateManualPo}
            data-testid="multi-sku-po-form"
            className="mt-5 space-y-4 rounded-2xl border border-[#B08A4A]/35 bg-[#FBF7EF] p-5 text-xs"
          >
            <div className="grid gap-4 md:grid-cols-3">
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
                  {warehouses.length > 0 ? (
                    warehouses.map((wh) => (
                      <option key={wh.code} value={wh.code}>
                        {wh.code} ({wh.name})
                      </option>
                    ))
                  ) : (
                    <>
                      <option value="CENTRAL_WH">
                        CENTRAL_WH (Kho Trung Tâm)
                      </option>
                      <option value="HN_ATELIER">
                        HN_ATELIER (Showroom Hà Nội)
                      </option>
                      <option value="HCM_SHOWROOM">
                        HCM_SHOWROOM (Showroom HCM)
                      </option>
                    </>
                  )}
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
            </div>

            {/* Dynamic Multi-SKU Rows */}
            <div className="space-y-2.5">
              <div className="flex items-center justify-between">
                <span className="font-semibold uppercase tracking-[0.14em] text-[#8A672C]">
                  Danh sách dòng SKU đặt nhập ({poItems.length} dòng)
                </span>
                <button
                  type="button"
                  data-testid="btn-add-po-line"
                  onClick={handleAddPoLine}
                  className="rounded-full border border-[#1C1410] bg-white px-3 py-1 text-[11px] font-medium text-[#1C1410] hover:bg-[#1C1410] hover:text-[#EBCF8F]"
                >
                  + Thêm dòng SKU
                </button>
              </div>

              {poItems.map((line, index) => {
                const lineSubtotal =
                  (Number(line.orderedQty) || 0) *
                  (Number(line.unitCostVnd) || 0);
                return (
                  <div
                    key={line.rowId}
                    className="grid items-end gap-2.5 rounded-2xl border border-[#B08A4A]/25 bg-white p-3 md:grid-cols-[2.2fr_0.8fr_1fr_1fr_auto]"
                  >
                    <label className="block">
                      <span className="text-[10px] uppercase tracking-[0.12em] text-[#8A672C]">
                        Dòng #{index + 1} · SKU
                      </span>
                      <select
                        value={line.skuId}
                        onChange={(e) => {
                          const found = uniqueSkus.find(
                            (s) => s.skuId === e.target.value,
                          );
                          handleUpdatePoLine(line.rowId, {
                            skuId: e.target.value,
                            skuCode: found?.skuCode || e.target.value,
                          });
                        }}
                        required
                        className="mt-1 w-full rounded-xl border border-[#B08A4A]/35 bg-[#FBF7EF] px-3 py-2 font-mono text-xs"
                      >
                        {uniqueSkus.map((sku) => (
                          <option key={sku.skuId} value={sku.skuId}>
                            {sku.skuCode || sku.skuId.slice(0, 14)} · Avl:{' '}
                            {sku.availableQty}
                          </option>
                        ))}
                      </select>
                    </label>

                    <label className="block">
                      <span className="text-[10px] uppercase tracking-[0.12em] text-[#8A672C]">
                        SL đặt
                      </span>
                      <input
                        type="number"
                        min={1}
                        max={100_000}
                        required
                        value={line.orderedQty}
                        onChange={(e) =>
                          handleUpdatePoLine(line.rowId, {
                            orderedQty: Number(e.target.value),
                          })
                        }
                        className="mt-1 w-full rounded-xl border border-[#B08A4A]/35 bg-[#FBF7EF] px-2.5 py-2 font-mono text-xs"
                      />
                    </label>

                    <label className="block">
                      <span className="text-[10px] uppercase tracking-[0.12em] text-[#8A672C]">
                        Đơn giá nhập (₫)
                      </span>
                      <input
                        type="number"
                        min={0}
                        step={10000}
                        required
                        value={line.unitCostVnd}
                        onChange={(e) =>
                          handleUpdatePoLine(line.rowId, {
                            unitCostVnd: Number(e.target.value),
                          })
                        }
                        className="mt-1 w-full rounded-xl border border-[#B08A4A]/35 bg-[#FBF7EF] px-2.5 py-2 font-mono text-xs"
                      />
                    </label>

                    <div className="rounded-xl bg-[#F4EBDA]/65 px-3 py-2 text-right font-mono">
                      <p className="text-[9.5px] uppercase text-[#7A6A5B]">
                        Thành tiền
                      </p>
                      <p className="font-semibold text-[#1C1410]">
                        {FORMAT_VND(lineSubtotal)}
                      </p>
                    </div>

                    <button
                      type="button"
                      disabled={poItems.length <= 1}
                      onClick={() => handleRemovePoLine(line.rowId)}
                      title="Xóa dòng SKU"
                      className="rounded-xl border border-[#8B2E2E]/35 px-3 py-2 text-xs text-[#8B2E2E] hover:bg-[#8B2E2E] hover:text-white disabled:opacity-35"
                    >
                      ×
                    </button>
                  </div>
                );
              })}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[#B08A4A]/30 bg-white px-4 py-3">
              <div className="font-mono text-xs text-[#5C4B41]">
                Tổng số lượng:{' '}
                <strong className="text-[#1C1410]">
                  {poBuilderTotals.totalQty}
                </strong>{' '}
                sản phẩm ({poItems.length} mã SKU)
              </div>
              <div className="font-mono text-sm font-bold text-[#1C1410]">
                TỔNG GIÁ TRỊ PO: {FORMAT_VND(poBuilderTotals.grandTotalVnd)}
              </div>
            </div>

            <label className="block">
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

            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowCreatePo(false)}
                className="rounded-full border border-[#B08A4A]/40 px-4 py-2 text-xs text-[#5C4B41]"
              >
                Hủy
              </button>
              <button
                type="submit"
                disabled={busyId === 'create-po'}
                className="rounded-full bg-[#1C1410] px-6 py-2 text-xs font-medium uppercase tracking-[0.16em] text-[#EBCF8F] disabled:opacity-50"
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
              const badge = PO_STATUS_BADGES[po.status] ?? {
                label: po.status,
                cls: 'border-[#B08A4A]/35 bg-[#FBF7EF] text-[#1C1410]',
              };
              const supplier = supplierMap.get(po.supplierId);
              const isAiDraft = po.status === PurchaseOrderStatus.NHAP_AI;
              const isTerminal =
                po.status === PurchaseOrderStatus.HOAN_TAT ||
                po.status === PurchaseOrderStatus.HOAN_TAT_MOT_PHAN ||
                po.status === PurchaseOrderStatus.DA_HUY ||
                po.status === 'CANCELLED';
              const rejectionReason =
                po.supplierRejectionReason || po.rejectionReason;
              const isRejectedBySupplier =
                po.status === 'SUPPLIER_REJECTED' ||
                po.status === 'REJECTED_BY_SUPPLIER' ||
                po.status === 'NCC_TU_CHOI' ||
                Boolean(rejectionReason);

              return (
                <article
                  key={po.id}
                  className={`rounded-2xl border p-4 text-xs ${
                    isAiDraft
                      ? 'border-[#B08A4A] bg-[#FFFDF8] shadow-sm'
                      : isRejectedBySupplier
                        ? 'border-[#8B2E2E]/45 bg-[#FFF9F8]'
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

                      {/* Partner Rejection Reason & Proposed Delivery Date */}
                      {isRejectedBySupplier ? (
                        <div className="mt-2 rounded-xl border border-[#8B2E2E]/35 bg-[#FFF5F4] px-3 py-2 text-[11px] text-[#8B2E2E]">
                          <p className="font-semibold">
                            ⚠ Đối tác đã từ chối PO
                            {po.rejectedAt
                              ? ` (${formatDateTime(po.rejectedAt)})`
                              : ''}
                          </p>
                          {rejectionReason || po.supplierNote ? (
                            <p className="mt-0.5">
                              Lý do NCC: &ldquo;
                              {rejectionReason || po.supplierNote}&rdquo;
                            </p>
                          ) : null}
                          {po.proposedDeliveryDate ? (
                            <p className="mt-0.5 font-mono font-semibold text-[#1C1410]">
                              Ngày giao đối tác đề xuất:{' '}
                              {po.proposedDeliveryDate}
                            </p>
                          ) : null}
                        </div>
                      ) : null}

                      {/* Cancel Reason Display */}
                      {po.cancelReason ? (
                        <p className="mt-1 rounded-lg bg-[#F4EBDA]/80 px-2.5 py-1 text-[11px] text-[#5C4B41]">
                          Lý do hủy PO: {po.cancelReason}
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

                      {po.status === PurchaseOrderStatus.NCC_DA_XAC_NHAN ||
                      po.status === PurchaseOrderStatus.HOAN_TAT_MOT_PHAN ? (
                        <button
                          type="button"
                          onClick={() => handleSelectGrnPo(po.id)}
                          className="rounded-full border border-[#1E4B32] bg-[#F2FBF6] px-4 py-1.5 text-[11px] font-medium text-[#1E4B32] hover:bg-[#1E4B32] hover:text-white"
                        >
                          Lập phiếu nhập GRN
                        </button>
                      ) : null}

                      {!isTerminal ? (
                        <button
                          type="button"
                          onClick={() => {
                            setCancellingPo(po);
                            setCancelPoReason('');
                          }}
                          className="rounded-full border border-[#8B2E2E]/45 bg-white px-3.5 py-1.5 text-[11px] font-medium text-[#8B2E2E] hover:bg-[#8B2E2E] hover:text-white"
                        >
                          Hủy PO
                        </button>
                      ) : null}
                    </div>
                  </div>

                  {po.items.length > 0 ? (() => {
                    const totalOrdered = po.items.reduce(
                      (s, it) => s + Math.max(0, it.orderedQty),
                      0,
                    );
                    const totalAccepted = po.items.reduce(
                      (s, it) => s + Math.max(0, it.acceptedQty),
                      0,
                    );
                    const grnPct =
                      totalOrdered > 0
                        ? Math.min(
                            100,
                            Math.round((totalAccepted / totalOrdered) * 100),
                          )
                        : 0;
                    return (
                      <div className="mt-3 space-y-2.5 border-t border-[#B08A4A]/15 pt-2.5">
                        <LiveStreamProgressBar
                          percent={grnPct}
                          tone={
                            grnPct >= 100
                              ? 'emerald'
                              : grnPct > 0
                                ? 'gold'
                                : 'amber'
                          }
                          height="xs"
                          label={`Tiến độ nhập kho PO → GRN (${totalAccepted}/${totalOrdered} sp)`}
                          rightText={`${grnPct}%`}
                        />
                        <div className="grid gap-1.5 sm:grid-cols-2">
                          {po.items.map((item) => (
                            <div
                              key={item.id}
                              className="flex items-center justify-between rounded-xl bg-white px-3 py-1.5 font-mono text-[11px]"
                            >
                              <span>
                                {item.skuCode} · Đặt {item.orderedQty} (Đã nhận
                                đạt: {item.acceptedQty})
                              </span>
                              <span className="text-[#8A672C]">
                                {item.unitCostVnd != null
                                  ? `${FORMAT_VND(item.unitCostVnd)}/sp`
                                  : '[RBAC]'}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  })() : null}
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

      {/* Section 3: Supplier Payables Table with Mark Paid Settlement */}
      <section className="rounded-3xl border border-[#B08A4A]/30 bg-white p-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="ledger-eyebrow text-[#8A672C]">
              Supplier Payables Ledger · Công nợ theo số lượng Đạt chuẩn
            </p>
            <h3 className="font-editorial mt-1 text-3xl text-[#1C1410]">
              Đối soát &amp; Tất toán Công nợ Nhà cung cấp ({payables.length})
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
                <th className="px-4 py-3">Trạng thái / UNC</th>
                <th className="px-4 py-3 text-right">Tất toán</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#B08A4A]/15">
              {payables.length === 0 ? (
                <tr>
                  <td
                    colSpan={6}
                    className="px-4 py-8 text-center text-xs text-[#7A6A5B]"
                  >
                    Chưa có phiếu công nợ nào phát sinh.
                  </td>
                </tr>
              ) : (
                payables.map((pay) => {
                  const sup = supplierMap.get(pay.supplierId);
                  const isPaid = pay.status === SupplierPayableStatus.PAID;
                  const bankRef = pay.bankReference || pay.paymentReference;
                  const note = pay.settlementNote || pay.note;
                  return (
                    <tr key={pay.id} className="hover:bg-[#FBF7EF]/60">
                      <td className="px-4 py-3 font-medium text-[#1C1410]">
                        {sup ? `${sup.code} · ${sup.name}` : pay.supplierId}
                      </td>
                      <td className="px-4 py-3 font-mono text-[11px] text-[#5C4B41]">
                        {pay.grnNumber || `GRN ${pay.grnId.slice(0, 10)}…`}
                        {pay.poNumber ? (
                          <span className="block text-[10px] text-[#7A6A5B]">
                            PO: {pay.poNumber}
                          </span>
                        ) : null}
                      </td>
                      <td className="px-4 py-3 text-right font-mono font-semibold text-[#1C1410]">
                        {FORMAT_VND(pay.amountPayableVnd)}
                      </td>
                      <td className="px-4 py-3 font-mono text-[11px] text-[#7A6A5B]">
                        {pay.dueDate}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-block rounded-full border px-2.5 py-0.5 font-mono text-[10px] font-semibold ${
                            isPaid
                              ? 'border-[#2E6B47]/40 bg-[#F2FBF6] text-[#1E4B32]'
                              : 'border-[#D9822B]/45 bg-[#FFF6E5] text-[#9A5B13]'
                          }`}
                        >
                          {pay.status}
                        </span>
                        {bankRef ? (
                          <p className="mt-1 font-mono text-[10px] text-[#5C4B41]">
                            UNC: <strong>{bankRef}</strong>
                            {pay.paidAt
                              ? ` · ${formatDateTime(pay.paidAt)}`
                              : ''}
                          </p>
                        ) : null}
                        {note ? (
                          <p className="text-[10px] text-[#7A6A5B]">{note}</p>
                        ) : null}
                      </td>
                      <td className="px-4 py-3 text-right">
                        {!isPaid ? (
                          <button
                            type="button"
                            data-testid={`btn-mark-paid-${pay.id}`}
                            onClick={() => {
                              setMarkingPayable(pay);
                              setBankReference('');
                              setPaidAtDate(
                                new Date().toISOString().slice(0, 10),
                              );
                              setSettlementNote('');
                            }}
                            className="rounded-full bg-[#1E4B32] px-3.5 py-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-white hover:opacity-90"
                          >
                            Mark Paid
                          </button>
                        ) : (
                          <span className="font-mono text-[10px] text-[#2E6B47]">
                            ✓ Đã tất toán
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* MODAL: Supplier CRUD */}
      {showSupplierModal ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Quản lý Nhà cung cấp B2B"
          className="fixed inset-0 z-50 flex items-center justify-center bg-[#1C1410]/70 p-4 backdrop-blur-sm"
        >
          <div className="max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-3xl border border-[#B08A4A]/40 bg-[#FBF7EF] p-6 shadow-2xl">
            <div className="flex items-start justify-between border-b border-[#B08A4A]/20 pb-3">
              <div>
                <p className="ledger-eyebrow text-[#8A672C]">
                  B2B Supplier Directory CRUD
                </p>
                <h3 className="font-editorial mt-0.5 text-3xl text-[#1C1410]">
                  Quản lý Nhà cung cấp &amp; Xưởng may đối tác
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setShowSupplierModal(false)}
                className="rounded-full border border-[#B08A4A]/40 px-3 py-1 text-xs text-[#5C4B41]"
              >
                Đóng
              </button>
            </div>

            {/* Supplier List */}
            <div className="mt-4 space-y-2">
              {suppliers.map((sup) => {
                const active =
                  sup.isActive !== undefined
                    ? sup.isActive
                    : sup.status === SupplierStatus.ACTIVE;
                return (
                  <div
                    key={sup.id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-[#B08A4A]/25 bg-white px-4 py-3 text-xs"
                  >
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono font-bold text-[#1C1410]">
                          {sup.code}
                        </span>
                        <span className="font-medium text-[#1C1410]">
                          {sup.name}
                        </span>
                        <span
                          className={`rounded-full px-2 py-0.5 font-mono text-[10px] ${
                            active
                              ? 'bg-[#F2FBF6] text-[#1E4B32]'
                              : 'bg-[#FFF5F4] text-[#8B2E2E]'
                          }`}
                        >
                          {active ? 'ACTIVE' : 'SUSPENDED'}
                        </span>
                      </div>
                      <p className="mt-0.5 text-[11px] text-[#7A6A5B]">
                        {sup.contactEmail}
                        {sup.contactPhone ? ` · ${sup.contactPhone}` : ''} ·
                        Lead {sup.leadTimeDays} ngày · Công nợ{' '}
                        {sup.paymentTermsDays ?? 30} ngày · Lỗi{' '}
                        {sup.defectRatePct}%
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => startEditSupplier(sup)}
                      className="rounded-full border border-[#B08A4A]/45 px-3 py-1 text-[11px] text-[#8A672C] hover:bg-[#F4EBDA]"
                    >
                      Chỉnh sửa
                    </button>
                  </div>
                );
              })}
            </div>

            {/* Create / Edit Supplier Form */}
            <form
              onSubmit={handleSaveSupplier}
              className="mt-5 rounded-2xl border border-[#B08A4A]/30 bg-white p-4 text-xs"
            >
              <div className="mb-3 flex items-center justify-between">
                <p className="font-semibold text-[#1C1410]">
                  {editingSupplierId
                    ? `Chỉnh sửa nhà cung cấp: ${supCode}`
                    : '+ Thêm nhà cung cấp mới'}
                </p>
                {editingSupplierId ? (
                  <button
                    type="button"
                    onClick={resetSupplierForm}
                    className="text-[11px] text-[#8A672C] underline"
                  >
                    Tạo nhà cung cấp mới
                  </button>
                ) : null}
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block">
                  <span className="uppercase tracking-[0.12em] text-[#8A672C]">
                    Mã NCC (Code)
                  </span>
                  <input
                    type="text"
                    required
                    value={supCode}
                    onChange={(e) => setSupCode(e.target.value)}
                    placeholder="VD: SUP-SILK-03"
                    className="mt-1 w-full rounded-xl border border-[#B08A4A]/35 bg-[#FBF7EF] px-3 py-2 font-mono text-xs"
                  />
                </label>

                <label className="block">
                  <span className="uppercase tracking-[0.12em] text-[#8A672C]">
                    Tên xưởng / Nhà cung cấp
                  </span>
                  <input
                    type="text"
                    required
                    value={supName}
                    onChange={(e) => setSupName(e.target.value)}
                    placeholder="VD: Xưởng Lụa Bảo Lộc"
                    className="mt-1 w-full rounded-xl border border-[#B08A4A]/35 bg-[#FBF7EF] px-3 py-2 text-xs"
                  />
                </label>

                <label className="block">
                  <span className="uppercase tracking-[0.12em] text-[#8A672C]">
                    Email liên hệ
                  </span>
                  <input
                    type="email"
                    required
                    value={supContactEmail}
                    onChange={(e) => setSupContactEmail(e.target.value)}
                    placeholder="contact@supplier.vn"
                    className="mt-1 w-full rounded-xl border border-[#B08A4A]/35 bg-[#FBF7EF] px-3 py-2 text-xs"
                  />
                </label>

                <label className="block">
                  <span className="uppercase tracking-[0.12em] text-[#8A672C]">
                    Người liên hệ
                  </span>
                  <input
                    type="text"
                    value={supContactName}
                    onChange={(e) => setSupContactName(e.target.value)}
                    placeholder="Nguyễn Văn A"
                    className="mt-1 w-full rounded-xl border border-[#B08A4A]/35 bg-[#FBF7EF] px-3 py-2 text-xs"
                  />
                </label>

                <label className="block">
                  <span className="uppercase tracking-[0.12em] text-[#8A672C]">
                    Số điện thoại
                  </span>
                  <input
                    type="text"
                    value={supContactPhone}
                    onChange={(e) => setSupContactPhone(e.target.value)}
                    placeholder="0901234567"
                    className="mt-1 w-full rounded-xl border border-[#B08A4A]/35 bg-[#FBF7EF] px-3 py-2 font-mono text-xs"
                  />
                </label>

                <label className="block">
                  <span className="uppercase tracking-[0.12em] text-[#8A672C]">
                    Địa chỉ xưởng
                  </span>
                  <input
                    type="text"
                    value={supAddress}
                    onChange={(e) => setSupAddress(e.target.value)}
                    className="mt-1 w-full rounded-xl border border-[#B08A4A]/35 bg-[#FBF7EF] px-3 py-2 text-xs"
                  />
                </label>

                <label className="block">
                  <span className="uppercase tracking-[0.12em] text-[#8A672C]">
                    Lead time (ngày)
                  </span>
                  <input
                    type="number"
                    min={1}
                    max={120}
                    value={supLeadTimeDays}
                    onChange={(e) => setSupLeadTimeDays(Number(e.target.value))}
                    className="mt-1 w-full rounded-xl border border-[#B08A4A]/35 bg-[#FBF7EF] px-3 py-2 font-mono text-xs"
                  />
                </label>

                <label className="block">
                  <span className="uppercase tracking-[0.12em] text-[#8A672C]">
                    Hạn thanh toán (ngày)
                  </span>
                  <input
                    type="number"
                    min={0}
                    max={180}
                    value={supPaymentTermsDays}
                    onChange={(e) =>
                      setSupPaymentTermsDays(Number(e.target.value))
                    }
                    className="mt-1 w-full rounded-xl border border-[#B08A4A]/35 bg-[#FBF7EF] px-3 py-2 font-mono text-xs"
                  />
                </label>

                <label className="flex items-center gap-2 sm:col-span-2">
                  <input
                    type="checkbox"
                    checked={supIsActive}
                    onChange={(e) => setSupIsActive(e.target.checked)}
                    className="h-4 w-4 accent-[#1C1410]"
                  />
                  <span className="font-medium text-[#1C1410]">
                    Đang hợp tác (ACTIVE)
                  </span>
                </label>
              </div>

              <div className="mt-4 flex justify-end">
                <button
                  type="submit"
                  disabled={busyId === 'save-supplier'}
                  className="rounded-full bg-[#1C1410] px-5 py-2 text-xs font-medium uppercase tracking-[0.14em] text-[#EBCF8F] disabled:opacity-50"
                >
                  {busyId === 'save-supplier'
                    ? 'Đang lưu...'
                    : editingSupplierId
                      ? 'Cập nhật NCC'
                      : 'Tạo nhà cung cấp'}
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {/* MODAL: Hủy PO */}
      {cancellingPo ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Hủy đơn đặt hàng nhập PO"
          className="fixed inset-0 z-50 flex items-center justify-center bg-[#1C1410]/70 p-4 backdrop-blur-sm"
        >
          <form
            onSubmit={handleConfirmCancelPo}
            className="w-full max-w-md rounded-3xl border border-[#8B2E2E]/40 bg-[#FBF7EF] p-6 shadow-2xl"
          >
            <p className="ledger-eyebrow text-[#8B2E2E]">
              Cancel Purchase Order · {cancellingPo.poNumber}
            </p>
            <h3 className="font-editorial mt-1 text-3xl text-[#1C1410]">
              Xác nhận hủy đơn đặt nhập
            </h3>
            <p className="mt-2 text-xs text-[#5C4B41]">
              Đơn PO sẽ chuyển sang trạng thái đã hủy và ghi nhật ký kiểm toán
              kèm lý do hủy.
            </p>

            <label className="mt-4 block text-xs">
              <span className="uppercase tracking-[0.14em] text-[#8A672C]">
                Lý do hủy PO (Bắt buộc)
              </span>
              <textarea
                rows={3}
                required
                minLength={3}
                value={cancelPoReason}
                onChange={(e) => setCancelPoReason(e.target.value)}
                placeholder="VD: Thay đổi kế hoạch nhập hàng mùa mới / NCC không đáp ứng tiến độ..."
                className="mt-1 w-full rounded-2xl border border-[#B08A4A]/35 bg-white p-3 text-xs"
              />
            </label>

            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setCancellingPo(null)}
                className="rounded-full border border-[#B08A4A]/40 px-4 py-2 text-xs text-[#5C4B41]"
              >
                Đóng
              </button>
              <button
                type="submit"
                disabled={busyId === `cancel-${cancellingPo.id}`}
                className="rounded-full bg-[#8B2E2E] px-5 py-2 text-xs font-medium uppercase tracking-[0.14em] text-white disabled:opacity-50"
              >
                {busyId === `cancel-${cancellingPo.id}`
                  ? 'Đang hủy PO...'
                  : 'Xác nhận hủy PO'}
              </button>
            </div>
          </form>
        </div>
      ) : null}

      {/* MODAL: Mark Paid (Tất toán Công nợ) */}
      {markingPayable ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Tất toán công nợ nhà cung cấp"
          className="fixed inset-0 z-50 flex items-center justify-center bg-[#1C1410]/70 p-4 backdrop-blur-sm"
        >
          <form
            onSubmit={handleConfirmMarkPaid}
            className="w-full max-w-md rounded-3xl border border-[#2E6B47]/40 bg-[#FBF7EF] p-6 shadow-2xl"
          >
            <p className="ledger-eyebrow text-[#1E4B32]">
              Payable Settlement · Mark Paid
            </p>
            <h3 className="font-editorial mt-1 text-3xl text-[#1C1410]">
              Tất toán Công nợ NCC
            </h3>
            <p className="mt-1 font-mono text-xs text-[#5C4B41]">
              Số tiền thanh toán:{' '}
              <strong className="text-base text-[#1C1410]">
                {FORMAT_VND(markingPayable.amountPayableVnd)}
              </strong>
            </p>

            <div className="mt-4 space-y-3 text-xs">
              <label className="block">
                <span className="uppercase tracking-[0.14em] text-[#8A672C]">
                  Mã tham chiếu chuyển khoản (bankReference) *
                </span>
                <input
                  type="text"
                  required
                  value={bankReference}
                  onChange={(e) => setBankReference(e.target.value)}
                  placeholder="VD: VCB-FT261125-99421"
                  className="mt-1 w-full rounded-xl border border-[#B08A4A]/35 bg-white px-3 py-2 font-mono text-xs"
                />
              </label>

              <label className="block">
                <span className="uppercase tracking-[0.14em] text-[#8A672C]">
                  Ngày thanh toán (paidAt)
                </span>
                <input
                  type="date"
                  required
                  value={paidAtDate}
                  onChange={(e) => setPaidAtDate(e.target.value)}
                  className="mt-1 w-full rounded-xl border border-[#B08A4A]/35 bg-white px-3 py-2 font-mono text-xs"
                />
              </label>

              <label className="block">
                <span className="uppercase tracking-[0.14em] text-[#8A672C]">
                  Ghi chú kế toán
                </span>
                <textarea
                  rows={2}
                  value={settlementNote}
                  onChange={(e) => setSettlementNote(e.target.value)}
                  placeholder="VD: Đã chuyển khoản tất toán đợt 1 qua tài khoản doanh nghiệp..."
                  className="mt-1 w-full rounded-2xl border border-[#B08A4A]/35 bg-white p-2.5 text-xs"
                />
              </label>
            </div>

            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setMarkingPayable(null)}
                className="rounded-full border border-[#B08A4A]/40 px-4 py-2 text-xs text-[#5C4B41]"
              >
                Hủy
              </button>
              <button
                type="submit"
                disabled={busyId === `mark-paid-${markingPayable.id}`}
                className="rounded-full bg-[#1E4B32] px-6 py-2 text-xs font-medium uppercase tracking-[0.14em] text-white disabled:opacity-50"
              >
                {busyId === `mark-paid-${markingPayable.id}`
                  ? 'Đang tất toán...'
                  : 'Xác nhận Mark Paid'}
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </div>
  );
}
