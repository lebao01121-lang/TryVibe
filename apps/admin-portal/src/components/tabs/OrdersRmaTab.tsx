'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
} from 'react';
import {
  MediaAssetType,
  OrderStatus,
  PaymentMethod,
  RmaExchangeMode,
  RmaReasonCode,
  RmaStatus,
  RmaType,
  type MediaAssetDto,
  type OrderDTO,
  type RmaRequestDTO,
  type Role,
} from '@atelier/contracts';
import {
  AnimatedTelemetryNumber,
  LiveStackedHealthBar,
} from '@atelier/motion-kit';
import { adminFetch, extractList } from '@/lib/api-client';
import { PrinterIcon } from '../AdminIcons';
import { emitPortalToast } from '../PortalToastBanner';

export interface OrdersRmaTabProps {
  roles?: readonly Role[];
  darkMode?: boolean;
  onRefreshOverview?: () => void;
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

const ORDER_STATUS_STYLE: Record<OrderStatus, { label: string; cls: string }> =
  {
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

const DEFAULT_PACK_PHOTO_URL = `${(
  process.env.NEXT_PUBLIC_MINIO_URL || 'http://127.0.0.1:9000'
).replace(/\/+$/, '')}/atelier-public/seed/packaging-hop-lua-co-dien.webp`;
const PACK_PHOTO_ALLOWED_MIMES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
]);
const PACK_PHOTO_MAX_BYTES = 10 * 1024 * 1024; // 10MB

