/**
 * Single Source of Truth for Atelier Dressmaker Mannequin Proportions.
 * All normalized coordinates are in [0..1] on a canonical 600 × 900 canvas.
 * Shared across GhostMannequinSvg, autoCalibrateGarment, AutoFittedGarmentCanvas,
 * GarmentLayerStage pin anchors, and OffscreenCanvas composite snapshots.
 */

export const MANNEQUIN_METRICS = {
  width: 600,
  height: 900,
  centerX: 0.5,
  yFinial: 0.105,
  yNeckBase: 0.168,
  wNeck: 0.068,
  yShoulder: 0.205,
  wShoulder: 0.305,
  yUpperBust: 0.252,
  wUpperBust: 0.258,
  yBust: 0.292,
  wBust: 0.252,
  yWaist: 0.415,
  wWaist: 0.182,
  yHip: 0.525,
  wHip: 0.272,
  yTorsoEnd: 0.585,
  yMidi: 0.745,
  yMaxi: 0.885,
  yStandEnd: 0.935,
} as const;

export const MANNEQUIN_NECK_TOP_Y = 0.132;
export const MANNEQUIN_TORSO_END_WIDTH = 0.242;

interface WidthKnot {
  readonly y: number;
  readonly w: number;
}

/**
 * Anatomical dressmaker silhouette knots matching MANNEQUIN_METRICS exactly.
 * Monotone cubic Hermite (Fritsch-Carlson) interpolation guarantees C1 smoothness
 * with zero overshoot and exact passage through neck, shoulder, bust, waist, and hip.
 */
const TORSO_KNOTS: readonly WidthKnot[] = [
  { y: MANNEQUIN_NECK_TOP_Y, w: 0.056 },
  { y: MANNEQUIN_METRICS.yNeckBase, w: MANNEQUIN_METRICS.wNeck },
  { y: 0.184, w: 0.195 },
  { y: MANNEQUIN_METRICS.yShoulder, w: MANNEQUIN_METRICS.wShoulder },
  { y: 0.228, w: 0.292 },
  { y: MANNEQUIN_METRICS.yUpperBust, w: MANNEQUIN_METRICS.wUpperBust },
  { y: MANNEQUIN_METRICS.yBust, w: MANNEQUIN_METRICS.wBust },
  { y: 0.354, w: 0.214 },
  { y: MANNEQUIN_METRICS.yWaist, w: MANNEQUIN_METRICS.wWaist },
  { y: 0.468, w: 0.236 },
  { y: MANNEQUIN_METRICS.yHip, w: MANNEQUIN_METRICS.wHip },
  { y: 0.562, w: 0.264 },
  { y: MANNEQUIN_METRICS.yTorsoEnd, w: MANNEQUIN_TORSO_END_WIDTH },
];

// Precompute Fritsch-Carlson monotone Hermite tangents once at module load
const TORSO_TANGENTS: readonly number[] = (() => {
  const n = TORSO_KNOTS.length;
  const secants: number[] = new Array(n - 1).fill(0);
  for (let i = 0; i < n - 1; i += 1) {
    const k0 = TORSO_KNOTS[i]!;
    const k1 = TORSO_KNOTS[i + 1]!;
    secants[i] = (k1.w - k0.w) / (k1.y - k0.y);
  }

  const m: number[] = new Array(n).fill(0);
  m[0] = secants[0]!;
  m[n - 1] = secants[n - 2]!;

  for (let i = 1; i < n - 1; i += 1) {
    const dPrev = secants[i - 1]!;
    const dNext = secants[i]!;
    if (dPrev * dNext <= 0) {
      // Local extremum (e.g., shoulder peak, cinched waist, hip apex) -> horizontal tangent
      m[i] = 0;
    } else {
      m[i] = (dPrev + dNext) * 0.5;
    }
  }

  // Enforce monotonicity constraints to eliminate any cubic overshoot
  for (let i = 0; i < n - 1; i += 1) {
    const d = secants[i]!;
    if (Math.abs(d) < 1e-6) {
      m[i] = 0;
      m[i + 1] = 0;
    } else {
      const a = m[i]! / d;
      const b = m[i + 1]! / d;
      const h = Math.hypot(a, b);
      if (h > 3) {
        const scale = 3 / h;
        m[i] = scale * a * d;
        m[i + 1] = scale * b * d;
      }
    }
  }

  return m;
})();

/**
 * Returns the exact normalized horizontal width [0..1] of the dressmaker mannequin
 * at normalized vertical coordinate `y` [0..1].
 * Outside the torso span [0.132..0.585], returns 0.
 */
