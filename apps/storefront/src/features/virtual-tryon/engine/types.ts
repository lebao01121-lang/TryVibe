import type * as THREE from 'three';

export type TryOn3DTabMode = 'camera' | 'photo' | 'mannequin';

export type TryOn3DLightingMode = 'morning' | 'showroom' | 'evening';

export type GarmentSlot3D = 'TOP' | 'BOTTOM' | 'ONE_PIECE' | 'OUTERWEAR';

export type FabricWeightClass = 'LIGHT' | 'MEDIUM' | 'HEAVY';

export type CameraStatus3D =
  | 'idle'
  | 'starting'
  | 'active'
  | 'denied'
  | 'unavailable'
  | 'paused';

export interface Garment3DLayerSpec {
  slot: GarmentSlot3D;
  productId: string;
  variantId: string;
  skuId: string;
  slug: string;
  name: string;
  colorName: string;
  colorHex: string;
  frontUrl: string;
  backUrl?: string | null;
  fabricComposition?: string;
  fabricWeight: FabricWeightClass;
  fitType?: string;
  priceVnd: number;
}

export interface BodyMeasurements3D {
  heightCm: number;
  weightKg: number;
  bustCm?: number;
  waistCm?: number;
  hipCm?: number;
  recommendedSize?: string;
}

export interface TailorPinPoint2D {
  x: number;
  y: number;
}

export interface TailorPinOverlayData {
  visible: boolean;
  confidence: number;
  seatedMode: boolean;
  leftShoulder: TailorPinPoint2D;
  rightShoulder: TailorPinPoint2D;
  collar: TailorPinPoint2D;
  leftHip?: TailorPinPoint2D;
  rightHip?: TailorPinPoint2D;
}

export interface PhotoAdjustments {
  offsetX: number;
  offsetY: number;
  scale: number;
}

export interface TryOn3DSceneHandle {
  captureComposite3x4: () => Promise<string | null>;
  resetMannequinOrbit: () => void;
  flipMannequinSide: () => void;
}

export interface GarmentAlphaBounds {
  cropTop: number;
  cropBottom: number;
  cropLeft: number;
  cropRight: number;
  aspectRatio: number;
  width: number;
  height: number;
}

export interface FabricPbrProfile {
  roughness: number;
  sheen: number;
  sheenRoughness: number;
  clearcoat: number;
  clearcoatRoughness: number;
  metalness: number;
  normalScale: number;
  weaveFrequency: number;
  weaveStrength: number;
  swayStiffness: number;
  swayDamping: number;
  swayAmplitude: number;
}

export interface GarmentTextureBundle {
  colorMap: THREE.CanvasTexture;
  normalMap: THREE.CanvasTexture;
  roughnessMap: THREE.CanvasTexture;
  backColorMap: THREE.CanvasTexture;
  backNormalMap: THREE.CanvasTexture;
  backRoughnessMap: THREE.CanvasTexture;
  hasDedicatedBack: boolean;
  alphaField: Float32Array;
  alphaGridW: number;
  alphaGridH: number;
  bounds: GarmentAlphaBounds;
  isStylizedFallback: boolean;
  sourceUrl: string;
}

export interface ArmPoseAngles {
  leftElbowAngle: number;
  rightElbowAngle: number;
  leftShoulderLift: number;
  rightShoulderLift: number;
}

export interface PoseLandmark3D {
  x: number;
  y: number;
  z: number;
  visibility: number;
}

export interface PhotoPoseHint {
  nose?: { x: number; y: number; visibility?: number };
  leftShoulder?: { x: number; y: number; visibility?: number };
  rightShoulder?: { x: number; y: number; visibility?: number };
  leftHip?: { x: number; y: number; visibility?: number };
  rightHip?: { x: number; y: number; visibility?: number };
  chinY?: number;
}

export interface PoseTracking3DFrame {
  detected: boolean;
  confidence: number;
  seatedMode: boolean;
  source: 'mediapipe' | 'hint' | 'fallback';
  /** Mirrored display coordinates in [0..1] */
  shoulderCenter: TailorPinPoint2D;
  hipCenter: TailorPinPoint2D;
  neckCenter: TailorPinPoint2D;
  headCenter: TailorPinPoint2D;
  /** Normalized viewport spans */
  shoulderWidth: number;
  torsoHeight: number;
  headRadius: number;
  /** Euler orientation in radians */
  rollZ: number;
  yawY: number;
  pitchX: number;
  armAngles: ArmPoseAngles;
  /** Optional 2D+Z forearm landmarks in display space for depth occlusion */
  leftElbow?: PoseLandmark3D;
  rightElbow?: PoseLandmark3D;
  leftWrist?: PoseLandmark3D;
  rightWrist?: PoseLandmark3D;
  leftShoulderZ: number;
  rightShoulderZ: number;
  tailorPins: TailorPinOverlayData;
}

export interface TryOn3DSceneProps {
  mode: TryOn3DTabMode;
  garments: readonly Garment3DLayerSpec[];
  lightingMode?: TryOn3DLightingMode;
  bodyMeasurements?: BodyMeasurements3D;
  cameraEnabled?: boolean;
  showTailorPins?: boolean;
  onCameraStatusChange?: (status: CameraStatus3D, message?: string) => void;
  onTailorPinsUpdate?: (pins: TailorPinOverlayData) => void;
  onRequestModeSwitch?: (nextMode: TryOn3DTabMode) => void;
  photoUrl?: string | null;
  photoPoseHint?: PhotoPoseHint | null;
  photoAdjustments?: PhotoAdjustments;
  beforeAfterSplitPct?: number | null;
  onMannequinSideChange?: (side: 'front' | 'back') => void;
  className?: string;
}
