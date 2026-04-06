/**
 * @fileoverview Main orchestrator — drives AudioAnalyzer + FaceRegionDeformer
 * in a requestAnimationFrame loop.
 *
 * Combines:
 *  - Audio Viseme → mouth deformation
 *  - Audio emotion → facial expression mapping
 *  - Camera head pose → yaw/pitch/roll (optional)
 *  - Idle animation delegated to FaceRegionDeformer
 */

import AudioAnalyzer from './audio-analyzer.js';
import FaceRegionDeformer from './face-region-deformer.js';

/** Emotion → facial expression parameter mapping */
const EMOTION_MAP = {
  joy:      { mouthCorner: 0.32, leftBrowRaise: 0.12, rightBrowRaise: 0.12, eyeWiden: 0.05 },
  anger:    { mouthCorner: -0.18, browFurrow: 0.38, leftBrowRaise: -0.12, rightBrowRaise: -0.12 },
  sadness:  { mouthCorner: -0.14, leftBrowRaise: 0.16, rightBrowRaise: 0.06, eyeWiden: -0.05 },
  surprise: { leftBrowRaise: 0.38, rightBrowRaise: 0.38, eyeWiden: 0.28 },
  fear:     { mouthCorner: -0.06, leftBrowRaise: 0.28, rightBrowRaise: 0.28, eyeWiden: 0.22 },
  neutral:  {},
};

class FaceEngine {
  /**
   * @param {HTMLCanvasElement} canvas
   */
  constructor(canvas) {
    /** @private */ this._canvas = canvas;

    /** @type {AudioAnalyzer} */
    this.audio = new AudioAnalyzer();

    /** @type {FaceRegionDeformer|null} */
    this.deformer = null;

    /** @private {HTMLImageElement|null} */
    this._avatarImage = null;

    /** @private */ this._running = false;
    /** @private */ this._rafId = null;
    /** @private */ this._lastTime = 0;

    // FPS calculation
    /** @type {number} */ this.fps = 0;
    /** @private */ this._fpsFrames = 0;
    /** @private */ this._fpsTime = 0;

    // Head pose (from camera tracker)
    /** @private */ this._headPose = { yaw: 0, pitch: 0, roll: 0 };
    /** @private */ this._targetHeadPose = { yaw: 0, pitch: 0, roll: 0 };

    // Smoothed emotion parameters
    /** @private */ this._currentEmotionParams = {};
    /** @private */ this._lastEmotion = 'neutral';

    // Callbacks
    /** @type {Function|null} FPS update callback (fps: number) */
    this.onFPS = null;
    /** @type {Function|null} Emotion change callback ({emotion, intensity}) */
    this.onEmotion = null;
  }

  // ==========================================================================
  // Public API
  // ==========================================================================

  /**
   * Load avatar photo and initialize deformer.
   * @param {File|Blob|string|HTMLImageElement} imageSource
   * @returns {Promise<void>}
   */
  async loadAvatar(imageSource) {
    const img = await this._loadImage(imageSource);
    this._avatarImage = img;

    // Limit canvas size for performance
    const maxDim = 640;
    let w = img.naturalWidth || img.width;
    let h = img.naturalHeight || img.height;
    if (w > maxDim || h > maxDim) {
      const scale = maxDim / Math.max(w, h);
      w = Math.round(w * scale);
      h = Math.round(h * scale);
    }

    // Resize image if needed
    if (w !== (img.naturalWidth || img.width) || h !== (img.naturalHeight || img.height)) {
      const tmp = document.createElement('canvas');
      tmp.width = w;
      tmp.height = h;
      tmp.getContext('2d').drawImage(img, 0, 0, w, h);
      const resized = new Image();
      resized.src = tmp.toDataURL();
      await new Promise((resolve) => { resized.onload = resolve; });
      this._avatarImage = resized;
    }

    this._canvas.width = w;
    this._canvas.height = h;

    this.deformer = new FaceRegionDeformer(this._canvas, this._avatarImage);
    this.deformer.init();

    // Initial render
    this.deformer.render(0);

    console.log('[FaceEngine] Avatar loaded: %dx%d, glasses=%s', w, h, this.deformer.hasGlasses);
  }

