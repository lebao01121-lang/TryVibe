'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  OrderStatus,
  RmaExchangeMode,
  RmaReasonCode,
  RmaStatus,
  RmaType,
  type OrderDTO,
  type RmaRequestDTO,
} from '@atelier/contracts';
import { adminFetch } from '@/lib/api-client';

function extractList<T>(data: unknown): T[] {
  if (Array.isArray(data)) return data as T[];
  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    for (const key of ['items', 'list', 'rows', 'orders', 'rmas', 'requests']) {
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
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(iso));
  } catch {
    return iso.slice(0, 16);
  }
}

const ORDER_STATUS_STYLE: Record<OrderStatus, { label: string; cls: string }> = {
  [OrderStatus.PENDING_RESERVATION]: {
    label: 'Chờ giữ tồn',
    cls: 'border-[#B08A4A]/40 bg-[#FBF7EF] text-[#7A6A5B]',
  },
  [OrderStatus.FAILED_OUT_OF_STOCK]: {
    label: 'Hết hàng',
    cls: 'border-[#8B2E2E]/40 bg-[#FFF5F4] text-[#8B2E2E]',
  },
  [OrderStatus.AWAITING_PAYMENT]: {
    label: 'Chờ thanh toán',
    cls: 'border-[#D9822B]/45 bg-[#FFF6E5] text-[#9A5B13]',
  },
  [OrderStatus.CONFIRMED]: {
    label: 'Đã xác nhận',
    cls: 'border-[#2E6B47]/40 bg-[#F2FBF6] text-[#1E4B32]',
  },
  [OrderStatus.PACKING]: {
    label: 'Đang đóng gói',
    cls: 'border-[#B08A4A]/55 bg-[#FFF8EB] text-[#8A5A12]',
  },
  [OrderStatus.SHIPPED]: {
    label: 'Đang giao vận',
    cls: 'border-[#2E5A8B]/40 bg-[#F2F7FC] text-[#1E4066]',
  },
  [OrderStatus.DELIVERED]: {
    label: 'Đã giao',
    cls: 'border-[#2E6B47]/50 bg-[#EBF9F1] text-[#1E4B32]',
  },
  [OrderStatus.COMPLETED]: {
    label: 'Hoàn tất',
    cls: 'border-[#1C1410]/30 bg-[#1C1410] text-[#EBCF8F]',
  },
  [OrderStatus.CANCELLED]: {
    label: 'Đã hủy',
    cls: 'border-[#7A6A5B]/35 bg-[#F4EBDA]/60 text-[#5C4B41]',
  },
  [OrderStatus.LATE_PAYMENT_NEEDS_REFUND]: {
    label: 'THANH TOÁN TRỄ · CẦN HOÀN TIỀN',
    cls: 'border-[#8B2E2E] bg-[#8B2E2E] text-white font-semibold',
  },
};

const RMA_TYPE_LABELS: Record<RmaType, string> = {
  [RmaType.SIZE_EXCHANGE]: 'Đổi Size',
  [RmaType.COLOR_EXCHANGE]: 'Đổi Màu',
  [RmaType.RETURN_REFUND]: 'Trả hàng & Hoàn tiền',
};

const RMA_REASON_LABELS: Record<RmaReasonCode, string> = {
  [RmaReasonCode.SAI_KICH_CO_CHAT]: 'Hơi chật',
  [RmaReasonCode.SAI_KICH_CO_RONG]: 'Hơi rộng',
  [RmaReasonCode.SAI_MAU_MO_TA]: 'Khác màu mô tả',
  [RmaReasonCode.LOI_SAN_XUAT]: 'Lỗi sản xuất',
  [RmaReasonCode.KHAC]: 'Lý do khác',
};

const DEFAULT_PACK_PHOTO_URL =
  'https://atelier.local/media/pack-box-signature-ivory.webp';

