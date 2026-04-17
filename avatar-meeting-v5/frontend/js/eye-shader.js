/**
 * @fileoverview v22 — Eye Enhancement (Caustic Refraction + Wet Surface).
 *
 * Enhances eye meshes to look alive via:
 *   1. Parallax-based cornea refraction (iris shifts with view angle)
 *   2. Wet surface Fresnel reflection (catchlights at grazing angles)
 *
 * CRITICAL: Uses in-place onBeforeCompile patching (same approach as
 * v19.2 Kajiya-Kay). NEVER creates a new material — preserves 100% of
 * the original material's properties (maps, transparency, etc).
 */

import * as THREE from 'three';

// ============================================================================
// GLSL shader chunks
// ============================================================================

const EYE_UNIFORMS_DECL = /* glsl */ `
  uniform float uEyeEnabled;         // 0.0 or 1.0 (master toggle)
  uniform float uCausticStrength;    // 0..1 parallax amount
  uniform float uCausticIOR;         // cornea IOR, typically 1.376
  uniform float uEyeWetness;         // 0..1, catchlight intensity
  uniform float uEyeReflectivity;    // 0..1, additional specular
  uniform vec3  uCatchlightTint;     // warm white, defaults vec3(1.0, 0.96, 0.92)
`;

const EYE_HELPERS = /* glsl */ `
  /**
   * Compute UV parallax from cornea refraction.
   * Uses Snell's law approximation for view-dependent iris shift.
   *
   * viewDir:     surface → camera direction (normalized, local space)
   * normalVec:   surface normal (normalized)
   * iorRatio:    n1/n2 (air/cornea ≈ 0.727)
   * virtDepth:   virtual thickness in UV units
   */
  vec2 corneaParallax(vec3 viewDir, vec3 normalVec, float iorRatio, float virtDepth) {
    // Refract view ray through virtual cornea
    vec3 refracted = refract(-viewDir, normalVec, iorRatio);
    // Check total internal reflection (very steep angles)
    if (dot(refracted, refracted) < 0.01) return vec2(0.0);
    // Project refracted direction's xy onto tangent plane for UV offset
    return refracted.xy * virtDepth;
  }
`;

// ============================================================================
// Eye material patching (in-place, like v19.2 Kajiya-Kay approach)
// ============================================================================

/**
 * Apply eye enhancement shader to an EXISTING eye material IN-PLACE.
 * Does NOT create a new material.
 *
 * @param {THREE.Material} material - The existing eye material
 * @returns {Object|null} Handle { material, params } or null if not applicable
 */
export function applyEyeShader(material) {
  if (!material) return null;

  // Skip if already patched
  if (material.userData && material.userData._eyePatched) {
    return material.userData._eyeHandle;
  }

  // Initialize userData if needed
  if (!material.userData) material.userData = {};

  // Store eye parameters
  material.userData.eyeParams = {
    enabled:         true,
    causticStrength: 0.5,
    causticIOR:      1.376,
    eyeWetness:      0.8,
    eyeReflectivity: 0.6,
    catchlightTint:  new THREE.Color(1.0, 0.96, 0.92),
  };

  // Enhance base material for wet eye look (these are safe property changes,
  // not structural — they don't break GLB transparency etc.)
  // Only do this for MeshPhysicalMaterial (has clearcoat support)
  if (material.isMeshPhysicalMaterial) {
    // Clearcoat = very thin glossy layer (tear film)
    if (typeof material.clearcoat === 'number') {
      material.clearcoat = Math.max(material.clearcoat, 1.0);
    }
    if (typeof material.clearcoatRoughness === 'number') {
      material.clearcoatRoughness = 0.05;  // very smooth tear film
    }
  }
  // Both standard and physical have these:
  if (typeof material.roughness === 'number') {
    material.roughness = Math.min(material.roughness, 0.2);
  }
  if (typeof material.envMapIntensity === 'number') {
    material.envMapIntensity = Math.max(material.envMapIntensity, 1.5);
  }

  // Diagnostic log
  console.log(
    `[Eye] Patching eye material: ` +
    `type=${material.type}, ` +
    `hasMap=${!!material.map}, ` +
    `isPhysical=${!!material.isMeshPhysicalMaterial}, ` +
    `transparent=${material.transparent}`
  );

  // Chain onBeforeCompile (preserve any existing hook)
  const previousOnBeforeCompile = material.onBeforeCompile;

  material.onBeforeCompile = (shader, renderer) => {
    // Run any previous hook first
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

    // Save shader ref for runtime uniform updates
    material.userData._eyeShader = shader;

    // Inject uniform declarations and helpers at top of fragment shader
    shader.fragmentShader = shader.fragmentShader.replace(
      'void main() {',
      EYE_UNIFORMS_DECL + '\n' + EYE_HELPERS + '\nvoid main() {'
    );

    // ========================================================================
    // Part 1: Caustic Refraction — modify UV for map_fragment
    // ========================================================================
    // The #include <map_fragment> standard chunk samples texture using vUv.
    // We replace it with a variant that uses parallax-shifted UV.
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <map_fragment>',
      /* glsl */ `
      // ★ v22: Caustic Refraction — virtual cornea lens parallax
      #ifdef USE_MAP
        vec2 eyeUv = vUv;
        if (uEyeEnabled > 0.5 && uCausticStrength > 0.001) {
          vec3 V_eye = normalize(vViewPosition);
          vec3 N_eye = normalize(normal);
          float iorRatio = 1.0 / max(1.001, uCausticIOR);
          float virtDepth = 0.008 * uCausticStrength;  // 8mm max virtual depth
          vec2 parallax = corneaParallax(V_eye, N_eye, iorRatio, virtDepth);
          eyeUv = clamp(vUv + parallax, vec2(0.001), vec2(0.999));
        }
        vec4 sampledDiffuseColor = texture2D(map, eyeUv);
        diffuseColor *= sampledDiffuseColor;
      #endif
      `
    );

    // ========================================================================
    // Part 2: Wet Eye Surface — Fresnel catchlight at end
    // ========================================================================
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <dithering_fragment>',
      /* glsl */ `
      // ★ v22: Wet eye Fresnel catchlight
      if (uEyeEnabled > 0.5) {
        vec3 V_eye2 = normalize(vViewPosition);
        vec3 N_eye2 = normalize(normal);
        float NdotV = max(0.0, dot(N_eye2, V_eye2));

        // Fresnel term: stronger at grazing angles (realistic wet surface)
        float fresnel = pow(1.0 - NdotV, 3.0);

        // Combined reflectivity * wetness
        float catchlight = fresnel * uEyeReflectivity * uEyeWetness;

        // Apply warm-white catchlight blend
        gl_FragColor.rgb = mix(gl_FragColor.rgb, uCatchlightTint, catchlight * 0.20);
      }
      #include <dithering_fragment>
      `
    );
  };

  // Mark as patched
  material.userData._eyePatched = true;
  material.needsUpdate = true;

  const handle = { material, params: material.userData.eyeParams };
  material.userData._eyeHandle = handle;
  return handle;
}

/**
 * Update parameters on an already-patched eye material.
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

  // Push to live shader uniforms
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
