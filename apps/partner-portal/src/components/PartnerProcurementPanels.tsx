'use client';

import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  PurchaseOrderStatus,
  SupplierPayableStatus,
  type GoodsReceiptDTO,
  type PurchaseOrderDTO,
  type SupplierPayableDTO,
} from '@atelier/contracts';
import { partnerFetch } from '@/lib/api-client';
import { emitPortalToast } from './PortalToastBanner';

function extractList<T>(data: unknown): T[] {
  if (Array.isArray(data)) return data as T[];
  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    for (const key of [
      'items',
      'list',
      'rows',
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

function escapeCsvCell(value: string | number | null | undefined): string {
  const raw = value === null || value === undefined ? '' : String(value);
  if (/[",\r\n]/.test(raw)) {
    return `"${raw.replace(/"/g, '""')}"`;
  }
  return raw;
}

const PO_STATUS_LABELS: Record<
  PurchaseOrderStatus,
  { label: string; cls: string }
> = {
  [PurchaseOrderStatus.NHAP_AI]: {
    label: 'NHAP_AI',
    cls: 'border-[#7A6A5B]/30 bg-[#F4EBDA] text-[#5C4B41]',
  },
  [PurchaseOrderStatus.CHO_NCC_XAC_NHAN]: {
    label: 'Chờ NCC xác nhận',
    cls: 'border-[#D9822B]/45 bg-[#FFF6E5] text-[#9A5B13]',
  },
  [PurchaseOrderStatus.NCC_DA_XAC_NHAN]: {
    label: 'Đã xác nhận hẹn giao',
    cls: 'border-[#2E5A8B]/40 bg-[#F2F7FC] text-[#1E4066]',
  },
  [PurchaseOrderStatus.HOAN_TAT_MOT_PHAN]: {
    label: 'Đã giao một phần',
    cls: 'border-[#B08A4A]/55 bg-[#FFF8EB] text-[#8A5A12]',
  },
  [PurchaseOrderStatus.HOAN_TAT]: {
    label: 'Hoàn tất nghiệm thu',
    cls: 'border-[#2E6B47]/40 bg-[#F2FBF6] text-[#1E4B32]',
  },
  [PurchaseOrderStatus.DA_HUY]: {
    label: 'Đã hủy',
    cls: 'border-[#7A6A5B]/35 bg-[#F4EBDA]/60 text-[#5C4B41]',
  },
  [PurchaseOrderStatus.CANCELLED]: {
    label: 'Đã hủy',
    cls: 'border-[#7A6A5B]/35 bg-[#F4EBDA]/60 text-[#5C4B41]',
  },
  [PurchaseOrderStatus.SUPPLIER_REJECTED]: {
    label: 'NCC từ chối / Đề xuất lịch mới',
    cls: 'border-[#8B2E2E]/45 bg-[#FFF5F4] text-[#8B2E2E]',
  },
};

export interface PartnerPurchaseOrdersTabProps {
  supplierId: string;
}

export function PartnerPurchaseOrdersTab({
  supplierId,
}: PartnerPurchaseOrdersTabProps) {
  const [orders, setOrders] = useState<PurchaseOrderDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [confirmedDate, setConfirmedDate] = useState('');
  const [supplierNote, setSupplierNote] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Reject PO / Propose Delivery Date Modal state
  const [rejectingPo, setRejectingPo] = useState<PurchaseOrderDTO | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [rejectProposedDate, setRejectProposedDate] = useState('');
  const [rejectSubmitting, setRejectSubmitting] = useState(false);
  const [rejectModalError, setRejectModalError] = useState<string | null>(null);

  const [feedback, setFeedback] = useState<{
    kind: 'success' | 'error';
    message: string;
  } | null>(null);

  const loadOrders = useCallback(async () => {
    setLoading(true);
    const res = await partnerFetch<unknown>('/api/v1/partner/purchase-orders');
    if (res.ok) {
      // Defensive client filter in addition to server-side NHAP_AI exclusion
      const list = extractList<PurchaseOrderDTO>(res.data).filter(
        (po) => po.status !== PurchaseOrderStatus.NHAP_AI,
      );
      setOrders(list);
    } else {
      setFeedback({
        kind: 'error',
        message:
          res.error?.message ||
          'Chưa thể tải danh sách Đơn đặt hàng nhập (PO).',
      });
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void loadOrders();
  }, [loadOrders]);

  const openConfirmForm = (po: PurchaseOrderDTO) => {
    setConfirmingId(po.id);
    setConfirmedDate(po.expectedDeliveryDate?.slice(0, 10) || '');
    setSupplierNote('Xác nhận đủ năng lực cung ứng đúng tiến độ cam kết.');
    setFeedback(null);
  };

  const handleConfirmPo = async (po: PurchaseOrderDTO) => {
    if (!confirmedDate.trim()) {
      setFeedback({
        kind: 'error',
        message: 'Vui lòng chọn ngày hẹn giao hàng dự kiến.',
      });
      return;
    }

    setSubmitting(true);
    setFeedback(null);

    const res = await partnerFetch<PurchaseOrderDTO>(
      `/api/v1/partner/purchase-orders/${encodeURIComponent(po.id)}/confirm`,
      {
        method: 'POST',
        body: JSON.stringify({
          confirmedDeliveryDate: confirmedDate.trim(),
          supplierNote: supplierNote.trim() || undefined,
        }),
      },
    );

    if (res.ok) {
      const msg = `Đã xác nhận đáp ứng đơn ${po.poNumber} (Hẹn giao: ${confirmedDate}) — kho Tầm Xuân đã nhận lịch GRN.`;
      setFeedback({ kind: 'success', message: msg });
      emitPortalToast({ kind: 'success', title: 'XÁC NHẬN PO THÀNH CÔNG', message: msg });
      setConfirmingId(null);
      await loadOrders();
    } else {
      const errMsg = res.error?.message || `Không thể xác nhận đơn ${po.poNumber}.`;
      setFeedback({ kind: 'error', message: errMsg });
      emitPortalToast({ kind: 'error', title: 'LỖI XÁC NHẬN PO', message: errMsg });
    }
    setSubmitting(false);
  };

  const openRejectModal = (po: PurchaseOrderDTO) => {
    setConfirmingId(null);
    setRejectingPo(po);
    setRejectReason('');
    setRejectProposedDate('');
    setRejectModalError(null);
    setFeedback(null);
  };

  const closeRejectModal = () => {
    if (rejectSubmitting) return;
    setRejectingPo(null);
    setRejectReason('');
    setRejectProposedDate('');
    setRejectModalError(null);
  };

  const handleRejectPo = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!rejectingPo) return;

    const trimmedReason = rejectReason.trim();
    if (trimmedReason.length < 2) {
      setRejectModalError('Vui lòng nhập lý do từ chối PO (tối thiểu 2 ký tự).');
      return;
    }

    setRejectSubmitting(true);
    setRejectModalError(null);

    const payload: {
      reason: string;
      proposedDeliveryDate?: string;
    } = {
      reason: trimmedReason,
      ...(rejectProposedDate.trim()
        ? { proposedDeliveryDate: rejectProposedDate.trim() }
        : {}),
    };

    const res = await partnerFetch<unknown>(
      `/api/v1/partner/purchase-orders/${encodeURIComponent(rejectingPo.id)}/reject`,
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
    );

    if (res.ok) {
      const proposedHint = rejectProposedDate.trim()
        ? ` · Đề xuất ngày giao mới: ${rejectProposedDate.trim()}`
        : '';
      const msg = `Đã gửi từ chối đơn ${rejectingPo.poNumber}${proposedHint}. Kho Tầm Xuân đã nhận phản hồi.`;
      setFeedback({ kind: 'success', message: msg });
      emitPortalToast({
        kind: 'success',
        title: 'ĐÃ TỪ CHỐI PO',
        message: msg,
      });
      setRejectingPo(null);
      setRejectReason('');
      setRejectProposedDate('');
      await loadOrders();
    } else {
      const errMsg =
        res.error?.message || `Không thể từ chối đơn ${rejectingPo.poNumber}.`;
      setRejectModalError(errMsg);
      emitPortalToast({
        kind: 'error',
        title: 'KHÔNG THỂ TỪ CHỐI PO',
        message: errMsg,
      });
    }
    setRejectSubmitting(false);
  };

  return (
    <section className="rounded-3xl border border-[#B08A4A]/30 bg-white p-6">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-[#B08A4A]/20 pb-4">
        <div>
          <p className="partner-eyebrow text-[#8A672C]">
            Purchase Orders · Phạm vi tenant {supplierId}
          </p>
          <h2 className="font-editorial mt-1 text-3xl text-[#1C1410]">
            Đơn đặt hàng nhập (PO · {orders.length})
          </h2>
          <p className="mt-1 text-xs text-[#7A6A5B]">
            Chỉ hiển thị các đơn đã được duyệt phát hành thuộc riêng mã nhà cung
            cấp của bạn (cô lập tuyệt đối theo JWT <code>supplier_id</code>).
          </p>
        </div>

        <button
          type="button"
          disabled={loading}
          onClick={() => void loadOrders()}
          className="rounded-full bg-[#1C1410] px-5 py-2 text-xs uppercase tracking-[0.16em] text-[#EBCF8F] disabled:opacity-50"
        >
          {loading ? 'Đang tải...' : 'Làm mới PO'}
        </button>
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

      <div className="mt-5 space-y-4">
        {orders.length === 0 ? (
          <p className="rounded-2xl border border-[#B08A4A]/20 bg-[#FBF7EF] p-8 text-center text-xs text-[#7A6A5B]">
            {loading
              ? 'Đang tải đơn đặt hàng nhập...'
              : 'Hiện chưa có đơn đặt hàng nhập nào được phát hành cho nhà cung cấp của bạn.'}
          </p>
        ) : (
          orders.map((po) => {
            const badge = PO_STATUS_LABELS[po.status] ?? {
              label: po.status,
              cls: 'border-[#7A6A5B]/35 bg-[#F4EBDA]/60 text-[#5C4B41]',
            };
            const canConfirm =
              po.status === PurchaseOrderStatus.CHO_NCC_XAC_NHAN;
            const canReject =
              po.status === PurchaseOrderStatus.CHO_NCC_XAC_NHAN ||
              po.status === PurchaseOrderStatus.NCC_DA_XAC_NHAN;
            const isConfirming = confirmingId === po.id;
            const isSupplierRejected =
              po.status === PurchaseOrderStatus.SUPPLIER_REJECTED;

            return (
              <article
                key={po.id}
                className={`rounded-2xl border p-4 text-xs ${
                  isSupplierRejected
                    ? 'border-[#8B2E2E]/35 bg-[#FFF5F4]/40'
                    : 'border-[#B08A4A]/25 bg-[#FBF7EF]/70'
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
                      <span className="rounded-full bg-white px-2.5 py-0.5 font-mono text-[10px] text-[#5C4B41]">
                        Kho nhận: {po.warehouseCode}
                      </span>
                      {po.proposedDeliveryDate ? (
                        <span className="rounded-full border border-[#D9822B]/45 bg-[#FFF6E5] px-2.5 py-0.5 font-mono text-[10px] font-semibold text-[#9A5B13]">
                          Đề xuất giao: {po.proposedDeliveryDate}
                        </span>
                      ) : null}
                    </div>

                    <p className="font-mono text-[11px] text-[#5C4B41]">
                      Yêu cầu giao: {po.expectedDeliveryDate}
                      {po.confirmedDeliveryDate
                        ? ` · Đã hẹn giao: ${po.confirmedDeliveryDate}`
                        : ''}
                      {po.totalCostVnd != null
                        ? ` · Giá trị PO: ${FORMAT_VND(po.totalCostVnd)}`
                        : ''}
                    </p>

                    {po.supplierRejectionReason ? (
                      <div className="mt-1.5 rounded-xl border border-[#8B2E2E]/30 bg-[#FFF5F4] px-3 py-2 text-[11px] text-[#8B2E2E]">
                        <p className="font-semibold">
                          Lý do từ chối PO: {po.supplierRejectionReason}
                        </p>
                        {po.proposedDeliveryDate || po.rejectedAt ? (
                          <p className="mt-0.5 font-mono text-[10px] text-[#8B2E2E]/85">
                            {po.proposedDeliveryDate
                              ? `Ngày giao đề xuất: ${po.proposedDeliveryDate}`
                              : ''}
                            {po.proposedDeliveryDate && po.rejectedAt
                              ? ' · '
                              : ''}
                            {po.rejectedAt
                              ? `Gửi lúc: ${formatDateTime(po.rejectedAt)}`
                              : ''}
                          </p>
                        ) : null}
                      </div>
                    ) : po.supplierNote ? (
                      <p className="text-[11px] text-[#1E4B32]">
                        Ghi chú phản hồi: {po.supplierNote}
                      </p>
                    ) : null}

                    {po.cancelReason ? (
                      <p className="text-[11px] text-[#5C4B41]">
                        Lý do hủy đơn từ Tầm Xuân: {po.cancelReason}
                      </p>
                    ) : null}
                  </div>

                  {canConfirm || canReject ? (
                    <div className="flex flex-wrap items-center gap-2">
                      {canConfirm ? (
                        <button
                          type="button"
                          onClick={() =>
                            isConfirming
                              ? setConfirmingId(null)
                              : openConfirmForm(po)
                          }
                          className="rounded-full bg-[#1C1410] px-4 py-2 text-[11px] font-medium uppercase tracking-[0.14em] text-[#EBCF8F]"
                        >
                          Xác nhận đáp ứng &amp; Hẹn giao
                        </button>
                      ) : null}

                      {canReject ? (
                        <button
                          type="button"
                          onClick={() => openRejectModal(po)}
                          className="rounded-full border border-[#8B2E2E]/50 bg-[#FFF5F4] px-4 py-2 text-[11px] font-medium uppercase tracking-[0.12em] text-[#8B2E2E] hover:bg-[#8B2E2E] hover:text-white transition-colors"
                        >
                          Từ chối PO / Đề xuất ngày giao
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                </div>

                {/* Confirm Delivery Inline Form */}
                {isConfirming ? (
                  <div className="mt-4 grid gap-3 rounded-2xl border border-[#B08A4A]/40 bg-white p-4 md:grid-cols-3">
                    <label className="block">
                      <span className="text-[10px] uppercase tracking-[0.14em] text-[#8A672C]">
                        Ngày hẹn giao hàng (confirmedDeliveryDate)
                      </span>
                      <input
                        type="date"
                        required
                        value={confirmedDate}
                        onChange={(e) => setConfirmedDate(e.target.value)}
                        className="mt-1 w-full rounded-xl border border-[#B08A4A]/35 bg-[#FBF7EF] px-3 py-1.5 font-mono text-xs"
                      />
                    </label>
                    <label className="block md:col-span-2">
                      <span className="text-[10px] uppercase tracking-[0.14em] text-[#8A672C]">
                        Ghi chú cho kho Tầm Xuân (supplierNote)
                      </span>
                      <input
                        type="text"
                        value={supplierNote}
                        onChange={(e) => setSupplierNote(e.target.value)}
                        className="mt-1 w-full rounded-xl border border-[#B08A4A]/35 bg-[#FBF7EF] px-3 py-1.5 text-xs"
                      />
                    </label>
                    <div className="md:col-span-3 flex justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => setConfirmingId(null)}
                        className="rounded-full border border-[#B08A4A]/40 px-4 py-1.5 text-[11px] text-[#5C4B41]"
                      >
                        Hủy
                      </button>
                      <button
                        type="button"
                        disabled={submitting}
                        onClick={() => void handleConfirmPo(po)}
                        className="rounded-full bg-[#1C1410] px-5 py-1.5 text-[11px] font-medium uppercase tracking-[0.14em] text-[#EBCF8F] disabled:opacity-50"
                      >
                        {submitting ? 'Đang gửi...' : 'Gửi xác nhận PO'}
                      </button>
                    </div>
                  </div>
                ) : null}

                {/* Line Items */}
                {po.items.length > 0 ? (
                  <div className="mt-3 grid gap-1.5 border-t border-[#B08A4A]/15 pt-2.5 sm:grid-cols-2">
                    {po.items.map((item) => (
                      <div
                        key={item.id}
                        className="flex items-center justify-between rounded-xl bg-white px-3 py-1.5 font-mono text-[11px]"
                      >
                        <span>
                          {item.skuCode} · Đặt <strong>{item.orderedQty}</strong>{' '}
                          (Đã nghiệm thu: {item.acceptedQty})
                        </span>
                        <span className="text-[#8A672C]">
                          {item.unitCostVnd != null
                            ? `${FORMAT_VND(item.unitCostVnd)}/sp`
                            : '—'}
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

      {/* Reject PO / Propose New Delivery Date Modal */}
      {rejectingPo ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="reject-po-modal-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-[#1C1410]/60 p-4 backdrop-blur-[2px]"
        >
          <div className="w-full max-w-lg rounded-3xl border border-[#B08A4A]/45 bg-white p-6 shadow-2xl">
            <div className="flex items-start justify-between gap-3 border-b border-[#B08A4A]/20 pb-3">
              <div>
                <p className="partner-eyebrow text-[#8B2E2E]">
                  Phản hồi đơn đặt hàng · Từ chối / Đề xuất lịch giao
                </p>
                <h3
                  id="reject-po-modal-title"
                  className="font-editorial mt-1 text-2xl text-[#1C1410]"
                >
                  Từ chối PO {rejectingPo.poNumber}
                </h3>
                <p className="mt-0.5 font-mono text-[11px] text-[#7A6A5B]">
                  Kho nhận: {rejectingPo.warehouseCode} · Ngày yêu cầu hiện tại:{' '}
                  {rejectingPo.expectedDeliveryDate}
                </p>
              </div>
              <button
                type="button"
                onClick={closeRejectModal}
                disabled={rejectSubmitting}
                aria-label="Đóng hộp thoại"
                className="rounded-full border border-[#B08A4A]/35 px-2.5 py-1 font-mono text-xs text-[#5C4B41] hover:bg-[#FBF7EF]"
              >
                ×
              </button>
            </div>

            <form onSubmit={handleRejectPo} className="mt-4 space-y-4 text-xs">
              <label className="block">
                <span className="uppercase tracking-[0.14em] text-[#8A672C]">
                  Lý do từ chối PO <span className="text-[#8B2E2E]">*</span>
                </span>
                <textarea
                  required
                  rows={3}
                  minLength={2}
                  maxLength={500}
                  value={rejectReason}
                  onChange={(e) => setRejectReason(e.target.value)}
                  placeholder="VD: Nguyên phụ liệu lụa Bảo Lộc đợt này cần thêm 5 ngày dệt nhuộm, đề xuất dời lịch giao..."
                  className="mt-1.5 w-full rounded-2xl border border-[#B08A4A]/40 bg-[#FBF7EF] px-3.5 py-2.5 text-xs text-[#1C1410] outline-none focus:border-[#1C1410]"
                />
              </label>

              <label className="block">
                <span className="uppercase tracking-[0.14em] text-[#8A672C]">
                  Đề xuất ngày giao dự kiến mới (tùy chọn)
                </span>
                <input
                  type="date"
                  value={rejectProposedDate}
                  onChange={(e) => setRejectProposedDate(e.target.value)}
                  className="mt-1.5 w-full rounded-2xl border border-[#B08A4A]/40 bg-[#FBF7EF] px-3.5 py-2 font-mono text-xs text-[#1C1410] outline-none focus:border-[#1C1410]"
                />
                <p className="mt-1 text-[11px] text-[#7A6A5B]">
                  Để trống nếu nhà cung cấp không thể đáp ứng lô hàng này.
                </p>
              </label>

              {rejectModalError ? (
                <p
                  role="alert"
                  className="rounded-xl border border-[#8B2E2E]/35 bg-[#FFF5F4] px-3.5 py-2.5 text-xs text-[#8B2E2E]"
                >
                  {rejectModalError}
                </p>
              ) : null}

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  disabled={rejectSubmitting}
                  onClick={closeRejectModal}
                  className="rounded-full border border-[#B08A4A]/45 px-4 py-2 text-[11px] font-medium text-[#5C4B41] hover:bg-[#FBF7EF]"
                >
                  Hủy bỏ
                </button>
                <button
                  type="submit"
                  disabled={rejectSubmitting}
                  className="rounded-full bg-[#8B2E2E] px-5 py-2 text-[11px] font-medium uppercase tracking-[0.14em] text-white hover:opacity-90 disabled:opacity-50"
                >
                  {rejectSubmitting
                    ? 'Đang gửi phản hồi...'
                    : 'Xác nhận từ chối PO'}
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </section>
  );
}

export function PartnerGoodsReceiptsTab() {
  const [receipts, setReceipts] = useState<GoodsReceiptDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadGrns = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await partnerFetch<unknown>('/api/v1/partner/goods-receipts');
    if (res.ok) {
      setReceipts(extractList<GoodsReceiptDTO>(res.data));
    } else {
      setError(
        res.error?.message || 'Chưa thể tải danh sách Biên bản nghiệm thu GRN.',
      );
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void loadGrns();
  }, [loadGrns]);

  return (
    <section className="rounded-3xl border border-[#B08A4A]/30 bg-white p-6">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-[#B08A4A]/20 pb-4">
        <div>
          <p className="partner-eyebrow text-[#8A672C]">
            Goods Receipt Notes (GRN) · Nghiệm thu chất lượng &amp; Lô hàng
          </p>
          <h2 className="font-editorial mt-1 text-3xl text-[#1C1410]">
            Biên bản nghiệm thu nhập kho ({receipts.length})
          </h2>
        </div>
        <button
          type="button"
          disabled={loading}
          onClick={() => void loadGrns()}
          className="rounded-full bg-[#1C1410] px-5 py-2 text-xs uppercase tracking-[0.16em] text-[#EBCF8F] disabled:opacity-50"
        >
          {loading ? 'Đang tải...' : 'Làm mới GRN'}
        </button>
      </div>

      {error ? (
        <p className="mt-4 rounded-2xl border border-[#8B2E2E]/35 bg-[#FFF5F4] px-4 py-3 text-xs text-[#8B2E2E]">
          {error}
        </p>
      ) : null}

      <div className="mt-5 space-y-4">
        {receipts.length === 0 ? (
          <p className="rounded-2xl border border-[#B08A4A]/20 bg-[#FBF7EF] p-8 text-center text-xs text-[#7A6A5B]">
            {loading
              ? 'Đang tải biên bản nghiệm thu...'
              : 'Chưa có biên bản nghiệm thu GRN nào được lập.'}
          </p>
        ) : (
          receipts.map((grn) => (
            <article
              key={grn.id}
              className="rounded-2xl border border-[#B08A4A]/25 bg-[#FBF7EF]/70 p-4 text-xs"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <strong className="font-mono text-sm text-[#1C1410]">
                    {grn.grnNumber}
                  </strong>
                  <span className="rounded-full bg-white px-2.5 py-0.5 font-mono text-[10px] text-[#5C4B41]">
                    PO: {grn.poNumber || grn.poId.slice(0, 10)}
                  </span>
                  <span className="rounded-full bg-white px-2.5 py-0.5 font-mono text-[10px] text-[#8A672C]">
                    Kho: {grn.warehouseCode}
                  </span>
                </div>
                <span className="font-mono text-[11px] text-[#7A6A5B]">
                  {formatDateTime(grn.createdAt)}
                </span>
              </div>

              <div className="mt-2.5 flex flex-wrap gap-2 font-mono text-[11px]">
                <span className="rounded-full border border-[#2E6B47]/40 bg-[#F2FBF6] px-3 py-0.5 font-semibold text-[#1E4B32]">
                  Đạt chuẩn (acceptedQty): {grn.totalAcceptedQty}
                </span>
                <span
                  className={`rounded-full border px-3 py-0.5 font-semibold ${
                    grn.totalRejectedQty > 0
                      ? 'border-[#8B2E2E]/40 bg-[#FFF5F4] text-[#8B2E2E]'
                      : 'border-[#B08A4A]/30 bg-white text-[#7A6A5B]'
                  }`}
                >
                  Lỗi trả xưởng (rejectedDefectQty): {grn.totalRejectedQty}
                </span>
              </div>

              {grn.items.length > 0 ? (
                <div className="mt-3 overflow-x-auto rounded-xl border border-[#B08A4A]/20 bg-white">
                  <table className="w-full text-left text-[11px]">
                    <thead className="border-b border-[#B08A4A]/15 bg-[#F4EBDA]/60 text-[10px] uppercase tracking-[0.12em] text-[#8A672C]">
                      <tr>
                        <th className="px-3 py-2">SKU</th>
                        <th className="px-3 py-2">Mã lô (batchCode)</th>
                        <th className="px-3 py-2 text-right">Thực nhận</th>
                        <th className="px-3 py-2 text-right">Đạt chuẩn</th>
                        <th className="px-3 py-2 text-right">Lỗi trả xưởng</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#B08A4A]/10 font-mono">
                      {grn.items.map((line, i) => (
                        <tr key={`${grn.id}-${line.poItemId}-${i}`}>
                          <td className="px-3 py-2">
                            {line.skuId.slice(0, 14)}…
                          </td>
                          <td className="px-3 py-2 font-semibold text-[#1C1410]">
                            {line.batchCode}
                          </td>
                          <td className="px-3 py-2 text-right">
                            {line.receivedQty}
                          </td>
                          <td className="px-3 py-2 text-right font-semibold text-[#1E4B32]">
                            +{line.acceptedQty}
                          </td>
                          <td
                            className={`px-3 py-2 text-right font-semibold ${
                              line.rejectedDefectQty > 0
                                ? 'text-[#8B2E2E]'
                                : 'text-[#7A6A5B]'
                            }`}
                          >
                            {line.rejectedDefectQty}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}
            </article>
          ))
        )}
      </div>
    </section>
  );
}

export interface PartnerPayablesTabProps {
  supplierId?: string;
}

export function PartnerPayablesTab({ supplierId }: PartnerPayablesTabProps = {}) {
  const [payables, setPayables] = useState<SupplierPayableDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadPayables = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await partnerFetch<unknown>('/api/v1/partner/payables');
    if (res.ok) {
      setPayables(extractList<SupplierPayableDTO>(res.data));
    } else {
      setError(
        res.error?.message || 'Chưa thể tải bảng Đối soát công nợ nhà cung cấp.',
      );
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void loadPayables();
  }, [loadPayables]);

  const summary = useMemo(() => {
    let unpaid = 0;
    let paid = 0;
    for (const row of payables) {
      if (row.status === SupplierPayableStatus.PAID) {
        paid += row.amountPayableVnd;
      } else {
        unpaid += row.amountPayableVnd;
      }
    }
    return { unpaid, paid, total: unpaid + paid };
  }, [payables]);

  const handleExportPayablesCsv = () => {
    if (payables.length === 0) {
      emitPortalToast({
        kind: 'info',
        title: 'CHƯA CÓ DỮ LIỆU CÔNG NỢ',
        message: 'Chưa có phiếu công nợ nào để xuất tệp CSV đối soát.',
      });
      return;
    }

    const headers = [
      'Mã công nợ',
      'Mã đơn đặt hàng (PO)',
      'Biên bản nghiệm thu (GRN)',
      'Số tiền phải trả (VND)',
      'Trạng thái',
      'Hạn thanh toán',
      'Mã tham chiếu ngân hàng (UNC)',
      'Ngày tất toán',
      'Ghi chú tất toán',
      'Ngày ghi nhận',
    ];

    const rows = payables.map((pay) => {
      const bankRef = pay.bankReference || pay.paymentReference || '';
      return [
        pay.id,
        pay.poNumber || pay.poId || '',
        pay.grnNumber || pay.grnId,
        pay.amountPayableVnd,
        pay.status,
        pay.dueDate,
        bankRef,
        pay.paidAt ? formatDateTime(pay.paidAt) : '',
        pay.settlementNote || '',
        formatDateTime(pay.createdAt),
      ]
        .map(escapeCsvCell)
        .join(',');
    });

    const csvContent = [headers.map(escapeCsvCell).join(','), ...rows].join(
      '\r\n',
    );
    // UTF-8 BOM (\uFEFF) ensures Vietnamese diacritics open cleanly in Microsoft Excel
    const blob = new Blob([`\uFEFF${csvContent}`], {
      type: 'text/csv;charset=utf-8;',
    });
    const url = URL.createObjectURL(blob);
    const ymd = new Date().toISOString().slice(0, 10);
    const scopeSuffix = supplierId ? `-${supplierId.slice(0, 8)}` : '';
    const link = document.createElement('a');
    link.href = url;
    link.download = `doi-soat-cong-no${scopeSuffix}-${ymd}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);

    emitPortalToast({
      kind: 'success',
      title: 'XUẤT ĐỐI SOÁT CSV THÀNH CÔNG',
      message: `Đã xuất ${payables.length} phiếu công nợ (UTF-8 BOM cho Excel).`,
    });
  };

  return (
    <section className="space-y-6">
      {/* KPI Totals */}
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="rounded-2xl border border-[#D9822B]/35 bg-[#FFF8EB] p-5">
          <p className="text-[11px] uppercase tracking-[0.14em] text-[#9A5B13]">
            Công nợ chờ thanh toán (UNPAID)
          </p>
          <p className="font-editorial mt-2 text-4xl text-[#1C1410]">
            {FORMAT_VND(summary.unpaid)}
          </p>
        </div>
        <div className="rounded-2xl border border-[#2E6B47]/30 bg-[#F2FBF6] p-5">
          <p className="text-[11px] uppercase tracking-[0.14em] text-[#1E4B32]">
            Đã tất toán (PAID)
          </p>
          <p className="font-editorial mt-2 text-4xl text-[#1C1410]">
            {FORMAT_VND(summary.paid)}
          </p>
        </div>
        <div className="rounded-2xl border border-[#B08A4A]/30 bg-white p-5">
          <p className="text-[11px] uppercase tracking-[0.14em] text-[#8A672C]">
            Tổng giá trị đối soát ({payables.length} phiếu)
          </p>
          <p className="font-editorial mt-2 text-4xl text-[#1C1410]">
            {FORMAT_VND(summary.total)}
          </p>
        </div>
      </div>

      {/* Payables Table */}
      <div className="rounded-3xl border border-[#B08A4A]/30 bg-white p-6">
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-[#B08A4A]/20 pb-4">
          <div>
            <p className="partner-eyebrow text-[#8A672C]">
              Supplier Payables · Tính theo số lượng đạt chuẩn GRN
            </p>
            <h2 className="font-editorial mt-1 text-3xl text-[#1C1410]">
              Chi tiết đối soát công nợ
            </h2>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={loading || payables.length === 0}
              onClick={handleExportPayablesCsv}
              className="rounded-full border border-[#1C1410] bg-[#FBF7EF] px-4 py-2 text-xs font-medium uppercase tracking-[0.12em] text-[#1C1410] hover:bg-[#1C1410] hover:text-[#EBCF8F] transition-colors disabled:opacity-45"
            >
              Xuất đối soát công nợ (CSV)
            </button>
            <button
              type="button"
              disabled={loading}
              onClick={() => void loadPayables()}
              className="rounded-full bg-[#1C1410] px-5 py-2 text-xs uppercase tracking-[0.16em] text-[#EBCF8F] disabled:opacity-50"
            >
              {loading ? 'Đang tải...' : 'Làm mới công nợ'}
            </button>
          </div>
        </div>

        {error ? (
          <p className="mt-4 rounded-2xl border border-[#8B2E2E]/35 bg-[#FFF5F4] px-4 py-3 text-xs text-[#8B2E2E]">
            {error}
          </p>
        ) : null}

        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-[#B08A4A]/25 bg-[#F4EBDA]/65 text-[10px] uppercase tracking-[0.14em] text-[#8A672C]">
              <tr>
                <th className="px-4 py-3">Mã công nợ / PO</th>
                <th className="px-4 py-3">Biên bản GRN</th>
                <th className="px-4 py-3 text-right">Số tiền phải trả</th>
                <th className="px-4 py-3">Hạn thanh toán</th>
                <th className="px-4 py-3">Trạng thái</th>
                <th className="px-4 py-3">Chứng từ UNC / Tất toán</th>
                <th className="px-4 py-3">Ngày ghi nhận</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#B08A4A]/15">
              {payables.length === 0 ? (
                <tr>
                  <td
                    colSpan={7}
                    className="px-4 py-8 text-center text-xs text-[#7A6A5B]"
                  >
                    {loading
                      ? 'Đang tải công nợ...'
                      : 'Chưa có công nợ nào phát sinh.'}
                  </td>
                </tr>
              ) : (
                payables.map((pay) => {
                  const bankRef = pay.bankReference || pay.paymentReference;
                  return (
                    <tr key={pay.id}>
                      <td className="px-4 py-3 font-mono">
                        <p className="font-semibold text-[#1C1410]">
                          {pay.poNumber || `${pay.id.slice(0, 12)}…`}
                        </p>
                        <p className="text-[10px] text-[#7A6A5B]">
                          ID: {pay.id.slice(0, 12)}…
                        </p>
                      </td>
                      <td className="px-4 py-3 font-mono text-[11px] text-[#5C4B41]">
                        {pay.grnNumber || `${pay.grnId.slice(0, 12)}…`}
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
                      <td className="px-4 py-3 font-mono text-[11px] text-[#5C4B41]">
                        {bankRef ? (
                          <div>
                            <p className="font-semibold text-[#1E4B32]">
                              {bankRef}
                            </p>
                            {pay.paidAt ? (
                              <p className="text-[10px] text-[#7A6A5B]">
                                {formatDateTime(pay.paidAt)}
                              </p>
                            ) : null}
                          </div>
                        ) : (
                          <span className="text-[#7A6A5B]">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3 font-mono text-[11px] text-[#7A6A5B]">
                        {formatDateTime(pay.createdAt)}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
