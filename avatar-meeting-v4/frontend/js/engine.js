/**
 * @fileoverview Main orchestrator — drives WebGLWarp + FaceCapture/AudioAnalyzer
 * + BlendShapeDriver + IdleAnimator in a requestAnimationFrame loop.
 *
 * v4 architecture:
 *   Camera ON  → FaceCapture.blendShapes → BlendShapeDriver → WebGLWarp (GPU)
 *   Camera OFF → AudioAnalyzer.toBlendShapes() → BlendShapeDriver → WebGLWarp (GPU)
 */

class Engine {
  /**
   * @param {HTMLCanvasElement} canvas
   */
  constructor(canvas) {
    /** @private */ this._canvas = canvas;

    /** @type {WebGLWarp|null} */ this.warp = null;
    /** @type {AudioAnalyzer} */ this.audio = new AudioAnalyzer();
    /** @type {FaceCapture|null} */ this.faceCapture = null;
    /** @type {BlendShapeDriver|null} */ this.driver = null;
    /** @type {IdleAnimator} */ this.idle = new IdleAnimator();

    /** @private */ this._running = false;
    /** @private */ this._rafId = null;
    /** @private */ this._lastTime = 0;

    // FPS
    /** @type {number} */ this.fps = 0;
    /** @private */ this._fpsFrames = 0;
    /** @private */ this._fpsTime = 0;

    // Smoothed head pose
    /** @private */ this._headPose = { yaw: 0, pitch: 0, roll: 0 };

    // Settings
    /** @type {boolean} */ this.hasGlasses = false;
    /** @type {number} */ this.headPoseSmoothing = 0.15;

    // Callbacks
    /** @type {Function|null} */ this.onFPS = null;
    /** @type {Function|null} */ this.onEmotion = null;
    /** @type {Function|null} */ this.onBlendShapes = null;
  }

  // ==========================================================================
  // Public API
  // ==========================================================================

  /**
   * Load avatar photo and initialise WebGL warp engine.
   * @param {File|Blob|string|HTMLImageElement} imageSource
   * @returns {Promise<void>}
   */
  async loadAvatar(imageSource) {
    const img = await this._loadImage(imageSource);

    // Limit size for performance
    const maxDim = 640;
    let w = img.naturalWidth || img.width;
    let h = img.naturalHeight || img.height;
    if (w > maxDim || h > maxDim) {
      const scale = maxDim / Math.max(w, h);
      w = Math.round(w * scale);
      h = Math.round(h * scale);
    }

    // Resize if needed
    let finalImg = img;
    if (w !== (img.naturalWidth || img.width) || h !== (img.naturalHeight || img.height)) {
      const tmp = document.createElement('canvas');
      tmp.width = w;
      tmp.height = h;
      tmp.getContext('2d').drawImage(img, 0, 0, w, h);
      finalImg = new Image();
      finalImg.src = tmp.toDataURL();
      await new Promise((resolve) => { finalImg.onload = resolve; });
    }

    this._canvas.width = w;
    this._canvas.height = h;

    // Initialize WebGL warp
    this.warp = new WebGLWarp(this._canvas);
    this.warp.init(finalImg);

    // Initialize BlendShape driver
    this.driver = new BlendShapeDriver(WebGLWarp.COLS, WebGLWarp.ROWS, w, h);

    // ★ Detect face in avatar image to set control points
    const faceDetected = await this.driver.detectFace(finalImg);
    console.log(`[Engine] Face detection: ${faceDetected ? 'OK' : 'using defaults'}`);

    // Initial render (zero displacement)
    const zeroDisp = new Float32Array(WebGLWarp.VERTEX_COUNT * 2);
    this.warp.render(zeroDisp, 0);

    console.log(`[Engine] Avatar loaded: ${w}×${h}, WebGL2 GPU rendering`);
  }

  /**
   * Start audio analysis (fallback / emotion display).
   * @returns {Promise<boolean>}
   */
  async startAudio() {
    try {
      return await this.audio.init();
    } catch (err) {
      console.error('[Engine] Audio start failed:', err);
      return false;
    }
  }

  /**
   * Start camera face capture with MediaPipe Face Landmarker.
   * @returns {Promise<boolean>}
   */
  async startCamera() {
    try {
      this.faceCapture = new FaceCapture();
      const ok = await this.faceCapture.init();
      if (ok) {
        this.idle.setCameraBlinkActive(true);
        console.log('[Engine] Camera face capture started — BlendShape mode');
      }
      return ok;
    } catch (err) {
      console.error('[Engine] Camera start failed:', err);
      return false;
    }
  }

  /** Stop camera. */
  stopCamera() {
    if (this.faceCapture) {
      this.faceCapture.stop();
      this.faceCapture = null;
      this.idle.setCameraBlinkActive(false);
    }
  }

  /** Start animation loop. */
  start() {
    if (this._running) return;
    this._running = true;
    this._lastTime = performance.now();
    this._fpsTime = this._lastTime;
    this._fpsFrames = 0;
    this._animate(this._lastTime);
  }

