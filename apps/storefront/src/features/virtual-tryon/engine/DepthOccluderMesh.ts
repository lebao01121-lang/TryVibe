import * as THREE from 'three';
import type { PoseLandmark3D, PoseTracking3DFrame } from './types';

export interface DepthOccluderRig {
  group: THREE.Group;
  headMesh: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
  neckMesh: THREE.Mesh<THREE.CylinderGeometry, THREE.MeshBasicMaterial>;
  leftForearmMesh: THREE.Mesh<THREE.CapsuleGeometry, THREE.MeshBasicMaterial>;
  rightForearmMesh: THREE.Mesh<THREE.CapsuleGeometry, THREE.MeshBasicMaterial>;
  leftHandMesh: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
  rightHandMesh: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
  dispose: () => void;
}

export interface ViewportWorldPlane {
  /** World-space visible width at z = 0 */
  worldWidth: number;
  /** World-space visible height at z = 0 */
  worldHeight: number;
}

const UP_VEC = new THREE.Vector3(0, 1, 0);
const TMP_A = new THREE.Vector3();
const TMP_B = new THREE.Vector3();
const TMP_DIR = new THREE.Vector3();
const TMP_MID = new THREE.Vector3();

function normToWorld(
  nx: number,
  ny: number,
  z: number,
  plane: ViewportWorldPlane,
  out: THREE.Vector3,
): THREE.Vector3 {
  out.set(
    (nx - 0.5) * plane.worldWidth,
    (0.5 - ny) * plane.worldHeight,
    z,
  );
  return out;
}

/**
 * Builds invisible depth-write occluders (`colorWrite: false, depthWrite: true`, `renderOrder = 0`):
 * - Head / chin ellipsoid + neck cylinder so high collars wrap naturally behind the neck
 *   and chin always stays cleanly in front of garments.
 * - Left & right forearm/hand occluder capsules activated whenever `wrist.z < shoulder.z - 0.05`
 *   so hands raised in front of the chest cleanly occlude virtual garments.
 */
export function createDepthOccluderRig(): DepthOccluderRig {
  const occluderMat = new THREE.MeshBasicMaterial({
    color: 0x000000,
    colorWrite: false,
    depthWrite: true,
    depthTest: true,
    side: THREE.FrontSide,
  });

  const headGeo = new THREE.SphereGeometry(1, 20, 16);
  const headMesh = new THREE.Mesh(headGeo, occluderMat);
  headMesh.name = 'depth-occluder-head';
  headMesh.renderOrder = 0;

  const neckGeo = new THREE.CylinderGeometry(0.86, 1.0, 1, 18, 1);
  const neckMesh = new THREE.Mesh(neckGeo, occluderMat);
  neckMesh.name = 'depth-occluder-neck';
  neckMesh.renderOrder = 0;

  const forearmGeo = new THREE.CapsuleGeometry(0.042, 0.24, 6, 12);
  const leftForearmMesh = new THREE.Mesh(forearmGeo, occluderMat);
  leftForearmMesh.name = 'depth-occluder-left-forearm';
  leftForearmMesh.renderOrder = 0;
  leftForearmMesh.visible = false;

  const rightForearmMesh = new THREE.Mesh(forearmGeo, occluderMat);
  rightForearmMesh.name = 'depth-occluder-right-forearm';
  rightForearmMesh.renderOrder = 0;
  rightForearmMesh.visible = false;

  const handGeo = new THREE.SphereGeometry(0.056, 12, 10);
  const leftHandMesh = new THREE.Mesh(handGeo, occluderMat);
  leftHandMesh.name = 'depth-occluder-left-hand';
  leftHandMesh.renderOrder = 0;
  leftHandMesh.visible = false;

  const rightHandMesh = new THREE.Mesh(handGeo, occluderMat);
  rightHandMesh.name = 'depth-occluder-right-hand';
  rightHandMesh.renderOrder = 0;
  rightHandMesh.visible = false;

  const group = new THREE.Group();
  group.name = 'depth-occluder-rig';
  group.renderOrder = 0;
  group.add(
    headMesh,
    neckMesh,
    leftForearmMesh,
    rightForearmMesh,
    leftHandMesh,
    rightHandMesh,
  );

  return {
    group,
    headMesh,
    neckMesh,
    leftForearmMesh,
    rightForearmMesh,
    leftHandMesh,
    rightHandMesh,
    dispose: () => {
      headGeo.dispose();
      neckGeo.dispose();
      forearmGeo.dispose();
      handGeo.dispose();
      occluderMat.dispose();
    },
  };
}

