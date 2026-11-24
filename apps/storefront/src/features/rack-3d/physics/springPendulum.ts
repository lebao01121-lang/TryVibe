export interface SpringPendulumState {
  /** Z-axis lateral pendulum swing angle in radians (clamped to [-0.6, 0.6]). */
  a: number;
  /** Z-axis angular velocity in rad/s. */
  va: number;
  /** Y-axis twist angle in radians (clamped to [-0.45, 0.45]). */
  b: number;
  /** Y-axis twist angular velocity in rad/s. */
  vb: number;
}

export interface SpringPendulumParams {
  /** Normalized fabric weight in [0.25, 1.0]. */
  weight: number;
  /** Z-axis restoring stiffness. */
  kz: number;
  /** Z-axis viscous damping. */
  dz: number;
  /** Y-axis twist restoring stiffness. */
  ky: number;
  /** Y-axis twist viscous damping. */
  dy: number;
  /** Multiplier applied to incoming wind/scroll impulses. */
  windScale: number;
}

const MIN_WEIGHT = 0.25;
const MAX_WEIGHT = 1.0;
const MAX_DT = 0.05;
const MAX_SWAY_RAD = 0.6;
const MAX_TWIST_RAD = 0.45;

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function lerp(start: number, end: number, t: number): number {
  return start + (end - start) * t;
}

/**
 * Normalizes backend `fabricWeight` (normalized 0.25..1.0, numeric GSM, or
 * descriptive strings such as "19 momme" / "240gsm" / "heavy tweed") into [0.25, 1.0].
 * 0.25 = airy silk / organza; 1.0 = heavy tweed / structured wool.
 */
export function normalizeFabricWeight(
  fabricWeight: number | string | null | undefined,
): number {
  if (typeof fabricWeight === 'number' && Number.isFinite(fabricWeight)) {
    if (fabricWeight <= 1.2) {
      return clamp(fabricWeight, MIN_WEIGHT, MAX_WEIGHT);
    }
    const gsmT = clamp((fabricWeight - 80) / 320, 0, 1);
    return lerp(MIN_WEIGHT, MAX_WEIGHT, gsmT);
  }

  if (typeof fabricWeight === 'string') {
    const raw = fabricWeight.trim().toLowerCase();
    const numMatch = raw.match(/(\d+(?:\.\d+)?)/);
    if (numMatch) {
      const parsed = Number.parseFloat(numMatch[1]);
      if (Number.isFinite(parsed)) {
        if (raw.includes('momme') || raw.includes('mm')) {
          const silkT = clamp((parsed - 12) / 28, 0, 1);
          return lerp(0.25, 0.46, silkT);
        }
        if (raw.includes('gsm') || parsed > 1.2) {
          const gsmT = clamp((parsed - 80) / 320, 0, 1);
          return lerp(MIN_WEIGHT, MAX_WEIGHT, gsmT);
        }
        return clamp(parsed, MIN_WEIGHT, MAX_WEIGHT);
      }
    }

    if (
      raw.includes('silk') ||
      raw.includes('lụa') ||
      raw.includes('tơ') ||
      raw.includes('organza') ||
      raw.includes('voan')
    ) {
      return 0.28;
    }
    if (
      raw.includes('tweed') ||
      raw.includes('wool') ||
      raw.includes('cashmere') ||
      raw.includes('len') ||
      raw.includes('dạ')
    ) {
      return 0.92;
    }
    if (raw.includes('linen') || raw.includes('cotton') || raw.includes('tencel')) {
      return 0.56;
    }
  }

  return 0.55;
}

/**
 * Derives 2-axis spring-damper constants smoothly from `fabricWeight`.
 * Silk (0.25) has soft restoring force, light damping, and high wind responsiveness;
 * Heavy tweed/wool (1.0) has firmer stiffness, crisp damping, and calmer wind inertia.
 */
export function computeSpringParams(
  fabricWeight: number | string | null | undefined,
): SpringPendulumParams {
  const weight = normalizeFabricWeight(fabricWeight);
  const t = clamp((weight - MIN_WEIGHT) / (MAX_WEIGHT - MIN_WEIGHT), 0, 1);

  return {
    weight,
    kz: lerp(6.2, 13.5, t),
    dz: lerp(0.82, 2.05, t),
    ky: lerp(4.2, 9.2, t),
    dy: lerp(1.05, 2.35, t),
    windScale: lerp(1.32, 0.62, t),
  };
}

export function createSpringPendulumState(initialAngle = 0): SpringPendulumState {
  return {
    a: clamp(initialAngle, -MAX_SWAY_RAD, MAX_SWAY_RAD),
    va: 0,
    b: 0,
    vb: 0,
  };
}

/**
 * Steps the 2-axis garment hanger pendulum in-place with dt clamped to 0.05s.
 */
export function stepSpringPendulum(
  state: SpringPendulumState,
  delta: number,
  rawWindForce: number,
  fabricWeight: number | string | null | undefined,
): SpringPendulumState {
  const dt = clamp(Number.isFinite(delta) ? delta : 0, 0, MAX_DT);
  if (dt <= 0) {
    return state;
  }

  const { kz, dz, ky, dy, windScale } = computeSpringParams(fabricWeight);
  const windForce = rawWindForce * windScale;

  // Z-axis sway
  state.va += (-kz * state.a - dz * state.va + windForce) * dt;
  state.a = clamp(state.a + state.va * dt, -MAX_SWAY_RAD, MAX_SWAY_RAD);

  // Y-axis twist
  state.vb += (-ky * state.b - dy * state.vb + windForce * 0.9) * dt;
  state.b = clamp(state.b + state.vb * dt, -MAX_TWIST_RAD, MAX_TWIST_RAD);

  return state;
}

/**
 * Injects an angular velocity impulse (e.g. when neighboring garments part).
 */
export function applySpringImpulse(
  state: SpringPendulumState,
  impulse: number,
  fabricWeight: number | string | null | undefined,
): void {
  const { windScale } = computeSpringParams(fabricWeight);
  state.va += impulse * windScale;
  state.vb += impulse * 0.55 * windScale;
}

/**
 * Holding curve from legacy showroom rack: lingers smoothly at each garment
 * integer stop (flat in [0..0.22] and [0.78..1.0]) and smoothsteps between stops.
 */
export function plateau(x: number): number {
  const i = Math.floor(x);
  const f = x - i;
  const t = Math.min(1, Math.max(0, (f - 0.22) / 0.56));
  return i + t * t * (3 - 2 * t);
}
