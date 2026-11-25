import { loadImageCorsSafe, prepareCleanGarment } from './garmentCleanPrep';
import {
  LIGHTING_PRESET_META,
  TRYON_FRAME_HEIGHT,
  TRYON_FRAME_WIDTH,
  type LightingPresetId,
  type NormalizedPoseLandmark,
  type PreparedGarmentAsset,
  type SessionPersonFrame,
  type TryOnGarmentSlot,
  type TryOnSynthesisGarmentInput,
} from './types';

export interface LocalCompositeParams {
  personFrame: SessionPersonFrame;
  garments: TryOnSynthesisGarmentInput[];
  lightingPreset: LightingPresetId;
  onStageChange?: (stageIndex: number) => void;
}

export interface LocalCompositeOutput {
  resultDataUrl: string;
  cleanCollarApplied: boolean;
}

interface ResolvedBodyMetrics {
  noseX: number;
  noseY: number;
  leftEarX: number;
  leftEarY: number;
  rightEarX: number;
  rightEarY: number;
  mouthMidX: number;
  mouthMidY: number;
  chinY: number;
  leftShoulderX: number;
  leftShoulderY: number;
  rightShoulderX: number;
  rightShoulderY: number;
  shoulderMidX: number;
  shoulderMidY: number;
  shoulderSpanPx: number;
  shoulderTiltRad: number;
  leftHipX: number;
  leftHipY: number;
  rightHipX: number;
  rightHipY: number;
  hipMidX: number;
  hipMidY: number;
  hipSpanPx: number;
  torsoHeightPx: number;
  earSpanPx: number;
}

const SLOT_LAYER_ORDER: Record<TryOnGarmentSlot, number> = {
  lower: 0,
  onePiece: 1,
  upper: 2,
  outerwear: 3,
};

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function getValidLandmark(
  landmarks: readonly NormalizedPoseLandmark[],
  index: number,
  fallbackX: number,
  fallbackY: number,
): { x: number; y: number } {
  const lm = landmarks[index];
  if (
    lm &&
    Number.isFinite(lm.x) &&
    Number.isFinite(lm.y) &&
    lm.visibility >= 0.25 &&
    lm.x > 0.01 &&
    lm.x < 0.99 &&
    lm.y > 0.01 &&
    lm.y < 0.99
  ) {
    return { x: lm.x, y: lm.y };
  }
  return { x: fallbackX, y: fallbackY };
}

/**
 * Extracts image-space left/right ordered anatomical body metrics from 33 MediaPipe landmarks.
 * Always normalizes image-left (`x` smaller) vs image-right (`x` larger) so real webcam,
 * mirrored mirror captures, and preset landmarks never flip 180°.
 */