async function hasValidPackImageMagicBytes(file: File): Promise<boolean> {
  try {
    const headerBuf = await file.slice(0, 12).arrayBuffer();
    const bytes = new Uint8Array(headerBuf);
    if (bytes.length < 12) return false;
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
      return true;
    }
    if (
      bytes[0] === 0x89 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x4e &&
      bytes[3] === 0x47 &&
      bytes[4] === 0x0d &&
      bytes[5] === 0x0a &&
      bytes[6] === 0x1a &&
      bytes[7] === 0x0a
    ) {
      return true;
    }
    if (
      bytes[0] === 0x52 &&
      bytes[1] === 0x49 &&
      bytes[2] === 0x46 &&
      bytes[3] === 0x46 &&
      bytes[8] === 0x57 &&
      bytes[9] === 0x45 &&
      bytes[10] === 0x42 &&
      bytes[11] === 0x50
    ) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

function extractUploadedMediaUrl(asset: MediaAssetDto | null): string | null {
  if (!asset) return null;
  if (typeof asset.publicUrl === 'string' && asset.publicUrl.trim()) {
    return asset.publicUrl.trim();
  }
  const variants = asset.variants ?? {};
  for (const key of ['preview_url', '960w', '1600w', '720w', '480w']) {
    const entry = variants[key];
    if (typeof entry === 'string' && entry.trim()) {
      return entry.trim();
    }
    if (
      entry &&
      typeof entry === 'object' &&
      'url' in entry &&
      typeof entry.url === 'string' &&
      entry.url.trim()
    ) {
      return entry.url.trim();
    }
  }
  return null;
}

/**
 * Deterministic visual 13x13 QR-style matrix derived from order reference string
 * so the printed delivery slip always includes a crisp scannable-style reference block.
 */
function buildDeterministicMatrixCells(seed: string): boolean[] {
  const size = 13;
  const cells = new Array<boolean>(size * size).fill(false);
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }

  const markFinder = (ox: number, oy: number) => {
    for (let y = 0; y < 4; y += 1) {
      for (let x = 0; x < 4; x += 1) {
        const border = x === 0 || y === 0 || x === 3 || y === 3;
        const center = x === 1 && y === 1;
        cells[(oy + y) * size + (ox + x)] = border || center;
      }
    }
  };
  markFinder(0, 0);
  markFinder(size - 4, 0);
  markFinder(0, size - 4);

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const inFinder =
        (x < 4 && y < 4) ||
        (x >= size - 4 && y < 4) ||
        (x < 4 && y >= size - 4);
      if (inFinder) continue;
      hash ^= (x + 1) * 31 + (y + 1) * 17;
      hash = Math.imul(hash, 16777619);
      cells[y * size + x] = (hash & 1) === 1;
    }
  }
  return cells;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildPrintableInvoiceHtml(order: OrderDTO): string {
  const refCode = order.shipment?.trackingCode || order.orderCode;
  const addr = order.shippingAddress;
  const fullAddr = [
    addr?.streetLine,
    addr?.wardName,
    addr?.districtName,
    addr?.provinceName,
  ]
    .filter(Boolean)
    .join(', ');
  const totalDiscount =
    (order.comboDiscountVnd || 0) + (order.voucherDiscountVnd || 0);
  const codAmount =
    order.paymentMethod === PaymentMethod.COD
      ? (order.shipment?.codCollectVnd ?? order.totalAmountVnd)
      : 0;

  const itemRows = order.items
    .map(
      (item, idx) => `
      <tr>
        <td style="padding:8px;border-bottom:1px solid #e5d8c3;text-align:center;">${idx + 1}</td>
        <td style="padding:8px;border-bottom:1px solid #e5d8c3;">
          <strong>${escapeHtml(item.productName)}</strong><br/>
          <span style="font-size:11px;color:#6c5c4e;">SKU: ${escapeHtml(item.skuCode)} · ${escapeHtml(item.colorName)} · Size ${escapeHtml(item.sizeCode)}</span>
        </td>
        <td style="padding:8px;border-bottom:1px solid #e5d8c3;text-align:center;font-family:monospace;">${item.qty}</td>
        <td style="padding:8px;border-bottom:1px solid #e5d8c3;text-align:right;font-family:monospace;">${FORMAT_VND(item.unitPriceVnd)}</td>
        <td style="padding:8px;border-bottom:1px solid #e5d8c3;text-align:right;font-family:monospace;">${FORMAT_VND(item.netRefundableUnitVnd * item.qty)}</td>
      </tr>`,
    )
    .join('');

  return `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="utf-8" />
  <title>Phiếu giao hàng & Hóa đơn - ${escapeHtml(order.orderCode)}</title>
  <style>
    body { font-family: "Be Vietnam Pro", Arial, sans-serif; color: #1C1410; margin: 0; padding: 28px; background: #fff; }
    .sheet { max-width: 780px; margin: 0 auto; border: 1px solid #B08A4A; padding: 28px; }
    .header { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #1C1410; padding-bottom: 16px; }
    .brand h1 { margin: 0; font-size: 22px; letter-spacing: 0.14em; }
    .brand p { margin: 4px 0 0; font-size: 11px; color: #6c5c4e; }
    .doc-title { text-align: right; }
    .doc-title h2 { margin: 0; font-size: 16px; letter-spacing: 0.08em; }
    .meta { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-top: 18px; font-size: 12px; }
    .box { background: #FBF7EF; border: 1px solid #EBD9B4; padding: 12px; border-radius: 8px; }
    table { width: 100%; border-collapse: collapse; margin-top: 18px; font-size: 12px; }
    th { background: #F4EBDA; color: #5C4B41; text-align: left; padding: 8px; font-size: 10px; text-transform: uppercase; letter-spacing: 0.1em; }
    .totals { margin-top: 16px; margin-left: auto; width: 320px; font-size: 12px; }
    .totals div { display: flex; justify-content: space-between; padding: 4px 0; }
    .totals .grand { border-top: 2px solid #1C1410; margin-top: 6px; padding-top: 8px; font-size: 15px; font-weight: 700; }
    .sigs { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; margin-top: 36px; text-align: center; font-size: 12px; }
    .sig-space { height: 64px; }
    @media print { body { padding: 0; } .sheet { border: none; } }
  </style>
</head>
<body>
  <div class="sheet">
    <div class="header">
      <div class="brand">
        <h1>TRYVIBE FASHION ATELIER</h1>
        <p>Flagship Hà Nội: 28 Tràng Tiền, Hoàn Kiếm · Showroom TP.HCM: 112 Đồng Khởi, Q.1</p>
        <p>Hotline: 1900 6868 · support@tryvibeatelier.vn</p>
      </div>
      <div class="doc-title">
        <h2>PHIẾU GIAO HÀNG KIÊM HÓA ĐƠN</h2>
        <p style="margin:4px 0 0;font-family:monospace;font-size:13px;"><strong>${escapeHtml(order.orderCode)}</strong></p>
        <p style="margin:2px 0 0;font-size:11px;color:#6c5c4e;">Ngày đặt: ${escapeHtml(formatDateTime(order.createdAt))}</p>
      </div>
    </div>
    <div class="meta">
      <div class="box">
        <div style="font-size:10px;text-transform:uppercase;color:#8A672C;letter-spacing:0.12em;">Thông tin người nhận</div>
        <p style="margin:6px 0 2px;"><strong>${escapeHtml(addr?.recipientName || 'Khách hàng Atelier')}</strong></p>
        <p style="margin:2px 0;">SĐT: ${escapeHtml(addr?.phone || '—')}</p>
        <p style="margin:2px 0;">Địa chỉ: ${escapeHtml(fullAddr || '—')}</p>
        ${order.customerEmail ? `<p style="margin:2px 0;">Email: ${escapeHtml(order.customerEmail)}</p>` : ''}
        ${order.giftNote ? `<p style="margin:6px 0 0;font-style:italic;">Lời chúc quà tặng: "${escapeHtml(order.giftNote)}"</p>` : ''}
      </div>
      <div class="box">
        <div style="font-size:10px;text-transform:uppercase;color:#8A672C;letter-spacing:0.12em;">Vận chuyển & Thanh toán</div>
        <p style="margin:6px 0 2px;">Vận chuyển: <strong>${escapeHtml(order.shippingMethod)}</strong></p>
        <p style="margin:2px 0;">Mã vận đơn / Ref: <strong style="font-family:monospace;">${escapeHtml(refCode)}</strong></p>
        <p style="margin:2px 0;">Kho xuất: <strong style="font-family:monospace;">${escapeHtml(order.shipment?.warehouseCode || 'CENTRAL_WH')}</strong></p>
        <p style="margin:2px 0;">Thanh toán: <strong>${escapeHtml(order.paymentMethod)}</strong></p>
        <p style="margin:2px 0;">COD thu hộ: <strong style="font-family:monospace;">${FORMAT_VND(codAmount)}</strong></p>
      </div>
    </div>
    <table>
      <thead>
        <tr>
          <th style="text-align:center;width:44px;">STT</th>
          <th>Sản phẩm / Phân loại</th>
          <th style="text-align:center;width:54px;">SL</th>
          <th style="text-align:right;width:110px;">Đơn giá</th>
          <th style="text-align:right;width:120px;">Thành tiền</th>
        </tr>
      </thead>
      <tbody>${itemRows}</tbody>
    </table>
    <div class="totals">
      <div><span>Tạm tính:</span><span style="font-family:monospace;">${FORMAT_VND(order.subtotalVnd)}</span></div>
      ${totalDiscount > 0 ? `<div><span>Giảm giá (${escapeHtml(order.voucherCode || 'Ưu đãi')}):</span><span style="font-family:monospace;">-${FORMAT_VND(totalDiscount)}</span></div>` : ''}
      ${order.packagingPriceVnd > 0 ? `<div><span>Hộp quà Atelier:</span><span style="font-family:monospace;">${FORMAT_VND(order.packagingPriceVnd)}</span></div>` : ''}
      <div><span>Phí vận chuyển:</span><span style="font-family:monospace;">${FORMAT_VND(order.shippingFeeVnd)}</span></div>
      <div class="grand"><span>TỔNG THANH TOÁN:</span><span style="font-family:monospace;">${FORMAT_VND(order.totalAmountVnd)}</span></div>
    </div>
    <div class="sigs">
      <div><strong>Người lập phiếu / Đóng gói</strong><div class="sig-space"></div><span>(Ký & ghi rõ họ tên)</span></div>
      <div><strong>Khách hàng / Người nhận</strong><div class="sig-space"></div><span>(Xác nhận nguyên vẹn & đủ hàng)</span></div>
    </div>
  </div>
</body>
</html>`;
}

