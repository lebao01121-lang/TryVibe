import { describe, expect, it } from 'vitest';
import {
  FitPreference,
  FitType,
  Gender,
  SizeCode,
  StretchLevel,
  type ProductFitStatsDto,
  type SizeChartDto,
} from '@atelier/contracts';
import {
  computeHonestSizeRecommendation,
  interpolateAnatomicalMeasurements,
  normalizeStretchLevel,
} from './size-recommender';

const WOMEN_TOPS_CHART: SizeChartDto = {
  id: 'chart-women-tops-01',
  code: 'WOMEN_TOPS_ATELIER',
  name: 'Bảng size Áo & Blazer Nữ Atelier',
  gender: Gender.WOMEN,
  garmentCategory: 'TOP',
  fitNote: 'Form chuẩn rập Việt',
  rows: [
    {
      sizeCode: SizeCode.XS,
      heightMinCm: 150,
      heightMaxCm: 157,
      weightMinKg: 40,
      weightMaxKg: 46,
      bustCm: 80,
      waistCm: 62,
      hipCm: 86,
      shoulderCm: 36,
    },
    {
      sizeCode: SizeCode.S,
      heightMinCm: 155,
      heightMaxCm: 162,
      weightMinKg: 46,
      weightMaxKg: 52,
      bustCm: 84,
      waistCm: 66,
      hipCm: 90,
      shoulderCm: 37.5,
    },
    {
      sizeCode: SizeCode.M,
      heightMinCm: 160,
      heightMaxCm: 167,
      weightMinKg: 52,
      weightMaxKg: 58,
      bustCm: 88,
      waistCm: 70,
      hipCm: 94,
      shoulderCm: 39,
    },
    {
      sizeCode: SizeCode.L,
      heightMinCm: 163,
      heightMaxCm: 171,
      weightMinKg: 58,
      weightMaxKg: 65,
      bustCm: 93,
      waistCm: 75,
      hipCm: 99,
      shoulderCm: 40.5,
    },
    {
      sizeCode: SizeCode.XL,
      heightMinCm: 166,
      heightMaxCm: 176,
      weightMinKg: 65,
      weightMaxKg: 74,
      bustCm: 98,
      waistCm: 80,
      hipCm: 104,
      shoulderCm: 42,
    },
  ],
};

function makeFitStats(overrides: Partial<ProductFitStatsDto> = {}): ProductFitStatsDto {
  return {
    productId: 'prod-01',
    totalReviews: 12,
    averageRating: 4.8,
    trueToSizePct: 75,
    runsSmallPct: 15,
    runsLargePct: 10,
    dominantFeedback: 'TRUE_TO_SIZE',
    ...overrides,
  };
}