function resolveBodyMetrics(
  landmarks: readonly NormalizedPoseLandmark[],
  w: number,
  h: number,
): ResolvedBodyMetrics {
  const nose = getValidLandmark(landmarks, 0, 0.5, 0.2);

  const earA = getValidLandmark(landmarks, 7, nose.x - 0.075, nose.y - 0.01);
  const earB = getValidLandmark(landmarks, 8, nose.x + 0.075, nose.y - 0.01);
  const imgLeftEar = earA.x <= earB.x ? earA : earB;
  const imgRightEar = earA.x <= earB.x ? earB : earA;

  const mouthA = getValidLandmark(landmarks, 9, nose.x - 0.025, nose.y + 0.042);
  const mouthB = getValidLandmark(landmarks, 10, nose.x + 0.025, nose.y + 0.042);

  const shA = getValidLandmark(landmarks, 11, 0.36, 0.35);
  const shB = getValidLandmark(landmarks, 12, 0.64, 0.35);
  const imgLeftSh = shA.x <= shB.x ? shA : shB;
  const imgRightSh = shA.x <= shB.x ? shB : shA;

  const hipA = getValidLandmark(landmarks, 23, imgLeftSh.x + 0.04, 0.65);
  const hipB = getValidLandmark(landmarks, 24, imgRightSh.x - 0.04, 0.65);
  const imgLeftHip = hipA.x <= hipB.x ? hipA : hipB;
  const imgRightHip = hipA.x <= hipB.x ? hipB : hipA;

  const leftShoulderX = imgLeftSh.x * w;
  const leftShoulderY = imgLeftSh.y * h;
  const rightShoulderX = imgRightSh.x * w;
  const rightShoulderY = imgRightSh.y * h;

  const shoulderMidX = (leftShoulderX + rightShoulderX) * 0.5;
  const shoulderMidY = (leftShoulderY + rightShoulderY) * 0.5;
  const dx = Math.max(24, rightShoulderX - leftShoulderX);
  const dy = rightShoulderY - leftShoulderY;
  const shoulderSpanPx = Math.hypot(dx, dy);
  const shoulderTiltRad = clamp(Math.atan2(dy, dx), -0.22, 0.22);

  const leftHipX = imgLeftHip.x * w;
  const leftHipY = imgLeftHip.y * h;
  const rightHipX = imgRightHip.x * w;
  const rightHipY = imgRightHip.y * h;
  const hipMidX = (leftHipX + rightHipX) * 0.5;
  const hipMidY = (leftHipY + rightHipY) * 0.5;
  const hipSpanPx = Math.max(shoulderSpanPx * 0.68, Math.abs(rightHipX - leftHipX));
  const torsoHeightPx = clamp(
    hipMidY - shoulderMidY,
    shoulderSpanPx * 1.12,
    h * 0.48,
  );

  const noseX = nose.x * w;
  const noseY = nose.y * h;
  const mouthMidX = ((mouthA.x + mouthB.x) * 0.5) * w;
  const mouthMidY = ((mouthA.y + mouthB.y) * 0.5) * h;

  const noseToMouth = clamp(mouthMidY - noseY, 16, 62);
  const rawChinY = mouthMidY + noseToMouth * 0.92;
  const chinY = clamp(
    rawChinY,
    mouthMidY + 12,
    shoulderMidY - Math.max(18, torsoHeightPx * 0.1),
  );

  const earSpanPx = clamp(
    Math.abs(imgRightEar.x - imgLeftEar.x) * w,
    shoulderSpanPx * 0.34,
    shoulderSpanPx * 0.72,
  );

  return {
    noseX,
    noseY,
    leftEarX: imgLeftEar.x * w,
    leftEarY: imgLeftEar.y * h,
    rightEarX: imgRightEar.x * w,
    rightEarY: imgRightEar.y * h,
    mouthMidX,
    mouthMidY,
    chinY,
    leftShoulderX,
    leftShoulderY,
    rightShoulderX,
    rightShoulderY,
    shoulderMidX,
    shoulderMidY,
    shoulderSpanPx,
    shoulderTiltRad,
    leftHipX,
    leftHipY,
    rightHipX,
    rightHipY,
    hipMidX,
    hipMidY,
    hipSpanPx,
    torsoHeightPx,
    earSpanPx,
  };
}

function isHighNeckGarment(garment: TryOnSynthesisGarmentInput, prepared: PreparedGarmentAsset): boolean {
  const lower = garment.name.toLowerCase();
  if (
    lower.includes('cổ lọ') ||
    lower.includes('co lo') ||
    lower.includes('turtleneck') ||
    lower.includes('cổ trụ') ||
    lower.includes('áo dài') ||
    lower.includes('ao dai')
  ) {
    return true;
  }
  const collarDepth = prepared.anchors.collarBottomY - prepared.anchors.collarTopY;
  return garment.slot === 'upper' && collarDepth < 0.065;
}

interface PlacementRect {
  centerX: number;
  pivotY: number;
  drawX: number;
  drawY: number;
  drawW: number;
  drawH: number;
  rotationRad: number;
  frontCollarRimY: number;
}

