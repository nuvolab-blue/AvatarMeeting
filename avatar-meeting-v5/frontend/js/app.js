/**
 * @fileoverview Main application controller for Avatar Meeting Studio v5.
 *
 * Orchestrates:
 *   - AvatarScene (Three.js 3D rendering)
 *   - FaceTracker (MediaPipe Face Landmarker)
 *   - VirtualCamera (canvas captureStream)
 *
 * Main loop runs at display refresh rate via requestAnimationFrame.
 * Each frame reads the latest FaceTracker results and passes them
 * to AvatarScene.update() for rendering.
 */

import { FaceTracker } from './face-tracker.js';
import { PoseTracker } from './pose-tracker.js';
import { AvatarScene } from './avatar-scene.js';
import { VirtualCamera } from './virtual-camera.js';

// ===== v18.1: Slider value formatters =====
function formatFixed(v, digits = 2) {
  return Number(v).toFixed(digits);
}
function formatSigned(v, digits = 2) {
  const n = Number(v);
  return (n >= 0 ? '+' : '') + n.toFixed(digits);
}
function setValDisplay(id, formatted) {
  const el = document.getElementById(id);
  if (el) el.textContent = formatted;
}

class App {
  constructor() {
    /** @type {AvatarScene|null} */
    this.scene = null;
    /** @type {FaceTracker|null} */
    this.tracker = null;
    /** @type {VirtualCamera|null} */
    this.vcam = null;
    /** @type {PoseTracker|null} */
    this.poseTracker = null;

    // FPS counter
    this._fpsFrames = 0;
    this._fpsTime = performance.now();
    this._fps = 0;
  }

