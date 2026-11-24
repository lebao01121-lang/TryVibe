export const WALL_SHADOW_VERTEX_SHADER = /* glsl */ `
  varying vec2 vUv;

  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

export const WALL_SHADOW_FRAGMENT_SHADER = /* glsl */ `
  uniform sampler2D uMap;
  uniform float uBlur;
  uniform float uStrength;
  uniform float uAlpha;
  varying vec2 vUv;

  const vec2 PD[12] = vec2[12](
    vec2(-0.326, -0.406),
    vec2(-0.840, -0.074),
    vec2(-0.696,  0.457),
    vec2(-0.203,  0.621),
    vec2( 0.962, -0.195),
    vec2( 0.473, -0.480),
    vec2( 0.519,  0.767),
    vec2( 0.185, -0.893),
    vec2( 0.507,  0.064),
    vec2( 0.896,  0.412),
    vec2(-0.322, -0.933),
    vec2(-0.792, -0.598)
  );

  float softAlpha(sampler2D mapTex, vec2 uv, float rad) {
    if (rad < 0.0005) {
      return texture2D(mapTex, uv).a;
    }
    float lodBias = log2(max(1.0, rad * 900.0)) - 0.6;
    float acc = texture2D(mapTex, uv, lodBias).a * 1.5;
    float w = 1.5;
    vec2 spread = vec2(rad, rad / 1.5);
    for (int k = 0; k < 12; k++) {
      vec2 tapUv = clamp(uv + PD[k] * spread, vec2(0.001), vec2(0.999));
      acc += texture2D(mapTex, tapUv, lodBias).a;
      w += 1.0;
    }
    return acc / w;
  }

  void main() {
    if (uAlpha < 0.005) discard;

    float a = softAlpha(uMap, vUv, uBlur);

    // Edge vignette prevents any rectangular shadow border artifact on rear wall
    float edgeMask =
      smoothstep(0.0, 0.14, vUv.x) *
      smoothstep(0.0, 0.14, 1.0 - vUv.x) *
      smoothstep(0.0, 0.14, vUv.y) *
      smoothstep(0.0, 0.14, 1.0 - vUv.y);
    a *= edgeMask;

    float outAlpha = a * uStrength * clamp(uAlpha, 0.0, 1.0);
    if (outAlpha < 0.002) discard;

    // Warm dark espresso showroom shadow
    gl_FragColor = vec4(0.05, 0.025, 0.015, outAlpha);
  }
`;
