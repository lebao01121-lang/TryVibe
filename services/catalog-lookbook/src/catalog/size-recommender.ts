import {
  FitPreference,
  FitType,
  StretchLevel,
  type ProductFitStatsDto,
  type SizeChartDto,
  type SizeCode,
  type SizeMeasurementBreakdownItem,
  type SizeMeasurementRow,
  type SizeRecommendRequest,
  type SizeRecommendResponse,
} from '@atelier/contracts';

export type CanonicalSizeCode = 'XS' | 'S' | 'M' | 'L' | 'XL';
export type AnatomicalFitZoneName = 'shoulder' | 'chest' | 'waist' | 'hip';
export type AnatomicalFitStatus = 'TIGHT' | 'SNUG' | 'IDEAL' | 'RELAXED';
export type AnatomicalFitStatusVi =
  | 'CHẬT'
  | 'ÔM VỪA'
  | 'CHUẨN PHOM'
  | 'RỘNG THOẢI MÁI';
export type ExtendedStretchLevel = 'NONE' | 'LOW' | 'LIGHT' | 'MEDIUM' | 'HIGH';

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

export interface EstimatedBodyMeasurements {
  bustCm: number;
  waistCm: number;
  hipCm: number;
  shoulderCm: number;
  interpolated: boolean;
  interpolatedFields: Array<'bustCm' | 'waistCm' | 'hipCm' | 'shoulderCm'>;
}

export interface ExtendedSizeRecommendRequest extends SizeRecommendRequest {
  slug?: string;
  stretchLevel?: ExtendedStretchLevel;
}

export interface AnatomicalSizeRecommendResponse extends SizeRecommendResponse {
  fitZones: AnatomicalFitZone[];
  allSizesFitZones: AllSizesFitZones;
  estimatedMeasurements: EstimatedBodyMeasurements;
  rationaleVi: string;
  effectiveStretchLevel: ExtendedStretchLevel;
}

interface ScoredRow {
  row: SizeMeasurementRow;
  index: number;
  penalty: number;
  breakdown: SizeMeasurementBreakdownItem[];
  zones: AnatomicalFitZone[];
}

const CANONICAL_SIZES: readonly CanonicalSizeCode[] = ['XS', 'S', 'M', 'L', 'XL'];

const FALLBACK_BODY_TARGETS: Record<
  CanonicalSizeCode,
  { bustCm: number; waistCm: number; hipCm: number; shoulderCm: number }
> = {
  XS: { bustCm: 80, waistCm: 62, hipCm: 86, shoulderCm: 36 },
  S: { bustCm: 84, waistCm: 66, hipCm: 90, shoulderCm: 37.5 },
  M: { bustCm: 88, waistCm: 70, hipCm: 94, shoulderCm: 39 },
  L: { bustCm: 93, waistCm: 75, hipCm: 99, shoulderCm: 40.5 },
  XL: { bustCm: 98, waistCm: 80, hipCm: 104, shoulderCm: 42 },
};

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function formatHeightMetersVi(heightCm: number): string {
  const rounded = Math.round(heightCm);
  const meters = Math.floor(rounded / 100);
  const cm = String(rounded % 100).padStart(2, '0');
  return `${meters}m${cm}`;
}

export function normalizeStretchLevel(
  raw: string | undefined | null,
  fallback: StretchLevel = StretchLevel.NONE,
): ExtendedStretchLevel {
  const upper = typeof raw === 'string' ? raw.trim().toUpperCase() : '';
  if (
    upper === 'NONE' ||
    upper === 'LOW' ||
    upper === 'LIGHT' ||
    upper === 'MEDIUM' ||
    upper === 'HIGH'
  ) {
    return upper;
  }
  return fallback;
}

function getStretchToleranceCm(stretchLevel: ExtendedStretchLevel): number {
  switch (stretchLevel) {
    case 'HIGH':
      return 3.5;
    case 'MEDIUM':
      return 2.6;
    case 'LIGHT':
    case 'LOW':
      return 2.0;
    case 'NONE':
    default:
      return 1.2;
  }
}

