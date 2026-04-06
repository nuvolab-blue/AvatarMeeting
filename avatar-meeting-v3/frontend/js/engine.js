/**
 * @fileoverview Main orchestrator — drives AudioAnalyzer + MeshWarpEngine
 * + SimpleFaceTracker in a requestAnimationFrame loop.
 */

/** Emotion → facial expression mapping */
const EMOTION_MAP = {
  joy:      { mouthCorner: 0.32, leftBrowRaise: 0.12, rightBrowRaise: 0.12, eyeWiden: 0.05 },
  anger:    { mouthCorner: -0.18, browFurrow: 0.38, leftBrowRaise: -0.12, rightBrowRaise: -0.12 },
  sadness:  { mouthCorner: -0.14, leftBrowRaise: 0.16, rightBrowRaise: 0.06, eyeWiden: -0.05 },
  surprise: { leftBrowRaise: 0.38, rightBrowRaise: 0.38, eyeWiden: 0.28 },
  fear:     { mouthCorner: -0.06, leftBrowRaise: 0.28, rightBrowRaise: 0.28, eyeWiden: 0.22 },
  neutral:  {},
};

const EMOTION_KEYS = ['mouthCorner', 'leftBrowRaise', 'rightBrowRaise', 'browFurrow', 'eyeWiden'];

class Engine {
  /**
   * @param {HTMLCanvasElement} canvas
   */
  constructor(canvas) {
    /** @private */ this._canvas = canvas;

    /** @type {AudioAnalyzer} */
    this.audio = new AudioAnalyzer();

    /** @type {MeshWarpEngine|null} */
    this.warp = null;

    /** @private */ this._tracker = null;
    /** @private */ this._avatarImage = null;

    /** @private */ this._running = false;
    /** @private */ this._rafId = null;
    /** @private */ this._lastTime = 0;

    // FPS
    /** @type {number} */ this.fps = 0;
    /** @private */ this._fpsFrames = 0;
    /** @private */ this._fpsTime = 0;

    // Head pose (from tracker)
    /** @private */ this._headPose = { yaw: 0, pitch: 0, roll: 0 };
    /** @private */ this._targetHeadPose = { yaw: 0, pitch: 0, roll: 0 };

    // Smoothed emotion params
    /** @private */ this._currentEmotionParams = {};

    /** @type {Function|null} */ this.onFPS = null;
    /** @type {Function|null} */ this.onEmotion = null;
  }

  // ==========================================================================
  // Public API
  // ==========================================================================

  /**
   * Load avatar photo and initialise warp engine.
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

    this.warp = new MeshWarpEngine(this._canvas);
    this.warp.init(finalImg);
    this.warp.render(0);

    console.log(`[Engine] Avatar loaded: ${w}x${h}, glasses=${this.warp.hasGlasses}`);
  }

  /**
   * Start audio analysis.
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
   * Start camera tracking.
   * @returns {Promise<boolean>}
   */
  async startCamera() {
    try {
      this._tracker = new SimpleFaceTracker();
      this._tracker.onHeadPose = (pose) => {
        this._targetHeadPose.yaw = pose.yaw;
        this._targetHeadPose.pitch = pose.pitch;
        this._targetHeadPose.roll = pose.roll;
      };
      return await this._tracker.init();
    } catch (err) {
      console.error('[Engine] Camera start failed:', err);
      return false;
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
    if (this._tracker) { this._tracker.stop(); this._tracker = null; }
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
  // Private: animation loop
  // ==========================================================================

  /** @private */
  _animate(now) {
    if (!this._running) return;
    this._rafId = requestAnimationFrame((t) => this._animate(t));

    const dt = now - this._lastTime;
    this._lastTime = now;

    // FPS
    this._fpsFrames++;
    if (now - this._fpsTime >= 1000) {
      this.fps = this._fpsFrames;
      this._fpsFrames = 0;
      this._fpsTime = now;
      if (this.onFPS) this.onFPS(this.fps);
    }

    if (!this.warp) return;

    // 1. Audio update
    this.audio.update();

    // 2. Head pose smoothing
    const ha = 0.12;
    this._headPose.yaw += (this._targetHeadPose.yaw - this._headPose.yaw) * ha;
    this._headPose.pitch += (this._targetHeadPose.pitch - this._headPose.pitch) * ha;
    this._headPose.roll += (this._targetHeadPose.roll - this._headPose.roll) * ha;

    // 3. Viseme
    const v = this.audio.currentViseme;

    // 4. Emotion → expression
    const em = this.audio.audioEmotion;
    const emap = EMOTION_MAP[em.emotion] || {};
    for (const key of EMOTION_KEYS) {
      const target = (emap[key] || 0) * em.intensity;
      const prev = this._currentEmotionParams[key] || 0;
      this._currentEmotionParams[key] = prev * 0.88 + target * 0.12;
    }

    // 5. Compose deformation
    const d = this.warp.deform;
    d.jawOpen = v.jawOpen;
    d.lipStretch = v.lipStretch;
    d.lipPucker = v.lipPucker;
    d.mouthCorner = this._currentEmotionParams.mouthCorner || 0;
    d.leftBrowRaise = this._currentEmotionParams.leftBrowRaise || 0;
    d.rightBrowRaise = this._currentEmotionParams.rightBrowRaise || 0;
    d.browFurrow = this._currentEmotionParams.browFurrow || 0;
    d.eyeWiden = this._currentEmotionParams.eyeWiden || 0;
    d.leftEyeOpen = 1;
    d.rightEyeOpen = 1;
    d.yaw = this._headPose.yaw;
    d.pitch = this._headPose.pitch;
    d.roll = this._headPose.roll;

    // 6. Render
    this.warp.render(dt);

    // 7. Emotion callback
    if (em.intensity > 0.08 && this.onEmotion) {
      this.onEmotion(em);
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
