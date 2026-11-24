'use client';

import { useState } from 'react';
import {
  FitPreference,
  type ProductSpuDto,
  type SizeRecommendResponse,
} from '@atelier/contracts';
import { apiFetch } from '@/lib/api-client';

export interface LiveSizeAdvisorProps {
  products: ProductSpuDto[];
}

const FIT_OPTIONS: Array<{ value: FitPreference; label: string }> = [
  { value: FitPreference.SLIM, label: 'Ôm vừa (Slim)' },
  { value: FitPreference.REGULAR, label: 'Tiêu chuẩn (Regular)' },
  { value: FitPreference.RELAXED, label: 'Thoải mái (Relaxed)' },
];

export function LiveSizeAdvisor({ products }: LiveSizeAdvisorProps) {
  const [selectedSlug, setSelectedSlug] = useState(products[0]?.slug ?? '');
  const [heightCm, setHeightCm] = useState(163);
  const [weightKg, setWeightKg] = useState(53);
  const [fitPreference, setFitPreference] = useState<FitPreference>(
    FitPreference.REGULAR,
  );
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<SizeRecommendResponse | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleCalculateSize = async () => {
    const targetProduct =
      products.find((p) => p.slug === selectedSlug) ?? products[0];
    if (!targetProduct) return;

    setLoading(true);
    setErrorMessage(null);

    const res = await apiFetch<SizeRecommendResponse>(
      '/bff/v1/storefront/size-recommend',
      {
        method: 'POST',
        skipAuthRefresh: true,
        body: JSON.stringify({
          productSlug: targetProduct.slug,
          heightCm,
          weightKg,
          fitPreference,
        }),
      },
    );

    if (res.ok && res.data) {
      setResult(res.data);
      try {
        window.sessionStorage.setItem(
          'atelier_last_recommended_size',
          res.data.recommendedSize,
        );
      } catch {
        // Ignore private browsing sessionStorage limits
      }
    } else {
      setResult(null);
      setErrorMessage(
        res.error?.message ||
          'Chưa thể kết nối máy chủ BFF để tính cỡ trang phục từ bảng số đo thực tế.',
      );
    }
    setLoading(false);
  };

  return (
    <section className="border-y border-[#B08A4A]/20 bg-[#F4EBDA]/60 py-14">
      <div className="mx-auto max-w-7xl px-6 lg:px-10">
        <div className="grid gap-8 lg:grid-cols-[1.05fr_1fr]">
          <div>
            <p className="atelier-eyebrow text-[#8A672C]">
              Live Size Advisor Station · Bảng Số Đo &amp; Dữ Liệu Phản Hồi Thực
            </p>
            <h2 className="font-editorial mt-2 text-4xl font-light text-[#1C1410] lg:text-5xl">
              Trạm tư vấn kích cỡ theo phom vải
            </h2>
            <p className="mt-3 text-sm leading-relaxed text-[#7A6A5B]">
              Hệ thống không đoán trước cỡ mặc định. Điều chỉnh chiều cao, cân
              nặng và độ ôm để gọi trực tiếp{' '}
              <code>POST /bff/v1/storefront/size-recommend</code> kết hợp bảng
              size và thống kê phản hồi độ vừa của khách hàng đã mua.
            </p>

            <div className="mt-6 space-y-5 rounded-3xl border border-[#B08A4A]/30 bg-[#FBF7EF] p-6">
              <div>
                <label
                  htmlFor="advisor-product"
                  className="block text-xs font-medium uppercase tracking-[0.18em] text-[#8A672C]"
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
                  className="mt-2 w-full rounded-xl border border-[#B08A4A]/35 bg-white px-3.5 py-2.5 text-sm text-[#1C1410] outline-none focus:border-[#8A672C]"
                >
                  {products.map((product) => (
                    <option key={product.slug} value={product.slug}>
                      {product.name} ({product.fitType})
                    </option>
                  ))}
                </select>
              </div>

              <div className="grid gap-5 sm:grid-cols-2">
                <div>
                  <div className="flex items-center justify-between text-xs">
                    <label
                      htmlFor="advisor-height"
                      className="uppercase tracking-[0.16em] text-[#8A672C]"
                    >
                      Chiều cao
                    </label>
                    <span className="font-mono font-semibold text-[#1C1410]">
                      {heightCm} cm
                    </span>
                  </div>
                  <input
                    id="advisor-height"
                    type="range"
                    min={145}
                    max={195}
                    value={heightCm}
                    onChange={(event) => setHeightCm(Number(event.target.value))}
                    className="mt-2 w-full accent-[#B08A4A]"
                  />
                </div>

                <div>
                  <div className="flex items-center justify-between text-xs">
                    <label
                      htmlFor="advisor-weight"
                      className="uppercase tracking-[0.16em] text-[#8A672C]"
                    >
                      Cân nặng
                    </label>
                    <span className="font-mono font-semibold text-[#1C1410]">
                      {weightKg} kg
                    </span>
                  </div>
                  <input
                    id="advisor-weight"
                    type="range"
                    min={40}
                    max={95}
                    value={weightKg}
                    onChange={(event) => setWeightKg(Number(event.target.value))}
                    className="mt-2 w-full accent-[#B08A4A]"
                  />
                </div>
              </div>

              <div>
                <p className="text-xs uppercase tracking-[0.16em] text-[#8A672C]">
                  Sở thích độ ôm (Fit Preference)
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {FIT_OPTIONS.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => setFitPreference(option.value)}
                      className={`rounded-full px-4 py-1.5 text-xs transition-colors ${
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

              <button
                type="button"
                disabled={loading}
                onClick={handleCalculateSize}
                className="w-full rounded-full bg-[#1C1410] py-3 text-xs font-medium uppercase tracking-[0.2em] text-[#EBCF8F] transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {loading
                  ? 'Đang đối chiếu bảng số đo...'
                  : 'Tính cỡ trang phục theo bảng số đo thực tế'}
              </button>
            </div>
          </div>

          {/* Honest Output Panel — No pre-filled fake percentage before real API call */}
          <div className="flex flex-col justify-between rounded-3xl border border-[#B08A4A]/35 bg-[#1C1410] p-7 text-[#FBF7EF]">
            {!result && !errorMessage ? (
              <div className="my-auto py-8 text-center">
                <p className="atelier-eyebrow text-[#EBCF8F]">
                  Chưa có kết quả tính toán
                </p>
                <h3 className="font-editorial mt-3 text-3xl font-light text-[#FBF7EF]">
                  Nhập số đo cơ thể để bắt đầu
                </h3>
                <p className="mx-auto mt-3 max-w-md text-xs leading-relaxed text-[#FBF7EF]/70">
                  Kết quả cỡ trang phục và hiệu chỉnh từ phản hồi khách mua thật
                  chỉ hiển thị sau khi hệ thống tính toán trực tiếp trên máy chủ.
                </p>
              </div>
            ) : errorMessage ? (
              <div className="my-auto rounded-2xl border border-[#EBCF8F]/35 bg-[#2A1E17] p-6 text-sm text-[#EBCF8F]">
                <p className="font-semibold uppercase tracking-[0.16em]">
                  Thông báo kết nối
                </p>
                <p className="mt-2 text-xs leading-relaxed text-[#FBF7EF]/85">
                  {errorMessage}
                </p>
              </div>
            ) : result ? (
              <div className="space-y-4">
                <div className="flex items-end justify-between border-b border-[#B08A4A]/25 pb-4">
                  <div>
                    <p className="atelier-eyebrow text-[#EBCF8F]">
                      Kết quả đối chiếu thực tế
                    </p>
                    <h3 className="font-editorial mt-1 text-5xl text-[#FBF7EF]">
                      Size {result.recommendedSize}
                    </h3>
                  </div>
                  <div className="text-right">
                    <p className="text-[10px] uppercase tracking-[0.18em] text-[#FBF7EF]/60">
                      Độ tin cậy thuật toán
                    </p>
                    <p className="font-mono text-lg text-[#EBCF8F]">
                      {Math.round(result.confidence * 100)} / 100
                    </p>
                  </div>
                </div>

                {result.crowdAdjusted && result.crowdAdjustmentReason ? (
                  <div className="rounded-2xl border border-[#EBCF8F]/50 bg-[#2A1E17] p-3.5 text-xs text-[#EBCF8F]">
                    <p className="font-semibold uppercase tracking-[0.14em]">
                      Hiệu chỉnh theo dữ liệu khách đã mặc thật
                    </p>
                    <p className="mt-1 text-[#FBF7EF]/90">
                      {result.crowdAdjustmentReason}
                    </p>
                  </div>
                ) : null}

                {result.fitNotes.length > 0 ? (
                  <ul className="space-y-1 text-xs text-[#FBF7EF]/85">
                    {result.fitNotes.map((note) => (
                      <li key={note}>• {note}</li>
                    ))}
                  </ul>
                ) : null}

                {result.measurementBreakdown.length > 0 ? (
                  <div className="overflow-hidden rounded-2xl border border-[#B08A4A]/25 bg-[#241A14]">
                    <table className="w-full text-left text-xs">
                      <thead className="border-b border-[#B08A4A]/20 text-[10px] uppercase tracking-[0.16em] text-[#EBCF8F]">
                        <tr>
                          <th className="px-3 py-2">Chỉ số</th>
                          <th className="px-3 py-2">Của bạn</th>
                          <th className="px-3 py-2">Bảng size</th>
                          <th className="px-3 py-2">Đánh giá</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[#B08A4A]/15">
                        {result.measurementBreakdown.map((item) => (
                          <tr key={item.metric}>
                            <td className="px-3 py-1.5 font-medium">
                              {item.metric}
                            </td>
                            <td className="px-3 py-1.5 font-mono">
                              {item.userValue ?? '—'}
                            </td>
                            <td className="px-3 py-1.5 font-mono text-[#FBF7EF]/75">
                              {item.chartMin != null && item.chartMax != null
                                ? `${item.chartMin}–${item.chartMax}`
                                : item.chartTarget ?? '—'}
                            </td>
                            <td className="px-3 py-1.5 font-mono text-[#EBCF8F]">
                              {item.verdict}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </section>
  );
}