function getStretchEaseBonusCm(
  stretchLevel: ExtendedStretchLevel,
  zone: AnatomicalFitZoneName,
): number {
  const isShoulder = zone === 'shoulder';
  switch (stretchLevel) {
    case 'HIGH':
      return isShoulder ? 0.8 : 2.5;
    case 'MEDIUM':
      return isShoulder ? 0.5 : 1.5;
    case 'LIGHT':
    case 'LOW':
      return isShoulder ? 0.3 : 0.8;
    case 'NONE':
    default:
      return 0;
  }
}

function getDesignEaseCm(fitType: FitType, zone: AnatomicalFitZoneName): number {
  if (zone === 'shoulder') {
    if (fitType === FitType.SLIM) return 0.5;
    if (fitType === FitType.RELAXED) return 1.8;
    if (fitType === FitType.OVERSIZE) return 2.8;
    return 1.1;
  }
  if (zone === 'waist') {
    if (fitType === FitType.SLIM) return 1.8;
    if (fitType === FitType.RELAXED) return 5.8;
    if (fitType === FitType.OVERSIZE) return 8.2;
    return 3.6;
  }
  // chest / hip
  if (fitType === FitType.SLIM) return 2.2;
  if (fitType === FitType.RELAXED) return 6.2;
  if (fitType === FitType.OVERSIZE) return 8.6;
  return 4.2;
}

/**
 * Anatomically interpolates missing 3-measurements + shoulder width from (heightCm, weightKg)
 * calibrated against TryVibe Atelier Vietnamese anthropometric standards.
 */
export function interpolateAnatomicalMeasurements(input: {
  heightCm: number;
  weightKg: number;
  bustCm?: number | null;
  waistCm?: number | null;
  hipCm?: number | null;
  shoulderCm?: number | null;
}): EstimatedBodyMeasurements {
  const estBust = round1(
    clamp(51.0 + 0.67 * input.weightKg + 0.06 * (input.heightCm - 162), 70, 130),
  );
  const estWaist = round1(
    clamp(33.5 + 0.67 * input.weightKg - 0.05 * (input.heightCm - 162), 54, 118),
  );
  const estHip = round1(
    clamp(57.0 + 0.68 * input.weightKg + 0.04 * (input.heightCm - 162), 76, 138),
  );
  const estShoulder = round1(
    clamp(19.5 + 0.15 * input.weightKg + 0.068 * input.heightCm, 32, 52),
  );

  const interpolatedFields: Array<'bustCm' | 'waistCm' | 'hipCm' | 'shoulderCm'> = [];

  const hasBust = typeof input.bustCm === 'number' && Number.isFinite(input.bustCm);
  const hasWaist = typeof input.waistCm === 'number' && Number.isFinite(input.waistCm);
  const hasHip = typeof input.hipCm === 'number' && Number.isFinite(input.hipCm);
  const hasShoulder =
    typeof input.shoulderCm === 'number' && Number.isFinite(input.shoulderCm);

  if (!hasBust) interpolatedFields.push('bustCm');
  if (!hasWaist) interpolatedFields.push('waistCm');
  if (!hasHip) interpolatedFields.push('hipCm');
  if (!hasShoulder) interpolatedFields.push('shoulderCm');

  return {
    bustCm: hasBust ? round1(input.bustCm!) : estBust,
    waistCm: hasWaist ? round1(input.waistCm!) : estWaist,
    hipCm: hasHip ? round1(input.hipCm!) : estHip,
    shoulderCm: hasShoulder ? round1(input.shoulderCm!) : estShoulder,
    interpolated: interpolatedFields.length > 0,
    interpolatedFields,
  };
}

