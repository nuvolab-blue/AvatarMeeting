/**
 * @fileoverview Client-side lip-sync & facial deformation engine.
 *
 * Uses canvas drawImage strip-warping for GPU-accelerated deformation.
 * Detects face landmarks on the uploaded avatar photo once, then deforms
 * mouth, eyes, and brows in real-time based on audio and camera input.
 *
 * If FaceMesh fails on the static image, uses proportional face estimates
 * so that deformation ALWAYS works.
 */

class LipSyncLocal {
  constructor() {
    /** @private @type {HTMLImageElement} */ this._avatarImage = null;
    /** @private @type {HTMLCanvasElement} */ this._offscreen = null;
    /** @private @type {CanvasRenderingContext2D} */ this._offCtx = null;
    /** @private */ this._ready = false;
    /** @private */ this._useCameraFeatures = false;

    // Face geometry (pixel coords on source image)
    /** @private */ this._faceX = 0;
    /** @private */ this._faceW = 0;
    /** @private */ this._faceHeight = 0;
    /** @private */ this._browY = 0;
    /** @private */ this._eyeY = 0;
    /** @private */ this._mouthCenterY = 0;
    /** @private */ this._mouthWidth = 0;
    /** @private */ this._chinY = 0;

    // Animation targets (0-1 normalised)
    /** @private */ this._targetMouthOpen = 0;
    /** @private */ this._targetBrowRaise = 0;
    /** @private */ this._targetEyeWide = 0; // -0.5 to +0.5
    /** @private */ this._targetHeadX = 0;   // pixels
    /** @private */ this._targetHeadY = 0;

    // Smoothed current values
    /** @private */ this._mouthOpen = 0;
    /** @private */ this._browRaise = 0;
    /** @private */ this._eyeWide = 0;
    /** @private */ this._headX = 0;
    /** @private */ this._headY = 0;

    /** @private */ this._smooth = 0.25;
  }

  /**
   * Initialise with the avatar image.
   * Always returns true — uses estimated proportions as fallback.
   * @param {HTMLImageElement} avatarImage
   * @returns {Promise<boolean>}
   */
  async init(avatarImage) {
    this._avatarImage = avatarImage;
    const w = avatarImage.naturalWidth || avatarImage.width;
    const h = avatarImage.naturalHeight || avatarImage.height;

    this._offscreen = document.createElement('canvas');
    this._offscreen.width = w;
    this._offscreen.height = h;
    this._offCtx = this._offscreen.getContext('2d');

    // Try FaceMesh landmark detection
    const landmarks = await this._detectFace(avatarImage);
    if (landmarks) {
      this._initFromLandmarks(landmarks, w, h);
    } else {
      this._initFallback(w, h);
    }

    this._ready = true;
    console.log('[LipSync] Ready — faceH=%d mouthY=%d chinY=%d faceX=%d faceW=%d',
      Math.round(this._faceHeight), Math.round(this._mouthCenterY),
      Math.round(this._chinY), Math.round(this._faceX), Math.round(this._faceW));
    return true;
  }

  /** @returns {boolean} */
  get isReady() { return this._ready; }

  /**
   * Set mouth open amount from audio amplitude.
   * @param {number} rms - Audio RMS amplitude (0-1)
   */
  setAudioAmplitude(rms) {
    const threshold = 0.008;
    const mapped = rms < threshold ? 0 : Math.min(1, (rms - threshold) * 6);
    const audioMouth = Math.pow(mapped, 1.5); // gentler curve than quadratic

    if (this._useCameraFeatures) {
      this._targetMouthOpen = Math.max(audioMouth, this._targetMouthOpen);
    } else {
      this._targetMouthOpen = audioMouth;
    }
  }

