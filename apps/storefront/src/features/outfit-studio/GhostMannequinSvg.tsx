'use client';

import { useId, useMemo } from 'react';
import {
  buildMannequinTorsoPathD,
  buildMannequinUpperShoulderPaths,
  getMannequinHalfWidthAt,
  MANNEQUIN_METRICS,
  toStageX,
  toStageY,
} from './mannequinMetrics';

export interface CoveredTorsoRange {
  topY: number;
  bottomY: number;
}

export interface GhostMannequinSvgProps {
  className?: string;
  viewSide?: 'front' | 'back';
  /** Normalized [0..1] vertical span of torso covered by active garments */
  coveredTorsoRange?: CoveredTorsoRange | null;
  /** Maximum normalized [0..1] bottom Y of active garments for pedestal clipping */
  coveredMaxBottomY?: number;
  /** True when ONE_PIECE or TOP+BOTTOM fully covers the mannequin torso cage */
  occludeTorsoCage?: boolean;
}

/**
 * 2-Layer Dynamic Occlusion Couture Dressmaker Mannequin strictly built on
 * viewBox="0 0 600 900" from MANNEQUIN_METRICS:
 * - Layer A (`data-mannequin-layer="exposed-frame"`): turned wooden neck finial,
 *   collarbone, exposed upper shoulder curve down to yUpperBust (clipped above
 *   garment neckline), and lower brass pedestal & tripod stand clipped cleanly
 *   below `Math.max(yTorsoEnd, coveredMaxBottomY - 0.01)`.
 * - Layer B (`data-mannequin-layer="torso-cage"`): bust contours, princess seams,
 *   ribcage outline, waist ribbon, and hip wireframe — dynamically occluded
 *   across covered garment spans so ZERO wireframe ever leaks behind or outside
 *   a dress or full outfit.
 */
