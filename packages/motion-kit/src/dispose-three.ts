export interface DisposableResource {
  dispose: () => void;
}

export interface DisposableMaterial extends DisposableResource {
  map?: DisposableResource | null;
  alphaMap?: DisposableResource | null;
  aoMap?: DisposableResource | null;
  bumpMap?: DisposableResource | null;
  displacementMap?: DisposableResource | null;
  emissiveMap?: DisposableResource | null;
  envMap?: DisposableResource | null;
  lightMap?: DisposableResource | null;
  metalnessMap?: DisposableResource | null;
  normalMap?: DisposableResource | null;
  roughnessMap?: DisposableResource | null;
  specularMap?: DisposableResource | null;
  gradientMap?: DisposableResource | null;
  uniforms?: Record<string, { value?: unknown }>;
  [key: string]: unknown;
}

export interface DisposableObject3D {
  geometry?: DisposableResource | null;
  material?: DisposableMaterial | readonly DisposableMaterial[] | null;
  children?: readonly DisposableObject3D[];
  traverse?: (callback: (object: DisposableObject3D) => void) => void;
}

export interface DisposeObject3DResult {
  geometriesDisposed: number;
  materialsDisposed: number;
  texturesDisposed: number;
}

const STANDARD_TEXTURE_KEYS = [
  'map',
  'alphaMap',
  'aoMap',
  'bumpMap',
  'displacementMap',
  'emissiveMap',
  'envMap',
  'lightMap',
  'metalnessMap',
  'normalMap',
  'roughnessMap',
  'specularMap',
  'gradientMap',
] as const;

function isDisposableResource(value: unknown): value is DisposableResource {
  return (
    typeof value === 'object' &&
    value !== null &&
    'dispose' in value &&
    typeof (value as { dispose?: unknown }).dispose === 'function'
  );
}

function disposeMaterial(
  material: DisposableMaterial,
  disposedSet: WeakSet<object>,
  counts: DisposeObject3DResult,
): void {
  if (disposedSet.has(material)) {
    return;
  }

  for (const key of STANDARD_TEXTURE_KEYS) {
    const tex = material[key];
    if (isDisposableResource(tex) && !disposedSet.has(tex)) {
      disposedSet.add(tex);
      tex.dispose();
      counts.texturesDisposed += 1;
    }
  }

  if (material.uniforms && typeof material.uniforms === 'object') {
    for (const uniform of Object.values(material.uniforms)) {
      const value = uniform?.value;
      if (isDisposableResource(value) && !disposedSet.has(value)) {
        disposedSet.add(value);
        value.dispose();
        counts.texturesDisposed += 1;
      } else if (Array.isArray(value)) {
        for (const item of value) {
          if (isDisposableResource(item) && !disposedSet.has(item)) {
            disposedSet.add(item);
            item.dispose();
            counts.texturesDisposed += 1;
          }
        }
      }
    }
  }

  disposedSet.add(material);
  material.dispose();
  counts.materialsDisposed += 1;
}

/**
 * Recursively disposes geometries, materials, standard textures, and custom
 * ShaderMaterial uniform textures on any Three.js-compatible Object3D tree.
 * Safe against shared resources, cyclic references, and null/undefined inputs.
 */
export function disposeObject3D(
  root: DisposableObject3D | null | undefined,
): DisposeObject3DResult {
  const counts: DisposeObject3DResult = {
    geometriesDisposed: 0,
    materialsDisposed: 0,
    texturesDisposed: 0,
  };

  if (!root) {
    return counts;
  }

  const visitedNodes = new WeakSet<object>();
  const disposedResources = new WeakSet<object>();

  const processNode = (node: DisposableObject3D): void => {
    if (visitedNodes.has(node)) {
      return;
    }
    visitedNodes.add(node);

    if (isDisposableResource(node.geometry) && !disposedResources.has(node.geometry)) {
      disposedResources.add(node.geometry);
      node.geometry.dispose();
      counts.geometriesDisposed += 1;
    }

    if (node.material) {
      const materials: readonly DisposableMaterial[] = Array.isArray(node.material)
        ? node.material
        : [node.material];
      for (const material of materials) {
        if (material && typeof material.dispose === 'function') {
          disposeMaterial(material, disposedResources, counts);
        }
      }
    }
  };

  if (typeof root.traverse === 'function') {
    root.traverse(processNode);
  } else {
    const stack: DisposableObject3D[] = [root];
    while (stack.length > 0) {
      const current = stack.pop();
      if (!current) {
        continue;
      }
      processNode(current);
      if (Array.isArray(current.children)) {
        for (const child of current.children) {
          if (child && !visitedNodes.has(child)) {
            stack.push(child);
          }
        }
      }
    }
  }

  return counts;
}
