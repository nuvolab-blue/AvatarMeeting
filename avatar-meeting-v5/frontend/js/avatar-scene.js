/**
 * @fileoverview Three.js scene for Ready Player Me 3D avatar rendering.
 *
 * Loads a Ready Player Me .glb avatar with ARKit morph targets,
 * applies MediaPipe BlendShape coefficients and head pose every frame.
 *
 * Architecture:
 *   GLTFLoader → traverse meshes for morphTargetDictionary
 *   → every frame: morphTargetInfluences[i] = smoothed score
 *   → headBone.rotation = smoothed Euler from 4x4 matrix
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

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
    /** @type {number} BlendShape smoothing (0=instant, 1=frozen) */
    this.smoothing = 0.5;
    /** @type {number} Head pose strength multiplier */
    this.headStrength = 1.0;
    /** @type {boolean} Mirror mode (for selfie camera) */
    this.mirrored = true;

    // Internal smoothing state
    /** @private */
    this._smoothedHeadRot = new THREE.Euler();
    /** @private */
    this._loaded = false;

    this._init();
  }

  /**
   * Initialize Three.js renderer, scene, camera, and lighting.
   * @private
   */
  _init() {
    // ----- Renderer -----
    this._renderer = new THREE.WebGLRenderer({
      canvas: this._canvas,
      antialias: true,
      alpha: true,
      preserveDrawingBuffer: true  // Required for captureStream
    });
    this._renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this._renderer.outputColorSpace = THREE.SRGBColorSpace;
    this._renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this._renderer.toneMappingExposure = 1.1;
    this._resize();

    // ----- Scene -----
    this._scene = new THREE.Scene();
    this._scene.background = new THREE.Color(0x101018);

    // ----- Camera (portrait framing for upper body) -----
    this._camera = new THREE.PerspectiveCamera(
      30,  // Narrow FOV for portrait-like framing
      this._canvas.clientWidth / this._canvas.clientHeight,
      0.1,
      100
    );
    // Default position (adjusted after avatar load)
    this._camera.position.set(0, 1.55, 1.0);
    this._camera.lookAt(0, 1.55, 0);

    // ----- 3-point portrait lighting -----
    // Key light: front-left, warm
    const keyLight = new THREE.DirectionalLight(0xfff4e6, 1.5);
    keyLight.position.set(2, 3, 4);
    this._scene.add(keyLight);

    // Fill light: front-right, cool
    const fillLight = new THREE.DirectionalLight(0xe6f0ff, 0.6);
    fillLight.position.set(-2, 1.5, 3);
    this._scene.add(fillLight);

    // Rim light: behind, separates subject from background
    const rimLight = new THREE.DirectionalLight(0xffffff, 1.0);
    rimLight.position.set(0, 2, -3);
    this._scene.add(rimLight);

    // Ambient: overall fill
    this._scene.add(new THREE.AmbientLight(0xffffff, 0.3));

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
  }

  /**
   * Load a Ready Player Me .glb avatar.
   * Automatically appends ?morphTargets=ARKit if missing.
   * @param {string} url - Ready Player Me .glb URL
   * @returns {Promise<void>}
   */
  async loadAvatar(url) {
    // Append morphTargets=ARKit for Ready Player Me URLs only
    let finalUrl = url;
    if (finalUrl.includes('readyplayer.me') && !finalUrl.includes('morphTargets=')) {
      const sep = finalUrl.includes('?') ? '&' : '?';
      finalUrl = `${finalUrl}${sep}morphTargets=ARKit&textureAtlas=1024`;
    }

    console.log('[AvatarScene] Loading:', finalUrl);

    // Remove existing avatar
    if (this._avatar) {
      this._scene.remove(this._avatar);
      this._avatar = null;
      this._morphMeshes = [];
      this._headBone = null;
      this._neckBone = null;
    }

    // Load glTF
    const loader = new GLTFLoader();
    const gltf = await loader.loadAsync(finalUrl);
    this._avatar = gltf.scene;
    this._scene.add(this._avatar);

    // ----- Traverse avatar to collect morph meshes and bones -----
    this._avatar.traverse((obj) => {
      // Meshes with morph targets (Wolf3D_Head, Wolf3D_Teeth, EyeLeft, EyeRight, etc.)
      if (obj.isMesh && obj.morphTargetDictionary) {
        this._morphMeshes.push(obj);
        console.log(
          `[AvatarScene] Mesh "${obj.name}" — ${Object.keys(obj.morphTargetDictionary).length} morph targets`
        );
      }
      // Bones (Ready Player Me / Mixamo / generic naming)
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
      console.warn(
        '[AvatarScene] WARNING: No morph targets found! ' +
        'Ensure avatar URL includes ?morphTargets=ARKit'
      );
    }
    if (!this._headBone) {
      console.warn('[AvatarScene] WARNING: Head bone not found');
    }

    // ----- Frame camera to upper body -----
    this._frameUpperBody();

    this._loaded = true;
    console.log(
      `[AvatarScene] Loaded: ${this._morphMeshes.length} morph meshes, ` +
      `head bone: ${this._headBone ? 'yes' : 'no'}`
    );
  }

  /**
   * Position camera to nicely frame the avatar's upper body.
   * @private
   */
  _frameUpperBody() {
    const box = new THREE.Box3().setFromObject(this._avatar);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());

    // Face center is near the top of the bounding box
    const faceY = box.max.y - size.y * 0.12;

    // FOV 30, distance ~0.85m frames head+shoulders nicely
    this._camera.position.set(0, faceY - 0.05, 0.85);
    this._camera.lookAt(0, faceY - 0.08, 0);

    console.log(`[AvatarScene] Camera framed: faceY=${faceY.toFixed(3)}, size=${size.y.toFixed(3)}`);
  }

  /**
   * Per-frame update. Apply BlendShapes and head pose, then render.
   * @param {Object<string, number>} blendShapes - 52 ARKit BlendShapes from MediaPipe
   * @param {Float32Array|null} transformMatrix - 4x4 head pose matrix
   */
  update(blendShapes, transformMatrix) {
    if (!this._loaded) {
      this._renderer.render(this._scene, this._camera);
      return;
    }

    // 1. Apply BlendShapes to all morph meshes
    this._applyBlendShapes(blendShapes);

    // 2. Apply head pose to head bone
    if (transformMatrix && this._headBone) {
      this._applyHeadPose(transformMatrix);
    }

    // 3. Render
    this._renderer.render(this._scene, this._camera);
  }

  /**
   * Apply MediaPipe ARKit BlendShapes to Three.js morph targets.
   * Handles mirroring (Left/Right swap for selfie camera) and smoothing.
   * @private
   */
  _applyBlendShapes(blendShapes) {
    if (!blendShapes || Object.keys(blendShapes).length === 0) return;
    const alpha = 1 - this.smoothing; // smoothing=0 → alpha=1 (instant)

    for (const mesh of this._morphMeshes) {
      const dict = mesh.morphTargetDictionary;
      const influences = mesh.morphTargetInfluences;

      for (const [name, score] of Object.entries(blendShapes)) {
        // Mirror processing: swap Left/Right for selfie camera
        let targetName = name;
        if (this.mirrored) {
          if (name.endsWith('Left')) targetName = name.replace('Left', 'Right');
          else if (name.endsWith('Right')) targetName = name.replace('Right', 'Left');
        }

        const idx = dict[targetName];
        if (idx === undefined) continue;

        // Exponential moving average smoothing
        const prev = influences[idx];
        influences[idx] = prev + (score - prev) * alpha;
      }
    }
  }

  /**
   * Extract rotation from MediaPipe's 4x4 transform matrix and apply to head bone.
   * @private
   */
  _applyHeadPose(matrixData) {
    // MediaPipe returns column-major Float32Array (16 elements)
    const m = new THREE.Matrix4().fromArray(matrixData);
    const targetEuler = new THREE.Euler().setFromRotationMatrix(m, 'YXZ');

    let yaw = targetEuler.y;
    let pitch = targetEuler.x;
    let roll = targetEuler.z;

    // Mirror: flip yaw and roll for selfie camera
    if (this.mirrored) {
      yaw = -yaw;
      roll = -roll;
    }

    // Apply strength multiplier
    yaw *= this.headStrength;
    pitch *= this.headStrength;
    roll *= this.headStrength;

    // Clamp to prevent extreme angles
    yaw = THREE.MathUtils.clamp(yaw, -0.7, 0.7);    // ~40 degrees
    pitch = THREE.MathUtils.clamp(pitch, -0.5, 0.5);  // ~29 degrees
    roll = THREE.MathUtils.clamp(roll, -0.4, 0.4);    // ~23 degrees

    // Smooth head rotation (alpha=0.3 for natural feel)
    const headAlpha = 0.3;
    this._smoothedHeadRot.x += (pitch - this._smoothedHeadRot.x) * headAlpha;
    this._smoothedHeadRot.y += (yaw - this._smoothedHeadRot.y) * headAlpha;
    this._smoothedHeadRot.z += (roll - this._smoothedHeadRot.z) * headAlpha;

    // Apply to bone
    this._headBone.rotation.x = this._smoothedHeadRot.x;
    this._headBone.rotation.y = this._smoothedHeadRot.y;
    this._headBone.rotation.z = this._smoothedHeadRot.z;
  }

  /**
   * Get canvas as MediaStream for virtual camera.
   * @param {number} fps
   * @returns {MediaStream}
   */
  getStream(fps = 30) {
    return this._canvas.captureStream(fps);
  }
}