function classifyZoneStatus(
  zone: AnatomicalFitZoneName,
  easeCm: number,
  stretchLevel: ExtendedStretchLevel,
): { status: AnatomicalFitStatus; statusVi: AnatomicalFitStatusVi } {
  const effectiveEase = easeCm + getStretchEaseBonusCm(stretchLevel, zone);
  if (zone === 'shoulder') {
    if (effectiveEase < 0.0) {
      return { status: 'TIGHT', statusVi: 'CHẬT' };
    }
    if (effectiveEase < 0.9) {
      return { status: 'SNUG', statusVi: 'ÔM VỪA' };
    }
    if (effectiveEase <= 2.4) {
      return { status: 'IDEAL', statusVi: 'CHUẨN PHOM' };
    }
    return { status: 'RELAXED', statusVi: 'RỘNG THOẢI MÁI' };
  }

  if (effectiveEase < 0.5) {
    return { status: 'TIGHT', statusVi: 'CHẬT' };
  }
  if (effectiveEase < 2.8) {
    return { status: 'SNUG', statusVi: 'ÔM VỪA' };
  }
  if (effectiveEase <= 6.8) {
    return { status: 'IDEAL', statusVi: 'CHUẨN PHOM' };
  }
  return { status: 'RELAXED', statusVi: 'RỘNG THOẢI MÁI' };
}

function computeZonesForSizeRow(params: {
  sizeCode: CanonicalSizeCode;
  row?: SizeMeasurementRow | null;
  body: EstimatedBodyMeasurements;
  fitType: FitType;
  stretchLevel: ExtendedStretchLevel;
  fitStats?: ProductFitStatsDto | null;
}): AnatomicalFitZone[] {
  const { sizeCode, row, body, fitType, stretchLevel, fitStats } = params;
  const fallback = FALLBACK_BODY_TARGETS[sizeCode];

  const hasCrowdSignal = Boolean(fitStats && fitStats.totalReviews >= 3);
  const runsSmallFactor =
    hasCrowdSignal && fitStats && fitStats.runsSmallPct >= 50
      ? clamp(fitStats.runsSmallPct / 65, 0.75, 1.35)
      : 0;
  const runsLargeFactor =
    hasCrowdSignal && fitStats && fitStats.runsLargePct >= 55
      ? clamp(fitStats.runsLargePct / 65, 0.75, 1.35)
      : 0;

  const zoneSpecs: Array<{
    zone: AnatomicalFitZoneName;
    labelVi: 'Vai' | 'Ngực' | 'Eo' | 'Hông';
    bodyCm: number;
    baseTargetCm: number;
  }> = [
    {
      zone: 'shoulder',
      labelVi: 'Vai',
      bodyCm: body.shoulderCm,
      baseTargetCm: row?.shoulderCm ?? fallback.shoulderCm,
    },
    {
      zone: 'chest',
      labelVi: 'Ngực',
      bodyCm: body.bustCm,
      baseTargetCm: row?.bustCm ?? fallback.bustCm,
    },
    {
      zone: 'waist',
      labelVi: 'Eo',
      bodyCm: body.waistCm,
      baseTargetCm: row?.waistCm ?? fallback.waistCm,
    },
    {
      zone: 'hip',
      labelVi: 'Hông',
      bodyCm: body.hipCm,
      baseTargetCm: row?.hipCm ?? fallback.hipCm,
    },
  ];

  return zoneSpecs.map((spec) => {
    const designEase = getDesignEaseCm(fitType, spec.zone);
    const crowdShift =
      runsSmallFactor > 0
        ? -(spec.zone === 'shoulder' ? 1.2 : 2.6) * runsSmallFactor
        : runsLargeFactor > 0
          ? (spec.zone === 'shoulder' ? 1.0 : 2.3) * runsLargeFactor
          : 0;

    const garmentCm = round1(spec.baseTargetCm + designEase + crowdShift);
    const easeCm = round1(garmentCm - spec.bodyCm);
    const { status, statusVi } = classifyZoneStatus(
      spec.zone,
      easeCm,
      stretchLevel,
    );

    return {
      zone: spec.zone,
      labelVi: spec.labelVi,
      status,
      statusVi,
      easeCm,
      bodyCm: spec.bodyCm,
      garmentCm,
    };
  });
}

