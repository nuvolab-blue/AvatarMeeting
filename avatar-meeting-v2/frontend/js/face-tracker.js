/**
 * @fileoverview Camera head tracking using MediaPipe FaceMesh.
 *
 * Optional module — avatar works without camera via idle animations.
 * When active, provides real-time head pose (yaw, pitch, roll) and
 * 468-point face landmarks for region updates.
 *
 * Processes every 2nd frame (~15fps) to reduce CPU load.
 */

class FaceTracker {
  constructor() {
    /** @private {FaceMesh|null} */ this._faceMesh = null;
    /** @private {HTMLVideoElement|null} */ this._video = null;
    /** @private {MediaStream|null} */ this._stream = null;
    /** @private */ this._running = false;
    /** @private */ this._rafId = null;
    /** @private */ this._frameCount = 0;

    // Smoothed head pose
    /** @private */ this._smoothYaw = 0;
    /** @private */ this._smoothPitch = 0;
    /** @private */ this._smoothRoll = 0;

    /** @type {Function|null} (headPose: {yaw, pitch, roll}) => void */
    this.onHeadPose = null;

    /** @type {Function|null} (landmarks: Array) => void */
    this.onLandmarks = null;

    /** @type {HTMLVideoElement|null} */
    this.videoEl = null;
  }

  /**
   * Initialize camera and MediaPipe FaceMesh.
   * @returns {Promise<boolean>}
   */
  async init() {
    // Check MediaPipe availability
    if (typeof FaceMesh === 'undefined') {
      console.warn('[FaceTracker] MediaPipe FaceMesh not loaded — skipping');
      return false;
    }

    try {
      // Camera
      this._stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 320, height: 240, frameRate: 30 },
      });

      this._video = document.createElement('video');
      this._video.srcObject = this._stream;
      this._video.setAttribute('playsinline', '');
      this._video.muted = true;
      await this._video.play();
      this.videoEl = this._video;

      // FaceMesh
      this._faceMesh = new FaceMesh({
        locateFile: (file) =>
          `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}`,
      });

      this._faceMesh.setOptions({
        maxNumFaces: 1,
        refineLandmarks: true,
        minDetectionConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });

      this._faceMesh.onResults((results) => this._onResults(results));
      await this._faceMesh.initialize();

      // Start processing loop
      this._running = true;
      this._loop();

      console.log('[FaceTracker] Initialized — 320x240 @ 15fps (every 2nd frame)');
      return true;
    } catch (err) {
      console.error('[FaceTracker] Init failed:', err);
      return false;
    }
  }

  /** Stop camera and tracking. */
  stop() {
    this._running = false;
    if (this._rafId) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
    if (this._stream) {
      this._stream.getTracks().forEach((t) => t.stop());
      this._stream = null;
    }
    console.log('[FaceTracker] Stopped');
  }

  /** Process a single video frame. */
  processFrame() {
    if (!this._faceMesh || !this._video || this._video.readyState < 2) return;
    try {
      this._faceMesh.send({ image: this._video });
    } catch (err) {
      console.error('[FaceTracker] processFrame error:', err);
    }
  }

  // ==========================================================================
  // Private
  // ==========================================================================

  /** @private */
  _loop() {
    if (!this._running) return;
    this._rafId = requestAnimationFrame(() => this._loop());

    // Process every 2nd frame (~15fps)
    this._frameCount++;
    if (this._frameCount % 2 === 0) {
      this.processFrame();
    }
  }

  /** @private */
  _onResults(results) {
    if (!results.multiFaceLandmarks || results.multiFaceLandmarks.length === 0) return;

    const lm = results.multiFaceLandmarks[0];

    // Pass landmarks to callback
    if (this.onLandmarks) this.onLandmarks(lm);

    // Head pose estimation
    const noseTip = lm[1];
    const chin = lm[152];
    const leftEye = lm[263];
    const rightEye = lm[33];

    const eyeCenter = (leftEye.x + rightEye.x) / 2;
    const rawYaw = (noseTip.x - eyeCenter) * 120;
    const rawPitch = (noseTip.y - 0.4) * -60;
    const dx = leftEye.x - rightEye.x;
    const dy = leftEye.y - rightEye.y;
    const rawRoll = Math.atan2(dy, dx) * (180 / Math.PI);

    // Clamp
    const yaw = Math.max(-45, Math.min(45, rawYaw));
    const pitch = Math.max(-30, Math.min(30, rawPitch));
    const roll = Math.max(-30, Math.min(30, rawRoll));

    // Smooth (alpha = 0.35)
    const a = 0.35;
    this._smoothYaw += (yaw - this._smoothYaw) * a;
    this._smoothPitch += (pitch - this._smoothPitch) * a;
    this._smoothRoll += (roll - this._smoothRoll) * a;

    if (this.onHeadPose) {
      this.onHeadPose({
        yaw: this._smoothYaw,
        pitch: this._smoothPitch,
        roll: this._smoothRoll,
      });
    }
  }
}

export default FaceTracker;

if (typeof window !== 'undefined') {
  window.FaceTracker = FaceTracker;
}
