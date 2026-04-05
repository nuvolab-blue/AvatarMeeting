/**
 * @fileoverview Face deformation controller with idle animation.
 *
 * Manages:
 *  - Audio RMS → mouth opening
 *  - Camera facial features → eyes, brows, mouth
 *  - Head pose → subtle translation
 *  - Idle animation → periodic blinks + micro-breathing for lifelike look
 *
 * Delegates actual rendering to WebGLMorph (GPU mesh warping).
 */

import WebGLMorph from './webgl_morph.js';

class LipSyncLocal {
  constructor() {
    /** @private */ this._morph = new WebGLMorph();
    /** @private */ this._ready = false;
    /** @private */ this._useCameraFeatures = false;

    // Smoothed current values
    /** @private */ this._mouthOpen = 0;
    /** @private */ this._browRaise = 0;
    /** @private */ this._eyeWide = 0;
    /** @private */ this._headX = 0;
    /** @private */ this._headY = 0;

    // Targets
    /** @private */ this._tMouth = 0;
    /** @private */ this._tBrow = 0;
    /** @private */ this._tEye = 0;
    /** @private */ this._tHeadX = 0;
    /** @private */ this._tHeadY = 0;

    /** @private */ this._alpha = 0.30; // smoothing

    // Idle animation state
    /** @private */ this._idleBlink = 0;      // 0..1 blink amount
    /** @private */ this._nextBlinkTime = 0;
    /** @private */ this._blinkPhase = 0;      // 0=waiting, 1=closing, 2=opening
    /** @private */ this._startTime = 0;
  }

  /**
   * @param {HTMLImageElement} avatarImage
   * @returns {Promise<boolean>}
   */
  async init(avatarImage) {
    const landmarks = await this._detectFace(avatarImage);
    const ok = this._morph.init(avatarImage, landmarks);
    if (!ok) return false;

    this._ready = true;
    this._startTime = performance.now();
    this._nextBlinkTime = this._startTime + 2000 + Math.random() * 3000;
    console.log('[LipSync] Morph engine ready');
    return true;
  }

  get isReady() { return this._ready; }

  /**
   * Audio RMS → mouth opening.
   * @param {number} rms 0..1
   */
  setAudioAmplitude(rms) {
    // Very sensitive threshold for detecting speech
    const t = 0.005;
    const mapped = rms < t ? 0 : Math.min(1, (rms - t) * 5);
    const audioMouth = Math.pow(mapped, 1.2);

    if (this._useCameraFeatures) {
      this._tMouth = Math.max(audioMouth, this._tMouth);
    } else {
      this._tMouth = audioMouth;
    }
  }

  /**
   * Camera facial features → deformation targets.
   * @param {{mouthOpen:number, browRaise:number, eyeOpen:number}} f
   */
  setFacialFeatures(f) {
    this._useCameraFeatures = true;
    this._tMouth = Math.max(this._tMouth, f.mouthOpen || 0);
    this._tBrow = f.browRaise || 0;
    this._tEye = f.eyeOpen != null ? (f.eyeOpen - 0.5) : 0;
  }

  /**
   * Head pose → translation shift.
   * @param {number} yaw degrees
   * @param {number} pitch degrees
   */
  setHeadPose(yaw, pitch) {
    this._tHeadX = -(yaw / 45) * 0.025;
    this._tHeadY = (pitch / 45) * 0.012;
  }

  /**
   * Render deformed avatar.
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} dx
   * @param {number} dy
   * @param {number} dw
   * @param {number} dh
   */
  render(ctx, dx, dy, dw, dh) {
    if (!this._ready) return;

    const now = performance.now();

    // === Idle Animation ===
    this._updateBlink(now);
    const breathe = Math.sin(now * 0.002) * 0.003; // subtle vertical oscillation

    // === Smooth animation ===
    const a = this._alpha;
    this._mouthOpen += (this._tMouth - this._mouthOpen) * a;
    this._browRaise += (this._tBrow - this._browRaise) * a;
    this._headX     += (this._tHeadX - this._headX) * a;
    this._headY     += (this._tHeadY - this._headY) * a;

    // Eye: blend camera input with idle blink
    let eyeTarget = this._tEye;
    if (this._idleBlink > 0 && !this._useCameraFeatures) {
      // Blink overrides eye openness: -0.5 = fully closed
      eyeTarget = -this._idleBlink * 0.5;
    } else if (this._useCameraFeatures && this._idleBlink > 0.3) {
      // Even with camera, add subtle blink influence
      eyeTarget = Math.min(eyeTarget, -this._idleBlink * 0.3);
    }
    this._eyeWide += (eyeTarget - this._eyeWide) * (a * 1.5); // faster for blink

    // Reset camera-driven mouth (camera will re-set each frame)
    if (this._useCameraFeatures) this._tMouth = 0;

    // === GPU render ===
    this._morph.render({
      mouthOpen: this._mouthOpen,
      browRaise: this._browRaise,
      eyeWide: this._eyeWide,
      headX: this._headX,
      headY: this._headY + breathe,
    });

    // Draw WebGL canvas onto 2D display canvas
    ctx.drawImage(this._morph.canvas, dx, dy, dw, dh);
  }

  // ==========================================================================
  // Private: idle animation
  // ==========================================================================

  _updateBlink(now) {
    const blinkDuration = 150; // ms for full close
    const openDuration = 120;  // ms for full open

    if (this._blinkPhase === 0) {
      // Waiting for next blink
      if (now >= this._nextBlinkTime) {
        this._blinkPhase = 1;
        this._blinkStart = now;
      }
    } else if (this._blinkPhase === 1) {
      // Closing
      const t = (now - this._blinkStart) / blinkDuration;
      this._idleBlink = Math.min(1, t);
      if (t >= 1) {
        this._blinkPhase = 2;
        this._blinkStart = now;
      }
    } else if (this._blinkPhase === 2) {
      // Opening
      const t = (now - this._blinkStart) / openDuration;
      this._idleBlink = Math.max(0, 1 - t);
      if (t >= 1) {
        this._idleBlink = 0;
        this._blinkPhase = 0;
        // Random interval: 2-6 seconds, occasionally double-blink
        const doubleBlink = Math.random() < 0.2;
        this._nextBlinkTime = now + (doubleBlink ? 200 : 2000 + Math.random() * 4000);
      }
    }
  }

  // ==========================================================================
  // Private: FaceMesh detection
  // ==========================================================================

  async _detectFace(img) {
    return new Promise((resolve) => {
      if (typeof FaceMesh === 'undefined') {
        console.warn('[LipSync] FaceMesh unavailable — grid fallback');
        resolve(null);
        return;
      }

      const timeout = setTimeout(() => {
        console.warn('[LipSync] FaceMesh timeout');
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
        if (res.multiFaceLandmarks?.length > 0) {
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
        fm.send({ image: c }).catch((e) => { console.error(e); done(null); });
      }).catch((e) => { console.error(e); done(null); });
    });
  }
}

export default LipSyncLocal;
