'use client';

export const TRYON_PRIVACY_GUARANTEE_TEXT =
  'Hình ảnh Camera được xử lý dựng phom 3D trực tiếp ngay trên thiết bị của bạn — tuyệt đối không tải lên hay lưu trữ video cá nhân trên máy chủ.';

export interface PrivacyConsentGateProps {
  accepted: boolean;
  onAccept?: () => void;
  onChange?: (checked: boolean) => void;
  compact?: boolean;
}

/**
 * Thin backward-compatible privacy badge reflecting client-side 3D AR processing.
 */
export function PrivacyConsentGate({
  compact = true,
}: PrivacyConsentGateProps) {
  return (
    <div
      className={
        compact
          ? 'rounded-xl border border-[#B08A4A]/25 bg-[#241A14]/75 px-3.5 py-2.5 text-[11px] leading-relaxed text-[#FBF7EF]/80'
          : 'mx-auto max-w-2xl rounded-2xl border border-[#B08A4A]/35 bg-[#241A14]/90 p-5 text-xs leading-relaxed text-[#FBF7EF]/85'
      }
    >
      <p className="text-[10px] font-medium tracking-[0.2em] uppercase text-[#EBCF8F]">
        Riêng tư tuyệt đối tại thiết bị · On-Device 3D AR
      </p>
      <p className="mt-1">{TRYON_PRIVACY_GUARANTEE_TEXT}</p>
    </div>
  );
}
