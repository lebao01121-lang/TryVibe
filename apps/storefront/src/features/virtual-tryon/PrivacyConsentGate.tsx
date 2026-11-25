'use client';

export const TRYON_PRIVACY_GUARANTEE_TEXT =
  'Ảnh chụp chỉ lưu tạm trong phiên thử đồ của bạn và tự động xóa sau 15 phút. Ngay sau đếm ngược 3–2–1, camera sẽ tự động tắt lập tức.';

export interface PrivacyConsentGateProps {
  accepted: boolean;
  onAccept?: () => void;
  onChange?: (checked: boolean) => void;
  onSwitchToUpload?: () => void;
  onSwitchToPresets?: () => void;
  compact?: boolean;
}

/**
 * Quiet Luxury privacy consent gate & inline commitment banner for
 * Stage 1 Virtual Try-On (15-minute auto-purge + instant webcam hardware off).
 */
export function PrivacyConsentGate({
  accepted,
  onAccept,
  onChange,
  onSwitchToUpload,
  onSwitchToPresets,
  compact = true,
}: PrivacyConsentGateProps) {
  if (compact) {
    return (
      <div
        data-testid="tryon-privacy-consent-compact"
        className="rounded-xl border border-[#B08A4A]/30 bg-[#1C1410]/85 px-3.5 py-2.5 text-[11px] leading-relaxed text-[#FBF7EF]/82 backdrop-blur-md"
      >
        <p className="flex items-center gap-1.5 text-[10px] font-medium tracking-[0.18em] uppercase text-[#EBCF8F]">
          <span aria-hidden="true">🔒</span>
          <span>TỰ ĐỘNG XÓA ẢNH SAU 15 PHÚT</span>
        </p>
        <p className="mt-1 text-[#FBF7EF]/75">{TRYON_PRIVACY_GUARANTEE_TEXT}</p>
      </div>
    );
  }

  const handleConfirm = () => {
    onChange?.(true);
    onAccept?.();
  };

  return (
    <div
      data-testid="tryon-privacy-consent-gate"
      className="mx-auto flex w-full max-w-[360px] flex-col items-center rounded-2xl border border-[#B08A4A]/40 bg-[#1C1410]/92 px-5 py-6 text-center text-[#FBF7EF] shadow-[0_24px_64px_-20px_rgba(0,0,0,0.85)] backdrop-blur-xl"
    >
      <span className="inline-flex items-center gap-1.5 rounded-full border border-[#EBCF8F]/45 bg-[#2B2019]/90 px-3 py-1 text-[10px] font-medium tracking-[0.16em] uppercase text-[#EBCF8F]">
        <span aria-hidden="true">🔒</span>
        <span>TỰ ĐỘNG XÓA ẢNH SAU 15 PHÚT</span>
      </span>

      <h3 className="mt-3.5 font-editorial text-[24px] leading-tight font-medium text-[#FBF7EF]">
        Gương Camera Thông Minh
      </h3>

      <p className="mt-2 text-xs leading-relaxed text-[#FBF7EF]/75">
        Đứng cách camera khoảng 80cm–1m để gương tự động căn vai, lấy sáng chuẩn và chụp 1 khung hình sắc nét cho toàn bộ tủ đồ.
      </p>

      <ul className="mt-4 w-full space-y-2 rounded-xl border border-[#B08A4A]/22 bg-[#241A14]/75 px-3.5 py-3 text-left text-[11px] leading-relaxed text-[#FBF7EF]/82">
        <li className="flex items-start gap-2">
          <span className="mt-0.5 text-[#EBCF8F]" aria-hidden="true">
            ✦
          </span>
          <span>
            <strong className="font-medium text-[#F4EBDA]">Tắt đèn camera tức thì</strong>{' '}
            ngay khi kết thúc đếm ngược <span className="font-mono text-[#EBCF8F]">3–2–1</span>.
          </span>
        </li>
        <li className="flex items-start gap-2">
          <span className="mt-0.5 text-[#EBCF8F]" aria-hidden="true">
            ✦
          </span>
          <span>
            <strong className="font-medium text-[#F4EBDA]">Chụp 1 lần — Thử cả tủ đồ</strong>{' '}
            mà không cần bật lại camera khi đổi mẫu hay đổi màu vải.
          </span>
        </li>
        <li className="flex items-start gap-2">
          <span className="mt-0.5 text-[#EBCF8F]" aria-hidden="true">
            ✦
          </span>
          <span>
            <strong className="font-medium text-[#F4EBDA]">Riêng tư tuyệt đối</strong>: ảnh phiên tự hủy sau 15 phút hoặc ngay khi đóng phòng thử.
          </span>
        </li>
      </ul>

      <button
        type="button"
        data-testid="tryon-privacy-accept-btn"
        onClick={handleConfirm}
        className="mt-5 w-full cursor-pointer rounded-full bg-gradient-to-r from-[#EBCF8F] via-[#D2AC65] to-[#B08A4A] px-5 py-2.5 text-xs font-semibold tracking-[0.14em] uppercase text-[#1C1410] shadow-[0_12px_28px_-10px_rgba(235,207,143,0.6)] transition-all hover:brightness-105 active:translate-y-px"
      >
        {accepted ? 'Tiếp tục bật Gương Camera' : 'Đồng ý & Bật Gương Camera'}
      </button>

      {onSwitchToUpload || onSwitchToPresets ? (
        <div className="mt-3.5 flex flex-wrap items-center justify-center gap-x-3 gap-y-1.5 text-[11px] text-[#EBD9B4]/80">
          {onSwitchToUpload ? (
            <button
              type="button"
              data-testid="tryon-consent-fallback-upload"
              onClick={onSwitchToUpload}
              className="cursor-pointer underline decoration-[#B08A4A]/60 underline-offset-4 transition-colors hover:text-[#EBCF8F]"
            >
              Tải Ảnh Của Bạn
            </button>
          ) : null}
          {onSwitchToUpload && onSwitchToPresets ? (
            <span className="text-[#B08A4A]/45" aria-hidden="true">
              ·
            </span>
          ) : null}
          {onSwitchToPresets ? (
            <button
              type="button"
              data-testid="tryon-consent-fallback-presets"
              onClick={onSwitchToPresets}
              className="cursor-pointer underline decoration-[#B08A4A]/60 underline-offset-4 transition-colors hover:text-[#EBCF8F]"
            >
              Dáng Mẫu Thử Nhanh
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