  /**
   * Initialize microphone and start audio analysis.
   * @returns {Promise<boolean>}
   */
  async startAudio() {
    try {
      const ok = await this.audio.init();
      if (ok) console.log('[FaceEngine] Audio started');
      return ok;
    } catch (err) {
      console.error('[FaceEngine] Audio start failed:', err);
      return false;
    }
  }

  /**
   * Initialize camera for head tracking (optional).
   * @param {import('./face-tracker.js').default} tracker
   * @returns {Promise<boolean>}
   */
  async startCamera(tracker) {
    if (!tracker) return false;
    try {
      const ok = await tracker.init();
      if (!ok) return false;

      tracker.onHeadPose = (pose) => {
        this._targetHeadPose.yaw = pose.yaw;
        this._targetHeadPose.pitch = pose.pitch;
        this._targetHeadPose.roll = pose.roll;
      };

      if (tracker.onLandmarks) {
        tracker.onLandmarks = (lm) => {
          if (this.deformer) this.deformer.updateLandmarks(lm);
        };
      }

      console.log('[FaceEngine] Camera started');
      return true;
    } catch (err) {
      console.error('[FaceEngine] Camera start failed:', err);
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
    console.log('[FaceEngine] Animation started');
  }

  /** Stop everything. */
  stop() {
    this._running = false;
    if (this._rafId) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
    this.audio.stop();
    console.log('[FaceEngine] Stopped');
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
  // Private: Main animation loop
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

    if (!this.deformer) return;

    // 1. Update audio
    this.audio.update();

    // 2. Smooth head pose (from camera)
    const hAlpha = 0.12;
    this._headPose.yaw += (this._targetHeadPose.yaw - this._headPose.yaw) * hAlpha;
    this._headPose.pitch += (this._targetHeadPose.pitch - this._headPose.pitch) * hAlpha;
    this._headPose.roll += (this._targetHeadPose.roll - this._headPose.roll) * hAlpha;

    // 3. Get viseme from audio
    const v = this.audio.currentViseme;

    // 4. Get emotion and map to expression params
    const em = this.audio.audioEmotion;
    const emap = EMOTION_MAP[em.emotion] || {};

    for (const key of Object.keys(EMOTION_MAP.joy)) {
      const target = (emap[key] || 0) * em.intensity;
      const prev = this._currentEmotionParams[key] || 0;
      this._currentEmotionParams[key] = prev * 0.88 + target * 0.12;
    }

    // 5. Compose deformation
    this.deformer.setDeformation({
      jawOpen: v.jawOpen,
      lipStretch: v.lipStretch,
      lipPucker: v.lipPucker,
      mouthWidth: v.mouthWidth,
      mouthCorner: this._currentEmotionParams.mouthCorner || 0,
      leftBrowRaise: this._currentEmotionParams.leftBrowRaise || 0,
      rightBrowRaise: this._currentEmotionParams.rightBrowRaise || 0,
      browFurrow: this._currentEmotionParams.browFurrow || 0,
      eyeWiden: this._currentEmotionParams.eyeWiden || 0,
      leftEyeOpen: 1,
      rightEyeOpen: 1,
      yaw: this._headPose.yaw,
      pitch: this._headPose.pitch,
      roll: this._headPose.roll,
    });

    // 6. Render
    this.deformer.render(dt);

    // 7. Emotion callback
    if (em.intensity > 0.08 && this.onEmotion) {
      this.onEmotion(em);
    }
  }

  // ==========================================================================
  // Private: Image loading
  // ==========================================================================

  /**
   * @private
   * @param {File|Blob|string|HTMLImageElement} src
   * @returns {Promise<HTMLImageElement>}
   */
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
        if (src instanceof File || src instanceof Blob) {
          URL.revokeObjectURL(img.src);
        }
        resolve(img);
      };
      img.onerror = () => reject(new Error('Image load failed'));
    });
  }
}

export default FaceEngine;

if (typeof window !== 'undefined') {
  window.FaceEngine = FaceEngine;
}
