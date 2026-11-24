import * as THREE from 'three';
import type { BodyMeasurements3D } from './types';

export interface MannequinBodyAnchors {
  collarY: number;
  shoulderY: number;
  bustY: number;
  waistY: number;
  hipY: number;
  hemY: number;
  shoulderWidth: number;
  torsoHeight: number;
  bustDepth: number;
  hipWidth: number;
}

export interface AtelierMannequinRig {
  group: THREE.Group;
  torsoGroup: THREE.Group;
  standGroup: THREE.Group;
  garmentMount: THREE.Group;
  anchors: MannequinBodyAnchors;
  dispose: () => void;
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function createLinenWeaveTextures(): {
  colorMap: THREE.CanvasTexture;
  normalMap: THREE.CanvasTexture;
  roughnessMap: THREE.CanvasTexture;
} {
  const size = 256;
  const colorCanvas = document.createElement('canvas');
  colorCanvas.width = size;
  colorCanvas.height = size;
  const cCtx = colorCanvas.getContext('2d');

  const normalCanvas = document.createElement('canvas');
  normalCanvas.width = size;
  normalCanvas.height = size;
  const nCtx = normalCanvas.getContext('2d');

  const roughCanvas = document.createElement('canvas');
  roughCanvas.width = size;
  roughCanvas.height = size;
  const rCtx = roughCanvas.getContext('2d');

  if (cCtx && nCtx && rCtx) {
    // Warm matte cream linen base (#EDE3D2)
    cCtx.fillStyle = '#EDE3D2';
    cCtx.fillRect(0, 0, size, size);

    const cImg = cCtx.getImageData(0, 0, size, size);
    const nImg = nCtx.createImageData(size, size);
    const rImg = rCtx.createImageData(size, size);

    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const idx = (y * size + x) * 4;
        // Authentic organic linen slub weave
        const warp = Math.sin(x * 1.15 + Math.sin(y * 0.14) * 1.6);
        const weft = Math.cos(y * 1.18 + Math.cos(x * 0.12) * 1.5);
        const slub = (warp * 0.55 + weft * 0.45) * 6.5;

        // Subtle vertical couture princess seam lines at 4 symmetrical panels
        const u = x / size;
        const seamDist = Math.min(
          Math.abs(u - 0.0),
          Math.abs(u - 0.25),
          Math.abs(u - 0.5),
          Math.abs(u - 0.75),
          Math.abs(u - 1.0),
        );
        const seamDarken = seamDist < 0.0055 ? -18 : 0;

        cImg.data[idx] = clamp(Math.round(237 + slub + seamDarken), 190, 252);
        cImg.data[idx + 1] = clamp(Math.round(227 + slub * 0.92 + seamDarken), 180, 245);
        cImg.data[idx + 2] = clamp(Math.round(210 + slub * 0.85 + seamDarken), 165, 232);
        cImg.data[idx + 3] = 255;

        const nx = clamp(warp * 0.22, -0.5, 0.5);
        const ny = clamp(weft * 0.22, -0.5, 0.5);
        nImg.data[idx] = Math.round((nx * 0.5 + 0.5) * 255);
        nImg.data[idx + 1] = Math.round((ny * 0.5 + 0.5) * 255);
        nImg.data[idx + 2] = 248;
        nImg.data[idx + 3] = 255;

        const rough = clamp(Math.round((0.88 - (warp * weft) * 0.05) * 255), 195, 245);
        rImg.data[idx] = rough;
        rImg.data[idx + 1] = rough;
        rImg.data[idx + 2] = rough;
        rImg.data[idx + 3] = 255;
      }
    }

    cCtx.putImageData(cImg, 0, 0);
    nCtx.putImageData(nImg, 0, 0);
    rCtx.putImageData(rImg, 0, 0);
  }

  const setupTex = (canvas: HTMLCanvasElement, srgb: boolean) => {
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(3, 4);
    tex.anisotropy = 4;
    tex.needsUpdate = true;
    return tex;
  };

  return {
    colorMap: setupTex(colorCanvas, true),
    normalMap: setupTex(normalCanvas, false),
    roughnessMap: setupTex(roughCanvas, false),
  };
}

function createFloorShadowTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const grad = ctx.createRadialGradient(128, 128, 10, 128, 128, 118);
    grad.addColorStop(0, 'rgba(18, 12, 8, 0.34)');
    grad.addColorStop(0.45, 'rgba(18, 12, 8, 0.14)');
    grad.addColorStop(1, 'rgba(18, 12, 8, 0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 256, 256);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Sculpts an anatomical dressmaker torso form from a high-resolution LatheGeometry
 * reshaped into realistic elliptical chest, tapered waist, and sculpted pelvis cross-sections.
 */
function buildSculptedTorsoGeometry(): THREE.BufferGeometry {
  // Profile points from lower pelvis cap (y = -0.22) up to neck top (y = +0.62)
  const profile: Array<[number, number]> = [
    [0.015, -0.225],
    [0.125, -0.215],
    [0.172, -0.17],
    [0.194, -0.1], // lower hip
    [0.186, -0.02], // upper hip
    [0.148, 0.08],
    [0.132, 0.16], // natural waist
    [0.144, 0.24], // ribcage
    [0.176, 0.34], // bust line
    [0.178, 0.42], // upper chest
    [0.192, 0.495], // sculpted shoulder cap
    [0.142, 0.538], // trapezius slope
    [0.068, 0.575], // neck base
    [0.058, 0.625], // neck column
    [0.054, 0.642],
  ];

  const lathePoints = profile.map(([r, y]) => new THREE.Vector2(r, y));
  const geo = new THREE.LatheGeometry(lathePoints, 52);

  // Reshape circular lathe into realistic couture dress-form anatomy (wider X, sculpted Z)
  const pos = geo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i += 1) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);

    const theta = Math.atan2(x, z); // 0 = front (+Z), PI = back (-Z)
    const frontFactor = Math.max(0, Math.cos(theta));
    const backFactor = Math.max(0, -Math.cos(theta));

    // Elliptical X/Z ratio varies by anatomical zone
    const shoulderZone = Math.exp(-Math.pow((y - 0.49) / 0.065, 2));
    const bustZone = Math.exp(-Math.pow((y - 0.345) / 0.085, 2));
    const waistZone = Math.exp(-Math.pow((y - 0.16) / 0.08, 2));
    const hipZone = Math.exp(-Math.pow((y + 0.08) / 0.11, 2));
    const neckZone = Math.exp(-Math.pow((y - 0.605) / 0.055, 2));

    const scaleX =
      1.04 +
      shoulderZone * 0.14 +
      hipZone * 0.06 -
      neckZone * 0.08;
    const scaleZ =
      0.66 -
      shoulderZone * 0.15 +
      bustZone * 0.08 +
      hipZone * 0.05 +
      neckZone * 0.24;

    // Anterior bust contour & subtle back lumbar hollow + seat fullness
    const bustLift = bustZone * frontFactor * frontFactor * 0.024;
    const lumbarHollow = -waistZone * backFactor * 0.014;
    const seatCurve = hipZone * backFactor * backFactor * 0.018;

    const newX = x * scaleX;
    const newZ = z * scaleZ + bustLift + lumbarHollow - seatCurve;

    pos.setXYZ(i, newX, y, newZ);
  }

  pos.needsUpdate = true;
  geo.computeVertexNormals();
  return geo;
}

/**
 * Builds an elegant procedural 3D Couture Dressmaker Mannequin:
 * - Sculpted matte cream linen torso (#EDE3D2) with procedural weave normal & roughness
 * - Brushed champagne brass neck finial & collar ring
 * - Subtle gold waist ribbon
 * - Vintage 3-legged curved brass tripod stand & floor contact shadow
 */