function computeGarmentPlacement(
  garment: TryOnSynthesisGarmentInput,
  prepared: PreparedGarmentAsset,
  body: ResolvedBodyMetrics,
  canvasW: number,
  canvasH: number,
): PlacementRect {
  const { anchors, canvas } = prepared;
  const naturalAspect = Math.max(0.28, canvas.width / Math.max(1, canvas.height));
  const neckHeight = Math.max(24, body.shoulderMidY - body.chinY);
  const highNeck = isHighNeckGarment(garment, prepared);
  const isSleeved = naturalAspect >= 0.56;

  if (garment.slot === 'lower') {
    const waistLineY = body.shoulderMidY + body.torsoHeightPx * 0.78;
    const drawW = clamp(
      Math.max(body.hipSpanPx * 1.56, body.shoulderSpanPx * 1.18),
      canvasW * 0.28,
      canvasW * 0.72,
    );
    const drawH = clamp(
      drawW / naturalAspect,
      body.torsoHeightPx * 1.15,
      canvasH - waistLineY + 64,
    );
    const centerX = body.hipMidX;
    const drawY = waistLineY - anchors.waistY * drawH;
    return {
      centerX,
      pivotY: waistLineY,
      drawX: centerX - drawW * 0.5,
      drawY,
      drawW,
      drawH,
      rotationRad: body.shoulderTiltRad * 0.35,
      frontCollarRimY: waistLineY,
    };
  }

  if (garment.slot === 'onePiece') {
    const widthMult = isSleeved ? 1.54 : 1.34;
    const drawW = clamp(
      Math.max(body.shoulderSpanPx * widthMult, body.hipSpanPx * 1.44),
      canvasW * 0.32,
      canvasW * 0.76,
    );
    const drawH = clamp(
      drawW / naturalAspect,
      body.torsoHeightPx * 1.78,
      canvasH - body.shoulderMidY + 90,
    );
    const shoulderAnchorInGarment = clamp(anchors.collarTopY + 0.085, 0.08, 0.22);
    const drawY = highNeck
      ? body.chinY + neckHeight * 0.44 - anchors.collarTopY * drawH
      : body.shoulderMidY - body.torsoHeightPx * 0.1 - shoulderAnchorInGarment * drawH;

    return {
      centerX: body.shoulderMidX,
      pivotY: body.shoulderMidY,
      drawX: body.shoulderMidX - drawW * 0.5,
      drawY,
      drawW,
      drawH,
      rotationRad: body.shoulderTiltRad,
      frontCollarRimY: drawY + anchors.collarBottomY * drawH,
    };
  }

  // `upper` or `outerwear`
  const isOuterwear = garment.slot === 'outerwear';
  const baseWidthMult = isOuterwear
    ? 1.74
    : isSleeved
      ? 1.72
      : 1.4;

  // Ensure wearer's shoulders (including trapezius slope, deltoids & underlying straps/sleeves) are 100% covered
  const garmentShoulderFrac = clamp(
    anchors.rightShoulderX - anchors.leftShoulderX,
    0.58,
    0.92,
  );
  const shoulderDrivenWidth =
    (body.shoulderSpanPx * (isOuterwear ? 1.44 : 1.38)) /
    clamp(garmentShoulderFrac * 0.9, 0.58, 0.86);

  const drawW = clamp(
    Math.max(body.shoulderSpanPx * baseWidthMult, shoulderDrivenWidth),
    canvasW * 0.36,
    canvasW * 0.84,
  );

  const minTorsoMult = isOuterwear ? 1.36 : 1.24;
  const maxTorsoMult = isOuterwear ? 2.15 : 1.64;
  const drawH = clamp(
    drawW / naturalAspect,
    body.torsoHeightPx * minTorsoMult,
    body.torsoHeightPx * maxTorsoMult,
  );

  const shoulderCapFrac = clamp(
    anchors.shoulderCapY ?? anchors.collarTopY + 0.11,
    0.04,
    0.26,
  );
  // Target top of outer garment shoulder knit slightly above wearer's trapezius / tank straps
  const targetShoulderTopY =
    body.shoulderMidY - Math.max(22, body.shoulderSpanPx * 0.155);
  const yFromShoulderCap = targetShoulderTopY - shoulderCapFrac * drawH;

  let drawY: number;
  if (highNeck) {
    // Keep front turtleneck lip comfortably below chin (15%..28% down neck) while covering shoulders completely
    const minDrawY =
      body.chinY + neckHeight * 0.15 - anchors.collarBottomY * drawH;
    const maxDrawY =
      body.chinY + neckHeight * 0.28 - anchors.collarBottomY * drawH;
    drawY = clamp(yFromShoulderCap, minDrawY, maxDrawY);
  } else {
    const minDrawY =
      body.chinY + neckHeight * 0.22 - anchors.collarTopY * drawH;
    const maxDrawY =
      body.shoulderMidY - body.torsoHeightPx * 0.08 - shoulderCapFrac * drawH;
    drawY = clamp(yFromShoulderCap, minDrawY, Math.max(minDrawY, maxDrawY));
  }

  // Align horizontal center using the garment's own measured shoulder midpoint
  const garmentCenterFrac = clamp(
    (anchors.leftShoulderX + anchors.rightShoulderX) * 0.5,
    0.45,
    0.55,
  );

  return {
    centerX: body.shoulderMidX,
    pivotY: body.shoulderMidY,
    drawX: body.shoulderMidX - garmentCenterFrac * drawW,
    drawY,
    drawW,
    drawH,
    rotationRad: body.shoulderTiltRad,
    frontCollarRimY: drawY + anchors.collarBottomY * drawH,
  };
}