describe('size-recommender', () => {
  describe('normalizeStretchLevel', () => {
    it('normalizes valid stretch levels case-insensitively and falls back on unknown inputs', () => {
      expect(normalizeStretchLevel(' high ')).toBe('HIGH');
      expect(normalizeStretchLevel('medium')).toBe('MEDIUM');
      expect(normalizeStretchLevel('light')).toBe('LIGHT');
      expect(normalizeStretchLevel('low')).toBe('LOW');
      expect(normalizeStretchLevel('none')).toBe('NONE');
      expect(normalizeStretchLevel('ULTRA', StretchLevel.LIGHT)).toBe('LIGHT');
      expect(normalizeStretchLevel(undefined, StretchLevel.HIGH)).toBe('HIGH');
      expect(normalizeStretchLevel(null)).toBe('NONE');
    });
  });

  describe('interpolateAnatomicalMeasurements', () => {
    it('interpolates all missing measurements from height and weight', () => {
      const est = interpolateAnatomicalMeasurements({ heightCm: 164, weightKg: 55 });
      expect(est.interpolated).toBe(true);
      expect(est.interpolatedFields).toEqual(['bustCm', 'waistCm', 'hipCm', 'shoulderCm']);
      expect(est.bustCm).toBeGreaterThanOrEqual(70);
      expect(est.waistCm).toBeGreaterThanOrEqual(54);
      expect(est.hipCm).toBeGreaterThanOrEqual(76);
      expect(est.shoulderCm).toBeGreaterThanOrEqual(32);
    });

    it('preserves explicit measurements and only interpolates missing ones', () => {
      const est = interpolateAnatomicalMeasurements({
        heightCm: 164,
        weightKg: 55,
        bustCm: 89.26,
        waistCm: 69.8,
        hipCm: 94.1,
        shoulderCm: 39.2,
      });
      expect(est.interpolated).toBe(false);
      expect(est.interpolatedFields).toEqual([]);
      expect(est.bustCm).toBe(89.3);
      expect(est.waistCm).toBe(69.8);
      expect(est.hipCm).toBe(94.1);
      expect(est.shoulderCm).toBe(39.2);
    });
  });

  describe('computeHonestSizeRecommendation — weighted L1 anatomical penalty', () => {
    it('returns fallback size M with 0.5 confidence when size chart has no rows', () => {
      const result = computeHonestSizeRecommendation({
        request: {
          productSlug: 'ao-lua',
          heightCm: 162,
          weightKg: 54,
          fitPreference: FitPreference.REGULAR,
        },
        sizeChart: { ...WOMEN_TOPS_CHART, rows: [] },
        fitType: FitType.REGULAR,
        stretchLevel: StretchLevel.NONE,
        fitCalibrationNote: 'Cắt chuẩn',
      });

      expect(result.recommendedSize).toBe(SizeCode.M);
      expect(result.confidence).toBe(0.5);
      expect(result.crowdAdjusted).toBe(false);
      expect(result.measurementBreakdown).toEqual([]);
      expect(result.fitZones).toHaveLength(4);
      expect(result.allSizesFitZones.M).toHaveLength(4);
    });

    it('selects exact matching size M with high confidence when all 6 anatomical metrics match', () => {
      const result = computeHonestSizeRecommendation({
        request: {
          productSlug: 'blazer-linen',
          heightCm: 163,
          weightKg: 55,
          bustCm: 88,
          waistCm: 70,
          hipCm: 94,
          shoulderCm: 39,
          fitPreference: FitPreference.REGULAR,
        },
        sizeChart: WOMEN_TOPS_CHART,
        fitType: FitType.REGULAR,
        stretchLevel: StretchLevel.LIGHT,
        fitCalibrationNote: 'Phom thẳng tinh gọn',
        fitStats: makeFitStats({ totalReviews: 20, trueToSizePct: 85, runsSmallPct: 10, runsLargePct: 5 }),
      });

      expect(result.recommendedSize).toBe(SizeCode.M);
      expect(result.confidence).toBeGreaterThanOrEqual(0.85);
      expect(result.crowdAdjusted).toBe(false);
      expect(result.measurementBreakdown).toHaveLength(6);
      expect(result.measurementBreakdown.every((m) => m.verdict === 'IDEAL')).toBe(true);
      expect(result.alternatives.map((a) => a.sizeCode)).toEqual([SizeCode.L, SizeCode.S]);
      expect(result.fitNotes.some((n) => n.includes('Phom thẳng tinh gọn'))).toBe(true);
    });

    it('handles out-of-range petite and tall/heavy measurements safely with bounded confidence', () => {
      const petite = computeHonestSizeRecommendation({
        request: {
          productSlug: 'ao-lua',
          heightCm: 142,
          weightKg: 35,
          bustCm: 74,
          waistCm: 56,
          hipCm: 80,
          shoulderCm: 34,
          fitPreference: FitPreference.REGULAR,
        },
        sizeChart: WOMEN_TOPS_CHART,
        fitType: FitType.OVERSIZE,
        stretchLevel: StretchLevel.HIGH,
        fitCalibrationNote: null,
      });

      expect(petite.recommendedSize).toBe(SizeCode.XS);
      expect(petite.confidence).toBeGreaterThanOrEqual(0.48);
      expect(petite.confidence).toBeLessThanOrEqual(0.96);
      expect(petite.alternatives.map((a) => a.sizeCode)).toEqual([SizeCode.S]);

      const large = computeHonestSizeRecommendation({
        request: {
          productSlug: 'ao-lua',
          heightCm: 184,
          weightKg: 86,
          bustCm: 108,
          waistCm: 90,
          hipCm: 114,
          shoulderCm: 45,
          fitPreference: FitPreference.REGULAR,
        },
        sizeChart: WOMEN_TOPS_CHART,
        fitType: FitType.SLIM,
        stretchLevel: StretchLevel.NONE,
        fitCalibrationNote: null,
      });

      expect(large.recommendedSize).toBe(SizeCode.XL);
      expect(large.confidence).toBeGreaterThanOrEqual(0.48);
      expect(large.confidence).toBeLessThanOrEqual(0.96);
      expect(large.alternatives.map((a) => a.sizeCode)).toEqual([SizeCode.L]);
    });

    it('auto sizes up on non-stretch fabric when an anatomical zone is TIGHT', () => {
      const result = computeHonestSizeRecommendation({
        request: {
          productSlug: 'dam-lua-khong-co-gian',
          heightCm: 162,
          weightKg: 54,
          bustCm: 88,
          waistCm: 73,
          hipCm: 94,
          shoulderCm: 40.8, // tighter than M shoulder (39 + 0.5 slim ease = 39.5)
          fitPreference: FitPreference.REGULAR,
        },
        sizeChart: WOMEN_TOPS_CHART,
        fitType: FitType.SLIM,
        stretchLevel: StretchLevel.NONE,
        fitCalibrationNote: null,
      });

      expect(result.recommendedSize).toBe(SizeCode.L);
      expect(result.rationaleVi).toContain('không co giãn');
    });

    it('respects RELAXED fit preference size-up and SLIM fit preference size-down on stretchy fabric', () => {
      const relaxed = computeHonestSizeRecommendation({
        request: {
          productSlug: 'ao-linen',
          heightCm: 164,
          weightKg: 57,
          bustCm: 90,
          waistCm: 72,
          hipCm: 96,
          shoulderCm: 39.5,
          fitPreference: FitPreference.RELAXED,
        },
        sizeChart: WOMEN_TOPS_CHART,
        fitType: FitType.RELAXED,
        stretchLevel: StretchLevel.NONE,
        fitCalibrationNote: null,
      });
      expect(relaxed.recommendedSize).toBe(SizeCode.L);

      const slimStretchy = computeHonestSizeRecommendation({
        request: {
          productSlug: 'len-merino',
          heightCm: 161,
          weightKg: 52.5,
          bustCm: 84,
          waistCm: 66,
          hipCm: 90,
          shoulderCm: 38.5,
          fitPreference: FitPreference.SLIM,
          stretchLevel: 'HIGH',
        },
        sizeChart: WOMEN_TOPS_CHART,
        fitType: FitType.REGULAR,
        stretchLevel: StretchLevel.HIGH,
        fitCalibrationNote: null,
      });
      expect([SizeCode.S, SizeCode.M]).toContain(slimStretchy.recommendedSize);
      expect(slimStretchy.effectiveStretchLevel).toBe('HIGH');
    });

    it('handles rows with missing optional chart targets (UNKNOWN verdict)', () => {
      const sparseChart: SizeChartDto = {
        ...WOMEN_TOPS_CHART,
        rows: [
          {
            sizeCode: SizeCode.M,
            heightMinCm: 158,
            heightMaxCm: 168,
            weightMinKg: 50,
            weightMaxKg: 60,
            bustCm: null,
            waistCm: null,
            hipCm: null,
            shoulderCm: null,
          },
        ],
      };

      const res = computeHonestSizeRecommendation({
        request: {
          productSlug: 'freesize-shirt',
          heightCm: 163,
          weightKg: 55,
          fitPreference: FitPreference.REGULAR,
        },
        sizeChart: sparseChart,
        fitType: FitType.REGULAR,
        stretchLevel: StretchLevel.LIGHT,
        fitCalibrationNote: null,
      });

      expect(res.recommendedSize).toBe(SizeCode.M);
      expect(res.measurementBreakdown.filter((b) => b.verdict === 'UNKNOWN')).toHaveLength(4);
    });
  });

  describe('computeHonestSizeRecommendation — Crowd-Fit Calibration', () => {
    it('bumps recommended size up when verified reviews report runsSmallPct >= 50%', () => {
      const baseReq = {
        productSlug: 'blazer-om',
        heightCm: 163,
        weightKg: 55,
        bustCm: 88,
        waistCm: 70,
        hipCm: 94,
        shoulderCm: 39,
        fitPreference: FitPreference.REGULAR,
      };

      const baseline = computeHonestSizeRecommendation({
        request: baseReq,
        sizeChart: WOMEN_TOPS_CHART,
        fitType: FitType.REGULAR,
        stretchLevel: StretchLevel.LIGHT,
        fitCalibrationNote: null,
        fitStats: makeFitStats({ totalReviews: 10, trueToSizePct: 80, runsSmallPct: 10, runsLargePct: 10 }),
      });

      const runsSmall = computeHonestSizeRecommendation({
        request: baseReq,
        sizeChart: WOMEN_TOPS_CHART,
        fitType: FitType.REGULAR,
        stretchLevel: StretchLevel.LIGHT,
        fitCalibrationNote: null,
        fitStats: makeFitStats({
          totalReviews: 15,
          trueToSizePct: 25,
          runsSmallPct: 68,
          runsLargePct: 7,
          dominantFeedback: 'RUNS_SMALL',
        }),
      });

      expect(baseline.recommendedSize).toBe(SizeCode.M);
      expect(baseline.crowdAdjusted).toBe(false);

      expect(runsSmall.recommendedSize).toBe(SizeCode.L);
      expect(runsSmall.crowdAdjusted).toBe(true);
      expect(runsSmall.crowdAdjustmentReason).toContain('68%');
      expect(runsSmall.crowdAdjustmentReason).toContain('Size L');
      // Crowd signal also reduces effective ease on size M compared to baseline
      const baselineMChest = baseline.allSizesFitZones.M.find((z) => z.zone === 'chest')!;
      const smallMChest = runsSmall.allSizesFitZones.M.find((z) => z.zone === 'chest')!;
      expect(smallMChest.easeCm).toBeLessThan(baselineMChest.easeCm);
    });

    it('lowers recommended size down when verified reviews report runsLargePct >= 55%', () => {
      const runsLarge = computeHonestSizeRecommendation({
        request: {
          productSlug: 'ao-rong',
          heightCm: 163,
          weightKg: 55,
          bustCm: 88,
          waistCm: 70,
          hipCm: 94,
          shoulderCm: 39,
          fitPreference: FitPreference.REGULAR,
        },
        sizeChart: WOMEN_TOPS_CHART,
        fitType: FitType.REGULAR,
        stretchLevel: StretchLevel.LIGHT,
        fitCalibrationNote: null,
        fitStats: makeFitStats({
          totalReviews: 9,
          trueToSizePct: 30,
          runsSmallPct: 5,
          runsLargePct: 65,
          dominantFeedback: 'RUNS_LARGE',
        }),
      });

      expect(runsLarge.recommendedSize).toBe(SizeCode.S);
      expect(runsLarge.crowdAdjusted).toBe(true);
      expect(runsLarge.crowdAdjustmentReason).toContain('65%');
      expect(runsLarge.crowdAdjustmentReason).toContain('Size S');
    });

    it('does NOT trigger crowd adjustment when totalReviews < 3', () => {
      const res = computeHonestSizeRecommendation({
        request: {
          productSlug: 'ao-moi',
          heightCm: 163,
          weightKg: 55,
          bustCm: 88,
          waistCm: 70,
          hipCm: 94,
          shoulderCm: 39,
          fitPreference: FitPreference.REGULAR,
        },
        sizeChart: WOMEN_TOPS_CHART,
        fitType: FitType.REGULAR,
        stretchLevel: StretchLevel.LIGHT,
        fitCalibrationNote: null,
        fitStats: makeFitStats({ totalReviews: 2, runsSmallPct: 100, trueToSizePct: 0, runsLargePct: 0 }),
      });

      expect(res.recommendedSize).toBe(SizeCode.M);
      expect(res.crowdAdjusted).toBe(false);
    });

    it('keeps XL with runs-small rationale when already at largest size in chart', () => {
      const res = computeHonestSizeRecommendation({
        request: {
          productSlug: 'blazer-xl',
          heightCm: 173,
          weightKg: 71,
          bustCm: 98,
          waistCm: 80,
          hipCm: 104,
          shoulderCm: 42,
          fitPreference: FitPreference.REGULAR,
        },
        sizeChart: WOMEN_TOPS_CHART,
        fitType: FitType.REGULAR,
        stretchLevel: StretchLevel.LIGHT,
        fitCalibrationNote: null,
        fitStats: makeFitStats({ totalReviews: 8, runsSmallPct: 60, trueToSizePct: 30, runsLargePct: 10 }),
      });

      expect(res.recommendedSize).toBe(SizeCode.XL);
      expect(res.crowdAdjusted).toBe(false);
      expect(res.rationaleVi).toContain('60%');
    });
  });
});
