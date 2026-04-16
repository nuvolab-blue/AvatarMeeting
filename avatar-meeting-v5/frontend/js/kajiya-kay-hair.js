/**
 * @fileoverview v19 — Kajiya-Kay hair shading.
 *
 * Replaces v11's simple anisotropic shading with a true Kajiya-Kay
 * physically-motivated hair model:
 *
 *   - 2 specular lobes (R primary white, TT secondary tinted)
 *   - Each lobe with independent shift along tangent
 *   - Tangent direction inferred from per-fragment normal
 *
 * Implementation: monkey-patches MeshPhysicalMaterial via onBeforeCompile
 * to inject our specular calculation into the fragment shader. This
 * keeps full compatibility with envMap, shadows, etc.
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
    vec3 shiftedT = T + shift * N;
    return normalize(shiftedT);
  }
`;

// ============================================================================
// Material creation
// ============================================================================

export function makeKajiyaKayMaterial(sourceMaterial) {
  const m = new THREE.MeshPhysicalMaterial();

  // ========================================================================
  // v19.1: Complete property transfer from source material
  // ========================================================================

  // --- Base color & albedo ---
  if (sourceMaterial.color) m.color.copy(sourceMaterial.color);
  if (sourceMaterial.map) m.map = sourceMaterial.map;

  // --- Surface detail maps ---
  if (sourceMaterial.normalMap) {
    m.normalMap = sourceMaterial.normalMap;
    if (sourceMaterial.normalScale) m.normalScale.copy(sourceMaterial.normalScale);
  }
  if (sourceMaterial.aoMap) {
    m.aoMap = sourceMaterial.aoMap;
    m.aoMapIntensity = sourceMaterial.aoMapIntensity ?? 1.0;
  }
  if (sourceMaterial.alphaMap) m.alphaMap = sourceMaterial.alphaMap;

  // ★ v19.1: Transfer roughness/metalness maps (critical for correct shading)
  if (sourceMaterial.roughnessMap) m.roughnessMap = sourceMaterial.roughnessMap;
  if (sourceMaterial.metalnessMap) m.metalnessMap = sourceMaterial.metalnessMap;

  // ★ v19.1: Transfer emissive properties
  if (sourceMaterial.emissive) m.emissive.copy(sourceMaterial.emissive);
  if (sourceMaterial.emissiveMap) m.emissiveMap = sourceMaterial.emissiveMap;
  if (sourceMaterial.emissiveIntensity !== undefined) {
    m.emissiveIntensity = sourceMaterial.emissiveIntensity;
  }

  // --- Environment map ---
  if (sourceMaterial.envMap) m.envMap = sourceMaterial.envMap;

  // ========================================================================
  // ★ v19.1: Transparency / rendering-order settings (ROOT CAUSE of hair
  //          disappearing when custom avatars have alpha-tested hair strands)
  // ========================================================================
  m.transparent = sourceMaterial.transparent ?? false;
  m.opacity = sourceMaterial.opacity ?? 1.0;
  m.alphaTest = sourceMaterial.alphaTest ?? 0;

  // ★ v19.1: depthWrite — crucial for proper sorting of hair strands
  if (sourceMaterial.depthWrite !== undefined) {
    m.depthWrite = sourceMaterial.depthWrite;
  }
  if (sourceMaterial.depthTest !== undefined) {
    m.depthTest = sourceMaterial.depthTest;
  }

  // ★ v19.1: alphaToCoverage for MSAA-based transparency
  if (sourceMaterial.alphaToCoverage !== undefined) {
    m.alphaToCoverage = sourceMaterial.alphaToCoverage;
  }

  // ★ v19.1: Side rendering — many hair meshes use DoubleSide for see-through
  m.side = sourceMaterial.side ?? THREE.FrontSide;

  // ========================================================================
  // ★ v19.1: PBR values — prefer source values, only use defaults as fallback
  // ========================================================================
  if (m.roughnessMap) {
    m.roughness = sourceMaterial.roughness ?? 1.0;
  } else {
    m.roughness = sourceMaterial.roughness ?? 0.55;
  }

  if (m.metalnessMap) {
    m.metalness = sourceMaterial.metalness ?? 1.0;
  } else {
    m.metalness = sourceMaterial.metalness ?? 0.0;
  }

  m.envMapIntensity = sourceMaterial.envMapIntensity !== undefined
    ? sourceMaterial.envMapIntensity
    : 0.7;

  // ========================================================================
  // Kajiya-Kay runtime parameters (unchanged from v19)
  // ========================================================================
  m.userData.kkParams = {
    hairTint:          new THREE.Color(0x6b3a1a),
    primaryShift:      0.2,
    secondaryShift:   -0.3,
    primaryWidth:      0.18,
    secondaryWidth:    0.30,
    primaryStrength:   0.8,
    secondaryStrength: 0.45,
  };

  // Diagnostic log — helps debugging when hair disappears
  console.log(
    `[KK] Hair material: ` +
    `transparent=${m.transparent}, ` +
    `alphaTest=${m.alphaTest}, ` +
    `opacity=${m.opacity}, ` +
    `depthWrite=${m.depthWrite}, ` +
    `side=${m.side}, ` +
    `hasMap=${!!m.map}, ` +
    `hasAlphaMap=${!!m.alphaMap}, ` +
    `hasRoughnessMap=${!!m.roughnessMap}`
  );

  m.onBeforeCompile = (shader) => {
    const p = m.userData.kkParams;

    shader.uniforms.uHairTint          = { value: p.hairTint };
    shader.uniforms.uPrimaryShift      = { value: p.primaryShift };
    shader.uniforms.uSecondaryShift    = { value: p.secondaryShift };
    shader.uniforms.uPrimaryWidth      = { value: p.primaryWidth };
    shader.uniforms.uSecondaryWidth    = { value: p.secondaryWidth };
    shader.uniforms.uPrimaryStrength   = { value: p.primaryStrength };
    shader.uniforms.uSecondaryStrength = { value: p.secondaryStrength };

    m.userData.kkShader = shader;

    shader.fragmentShader = shader.fragmentShader.replace(
      'void main() {',
      KAJIYA_UNIFORMS_DECL + '\n' + KAJIYA_HELPERS + '\nvoid main() {'
    );

    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <dithering_fragment>',
      /* glsl */ `
      // ============================================================
      // v19: Kajiya-Kay hair specular contribution
      // ============================================================
      {
        vec3 N_kk = normalize(normal);
        vec3 V_kk = normalize(vViewPosition);

        vec3 worldUp_kk = abs(N_kk.y) < 0.95 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
        vec3 T_kk = normalize(cross(N_kk, cross(worldUp_kk, N_kk)));

        vec3 kkSpec = vec3(0.0);

        #if (NUM_DIR_LIGHTS > 0)
          #pragma unroll_loop_start
          for (int i = 0; i < NUM_DIR_LIGHTS; i++) {
            vec3 L_kk = normalize(directionalLights[ i ].direction);
            vec3 H_kk = normalize(L_kk + V_kk);

            vec3 T_R = shiftTangent(T_kk, N_kk, uPrimaryShift);
            float r_lobe = kajiyaKayLobe(T_R, H_kk, uPrimaryWidth);

            vec3 T_TT = shiftTangent(T_kk, N_kk, uSecondaryShift);
            float tt_lobe = kajiyaKayLobe(T_TT, H_kk, uSecondaryWidth);

            float NdotL = max(0.0, dot(N_kk, L_kk));
            vec3 lightCol = directionalLights[ i ].color;

            kkSpec += lightCol * NdotL * (
              uPrimaryStrength   * r_lobe  * vec3(1.0) +
              uSecondaryStrength * tt_lobe * uHairTint
            );
          }
          #pragma unroll_loop_end
        #endif

        gl_FragColor.rgb += kkSpec;
      }
      #include <dithering_fragment>
      `
    );
  };

  m.needsUpdate = true;
  return m;
}

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
