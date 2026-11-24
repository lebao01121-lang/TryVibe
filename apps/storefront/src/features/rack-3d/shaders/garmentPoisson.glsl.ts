export const GARMENT_VERTEX_SHADER = /* glsl */ `
  uniform float uFlip;
  uniform float uTime;
  varying vec2 vUv;

  void main() {
    vUv = uv;
    vec3 pos = position;
    // Subtle silk drape ripple during front/back flip transition
    float flipWave = sin(clamp(uFlip, 0.0, 1.0) * 3.14159265);
    pos.z += sin(uv.y * 5.0 + uTime * 2.2) * 0.025 * flipWave;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
  }
`;

export const GARMENT_FRAGMENT_SHADER = /* glsl */ `
  uniform sampler2D uMapA;
  uniform sampler2D uMapB;
  uniform float uMix;
  uniform float uBlur;
  uniform float uDim;
  uniform float uGlow;
  uniform float uFlip;
  uniform float uTime;
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

  // Premultiplied-alpha aware 12-tap Poisson Disk optical DOF blur preventing dark halos
  vec4 soft(sampler2D mapTex, vec2 uv, float rad) {
    if (rad < 0.0005) {
      return texture2D(mapTex, uv);
    }
    float lodBias = log2(max(1.0, rad * 900.0)) - 0.6;
    vec4 center = texture2D(mapTex, uv, lodBias);
    vec3 rgbAcc = center.rgb * center.a * 1.5;
    float aAcc = center.a * 1.5;
    float wAcc = 1.5;

    vec2 spread = vec2(rad, rad / 1.5);
    for (int k = 0; k < 12; k++) {
      vec2 tapUv = clamp(uv + PD[k] * spread, vec2(0.001), vec2(0.999));
      vec4 tap = texture2D(mapTex, tapUv, lodBias);
      rgbAcc += tap.rgb * tap.a;
      aAcc += tap.a;
      wAcc += 1.0;
    }

    float outAlpha = aAcc / wAcc;
    vec3 outRgb = aAcc > 0.0005 ? (rgbAcc / aAcc) : vec3(0.0);
    return vec4(outRgb, outAlpha);
  }

  void main() {
    if (uAlpha < 0.005) discard;

    // Keep back-face UV readable left-to-right when plane rotates 180 deg
    vec2 sampleUv = vUv;
    if (!gl_FrontFacing) {
      sampleUv.x = 1.0 - sampleUv.x;
    }

    float mixAmt = clamp(uMix, 0.0, 1.0);
    vec4 sampleA = soft(uMapA, sampleUv, uBlur);
    vec4 sampleB = mixAmt > 0.001 ? soft(uMapB, sampleUv, uBlur) : sampleA;

    float alpha = mix(sampleA.a, sampleB.a, mixAmt);
    float finalAlpha = alpha * clamp(uAlpha, 0.0, 1.0);
    if (finalAlpha < 0.015) discard;

    // Premultiplied crossfade avoids dark seams between garment silhouettes
    vec3 premulRgb = mix(sampleA.rgb * sampleA.a, sampleB.rgb * sampleB.a, mixAmt);
    vec3 col = premulRgb / max(alpha, 0.001);

    // Optical depth dimming: uDim 0.0 (presented focus) -> 0.58 (receded side garments)
    col = mix(col, col * 0.42, clamp(uDim, 0.0, 1.0));

    float flipShade = 1.0 - 0.06 * sin(clamp(uFlip, 0.0, 1.0) * 3.14159265);
    col *= flipShade;

    // Warm champagne rim glow where cutout alpha feathers + subtle fabric sheen
    float rim = 1.0 - smoothstep(0.35, 1.0, alpha);
    float sheen = 0.022 * uGlow * (0.5 + 0.5 * sin(uTime * 1.3 + vUv.y * 4.2 - vUv.x * 1.8));
    col += vec3(1.0, 0.87, 0.60) * (uGlow * rim * 0.9 + sheen);

    gl_FragColor = vec4(col, finalAlpha);
  }
`;