  /**
   * Set facial features from camera face tracker.
   * @param {{mouthOpen:number, browRaise:number, eyeOpen:number}} features
   */
  setFacialFeatures(features) {
    this._useCameraFeatures = true;
    this._targetMouthOpen = Math.max(this._targetMouthOpen, features.mouthOpen || 0);
    this._targetBrowRaise = features.browRaise || 0;
    // eyeOpen 0-1 where 0.5 = neutral
    this._targetEyeWide = features.eyeOpen != null ? (features.eyeOpen - 0.5) : 0;
  }

  /**
   * Set head pose for subtle avatar shift.
   * @param {number} yaw  - degrees (-45 to 45)
   * @param {number} pitch - degrees (-45 to 45)
   */
  setHeadPose(yaw, pitch) {
    const maxShift = this._faceHeight * 0.04;
    this._targetHeadX = -(yaw / 45) * maxShift;
    this._targetHeadY = (pitch / 45) * maxShift * 0.5;
  }

  /**
   * Render deformed avatar onto the target canvas.
   * @param {CanvasRenderingContext2D} targetCtx
   * @param {number} dx - Destination x
   * @param {number} dy - Destination y
   * @param {number} dw - Destination width
   * @param {number} dh - Destination height
   */
  render(targetCtx, dx, dy, dw, dh) {
    if (!this._ready || !this._avatarImage) return;

    // Smooth all values
    const a = this._smooth;
    this._mouthOpen += (this._targetMouthOpen - this._mouthOpen) * a;
    this._browRaise += (this._targetBrowRaise - this._browRaise) * a;
    this._eyeWide += (this._targetEyeWide - this._eyeWide) * a;
    this._headX += (this._targetHeadX - this._headX) * a;
    this._headY += (this._targetHeadY - this._headY) * a;

    // Reset camera-driven mouth target (camera will re-set it each frame)
    if (this._useCameraFeatures) {
      this._targetMouthOpen = 0;
    }

    const sw = this._offscreen.width;
    const sh = this._offscreen.height;

    // Render deformed image to offscreen canvas
    this._offCtx.clearRect(0, 0, sw, sh);
    this._renderDeformed(this._offCtx, sw, sh);

    // Draw to display canvas with head-pose shift
    const scaleX = dw / sw;
    const scaleY = dh / sh;
    const shiftX = Math.round(this._headX * scaleX);
    const shiftY = Math.round(this._headY * scaleY);
    targetCtx.drawImage(this._offscreen, 0, 0, sw, sh,
      dx + shiftX, dy + shiftY, dw, dh);
  }

  // ---- Private: rendering ----

  /**
   * Render base image with facial deformations applied.
   * Uses drawImage (GPU-accelerated) instead of getImageData/putImageData.
   * @private
   */
  _renderDeformed(ctx, w, h) {
    const img = this._avatarImage;

    // Calculate pixel-level deformation amounts
    const mouthPx = this._mouthOpen * this._faceHeight * 0.12;
    const browPx = this._browRaise * this._faceHeight * 0.04;
    const eyePx = this._eyeWide * this._faceHeight * 0.03;

    const anyDeform = mouthPx > 0.5 || browPx > 0.5 || Math.abs(eyePx) > 0.5;

    // Draw base image
    ctx.drawImage(img, 0, 0, w, h);

    if (!anyDeform) return;

    // Apply deformations (order matters: bottom-up to avoid overlap issues)
    if (mouthPx > 1) this._deformMouth(ctx, img, w, h, mouthPx);
    if (browPx > 1) this._deformBrow(ctx, img, w, h, browPx);
    if (Math.abs(eyePx) > 0.5) this._deformEye(ctx, img, w, h, eyePx);
  }