function evaluateRangeMetric(
  metric: string,
  userValue: number,
  minVal: number,
  maxVal: number,
  unitScale: number,
): { penalty: number; item: SizeMeasurementBreakdownItem } {
  const midpoint = round1((minVal + maxVal) / 2);
  const delta = round1(userValue - midpoint);

  if (userValue < minVal) {
    const gap = minVal - userValue;
    return {
      penalty: (gap / unitScale) * 1.4,
      item: {
        metric,
        userValue,
        chartMin: minVal,
        chartMax: maxVal,
        chartTarget: midpoint,
        delta,
        verdict: 'RELAXED',
      },
    };
  }
  if (userValue > maxVal) {
    const gap = userValue - maxVal;
    return {
      penalty: (gap / unitScale) * 1.8,
      item: {
        metric,
        userValue,
        chartMin: minVal,
        chartMax: maxVal,
        chartTarget: midpoint,
        delta,
        verdict: 'TIGHT',
      },
    };
  }
  const halfSpan = Math.max(1, (maxVal - minVal) / 2);
  const offsetPenalty = (Math.abs(userValue - midpoint) / halfSpan) * 0.35;
  return {
    penalty: offsetPenalty,
    item: {
      metric,
      userValue,
      chartMin: minVal,
      chartMax: maxVal,
      chartTarget: midpoint,
      delta,
      verdict: 'IDEAL',
    },
  };
}

function evaluateTargetMetric(
  metric: string,
  userValue: number | null | undefined,
  chartTarget: number | null | undefined,
  toleranceCm: number,
  weight: number,
): { penalty: number; item: SizeMeasurementBreakdownItem } {
  if (
    userValue === null ||
    userValue === undefined ||
    chartTarget === null ||
    chartTarget === undefined
  ) {
    return {
      penalty: 0,
      item: {
        metric,
        userValue: userValue ?? null,
        chartTarget: chartTarget ?? null,
        delta: null,
        verdict: 'UNKNOWN',
      },
    };
  }

  const delta = round1(userValue - chartTarget);
  if (delta > toleranceCm) {
    return {
      penalty: ((delta - toleranceCm) / 2.2) * weight * 1.6,
      item: {
        metric,
        userValue,
        chartTarget,
        delta,
        verdict: 'TIGHT',
      },
    };
  }
  if (delta < -toleranceCm * 1.35) {
    return {
      penalty: ((Math.abs(delta) - toleranceCm) / 2.5) * weight,
      item: {
        metric,
        userValue,
        chartTarget,
        delta,
        verdict: 'RELAXED',
      },
    };
  }
  return {
    penalty: (Math.abs(delta) / Math.max(1.5, toleranceCm)) * 0.3 * weight,
    item: {
      metric,
      userValue,
      chartTarget,
      delta,
      verdict: 'IDEAL',
    },
  };
}

function buildAllSizesFitZones(params: {
  rows: readonly SizeMeasurementRow[];
  body: EstimatedBodyMeasurements;
  fitType: FitType;
  stretchLevel: ExtendedStretchLevel;
  fitStats?: ProductFitStatsDto | null;
}): AllSizesFitZones {
  const rowByCode = new Map<string, SizeMeasurementRow>();
  for (const row of params.rows) {
    rowByCode.set(row.sizeCode, row);
  }

  const out = {} as AllSizesFitZones;
  for (const code of CANONICAL_SIZES) {
    out[code] = computeZonesForSizeRow({
      sizeCode: code,
      row: rowByCode.get(code) ?? null,
      body: params.body,
      fitType: params.fitType,
      stretchLevel: params.stretchLevel,
      fitStats: params.fitStats,
    });
  }
  return out;
}