/**
 * Applies cylindrical 3D torso wrap shading + ambient room light + lighting preset
 * onto the draped garment layer (`source-atop` so transparent pixels stay untouched).
 */
function shadeAndRelightGarmentLayer(
  layerCanvas: HTMLCanvasElement,
  placement: PlacementRect,
  ambientRgb: [number, number, number],
  lightingPreset: LightingPresetId,
): void {
  const ctx = layerCanvas.getContext('2d');
  if (!ctx) return;

  const preset = LIGHTING_PRESET_META[lightingPreset];
  const { drawX, drawY, drawW, drawH } = placement;

  ctx.save();
  ctx.globalCompositeOperation = 'source-atop';

  // 1. Cylindrical horizontal body-wrap shading (gentle edge roll-off + chest soft key highlight)
  const cylGrad = ctx.createLinearGradient(drawX, 0, drawX + drawW, 0);
  cylGrad.addColorStop(0.0, 'rgba(18, 13, 10, 0.18)');
  cylGrad.addColorStop(0.16, 'rgba(18, 13, 10, 0.06)');
  cylGrad.addColorStop(0.45, 'rgba(255, 250, 242, 0.05)');
  cylGrad.addColorStop(0.55, 'rgba(255, 250, 242, 0.04)');
  cylGrad.addColorStop(0.84, 'rgba(18, 13, 10, 0.07)');
  cylGrad.addColorStop(1.0, 'rgba(18, 13, 10, 0.2)');
  ctx.fillStyle = cylGrad;
  ctx.fillRect(0, 0, layerCanvas.width, layerCanvas.height);

  // 2. Vertical torso depth shading (soft shadow near under-bust/hem & collar contour)
  const vertGrad = ctx.createLinearGradient(0, drawY, 0, drawY + drawH);
  vertGrad.addColorStop(0.0, 'rgba(24, 18, 14, 0.06)');
  vertGrad.addColorStop(0.18, 'rgba(255, 252, 246, 0.04)');
  vertGrad.addColorStop(0.68, 'rgba(0, 0, 0, 0.0)');
  vertGrad.addColorStop(1.0, 'rgba(16, 12, 9, 0.12)');
  ctx.fillStyle = vertGrad;
  ctx.fillRect(0, 0, layerCanvas.width, layerCanvas.height);

  // 3. Ambient room RGB harmonization so the garment blends seamlessly with the person's photo
  const [ambR, ambG, ambB] = ambientRgb;
  const ambLuma = 0.299 * ambR + 0.587 * ambG + 0.114 * ambB;
  ctx.globalCompositeOperation = 'source-atop';
  ctx.fillStyle = `rgba(${Math.round(ambR)}, ${Math.round(ambG)}, ${Math.round(ambB)}, 0.12)`;
  ctx.fillRect(0, 0, layerCanvas.width, layerCanvas.height);

  // Dim garment gently if user photo was taken in dimmer indoor light
  if (ambLuma < 145) {
    const dimAlpha = clamp((145 - ambLuma) / 260, 0.04, 0.24);
    ctx.fillStyle = `rgba(18, 14, 12, ${dimAlpha.toFixed(3)})`;
    ctx.fillRect(0, 0, layerCanvas.width, layerCanvas.height);
  }

  // 4. Selected Atelier lighting preset tone (Nắng Sớm / Showroom Atelier / Đèn Tiệc Tối)
  const [pR, pG, pB] = preset.tintRgb;
  ctx.fillStyle = `rgba(${pR}, ${pG}, ${pB}, ${(preset.tintStrength * 0.72).toFixed(3)})`;
  ctx.fillRect(0, 0, layerCanvas.width, layerCanvas.height);

  if (lightingPreset === 'evening') {
    // Soft warm directional studio falloff for evening ambiance
    const eveGrad = ctx.createRadialGradient(
      placement.centerX - drawW * 0.14,
      drawY + drawH * 0.22,
      drawW * 0.08,
      placement.centerX,
      drawY + drawH * 0.5,
      drawH * 0.85,
    );
    eveGrad.addColorStop(0, 'rgba(255, 224, 178, 0.09)');
    eveGrad.addColorStop(0.65, 'rgba(34, 22, 16, 0.12)');
    eveGrad.addColorStop(1, 'rgba(18, 11, 8, 0.22)');
    ctx.fillStyle = eveGrad;
    ctx.fillRect(0, 0, layerCanvas.width, layerCanvas.height);
  } else if (lightingPreset === 'morning') {
    const mornGrad = ctx.createLinearGradient(drawX, drawY, drawX + drawW, drawY + drawH * 0.7);
    mornGrad.addColorStop(0, 'rgba(255, 250, 236, 0.11)');
    mornGrad.addColorStop(0.55, 'rgba(255, 248, 232, 0.03)');
    mornGrad.addColorStop(1, 'rgba(198, 212, 228, 0.06)');
    ctx.fillStyle = mornGrad;
    ctx.fillRect(0, 0, layerCanvas.width, layerCanvas.height);
  }

  ctx.restore();
}

