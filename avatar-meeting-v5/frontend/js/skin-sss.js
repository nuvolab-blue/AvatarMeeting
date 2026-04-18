/**
 * @fileoverview v23 — Improved Subsurface Scattering for skin.
 *
 * Enhances skin materials with a Fresnel-based subsurface scattering
 * approximation, simulating light transmission through thin skin areas
 * (ears, nose, lips) as reddish translucency.
 *
 * Approach: in-place onBeforeCompile patching (non-destructive).
 * All SSS appearance is generated in-shader via uniforms.
 * Compatible with the existing sheen+clearcoat base skin material.
 *
 * Reference: Jimenez et al. 2015 "Separable Subsurface Scattering"
 * (adapted for per-material shader injection instead of post-process).
 */

import * as THREE from 'three';

// ============================================================================
// GLSL chunks
// ============================================================================

const SSS_UNIFORMS_DECL = /* glsl */ `
  uniform float uSSSEnabled;         // 0.0 or 1.0 master toggle
  uniform float uSSSStrength;        // 0..1 overall intensity
  uniform vec3  uSSSColor;           // subsurface tint (typically warm red)
  uniform float uSSSDistortion;      // 0..1 normal distortion for SSS
  uniform float uSSSAmbient;         // 0..0.3 ambient SSS floor
  uniform float uSSSPower;           // 1..4 falloff sharpness
  uniform float uSSSThinness;        // 0..1 how much to weight grazing angles
`;

const SSS_HELPERS = /* glsl */ `
  // Compute SSS contribution for a single directional light.
  vec3 computeSSSLight(vec3 L_dir, vec3 V_dir, vec3 N_surf, vec3 lightColor) {
    // Distort light direction by surface normal (wraps SSS around edges)
    vec3 L_distorted = normalize(L_dir + N_surf * uSSSDistortion);

    // View-dependent term — stronger when viewing through the surface
    float VdotL = max(0.0, dot(V_dir, -L_distorted));
    float sss = pow(VdotL, uSSSPower);

    // Ambient floor (always-present soft glow)
    sss = sss + uSSSAmbient;

    // Grazing angle emphasis (thin areas glow more)
    float thinness = 1.0 - abs(dot(V_dir, N_surf));
    sss *= mix(1.0, thinness, uSSSThinness);

    return sss * lightColor * uSSSColor * uSSSStrength;
  }
`;

// ============================================================================
// Skin SSS patching (non-destructive)
// ============================================================================

export function applySSSShader(material) {
  if (!material) return null;

  if (material.userData && material.userData._sssPatched) {
    return material.userData._sssHandle;
  }

  if (!material.userData) material.userData = {};

  material.userData.sssParams = {
    enabled:    true,
    strength:   0.35,
    distortion: 0.25,
    ambient:    0.10,
    power:      2.0,
    thinness:   0.60,
    color:      new THREE.Color(1.0, 0.45, 0.35),  // warm red (blood)
  };

  console.log(
    `[SSS] Patching skin material: ` +
    `name="${material.name || '(unnamed)'}", ` +
    `type=${material.type}`
  );

  const previousOnBeforeCompile = material.onBeforeCompile;

  material.onBeforeCompile = (shader, renderer) => {
    if (previousOnBeforeCompile) {
      previousOnBeforeCompile.call(material, shader, renderer);
    }

    const p = material.userData.sssParams;

    shader.uniforms.uSSSEnabled    = { value: p.enabled ? 1.0 : 0.0 };
    shader.uniforms.uSSSStrength   = { value: p.strength };
    shader.uniforms.uSSSColor      = { value: p.color };
    shader.uniforms.uSSSDistortion = { value: p.distortion };
    shader.uniforms.uSSSAmbient    = { value: p.ambient };
    shader.uniforms.uSSSPower      = { value: p.power };
    shader.uniforms.uSSSThinness   = { value: p.thinness };

    material.userData._sssShader = shader;

    // Inject decls + helpers at top of fragment main()
    shader.fragmentShader = shader.fragmentShader.replace(
      'void main() {',
      SSS_UNIFORMS_DECL + '\n' + SSS_HELPERS + '\nvoid main() {'
    );

    // Inject SSS accumulation before dithering_fragment.
    // At this point in main(), `normal` (local) and `vViewPosition` are both defined.
    if (shader.fragmentShader.includes('#include <dithering_fragment>')) {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <dithering_fragment>',
        /* glsl */ `
        // ★ v23: Subsurface Scattering accumulation
        if (uSSSEnabled > 0.5) {
          vec3 V_sss = normalize(vViewPosition);
          vec3 N_sss = normalize(normal);
          vec3 sssAccum = vec3(0.0);

          #if (NUM_DIR_LIGHTS > 0)
            for (int sss_i = 0; sss_i < NUM_DIR_LIGHTS; sss_i++) {
              vec3 L_sss = normalize(directionalLights[ sss_i ].direction);
              vec3 lightCol = directionalLights[ sss_i ].color;
              sssAccum += computeSSSLight(L_sss, V_sss, N_sss, lightCol);
            }
          #endif

          // Additive with headroom clamp (prevent over-brightening)
          vec3 headroom_sss = max(vec3(0.0), 1.0 - gl_FragColor.rgb);
          gl_FragColor.rgb += sssAccum * headroom_sss;
        }
        #include <dithering_fragment>
        `
      );
    } else {
      console.warn('[SSS] dithering_fragment chunk not found, skipping SSS injection');
    }
  };

  material.userData._sssPatched = true;
  material.needsUpdate = true;

  const handle = { material, params: material.userData.sssParams };
  material.userData._sssHandle = handle;
  return handle;
}

export function updateSSSParams(mat, updates) {
  if (!mat || !mat.userData || !mat.userData.sssParams) return;
  const p = mat.userData.sssParams;

  for (const [key, val] of Object.entries(updates)) {
    if (key === 'color' && val) {
      p.color.copy(val);
    } else if (key === 'enabled') {
      p.enabled = !!val;
    } else if (typeof val === 'number') {
      p[key] = val;
    }
  }

  const sh = mat.userData._sssShader;
  if (sh && sh.uniforms) {
    if (sh.uniforms.uSSSEnabled)    sh.uniforms.uSSSEnabled.value    = p.enabled ? 1.0 : 0.0;
    if (sh.uniforms.uSSSStrength)   sh.uniforms.uSSSStrength.value   = p.strength;
    if (sh.uniforms.uSSSColor)      sh.uniforms.uSSSColor.value      = p.color;
    if (sh.uniforms.uSSSDistortion) sh.uniforms.uSSSDistortion.value = p.distortion;
    if (sh.uniforms.uSSSAmbient)    sh.uniforms.uSSSAmbient.value    = p.ambient;
    if (sh.uniforms.uSSSPower)      sh.uniforms.uSSSPower.value      = p.power;
    if (sh.uniforms.uSSSThinness)   sh.uniforms.uSSSThinness.value   = p.thinness;
  }
}

export function removeSSSShader(material) {
  if (!material || !material.userData || !material.userData._sssPatched) return;
  material.onBeforeCompile = () => {};
  delete material.userData.sssParams;
  delete material.userData._sssShader;
  delete material.userData._sssHandle;
  delete material.userData._sssPatched;
  material.needsUpdate = true;
}
