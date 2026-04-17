/**
 * @fileoverview v19.2 — Kajiya-Kay hair shading (in-place patch approach).
 *
 * CRITICAL FIX: v19/v19.1 created a NEW MeshPhysicalMaterial and copied
 * properties manually, which caused hair to disappear on custom avatars
 * because dozens of material properties (depthWrite, alphaToCoverage,
 * blending, etc.) were not fully transferred.
 *
 * v19.2 approach: NEVER create a new material. Instead, patch the EXISTING
 * material's onBeforeCompile to inject KK specular. This guarantees 100%
 * property preservation because we never replace the material object.
 */

import * as THREE from 'three';

// ============================================================================
// GLSL chunks
// ============================================================================

const KAJIYA_UNIFORMS_DECL = /* glsl */ `
  uniform vec3  uHairTint;
  uniform float uPrimaryShift;
  uniform float uSecondaryShift;
  uniform float uPrimaryWidth;
  uniform float uSecondaryWidth;
  uniform float uPrimaryStrength;
  uniform float uSecondaryStrength;
`;

const KAJIYA_HELPERS = /* glsl */ `
  float kajiyaKayLobe(vec3 T, vec3 H, float width) {
    float TdotH = dot(T, H);
    float sinTH = sqrt(max(0.0, 1.0 - TdotH * TdotH));
    float dirAtten = smoothstep(-1.0, 0.0, TdotH);
    return dirAtten * pow(sinTH, 1.0 / max(0.05, width));
  }

  vec3 shiftTangent(vec3 T, vec3 N, float shift) {
    return normalize(T + shift * N);
  }
`;

const KAJIYA_MAIN_CODE = /* glsl */ `
      // ============================================================
      // v19.3: Kajiya-Kay hair specular (with soft-clip to prevent blow-out)
      // NOTE: plain GLSL for-loop (not #pragma unroll_loop_start) — retained
      // from v19.2 fix to avoid variable redefinition errors during unrolling.
      // ============================================================
      {
        vec3 N_kk = normalize(normal);
        vec3 V_kk = normalize(vViewPosition);

        vec3 worldUp_kk = abs(N_kk.y) < 0.95 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
        vec3 T_kk = normalize(cross(N_kk, cross(worldUp_kk, N_kk)));

        vec3 kkSpec = vec3(0.0);

        #if (NUM_DIR_LIGHTS > 0)
          for (int kk_i = 0; kk_i < NUM_DIR_LIGHTS; kk_i++) {
            vec3 L_kk = normalize(directionalLights[ kk_i ].direction);
            vec3 H_kk = normalize(L_kk + V_kk);

            vec3 T_R = shiftTangent(T_kk, N_kk, uPrimaryShift);
            float r_lobe = kajiyaKayLobe(T_R, H_kk, uPrimaryWidth);

            vec3 T_TT = shiftTangent(T_kk, N_kk, uSecondaryShift);
            float tt_lobe = kajiyaKayLobe(T_TT, H_kk, uSecondaryWidth);

            float NdotL = max(0.0, dot(N_kk, L_kk));
            vec3 lightCol = directionalLights[ kk_i ].color;

            kkSpec += lightCol * NdotL * (
              uPrimaryStrength   * r_lobe  * vec3(1.0) +
              uSecondaryStrength * tt_lobe * uHairTint
            );
          }
        #endif

        // ★ v19.4: Dual modulation for physically correct hair highlights.
        // (1) Headroom prevents blow-out on already-bright pixels.
        // (2) Hair darkness modulation suppresses highlights on dark hair
        //     (Energy Conservation: black hair absorbs more light, so
        //      should reflect less — matches ILM/Pixar hair shader behavior).
        vec3 headroom = max(vec3(0.0), 1.0 - gl_FragColor.rgb);

        // Compute hair luminance (how bright the base color is, 0..1)
        float hairLuma = dot(gl_FragColor.rgb, vec3(0.299, 0.587, 0.114));

        // Dark hair → strong suppression (25% at pure black),
        // light hair → full reflection (100% at white).
        // Quadratic curve smooths the transition.
        float darkness = 1.0 - hairLuma;
        float kkModulation = mix(1.0, 0.25, darkness * darkness);

        // Combine headroom × darkness modulation
        vec3 safeKK = kkSpec * headroom * kkModulation;

        // Apply the doubly-limited highlight
        gl_FragColor.rgb += safeKK;
      }
      #include <dithering_fragment>
`;

// ============================================================================
// In-place KK shader injection
// ============================================================================

/**
 * Apply Kajiya-Kay shader extension to an EXISTING material IN-PLACE.
 * Does NOT create a new material — the original material object is preserved
 * with ALL its properties (transparent, depthWrite, alphaTest, maps, etc.).
 *
 * Safe to call on MeshStandardMaterial or MeshPhysicalMaterial.
 *
 * @param {THREE.Material} material - The existing hair material to patch
 */