/**
 * Composites the wearer's real head, hair, jawline, chin, and upper neck cleanly ON TOP
 * of the garment collar so high collars / turtlenecks / lapels NEVER cut over the face or chin.
 */
function applyHeadChinNeckOcclusion(
  outCtx: CanvasRenderingContext2D,
  baseCanvas: HTMLCanvasElement,
  body: ResolvedBodyMetrics,
  frontCollarRimY: number,
  hasHighNeck: boolean,
): void {
  const w = baseCanvas.width;
  const h = baseCanvas.height;

  const maskCanvas = document.createElement('canvas');
  maskCanvas.width = w;
  maskCanvas.height = h;
  const mCtx = maskCanvas.getContext('2d');
  if (!mCtx) return;

  const headCenterX = (body.noseX * 0.55 + (body.leftEarX + body.rightEarX) * 0.225);
  const headHalfW = Math.max(body.earSpanPx * 1.15, body.shoulderSpanPx * 0.38);
  // Keep neck occlusion column strictly inside real neck skin so zero background halo
  // bleeds onto dark collars (e.g. Cacao Đậm) or reveals outer tank straps.
  const neckHalfW = clamp(body.earSpanPx * 0.24, 18, body.shoulderSpanPx * 0.17);
  const neckHeight = Math.max(22, body.shoulderMidY - body.chinY);

  // Determine how far down the neck stays in front of the garment collar:
  // - High-neck / turtleneck: preserve head + chin + upper neck cleanly down to the front collar rim
  // - Open neckline / V-neck: preserve head + chin + neck down to the front neckline opening
  const neckStopY = hasHighNeck
    ? clamp(
        Math.min(frontCollarRimY - 1, body.chinY + neckHeight * 0.46),
        body.chinY + 4,
        body.shoulderMidY - 12,
      )
    : clamp(
        Math.min(frontCollarRimY + 2, body.shoulderMidY + 8),
        body.chinY + 12,
        body.shoulderMidY + 18,
      );

  // Build soft feathered occlusion mask
  mCtx.save();
  mCtx.filter = 'blur(3.5px)';
  mCtx.fillStyle = '#ffffff';

  // 1. Full upper head + hair region above jaw level
  const jawSideY = body.mouthMidY + (body.chinY - body.mouthMidY) * 0.42;
  mCtx.beginPath();
  mCtx.moveTo(headCenterX - headHalfW * 1.32, 0);
  mCtx.lineTo(headCenterX + headHalfW * 1.32, 0);
  mCtx.lineTo(headCenterX + headHalfW * 1.18, body.rightEarY + 10);
  mCtx.quadraticCurveTo(
    headCenterX + headHalfW * 0.72,
    jawSideY,
    headCenterX + neckHalfW * 1.0,
    body.chinY + 1,
  );
  mCtx.quadraticCurveTo(
    headCenterX,
    body.chinY + 8,
    headCenterX - neckHalfW * 1.0,
    body.chinY + 1,
  );
  mCtx.quadraticCurveTo(
    headCenterX - headHalfW * 0.72,
    jawSideY,
    headCenterX - headHalfW * 1.18,
    body.leftEarY + 10,
  );
  mCtx.closePath();
  mCtx.fill();

  // 2. Narrow tapered upper-neck column descending cleanly into the front collar rim
  if (neckStopY > body.chinY + 2) {
    mCtx.beginPath();
    mCtx.moveTo(headCenterX - neckHalfW * 0.92, body.chinY - 4);
    mCtx.lineTo(headCenterX + neckHalfW * 0.92, body.chinY - 4);
    mCtx.lineTo(headCenterX + neckHalfW * 0.82, neckStopY - 3);
    mCtx.quadraticCurveTo(
      headCenterX,
      neckStopY + 3,
      headCenterX - neckHalfW * 0.82,
      neckStopY - 3,
    );
    mCtx.closePath();
    mCtx.fill();
  }
  mCtx.restore();

  // Extract masked head/chin/neck from the original person frame
  const headLayer = document.createElement('canvas');
  headLayer.width = w;
  headLayer.height = h;
  const hCtx = headLayer.getContext('2d');
  if (!hCtx) return;

  hCtx.drawImage(maskCanvas, 0, 0);
  hCtx.globalCompositeOperation = 'source-in';
  hCtx.drawImage(baseCanvas, 0, 0);

  // Subtle ambient contact shadow under the chin/neck where collar meets skin
  outCtx.save();
  const shadowGrad = outCtx.createRadialGradient(
    headCenterX,
    neckStopY + 2,
    neckHalfW * 0.2,
    headCenterX,
    neckStopY + 4,
    neckHalfW * 1.35,
  );
  shadowGrad.addColorStop(0, 'rgba(28, 19, 14, 0.16)');
  shadowGrad.addColorStop(1, 'rgba(28, 19, 14, 0)');
  outCtx.fillStyle = shadowGrad;
  outCtx.fillRect(
    headCenterX - neckHalfW * 1.5,
    neckStopY - 10,
    neckHalfW * 3,
    28,
  );
  outCtx.restore();

  // Composite head/chin/upper neck crisply on top of the draped garment
  outCtx.drawImage(headLayer, 0, 0);
}

