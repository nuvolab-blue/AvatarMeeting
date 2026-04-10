/**
 * @fileoverview Three.js scene for Ready Player Me 3D avatar rendering.
 *
 * v6: OrbitControls, framing presets, EffectComposer, HDRI, 3-point lighting
 * v8: Background system (color, HDRI, image, video), material refactor
 * v9: 360° panorama + 3D scene backgrounds
 * v10: Dual-scene rendering (separate BG camera), dynamic framing presets
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { SSAOPass } from 'three/addons/postprocessing/SSAOPass.js';
import { BokehPass } from 'three/addons/postprocessing/BokehPass.js';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { IdleGestureAnimator } from './idle-gesture.js';

export class AvatarScene {
  /**
   * @param {HTMLCanvasElement} canvas
   */
  constructor(canvas) {
    this._canvas = canvas;
    /** @type {THREE.WebGLRenderer} */
    this._renderer = null;
    /** @type {THREE.Scene} */
    this._scene = null;
    /** @type {THREE.PerspectiveCamera} */
    this._camera = null;
    /** @type {THREE.Object3D|null} */
    this._avatar = null;
    /** @type {THREE.Bone|null} */
    this._headBone = null;
    /** @type {THREE.Bone|null} */
    this._neckBone = null;
    /** @type {THREE.Mesh[]} Meshes that have morph targets */
    this._morphMeshes = [];
    /** @type {THREE.Clock} */
    this._clock = new THREE.Clock();

    // Driving parameters (controlled from UI)
    this.smoothing = 0.5;
    this.headStrength = 1.0;
    this.mirrored = true;

    /** @private */
    this._smoothedHeadRot = new THREE.Euler();
    /** @private */
    this._loaded = false;

    // ===== v7: Idle body gesture + pose tracking =====
    this._gesture = new IdleGestureAnimator();
    /** @private */
    this._lastGestureTime = 0;
    this._poseTracker = null;

    // ===== v6: Zoom / OrbitControls =====
    /** @type {OrbitControls|null} */
    this._controls = null;
    this._zoomLevel = 0.5;
    this._cameraTarget = new THREE.Vector3();
    this._cameraDesiredPosition = new THREE.Vector3();
    this._cameraDesiredTarget = new THREE.Vector3();
    /** @private */
    this._desiredFOV = 30;
    /** @private */
    this._userInteracting = false;

    // ===== v6: VFX / Post-processing =====
    this._composer = null;
    /** @private */
    this._ssaoPass = null;
    /** @private */
    this._bloomPass = null;
    /** @private */
    this._bokehPass = null;
    /** @private */
    this._cinematicPass = null;

    this.vfx = {
      enabled: true,
      bloom: 0.4,
      ssao: 0.5,
      dof: 0.3,
      vignette: 0.3,
      filmGrain: 0.05,
    };

    // ===== v8/v9: Background system =====
    /** @private {THREE.Mesh|null} Background plane for 2D image/video */
    this._bgPlane = null;
    /** @private {THREE.Texture|HTMLVideoElement|null} Current background resource */
    this._bgResource = null;

    // ===== v10: Dual-scene rendering =====
    /** @private {THREE.Scene|null} Separate scene for 3D background */
    this._bgScene3D = null;
    /** @private {THREE.PerspectiveCamera|null} Independent camera for 3D background */
    this._bgCamera = null;
    /** @private {THREE.WebGLRenderTarget|null} Render target for background */
    this._bgRenderTarget = null;
    /** @private {OrbitControls|null} Controls for background camera */
    this._bgControls = null;
    /** @private {boolean} When true, background camera is locked */
    this._bgCameraLocked = false;
    /** @private {THREE.Object3D|null} Reference to loaded BG model for cleanup */
    this._bgModelRoot = null;
    /** @private {'color'|'hdri'|'image'|'video'|'panorama'|'3dscene'} */
    this._bgMode = 'color';

    this._init();
  }

  // ==========================================================================
  // Framing presets (v10: dynamic distance from bbox)
  // ==========================================================================

  get FRAMING_PRESETS() {
    return {
      fullbody: { name: '全身',            frac: 1.0,  margin: 0.15, fov: 32 },
      upper:    { name: '上半身',          frac: 0.55, margin: 0.10, fov: 28 },
      portrait: { name: 'ポートレート',    frac: 0.35, margin: 0.08, fov: 30 },
      closeup:  { name: '顔クローズアップ', frac: 0.18, margin: 0.05, fov: 35 },
    };
  }

  /**
   * Apply a framing preset. Computes camera distance dynamically
   * from the avatar's actual bounding box size.
   * @param {'fullbody'|'upper'|'portrait'|'closeup'} preset
   */
  setFramingPreset(preset) {
    if (!this._avatar) return;
    const def = this.FRAMING_PRESETS[preset];
    if (!def) return;

    const box = new THREE.Box3().setFromObject(this._avatar);
    const size = box.getSize(new THREE.Vector3());
    const avatarHeight = size.y;

    const visibleHeight = avatarHeight * def.frac;
    const lookAtY = box.max.y - visibleHeight * 0.5;

    const fovRad = (def.fov * Math.PI) / 180;
    const baseDist = (visibleHeight * (1 + def.margin)) / (2 * Math.tan(fovRad / 2));

    this._cameraDesiredPosition.set(0, lookAtY, baseDist);
    this._cameraDesiredTarget.set(0, lookAtY, 0);
    this._desiredFOV = def.fov;
    this._userInteracting = false;

    console.log(
      `[AvatarScene] Framing: ${def.name} — ` +
      `height=${avatarHeight.toFixed(2)}, vis=${visibleHeight.toFixed(2)}, ` +
      `dist=${baseDist.toFixed(2)}`
    );
  }

  /**
   * Continuous zoom (0=full body, 1=face close-up).
   * @param {number} t - 0..1
   */
  setZoomLevel(t) {
    this._zoomLevel = Math.max(0, Math.min(1, t));
    const presetKeys = ['fullbody', 'upper', 'portrait', 'closeup'];
    const fIdx = this._zoomLevel * (presetKeys.length - 1);
    const i0 = Math.floor(fIdx);
    const i1 = Math.min(i0 + 1, presetKeys.length - 1);
    const f = fIdx - i0;

    const p0 = this.FRAMING_PRESETS[presetKeys[i0]];
    const p1 = this.FRAMING_PRESETS[presetKeys[i1]];

    if (!this._avatar) return;
    const box = new THREE.Box3().setFromObject(this._avatar);
    const size = box.getSize(new THREE.Vector3());
    const avatarHeight = size.y;

    const frac = p0.frac + (p1.frac - p0.frac) * f;
    const margin = p0.margin + (p1.margin - p0.margin) * f;
    const fov = p0.fov + (p1.fov - p0.fov) * f;

    const visibleHeight = avatarHeight * frac;
    const lookAtY = box.max.y - visibleHeight * 0.5;
    const fovRad = (fov * Math.PI) / 180;
    const baseDist = (visibleHeight * (1 + margin)) / (2 * Math.tan(fovRad / 2));

    this._cameraDesiredPosition.set(0, lookAtY, baseDist);
    this._cameraDesiredTarget.set(0, lookAtY, 0);
    this._desiredFOV = fov;
    this._userInteracting = false;
  }

  // ==========================================================================
  // Initialization
  // ==========================================================================

  /** @private */
  _init() {
    // ----- Renderer -----
    this._renderer = new THREE.WebGLRenderer({
      canvas: this._canvas,
      antialias: true,
      alpha: true,
      preserveDrawingBuffer: true
    });
    this._renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this._renderer.outputColorSpace = THREE.SRGBColorSpace;
    this._renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this._renderer.toneMappingExposure = 1.1;
    this._resize();

    // ----- Shadow maps -----
    this._renderer.shadowMap.enabled = true;
    this._renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    // ----- Scene -----
    this._scene = new THREE.Scene();
    this._scene.background = new THREE.Color(0x101018);

    // ----- Camera -----
    this._camera = new THREE.PerspectiveCamera(
      30,
      this._canvas.clientWidth / this._canvas.clientHeight,
      0.1,
      100
    );
    this._camera.position.set(0, 1.55, 1.0);
    this._camera.lookAt(0, 1.55, 0);

    // ----- Cinematic 3-point lighting + soft shadows -----
    const keyLight = new THREE.DirectionalLight(0xfff2e0, 2.5);
    keyLight.position.set(2.5, 3.5, 3.0);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.width = 2048;
    keyLight.shadow.mapSize.height = 2048;
    keyLight.shadow.camera.near = 0.1;
    keyLight.shadow.camera.far = 10;
    keyLight.shadow.camera.left = -2;
    keyLight.shadow.camera.right = 2;
    keyLight.shadow.camera.top = 2;
    keyLight.shadow.camera.bottom = -2;
    keyLight.shadow.bias = -0.0001;
    keyLight.shadow.radius = 4;
    this._scene.add(keyLight);

    const fillLight = new THREE.DirectionalLight(0xc8d8ff, 0.6);
    fillLight.position.set(-2.5, 1.5, 2.0);
    this._scene.add(fillLight);

    const rimLight = new THREE.DirectionalLight(0xffffff, 1.5);
    rimLight.position.set(0, 2, -3);
    this._scene.add(rimLight);

    this._scene.add(new THREE.AmbientLight(0xffffff, 0.15));

    // ----- OrbitControls -----
    this._controls = new OrbitControls(this._camera, this._canvas);
    this._controls.enableDamping = true;
    this._controls.dampingFactor = 0.08;
    this._controls.enablePan = false;
    this._controls.minDistance = 0.3;
    this._controls.maxDistance = 4.0;
    this._controls.minPolarAngle = Math.PI * 0.3;
    this._controls.maxPolarAngle = Math.PI * 0.7;
    this._controls.enableRotate = true;
    this._controls.rotateSpeed = 0.5;
    this._controls.zoomSpeed = 0.8;

    this._controls.addEventListener('start', () => { this._userInteracting = true; });
    this._controls.addEventListener('end', () => {
      setTimeout(() => { this._userInteracting = false; }, 500);
    });

    // ----- Post-processing & HDRI -----
    this._setupPostProcessing();
    this._setupHDRI();

    // ----- v10: BG render target -----
    this._initBgRenderTarget();

    // ----- Resize handling -----
    window.addEventListener('resize', () => this._resize());
  }

  /** @private */
  _resize() {
    const w = this._canvas.clientWidth;
    const h = this._canvas.clientHeight;
    if (w === 0 || h === 0) return;
    this._renderer.setSize(w, h, false);
    if (this._camera) {
      this._camera.aspect = w / h;
      this._camera.updateProjectionMatrix();
    }
    if (this._composer) {
      this._composer.setSize(w, h);
    }
    // v10: Resize BG render target
    if (this._bgRenderTarget) {
      const pw = w * Math.min(window.devicePixelRatio, 2);
      const ph = h * Math.min(window.devicePixelRatio, 2);
      this._bgRenderTarget.setSize(pw, ph);
    }
    if (this._bgCamera) {
      this._bgCamera.aspect = w / h;
      this._bgCamera.updateProjectionMatrix();
    }
  }

  /**
   * Create the WebGLRenderTarget used for 3D background compositing.
   * @private
   */
  _initBgRenderTarget() {
    const w = this._canvas.clientWidth * Math.min(window.devicePixelRatio, 2);
    const h = this._canvas.clientHeight * Math.min(window.devicePixelRatio, 2);

    this._bgRenderTarget = new THREE.WebGLRenderTarget(Math.max(w, 1), Math.max(h, 1), {
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      colorSpace: THREE.SRGBColorSpace,
    });

    console.log(`[AvatarScene] BG RenderTarget: ${Math.round(w)}x${Math.round(h)}`);
  }

  // ==========================================================================
  // Post-processing pipeline
  // ==========================================================================

  /** @private */
  _setupPostProcessing() {
    const w = this._canvas.clientWidth || 800;
    const h = this._canvas.clientHeight || 600;

    this._composer = new EffectComposer(this._renderer);
    this._composer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this._composer.setSize(w, h);

    const renderPass = new RenderPass(this._scene, this._camera);
    this._composer.addPass(renderPass);

    try {
      this._ssaoPass = new SSAOPass(this._scene, this._camera, w, h);
      this._ssaoPass.kernelRadius = 8;
      this._ssaoPass.minDistance = 0.001;
      this._ssaoPass.maxDistance = 0.1;
      this._ssaoPass.output = SSAOPass.OUTPUT.Default;
      this._composer.addPass(this._ssaoPass);
    } catch (e) {
      console.warn('[AvatarScene] SSAO not available:', e.message);
    }

    this._bloomPass = new UnrealBloomPass(
      new THREE.Vector2(w, h), 0.4, 0.6, 0.85
    );
    this._composer.addPass(this._bloomPass);

    try {
      this._bokehPass = new BokehPass(this._scene, this._camera, {
        focus: 1.0, aperture: 0.0001, maxblur: 0.005,
      });
      this._composer.addPass(this._bokehPass);
    } catch (e) {
      console.warn('[AvatarScene] BokehPass not available:', e.message);
    }

    const smaaPass = new SMAAPass(w, h);
    this._composer.addPass(smaaPass);

    this._cinematicPass = this._createCinematicPass();
    this._composer.addPass(this._cinematicPass);

    const outputPass = new OutputPass();
    this._composer.addPass(outputPass);

    console.log('[AvatarScene] PostProcessing pipeline ready');
  }

  /** @private */
  _createCinematicPass() {
    const shader = {
      uniforms: {
        tDiffuse:  { value: null },
        uTime:     { value: 0 },
        uVignette: { value: 0.3 },
        uGrain:    { value: 0.05 },
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
        uniform float uTime;
        uniform float uVignette;
        uniform float uGrain;
        varying vec2 vUv;

        float random(vec2 p) {
          return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
        }

        void main() {
          vec4 color = texture2D(tDiffuse, vUv);
          vec2 centered = vUv - 0.5;
          float dist = length(centered);
          float vignette = smoothstep(0.8, 0.2, dist);
          color.rgb *= mix(1.0, vignette, uVignette);
          float grain = random(vUv + fract(uTime)) * 2.0 - 1.0;
          color.rgb += grain * uGrain;
          color.r *= 1.02;
          color.b *= 0.98;
          gl_FragColor = color;
        }
      `,
    };
    return new ShaderPass(shader);
  }

  /** @private */
  _setupHDRI() {
    const rgbeLoader = new RGBELoader();
    const url = 'https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/1k/studio_small_09_1k.hdr';

    rgbeLoader.load(
      url,
      (texture) => {
        texture.mapping = THREE.EquirectangularReflectionMapping;
        this._scene.environment = texture;
        if (this._avatar) this._applyEnvMapIntensity(1.2);
        console.log('[AvatarScene] HDRI environment loaded');
      },
      undefined,
      (err) => {
        console.warn('[AvatarScene] HDRI load failed, using fallback lighting:', err);
      }
    );
  }

  /** @private */
  _applyEnvMapIntensity(intensity) {
    if (!this._avatar) return;
    this._avatar.traverse((obj) => {
      if (obj.isMesh && obj.material) {
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        for (const m of mats) {
          if (m.envMapIntensity !== undefined) {
            m.envMapIntensity = intensity;
            m.needsUpdate = true;
          }
        }
      }
    });
  }

  // ==========================================================================
  // Avatar loading
  // ==========================================================================

  async loadAvatarFromFile(file) {
    const objectUrl = URL.createObjectURL(file);
    console.log(`[AvatarScene] Loading local file: ${file.name} (${(file.size / 1024 / 1024).toFixed(1)} MB)`);
    try {
      await this._loadGLTF(objectUrl);
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  }

  async loadAvatar(url) {
    let finalUrl = url;
    if (finalUrl.includes('readyplayer.me') && !finalUrl.includes('morphTargets=')) {
      const sep = finalUrl.includes('?') ? '&' : '?';
      finalUrl = `${finalUrl}${sep}morphTargets=ARKit&textureAtlas=1024`;
    }
    console.log('[AvatarScene] Loading URL:', finalUrl);
    await this._loadGLTF(finalUrl);
  }

  /** @private */
  async _loadGLTF(url) {
    if (this._avatar) {
      this._gesture.clear();
      this._scene.remove(this._avatar);
      this._avatar = null;
      this._morphMeshes = [];
      this._headBone = null;
      this._neckBone = null;
    }

    const loader = new GLTFLoader();
    const gltf = await loader.loadAsync(url);
    this._avatar = gltf.scene;
    this._scene.add(this._avatar);

    this._applyMaterialQuality();
    this._collectMorphAndBones();
    this._gesture.registerAvatar(this._avatar);
    this._autoFrameAvatar();

    this._loaded = true;
    console.log(
      `[AvatarScene] Loaded: ${this._morphMeshes.length} morph meshes, ` +
      `head bone: ${this._headBone ? 'yes' : 'no'}`
    );
  }

  /**
   * Auto-frame: choose preset based on model proportions, apply instantly.
   * @private
   */
  _autoFrameAvatar() {
    const box = new THREE.Box3().setFromObject(this._avatar);
    const size = box.getSize(new THREE.Vector3());

    // Heuristic: tall models (robots, full figures) start with fullbody
    const aspect = size.y / Math.max(size.x, 0.01);
    const defaultPreset = aspect > 2.5 ? 'fullbody' : 'upper';
    this.setFramingPreset(defaultPreset);

    // Apply immediately (no animation)
    this._camera.position.copy(this._cameraDesiredPosition);
    this._cameraTarget.copy(this._cameraDesiredTarget);
    this._camera.fov = this._desiredFOV;
    this._camera.updateProjectionMatrix();
    this._camera.lookAt(this._cameraTarget);
    if (this._controls) {
      this._controls.target.copy(this._cameraTarget);
      this._controls.update();
    }

    console.log(
      `[AvatarScene] Auto-framed: preset=${defaultPreset}, ` +
      `aspect=${aspect.toFixed(2)}, size=${size.y.toFixed(2)}m`
    );
  }

  // ==========================================================================
  // Per-frame update
  // ==========================================================================

  update(blendShapes, transformMatrix) {
    if (!this._loaded) {
      this._renderer.render(this._scene, this._camera);
      return;
    }

    // 1. Apply BlendShapes
    this._applyBlendShapes(blendShapes);

    // 2. Head pose
    if (transformMatrix && this._headBone) {
      this._applyHeadPose(transformMatrix);
    }

    // 3. Idle body gesture
    const now = performance.now();
    const gestDt = this._lastGestureTime ? now - this._lastGestureTime : 16;
    this._lastGestureTime = now;
    if (this._poseTracker?.poseDetected && this._poseTracker.worldLandmarks) {
      this._gesture.updateWithPose(gestDt, blendShapes, this._poseTracker.worldLandmarks, this.mirrored);
    } else {
      this._gesture.update(gestDt, blendShapes);
    }

    // 4. Camera smooth lerp
    if (this._cameraDesiredPosition && this._controls) {
      const dist = this._camera.position.distanceTo(this._cameraDesiredPosition);
      if (dist > 0.01 && !this._userInteracting) {
        this._camera.position.lerp(this._cameraDesiredPosition, 0.08);
        this._cameraTarget.lerp(this._cameraDesiredTarget, 0.08);
        this._controls.target.copy(this._cameraTarget);

        if (this._desiredFOV) {
          this._camera.fov += (this._desiredFOV - this._camera.fov) * 0.08;
          this._camera.updateProjectionMatrix();
        }
      }
      this._controls.update();
    }

    // 5. Render

    // 5a. If 3D background scene exists, render it to RenderTarget first
    if (this._bgScene3D && this._bgCamera && this._bgRenderTarget) {
      if (this._bgControls && !this._bgCameraLocked) {
        this._bgControls.update();
      }

      const currentTarget = this._renderer.getRenderTarget();
      this._renderer.setRenderTarget(this._bgRenderTarget);
      this._renderer.clear();
      this._renderer.render(this._bgScene3D, this._bgCamera);
      this._renderer.setRenderTarget(currentTarget);

      // Use the rendered background as the avatar scene's background
      this._scene.background = this._bgRenderTarget.texture;
    }

    // 5b. Render avatar scene
    if (this._composer && this.vfx.enabled) {
      if (this._cinematicPass) {
        this._cinematicPass.uniforms.uTime.value = performance.now() * 0.001;
        this._cinematicPass.uniforms.uVignette.value = this.vfx.vignette;
        this._cinematicPass.uniforms.uGrain.value = this.vfx.filmGrain;
      }
      if (this._bloomPass) {
        this._bloomPass.strength = this.vfx.bloom;
      }
      if (this._bokehPass) {
        const camDist = this._camera.position.distanceTo(this._cameraTarget);
        this._bokehPass.uniforms.focus.value = camDist;
        this._bokehPass.uniforms.aperture.value = this.vfx.dof * 0.0001;
      }
      this._composer.render();
    } else {
      this._renderer.render(this._scene, this._camera);
    }
  }

  // ==========================================================================
  // BlendShapes & Head Pose
  // ==========================================================================

  /** @private */
  _applyBlendShapes(blendShapes) {
    if (!blendShapes || Object.keys(blendShapes).length === 0) return;
    const alpha = 1 - this.smoothing;

    for (const mesh of this._morphMeshes) {
      const dict = mesh.morphTargetDictionary;
      const influences = mesh.morphTargetInfluences;

      for (const [name, score] of Object.entries(blendShapes)) {
        let targetName = name;
        if (this.mirrored) {
          if (name.endsWith('Left')) targetName = name.replace('Left', 'Right');
          else if (name.endsWith('Right')) targetName = name.replace('Right', 'Left');
        }

        const idx = dict[targetName];
        if (idx === undefined) continue;

        const prev = influences[idx];
        influences[idx] = prev + (score - prev) * alpha;
      }
    }
  }

  /** @private */
  _applyHeadPose(matrixData) {
    const m = new THREE.Matrix4().fromArray(matrixData);
    const targetEuler = new THREE.Euler().setFromRotationMatrix(m, 'YXZ');

    let yaw = targetEuler.y;
    let pitch = targetEuler.x;
    let roll = targetEuler.z;

    if (this.mirrored) {
      yaw = -yaw;
      roll = -roll;
    }

    yaw *= this.headStrength;
    pitch *= this.headStrength;
    roll *= this.headStrength;

    yaw = THREE.MathUtils.clamp(yaw, -0.7, 0.7);
    pitch = THREE.MathUtils.clamp(pitch, -0.5, 0.5);
    roll = THREE.MathUtils.clamp(roll, -0.4, 0.4);

    const headAlpha = 0.3;
    this._smoothedHeadRot.x += (pitch - this._smoothedHeadRot.x) * headAlpha;
    this._smoothedHeadRot.y += (yaw - this._smoothedHeadRot.y) * headAlpha;
    this._smoothedHeadRot.z += (roll - this._smoothedHeadRot.z) * headAlpha;

    this._headBone.rotation.x = this._smoothedHeadRot.x;
    this._headBone.rotation.y = this._smoothedHeadRot.y;
    this._headBone.rotation.z = this._smoothedHeadRot.z;
  }

  // ==========================================================================
  // Utility
  // ==========================================================================

  getStream(fps = 30) {
    return this._canvas.captureStream(fps);
  }

  // ==========================================================================
  // Idle Gesture API — v7
  // ==========================================================================

  setGestureEnabled(enabled) { this._gesture.enabled = !!enabled; }
  setGestureIntensity(value) { this._gesture.intensity = Math.max(0, Math.min(2, value)); }
  get gestureIntensity() { return this._gesture.intensity; }

  setPoseTracker(tracker) { this._poseTracker = tracker; }

  // ==========================================================================
  // Internal helpers (v8 refactor)
  // ==========================================================================

  /** @private */
  _applyMaterialQuality() {
    if (!this._avatar) return;
    this._avatar.traverse((obj) => {
      if (obj.isMesh) {
        obj.castShadow = true;
        obj.receiveShadow = true;
        if (obj.material) {
          const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
          for (const m of mats) {
            if (m.envMapIntensity !== undefined) m.envMapIntensity = 1.2;
            if (m.map) m.map.colorSpace = THREE.SRGBColorSpace;
            if (obj.name && /head|skin|body/i.test(obj.name)) {
              if (m.roughness !== undefined) m.roughness = 0.65;
              if (m.metalness !== undefined) m.metalness = 0.0;
            }
            m.needsUpdate = true;
          }
        }
      }
    });
  }

  /** @private */
  _collectMorphAndBones() {
    if (!this._avatar) return;
    this._morphMeshes = [];
    this._headBone = null;
    this._neckBone = null;

    this._avatar.traverse((obj) => {
      if (obj.isMesh && obj.morphTargetDictionary) {
        this._morphMeshes.push(obj);
        console.log(
          `[AvatarScene] Mesh "${obj.name}" — ${Object.keys(obj.morphTargetDictionary).length} morph targets`
        );
      }
      if (obj.isBone || obj.type === 'Bone') {
        const n = obj.name.toLowerCase();
        if (obj.name === 'Head' || n === 'head' || n.includes('head')) {
          if (!this._headBone) this._headBone = obj;
        }
        if (obj.name === 'Neck' || n === 'neck' || n.includes('neck')) {
          if (!this._neckBone) this._neckBone = obj;
        }
      }
    });

    if (this._morphMeshes.length === 0) {
      console.warn('[AvatarScene] WARNING: No morph targets found!');
    }
    if (!this._headBone) {
      console.warn('[AvatarScene] WARNING: Head bone not found');
    }
  }

  // ==========================================================================
  // Background API (v8/v9/v10)
  // ==========================================================================

  /**
   * Set solid color background.
   * @param {string|number} color
   */
  setBackgroundColor(color) {
    this._clearAllBackgrounds();
    this._scene.background = new THREE.Color(color);
    this._bgMode = 'color';
  }

  /**
   * Set HDRI as the background (spherical).
   * @param {string} url - URL to .hdr file
   */
  async setBackgroundHDRI(url) {
    this._clearAllBackgrounds();
    return new Promise((resolve, reject) => {
      new RGBELoader().load(
        url,
        (texture) => {
          texture.mapping = THREE.EquirectangularReflectionMapping;
          this._scene.background = texture;
          if (!this._scene.environment) {
            this._scene.environment = texture;
          }
          this._bgMode = 'hdri';
          console.log('[AvatarScene] HDRI background loaded:', url);
          resolve();
        },
        undefined,
        (err) => {
          console.warn('[AvatarScene] HDRI load failed:', err);
          reject(err);
        }
      );
    });
  }

  /**
   * Set a 2D image as the background.
   * @param {string|File} source
   */
  async setBackgroundImage(source) {
    const url = source instanceof File ? URL.createObjectURL(source) : source;

    return new Promise((resolve, reject) => {
      new THREE.TextureLoader().load(
        url,
        (texture) => {
          texture.colorSpace = THREE.SRGBColorSpace;
          this._clearAllBackgrounds();
          this._createBackgroundPlane(texture);
          this._bgMode = 'image';
          this._scene.background = new THREE.Color(0x000000);
          if (source instanceof File) URL.revokeObjectURL(url);
          console.log('[AvatarScene] Image background set');
          resolve();
        },
        undefined,
        reject
      );
    });
  }

  /**
   * Set a video as the background.
   * @param {string|File} source
   */
  async setBackgroundVideo(source) {
    const url = source instanceof File ? URL.createObjectURL(source) : source;

    const video = document.createElement('video');
    video.src = url;
    video.crossOrigin = 'anonymous';
    video.loop = true;
    video.muted = true;
    video.playsInline = true;
    video.autoplay = true;

    await new Promise((resolve, reject) => {
      video.addEventListener('loadeddata', resolve, { once: true });
      video.addEventListener('error', reject, { once: true });
    });
    await video.play().catch(() => {});

    const texture = new THREE.VideoTexture(video);
    texture.colorSpace = THREE.SRGBColorSpace;

    this._clearAllBackgrounds();
    this._createBackgroundPlane(texture);
    this._bgResource = video;
    this._bgMode = 'video';
    this._scene.background = new THREE.Color(0x000000);
    console.log('[AvatarScene] Video background set');
  }

  /**
   * Set a 360° equirectangular photo (JPG/PNG) as the spherical background.
   * @param {string|File} source
   */
  async setBackgroundPanorama(source) {
    this._clearAllBackgrounds();

    const url = source instanceof File ? URL.createObjectURL(source) : source;
    const cleanup = () => { if (source instanceof File) URL.revokeObjectURL(url); };

    return new Promise((resolve, reject) => {
      new THREE.TextureLoader().load(
        url,
        (texture) => {
          texture.mapping = THREE.EquirectangularReflectionMapping;
          texture.colorSpace = THREE.SRGBColorSpace;
          texture.minFilter = THREE.LinearFilter;
          texture.magFilter = THREE.LinearFilter;

          this._scene.background = texture;
          this._bgMode = 'panorama';

          cleanup();
          console.log('[AvatarScene] Panorama background loaded');
          resolve();
        },
        undefined,
        (err) => {
          cleanup();
          console.warn('[AvatarScene] Panorama load failed:', err);
          reject(err);
        }
      );
    });
  }

  /**
   * Load a GLB/GLTF file as a 3D background scene.
   * v10: Renders into a SEPARATE scene with its own camera,
   * composited behind the avatar via WebGLRenderTarget.
   * @param {string|File} source
   * @param {Object} [options]
   * @param {number} [options.targetSize=8.0]
   */
  async setBackground3DScene(source, options = {}) {
    this._clearAllBackgrounds();

    const url = source instanceof File ? URL.createObjectURL(source) : source;
    const cleanup = () => { if (source instanceof File) URL.revokeObjectURL(url); };

    try {
      const loader = new GLTFLoader();
      const gltf = await loader.loadAsync(url);
      const sceneGroup = gltf.scene;

      // Create dedicated background scene
      this._bgScene3D = new THREE.Scene();
      this._bgScene3D.background = new THREE.Color(0x101018);

      // Copy IBL environment to BG scene
      if (this._scene.environment) {
        this._bgScene3D.environment = this._scene.environment;
      }

      // Add lights to BG scene (independent from avatar)
      const bgKey = new THREE.DirectionalLight(0xfff4e6, 1.8);
      bgKey.position.set(3, 5, 4);
      this._bgScene3D.add(bgKey);
      const bgFill = new THREE.DirectionalLight(0xc8d8ff, 0.5);
      bgFill.position.set(-3, 2, 2);
      this._bgScene3D.add(bgFill);
      this._bgScene3D.add(new THREE.AmbientLight(0xffffff, 0.3));

      // Auto-frame the model
      sceneGroup.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(sceneGroup);
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());

      const maxDim = Math.max(size.x, size.y, size.z) || 1;
      const targetSize = options.targetSize ?? 8.0;
      const scale = targetSize / maxDim;
      sceneGroup.scale.setScalar(scale);

      // Center at origin, floor at y=0
      sceneGroup.position.set(
        -center.x * scale,
        -box.min.y * scale,
        -center.z * scale,
      );

      // Configure materials
      sceneGroup.traverse((obj) => {
        if (obj.isMesh && obj.material) {
          obj.receiveShadow = true;
          const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
          for (const m of mats) {
            if (m.envMapIntensity !== undefined) m.envMapIntensity = 0.8;
            if (m.map) m.map.colorSpace = THREE.SRGBColorSpace;
            m.needsUpdate = true;
          }
        }
        if (obj.isLight) obj.intensity = 0;
      });

      this._bgScene3D.add(sceneGroup);
      this._bgModelRoot = sceneGroup;

      // Create background camera
      const aspect = this._canvas.clientWidth / this._canvas.clientHeight;
      this._bgCamera = new THREE.PerspectiveCamera(45, aspect, 0.1, 200);

      const scaledSize = size.clone().multiplyScalar(scale);
      const maxScaledDim = Math.max(scaledSize.x, scaledSize.y, scaledSize.z);
      const camDist = maxScaledDim * 1.2;
      this._bgCamera.position.set(0, scaledSize.y * 0.4, camDist);
      this._bgCamera.lookAt(0, scaledSize.y * 0.35, 0);

      // Background OrbitControls (separate from avatar controls)
      this._bgControls = new OrbitControls(this._bgCamera, this._canvas);
      this._bgControls.enableDamping = true;
      this._bgControls.dampingFactor = 0.08;
      this._bgControls.target.set(0, scaledSize.y * 0.35, 0);
      this._bgControls.enabled = true;
      this._bgCameraLocked = false;

      // Disable avatar OrbitControls while BG is being positioned
      if (this._controls) this._controls.enabled = false;

      this._bgMode = '3dscene';

      cleanup();
      console.log(
        `[AvatarScene] 3D BG scene loaded into separate scene ` +
        `(scale ${scale.toFixed(2)}x). Use lockBgCamera() when done positioning.`
      );
    } catch (err) {
      cleanup();
      console.error('[AvatarScene] 3D scene load failed:', err);
      throw err;
    }
  }

  /** Lock the background camera position. Re-enables avatar OrbitControls. */
  lockBgCamera() {
    if (this._bgControls) this._bgControls.enabled = false;
    this._bgCameraLocked = true;
    if (this._controls) this._controls.enabled = true;
    console.log('[AvatarScene] BG camera locked');
  }

  /** Unlock the background camera for repositioning. */
  unlockBgCamera() {
    if (this._bgControls) this._bgControls.enabled = true;
    this._bgCameraLocked = false;
    if (this._controls) this._controls.enabled = false;
    console.log('[AvatarScene] BG camera unlocked for repositioning');
  }

  /** @type {boolean} */
  get isBgCameraLocked() { return this._bgCameraLocked; }

  // ==========================================================================
  // Background helpers
  // ==========================================================================

  /** @private */
  _createBackgroundPlane(texture) {
    const distanceFromCamera = 5.0;
    const vFov = (this._camera.fov * Math.PI) / 180;
    const height = 2 * Math.tan(vFov / 2) * distanceFromCamera;
    const aspect = texture.image
      ? (texture.image.videoWidth || texture.image.width) /
        (texture.image.videoHeight || texture.image.height)
      : 16 / 9;
    const width = Math.max(height * aspect, height * 1.78);

    const geom = new THREE.PlaneGeometry(width * 1.5, height * 1.5);
    const mat = new THREE.MeshBasicMaterial({
      map: texture,
      depthWrite: false,
      toneMapped: false,
    });
    this._bgPlane = new THREE.Mesh(geom, mat);
    this._bgPlane.position.set(0, 1.4, -3.0);
    this._bgPlane.renderOrder = -1;
    this._scene.add(this._bgPlane);
  }

  /**
   * Clear ALL background resources.
   * @private
   */
  _clearAllBackgrounds() {
    // 1. Plane mesh
    if (this._bgPlane) {
      this._scene.remove(this._bgPlane);
      this._bgPlane.geometry.dispose();
      if (this._bgPlane.material.map) this._bgPlane.material.map.dispose();
      this._bgPlane.material.dispose();
      this._bgPlane = null;
    }

    // 2. Video resource
    if (this._bgResource && this._bgResource.tagName === 'VIDEO') {
      try {
        this._bgResource.pause();
        this._bgResource.src = '';
        this._bgResource.load();
      } catch (e) { /* ignore */ }
    }
    this._bgResource = null;

    // 3. 3D scene background (v10: separate scene)
    if (this._bgScene3D) {
      this._bgScene3D.traverse((obj) => {
        if (obj.geometry) obj.geometry.dispose();
        if (obj.material) {
          const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
          for (const m of mats) {
            for (const key of ['map', 'normalMap', 'roughnessMap', 'metalnessMap',
                                'aoMap', 'emissiveMap', 'alphaMap']) {
              if (m[key]?.dispose) m[key].dispose();
            }
            m.dispose();
          }
        }
      });
      this._bgScene3D = null;
      this._bgModelRoot = null;
    }
    if (this._bgControls) {
      this._bgControls.dispose();
      this._bgControls = null;
    }
    this._bgCamera = null;
    this._bgCameraLocked = false;

    // Re-enable avatar controls
    if (this._controls) this._controls.enabled = true;

    // 4. Equirect texture (panorama / HDRI background)
    if (this._scene.background && this._scene.background.dispose) {
      if (this._scene.background !== this._scene.environment) {
        try { this._scene.background.dispose(); } catch (e) { /* ignore */ }
      }
    }
    this._scene.background = null;
  }

  /** Preset HDRI list */
  get BACKGROUND_PRESETS() {
    return [
      { name: 'ダークスタジオ', mode: 'color', value: 0x101018 },
      { name: 'スタジオ (中性)', mode: 'hdri',
        url: 'https://cdn.jsdelivr.net/gh/google/model-viewer@master/packages/shared-assets/environments/neutral_1k.hdr' },
      { name: 'フォトスタジオ', mode: 'hdri',
        url: 'https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/1k/studio_small_09_1k.hdr' },
      { name: '夕焼け', mode: 'hdri',
        url: 'https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/1k/venice_sunset_1k.hdr' },
      { name: '夜の街', mode: 'hdri',
        url: 'https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/1k/moonless_golf_1k.hdr' },
    ];
  }
}
