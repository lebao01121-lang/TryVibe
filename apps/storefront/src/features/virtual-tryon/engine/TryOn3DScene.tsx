'use client';

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import {
  createAtelierMannequin3D,
  updateMannequinBodyProportions,
  type AtelierMannequinRig,
} from './AtelierMannequin3D';
import {
  createDepthOccluderRig,
  updateDepthOccluders,
  type DepthOccluderRig,
  type ViewportWorldPlane,
} from './DepthOccluderMesh';
import {
  buildFallbackPoseFrame,
  closePoseTrackers,
  detectPhotoPoseSafe,
  detectVideoPoseSync,
  getVideoPoseLandmarker,
  PoseStreamFilterBank,
} from './poseTracker';
import {
  buildGarmentTextureBundle,
  disposeGarmentTextureBundle,
} from './texturePipeline';
import type {
  ArmPoseAngles,
  CameraStatus3D,
  Garment3DLayerSpec,
  GarmentSlot3D,
  PhotoAdjustments,
  PoseTracking3DFrame,
  TailorPinOverlayData,
  TryOn3DLightingMode,
  TryOn3DSceneHandle,
  TryOn3DSceneProps,
} from './types';
import {
  createVolumetricGarmentRig,
  deformVolumetricGarment,
  swapVolumetricGarmentTexture,
  type VolumetricGarmentRig,
} from './VolumetricGarmentMesh';

interface LightingPresetConfig {
  hemiSky: number;
  hemiGround: number;
  hemiIntensity: number;
  keyColor: number;
  keyIntensity: number;
  fillColor: number;
  fillIntensity: number;
  rimColor: number;
  rimIntensity: number;
  exposure: number;
  backdropCss: string;
  canvasBgTop: string;
  canvasBgMid: string;
  canvasBgBottom: string;
}

const LIGHTING_PRESETS: Record<TryOn3DLightingMode, LightingPresetConfig> = {
  morning: {
    hemiSky: 0xfff8ec,
    hemiGround: 0xd6c4ac,
    hemiIntensity: 1.05,
    keyColor: 0xfff2dc,
    keyIntensity: 2.15,
    fillColor: 0xdce8f8,
    fillIntensity: 0.92,
    rimColor: 0xffe0b2,
    rimIntensity: 1.35,
    exposure: 1.12,
    backdropCss:
      'radial-gradient(ellipse at 50% 26%, #45392F 0%, #2C231C 56%, #1B1510 100%)',
    canvasBgTop: '#45392F',
    canvasBgMid: '#2C231C',
    canvasBgBottom: '#1B1510',
  },
  showroom: {
    hemiSky: 0xfbf6ee,
    hemiGround: 0x9e8c78,
    hemiIntensity: 0.88,
    keyColor: 0xfff8ee,
    keyIntensity: 1.98,
    fillColor: 0xf0e7d8,
    fillIntensity: 0.95,
    rimColor: 0xf2d9a4,
    rimIntensity: 1.48,
    exposure: 1.06,
    backdropCss:
      'radial-gradient(ellipse at 50% 30%, #342920 0%, #201812 58%, #140F0B 100%)',
    canvasBgTop: '#342920',
    canvasBgMid: '#201812',
    canvasBgBottom: '#140F0B',
  },
  evening: {
    hemiSky: 0xe6d4ec,
    hemiGround: 0x3b2c25,
    hemiIntensity: 0.56,
    keyColor: 0xffdfba,
    keyIntensity: 1.82,
    fillColor: 0x6f5a7a,
    fillIntensity: 0.68,
    rimColor: 0xf5c874,
    rimIntensity: 2.15,
    exposure: 1.0,
    backdropCss:
      'radial-gradient(ellipse at 50% 28%, #271E2B 0%, #161017 58%, #0C090D 100%)',
    canvasBgTop: '#271E2B',
    canvasBgMid: '#161017',
    canvasBgBottom: '#0C090D',
  },
};

const SLOT_ORDER: readonly GarmentSlot3D[] = [
  'BOTTOM',
  'TOP',
  'ONE_PIECE',
  'OUTERWEAR',
];

const DEFAULT_PHOTO_ADJUSTMENTS: PhotoAdjustments = {
  offsetX: 0,
  offsetY: 0,
  scale: 1,
};

const ZERO_ARMS: ArmPoseAngles = {
  leftElbowAngle: 0,
  rightElbowAngle: 0,
  leftShoulderLift: 0,
  rightShoulderLift: 0,
};

const EMPTY_TAILOR_PINS: TailorPinOverlayData = {
  visible: false,
  confidence: 0,
  seatedMode: false,
  leftShoulder: { x: 0.35, y: 0.38 },
  rightShoulder: { x: 0.65, y: 0.38 },
  collar: { x: 0.5, y: 0.34 },
};

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function drawCoverImage(
  ctx: CanvasRenderingContext2D,
  source: CanvasImageSource,
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
  mirrored: boolean,
): void {
  const safeSrcW = Math.max(1, srcW);
  const safeSrcH = Math.max(1, srcH);
  const srcAspect = safeSrcW / safeSrcH;
  const dstAspect = dstW / dstH;

  let sx = 0;
  let sy = 0;
  let sw = safeSrcW;
  let sh = safeSrcH;

  if (srcAspect > dstAspect) {
    sw = safeSrcH * dstAspect;
    sx = (safeSrcW - sw) * 0.5;
  } else {
    sh = safeSrcW / dstAspect;
    sy = (safeSrcH - sh) * 0.5;
  }

  ctx.save();
  if (mirrored) {
    ctx.translate(dstW, 0);
    ctx.scale(-1, 1);
  }
  ctx.drawImage(source, sx, sy, sw, sh, 0, 0, dstW, dstH);
  ctx.restore();
}

function computeVisibleWorldPlane(
  camera: THREE.PerspectiveCamera,
): ViewportWorldPlane {
  const dist = Math.max(0.5, camera.position.z);
  const vFovRad = THREE.MathUtils.degToRad(camera.fov);
  const worldHeight = 2 * Math.tan(vFovRad * 0.5) * dist;
  const worldWidth = worldHeight * Math.max(0.3, camera.aspect);
  return { worldWidth, worldHeight };
}