  /**
   * Mouth opening: draw cavity, shift lower face down.
   * @private
   */
  _deformMouth(ctx, img, w, h, mouthPx) {
    const splitY = Math.round(this._mouthCenterY);
    const lowerH = Math.round(Math.min(h - splitY, this._chinY - splitY + 40));
    if (lowerH <= 0) return;

    // Face column with margin
    const margin = 20;
    const fx = Math.max(0, Math.round(this._faceX - margin));
    const fRight = Math.min(w, Math.round(this._faceX + this._faceW + margin));
    const fw = fRight - fx;
    if (fw <= 0) return;

    const faceCenterX = this._faceX + this._faceW / 2;
    const shift = Math.round(mouthPx);

    // Step 1: Draw mouth cavity in the gap area
    ctx.save();
    ctx.beginPath();
    ctx.rect(fx, splitY, fw, shift + 5);
    ctx.clip();

    // Dark interior fill
    ctx.fillStyle = '#180808';
    ctx.fillRect(fx, splitY, fw, shift + 5);

    // Elliptical mouth cavity
    ctx.beginPath();
    const cavityRx = this._mouthWidth * 0.35;
    const cavityRy = Math.min(shift * 0.45, this._mouthWidth * 0.2);
    ctx.ellipse(faceCenterX, splitY + shift * 0.4,
      cavityRx, Math.max(cavityRy, 2), 0, 0, Math.PI * 2);
    ctx.fillStyle = '#0a0404';
    ctx.fill();
    ctx.restore();

    // Step 2: Redraw lower face shifted down (clipped to face column)
    ctx.save();
    ctx.beginPath();
    ctx.rect(fx, splitY + shift, fw, lowerH + 10);
    ctx.clip();
    ctx.drawImage(img,
      fx, splitY, fw, lowerH,
      fx, splitY + shift, fw, lowerH);
    ctx.restore();
  }

  /**
   * Brow raise: shift brow area up, fill gap with stretched forehead.
   * @private
   */
  _deformBrow(ctx, img, w, h, browPx) {
    const margin = 15;
    const fx = Math.max(0, Math.round(this._faceX - margin));
    const fRight = Math.min(w, Math.round(this._faceX + this._faceW + margin));
    const fw = fRight - fx;
    if (fw <= 0) return;

    const shift = Math.round(browPx);
    const browTop = Math.max(0, Math.round(this._browY - 15));
    const browH = Math.round(this._eyeY - this._browY + 10);
    if (browH <= 0 || browTop - shift < 0) return;

    ctx.save();
    ctx.beginPath();
    ctx.rect(fx, browTop - shift, fw, browH + shift + 5);
    ctx.clip();

    // Draw brow area shifted up
    ctx.drawImage(img,
      fx, browTop, fw, browH,
      fx, browTop - shift, fw, browH);

    // Fill the gap below shifted brow with stretched skin from above
    if (shift > 0) {
      const gapY = browTop + browH - shift;
      const srcGapY = Math.max(0, browTop - shift);
      ctx.drawImage(img,
        fx, srcGapY, fw, Math.min(shift + 2, browTop),
        fx, gapY, fw, shift + 2);
    }

    ctx.restore();
  }

  /**
   * Eye widening/narrowing: stretch eye region vertically.
   * @private
   */
  _deformEye(ctx, img, w, h, eyePx) {
    const margin = 15;
    const fx = Math.max(0, Math.round(this._faceX - margin));
    const fRight = Math.min(w, Math.round(this._faceX + this._faceW + margin));
    const fw = fRight - fx;
    if (fw <= 0) return;

    const eyeRegionH = Math.round(this._faceHeight * 0.1);
    const eyeTop = Math.round(this._eyeY - eyeRegionH / 2);
    const destH = Math.round(eyeRegionH + eyePx);
    if (destH <= 0 || eyeTop < 0) return;

    ctx.save();
    ctx.beginPath();
    ctx.rect(fx, eyeTop - Math.abs(eyePx), fw, destH + Math.abs(eyePx) * 2 + 5);
    ctx.clip();

    // Stretch or compress the eye region vertically
    ctx.drawImage(img,
      fx, eyeTop, fw, eyeRegionH,
      fx, eyeTop - eyePx * 0.5, fw, destH);

    ctx.restore();
  }

