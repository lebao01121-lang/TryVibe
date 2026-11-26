'use client';

import { useState } from 'react';
import { FitPreference, type SizeRecommendResponse } from '@atelier/contracts';

export type CanonicalSizeCode = 'XS' | 'S' | 'M' | 'L' | 'XL';
export type BodyProfileFitPreference = 'SNUG' | 'TRUE_TO_SIZE' | 'RELAXED';
export type AnatomicalFitZoneName = 'shoulder' | 'chest' | 'waist' | 'hip';
export type AnatomicalFitStatus = 'TIGHT' | 'SNUG' | 'IDEAL' | 'RELAXED';
export type AnatomicalFitStatusVi =
  | 'CHẬT'
  | 'ÔM VỪA'
  | 'CHUẨN PHOM'
  | 'RỘNG THOẢI MÁI';

export const CANONICAL_SIZE_CODES: readonly CanonicalSizeCode[] = [
  'XS',
  'S',
  'M',
  'L',
  'XL',
] as const;

export const BODY_PROFILE_STORAGE_KEY = 'atelier_body_profile_v1';
export const BODY_PROFILE_UPDATED_EVENT = 'atelier:body-profile-updated';

export interface SharedBodyProfileV1 {
  heightCm: number;
  weightKg: number;
  bustCm?: number;
  waistCm?: number;
  hipCm?: number;
  fitPreference: BodyProfileFitPreference;
  recommendedSize?: CanonicalSizeCode;
  updatedAt: number;
}

export interface AnatomicalFitZone {
  zone: AnatomicalFitZoneName;
  labelVi: 'Vai' | 'Ngực' | 'Eo' | 'Hông';
  status: AnatomicalFitStatus;
  statusVi: AnatomicalFitStatusVi;
  easeCm: number;
  bodyCm: number;
  garmentCm: number;
}

export type AllSizesFitZones = Record<CanonicalSizeCode, AnatomicalFitZone[]>;

export interface EstimatedBodyMeasurementsDto {
  bustCm: number;
  waistCm: number;
  hipCm: number;
  shoulderCm: number;
  interpolated: boolean;
  interpolatedFields?: string[];
}

export interface ExtendedSizeRecommendResponse extends SizeRecommendResponse {
  fitZones?: AnatomicalFitZone[];
  allSizesFitZones?: AllSizesFitZones;
  estimatedMeasurements?: EstimatedBodyMeasurementsDto;
  rationaleVi?: string;
  effectiveStretchLevel?: string;
}

export const BODY_FIT_PREFERENCE_OPTIONS: ReadonlyArray<{
  value: BodyProfileFitPreference;
  label: string;
  shortHint: string;
}> = [
  { value: 'SNUG', label: 'Ôm vừa', shortHint: 'Gọn vai eo' },
  { value: 'TRUE_TO_SIZE', label: 'Chuẩn phom', shortHint: 'Độ rủ chuẩn xưởng' },
  { value: 'RELAXED', label: 'Thoải mái', shortHint: 'Rộng nhẹ dễ phối' },
];

export function mapProfileFitToApiFit(
  pref: BodyProfileFitPreference,
): FitPreference {
  if (pref === 'SNUG') return FitPreference.SLIM;
  if (pref === 'RELAXED') return FitPreference.RELAXED;
  return FitPreference.REGULAR;
}

export function mapApiFitToProfileFit(
  pref: FitPreference | string | undefined | null,
): BodyProfileFitPreference {
  if (pref === FitPreference.SLIM || pref === 'SNUG') return 'SNUG';
  if (pref === FitPreference.RELAXED || pref === 'RELAXED') return 'RELAXED';
  return 'TRUE_TO_SIZE';
}

export function isCanonicalSizeCode(
  value: unknown,
): value is CanonicalSizeCode {
  return (
    typeof value === 'string' &&
    (CANONICAL_SIZE_CODES as readonly string[]).includes(value)
  );
}