export function applyKajiyaKayShader(material) {
  // Skip if already patched
  if (material.userData._kkPatched) return;

  // Store KK parameters (v19.3: subtler defaults for natural look)
  material.userData.kkParams = {
    hairTint:          new THREE.Color(0x3a2015),  // darker warm brown (was 0x6b3a1a)
    primaryShift:      0.15,                        // (was 0.2)
    secondaryShift:   -0.25,                        // (was -0.3)
    primaryWidth:      0.12,                        // tighter (was 0.18)
    secondaryWidth:    0.22,                        // tighter (was 0.30)
    primaryStrength:   0.5,                         // weaker (was 0.8)
    secondaryStrength: 0.25,                        // weaker (was 0.45)
  };

  // Diagnostic log
  console.log(
    `[KK] Patching hair material in-place: ` +
    `type=${material.type}, ` +
    `transparent=${material.transparent}, ` +
    `alphaTest=${material.alphaTest}, ` +
    `depthWrite=${material.depthWrite}, ` +
    `hasMap=${!!material.map}, ` +
    `hasAlphaMap=${!!material.alphaMap}`
  );

  // Patch onBeforeCompile — chain with any existing hook
  const originalOnBeforeCompile = material.onBeforeCompile;

  material.onBeforeCompile = (shader, renderer) => {
    // Call original onBeforeCompile if it existed
    if (originalOnBeforeCompile) {
      originalOnBeforeCompile.call(material, shader, renderer);
    }

    const p = material.userData.kkParams;

    // Register uniforms
    shader.uniforms.uHairTint          = { value: p.hairTint };
    shader.uniforms.uPrimaryShift      = { value: p.primaryShift };
    shader.uniforms.uSecondaryShift    = { value: p.secondaryShift };
    shader.uniforms.uPrimaryWidth      = { value: p.primaryWidth };
    shader.uniforms.uSecondaryWidth    = { value: p.secondaryWidth };
    shader.uniforms.uPrimaryStrength   = { value: p.primaryStrength };
    shader.uniforms.uSecondaryStrength = { value: p.secondaryStrength };

    // Save shader reference for runtime updates
    material.userData.kkShader = shader;

    // Inject uniform declarations + helper functions
    shader.fragmentShader = shader.fragmentShader.replace(
      'void main() {',
      KAJIYA_UNIFORMS_DECL + '\n' + KAJIYA_HELPERS + '\nvoid main() {'
    );

    // Inject KK specular at dithering point (end of fragment shader)
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <dithering_fragment>',
      KAJIYA_MAIN_CODE
    );
  };

  // Mark as patched to prevent double-application
  material.userData._kkPatched = true;

  // Force recompilation with the new onBeforeCompile
  material.needsUpdate = true;
}

/**
 * Remove KK shader from a material (restore original behavior).
 *
 * @param {THREE.Material} material
 */
export function removeKajiyaKayShader(material) {
  if (!material || !material.userData._kkPatched) return;

  // Reset onBeforeCompile to empty (forces recompile without KK)
  material.onBeforeCompile = () => {};

  // Clean up userData
  delete material.userData.kkParams;
  delete material.userData.kkShader;
  delete material.userData._kkPatched;

  // Force recompilation without KK
  material.needsUpdate = true;
}

/**
 * Update KK uniforms on a patched material.
 * @param {THREE.Material} mat
 * @param {Object} updates
 */
export function updateKajiyaKayParams(mat, updates) {
  if (!mat || !mat.userData || !mat.userData.kkParams) return;
  const p = mat.userData.kkParams;
  for (const [k, v] of Object.entries(updates)) {
    if (k === 'hairTint' && v) {
      p.hairTint.copy(v);
    } else if (typeof v === 'number') {
      p[k] = v;
    }
  }

  const sh = mat.userData.kkShader;
  if (sh && sh.uniforms) {
    if (sh.uniforms.uHairTint)          sh.uniforms.uHairTint.value = p.hairTint;
    if (sh.uniforms.uPrimaryShift)      sh.uniforms.uPrimaryShift.value = p.primaryShift;
    if (sh.uniforms.uSecondaryShift)    sh.uniforms.uSecondaryShift.value = p.secondaryShift;
    if (sh.uniforms.uPrimaryWidth)      sh.uniforms.uPrimaryWidth.value = p.primaryWidth;
    if (sh.uniforms.uSecondaryWidth)    sh.uniforms.uSecondaryWidth.value = p.secondaryWidth;
    if (sh.uniforms.uPrimaryStrength)   sh.uniforms.uPrimaryStrength.value = p.primaryStrength;
    if (sh.uniforms.uSecondaryStrength) sh.uniforms.uSecondaryStrength.value = p.secondaryStrength;
  }
}
