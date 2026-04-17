/**
 * @fileoverview v22.1 — Eye Enhancement (non-destructive, safe approach).
 *
 * CRITICAL FIX from v22:
 *   - NO destructive material property changes (clearcoat, roughness, etc.)
 *   - All visual effects are generated IN-SHADER via uniforms
 *   - ON/OFF toggle now actually works (pure uniform control)
 *   - Original material is 100% preserved
 *
 * Approach: in-place onBeforeCompile patch with shader-only effects.
 * Parallax refraction for UV shift + Fresnel-based wet highlight overlay.
 * No base material property mutation whatsoever.
 */

import * as THREE from 'three';

// ============================================================================
// GLSL chunks
// ============================================================================

const EYE_UNIFORMS_DECL = /* glsl */ `
  uniform float uEyeEnabled;
  uniform float uCausticStrength;
  uniform float uCausticIOR;
  uniform float uEyeWetness;
  uniform float uEyeReflectivity;
  uniform vec3  uCatchlightTint;
`;

const EYE_HELPERS = /* glsl */ `
  // Parallax UV shift simulating cornea refraction
  vec2 corneaParallax(vec3 viewDir, vec3 normalVec, float iorRatio, float virtDepth) {
    vec3 refracted = refract(-viewDir, normalVec, iorRatio);
    if (dot(refracted, refracted) < 0.01) return vec2(0.0);
    return refracted.xy * virtDepth;
  }
`;

// ============================================================================
// Eye shader patching (non-destructive)
// ============================================================================

export function applyEyeShader(material) {
  if (!material) return null;

  // Skip if already patched
  if (material.userData && material.userData._eyePatched) {
    return material.userData._eyeHandle;
  }

  if (!material.userData) material.userData = {};

  // Store eye parameters (uniforms only, no material mutation)
  material.userData.eyeParams = {
    enabled:         true,
    causticStrength: 0.5,
    causticIOR:      1.376,
    eyeWetness:      0.8,
    eyeReflectivity: 0.6,
    catchlightTint:  new THREE.Color(1.0, 0.96, 0.92),
  };

  // ========================================================================
  // ★ v22.1 CRITICAL: NO base material property changes.
  // We do NOT touch:
  //   - material.clearcoat
  //   - material.clearcoatRoughness
  //   - material.roughness
  //   - material.envMapIntensity
  //   - material.metalness
  //   - any other PBR property
  // All wet-eye appearance is generated IN-SHADER via the uniforms above.
  // This guarantees ON/OFF toggle works and OFF restores original look.
  // ========================================================================

  // Diagnostic log
  console.log(
    `[Eye v22.1] Patching (non-destructive): ` +
    `name="${material.name || '(unnamed)'}", ` +
    `type=${material.type}, ` +
    `hasMap=${!!material.map}`
  );

  // Chain onBeforeCompile (preserve any existing hook)
  const previousOnBeforeCompile = material.onBeforeCompile;

  material.onBeforeCompile = (shader, renderer) => {
    if (previousOnBeforeCompile) {
      previousOnBeforeCompile.call(material, shader, renderer);
    }

    const p = material.userData.eyeParams;

    // Register uniforms
    shader.uniforms.uEyeEnabled       = { value: p.enabled ? 1.0 : 0.0 };
    shader.uniforms.uCausticStrength  = { value: p.causticStrength };
    shader.uniforms.uCausticIOR       = { value: p.causticIOR };
    shader.uniforms.uEyeWetness       = { value: p.eyeWetness };
    shader.uniforms.uEyeReflectivity  = { value: p.eyeReflectivity };
    shader.uniforms.uCatchlightTint   = { value: p.catchlightTint };

    material.userData._eyeShader = shader;

    // Inject uniform decls + helpers
    shader.fragmentShader = shader.fragmentShader.replace(
      'void main() {',
      EYE_UNIFORMS_DECL + '\n' + EYE_HELPERS + '\nvoid main() {'
    );

    // ========================================================================
    // Part 1: Caustic Refraction (UV shift for map_fragment)
    // Only active when uEyeEnabled > 0.5 AND uCausticStrength > 0
    // ========================================================================
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <map_fragment>',
      /* glsl */ `
      #ifdef USE_MAP
        vec2 eyeUv = vUv;
        if (uEyeEnabled > 0.5 && uCausticStrength > 0.001) {
          vec3 V_eye = normalize(vViewPosition);
          vec3 N_eye = normalize(normal);
          float iorRatio = 1.0 / max(1.001, uCausticIOR);
          float virtDepth = 0.008 * uCausticStrength;
          vec2 parallax = corneaParallax(V_eye, N_eye, iorRatio, virtDepth);
          eyeUv = clamp(vUv + parallax, vec2(0.001), vec2(0.999));
        }
        vec4 sampledDiffuseColor = texture2D(map, eyeUv);
        diffuseColor *= sampledDiffuseColor;
      #endif
      `
    );

    // ========================================================================
    // Part 2: Fresnel wet surface (additive catchlight, subtle)
    // Only active when uEyeEnabled > 0.5. When OFF, zero contribution.
    // ========================================================================
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <dithering_fragment>',
      /* glsl */ `
      // ★ v22.1: Non-destructive Fresnel catchlight (additive only)
      if (uEyeEnabled > 0.5) {
        vec3 V_wet = normalize(vViewPosition);
        vec3 N_wet = normalize(normal);
        float NdotV = max(0.0, dot(N_wet, V_wet));

        // Fresnel — stronger at grazing angles
        float fresnel = pow(1.0 - NdotV, 3.0);
        float catchAmount = fresnel * uEyeReflectivity * uEyeWetness;

        // Add soft catchlight (mix-based to avoid over-brightening)
        // Strength capped at 0.15 to prevent full whiteout
        gl_FragColor.rgb = mix(
          gl_FragColor.rgb,
          uCatchlightTint,
          catchAmount * 0.15
        );
      }
      #include <dithering_fragment>
      `
    );
  };

  material.userData._eyePatched = true;
  material.needsUpdate = true;

  const handle = { material, params: material.userData.eyeParams };
  material.userData._eyeHandle = handle;
  return handle;
}