/**
 * Applies a subtle unified room-lighting atmosphere pass over the final 768x1024 frame
 * so person + garments share the same studio lighting preset (`Nắng Sớm` / `Showroom Atelier` / `Đèn Tiệc Tối`).
 */
function applyStudioAtmospherePass(
  outCtx: CanvasRenderingContext2D,
  w: number,
  h: number,
  lightingPreset: LightingPresetId,
): void {
  const preset = LIGHTING_PRESET_META[lightingPreset];
  outCtx.save();

  if (lightingPreset === 'morning') {
    const grad = outCtx.createLinearGradient(0, 0, w, h * 0.85);
    grad.addColorStop(0, 'rgba(255, 246, 226, 0.11)');
    grad.addColorStop(0.55, 'rgba(255, 250, 240, 0.04)');
    grad.addColorStop(1, 'rgba(232, 240, 248, 0.05)');
    outCtx.fillStyle = grad;
    outCtx.fillRect(0, 0, w, h);
  } else if (lightingPreset === 'evening') {
    const [r, g, b] = preset.tintRgb;
    outCtx.fillStyle = `rgba(${r}, ${g}, ${b}, 0.08)`;
    outCtx.fillRect(0, 0, w, h);

    // Subtle luxury vignette for evening tungsten feel
    const vig = outCtx.createRadialGradient(
      w * 0.5,
      h * 0.36,
      w * 0.22,
      w * 0.5,
      h * 0.5,
      h * 0.78,
    );
    vig.addColorStop(0, 'rgba(255, 224, 184, 0.04)');
    vig.addColorStop(0.7, 'rgba(22, 14, 10, 0.08)');
    vig.addColorStop(1, 'rgba(14, 9, 7, 0.22)');
    outCtx.fillStyle = vig;
    outCtx.fillRect(0, 0, w, h);
  } else {
    // Balanced Showroom Atelier ivory sheen
    const grad = outCtx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, 'rgba(251, 247, 239, 0.04)');
    grad.addColorStop(1, 'rgba(28, 20, 16, 0.04)');
    outCtx.fillStyle = grad;
    outCtx.fillRect(0, 0, w, h);
  }

  outCtx.restore();
}

