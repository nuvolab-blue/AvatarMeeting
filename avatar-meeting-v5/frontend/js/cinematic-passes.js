/**
 * @fileoverview v18 — Cinematic post-process passes.
 *
 * Provides factory functions for three additional ShaderPass effects:
 *   - createLUTPass()              Color grading via 3D LUT in 2D texture
 *   - createAnamorphicFlarePass()  Horizontal blue lens flares
 *   - createLensPass()             Chromatic aberration + barrel distortion
 *
 * All shaders are inline (no external GLSL files). LUTs are generated
 * procedurally — no asset files required.
 */

import * as THREE from 'three';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

// ============================================================================
// LUT generation (procedural)
// ============================================================================

const LUT_SIZE = 32;  // 32x32x32 = 32768 colors

// ----------------------------------------------------------------------------
// Helper color manipulation (defined before use)
// ----------------------------------------------------------------------------
function lerp(a, b, t) { return a + (b - a) * t; }
function clamp01(x) { return Math.max(0, Math.min(1, x)); }
function smoothstep(edge0, edge1, x) {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}
function lift_gamma_gain(c, lift, gamma, gain) {
  let v = c * gain + lift * (1 - c);
  v = Math.pow(Math.max(0, v), 1 / Math.max(0.01, gamma));
  return clamp01(v);
}

/**
 * Generate a 1024x32 RGBA8 DataTexture representing a 32^3 3D LUT.
 * Each preset is a function (r, g, b) → (r', g', b'), all in [0,1].
 */