function positionForearmOccluder(
  forearmMesh: THREE.Mesh,
  handMesh: THREE.Mesh,
  elbow: PoseLandmark3D | undefined,
  wrist: PoseLandmark3D | undefined,
  shoulderZ: number,
  shoulderWorldW: number,
  plane: ViewportWorldPlane,
): void {
  // Activate occlusion only when wrist moves clearly in front of chest plane
  const handInFront =
    Boolean(elbow && wrist) &&
    (wrist?.visibility ?? 0) > 0.42 &&
    (elbow?.visibility ?? 0) > 0.35 &&
    (wrist?.z ?? 0) < shoulderZ - 0.05;

  forearmMesh.visible = handInFront;
  handMesh.visible = handInFront;

  if (!handInFront || !elbow || !wrist) {
    return;
  }

  // Place foreground hand/forearm clearly in front of front volumetric garment relief
  const frontZ = Math.max(0.24, shoulderWorldW * 0.56);
  normToWorld(elbow.x, elbow.y, frontZ * 0.72, plane, TMP_A);
  normToWorld(wrist.x, wrist.y, frontZ, plane, TMP_B);

  TMP_DIR.subVectors(TMP_B, TMP_A);
  const segLen = Math.max(0.06, TMP_DIR.length());
  TMP_MID.addVectors(TMP_A, TMP_B).multiplyScalar(0.5);

  forearmMesh.position.copy(TMP_MID);
  TMP_DIR.normalize();
  forearmMesh.quaternion.setFromUnitVectors(UP_VEC, TMP_DIR);

  const limbRadiusScale = Math.max(0.65, Math.min(1.45, shoulderWorldW / 0.44));
  forearmMesh.scale.set(
    limbRadiusScale,
    segLen / 0.32,
    limbRadiusScale,
  );

  handMesh.position.copy(TMP_B);
  handMesh.scale.setScalar(limbRadiusScale * 1.15);
}

/**
 * Updates depth occluders from the latest filtered 3D pose frame.
 */
export function updateDepthOccluders(
  rig: DepthOccluderRig,
  pose: PoseTracking3DFrame | null,
  plane: ViewportWorldPlane,
  enabled: boolean,
): void {
  rig.group.visible = enabled && Boolean(pose?.detected);
  if (!enabled || !pose || !pose.detected) {
    return;
  }

  const shoulderWorldW = Math.max(0.22, pose.shoulderWidth * plane.worldWidth);
  const headRadiusWorld = Math.max(
    0.07,
    pose.headRadius * plane.worldHeight,
  );

  // Head / chin ellipsoid sits cleanly in front of garment collars
  const headZ = shoulderWorldW * 0.36;
  normToWorld(pose.headCenter.x, pose.headCenter.y, headZ, plane, TMP_A);
  rig.headMesh.position.copy(TMP_A);
  rig.headMesh.scale.set(
    headRadiusWorld * 0.78,
    headRadiusWorld * 1.06,
    headRadiusWorld * 0.85,
  );
  rig.headMesh.rotation.set(pose.pitchX * 0.5, pose.yawY * 0.65, pose.rollZ);

  // Neck cylinder spans from chin base down to collar center
  normToWorld(pose.neckCenter.x, pose.neckCenter.y, shoulderWorldW * 0.16, plane, TMP_B);
  const neckHeight = Math.max(headRadiusWorld * 0.72, Math.abs(TMP_A.y - TMP_B.y) * 0.85);
  rig.neckMesh.position.set(
    (TMP_A.x + TMP_B.x) * 0.5,
    (TMP_A.y + TMP_B.y) * 0.5 - headRadiusWorld * 0.18,
    shoulderWorldW * 0.18,
  );
  const neckRadius = Math.max(0.042, shoulderWorldW * 0.145);
  rig.neckMesh.scale.set(neckRadius, neckHeight, neckRadius * 0.92);
  rig.neckMesh.rotation.set(pose.pitchX * 0.4, pose.yawY * 0.5, pose.rollZ);

  // Left & right forearm/hand depth occluders
  positionForearmOccluder(
    rig.leftForearmMesh,
    rig.leftHandMesh,
    pose.leftElbow,
    pose.leftWrist,
    pose.leftShoulderZ,
    shoulderWorldW,
    plane,
  );
  positionForearmOccluder(
    rig.rightForearmMesh,
    rig.rightHandMesh,
    pose.rightElbow,
    pose.rightWrist,
    pose.rightShoulderZ,
    shoulderWorldW,
    plane,
  );
}