  // ---- Private: face geometry initialisation ----

  /**
   * Compute face geometry from FaceMesh landmarks.
   * @private
   */
  _initFromLandmarks(lm, w, h) {
    const forehead = lm[10];
    const chin = lm[152];
    const leftFace = lm[234];
    const rightFace = lm[454];
    const upperLip = lm[13];
    const lowerLip = lm[14];
    const leftMouth = lm[61];
    const rightMouth = lm[291];
    const leftBrow = lm[105];
    const rightBrow = lm[334];
    const leftEye = lm[159];
    const rightEye = lm[386];

    this._faceX = Math.min(leftFace.x, rightFace.x) * w;
    this._faceW = Math.abs(rightFace.x - leftFace.x) * w;
    this._faceHeight = (chin.y - forehead.y) * h;
    this._mouthCenterY = ((upperLip.y + lowerLip.y) / 2) * h;
    this._mouthWidth = Math.abs(rightMouth.x - leftMouth.x) * w;
    this._chinY = chin.y * h;
    this._browY = ((leftBrow.y + rightBrow.y) / 2) * h;
    this._eyeY = ((leftEye.y + rightEye.y) / 2) * h;

    console.log('[LipSync] Landmarks detected successfully');
  }

  /**
   * Estimate face geometry from typical proportions (fallback).
   * @private
   */
  _initFallback(w, h) {
    // Assume a centered portrait photo
    this._faceX = w * 0.25;
    this._faceW = w * 0.50;
    this._faceHeight = h * 0.55;
    this._browY = h * 0.30;
    this._eyeY = h * 0.37;
    this._mouthCenterY = h * 0.60;
    this._mouthWidth = w * 0.22;
    this._chinY = h * 0.72;

    console.warn('[LipSync] Using estimated face proportions (FaceMesh unavailable)');
  }

  // ---- Private: FaceMesh detection ----

  /**
   * Detect face landmarks on a static image using MediaPipe FaceMesh.
   * @private
   * @param {HTMLImageElement} img
   * @returns {Promise<Array|null>}
   */
  async _detectFace(img) {
    return new Promise((resolve) => {
      if (typeof FaceMesh === 'undefined') {
        console.warn('[LipSync] FaceMesh not loaded — will use fallback proportions');
        resolve(null);
        return;
      }

      const timeout = setTimeout(() => {
        console.warn('[LipSync] FaceMesh timed out (15s) — using fallback');
        resolve(null);
      }, 15000);

      let resolved = false;
      const done = (result) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timeout);
        resolve(result);
      };

      const fm = new FaceMesh({
        locateFile: (file) =>
          `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}`,
      });

      fm.setOptions({
        maxNumFaces: 1,
        refineLandmarks: true,
        minDetectionConfidence: 0.3,
        minTrackingConfidence: 0.3,
      });

      fm.onResults((results) => {
        if (results.multiFaceLandmarks && results.multiFaceLandmarks.length > 0) {
          console.log('[LipSync] FaceMesh: %d landmarks detected',
            results.multiFaceLandmarks[0].length);
          done(results.multiFaceLandmarks[0]);
        } else {
          console.warn('[LipSync] FaceMesh: no face found in image');
          done(null);
        }
        try { fm.close(); } catch { /* ignore */ }
      });

      fm.initialize().then(() => {
        console.log('[LipSync] FaceMesh initialised, analysing static image...');
        const c = document.createElement('canvas');
        c.width = img.naturalWidth || img.width;
        c.height = img.naturalHeight || img.height;
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        fm.send({ image: c }).catch((err) => {
          console.error('[LipSync] FaceMesh.send() error:', err);
          done(null);
        });
      }).catch((err) => {
        console.error('[LipSync] FaceMesh.initialize() error:', err);
        done(null);
      });
    });
  }
}

export default LipSyncLocal;