export function loadSharedBodyProfile(): SharedBodyProfileV1 | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(BODY_PROFILE_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SharedBodyProfileV1>;
    if (
      typeof parsed.heightCm !== 'number' ||
      !Number.isFinite(parsed.heightCm) ||
      typeof parsed.weightKg !== 'number' ||
      !Number.isFinite(parsed.weightKg)
    ) {
      return null;
    }
    const fitPreference: BodyProfileFitPreference =
      parsed.fitPreference === 'SNUG' ||
      parsed.fitPreference === 'RELAXED' ||
      parsed.fitPreference === 'TRUE_TO_SIZE'
        ? parsed.fitPreference
        : 'TRUE_TO_SIZE';

    return {
      heightCm: Math.round(parsed.heightCm),
      weightKg: Math.round(parsed.weightKg),
      ...(typeof parsed.bustCm === 'number' && Number.isFinite(parsed.bustCm)
        ? { bustCm: parsed.bustCm }
        : {}),
      ...(typeof parsed.waistCm === 'number' && Number.isFinite(parsed.waistCm)
        ? { waistCm: parsed.waistCm }
        : {}),
      ...(typeof parsed.hipCm === 'number' && Number.isFinite(parsed.hipCm)
        ? { hipCm: parsed.hipCm }
        : {}),
      fitPreference,
      ...(isCanonicalSizeCode(parsed.recommendedSize)
        ? { recommendedSize: parsed.recommendedSize }
        : {}),
      updatedAt:
        typeof parsed.updatedAt === 'number' && Number.isFinite(parsed.updatedAt)
          ? parsed.updatedAt
          : Date.now(),
    };
  } catch {
    return null;
  }
}

export function saveSharedBodyProfile(profile: SharedBodyProfileV1): void {
  if (typeof window === 'undefined') return;
  try {
    const normalized: SharedBodyProfileV1 = {
      ...profile,
      heightCm: Math.round(profile.heightCm),
      weightKg: Math.round(profile.weightKg),
      updatedAt: profile.updatedAt || Date.now(),
    };
    window.localStorage.setItem(
      BODY_PROFILE_STORAGE_KEY,
      JSON.stringify(normalized),
    );
    if (normalized.recommendedSize) {
      window.sessionStorage.setItem(
        'atelier_last_recommended_size',
        normalized.recommendedSize,
      );
    }
    window.dispatchEvent(
      new CustomEvent<SharedBodyProfileV1>(BODY_PROFILE_UPDATED_EVENT, {
        detail: normalized,
      }),
    );
  } catch {
    // Ignore private browsing quota errors
  }
}

export interface AnatomicalFitVisualizerProps {
  recommendedSize: CanonicalSizeCode;
  selectedSize: CanonicalSizeCode;
  onSelectSize?: (size: CanonicalSizeCode) => void;
  fitZones?: AnatomicalFitZone[];
  allSizesFitZones?: AllSizesFitZones;
  availableSizes?: ReadonlyArray<{
    sizeCode: CanonicalSizeCode;
    inStock: boolean;
  }>;
  estimatedMeasurements?: EstimatedBodyMeasurementsDto;
  rationaleVi?: string | null;
  crowdAdjusted?: boolean;
  crowdAdjustmentReason?: string | null;
  theme?: 'dark' | 'light';
  compact?: boolean;
  className?: string;
}

const ZONE_VISUAL_META: Record<
  AnatomicalFitStatus,
  {
    stroke: string;
    dotBg: string;
    pillDark: string;
    pillLight: string;
    barColor: string;
  }
> = {
  TIGHT: {
    stroke: '#D96B5A',
    dotBg: '#D96B5A',
    pillDark: 'border-[#D96B5A]/55 bg-[#D96B5A]/18 text-[#F4B4A9]',
    pillLight: 'border-[#B84A39]/35 bg-[#FDF1EE] text-[#9E3626]',
    barColor: '#D96B5A',
  },
  SNUG: {
    stroke: '#E3A84F',
    dotBg: '#E3A84F',
    pillDark: 'border-[#E3A84F]/55 bg-[#E3A84F]/16 text-[#F5D08E]',
    pillLight: 'border-[#B08A4A]/45 bg-[#FBF4E4] text-[#8A672C]',
    barColor: '#D49A42',
  },
  IDEAL: {
    stroke: '#58B37D',
    dotBg: '#58B37D',
    pillDark: 'border-[#58B37D]/55 bg-[#58B37D]/18 text-[#A6E6BF]',
    pillLight: 'border-[#2E6B47]/35 bg-[#EEF8F2] text-[#1F5636]',
    barColor: '#4E9A6F',
  },
  RELAXED: {
    stroke: '#8BA8BE',
    dotBg: '#8BA8BE',
    pillDark: 'border-[#8BA8BE]/55 bg-[#8BA8BE]/18 text-[#CBE0EE]',
    pillLight: 'border-[#648299]/35 bg-[#F1F6FA] text-[#3F5D73]',
    barColor: '#7898B0',
  },
};