export function computeHonestSizeRecommendation(params: {
  request: ExtendedSizeRecommendRequest;
  sizeChart: SizeChartDto;
  fitType: FitType;
  stretchLevel: StretchLevel;
  fitCalibrationNote: string | null;
  fitStats?: ProductFitStatsDto | null;
  availableSizes?: readonly SizeCode[];
}): AnatomicalSizeRecommendResponse {
  const {
    request,
    sizeChart,
    fitType,
    stretchLevel: productStretchLevel,
    fitCalibrationNote,
    fitStats = null,
  } = params;

  const effectiveStretchLevel = normalizeStretchLevel(
    request.stretchLevel,
    productStretchLevel,
  );
  const estimatedMeasurements = interpolateAnatomicalMeasurements(request);
  const rows = sizeChart.rows;
  const allSizesFitZones = buildAllSizesFitZones({
    rows,
    body: estimatedMeasurements,
    fitType,
    stretchLevel: effectiveStretchLevel,
    fitStats,
  });

  if (rows.length === 0) {
    const fallbackSize: CanonicalSizeCode = 'M';
    const rationaleVi =
      'Sản phẩm chưa có bảng số đo chi tiết; hệ thống đối chiếu tạm theo tiêu chuẩn Atelier cỡ M.';
    return {
      recommendedSize: fallbackSize,
      confidence: 0.5,
      fitNotes: [rationaleVi],
      measurementBreakdown: [],
      alternatives: [],
      fitCalibrationNote,
      fitStats,
      crowdAdjusted: false,
      crowdAdjustmentReason: null,
      fitZones: allSizesFitZones[fallbackSize],
      allSizesFitZones,
      estimatedMeasurements,
      rationaleVi,
      effectiveStretchLevel,
    };
  }

  const toleranceCm = getStretchToleranceCm(effectiveStretchLevel);
  const hasExplicitBust = request.bustCm !== null && request.bustCm !== undefined;
  const hasExplicitWaist = request.waistCm !== null && request.waistCm !== undefined;
  const hasExplicitHip = request.hipCm !== null && request.hipCm !== undefined;
  const hasExplicitShoulder =
    request.shoulderCm !== null && request.shoulderCm !== undefined;

  const scored: ScoredRow[] = rows.map((row, index) => {
    const heightEval = evaluateRangeMetric(
      'heightCm',
      request.heightCm,
      row.heightMinCm,
      row.heightMaxCm,
      4.5,
    );
    const weightEval = evaluateRangeMetric(
      'weightKg',
      request.weightKg,
      row.weightMinKg,
      row.weightMaxKg,
      3.5,
    );

    const bustEval = evaluateTargetMetric(
      'bustCm',
      hasExplicitBust ? request.bustCm : estimatedMeasurements.bustCm,
      row.bustCm,
      toleranceCm,
      hasExplicitBust ? 1.5 : 0.35,
    );
    const waistEval = evaluateTargetMetric(
      'waistCm',
      hasExplicitWaist ? request.waistCm : estimatedMeasurements.waistCm,
      row.waistCm,
      toleranceCm,
      hasExplicitWaist ? 1.7 : 0.35,
    );
    const hipEval = evaluateTargetMetric(
      'hipCm',
      hasExplicitHip ? request.hipCm : estimatedMeasurements.hipCm,
      row.hipCm,
      toleranceCm,
      hasExplicitHip ? 1.4 : 0.3,
    );
    const shoulderEval = evaluateTargetMetric(
      'shoulderCm',
      hasExplicitShoulder
        ? request.shoulderCm
        : estimatedMeasurements.shoulderCm,
      row.shoulderCm,
      Math.max(1.0, toleranceCm * 0.65),
      hasExplicitShoulder ? 1.3 : 0.3,
    );

    let totalPenalty =
      heightEval.penalty * 0.9 +
      weightEval.penalty * 1.35 +
      bustEval.penalty +
      waistEval.penalty +
      hipEval.penalty +
      shoulderEval.penalty;

    const breakdown: SizeMeasurementBreakdownItem[] = [
      heightEval.item,
      weightEval.item,
      bustEval.item,
      waistEval.item,
      hipEval.item,
      shoulderEval.item,
    ];

    const tightCount = breakdown.filter((b) => b.verdict === 'TIGHT').length;
    if (effectiveStretchLevel === 'NONE' && tightCount > 0) {
      totalPenalty += tightCount * 0.75;
    }

    const canonicalCode = (
      CANONICAL_SIZES.includes(row.sizeCode as CanonicalSizeCode)
        ? row.sizeCode
        : 'M'
    ) as CanonicalSizeCode;

    return {
      row,
      index,
      penalty: totalPenalty,
      breakdown,
      zones: allSizesFitZones[canonicalCode],
    };
  });

  scored.sort((a, b) => a.penalty - b.penalty);
  let chosen = scored[0];

  const fitNotes: string[] = [];
  const hasAnyTight = chosen.breakdown.some((b) => b.verdict === 'TIGHT');
  const hasAnyRelaxed = chosen.breakdown.some((b) => b.verdict === 'RELAXED');
  const tightAnatomicalZones = chosen.zones.filter((z) => z.status === 'TIGHT');

  // Stage 3 Crowd Fit Calibration + Non-Stretch Tight Ease Auto Size-Up
  let crowdAdjusted = false;
  let crowdAdjustmentReason: string | null = null;
  let rationaleVi = '';

  const weightSpan = Math.max(
    1,
    chosen.row.weightMaxKg - chosen.row.weightMinKg,
  );
  const weightPosition =
    (request.weightKg - chosen.row.weightMinKg) / weightSpan;
  const sitsInUpperHalfOrBoundary =
    weightPosition >= 0.45 ||
    hasAnyTight ||
    tightAnatomicalZones.length > 0 ||
    chosen.breakdown.some((b) => b.delta !== null && b.delta > 0);

  const bodySummaryVi = `${formatHeightMetersVi(request.heightCm)} · ${Math.round(request.weightKg)}kg`;

  if (
    fitStats &&
    fitStats.totalReviews >= 3 &&
    fitStats.runsSmallPct >= 50 &&
    (request.fitPreference !== FitPreference.SLIM || sitsInUpperHalfOrBoundary) &&
    chosen.index + 1 < rows.length
  ) {
    const bumped = scored.find((s) => s.index === chosen.index + 1);
    if (bumped) {
      chosen = bumped;
      crowdAdjusted = true;
      crowdAdjustmentReason = `${fitStats.runsSmallPct}% khách có vóc dáng ${bodySummaryVi} đánh giá mẫu này hơi ôm vai và thân trên, xưởng khuyên chọn Size ${chosen.row.sizeCode} để cử động thoải mái.`;
      rationaleVi = crowdAdjustmentReason;
      fitNotes.push(crowdAdjustmentReason);
    }
  } else if (
    fitStats &&
    fitStats.totalReviews >= 3 &&
    fitStats.runsLargePct >= 55 &&
    request.fitPreference !== FitPreference.RELAXED &&
    chosen.index - 1 >= 0
  ) {
    const lowered = scored.find((s) => s.index === chosen.index - 1);
    if (lowered) {
      chosen = lowered;
      crowdAdjusted = true;
      crowdAdjustmentReason = `${fitStats.runsLargePct}% khách có vóc dáng ${bodySummaryVi} đánh giá mẫu này hơi rộng, xưởng khuyên chọn Size ${chosen.row.sizeCode} để phom dáng gọn gàng hơn.`;
      rationaleVi = crowdAdjustmentReason;
      fitNotes.push(crowdAdjustmentReason);
    }
  } else if (
    effectiveStretchLevel === 'NONE' &&
    tightAnatomicalZones.length > 0 &&
    request.fitPreference !== FitPreference.SLIM &&
    chosen.index + 1 < rows.length
  ) {
    const bumped = scored.find((s) => s.index === chosen.index + 1);
    if (bumped) {
      const tightLabel = tightAnatomicalZones.map((z) => z.labelVi.toLowerCase()).join(', ');
      chosen = bumped;
      rationaleVi = `Chất liệu không co giãn và vùng ${tightLabel} hơi sát ở cỡ tiêu chuẩn, xưởng khuyên chọn Size ${chosen.row.sizeCode} cho vóc dáng ${bodySummaryVi} để cử động thoải mái.`;
      fitNotes.push(rationaleVi);
    }
  } else if (
    request.fitPreference === FitPreference.RELAXED &&
    chosen.index + 1 < rows.length &&
    (hasAnyTight || effectiveStretchLevel === 'NONE')
  ) {
    const nextUp = scored.find((s) => s.index === chosen.index + 1);
    if (nextUp && nextUp.penalty - chosen.penalty <= 1.25) {
      chosen = nextUp;
      rationaleVi = `Đã nâng lên Size ${chosen.row.sizeCode} theo gu mặc thoải mái (RELAXED) và độ co giãn vải ${effectiveStretchLevel}.`;
      fitNotes.push(rationaleVi);
    }
  } else if (
    request.fitPreference === FitPreference.SLIM &&
    chosen.index - 1 >= 0 &&
    hasAnyRelaxed &&
    effectiveStretchLevel !== 'NONE'
  ) {
    const nextDown = scored.find((s) => s.index === chosen.index - 1);
    if (nextDown && nextDown.penalty - chosen.penalty <= 0.9) {
      chosen = nextDown;
      rationaleVi = `Đã tinh chỉnh xuống Size ${chosen.row.sizeCode} phù hợp gu mặc ôm vừa nhờ chất vải có độ co giãn (${effectiveStretchLevel}).`;
      fitNotes.push(rationaleVi);
    }
  }

  if (!rationaleVi) {
    if (fitStats && fitStats.totalReviews >= 3 && fitStats.runsSmallPct >= 50) {
      rationaleVi = `Size ${chosen.row.sizeCode} phù hợp nhất với vóc dáng ${bodySummaryVi} (${fitStats.runsSmallPct}% khách đánh giá mẫu này hơi ôm, cỡ ${chosen.row.sizeCode} đảm bảo độ thoáng vai và cử động).`;
    } else {
      rationaleVi = `Size ${chosen.row.sizeCode} khớp chuẩn rập ${sizeChart.name} cho vóc dáng ${bodySummaryVi} (phom ${fitType}, độ co giãn ${effectiveStretchLevel}).`;
    }
  }

  const providedMeasurements = [
    request.bustCm,
    request.waistCm,
    request.hipCm,
    request.shoulderCm,
  ].filter((v) => v !== null && v !== undefined).length;

  const baseConfidence =
    0.66 +
    Math.min(0.2, providedMeasurements * 0.05) +
    (fitStats && fitStats.totalReviews >= 3 ? 0.05 : 0);
  const penaltyDrop = Math.min(0.28, chosen.penalty * 0.075);
  const confidence = Number(
    Math.max(0.48, Math.min(0.96, baseConfidence - penaltyDrop)).toFixed(2),
  );

  fitNotes.push(
    `Đối chiếu theo ${sizeChart.name}: phom thiết kế ${fitType}, độ co giãn vải ${effectiveStretchLevel}.`,
  );
  if (estimatedMeasurements.interpolated) {
    fitNotes.push(
      `Số đo ước tính nội suy từ ${bodySummaryVi}: Ngực ~${estimatedMeasurements.bustCm}cm · Eo ~${estimatedMeasurements.waistCm}cm · Hông ~${estimatedMeasurements.hipCm}cm · Vai ~${estimatedMeasurements.shoulderCm}cm.`,
    );
  }
  if (fitCalibrationNote) {
    fitNotes.push(`Ghi chú cân chỉnh rập: ${fitCalibrationNote}`);
  }

  const alternatives: Array<{ sizeCode: SizeCode; reason: string }> = [];
  if (chosen.index + 1 < rows.length) {
    const larger = rows[chosen.index + 1];
    alternatives.push({
      sizeCode: larger.sizeCode,
      reason: `Chọn ${larger.sizeCode} nếu thích mặc rộng rãi hơn hoặc phối thêm lớp áo bên trong.`,
    });
  }
  if (chosen.index - 1 >= 0) {
    const smaller = rows[chosen.index - 1];
    alternatives.push({
      sizeCode: smaller.sizeCode,
      reason: `Chọn ${smaller.sizeCode} nếu thích dáng ôm sát hơn và số đo eo/vai gọn.`,
    });
  }

  const recommendedCanonical = (
    CANONICAL_SIZES.includes(chosen.row.sizeCode as CanonicalSizeCode)
      ? chosen.row.sizeCode
      : 'M'
  ) as CanonicalSizeCode;

  return {
    recommendedSize: chosen.row.sizeCode,
    confidence,
    fitNotes,
    measurementBreakdown: chosen.breakdown,
    alternatives,
    fitCalibrationNote,
    fitStats,
    crowdAdjusted,
    crowdAdjustmentReason,
    fitZones: allSizesFitZones[recommendedCanonical],
    allSizesFitZones,
    estimatedMeasurements,
    rationaleVi,
    effectiveStretchLevel,
  };
}
