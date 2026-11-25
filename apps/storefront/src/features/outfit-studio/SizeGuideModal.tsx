'use client';

import { useEffect, useId, useMemo, useState } from 'react';
import { FitPreference, SizeCode } from '@atelier/contracts';
import { useScrollLock } from '@atelier/motion-kit';

export type StudioRecommendedSize = 'XS' | 'S' | 'M' | 'L' | 'XL';

export interface StudioSizeProfile {
  heightCm: number;
  weightKg: number;
  bustCm: number;
  waistCm: number;
  hipCm: number;
  fitPreference: FitPreference;
  recommendedSize: StudioRecommendedSize;
  updatedAt: string;
}

export const STUDIO_SIZE_PROFILE_STORAGE_KEY = 'atelier_studio_size_profile_v1';

const ORDERED_SIZES: StudioRecommendedSize[] = ['XS', 'S', 'M', 'L', 'XL'];

const ATELIER_SIZE_BANDS: Array<{
  size: StudioRecommendedSize;
  heightRange: string;
  weightRange: string;
  bust: number;
  waist: number;
  hip: number;
  weightMid: number;
  heightMid: number;
}> = [
  { size: 'XS', heightRange: '148–158', weightRange: '40–47', bust: 80, waist: 62, hip: 86, weightMid: 43.5, heightMid: 153 },
  { size: 'S', heightRange: '155–164', weightRange: '46–53', bust: 84, waist: 66, hip: 90, weightMid: 49.5, heightMid: 159.5 },
  { size: 'M', heightRange: '160–169', weightRange: '52–60', bust: 88, waist: 70, hip: 94, weightMid: 56, heightMid: 164.5 },
  { size: 'L', heightRange: '165–175', weightRange: '59–68', bust: 93, waist: 75, hip: 99, weightMid: 63.5, heightMid: 170 },
  { size: 'XL', heightRange: '170–182', weightRange: '67–78', bust: 98, waist: 80, hip: 104, weightMid: 72.5, heightMid: 176 },
];

const FIT_OPTIONS: Array<{
  value: FitPreference;
  label: string;
  hint: string;
}> = [
  { value: FitPreference.SLIM, label: 'Ôm tôn dáng', hint: 'Gọn eo và cầu vai' },
  { value: FitPreference.REGULAR, label: 'Chuẩn xưởng', hint: 'Độ rủ tự nhiên đặc trưng' },
  { value: FitPreference.RELAXED, label: 'Thoải mái', hint: 'Tăng nhẹ biên độ cử động' },
];

export function computeRecommendedStudioSize(input: {
  heightCm: number;
  weightKg: number;
  bustCm: number;
  waistCm: number;
  hipCm: number;
  fitPreference: FitPreference;
}): {
  recommendedSize: StudioRecommendedSize;
  fitNote: string;
} {
  let bestIdx = 2; // M default
  let bestDistance = Number.POSITIVE_INFINITY;

  ATELIER_SIZE_BANDS.forEach((band, idx) => {
    const dWeight = Math.abs(input.weightKg - band.weightMid) / 6.5;
    const dHeight = Math.abs(input.heightCm - band.heightMid) / 10;
    const dBust = Math.abs(input.bustCm - band.bust) / 4.5;
    const dWaist = Math.abs(input.waistCm - band.waist) / 4.2;
    const dHip = Math.abs(input.hipCm - band.hip) / 5.0;

    // Prioritize bust/waist/weight for structured couture silhouettes
    const weightedDist =
      dWeight * 0.3 +
      dWaist * 0.25 +
      dBust * 0.22 +
      dHip * 0.13 +
      dHeight * 0.1;

    if (weightedDist < bestDistance) {
      bestDistance = weightedDist;
      bestIdx = idx;
    }
  });

  if (input.fitPreference === FitPreference.RELAXED && bestIdx < ORDERED_SIZES.length - 1) {
    const band = ATELIER_SIZE_BANDS[bestIdx]!;
    if (input.waistCm >= band.waist + 1 || input.bustCm >= band.bust + 1 || input.weightKg >= band.weightMid + 2) {
      bestIdx += 1;
    }
  } else if (input.fitPreference === FitPreference.SLIM && bestIdx > 0) {
    const band = ATELIER_SIZE_BANDS[bestIdx]!;
    if (input.waistCm <= band.waist - 1 && input.bustCm <= band.bust - 1) {
      bestIdx -= 1;
    }
  }

  const recommendedSize = ORDERED_SIZES[bestIdx] ?? SizeCode.M;
  const band = ATELIER_SIZE_BANDS[bestIdx]!;

  const fitNote =
    input.fitPreference === FitPreference.RELAXED
      ? `Phom ${recommendedSize} tạo độ rủ thoáng nhẹ quanh vòng eo (${band.waist} cm) và cầu vai.`
      : input.fitPreference === FitPreference.SLIM
        ? `Phom ${recommendedSize} ôm gọn đường chiết eo (${band.waist} cm), tôn dáng thanh thoát.`
        : `Phom ${recommendedSize} cân đối với vòng ngực ~${band.bust} cm và eo ~${band.waist} cm chuẩn rập TryVibe.`;

  return { recommendedSize, fitNote };
}

