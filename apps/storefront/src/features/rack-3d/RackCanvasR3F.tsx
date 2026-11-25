'use client';

import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { useEffect, useRef, type MutableRefObject } from 'react';
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { RackGarmentItemDto, RackGarmentVariantDto } from '@atelier/contracts';
import { disposeObject3D, type DisposableObject3D } from '@atelier/motion-kit';
import {
  applySpringImpulse,
  clamp,
  createSpringPendulumState,
  stepSpringPendulum,
  type SpringPendulumState,
} from './physics/springPendulum';
import {
  GARMENT_FRAGMENT_SHADER,
  GARMENT_VERTEX_SHADER,
} from './shaders/garmentPoisson.glsl';
import {
  createSparkGeometryBuffers,
  SPARK_FRAGMENT_SHADER,
  SPARK_PARTICLE_COUNT,
  SPARK_VERTEX_SHADER,
} from './shaders/sparkParticles.glsl';
import {
  WALL_SHADOW_FRAGMENT_SHADER,
  WALL_SHADOW_VERTEX_SHADER,
} from './shaders/wallShadow.glsl';

const GARMENT_H = 3.5;
const GARMENT_W = 2.33;
const HANGER_DROP = 0.36;
const DEFAULT_HANGER_ANCHOR_X = 0.5;
const DEFAULT_HANGER_ANCHOR_Y = 0.14;
const SPACING = 2.25;
const RAIL_Y = 2.72;
const PRESENT_Z = 3.4;
const AUTO_PRESENT_DELAY_SEC = 0.28;

export interface RackCanvasR3FProps {
  items: RackGarmentItemDto[];
  focusRef: MutableRefObject<number>;
  shouldRender: boolean;
  maxDpr?: number;
  activeVariants: Record<string, number>;
  showBackMap: Record<string, boolean>;
  onPresentChange: (index: number) => void;
  onPick: (index: number) => void;
  onTogglePresentedBack?: (index: number) => void;
  onHoverChange?: (index: number) => void;
  onContextLost: () => void;
}

interface GarmentRuntime {
  index: number;
  productId: string;
  fabricWeight: number | string;
  pivot: THREE.Group;
  mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  mat: THREE.ShaderMaterial;
  hangerGroup: THREE.Group;
  hangerBrassMat: THREE.MeshPhysicalMaterial;
  hangerWoodMat: THREE.MeshPhysicalMaterial;
  shadowPivot: THREE.Group;
  shadowMesh: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  shadowMat: THREE.ShaderMaterial;
  pendulum: SpringPendulumState;
  pres: number;
  presTarget: number;
  spread: number;
  spreadTarget: number;
  baseZ: number;
  mixProgress: number;
  isMixing: boolean;
  currentUrl: string;
  fadeAlpha: number;
  fadeTarget: number;
  backFlip: number;
  backFlipTarget: number;
}

