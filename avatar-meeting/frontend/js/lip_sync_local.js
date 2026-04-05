/**
 * @fileoverview Face deformation controller.
 *
 * Detects face landmarks on the avatar image via MediaPipe FaceMesh,
 * then delegates rendering to WebGLMorph for GPU-accelerated mesh warping.
 * Handles audio → mouth, camera → eyes/brows/mouth, and head pose.
 */

import WebGLMorph from './webgl_morph.js';

class LipSyncLocal {
  constructor() {
    /** @private */ this._morph = new WebGLMorph();
    /** @private */ this._ready = false;
    /** @private */ this._useCameraFeatures = false;

    // Face geometry for head-pose scaling
    /** @private */ this._faceHeight = 0;

    // Smoothed animation values
    /** @private */ this._mouthOpen = 0;
    /** @private */ this._browRaise = 0;
    /** @private */ this._eyeWide = 0;
    /** @private */ this._headX = 0;
    /** @private */ this._headY = 0;

    // Animation targets
    /** @private */ this._tMouth = 0;
    /** @private */ this._tBrow = 0;
    /** @private */ this._tEye = 0;
    /** @private */ this._tHeadX = 0;
    /** @private */ this._tHeadY = 0;

    /** @private */ this._alpha = 0.28; // smoothing factor
  }

  /**
   * Initialise: detect face, build WebGL mesh.
   * @param {HTMLImageElement} avatarImage
   * @returns {Promise<boolean>}
   */
  async init(avatarImage) {
    const h = avatarImage.naturalHeight || avatarImage.height;

    // Detect face landmarks
    const landmarks = await this._detectFace(avatarImage);
    if (landmarks) {
      const forehead = landmarks[10], chin = landmarks[152];
      this._faceHeight = (chin.y - forehead.y) * h;
    } else {
      this._faceHeight = h * 0.55;
    }

    // Build WebGL morph mesh
    const ok = this._morph.init(avatarImage, landmarks);
    if (!ok) {
      console.warn('[LipSync] WebGL morph init failed');
      return false;
    }

    this._ready = true;
    console.log('[LipSync] Ready (faceH=%d)', Math.round(this._faceHeight));
    return true;
  }

  /** @returns {boolean} */
  get isReady() { return this._ready; }

  /**
   * Set mouth open from audio RMS.
   * @param {number} rms 0..1
   */
  setAudioAmplitude(rms) {
    const t = 0.008;
    const mapped = rms < t ? 0 : Math.min(1, (rms - t) * 6);
    const audioMouth = Math.pow(mapped, 1.5);
    if (this._useCameraFeatures) {
      this._tMouth = Math.max(audioMouth, this._tMouth);
    } else {
      this._tMouth = audioMouth;
    }
  }

  /**
   * Set facial features from camera.
   * @param {{mouthOpen:number, browRaise:number, eyeOpen:number}} f
   */
  setFacialFeatures(f) {
    this._useCameraFeatures = true;
    this._tMouth = Math.max(this._tMouth, f.mouthOpen || 0);
    this._tBrow = f.browRaise || 0;
    this._tEye = f.eyeOpen != null ? (f.eyeOpen - 0.5) : 0;
  }

  /**
   * Set head pose (translation only).
   * @param {number} yaw degrees
   * @param {number} pitch degrees
   */
  setHeadPose(yaw, pitch) {
    const maxShift = 0.03; // normalised to image width/height
    this._tHeadX = -(yaw / 45) * maxShift;
    this._tHeadY = (pitch / 45) * maxShift * 0.5;
  }

  /**
   * Render deformed avatar onto the 2D target canvas.
   * @param {CanvasRenderingContext2D} targetCtx
   * @param {number} dx
   * @param {number} dy
   * @param {number} dw
   * @param {number} dh
   */
  render(targetCtx, dx, dy, dw, dh) {
    if (!this._ready) return;

    // Smooth animation
    const a = this._alpha;
    this._mouthOpen += (this._tMouth - this._mouthOpen) * a;
    this._browRaise += (this._tBrow - this._browRaise) * a;
    this._eyeWide   += (this._tEye - this._eyeWide) * a;
    this._headX     += (this._tHeadX - this._headX) * a;
    this._headY     += (this._tHeadY - this._headY) * a;

    // Reset camera-driven targets
    if (this._useCameraFeatures) this._tMouth = 0;

    // GPU render
    this._morph.render({
      mouthOpen: this._mouthOpen,
      browRaise: this._browRaise,
      eyeWide: this._eyeWide,
      headX: this._headX,
      headY: this._headY,
    });

    // Draw WebGL result onto 2D canvas
    targetCtx.drawImage(this._morph.canvas, dx, dy, dw, dh);
  }

  // ===========================================================================
  // Private: FaceMesh detection
  // ===========================================================================

  /** @private */
  async _detectFace(img) {
    return new Promise((resolve) => {
      if (typeof FaceMesh === 'undefined') {
        console.warn('[LipSync] FaceMesh unavailable — grid fallback');
        resolve(null);
        return;
      }

      const timeout = setTimeout(() => {
        console.warn('[LipSync] FaceMesh timeout — grid fallback');
        done(null);
      }, 15000);

      let resolved = false;
      const done = (r) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timeout);
        resolve(r);
      };

      const fm = new FaceMesh({
        locateFile: (f) =>
          `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${f}`,
      });
      fm.setOptions({
        maxNumFaces: 1, refineLandmarks: true,
        minDetectionConfidence: 0.3, minTrackingConfidence: 0.3,
      });
      fm.onResults((res) => {
        if (res.multiFaceLandmarks && res.multiFaceLandmarks.length > 0) {
          console.log('[LipSync] %d landmarks detected', res.multiFaceLandmarks[0].length);
          done(res.multiFaceLandmarks[0]);
        } else {
          console.warn('[LipSync] No face found');
          done(null);
        }
        try { fm.close(); } catch {}
      });
      fm.initialize().then(() => {
        const c = document.createElement('canvas');
        c.width = img.naturalWidth || img.width;
        c.height = img.naturalHeight || img.height;
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        fm.send({ image: c }).catch((e) => { console.error('[LipSync]', e); done(null); });
      }).catch((e) => { console.error('[LipSync]', e); done(null); });
    });
  }
}

export default LipSyncLocal;
