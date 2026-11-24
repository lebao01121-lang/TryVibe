import * as THREE from 'three';
import {
  disposeGarmentTextureBundle,
  resolveFabricPbrProfile,
} from './texturePipeline';
import type {
  ArmPoseAngles,
  FabricPbrProfile,
  Garment3DLayerSpec,
  GarmentSlot3D,
  GarmentTextureBundle,
} from './types';

const SEGMENTS_X = 48;
const SEGMENTS_Y = 64;

export interface VolumetricGarmentRig {
  group: THREE.Group;
  slot: GarmentSlot3D;
  spec: Garment3DLayerSpec;
  pbr: FabricPbrProfile;
  bundle: GarmentTextureBundle;
  frontMesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshPhysicalMaterial>;
  backMesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshPhysicalMaterial>;
  shadowMesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  shadowTexture: THREE.CanvasTexture;
  baseWidth: number;
  baseHeight: number;
  /** Precomputed rest positions for zero-allocation real-time deformation */
  frontRestPos: Float32Array;
  backRestPos: Float32Array;
  torsoWeights: Float32Array;
  leftSleeveWeights: Float32Array;
  rightSleeveWeights: Float32Array;
  hemSwayWeights: Float32Array;
  /** Spring-damped hem physics state */
  swayPos: number;
  swayVel: number;
  idlePhase: number;
  /** Smooth color crossfade state */
  crossfadeElapsed: number;
  crossfadeDuration: number;
  dispose: () => void;
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/**
 * Samples the normalized alpha field with 3x3 smoothing so volumetric Z relief
 * rises smoothly from silhouette borders without jagged stairs.
 */
function sampleSmoothAlpha(
  alphaField: Float32Array,
  gridW: number,
  gridH: number,
  u: number,
  vTopDown: number,
): number {
  const gx = clamp(u, 0, 1) * (gridW - 1);
  const gy = clamp(vTopDown, 0, 1) * (gridH - 1);
  const cx = Math.round(gx);
  const cy = Math.round(gy);

  let sum = 0;
  let weightSum = 0;
  for (let dy = -1; dy <= 1; dy += 1) {
    const sy = clamp(cy + dy, 0, gridH - 1);
    for (let dx = -1; dx <= 1; dx += 1) {
      const sx = clamp(cx + dx, 0, gridW - 1);
      const w = dx === 0 && dy === 0 ? 4 : dx === 0 || dy === 0 ? 2 : 1;
      sum += (alphaField[sy * gridW + sx] ?? 0) * w;
      weightSum += w;
    }
  }
  const avg = sum / Math.max(1, weightSum);
  return smoothstep(0.08, 0.72, avg);
}

/**
 * Anatomical contour profile R(v) & full normalized fabric width w(v) aligned to:
 * shoulder v=0.18, bust v=0.28, waist v=0.44, hip v=0.54, hem v=0.92.
 * Using full width w(v) so |u - 0.5| = w(v)/2 maps to cos(±pi/2) = 0 cleanly at silhouette edges.
 */
function evaluateAnatomicalContour(
  vTopDown: number,
  slot: GarmentSlot3D,
  isBack: boolean,
): { radiusZ: number; fullWidthU: number } {
  const t = clamp(vTopDown, 0, 1);

  if (slot === 'BOTTOM') {
    // Waist at t=0.06 -> Hip at t=0.26 -> Thigh/Leg taper down to hem t=0.92
    let r: number;
    let w: number;
    if (t < 0.26) {
      const k = smoothstep(0.0, 0.26, t);
      r = lerp(0.138, 0.182, k);
      w = lerp(0.68, 0.86, k);
    } else if (t < 0.56) {
      const k = smoothstep(0.26, 0.56, t);
      r = lerp(0.182, 0.152, k);
      w = lerp(0.86, 0.9, k);
    } else {
      const k = smoothstep(0.56, 0.96, t);
      r = lerp(0.152, 0.128, k);
      w = lerp(0.9, 0.94, k);
    }
    return {
      radiusZ: r * (isBack ? 0.98 : 1.0),
      fullWidthU: w,
    };
  }

  // Canonical full/upper torso anatomical landmarks:
  // t=0.04 collar, t=0.18 shoulder, t=0.28 bust, t=0.44 waist, t=0.54 hip, t=0.92 hem
  const mappedT =
    slot === 'TOP'
      ? lerp(0.04, 0.58, t)
      : slot === 'OUTERWEAR'
        ? lerp(0.02, 0.72, t)
        : t; // ONE_PIECE spans full 0..1

  let r: number;
  let w: number;

  if (mappedT < 0.18) {
    // Collar (0.04) -> Shoulder (0.18)
    const k = smoothstep(0.02, 0.18, mappedT);
    r = lerp(0.105, 0.152, k);
    w = lerp(0.62, 0.92, k);
  } else if (mappedT < 0.28) {
    // Shoulder (0.18) -> Bust (0.28)
    const k = smoothstep(0.18, 0.28, mappedT);
    r = lerp(0.152, isBack ? 0.168 : 0.194, k);
    w = lerp(0.92, 0.88, k);
  } else if (mappedT < 0.44) {
    // Bust (0.28) -> Waist (0.44)
    const k = smoothstep(0.28, 0.44, mappedT);
    r = lerp(isBack ? 0.168 : 0.194, isBack ? 0.136 : 0.144, k);
    w = lerp(0.88, 0.74, k);
  } else if (mappedT < 0.54) {
    // Waist (0.44) -> Hip (0.54)
    const k = smoothstep(0.44, 0.54, mappedT);
    r = lerp(isBack ? 0.136 : 0.144, isBack ? 0.184 : 0.178, k);
    w = lerp(0.74, 0.88, k);
  } else {
    // Hip (0.54) -> Hem (0.92..1.0)
    const k = smoothstep(0.54, 0.92, mappedT);
    r = lerp(isBack ? 0.184 : 0.178, 0.152, k);
    w = lerp(0.88, 0.96, k);
  }

  // Outerwear wraps slightly fuller over inner layers
  const layerInflation = slot === 'OUTERWEAR' ? 1.16 : slot === 'TOP' ? 1.04 : 1.06;

  return {
    radiusZ: r * layerInflation,
    fullWidthU: w,
  };
}

/**
 * Generates a subtle radial contact shadow canvas texture to ground garment collars/shoulders
 * onto the mannequin or user's body.
 */
function createContactShadowTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.clearRect(0, 0, 128, 128);
    const grad = ctx.createRadialGradient(64, 52, 8, 64, 56, 56);
    grad.addColorStop(0, 'rgba(20, 14, 10, 0.38)');
    grad.addColorStop(0.52, 'rgba(24, 18, 12, 0.16)');
    grad.addColorStop(1, 'rgba(24, 18, 12, 0.0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 128, 128);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Applies true 3D Volumetric Anatomical Relief to a high-resolution PlaneGeometry(w, h, 48, 64):
 *   dz(u, v) = R(v) * cos(((u - 0.5) / w(v)) * pi) * alpha(u, v)
 * plus gentle couture hem drape pleats for natural volume & rim lighting from every angle.
 */
function applyVolumetricRelief(
  geometry: THREE.PlaneGeometry,
  bundle: GarmentTextureBundle,
  slot: GarmentSlot3D,
  isBack: boolean,
  pbr: FabricPbrProfile,
  width: number,
  height: number,
): Float32Array {
  const posAttr = geometry.attributes.position as THREE.BufferAttribute;
  const uvAttr = geometry.attributes.uv as THREE.BufferAttribute;
  const count = posAttr.count;
  const restCopy = new Float32Array(count * 3);

  const depthScale = Math.max(0.98, Math.min(1.32, width / 0.54));
  const pleatGain =
    slot === 'ONE_PIECE' || slot === 'BOTTOM'
      ? 0.014 * pbr.swayAmplitude
      : 0.005 * pbr.swayAmplitude;

  for (let i = 0; i < count; i += 1) {
    const rawU = uvAttr.getX(i);
    const uvY = uvAttr.getY(i);
    // For back mesh (which is rotated 180 deg around Y), mirror u when querying front alpha
    const u = isBack ? 1 - rawU : rawU;
    const vTopDown = 1 - uvY;

    const alpha = sampleSmoothAlpha(
      bundle.alphaField,
      bundle.alphaGridW,
      bundle.alphaGridH,
      u,
      vTopDown,
    );

    const { radiusZ, fullWidthU } = evaluateAnatomicalContour(
      vTopDown,
      slot,
      isBack,
    );

    // Cylindrical chest/shoulder/waist/hip contour formula: R(v) * cos(((u - 0.5) / w(v)) * pi) * alpha(u, v)
    const normalizedSpan = clamp((u - 0.5) / Math.max(0.28, fullWidthU), -0.5, 0.5);
    const cylindricalCos = Math.cos(normalizedSpan * Math.PI);

    // Subtle organic couture drape pleats near lower hem
    const hemMask = smoothstep(0.52, 0.94, vTopDown);
    const pleatWave =
      Math.sin((u - 0.5) * Math.PI * 7.0) * pleatGain * hemMask * alpha;

    // Gentle shoulder wrap curvature pulling outer sleeve edges slightly inward along -Z
    const sleeveWrap =
      slot === 'TOP' || slot === 'OUTERWEAR'
        ? -Math.pow(Math.max(0, Math.abs(u - 0.5) - 0.28) / 0.22, 2) *
          0.032 *
          smoothstep(0.08, 0.35, vTopDown) *
          (1 - smoothstep(0.55, 0.85, vTopDown)) *
          alpha
        : 0;

    // Slight collar neck-opening relief so necklines wrap around the neck cylinder cleanly
    const collarDip =
      slot !== 'BOTTOM'
        ? -Math.exp(-Math.pow((u - 0.5) / 0.14, 2)) *
          (1 - smoothstep(0.0, 0.16, vTopDown)) *
          0.024 *
          alpha
        : 0;

    const dz =
      (radiusZ * cylindricalCos * alpha + pleatWave + sleeveWrap + collarDip) *
      depthScale;

    // Back plane is rotated Math.PI around Y, so local +Z on backMesh points to world -Z!
    const x = posAttr.getX(i);
    const y = posAttr.getY(i);
    const z = Math.max(0, dz);

    posAttr.setXYZ(i, x, y, z);
    restCopy[i * 3] = x;
    restCopy[i * 3 + 1] = y;
    restCopy[i * 3 + 2] = z;
  }

  // Keep height reference to prevent unused lint warning & preserve geometry bounds
  void height;
  posAttr.needsUpdate = true;
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();

  return restCopy;
}

function buildVertexWeights(
  geometry: THREE.PlaneGeometry,
  slot: GarmentSlot3D,
): {
  torsoWeights: Float32Array;
  leftSleeveWeights: Float32Array;
  rightSleeveWeights: Float32Array;
  hemSwayWeights: Float32Array;
} {
  const uvAttr = geometry.attributes.uv as THREE.BufferAttribute;
  const count = uvAttr.count;

  const torsoWeights = new Float32Array(count);
  const leftSleeveWeights = new Float32Array(count);
  const rightSleeveWeights = new Float32Array(count);
  const hemSwayWeights = new Float32Array(count);

  const hasSleeves = slot === 'TOP' || slot === 'OUTERWEAR' || slot === 'ONE_PIECE';
  const sleeveStrength =
    slot === 'OUTERWEAR' ? 1.0 : slot === 'TOP' ? 0.95 : slot === 'ONE_PIECE' ? 0.55 : 0;

  for (let i = 0; i < count; i += 1) {
    const u = uvAttr.getX(i);
    const vTopDown = 1 - uvAttr.getY(i);

    // Sleeve zones: outer left (u < 0.30) & outer right (u > 0.70) within upper body band
    const sleeveBandY =
      smoothstep(0.08, 0.2, vTopDown) * (1 - smoothstep(0.58, 0.78, vTopDown));

    const leftW = hasSleeves
      ? smoothstep(0.32, 0.14, u) * sleeveBandY * sleeveStrength
      : 0;
    const rightW = hasSleeves
      ? smoothstep(0.68, 0.86, u) * sleeveBandY * sleeveStrength
      : 0;

    // Hem sway weight rises smoothly from waist down to hem
    const hemStart = slot === 'BOTTOM' ? 0.2 : 0.42;
    const hemW = Math.pow(smoothstep(hemStart, 0.98, vTopDown), 1.45);

    const torsoW = clamp(1 - Math.max(leftW, rightW), 0, 1);

    torsoWeights[i] = torsoW;
    leftSleeveWeights[i] = leftW;
    rightSleeveWeights[i] = rightW;
    hemSwayWeights[i] = hemW;
  }

  return {
    torsoWeights,
    leftSleeveWeights,
    rightSleeveWeights,
    hemSwayWeights,
  };
}

function getSlotRenderOrder(slot: GarmentSlot3D): number {
  switch (slot) {
    case 'BOTTOM':
      return 12;
    case 'TOP':
      return 20;
    case 'ONE_PIECE':
      return 22;
    case 'OUTERWEAR':
      return 34;
    default:
      return 20;
  }
}

function createPhysicalFabricMaterial(
  colorMap: THREE.CanvasTexture,
  normalMap: THREE.CanvasTexture,
  roughnessMap: THREE.CanvasTexture,
  spec: Garment3DLayerSpec,
  pbr: FabricPbrProfile,
  isBack: boolean,
): THREE.MeshPhysicalMaterial {
  const baseColor = new THREE.Color(spec.colorHex || '#E8DFD1');
  const sheenTint = baseColor.clone().lerp(new THREE.Color('#FBF7EF'), 0.48);

  return new THREE.MeshPhysicalMaterial({
    map: colorMap,
    normalMap,
    normalScale: new THREE.Vector2(pbr.normalScale, pbr.normalScale),
    roughnessMap,
    roughness: pbr.roughness,
    metalness: pbr.metalness,
    sheen: pbr.sheen * (isBack ? 0.88 : 1.0),
    sheenRoughness: pbr.sheenRoughness,
    sheenColor: sheenTint,
    clearcoat: pbr.clearcoat * (isBack ? 0.8 : 1.0),
    clearcoatRoughness: pbr.clearcoatRoughness,
    transparent: true,
    alphaTest: 0.06,
    side: THREE.FrontSide,
    depthWrite: true,
    depthTest: true,
    envMapIntensity: isBack ? 0.85 : 1.05,
  });
}

/**
 * Builds a complete true-3D Volumetric Garment Rig (front anatomical relief shell +
 * symmetrical back 3D shell + soft shoulder/collar contact shadow) ready for
 * real-time webcam AR, static photo fitting, or 360° couture mannequin orbit.
 */
export function createVolumetricGarmentRig(
  spec: Garment3DLayerSpec,
  bundle: GarmentTextureBundle,
): VolumetricGarmentRig {
  const pbr = resolveFabricPbrProfile(spec.fabricComposition, spec.fabricWeight);
  const aspect = clamp(bundle.bounds.aspectRatio || 0.72, 0.35, 1.45);

  // Canonical world height per slot (scaled dynamically during fitting to user/mannequin)
  const baseHeight =
    spec.slot === 'ONE_PIECE'
      ? 1.24
      : spec.slot === 'BOTTOM'
        ? 0.96
        : spec.slot === 'OUTERWEAR'
          ? 0.86
          : 0.68;
  const baseWidth = clamp(baseHeight * aspect, 0.36, 0.92);

  const frontGeo = new THREE.PlaneGeometry(
    baseWidth,
    baseHeight,
    SEGMENTS_X,
    SEGMENTS_Y,
  );
  const backGeo = new THREE.PlaneGeometry(
    baseWidth,
    baseHeight,
    SEGMENTS_X,
    SEGMENTS_Y,
  );

  const frontRestPos = applyVolumetricRelief(
    frontGeo,
    bundle,
    spec.slot,
    false,
    pbr,
    baseWidth,
    baseHeight,
  );
  const backRestPos = applyVolumetricRelief(
    backGeo,
    bundle,
    spec.slot,
    true,
    pbr,
    baseWidth,
    baseHeight,
  );

  const weights = buildVertexWeights(frontGeo, spec.slot);

  const frontMat = createPhysicalFabricMaterial(
    bundle.colorMap,
    bundle.normalMap,
    bundle.roughnessMap,
    spec,
    pbr,
    false,
  );
  const backMat = createPhysicalFabricMaterial(
    bundle.backColorMap,
    bundle.backNormalMap,
    bundle.backRoughnessMap,
    spec,
    pbr,
    true,
  );

  const renderOrder = getSlotRenderOrder(spec.slot);

  const frontMesh = new THREE.Mesh(frontGeo, frontMat);
  frontMesh.name = `garment-front-${spec.slot}`;
  frontMesh.renderOrder = renderOrder;
  frontMesh.frustumCulled = false;

  const backMesh = new THREE.Mesh(backGeo, backMat);
  backMesh.name = `garment-back-${spec.slot}`;
  backMesh.rotation.y = Math.PI;
  backMesh.renderOrder = renderOrder;
  backMesh.frustumCulled = false;

  // Soft shoulder / collar contact grounding shadow mesh
  const shadowTexture = createContactShadowTexture();
  const shadowGeo = new THREE.PlaneGeometry(baseWidth * 0.64, baseHeight * 0.2);
  const shadowMat = new THREE.MeshBasicMaterial({
    map: shadowTexture,
    transparent: true,
    opacity: 0.24,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
  });
  const shadowMesh = new THREE.Mesh(shadowGeo, shadowMat);
  shadowMesh.name = `garment-shadow-${spec.slot}`;
  shadowMesh.position.set(
    0,
    spec.slot === 'BOTTOM' ? baseHeight * 0.42 : baseHeight * 0.34,
    -0.012,
  );
  shadowMesh.renderOrder = renderOrder - 2;

  const group = new THREE.Group();
  group.name = `volumetric-garment-${spec.slot}`;
  group.add(shadowMesh);
  group.add(backMesh);
  group.add(frontMesh);

  const rig: VolumetricGarmentRig = {
    group,
    slot: spec.slot,
    spec,
    pbr,
    bundle,
    frontMesh,
    backMesh,
    shadowMesh,
    shadowTexture,
    baseWidth,
    baseHeight,
    frontRestPos,
    backRestPos,
    torsoWeights: weights.torsoWeights,
    leftSleeveWeights: weights.leftSleeveWeights,
    rightSleeveWeights: weights.rightSleeveWeights,
    hemSwayWeights: weights.hemSwayWeights,
    swayPos: 0,
    swayVel: 0,
    idlePhase: Math.random() * Math.PI * 2,
    crossfadeElapsed: 1,
    crossfadeDuration: 0.26,
    dispose: () => {
      frontGeo.dispose();
      backGeo.dispose();
      shadowGeo.dispose();
      frontMat.dispose();
      backMat.dispose();
      shadowMat.dispose();
      shadowTexture.dispose();
      disposeGarmentTextureBundle(rig.bundle);
    },
  };

  return rig;
}

/**
 * Swaps garment color/variant textures smoothly WITHOUT recreating geometry,
 * updating PBR fabric sheen/roughness and disposing the previous texture bundle cleanly.
 */
export function swapVolumetricGarmentTexture(
  rig: VolumetricGarmentRig,
  nextBundle: GarmentTextureBundle,
  nextSpec: Garment3DLayerSpec,
): void {
  const prevBundle = rig.bundle;
  const prevFrontUrl = rig.spec.frontUrl;
  const prevColorHex = rig.spec.colorHex;
  const nextPbr = resolveFabricPbrProfile(
    nextSpec.fabricComposition,
    nextSpec.fabricWeight,
  );

  rig.spec = nextSpec;
  rig.pbr = nextPbr;
  rig.bundle = nextBundle;

  // Update front & back anatomical displacement to reflect new alpha mask cleanly
  const nextFrontRest = applyVolumetricRelief(
    rig.frontMesh.geometry,
    nextBundle,
    nextSpec.slot,
    false,
    nextPbr,
    rig.baseWidth,
    rig.baseHeight,
  );
  const nextBackRest = applyVolumetricRelief(
    rig.backMesh.geometry,
    nextBundle,
    nextSpec.slot,
    true,
    nextPbr,
    rig.baseWidth,
    rig.baseHeight,
  );
  rig.frontRestPos.set(nextFrontRest);
  rig.backRestPos.set(nextBackRest);

  const swatchColor = new THREE.Color(nextSpec.colorHex || '#E8DFD1');
  const sheenTint = swatchColor.clone().lerp(new THREE.Color('#FBF7EF'), 0.48);
  // If two variants share the exact same fallback image URL but differ in colorHex,
  // apply a refined 28% swatch tint so switching colors always gives clear visual feedback.
  const sameUrlDifferentSwatch =
    prevFrontUrl === nextSpec.frontUrl &&
    prevColorHex.toLowerCase() !== nextSpec.colorHex.toLowerCase();
  const baseMatTint = sameUrlDifferentSwatch
    ? new THREE.Color(0xffffff).lerp(swatchColor, 0.28)
    : new THREE.Color(0xffffff);

  const applyMat = (
    mat: THREE.MeshPhysicalMaterial,
    colorMap: THREE.CanvasTexture,
    normalMap: THREE.CanvasTexture,
    roughnessMap: THREE.CanvasTexture,
    isBack: boolean,
  ) => {
    mat.color.copy(baseMatTint);
    mat.map = colorMap;
    mat.normalMap = normalMap;
    mat.normalScale.set(nextPbr.normalScale, nextPbr.normalScale);
    mat.roughnessMap = roughnessMap;
    mat.roughness = nextPbr.roughness;
    mat.metalness = nextPbr.metalness;
    mat.sheen = nextPbr.sheen * (isBack ? 0.88 : 1.0);
    mat.sheenRoughness = nextPbr.sheenRoughness;
    mat.sheenColor.copy(sheenTint);
    mat.clearcoat = nextPbr.clearcoat * (isBack ? 0.8 : 1.0);
    mat.clearcoatRoughness = nextPbr.clearcoatRoughness;
    mat.opacity = 0.72;
    mat.needsUpdate = true;
  };

  applyMat(
    rig.frontMesh.material,
    nextBundle.colorMap,
    nextBundle.normalMap,
    nextBundle.roughnessMap,
    false,
  );
  applyMat(
    rig.backMesh.material,
    nextBundle.backColorMap,
    nextBundle.backNormalMap,
    nextBundle.backRoughnessMap,
    true,
  );

  rig.crossfadeElapsed = 0;
  rig.crossfadeDuration = 0.24;

  if (prevBundle && prevBundle !== nextBundle) {
    disposeGarmentTextureBundle(prevBundle);
  }
}

/**
 * Real-time per-frame soft vertex deformation:
 * - Organic sleeve bending when user raises/opens elbows (`TOP` / `OUTERWEAR`)
 * - Spring-damped hem physics reacting to body velocity & `fabricWeight`
 * - Smooth color crossfade opacity easing
 */
export function deformVolumetricGarment(
  rig: VolumetricGarmentRig,
  armAngles: ArmPoseAngles,
  swayVelocity: number,
  dt: number,
): void {
  const safeDt = clamp(dt, 0.001, 0.05);

  // Smooth color swap crossfade completion
  if (rig.crossfadeElapsed < rig.crossfadeDuration) {
    rig.crossfadeElapsed = Math.min(
      rig.crossfadeDuration,
      rig.crossfadeElapsed + safeDt,
    );
    const p = rig.crossfadeElapsed / rig.crossfadeDuration;
    const eased = 1 - Math.pow(1 - p, 3);
    const opacity = lerp(0.72, 1.0, eased);
    rig.frontMesh.material.opacity = opacity;
    rig.backMesh.material.opacity = opacity;
  }

  // Spring-damped hem physics driven by body/orbit angular or lateral velocity
  rig.idlePhase += safeDt * 1.45;
  const clampedImpulse = clamp(swayVelocity, -3.5, 3.5);
  const targetAccel =
    clampedImpulse * 4.2 * rig.pbr.swayAmplitude -
    rig.swayPos * rig.pbr.swayStiffness -
    rig.swayVel * rig.pbr.swayDamping;

  rig.swayVel += targetAccel * safeDt;
  rig.swayPos = clamp(rig.swayPos + rig.swayVel * safeDt, -0.18, 0.18);

  const subtleBreathe =
    Math.sin(rig.idlePhase) * 0.0065 * rig.pbr.swayAmplitude;
  const totalSwayX = rig.swayPos * 0.22 + subtleBreathe;
  const totalSwayZ = Math.abs(rig.swayPos) * 0.08 + Math.cos(rig.idlePhase * 0.8) * 0.004 * rig.pbr.swayAmplitude;

  const leftLift = clamp(armAngles.leftShoulderLift, -0.45, 0.85);
  const rightLift = clamp(armAngles.rightShoulderLift, -0.45, 0.85);
  const leftBend = clamp(armAngles.leftElbowAngle, -0.65, 0.65);
  const rightBend = clamp(armAngles.rightElbowAngle, -0.65, 0.65);

  const pivotY = rig.baseHeight * 0.26;
  const pivotX = rig.baseWidth * 0.24;

  const deformShell = (
    geometry: THREE.PlaneGeometry,
    restPos: Float32Array,
    isBack: boolean,
  ) => {
    const posAttr = geometry.attributes.position as THREE.BufferAttribute;
    const count = posAttr.count;
    const dirSign = isBack ? -1 : 1;

    for (let i = 0; i < count; i += 1) {
      const i3 = i * 3;
      let x = restPos[i3]!;
      let y = restPos[i3 + 1]!;
      let z = restPos[i3 + 2]!;

      const lw = rig.leftSleeveWeights[i]!;
      const rw = rig.rightSleeveWeights[i]!;
      const hw = rig.hemSwayWeights[i]!;

      // Sleeve articulation around shoulder joints
      if (lw > 0.002) {
        const angle = (leftLift * 0.55 + leftBend * 0.28) * lw * dirSign;
        const cosA = Math.cos(angle);
        const sinA = Math.sin(angle);
        const rx = x + pivotX * dirSign;
        const ry = y - pivotY;
        x = rx * cosA - ry * sinA - pivotX * dirSign;
        y = rx * sinA + ry * cosA + pivotY;
        z += Math.abs(leftLift) * 0.018 * lw;
      } else if (rw > 0.002) {
        const angle = -(rightLift * 0.55 + rightBend * 0.28) * rw * dirSign;
        const cosA = Math.cos(angle);
        const sinA = Math.sin(angle);
        const rx = x - pivotX * dirSign;
        const ry = y - pivotY;
        x = rx * cosA - ry * sinA + pivotX * dirSign;
        y = rx * sinA + ry * cosA + pivotY;
        z += Math.abs(rightLift) * 0.018 * rw;
      }

      // Spring-damped flowing hem wave
      if (hw > 0.002) {
        const ripple =
          Math.sin(x * 8.5 + rig.idlePhase * 1.4) *
          0.007 *
          rig.pbr.swayAmplitude *
          hw;
        x += totalSwayX * hw * dirSign;
        z += (totalSwayZ + ripple) * hw;
      }

      posAttr.setXYZ(i, x, y, z);
    }

    posAttr.needsUpdate = true;
  };

  deformShell(rig.frontMesh.geometry, rig.frontRestPos, false);
  deformShell(rig.backMesh.geometry, rig.backRestPos, true);
}
