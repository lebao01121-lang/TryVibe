export const SPARK_AMBIENT_COUNT = 90;
export const SPARK_HALO_COUNT = 28;
export const SPARK_PARTICLE_COUNT = SPARK_AMBIENT_COUNT + SPARK_HALO_COUNT; // 118

export const SPARK_VERTEX_SHADER = /* glsl */ `
  attribute float seed;
  attribute float kind;
  uniform float uTime;
  uniform float uFocusAmt;
  uniform vec3 uFocusPos;
  uniform float uPx;
  varying float vA;

  void main() {
    vec3 p = position;
    float tw = 0.5 + 0.5 * sin(uTime * (1.3 + seed * 2.7) + seed * 40.0);
    tw = pow(tw, 5.0);

    float dpr = clamp(uPx, 1.0, 2.0);
    float cssSize = 2.0;
    vA = 0.0;

    if (kind > 0.5) {
      // 28 delicate 3px-6.5px golden halo sparkles orbiting the presented garment
      float ang = seed * 6.2831853 + uTime * 0.14 * (seed > 0.5 ? 1.0 : -1.0);
      float radius = 1.25 + fract(seed * 13.7) * 1.35;
      p = uFocusPos + vec3(
        cos(ang) * radius * 0.85,
        sin(ang) * radius * 1.25 + 0.15,
        (fract(seed * 7.3) - 0.5) * 1.4
      );
      vA = (0.18 + tw * 0.82) * uFocusAmt * 0.85;
      cssSize = clamp(3.0 + fract(seed * 19.1) * 3.5 * (0.65 + 0.35 * tw), 3.0, 6.5);
    } else {
      // 90 fine 2px-5px ambient showroom dust motes drifting softly upward
      p.y = mod(p.y + uTime * (0.05 + seed * 0.11) + 5.0, 10.0) - 5.0;
      p.x += sin(uTime * 0.28 + seed * 20.0) * 0.25;
      vA = (0.12 + tw * 0.65) * 0.52;
      cssSize = clamp(2.0 + fract(seed * 17.3) * 3.0 * (0.7 + 0.3 * tw), 2.0, 5.0);
    }

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = cssSize * dpr;
  }
`;

export const SPARK_FRAGMENT_SHADER = /* glsl */ `
  varying float vA;

  void main() {
    float d = length(gl_PointCoord - 0.5);
    if (d > 0.5) discard;

    // Tight exponential golden spark glow — zero big opaque white dots
    float glow = exp(-d * 6.5) * 0.85 + smoothstep(0.5, 0.0, d) * 0.22;
    float a = glow * vA;
    if (a < 0.004) discard;

    // Subtle warm gold #F5DC9B
    vec3 goldColor = vec3(0.961, 0.863, 0.608);
    gl_FragColor = vec4(goldColor * a, a);
  }
`;

export interface SparkGeometryBuffers {
  positions: Float32Array;
  seeds: Float32Array;
  kinds: Float32Array;
}

function deterministicRand(index: number, salt: number): number {
  const x = Math.sin((index + 1) * 12.9898 + salt * 78.233) * 43758.5453123;
  return x - Math.floor(x);
}

/**
 * Generates deterministic attribute buffers for all 118 showroom spark particles:
 * 90 ambient dust motes (kind = 0) + 28 orbiting golden halo sparkles (kind = 1).
 */
export function createSparkGeometryBuffers(): SparkGeometryBuffers {
  const positions = new Float32Array(SPARK_PARTICLE_COUNT * 3);
  const seeds = new Float32Array(SPARK_PARTICLE_COUNT);
  const kinds = new Float32Array(SPARK_PARTICLE_COUNT);

  for (let i = 0; i < SPARK_PARTICLE_COUNT; i += 1) {
    positions[i * 3] = (deterministicRand(i, 1) - 0.5) * 22;
    positions[i * 3 + 1] = (deterministicRand(i, 2) - 0.5) * 10;
    positions[i * 3 + 2] = (deterministicRand(i, 3) - 0.3) * 6;
    seeds[i] = deterministicRand(i, 4);
    kinds[i] = i >= SPARK_AMBIENT_COUNT ? 1 : 0;
  }

  return { positions, seeds, kinds };
}