export function createAtelierMannequin3D(
  initialMeasurements?: BodyMeasurements3D,
): AtelierMannequinRig {
  const disposables: Array<{ dispose: () => void }> = [];

  const linenTex = createLinenWeaveTextures();
  disposables.push(linenTex.colorMap, linenTex.normalMap, linenTex.roughnessMap);

  const linenMat = new THREE.MeshPhysicalMaterial({
    map: linenTex.colorMap,
    normalMap: linenTex.normalMap,
    normalScale: new THREE.Vector2(0.45, 0.45),
    roughnessMap: linenTex.roughnessMap,
    roughness: 0.88,
    metalness: 0.0,
    sheen: 0.45,
    sheenRoughness: 0.72,
    sheenColor: new THREE.Color('#FAF3E6'),
    envMapIntensity: 0.9,
  });
  disposables.push(linenMat);

  const brassMat = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color('#C9A462'),
    metalness: 0.84,
    roughness: 0.26,
    clearcoat: 0.24,
    clearcoatRoughness: 0.22,
    envMapIntensity: 1.35,
  });
  disposables.push(brassMat);

  const darkBrassMat = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color('#8D6F3D'),
    metalness: 0.78,
    roughness: 0.36,
    envMapIntensity: 1.15,
  });
  disposables.push(darkBrassMat);

  const ribbonMat = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color('#B08A4A'),
    metalness: 0.38,
    roughness: 0.36,
    sheen: 0.65,
    sheenColor: new THREE.Color('#F3DDA5'),
  });
  disposables.push(ribbonMat);

  // 1. Sculpted Linen Torso
  const torsoGroup = new THREE.Group();
  torsoGroup.name = 'mannequin-torso-group';

  const torsoGeo = buildSculptedTorsoGeometry();
  disposables.push(torsoGeo);
  const torsoMesh = new THREE.Mesh(torsoGeo, linenMat);
  torsoMesh.name = 'mannequin-linen-torso';
  torsoMesh.renderOrder = 2;
  torsoGroup.add(torsoMesh);

  // 2. Brushed Champagne Brass Neck Finial + Collar Cap
  const finialProfile = [
    new THREE.Vector2(0.056, 0.638),
    new THREE.Vector2(0.062, 0.648),
    new THREE.Vector2(0.048, 0.662),
    new THREE.Vector2(0.022, 0.678),
    new THREE.Vector2(0.036, 0.706),
    new THREE.Vector2(0.041, 0.728),
    new THREE.Vector2(0.024, 0.752),
    new THREE.Vector2(0.011, 0.768),
    new THREE.Vector2(0.0, 0.774),
  ];
  const finialGeo = new THREE.LatheGeometry(finialProfile, 32);
  disposables.push(finialGeo);
  const finialMesh = new THREE.Mesh(finialGeo, brassMat);
  finialMesh.name = 'mannequin-brass-finial';
  finialMesh.renderOrder = 3;
  torsoGroup.add(finialMesh);

  // 3. Subtle Champagne Gold Waist Ribbon Band
  const waistRibbonGeo = new THREE.TorusGeometry(0.136, 0.0055, 12, 48);
  disposables.push(waistRibbonGeo);
  const waistRibbon = new THREE.Mesh(waistRibbonGeo, ribbonMat);
  waistRibbon.name = 'mannequin-waist-ribbon';
  waistRibbon.rotation.x = Math.PI / 2;
  waistRibbon.scale.set(1.04, 0.68, 1.0);
  waistRibbon.position.y = 0.16;
  waistRibbon.renderOrder = 3;
  torsoGroup.add(waistRibbon);

  // Lower torso wood/brass trim cap
  const baseTrimGeo = new THREE.CylinderGeometry(0.072, 0.052, 0.036, 28);
  disposables.push(baseTrimGeo);
  const baseTrim = new THREE.Mesh(baseTrimGeo, darkBrassMat);
  baseTrim.position.y = -0.232;
  torsoGroup.add(baseTrim);

  // 4. Vintage 3-Legged Brass Tripod Stand
  const standGroup = new THREE.Group();
  standGroup.name = 'mannequin-tripod-stand';

  const poleGeo = new THREE.CylinderGeometry(0.015, 0.018, 0.86, 20);
  disposables.push(poleGeo);
  const poleMesh = new THREE.Mesh(poleGeo, brassMat);
  poleMesh.position.y = -0.66;
  standGroup.add(poleMesh);

  // Decorative turned brass hub
  const hubGeo = new THREE.CylinderGeometry(0.034, 0.044, 0.09, 24);
  disposables.push(hubGeo);
  const hubMesh = new THREE.Mesh(hubGeo, darkBrassMat);
  hubMesh.position.y = -0.84;
  standGroup.add(hubMesh);

  // 3 sculpted cabriole brass legs
  const footGeo = new THREE.SphereGeometry(0.016, 12, 10);
  disposables.push(footGeo);

  for (let legIdx = 0; legIdx < 3; legIdx += 1) {
    const angle = (legIdx * Math.PI * 2) / 3 + Math.PI / 6;
    const cosA = Math.cos(angle);
    const sinA = Math.sin(angle);

    const curve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(cosA * 0.025, -0.84, sinA * 0.025),
      new THREE.Vector3(cosA * 0.13, -0.9, sinA * 0.13),
      new THREE.Vector3(cosA * 0.22, -1.03, sinA * 0.22),
      new THREE.Vector3(cosA * 0.275, -1.14, sinA * 0.275),
    ]);
    const legGeo = new THREE.TubeGeometry(curve, 20, 0.011, 10, false);
    disposables.push(legGeo);
    const legMesh = new THREE.Mesh(legGeo, brassMat);
    standGroup.add(legMesh);

    const footMesh = new THREE.Mesh(footGeo, darkBrassMat);
    footMesh.position.set(cosA * 0.275, -1.145, sinA * 0.275);
    standGroup.add(footMesh);
  }

  // Subtle floor contact shadow disc
  const shadowTex = createFloorShadowTexture();
  disposables.push(shadowTex);
  const shadowGeo = new THREE.PlaneGeometry(0.95, 0.95);
  disposables.push(shadowGeo);
  const shadowMat = new THREE.MeshBasicMaterial({
    map: shadowTex,
    transparent: true,
    opacity: 0.72,
    depthWrite: false,
  });
  disposables.push(shadowMat);
  const floorShadow = new THREE.Mesh(shadowGeo, shadowMat);
  floorShadow.rotation.x = -Math.PI / 2;
  floorShadow.position.y = -1.152;
  floorShadow.renderOrder = 1;
  standGroup.add(floorShadow);

  const garmentMount = new THREE.Group();
  garmentMount.name = 'mannequin-garment-mount';

  const group = new THREE.Group();
  group.name = 'atelier-mannequin-3d';
  group.add(standGroup, torsoGroup, garmentMount);

  const rig: AtelierMannequinRig = {
    group,
    torsoGroup,
    standGroup,
    garmentMount,
    anchors: {
      collarY: 0.565,
      shoulderY: 0.495,
      bustY: 0.345,
      waistY: 0.16,
      hipY: -0.08,
      hemY: -0.82,
      shoulderWidth: 0.41,
      torsoHeight: 0.58,
      bustDepth: 0.145,
      hipWidth: 0.41,
    },
    dispose: () => {
      for (const d of disposables) {
        d.dispose();
      }
    },
  };

  if (initialMeasurements) {
    updateMannequinBodyProportions(rig, initialMeasurements);
  }

  return rig;
}