function generateLUTTexture(transformFn) {
  const width = LUT_SIZE * LUT_SIZE;  // 1024
  const height = LUT_SIZE;             // 32
  const data = new Uint8Array(width * height * 4);
  const sizeMinus1 = LUT_SIZE - 1;

  for (let b = 0; b < LUT_SIZE; b++) {
    for (let g = 0; g < LUT_SIZE; g++) {
      for (let r = 0; r < LUT_SIZE; r++) {
        const inR = r / sizeMinus1;
        const inG = g / sizeMinus1;
        const inB = b / sizeMinus1;
        const out = transformFn(inR, inG, inB);
        // Layout: x = b * 32 + r, y = g
        const x = b * LUT_SIZE + r;
        const y = g;
        const idx = (y * width + x) * 4;
        data[idx + 0] = Math.max(0, Math.min(255, Math.round(out[0] * 255)));
        data[idx + 1] = Math.max(0, Math.min(255, Math.round(out[1] * 255)));
        data[idx + 2] = Math.max(0, Math.min(255, Math.round(out[2] * 255)));
        data[idx + 3] = 255;
      }
    }
  }

  const tex = new THREE.DataTexture(data, width, height, THREE.RGBAFormat);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

// ----------------------------------------------------------------------------
// LUT preset transforms (each: (r, g, b) → [r', g', b'])
// ----------------------------------------------------------------------------

/** Neutral — identity LUT (still useful for tone-mapping check) */
const lutNeutral = (r, g, b) => [r, g, b];

/**
 * Kodak Vision3 5219 — warm, low contrast, blue shadows, slight magenta.
 */
const lutKodak5219 = (r, g, b) => {
  const cR = lift_gamma_gain(r, 0.04, 0.95, 1.05);
  const cG = lift_gamma_gain(g, 0.03, 0.96, 1.02);
  const cB = lift_gamma_gain(b, 0.06, 1.05, 0.92);
  const luma = 0.299 * cR + 0.587 * cG + 0.114 * cB;
  const shadowMix = 1 - smoothstep(0.0, 0.4, luma);
  const highMix = smoothstep(0.5, 0.9, luma);
  let outR = cR + 0.04 * highMix - 0.02 * shadowMix;
  let outG = cG + 0.02 * highMix;
  let outB = cB - 0.03 * highMix + 0.06 * shadowMix;
  return [clamp01(outR), clamp01(outG), clamp01(outB)];
};

/**
 * Fuji Eterna — low contrast, muted greens, naturalistic.
 */
const lutFujiEterna = (r, g, b) => {
  const cR = lerp(0.07, 0.93, r);
  const cG = lerp(0.08, 0.92, g);
  const cB = lerp(0.07, 0.91, b);
  const luma = 0.299 * cR + 0.587 * cG + 0.114 * cB;
  const desat = 0.15;
  let outR = lerp(cR, luma, desat);
  let outG = lerp(cG, luma, desat) + 0.02;
  let outB = lerp(cB, luma, desat) - 0.01;
  return [clamp01(outR), clamp01(outG), clamp01(outB)];
};

/**
 * Bleach Bypass — high contrast, very desaturated.
 */
const lutBleachBypass = (r, g, b) => {
  const cR = smoothstep(0.0, 1.0, r) * smoothstep(-0.2, 0.8, r);
  const cG = smoothstep(0.0, 1.0, g) * smoothstep(-0.2, 0.8, g);
  const cB = smoothstep(0.0, 1.0, b) * smoothstep(-0.2, 0.8, b);
  const luma = 0.299 * cR + 0.587 * cG + 0.114 * cB;
  const desat = 0.65;
  let outR = lerp(cR, luma, desat);
  let outG = lerp(cG, luma, desat);
  let outB = lerp(cB, luma, desat);
  return [clamp01(outR), clamp01(outG), clamp01(outB)];
};

/**
 * Teal & Orange — skin tones pushed orange, shadows pushed teal.
 */
const lutTealOrange = (r, g, b) => {
  const cR = lift_gamma_gain(r, 0.0, 1.0, 1.05);
  const cG = lift_gamma_gain(g, 0.0, 1.0, 1.0);
  const cB = lift_gamma_gain(b, 0.02, 1.0, 0.95);
  const luma = 0.299 * cR + 0.587 * cG + 0.114 * cB;
  const highMix = smoothstep(0.4, 0.9, luma);
  const shadowMix = 1 - smoothstep(0.0, 0.5, luma);
  let outR = cR + 0.08 * highMix - 0.04 * shadowMix;
  let outG = cG + 0.02 * highMix - 0.01 * shadowMix;
  let outB = cB - 0.06 * highMix + 0.10 * shadowMix;
  return [clamp01(outR), clamp01(outG), clamp01(outB)];
};

// ----------------------------------------------------------------------------
// LUT preset registry
// ----------------------------------------------------------------------------
export const LUT_PRESETS = {
  neutral:      { name: 'Neutral (無加工)',     fn: lutNeutral },
  kodak5219:    { name: 'Kodak 5219 Vision3',   fn: lutKodak5219 },
  fujiEterna:   { name: 'Fuji Eterna',           fn: lutFujiEterna },
  bleachBypass: { name: 'Bleach Bypass',         fn: lutBleachBypass },
  tealOrange:   { name: 'Teal & Orange',          fn: lutTealOrange },
};

// Cache generated textures
const _lutCache = new Map();
export function getLUTTexture(presetKey) {
  if (_lutCache.has(presetKey)) return _lutCache.get(presetKey);
  const preset = LUT_PRESETS[presetKey];
  if (!preset) {
    console.warn('[LUT] Unknown preset:', presetKey);
    return getLUTTexture('neutral');
  }
  const tex = generateLUTTexture(preset.fn);
  _lutCache.set(presetKey, tex);
  return tex;
}

// ============================================================================
// LUT ShaderPass
// ============================================================================
export function createLUTPass() {
  const initialLUT = getLUTTexture('neutral');
  const shader = {
    uniforms: {
      tDiffuse:    { value: null },
      tLUT:        { value: initialLUT },
      uIntensity:  { value: 1.0 },
    },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform sampler2D tDiffuse;
      uniform sampler2D tLUT;
      uniform float uIntensity;
      varying vec2 vUv;

      vec3 sampleLUT(vec3 color) {
        color = clamp(color, 0.0, 1.0);
        float blueRange = 31.0;
        float blueLow  = floor(color.b * blueRange);
        float blueHigh = min(blueLow + 1.0, 31.0);
        float blueMix  = fract(color.b * blueRange);
        float xOffsetLow  = (color.r * 31.0 + 0.5 + blueLow  * 32.0) / 1024.0;
        float xOffsetHigh = (color.r * 31.0 + 0.5 + blueHigh * 32.0) / 1024.0;
        float yOffset     = (color.g * 31.0 + 0.5) / 32.0;
        vec3 cLow  = texture2D(tLUT, vec2(xOffsetLow,  yOffset)).rgb;
        vec3 cHigh = texture2D(tLUT, vec2(xOffsetHigh, yOffset)).rgb;
        return mix(cLow, cHigh, blueMix);
      }

      void main() {
        vec4 src = texture2D(tDiffuse, vUv);
        vec3 graded = sampleLUT(src.rgb);
        gl_FragColor = vec4(mix(src.rgb, graded, uIntensity), src.a);
      }
    `,
  };
  return new ShaderPass(shader);
}

// ============================================================================
// Anamorphic flare ShaderPass
// ============================================================================
export function createAnamorphicFlarePass() {
  const shader = {
    uniforms: {
      tDiffuse:   { value: null },
      uThreshold: { value: 0.85 },
      uIntensity: { value: 0.6 },
      uTint:      { value: new THREE.Color(0.4, 0.7, 1.2) },
      uResolution:{ value: new THREE.Vector2(1, 1) },
      uStretch:   { value: 1.0 },
    },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform sampler2D tDiffuse;
      uniform float uThreshold;
      uniform float uIntensity;
      uniform vec3 uTint;
      uniform vec2 uResolution;
      uniform float uStretch;
      varying vec2 vUv;

      vec3 brightExtract(vec3 c) {
        float l = max(c.r, max(c.g, c.b));
        float t = smoothstep(uThreshold, 1.0, l);
        return c * t;
      }

      void main() {
        vec4 src = texture2D(tDiffuse, vUv);

        float pixelStep = (1.0 / uResolution.x) * 8.0 * max(0.1, uStretch);
        vec3 flare = vec3(0.0);
        float totalWeight = 0.0;
        for (int i = -16; i <= 16; i++) {
          float fi = float(i);
          float weight = exp(-fi * fi * 0.015);
          vec2 offsetUv = vUv + vec2(fi * pixelStep, 0.0);
          offsetUv.x = clamp(offsetUv.x, 0.0, 1.0);
          flare += brightExtract(texture2D(tDiffuse, offsetUv).rgb) * weight;
          totalWeight += weight;
        }
        flare /= totalWeight;
        flare *= uTint;

        vec3 outColor = src.rgb + flare * uIntensity;
        gl_FragColor = vec4(outColor, src.a);
      }
    `,
  };
  return new ShaderPass(shader);
}

// ============================================================================
// Lens pass: chromatic aberration + barrel distortion (combined)
// ============================================================================
export function createLensPass() {
  const shader = {
    uniforms: {
      tDiffuse:    { value: null },
      uCAStrength: { value: 0.003 },
      uDistortion: { value: 0.05 },
    },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform sampler2D tDiffuse;
      uniform float uCAStrength;
      uniform float uDistortion;
      varying vec2 vUv;

      vec2 barrelDistort(vec2 uv, float strength) {
        vec2 centered = uv - 0.5;
        float r2 = dot(centered, centered);
        centered *= 1.0 + strength * r2;
        return centered + 0.5;
      }

      vec4 sampleSafe(vec2 uv) {
        if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
          return vec4(0.0, 0.0, 0.0, 1.0);
        }
        return texture2D(tDiffuse, uv);
      }

      void main() {
        vec2 centered = vUv - 0.5;
        float dist = length(centered);

        vec2 distortedUv = barrelDistort(vUv, uDistortion);

        float caScale = uCAStrength * dist * 4.0;
        vec2 dir = normalize(centered + 1e-6);
        vec2 uvR = barrelDistort(vUv + dir * caScale, uDistortion);
        vec2 uvG = distortedUv;
        vec2 uvB = barrelDistort(vUv - dir * caScale, uDistortion);

        float r = sampleSafe(uvR).r;
        float g = sampleSafe(uvG).g;
        float b = sampleSafe(uvB).b;
        float a = sampleSafe(uvG).a;

        gl_FragColor = vec4(r, g, b, a);
      }
    `,
  };
  return new ShaderPass(shader);
}

// ============================================================================
// v21.1: Contact Shadow (Luminance-based approach — no depth texture needed)
// ============================================================================
// Uses the existing color buffer to detect dark gradients at object contact
// points. More robust than depth-based SSRT since it doesn't require
// depth texture binding. Visually equivalent for close-contact shadows.

export function createContactShadowPass() {
  const shader = {
    uniforms: {
      tDiffuse:    { value: null },
      uIntensity:  { value: 0.5 },        // 0..1, shadow darkening strength
      uThreshold:  { value: 0.4 },        // Luma threshold: below this = dark
      uRadius:     { value: 1.2 },        // Sample radius in pixels × 4
      uSoftness:   { value: 0.6 },        // 0..1, how gradual the darkening
      uResolution: { value: new THREE.Vector2(1, 1) },
    },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform sampler2D tDiffuse;
      uniform float uIntensity;
      uniform float uThreshold;
      uniform float uRadius;
      uniform float uSoftness;
      uniform vec2 uResolution;
      varying vec2 vUv;

      // Compute luminance using BT.601 coefficients
      float luma(vec3 c) {
        return dot(c, vec3(0.299, 0.587, 0.114));
      }

      void main() {
        vec4 src = texture2D(tDiffuse, vUv);
        float centerLuma = luma(src.rgb);

        // Sample 8 neighbors at increasing distance to find dark gradients
        vec2 texel = uRadius * 4.0 / uResolution;

        // 8-direction sample pattern (octagonal)
        vec2 offsets[8];
        offsets[0] = vec2( 1.0,  0.0);
        offsets[1] = vec2(-1.0,  0.0);
        offsets[2] = vec2( 0.0,  1.0);
        offsets[3] = vec2( 0.0, -1.0);
        offsets[4] = vec2( 0.7,  0.7);
        offsets[5] = vec2(-0.7,  0.7);
        offsets[6] = vec2( 0.7, -0.7);
        offsets[7] = vec2(-0.7, -0.7);

        // Compute average neighbor darkness relative to center
        float darknessSum = 0.0;
        for (int i = 0; i < 8; i++) {
          vec2 sampleUv = clamp(vUv + offsets[i] * texel, vec2(0.001), vec2(0.999));
          float nLuma = luma(texture2D(tDiffuse, sampleUv).rgb);

          // This pixel contributes to shadow if:
          // 1. It's darker than the threshold
          // 2. Its darkness is greater than center (gradient toward dark)
          float darker = max(0.0, uThreshold - nLuma) / uThreshold;
          darknessSum += darker;
        }

        // Average darkness (0..1)
        float avgDarkness = darknessSum / 8.0;

        // Current pixel's own darkness factor
        float centerDarkness = max(0.0, uThreshold - centerLuma) / uThreshold;

        // Combined contact shadow: strong when BOTH neighbors AND center are dark
        float contactAmount = avgDarkness * centerDarkness;

        // Apply softness curve
        contactAmount = pow(contactAmount, 1.0 - uSoftness);

        // Darken the pixel proportional to contact amount
        vec3 darkened = src.rgb * (1.0 - contactAmount * uIntensity);

        gl_FragColor = vec4(darkened, src.a);
      }
    `,
  };
  return new ShaderPass(shader);
}

