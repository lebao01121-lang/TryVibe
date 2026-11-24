const POSITIVE_KEYWORDS = [
  'đẹp',
  'mát',
  'rủ',
  'chuẩn',
  'sắc nét',
  'mềm',
  'tinh tế',
  'hài lòng',
  'ưng',
  'sang',
  'thoải mái',
  'thủ công',
  'chỉnh chu',
  'tôn dáng',
  'nhẹ',
  'mịn',
  'ấm',
  'tốt',
  'xuất sắc',
  'tuyệt',
] as const;

const NEGATIVE_KEYWORDS = [
  'hơi chật',
  'chật',
  'bó',
  'kích',
  'rộng quá',
  'nhăn',
  'kém',
  'xấu',
  'lỗi',
  'thất vọng',
  'ngứa',
  'cứng',
  'không vừa',
  'trả lại',
  'mỏng quá',
] as const;

/**
 * Computes a Vietnamese review sentiment score in [0.0, 1.0] from star rating
 * and positive/negative garment review keywords.
 */
export function computeVietnameseSentimentScore(rating: number, comment: string): number {
  const clampedRating = Math.min(5, Math.max(1, rating));
  // Rating 1 -> 0.16, 2 -> 0.34, 3 -> 0.52, 4 -> 0.72, 5 -> 0.88
  const ratingBaseMap: Record<number, number> = {
    1: 0.16,
    2: 0.34,
    3: 0.52,
    4: 0.72,
    5: 0.88,
  };
  let score = ratingBaseMap[clampedRating] ?? 0.7;

  const normalized = comment.normalize('NFC').toLowerCase();

  let positiveHits = 0;
  for (const kw of POSITIVE_KEYWORDS) {
    if (normalized.includes(kw)) {
      positiveHits += 1;
    }
  }

  let negativeHits = 0;
  for (const kw of NEGATIVE_KEYWORDS) {
    if (normalized.includes(kw)) {
      negativeHits += 1;
    }
  }

  score += Math.min(positiveHits, 4) * 0.03;
  score -= Math.min(negativeHits, 4) * 0.05;

  const clamped = Math.min(1, Math.max(0, score));
  return Math.round(clamped * 100) / 100;
}
