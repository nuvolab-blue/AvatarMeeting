/**
 * @fileoverview Cinematic lighting presets.
 *
 * 5 classic cinematography lighting setups. Each preset specifies color,
 * intensity, and position for the 4-light setup (key, fill, rim, hemi).
 *
 * Application is non-destructive: existing Light objects are reused;
 * only their properties are mutated. This preserves shadow setup,
 * scene references, and avoids GC churn.
 */

export const LIGHTING_PRESETS = {
  beauty: {
    name: 'Beauty (標準)',
    description: 'バランス重視。インタビューやCMの定番',
    key:  { color: 0xfff4e6, intensity: 1.5, position: { x: 2, y: 3, z: 4 } },
    fill: { color: 0xc8d8ff, intensity: 0.5, position: { x: -2, y: 1.5, z: 3 } },
    rim:  { color: 0xffffff, intensity: 1.5, position: { x: 0, y: 2, z: -3 } },
    hemi: { skyColor: 0xb1d4ff, groundColor: 0xb89878, intensity: 0.4 },
    toneMappingExposure: 1.0,
  },

  rembrandt: {
    name: 'Rembrandt (ドラマチック)',
    description: '片頬に三角の影。シリアスな場面に',
    key:  { color: 0xffe4b5, intensity: 2.5, position: { x: 2.5, y: 3.5, z: 2.0 } },
    fill: { color: 0x6080a0, intensity: 0.10, position: { x: -2, y: 1, z: 2 } },
    rim:  { color: 0xfff0d0, intensity: 0.8, position: { x: -1.5, y: 2.5, z: -3 } },
    hemi: { skyColor: 0x4060a0, groundColor: 0x402010, intensity: 0.10 },
    toneMappingExposure: 0.85,
  },

  highKey: {
    name: 'High-Key (明朗)',
    description: '全体明るくフラット。コメディ・CM向け',
    key:  { color: 0xffffff, intensity: 1.8, position: { x: 1, y: 2.5, z: 4 } },
    fill: { color: 0xfafafa, intensity: 1.4, position: { x: -2, y: 2, z: 3 } },
    rim:  { color: 0xffffff, intensity: 0.6, position: { x: 0, y: 2, z: -3 } },
    hemi: { skyColor: 0xffffff, groundColor: 0xeaeaea, intensity: 0.8 },
    toneMappingExposure: 1.15,
  },

  lowKey: {
    name: 'Low-Key (ノワール)',
    description: '暗背景+強い縁光。サスペンス・ミステリー',
    key:  { color: 0xffd699, intensity: 0.8, position: { x: 2, y: 4.5, z: 1.5 } },
    fill: { color: 0x101020, intensity: 0.05, position: { x: -2, y: 1, z: 2 } },
    rim:  { color: 0x6090ff, intensity: 3.0, position: { x: -1, y: 2, z: -3.5 } },
    hemi: { skyColor: 0x202040, groundColor: 0x100808, intensity: 0.05 },
    toneMappingExposure: 0.75,
  },

  magicHour: {
    name: 'Magic Hour (黄昏)',
    description: '暖色キー + 寒色フィル。夕暮れの詩情',
    key:  { color: 0xffa040, intensity: 2.2, position: { x: 3.5, y: 1.5, z: 2.5 } },
    fill: { color: 0x5070b0, intensity: 0.8, position: { x: -2, y: 2, z: 2 } },
    rim:  { color: 0xff9050, intensity: 2.5, position: { x: -0.5, y: 1, z: -3 } },
    hemi: { skyColor: 0xffaa66, groundColor: 0x4060a0, intensity: 0.5 },
    toneMappingExposure: 1.0,
  },
};

/**
 * Mutate the 4 existing light objects in-place to match a preset.
 * @param {string} presetKey
 * @param {{key, fill, rim, hemi}} lights - existing Light references
 * @param {THREE.WebGLRenderer} renderer
 * @returns {boolean}
 */
export function applyLightingPreset(presetKey, lights, renderer) {
  const preset = LIGHTING_PRESETS[presetKey];
  if (!preset) {
    console.warn(`[Lighting] Unknown preset: ${presetKey}`);
    return false;
  }

  if (lights.key) {
    lights.key.color.setHex(preset.key.color);
    lights.key.intensity = preset.key.intensity;
    lights.key.position.set(preset.key.position.x, preset.key.position.y, preset.key.position.z);
  }
  if (lights.fill) {
    lights.fill.color.setHex(preset.fill.color);
    lights.fill.intensity = preset.fill.intensity;
    lights.fill.position.set(preset.fill.position.x, preset.fill.position.y, preset.fill.position.z);
  }
  if (lights.rim) {
    lights.rim.color.setHex(preset.rim.color);
    lights.rim.intensity = preset.rim.intensity;
    lights.rim.position.set(preset.rim.position.x, preset.rim.position.y, preset.rim.position.z);
  }
  if (lights.hemi) {
    lights.hemi.color.setHex(preset.hemi.skyColor);
    lights.hemi.groundColor.setHex(preset.hemi.groundColor);
    lights.hemi.intensity = preset.hemi.intensity;
  }

  if (renderer && preset.toneMappingExposure !== undefined) {
    renderer.toneMappingExposure = preset.toneMappingExposure;
  }

  console.log(`[Lighting] Applied preset: ${preset.name}`);
  return true;
}