/**
 * Stage 1 Local Anatomical VTON Compositor.
 * Operates strictly on a locked 768x1024 static `SessionPersonFrame` (never live video!).
 */
export async function compositeLocalAnatomicalTryOn(
  params: LocalCompositeParams,
): Promise<LocalCompositeOutput> {
  const { personFrame, garments, lightingPreset, onStageChange } = params;
  const W = TRYON_FRAME_WIDTH;
  const H = TRYON_FRAME_HEIGHT;

  onStageChange?.(0);

  if (typeof document === 'undefined') {
    return {
      resultDataUrl: personFrame.dataUrl,
      cleanCollarApplied: false,
    };
  }

  // 1. Load the locked 768x1024 person frame
  const baseCanvas = document.createElement('canvas');
  baseCanvas.width = W;
  baseCanvas.height = H;
  const baseCtx = baseCanvas.getContext('2d', { willReadFrequently: true });

  const loadedPerson = await loadImageCorsSafe(personFrame.dataUrl);
  if (baseCtx && loadedPerson) {
    // Cover-fit cleanly to 768x1024 in case a non-exact source sneaks through
    const scale = Math.max(W / loadedPerson.width, H / loadedPerson.height);
    const drawW = loadedPerson.width * scale;
    const drawH = loadedPerson.height * scale;
    const ox = (W - drawW) * 0.5;
    const oy = (H - drawH) * 0.12;
    baseCtx.drawImage(loadedPerson.source as CanvasImageSource, ox, oy, drawW, drawH);
    loadedPerson.cleanup();
  }

  const outCanvas = document.createElement('canvas');
  outCanvas.width = W;
  outCanvas.height = H;
  const outCtx = outCanvas.getContext('2d');
  if (!outCtx) {
    return {
      resultDataUrl: personFrame.dataUrl,
      cleanCollarApplied: false,
    };
  }

  outCtx.drawImage(baseCanvas, 0, 0);

  if (garments.length === 0) {
    applyStudioAtmospherePass(outCtx, W, H, lightingPreset);
    onStageChange?.(3);
    return {
      resultDataUrl: outCanvas.toDataURL('image/webp', 0.92),
      cleanCollarApplied: false,
    };
  }

  const body = resolveBodyMetrics(personFrame.poseLandmarks, W, H);

  // 2. Prepare clean garments in parallel (background mat + collar cavity clean + color recolor)
  onStageChange?.(1);
  const orderedGarments = [...garments].sort(
    (a, b) => SLOT_LAYER_ORDER[a.slot] - SLOT_LAYER_ORDER[b.slot],
  );

  const preparedList = await Promise.all(
    orderedGarments.map((g) =>
      prepareCleanGarment({
        garmentImageUrl: g.garmentImageUrl,
        colorHex: g.colorHex,
        slot: g.slot,
        name: g.name,
      }),
    ),
  );

  let cleanCollarApplied = false;
  let hasUpperCoveringGarment = false;
  let hasHighNeck = false;
  let topMostFrontCollarY = body.shoulderMidY;

  // 3. Pose-aligned anatomical drape + cylindrical wrap shading + ambient relighting
  onStageChange?.(2);
  for (let i = 0; i < orderedGarments.length; i += 1) {
    const garment = orderedGarments[i]!;
    const prepared = preparedList[i]!;
    if (prepared.cleanCollarApplied) {
      cleanCollarApplied = true;
    }

    const placement = computeGarmentPlacement(garment, prepared, body, W, H);

    if (garment.slot !== 'lower') {
      hasUpperCoveringGarment = true;
      if (isHighNeckGarment(garment, prepared)) {
        hasHighNeck = true;
      }
      topMostFrontCollarY = Math.min(topMostFrontCollarY, placement.frontCollarRimY);
    }

    const garmentLayer = document.createElement('canvas');
    garmentLayer.width = W;
    garmentLayer.height = H;
    const gCtx = garmentLayer.getContext('2d');
    if (!gCtx) continue;

    gCtx.save();
    gCtx.translate(placement.centerX, placement.pivotY);
    gCtx.rotate(placement.rotationRad);
    gCtx.drawImage(
      prepared.canvas,
      placement.drawX - placement.centerX,
      placement.drawY - placement.pivotY,
      placement.drawW,
      placement.drawH,
    );
    gCtx.restore();

    shadeAndRelightGarmentLayer(
      garmentLayer,
      placement,
      personFrame.ambientRgb,
      lightingPreset,
    );

    // Subtle soft drop shadow directly beneath the garment so it grounds naturally on the wearer
    outCtx.save();
    outCtx.shadowColor = 'rgba(20, 14, 10, 0.16)';
    outCtx.shadowBlur = 10;
    outCtx.shadowOffsetX = 0;
    outCtx.shadowOffsetY = 3;
    outCtx.drawImage(garmentLayer, 0, 0);
    outCtx.restore();
  }

  // 4. Head, chin, jawline & upper-neck occlusion pass ON TOP of collars
  onStageChange?.(3);
  if (hasUpperCoveringGarment) {
    applyHeadChinNeckOcclusion(
      outCtx,
      baseCanvas,
      body,
      topMostFrontCollarY,
      hasHighNeck,
    );
  }

  // 5. Harmonize full portrait atmosphere to the chosen lighting preset
  applyStudioAtmospherePass(outCtx, W, H, lightingPreset);

  let resultDataUrl: string;
  try {
    resultDataUrl = outCanvas.toDataURL('image/webp', 0.92);
    if (!resultDataUrl.startsWith('data:image/')) {
      resultDataUrl = outCanvas.toDataURL('image/png');
    }
  } catch {
    resultDataUrl = personFrame.dataUrl;
  }

  return {
    resultDataUrl,
    cleanCollarApplied,
  };
}
