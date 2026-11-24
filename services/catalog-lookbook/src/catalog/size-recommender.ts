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

interface ScoredRow {
  row: SizeMeasurementRow;
  index: number;
  penalty: number;
  breakdown: SizeMeasurementBreakdownItem[];
}

function getStretchToleranceCm(stretchLevel: StretchLevel): number {
  switch (stretchLevel) {
    case StretchLevel.HIGH:
      return 3.5;
    case StretchLevel.LIGHT:
      return 2.0;
    case StretchLevel.NONE:
    default:
      return 1.2;
  }
}

function evaluateRangeMetric(
  metric: string,
  userValue: number,
  minVal: number,
  maxVal: number,
  unitScale: number,
): { penalty: number; item: SizeMeasurementBreakdownItem } {
  const midpoint = Number(((minVal + maxVal) / 2).toFixed(1));
  const delta = Number((userValue - midpoint).toFixed(1));

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

  const delta = Number((userValue - chartTarget).toFixed(1));
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

export function computeHonestSizeRecommendation(params: {
  request: SizeRecommendRequest;
  sizeChart: SizeChartDto;
  fitType: FitType;
  stretchLevel: StretchLevel;
  fitCalibrationNote: string | null;
  fitStats?: ProductFitStatsDto | null;
  availableSizes?: readonly SizeCode[];
}): SizeRecommendResponse {
  const {
    request,
    sizeChart,
    fitType,
    stretchLevel,
    fitCalibrationNote,
    fitStats = null,
  } = params;
  const rows = sizeChart.rows;
  if (rows.length === 0) {
    return {
      recommendedSize: 'M',
      confidence: 0.5,
      fitNotes: ['Sản phẩm chưa có bảng số đo chi tiết; đề xuất cỡ M tiêu chuẩn.'],
      measurementBreakdown: [],
      alternatives: [],
      fitCalibrationNote,
      fitStats,
      crowdAdjusted: false,
      crowdAdjustmentReason: null,
    };
  }

  const toleranceCm = getStretchToleranceCm(stretchLevel);
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
      request.bustCm,
      row.bustCm,
      toleranceCm,
      1.5,
    );
    const waistEval = evaluateTargetMetric(
      'waistCm',
      request.waistCm,
      row.waistCm,
      toleranceCm,
      1.7,
    );
    const hipEval = evaluateTargetMetric(
      'hipCm',
      request.hipCm,
      row.hipCm,
      toleranceCm,
      1.4,
    );
    const shoulderEval = evaluateTargetMetric(
      'shoulderCm',
      request.shoulderCm,
      row.shoulderCm,
      Math.max(1.0, toleranceCm * 0.65),
      1.3,
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
    if (stretchLevel === StretchLevel.NONE && tightCount > 0) {
      totalPenalty += tightCount * 0.75;
    }

    return { row, index, penalty: totalPenalty, breakdown };
  });

  scored.sort((a, b) => a.penalty - b.penalty);
  let chosen = scored[0];

  const fitNotes: string[] = [];
  const hasAnyTight = chosen.breakdown.some((b) => b.verdict === 'TIGHT');
  const hasAnyRelaxed = chosen.breakdown.some((b) => b.verdict === 'RELAXED');

  // Phase 3 Crowd Fit Calibration using real Verified Fit Reviews statistics
  let crowdAdjusted = false;
  let crowdAdjustmentReason: string | null = null;

  const weightSpan = Math.max(
    1,
    chosen.row.weightMaxKg - chosen.row.weightMinKg,
  );
  const weightPosition =
    (request.weightKg - chosen.row.weightMinKg) / weightSpan;
  const sitsInUpperHalfOrBoundary =
    weightPosition >= 0.45 ||
    hasAnyTight ||
    chosen.breakdown.some((b) => b.delta !== null && b.delta > 0);

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
      crowdAdjustmentReason = `${fitStats.runsSmallPct}% người mua mẫu này đánh giá form hơi ôm, hệ thống gợi ý nhích lên Size ${chosen.row.sizeCode} để thoải mái vai và cử động.`;
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
      crowdAdjustmentReason = `${fitStats.runsLargePct}% người mua mẫu này đánh giá form hơi rộng, hệ thống gợi ý lùi xuống Size ${chosen.row.sizeCode} để phom dáng gọn gàng hơn.`;
      fitNotes.push(crowdAdjustmentReason);
    }
  } else if (
    request.fitPreference === FitPreference.RELAXED &&
    chosen.index + 1 < rows.length &&
    (hasAnyTight || stretchLevel === StretchLevel.NONE)
  ) {
    const nextUp = scored.find((s) => s.index === chosen.index + 1);
    if (nextUp && nextUp.penalty - chosen.penalty <= 1.25) {
      chosen = nextUp;
      fitNotes.push(
        `Đã nâng lên cỡ ${chosen.row.sizeCode} theo sở thích mặc thoải mái (RELAXED) và độ co giãn ${stretchLevel}.`,
      );
    }
  } else if (
    request.fitPreference === FitPreference.SLIM &&
    chosen.index - 1 >= 0 &&
    hasAnyRelaxed &&
    stretchLevel !== StretchLevel.NONE
  ) {
    const nextDown = scored.find((s) => s.index === chosen.index - 1);
    if (nextDown && nextDown.penalty - chosen.penalty <= 0.9) {
      chosen = nextDown;
      fitNotes.push(
        `Đã tinh chỉnh xuống cỡ ${chosen.row.sizeCode} phù hợp gu mặc gọn dáng (SLIM) nhờ chất vải co giãn ${stretchLevel}.`,
      );
    }
  }

  const providedMeasurements = [
    request.bustCm,
    request.waistCm,
    request.hipCm,
    request.shoulderCm,
  ].filter((v) => v !== null && v !== undefined).length;

  const baseConfidence =
    0.64 +
    Math.min(0.22, providedMeasurements * 0.055) +
    (fitStats && fitStats.totalReviews >= 3 ? 0.05 : 0);
  const penaltyDrop = Math.min(0.3, chosen.penalty * 0.08);
  const confidence = Number(
    Math.max(0.45, Math.min(0.96, baseConfidence - penaltyDrop)).toFixed(2),
  );

  fitNotes.push(
    `Đối chiếu theo ${sizeChart.name}: phom thiết kế ${fitType}, độ co giãn vải ${stretchLevel}.`,
  );
  if (providedMeasurements === 0) {
    fitNotes.push(
      'Đề xuất dựa trên chiều cao & cân nặng; bổ sung thêm số đo vòng ngực/eo/hông để tăng độ chính xác.',
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
  };
}
