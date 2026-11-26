'use client';

import Link from 'next/link';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
} from 'react';
import { io, type Socket } from 'socket.io-client';
import {
  FitFeedback,
  OrderStatus,
  PaymentMethod,
  RMA_CUSTOMER_NOTE_MAX_LEN,
  RmaExchangeMode,
  RmaReasonCode,
  RmaStatus,
  RmaType,
  type CustomerBodyProfileDto,
  type OrderDTO,
  type RmaRequestDTO,
  type SePayOrderStatusDTO,
  type VerifiedReviewDto,
} from '@atelier/contracts';
import { useScrollLock } from '@atelier/motion-kit';
import { GiftCardPreview } from '@/features/drawer-bag/GiftCardPreview';
import { apiFetch, getBffBaseUrl, getStoredSession } from '@/lib/api-client';
import { FORMAT_VND } from '@/lib/catalog-data';
import { getOrCreateGuestSessionId } from '@/lib/guest-session';

export interface OrderDetailClientProps {
  orderCode: string;
}

const TIMELINE_STEPS: Array<{ status: OrderStatus; label: string; desc: string }> = [
  {
    status: OrderStatus.PENDING_RESERVATION,
    label: 'Khởi tạo',
    desc: 'Giữ tồn kho tại xưởng',
  },
  {
    status: OrderStatus.AWAITING_PAYMENT,
    label: 'Chờ thanh toán',
    desc: 'Đang đối soát VietQR / Cổng thanh toán',
  },
  {
    status: OrderStatus.CONFIRMED,
    label: 'Đã xác nhận',
    desc: 'Thanh toán & giữ hàng thành công',
  },
  {
    status: OrderStatus.PACKING,
    label: 'Đang đóng gói',
    desc: 'Là hơi, gắn thiệp & chụp ảnh hộp quà',
  },
  {
    status: OrderStatus.SHIPPED,
    label: 'Đang giao vận',
    desc: 'Đã bàn giao cho đơn vị vận chuyển',
  },
  {
    status: OrderStatus.DELIVERED,
    label: 'Đã giao',
    desc: 'Mở khóa Đổi size 1 chạm & Đánh giá độ vừa',
  },
];

const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  [OrderStatus.PENDING_RESERVATION]: 'Đang giữ tồn kho',
  [OrderStatus.FAILED_OUT_OF_STOCK]: 'Hết hàng khi giữ kho',
  [OrderStatus.AWAITING_PAYMENT]: 'Chờ thanh toán',
  [OrderStatus.CONFIRMED]: 'Đã xác nhận',
  [OrderStatus.PACKING]: 'Đang đóng gói tại Atelier',
  [OrderStatus.SHIPPED]: 'Đang giao vận',
  [OrderStatus.DELIVERED]: 'Đã giao thành công',
  [OrderStatus.COMPLETED]: 'Hoàn tất',
  [OrderStatus.CANCELLED]: 'Đã hủy',
  [OrderStatus.LATE_PAYMENT_NEEDS_REFUND]: 'Thanh toán trễ — Chờ hoàn tiền tự động',
};

const RMA_STATUS_LABELS: Record<RmaStatus, string> = {
  [RmaStatus.RMA_REQUESTED]: 'Đã tiếp nhận yêu cầu',
  [RmaStatus.RMA_APPROVED]: 'Đã phê duyệt đổi/trả',
  [RmaStatus.RMA_REJECTED]: 'Từ chối yêu cầu',
  [RmaStatus.EXCHANGE_RESERVED]: 'Đã giữ sẵn size đổi',
  [RmaStatus.INSTANT_2WAY_DISPATCHED]: 'Đang giao đổi 2 chiều tại cửa',
  [RmaStatus.RETURN_IN_TRANSIT]: 'Hàng hoàn đang gửi về xưởng',
  [RmaStatus.QC_INSPECTING]: 'Xưởng đang kiểm định 3 tiêu chí QC',
  [RmaStatus.QC_PASSED]: 'Đạt chuẩn kiểm định QC',
  [RmaStatus.QC_FAILED]: 'Không đạt kiểm định QC',
  [RmaStatus.EXCHANGE_SHIPPED]: 'Đã giao mẫu đổi mới',
  [RmaStatus.REFUND_PROCESSING]: 'Đang xử lý hoàn tiền',
  [RmaStatus.RMA_COMPLETED]: 'Hoàn tất đổi / trả',
};

const RMA_REASON_OPTIONS: Array<{ value: RmaReasonCode; label: string }> = [
  { value: RmaReasonCode.SAI_KICH_CO_CHAT, label: 'Mặc hơi chật — Muốn đổi size lớn hơn' },
  { value: RmaReasonCode.SAI_KICH_CO_RONG, label: 'Mặc hơi rộng — Muốn đổi size nhỏ hơn' },
  { value: RmaReasonCode.SAI_MAU_MO_TA, label: 'Màu sắc thực tế khác kỳ vọng' },
  { value: RmaReasonCode.LOI_SAN_XUAT, label: 'Lỗi đường may / khuy / bề mặt vải' },
  { value: RmaReasonCode.KHAC, label: 'Lý do khác' },
];

const MAX_RMA_EVIDENCE_PHOTOS = 3;
const MAX_RMA_EVIDENCE_BYTES = 5 * 1024 * 1024;
const ALLOWED_RMA_IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);

const CANCEL_REASON_OPTIONS = [
  'Đổi ý — Muốn chọn lại kích cỡ hoặc thiết kế khác',
  'Cập nhật lại địa chỉ nhận hàng hoặc thông tin liên hệ',
  'Muốn thay đổi phương thức thanh toán',
  'Không còn nhu cầu đặt hàng lúc này',
] as const;

interface UploadedRmaEvidence {
  url: string;
  objectKey?: string;
  fileName: string;
}

interface RmaEvidenceUploadResponse {
  url?: string;
  publicUrl?: string;
  processedUrl?: string;
  originalUrl?: string;
  objectKey?: string;
}