function applyGarmentsToMannequin(
  rigs: Map<GarmentSlot3D, VolumetricGarmentRig>,
  mannequin: AtelierMannequinRig,
): void {
  const a = mannequin.anchors;
  const hasOnePiece = rigs.has('ONE_PIECE');
  const hasTop = rigs.has('TOP');

  for (const slot of SLOT_ORDER) {
    const rig = rigs.get(slot);
    if (!rig) continue;

    if (rig.group.parent !== mannequin.garmentMount) {
      mannequin.garmentMount.add(rig.group);
    }

    const aspect = clamp(rig.bundle.bounds.aspectRatio || 0.72, 0.36, 1.38);

    let targetH = rig.baseHeight;
    let targetW = rig.baseWidth;
    let centerY = 0;
    let depthMult = 1.06;
    let zShift = 0;

    if (slot === 'ONE_PIECE') {
      targetH = Math.max(1.18, (a.collarY - a.hemY) * 0.96);
      targetW = clamp(
        Math.max(a.shoulderWidth * 1.56, targetH * aspect * 0.86),
        a.shoulderWidth * 1.45,
        0.98,
      );
      centerY = a.shoulderY + 0.048 - targetH * 0.48;
      depthMult = Math.max(1.08, a.bustDepth / 0.132);
      zShift = 0.008;
    } else if (slot === 'TOP') {
      targetH = a.torsoHeight * 1.18;
      targetW = clamp(
        Math.max(a.shoulderWidth * 1.58, targetH * aspect * 0.92),
        a.shoulderWidth * 1.46,
        0.86,
      );
      centerY = a.shoulderY + 0.044 - targetH * 0.45;
      depthMult = Math.max(1.08, a.bustDepth / 0.13);
      zShift = 0.012;
    } else if (slot === 'BOTTOM') {
      targetH = a.torsoHeight * 1.52;
      targetW = clamp(
        Math.max(a.hipWidth * 1.38, targetH * aspect * 0.92),
        a.hipWidth * 1.24,
        0.82,
      );
      centerY = a.waistY + 0.03 - targetH * 0.48;
      depthMult = Math.max(1.04, a.bustDepth / 0.136);
      zShift = 0.0;
    } else {
      // OUTERWEAR wraps cleanly outside inner TOP or ONE_PIECE
      targetH = a.torsoHeight * (hasOnePiece ? 1.34 : 1.42);
      targetW = clamp(
        Math.max(a.shoulderWidth * 1.74, targetH * aspect * 0.96),
        a.shoulderWidth * 1.62,
        0.96,
      );
      centerY = a.shoulderY + 0.056 - targetH * 0.45;
      const outerBoost = hasOnePiece || hasTop ? 1.22 : 1.12;
      depthMult = Math.max(1.18, (a.bustDepth / 0.128) * outerBoost);
      zShift = hasOnePiece || hasTop ? 0.022 : 0.012;
    }

    rig.group.position.set(0, centerY, zShift);
    rig.group.rotation.set(0, 0, 0);
    rig.group.scale.set(
      targetW / rig.baseWidth,
      targetH / rig.baseHeight,
      depthMult,
    );
  }
}

function applyGarmentsToPose(
  rigs: Map<GarmentSlot3D, VolumetricGarmentRig>,
  arMount: THREE.Group,
  pose: PoseTracking3DFrame | null,
  plane: ViewportWorldPlane,
  adjustments: PhotoAdjustments,
): void {
  const visible = Boolean(pose && pose.detected);
  arMount.visible = visible;
  if (!visible || !pose) return;

  const hasInnerLayer = rigs.has('TOP') || rigs.has('ONE_PIECE');
  const userScale = clamp(adjustments.scale || 1, 0.65, 1.55);
  const offX = clamp(adjustments.offsetX || 0, -0.35, 0.35) * plane.worldWidth;
  const offY = -clamp(adjustments.offsetY || 0, -0.35, 0.35) * plane.worldHeight;

  const shoulderX = (pose.shoulderCenter.x - 0.5) * plane.worldWidth + offX;
  const shoulderY = (0.5 - pose.shoulderCenter.y) * plane.worldHeight + offY;
  const hipX = (pose.hipCenter.x - 0.5) * plane.worldWidth + offX;
  const hipY = (0.5 - pose.hipCenter.y) * plane.worldHeight + offY;

  const shoulderWorldW =
    Math.max(0.24, pose.shoulderWidth * plane.worldWidth) * userScale;
  const torsoWorldH =
    Math.max(0.32, pose.torsoHeight * plane.worldHeight) * userScale;

  for (const slot of SLOT_ORDER) {
    const rig = rigs.get(slot);
    if (!rig) continue;

    if (rig.group.parent !== arMount) {
      arMount.add(rig.group);
    }

    const aspect = clamp(rig.bundle.bounds.aspectRatio || 0.72, 0.36, 1.38);

    let targetH = rig.baseHeight;
    let targetW = rig.baseWidth;
    let anchorX = shoulderX;
    let anchorY = shoulderY;
    let zPos = 0.02;
    let depthScale = clamp(shoulderWorldW / 0.44, 0.65, 1.45);

    if (slot === 'ONE_PIECE') {
      targetH = torsoWorldH * 2.02;
      targetW = clamp(
        Math.max(shoulderWorldW * 1.54, targetH * aspect * 0.78),
        shoulderWorldW * 1.42,
        shoulderWorldW * 2.45,
      );
      anchorX = shoulderX * 0.6 + hipX * 0.4;
      anchorY = shoulderY + torsoWorldH * 0.1 - targetH * 0.46;
      zPos = 0.024;
    } else if (slot === 'TOP') {
      targetH = torsoWorldH * 1.2;
      targetW = clamp(
        Math.max(shoulderWorldW * 1.56, targetH * aspect * 0.9),
        shoulderWorldW * 1.44,
        shoulderWorldW * 2.35,
      );
      anchorX = shoulderX * 0.78 + hipX * 0.22;
      anchorY = shoulderY + torsoWorldH * 0.11 - targetH * 0.44;
      zPos = 0.028;
    } else if (slot === 'BOTTOM') {
      targetH = torsoWorldH * 1.46;
      targetW = clamp(
        Math.max(shoulderWorldW * 1.24, targetH * aspect * 0.88),
        shoulderWorldW * 1.12,
        shoulderWorldW * 1.95,
      );
      const waistX = shoulderX * 0.28 + hipX * 0.72;
      const waistY = shoulderY * 0.26 + hipY * 0.74;
      anchorX = waistX;
      anchorY = waistY + torsoWorldH * 0.08 - targetH * 0.47;
      zPos = 0.008;
    } else {
      // OUTERWEAR sits cleanly in front of inner TOP / ONE_PIECE
      targetH = torsoWorldH * 1.38;
      targetW = clamp(
        Math.max(shoulderWorldW * 1.72, targetH * aspect * 0.94),
        shoulderWorldW * 1.58,
        shoulderWorldW * 2.6,
      );
      anchorX = shoulderX * 0.75 + hipX * 0.25;
      anchorY = shoulderY + torsoWorldH * 0.13 - targetH * 0.44;
      zPos = hasInnerLayer ? 0.064 : 0.032;
      depthScale *= hasInnerLayer ? 1.16 : 1.05;
    }

    rig.group.position.set(anchorX, anchorY, zPos);
    // Screen Y points down while Three.js Y points up -> invert rollZ sign
    rig.group.rotation.set(pose.pitchX, pose.yawY, -pose.rollZ);
    rig.group.scale.set(
      targetW / rig.baseWidth,
      targetH / rig.baseHeight,
      depthScale,
    );
  }
}