/**
 * Remove eye shader from a material. Restores original rendering.
 * @param {THREE.Material} material
 */
export function removeEyeShader(material) {
  if (!material || !material.userData || !material.userData._eyePatched) return;

  // Clear onBeforeCompile to restore default rendering
  material.onBeforeCompile = () => {};

  delete material.userData.eyeParams;
  delete material.userData._eyeShader;
  delete material.userData._eyeHandle;
  delete material.userData._eyePatched;

  material.needsUpdate = true;
}

/**
 * Update parameters on a patched eye material.
 * @param {THREE.Material} mat
 * @param {Object} updates
 */
export function updateEyeParams(mat, updates) {
  if (!mat || !mat.userData || !mat.userData.eyeParams) return;
  const p = mat.userData.eyeParams;

  for (const [key, val] of Object.entries(updates)) {
    if (key === 'catchlightTint' && val) {
      p.catchlightTint.copy(val);
    } else if (key === 'enabled') {
      p.enabled = !!val;
    } else if (typeof val === 'number') {
      p[key] = val;
    }
  }

  const sh = mat.userData._eyeShader;
  if (sh && sh.uniforms) {
    if (sh.uniforms.uEyeEnabled)       sh.uniforms.uEyeEnabled.value       = p.enabled ? 1.0 : 0.0;
    if (sh.uniforms.uCausticStrength)  sh.uniforms.uCausticStrength.value  = p.causticStrength;
    if (sh.uniforms.uCausticIOR)       sh.uniforms.uCausticIOR.value       = p.causticIOR;
    if (sh.uniforms.uEyeWetness)       sh.uniforms.uEyeWetness.value       = p.eyeWetness;
    if (sh.uniforms.uEyeReflectivity)  sh.uniforms.uEyeReflectivity.value  = p.eyeReflectivity;
    if (sh.uniforms.uCatchlightTint)   sh.uniforms.uCatchlightTint.value   = p.catchlightTint;
  }
}