  /** Initialize the application. */
  init() {
    // ----- DOM refs -----
    this._canvas = document.getElementById('avatar-canvas');
    this._urlInput = document.getElementById('avatar-url');
    this._loadBtn = document.getElementById('load-avatar');
    this._camBtn = document.getElementById('start-camera');
    this._vcamBtn = document.getElementById('start-vcam');
    this._smoothing = document.getElementById('smoothing');
    this._headStrength = document.getElementById('head-strength');
    this._mirrorChk = document.getElementById('mirror');
    this._loading = document.getElementById('loading');
    this._loadingText = document.getElementById('loading-text');
    this._lb = document.getElementById('lb');

    // ----- Create modules -----
    this.scene = new AvatarScene(this._canvas);
    this.vcam = new VirtualCamera(this._canvas);

    // ----- File drop / file input -----
    this._fileDrop = document.getElementById('file-drop');
    this._fileInput = document.getElementById('file-input');

    this._fileDrop.addEventListener('click', () => this._fileInput.click());
    this._fileInput.addEventListener('change', (e) => {
      if (e.target.files.length) this._loadAvatarFromFile(e.target.files[0]);
    });
    this._fileDrop.addEventListener('dragover', (e) => {
      e.preventDefault();
      this._fileDrop.classList.add('over');
    });
    this._fileDrop.addEventListener('dragleave', () => {
      this._fileDrop.classList.remove('over');
    });
    this._fileDrop.addEventListener('drop', (e) => {
      e.preventDefault();
      this._fileDrop.classList.remove('over');
      if (e.dataTransfer.files.length) this._loadAvatarFromFile(e.dataTransfer.files[0]);
    });

    // ----- Event listeners -----
    this._loadBtn.addEventListener('click', () => this._loadAvatar());
    this._camBtn.addEventListener('click', () => this._toggleCamera());
    this._vcamBtn.addEventListener('click', () => this._toggleVCam());

    this._smoothing.addEventListener('input', (e) => {
      this.scene.smoothing = parseFloat(e.target.value);
    });
    this._headStrength.addEventListener('input', (e) => {
      this.scene.headStrength = parseFloat(e.target.value);
    });
    this._mirrorChk.addEventListener('change', (e) => {
      this.scene.mirrored = e.target.checked;
    });

    // ----- Framing preset buttons -----
    document.querySelectorAll('[data-preset]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const preset = e.target.dataset.preset;
        this.scene.setFramingPreset(preset);
        document.querySelectorAll('[data-preset]').forEach((b) => b.classList.remove('active'));
        e.target.classList.add('active');
      });
    });

    // Zoom slider
    const zoomSlider = document.getElementById('zoom-slider');
    if (zoomSlider) {
      zoomSlider.addEventListener('input', (e) => {
        this.scene.setZoomLevel(parseFloat(e.target.value));
      });
    }

    // ----- VFX settings -----
    const vfxBindings = [
      ['vfx-enabled', 'enabled', 'checked'],
      ['vfx-bloom', 'bloom', 'value'],
      ['vfx-ssao', 'ssao', 'value'],
      ['vfx-dof', 'dof', 'value'],
      ['vfx-vignette', 'vignette', 'value'],
      ['vfx-grain', 'filmGrain', 'value'],
    ];
    for (const [id, key, prop] of vfxBindings) {
      const el = document.getElementById(id);
      if (!el) continue;
      const evtName = prop === 'checked' ? 'change' : 'input';
      el.addEventListener(evtName, (e) => {
        const val = prop === 'checked' ? e.target.checked : parseFloat(e.target.value);
        this.scene.vfx[key] = val;
      });
    }

    // ----- v12: Spring interpolation -----
    const springEnabled = document.getElementById('spring-enabled');
    if (springEnabled) {
      springEnabled.addEventListener('change', (e) => {
        this.scene.setSpringEnabled(e.target.checked);
      });
    }
    const springStrength = document.getElementById('spring-strength');
    if (springStrength) {
      springStrength.addEventListener('input', (e) => {
        const v = parseFloat(e.target.value);
        this.scene.setSpringStrength(v);
        setValDisplay('spring-strength-val', formatFixed(v, 2));
      });
    }
    const springStiffness = document.getElementById('spring-stiffness');
    if (springStiffness) {
      springStiffness.addEventListener('input', (e) => {
        const v = parseFloat(e.target.value);
        this.scene.setSpringStiffness(v);
        setValDisplay('spring-stiffness-val', formatFixed(v, 2));
      });
    }
    const springDamping = document.getElementById('spring-damping');
    if (springDamping) {
      springDamping.addEventListener('input', (e) => {
        const v = parseFloat(e.target.value);
        this.scene.setSpringDamping(v);
        setValDisplay('spring-damping-val', formatFixed(v, 2));
      });
    }

    // ----- v13: Breathing -----
    const breathEnabled = document.getElementById('breath-enabled');
    if (breathEnabled) {
      breathEnabled.addEventListener('change', (e) => {
        this.scene.setBreathingEnabled(e.target.checked);
      });
    }
    const breathRate = document.getElementById('breath-rate');
    if (breathRate) {
      breathRate.addEventListener('input', (e) => {
        this.scene.setBreathRate(parseFloat(e.target.value));
      });
    }
    const breathDepth = document.getElementById('breath-depth');
    if (breathDepth) {
      breathDepth.addEventListener('input', (e) => {
        this.scene.setBreathDepth(parseFloat(e.target.value));
      });
    }

    // ===== v14: Audio emotion controls =====
    const emotionEnabled = document.getElementById('emotion-enabled');
    if (emotionEnabled) {
      emotionEnabled.addEventListener('change', (e) => {
        this.scene.setEmotionEnabled(e.target.checked);
      });
    }
    const emotionSensitivity = document.getElementById('emotion-sensitivity');
    if (emotionSensitivity) {
      emotionSensitivity.addEventListener('input', (e) => {
        this.scene.setEmotionSensitivity(parseFloat(e.target.value));
      });
    }
    const emotionStrength = document.getElementById('emotion-strength');
    if (emotionStrength) {
      emotionStrength.addEventListener('input', (e) => {
        this.scene.setEmotionStrength(parseFloat(e.target.value));
      });
    }

    // ===== v15: Life motion controls =====
    const saccadeEnabled = document.getElementById('saccade-enabled');
    if (saccadeEnabled) {
      saccadeEnabled.addEventListener('change', (e) => {
        this.scene.setSaccadeEnabled(e.target.checked);
      });
    }
    const saccadeAmplitude = document.getElementById('saccade-amplitude');
    if (saccadeAmplitude) {
      saccadeAmplitude.addEventListener('input', (e) => {
        this.scene.setSaccadeAmplitude(parseFloat(e.target.value));
      });
    }
    const shakeEnabled = document.getElementById('shake-enabled');
    if (shakeEnabled) {
      shakeEnabled.addEventListener('change', (e) => {
        this.scene.setCameraShakeEnabled(e.target.checked);
      });
    }
    const shakeAmplitude = document.getElementById('shake-amplitude');
    if (shakeAmplitude) {
      shakeAmplitude.addEventListener('input', (e) => {
        // UI in mm → scene expects meters
        this.scene.setCameraShakeAmplitude(parseFloat(e.target.value) / 1000);
      });
    }
    const shakeFrequency = document.getElementById('shake-frequency');
    if (shakeFrequency) {
      shakeFrequency.addEventListener('input', (e) => {
        this.scene.setCameraShakeFrequency(parseFloat(e.target.value));
      });
    }

    // ===== v16: Lighting presets =====
    const lightingSelect = document.getElementById('lighting-preset');
    const lightingDesc = document.getElementById('lighting-description');
    if (lightingSelect) {
      const presets = this.scene.getLightingPresetList();
      lightingSelect.innerHTML = '';
      for (const p of presets) {
        const opt = document.createElement('option');
        opt.value = p.key;
        opt.textContent = p.name;
        lightingSelect.appendChild(opt);
      }
      lightingSelect.value = this.scene.getCurrentLightingPreset();

      const updateDesc = () => {
        const cur = presets.find((p) => p.key === lightingSelect.value);
        if (cur && lightingDesc) lightingDesc.textContent = cur.description;
      };
      updateDesc();

      lightingSelect.addEventListener('change', (e) => {
        const ok = this.scene.applyLightingPreset(e.target.value);
        if (ok) {
          updateDesc();
          this._log('s', `照明プリセット適用: ${e.target.value}`);
        }
      });
    }

    // ===== v17: Secondary motion controls =====
    const headFollowEnabled = document.getElementById('head-follow-enabled');
    if (headFollowEnabled) {
      headFollowEnabled.addEventListener('change', (e) => {
        this.scene.setHeadFollowEnabled(e.target.checked);
      });
    }
    const headFollowStrength = document.getElementById('head-follow-strength');
    if (headFollowStrength) {
      headFollowStrength.addEventListener('input', (e) => {
        this.scene.setHeadFollowStrength(parseFloat(e.target.value));
      });
    }
    const hairPhysEnabled = document.getElementById('hair-physics-enabled');
    if (hairPhysEnabled) {
      hairPhysEnabled.addEventListener('change', (e) => {
        this.scene.setHairPhysicsEnabled(e.target.checked);
      });
    }
    const hairPhysStrength = document.getElementById('hair-physics-strength');
    if (hairPhysStrength) {
      hairPhysStrength.addEventListener('input', (e) => {
        this.scene.setHairPhysicsStrength(parseFloat(e.target.value));
      });
    }

    // ===== v18: LUT color grading =====
    const lutSelect = document.getElementById('lut-preset');
    if (lutSelect) {
      const presets = this.scene.getLUTPresetList();
      lutSelect.innerHTML = '';
      for (const p of presets) {
        const opt = document.createElement('option');
        opt.value = p.key;
        opt.textContent = p.name;
        lutSelect.appendChild(opt);
      }
      lutSelect.value = this.scene.getCurrentLUTPreset();
      lutSelect.addEventListener('change', (e) => {
        this.scene.applyLUTPreset(e.target.value);
        this._log('s', `LUT適用: ${e.target.value}`);
      });
    }
    const lutEnabled = document.getElementById('lut-enabled');
    if (lutEnabled) {
      lutEnabled.addEventListener('change', (e) => {
        this.scene.setLUTEnabled(e.target.checked);
      });
    }
    const lutIntensity = document.getElementById('lut-intensity');
    if (lutIntensity) {
      lutIntensity.addEventListener('input', (e) => {
        const v = parseFloat(e.target.value);
        this.scene.setLUTIntensity(v);
        setValDisplay('lut-intensity-val', formatFixed(v, 2));
      });
    }

    // ===== v18: Lens (CA + distortion) =====
    const lensEnabled = document.getElementById('lens-enabled');
    if (lensEnabled) {
      lensEnabled.addEventListener('change', (e) => {
        this.scene.setLensEnabled(e.target.checked);
      });
    }
    const caStrength = document.getElementById('ca-strength');
    if (caStrength) {
      caStrength.addEventListener('input', (e) => {
        const v = parseFloat(e.target.value);
        this.scene.setChromaticAberration(v);
        setValDisplay('ca-strength-val', formatFixed(v, 4));
      });
    }
    const lensDistortion = document.getElementById('lens-distortion');
    if (lensDistortion) {
      lensDistortion.addEventListener('input', (e) => {
        const v = parseFloat(e.target.value);
        this.scene.setLensDistortion(v);
        setValDisplay('lens-distortion-val', formatSigned(v, 2));
      });
    }

    // ===== v18: Anamorphic flare =====
    const flareEnabled = document.getElementById('flare-enabled');
    if (flareEnabled) {
      flareEnabled.addEventListener('change', (e) => {
        this.scene.setAnamorphicFlareEnabled(e.target.checked);
      });
    }
    const flareIntensity = document.getElementById('flare-intensity');
    if (flareIntensity) {
      flareIntensity.addEventListener('input', (e) => {
        const v = parseFloat(e.target.value);
        this.scene.setAnamorphicFlareIntensity(v);
        setValDisplay('flare-intensity-val', formatFixed(v, 2));
      });
    }
    const flareThreshold = document.getElementById('flare-threshold');
    if (flareThreshold) {
      flareThreshold.addEventListener('input', (e) => {
        const v = parseFloat(e.target.value);
        this.scene.setAnamorphicFlareThreshold(v);
        setValDisplay('flare-threshold-val', formatFixed(v, 2));
      });
    }
    const flareStretch = document.getElementById('flare-stretch');
    if (flareStretch) {
      flareStretch.addEventListener('input', (e) => {
        const v = parseFloat(e.target.value);
        this.scene.setAnamorphicFlareStretch(v);
        setValDisplay('flare-stretch-val', formatFixed(v, 2));
      });
    }

    // ===== v21.1: Contact Shadow (luminance-based) =====
    const csEnabled = document.getElementById('contact-shadow-enabled');
    if (csEnabled) {
      csEnabled.addEventListener('change', (e) => {
        this.scene.setContactShadowEnabled(e.target.checked);
      });
    }
    const csIntensity = document.getElementById('contact-shadow-intensity');
    if (csIntensity) {
      csIntensity.addEventListener('input', (e) => {
        const v = parseFloat(e.target.value);
        this.scene.setContactShadowIntensity(v);
        setValDisplay('contact-shadow-intensity-val', formatFixed(v, 2));
      });
    }
    const csThreshold = document.getElementById('contact-shadow-threshold');
    if (csThreshold) {
      csThreshold.addEventListener('input', (e) => {
        const v = parseFloat(e.target.value);
        this.scene.setContactShadowThreshold(v);
        setValDisplay('contact-shadow-threshold-val', formatFixed(v, 2));
      });
    }
    const csRadius = document.getElementById('contact-shadow-radius');
    if (csRadius) {
      csRadius.addEventListener('input', (e) => {
        const v = parseFloat(e.target.value);
        this.scene.setContactShadowRadius(v);
        setValDisplay('contact-shadow-radius-val', formatFixed(v, 2));
      });
    }
    const csSoftness = document.getElementById('contact-shadow-softness');
    if (csSoftness) {
      csSoftness.addEventListener('input', (e) => {
        const v = parseFloat(e.target.value);
        this.scene.setContactShadowSoftness(v);
        setValDisplay('contact-shadow-softness-val', formatFixed(v, 2));
      });
    }

    // ===== v21: Film Halation =====
    const fhEnabled = document.getElementById('film-halation-enabled');
    if (fhEnabled) {
      fhEnabled.addEventListener('change', (e) => {
        this.scene.setFilmHalationEnabled(e.target.checked);
      });
    }
    const fhIntensity = document.getElementById('film-halation-intensity');
    if (fhIntensity) {
      fhIntensity.addEventListener('input', (e) => {
        const v = parseFloat(e.target.value);
        this.scene.setFilmHalationIntensity(v);
        setValDisplay('film-halation-intensity-val', formatFixed(v, 2));
      });
    }
    const fhThreshold = document.getElementById('film-halation-threshold');
    if (fhThreshold) {
      fhThreshold.addEventListener('input', (e) => {
        const v = parseFloat(e.target.value);
        this.scene.setFilmHalationThreshold(v);
        setValDisplay('film-halation-threshold-val', formatFixed(v, 2));
      });
    }
    const fhRadius = document.getElementById('film-halation-radius');
    if (fhRadius) {
      fhRadius.addEventListener('input', (e) => {
        const v = parseFloat(e.target.value);
        this.scene.setFilmHalationRadius(v);
        setValDisplay('film-halation-radius-val', formatFixed(v, 2));
      });
    }

    // ===== v22: Eye Enhancement =====
    const eyeEnabled = document.getElementById('eye-enabled');
    if (eyeEnabled) {
      eyeEnabled.addEventListener('change', (e) => {
        this.scene.setEyeShaderEnabled(e.target.checked);
        this._log('s', `目エンハンス: ${e.target.checked ? 'ON' : 'OFF'}`);
      });
    }
    const eyeCausticStrength = document.getElementById('eye-caustic-strength');
    if (eyeCausticStrength) {
      eyeCausticStrength.addEventListener('input', (e) => {
        const v = parseFloat(e.target.value);
        this.scene.setEyeCausticStrength(v);
        setValDisplay('eye-caustic-strength-val', formatFixed(v, 2));
      });
    }
    const eyeCausticIOR = document.getElementById('eye-caustic-ior');
    if (eyeCausticIOR) {
      eyeCausticIOR.addEventListener('input', (e) => {
        const v = parseFloat(e.target.value);
        this.scene.setEyeCausticIOR(v);
        setValDisplay('eye-caustic-ior-val', formatFixed(v, 2));
      });
    }
    const eyeWetness = document.getElementById('eye-wetness');
    if (eyeWetness) {
      eyeWetness.addEventListener('input', (e) => {
        const v = parseFloat(e.target.value);
        this.scene.setEyeWetness(v);
        setValDisplay('eye-wetness-val', formatFixed(v, 2));
      });
    }
    const eyeReflectivity = document.getElementById('eye-reflectivity');
    if (eyeReflectivity) {
      eyeReflectivity.addEventListener('input', (e) => {
        const v = parseFloat(e.target.value);
        this.scene.setEyeReflectivity(v);
        setValDisplay('eye-reflectivity-val', formatFixed(v, 2));
      });
    }

    // ===== v19: Kajiya-Kay hair =====
    const kkEnabled = document.getElementById('kk-enabled');
    if (kkEnabled) {
      kkEnabled.addEventListener('change', (e) => {
        this.scene.setKajiyaKayEnabled(e.target.checked);
        this._log('s', `髪シェーダー: ${e.target.checked ? 'Kajiya-Kay' : 'v11 anisotropic'}`);
      });
    }

    const kkPrimaryStrength = document.getElementById('kk-primary-strength');
    if (kkPrimaryStrength) {
      kkPrimaryStrength.addEventListener('input', (e) => {
        const v = parseFloat(e.target.value);
        this.scene.setHairPrimaryStrength(v);
        setValDisplay('kk-primary-strength-val', formatFixed(v, 2));
      });
    }
    const kkSecondaryStrength = document.getElementById('kk-secondary-strength');
    if (kkSecondaryStrength) {
      kkSecondaryStrength.addEventListener('input', (e) => {
        const v = parseFloat(e.target.value);
        this.scene.setHairSecondaryStrength(v);
        setValDisplay('kk-secondary-strength-val', formatFixed(v, 2));
      });
    }
    const kkPrimaryWidth = document.getElementById('kk-primary-width');
    if (kkPrimaryWidth) {
      kkPrimaryWidth.addEventListener('input', (e) => {
        const v = parseFloat(e.target.value);
        this.scene.setHairPrimaryWidth(v);
        setValDisplay('kk-primary-width-val', formatFixed(v, 2));
      });
    }
    const kkSecondaryWidth = document.getElementById('kk-secondary-width');
    if (kkSecondaryWidth) {
      kkSecondaryWidth.addEventListener('input', (e) => {
        const v = parseFloat(e.target.value);
        this.scene.setHairSecondaryWidth(v);
        setValDisplay('kk-secondary-width-val', formatFixed(v, 2));
      });
    }
    const kkPrimaryShift = document.getElementById('kk-primary-shift');
    if (kkPrimaryShift) {
      kkPrimaryShift.addEventListener('input', (e) => {
        const v = parseFloat(e.target.value);
        this.scene.setHairPrimaryShift(v);
        setValDisplay('kk-primary-shift-val', formatSigned(v, 2));
      });
    }
    const kkSecondaryShift = document.getElementById('kk-secondary-shift');
    if (kkSecondaryShift) {
      kkSecondaryShift.addEventListener('input', (e) => {
        const v = parseFloat(e.target.value);
        this.scene.setHairSecondaryShift(v);
        setValDisplay('kk-secondary-shift-val', formatSigned(v, 2));
      });
    }
    // v20: Hair tint with both color picker AND hex text input (bidirectional sync)
    const kkTint = document.getElementById('kk-tint');
    const kkTintHex = document.getElementById('kk-tint-hex');

    /** Apply hex string "#rrggbb" to the scene; return true on success */
    const applyHexTint = (hexStr) => {
      const match = /^#([0-9a-fA-F]{6})$/.exec(hexStr.trim());
      if (!match) return false;
      const hex = parseInt(match[1], 16);
      this.scene.setHairTint(hex);
      return true;
    };

    if (kkTint) {
      kkTint.addEventListener('input', (e) => {
        const hexStr = e.target.value.toLowerCase();
        applyHexTint(hexStr);
        if (kkTintHex) {
          kkTintHex.value = hexStr;
          kkTintHex.classList.remove('invalid');
        }
      });
    }

    if (kkTintHex) {
      kkTintHex.addEventListener('input', (e) => {
        let val = e.target.value.trim();
        // Auto-prepend # if missing
        if (val.length === 6 && !val.startsWith('#')) {
          val = '#' + val;
          e.target.value = val;
        }
        if (applyHexTint(val)) {
          e.target.classList.remove('invalid');
          if (kkTint) kkTint.value = val.toLowerCase();
        } else {
          e.target.classList.add('invalid');
        }
      });

      kkTintHex.addEventListener('blur', (e) => {
        if (e.target.classList.contains('invalid') && kkTint) {
          e.target.value = kkTint.value.toLowerCase();
          e.target.classList.remove('invalid');
        }
      });
    }

    // ----- Idle gesture settings -----
    const gestEnabled = document.getElementById('gesture-enabled');
    if (gestEnabled) {
      gestEnabled.addEventListener('change', (e) => {
        this.scene.setGestureEnabled(e.target.checked);
      });
    }
    const gestIntensity = document.getElementById('gesture-intensity');
    if (gestIntensity) {
      gestIntensity.addEventListener('input', (e) => {
        this.scene.setGestureIntensity(parseFloat(e.target.value));
      });
    }

    // ----- Background presets -----
    const bgPresetSelect = document.getElementById('bg-preset');
    if (bgPresetSelect) {
      const presets = this.scene.BACKGROUND_PRESETS;
      presets.forEach((p, i) => {
        const opt = document.createElement('option');
        opt.value = String(i);
        opt.textContent = p.name;
        bgPresetSelect.appendChild(opt);
      });

      bgPresetSelect.addEventListener('change', async (e) => {
        const idx = parseInt(e.target.value);
        if (isNaN(idx)) return;
        const preset = presets[idx];
        try {
          this._showLoading(`背景読み込み中: ${preset.name}`);
          if (preset.mode === 'color') {
            this.scene.setBackgroundColor(preset.value);
          } else if (preset.mode === 'hdri') {
            await this.scene.setBackgroundHDRI(preset.url);
          }
          this._hideLoading();
          this._hideBgCameraControls();
          this._log('s', `背景: ${preset.name}`);
        } catch (err) {
          this._hideLoading();
          this._log('e', `背景設定失敗: ${err.message}`);
        }
      });
    }

    // Image background upload
    const bgImageBtn = document.getElementById('bg-image-btn');
    const bgImageFile = document.getElementById('bg-image-file');
    if (bgImageBtn && bgImageFile) {
      bgImageBtn.addEventListener('click', () => bgImageFile.click());
      bgImageFile.addEventListener('change', async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        try {
          await this.scene.setBackgroundImage(file);
          this._hideBgCameraControls();
          this._log('s', `画像背景: ${file.name}`);
        } catch (err) {
          this._log('e', err.message);
        }
        bgImageFile.value = '';
      });
    }

    // Video background upload
    const bgVideoBtn = document.getElementById('bg-video-btn');
    const bgVideoFile = document.getElementById('bg-video-file');
    if (bgVideoBtn && bgVideoFile) {
      bgVideoBtn.addEventListener('click', () => bgVideoFile.click());
      bgVideoFile.addEventListener('change', async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        try {
          await this.scene.setBackgroundVideo(file);
          this._hideBgCameraControls();
          this._log('s', `動画背景: ${file.name}`);
        } catch (err) {
          this._log('e', err.message);
        }
        bgVideoFile.value = '';
      });
    }

    // 360° Panorama background
    const bgPanoBtn = document.getElementById('bg-pano-btn');
    const bgPanoFile = document.getElementById('bg-pano-file');
    if (bgPanoBtn && bgPanoFile) {
      bgPanoBtn.addEventListener('click', () => bgPanoFile.click());
      bgPanoFile.addEventListener('change', async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        this._showLoading(`360°パノラマ読み込み中: ${file.name}`);
        try {
          await this.scene.setBackgroundPanorama(file);
          this._hideLoading();
          this._hideBgCameraControls();
          this._log('s', `360°パノラマ背景: ${file.name}`);
        } catch (err) {
          this._hideLoading();
          this._log('e', `読み込み失敗: ${err.message}`);
        }
        bgPanoFile.value = '';
      });
    }

    // 3D Scene background
    const bg3dBtn = document.getElementById('bg-3d-btn');
    const bg3dFile = document.getElementById('bg-3d-file');
    if (bg3dBtn && bg3dFile) {
      bg3dBtn.addEventListener('click', () => bg3dFile.click());
      bg3dFile.addEventListener('change', async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        this._showLoading(`3Dシーン読み込み中: ${file.name}\n(時間がかかる場合があります)`);
        try {
          await this.scene.setBackground3DScene(file);
          this._hideLoading();
          this._log('s', `3Dシーン背景: ${file.name}`);
          this._showBgCameraControls();
          this._log('i', '背景の視点をマウスで調整し「視点を固定」を押してください');
        } catch (err) {
          this._hideLoading();
          this._log('e', `読み込み失敗: ${err.message}`);
        }
        bg3dFile.value = '';
      });
    }

    // ----- Background camera lock/unlock -----
    this._bgCamControls = document.getElementById('bg-camera-controls');
    this._bgCamLabel = document.getElementById('bg-camera-label');
    this._bgCamLockBtn = document.getElementById('bg-cam-lock');
    this._bgCamUnlockBtn = document.getElementById('bg-cam-unlock');

    if (this._bgCamLockBtn) {
      this._bgCamLockBtn.addEventListener('click', () => {
        this.scene.lockBgCamera();
        this._bgCamLockBtn.style.display = 'none';
        this._bgCamUnlockBtn.style.display = '';
        this._bgCamLabel.textContent = '🔒 背景カメラ: 固定';
        this._bgCamLabel.parentElement.classList.add('locked');
        this._log('s', '背景カメラを固定しました');
      });
    }
    if (this._bgCamUnlockBtn) {
      this._bgCamUnlockBtn.addEventListener('click', () => {
        this.scene.unlockBgCamera();
        this._bgCamUnlockBtn.style.display = 'none';
        this._bgCamLockBtn.style.display = '';
        this._bgCamLabel.textContent = '🔓 背景カメラ: 調整中';
        this._bgCamLabel.parentElement.classList.remove('locked');
        this._log('i', '背景カメラを再調整できます');
      });
    }

    // ----- v20: Settings reset button -----
    const resetBtn = document.getElementById('reset-settings-btn');
    if (resetBtn) {
      resetBtn.addEventListener('click', () => {
        if (confirm('全ての設定を初期値に戻しますか?\nページがリロードされます。')) {
          localStorage.removeItem('avatarMeetingStudio.settings.v1');
          location.reload();
        }
      });
    }

    // ----- v20: Settings persistence (must be last — after all handlers) -----
    this._setupSettingsPersistence();

    // ----- Auto-load default avatar -----
    this._loadAvatar();

    // ----- Start main loop -----
    this._loop();

    this._log('i', 'Avatar Meeting Studio v20 ready');
  }

  /**
   * v20: localStorage persistence for all UI control values.
   * Captures checkboxes, ranges, selects, and color/text inputs.
   * @private
   */
  _setupSettingsPersistence() {
    const STORAGE_KEY = 'avatarMeetingStudio.settings.v1';
    const SAVE_DEBOUNCE_MS = 300;

    const selectors = [
      'input[type="range"]',
      'input[type="checkbox"]',
      'input[type="color"]',
      'input[type="text"].hex-input',
      'select',
    ];
    const controls = [];
    for (const sel of selectors) {
      controls.push(...document.querySelectorAll(sel));
    }
    const persistable = controls.filter((c) => c.id);

    // --- Restore saved values ---
    const restore = () => {
      let saved = null;
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return;
        saved = JSON.parse(raw);
      } catch (err) {
        console.warn('[Settings] Failed to parse saved settings:', err);
        return;
      }

      if (!saved || typeof saved !== 'object') return;

      let restoredCount = 0;
      for (const ctrl of persistable) {
        if (!(ctrl.id in saved)) continue;
        const val = saved[ctrl.id];
        try {
          if (ctrl.type === 'checkbox') {
            ctrl.checked = !!val;
          } else {
            ctrl.value = String(val);
          }
          const eventType = ctrl.type === 'checkbox' || ctrl.tagName === 'SELECT'
            ? 'change' : 'input';
          ctrl.dispatchEvent(new Event(eventType, { bubbles: true }));
          restoredCount++;
        } catch (err) {
          // Silently skip problematic controls
        }
      }

      if (restoredCount > 0) {
        this._log?.('s', `設定を復元しました (${restoredCount} 項目)`);
        console.log(`[Settings] Restored ${restoredCount} values from localStorage`);
      }
    };

    // --- Save current values ---
    let saveTimer = null;
    const saveNow = () => {
      try {
        const data = {};
        for (const ctrl of persistable) {
          if (ctrl.type === 'checkbox') {
            data[ctrl.id] = ctrl.checked;
          } else {
            data[ctrl.id] = ctrl.value;
          }
        }
        localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
      } catch (err) {
        console.warn('[Settings] Failed to save:', err);
      }
    };
    const debouncedSave = () => {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(saveNow, SAVE_DEBOUNCE_MS);
    };

    // --- Wire up auto-save on every change ---
    for (const ctrl of persistable) {
      const eventType = ctrl.type === 'checkbox' || ctrl.tagName === 'SELECT'
        ? 'change' : 'input';
      ctrl.addEventListener(eventType, debouncedSave);
    }

    // --- Restore after brief delay to let scene init complete ---
    setTimeout(restore, 200);

    // --- Expose reset helper on window for debugging ---
    window.resetAvatarMeetingSettings = () => {
      localStorage.removeItem(STORAGE_KEY);
      console.log('[Settings] Cleared saved settings. Reload to use defaults.');
    };

    console.log(`[Settings] Persistence enabled (${persistable.length} controls tracked)`);
  }

  /**
   * Load avatar from a local .glb file.
   * @param {File} file
   * @private
   */
  async _loadAvatarFromFile(file) {
    if (!file) return;
    if (!file.name.endsWith('.glb') && !file.name.endsWith('.gltf')) {
      this._log('w', '.glb または .gltf ファイルを選択してください');
      return;
    }

    this._showLoading(`ローカルファイルをロード中...\n${file.name}`);
    try {
      await this.scene.loadAvatarFromFile(file);
      this._hideLoading();
      this._camBtn.disabled = false;
      this._vcamBtn.disabled = false;
      this._log('s', `ローカルアバター読み込み完了: ${file.name}`);
    } catch (err) {
      this._hideLoading();
      this._log('e', `読み込み失敗: ${err.message}`);
      console.error('[App] Local avatar load error:', err);
    }
  }

  /**
   * Load avatar from the URL input.
   * @private
   */
  async _loadAvatar() {
    const url = this._urlInput.value.trim();
    if (!url) return;

    this._showLoading('アバターをロード中...');
    try {
      await this.scene.loadAvatar(url);
      this._hideLoading();
      this._camBtn.disabled = false;
      this._vcamBtn.disabled = false;
      this._log('s', 'アバター読み込み完了');
    } catch (err) {
      this._hideLoading();
      this._log('e', `読み込み失敗: ${err.message}`);
      console.error('[App] Avatar load error:', err);
    }
  }

  /**
   * Toggle camera tracking on/off.
   * @private
   */
  async _toggleCamera() {
    if (!this.tracker) {
      this._showLoading('MediaPipe を初期化中...\n(初回は ~5MB ダウンロード)');
      this.tracker = new FaceTracker();
      const ok = await this.tracker.init();
      if (!ok) {
        this._hideLoading();
        this._log('e', 'カメラ初期化失敗');
        this.tracker = null;
        return;
      }
      this._log('s', 'カメラ追跡開始 (Face Landmarker)');

      // Start pose tracking using the same camera stream
      this._showLoading('ポーズ検出を初期化中...\n(pose_landmarker_lite)');
      this.poseTracker = new PoseTracker();
      const poseOk = await this.poseTracker.init(this.tracker._stream);
      this._hideLoading();
      if (poseOk) {
        this.scene.setPoseTracker(this.poseTracker);
        this._log('s', 'ポーズ追跡開始 (Pose Landmarker)');
      } else {
        this._log('w', 'ポーズ追跡初期化失敗 (ノイズモードで動作)');
        this.poseTracker = null;
      }

      // ★ v14: Start independent audio stream for emotion analysis
      try {
        const audioStream = await navigator.mediaDevices.getUserMedia({
          video: false,
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: false,
          },
        });
        const emotionOk = await this.scene.startEmotionAnalysis(audioStream);
        if (emotionOk) {
          this._log('s', '音声感情解析開始');
        } else {
          this._log('w', '音声感情解析の初期化に失敗');
        }
      } catch (err) {
        this._log('w', `音声感情解析を利用できません: ${err.message}`);
      }

      this._camBtn.textContent = '📹 カメラ OFF';
      this._camBtn.classList.add('active');
    } else {
      this.tracker.stop();
      this.tracker = null;
      if (this.poseTracker) {
        this.poseTracker.stop();
        this.poseTracker = null;
      }
      this.scene.setPoseTracker(null);
      // ★ v14: Stop emotion analysis
      this.scene.stopEmotionAnalysis();
      this._camBtn.textContent = '📹 カメラを有効化';
      this._camBtn.classList.remove('active');
      this._log('i', 'カメラ停止');
    }
  }

  /**
   * Toggle virtual camera output on/off.
   * @private
   */
  _toggleVCam() {
    if (!this.vcam.isActive) {
      this.vcam.start(30);
      this._vcamBtn.textContent = '🔄 仮想カメラ OFF';
      this._vcamBtn.classList.add('active');
      this._lb.style.display = 'flex';
      this._log('s', '仮想カメラ ON — OBS Virtual Camera 経由で Meet に出力');
    } else {
      this.vcam.stop();
      this._vcamBtn.textContent = '🔄 仮想カメラ ON';
      this._vcamBtn.classList.remove('active');
      this._lb.style.display = 'none';
      this._log('i', '仮想カメラ停止');
    }
  }

  /**
   * Main animation loop. Runs every frame.
   * Reads latest FaceTracker data and passes to AvatarScene.
   * @private
   */
  _loop() {
    requestAnimationFrame(() => this._loop());

    // FPS counter
    this._fpsFrames++;
    const now = performance.now();
    if (now - this._fpsTime >= 1000) {
      this._fps = this._fpsFrames;
      this._fpsFrames = 0;
      this._fpsTime = now;
      this._updateStatusBar();
    }

    // Pass latest tracker data to scene (empty object if no tracker)
    const blendShapes = this.tracker?.blendShapes || {};
    const matrix = this.tracker?.transformMatrix || null;
    this.scene.update(blendShapes, matrix);
  }

  /**
   * Update the status bar with current metrics.
   * @private
   */
  _updateStatusBar() {
    const sf = document.getElementById('sf');
    const sj = document.getElementById('sj');
    const sb = document.getElementById('sb');
    const sh = document.getElementById('sh');

    if (sf) sf.textContent = `FPS:${this._fps}`;

    if (this.tracker && this.tracker.faceDetected) {
      const bs = this.tracker.blendShapes;
      if (sj) sj.textContent = `jaw:${(bs.jawOpen || 0).toFixed(2)}`;
      if (sb) {
        const blink = ((bs.eyeBlinkLeft || 0) + (bs.eyeBlinkRight || 0)) / 2;
        sb.textContent = `blink:${blink.toFixed(2)}`;
      }
      if (sh && this.tracker.transformMatrix) {
        // Extract approximate yaw from the matrix
        const m = this.tracker.transformMatrix;
        const yaw = (Math.atan2(-m[2], m[0]) * 180 / Math.PI).toFixed(0);
        sh.textContent = `yaw:${yaw}\u00B0`;
      }
    }
  }

  /** Show background camera controls (after 3D scene load). @private */
  _showBgCameraControls() {
    if (!this._bgCamControls) return;
    this._bgCamControls.style.display = '';
    this._bgCamLockBtn.style.display = '';
    this._bgCamUnlockBtn.style.display = 'none';
    this._bgCamLabel.textContent = '🔓 背景カメラ: 調整中';
    this._bgCamLabel.parentElement.classList.remove('locked');
  }

  /** Hide background camera controls. @private */
  _hideBgCameraControls() {
    if (!this._bgCamControls) return;
    this._bgCamControls.style.display = 'none';
  }

  /** @private */
  _showLoading(text) {
    this._loadingText.textContent = text;
    this._loading.style.display = 'flex';
  }

  /** @private */
  _hideLoading() {
    this._loading.style.display = 'none';
  }

  /**
   * Append a log message to the log panel.
   * @param {'i'|'s'|'e'|'w'} level
   * @param {string} message
   */
  _log(level, message) {
    const box = document.getElementById('log');
    if (!box) return;
    const ts = new Date().toLocaleTimeString('ja-JP', { hour12: false });
    const line = document.createElement('div');
    line.className = level;
    line.textContent = `[${ts}] ${message}`;
    box.appendChild(line);
    box.scrollTop = box.scrollHeight;
    while (box.children.length > 50) box.removeChild(box.firstChild);
  }
}

// ----- Bootstrap -----
document.addEventListener('DOMContentLoaded', () => {
  const app = new App();
  app.init();
  window._app = app;  // Debug access
});