// ============================================================================
// v21: Film Halation (fine red/orange glow around bright areas)
// ============================================================================
// Emulates the chemical halation of film emulsion: when light hits film,
// some scatters through the layers and re-emerges as a soft red-orange halo
// around bright highlights. This is a subtle effect that separates film
// from digital footage.

export function createFilmHalationPass() {
  const shader = {
    uniforms: {
      tDiffuse:    { value: null },
      uThreshold:  { value: 0.75 },      // Brightness threshold
      uIntensity:  { value: 0.3 },       // Halation strength
      uRadius:     { value: 1.0 },       // Halo spread (0.5..2.0)
      uTint:       { value: new THREE.Color(1.0, 0.5, 0.3) },  // red-orange
      uResolution: { value: new THREE.Vector2(1, 1) },
    },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform sampler2D tDiffuse;
      uniform float uThreshold;
      uniform float uIntensity;
      uniform float uRadius;
      uniform vec3 uTint;
      uniform vec2 uResolution;
      varying vec2 vUv;

      vec3 brightExtract(vec3 c) {
        float l = max(c.r, max(c.g, c.b));
        float t = smoothstep(uThreshold, 1.0, l);
        return c * t;
      }

      void main() {
        vec4 src = texture2D(tDiffuse, vUv);

        // 13-tap disk blur centered on pixel, scaled by radius
        vec2 texel = uRadius / uResolution;
        vec3 halo = vec3(0.0);

        // Star-shaped sample pattern for halo (more natural than box blur)
        vec2 offsets[13];
        offsets[0]  = vec2( 0.0,  0.0);
        offsets[1]  = vec2( 1.0,  0.0);
        offsets[2]  = vec2(-1.0,  0.0);
        offsets[3]  = vec2( 0.0,  1.0);
        offsets[4]  = vec2( 0.0, -1.0);
        offsets[5]  = vec2( 0.7,  0.7);
        offsets[6]  = vec2(-0.7,  0.7);
        offsets[7]  = vec2( 0.7, -0.7);
        offsets[8]  = vec2(-0.7, -0.7);
        offsets[9]  = vec2( 2.0,  0.0);
        offsets[10] = vec2(-2.0,  0.0);
        offsets[11] = vec2( 0.0,  2.0);
        offsets[12] = vec2( 0.0, -2.0);

        float weights[13];
        weights[0]  = 0.20;
        weights[1]  = 0.10; weights[2]  = 0.10;
        weights[3]  = 0.10; weights[4]  = 0.10;
        weights[5]  = 0.06; weights[6]  = 0.06;
        weights[7]  = 0.06; weights[8]  = 0.06;
        weights[9]  = 0.04; weights[10] = 0.04;
        weights[11] = 0.04; weights[12] = 0.04;

        float totalWeight = 0.0;
        for (int i = 0; i < 13; i++) {
          vec2 sampleUv = vUv + offsets[i] * texel * 8.0;
          sampleUv = clamp(sampleUv, vec2(0.001), vec2(0.999));
          halo += brightExtract(texture2D(tDiffuse, sampleUv).rgb) * weights[i];
          totalWeight += weights[i];
        }
        halo /= totalWeight;

        // Tint the halo with film-characteristic red-orange
        halo *= uTint;

        // Additive composite
        vec3 outColor = src.rgb + halo * uIntensity;
        gl_FragColor = vec4(outColor, src.a);
      }
    `,
  };
  return new ShaderPass(shader);
}