export function OrdersRmaTab() {
  const [orders, setOrders] = useState<OrderDTO[]>([]);
  const [rmas, setRmas] = useState<RmaRequestDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{
    kind: 'success' | 'error';
    message: string;
  } | null>(null);

  // Filters
  const [statusFilter, setStatusFilter] = useState<'ALL' | OrderStatus>('ALL');
  const [searchQuery, setSearchQuery] = useState('');

  // Inline Pack Photo state
  const [packingOrderCode, setPackingOrderCode] = useState<string | null>(null);
  const [packPhotoUrl, setPackPhotoUrl] = useState(DEFAULT_PACK_PHOTO_URL);

  // 3-Criterion QC Checklist Dialog state
  const [qcRma, setQcRma] = useState<RmaRequestDTO | null>(null);
  const [tagsIntact, setTagsIntact] = useState(true);
  const [unwashed, setUnwashed] = useState(true);
  const [noStainsOrOdor, setNoStainsOrOdor] = useState(true);
  const [qcPassedOverride, setQcPassedOverride] = useState<boolean | null>(
    null,
  );
  const [inspectorNote, setInspectorNote] = useState('');

  const loadData = useCallback(async () => {
    setLoading(true);
    const [ordersRes, rmaRes] = await Promise.all([
      adminFetch<unknown>('/api/v1/admin/orders'),
      adminFetch<unknown>('/api/v1/admin/rma'),
    ]);

    if (ordersRes.ok) {
      setOrders(extractList<OrderDTO>(ordersRes.data));
    }
    if (rmaRes.ok) {
      setRmas(extractList<RmaRequestDTO>(rmaRes.data));
    }
    if (!ordersRes.ok && !rmaRes.ok) {
      setFeedback({
        kind: 'error',
        message:
          ordersRes.error?.message ||
          'Chưa thể tải danh sách đơn hàng & RMA. Kiểm tra quyền ORDER_READ và dịch vụ order-rma (:4006).',
      });
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const latePaymentOrders = useMemo(
    () =>
      orders.filter(
        (order) => order.status === OrderStatus.LATE_PAYMENT_NEEDS_REFUND,
      ),
    [orders],
  );

  const filteredOrders = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return orders.filter((order) => {
      if (statusFilter !== 'ALL' && order.status !== statusFilter) {
        return false;
      }
      if (q) {
        const hay = [
          order.orderCode,
          order.customerEmail ?? '',
          order.shippingAddress?.recipientName ?? '',
          order.shippingAddress?.phone ?? '',
          order.paymentMethod,
        ]
          .join(' ')
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [orders, statusFilter, searchQuery]);

  const handleRefundLatePayment = async (orderCode: string) => {
    setBusyAction(`refund-${orderCode}`);
    setFeedback(null);
    const res = await adminFetch<unknown>(
      `/api/v1/admin/orders/${encodeURIComponent(orderCode)}/refund-late-payment`,
      { method: 'POST', body: JSON.stringify({}) },
    );
    if (res.ok) {
      setFeedback({
        kind: 'success',
        message: `Đã xử lý hoàn tiền thanh toán trễ cho đơn ${orderCode}.`,
      });
      await loadData();
    } else {
      setFeedback({
        kind: 'error',
        message:
          res.error?.message ||
          `Không thể hoàn tiền thanh toán trễ cho đơn ${orderCode}.`,
      });
    }
    setBusyAction(null);
  };

  const handlePackOrder = async (orderCode: string) => {
    setBusyAction(`pack-${orderCode}`);
    setFeedback(null);
    const res = await adminFetch<unknown>(
      `/api/v1/admin/orders/${encodeURIComponent(orderCode)}/pack`,
      {
        method: 'POST',
        body: JSON.stringify({
          packPhotoUrl: packPhotoUrl.trim() || DEFAULT_PACK_PHOTO_URL,
        }),
      },
    );
    if (res.ok) {
      setFeedback({
        kind: 'success',
        message: `Đơn ${orderCode} đã chuyển trạng thái Đóng gói kèm ảnh hộp quà.`,
      });
      setPackingOrderCode(null);
      await loadData();
    } else {
      setFeedback({
        kind: 'error',
        message: res.error?.message || `Đóng gói đơn ${orderCode} thất bại.`,
      });
    }
    setBusyAction(null);
  };

  const handleOrderTransition = async (
    orderCode: string,
    step: 'ship' | 'deliver',
  ) => {
    setBusyAction(`${step}-${orderCode}`);
    setFeedback(null);
    const res = await adminFetch<unknown>(
      `/api/v1/admin/orders/${encodeURIComponent(orderCode)}/${step}`,
      { method: 'POST', body: JSON.stringify({}) },
    );
    if (res.ok) {
      setFeedback({
        kind: 'success',
        message:
          step === 'ship'
            ? `Đơn ${orderCode} đã bàn giao đơn vị vận chuyển (SHIPPED).`
            : `Đơn ${orderCode} đã xác nhận giao thành công (DELIVERED).`,
      });
      await loadData();
    } else {
      setFeedback({
        kind: 'error',
        message:
          res.error?.message || `Cập nhật trạng thái đơn ${orderCode} thất bại.`,
      });
    }
    setBusyAction(null);
  };

  const handleApproveRma = async (rma: RmaRequestDTO) => {
    setBusyAction(`approve-${rma.id}`);
    setFeedback(null);
    const res = await adminFetch<unknown>(
      `/api/v1/admin/rma/${encodeURIComponent(rma.id)}/approve`,
      { method: 'POST', body: JSON.stringify({}) },
    );
    if (res.ok) {
      setFeedback({
        kind: 'success',
        message: `Đã duyệt phiếu RMA ${rma.rmaCode} (${rma.exchangeMode === RmaExchangeMode.INSTANT_2WAY ? 'Đổi 2 chiều tức thì' : 'Kiểm định QC chuẩn'}).`,
      });
      await loadData();
    } else {
      setFeedback({
        kind: 'error',
        message:
          res.error?.message || `Không thể duyệt phiếu RMA ${rma.rmaCode}.`,
      });
    }
    setBusyAction(null);
  };

  const openQcDialog = (rma: RmaRequestDTO) => {
    setQcRma(rma);
    setTagsIntact(true);
    setUnwashed(true);
    setNoStainsOrOdor(true);
    setQcPassedOverride(null);
    setInspectorNote('');
  };

  const computedQcPassed =
    qcPassedOverride !== null
      ? qcPassedOverride
      : tagsIntact && unwashed && noStainsOrOdor;

  const handleSubmitQc = async () => {
    if (!qcRma) return;
    setBusyAction(`qc-${qcRma.id}`);
    setFeedback(null);

    const res = await adminFetch<unknown>(
      `/api/v1/admin/rma/${encodeURIComponent(qcRma.id)}/qc-complete`,
      {
        method: 'POST',
        body: JSON.stringify({
          tagsIntact,
          unwashed,
          noStainsOrOdor,
          passed: computedQcPassed,
          inspectorNote: inspectorNote.trim() || undefined,
        }),
      },
    );

    if (res.ok) {
      setFeedback({
        kind: 'success',
        message: computedQcPassed
          ? `QC ĐẠT cho ${qcRma.rmaCode} — đã hoàn tồn kho / kích hoạt hoàn tiền hoặc chốt đơn đổi.`
          : `QC KHÔNG ĐẠT cho ${qcRma.rmaCode} — đã ghi nhận trạng thái QC_FAILED.`,
      });
      setQcRma(null);
      await loadData();
    } else {
      setFeedback({
        kind: 'error',
        message:
          res.error?.message ||
          `Không thể hoàn tất kiểm định QC cho ${qcRma.rmaCode}.`,
      });
    }
    setBusyAction(null);
  };

  return (
    <div className="space-y-8">
      {/* Prominent Late-Payment Alert Banner */}
      {latePaymentOrders.length > 0 ? (
        <section
          role="alert"
          className="rounded-3xl border-2 border-[#8B2E2E] bg-[#FFF5F4] p-6 shadow-sm"
        >
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="font-mono text-[11px] font-bold uppercase tracking-[0.18em] text-[#8B2E2E]">
                CẢNH BÁO THANH TOÁN TRỄ · LATE_PAYMENT_NEEDS_REFUND (
                {latePaymentOrders.length})
              </p>
              <h2 className="font-editorial mt-1 text-3xl text-[#1C1410]">
                Phát hiện giao dịch thanh toán sau khi đơn đã hết hạn 15 phút
              </h2>
              <p className="mt-1 text-xs text-[#5C4B41]">
                Kho đã tự động nhả giữ chỗ. Vui lòng hoàn tiền ngay cho khách
                hàng bằng thao tác 1 chạm bên dưới để tránh ghi nhận doanh thu
                sai lệch.
              </p>
            </div>
          </div>

          <div className="mt-4 space-y-2.5">
            {latePaymentOrders.map((order) => (
              <div
                key={order.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[#8B2E2E]/35 bg-white px-4 py-3 text-xs"
              >
                <div className="space-y-0.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono font-bold text-[#8B2E2E]">
                      {order.orderCode}
                    </span>
                    <span className="rounded-full bg-[#FFF5F4] px-2.5 py-0.5 font-mono text-[10px] text-[#8B2E2E]">
                      {order.paymentMethod}
                    </span>
                    <span className="font-mono font-semibold text-[#1C1410]">
                      {FORMAT_VND(order.totalAmountVnd)}
                    </span>
                  </div>
                  <p className="text-[11px] text-[#7A6A5B]">
                    {order.shippingAddress?.recipientName} ·{' '}
                    {order.customerEmail || order.shippingAddress?.phone} · Tạo
                    lúc {formatDateTime(order.createdAt)}
                  </p>
                </div>

                <button
                  type="button"
                  disabled={busyAction === `refund-${order.orderCode}`}
                  onClick={() => void handleRefundLatePayment(order.orderCode)}
                  className="rounded-full bg-[#8B2E2E] px-5 py-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                >
                  {busyAction === `refund-${order.orderCode}`
                    ? 'Đang hoàn tiền...'
                    : 'Hoàn tiền thanh toán trễ'}
                </button>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {/* Main Orders Fulfillment Ledger */}
      <section className="rounded-3xl border border-[#B08A4A]/30 bg-white p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="ledger-eyebrow text-[#8A672C]">
              Order Fulfillment Ledger · Đóng gói &amp; Giao vận
            </p>
            <h2 className="font-editorial mt-1 text-3xl text-[#1C1410]">
              Quản lý Đơn hàng ({filteredOrders.length} / {orders.length})
            </h2>
          </div>

          <button
            type="button"
            disabled={loading}
            onClick={() => void loadData()}
            className="rounded-full bg-[#1C1410] px-5 py-2 text-xs uppercase tracking-[0.16em] text-[#EBCF8F] hover:opacity-90 disabled:opacity-50"
          >
            {loading ? 'Đang tải...' : 'Làm mới đơn & RMA'}
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

        <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
          <input
            type="search"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Tìm mã đơn, email, tên người nhận, SĐT..."
            className="w-72 rounded-full border border-[#B08A4A]/40 bg-[#FBF7EF] px-4 py-1.5 text-xs text-[#1C1410] outline-none focus:border-[#1C1410]"
          />

          <div className="flex flex-wrap gap-1.5">
            {(
              [
                ['ALL', 'Tất cả'],
                [OrderStatus.CONFIRMED, 'Đã xác nhận'],
                [OrderStatus.PACKING, 'Đóng gói'],
                [OrderStatus.SHIPPED, 'Đang giao'],
                [OrderStatus.DELIVERED, 'Đã giao'],
                [OrderStatus.AWAITING_PAYMENT, 'Chờ TT'],
                [OrderStatus.LATE_PAYMENT_NEEDS_REFUND, 'TT Trễ'],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setStatusFilter(key)}
                className={`rounded-full px-3 py-1 text-[11px] transition-colors ${
                  statusFilter === key
                    ? 'bg-[#1C1410] text-[#EBCF8F]'
                    : 'border border-[#B08A4A]/35 bg-[#FBF7EF] text-[#5C4B41]'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="mt-5 space-y-3">
          {filteredOrders.length === 0 ? (
            <p className="rounded-2xl border border-[#B08A4A]/20 bg-[#FBF7EF] p-8 text-center text-xs text-[#7A6A5B]">
              {loading
                ? 'Đang tải danh sách đơn hàng...'
                : 'Chưa có đơn hàng nào khớp bộ lọc.'}
            </p>
          ) : (
            filteredOrders.map((order) => {
              const badge = ORDER_STATUS_STYLE[order.status] ?? {
                label: order.status,
                cls: 'border-[#B08A4A]/30 bg-[#FBF7EF] text-[#1C1410]',
              };
              const isPackingThis = packingOrderCode === order.orderCode;

              return (
                <article
                  key={order.id}
                  className="rounded-2xl border border-[#B08A4A]/25 bg-[#FBF7EF]/65 p-4 text-xs"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-sm font-bold text-[#1C1410]">
                          {order.orderCode}
                        </span>
                        <span
                          className={`rounded-full border px-2.5 py-0.5 text-[10px] uppercase tracking-[0.1em] ${badge.cls}`}
                        >
                          {badge.label}
                        </span>
                        <span className="rounded-full bg-white px-2.5 py-0.5 font-mono text-[10px] text-[#5C4B41]">
                          {order.paymentMethod} · {order.shippingMethod}
                        </span>
                      </div>
                      <p className="mt-1 text-[11px] text-[#5C4B41]">
                        {order.shippingAddress?.recipientName} ·{' '}
                        {order.shippingAddress?.phone} ·{' '}
                        {order.shippingAddress?.streetLine},{' '}
                        {order.shippingAddress?.districtName},{' '}
                        {order.shippingAddress?.provinceName}
                      </p>
                      <p className="mt-0.5 font-mono text-[11px] text-[#7A6A5B]">
                        Tạo: {formatDateTime(order.createdAt)} · Tổng:{' '}
                        <strong className="text-[#1C1410]">
                          {FORMAT_VND(order.totalAmountVnd)}
                        </strong>
                        {order.voucherCode
                          ? ` · Voucher: ${order.voucherCode} (-${FORMAT_VND(order.voucherDiscountVnd)})`
                          : ''}
                        {order.shipment?.trackingCode
                          ? ` · Vận đơn: ${order.shipment.trackingCode}`
                          : ''}
                      </p>
                    </div>

                    {/* Fulfillment Action Controls */}
                    <div className="flex flex-wrap items-center gap-2">
                      {order.status === OrderStatus.CONFIRMED ? (
                        <button
                          type="button"
                          onClick={() => {
                            setPackingOrderCode(
                              isPackingThis ? null : order.orderCode,
                            );
                            setPackPhotoUrl(DEFAULT_PACK_PHOTO_URL);
                          }}
                          className="rounded-full bg-[#1C1410] px-3.5 py-1.5 text-[10px] font-medium uppercase tracking-[0.14em] text-[#EBCF8F]"
                        >
                          Đóng gói + Ảnh hộp quà
                        </button>
                      ) : null}

                      {(order.status === OrderStatus.PACKING ||
                        order.status === OrderStatus.CONFIRMED) ? (
                        <button
                          type="button"
                          disabled={busyAction === `ship-${order.orderCode}`}
                          onClick={() =>
                            void handleOrderTransition(order.orderCode, 'ship')
                          }
                          className="rounded-full border border-[#1C1410] bg-white px-3.5 py-1.5 text-[10px] font-medium uppercase tracking-[0.14em] text-[#1C1410] hover:bg-[#1C1410] hover:text-[#EBCF8F] disabled:opacity-50"
                        >
                          {busyAction === `ship-${order.orderCode}`
                            ? 'Đang giao...'
                            : 'Giao vận'}
                        </button>
                      ) : null}

                      {order.status === OrderStatus.SHIPPED ? (
                        <button
                          type="button"
                          disabled={busyAction === `deliver-${order.orderCode}`}
                          onClick={() =>
                            void handleOrderTransition(
                              order.orderCode,
                              'deliver',
                            )
                          }
                          className="rounded-full bg-[#1E4B32] px-3.5 py-1.5 text-[10px] font-medium uppercase tracking-[0.14em] text-white disabled:opacity-50"
                        >
                          {busyAction === `deliver-${order.orderCode}`
                            ? 'Đang xác nhận...'
                            : 'Đã giao'}
                        </button>
                      ) : null}

                      {order.status ===
                      OrderStatus.LATE_PAYMENT_NEEDS_REFUND ? (
                        <button
                          type="button"
                          disabled={busyAction === `refund-${order.orderCode}`}
                          onClick={() =>
                            void handleRefundLatePayment(order.orderCode)
                          }
                          className="rounded-full bg-[#8B2E2E] px-3.5 py-1.5 text-[10px] font-medium uppercase tracking-[0.14em] text-white disabled:opacity-50"
                        >
                          Hoàn tiền thanh toán trễ
                        </button>
                      ) : null}
                    </div>
                  </div>

                  {/* Inline Pack Photo Input */}
                  {isPackingThis ? (
                    <div className="mt-3 flex flex-wrap items-center gap-2 rounded-xl border border-[#B08A4A]/35 bg-white p-3">
                      <input
                        type="url"
                        value={packPhotoUrl}
                        onChange={(e) => setPackPhotoUrl(e.target.value)}
                        placeholder="URL ảnh hộp quà đã đóng gói..."
                        className="min-w-[260px] flex-1 rounded-xl border border-[#B08A4A]/35 bg-[#FBF7EF] px-3 py-1.5 font-mono text-[11px]"
                      />
                      <button
                        type="button"
                        disabled={busyAction === `pack-${order.orderCode}`}
                        onClick={() => void handlePackOrder(order.orderCode)}
                        className="rounded-full bg-[#1C1410] px-4 py-1.5 text-[10px] uppercase tracking-[0.14em] text-[#EBCF8F]"
                      >
                        {busyAction === `pack-${order.orderCode}`
                          ? 'Đang lưu...'
                          : 'Xác nhận đóng gói'}
                      </button>
                    </div>
                  ) : null}

                  {/* Line Items Summary */}
                  {order.items.length > 0 ? (
                    <div className="mt-3 grid gap-1.5 border-t border-[#B08A4A]/15 pt-2.5 sm:grid-cols-2">
                      {order.items.map((item) => (
                        <div
                          key={item.id}
                          className="flex items-center justify-between rounded-xl bg-white px-3 py-1.5 text-[11px]"
                        >
                          <span className="truncate font-medium text-[#1C1410]">
                            {item.productName} ({item.colorName} ·{' '}
                            {item.sizeCode}) × {item.qty}
                          </span>
                          <span className="ml-2 shrink-0 font-mono text-[#8A672C]">
                            Net: {FORMAT_VND(item.netRefundableUnitVnd)}
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

      {/* RMA Queue & 3-Criterion QC Checklist */}
      <section className="rounded-3xl border border-[#B08A4A]/30 bg-white p-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="ledger-eyebrow text-[#8A672C]">
              RMA &amp; Size Exchange Queue · Đổi Size 2 Chiều &amp; Kiểm định QC
            </p>
            <h2 className="font-editorial mt-1 text-3xl text-[#1C1410]">
              Yêu cầu Đổi / Trả hàng ({rmas.length})
            </h2>
          </div>
        </div>

        <div className="mt-5 space-y-3">
          {rmas.length === 0 ? (
            <p className="rounded-2xl border border-[#B08A4A]/20 bg-[#FBF7EF] p-8 text-center text-xs text-[#7A6A5B]">
              Chưa có yêu cầu RMA nào.
            </p>
          ) : (
            rmas.map((rma) => {
              const isInstant =
                rma.exchangeMode === RmaExchangeMode.INSTANT_2WAY;
              const canApprove = rma.status === RmaStatus.RMA_REQUESTED;
              const canRunQc =
                rma.status === RmaStatus.EXCHANGE_RESERVED ||
                rma.status === RmaStatus.INSTANT_2WAY_DISPATCHED ||
                rma.status === RmaStatus.RETURN_IN_TRANSIT ||
                rma.status === RmaStatus.QC_INSPECTING ||
                rma.status === RmaStatus.RMA_APPROVED;

              return (
                <article
                  key={rma.id}
                  className="rounded-2xl border border-[#B08A4A]/25 bg-[#FBF7EF]/70 p-4 text-xs"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-sm font-bold text-[#1C1410]">
                          {rma.rmaCode}
                        </span>
                        {rma.orderCode ? (
                          <span className="font-mono text-[11px] text-[#7A6A5B]">
                            Đơn {rma.orderCode}
                          </span>
                        ) : null}
                        <span className="rounded-full bg-[#1C1410] px-2.5 py-0.5 font-mono text-[10px] text-[#EBCF8F]">
                          {rma.status}
                        </span>
                        <span
                          className={`rounded-full border px-2.5 py-0.5 font-mono text-[10px] font-semibold ${
                            isInstant
                              ? 'border-[#2E6B47]/45 bg-[#F2FBF6] text-[#1E4B32]'
                              : 'border-[#B08A4A]/45 bg-[#FFF8EB] text-[#8A5A12]'
                          }`}
                        >
                          {isInstant
                            ? 'INSTANT_2WAY · Đổi 2 chiều tức thì'
                            : 'STANDARD_QC · Kiểm định QC chuẩn'}
                        </span>
                      </div>

                      <p className="text-[11px] text-[#2B2019]">
                        <strong>{RMA_TYPE_LABELS[rma.type]}</strong> · Lý do:{' '}
                        <strong>{RMA_REASON_LABELS[rma.reasonCode]}</strong> ·
                        SL: {rma.qty}
                        {rma.refundAmountVnd != null
                          ? ` · Hoàn dự kiến: ${FORMAT_VND(rma.refundAmountVnd)}`
                          : ''}
                        {rma.supplierBatchCode
                          ? ` · Lô NCC: ${rma.supplierBatchCode}`
                          : ''}
                      </p>

                      {rma.customerNote ? (
                        <p className="rounded-xl border border-[#B08A4A]/20 bg-white px-3 py-1.5 text-[11px] text-[#5C4B41]">
                          Ghi chú khách: &ldquo;{rma.customerNote}&rdquo;
                        </p>
                      ) : null}
                    </div>

                    <div className="flex flex-wrap gap-2">
                      {canApprove ? (
                        <button
                          type="button"
                          disabled={busyAction === `approve-${rma.id}`}
                          onClick={() => void handleApproveRma(rma)}
                          className="rounded-full bg-[#1C1410] px-4 py-1.5 text-[10px] font-medium uppercase tracking-[0.14em] text-[#EBCF8F] disabled:opacity-50"
                        >
                          {busyAction === `approve-${rma.id}`
                            ? 'Đang duyệt...'
                            : 'Duyệt RMA'}
                        </button>
                      ) : null}

                      {canRunQc ? (
                        <button
                          type="button"
                          onClick={() => openQcDialog(rma)}
                          className="rounded-full border border-[#8A672C] bg-[#F4EBDA] px-4 py-1.5 text-[10px] font-medium uppercase tracking-[0.14em] text-[#1C1410] hover:bg-[#1C1410] hover:text-[#EBCF8F]"
                        >
                          Kiểm định QC (3 tiêu chí)
                        </button>
                      ) : null}
                    </div>
                  </div>
                </article>
              );
            })
          )}
        </div>
      </section>

      {/* 3-Criterion QC Checklist Modal Dialog */}
      {qcRma ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Biểu mẫu Kiểm định QC 3 Tiêu chí"
          className="fixed inset-0 z-50 flex items-center justify-center bg-[#1C1410]/75 p-4 backdrop-blur-sm"
        >
          <div className="w-full max-w-lg rounded-3xl border border-[#B08A4A]/40 bg-[#FBF7EF] p-6 shadow-2xl">
            <div className="flex items-start justify-between gap-3 border-b border-[#B08A4A]/20 pb-4">
              <div>
                <p className="ledger-eyebrow text-[#8A672C]">
                  QC Inspection · {qcRma.rmaCode}
                </p>
                <h3 className="font-editorial mt-1 text-3xl text-[#1C1410]">
                  Bảng kiểm QC 3 tiêu chí hoàn kho
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setQcRma(null)}
                className="rounded-full border border-[#B08A4A]/40 px-3 py-1 text-xs text-[#5C4B41]"
              >
                Đóng
              </button>
            </div>

            <div className="mt-5 space-y-3 text-xs">
              <label className="flex cursor-pointer items-center gap-3 rounded-2xl border border-[#B08A4A]/25 bg-white p-3.5">
                <input
                  type="checkbox"
                  checked={tagsIntact}
                  onChange={(e) => {
                    setTagsIntact(e.target.checked);
                    setQcPassedOverride(null);
                  }}
                  className="h-4 w-4 accent-[#1C1410]"
                />
                <span>
                  <strong className="text-[#1C1410]">
                    1. Còn nguyên tem mác / seal xưởng
                  </strong>{' '}
                  (<code>tagsIntact</code>)
                </span>
              </label>

              <label className="flex cursor-pointer items-center gap-3 rounded-2xl border border-[#B08A4A]/25 bg-white p-3.5">
                <input
                  type="checkbox"
                  checked={unwashed}
                  onChange={(e) => {
                    setUnwashed(e.target.checked);
                    setQcPassedOverride(null);
                  }}
                  className="h-4 w-4 accent-[#1C1410]"
                />
                <span>
                  <strong className="text-[#1C1410]">
                    2. Chưa giặt / chưa chỉnh sửa phom
                  </strong>{' '}
                  (<code>unwashed</code>)
                </span>
              </label>

              <label className="flex cursor-pointer items-center gap-3 rounded-2xl border border-[#B08A4A]/25 bg-white p-3.5">
                <input
                  type="checkbox"
                  checked={noStainsOrOdor}
                  onChange={(e) => {
                    setNoStainsOrOdor(e.target.checked);
                    setQcPassedOverride(null);
                  }}
                  className="h-4 w-4 accent-[#1C1410]"
                />
                <span>
                  <strong className="text-[#1C1410]">
                    3. Không vết bẩn / không mùi lạ
                  </strong>{' '}
                  (<code>noStainsOrOdor</code>)
                </span>
              </label>

              <div className="flex items-center justify-between rounded-2xl border border-[#B08A4A]/30 bg-[#F4EBDA]/65 px-4 py-3">
                <span className="font-medium text-[#1C1410]">
                  Kết luận kiểm định QC:
                </span>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setQcPassedOverride(true)}
                    className={`rounded-full px-3.5 py-1 font-medium ${
                      computedQcPassed
                        ? 'bg-[#1E4B32] text-white'
                        : 'border border-[#2E6B47]/35 bg-white text-[#1E4B32]'
                    }`}
                  >
                    ĐẠT (QC_PASSED)
                  </button>
                  <button
                    type="button"
                    onClick={() => setQcPassedOverride(false)}
                    className={`rounded-full px-3.5 py-1 font-medium ${
                      !computedQcPassed
                        ? 'bg-[#8B2E2E] text-white'
                        : 'border border-[#8B2E2E]/35 bg-white text-[#8B2E2E]'
                    }`}
                  >
                    KHÔNG ĐẠT (QC_FAILED)
                  </button>
                </div>
              </div>

              <label className="block">
                <span className="text-[11px] uppercase tracking-[0.14em] text-[#8A672C]">
                  Ghi chú kiểm định viên
                </span>
                <textarea
                  rows={2}
                  value={inspectorNote}
                  onChange={(e) => setInspectorNote(e.target.value)}
                  placeholder="Ghi nhận tình trạng sợi vải, tem mác hoặc lỗi sản xuất..."
                  className="mt-1 w-full rounded-2xl border border-[#B08A4A]/35 bg-white p-3 text-xs"
                />
              </label>
            </div>

            <div className="mt-5 flex justify-end gap-2.5">
              <button
                type="button"
                onClick={() => setQcRma(null)}
                className="rounded-full border border-[#B08A4A]/40 px-4 py-2 text-xs text-[#5C4B41]"
              >
                Hủy
              </button>
              <button
                type="button"
                disabled={busyAction === `qc-${qcRma.id}`}
                onClick={() => void handleSubmitQc()}
                className="rounded-full bg-[#1C1410] px-6 py-2 text-xs font-medium uppercase tracking-[0.16em] text-[#EBCF8F] disabled:opacity-50"
              >
                {busyAction === `qc-${qcRma.id}`
                  ? 'Đang xử lý...'
                  : 'Xác nhận hoàn tất QC'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