const ZONE_SILHOUETTE_COORDS: Record<
  AnatomicalFitZoneName,
  { y: number; leftX: number; rightX: number; shortLabel: string }
> = {
  shoulder: { y: 64, leftX: 30, rightX: 110, shortLabel: 'Vai' },
  chest: { y: 108, leftX: 39, rightX: 101, shortLabel: 'Ngực' },
  waist: { y: 154, leftX: 46, rightX: 94, shortLabel: 'Eo' },
  hip: { y: 202, leftX: 35, rightX: 105, shortLabel: 'Hông' },
};

function computeGaugePositionPct(zone: AnatomicalFitZone): number {
  // Map easeCm smoothly onto a 4%..96% comfort bar (0% = very tight, 55% = ideal, 100% = very loose)
  const minEase = zone.zone === 'shoulder' ? -2.2 : -4.5;
  const maxEase = zone.zone === 'shoulder' ? 4.2 : 10.5;
  const ratio = (zone.easeCm - minEase) / (maxEase - minEase);
  return Math.max(5, Math.min(95, Math.round(ratio * 100)));
}

function formatSignedEase(easeCm: number): string {
  const rounded = Math.round(easeCm * 10) / 10;
  return `${rounded > 0 ? '+' : ''}${rounded.toFixed(1)} cm`;
}