export function loadSavedStudioSizeProfile(): StudioSizeProfile | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(STUDIO_SIZE_PROFILE_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StudioSizeProfile>;
    if (
      typeof parsed.heightCm === 'number' &&
      typeof parsed.weightKg === 'number' &&
      typeof parsed.recommendedSize === 'string' &&
      ORDERED_SIZES.includes(parsed.recommendedSize as StudioRecommendedSize)
    ) {
      return {
        heightCm: parsed.heightCm,
        weightKg: parsed.weightKg,
        bustCm: typeof parsed.bustCm === 'number' ? parsed.bustCm : 84,
        waistCm: typeof parsed.waistCm === 'number' ? parsed.waistCm : 66,
        hipCm: typeof parsed.hipCm === 'number' ? parsed.hipCm : 90,
        fitPreference:
          parsed.fitPreference === FitPreference.SLIM ||
          parsed.fitPreference === FitPreference.RELAXED
            ? parsed.fitPreference
            : FitPreference.REGULAR,
        recommendedSize: parsed.recommendedSize as StudioRecommendedSize,
        updatedAt: parsed.updatedAt ?? new Date().toISOString(),
      };
    }
  } catch {
    // Ignore storage read failures
  }
  return null;
}

export function saveStudioSizeProfile(profile: StudioSizeProfile): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(
      STUDIO_SIZE_PROFILE_STORAGE_KEY,
      JSON.stringify(profile),
    );
  } catch {
    // Ignore quota/private browsing failures
  }
}

export interface SizeGuideModalProps {
  open: boolean;
  initialProfile: StudioSizeProfile | null;
  onClose: () => void;
  onSaveProfile: (profile: StudioSizeProfile) => void;
}