async function hasValidClientImageMagicBytes(file: File): Promise<boolean> {
  try {
    const headerBuf = await file.slice(0, 12).arrayBuffer();
    const bytes = new Uint8Array(headerBuf);
    if (bytes.length < 12) return false;
    // JPEG: FF D8 FF
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
      return true;
    }
    // PNG: 89 50 4E 47 0D 0A 1A 0A
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
    // WebP: RIFF....WEBP
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

function getTimelineIndex(status: OrderStatus): number {
  if (status === OrderStatus.COMPLETED) return TIMELINE_STEPS.length - 1;
  const idx = TIMELINE_STEPS.findIndex((step) => step.status === status);
  return idx;
}

export function OrderDetailClient({ orderCode }: OrderDetailClientProps) {
  const socketRef = useRef<Socket | null>(null);

  const [loading, setLoading] = useState(true);
  const [order, setOrder] = useState<OrderDTO | null>(null);
  const [rmaList, setRmaList] = useState<RmaRequestDTO[]>([]);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [realtimeBanner, setRealtimeBanner] = useState<string | null>(null);
  const [packPhotoFallbackStage, setPackPhotoFallbackStage] = useState<0 | 1 | 2>(0);
  const [sepayQrStage, setSepayQrStage] = useState<0 | 1 | 2>(0);
  const [sepayCopiedKey, setSepayCopiedKey] = useState<string | null>(null);
  const [checkingSePay, setCheckingSePay] = useState(false);
  const [simulatingSePay, setSimulatingSePay] = useState(false);
  const [sepayNotice, setSepayNotice] = useState<{
    kind: 'info' | 'success' | 'warning';
    text: string;
  } | null>(null);

  // 1-Click RMA Modal state
  const [rmaModalOpen, setRmaModalOpen] = useState(false);
  const [rmaItemId, setRmaItemId] = useState('');
  const [rmaType, setRmaType] = useState<RmaType>(RmaType.SIZE_EXCHANGE);
  const [rmaExchangeMode, setRmaExchangeMode] = useState<RmaExchangeMode>(
    RmaExchangeMode.INSTANT_2WAY,
  );
  const [rmaReason, setRmaReason] = useState<RmaReasonCode>(
    RmaReasonCode.SAI_KICH_CO_CHAT,
  );
  const [rmaNote, setRmaNote] = useState('');
  const [rmaEvidencePhotos, setRmaEvidencePhotos] = useState<UploadedRmaEvidence[]>([]);
  const [uploadingEvidence, setUploadingEvidence] = useState(false);
  const [rmaUploadError, setRmaUploadError] = useState<string | null>(null);
  const rmaFileInputRef = useRef<HTMLInputElement | null>(null);
  const [submittingRma, setSubmittingRma] = useState(false);
  const [rmaFeedback, setRmaFeedback] = useState<string | null>(null);

  // Customer Self-Cancel state (enabled for AWAITING_PAYMENT | CONFIRMED)
  const [cancelConfirmOpen, setCancelConfirmOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState<string>(CANCEL_REASON_OPTIONS[0]);
  const [cancellingOrder, setCancellingOrder] = useState(false);
  const [cancelFeedback, setCancelFeedback] = useState<string | null>(null);
  const [cancelError, setCancelError] = useState<string | null>(null);

  // Verified Fit Review Form state (unlocked ONLY when status === DELIVERED)
  const [reviewItemId, setReviewItemId] = useState('');
  const [rating, setRating] = useState(5);
  const [fitFeedback, setFitFeedback] = useState<FitFeedback>(FitFeedback.TRUE_TO_SIZE);
  const [reviewerHeightCm, setReviewerHeightCm] = useState('163');
  const [reviewerWeightKg, setReviewerWeightKg] = useState('53');
  const [reviewComment, setReviewComment] = useState('');
  const [submittingReview, setSubmittingReview] = useState(false);
  const [reviewSuccess, setReviewSuccess] = useState<string | null>(null);
  const [reviewError, setReviewError] = useState<string | null>(null);

  useScrollLock(rmaModalOpen);

  const fetchOrderAndRma = useCallback(async () => {
    const orderRes = await apiFetch<OrderDTO>(
      `/bff/v1/storefront/orders/${encodeURIComponent(orderCode)}`,
      { skipAuthRefresh: true },
    );

    if (orderRes.ok && orderRes.data) {
      setOrder(orderRes.data);
      setPackPhotoFallbackStage(0);
      setSepayQrStage(0);
      setErrorMsg(null);
      const firstReturnable =
        orderRes.data.items.find((i) => i.isReturnable) ?? orderRes.data.items[0];
      if (firstReturnable) {
        setRmaItemId((prev) => prev || firstReturnable.id);
        setReviewItemId((prev) => prev || firstReturnable.id);
      }

      const rmaRes = await apiFetch<RmaRequestDTO[]>(
        `/bff/v1/storefront/orders/${encodeURIComponent(orderCode)}/rma`,
        { skipAuthRefresh: true },
      );
      if (rmaRes.ok && Array.isArray(rmaRes.data)) {
        setRmaList(rmaRes.data);
      }
    } else {
      setOrder(null);
      setRmaList([]);
      setErrorMsg(
        orderRes.error?.message || `Không tìm thấy đơn hàng #${orderCode}.`,
      );
    }

    setLoading(false);
  }, [orderCode]);

  useEffect(() => {
    void fetchOrderAndRma();
  }, [fetchOrderAndRma]);

  const handleCopySePayField = useCallback(async (key: string, value: string) => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setSepayCopiedKey(key);
      window.setTimeout(() => {
        setSepayCopiedKey((prev) => (prev === key ? null : prev));
      }, 2000);
    } catch {
      // Ignore clipboard restrictions
    }
  }, []);

  const handleCheckSePayOrderStatus = useCallback(async () => {
    if (!order || checkingSePay) return;
    setCheckingSePay(true);
    setSepayNotice(null);

    const res = await apiFetch<SePayOrderStatusDTO>(
      `/bff/v1/storefront/payments/sepay/status/${encodeURIComponent(order.orderCode)}`,
      { skipAuthRefresh: true, timeoutMs: 12_000 },
    );

    setCheckingSePay(false);
    if (!res.ok || !res.data) {
      setSepayNotice({
        kind: 'warning',
        text:
          res.error?.message ||
          'Chưa thể kiểm tra trạng thái thanh toán SePay lúc này. Vui lòng thử lại sau giây lát.',
      });
      return;
    }

    if (res.data.paid) {
      setSepayNotice({
        kind: 'success',
        text:
          res.data.message ||
          'SePay đã xác nhận thanh toán thành công! Đang cập nhật trạng thái đơn hàng...',
      });
      await fetchOrderAndRma();
      return;
    }

    setSepayNotice({
      kind: 'info',
      text:
        res.data.message ||
        'Chưa ghi nhận chuyển khoản mới. Nếu bạn vừa chuyển, vui lòng đợi 5–15 giây rồi kiểm tra lại.',
    });
  }, [checkingSePay, fetchOrderAndRma, order]);

  const handleSimulateSePayOrder = useCallback(async () => {
    if (!order || simulatingSePay) return;
    setSimulatingSePay(true);
    setSepayNotice(null);

    const res = await apiFetch<Record<string, unknown>>(
      '/bff/v1/storefront/payments/sepay/simulate',
      {
        method: 'POST',
        skipAuthRefresh: true,
        body: JSON.stringify({
          orderId: order.id,
          orderCode: order.orderCode,
          amountVnd: order.totalAmountVnd,
        }),
      },
    );

    setSimulatingSePay(false);
    if (!res.ok) {
      setSepayNotice({
        kind: 'warning',
        text: res.error?.message || 'Không thể giả lập chuyển khoản SePay lúc này.',
      });
      return;
    }

    setSepayNotice({
      kind: 'success',
      text: `Đã giả lập chuyển khoản SePay thành công cho đơn #${order.orderCode}.`,
    });
    await fetchOrderAndRma();
  }, [fetchOrderAndRma, order, simulatingSePay]);

  // Pre-populate reviewer height/weight from CustomerBodyProfile if logged in
  useEffect(() => {
    const session = getStoredSession();
    if (!session?.accessToken) return;
    let cancelled = false;

    void apiFetch<CustomerBodyProfileDto>('/bff/v1/customers/me/body-profile').then(
      (res) => {
        if (cancelled || !res.ok || !res.data) return;
        setReviewerHeightCm(String(res.data.heightCm));
        setReviewerWeightKg(String(res.data.weightKg));
      },
    );

    return () => {
      cancelled = true;
    };
  }, []);

  // Realtime Socket.io `order:subscribe` for live status transitions (`order:paid`, `order:updated`)
  useEffect(() => {
    try {
      const session = getStoredSession();
      const guestSessionId = getOrCreateGuestSessionId();
      const explicitRealtimeUrl = process.env.NEXT_PUBLIC_REALTIME_URL?.trim();
      const realtimeSocketUrl = explicitRealtimeUrl
        ? `${explicitRealtimeUrl.replace(/\/+$/, '')}/realtime`
        : typeof window !== 'undefined' &&
            window.location.port === '3000' &&
            (window.location.hostname === '127.0.0.1' ||
              window.location.hostname === 'localhost')
          ? `${window.location.protocol}//${window.location.hostname}:4000/realtime`
          : `${getBffBaseUrl()}/realtime`;

      const socket = io(realtimeSocketUrl, {
        path: '/socket.io/',
        transports: ['websocket', 'polling'],
        withCredentials: true,
        auth: {
          ...(session?.accessToken ? { token: session.accessToken } : {}),
          guestSessionId,
        },
        reconnectionAttempts: 3,
        timeout: 5000,
      });
      socketRef.current = socket;

      socket.on('connect', () => {
        socket.emit('order:subscribe', { orderId: orderCode, orderCode });
      });

      socket.on('order:paid', () => {
        setRealtimeBanner('Đã nhận thanh toán VietQR thành công — Đơn hàng đã được xác nhận!');
        void fetchOrderAndRma();
      });

      socket.on('order:updated', (payload: { status?: OrderStatus }) => {
        if (payload?.status) {
          setRealtimeBanner(
            `Trạng thái đơn hàng vừa cập nhật: ${ORDER_STATUS_LABELS[payload.status] ?? payload.status}`,
          );
        }
        void fetchOrderAndRma();
      });
    } catch {
      // Realtime socket optional when offline
    }

    return () => {
      if (socketRef.current) {
        socketRef.current.disconnect();
        socketRef.current = null;
      }
    };
  }, [fetchOrderAndRma, orderCode]);

  // Escape closes RMA modal
  useEffect(() => {
    if (!rmaModalOpen) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setRmaModalOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [rmaModalOpen]);

  const isDelivered =
    order?.status === OrderStatus.DELIVERED || order?.status === OrderStatus.COMPLETED;

  const canCustomerCancel =
    order?.status === OrderStatus.AWAITING_PAYMENT ||
    order?.status === OrderStatus.CONFIRMED;

  const selectedReviewItem = useMemo(
    () => order?.items.find((i) => i.id === reviewItemId) ?? order?.items[0] ?? null,
    [order?.items, reviewItemId],
  );

  const handleSelectRmaEvidenceFiles = async (event: ChangeEvent<HTMLInputElement>) => {
    const selectedFiles = Array.from(event.target.files ?? []);
    event.target.value = '';
    if (selectedFiles.length === 0) return;

    setRmaUploadError(null);
    const remainingSlots = MAX_RMA_EVIDENCE_PHOTOS - rmaEvidencePhotos.length;
    if (remainingSlots <= 0) {
      setRmaUploadError(
        `Bạn đã tải đủ tối đa ${MAX_RMA_EVIDENCE_PHOTOS} ảnh minh chứng cho yêu cầu RMA.`,
      );
      return;
    }

    const filesToProcess = selectedFiles.slice(0, remainingSlots);
    if (selectedFiles.length > remainingSlots) {
      setRmaUploadError(
        `Tối đa ${MAX_RMA_EVIDENCE_PHOTOS} ảnh minh chứng — chỉ tải lên ${remainingSlots} ảnh đầu tiên.`,
      );
    }

    setUploadingEvidence(true);
    const newlyUploaded: UploadedRmaEvidence[] = [];

    for (const file of filesToProcess) {
      if (!ALLOWED_RMA_IMAGE_MIMES.has(file.type)) {
        setRmaUploadError(
          `Tệp "${file.name}" không đúng định dạng. Chỉ chấp nhận ảnh JPEG, PNG hoặc WebP.`,
        );
        continue;
      }
      if (file.size > MAX_RMA_EVIDENCE_BYTES) {
        setRmaUploadError(
          `Tệp "${file.name}" vượt quá dung lượng tối đa 5MB mỗi ảnh.`,
        );
        continue;
      }
      const validMagic = await hasValidClientImageMagicBytes(file);
      if (!validMagic) {
        setRmaUploadError(
          `Tệp "${file.name}" không đạt kiểm tra nội dung ảnh thực (JPEG/PNG/WebP).`,
        );
        continue;
      }

      const formData = new FormData();
      formData.append('file', file);
      formData.append('fileName', file.name);
      formData.append('mimeType', file.type);

      const uploadRes = await apiFetch<RmaEvidenceUploadResponse>(
        '/bff/v1/storefront/rma/evidence-upload',
        {
          method: 'POST',
          body: formData,
          timeoutMs: 25_000,
        },
      );

      const uploadedUrl =
        uploadRes.data?.url ||
        uploadRes.data?.publicUrl ||
        uploadRes.data?.processedUrl ||
        uploadRes.data?.originalUrl ||
        null;

      if (!uploadRes.ok || !uploadedUrl) {
        setRmaUploadError(
          uploadRes.error?.message ||
            `Không thể tải lên ảnh "${file.name}". Vui lòng thử lại.`,
        );
        continue;
      }

      newlyUploaded.push({
        url: uploadedUrl,
        objectKey: uploadRes.data?.objectKey,
        fileName: file.name,
      });
    }

    if (newlyUploaded.length > 0) {
      setRmaEvidencePhotos((prev) =>
        [...prev, ...newlyUploaded].slice(0, MAX_RMA_EVIDENCE_PHOTOS),
      );
    }
    setUploadingEvidence(false);
  };

  const handleRemoveRmaEvidence = (urlToRemove: string) => {
    setRmaEvidencePhotos((prev) => prev.filter((item) => item.url !== urlToRemove));
    setRmaUploadError(null);
  };

  const handleConfirmCancelOrder = async () => {
    if (!order || !canCustomerCancel) return;
    setCancellingOrder(true);
    setCancelError(null);
    setCancelFeedback(null);

    const hasSession = Boolean(getStoredSession()?.accessToken);
    const res = await apiFetch<OrderDTO>(
      `/bff/v1/storefront/orders/${encodeURIComponent(order.orderCode)}/cancel`,
      {
        method: 'POST',
        skipAuthRefresh: !hasSession,
        body: JSON.stringify({
          reason: cancelReason.trim() || 'Khách hàng chủ động hủy đơn hàng',
        }),
      },
    );

    setCancellingOrder(false);
    if (res.ok) {
      setCancelConfirmOpen(false);
      if (res.data && res.data.orderCode) {
        setOrder(res.data);
      }
      setCancelFeedback(
        `Đã hủy đơn hàng #${order.orderCode} thành công. Tồn kho giữ chỗ và mã ưu đãi (nếu có) đã được giải phóng.`,
      );
      await fetchOrderAndRma();
    } else {
      setCancelError(
        res.error?.message ||
          'Chưa thể hủy đơn hàng lúc này. Vui lòng kiểm tra trạng thái đơn hoặc đăng nhập đúng tài khoản đặt hàng.',
      );
    }
  };

  const handleSubmitRma = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!order || !rmaItemId || uploadingEvidence) return;

    setSubmittingRma(true);
    setRmaFeedback(null);

    const safeNote = rmaNote.trim().slice(0, RMA_CUSTOMER_NOTE_MAX_LEN);
    const res = await apiFetch<RmaRequestDTO>(
      `/bff/v1/storefront/orders/${encodeURIComponent(order.orderCode)}/rma`,
      {
        method: 'POST',
        body: JSON.stringify({
          orderItemId: rmaItemId,
          qty: 1,
          type: rmaType,
          exchangeMode:
            rmaType === RmaType.RETURN_REFUND
              ? RmaExchangeMode.STANDARD_QC
              : rmaExchangeMode,
          reasonCode: rmaReason,
          customerNote: safeNote,
          evidencePhotoUrls: rmaEvidencePhotos.map((photo) => photo.url),
        }),
      },
    );

    setSubmittingRma(false);
    if (res.ok && res.data) {
      setRmaModalOpen(false);
      setRmaNote('');
      setRmaEvidencePhotos([]);
      setRmaUploadError(null);
      setRmaFeedback(`Đã tạo yêu cầu đổi/trả #${res.data.rmaCode} thành công.`);
      await fetchOrderAndRma();
    } else {
      setRmaFeedback(
        res.error?.message ||
          'Chưa thể tạo yêu cầu đổi/trả (vui lòng đăng nhập đúng tài khoản đặt hàng).',
      );
    }
  };

  const handleSubmitVerifiedReview = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!order || !selectedReviewItem) return;

    setSubmittingReview(true);
    setReviewSuccess(null);
    setReviewError(null);

    const res = await apiFetch<VerifiedReviewDto>('/bff/v1/storefront/reviews', {
      method: 'POST',
      body: JSON.stringify({
        productId: selectedReviewItem.productId,
        skuId: selectedReviewItem.skuId,
        orderId: order.id,
        orderItemId: selectedReviewItem.id,
        rating,
        fitFeedback,
        reviewerHeightCm: Number(reviewerHeightCm),
        reviewerWeightKg: Number(reviewerWeightKg),
        sizePurchased: selectedReviewItem.sizeCode,
        comment: reviewComment.trim(),
      }),
    });

    setSubmittingReview(false);
    if (res.ok) {
      setReviewComment('');
      setReviewSuccess(
        `Cảm ơn bạn đã gửi Đánh giá độ vừa cho ${selectedReviewItem.productName} (Size ${selectedReviewItem.sizeCode}). Dữ liệu thực tế này giúp hệ thống tư vấn size chuẩn xác hơn!`,
      );
    } else {
      setReviewError(
        res.error?.message ||
          'Vui lòng đăng nhập tài khoản đã mua đơn hàng này để gửi đánh giá xác thực.',
      );
    }
  };

  if (loading) {
    return (
      <div className="mx-auto max-w-6xl px-6 py-16 text-center text-sm text-[#7A6A5B]">
        Đang tải chi tiết đơn hàng #{orderCode}...
      </div>
    );
  }

  if (!order) {
    return (
      <div className="mx-auto max-w-xl px-6 py-20 text-center">
        <div className="rounded-[28px] border border-[#B08A4A]/35 bg-[#FBF7EF] p-10">
          <p className="eyebrow text-[#8A672C]">Theo dõi đơn hàng</p>
          <h1 className="mt-2 font-editorial text-4xl font-light text-[#1C1410]">
            Không tìm thấy đơn #{orderCode}
          </h1>
          <p className="mt-3 text-sm text-[#7A6A5B]">
            {errorMsg || 'Mã đơn hàng chưa tồn tại hoặc bạn cần đăng nhập đúng tài khoản.'}
          </p>
          <div className="mt-6 flex flex-wrap justify-center gap-3">
            <Link href="/tai-khoan" className="btn btn--gold !py-3">
              Về tài khoản của tôi
            </Link>
            <Link href="/bo-suu-tap" className="btn btn--line !py-3">
              Khám phá Bộ sưu tập
            </Link>
          </div>
        </div>
      </div>
    );
  }

  const activeTimelineIdx = getTimelineIndex(order.status);

  return (
    <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6 lg:px-10 lg:py-14">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-[#B08A4A]/25 pb-7">
        <div>
          <p className="eyebrow text-[#8A672C]">Theo dõi Đơn hàng Trực tuyến · Atelier</p>
          <h1 className="mt-1 font-editorial text-4xl font-light text-[#1C1410] sm:text-5xl">
            Đơn hàng #{order.orderCode}
          </h1>
          <p className="mt-1.5 text-xs text-[#7A6A5B]">
            Đặt lúc {new Date(order.createdAt).toLocaleString('vi-VN')} · Phương thức{' '}
            <strong>{order.paymentMethod}</strong> · Giao vận{' '}
            <strong>{order.shippingMethod}</strong>
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <span
            className={`rounded-full px-4 py-1.5 text-xs font-medium tracking-[0.14em] uppercase ${
              order.status === OrderStatus.DELIVERED || order.status === OrderStatus.COMPLETED
                ? 'bg-emerald-900 text-emerald-100'
                : order.status === OrderStatus.LATE_PAYMENT_NEEDS_REFUND ||
                    order.status === OrderStatus.CANCELLED ||
                    order.status === OrderStatus.FAILED_OUT_OF_STOCK
                  ? 'bg-amber-900 text-amber-100'
                  : 'bg-[#1C1410] text-[#EBCF8F]'
            }`}
          >
            {ORDER_STATUS_LABELS[order.status] ?? order.status}
          </span>

          {canCustomerCancel ? (
            <button
              type="button"
              data-testid="customer-cancel-order-btn"
              onClick={() => {
                setCancelError(null);
                setCancelConfirmOpen((prev) => !prev);
              }}
              className="rounded-full border border-[#8B2E2E]/55 bg-white px-5 py-2 text-xs font-medium uppercase tracking-[0.14em] text-[#8B2E2E] transition-colors hover:bg-[#8B2E2E] hover:text-white"
            >
              Hủy đơn hàng
            </button>
          ) : null}

          {isDelivered ? (
            <button
              type="button"
              onClick={() => {
                setRmaFeedback(null);
                setRmaUploadError(null);
                setRmaModalOpen(true);
              }}
              className="btn btn--gold !px-5 !py-2.5 !text-xs"
            >
              Đổi size / Trả hàng 1 chạm
            </button>
          ) : null}
        </div>
      </div>

      {/* Inline Customer Self-Cancel Confirmation Panel */}
      {canCustomerCancel && cancelConfirmOpen ? (
        <section
          data-testid="customer-cancel-confirm-panel"
          className="mt-6 rounded-2xl border border-[#8B2E2E]/35 bg-[#FFF5F4] p-5 text-xs text-[#2B2019]"
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="font-medium uppercase tracking-[0.14em] text-[#8B2E2E]">
                Xác nhận hủy đơn hàng #{order.orderCode}
              </p>
              <p className="mt-1 text-[#5C4B41]">
                Hệ thống sẽ lập tức giải phóng tồn kho đang giữ và mở lại lượt sử dụng mã
                ưu đãi (nếu có). Thao tác này không thể hoàn tác.
              </p>
            </div>
          </div>

          <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
            <label className="block">
              <span className="text-[11px] text-[#5C4B41]">Lý do hủy đơn</span>
              <select
                value={cancelReason}
                onChange={(e) => setCancelReason(e.target.value)}
                className="mt-1 w-full rounded-xl border border-[#8B2E2E]/30 bg-white px-3 py-2 text-xs text-[#1C1410]"
              >
                {CANCEL_REASON_OPTIONS.map((opt) => (
                  <option key={opt} value={opt}>
                    {opt}
                  </option>
                ))}
              </select>
            </label>

            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => setCancelConfirmOpen(false)}
                disabled={cancellingOrder}
                className="rounded-full border border-[#8A672C]/40 bg-white px-4 py-2 text-xs uppercase tracking-[0.12em] text-[#5C431C]"
              >
                Giữ lại đơn
              </button>
              <button
                type="button"
                data-testid="customer-cancel-confirm-btn"
                disabled={cancellingOrder}
                onClick={() => void handleConfirmCancelOrder()}
                className="rounded-full bg-[#8B2E2E] px-5 py-2 text-xs font-medium uppercase tracking-[0.14em] text-white transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {cancellingOrder ? 'Đang hủy đơn...' : 'Xác nhận hủy đơn'}
              </button>
            </div>
          </div>

          {cancelError ? (
            <p
              role="alert"
              className="mt-3 rounded-xl border border-red-300 bg-white px-3.5 py-2 text-xs text-[#8B2E2E]"
            >
              {cancelError}
            </p>
          ) : null}
        </section>
      ) : null}

      {cancelFeedback ? (
        <div
          role="status"
          data-testid="customer-cancel-feedback"
          className="mt-6 rounded-2xl border border-[#B08A4A]/50 bg-[#F4EBDA] px-5 py-3 text-xs font-medium text-[#1C1410]"
        >
          {cancelFeedback}
        </div>
      ) : null}

      {realtimeBanner ? (
        <div
          role="status"
          className="mt-6 rounded-2xl border border-[#B08A4A]/50 bg-[#F4EBDA] px-5 py-3 text-xs font-medium text-[#1C1410]"
        >
          {realtimeBanner}
        </div>
      ) : null}

      {rmaFeedback ? (
        <div
          role="status"
          className="mt-5 rounded-2xl border border-[#B08A4A]/45 bg-white px-5 py-3 text-xs text-[#1C1410]"
        >
          {rmaFeedback}
        </div>
      ) : null}

      {/* Special Terminal Status Alert */}
      {order.status === OrderStatus.LATE_PAYMENT_NEEDS_REFUND ||
      order.status === OrderStatus.CANCELLED ||
      order.status === OrderStatus.FAILED_OUT_OF_STOCK ? (
        <div className="mt-6 rounded-2xl border border-amber-400/70 bg-amber-50 p-5 text-sm text-amber-950">
          <p className="font-medium">{ORDER_STATUS_LABELS[order.status]}</p>
          <p className="mt-1 text-xs">
            {order.cancelReason ||
              'Hệ thống đã ghi nhận trạng thái ngoại lệ và sẽ hỗ trợ hoàn tiền tự động nếu giao dịch phát sinh sau thời hạn giữ kho 15 phút.'}
          </p>
        </div>
      ) : null}

      {/* Compact SePay VietQR Payment Card while awaiting payment */}
      {order.status === OrderStatus.AWAITING_PAYMENT &&
      order.paymentMethod === PaymentMethod.VIETQR &&
      order.paymentIntent ? (
        (() => {
          const intent = order.paymentIntent;
          const isSePayLive = intent.providerMode === 'LIVE';
          const bankInfo = intent.bankInfo ?? null;
          const bankLabel = bankInfo?.bankName
            ? bankInfo.bankCode &&
              !bankInfo.bankName.toUpperCase().includes(bankInfo.bankCode.toUpperCase())
              ? `${bankInfo.bankName} (${bankInfo.bankCode})`
              : bankInfo.bankName
            : bankInfo?.bankCode || 'MBBank (MB)';
          const transferContent = intent.transferContent?.trim() || order.orderCode;
          const primaryQr = intent.sepayQrImageUrl || intent.vietQrImageUrl || null;
          const fallbackQr =
            intent.sepayQrImageUrl &&
            intent.vietQrImageUrl &&
            intent.vietQrImageUrl !== intent.sepayQrImageUrl
              ? intent.vietQrImageUrl
              : null;
          const activeQr =
            sepayQrStage === 0 ? primaryQr : sepayQrStage === 1 ? fallbackQr : null;
          const canDevSimulate =
            process.env.NEXT_PUBLIC_PAYMENT_MODE !== 'live' && !isSePayLive;

          return (
            <section
              data-testid="order-sepay-payment-card"
              className="mt-6 rounded-[28px] border border-[#B08A4A]/45 bg-[#FBF7EF] p-6 shadow-md"
            >
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#B08A4A]/20 pb-4">
                <div>
                  <p className="eyebrow text-[#8A672C]">
                    Chờ thanh toán · VietQR SePay Tự động
                  </p>
                  <h2 className="mt-1 font-editorial text-2xl font-light text-[#1C1410]">
                    Quét mã QR hoặc chuyển khoản để xác nhận đơn #{order.orderCode}
                  </h2>
                </div>
                <span
                  className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] ${
                    isSePayLive
                      ? 'border-emerald-700/35 bg-emerald-50 text-emerald-900'
                      : 'border-[#B08A4A]/50 bg-[#F4EBDA] text-[#5C431C]'
                  }`}
                >
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${
                      isSePayLive ? 'bg-emerald-600' : 'bg-[#B08A4A]'
                    }`}
                  />
                  {isSePayLive ? 'SePay Live Tự Động' : 'SePay · VietQR Sandbox'}
                </span>
              </div>

              <div className="mt-5 grid items-center gap-6 md:grid-cols-[200px_1fr]">
                <div className="mx-auto flex w-full max-w-[200px] flex-col items-center rounded-2xl border border-[#B08A4A]/30 bg-white p-3.5 shadow-xs">
                  {activeQr ? (
                    <img
                      src={activeQr}
                      alt={`Mã VietQR SePay đơn #${order.orderCode}`}
                      onError={() => {
                        setSepayQrStage((prev) =>
                          prev === 0 && fallbackQr ? 1 : 2,
                        );
                      }}
                      className="aspect-square w-full rounded-lg object-contain"
                    />
                  ) : (
                    <div className="flex aspect-square w-full flex-col items-center justify-center rounded-lg border border-dashed border-[#B08A4A]/45 bg-[#FBF7EF] p-3 text-center">
                      <span className="font-editorial text-lg text-[#8A672C]">
                        VietQR · SePay
                      </span>
                      <span className="mt-1 font-mono text-[10px] break-all text-[#2B2019]">
                        {transferContent}
                      </span>
                    </div>
                  )}
                </div>

                <div className="space-y-3 text-xs">
                  <div className="grid gap-2.5 rounded-2xl border border-[#B08A4A]/25 bg-white p-4 sm:grid-cols-2">
                    <div>
                      <span className="text-[10px] uppercase tracking-[0.14em] text-[#7A6A5B]">
                        Ngân hàng
                      </span>
                      <p className="mt-0.5 font-medium text-[#1C1410]">{bankLabel}</p>
                    </div>
                    {bankInfo?.accountNo ? (
                      <div>
                        <span className="text-[10px] uppercase tracking-[0.14em] text-[#7A6A5B]">
                          Số tài khoản
                        </span>
                        <div className="mt-0.5 flex items-center gap-2">
                          <code className="font-mono font-semibold text-[#1C1410]">
                            {bankInfo.accountNo}
                          </code>
                          <button
                            type="button"
                            onClick={() =>
                              void handleCopySePayField('accountNo', bankInfo.accountNo)
                            }
                            className="text-[10px] font-medium text-[#8A672C] underline"
                          >
                            {sepayCopiedKey === 'accountNo' ? 'Đã chép' : 'Chép'}
                          </button>
                        </div>
                      </div>
                    ) : null}
                    {bankInfo?.accountName ? (
                      <div>
                        <span className="text-[10px] uppercase tracking-[0.14em] text-[#7A6A5B]">
                          Chủ tài khoản
                        </span>
                        <p className="mt-0.5 font-medium uppercase text-[#1C1410]">
                          {bankInfo.accountName}
                        </p>
                      </div>
                    ) : null}
                    <div>
                      <span className="text-[10px] uppercase tracking-[0.14em] text-[#7A6A5B]">
                        Số tiền cần chuyển
                      </span>
                      <p className="mt-0.5 font-editorial text-xl font-medium text-[#1C1410]">
                        {FORMAT_VND(order.totalAmountVnd)}
                      </p>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[#B08A4A]/40 bg-[#F4EBDA]/80 px-3.5 py-2.5">
                    <div>
                      <span className="block text-[10px] font-semibold uppercase tracking-[0.14em] text-[#8A672C]">
                        Nội dung chuyển khoản (giữ chính xác)
                      </span>
                      <code className="mt-0.5 inline-block rounded bg-white px-2 py-0.5 font-mono text-xs font-semibold text-[#1C1410]">
                        {transferContent}
                      </code>
                    </div>
                    <button
                      type="button"
                      onClick={() =>
                        void handleCopySePayField('content', transferContent)
                      }
                      className="rounded-lg bg-[#1C1410] px-3 py-1.5 text-[10px] font-medium uppercase tracking-[0.14em] text-[#EBCF8F]"
                    >
                      {sepayCopiedKey === 'content' ? 'Đã chép' : 'Sao chép nội dung'}
                    </button>
                  </div>

                  {sepayNotice ? (
                    <p
                      role="status"
                      className={`rounded-xl border px-3 py-2 text-xs ${
                        sepayNotice.kind === 'success'
                          ? 'border-emerald-300 bg-emerald-50 text-emerald-950'
                          : sepayNotice.kind === 'warning'
                            ? 'border-red-300 bg-red-50 text-red-900'
                            : 'border-[#B08A4A]/40 bg-white text-[#3B2E25]'
                      }`}
                    >
                      {sepayNotice.text}
                    </p>
                  ) : null}

                  <div className="flex flex-wrap items-center gap-2.5 pt-1">
                    <button
                      type="button"
                      data-testid="order-sepay-check-btn"
                      disabled={checkingSePay}
                      onClick={() => void handleCheckSePayOrderStatus()}
                      className="btn btn--gold !px-4 !py-2 !text-xs disabled:opacity-50"
                    >
                      {checkingSePay
                        ? 'Đang kiểm tra SePay...'
                        : 'Kiểm tra thanh toán SePay'}
                    </button>

                    {canDevSimulate ? (
                      <button
                        type="button"
                        data-testid="order-sepay-simulate-btn"
                        disabled={simulatingSePay}
                        onClick={() => void handleSimulateSePayOrder()}
                        className="rounded-full border border-[#8A672C]/50 bg-[#F4EBDA] px-4 py-2 text-[11px] font-medium tracking-[0.1em] text-[#5C431C] transition-colors hover:bg-[#EBCF8F] disabled:opacity-50"
                      >
                        {simulatingSePay
                          ? 'Đang giả lập...'
                          : 'Giả lập chuyển khoản SePay (Dev)'}
                      </button>
                    ) : null}
                  </div>
                </div>
              </div>
            </section>
          );
        })()
      ) : null}

      {/* Editorial 6-Step Order Timeline */}
      <section className="mt-8 rounded-[28px] border border-[#B08A4A]/28 bg-white/95 p-6 shadow-sm">
        <p className="eyebrow text-[#8A672C]">Hành trình đơn hàng</p>
        <ol className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-6">
          {TIMELINE_STEPS.map((step, idx) => {
            const reached = activeTimelineIdx >= idx && activeTimelineIdx >= 0;
            const current = activeTimelineIdx === idx;
            return (
              <li
                key={step.status}
                className={`rounded-2xl border p-3.5 transition-all ${
                  current
                    ? 'border-[#1C1410] bg-[#1C1410] text-[#FBF7EF] shadow-md'
                    : reached
                      ? 'border-[#B08A4A]/55 bg-[#F4EBDA]/65 text-[#1C1410]'
                      : 'border-[#B08A4A]/20 bg-[#FBF7EF]/50 text-[#8D7E70]'
                }`}
              >
                <span className="font-mono text-[10px] tracking-[0.2em] uppercase opacity-75">
                  0{idx + 1}
                </span>
                <p className="mt-1 font-editorial text-lg leading-tight font-medium">
                  {step.label}
                </p>
                <p className="mt-1 text-[11px] opacity-80">{step.desc}</p>
              </li>
            );
          })}
        </ol>
      </section>

      <div className="mt-8 grid items-start gap-8 lg:grid-cols-[1.35fr_0.9fr]">
        {/* LEFT: ITEMIZED SNAPSHOT + PACK PHOTO + LIVE RMA LIST + VERIFIED FIT REVIEW */}
        <div className="space-y-8">
          {/* Pack Photo Showcase (when shipment.packPhotoUrl exists) */}
          {order.shipment?.packPhotoUrl ? (
            <section className="rounded-[28px] border border-[#B08A4A]/40 bg-gradient-to-br from-[#1C1410] to-[#2B1F18] p-6 text-[#FBF7EF] shadow-xl">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="eyebrow text-[#EBCF8F]">
                    Cam kết Thủ công · Trước khi xuất xưởng
                  </p>
                  <h2 className="mt-1 font-editorial text-3xl font-light text-[#FBF7EF]">
                    Ảnh chụp hộp trang phục trước khi niêm phong
                  </h2>
                </div>
                <span className="rounded-full border border-[#EBCF8F]/45 px-3 py-1 font-mono text-[11px] text-[#EBCF8F]">
                  {order.shipment.trackingCode}
                </span>
              </div>

              <div className="mt-5 grid items-center gap-5 sm:grid-cols-[220px_1fr]">
                <div className="overflow-hidden rounded-2xl border border-[#EBCF8F]/35 bg-[#120C09]">
                  {packPhotoFallbackStage < 2 ? (
                    <img
                      src={
                        packPhotoFallbackStage === 0
                          ? order.shipment.packPhotoUrl
                          : '/packaging/hop-lua-co-dien.webp'
                      }
                      alt={`Ảnh chụp hộp trang phục đơn #${order.orderCode} trước khi niêm phong`}
                      onError={() => {
                        setPackPhotoFallbackStage((prev) =>
                          prev === 0 ? 1 : 2,
                        );
                      }}
                      className="aspect-[4/3] w-full object-cover"
                    />
                  ) : (
                    <div className="flex aspect-[4/3] w-full flex-col items-center justify-center gap-1.5 bg-[#1A120E] px-4 text-center text-[#EBCF8F]/80">
                      <span className="font-editorial text-lg tracking-widest">
                        T&amp;V
                      </span>
                      <span className="text-[10px] uppercase tracking-[0.16em] text-[#FBF7EF]/60">
                        Hộp niêm phong Atelier
                      </span>
                    </div>
                  )}
                </div>
                <div className="space-y-2 text-xs text-[#FBF7EF]/80">
                  <p>
                    Kho xuất: <strong className="text-[#EBCF8F]">{order.shipment.warehouseCode}</strong>
                  </p>
                  <p>
                    Đơn vị vận chuyển:{' '}
                    <strong className="text-[#EBCF8F]">{order.shipment.carrier}</strong>
                  </p>
                  <p>
                    Trạng thái kiện hàng:{' '}
                    <strong className="text-[#EBCF8F]">{order.shipment.status}</strong>
                  </p>
                  <p className="pt-1 text-[#FBF7EF]/65">
                    Mỗi thiết kế đều được là hơi, bọc giấy nến không axit và kiểm tra tem mác
                    nguyên vẹn trước khi bàn giao vận chuyển.
                  </p>
                </div>
              </div>
            </section>
          ) : null}

          {/* Itemized Snapshot with Prorated `allocatedDiscountVnd` */}
          <section className="rounded-[28px] border border-[#B08A4A]/28 bg-white/95 p-6 shadow-sm">
            <p className="eyebrow text-[#8A672C]">
              Chi tiết thiết kế · {order.items.length} dòng sản phẩm
            </p>
            <ul className="mt-4 divide-y divide-[#B08A4A]/20">
              {order.items.map((item) => (
                <li key={item.id} className="flex items-start gap-4 py-4 first:pt-0 last:pb-0">
                  <div className="h-24 w-16 shrink-0 overflow-hidden rounded-xl border border-[#B08A4A]/25 bg-[#F8F4EC] p-1">
                    {item.imageUrl ? (
                      <img
                        src={item.imageUrl}
                        alt={item.productName}
                        className="h-full w-full object-contain"
                      />
                    ) : (
                      <div className="flex h-full items-center justify-center font-editorial text-xs text-[#8A672C]">
                        T&amp;V
                      </div>
                    )}
                  </div>

                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <h3 className="font-editorial text-2xl leading-tight text-[#1C1410]">
                          {item.productName}
                        </h3>
                        <p className="mt-0.5 text-xs text-[#6B5B4C]">
                          {item.colorName} · Size {item.sizeCode} · SKU{' '}
                          <code className="font-mono text-[11px]">{item.skuCode}</code> · SL{' '}
                          {item.qty}
                        </p>
                      </div>
                      <div className="text-right">
                        <p className="font-editorial text-xl text-[#1C1410]">
                          {FORMAT_VND(item.unitPriceVnd * item.qty)}
                        </p>
                        {item.allocatedDiscountVnd > 0 ? (
                          <p className="text-[11px] font-medium text-emerald-800">
                            Phân bổ giảm giá: −{FORMAT_VND(item.allocatedDiscountVnd)}
                          </p>
                        ) : null}
                      </div>
                    </div>

                    <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px]">
                      <span className="rounded-full border border-[#B08A4A]/35 bg-[#FBF7EF] px-2.5 py-0.5 text-[#5C431C]">
                        Giá trị hoàn trả thực: {FORMAT_VND(item.netRefundableUnitVnd)}/chiếc
                      </span>
                      {!item.isReturnable ? (
                        <span className="rounded-full bg-amber-100 px-2.5 py-0.5 text-amber-900">
                          Không áp dụng đổi/trả
                        </span>
                      ) : null}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </section>

          {/* Live RMA Statuses Section */}
          {rmaList.length > 0 ? (
            <section className="rounded-[28px] border border-[#B08A4A]/35 bg-[#F4EBDA]/55 p-6">
              <p className="eyebrow text-[#8A672C]">
                Yêu cầu Đổi size / Hoàn trả ({rmaList.length})
              </p>
              <ul className="mt-4 space-y-3">
                {rmaList.map((rma) => (
                  <li
                    key={rma.id}
                    className="rounded-2xl border border-[#B08A4A]/30 bg-white p-4 text-xs"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <span className="font-mono font-semibold text-[#1C1410]">
                          #{rma.rmaCode}
                        </span>
                        <span className="mx-2 text-[#B08A4A]">·</span>
                        <span className="uppercase tracking-[0.12em] text-[#8A672C]">
                          {rma.type}
                        </span>
                        <span className="ml-2 rounded-full border border-[#B08A4A]/40 bg-[#FBF7EF] px-2 py-0.5 text-[10px]">
                          {rma.exchangeMode === RmaExchangeMode.INSTANT_2WAY
                            ? 'Đổi nhanh 2 chiều tại cửa'
                            : 'Tiêu chuẩn QC tại xưởng'}
                        </span>
                      </div>
                      <span className="rounded-full bg-[#1C1410] px-3 py-1 text-[10px] font-medium uppercase tracking-[0.12em] text-[#EBCF8F]">
                        {RMA_STATUS_LABELS[rma.status] ?? rma.status}
                      </span>
                    </div>
                    {rma.customerNote ? (
                      <p className="mt-2 text-[#5C4B41]">Ghi chú: “{rma.customerNote}”</p>
                    ) : null}
                    {Array.isArray(rma.evidencePhotoUrls) &&
                    rma.evidencePhotoUrls.length > 0 ? (
                      <div className="mt-2.5 flex flex-wrap gap-2">
                        {rma.evidencePhotoUrls.map((photoUrl, photoIdx) => (
                          <a
                            key={`${rma.id}-ev-${photoIdx}`}
                            href={photoUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="block h-14 w-14 overflow-hidden rounded-lg border border-[#B08A4A]/35 bg-[#FBF7EF]"
                          >
                            <img
                              src={photoUrl}
                              alt={`Ảnh minh chứng RMA #${rma.rmaCode} (${photoIdx + 1})`}
                              className="aspect-square h-full w-full object-cover"
                            />
                          </a>
                        ))}
                      </div>
                    ) : null}
                    {rma.refundAmountVnd != null && rma.refundAmountVnd > 0 ? (
                      <p className="mt-1.5 font-medium text-emerald-800">
                        Số tiền hoàn theo phân bổ thực tế: {FORMAT_VND(rma.refundAmountVnd)}
                      </p>
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {/* Verified Fit Review Form (Unlocked ONLY when DELIVERED / COMPLETED) */}
          {isDelivered ? (
            <section className="rounded-[28px] border border-[#B08A4A]/35 bg-[#FBF7EF] p-6 shadow-sm">
              <p className="eyebrow text-[#8A672C]">
                Đánh giá Độ vừa Xác thực · Verified Fit Review
              </p>
              <h2 className="mt-1 font-editorial text-3xl font-light text-[#1C1410]">
                Chia sẻ trải nghiệm phom dáng của bạn
              </h2>
              <p className="mt-1.5 text-xs text-[#6B5B4C]">
                Phản hồi từ đơn hàng đã giao thành công giúp cộng đồng và Cố vấn Size AI
                hiệu chỉnh chuẩn xác hơn.
              </p>

              <form onSubmit={handleSubmitVerifiedReview} className="mt-5 space-y-4">
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="text-xs sm:col-span-2">
                    <span className="text-[#5C4B41]">Thiết kế đã mua</span>
                    <select
                      value={reviewItemId}
                      onChange={(e) => setReviewItemId(e.target.value)}
                      className="mt-1 w-full rounded-xl border border-[#B08A4A]/35 bg-white px-3 py-2 text-sm text-[#1C1410]"
                    >
                      {order.items.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.productName} ({item.colorName} · Size {item.sizeCode})
                        </option>
                      ))}
                    </select>
                  </label>

                  <div className="text-xs">
                    <span className="block text-[#5C4B41]">Đánh giá sao</span>
                    <div className="mt-1.5 flex gap-1.5">
                      {[1, 2, 3, 4, 5].map((star) => (
                        <button
                          key={star}
                          type="button"
                          onClick={() => setRating(star)}
                          className={`flex h-9 w-9 items-center justify-center rounded-full border text-sm transition-colors ${
                            star <= rating
                              ? 'border-[#1C1410] bg-[#1C1410] text-[#EBCF8F]'
                              : 'border-[#B08A4A]/35 bg-white text-[#8A672C]'
                          }`}
                        >
                          ★
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="text-xs">
                    <span className="block text-[#5C4B41]">Cảm nhận độ vừa</span>
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {[
                        { value: FitFeedback.RUNS_SMALL, label: 'Hơi chật' },
                        { value: FitFeedback.TRUE_TO_SIZE, label: 'Chuẩn size' },
                        { value: FitFeedback.RUNS_LARGE, label: 'Hơi rộng' },
                      ].map((opt) => (
                        <button
                          key={opt.value}
                          type="button"
                          onClick={() => setFitFeedback(opt.value)}
                          className={`rounded-full border px-3 py-1.5 text-xs transition-colors ${
                            fitFeedback === opt.value
                              ? 'border-[#1C1410] bg-[#1C1410] text-[#EBCF8F]'
                              : 'border-[#B08A4A]/35 bg-white text-[#2B2019]'
                          }`}
                        >
                          {opt.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  <label className="text-xs">
                    <span className="text-[#5C4B41]">Chiều cao của bạn (cm)</span>
                    <input
                      type="number"
                      required
                      min={120}
                      max={230}
                      value={reviewerHeightCm}
                      onChange={(e) => setReviewerHeightCm(e.target.value)}
                      className="mt-1 w-full rounded-xl border border-[#B08A4A]/35 bg-white px-3 py-2 font-mono text-sm"
                    />
                  </label>

                  <label className="text-xs">
                    <span className="text-[#5C4B41]">Cân nặng của bạn (kg)</span>
                    <input
                      type="number"
                      required
                      min={25}
                      max={200}
                      value={reviewerWeightKg}
                      onChange={(e) => setReviewerWeightKg(e.target.value)}
                      className="mt-1 w-full rounded-xl border border-[#B08A4A]/35 bg-white px-3 py-2 font-mono text-sm"
                    />
                  </label>
                </div>

                <label className="block text-xs">
                  <span className="text-[#5C4B41]">Nhận xét chất liệu &amp; phom dáng</span>
                  <textarea
                    required
                    rows={3}
                    maxLength={1000}
                    value={reviewComment}
                    onChange={(e) => setReviewComment(e.target.value)}
                    placeholder="Ví dụ: Vải linen thoáng nhẹ, đường vai đứng phom; mình 1m63 53kg mặc size M vừa thoải mái."
                    className="mt-1 w-full rounded-xl border border-[#B08A4A]/35 bg-white px-3.5 py-2.5 text-sm text-[#1C1410] outline-none focus:border-[#8A672C]"
                  />
                </label>

                {reviewSuccess ? (
                  <p className="rounded-xl border border-emerald-300 bg-emerald-50 px-3.5 py-2.5 text-xs text-emerald-900">
                    {reviewSuccess}
                  </p>
                ) : null}
                {reviewError ? (
                  <p className="rounded-xl border border-red-300 bg-red-50 px-3.5 py-2.5 text-xs text-red-900">
                    {reviewError}
                  </p>
                ) : null}

                <button
                  type="submit"
                  disabled={submittingReview}
                  className="btn btn--gold !py-3 disabled:opacity-50"
                >
                  {submittingReview ? 'Đang gửi đánh giá...' : 'Gửi Đánh giá Xác thực'}
                </button>
              </form>
            </section>
          ) : null}
        </div>

        {/* RIGHT: PAYMENT BREAKDOWN + ADDRESS + GIFT CARD */}
        <aside className="space-y-6">
          <div className="rounded-[28px] border border-[#B08A4A]/30 bg-[#F4EBDA]/65 p-6">
            <p className="eyebrow text-[#8A672C]">Tổng kết thanh toán</p>
            <div className="mt-4 space-y-2 text-xs text-[#5C4B41]">
              <div className="flex justify-between">
                <span>Tạm tính</span>
                <span>{FORMAT_VND(order.subtotalVnd)}</span>
              </div>
              {order.comboDiscountVnd > 0 ? (
                <div className="flex justify-between font-medium text-[#8A672C]">
                  <span>Ưu đãi Combo Set</span>
                  <span>−{FORMAT_VND(order.comboDiscountVnd)}</span>
                </div>
              ) : null}
              {order.voucherDiscountVnd > 0 ? (
                <div className="flex justify-between font-medium text-emerald-800">
                  <span>Mã ưu đãi ({order.voucherCode})</span>
                  <span>−{FORMAT_VND(order.voucherDiscountVnd)}</span>
                </div>
              ) : null}
              <div className="flex justify-between">
                <span>Đóng gói Signature</span>
                <span>
                  {order.packagingPriceVnd > 0
                    ? `+${FORMAT_VND(order.packagingPriceVnd)}`
                    : 'Miễn phí'}
                </span>
              </div>
              <div className="flex justify-between">
                <span>Phí giao vận</span>
                <span>
                  {order.shippingFeeVnd > 0
                    ? `+${FORMAT_VND(order.shippingFeeVnd)}`
                    : 'Miễn phí'}
                </span>
              </div>
            </div>

            <div className="mt-4 flex items-baseline justify-between border-t border-[#B08A4A]/25 pt-4">
              <span className="text-[11px] uppercase tracking-[0.2em] text-[#6B5B4C]">
                Tổng cộng
              </span>
              <b className="font-editorial text-3xl text-[#1C1410]">
                {FORMAT_VND(order.totalAmountVnd)}
              </b>
            </div>
          </div>

          <div className="rounded-[24px] border border-[#B08A4A]/25 bg-white p-5 text-xs">
            <p className="eyebrow text-[#8A672C]">Thông tin giao nhận</p>
            <p className="mt-2 font-medium text-[#1C1410]">
              {order.shippingAddress.recipientName} · {order.shippingAddress.phone}
            </p>
            <p className="mt-1 text-[#6B5B4C]">
              {order.shippingAddress.streetLine}, {order.shippingAddress.wardName},{' '}
              {order.shippingAddress.districtName}, {order.shippingAddress.provinceName}
            </p>
            {order.deliveryDate || order.deliverySlot ? (
              <p className="mt-2 rounded-xl bg-[#F4EBDA]/75 px-3 py-1.5 text-[#5C431C]">
                Hẹn giao 2 giờ: {order.deliveryDate} · {order.deliverySlot}
              </p>
            ) : null}
          </div>

          {order.giftNote ? (
            <div className="py-2">
              <p className="mb-3 text-center text-[10px] uppercase tracking-[0.22em] text-[#8A672C]">
                Thiệp viết tay đi kèm đơn hàng
              </p>
              <GiftCardPreview note={order.giftNote} visible inline />
            </div>
          ) : null}
        </aside>
      </div>

      {/* 1-CLICK SIZE EXCHANGE / RETURN RMA MODAL */}
      {rmaModalOpen ? (
        <div
          className="fixed inset-0 z-[92] flex items-center justify-center bg-[#140E0A]/75 p-4 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-labelledby="rmaModalTitle"
          onClick={(e) => {
            if (e.target === e.currentTarget) setRmaModalOpen(false);
          }}
        >
          <div
            className="max-h-[90vh] w-full max-w-xl overflow-y-auto rounded-[28px] border border-[#B08A4A]/45 bg-[#FBF7EF] p-6 text-[#2B2019] shadow-2xl sm:p-8"
            data-lenis-prevent=""
          >
            <div className="flex items-start justify-between gap-3 border-b border-[#B08A4A]/20 pb-4">
              <div>
                <p className="eyebrow text-[#8A672C]">Hậu mãi 1 chạm · Đổi Size / Hoàn Trả</p>
                <h2 id="rmaModalTitle" className="mt-1 font-editorial text-3xl text-[#1C1410]">
                  Tạo yêu cầu RMA đơn #{order.orderCode}
                </h2>
              </div>
              <button
                type="button"
                onClick={() => setRmaModalOpen(false)}
                aria-label="Đóng cửa sổ đổi trả"
                className="flex h-9 w-9 items-center justify-center rounded-full border border-[#8A672C]/35 text-lg text-[#8A672C]"
              >
                ×
              </button>
            </div>

            <form onSubmit={handleSubmitRma} className="mt-5 space-y-4">
              <label className="block text-xs">
                <span className="text-[#5C4B41]">Chọn thiết kế cần đổi / trả</span>
                <select
                  value={rmaItemId}
                  onChange={(e) => setRmaItemId(e.target.value)}
                  className="mt-1 w-full rounded-xl border border-[#B08A4A]/35 bg-white px-3 py-2 text-sm text-[#1C1410]"
                >
                  {order.items.map((item) => (
                    <option key={item.id} value={item.id} disabled={!item.isReturnable}>
                      {item.productName} — Size {item.sizeCode}{' '}
                      {!item.isReturnable ? '(Không hỗ trợ đổi/trả)' : ''}
                    </option>
                  ))}
                </select>
              </label>

              <div className="grid gap-3 sm:grid-cols-3">
                {[
                  { value: RmaType.SIZE_EXCHANGE, label: 'Đổi kích cỡ' },
                  { value: RmaType.COLOR_EXCHANGE, label: 'Đổi màu sắc' },
                  { value: RmaType.RETURN_REFUND, label: 'Trả & Hoàn tiền' },
                ].map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => setRmaType(opt.value)}
                    className={`rounded-xl border px-3 py-2.5 text-xs font-medium transition-colors ${
                      rmaType === opt.value
                        ? 'border-[#1C1410] bg-[#1C1410] text-[#EBCF8F]'
                        : 'border-[#B08A4A]/35 bg-white text-[#2B2019]'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>

              {rmaType !== RmaType.RETURN_REFUND ? (
                <div className="grid gap-2.5 sm:grid-cols-2">
                  <button
                    type="button"
                    onClick={() => setRmaExchangeMode(RmaExchangeMode.INSTANT_2WAY)}
                    className={`rounded-2xl border p-3 text-left text-xs transition-colors ${
                      rmaExchangeMode === RmaExchangeMode.INSTANT_2WAY
                        ? 'border-[#1C1410] bg-[#1C1410] text-[#FBF7EF]'
                        : 'border-[#B08A4A]/35 bg-white text-[#2B2019]'
                    }`}
                  >
                    <p className="font-medium">Đổi nhanh 2 chiều tại cửa</p>
                    <p className="mt-0.5 text-[11px] opacity-75">
                      INSTANT_2WAY · Shipper giao cỡ mới &amp; thu lại cỡ cũ cùng lúc
                    </p>
                  </button>

                  <button
                    type="button"
                    onClick={() => setRmaExchangeMode(RmaExchangeMode.STANDARD_QC)}
                    className={`rounded-2xl border p-3 text-left text-xs transition-colors ${
                      rmaExchangeMode === RmaExchangeMode.STANDARD_QC
                        ? 'border-[#1C1410] bg-[#1C1410] text-[#FBF7EF]'
                        : 'border-[#B08A4A]/35 bg-white text-[#2B2019]'
                    }`}
                  >
                    <p className="font-medium">Tiêu chuẩn QC tại xưởng</p>
                    <p className="mt-0.5 text-[11px] opacity-75">
                      STANDARD_QC · Kiểm định 3 tiêu chí tem/mác/vết bẩn trước khi đổi
                    </p>
                  </button>
                </div>
              ) : null}

              <label className="block text-xs">
                <span className="text-[#5C4B41]">Lý do đổi / trả</span>
                <select
                  value={rmaReason}
                  onChange={(e) => setRmaReason(e.target.value as RmaReasonCode)}
                  className="mt-1 w-full rounded-xl border border-[#B08A4A]/35 bg-white px-3 py-2 text-sm text-[#1C1410]"
                >
                  {RMA_REASON_OPTIONS.map((r) => (
                    <option key={r.value} value={r.value}>
                      {r.label}
                    </option>
                  ))}
                </select>
              </label>

              <label className="block text-xs">
                <div className="flex items-center justify-between text-[#5C4B41]">
                  <span>Ghi chú chi tiết cho xưởng</span>
                  <span className="font-mono text-[11px] text-[#8A672C]">
                    {rmaNote.length}/{RMA_CUSTOMER_NOTE_MAX_LEN}
                  </span>
                </div>
                <textarea
                  rows={3}
                  maxLength={RMA_CUSTOMER_NOTE_MAX_LEN}
                  value={rmaNote}
                  onChange={(e) =>
                    setRmaNote(e.target.value.slice(0, RMA_CUSTOMER_NOTE_MAX_LEN))
                  }
                  placeholder="Mô tả cỡ muốn đổi hoặc tình trạng sản phẩm (tối đa 300 ký tự)..."
                  className="mt-1 w-full resize-none rounded-xl border border-[#B08A4A]/35 bg-white px-3.5 py-2.5 text-sm text-[#1C1410] outline-none focus:border-[#8A672C]"
                />
              </label>

              {/* Multi-photo RMA Evidence Uploader (max 3 images, JPEG/PNG/WebP <= 5MB) */}
              <div className="space-y-2.5 rounded-2xl border border-[#B08A4A]/30 bg-white/80 p-4 text-xs">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="font-medium text-[#1C1410]">
                      Ảnh minh chứng sản phẩm (tùy chọn)
                    </p>
                    <p className="mt-0.5 text-[11px] text-[#7A6A5B]">
                      Tối đa {MAX_RMA_EVIDENCE_PHOTOS} ảnh · Định dạng JPEG, PNG hoặc WebP
                      (≤ 5MB/ảnh)
                    </p>
                  </div>
                  <span className="rounded-full bg-[#F4EBDA] px-2.5 py-0.5 font-mono text-[11px] text-[#8A672C]">
                    {rmaEvidencePhotos.length}/{MAX_RMA_EVIDENCE_PHOTOS}
                  </span>
                </div>

                <input
                  ref={rmaFileInputRef}
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  multiple
                  onChange={(e) => void handleSelectRmaEvidenceFiles(e)}
                  data-testid="rma-evidence-file-input"
                  className="sr-only"
                />

                <button
                  type="button"
                  disabled={
                    uploadingEvidence ||
                    rmaEvidencePhotos.length >= MAX_RMA_EVIDENCE_PHOTOS
                  }
                  onClick={() => rmaFileInputRef.current?.click()}
                  data-testid="rma-evidence-upload-btn"
                  className="w-full rounded-xl border border-dashed border-[#8A672C]/55 bg-[#FBF7EF] px-4 py-3 text-center text-xs font-medium text-[#5C431C] transition-colors hover:bg-[#F4EBDA] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {uploadingEvidence
                    ? 'Đang tải ảnh minh chứng lên hệ thống...'
                    : rmaEvidencePhotos.length >= MAX_RMA_EVIDENCE_PHOTOS
                      ? 'Đã đạt tối đa 3 ảnh minh chứng'
                      : '+ Chọn ảnh minh chứng từ thiết bị'}
                </button>

                {rmaUploadError ? (
                  <p
                    role="alert"
                    data-testid="rma-evidence-upload-error"
                    className="rounded-xl border border-[#8B2E2E]/35 bg-[#FFF5F4] px-3 py-2 text-[11px] text-[#8B2E2E]"
                  >
                    {rmaUploadError}
                  </p>
                ) : null}

                {rmaEvidencePhotos.length > 0 ? (
                  <div
                    data-testid="rma-evidence-thumbnails"
                    className="grid grid-cols-3 gap-2.5 pt-1"
                  >
                    {rmaEvidencePhotos.map((photo, idx) => (
                      <div
                        key={`${photo.url}-${idx}`}
                        className="group relative overflow-hidden rounded-xl border border-[#B08A4A]/35 bg-[#FBF7EF]"
                      >
                        <img
                          src={photo.url}
                          alt={`Ảnh minh chứng ${idx + 1}: ${photo.fileName}`}
                          className="aspect-square w-full object-cover"
                        />
                        <button
                          type="button"
                          onClick={() => handleRemoveRmaEvidence(photo.url)}
                          aria-label={`Xóa ảnh ${photo.fileName}`}
                          className="absolute top-1.5 right-1.5 flex h-6 w-6 items-center justify-center rounded-full bg-[#1C1410]/85 text-xs text-[#EBCF8F] transition-colors hover:bg-[#8B2E2E] hover:text-white"
                        >
                          ×
                        </button>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>

              <div className="flex justify-end gap-2.5 pt-2">
                <button
                  type="button"
                  onClick={() => setRmaModalOpen(false)}
                  className="rounded-full border border-[#8A672C]/40 px-5 py-2.5 text-xs uppercase tracking-[0.14em] text-[#5C431C]"
                >
                  Hủy
                </button>
                <button
                  type="submit"
                  disabled={submittingRma || uploadingEvidence}
                  className="btn btn--gold !px-6 !py-2.5 !text-xs disabled:opacity-50"
                >
                  {submittingRma
                    ? 'Đang gửi yêu cầu...'
                    : uploadingEvidence
                      ? 'Đang tải ảnh...'
                      : 'Gửi yêu cầu RMA'}
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </div>
  );
}