export function GhostMannequinSvg({
  className = 'h-full w-full',
  viewSide = 'front',
  coveredTorsoRange = null,
  coveredMaxBottomY = 0,
  occludeTorsoCage = false,
}: GhostMannequinSvgProps) {
  const uid = useId().replace(/:/g, '');
  const standClipId = `mannequin-stand-clip-${uid}`;
  const torsoClipId = `mannequin-torso-clip-${uid}`;

  const cx = toStageX(MANNEQUIN_METRICS.centerX); // 300
  const yFinial = toStageY(MANNEQUIN_METRICS.yFinial); // 94.5
  const yNeckBase = toStageY(MANNEQUIN_METRICS.yNeckBase); // 151.2
  const hwNeck = (MANNEQUIN_METRICS.wNeck * MANNEQUIN_METRICS.width) * 0.5; // 20.4
  const yShoulder = toStageY(MANNEQUIN_METRICS.yShoulder); // 184.5
  const hwShoulder = getMannequinHalfWidthAt(MANNEQUIN_METRICS.yShoulder) * MANNEQUIN_METRICS.width; // 91.5
  const yBust = toStageY(MANNEQUIN_METRICS.yBust); // 262.8
  const hwBust = getMannequinHalfWidthAt(MANNEQUIN_METRICS.yBust) * MANNEQUIN_METRICS.width; // 75.6
  const yWaist = toStageY(MANNEQUIN_METRICS.yWaist); // 373.5
  const hwWaist = getMannequinHalfWidthAt(MANNEQUIN_METRICS.yWaist) * MANNEQUIN_METRICS.width; // 54.6
  const yHip = toStageY(MANNEQUIN_METRICS.yHip); // 472.5
  const hwHip = getMannequinHalfWidthAt(MANNEQUIN_METRICS.yHip) * MANNEQUIN_METRICS.width; // 81.6
  const yTorsoEnd = toStageY(MANNEQUIN_METRICS.yTorsoEnd); // 526.5
  const hwTorsoEnd = getMannequinHalfWidthAt(MANNEQUIN_METRICS.yTorsoEnd) * MANNEQUIN_METRICS.width; // 72.6
  const yStandEnd = toStageY(MANNEQUIN_METRICS.yStandEnd); // 841.5

  const fullTorsoD = useMemo(
    () => buildMannequinTorsoPathD(MANNEQUIN_METRICS.yNeckBase, MANNEQUIN_METRICS.yTorsoEnd, 46),
    [],
  );

  // Determine torso-cage occlusion mode
  const isFullOccluded = Boolean(
    occludeTorsoCage ||
      (coveredTorsoRange &&
        coveredTorsoRange.topY <= MANNEQUIN_METRICS.yUpperBust + 0.03 &&
        coveredTorsoRange.bottomY >= MANNEQUIN_METRICS.yTorsoEnd - 0.025),
  );
  const isPartialOccluded = Boolean(!isFullOccluded && coveredTorsoRange);
  const occlusionState = isFullOccluded
    ? 'true'
    : isPartialOccluded
      ? 'partial'
      : 'false';

  // Upper exposed shoulder curve in Layer A: stops cleanly at the active neckline
  // (or yUpperBust = 0.252 for strapless gowns so upper shoulders show gracefully)
  const exposedShoulderStopY = coveredTorsoRange
    ? Math.min(MANNEQUIN_METRICS.yUpperBust, coveredTorsoRange.topY + 0.004)
    : MANNEQUIN_METRICS.yUpperBust;

  const showExposedShoulderCurve =
    exposedShoulderStopY > MANNEQUIN_METRICS.yNeckBase + 0.01;

  const upperShoulderPaths = useMemo(
    () =>
      showExposedShoulderCurve
        ? buildMannequinUpperShoulderPaths(exposedShoulderStopY, 18)
        : null,
    [exposedShoulderStopY, showExposedShoulderCurve],
  );

  // Layer A lower brass pedestal clip: starts strictly below garment hem
  const standClipStartNorm = Math.max(
    MANNEQUIN_METRICS.yTorsoEnd,
    coveredMaxBottomY > 0 ? coveredMaxBottomY - 0.01 : MANNEQUIN_METRICS.yTorsoEnd,
  );
  const standClipStartPx = Math.min(
    MANNEQUIN_METRICS.height,
    Math.max(yTorsoEnd, standClipStartNorm * MANNEQUIN_METRICS.height),
  );

  // Layer B torso-cage exposed clip rectangles (only uncovered vertical spans)
  const covTopPx = coveredTorsoRange
    ? Math.max(yNeckBase, (coveredTorsoRange.topY + 0.008) * MANNEQUIN_METRICS.height)
    : yNeckBase;
  const covBottomPx = coveredTorsoRange
    ? Math.min(
        yTorsoEnd + 24,
        (coveredTorsoRange.bottomY - 0.008) * MANNEQUIN_METRICS.height,
      )
    : yTorsoEnd + 24;

  // Pedestal geometry anchored between yTorsoEnd (526.5) and yStandEnd (841.5)
  const socketBottomY = yTorsoEnd + 20; // 546.5
  const hubY = yStandEnd - 86; // 755.5
  const midRingY = (socketBottomY + hubY) * 0.52;

  return (
    <svg
      viewBox="0 0 600 900"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      data-testid="ghost-mannequin-svg"
      data-torso-occluded={occlusionState}
      className={`pointer-events-none select-none ${className}`}
      style={{ opacity: 0.48 }}
    >
      <defs>
        {/* Clips Layer A lower pedestal & tripod stand cleanly below active garment hems */}
        <clipPath id={standClipId}>
          <rect
            x="0"
            y={standClipStartPx}
            width="600"
            height={Math.max(0, 900 - standClipStartPx)}
          />
        </clipPath>

        {/* Clips Layer B torso-cage to ONLY uncovered torso bands */}
        <clipPath id={torsoClipId}>
          {isFullOccluded ? (
            <rect x="0" y="0" width="0" height="0" />
          ) : isPartialOccluded && coveredTorsoRange ? (
            <>
              {covTopPx > yNeckBase + 4 ? (
                <rect
                  x="0"
                  y={yNeckBase - 4}
                  width="600"
                  height={Math.max(0, covTopPx - (yNeckBase - 4))}
                />
              ) : null}
              {covBottomPx < yTorsoEnd + 20 ? (
                <rect
                  x="0"
                  y={covBottomPx}
                  width="600"
                  height={Math.max(0, yTorsoEnd + 24 - covBottomPx)}
                />
              ) : null}
            </>
          ) : (
            <rect x="0" y="0" width="600" height="900" />
          )}
        </clipPath>
      </defs>

      {/* ===================================================================
          LAYER B: TORSO CAGE (Dynamically occluded whenever covered by dress / full outfit)
          =================================================================== */}
      <g
        data-mannequin-layer="torso-cage"
        data-occluded={occlusionState}
        clipPath={`url(#${torsoClipId})`}
        style={
          isFullOccluded
            ? { opacity: 0, visibility: 'hidden' }
            : { opacity: 1, visibility: 'visible' }
        }
      >
        {/* Subtle warm champagne volume glow inside dressmaker torso form */}
        <path d={`${fullTorsoD} Z`} fill="#EBCF8F" fillOpacity="0.16" />

        <g
          stroke="#B08A4A"
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          {/* Outer torso silhouette derived directly from MANNEQUIN_METRICS */}
          <path d={fullTorsoD} />

          {/* Armhole dress-form cap seams */}
          <path
            d={`M ${(cx - hwShoulder + 4).toFixed(1)} ${yShoulder.toFixed(1)} C ${(cx - hwShoulder - 3).toFixed(1)} ${(yShoulder + 24).toFixed(1)} ${(cx - hwBust - 4).toFixed(1)} ${(yBust - 8).toFixed(1)} ${(cx - hwBust + 8).toFixed(1)} ${(yBust + 12).toFixed(1)}`}
            strokeOpacity="0.65"
          />
          <path
            d={`M ${(cx + hwShoulder - 4).toFixed(1)} ${yShoulder.toFixed(1)} C ${(cx + hwShoulder + 3).toFixed(1)} ${(yShoulder + 24).toFixed(1)} ${(cx + hwBust + 4).toFixed(1)} ${(yBust - 8).toFixed(1)} ${(cx + hwBust - 8).toFixed(1)} ${(yBust + 12).toFixed(1)}`}
            strokeOpacity="0.65"
          />

          {/* Center vertical tailoring stitch line */}
          <line
            x1={cx}
            y1={yNeckBase + 14}
            x2={cx}
            y2={yTorsoEnd + 10}
            strokeDasharray={viewSide === 'back' ? '8 5' : '4 7'}
            strokeOpacity="0.72"
          />

          {viewSide === 'front' ? (
            <>
              {/* Subtle bust contours at yBust = 262.8 */}
              <path
                d={`M ${(cx - hwBust + 10).toFixed(1)} ${yBust.toFixed(1)} C ${(cx - hwBust * 0.62).toFixed(1)} ${(yBust + 20).toFixed(1)} ${(cx - 18).toFixed(1)} ${(yBust + 20).toFixed(1)} ${(cx - 8).toFixed(1)} ${(yBust + 2).toFixed(1)}`}
                strokeOpacity="0.62"
              />
              <path
                d={`M ${(cx + 8).toFixed(1)} ${(yBust + 2).toFixed(1)} C ${(cx + 18).toFixed(1)} ${(yBust + 20).toFixed(1)} ${(cx + hwBust * 0.62).toFixed(1)} ${(yBust + 20).toFixed(1)} ${(cx + hwBust - 10).toFixed(1)} ${yBust.toFixed(1)}`}
                strokeOpacity="0.62"
              />

              {/* Front couture princess seams */}
              <path
                d={`M ${(cx - 46).toFixed(1)} ${(yShoulder - 10).toFixed(1)} C ${(cx - 56).toFixed(1)} ${(yBust - 12).toFixed(1)} ${(cx - 48).toFixed(1)} ${(yBust + 42).toFixed(1)} ${(cx - 33).toFixed(1)} ${yWaist.toFixed(1)} C ${(cx - 42).toFixed(1)} ${(yHip - 24).toFixed(1)} ${(cx - 52).toFixed(1)} ${(yHip + 18).toFixed(1)} ${(cx - 46).toFixed(1)} ${(yTorsoEnd + 6).toFixed(1)}`}
                strokeOpacity="0.62"
              />
              <path
                d={`M ${(cx + 46).toFixed(1)} ${(yShoulder - 10).toFixed(1)} C ${(cx + 56).toFixed(1)} ${(yBust - 12).toFixed(1)} ${(cx + 48).toFixed(1)} ${(yBust + 42).toFixed(1)} ${(cx + 33).toFixed(1)} ${yWaist.toFixed(1)} C ${(cx + 42).toFixed(1)} ${(yHip - 24).toFixed(1)} ${(cx + 52).toFixed(1)} ${(yHip + 18).toFixed(1)} ${(cx + 46).toFixed(1)} ${(yTorsoEnd + 6).toFixed(1)}`}
                strokeOpacity="0.62"
              />
            </>
          ) : (
            <>
              {/* Back shoulder blade yoke & tailored back princess seams */}
              <path
                d={`M ${(cx - 72).toFixed(1)} ${(yShoulder + 34).toFixed(1)} C ${(cx - 38).toFixed(1)} ${(yShoulder + 44).toFixed(1)} ${(cx + 38).toFixed(1)} ${(yShoulder + 44).toFixed(1)} ${(cx + 72).toFixed(1)} ${(yShoulder + 34).toFixed(1)}`}
                strokeOpacity="0.54"
              />
              <path
                d={`M ${(cx - 44).toFixed(1)} ${(yShoulder - 8).toFixed(1)} C ${(cx - 46).toFixed(1)} ${yBust.toFixed(1)} ${(cx - 38).toFixed(1)} ${(yWaist - 34).toFixed(1)} ${(cx - 31).toFixed(1)} ${yWaist.toFixed(1)} C ${(cx - 38).toFixed(1)} ${(yHip - 16).toFixed(1)} ${(cx - 45).toFixed(1)} ${(yHip + 20).toFixed(1)} ${(cx - 42).toFixed(1)} ${(yTorsoEnd + 6).toFixed(1)}`}
                strokeOpacity="0.64"
              />
              <path
                d={`M ${(cx + 44).toFixed(1)} ${(yShoulder - 8).toFixed(1)} C ${(cx + 46).toFixed(1)} ${yBust.toFixed(1)} ${(cx + 38).toFixed(1)} ${(yWaist - 34).toFixed(1)} ${(cx + 31).toFixed(1)} ${yWaist.toFixed(1)} C ${(cx + 38).toFixed(1)} ${(yHip - 16).toFixed(1)} ${(cx + 45).toFixed(1)} ${(yHip + 20).toFixed(1)} ${(cx + 42).toFixed(1)} ${(yTorsoEnd + 6).toFixed(1)}`}
                strokeOpacity="0.64"
              />
            </>
          )}

          {/* Delicate couture waist ribbon band at yWaist = 373.5 */}
          <path
            d={`M ${(cx - hwWaist).toFixed(1)} ${(yWaist - 5).toFixed(1)} C ${(cx - 24).toFixed(1)} ${(yWaist + 4).toFixed(1)} ${(cx + 24).toFixed(1)} ${(yWaist + 4).toFixed(1)} ${(cx + hwWaist).toFixed(1)} ${(yWaist - 5).toFixed(1)}`}
          />
          <path
            d={`M ${(cx - hwWaist).toFixed(1)} ${(yWaist + 5).toFixed(1)} C ${(cx - 24).toFixed(1)} ${(yWaist + 14).toFixed(1)} ${(cx + 24).toFixed(1)} ${(yWaist + 14).toFixed(1)} ${(cx + hwWaist).toFixed(1)} ${(yWaist + 5).toFixed(1)}`}
          />
          <circle
            cx={cx}
            cy={yWaist + 5}
            r="3.2"
            fill="#B08A4A"
            fillOpacity="0.58"
          />

          {/* Hip construction guide line at yHip = 472.5 */}
          <path
            d={`M ${(cx - hwHip + 4).toFixed(1)} ${yHip.toFixed(1)} C ${(cx - 32).toFixed(1)} ${(yHip + 12).toFixed(1)} ${(cx + 32).toFixed(1)} ${(yHip + 12).toFixed(1)} ${(cx + hwHip - 4).toFixed(1)} ${yHip.toFixed(1)}`}
            strokeDasharray="3 7"
            strokeOpacity="0.55"
          />

          {/* Dress form linen bottom rim near yTorsoEnd = 526.5 */}
          <path
            d={`M ${(cx - hwTorsoEnd + 6).toFixed(1)} ${(yTorsoEnd - 12).toFixed(1)} C ${(cx - 28).toFixed(1)} ${(yTorsoEnd + 2).toFixed(1)} ${(cx + 28).toFixed(1)} ${(yTorsoEnd + 2).toFixed(1)} ${(cx + hwTorsoEnd - 6).toFixed(1)} ${(yTorsoEnd - 12).toFixed(1)}`}
            strokeOpacity="0.68"
          />
        </g>
      </g>

      {/* ===================================================================
          LAYER A: EXPOSED FRAME (Turned neck finial + upper collarbone/shoulders
          + lower brass pedestal & scrolled tripod stand clipped below garments)
          =================================================================== */}
      <g
        data-mannequin-layer="exposed-frame"
        stroke="#B08A4A"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {/* Turned wooden / brass neck finial centered at yFinial = 94.5 */}
        <circle
          cx={cx}
          cy={yFinial - 26}
          r="5.5"
          fill="#EBCF8F"
          fillOpacity="0.38"
        />
        <path
          d={`M ${(cx - 10).toFixed(1)} ${(yFinial - 20).toFixed(1)} C ${(cx - 16).toFixed(1)} ${(yFinial - 10).toFixed(1)} ${(cx - 16).toFixed(1)} ${(yFinial + 2).toFixed(1)} ${(cx - 8).toFixed(1)} ${(yFinial + 9).toFixed(1)} L ${(cx + 8).toFixed(1)} ${(yFinial + 9).toFixed(1)} C ${(cx + 16).toFixed(1)} ${(yFinial + 2).toFixed(1)} ${(cx + 16).toFixed(1)} ${(yFinial - 10).toFixed(1)} ${(cx + 10).toFixed(1)} ${(yFinial - 20).toFixed(1)} Z`}
          fill="#FBF7EF"
          fillOpacity="0.45"
        />
        {/* Neck finial flange rings */}
        <ellipse cx={cx} cy={yFinial + 13} rx="20" ry="4.5" />
        <path
          d={`M ${(cx - 17).toFixed(1)} ${(yFinial + 18).toFixed(1)} C ${(cx - 11).toFixed(1)} ${(yFinial + 24).toFixed(1)} ${(cx + 11).toFixed(1)} ${(yFinial + 24).toFixed(1)} ${(cx + 17).toFixed(1)} ${(yFinial + 18).toFixed(1)}`}
        />
        {/* Neck column down to yNeckBase = 151.2 */}
        <path
          d={`M ${(cx - hwNeck + 3.5).toFixed(1)} ${(yFinial + 22).toFixed(1)} L ${(cx - hwNeck).toFixed(1)} ${yNeckBase.toFixed(1)} C ${(cx - hwNeck).toFixed(1)} ${(yNeckBase + 9).toFixed(1)} ${(cx + hwNeck).toFixed(1)} ${(yNeckBase + 9).toFixed(1)} ${(cx + hwNeck).toFixed(1)} ${yNeckBase.toFixed(1)} L ${(cx + hwNeck - 3.5).toFixed(1)} ${(yFinial + 22).toFixed(1)}`}
        />
        {/* Delicate collarbone neckline curve */}
        <path
          d={`M ${(cx - hwNeck - 7).toFixed(1)} ${(yNeckBase + 9).toFixed(1)} C ${(cx - 14).toFixed(1)} ${(yNeckBase + 20).toFixed(1)} ${(cx + 14).toFixed(1)} ${(yNeckBase + 20).toFixed(1)} ${(cx + hwNeck + 7).toFixed(1)} ${(yNeckBase + 9).toFixed(1)}`}
          strokeOpacity="0.72"
        />

        {/* Exposed upper shoulder silhouette down to active neckline / yUpperBust */}
        {upperShoulderPaths ? (
          <g>
            <path d={upperShoulderPaths.leftD} />
            <path d={upperShoulderPaths.rightD} />
            {isFullOccluded ? (
              <line
                x1={cx}
                y1={yNeckBase + 18}
                x2={cx}
                y2={Math.max(yNeckBase + 22, toStageY(exposedShoulderStopY) - 6)}
                strokeDasharray="3 6"
                strokeOpacity="0.45"
              />
            ) : null}
          </g>
        ) : null}

        {/* Lower vintage brass pedestal & scrolled tripod stand clipped below garments */}
        <g clipPath={`url(#${standClipId})`}>
          {/* Lower brass socket collar at yTorsoEnd */}
          <path
            d={`M ${(cx - 15).toFixed(1)} ${(yTorsoEnd + 4).toFixed(1)} L ${(cx - 11).toFixed(1)} ${socketBottomY.toFixed(1)} L ${(cx + 11).toFixed(1)} ${socketBottomY.toFixed(1)} L ${(cx + 15).toFixed(1)} ${(yTorsoEnd + 4).toFixed(1)}`}
          />
          <ellipse cx={cx} cy={socketBottomY} rx="11.5" ry="3.4" />

          {/* Slender double-line brass stem */}
          <line x1={cx - 3} y1={socketBottomY + 2} x2={cx - 3} y2={hubY} />
          <line x1={cx + 3} y1={socketBottomY + 2} x2={cx + 3} y2={hubY} />

          {/* Decorative mid-pole turned ring */}
          <ellipse
            cx={cx}
            cy={midRingY}
            rx="8.5"
            ry="3"
            fill="#FBF7EF"
            fillOpacity="0.48"
          />

          {/* Tripod hub collar */}
          <path
            d={`M ${(cx - 11).toFixed(1)} ${(hubY - 4).toFixed(1)} C ${(cx - 11).toFixed(1)} ${(hubY + 7).toFixed(1)} ${(cx + 11).toFixed(1)} ${(hubY + 7).toFixed(1)} ${(cx + 11).toFixed(1)} ${(hubY - 4).toFixed(1)}`}
          />
          <circle
            cx={cx}
            cy={hubY + 6}
            r="6.5"
            fill="#EBCF8F"
            fillOpacity="0.38"
          />

          {/* Graceful scrolled tripod legs reaching yStandEnd = 841.5 */}
          <path
            d={`M ${(cx - 6).toFixed(1)} ${(hubY + 11).toFixed(1)} C ${(cx - 24).toFixed(1)} ${(hubY + 40).toFixed(1)} ${(cx - 58).toFixed(1)} ${(hubY + 48).toFixed(1)} ${(cx - 82).toFixed(1)} ${(yStandEnd - 15).toFixed(1)} C ${(cx - 90).toFixed(1)} ${(yStandEnd - 6).toFixed(1)} ${(cx - 82).toFixed(1)} ${(yStandEnd + 3).toFixed(1)} ${(cx - 72).toFixed(1)} ${(yStandEnd - 4).toFixed(1)}`}
          />
          <path
            d={`M ${(cx + 6).toFixed(1)} ${(hubY + 11).toFixed(1)} C ${(cx + 24).toFixed(1)} ${(hubY + 40).toFixed(1)} ${(cx + 58).toFixed(1)} ${(hubY + 48).toFixed(1)} ${(cx + 82).toFixed(1)} ${(yStandEnd - 15).toFixed(1)} C ${(cx + 90).toFixed(1)} ${(yStandEnd - 6).toFixed(1)} ${(cx + 82).toFixed(1)} ${(yStandEnd + 3).toFixed(1)} ${(cx + 72).toFixed(1)} ${(yStandEnd - 4).toFixed(1)}`}
          />
          <path
            d={`M ${cx} ${(hubY + 13).toFixed(1)} L ${cx} ${yStandEnd.toFixed(1)}`}
          />

          {/* Brass claw/ball feet */}
          <circle cx={cx - 80} cy={yStandEnd - 6} r="3.4" fill="#B08A4A" fillOpacity="0.62" />
          <circle cx={cx + 80} cy={yStandEnd - 6} r="3.4" fill="#B08A4A" fillOpacity="0.62" />
          <circle cx={cx} cy={yStandEnd} r="3.4" fill="#B08A4A" fillOpacity="0.62" />

          {/* Subtle floor grounding ellipse */}
          <ellipse
            cx={cx}
            cy={yStandEnd + 1}
            rx="98"
            ry="10.5"
            strokeOpacity="0.34"
            strokeDasharray="3 6"
          />
        </g>
      </g>
    </svg>
  );
}
