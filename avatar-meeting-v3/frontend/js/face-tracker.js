/**
 * @fileoverview Simple camera face tracking — no MediaPipe dependency.
 *
 * Two-tier fallback:
 *  1. FaceDetector API (Chrome native) — fast, accurate bounding box
 *  2. Luminance centroid tracking — works everywhere, less accurate
 *
 * Both produce head pose (yaw, pitch, roll) from face position.
 */

class SimpleFaceTracker {
  constructor() {
    /** @private */ this._video = null;
    /** @private */ this._stream = null;
    /** @private */ this._detector = null;
    /** @private */ this._running = false;
    /** @private */ this._intervalId = null;
    /** @private */ this._mode = 'none'; // 'facedetector' | 'luminance' | 'none'

    // Smoothed pose
    /** @private */ this._smoothYaw = 0;
    /** @private */ this._smoothPitch = 0;
    /** @private */ this._smoothRoll = 0;

    // Luminance fallback canvas
    /** @private */ this._lumCanvas = null;
    /** @private */ this._lumCtx = null;

    /** @type {Function|null} ({yaw, pitch, roll}) => void */
    this.onHeadPose = null;
  }

  /**
   * Initialise camera and face detection.
   * @returns {Promise<boolean>}
   */
  async init() {
    try {
      this._stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 320, height: 240, frameRate: 15 },
      });

      this._video = document.createElement('video');
      this._video.srcObject = this._stream;
      this._video.setAttribute('playsinline', '');
      this._video.muted = true;
      await this._video.play();

      // Show in PIP
      const pipVideo = document.getElementById('pv');
      if (pipVideo) {
        pipVideo.srcObject = this._stream;
        pipVideo.play().catch(() => {});
      }
      const pip = document.getElementById('pip');
      if (pip) pip.style.display = 'block';

      // Try FaceDetector API
      if ('FaceDetector' in window) {
        try {
          this._detector = new FaceDetector({ fastMode: true, maxDetectedFaces: 1 });
          this._mode = 'facedetector';
          console.log('[FaceTracker] Using FaceDetector API');
        } catch (e) {
          console.warn('[FaceTracker] FaceDetector init failed:', e);
        }
      }

      // Fallback: luminance centroid
      if (this._mode === 'none') {
        this._lumCanvas = document.createElement('canvas');
        this._lumCanvas.width = 80;
        this._lumCanvas.height = 60;
        this._lumCtx = this._lumCanvas.getContext('2d', { willReadFrequently: true });
        this._mode = 'luminance';
        console.log('[FaceTracker] Using luminance centroid fallback');
      }

      // Start tracking loop (10fps)
      this._running = true;
      this._intervalId = setInterval(() => this._track(), 100);

      console.log('[FaceTracker] Init: mode=%s', this._mode);
      return true;
    } catch (err) {
      console.error('[FaceTracker] Init failed:', err);
      return false;
    }
  }

  /** Stop camera and tracking. */
  stop() {
    this._running = false;
    if (this._intervalId) {
      clearInterval(this._intervalId);
      this._intervalId = null;
    }
    if (this._stream) {
      this._stream.getTracks().forEach((t) => t.stop());
      this._stream = null;
    }
    const pip = document.getElementById('pip');
    if (pip) pip.style.display = 'none';
    console.log('[FaceTracker] Stopped');
  }

  // ==========================================================================
  // Private: tracking loop
  // ==========================================================================

  /** @private */
  async _track() {
    if (!this._running || !this._video || this._video.readyState < 2) return;

    try {
      if (this._mode === 'facedetector') {
        await this._trackFaceDetector();
      } else {
        this._trackLuminance();
      }
    } catch (e) {
      // Silently handle tracking errors
    }
  }

  /** @private */
  async _trackFaceDetector() {
    const faces = await this._detector.detect(this._video);
    if (faces.length === 0) return;

    const face = faces[0].boundingBox;
    const vw = this._video.videoWidth;
    const vh = this._video.videoHeight;

    // Face center normalised to -1..1
    const fcx = (face.x + face.width / 2) / vw * 2 - 1;
    const fcy = (face.y + face.height / 2) / vh * 2 - 1;

    // Map to degrees (mirrored for yaw)
    const rawYaw = -fcx * 35;
    const rawPitch = -fcy * 25;

    this._smooth(rawYaw, rawPitch, 0, 0.25);
  }

  /** @private */
  _trackLuminance() {
    const lc = this._lumCanvas;
    const lctx = this._lumCtx;

    lctx.drawImage(this._video, 0, 0, 80, 60);
    const imgData = lctx.getImageData(0, 0, 80, 60);
    const data = imgData.data;

    let sumX = 0, sumY = 0, count = 0;
    for (let y = 0; y < 60; y++) {
      for (let x = 0; x < 80; x++) {
        const i = (y * 80 + x) * 4;
        const lum = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
        if (lum > 100) {
          sumX += x;
          sumY += y;
          count++;
        }
      }
    }

    if (count < 50) return;

    const cx = sumX / count;
    const cy = sumY / count;

    // Normalise to -1..1
    const fcx = (cx / 80) * 2 - 1;
    const fcy = (cy / 60) * 2 - 1;

    const rawYaw = -fcx * 30;
    const rawPitch = -fcy * 20;

    this._smooth(rawYaw, rawPitch, 0, 0.15);
  }

  /**
   * Exponential moving average for pose smoothing.
   * @private
   */
  _smooth(yaw, pitch, roll, alpha) {
    this._smoothYaw += (yaw - this._smoothYaw) * alpha;
    this._smoothPitch += (pitch - this._smoothPitch) * alpha;
    this._smoothRoll += (roll - this._smoothRoll) * alpha;

    // Clamp
    this._smoothYaw = Math.max(-45, Math.min(45, this._smoothYaw));
    this._smoothPitch = Math.max(-30, Math.min(30, this._smoothPitch));
    this._smoothRoll = Math.max(-30, Math.min(30, this._smoothRoll));

    if (this.onHeadPose) {
      this.onHeadPose({
        yaw: this._smoothYaw,
        pitch: this._smoothPitch,
        roll: this._smoothRoll,
      });
    }
  }
}

window.SimpleFaceTracker = SimpleFaceTracker;