export function AnatomicalFitVisualizer({
  recommendedSize,
  selectedSize,
  onSelectSize,
  fitZones,
  allSizesFitZones,
  availableSizes,
  estimatedMeasurements,
  rationaleVi,
  crowdAdjusted = false,
  crowdAdjustmentReason = null,
  theme = 'dark',
  compact = false,
  className = '',
}: AnatomicalFitVisualizerProps) {
  const [hoveredZone, setHoveredZone] = useState<AnatomicalFitZoneName | null>(
    null,
  );

  const activeZones: AnatomicalFitZone[] =
    allSizesFitZones?.[selectedSize] ??
    fitZones ??
    allSizesFitZones?.[recommendedSize] ??
    [];

  if (activeZones.length === 0) {
    return null;
  }

  const isDark = theme === 'dark';
  const stockBySize = new Map<CanonicalSizeCode, boolean>();
  if (availableSizes) {
    for (const s of availableSizes) {
      stockBySize.set(s.sizeCode, s.inStock);
    }
  }

  const activeRationale =
    selectedSize === recommendedSize
      ? crowdAdjustmentReason || rationaleVi
      : `Đang mô phỏng độ vừa khi mặc Size ${selectedSize} (xưởng đề xuất Size ${recommendedSize} cho vóc dáng của bạn).`;

  return (
    <div
      data-testid="anatomical-fit-visualizer"
      data-selected-size={selectedSize}
      data-recommended-size={recommendedSize}
      className={`rounded-2xl border ${
        isDark
          ? 'border-[#B08A4A]/35 bg-[#16100C] text-[#FBF7EF]'
          : 'border-[#B08A4A]/30 bg-[#FBF7EF] text-[#1C1410]'
      } ${compact ? 'p-2.5' : 'p-4 sm:p-5'} ${className}`}
    >
      {/* Top Bar: Title + Live Interactive XS..XL Size Switcher */}
      <div
        className={`flex flex-wrap items-center justify-between gap-2 border-b border-[#B08A4A]/20 ${
          compact ? 'pb-2' : 'pb-2.5'
        }`}
      >
        <div>
          <p
            className={`text-[10px] font-medium tracking-[0.18em] uppercase ${
              isDark ? 'text-[#EBCF8F]' : 'text-[#8A672C]'
            }`}
          >
            Mô phỏng 4 vùng phom · Vai · Ngực · Eo · Hông
          </p>
          {!compact ? (
            <p
              className={`mt-0.5 text-[11px] ${
                isDark ? 'text-[#FBF7EF]/70' : 'text-[#7A6A5B]'
              }`}
            >
              Chuyển cỡ XS–XL để kiểm tra độ thoải mái từng vùng cơ thể ngay lập
              tức
            </p>
          ) : null}
        </div>

        <div
          role="group"
          aria-label="Chọn cỡ mô phỏng độ vừa 4 vùng"
          className="flex flex-wrap items-center gap-1"
        >
          {CANONICAL_SIZE_CODES.map((code) => {
            const isSelected = code === selectedSize;
            const isRecommended = code === recommendedSize;
            const inStock = stockBySize.has(code) ? stockBySize.get(code)! : true;
            return (
              <button
                key={code}
                type="button"
                data-testid={`fit-visualizer-size-${code}`}
                aria-pressed={isSelected}
                onClick={() => onSelectSize?.(code)}
                className={`relative cursor-pointer rounded-full border px-2.5 py-0.5 font-mono text-[10.5px] font-medium transition-all ${
                  isSelected
                    ? isDark
                      ? 'border-[#EBCF8F] bg-[#EBCF8F] text-[#1C1410]'
                      : 'border-[#1C1410] bg-[#1C1410] text-[#EBCF8F]'
                    : isDark
                      ? 'border-[#B08A4A]/35 bg-[#1F1712] text-[#FBF7EF]/80 hover:border-[#EBCF8F]'
                      : 'border-[#B08A4A]/35 bg-white text-[#2B2019] hover:border-[#8A672C]'
                } ${!inStock ? 'opacity-55' : ''}`}
                title={
                  isRecommended
                    ? `Size ${code} · Khuyên dùng theo số đo của bạn`
                    : `Mô phỏng Size ${code}`
                }
              >
                {code}
                {isRecommended ? (
                  <span
                    aria-label="Khuyên dùng"
                    className={`ml-1 inline-block text-[8px] ${
                      isSelected
                        ? isDark
                          ? 'text-[#1C1410]'
                          : 'text-[#EBCF8F]'
                        : 'text-[#B08A4A]'
                    }`}
                  >
                    ✦
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      </div>

      {/* Crowd / Rationale Notice */}
      {activeRationale ? (
        <div
          data-testid="fit-visualizer-rationale"
          className={`${compact ? 'mt-2 px-2.5 py-1.5 text-[10.5px]' : 'mt-2.5 px-3 py-2 text-[11px]'} rounded-xl border leading-snug ${
            crowdAdjusted && selectedSize === recommendedSize
              ? isDark
                ? 'border-[#EBCF8F]/45 bg-[#2A1E17] text-[#F4EBDA]'
                : 'border-[#B08A4A]/45 bg-[#F4EBDA]/85 text-[#2B2019]'
              : isDark
                ? 'border-[#B08A4A]/20 bg-[#1E1611] text-[#FBF7EF]/85'
                : 'border-[#B08A4A]/20 bg-white text-[#5C4B41]'
          }`}
        >
          {crowdAdjusted && selectedSize === recommendedSize ? (
            <span
              className={`mr-1.5 inline-block rounded-full px-2 py-0.5 text-[9px] font-semibold tracking-[0.12em] uppercase ${
                isDark
                  ? 'bg-[#EBCF8F] text-[#1C1410]'
                  : 'bg-[#1C1410] text-[#EBCF8F]'
              }`}
            >
              Hiệu chỉnh cộng đồng
            </span>
          ) : null}
          <span>{activeRationale}</span>
        </div>
      ) : null}

      {/* Body Grid: Quiet Luxury Silhouette Sketch + Live 4-Zone Meter */}
      <div
        className={`grid items-center gap-2.5 ${
          compact
            ? 'mt-2 grid-cols-[84px_1fr]'
            : 'mt-3 grid-cols-[108px_1fr] sm:grid-cols-[124px_1fr] sm:gap-3'
        }`}
      >
        {/* Left: Minimalist Quiet Luxury Editorial Silhouette Sketch */}
        <div
          className={`relative flex flex-col items-center justify-center rounded-xl border p-2 ${
            isDark
              ? 'border-[#B08A4A]/20 bg-[#1B1410]'
              : 'border-[#B08A4A]/20 bg-[#F4EBDA]/55'
          }`}
        >
          <svg
            viewBox="0 0 140 250"
            role="img"
            aria-label={`Sơ đồ phom dáng 4 vùng Size ${selectedSize}`}
            className={compact ? 'h-[156px] w-[76px]' : 'h-[198px] w-[98px]'}
          >
            {/* Subtle Atelier Center Plumb Line */}
            <line
              x1="70"
              y1="18"
              x2="70"
              y2="238"
              stroke={isDark ? '#B08A4A' : '#8A672C'}
              strokeOpacity="0.24"
              strokeDasharray="3 4"
              strokeWidth="1"
            />

            {/* Minimalist Dressmaker Mannequin Contour */}
            <path
              d="M58 26 C58 19 82 19 82 26 L82 40 C82 46 92 52 108 60 C114 63 116 70 112 80 L102 108 C98 124 94 140 94 154 C94 170 105 186 106 204 C107 220 100 232 95 240 L45 240 C40 232 33 220 34 204 C35 186 46 170 46 154 C46 140 42 124 38 108 L28 80 C24 70 26 63 32 60 C48 52 58 46 58 40 Z"
              fill={isDark ? '#271D17' : '#FBF7EF'}
              stroke={isDark ? '#EBCF8F' : '#8A672C'}
              strokeOpacity="0.65"
              strokeWidth="1.4"
              strokeLinejoin="round"
            />

            {/* Neckline & Tailoring Collar Detail */}
            <path
              d="M55 44 Q70 55 85 44"
              fill="none"
              stroke={isDark ? '#EBCF8F' : '#8A672C'}
              strokeOpacity="0.45"
              strokeWidth="1.1"
            />

            {/* 4 Live Anatomical Measurement Lines & Status Nodes */}
            {activeZones.map((zone) => {
              const coord = ZONE_SILHOUETTE_COORDS[zone.zone];
              const visual = ZONE_VISUAL_META[zone.status];
              const isHighlighted = hoveredZone === zone.zone;
              return (
                <g key={zone.zone}>
                  <line
                    x1={coord.leftX}
                    y1={coord.y}
                    x2={coord.rightX}
                    y2={coord.y}
                    stroke={visual.stroke}
                    strokeWidth={isHighlighted ? 2.6 : 1.8}
                    strokeOpacity={isHighlighted ? 1 : 0.85}
                    strokeDasharray={zone.status === 'RELAXED' ? '4 2.5' : undefined}
                  />
                  <circle
                    cx={coord.leftX}
                    cy={coord.y}
                    r={isHighlighted ? 4.2 : 3}
                    fill={visual.dotBg}
                  />
                  <circle
                    cx={coord.rightX}
                    cy={coord.y}
                    r={isHighlighted ? 4.2 : 3}
                    fill={visual.dotBg}
                  />
                  <text
                    x="70"
                    y={coord.y - 5}
                    textAnchor="middle"
                    fill={isDark ? '#FBF7EF' : '#1C1410'}
                    fillOpacity={isHighlighted ? 1 : 0.78}
                    fontSize="8.5"
                    fontWeight="600"
                    letterSpacing="0.06em"
                  >
                    {coord.shortLabel.toUpperCase()}
                  </text>
                </g>
              );
            })}
          </svg>
          <span
            className={`mt-1 rounded-full px-2 py-0.5 font-mono text-[9.5px] font-semibold ${
              isDark
                ? 'bg-[#2A1E17] text-[#EBCF8F]'
                : 'bg-[#1C1410] text-[#EBCF8F]'
            }`}
          >
            Size {selectedSize}
          </span>
        </div>

        {/* Right: 4-Zone Comfort Meter Stack */}
        <div className={compact ? 'space-y-1.5' : 'space-y-2.5'}>
          {activeZones.map((zone) => {
            const visual = ZONE_VISUAL_META[zone.status];
            const gaugePct = computeGaugePositionPct(zone);
            return (
              <div
                key={zone.zone}
                data-testid={`fit-zone-${zone.zone}`}
                data-fit-status={zone.status}
                onMouseEnter={() => setHoveredZone(zone.zone)}
                onMouseLeave={() => setHoveredZone(null)}
                className={`rounded-xl border transition-colors ${
                  compact ? 'px-2.5 py-1' : 'px-3 py-2'
                } ${
                  hoveredZone === zone.zone
                    ? isDark
                      ? 'border-[#EBCF8F]/55 bg-[#241A14]'
                      : 'border-[#8A672C]/55 bg-[#F4EBDA]/65'
                    : isDark
                      ? 'border-[#B08A4A]/20 bg-[#1E1611]'
                      : 'border-[#B08A4A]/20 bg-white'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5">
                    <span
                      className="h-2 w-2 shrink-0 rounded-full"
                      style={{ backgroundColor: visual.dotBg }}
                      aria-hidden="true"
                    />
                    <span
                      className={`font-medium ${
                        compact ? 'text-[11px]' : 'text-xs'
                      }`}
                    >
                      {zone.labelVi}
                    </span>
                    <span
                      data-testid={`fit-zone-ease-${zone.zone}`}
                      className={`font-mono ${
                        compact ? 'text-[10px]' : 'text-[11px]'
                      } ${isDark ? 'text-[#EBCF8F]' : 'text-[#8A672C]'}`}
                    >
                      {formatSignedEase(zone.easeCm)}
                    </span>
                  </div>

                  <span
                    data-testid={`fit-zone-status-${zone.zone}`}
                    className={`rounded-full border px-2 py-0.5 text-[9px] font-semibold tracking-[0.08em] uppercase ${
                      isDark ? visual.pillDark : visual.pillLight
                    }`}
                  >
                    {zone.statusVi}
                  </span>
                </div>

                {/* Live Comfort Spectrum Rail with Luxury Atelier Liquid Shimmer */}
                <div
                  className={`relative w-full overflow-hidden rounded-full bg-[#B08A4A]/20 ${
                    compact ? 'mt-1 h-1.5' : 'mt-1.5 h-2'
                  }`}
                >
                  {/* Ideal comfort target zone indicator (approx 38%..72%) */}
                  <div
                    className={`absolute top-0 bottom-0 left-[38%] w-[34%] ${
                      isDark ? 'bg-[#58B37D]/25' : 'bg-[#4E9A6F]/20'
                    }`}
                  />
                  <div
                    className="absolute top-0 bottom-0 left-0 overflow-hidden rounded-full transition-[width,background-color] duration-500 ease-[cubic-bezier(0.22,1,0.36,1)]"
                    style={{
                      width: `${gaugePct}%`,
                      backgroundColor: visual.barColor,
                    }}
                  >
                    <span
                      aria-hidden="true"
                      className="telemetry-anim telemetry-sheen opacity-65"
                    />
                  </div>
                </div>

                <div
                  className={`${compact ? 'mt-0.5' : 'mt-1'} flex items-center justify-between font-mono text-[9.5px] ${
                    isDark ? 'text-[#FBF7EF]/60' : 'text-[#7A6A5B]'
                  }`}
                >
                  <span>Cơ thể {zone.bodyCm}cm</span>
                  <span>Rập áo {zone.garmentCm}cm</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {estimatedMeasurements?.interpolated ? (
        <p
          className={`${compact ? 'mt-1.5 leading-snug' : 'mt-2.5 leading-relaxed'} text-[10px] ${
            isDark ? 'text-[#FBF7EF]/55' : 'text-[#7A6A5B]'
          }`}
        >
          Số đo 3 vòng ước tính từ chiều cao &amp; cân nặng (Ngực ~
          {estimatedMeasurements.bustCm} · Eo ~{estimatedMeasurements.waistCm} ·
          Hông ~{estimatedMeasurements.hipCm}cm). Nhập thêm 3 vòng nếu muốn tinh
          chỉnh sâu hơn.
        </p>
      ) : null}
    </div>
  );
}