  /** Stop everything. */
  stop() {
    this._running = false;
    if (this._rafId) { cancelAnimationFrame(this._rafId); this._rafId = null; }
    this.audio.stop();
    this.stopCamera();
    if (this.warp) { this.warp.destroy(); this.warp = null; }
  }

  /**
   * Get canvas MediaStream for virtual camera.
   * @param {number} fps
   * @returns {MediaStream}
   */
  getStream(fps = 30) {
    return this._canvas.captureStream(fps);
  }

  // ==========================================================================
  // Private: Animation loop
  // ==========================================================================

  /** @private */
  _animate(now) {
    if (!this._running) return;
    this._rafId = requestAnimationFrame((t) => this._animate(t));

    const dt = now - this._lastTime;
    this._lastTime = now;

    // FPS counter
    this._fpsFrames++;
    if (now - this._fpsTime >= 1000) {
      this.fps = this._fpsFrames;
      this._fpsFrames = 0;
      this._fpsTime = now;
      if (this.onFPS) this.onFPS(this.fps);
    }

    if (!this.warp || !this.driver) return;

    // ---- 1. Get BlendShapes ----
    let bs = {};
    let rawPose = { yaw: 0, pitch: 0, roll: 0 };

    if (this.faceCapture && this.faceCapture.isActive) {
      // ★ Camera mode: use MediaPipe BlendShapes directly
      bs = { ...this.faceCapture.blendShapes };
      rawPose = { ...this.faceCapture.headPose };

      // Audio emotion only (for display, not for deformation)
      if (this.audio.isActive) {
        this.audio.update();
      }
    } else {
      // Fallback: audio-based estimation
      if (this.audio.isActive) {
        this.audio.update();
        bs = this.audio.toBlendShapes();
      }
    }

    // ---- 2. Idle animation ----
    const idleBS = this.idle.update(dt);

    // Merge idle into blendShapes (additive, but blink priority to camera)
    for (const [key, val] of Object.entries(idleBS)) {
      if (key.startsWith('_')) continue; // Skip pose offsets
      if (key === 'eyeBlinkLeft' || key === 'eyeBlinkRight') {
        // Only add idle blink if camera not providing blink
        if (!this.faceCapture || !this.faceCapture.isActive) {
          bs[key] = Math.min((bs[key] || 0) + val, 1.0);
        }
      } else {
        bs[key] = (bs[key] || 0) + val;
      }
    }

    // Idle head pose offsets
    if (this.faceCapture && this.faceCapture.isActive) {
      // Camera + subtle idle
      rawPose.yaw += (idleBS._yawOffset || 0) * 0.3;
      rawPose.pitch += (idleBS._pitchOffset || 0) * 0.3;
      rawPose.roll += (idleBS._rollOffset || 0) * 0.3;
    } else {
      // No camera: idle provides all pose
      rawPose.yaw = idleBS._yawOffset || 0;
      rawPose.pitch = idleBS._pitchOffset || 0;
      rawPose.roll = idleBS._rollOffset || 0;
    }

    // ---- 3. Smooth head pose ----
    const a = this.headPoseSmoothing;
    this._headPose.yaw += (rawPose.yaw - this._headPose.yaw) * a;
    this._headPose.pitch += (rawPose.pitch - this._headPose.pitch) * a;
    this._headPose.roll += (rawPose.roll - this._headPose.roll) * a;

    // ---- 4. Compute vertex displacements ----
    const displacements = this.driver.computeDisplacements(
      bs, this._headPose, this.hasGlasses
    );

    // ---- 5. Render ----
    const mouthOpenness = bs.jawOpen || 0;

    // Update mouth center uniform
    const mc = this.driver.getMouthCenter(bs);
    const gl = this.warp._gl;
    if (gl && this.warp._uMouthCenter) {
      gl.useProgram(this.warp._program);
      gl.uniform2f(this.warp._uMouthCenter, mc.x, mc.y);
    }

    this.warp.render(displacements, mouthOpenness);

    // ---- 6. Callbacks ----
    if (this.onBlendShapes) {
      this.onBlendShapes(bs);
    }
    if (this.onEmotion && this.audio.isActive) {
      const em = this.audio.audioEmotion;
      if (em.intensity > 0.08) {
        this.onEmotion(em);
      }
    }
  }

  // ==========================================================================
  // Image loading
  // ==========================================================================

  /** @private */
  _loadImage(src) {
    return new Promise((resolve, reject) => {
      if (src instanceof HTMLImageElement) {
        if (src.complete) { resolve(src); return; }
        src.onload = () => resolve(src);
        src.onerror = reject;
        return;
      }

      const img = new Image();
      img.crossOrigin = 'anonymous';

      if (src instanceof File || src instanceof Blob) {
        img.src = URL.createObjectURL(src);
      } else if (typeof src === 'string') {
        img.src = src;
      } else {
        reject(new Error('Unsupported image source'));
        return;
      }

      img.onload = () => {
        if (src instanceof File || src instanceof Blob) URL.revokeObjectURL(img.src);
        resolve(img);
      };
      img.onerror = () => reject(new Error('Image load failed'));
    });
  }
}

window.Engine = Engine;