function createTransparentTexture(): THREE.DataTexture {
  const data = new Uint8Array([0, 0, 0, 0]);
  const tex = new THREE.DataTexture(data, 1, 1, THREE.RGBAFormat);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

function getVariantTextureUrl(
  variant: RackGarmentVariantDto | undefined,
  showBack: boolean,
): string | null {
  if (!variant) return null;
  if (showBack) {
    return (
      variant.backCutoutUrl ||
      variant.frontCutoutUrl ||
      variant.lookbookMainUrl ||
      variant.tryonFlatPreviewUrl ||
      null
    );
  }
  return (
    variant.frontCutoutUrl ||
    variant.lookbookMainUrl ||
    variant.tryonFlatPreviewUrl ||
    null
  );
}

function applyHangerAnchorOffset(
  mesh: THREE.Mesh,
  shadowMesh: THREE.Mesh,
  anchorX: number | undefined,
  anchorY: number | undefined,
): void {
  const safeX = clamp(
    typeof anchorX === 'number' && Number.isFinite(anchorX)
      ? anchorX
      : DEFAULT_HANGER_ANCHOR_X,
    0,
    1,
  );
  const safeY = clamp(
    typeof anchorY === 'number' && Number.isFinite(anchorY)
      ? anchorY
      : DEFAULT_HANGER_ANCHOR_Y,
    0,
    1,
  );
  const localAnchorX = (safeX - 0.5) * GARMENT_W;
  const localAnchorY = (0.5 - safeY) * GARMENT_H;
  const posX = -localAnchorX;
  const posY = -(HANGER_DROP + localAnchorY);
  // Slightly forward of sculpted walnut hanger bar (z = 0.025) so collar drapes naturally
  mesh.position.set(posX, posY, 0.025);
  shadowMesh.position.set(posX, posY, 0);
}

function syncCanvasCursor(
  dom: HTMLCanvasElement,
  hoveredIndex: number,
  presentedIndex: number,
): void {
  const nextLabel =
    hoveredIndex >= 0 && hoveredIndex === presentedIndex ? 'XOAY' : 'XEM';
  const prevCursor = dom.getAttribute('data-cursor');
  const prevLabel = dom.getAttribute('data-cursor-label');

  if (prevCursor !== 'view' || prevLabel !== nextLabel) {
    dom.setAttribute('data-cursor', 'view');
    dom.setAttribute('data-cursor-label', nextLabel);
    if (typeof window !== 'undefined') {
      window.dispatchEvent(
        new CustomEvent('atelier:cursor-update', {
          detail: { active: true, label: nextLabel },
        }),
      );
    }
  }
}

function RackScene({
  items,
  focusRef,
  shouldRender,
  activeVariants,
  showBackMap,
  onPresentChange,
  onPick,
  onTogglePresentedBack,
  onHoverChange,
  onContextLost,
}: Omit<RackCanvasR3FProps, 'maxDpr'>) {
  const { gl, scene, camera, size } = useThree();

  const rootGroupRef = useRef<THREE.Group | null>(null);
  const rackGroupRef = useRef<THREE.Group | null>(null);
  const runtimesRef = useRef<GarmentRuntime[]>([]);
  const pickMeshesRef = useRef<THREE.Object3D[]>([]);
  const sparkMatRef = useRef<THREE.ShaderMaterial | null>(null);
  const textureCacheRef = useRef<Map<string, THREE.Texture>>(new Map());
  const loadedUrlsRef = useRef<Set<string>>(new Set());
  const transparentTexRef = useRef<THREE.DataTexture | null>(null);
  const loaderRef = useRef<THREE.TextureLoader | null>(null);
  const sceneDisposedRef = useRef(false);
  const shouldRenderRef = useRef(shouldRender);
  shouldRenderRef.current = shouldRender;

  // Mutable 60Hz animation refs mutated directly inside useFrame (ZERO React setState)
  const smoothFocusRef = useRef(0);
  const prevFocusRef = useRef(0);
  const focusVelRef = useRef(0);
  const focusAccRef = useRef(0);
  const stillTimeRef = useRef(0);
  const presentedRef = useRef(-1);
  const hoveredRef = useRef(-1);
  const pointerNdcRef = useRef(new THREE.Vector2(9, 9));
  const pointerVelXRef = useRef(0);
  const lastClientXRef = useRef<number | null>(null);
  const raycasterRef = useRef(new THREE.Raycaster());
  const hitPointRef = useRef(new THREE.Vector3());
  const presentYRef = useRef(-0.12);
  const elapsedRef = useRef(0);

  const callbacksRef = useRef({
    onPresentChange,
    onPick,
    onTogglePresentedBack,
    onHoverChange,
    onContextLost,
  });
  callbacksRef.current = {
    onPresentChange,
    onPick,
    onTogglePresentedBack,
    onHoverChange,
    onContextLost,
  };

  const getTransparentTex = (): THREE.DataTexture => {
    if (!transparentTexRef.current) {
      transparentTexRef.current = createTransparentTexture();
    }
    return transparentTexRef.current;
  };

  // Explicit VRAM texture reclamation on swatch / front-back texture swaps
  const evictUnreferencedTextures = (runtimes: GarmentRuntime[]): void => {
    const activeTextures = new Set<THREE.Texture>();
    if (transparentTexRef.current) {
      activeTextures.add(transparentTexRef.current);
    }
    for (let i = 0; i < runtimes.length; i += 1) {
      const rt = runtimes[i];
      if (!rt) continue;
      const texA = rt.mat.uniforms.uMapA?.value as THREE.Texture | undefined;
      const texB = rt.mat.uniforms.uMapB?.value as THREE.Texture | undefined;
      const texShadow = rt.shadowMat.uniforms.uMap?.value as
        | THREE.Texture
        | undefined;
      if (texA) activeTextures.add(texA);
      if (texB) activeTextures.add(texB);
      if (texShadow) activeTextures.add(texShadow);
    }

    for (const [url, tex] of Array.from(textureCacheRef.current.entries())) {
      if (!activeTextures.has(tex)) {
        tex.dispose();
        textureCacheRef.current.delete(url);
        loadedUrlsRef.current.delete(url);
      }
    }
  };

  // Load real WebP cutout textures cleanly; NEVER draw fake placeholder polygons
  const resolveTexture = (
    url: string | null,
    onReady?: (loadedTexture: THREE.Texture) => void,
  ): { texture: THREE.Texture; alreadyLoaded: boolean } => {
    if (!url) {
      return { texture: getTransparentTex(), alreadyLoaded: false };
    }

    const cache = textureCacheRef.current;
    const existing = cache.get(url);
    if (existing) {
      const isLoaded = loadedUrlsRef.current.has(url);
      if (isLoaded) {
        onReady?.(existing);
      }
      return { texture: existing, alreadyLoaded: isLoaded };
    }

    if (!loaderRef.current) {
      const loader = new THREE.TextureLoader();
      loader.setCrossOrigin('anonymous');
      loaderRef.current = loader;
    }

    const tex = loaderRef.current.load(
      url,
      (loaded: THREE.Texture) => {
        if (sceneDisposedRef.current || textureCacheRef.current.get(url) !== loaded) {
          loaded.dispose();
          return;
        }
        loaded.colorSpace = THREE.SRGBColorSpace;
        loaded.anisotropy = 4;
        loaded.generateMipmaps = true;
        loaded.minFilter = THREE.LinearMipmapLinearFilter;
        loaded.magFilter = THREE.LinearFilter;
        loaded.needsUpdate = true;
        loadedUrlsRef.current.add(url);
        onReady?.(loaded);
      },
      undefined,
      () => {
        // Dispose failed texture handle & stay cleanly transparent (zero fake polygons)
        const failed = textureCacheRef.current.get(url);
        if (failed === tex) {
          textureCacheRef.current.delete(url);
          loadedUrlsRef.current.delete(url);
          tex.dispose();
        }
      },
    );
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;

    cache.set(url, tex);
    return { texture: tex, alreadyLoaded: false };
  };

  // 1. RoomEnvironment IBL + WebGL context loss listener + explicit renderTarget.dispose()
  useEffect(() => {
    gl.outputColorSpace = THREE.SRGBColorSpace;
    gl.toneMapping = THREE.ACESFilmicToneMapping;
    gl.toneMappingExposure = 1.05;

    const pmrem = new THREE.PMREMGenerator(gl);
    const roomEnv = new RoomEnvironment();
    const renderTarget = pmrem.fromScene(roomEnv, 0.04);
    scene.environment = renderTarget.texture;
    pmrem.dispose();
    roomEnv.dispose();

    const dom = gl.domElement;
    dom.setAttribute('data-cursor', 'view');
    dom.setAttribute('data-cursor-label', 'XEM');

    const handleContextLost = (event: Event) => {
      event.preventDefault();
      callbacksRef.current.onContextLost();
    };
    dom.addEventListener('webglcontextlost', handleContextLost, false);

    return () => {
      dom.removeEventListener('webglcontextlost', handleContextLost, false);
      dom.removeAttribute('data-cursor');
      dom.removeAttribute('data-cursor-label');
      scene.environment = null;
      renderTarget.texture.dispose();
      renderTarget.dispose();
    };
  }, [gl, scene]);

  // 2. Responsive camera aspect & exact spark DPR scale
  useEffect(() => {
    if (camera instanceof THREE.PerspectiveCamera) {
      const aspect = size.width / Math.max(1, size.height);
      const isPortrait = aspect < 0.9;
      camera.aspect = aspect;
      camera.position.set(0, 0, isPortrait ? 19 : 16);
      camera.updateProjectionMatrix();
      presentYRef.current = isPortrait ? 0.45 : -0.12;
    }
    if (sparkMatRef.current) {
      sparkMatRef.current.uniforms.uPx.value = Math.min(gl.getPixelRatio(), 1.5);
    }
  }, [camera, gl, size.height, size.width]);

  // 3. Build Extended Horizontal Brass Rail, Sculpted 3D Hangers, Wall Shadows & 118 Spark Particles
  useEffect(() => {
    sceneDisposedRef.current = false;
    const rootGroup = new THREE.Group();
    const rackGroup = new THREE.Group();
    rootGroup.add(rackGroup);
    scene.add(rootGroup);
    rootGroupRef.current = rootGroup;
    rackGroupRef.current = rackGroup;

    const n = items.length;
    const brassMat = new THREE.MeshPhysicalMaterial({
      color: 0xd9b26a,
      metalness: 1,
      roughness: 0.22,
      clearcoat: 0.6,
      clearcoatRoughness: 0.2,
    });

    // Extended horizontal brass rail sweeping past both viewport edges (ZERO ceiling support rods!)
    const railLen = Math.max(1, n - 1) * SPACING + 22;
    const railCenterX = (Math.max(0, n - 1) * SPACING) / 2;
    const railGeo = new THREE.CylinderGeometry(0.052, 0.052, railLen, 32);
    railGeo.rotateZ(Math.PI * 0.5);
    const railMesh = new THREE.Mesh(railGeo, brassMat);
    railMesh.position.set(railCenterX, RAIL_Y, 0);
    rackGroup.add(railMesh);

    // Subtle brass end finials far beyond viewport bounds
    const finialGeo = new THREE.SphereGeometry(0.095, 24, 14);
    for (const dir of [-1, 1]) {
      const finial = new THREE.Mesh(finialGeo, brassMat);
      finial.position.set(railCenterX + (dir * railLen) / 2, RAIL_Y, 0);
      rackGroup.add(finial);
    }

    // Shared garment plane + sculpted 3D hanger geometries
    const planeGeo = new THREE.PlaneGeometry(GARMENT_W, GARMENT_H);

    // Brass ring gripping horizontal X-axis rail at local y = 0
    const ringGeo = new THREE.TorusGeometry(0.052, 0.016, 12, 28);
    ringGeo.rotateY(Math.PI * 0.5);

    // Polished curved brass C-hook curving cleanly from rail y = 0 down to neck y = -0.34
    const hookCurve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(0, 0.036, -0.054),
      new THREE.Vector3(0, 0.072, 0.0),
      new THREE.Vector3(0, 0.042, 0.056),
      new THREE.Vector3(0, -0.045, 0.046),
      new THREE.Vector3(0, -0.15, 0.022),
      new THREE.Vector3(0, -0.34, 0.018),
    ]);
    const hookGeo = new THREE.TubeGeometry(hookCurve, 28, 0.013, 10, false);

    // Brass collar ferrule cylinder at y = -0.34
    const ferruleGeo = new THREE.CylinderGeometry(0.022, 0.03, 0.065, 16);
    ferruleGeo.translate(0, -0.34, 0.018);

    // Sculpted ergonomic Dark Walnut wooden hanger shoulders
    const shoulderCurve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(-0.62, -0.56, 0.01),
      new THREE.Vector3(-0.28, -0.40, 0.015),
      new THREE.Vector3(0.0, -0.34, 0.02),
      new THREE.Vector3(0.28, -0.40, 0.015),
      new THREE.Vector3(0.62, -0.56, 0.01),
    ]);
    const shoulderGeo = new THREE.TubeGeometry(shoulderCurve, 32, 0.028, 12, false);

    // Tiny polished brass shoulder end-caps
    const shoulderTipLeftGeo = new THREE.SphereGeometry(0.03, 14, 10);
    shoulderTipLeftGeo.translate(-0.62, -0.56, 0.01);
    const shoulderTipRightGeo = new THREE.SphereGeometry(0.03, 14, 10);
    shoulderTipRightGeo.translate(0.62, -0.56, 0.01);

    const pickMeshes: THREE.Object3D[] = [];
    const runtimes: GarmentRuntime[] = [];

    for (let idx = 0; idx < items.length; idx += 1) {
      const item = items[idx]!;
      const initialVariant = item.variants[0];
      const initialUrl = getVariantTextureUrl(initialVariant, false);

      const pivot = new THREE.Group();
      rackGroup.add(pivot);

      const initialTexBundle = resolveTexture(initialUrl, () => {
        const rt = runtimesRef.current[idx];
        if (rt && rt.currentUrl === (initialUrl ?? '')) {
          rt.fadeTarget = 1;
        }
      });

      const mat = new THREE.ShaderMaterial({
        uniforms: {
          uMapA: { value: initialTexBundle.texture },
          uMapB: { value: initialTexBundle.texture },
          uMix: { value: 0 },
          uBlur: { value: 0 },
          uDim: { value: 0 },
          uGlow: { value: 0 },
          uFlip: { value: 0 },
          uTime: { value: 0 },
          uAlpha: { value: initialTexBundle.alreadyLoaded ? 1 : 0 },
        },
        vertexShader: GARMENT_VERTEX_SHADER,
        fragmentShader: GARMENT_FRAGMENT_SHADER,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
      });

      const mesh = new THREE.Mesh(planeGeo, mat);
      mesh.rotation.z = 0; // Natural upright hanging (NO upside-down Math.PI flip!)
      mesh.userData.index = idx;
      mesh.renderOrder = 2;
      pivot.add(mesh);
      pickMeshes.push(mesh);

      // Sculpted 3D Brass + Dark Walnut Hanger attached directly to pivot group
      const hangerBrassMat = new THREE.MeshPhysicalMaterial({
        color: 0xdcb870,
        metalness: 1,
        roughness: 0.22,
        clearcoat: 0.6,
        clearcoatRoughness: 0.2,
        transparent: true,
        opacity: 1,
      });
      const hangerWoodMat = new THREE.MeshPhysicalMaterial({
        color: 0x3b2314,
        metalness: 0.05,
        roughness: 0.32,
        clearcoat: 0.55,
        clearcoatRoughness: 0.24,
        transparent: true,
        opacity: 1,
      });

      const hangerGroup = new THREE.Group();
      hangerGroup.renderOrder = 1;
      hangerGroup.add(new THREE.Mesh(ringGeo, hangerBrassMat));
      hangerGroup.add(new THREE.Mesh(hookGeo, hangerBrassMat));
      hangerGroup.add(new THREE.Mesh(ferruleGeo, hangerBrassMat));
      hangerGroup.add(new THREE.Mesh(shoulderGeo, hangerWoodMat));
      hangerGroup.add(new THREE.Mesh(shoulderTipLeftGeo, hangerBrassMat));
      hangerGroup.add(new THREE.Mesh(shoulderTipRightGeo, hangerBrassMat));
      pivot.add(hangerGroup);

      // Rear showroom wall soft silhouette shadow (z = -2.1)
      const shadowMat = new THREE.ShaderMaterial({
        uniforms: {
          uMap: { value: initialTexBundle.texture },
          uBlur: { value: 0.035 },
          uStrength: { value: 0.42 },
          uAlpha: { value: initialTexBundle.alreadyLoaded ? 1 : 0 },
        },
        vertexShader: WALL_SHADOW_VERTEX_SHADER,
        fragmentShader: WALL_SHADOW_FRAGMENT_SHADER,
        transparent: true,
        depthWrite: false,
      });
      const shadowPivot = new THREE.Group();
      rackGroup.add(shadowPivot);
      const shadowMesh = new THREE.Mesh(planeGeo, shadowMat);
      shadowMesh.rotation.z = 0;
      shadowMesh.scale.setScalar(1.06);
      shadowMesh.renderOrder = 0;
      shadowPivot.add(shadowMesh);

      applyHangerAnchorOffset(
        mesh,
        shadowMesh,
        initialVariant?.hangerAnchorX,
        initialVariant?.hangerAnchorY,
      );

      const seedAngle = (((idx * 37) % 100) / 100 - 0.5) * 0.08;
      runtimes.push({
        index: idx,
        productId: item.productId,
        fabricWeight: item.fabricWeight,
        pivot,
        mesh,
        mat,
        hangerGroup,
        hangerBrassMat,
        hangerWoodMat,
        shadowPivot,
        shadowMesh,
        shadowMat,
        pendulum: createSpringPendulumState(seedAngle),
        pres: 0,
        presTarget: 0,
        spread: 0,
        spreadTarget: 0,
        baseZ: (idx % 2) * 0.16,
        mixProgress: 0,
        isMixing: false,
        currentUrl: initialUrl ?? '',
        fadeAlpha: initialTexBundle.alreadyLoaded ? 1 : 0,
        fadeTarget: initialTexBundle.alreadyLoaded ? 1 : 0,
        backFlip: 0,
        backFlipTarget: 0,
      });
    }

    runtimesRef.current = runtimes;
    pickMeshesRef.current = pickMeshes;

    // 118 Fine Golden Spark Particles (90 ambient 2px-5px dust + 28 orbiting 3px-6.5px halo)
    const { positions, seeds, kinds } = createSparkGeometryBuffers();
    const sparkGeo = new THREE.BufferGeometry();
    sparkGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    sparkGeo.setAttribute('seed', new THREE.BufferAttribute(seeds, 1));
    sparkGeo.setAttribute('kind', new THREE.BufferAttribute(kinds, 1));
    sparkGeo.setDrawRange(0, SPARK_PARTICLE_COUNT);

    const sparkMat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uFocusAmt: { value: 0 },
        uFocusPos: { value: new THREE.Vector3(0, 0, PRESENT_Z - 0.3) },
        uPx: { value: Math.min(gl.getPixelRatio(), 1.5) },
      },
      vertexShader: SPARK_VERTEX_SHADER,
      fragmentShader: SPARK_FRAGMENT_SHADER,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    sparkMatRef.current = sparkMat;

    const sparkPoints = new THREE.Points(sparkGeo, sparkMat);
    sparkPoints.frustumCulled = false;
    sparkPoints.renderOrder = 3;
    rootGroup.add(sparkPoints);

    presentedRef.current = -1;
    stillTimeRef.current = 0;

    return () => {
      sceneDisposedRef.current = true;
      const disposedRuntimes = runtimesRef.current;
      runtimesRef.current = [];
      pickMeshesRef.current = [];
      sparkMatRef.current = null;

      // Explicit per-runtime shader & physical material disposal
      for (const rt of disposedRuntimes) {
        rt.mat.dispose();
        rt.shadowMat.dispose();
        rt.hangerBrassMat.dispose();
        rt.hangerWoodMat.dispose();
      }

      // Explicit shared geometry & material disposal
      const sharedGeometries: THREE.BufferGeometry[] = [
        railGeo,
        finialGeo,
        planeGeo,
        ringGeo,
        hookGeo,
        ferruleGeo,
        shoulderGeo,
        shoulderTipLeftGeo,
        shoulderTipRightGeo,
        sparkGeo,
      ];
      for (const geometry of sharedGeometries) {
        geometry.dispose();
      }
      brassMat.dispose();
      sparkMat.dispose();

      disposeObject3D(rootGroup as unknown as DisposableObject3D);

      rootGroup.traverse((obj: THREE.Object3D) => {
        const meshLike = obj as THREE.Mesh;
        if (meshLike.geometry && typeof meshLike.geometry.dispose === 'function') {
          meshLike.geometry.dispose();
        }
        if (meshLike.material) {
          const mats = Array.isArray(meshLike.material)
            ? meshLike.material
            : [meshLike.material];
          for (const material of mats) {
            if (material && typeof material.dispose === 'function') {
              material.dispose();
            }
          }
        }
      });

      for (const texture of textureCacheRef.current.values()) {
        texture.dispose();
      }
      textureCacheRef.current.clear();
      loadedUrlsRef.current.clear();

      if (transparentTexRef.current) {
        transparentTexRef.current.dispose();
        transparentTexRef.current = null;
      }

      scene.remove(rootGroup);
      rootGroupRef.current = null;
      rackGroupRef.current = null;
      gl.renderLists.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gl, items, scene]);

  // 4. Sync color swatch selection & front/back flip into shader uniforms + reclaim swapped textures
  useEffect(() => {
    const runtimes = runtimesRef.current;
    for (let i = 0; i < runtimes.length; i += 1) {
      const rt = runtimes[i];
      const item = items[i];
      if (!rt || !item) continue;

      const variantIdx = activeVariants[item.productId] ?? 0;
      const variant = item.variants[variantIdx] ?? item.variants[0];
      const showBack = Boolean(showBackMap[item.productId]);
      const nextUrl = getVariantTextureUrl(variant, showBack);
      const nextKey = nextUrl ?? '';

      if (variant) {
        applyHangerAnchorOffset(
          rt.mesh,
          rt.shadowMesh,
          variant.hangerAnchorX,
          variant.hangerAnchorY,
        );
      }

      rt.backFlipTarget = showBack ? 1 : 0;

      if (nextKey !== rt.currentUrl) {
        rt.currentUrl = nextKey;
        const applySwappedTexture = (targetRt: GarmentRuntime, nextTex: THREE.Texture) => {
          targetRt.mat.uniforms.uMapB.value = nextTex;
          targetRt.shadowMat.uniforms.uMap.value = nextTex;
          targetRt.mixProgress = 0;
          targetRt.isMixing = true;
          targetRt.fadeTarget = 1;
          evictUnreferencedTextures(runtimesRef.current);
        };

        const { texture: nextTex, alreadyLoaded } = resolveTexture(
          nextUrl,
          (loadedTex) => {
            const targetRt = runtimesRef.current[i];
            if (
              !sceneDisposedRef.current &&
              targetRt &&
              targetRt.currentUrl === nextKey
            ) {
              applySwappedTexture(targetRt, loadedTex);
            }
          },
        );

        if (alreadyLoaded || !nextUrl) {
          applySwappedTexture(rt, nextTex);
        }
        applySpringImpulse(rt.pendulum, 0.45, rt.fabricWeight);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeVariants, showBackMap, items]);

  // 5. Pointer wind sweep, dynamic cursor label & click-to-pick / click-to-flip listener
  useEffect(() => {
    const dom = gl.domElement;

    const handlePointerMove = (event: PointerEvent) => {
      const rect = dom.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      pointerNdcRef.current.set(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -(((event.clientY - rect.top) / rect.height) * 2 - 1),
      );
      if (lastClientXRef.current !== null) {
        pointerVelXRef.current += event.clientX - lastClientXRef.current;
      }
      lastClientXRef.current = event.clientX;
    };

    const handlePointerLeave = () => {
      pointerNdcRef.current.set(9, 9);
      lastClientXRef.current = null;
      if (hoveredRef.current !== -1) {
        hoveredRef.current = -1;
        dom.style.cursor = '';
        syncCanvasCursor(dom, -1, presentedRef.current);
        callbacksRef.current.onHoverChange?.(-1);
      }
    };

    const handleClick = () => {
      const hitIdx = hoveredRef.current;
      if (hitIdx < 0) return;
      if (hitIdx === presentedRef.current && callbacksRef.current.onTogglePresentedBack) {
        callbacksRef.current.onTogglePresentedBack(hitIdx);
      } else {
        callbacksRef.current.onPick(hitIdx);
      }
    };

    dom.addEventListener('pointermove', handlePointerMove, { passive: true });
    dom.addEventListener('pointerleave', handlePointerLeave);
    dom.addEventListener('click', handleClick);

    return () => {
      dom.removeEventListener('pointermove', handlePointerMove);
      dom.removeEventListener('pointerleave', handlePointerLeave);
      dom.removeEventListener('click', handleClick);
      dom.style.cursor = '';
    };
  }, [gl]);

  // 6. 60Hz WebGL animation loop — mutates Three.js objects & uniforms directly (ZERO setState!)
  useFrame((_state, delta) => {
    if (!shouldRenderRef.current) return;
    const rackGroup = rackGroupRef.current;
    const runtimes = runtimesRef.current;
    if (!rackGroup || runtimes.length === 0) return;

    const dt = clamp(delta, 0, 0.05);
    elapsedRef.current += dt;
    const t = elapsedRef.current;

    const maxIdx = Math.max(0, runtimes.length - 1);
    const targetFocus = clamp(focusRef.current, 0, maxIdx);

    const prevVel = focusVelRef.current;
    smoothFocusRef.current +=
      (targetFocus - smoothFocusRef.current) * (1 - Math.pow(0.0025, dt));
    const safeDt = Math.max(dt, 0.0001);
    focusVelRef.current = (smoothFocusRef.current - prevFocusRef.current) / safeDt;
    prevFocusRef.current = smoothFocusRef.current;
    focusAccRef.current = (focusVelRef.current - prevVel) / safeDt;

    rackGroup.position.x = -smoothFocusRef.current * SPACING;

    // 0.28s stop-scroll auto-present logic
    const nearest = clamp(Math.round(smoothFocusRef.current), 0, maxIdx);
    if (
      Math.abs(smoothFocusRef.current - nearest) < 0.06 &&
      Math.abs(focusVelRef.current) < 0.05
    ) {
      stillTimeRef.current += dt;
    } else {
      stillTimeRef.current = 0;
    }

    const triggerPresent = (nextIndex: number) => {
      if (nextIndex === presentedRef.current) return;
      presentedRef.current = nextIndex;
      for (let i = 0; i < runtimes.length; i += 1) {
        const rt = runtimes[i];
        if (!rt) continue;
        rt.presTarget = i === nextIndex ? 1 : 0;
        rt.spreadTarget = nextIndex < 0 ? 0 : Math.sign(i - nextIndex);
      }
      if (nextIndex >= 0) {
        const leftNeighbor = runtimes[nextIndex - 1];
        const rightNeighbor = runtimes[nextIndex + 1];
        if (leftNeighbor) {
          applySpringImpulse(leftNeighbor.pendulum, -0.9, leftNeighbor.fabricWeight);
        }
        if (rightNeighbor) {
          applySpringImpulse(rightNeighbor.pendulum, 0.9, rightNeighbor.fabricWeight);
        }
      }
      syncCanvasCursor(gl.domElement, hoveredRef.current, nextIndex);
      callbacksRef.current.onPresentChange(nextIndex);
    };

    if (
      presentedRef.current >= 0 &&
      Math.abs(smoothFocusRef.current - presentedRef.current) > 0.35
    ) {
      triggerPresent(-1);
    }
    if (
      stillTimeRef.current > AUTO_PRESENT_DELAY_SEC &&
      presentedRef.current !== nearest
    ) {
      triggerPresent(nearest);
    }

    // Raycast hover for gentle cursor wind sway & dynamic XEM / XOAY cursor label
    raycasterRef.current.setFromCamera(pointerNdcRef.current, camera);
    const hits = raycasterRef.current.intersectObjects(pickMeshesRef.current, false);
    const firstHit = hits[0];
    const nextHover =
      firstHit && typeof firstHit.object.userData.index === 'number'
        ? (firstHit.object.userData.index as number)
        : -1;
    if (nextHover !== hoveredRef.current) {
      hoveredRef.current = nextHover;
      gl.domElement.style.cursor = nextHover >= 0 ? 'pointer' : '';
      syncCanvasCursor(gl.domElement, nextHover, presentedRef.current);
      callbacksRef.current.onHoverChange?.(nextHover);
    }
    if (firstHit) {
      hitPointRef.current.copy(firstHit.point);
    }
    pointerVelXRef.current *= 0.86;

    const currentPresented = presentedRef.current;
    const presentY = presentYRef.current;

    for (let i = 0; i < runtimes.length; i += 1) {
      const rt = runtimes[i];
      if (!rt) continue;

      // Smooth fade-in on real WebP load (uAlpha: 0 -> 1)
      if (rt.fadeAlpha !== rt.fadeTarget) {
        rt.fadeAlpha += (rt.fadeTarget - rt.fadeAlpha) * (1 - Math.exp(-7.5 * dt));
        if (Math.abs(rt.fadeTarget - rt.fadeAlpha) < 0.004) {
          rt.fadeAlpha = rt.fadeTarget;
        }
      }
      rt.mat.uniforms.uAlpha.value = rt.fadeAlpha;
      rt.shadowMat.uniforms.uAlpha.value = rt.fadeAlpha;

      // Ambient draft + scroll inertia + pointer sweep wind
      let rawWind =
        -focusAccRef.current * 0.012 + Math.sin(t * 0.7 + rt.index * 1.7) * 0.05;
      if (
        hoveredRef.current === rt.index ||
        (firstHit &&
          Math.abs(
            hitPointRef.current.x - (rt.index * SPACING + rackGroup.position.x),
          ) <
            GARMENT_W * 0.7)
      ) {
        rawWind += pointerVelXRef.current * 0.018;
      }

      stepSpringPendulum(rt.pendulum, dt, rawWind, rt.fabricWeight);

      // Smooth damped presentation & neighbor parting
      const presRate = rt.presTarget > rt.pres ? 3.2 : 4.2;
      rt.pres += (rt.presTarget - rt.pres) * (1 - Math.exp(-presRate * dt));
      if (Math.abs(rt.presTarget - rt.pres) < 0.0005) rt.pres = rt.presTarget;

      rt.spread += (rt.spreadTarget - rt.spread) * (1 - Math.exp(-3.4 * dt));
      if (Math.abs(rt.spreadTarget - rt.spread) < 0.0005) rt.spread = rt.spreadTarget;

      // Smooth front/back Y flip progress
      rt.backFlip += (rt.backFlipTarget - rt.backFlip) * (1 - Math.exp(-5.8 * dt));
      if (Math.abs(rt.backFlipTarget - rt.backFlip) < 0.0005) {
        rt.backFlip = rt.backFlipTarget;
      }

      // Smooth color swatch / side texture crossfade (uMix: 0 -> 1) + VRAM texture reclamation
      if (rt.isMixing) {
        rt.mixProgress = Math.min(1, rt.mixProgress + dt * 2.6);
        const easedMix =
          rt.mixProgress * rt.mixProgress * (3 - 2 * rt.mixProgress);
        rt.mat.uniforms.uMix.value = easedMix;
        if (rt.mixProgress >= 1) {
          const replacedTexture = rt.mat.uniforms.uMapA.value as THREE.Texture | null;
          const activeTexture = rt.mat.uniforms.uMapB.value as THREE.Texture | null;
          rt.mat.uniforms.uMapA.value = activeTexture;
          rt.mat.uniforms.uMix.value = 0;
          rt.isMixing = false;
          if (replacedTexture && replacedTexture !== activeTexture) {
            evictUnreferencedTextures(runtimes);
          }
        }
      }

      const p = rt.pres;
      const restX = rt.index * SPACING + rt.spread * 1.15;
      const restZ = rt.baseZ - Math.abs(rt.spread) * 0.5;
      const targetX = smoothFocusRef.current * SPACING;
      const targetPivotY =
        presentY + (HANGER_DROP + (0.5 - DEFAULT_HANGER_ANCHOR_Y) * GARMENT_H);

      // Lift arc Math.sin(pres * Math.PI) * 0.6 & advance z -> 3.4
      rt.pivot.position.set(
        restX + (targetX - restX) * p,
        RAIL_Y + (targetPivotY - RAIL_Y) * p + Math.sin(p * Math.PI) * 0.6,
        restZ + (PRESENT_Z - restZ) * p,
      );

      // Natural upright sway on Z (NEVER upside-down Math.PI!)
      rt.pivot.rotation.z =
        rt.pendulum.a * (1 - p) + (p > 0.98 ? Math.sin(t * 1.1) * 0.012 : 0);

      // Editorial Y turn: -0.22 on rail -> 0 + sin(t * 0.6) * 0.06 presented, + Math.PI on back flip
      const restRotY = -0.22 + rt.pendulum.b * 0.7;
      const presentedRotY = Math.sin(t * 0.6) * 0.06;
      rt.pivot.rotation.y =
        restRotY * (1 - p) + presentedRotY * p + rt.backFlip * Math.PI;

      // Smoothly fade sculpted 3D hanger when presented forward (no floating artifacts)
      const hangerOpacity = Math.max(0, 1 - p * 2.6);
      rt.hangerBrassMat.opacity = hangerOpacity;
      rt.hangerWoodMat.opacity = hangerOpacity;
      rt.hangerBrassMat.depthWrite = hangerOpacity > 0.85;
      rt.hangerWoodMat.depthWrite = hangerOpacity > 0.85;
      rt.hangerGroup.visible = hangerOpacity > 0.01;

      // Update optical DOF garment shader uniforms
      const isFocused = currentPresented === rt.index;
      const isBackground = currentPresented >= 0 && !isFocused;
      const targetDim = isBackground ? 0.58 : 0.0;
      const targetBlur = isBackground ? 0.0065 : 0.0;

      rt.mat.uniforms.uDim.value +=
        (targetDim - (rt.mat.uniforms.uDim.value as number)) * 0.09;
      rt.mat.uniforms.uBlur.value +=
        (targetBlur - (rt.mat.uniforms.uBlur.value as number)) * 0.09;
      rt.mat.uniforms.uGlow.value = 0.28 * p;
      rt.mat.uniforms.uFlip.value = rt.backFlip;
      rt.mat.uniforms.uTime.value = t;

      // Rear showroom wall soft silhouette shadow at z = -2.1
      rt.shadowPivot.position.set(
        rt.pivot.position.x + 0.45 + p * 0.55,
        rt.pivot.position.y - 0.28 - p * 0.18,
        -2.1,
      );
      rt.shadowPivot.rotation.copy(rt.pivot.rotation);
      rt.shadowMat.uniforms.uStrength.value = 0.42 - p * 0.2;
      rt.shadowMat.uniforms.uBlur.value = 0.035 + p * 0.03;
    }

    // Update 118 fine golden spark particles
    const sparkMat = sparkMatRef.current;
    if (sparkMat) {
      sparkMat.uniforms.uTime.value = t;
      const targetSparkFocus =
        currentPresented >= 0 ? (runtimes[currentPresented]?.pres ?? 0) : 0;
      sparkMat.uniforms.uFocusAmt.value +=
        (targetSparkFocus - (sparkMat.uniforms.uFocusAmt.value as number)) * 0.1;
      (sparkMat.uniforms.uFocusPos.value as THREE.Vector3).set(
        0,
        presentY + 0.1,
        PRESENT_Z - 0.3,
      );
    }
  });

  return null;
}

export function RackCanvasR3F({
  items,
  focusRef,
  shouldRender,
  maxDpr = 1.5,
  activeVariants,
  showBackMap,
  onPresentChange,
  onPick,
  onTogglePresentedBack,
  onHoverChange,
  onContextLost,
}: RackCanvasR3FProps) {
  return (
    <Canvas
      className="rack__gl absolute inset-0 h-full w-full"
      dpr={[1, maxDpr]}
      frameloop={shouldRender ? 'always' : 'never'}
      camera={{ fov: 28, near: 0.1, far: 100, position: [0, 0, 16] }}
      gl={{
        antialias: true,
        alpha: true,
        powerPreference: 'high-performance',
      }}
      onCreated={({ gl }) => {
        gl.outputColorSpace = THREE.SRGBColorSpace;
        gl.toneMapping = THREE.ACESFilmicToneMapping;
        gl.toneMappingExposure = 1.05;
      }}
    >
      <RackScene
        items={items}
        focusRef={focusRef}
        shouldRender={shouldRender}
        activeVariants={activeVariants}
        showBackMap={showBackMap}
        onPresentChange={onPresentChange}
        onPick={onPick}
        onTogglePresentedBack={onTogglePresentedBack}
        onHoverChange={onHoverChange}
        onContextLost={onContextLost}
      />
    </Canvas>
  );
}

export default RackCanvasR3F;