export function SizeGuideModal({
  open,
  initialProfile,
  onClose,
  onSaveProfile,
}: SizeGuideModalProps) {
  useScrollLock(open);
  const titleId = useId();

  const [heightCm, setHeightCm] = useState(initialProfile?.heightCm ?? 162);
  const [weightKg, setWeightKg] = useState(initialProfile?.weightKg ?? 52);
  const [bustCm, setBustCm] = useState(initialProfile?.bustCm ?? 85);
  const [waistCm, setWaistCm] = useState(initialProfile?.waistCm ?? 67);
  const [hipCm, setHipCm] = useState(initialProfile?.hipCm ?? 91);
  const [fitPreference, setFitPreference] = useState<FitPreference>(
    initialProfile?.fitPreference ?? FitPreference.REGULAR,
  );

  useEffect(() => {
    if (!open || !initialProfile) return;
    setHeightCm(initialProfile.heightCm);
    setWeightKg(initialProfile.weightKg);
    setBustCm(initialProfile.bustCm);
    setWaistCm(initialProfile.waistCm);
    setHipCm(initialProfile.hipCm);
    setFitPreference(initialProfile.fitPreference);
  }, [open, initialProfile]);

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  const computation = useMemo(
    () =>
      computeRecommendedStudioSize({
        heightCm,
        weightKg,
        bustCm,
        waistCm,
        hipCm,
        fitPreference,
      }),
    [heightCm, weightKg, bustCm, waistCm, hipCm, fitPreference],
  );

  if (!open) {
    return null;
  }

  const handleConfirm = () => {
    const nextProfile: StudioSizeProfile = {
      heightCm,
      weightKg,
      bustCm,
      waistCm,
      hipCm,
      fitPreference,
      recommendedSize: computation.recommendedSize,
      updatedAt: new Date().toISOString(),
    };
    saveStudioSizeProfile(nextProfile);
    onSaveProfile(nextProfile);
    onClose();
  };

  return (
    <div
      data-testid="size-guide-modal"
      data-lenis-prevent=""
      className="fixed inset-0 z-[115] flex items-center justify-center p-4 sm:p-6"
    >
      {/* Backdrop Scrim */}
      <div
        className="absolute inset-0 bg-[#140E0A]/65 backdrop-blur-[4px]"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Dialog Card */}
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="relative z-10 flex max-h-[90svh] w-full max-w-[680px] flex-col overflow-hidden rounded-[26px] border border-[#B08A4A]/40 bg-[#FBF7EF] text-[#2B2019] shadow-[0_32px_80px_-24px_rgba(20,14,10,0.65)]"
      >
        <header className="flex items-start justify-between gap-4 border-b border-[#B08A4A]/20 px-6 py-5">
          <div>
            <p className="text-[10px] font-medium tracking-[0.26em] uppercase text-[#8A672C]">
              Hồ Sơ Số Đo · TryVibe Atelier
            </p>
            <h3
              id={titleId}
              className="font-editorial mt-1 text-3xl font-normal text-[#1C1410]"
            >
              Đo dáng &amp; gợi ý kích cỡ chuẩn rập
            </h3>
          </div>
          <button
            type="button"
            data-testid="size-guide-close-btn"
            onClick={onClose}
            aria-label="Đóng hồ sơ số đo"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-[#B08A4A]/35 text-lg text-[#8A672C] transition-colors hover:bg-[#F4EBDA] hover:text-[#1C1410]"
          >
            ×
          </button>
        </header>

        <div className="flex-1 space-y-5 overflow-y-auto px-6 py-5" data-lenis-prevent="">
          {/* Recommendation Banner */}
          <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-[#B08A4A]/35 bg-[#1C1410] px-5 py-4 text-[#FBF7EF]">
            <div>
              <p className="text-[10px] tracking-[0.22em] uppercase text-[#EBCF8F]">
                Kích cỡ khuyến nghị cho bộ phối
              </p>
              <p
                data-testid="size-guide-recommended"
                className="font-editorial mt-0.5 text-4xl font-light text-[#FBF7EF]"
              >
                Size {computation.recommendedSize}
              </p>
            </div>
            <p className="max-w-[340px] text-xs leading-relaxed text-[#FBF7EF]/80">
              {computation.fitNote}
            </p>
          </div>

          {/* Primary Sliders: Height & Weight */}
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="rounded-2xl border border-[#B08A4A]/25 bg-white/85 p-4">
              <div className="flex items-center justify-between text-xs">
                <label
                  htmlFor="studio-size-height"
                  className="font-medium tracking-[0.14em] uppercase text-[#8A672C]"
                >
                  Chiều cao
                </label>
                <span className="font-mono text-sm font-semibold text-[#1C1410]">
                  {heightCm} cm
                </span>
              </div>
              <input
                id="studio-size-height"
                type="range"
                min={145}
                max={185}
                value={heightCm}
                onChange={(e) => setHeightCm(Number(e.target.value))}
                className="mt-2.5 w-full accent-[#B08A4A]"
              />
              <div className="mt-1 flex justify-between font-mono text-[10px] text-[#7A6A5B]">
                <span>145 cm</span>
                <span>185 cm</span>
              </div>
            </div>

            <div className="rounded-2xl border border-[#B08A4A]/25 bg-white/85 p-4">
              <div className="flex items-center justify-between text-xs">
                <label
                  htmlFor="studio-size-weight"
                  className="font-medium tracking-[0.14em] uppercase text-[#8A672C]"
                >
                  Cân nặng
                </label>
                <span className="font-mono text-sm font-semibold text-[#1C1410]">
                  {weightKg} kg
                </span>
              </div>
              <input
                id="studio-size-weight"
                type="range"
                min={38}
                max={85}
                value={weightKg}
                onChange={(e) => setWeightKg(Number(e.target.value))}
                className="mt-2.5 w-full accent-[#B08A4A]"
              />
              <div className="mt-1 flex justify-between font-mono text-[10px] text-[#7A6A5B]">
                <span>38 kg</span>
                <span>85 kg</span>
              </div>
            </div>
          </div>

          {/* 3-Point Atelier Measurements */}
          <div className="grid grid-cols-3 gap-3">
            <label className="block rounded-2xl border border-[#B08A4A]/25 bg-white/85 p-3">
              <span className="block text-[10px] font-medium tracking-[0.14em] uppercase text-[#8A672C]">
                Vòng ngực (cm)
              </span>
              <input
                type="number"
                min={70}
                max={120}
                value={bustCm}
                onChange={(e) =>
                  setBustCm(Math.max(70, Math.min(120, Number(e.target.value) || 84)))
                }
                className="mt-1.5 w-full rounded-lg border border-[#B08A4A]/30 bg-[#FBF7EF] px-2.5 py-1.5 font-mono text-sm font-medium text-[#1C1410] outline-none focus:border-[#8A672C]"
              />
            </label>

            <label className="block rounded-2xl border border-[#B08A4A]/25 bg-white/85 p-3">
              <span className="block text-[10px] font-medium tracking-[0.14em] uppercase text-[#8A672C]">
                Vòng eo (cm)
              </span>
              <input
                type="number"
                min={52}
                max={105}
                value={waistCm}
                onChange={(e) =>
                  setWaistCm(Math.max(52, Math.min(105, Number(e.target.value) || 66)))
                }
                className="mt-1.5 w-full rounded-lg border border-[#B08A4A]/30 bg-[#FBF7EF] px-2.5 py-1.5 font-mono text-sm font-medium text-[#1C1410] outline-none focus:border-[#8A672C]"
              />
            </label>

            <label className="block rounded-2xl border border-[#B08A4A]/25 bg-white/85 p-3">
              <span className="block text-[10px] font-medium tracking-[0.14em] uppercase text-[#8A672C]">
                Vòng hông (cm)
              </span>
              <input
                type="number"
                min={76}
                max={125}
                value={hipCm}
                onChange={(e) =>
                  setHipCm(Math.max(76, Math.min(125, Number(e.target.value) || 90)))
                }
                className="mt-1.5 w-full rounded-lg border border-[#B08A4A]/30 bg-[#FBF7EF] px-2.5 py-1.5 font-mono text-sm font-medium text-[#1C1410] outline-none focus:border-[#8A672C]"
              />
            </label>
          </div>

          {/* Fit Preference */}
          <div>
            <p className="text-[11px] font-medium tracking-[0.18em] uppercase text-[#8A672C]">
              Gu phom dáng yêu thích
            </p>
            <div className="mt-2 grid gap-2 sm:grid-cols-3">
              {FIT_OPTIONS.map((opt) => {
                const active = fitPreference === opt.value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => setFitPreference(opt.value)}
                    className={`rounded-xl border px-3 py-2.5 text-left transition-colors ${
                      active
                        ? 'border-[#1C1410] bg-[#1C1410] text-[#FBF7EF]'
                        : 'border-[#B08A4A]/30 bg-white/85 text-[#2B2019] hover:border-[#8A672C]'
                    }`}
                  >
                    <span className="block text-xs font-medium">{opt.label}</span>
                    <span
                      className={`mt-0.5 block text-[10px] ${
                        active ? 'text-[#EBCF8F]/85' : 'text-[#7A6A5B]'
                      }`}
                    >
                      {opt.hint}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Reference Size Chart Table */}
          <div className="overflow-hidden rounded-2xl border border-[#B08A4A]/25 bg-white">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-[#B08A4A]/20 bg-[#F4EBDA]/65 text-[10px] tracking-[0.14em] uppercase text-[#8A672C]">
                <tr>
                  <th className="px-3 py-2">Size</th>
                  <th className="px-3 py-2">Cao (cm)</th>
                  <th className="px-3 py-2">Nặng (kg)</th>
                  <th className="px-3 py-2">Ngực</th>
                  <th className="px-3 py-2">Eo</th>
                  <th className="px-3 py-2">Hông</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#B08A4A]/15 font-mono text-[11px]">
                {ATELIER_SIZE_BANDS.map((row) => {
                  const isRec = row.size === computation.recommendedSize;
                  return (
                    <tr
                      key={row.size}
                      className={isRec ? 'bg-[#EBD9B4]/40 font-semibold text-[#1C1410]' : 'text-[#5C4B3E]'}
                    >
                      <td className="px-3 py-1.5 font-sans font-semibold">
                        {row.size} {isRec ? '✦' : ''}
                      </td>
                      <td className="px-3 py-1.5">{row.heightRange}</td>
                      <td className="px-3 py-1.5">{row.weightRange}</td>
                      <td className="px-3 py-1.5">{row.bust}</td>
                      <td className="px-3 py-1.5">{row.waist}</td>
                      <td className="px-3 py-1.5">{row.hip}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-[#B08A4A]/20 bg-[#F4EBDA]/55 px-6 py-4">
          <p className="text-[11px] text-[#6B5B4C]">
            Lưu hồ sơ để xưởng tự động chọn Size <strong>{computation.recommendedSize}</strong> cho các thiết kế mới.
          </p>
          <div className="flex items-center gap-2.5">
            <button
              type="button"
              onClick={onClose}
              className="rounded-full border border-[#8A672C]/35 bg-white px-4 py-2 text-[11px] tracking-[0.14em] uppercase text-[#2B2019] transition-colors hover:border-[#1C1410]"
            >
              Đóng
            </button>
            <button
              type="button"
              data-testid="size-guide-save-btn"
              onClick={handleConfirm}
              className="btn btn--gold !px-5 !py-2.5 !text-[11px]"
            >
              Lưu hồ sơ · Size {computation.recommendedSize}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