export function OrdersRmaTab({ onRefreshOverview }: OrdersRmaTabProps) {
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

  // Inline Pack Photo & MinIO Upload state
  const [packingOrderCode, setPackingOrderCode] = useState<string | null>(null);
  const [packPhotoUrl, setPackPhotoUrl] = useState(DEFAULT_PACK_PHOTO_URL);
  const [packPhotoUploading, setPackPhotoUploading] = useState(false);
  const [packPhotoProgress, setPackPhotoProgress] = useState(0);
  const [packPhotoPreviewUrl, setPackPhotoPreviewUrl] = useState<string | null>(
    null,
  );
  const [packPhotoMeta, setPackPhotoMeta] = useState<{
    fileName: string;
    sizeKb: number;
  } | null>(null);
  const [packPhotoError, setPackPhotoError] = useState<string | null>(null);
  const packPhotoObjectUrlRef = useRef<string | null>(null);

  // Cancel Order Modal state
  const [cancellingOrder, setCancellingOrder] = useState<OrderDTO | null>(null);
  const [cancelOrderReason, setCancelOrderReason] = useState('');

  // Reject RMA Modal state
  const [rejectingRma, setRejectingRma] = useState<RmaRequestDTO | null>(null);
  const [rejectRmaReason, setRejectRmaReason] = useState('');

  // Printable Invoice / Delivery Slip Overlay state
  const [invoiceOrder, setInvoiceOrder] = useState<OrderDTO | null>(null);

  useEffect(() => {
    return () => {
      if (packPhotoObjectUrlRef.current) {
        URL.revokeObjectURL(packPhotoObjectUrlRef.current);
      }
    };
  }, []);

  const resetPackPhotoUploadState = useCallback(() => {
    if (packPhotoObjectUrlRef.current) {
      URL.revokeObjectURL(packPhotoObjectUrlRef.current);
      packPhotoObjectUrlRef.current = null;
    }
    setPackPhotoUploading(false);
    setPackPhotoProgress(0);
    setPackPhotoPreviewUrl(null);
    setPackPhotoMeta(null);
    setPackPhotoError(null);
  }, []);

  const handlePackPhotoFileChange = async (
    event: ChangeEvent<HTMLInputElement>,
  ) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setPackPhotoError(null);

    if (!PACK_PHOTO_ALLOWED_MIMES.has(file.type)) {
      setPackPhotoError(
        'Chỉ chấp nhận ảnh định dạng JPEG, PNG hoặc WebP (image/jpeg, image/png, image/webp).',
      );
      event.target.value = '';
      return;
    }

    if (file.size > PACK_PHOTO_MAX_BYTES) {
      setPackPhotoError(
        `Tệp ảnh vượt quá giới hạn 10MB (hiện tại ${(file.size / (1024 * 1024)).toFixed(2)}MB).`,
      );
      event.target.value = '';
      return;
    }

    const validMagic = await hasValidPackImageMagicBytes(file);
    if (!validMagic) {
      setPackPhotoError(
        'Tệp ảnh không đạt kiểm định Magic Bytes (chỉ chấp nhận ảnh JPEG, PNG hoặc WebP thực).',
      );
      event.target.value = '';
      return;
    }

    if (packPhotoObjectUrlRef.current) {
      URL.revokeObjectURL(packPhotoObjectUrlRef.current);
    }
    const localPreviewUrl = URL.createObjectURL(file);
    packPhotoObjectUrlRef.current = localPreviewUrl;
    setPackPhotoPreviewUrl(localPreviewUrl);
    setPackPhotoMeta({
      fileName: file.name,
      sizeKb: Math.max(1, Math.round(file.size / 1024)),
    });
    setPackPhotoUploading(true);
    setPackPhotoProgress(35);

    const progressTimer = window.setTimeout(() => {
      setPackPhotoProgress(78);
    }, 320);

    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('assetType', MediaAssetType.LOOKBOOK_PHOTO);

      const res = await adminFetch<MediaAssetDto>(
        '/api/v1/admin/media/upload',
        {
          method: 'POST',
          body: formData,
          timeoutMs: 30_000,
        },
      );

      window.clearTimeout(progressTimer);

      if (res.ok && res.data) {
        const uploadedUrl = extractUploadedMediaUrl(res.data);
        if (uploadedUrl) {
          setPackPhotoUrl(uploadedUrl);
          setPackPhotoPreviewUrl(uploadedUrl);
          setPackPhotoProgress(100);
          setFeedback({
            kind: 'success',
            message: `Đã tải ảnh hộp quà "${file.name}" lên MinIO và tự động điền URL.`,
          });
        } else {
          setPackPhotoProgress(0);
          setPackPhotoError(
            'Tải ảnh thành công nhưng không nhận được URL MinIO công khai.',
          );
        }
      } else {
        setPackPhotoProgress(0);
        setPackPhotoError(
          res.error?.message ||
            'Không thể tải ảnh đóng gói lên MinIO. Kiểm tra tệp ảnh và quyền tải media.',
        );
      }
    } catch (err) {
      window.clearTimeout(progressTimer);
      setPackPhotoProgress(0);
      setPackPhotoError(
        err instanceof Error
          ? err.message
          : 'Lỗi kết nối khi tải ảnh đóng gói.',
      );
    } finally {
      setPackPhotoUploading(false);
      event.target.value = '';
    }
  };

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
      setOrders(
        extractList<OrderDTO>(ordersRes.data, ['items', 'orders', 'list']),
      );
    }
    if (rmaRes.ok) {
      setRmas(
        extractList<RmaRequestDTO>(rmaRes.data, [
          'items',
          'rmas',
          'requests',
          'list',
        ]),
      );
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
      const msg = `Đã xử lý hoàn tiền thanh toán trễ cho đơn ${orderCode}.`;
      setFeedback({ kind: 'success', message: msg });
      emitPortalToast({ kind: 'success', title: 'HOÀN TIỀN TRỄ', message: msg });
      await loadData();
      onRefreshOverview?.();
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
      const msg = `Đơn ${orderCode} đã chuyển trạng thái Đóng gói kèm ảnh hộp quà.`;
      setFeedback({ kind: 'success', message: msg });
      emitPortalToast({ kind: 'success', title: 'ĐÓNG GÓI ĐƠN', message: msg });
      setPackingOrderCode(null);
      resetPackPhotoUploadState();
      await loadData();
      onRefreshOverview?.();
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
    step: 'ship' | 'deliver' | 'complete',
  ) => {
    setBusyAction(`${step}-${orderCode}`);
    setFeedback(null);
    const res = await adminFetch<unknown>(
      `/api/v1/admin/orders/${encodeURIComponent(orderCode)}/${step}`,
      { method: 'POST', body: JSON.stringify({}) },
    );
    if (res.ok) {
      const msg =
        step === 'ship'
          ? `Đơn ${orderCode} đã bàn giao đơn vị vận chuyển (SHIPPED).`
          : step === 'deliver'
            ? `Đơn ${orderCode} đã xác nhận giao thành công (DELIVERED).`
            : `Đơn ${orderCode} đã chuyển sang Hoàn tất (COMPLETED).`;
      setFeedback({ kind: 'success', message: msg });
      emitPortalToast({ kind: 'success', title: 'VẬN HÀNH ĐƠN', message: msg });
      await loadData();
      onRefreshOverview?.();
    } else {
      setFeedback({
        kind: 'error',
        message:
          res.error?.message ||
          `Cập nhật trạng thái đơn ${orderCode} thất bại.`,
      });
    }
    setBusyAction(null);
  };

  const handleConfirmCancelOrder = async (
    event: FormEvent<HTMLFormElement>,
  ) => {
    event.preventDefault();
    if (!cancellingOrder) return;
    if (cancelOrderReason.trim().length < 2) {
      setFeedback({
        kind: 'error',
        message: 'Vui lòng nhập lý do hủy đơn hàng.',
      });
      return;
    }

    setBusyAction(`cancel-${cancellingOrder.orderCode}`);
    setFeedback(null);
    const res = await adminFetch<unknown>(
      `/api/v1/admin/orders/${encodeURIComponent(cancellingOrder.orderCode)}/cancel`,
      {
        method: 'POST',
        body: JSON.stringify({ reason: cancelOrderReason.trim() }),
      },
    );

    if (res.ok) {
      const msg = `Đã hủy đơn ${cancellingOrder.orderCode} — tồn kho & voucher (nếu có) đã được tự động hoàn trả.`;
      setFeedback({ kind: 'success', message: msg });
      emitPortalToast({ kind: 'info', title: 'HỦY ĐƠN HÀNG', message: msg });
      setCancellingOrder(null);
      setCancelOrderReason('');
      await loadData();
      onRefreshOverview?.();
    } else {
      setFeedback({
        kind: 'error',
        message:
          res.error?.message ||
          `Không thể hủy đơn ${cancellingOrder.orderCode}.`,
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
      const msg = `Đã duyệt phiếu RMA ${rma.rmaCode} (${rma.exchangeMode === RmaExchangeMode.INSTANT_2WAY ? 'Đổi 2 chiều tức thì' : 'Kiểm định QC chuẩn'}).`;
      setFeedback({ kind: 'success', message: msg });
      emitPortalToast({ kind: 'success', title: 'DUYỆT RMA', message: msg });
      await loadData();
      onRefreshOverview?.();
    } else {
      setFeedback({
        kind: 'error',
        message:
          res.error?.message || `Không thể duyệt phiếu RMA ${rma.rmaCode}.`,
      });
    }
    setBusyAction(null);
  };

  const handleConfirmRejectRma = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!rejectingRma) return;
    if (rejectRmaReason.trim().length < 2) {
      setFeedback({
        kind: 'error',
        message: 'Vui lòng nhập lý do từ chối RMA để thông báo khách hàng.',
      });
      return;
    }

    setBusyAction(`reject-rma-${rejectingRma.id}`);
    setFeedback(null);
    const res = await adminFetch<unknown>(
      `/api/v1/admin/rma/${encodeURIComponent(rejectingRma.id)}/reject`,
      {
        method: 'POST',
        body: JSON.stringify({ reason: rejectRmaReason.trim() }),
      },
    );

    if (res.ok) {
      const msg = `Đã từ chối phiếu RMA ${rejectingRma.rmaCode} và gửi thông báo lý do tới khách hàng.`;
      setFeedback({ kind: 'success', message: msg });
      emitPortalToast({ kind: 'info', title: 'TỪ CHỐI RMA', message: msg });
      setRejectingRma(null);
      setRejectRmaReason('');
      await loadData();
      onRefreshOverview?.();
    } else {
      setFeedback({
        kind: 'error',
        message:
          res.error?.message ||
          `Không thể từ chối phiếu RMA ${rejectingRma.rmaCode}.`,
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
      const msg = computedQcPassed
        ? `QC ĐẠT cho ${qcRma.rmaCode} — đã hoàn tồn kho / kích hoạt hoàn tiền hoặc chốt đơn đổi.`
        : `QC KHÔNG ĐẠT cho ${qcRma.rmaCode} — đã ghi nhận trạng thái QC_FAILED.`;
      setFeedback({ kind: 'success', message: msg });
      emitPortalToast({ kind: 'success', title: 'KIỂM ĐỊNH QC', message: msg });
      setQcRma(null);
      await loadData();
      onRefreshOverview?.();
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

  const handleDownloadInvoiceHtml = (order: OrderDTO) => {
    const html = buildPrintableInvoiceHtml(order);
    const blob = new Blob([html], { type: 'text/html;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `phieu-giao-hang-${order.orderCode}.html`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    emitPortalToast({
      kind: 'success',
      title: 'PHIẾU GIAO HÀNG & HÓA ĐƠN',
      message: `Đã tải phiếu giao hàng ${order.orderCode} (.html sẵn sàng in / xuất PDF).`,
    });
  };

  const qrCells = useMemo(
    () =>
      invoiceOrder
        ? buildDeterministicMatrixCells(
            `${invoiceOrder.orderCode}|${invoiceOrder.shipment?.trackingCode ?? ''}`,
          )
        : [],
    [invoiceOrder],
  );

  return (
    <div data-testid="orders-rma-tab" className="space-y-8">
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
              Order Fulfillment Ledger · Đóng gói, Giao vận, Hoàn tất &amp; In
              Phiếu giao
            </p>
            <h2 className="font-editorial mt-1 text-3xl text-[#1C1410]">
              Quản lý Đơn hàng (
              <AnimatedTelemetryNumber value={filteredOrders.length} /> /{' '}
              <AnimatedTelemetryNumber value={orders.length} />)
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

        <div className="mt-4 rounded-2xl border border-[#B08A4A]/20 bg-[#FBF7EF]/80 px-4 py-3">
          <LiveStackedHealthBar
            segments={[
              {
                id: 'completed',
                label: 'Đã giao / Hoàn tất',
                value: orders.filter(
                  (o) =>
                    o.status === OrderStatus.DELIVERED ||
                    o.status === OrderStatus.COMPLETED,
                ).length,
                tone: 'emerald',
              },
              {
                id: 'processing',
                label: 'Đang đóng gói / Vận chuyển',
                value: orders.filter(
                  (o) =>
                    o.status === OrderStatus.CONFIRMED ||
                    o.status === OrderStatus.PACKING ||
                    o.status === OrderStatus.SHIPPED ||
                    o.status === OrderStatus.AWAITING_PAYMENT,
                ).length,
                tone: 'amber',
              },
              {
                id: 'rma-alerts',
                label: 'RMA & Thanh toán trễ',
                value: rmas.length + latePaymentOrders.length,
                tone: 'crimson',
              },
            ]}
          />
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
                [OrderStatus.COMPLETED, 'Hoàn tất'],
                [OrderStatus.AWAITING_PAYMENT, 'Chờ TT'],
                [OrderStatus.CANCELLED, 'Đã hủy'],
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
              const canCancelOrder =
                order.status === OrderStatus.PENDING_RESERVATION ||
                order.status === OrderStatus.AWAITING_PAYMENT ||
                order.status === OrderStatus.CONFIRMED ||
                order.status === OrderStatus.PACKING;
              const canCompleteOrder =
                order.status === OrderStatus.DELIVERED ||
                order.status === OrderStatus.SHIPPED;

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
                      {order.cancelReason ? (
                        <p className="mt-1 text-[11px] text-[#8B2E2E]">
                          Lý do hủy: {order.cancelReason}
                        </p>
                      ) : null}
                    </div>

                    {/* Fulfillment Action Controls */}
                    <div className="flex flex-wrap items-center gap-2">
                      {/* Print Delivery Slip & Summary Invoice */}
                      <button
                        type="button"
                        data-testid={`btn-print-invoice-${order.orderCode}`}
                        onClick={() => setInvoiceOrder(order)}
                        className="inline-flex items-center gap-1.5 rounded-full border border-[#B08A4A]/50 bg-white px-3 py-1.5 text-[10px] font-medium text-[#1C1410] hover:bg-[#F4EBDA]"
                      >
                        <PrinterIcon size={12} />
                        In phiếu giao
                      </button>

                      {order.status === OrderStatus.CONFIRMED ? (
                        <button
                          type="button"
                          onClick={() => {
                            const nextCode = isPackingThis
                              ? null
                              : order.orderCode;
                            setPackingOrderCode(nextCode);
                            setPackPhotoUrl(DEFAULT_PACK_PHOTO_URL);
                            resetPackPhotoUploadState();
                          }}
                          className="rounded-full bg-[#1C1410] px-3.5 py-1.5 text-[10px] font-medium uppercase tracking-[0.14em] text-[#EBCF8F]"
                        >
                          Đóng gói + Ảnh hộp quà
                        </button>
                      ) : null}

                      {order.status === OrderStatus.PACKING ||
                      order.status === OrderStatus.CONFIRMED ? (
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

                      {canCompleteOrder ? (
                        <button
                          type="button"
                          data-testid={`btn-complete-order-${order.orderCode}`}
                          disabled={
                            busyAction === `complete-${order.orderCode}`
                          }
                          onClick={() =>
                            void handleOrderTransition(
                              order.orderCode,
                              'complete',
                            )
                          }
                          className="rounded-full bg-[#1C1410] px-3.5 py-1.5 text-[10px] font-medium uppercase tracking-[0.14em] text-[#EBCF8F] hover:opacity-90 disabled:opacity-50"
                        >
                          {busyAction === `complete-${order.orderCode}`
                            ? 'Đang hoàn tất...'
                            : 'Hoàn tất đơn'}
                        </button>
                      ) : null}

                      {canCancelOrder ? (
                        <button
                          type="button"
                          data-testid={`btn-cancel-order-${order.orderCode}`}
                          onClick={() => {
                            setCancellingOrder(order);
                            setCancelOrderReason('');
                          }}
                          className="rounded-full border border-[#8B2E2E]/45 bg-white px-3 py-1.5 text-[10px] font-medium uppercase tracking-[0.12em] text-[#8B2E2E] hover:bg-[#8B2E2E] hover:text-white"
                        >
                          Hủy đơn
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

                  {/* Inline Pack Photo Upload + URL Input */}
                  {isPackingThis ? (
                    <div className="mt-3 space-y-2.5 rounded-xl border border-[#B08A4A]/35 bg-white p-3.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <label
                          data-testid="pack-photo-upload-btn"
                          className={`inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-[#B08A4A]/55 bg-[#F4EBDA] px-3.5 py-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-[#1C1410] transition-colors hover:bg-[#1C1410] hover:text-[#EBCF8F] ${
                            packPhotoUploading
                              ? 'pointer-events-none opacity-60'
                              : ''
                          }`}
                        >
                          {packPhotoUploading
                            ? `Đang tải lên (${packPhotoProgress}%)...`
                            : 'Tải ảnh hộp quà (JPG/PNG/WebP ≤ 10MB)'}
                          <input
                            type="file"
                            data-testid="pack-photo-file-input"
                            accept="image/jpeg,image/png,image/webp"
                            disabled={packPhotoUploading}
                            onChange={(e) => void handlePackPhotoFileChange(e)}
                            className="hidden"
                          />
                        </label>

                        <input
                          type="url"
                          value={packPhotoUrl}
                          onChange={(e) => setPackPhotoUrl(e.target.value)}
                          placeholder="URL ảnh hộp quà đã đóng gói (MinIO)..."
                          className="min-w-[240px] flex-1 rounded-xl border border-[#B08A4A]/35 bg-[#FBF7EF] px-3 py-1.5 font-mono text-[11px]"
                        />

                        <button
                          type="button"
                          disabled={
                            packPhotoUploading ||
                            busyAction === `pack-${order.orderCode}`
                          }
                          onClick={() => void handlePackOrder(order.orderCode)}
                          className="rounded-full bg-[#1C1410] px-4 py-1.5 text-[10px] uppercase tracking-[0.14em] text-[#EBCF8F] disabled:opacity-50"
                        >
                          {busyAction === `pack-${order.orderCode}`
                            ? 'Đang lưu...'
                            : 'Xác nhận đóng gói'}
                        </button>
                      </div>

                      {packPhotoUploading || packPhotoProgress === 100 ? (
                        <div className="space-y-1">
                          <div className="flex items-center justify-between font-mono text-[10px] text-[#7A6A5B]">
                            <span>
                              {packPhotoUploading
                                ? 'Đang kiểm định Magic Bytes & tải lên MinIO...'
                                : '✓ Ảnh hộp quà đã lưu trên MinIO và tự động điền URL'}
                            </span>
                            <span>{packPhotoProgress}%</span>
                          </div>
                          <div className="h-1.5 w-full overflow-hidden rounded-full bg-[#F4EBDA]">
                            <div
                              style={{ width: `${packPhotoProgress}%` }}
                              className={`h-full rounded-full transition-all duration-300 ${
                                packPhotoProgress === 100
                                  ? 'bg-[#2E6B47]'
                                  : 'bg-[#B08A4A]'
                              }`}
                            />
                          </div>
                        </div>
                      ) : null}

                      {packPhotoError ? (
                        <p
                          role="alert"
                          className="rounded-lg border border-[#8B2E2E]/35 bg-[#FFF5F4] px-3 py-1.5 text-[11px] text-[#8B2E2E]"
                        >
                          {packPhotoError}
                        </p>
                      ) : null}

                      {packPhotoPreviewUrl ||
                      (packPhotoUrl.trim() &&
                        packPhotoUrl.trim() !== DEFAULT_PACK_PHOTO_URL) ? (
                        <div className="flex items-center gap-3 rounded-xl border border-[#B08A4A]/25 bg-[#FBF7EF] p-2.5">
                          <img
                            src={packPhotoPreviewUrl || packPhotoUrl.trim()}
                            alt={`Ảnh đóng gói đơn ${order.orderCode}`}
                            data-testid="pack-photo-preview"
                            className="h-16 w-16 rounded-lg border border-[#B08A4A]/30 bg-white object-cover"
                          />
                          <div className="min-w-0 flex-1 text-[11px]">
                            <p className="font-medium text-[#1C1410]">
                              Xem trước ảnh hộp quà đóng gói
                              {packPhotoMeta
                                ? ` · ${packPhotoMeta.fileName} (${packPhotoMeta.sizeKb} KB)`
                                : ''}
                            </p>
                            <p className="mt-0.5 truncate font-mono text-[10px] text-[#7A6A5B]">
                              {packPhotoUrl.trim()}
                            </p>
                          </div>
                          <button
                            type="button"
                            onClick={() => {
                              resetPackPhotoUploadState();
                              setPackPhotoUrl(DEFAULT_PACK_PHOTO_URL);
                            }}
                            className="rounded-full border border-[#B08A4A]/40 px-2.5 py-1 text-[10px] text-[#5C4B41] hover:border-[#1C1410]"
                          >
                            Xóa ảnh
                          </button>
                        </div>
                      ) : null}
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
              RMA &amp; Size Exchange Queue · Đổi Size 2 Chiều, Từ chối &amp;
              Kiểm định QC
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
              const canReject =
                rma.status === RmaStatus.RMA_REQUESTED ||
                rma.status === RmaStatus.RMA_APPROVED ||
                rma.status === RmaStatus.EXCHANGE_RESERVED ||
                rma.status === RmaStatus.QC_INSPECTING;
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
                        <span
                          className={`rounded-full px-2.5 py-0.5 font-mono text-[10px] ${
                            rma.status === RmaStatus.RMA_REJECTED
                              ? 'bg-[#8B2E2E] text-white'
                              : 'bg-[#1C1410] text-[#EBCF8F]'
                          }`}
                        >
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

                      {rma.rejectionReason ? (
                        <p className="rounded-xl border border-[#8B2E2E]/30 bg-[#FFF5F4] px-3 py-1.5 text-[11px] text-[#8B2E2E]">
                          Lý do từ chối gửi khách: &ldquo;{rma.rejectionReason}
                          &rdquo;
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

                      {canReject ? (
                        <button
                          type="button"
                          data-testid={`btn-reject-rma-${rma.id}`}
                          onClick={() => {
                            setRejectingRma(rma);
                            setRejectRmaReason('');
                          }}
                          className="rounded-full border border-[#8B2E2E]/45 bg-white px-3.5 py-1.5 text-[10px] font-medium uppercase tracking-[0.12em] text-[#8B2E2E] hover:bg-[#8B2E2E] hover:text-white"
                        >
                          Từ chối RMA
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

      {/* MODAL: Hủy đơn hàng */}
      {cancellingOrder ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Hủy đơn hàng"
          className="fixed inset-0 z-50 flex items-center justify-center bg-[#1C1410]/75 p-4 backdrop-blur-sm"
        >
          <form
            onSubmit={handleConfirmCancelOrder}
            className="w-full max-w-md rounded-3xl border border-[#8B2E2E]/40 bg-[#FBF7EF] p-6 shadow-2xl"
          >
            <p className="ledger-eyebrow text-[#8B2E2E]">
              Cancel Order · {cancellingOrder.orderCode}
            </p>
            <h3 className="font-editorial mt-1 text-3xl text-[#1C1410]">
              Xác nhận hủy đơn hàng
            </h3>
            <div className="mt-3 rounded-2xl border border-[#B08A4A]/30 bg-white px-3.5 py-2.5 text-xs text-[#5C4B41]">
              Hệ thống sẽ tự động <strong>nhả giữ chỗ / hoàn tồn kho</strong>{' '}
              các SKU và{' '}
              <strong>hoàn lượt sử dụng Voucher</strong> (nếu đơn có áp dụng mã
              giảm giá).
            </div>

            <label className="mt-4 block text-xs">
              <span className="uppercase tracking-[0.14em] text-[#8A672C]">
                Lý do hủy đơn (Bắt buộc)
              </span>
              <textarea
                rows={3}
                required
                minLength={2}
                value={cancelOrderReason}
                onChange={(e) => setCancelOrderReason(e.target.value)}
                placeholder="VD: Khách yêu cầu hủy qua hotline trước khi bàn giao vận chuyển..."
                className="mt-1 w-full rounded-2xl border border-[#B08A4A]/35 bg-white p-3 text-xs"
              />
            </label>

            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setCancellingOrder(null)}
                className="rounded-full border border-[#B08A4A]/40 px-4 py-2 text-xs text-[#5C4B41]"
              >
                Đóng
              </button>
              <button
                type="submit"
                disabled={busyAction === `cancel-${cancellingOrder.orderCode}`}
                className="rounded-full bg-[#8B2E2E] px-5 py-2 text-xs font-medium uppercase tracking-[0.14em] text-white disabled:opacity-50"
              >
                {busyAction === `cancel-${cancellingOrder.orderCode}`
                  ? 'Đang hủy đơn...'
                  : 'Xác nhận hủy đơn'}
              </button>
            </div>
          </form>
        </div>
      ) : null}

      {/* MODAL: Từ chối RMA */}
      {rejectingRma ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Từ chối yêu cầu RMA"
          className="fixed inset-0 z-50 flex items-center justify-center bg-[#1C1410]/75 p-4 backdrop-blur-sm"
        >
          <form
            onSubmit={handleConfirmRejectRma}
            className="w-full max-w-md rounded-3xl border border-[#8B2E2E]/40 bg-[#FBF7EF] p-6 shadow-2xl"
          >
            <p className="ledger-eyebrow text-[#8B2E2E]">
              Reject RMA · {rejectingRma.rmaCode}
            </p>
            <h3 className="font-editorial mt-1 text-3xl text-[#1C1410]">
              Từ chối yêu cầu Đổi / Trả hàng
            </h3>
            <p className="mt-2 text-xs text-[#5C4B41]">
              Lý do từ chối sẽ được lưu vào hồ sơ RMA và gửi thông báo qua Email
              / ZNS tới khách hàng.
            </p>

            <label className="mt-4 block text-xs">
              <span className="uppercase tracking-[0.14em] text-[#8A672C]">
                Lý do từ chối gửi khách hàng (Bắt buộc)
              </span>
              <textarea
                rows={3}
                required
                minLength={2}
                value={rejectRmaReason}
                onChange={(e) => setRejectRmaReason(e.target.value)}
                placeholder="VD: Sản phẩm vượt quá thời hạn đổi size 14 ngày hoặc đã tháo tem niêm phong..."
                className="mt-1 w-full rounded-2xl border border-[#B08A4A]/35 bg-white p-3 text-xs"
              />
            </label>

            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setRejectingRma(null)}
                className="rounded-full border border-[#B08A4A]/40 px-4 py-2 text-xs text-[#5C4B41]"
              >
                Đóng
              </button>
              <button
                type="submit"
                disabled={busyAction === `reject-rma-${rejectingRma.id}`}
                className="rounded-full bg-[#8B2E2E] px-5 py-2 text-xs font-medium uppercase tracking-[0.14em] text-white disabled:opacity-50"
              >
                {busyAction === `reject-rma-${rejectingRma.id}`
                  ? 'Đang xử lý...'
                  : 'Xác nhận từ chối RMA'}
              </button>
            </div>
          </form>
        </div>
      ) : null}

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

      {/* PRINT-READY OVERLAY: Phiếu giao hàng kiêm Hóa đơn tóm tắt */}
      {invoiceOrder ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Phiếu giao hàng kiêm Hóa đơn tóm tắt"
          data-testid="order-invoice-modal"
          className="fixed inset-0 z-50 flex items-center justify-center bg-[#1C1410]/75 p-4 backdrop-blur-sm"
        >
          <style>{`
            @media print {
              body * { visibility: hidden !important; }
              #atelier-printable-invoice, #atelier-printable-invoice * { visibility: visible !important; }
              #atelier-printable-invoice {
                position: fixed !important;
                inset: 0 !important;
                width: 100% !important;
                max-width: none !important;
                max-height: none !important;
                overflow: visible !important;
                border: none !important;
                border-radius: 0 !important;
                box-shadow: none !important;
                padding: 20px !important;
                background: #ffffff !important;
              }
              .atelier-no-print { display: none !important; }
            }
          `}</style>

          <div
            id="atelier-printable-invoice"
            className="max-h-[92vh] w-full max-w-3xl overflow-y-auto rounded-3xl border border-[#B08A4A]/50 bg-white p-7 text-[#1C1410] shadow-2xl"
          >
            {/* Screen-only Action Toolbar */}
            <div className="atelier-no-print mb-5 flex flex-wrap items-center justify-between gap-2 border-b border-[#B08A4A]/25 pb-4">
              <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-[#8A672C]">
                Bản xem trước In Ấn · Chuẩn A4 / A5
              </span>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => window.print()}
                  className="inline-flex items-center gap-1.5 rounded-full bg-[#1C1410] px-4 py-2 text-xs font-medium text-[#EBCF8F] hover:opacity-90"
                >
                  <PrinterIcon size={14} />
                  In phiếu / Lưu PDF
                </button>
                <button
                  type="button"
                  onClick={() => handleDownloadInvoiceHtml(invoiceOrder)}
                  className="rounded-full border border-[#1C1410] bg-[#FBF7EF] px-4 py-2 text-xs font-medium text-[#1C1410] hover:bg-[#F4EBDA]"
                >
                  ↓ Tải Hóa đơn HTML
                </button>
                <button
                  type="button"
                  onClick={() => setInvoiceOrder(null)}
                  className="rounded-full border border-[#B08A4A]/40 px-3.5 py-2 text-xs text-[#5C4B41]"
                >
                  Đóng
                </button>
              </div>
            </div>

            {/* Atelier Brand Header */}
            <div className="flex flex-wrap items-start justify-between gap-4 border-b-2 border-[#1C1410] pb-4">
              <div className="flex items-start gap-3">
                <div className="font-editorial flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-[#1C1410] text-xl font-bold text-[#EBCF8F]">
                  TV
                </div>
                <div>
                  <h3 className="font-editorial text-2xl font-semibold tracking-wider text-[#1C1410]">
                    TRYVIBE FASHION ATELIER
                  </h3>
                  <p className="text-[11px] text-[#5C4B41]">
                    Flagship Hà Nội: 28 Tràng Tiền, Hoàn Kiếm · Showroom TP.HCM:
                    112 Đồng Khởi, Q.1
                  </p>
                  <p className="font-mono text-[10.5px] text-[#7A6A5B]">
                    Hotline: 1900 6868 · support@tryvibeatelier.vn
                  </p>
                </div>
              </div>

              <div className="text-right">
                <p className="text-xs font-bold uppercase tracking-[0.14em] text-[#1C1410]">
                  PHIẾU GIAO HÀNG KIÊM HÓA ĐƠN
                </p>
                <p className="mt-1 font-mono text-base font-bold text-[#8A672C]">
                  {invoiceOrder.orderCode}
                </p>
                <p className="font-mono text-[10.5px] text-[#7A6A5B]">
                  Ngày tạo: {formatDateTime(invoiceOrder.createdAt)}
                </p>
              </div>
            </div>

            {/* Recipient + Shipping + QR Reference */}
            <div className="mt-5 grid gap-4 md:grid-cols-[1.2fr_1fr_auto]">
              <div className="rounded-2xl border border-[#B08A4A]/30 bg-[#FBF7EF] p-4 text-xs">
                <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-[#8A672C]">
                  Người nhận hàng
                </p>
                <p className="mt-1.5 text-sm font-semibold text-[#1C1410]">
                  {invoiceOrder.shippingAddress?.recipientName}
                </p>
                <p className="mt-0.5 font-mono text-[11px] text-[#2B2019]">
                  SĐT: {invoiceOrder.shippingAddress?.phone}
                </p>
                <p className="mt-1 text-[11px] leading-relaxed text-[#5C4B41]">
                  {invoiceOrder.shippingAddress?.streetLine},{' '}
                  {invoiceOrder.shippingAddress?.wardName},{' '}
                  {invoiceOrder.shippingAddress?.districtName},{' '}
                  {invoiceOrder.shippingAddress?.provinceName}
                </p>
                {invoiceOrder.customerEmail ? (
                  <p className="mt-0.5 font-mono text-[10.5px] text-[#7A6A5B]">
                    {invoiceOrder.customerEmail}
                  </p>
                ) : null}
                {invoiceOrder.giftNote ? (
                  <p className="mt-2 rounded-lg bg-white px-2.5 py-1.5 italic text-[11px] text-[#8A672C]">
                    Thiệp tặng: &ldquo;{invoiceOrder.giftNote}&rdquo;
                  </p>
                ) : null}
              </div>

              <div className="rounded-2xl border border-[#B08A4A]/30 bg-[#FBF7EF] p-4 text-xs">
                <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-[#8A672C]">
                  Giao vận &amp; Thanh toán
                </p>
                <dl className="mt-1.5 space-y-1 text-[11px]">
                  <div className="flex justify-between gap-2">
                    <dt className="text-[#7A6A5B]">Đơn vị vận chuyển:</dt>
                    <dd className="font-semibold">
                      {invoiceOrder.shippingMethod}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt className="text-[#7A6A5B]">Mã vận đơn:</dt>
                    <dd className="font-mono font-semibold">
                      {invoiceOrder.shipment?.trackingCode ||
                        invoiceOrder.orderCode}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt className="text-[#7A6A5B]">Kho xuất:</dt>
                    <dd className="font-mono">
                      {invoiceOrder.shipment?.warehouseCode || 'CENTRAL_WH'}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt className="text-[#7A6A5B]">Thanh toán:</dt>
                    <dd className="font-mono font-semibold">
                      {invoiceOrder.paymentMethod}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-2 border-t border-[#B08A4A]/20 pt-1">
                    <dt className="font-semibold text-[#1C1410]">
                      Thu hộ COD:
                    </dt>
                    <dd className="font-mono font-bold text-[#8B2E2E]">
                      {invoiceOrder.paymentMethod === PaymentMethod.COD
                        ? FORMAT_VND(
                            invoiceOrder.shipment?.codCollectVnd ??
                              invoiceOrder.totalAmountVnd,
                          )
                        : '0₫ (Đã thanh toán)'}
                    </dd>
                  </div>
                </dl>
              </div>

              {/* QR / Shipping Reference Block */}
              <div className="flex flex-col items-center justify-center rounded-2xl border border-[#B08A4A]/30 bg-white p-3">
                <svg
                  width="92"
                  height="92"
                  viewBox="0 0 13 13"
                  aria-label="Mã QR tham chiếu vận đơn"
                  className="rounded border border-[#EBD9B4] p-1"
                >
                  {qrCells.map((filled, idx) =>
                    filled ? (
                      <rect
                        key={idx}
                        x={idx % 13}
                        y={Math.floor(idx / 13)}
                        width="1"
                        height="1"
                        fill="#1C1410"
                      />
                    ) : null,
                  )}
                </svg>
                <span className="mt-1.5 font-mono text-[9.5px] font-semibold tracking-wider text-[#5C4B41]">
                  {invoiceOrder.shipment?.trackingCode || invoiceOrder.orderCode}
                </span>
              </div>
            </div>

            {/* Line Items Table */}
            <div className="mt-5 overflow-hidden rounded-2xl border border-[#B08A4A]/30">
              <table className="w-full text-left text-xs">
                <thead className="bg-[#F4EBDA] text-[10px] uppercase tracking-[0.12em] text-[#5C4B41]">
                  <tr>
                    <th className="px-3 py-2.5 text-center">STT</th>
                    <th className="px-3 py-2.5">Sản phẩm &amp; Phân loại</th>
                    <th className="px-3 py-2.5 text-center">SL</th>
                    <th className="px-3 py-2.5 text-right">Đơn giá</th>
                    <th className="px-3 py-2.5 text-right">Giảm phân bổ</th>
                    <th className="px-3 py-2.5 text-right">Thành tiền</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#B08A4A]/20">
                  {invoiceOrder.items.map((item, idx) => (
                    <tr key={item.id}>
                      <td className="px-3 py-2.5 text-center font-mono text-[#7A6A5B]">
                        {idx + 1}
                      </td>
                      <td className="px-3 py-2.5">
                        <p className="font-semibold text-[#1C1410]">
                          {item.productName}
                        </p>
                        <p className="font-mono text-[10.5px] text-[#7A6A5B]">
                          {item.skuCode} · {item.colorName} · Size{' '}
                          {item.sizeCode}
                        </p>
                      </td>
                      <td className="px-3 py-2.5 text-center font-mono font-semibold">
                        {item.qty}
                      </td>
                      <td className="px-3 py-2.5 text-right font-mono">
                        {FORMAT_VND(item.unitPriceVnd)}
                      </td>
                      <td className="px-3 py-2.5 text-right font-mono text-[#7A6A5B]">
                        {item.allocatedDiscountVnd > 0
                          ? `-${FORMAT_VND(item.allocatedDiscountVnd)}`
                          : '—'}
                      </td>
                      <td className="px-3 py-2.5 text-right font-mono font-semibold text-[#1C1410]">
                        {FORMAT_VND(item.netRefundableUnitVnd * item.qty)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Totals Block */}
            <div className="mt-4 flex justify-end">
              <div className="w-full max-w-xs space-y-1.5 rounded-2xl border border-[#B08A4A]/30 bg-[#FBF7EF] p-4 text-xs">
                <div className="flex justify-between">
                  <span className="text-[#5C4B41]">Tạm tính:</span>
                  <span className="font-mono">
                    {FORMAT_VND(invoiceOrder.subtotalVnd)}
                  </span>
                </div>
                {invoiceOrder.comboDiscountVnd > 0 ? (
                  <div className="flex justify-between text-[#1E4B32]">
                    <span>Ưu đãi Combo Outfit:</span>
                    <span className="font-mono">
                      -{FORMAT_VND(invoiceOrder.comboDiscountVnd)}
                    </span>
                  </div>
                ) : null}
                {invoiceOrder.voucherDiscountVnd > 0 ? (
                  <div className="flex justify-between text-[#1E4B32]">
                    <span>
                      Voucher ({invoiceOrder.voucherCode || 'PROMO'}):
                    </span>
                    <span className="font-mono">
                      -{FORMAT_VND(invoiceOrder.voucherDiscountVnd)}
                    </span>
                  </div>
                ) : null}
                {invoiceOrder.packagingPriceVnd > 0 ? (
                  <div className="flex justify-between">
                    <span className="text-[#5C4B41]">Hộp quà Atelier:</span>
                    <span className="font-mono">
                      {FORMAT_VND(invoiceOrder.packagingPriceVnd)}
                    </span>
                  </div>
                ) : null}
                <div className="flex justify-between">
                  <span className="text-[#5C4B41]">Phí vận chuyển:</span>
                  <span className="font-mono">
                    {FORMAT_VND(invoiceOrder.shippingFeeVnd)}
                  </span>
                </div>
                <div className="flex justify-between border-t-2 border-[#1C1410] pt-2 text-sm font-bold text-[#1C1410]">
                  <span>TỔNG THANH TOÁN:</span>
                  <span className="font-mono">
                    {FORMAT_VND(invoiceOrder.totalAmountVnd)}
                  </span>
                </div>
              </div>
            </div>

            {/* Signature Block */}
            <div className="mt-8 grid grid-cols-2 gap-6 border-t border-dashed border-[#B08A4A]/45 pt-5 text-center text-xs">
              <div>
                <p className="font-semibold text-[#1C1410]">
                  Người lập phiếu / Đóng gói
                </p>
                <p className="text-[10.5px] text-[#7A6A5B]">
                  TryVibe Fashion Atelier
                </p>
                <div className="h-14" />
                <p className="text-[10.5px] text-[#7A6A5B]">
                  (Ký và ghi rõ họ tên)
                </p>
              </div>
              <div>
                <p className="font-semibold text-[#1C1410]">
                  Khách hàng / Người nhận hàng
                </p>
                <p className="text-[10.5px] text-[#7A6A5B]">
                  Xác nhận hàng nguyên tem mác &amp; đủ số lượng
                </p>
                <div className="h-14" />
                <p className="text-[10.5px] text-[#7A6A5B]">
                  (Ký và ghi rõ họ tên)
                </p>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