export const TryOn3DScene = forwardRef<TryOn3DSceneHandle, TryOn3DSceneProps>(
  function TryOn3DScene(
    {
      mode,
      garments,
      lightingMode = 'showroom',
      bodyMeasurements,
      cameraEnabled = true,
      showTailorPins = true,
      onCameraStatusChange,
      onTailorPinsUpdate,
      onRequestModeSwitch,
      photoUrl = null,
      photoPoseHint = null,
      photoAdjustments = DEFAULT_PHOTO_ADJUSTMENTS,
      beforeAfterSplitPct = null,
      onMannequinSideChange,
      className = '',
    },
    ref,
  ) {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const canvasHostRef = useRef<HTMLDivElement | null>(null);
    const videoRef = useRef<HTMLVideoElement | null>(null);
    const photoImgRef = useRef<HTMLImageElement | null>(null);
    const streamRef = useRef<MediaStream | null>(null);

    // Core imperative Three.js handles
    const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
    const sceneRef = useRef<THREE.Scene | null>(null);
    const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
    const envRtRef = useRef<THREE.WebGLRenderTarget | null>(null);
    const lightsRef = useRef<{
      hemi: THREE.HemisphereLight;
      key: THREE.DirectionalLight;
      fill: THREE.DirectionalLight;
      rim: THREE.DirectionalLight;
    } | null>(null);
    const mannequinRef = useRef<AtelierMannequinRig | null>(null);
    const occluderRef = useRef<DepthOccluderRig | null>(null);
    const arMountRef = useRef<THREE.Group | null>(null);
    const garmentRigsRef = useRef<Map<GarmentSlot3D, VolumetricGarmentRig>>(
      new Map(),
    );
    const loadEpochRef = useRef(0);

    // Live animation & state refs (avoiding stale closures inside 60 FPS rAF)
    const modeRef = useRef(mode);
    modeRef.current = mode;
    const lightingRef = useRef(lightingMode);
    lightingRef.current = lightingMode;
    const photoAdjustmentsRef = useRef(photoAdjustments);
    photoAdjustmentsRef.current = photoAdjustments;
    const showTailorPinsRef = useRef(showTailorPins);
    showTailorPinsRef.current = showTailorPins;
    const onTailorPinsUpdateRef = useRef(onTailorPinsUpdate);
    onTailorPinsUpdateRef.current = onTailorPinsUpdate;
    const onCameraStatusChangeRef = useRef(onCameraStatusChange);
    onCameraStatusChangeRef.current = onCameraStatusChange;
    const onMannequinSideChangeRef = useRef(onMannequinSideChange);
    onMannequinSideChangeRef.current = onMannequinSideChange;

    // Pose tracking refs
    const videoLandmarkerRef =
      useRef<Awaited<ReturnType<typeof getVideoPoseLandmarker>>>(null);
    const filterBankRef = useRef<PoseStreamFilterBank>(
      new PoseStreamFilterBank(),
    );
    const cameraPoseRef = useRef<PoseTracking3DFrame | null>(null);
    const photoPoseRef = useRef<PoseTracking3DFrame | null>(null);
    const lastPoseDetectMsRef = useRef(0);
    const prevShoulderXRef = useRef(0.5);
    const lastPinEmitMsRef = useRef(0);

    // Mannequin 360° orbit & zoom state refs
    const orbitRef = useRef({
      yaw: 0,
      targetYaw: 0,
      pitch: 0.04,
      targetPitch: 0.04,
      zoom: 1.0,
      targetZoom: 1.0,
      isDragging: false,
      lastX: 0,
      lastY: 0,
      prevYaw: 0,
      side: 'front' as 'front' | 'back',
      activePointers: new Map<number, { x: number; y: number }>(),
      lastPinchDist: null as number | null,
    });

    const [webglFailed, setWebglFailed] = useState(false);
    const [cameraStatus, setCameraStatus] = useState<CameraStatus3D>('idle');
    const [cameraMessage, setCameraMessage] = useState<string>('');
    const [tailorPins, setTailorPins] =
      useState<TailorPinOverlayData>(EMPTY_TAILOR_PINS);
    const [loadingGarments, setLoadingGarments] = useState(false);

    const updateCameraStatus = useCallback(
      (nextStatus: CameraStatus3D, msg = '') => {
        setCameraStatus(nextStatus);
        setCameraMessage(msg);
        onCameraStatusChangeRef.current?.(nextStatus, msg || undefined);
      },
      [],
    );

    const stopAllCameraTracks = useCallback(() => {
      const stream = streamRef.current;
      if (stream) {
        stream.getTracks().forEach((track) => {
          try {
            track.stop();
          } catch {
            // Ignore already-stopped track
          }
        });
        streamRef.current = null;
      }

      const video = videoRef.current;
      if (video) {
        if (video.srcObject && 'getTracks' in video.srcObject) {
          (video.srcObject as MediaStream).getTracks().forEach((track) => {
            try {
              track.stop();
            } catch {
              // Ignore
            }
          });
        }
        video.srcObject = null;
      }
      cameraPoseRef.current = null;
      setTailorPins(EMPTY_TAILOR_PINS);
    }, []);

    // Expose imperative methods: captureComposite3x4, resetMannequinOrbit, flipMannequinSide
    useImperativeHandle(
      ref,
      () => ({
        captureComposite3x4: async (): Promise<string | null> => {
          const renderer = rendererRef.current;
          const scene = sceneRef.current;
          const camera = cameraRef.current;
          if (!renderer || !scene || !camera) return null;

          // Render a fresh frame so preserveDrawingBuffer holds latest state
          try {
            renderer.render(scene, camera);
          } catch {
            return null;
          }

          const outW = 768;
          const outH = 1024;
          const outCanvas = document.createElement('canvas');
          outCanvas.width = outW;
          outCanvas.height = outH;
          const ctx = outCanvas.getContext('2d');
          if (!ctx) return null;

          const activeMode = modeRef.current;
          const preset = LIGHTING_PRESETS[lightingRef.current];

          if (activeMode === 'camera') {
            const video = videoRef.current;
            if (
              video &&
              video.readyState >= 2 &&
              video.videoWidth > 0 &&
              video.videoHeight > 0
            ) {
              drawCoverImage(
                ctx,
                video,
                video.videoWidth,
                video.videoHeight,
                outW,
                outH,
                true,
              );
            } else {
              const grad = ctx.createLinearGradient(0, 0, 0, outH);
              grad.addColorStop(0, preset.canvasBgTop);
              grad.addColorStop(0.55, preset.canvasBgMid);
              grad.addColorStop(1, preset.canvasBgBottom);
              ctx.fillStyle = grad;
              ctx.fillRect(0, 0, outW, outH);
            }
          } else if (activeMode === 'photo') {
            const img = photoImgRef.current;
            if (img && img.complete && img.naturalWidth > 0 && img.naturalHeight > 0) {
              try {
                drawCoverImage(
                  ctx,
                  img,
                  img.naturalWidth,
                  img.naturalHeight,
                  outW,
                  outH,
                  false,
                );
              } catch {
                ctx.fillStyle = '#1C1410';
                ctx.fillRect(0, 0, outW, outH);
              }
            } else {
              ctx.fillStyle = '#1C1410';
              ctx.fillRect(0, 0, outW, outH);
            }
          } else {
            // Mannequin studio backdrop gradient
            const grad = ctx.createRadialGradient(
              outW * 0.5,
              outH * 0.3,
              40,
              outW * 0.5,
              outH * 0.48,
              outH * 0.72,
            );
            grad.addColorStop(0, preset.canvasBgTop);
            grad.addColorStop(0.58, preset.canvasBgMid);
            grad.addColorStop(1, preset.canvasBgBottom);
            ctx.fillStyle = grad;
            ctx.fillRect(0, 0, outW, outH);
          }

          // Composite live transparent WebGL 3D canvas cleanly onto 3:4 frame
          const glCanvas = renderer.domElement;
          if (glCanvas.width > 0 && glCanvas.height > 0) {
            drawCoverImage(
              ctx,
              glCanvas,
              glCanvas.width,
              glCanvas.height,
              outW,
              outH,
              false,
            );
          }

          // Whisper-subtle Atelier signature stamp in bottom right corner
          ctx.save();
          ctx.font = '500 16px Georgia, serif';
          ctx.fillStyle = 'rgba(235, 207, 143, 0.58)';
          ctx.textAlign = 'right';
          ctx.fillText('ATELIER 3D', outW - 24, outH - 22);
          ctx.restore();

          try {
            const webp = outCanvas.toDataURL('image/webp', 0.92);
            if (webp.startsWith('data:image/webp')) {
              return webp;
            }
          } catch {
            // Fall through to PNG
          }

          try {
            return outCanvas.toDataURL('image/png');
          } catch {
            return null;
          }
        },

        resetMannequinOrbit: () => {
          orbitRef.current.targetYaw = 0;
          orbitRef.current.targetPitch = 0.04;
          orbitRef.current.targetZoom = 1.0;
          if (orbitRef.current.side !== 'front') {
            orbitRef.current.side = 'front';
            onMannequinSideChangeRef.current?.('front');
          }
        },

        flipMannequinSide: () => {
          const nextSide =
            orbitRef.current.side === 'front' ? 'back' : 'front';
          orbitRef.current.side = nextSide;
          // Rotate smoothly to exact front (0) or back (PI) modulo full turns
          const currentTurns = Math.round(
            orbitRef.current.targetYaw / (Math.PI * 2),
          );
          orbitRef.current.targetYaw =
            currentTurns * Math.PI * 2 + (nextSide === 'back' ? Math.PI : 0);
          onMannequinSideChangeRef.current?.(nextSide);
        },
      }),
      [],
    );

    // 1. Initialize imperative Three.js Scene + WebGLRenderer + RoomEnvironment + 60 FPS loop
    useEffect(() => {
      const host = canvasHostRef.current;
      const container = containerRef.current;
      if (!host || !container) return undefined;

      let renderer: THREE.WebGLRenderer;
      try {
        renderer = new THREE.WebGLRenderer({
          antialias: true,
          alpha: true,
          powerPreference: 'high-performance',
          preserveDrawingBuffer: true,
        });
      } catch {
        setWebglFailed(true);
        return undefined;
      }

      const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      renderer.setPixelRatio(dpr);
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = LIGHTING_PRESETS[lightingRef.current].exposure;
      renderer.domElement.style.width = '100%';
      renderer.domElement.style.height = '100%';
      renderer.domElement.style.display = 'block';
      renderer.domElement.setAttribute('data-testid', 'tryon-3d-webgl-canvas');
      host.innerHTML = '';
      host.appendChild(renderer.domElement);

      const scene = new THREE.Scene();

      // Museum-grade PBR IBL from RoomEnvironment + PMREMGenerator
      const pmremGenerator = new THREE.PMREMGenerator(renderer);
      const roomEnv = new RoomEnvironment();
      const envRT = pmremGenerator.fromScene(roomEnv, 0.04);
      scene.environment = envRT.texture;
      roomEnv.dispose();
      pmremGenerator.dispose();

      const initW = Math.max(1, container.clientWidth);
      const initH = Math.max(1, container.clientHeight);
      const camera = new THREE.PerspectiveCamera(38, initW / initH, 0.1, 20);
      camera.position.set(0, -0.08, 2.72);
      camera.lookAt(0, -0.14, 0);
      renderer.setSize(initW, initH, false);

      // 3-Point Atelier Lighting Rig + Hemisphere bounce
      const initialPreset = LIGHTING_PRESETS[lightingRef.current];
      const hemi = new THREE.HemisphereLight(
        initialPreset.hemiSky,
        initialPreset.hemiGround,
        initialPreset.hemiIntensity,
      );
      const key = new THREE.DirectionalLight(
        initialPreset.keyColor,
        initialPreset.keyIntensity,
      );
      key.position.set(2.1, 2.8, 3.2);

      const fill = new THREE.DirectionalLight(
        initialPreset.fillColor,
        initialPreset.fillIntensity,
      );
      fill.position.set(-2.5, 1.1, 2.4);

      const rim = new THREE.DirectionalLight(
        initialPreset.rimColor,
        initialPreset.rimIntensity,
      );
      rim.position.set(-1.3, 2.3, -2.9);

      scene.add(hemi, key, fill, rim);

      // Procedural 3D Dressmaker Mannequin + AR Occluder + AR Garment Mount
      const mannequin = createAtelierMannequin3D(bodyMeasurements);
      mannequin.group.visible = modeRef.current === 'mannequin';
      scene.add(mannequin.group);

      const occluder = createDepthOccluderRig();
      occluder.group.visible = false;
      scene.add(occluder.group);

      const arMount = new THREE.Group();
      arMount.name = 'ar-garment-mount';
      arMount.visible = modeRef.current !== 'mannequin';
      scene.add(arMount);

      rendererRef.current = renderer;
      sceneRef.current = scene;
      cameraRef.current = camera;
      envRtRef.current = envRT;
      lightsRef.current = { hemi, key, fill, rim };
      mannequinRef.current = mannequin;
      occluderRef.current = occluder;
      arMountRef.current = arMount;

      // ResizeObserver for crisp responsive viewport across 1440×900, 1366×768 & 390×844
      const syncViewportSize = () => {
        const w = Math.max(1, container.clientWidth);
        const h = Math.max(1, container.clientHeight);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        renderer.setSize(w, h, false);
      };
      const resizeObserver =
        typeof ResizeObserver !== 'undefined'
          ? new ResizeObserver(syncViewportSize)
          : null;
      resizeObserver?.observe(container);

      const prefersReducedMotion =
        typeof window.matchMedia === 'function' &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches;

      // Reusable colors for zero-GC light preset interpolation
      const targetHemiSky = new THREE.Color();
      const targetHemiGround = new THREE.Color();
      const targetKeyCol = new THREE.Color();
      const targetFillCol = new THREE.Color();
      const targetRimCol = new THREE.Color();

      let rafId = 0;
      let prevTimeMs = performance.now();
      let idleClock = 0;

      const animate = (nowMs: number) => {
        rafId = window.requestAnimationFrame(animate);
        const dt = clamp((nowMs - prevTimeMs) / 1000, 0.001, 0.05);
        prevTimeMs = nowMs;
        idleClock += dt;

        const activeMode = modeRef.current;
        const preset = LIGHTING_PRESETS[lightingRef.current];
        const lightLerp = 1 - Math.exp(-6.5 * dt);

        // Smooth lighting temperature & intensity interpolation
        targetHemiSky.setHex(preset.hemiSky);
        targetHemiGround.setHex(preset.hemiGround);
        targetKeyCol.setHex(preset.keyColor);
        targetFillCol.setHex(preset.fillColor);
        targetRimCol.setHex(preset.rimColor);

        hemi.color.lerp(targetHemiSky, lightLerp);
        hemi.groundColor.lerp(targetHemiGround, lightLerp);
        hemi.intensity += (preset.hemiIntensity - hemi.intensity) * lightLerp;
        key.color.lerp(targetKeyCol, lightLerp);
        key.intensity += (preset.keyIntensity - key.intensity) * lightLerp;
        fill.color.lerp(targetFillCol, lightLerp);
        fill.intensity += (preset.fillIntensity - fill.intensity) * lightLerp;
        rim.color.lerp(targetRimCol, lightLerp);
        rim.intensity += (preset.rimIntensity - rim.intensity) * lightLerp;
        renderer.toneMappingExposure +=
          (preset.exposure - renderer.toneMappingExposure) * lightLerp;

        const rigs = garmentRigsRef.current;

        if (activeMode === 'mannequin') {
          mannequin.group.visible = true;
          arMount.visible = false;
          occluder.group.visible = false;

          // Smooth damped 360° orbit & zoom
          const orb = orbitRef.current;
          const ease = 1 - Math.exp(-10 * dt);
          orb.yaw += (orb.targetYaw - orb.yaw) * ease;
          orb.pitch += (orb.targetPitch - orb.pitch) * ease;
          orb.zoom += (orb.targetZoom - orb.zoom) * ease;

          const angularVel = (orb.yaw - orb.prevYaw) / Math.max(0.008, dt);
          orb.prevYaw = orb.yaw;

          const breatheY = prefersReducedMotion
            ? 0
            : Math.sin(idleClock * 1.35) * 0.006;

          mannequin.group.rotation.y = orb.yaw;
          mannequin.group.rotation.x = orb.pitch;
          mannequin.group.position.y = breatheY;

          camera.position.set(0, -0.06, 2.74 / orb.zoom);
          camera.lookAt(0, -0.14, 0);

          applyGarmentsToMannequin(rigs, mannequin);

          rigs.forEach((rig) => {
            deformVolumetricGarment(rig, ZERO_ARMS, angularVel * 0.45, dt);
          });
        } else if (activeMode === 'camera') {
          mannequin.group.visible = false;
          camera.position.set(0, 0, 2.6);
          camera.lookAt(0, 0, 0);

          const video = videoRef.current;
          const cw = Math.max(1, container.clientWidth);
          const ch = Math.max(1, container.clientHeight);

          if (
            video &&
            video.readyState >= 2 &&
            video.videoWidth > 0 &&
            nowMs - lastPoseDetectMsRef.current >= 16
          ) {
            lastPoseDetectMsRef.current = nowMs;
            const detected = detectVideoPoseSync(
              videoLandmarkerRef.current,
              video,
              nowMs,
              cw,
              ch,
              filterBankRef.current,
            );
            if (detected) {
              cameraPoseRef.current = detected;
            } else if (!videoLandmarkerRef.current && !cameraPoseRef.current) {
              cameraPoseRef.current = buildFallbackPoseFrame(null, true);
            }
          }

          const pose = cameraPoseRef.current;
          const plane = computeVisibleWorldPlane(camera);

          applyGarmentsToPose(
            rigs,
            arMount,
            pose,
            plane,
            DEFAULT_PHOTO_ADJUSTMENTS,
          );
          updateDepthOccluders(occluder, pose, plane, true);

          // Sway velocity driven by user's lateral shoulder velocity
          let swayVel = 0;
          if (pose) {
            swayVel =
              ((pose.shoulderCenter.x - prevShoulderXRef.current) /
                Math.max(0.012, dt)) *
              2.2;
            prevShoulderXRef.current = pose.shoulderCenter.x;

            // Emit Tailor's Pins overlay updates at ~24Hz for smooth SVG overlay without React churn
            if (showTailorPinsRef.current && nowMs - lastPinEmitMsRef.current >= 42) {
              lastPinEmitMsRef.current = nowMs;
              setTailorPins(pose.tailorPins);
              onTailorPinsUpdateRef.current?.(pose.tailorPins);
            }
          }

          const activeArms = pose?.armAngles ?? ZERO_ARMS;
          rigs.forEach((rig) => {
            deformVolumetricGarment(rig, activeArms, swayVel, dt);
          });
        } else {
          // Tab: 'photo'
          mannequin.group.visible = false;
          camera.position.set(0, 0, 2.6);
          camera.lookAt(0, 0, 0);

          const pose = photoPoseRef.current;
          const plane = computeVisibleWorldPlane(camera);

          applyGarmentsToPose(
            rigs,
            arMount,
            pose,
            plane,
            photoAdjustmentsRef.current,
          );
          updateDepthOccluders(occluder, pose, plane, false);

          rigs.forEach((rig) => {
            deformVolumetricGarment(
              rig,
              ZERO_ARMS,
              prefersReducedMotion ? 0 : Math.sin(idleClock * 1.1) * 0.08,
              dt,
            );
          });
        }

        renderer.render(scene, camera);
      };

      rafId = window.requestAnimationFrame(animate);

      // Strict ZERO-LEAK Cleanup on unmount
      return () => {
        window.cancelAnimationFrame(rafId);
        resizeObserver?.disconnect();
        stopAllCameraTracks();
        closePoseTrackers();

        garmentRigsRef.current.forEach((rig) => {
          rig.group.parent?.remove(rig.group);
          rig.dispose();
        });
        garmentRigsRef.current.clear();

        mannequin.group.parent?.remove(mannequin.group);
        mannequin.dispose();
        occluder.group.parent?.remove(occluder.group);
        occluder.dispose();

        scene.environment = null;
        envRT.dispose();
        renderer.dispose();
        if (renderer.domElement.parentNode === host) {
          host.removeChild(renderer.domElement);
        }

        rendererRef.current = null;
        sceneRef.current = null;
        cameraRef.current = null;
        envRtRef.current = null;
        lightsRef.current = null;
        mannequinRef.current = null;
        occluderRef.current = null;
        arMountRef.current = null;
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // 2. Sync mannequin body proportions smoothly when CustomerBodyProfile changes
    useEffect(() => {
      if (mannequinRef.current) {
        updateMannequinBodyProportions(mannequinRef.current, bodyMeasurements);
      }
    }, [
      bodyMeasurements?.heightCm,
      bodyMeasurements?.weightKg,
      bodyMeasurements?.bustCm,
      bodyMeasurements?.waistCm,
      bodyMeasurements?.hipCm,
      bodyMeasurements,
    ]);

    // 3. Synchronize multi-layer 3D garments with instant smooth color crossfade & zero leaks
    const garmentsSignature = useMemo(
      () =>
        garments
          .map(
            (g) =>
              `${g.slot}|${g.productId}|${g.variantId}|${g.frontUrl}|${g.backUrl ?? ''}|${g.colorHex}|${g.fabricWeight}|${g.fabricComposition ?? ''}`,
          )
          .join(';;'),
      [garments],
    );

    useEffect(() => {
      const scene = sceneRef.current;
      const mannequin = mannequinRef.current;
      const arMount = arMountRef.current;
      if (!scene || !mannequin || !arMount) return undefined;

      const epoch = ++loadEpochRef.current;
      let cancelled = false;

      const activeBySlot = new Map<GarmentSlot3D, Garment3DLayerSpec>();
      for (const spec of garments) {
        activeBySlot.set(spec.slot, spec);
      }

      // Immediately remove & dispose any garment slots no longer worn
      const rigs = garmentRigsRef.current;
      for (const [slot, existingRig] of Array.from(rigs.entries())) {
        if (!activeBySlot.has(slot)) {
          existingRig.group.parent?.remove(existingRig.group);
          existingRig.dispose();
          rigs.delete(slot);
        }
      }

      const slotsToLoad: Garment3DLayerSpec[] = [];
      for (const spec of activeBySlot.values()) {
        const existing = rigs.get(spec.slot);
        if (
          existing &&
          existing.spec.productId === spec.productId &&
          existing.spec.variantId === spec.variantId &&
          existing.spec.frontUrl === spec.frontUrl &&
          existing.spec.backUrl === spec.backUrl &&
          existing.spec.colorHex === spec.colorHex
        ) {
          continue;
        }
        slotsToLoad.push(spec);
      }

      if (slotsToLoad.length === 0) {
        setLoadingGarments(false);
        return undefined;
      }

      setLoadingGarments(true);

      Promise.all(
        slotsToLoad.map(async (spec) => {
          const bundle = await buildGarmentTextureBundle(spec);
          return { spec, bundle };
        }),
      )
        .then((results) => {
          if (cancelled || epoch !== loadEpochRef.current) {
            for (const item of results) {
              disposeGarmentTextureBundle(item.bundle);
            }
            return;
          }

          const currentRigs = garmentRigsRef.current;
          for (const { spec, bundle } of results) {
            const existing = currentRigs.get(spec.slot);
            if (existing && existing.spec.productId === spec.productId) {
              // Same silhouette / color variant switch -> instant smooth crossfade without geometry rebuild
              swapVolumetricGarmentTexture(existing, bundle, spec);
            } else {
              if (existing) {
                existing.group.parent?.remove(existing.group);
                existing.dispose();
              }
              const nextRig = createVolumetricGarmentRig(spec, bundle);
              const parent =
                modeRef.current === 'mannequin'
                  ? mannequin.garmentMount
                  : arMount;
              parent.add(nextRig.group);
              currentRigs.set(spec.slot, nextRig);
            }
          }
          setLoadingGarments(false);
        })
        .catch(() => {
          if (!cancelled) {
            setLoadingGarments(false);
          }
        });

      return () => {
        cancelled = true;
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [garmentsSignature]);

    // 4. Manage live Webcam MediaStream & MediaPipe VIDEO PoseLandmarker strictly on 'camera' tab
    useEffect(() => {
      if (mode !== 'camera') {
        stopAllCameraTracks();
        updateCameraStatus('idle');
        return undefined;
      }

      if (!cameraEnabled) {
        stopAllCameraTracks();
        updateCameraStatus(
          'paused',
          'Camera đã được tắt hoàn toàn — bạn có thể bật lại bất cứ lúc nào.',
        );
        return undefined;
      }

      let cancelled = false;
      filterBankRef.current.reset();
      updateCameraStatus('starting');

      const startCamera = async () => {
        if (
          typeof navigator === 'undefined' ||
          !navigator.mediaDevices ||
          typeof navigator.mediaDevices.getUserMedia !== 'function'
        ) {
          if (!cancelled) {
            updateCameraStatus(
              'unavailable',
              'Trình duyệt hoặc thiết bị này chưa có camera khả dụng.',
            );
          }
          return;
        }

        try {
          const stream = await navigator.mediaDevices.getUserMedia({
            video: {
              facingMode: 'user',
              width: { ideal: 960 },
              height: { ideal: 1280 },
            },
            audio: false,
          });

          if (cancelled) {
            stream.getTracks().forEach((t) => t.stop());
            return;
          }

          streamRef.current = stream;
          const video = videoRef.current;
          if (video) {
            video.srcObject = stream;
            try {
              await video.play();
            } catch {
              // Autoplay handled silently via muted playsInline
            }
          }

          updateCameraStatus('active');

          // Lazily warm up MediaPipe VIDEO PoseLandmarker in background
          const landmarker = await getVideoPoseLandmarker();
          if (!cancelled) {
            videoLandmarkerRef.current = landmarker;
          }
        } catch (err) {
          if (cancelled) return;
          const errName =
            err && typeof err === 'object' && 'name' in err
              ? String((err as { name?: unknown }).name)
              : '';
          if (
            errName === 'NotAllowedError' ||
            errName === 'PermissionDeniedError'
          ) {
            updateCameraStatus(
              'denied',
              'Quyền truy cập camera đang bị từ chối. Hãy cấp quyền trên thanh địa chỉ hoặc chuyển sang Ướm 3D Trên Ảnh / Ma-nơ-canh 3D.',
            );
          } else {
            updateCameraStatus(
              'unavailable',
              'Không tìm thấy webcam đang kết nối. Bạn có thể trải nghiệm ngay Ướm 3D Trên Ảnh hoặc xoay Ma-nơ-canh 3D 360°.',
            );
          }
        }
      };

      void startCamera();

      return () => {
        cancelled = true;
        stopAllCameraTracks();
      };
    }, [mode, cameraEnabled, stopAllCameraTracks, updateCameraStatus]);

    // 5. Run one-shot PoseLandmarker IMAGE detection whenever photoUrl changes in 'photo' tab
    useEffect(() => {
      if (mode !== 'photo') {
        return undefined;
      }

      if (!photoUrl) {
        photoPoseRef.current = null;
        return undefined;
      }

      let cancelled = false;
      // Instant ergonomic pre-rig from hint so garments appear in < 50ms before WASM finishes
      photoPoseRef.current = buildFallbackPoseFrame(photoPoseHint, false);

      const img = new Image();
      if (!photoUrl.startsWith('data:') && !photoUrl.startsWith('blob:')) {
        img.crossOrigin = 'anonymous';
      }
      img.decoding = 'async';
      img.onload = () => {
        if (cancelled) return;
        const container = containerRef.current;
        const dstW = container?.clientWidth || 420;
        const dstH = container?.clientHeight || 560;
        void detectPhotoPoseSafe(img, dstW, dstH, photoPoseHint).then((pose) => {
          if (!cancelled) {
            photoPoseRef.current = pose;
          }
        });
      };
      img.onerror = () => {
        if (!cancelled) {
          photoPoseRef.current = buildFallbackPoseFrame(photoPoseHint, false);
        }
      };
      img.src = photoUrl;

      return () => {
        cancelled = true;
      };
    }, [mode, photoUrl, photoPoseHint]);

    // 6. Wheel zoom listener (non-passive so scrolling zooms mannequin cleanly without scrolling page)
    useEffect(() => {
      const container = containerRef.current;
      if (!container) return undefined;

      const handleWheel = (event: WheelEvent) => {
        if (modeRef.current !== 'mannequin') return;
        event.preventDefault();
        const delta = -event.deltaY * 0.0012;
        orbitRef.current.targetZoom = clamp(
          orbitRef.current.targetZoom + delta,
          0.74,
          1.55,
        );
      };

      container.addEventListener('wheel', handleWheel, { passive: false });
      return () => {
        container.removeEventListener('wheel', handleWheel);
      };
    }, []);

    // Pointer drag 360° orbit + 2-finger pinch zoom handlers for Mannequin mode
    const handlePointerDown = useCallback(
      (event: React.PointerEvent<HTMLDivElement>) => {
        if (modeRef.current !== 'mannequin') return;
        const orb = orbitRef.current;
        event.currentTarget.setPointerCapture(event.pointerId);
        orb.activePointers.set(event.pointerId, {
          x: event.clientX,
          y: event.clientY,
        });
        if (orb.activePointers.size === 1) {
          orb.isDragging = true;
          orb.lastX = event.clientX;
          orb.lastY = event.clientY;
        } else if (orb.activePointers.size === 2) {
          orb.isDragging = false;
          const pts = Array.from(orb.activePointers.values());
          orb.lastPinchDist = Math.hypot(
            pts[0]!.x - pts[1]!.x,
            pts[0]!.y - pts[1]!.y,
          );
        }
      },
      [],
    );

    const handlePointerMove = useCallback(
      (event: React.PointerEvent<HTMLDivElement>) => {
        if (modeRef.current !== 'mannequin') return;
        const orb = orbitRef.current;
        if (!orb.activePointers.has(event.pointerId)) return;
        orb.activePointers.set(event.pointerId, {
          x: event.clientX,
          y: event.clientY,
        });

        if (orb.activePointers.size === 2) {
          const pts = Array.from(orb.activePointers.values());
          const dist = Math.hypot(
            pts[0]!.x - pts[1]!.x,
            pts[0]!.y - pts[1]!.y,
          );
          if (orb.lastPinchDist !== null && orb.lastPinchDist > 4) {
            const scaleDelta = (dist - orb.lastPinchDist) * 0.004;
            orb.targetZoom = clamp(orb.targetZoom + scaleDelta, 0.74, 1.55);
          }
          orb.lastPinchDist = dist;
          return;
        }

        if (!orb.isDragging) return;
        const dx = event.clientX - orb.lastX;
        const dy = event.clientY - orb.lastY;
        orb.lastX = event.clientX;
        orb.lastY = event.clientY;

        orb.targetYaw += dx * 0.0095;
        orb.targetPitch = clamp(orb.targetPitch + dy * 0.0045, -0.22, 0.24);

        // Keep front/back indicator synced when user drags past 90°
        const normYaw =
          ((orb.targetYaw % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
        const nextSide =
          normYaw > Math.PI * 0.5 && normYaw < Math.PI * 1.5 ? 'back' : 'front';
        if (nextSide !== orb.side) {
          orb.side = nextSide;
          onMannequinSideChangeRef.current?.(nextSide);
        }
      },
      [],
    );

    const handlePointerUpOrCancel = useCallback(
      (event: React.PointerEvent<HTMLDivElement>) => {
        const orb = orbitRef.current;
        orb.activePointers.delete(event.pointerId);
        if (orb.activePointers.size < 2) {
          orb.lastPinchDist = null;
        }
        if (orb.activePointers.size === 0) {
          orb.isDragging = false;
        }
      },
      [],
    );

    const activePreset = LIGHTING_PRESETS[lightingMode];
    const hasSplitClip =
      mode === 'photo' &&
      typeof beforeAfterSplitPct === 'number' &&
      Number.isFinite(beforeAfterSplitPct);
    const clampedSplitPct = hasSplitClip
      ? clamp(beforeAfterSplitPct, 0, 100)
      : 100;

    const showCameraFallback =
      mode === 'camera' &&
      (cameraStatus === 'denied' ||
        cameraStatus === 'unavailable' ||
        cameraStatus === 'paused');

    return (
      <div
        ref={containerRef}
        data-testid="tryon-3d-stage"
        data-tryon-mode={mode}
        data-tryon-lighting={lightingMode}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUpOrCancel}
        onPointerCancel={handlePointerUpOrCancel}
        className={`relative h-full w-full select-none overflow-hidden rounded-[22px] border border-[#B08A4A]/35 bg-[#18120E] ${
          mode === 'mannequin' ? 'cursor-grab active:cursor-grabbing touch-none' : ''
        } ${className}`}
        style={{
          background:
            mode === 'mannequin' ? activePreset.backdropCss : '#14100C',
        }}
      >
        {/* Background Layer 1: Live mirrored camera feed */}
        <video
          ref={videoRef}
          playsInline
          muted
          autoPlay
          aria-label="Luồng gương 3D AR trực tiếp"
          className={`pointer-events-none absolute inset-0 h-full w-full object-cover transition-opacity duration-300 ${
            mode === 'camera' && cameraStatus === 'active'
              ? 'opacity-100'
              : 'opacity-0'
          }`}
          style={{ transform: 'scaleX(-1)' }}
        />

        {/* Background Layer 2: Uploaded or sample studio portrait for Photo mode */}
        {mode === 'photo' && photoUrl ? (
          <img
            ref={photoImgRef}
            src={photoUrl}
            alt="Ảnh người mặc thử đồ 3D"
            draggable={false}
            crossOrigin={
              photoUrl.startsWith('data:') || photoUrl.startsWith('blob:')
                ? undefined
                : 'anonymous'
            }
            className="pointer-events-none absolute inset-0 h-full w-full object-cover"
          />
        ) : null}

        {/* Foreground Layer: Transparent Three.js WebGL 3D Garment & Mannequin Stage */}
        <div
          ref={canvasHostRef}
          className="pointer-events-none absolute inset-0 h-full w-full"
          style={
            hasSplitClip
              ? { clipPath: `inset(0 ${100 - clampedSplitPct}% 0 0)` }
              : undefined
          }
        />

        {/* Live Before/After vertical gold hairline when photo split comparison is active */}
        {hasSplitClip ? (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 z-20 w-px bg-[#EBCF8F] shadow-[0_0_12px_rgba(235,207,143,0.85)]"
            style={{ left: `${clampedSplitPct}%` }}
          >
            <div className="absolute top-1/2 left-1/2 flex h-7 w-7 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-[#EBCF8F] bg-[#18120E]/90 text-[11px] text-[#EBCF8F] shadow-lg">
              ↔
            </div>
          </div>
        ) : null}

        {/* Refined SVG "Tailor's Pins" Overlay (Camera mode only, delicate gold dots & hairline stitch) */}
        {mode === 'camera' &&
        showTailorPins &&
        cameraStatus === 'active' &&
        tailorPins.visible ? (
          <svg
            data-testid="tryon-tailor-pins-svg"
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 z-20 h-full w-full"
          >
            {/* Hairline dashed shoulder tailoring stitch */}
            <line
              x1={tailorPins.leftShoulder.x * 100}
              y1={tailorPins.leftShoulder.y * 100}
              x2={tailorPins.rightShoulder.x * 100}
              y2={tailorPins.rightShoulder.y * 100}
              stroke="#B08A4A"
              strokeOpacity="0.62"
              strokeWidth="0.35"
              strokeDasharray="1.4 1.6"
            />
            {/* Collar pin */}
            <circle
              cx={tailorPins.collar.x * 100}
              cy={tailorPins.collar.y * 100}
              r="0.72"
              fill="#FBF7EF"
              stroke="#B08A4A"
              strokeWidth="0.35"
            />
            {/* Left shoulder pin */}
            <circle
              cx={tailorPins.leftShoulder.x * 100}
              cy={tailorPins.leftShoulder.y * 100}
              r="1.35"
              fill="none"
              stroke="#B08A4A"
              strokeOpacity="0.78"
              strokeWidth="0.28"
            />
            <circle
              cx={tailorPins.leftShoulder.x * 100}
              cy={tailorPins.leftShoulder.y * 100}
              r="0.58"
              fill="#EBCF8F"
            />
            {/* Right shoulder pin */}
            <circle
              cx={tailorPins.rightShoulder.x * 100}
              cy={tailorPins.rightShoulder.y * 100}
              r="1.35"
              fill="none"
              stroke="#B08A4A"
              strokeOpacity="0.78"
              strokeWidth="0.28"
            />
            <circle
              cx={tailorPins.rightShoulder.x * 100}
              cy={tailorPins.rightShoulder.y * 100}
              r="0.58"
              fill="#EBCF8F"
            />
            {/* Optional subtle hip pins when full torso is visible */}
            {tailorPins.leftHip && tailorPins.rightHip ? (
              <>
                <circle
                  cx={tailorPins.leftHip.x * 100}
                  cy={tailorPins.leftHip.y * 100}
                  r="0.55"
                  fill="#B08A4A"
                  fillOpacity="0.82"
                />
                <circle
                  cx={tailorPins.rightHip.x * 100}
                  cy={tailorPins.rightHip.y * 100}
                  r="0.55"
                  fill="#B08A4A"
                  fillOpacity="0.82"
                />
              </>
            ) : null}
          </svg>
        ) : null}

        {/* Seated webcam auto-adaptation subtle pill */}
        {mode === 'camera' &&
        cameraStatus === 'active' &&
        tailorPins.visible &&
        tailorPins.seatedMode ? (
          <div className="pointer-events-none absolute top-3 left-3 z-20 rounded-full border border-[#B08A4A]/45 bg-[#18120E]/75 px-2.5 py-1 text-[10px] tracking-[0.12em] uppercase text-[#EBCF8F] backdrop-blur-md">
            Góc ngồi gần · Tự căn thân trên
          </div>
        ) : null}

        {/* Subtle garment texture preparation shimmer */}
        {loadingGarments ? (
          <div className="pointer-events-none absolute top-3 right-3 z-20 rounded-full border border-[#B08A4A]/40 bg-[#18120E]/75 px-2.5 py-1 text-[10px] tracking-[0.14em] uppercase text-[#FBF7EF]/85 backdrop-blur-md">
            Đang dệt chất liệu 3D…
          </div>
        ) : null}

        {/* Luxury fallback overlay when camera is denied, missing, or paused */}
        {showCameraFallback ? (
          <div
            data-testid="tryon-camera-fallback"
            className="absolute inset-0 z-30 flex flex-col items-center justify-center bg-[#16100C]/92 px-6 text-center backdrop-blur-md"
          >
            <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full border border-[#B08A4A]/50 bg-[#251C15] text-lg text-[#EBCF8F]">
              ✦
            </div>
            <p className="font-serif text-base tracking-wide text-[#FBF7EF]">
              {cameraStatus === 'paused'
                ? 'Gương Camera 3D đang tạm tắt'
                : cameraStatus === 'denied'
                  ? 'Chưa có quyền truy cập Camera'
                  : 'Không tìm thấy Webcam trên thiết bị'}
            </p>
            <p className="mt-2 max-w-[300px] text-xs leading-relaxed text-[#FBF7EF]/68">
              {cameraMessage ||
                'Mọi xử lý đều chạy trực tiếp trên trình duyệt. Bạn có thể thử ngay chế độ Ướm 3D Trên Ảnh hoặc xoay Ma-nơ-canh 3D 360°.'}
            </p>
            {onRequestModeSwitch ? (
              <div className="mt-5 flex flex-wrap items-center justify-center gap-2.5">
                <button
                  type="button"
                  data-testid="tryon-fallback-to-photo"
                  onClick={() => onRequestModeSwitch('photo')}
                  className="rounded-full border border-[#EBCF8F]/60 bg-[#B08A4A]/20 px-4 py-1.5 text-[11px] font-medium tracking-[0.12em] uppercase text-[#EBCF8F] transition hover:bg-[#B08A4A]/35"
                >
                  Ướm 3D Trên Ảnh
                </button>
                <button
                  type="button"
                  data-testid="tryon-fallback-to-mannequin"
                  onClick={() => onRequestModeSwitch('mannequin')}
                  className="rounded-full border border-[#FBF7EF]/25 bg-[#FBF7EF]/8 px-4 py-1.5 text-[11px] font-medium tracking-[0.12em] uppercase text-[#FBF7EF]/90 transition hover:bg-[#FBF7EF]/16"
                >
                  Ma-nơ-canh 3D 360°
                </button>
              </div>
            ) : null}
          </div>
        ) : null}

        {/* Photo mode empty prompt if no photo selected yet */}
        {mode === 'photo' && !photoUrl ? (
          <div className="pointer-events-none absolute inset-0 z-20 flex flex-col items-center justify-center bg-[#18120E]/85 px-6 text-center">
            <p className="font-serif text-sm tracking-wide text-[#EBCF8F]">
              Chọn ảnh mẫu Atelier hoặc tải ảnh chân dung của bạn
            </p>
            <p className="mt-1.5 max-w-[280px] text-xs text-[#FBF7EF]/65">
              Trang phục 3D sẽ tự động ôm theo đường vai & thân dáng ngay trên trình duyệt.
            </p>
          </div>
        ) : null}

        {/* Graceful WebGL unavailable notice */}
        {webglFailed ? (
          <div className="absolute inset-0 z-40 flex flex-col items-center justify-center bg-[#18120E]/95 px-6 text-center">
            <p className="font-serif text-base text-[#EBCF8F]">
              Trình duyệt hiện chưa bật tăng tốc đồ họa WebGL
            </p>
            <p className="mt-2 max-w-[300px] text-xs text-[#FBF7EF]/70">
              Hãy bật Hardware Acceleration trong cài đặt trình duyệt để trải nghiệm Gương 3D AR 60 FPS.
            </p>
          </div>
        ) : null}
      </div>
    );
  },
);
