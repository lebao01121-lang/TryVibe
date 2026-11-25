'use client';

import { useCallback, useEffect, useState } from 'react';
import type { ProductSpuDto } from '@atelier/contracts';
import {
  AnatomicalFitVisualizer,
  BODY_FIT_PREFERENCE_OPTIONS,
  BODY_PROFILE_UPDATED_EVENT,
  isCanonicalSizeCode,
  loadSharedBodyProfile,
  saveSharedBodyProfile,
  type BodyProfileFitPreference,
  type CanonicalSizeCode,
  type ExtendedSizeRecommendResponse,
  type SharedBodyProfileV1,
} from '@/components/AnatomicalFitVisualizer';
import { apiFetch } from '@/lib/api-client';

export interface LiveSizeAdvisorProps {
  products: ProductSpuDto[];
  lockedProduct?: ProductSpuDto;
  selectedSize?: CanonicalSizeCode;
  onSelectSize?: (size: CanonicalSizeCode) => void;
  onRecommendedSize?: (
    size: CanonicalSizeCode,
    response: ExtendedSizeRecommendResponse,
  ) => void;
  embedded?: boolean;
}

export function LiveSizeAdvisor({
  products,
  lockedProduct,
  selectedSize,
  onSelectSize,
  onRecommendedSize,
  embedded = false,
}: LiveSizeAdvisorProps) {
  const activeProducts = lockedProduct ? [lockedProduct] : products;
  const [selectedSlug, setSelectedSlug] = useState(
    lockedProduct?.slug ?? products[0]?.slug ?? '',
  );
  const [savedProfile, setSavedProfile] = useState<SharedBodyProfileV1 | null>(
    null,
  );
  const [formOpen, setFormOpen] = useState(false);
  const [showOptional3, setShowOptional3] = useState(false);
  const [heightCm, setHeightCm] = useState(163);
  const [weightKg, setWeightKg] = useState(52);
  const [bustCm, setBustCm] = useState('');
  const [waistCm, setWaistCm] = useState('');
  const [hipCm, setHipCm] = useState('');
  const [fitPreference, setFitPreference] =
    useState<BodyProfileFitPreference>('TRUE_TO_SIZE');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ExtendedSizeRecommendResponse | null>(
    null,
  );
  const [previewSize, setPreviewSize] = useState<CanonicalSizeCode>('M');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const targetProduct =
    lockedProduct ??
    activeProducts.find((p) => p.slug === selectedSlug) ??
    activeProducts[0] ??
    null;

  const requestRecommendation = useCallback(
    async (
      product: ProductSpuDto,
      profileInput: {
        heightCm: number;
        weightKg: number;
        bustCm?: number;
        waistCm?: number;
        hipCm?: number;
        fitPreference: BodyProfileFitPreference;
      },
      persistProfile: boolean,
    ) => {
      setLoading(true);
      setErrorMessage(null);

      const payload: Record<string, unknown> = {
        productId: product.id,
        productSlug: product.slug,
        slug: product.slug,
        heightCm: profileInput.heightCm,
        weightKg: profileInput.weightKg,
        fitPreference: profileInput.fitPreference,
      };
      if (profileInput.bustCm && profileInput.bustCm >= 50) {
        payload.bustCm = profileInput.bustCm;
      }
      if (profileInput.waistCm && profileInput.waistCm >= 40) {
        payload.waistCm = profileInput.waistCm;
      }
      if (profileInput.hipCm && profileInput.hipCm >= 50) {
        payload.hipCm = profileInput.hipCm;
      }

      const res = await apiFetch<ExtendedSizeRecommendResponse>(
        '/bff/v1/storefront/size-recommend',
        {
          method: 'POST',
          skipAuthRefresh: true,
          body: JSON.stringify(payload),
        },
      );

      if (res.ok && res.data) {
        const recSize: CanonicalSizeCode = isCanonicalSizeCode(
          res.data.recommendedSize,
        )
          ? res.data.recommendedSize
          : 'M';
        setResult(res.data);
        setPreviewSize(recSize);

        if (persistProfile) {
          const nextProfile: SharedBodyProfileV1 = {
            heightCm: profileInput.heightCm,
            weightKg: profileInput.weightKg,
            ...(profileInput.bustCm ? { bustCm: profileInput.bustCm } : {}),
            ...(profileInput.waistCm ? { waistCm: profileInput.waistCm } : {}),
            ...(profileInput.hipCm ? { hipCm: profileInput.hipCm } : {}),
            fitPreference: profileInput.fitPreference,
            recommendedSize: recSize,
            updatedAt: Date.now(),
          };
          saveSharedBodyProfile(nextProfile);
          setSavedProfile(nextProfile);
          setFormOpen(false);
        }

        onRecommendedSize?.(recSize, res.data);
      } else {
        setResult(null);
        setErrorMessage(
          res.error?.message ||
            'Chưa thể kết nối máy chủ BFF để tính cỡ trang phục từ bảng số đo thực tế.',
        );
      }

      setLoading(false);
    },
    [onRecommendedSize],
  );

  // Hydrate ONLY from real saved `atelier_body_profile_v1` — zero guessed values on first visit
  useEffect(() => {
    const syncFromStorage = () => {
      const existing = loadSharedBodyProfile();
      setSavedProfile(existing);
      if (existing) {
        setHeightCm(existing.heightCm);
        setWeightKg(existing.weightKg);
        setBustCm(existing.bustCm ? String(existing.bustCm) : '');
        setWaistCm(existing.waistCm ? String(existing.waistCm) : '');
        setHipCm(existing.hipCm ? String(existing.hipCm) : '');
        setFitPreference(existing.fitPreference);
        if (targetProduct) {
          void requestRecommendation(targetProduct, existing, false);
        }
      }
    };

    syncFromStorage();

    const onProfileUpdated = (event: Event) => {
      const detail = (event as CustomEvent<SharedBodyProfileV1>).detail;
      const latest = detail ?? loadSharedBodyProfile();
      if (!latest) return;
      setSavedProfile(latest);
      setHeightCm(latest.heightCm);
      setWeightKg(latest.weightKg);
      setBustCm(latest.bustCm ? String(latest.bustCm) : '');
      setWaistCm(latest.waistCm ? String(latest.waistCm) : '');
      setHipCm(latest.hipCm ? String(latest.hipCm) : '');
      setFitPreference(latest.fitPreference);
    };

    window.addEventListener(BODY_PROFILE_UPDATED_EVENT, onProfileUpdated);
    return () => {
      window.removeEventListener(BODY_PROFILE_UPDATED_EVENT, onProfileUpdated);
    };
  }, [requestRecommendation, targetProduct?.id]);

  // Keep preview size synced with parent selection if controlled
  useEffect(() => {
    if (selectedSize) {
      setPreviewSize(selectedSize);
    }
  }, [selectedSize]);

  const handleCalculateSize = async () => {
    if (!targetProduct) return;
    const parsedBust = bustCm ? Number(bustCm) : undefined;
    const parsedWaist = waistCm ? Number(waistCm) : undefined;
    const parsedHip = hipCm ? Number(hipCm) : undefined;

    await requestRecommendation(
      targetProduct,
      {
        heightCm,
        weightKg,
        bustCm:
          parsedBust && Number.isFinite(parsedBust) && parsedBust >= 50
            ? parsedBust
            : undefined,
        waistCm:
          parsedWaist && Number.isFinite(parsedWaist) && parsedWaist >= 40
            ? parsedWaist
            : undefined,
        hipCm:
          parsedHip && Number.isFinite(parsedHip) && parsedHip >= 50
            ? parsedHip
            : undefined,
        fitPreference,
      },
      true,
    );
  };

  const handleVisualizerSizeSelect = (nextSize: CanonicalSizeCode) => {
    setPreviewSize(nextSize);
    onSelectSize?.(nextSize);
  };

  const recommendedCanonical: CanonicalSizeCode =
    result && isCanonicalSizeCode(result.recommendedSize)
      ? result.recommendedSize
      : 'M';

  const availableSizesForProduct = targetProduct
    ? (['XS', 'S', 'M', 'L', 'XL'] as const).map((code) => ({
        sizeCode: code,
        inStock: targetProduct.variants.some((v) =>
          v.skus.some((s) => s.sizeCode === code && s.inStock),
        ),
      }))
    : undefined;

  return (
    <section
      data-testid="live-size-advisor"
      className={
        embedded
          ? 'rounded-3xl border border-[#B08A4A]/35 bg-[#F4EBDA]/65 p-5'
          : 'border-y border-[#B08A4A]/20 bg-[#F4EBDA]/60 py-14'
      }
    >
      <div className={embedded ? 'space-y-4' : 'mx-auto max-w-7xl px-6 lg:px-10'}>
        <div
          className={
            embedded ? 'space-y-4' : 'grid gap-8 lg:grid-cols-[1.02fr_1.08fr]'
          }
        >
          {/* Left / Input Column */}
          <div>
            <p className="atelier-eyebrow text-[#8A672C]">
              Cố vấn Size AI · Bảng Rập &amp; Dữ Liệu Khách Mặc Thật
            </p>
            <h2
              className={`font-editorial mt-1.5 font-light text-[#1C1410] ${
                embedded ? 'text-2xl sm:text-3xl' : 'text-4xl lg:text-5xl'
              }`}
            >
              Trạm tư vấn kích cỡ theo 4 vùng cơ thể
            </h2>
            <p className="mt-2 text-xs leading-relaxed text-[#7A6A5B] sm:text-sm">
              Không đoán trước cỡ mặc định. Nhập chiều cao &amp; cân nặng để máy
              chủ đối chiếu bảng thông số xưởng may, độ co giãn vải và phản hồi
              độ vừa từ khách hàng đã mua thật.
            </p>

            {/* Honest Initial CTA when NO profile is saved yet and form is closed */}
            {!savedProfile && !formOpen ? (
              <div className="mt-5 rounded-3xl border border-[#B08A4A]/35 bg-[#FBF7EF] p-5">
                <p className="text-xs leading-relaxed text-[#5C4B41]">
                  Bạn chưa lưu hồ sơ số đo. Chọn nút bên dưới để tính kích cỡ
                  chuẩn xác và mô phỏng độ vừa 4 vùng{' '}
                  <strong className="text-[#1C1410]">
                    Vai · Ngực · Eo · Hông
                  </strong>
                  .
                </p>
                <button
                  type="button"
                  data-testid="live-size-advisor-cta"
                  onClick={() => setFormOpen(true)}
                  className="mt-4 w-full cursor-pointer rounded-full bg-[#1C1410] px-5 py-3 text-xs font-medium tracking-[0.14em] text-[#EBCF8F] transition-opacity hover:opacity-90"
                >
                  ✦ Tính chuẩn Size của bạn trong 5 giây
                </button>
              </div>
            ) : null}

            {/* Saved Profile Compact Summary + Re-edit Toggle */}
            {savedProfile && !formOpen ? (
              <div className="mt-4 flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-[#B08A4A]/30 bg-[#FBF7EF] px-4 py-3 text-xs">
                <div className="text-[#2B2019]">
                  <span className="text-[10px] uppercase tracking-[0.14em] text-[#8A672C]">
                    Hồ sơ số đo của bạn
                  </span>
                  <p className="mt-0.5 font-mono font-semibold text-[#1C1410]">
                    {savedProfile.heightCm}cm · {savedProfile.weightKg}kg
                    {savedProfile.bustCm ? ` · Ngực ${savedProfile.bustCm}` : ''}
                    {savedProfile.waistCm ? ` · Eo ${savedProfile.waistCm}` : ''}
                    {savedProfile.hipCm ? ` · Hông ${savedProfile.hipCm}` : ''}
                  </p>
                </div>
                <button
                  type="button"
                  data-testid="live-size-advisor-edit-btn"
                  onClick={() => setFormOpen(true)}
                  className="cursor-pointer rounded-full border border-[#8A672C] bg-white px-3.5 py-1.5 text-[11px] font-medium text-[#1C1410] transition-colors hover:bg-[#1C1410] hover:text-[#EBCF8F]"
                >
                  Chỉnh số đo
                </button>
              </div>
            ) : null}

            {/* Interactive 5-Second Sliders Form */}
            {formOpen ? (
              <div
                data-testid="live-size-advisor-form"
                className="mt-5 space-y-4 rounded-3xl border border-[#B08A4A]/30 bg-[#FBF7EF] p-5"
              >
                {!lockedProduct && activeProducts.length > 1 ? (
                  <div>
                    <label
                      htmlFor="advisor-product"
                      className="block text-xs font-medium uppercase tracking-[0.16em] text-[#8A672C]"
                    >
                      Chọn thiết kế cần đối chiếu
                    </label>
                    <select
                      id="advisor-product"
                      value={selectedSlug}
                      onChange={(event) => {
                        setSelectedSlug(event.target.value);
                        setResult(null);
                      }}
                      className="mt-1.5 w-full rounded-xl border border-[#B08A4A]/35 bg-white px-3.5 py-2 text-sm text-[#1C1410] outline-none focus:border-[#8A672C]"
                    >
                      {activeProducts.map((product) => (
                        <option key={product.slug} value={product.slug}>
                          {product.name} ({product.fitType})
                        </option>
                      ))}
                    </select>
                  </div>
                ) : null}

                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="rounded-2xl border border-[#B08A4A]/25 bg-white p-3.5">
                    <div className="flex items-center justify-between text-xs">
                      <label
                        htmlFor="advisor-height"
                        className="uppercase tracking-[0.14em] text-[#8A672C]"
                      >
                        Chiều cao
                      </label>
                      <span className="font-mono font-semibold text-[#1C1410]">
                        {heightCm} cm
                      </span>
                    </div>
                    <input
                      id="advisor-height"
                      data-testid="live-size-height-slider"
                      type="range"
                      min={145}
                      max={190}
                      value={heightCm}
                      onChange={(event) =>
                        setHeightCm(Number(event.target.value))
                      }
                      className="mt-2 w-full accent-[#B08A4A]"
                    />
                  </div>

                  <div className="rounded-2xl border border-[#B08A4A]/25 bg-white p-3.5">
                    <div className="flex items-center justify-between text-xs">
                      <label
                        htmlFor="advisor-weight"
                        className="uppercase tracking-[0.14em] text-[#8A672C]"
                      >
                        Cân nặng
                      </label>
                      <span className="font-mono font-semibold text-[#1C1410]">
                        {weightKg} kg
                      </span>
                    </div>
                    <input
                      id="advisor-weight"
                      data-testid="live-size-weight-slider"
                      type="range"
                      min={40}
                      max={95}
                      value={weightKg}
                      onChange={(event) =>
                        setWeightKg(Number(event.target.value))
                      }
                      className="mt-2 w-full accent-[#B08A4A]"
                    />
                  </div>
                </div>

                {/* Optional 3 Measurements */}
                <div>
                  <button
                    type="button"
                    onClick={() => setShowOptional3((prev) => !prev)}
                    className="cursor-pointer text-xs text-[#8A672C] underline underline-offset-4 hover:text-[#1C1410]"
                  >
                    {showOptional3
                      ? 'Ẩn số đo 3 vòng tùy chọn'
                      : '+ Bổ sung số đo 3 vòng (Ngực · Eo · Hông) tùy chọn'}
                  </button>
                  {showOptional3 ? (
                    <div className="mt-2.5 grid grid-cols-3 gap-2.5">
                      <label className="text-[11px] text-[#5C4B41]">
                        Ngực (cm)
                        <input
                          type="number"
                          min={60}
                          max={150}
                          placeholder="Tự ước tính"
                          value={bustCm}
                          onChange={(e) => setBustCm(e.target.value)}
                          className="mt-1 w-full rounded-xl border border-[#B08A4A]/35 bg-white px-2.5 py-1.5 font-mono text-xs text-[#1C1410]"
                        />
                      </label>
                      <label className="text-[11px] text-[#5C4B41]">
                        Eo (cm)
                        <input
                          type="number"
                          min={45}
                          max={140}
                          placeholder="Tự ước tính"
                          value={waistCm}
                          onChange={(e) => setWaistCm(e.target.value)}
                          className="mt-1 w-full rounded-xl border border-[#B08A4A]/35 bg-white px-2.5 py-1.5 font-mono text-xs text-[#1C1410]"
                        />
                      </label>
                      <label className="text-[11px] text-[#5C4B41]">
                        Hông (cm)
                        <input
                          type="number"
                          min={65}
                          max={160}
                          placeholder="Tự ước tính"
                          value={hipCm}
                          onChange={(e) => setHipCm(e.target.value)}
                          className="mt-1 w-full rounded-xl border border-[#B08A4A]/35 bg-white px-2.5 py-1.5 font-mono text-xs text-[#1C1410]"
                        />
                      </label>
                    </div>
                  ) : null}
                </div>

                {/* Fit Preference Pills: Ôm vừa | Chuẩn phom | Thoải mái */}
                <div>
                  <p className="text-xs uppercase tracking-[0.14em] text-[#8A672C]">
                    Gu mặc ưu tiên
                  </p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {BODY_FIT_PREFERENCE_OPTIONS.map((option) => (
                      <button
                        key={option.value}
                        type="button"
                        onClick={() => setFitPreference(option.value)}
                        className={`cursor-pointer rounded-full px-4 py-1.5 text-xs transition-colors ${
                          fitPreference === option.value
                            ? 'bg-[#1C1410] text-[#EBCF8F]'
                            : 'border border-[#B08A4A]/35 bg-white text-[#2B2019]'
                        }`}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    data-testid="live-size-submit-btn"
                    disabled={loading}
                    onClick={() => void handleCalculateSize()}
                    className="flex-1 cursor-pointer rounded-full bg-[#1C1410] py-2.5 text-xs font-medium uppercase tracking-[0.16em] text-[#EBCF8F] transition-opacity hover:opacity-90 disabled:opacity-50"
                  >
                    {loading
                      ? 'Đang phân tích 4 vùng phom...'
                      : 'Tính & Lưu Size chuẩn của tôi'}
                  </button>
                  {savedProfile ? (
                    <button
                      type="button"
                      onClick={() => setFormOpen(false)}
                      className="cursor-pointer rounded-full border border-[#B08A4A]/35 bg-white px-4 py-2.5 text-xs text-[#5C4B41]"
                    >
                      Hủy
                    </button>
                  ) : null}
                </div>
              </div>
            ) : null}
          </div>

          {/* Right / Honest Output + 4-Zone <AnatomicalFitVisualizer /> */}
          <div className="flex flex-col justify-between rounded-3xl border border-[#B08A4A]/35 bg-[#1C1410] p-6 text-[#FBF7EF]">
            {!result && !errorMessage ? (
              <div className="my-auto py-6 text-center">
                <p className="atelier-eyebrow text-[#EBCF8F]">
                  Chưa có kết quả tính toán
                </p>
                <h3 className="font-editorial mt-3 text-3xl font-light text-[#FBF7EF]">
                  Nhập số đo cơ thể để bắt đầu
                </h3>
                <p className="mx-auto mt-3 max-w-md text-xs leading-relaxed text-[#FBF7EF]/70">
                  Kết quả cỡ trang phục, hiệu chỉnh theo khách đã mặc thật và sơ
                  đồ 4 vùng Vai · Ngực · Eo · Hông chỉ hiển thị sau khi máy chủ
                  tính toán trực tiếp từ số đo của bạn.
                </p>
              </div>
            ) : errorMessage ? (
              <div className="my-auto rounded-2xl border border-[#EBCF8F]/35 bg-[#2A1E17] p-5 text-sm text-[#EBCF8F]">
                <p className="font-semibold uppercase tracking-[0.16em]">
                  Thông báo kết nối
                </p>
                <p className="mt-2 text-xs leading-relaxed text-[#FBF7EF]/85">
                  {errorMessage}
                </p>
              </div>
            ) : result ? (
              <div className="space-y-4">
                <div className="flex items-end justify-between border-b border-[#B08A4A]/25 pb-3.5">
                  <div>
                    <p className="atelier-eyebrow text-[#EBCF8F]">
                      Đề xuất thực tế từ bảng rập &amp; đánh giá độ vừa
                    </p>
                    <h3
                      data-testid="live-size-recommended-result"
                      className="font-editorial mt-1 text-4xl text-[#FBF7EF] sm:text-5xl"
                    >
                      Size {result.recommendedSize}
                    </h3>
                  </div>
                  <div className="text-right">
                    <p className="text-[10px] uppercase tracking-[0.16em] text-[#FBF7EF]/60">
                      Độ tin cậy số đo
                    </p>
                    <p className="font-mono text-base text-[#EBCF8F]">
                      {Math.round(result.confidence * 100)} / 100
                    </p>
                  </div>
                </div>

                <AnatomicalFitVisualizer
                  recommendedSize={recommendedCanonical}
                  selectedSize={previewSize}
                  onSelectSize={handleVisualizerSizeSelect}
                  fitZones={result.fitZones}
                  allSizesFitZones={result.allSizesFitZones}
                  availableSizes={availableSizesForProduct}
                  estimatedMeasurements={result.estimatedMeasurements}
                  rationaleVi={result.rationaleVi}
                  crowdAdjusted={Boolean(result.crowdAdjusted)}
                  crowdAdjustmentReason={result.crowdAdjustmentReason ?? null}
                  theme="dark"
                  compact={embedded}
                />

                {result.fitNotes.length > 0 ? (
                  <ul className="space-y-1 text-xs text-[#FBF7EF]/80">
                    {result.fitNotes.slice(0, 3).map((note) => (
                      <li key={note}>• {note}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </section>
  );
}