/**
 * Dynamically scales shoulder width, bust depth, waist taper, hip curve, and height
 * smoothly from `BodyMeasurements3D` (anchored around Atelier Size M: 164cm, 55kg, 88-70-94).
 */
export function updateMannequinBodyProportions(
  rig: AtelierMannequinRig,
  measurements?: BodyMeasurements3D | null,
): MannequinBodyAnchors {
  const heightCm = clamp(measurements?.heightCm ?? 164, 145, 192);
  const weightKg = clamp(measurements?.weightKg ?? 55, 38, 105);
  const bustCm = clamp(
    measurements?.bustCm ?? 82 + (weightKg - 48) * 0.72,
    72,
    118,
  );
  const waistCm = clamp(
    measurements?.waistCm ?? 64 + (weightKg - 48) * 0.78,
    54,
    104,
  );
  const hipCm = clamp(
    measurements?.hipCm ?? 88 + (weightKg - 48) * 0.75,
    78,
    124,
  );

  // Normalized scale factors relative to Atelier canonical M (164cm, 55kg, 88-70-94)
  const heightScale = clamp(heightCm / 164, 0.89, 1.15);
  const girthAvg =
    (bustCm / 88) * 0.4 + (waistCm / 70) * 0.25 + (hipCm / 94) * 0.35;
  const widthScale = clamp(girthAvg, 0.86, 1.24);
  const depthScale = clamp(
    (bustCm / 88) * 0.52 + (hipCm / 94) * 0.48,
    0.86,
    1.26,
  );

  rig.torsoGroup.scale.set(widthScale, heightScale, depthScale);
  // Keep torso base nicely anchored on the brass pole as height scales
  rig.torsoGroup.position.y = (heightScale - 1) * 0.22;

  const yOff = rig.torsoGroup.position.y;
  const anchors: MannequinBodyAnchors = {
    collarY: 0.565 * heightScale + yOff,
    shoulderY: 0.495 * heightScale + yOff,
    bustY: 0.345 * heightScale + yOff,
    waistY: 0.16 * heightScale + yOff,
    hipY: -0.08 * heightScale + yOff,
    hemY: -0.82 * heightScale + yOff,
    shoulderWidth: 0.41 * widthScale,
    torsoHeight: 0.58 * heightScale,
    bustDepth: 0.145 * depthScale,
    hipWidth: 0.41 * widthScale,
  };

  rig.anchors = anchors;
  return anchors;
}
