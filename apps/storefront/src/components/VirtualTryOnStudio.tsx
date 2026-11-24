'use client';

import { useState } from 'react';
import { useCameraGpuGuard } from '@atelier/motion-kit';
import { FALLBACK_PRODUCTS, FORMAT_VND } from '@/lib/catalog-data';

type TryOnStage = 'idle' | 'queued' | 'completed';

export function VirtualTryOnStudio() {
  const [selectedSlug, setSelectedSlug] = useState(
    FALLBACK_PRODUCTS[0]?.slug ?? '',
  );
  const [cameraActive, setCameraActive] = useState(false);
  const [consentAccepted, setConsentAccepted] = useState(false);
  const [stage, setStage] = useState<TryOnStage>('idle');

  useCameraGpuGuard(cameraActive);

  const selectedGarment =
    FALLBACK_PRODUCTS.find((item) => item.slug === selectedSlug) ??
    FALLBACK_PRODUCTS[0]!;

  const handleSimulateTryOn = () => {
    if (!consentAccepted) return;
    setStage('queued');
    window.setTimeout(() => {
      setStage('completed');
    }, 650);
  };

  return (
    <div className="grid gap-8 lg:grid-cols-[1.15fr_1fr]">
      <div className="rounded-3xl border border-[#B08A4A]/30 bg-[#1C1410] p-6 text-[#FBF7EF] lg:p-8">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#B08A4A]/20 pb-4">
          <div>
            <p className="atelier-eyebrow text-[#EBCF8F]">
              Phòng Thử Đồ Ảo · Bảo Vệ Quyền Riêng Tư
            </p>
            <h2 className="font-editorial mt-1 text-3xl font-light">
              Khung chụp ảnh toàn thân
            </h2>
          </div>
          <span className="rounded-full border border-[#EBCF8F]/40 px-3.5 py-1 text-[11px] uppercase tracking-[0.2em] text-[#EBCF8F]">
            GPU Guard: {cameraActive ? 'Camera Active' : 'Standby'}
          </span>
        </div>

        <div className="mt-6 flex min-h-72 flex-col items-center justify-center rounded-2xl border border-dashed border-[#EBCF8F]/35 bg-[#241A14]/70 p-8 text-center">
          <p className="font-editorial text-2xl text-[#EBCF8F]">
            {cameraActive
              ? 'Camera thử đồ đang bật — WebGL nền đã tạm dừng'
              : 'Chọn bật Camera hoặc tải ảnh chân dung đứng thẳng'}
          </p>
          <p className="mt-2 max-w-md text-xs leading-relaxed text-[#FBF7EF]/75">
            Ảnh khách hàng được lưu mã hóa trong kho riêng tư{' '}
            <code className="text-[#EBCF8F]">atelier-private-tryon</code> và tự
            động xóa cứng vĩnh viễn sau <strong>15 phút</strong>.
          </p>

          <div className="mt-6 flex flex-wrap justify-center gap-3">
            <button
              type="button"
              onClick={() => setCameraActive((prev) => !prev)}
              className="rounded-full bg-[#EBCF8F] px-6 py-2.5 text-xs font-medium uppercase tracking-[0.18em] text-[#1C1410] transition-opacity hover:opacity-90"
            >
              {cameraActive ? 'Đóng Camera' : 'Mở Camera (Kích hoạt GPU Guard)'}
            </button>

            <button
              type="button"
              onClick={handleSimulateTryOn}
              disabled={!consentAccepted}
              className="rounded-full border border-[#EBCF8F]/60 px-6 py-2.5 text-xs uppercase tracking-[0.18em] text-[#EBCF8F] disabled:cursor-not-allowed disabled:opacity-40"
            >
              Chạy thử đồ mẫu
            </button>
          </div>

          {stage !== 'idle' ? (
            <div className="mt-6 w-full max-w-md rounded-xl border border-[#B08A4A]/35 bg-[#1C1410] p-4 text-left text-xs">
              <p className="uppercase tracking-[0.18em] text-[#EBCF8F]">
                Trạng thái tác vụ AI Try-On
              </p>
              <p className="mt-1 text-[#FBF7EF]/85">
                {stage === 'queued'
                  ? 'Đang xếp hàng xử lý trên dịch vụ thử đồ AI...'
                  : `Hoàn tất mô phỏng thử mẫu "${selectedGarment.name}". Ảnh riêng tư sẽ tự hủy sau 15 phút.`}
              </p>
            </div>
          ) : null}
        </div>

        <label className="mt-5 flex cursor-pointer items-start gap-3 text-xs leading-relaxed text-[#FBF7EF]/80">
          <input
            type="checkbox"
            checked={consentAccepted}
            onChange={(event) => setConsentAccepted(event.target.checked)}
            className="mt-0.5 h-4 w-4 accent-[#B08A4A]"
          />
          <span>
            Tôi đồng ý xử lý tạm thời ảnh cơ thể cho mục đích thử trang phục ảo
            và hiểu rằng ảnh sẽ tự hủy cứng sau 15 phút theo chính sách bảo mật
            Atelier.
          </span>
        </label>
      </div>

      <aside className="rounded-3xl border border-[#B08A4A]/25 bg-[#F4EBDA]/65 p-6 lg:p-8">
        <p className="atelier-eyebrow text-[#8A672C]">Chọn thiết kế thử đồ</p>
        <h3 className="font-editorial mt-1 text-3xl text-[#2B2019]">
          {selectedGarment.name}
        </h3>
        <p className="mt-1 text-sm text-[#7A6A5B]">
          {selectedGarment.fabricComposition}
        </p>
        <p className="font-editorial mt-3 text-2xl text-[#8A672C]">
          {FORMAT_VND(selectedGarment.minPriceVnd)}
        </p>

        <div className="mt-6 space-y-2.5">
          {FALLBACK_PRODUCTS.map((item) => {
            const active = item.slug === selectedGarment.slug;
            return (
              <button
                key={item.slug}
                type="button"
                onClick={() => {
                  setSelectedSlug(item.slug);
                  setStage('idle');
                }}
                className={`flex w-full items-center justify-between rounded-2xl border px-4 py-3 text-left transition-colors ${
                  active
                    ? 'border-[#1C1410] bg-[#1C1410] text-[#FBF7EF]'
                    : 'border-[#B08A4A]/25 bg-[#FBF7EF] text-[#2B2019] hover:border-[#8A672C]'
                }`}
              >
                <div>
                  <p className="text-sm font-medium">{item.name}</p>
                  <p
                    className={`text-xs ${active ? 'text-[#EBCF8F]/80' : 'text-[#7A6A5B]'}`}
                  >
                    {item.categoryName}
                  </p>
                </div>
                <span className="font-editorial text-lg">
                  {FORMAT_VND(item.minPriceVnd)}
                </span>
              </button>
            );
          })}
        </div>
      </aside>
    </div>
  );
}