export function getMannequinWidthAt(y: number): number {
  const first = TORSO_KNOTS[0]!;
  const last = TORSO_KNOTS[TORSO_KNOTS.length - 1]!;

  if (y < first.y || y > last.y) {
    return 0;
  }
  if (y === first.y) return first.w;
  if (y === last.y) return last.w;

  for (let i = 0; i < TORSO_KNOTS.length - 1; i += 1) {
    const k0 = TORSO_KNOTS[i]!;
    const k1 = TORSO_KNOTS[i + 1]!;
    if (y >= k0.y && y <= k1.y) {
      const h = k1.y - k0.y;
      const t = (y - k0.y) / h;
      const t2 = t * t;
      const t3 = t2 * t;
      const h00 = 2 * t3 - 3 * t2 + 1;
      const h10 = t3 - 2 * t2 + t;
      const h01 = -2 * t3 + 3 * t2;
      const h11 = t3 - t2;
      const val =
        h00 * k0.w +
        h10 * h * TORSO_TANGENTS[i]! +
        h01 * k1.w +
        h11 * h * TORSO_TANGENTS[i + 1]!;
      return Math.max(0, val);
    }
  }

  return 0;
}

/**
 * Returns exact normalized half-width from centerX = 0.50 at vertical coordinate `y`.
 */
export function getMannequinHalfWidthAt(y: number): number {
  return getMannequinWidthAt(y) * 0.5;
}

/**
 * Converts normalized [0..1] coordinates into canonical 600 × 900 SVG/Canvas pixels.
 */
export function toStageX(normX: number): number {
  return normX * MANNEQUIN_METRICS.width;
}

export function toStageY(normY: number): number {
  return normY * MANNEQUIN_METRICS.height;
}

/**
 * Builds the exact SVG path for the closed couture dressmaker torso silhouette
 * directly from `getMannequinHalfWidthAt(y)`, guaranteeing 0.0px drift between
 * GhostMannequinSvg and AutoFitMannequinEngine.
 */
export function buildMannequinTorsoPathD(
  yStart: number = MANNEQUIN_METRICS.yNeckBase,
  yEnd: number = MANNEQUIN_METRICS.yTorsoEnd,
  steps = 44,
): string {
  const cx = toStageX(MANNEQUIN_METRICS.centerX);
  const clampedStart = Math.max(MANNEQUIN_NECK_TOP_Y, yStart);
  const clampedEnd = Math.min(MANNEQUIN_METRICS.yTorsoEnd, yEnd);
  const leftPts: Array<[number, number]> = [];
  const rightPts: Array<[number, number]> = [];

  for (let i = 0; i <= steps; i += 1) {
    const yNorm = clampedStart + ((clampedEnd - clampedStart) * i) / steps;
    const hwPx = getMannequinHalfWidthAt(yNorm) * MANNEQUIN_METRICS.width;
    const yPx = toStageY(yNorm);
    leftPts.push([cx - hwPx, yPx]);
    rightPts.push([cx + hwPx, yPx]);
  }

  const parts: string[] = [];
  const firstLeft = leftPts[0]!;
  parts.push(`M ${firstLeft[0].toFixed(2)} ${firstLeft[1].toFixed(2)}`);
  for (let i = 1; i < leftPts.length; i += 1) {
    const p = leftPts[i]!;
    parts.push(`L ${p[0].toFixed(2)} ${p[1].toFixed(2)}`);
  }

  // Gentle curved bottom linen hem closing left torso end to right torso end
  const lastLeft = leftPts[leftPts.length - 1]!;
  const lastRight = rightPts[rightPts.length - 1]!;
  const bottomDrop = clampedEnd >= MANNEQUIN_METRICS.yTorsoEnd - 0.005 ? 16 : 6;
  parts.push(
    `Q ${cx.toFixed(2)} ${(lastLeft[1] + bottomDrop).toFixed(2)} ${lastRight[0].toFixed(2)} ${lastRight[1].toFixed(2)}`,
  );

  for (let i = rightPts.length - 2; i >= 0; i -= 1) {
    const p = rightPts[i]!;
    parts.push(`L ${p[0].toFixed(2)} ${p[1].toFixed(2)}`);
  }

  return parts.join(' ');
}

/**
 * Builds the exact left and right upper-shoulder contour paths from neck base
 * down to `yStop` (e.g., yUpperBust = 0.252) for Layer A exposed mannequin frame.
 */
export function buildMannequinUpperShoulderPaths(
  yStop: number = MANNEQUIN_METRICS.yUpperBust,
  steps = 18,
): { leftD: string; rightD: string } {
  const cx = toStageX(MANNEQUIN_METRICS.centerX);
  const yStart = MANNEQUIN_METRICS.yNeckBase;
  const clampedStop = Math.max(yStart + 0.005, Math.min(MANNEQUIN_METRICS.yTorsoEnd, yStop));
  const leftParts: string[] = [];
  const rightParts: string[] = [];

  for (let i = 0; i <= steps; i += 1) {
    const yNorm = yStart + ((clampedStop - yStart) * i) / steps;
    const hwPx = getMannequinHalfWidthAt(yNorm) * MANNEQUIN_METRICS.width;
    const yPx = toStageY(yNorm);
    const cmd = i === 0 ? 'M' : 'L';
    leftParts.push(`${cmd} ${(cx - hwPx).toFixed(2)} ${yPx.toFixed(2)}`);
    rightParts.push(`${cmd} ${(cx + hwPx).toFixed(2)} ${yPx.toFixed(2)}`);
  }

  return {
    leftD: leftParts.join(' '),
    rightD: rightParts.join(' '),
  };
}
