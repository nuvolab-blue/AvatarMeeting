/**
 * @fileoverview MediaPipe Face Landmarker wrapper for camera-based face capture.
 *
 * Provides 52 BlendShape coefficients, 478 landmarks, and head pose
 * from the user's webcam in real-time using GPU-accelerated inference.
 *
 * This replaces v3's FaceDetector API (bounding box only) with full
 * facial expression tracking — the key architectural improvement in v4.
 */

class FaceCapture {
  constructor() {
    /** @type {Object<string, number>} 52 BlendShape coefficients (0-1) */
    this.blendShapes = {};

    /** @type {{yaw: number, pitch: number, roll: number}} */
    this.headPose = { yaw: 0, pitch: 0, roll: 0 };

    /** @type {Array<{x: number, y: number, z: number}>|null} 478 landmarks */
    this.landmarks = null;

    /** @type {Function|null} Called each frame with updated data */
    this.onUpdate = null;

    /** @private */ this._landmarker = null;
    /** @private {HTMLVideoElement|null} */ this._video = null;
    /** @private {MediaStream|null} */ this._stream = null;
    /** @private */ this._active = false;
    /** @private */ this._rafId = null;
    /** @private */ this._lastTime = -1;
  }

  /** @type {boolean} */
  get isActive() { return this._active; }

  /** @type {HTMLVideoElement|null} For PIP display */
  get videoElement() { return this._video; }

  /**
   * Initialize camera and MediaPipe Face Landmarker.
   * Downloads the model on first call (~4MB).
   * @returns {Promise<boolean>}
   */
  async init() {
    try {
      // 1. Start camera
      this._stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
      });

      this._video = document.createElement('video');
      this._video.srcObject = this._stream;
      this._video.setAttribute('playsinline', '');
      this._video.muted = true;
      await this._video.play();

      // 2. Load MediaPipe Face Landmarker
      console.log('[FaceCapture] Loading MediaPipe Face Landmarker model...');
      const { FaceLandmarker, FilesetResolver } = await import(
        'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.22'
      );

      const vision = await FilesetResolver.forVisionTasks(
        'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.22/wasm'
      );

      this._landmarker = await FaceLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath:
            'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
          delegate: 'GPU',
        },
        runningMode: 'VIDEO',
        numFaces: 1,
        outputFaceBlendshapes: true,
        outputFacialTransformationMatrixes: true,
      });

      console.log('[FaceCapture] MediaPipe Face Landmarker ready (GPU delegate)');

      // 3. Start processing loop
      this._active = true;
      this._lastTime = -1;
      this._processLoop();

      return true;
    } catch (err) {
      console.error('[FaceCapture] Init failed:', err);
      this._cleanup();
      return false;
    }
  }

  /** Stop camera and release resources. */
  stop() {
    this._active = false;
    if (this._rafId) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
    this._cleanup();
    console.log('[FaceCapture] Stopped');
  }

  // ==========================================================================
  // Private
  // ==========================================================================

  /** @private */
  _processLoop() {
    if (!this._active) return;
    this._rafId = requestAnimationFrame(() => this._processLoop());

    const video = this._video;
    if (!video || video.readyState < 2) return; // HAVE_CURRENT_DATA

    const now = performance.now();
    // MediaPipe requires strictly increasing timestamps
    if (now <= this._lastTime) return;
    this._lastTime = now;

    try {
      const result = this._landmarker.detectForVideo(video, now);

      // BlendShapes
      if (result.faceBlendshapes && result.faceBlendshapes.length > 0) {
        const shapes = result.faceBlendshapes[0].categories;
        for (const s of shapes) {
          this.blendShapes[s.categoryName] = s.score;
        }
      }

      // Head pose from facial transformation matrix
      if (result.facialTransformationMatrixes && result.facialTransformationMatrixes.length > 0) {
        const m = result.facialTransformationMatrixes[0].data;
        this.headPose = this._extractPose(m);
      }

      // Landmarks
      if (result.faceLandmarks && result.faceLandmarks.length > 0) {
        this.landmarks = result.faceLandmarks[0];
      }

      if (this.onUpdate) {
        this.onUpdate(this.blendShapes, this.headPose, this.landmarks);
      }
    } catch (err) {
      // Silently skip frame errors (can happen during camera init)
    }
  }

  /**
   * Extract Euler angles from 4×4 transformation matrix.
   * @private
   * @param {Float32Array} m - 4×4 column-major matrix
   * @returns {{yaw: number, pitch: number, roll: number}} degrees
   */
  _extractPose(m) {
    // Column-major 4x4: m[0..3] = col0, m[4..7] = col1, etc.
    // Row-major access: M[row][col] = m[col*4 + row]
    const r00 = m[0], r01 = m[4], r02 = m[8];
    const r10 = m[1], r11 = m[5], r12 = m[9];
    const r20 = m[2], r21 = m[6], r22 = m[10];

    const toDeg = 180 / Math.PI;

    // Euler angles (XYZ convention)
    const pitch = Math.asin(-Math.max(-1, Math.min(1, r20))) * toDeg;
    const yaw = Math.atan2(r10, r00) * toDeg;
    const roll = Math.atan2(r21, r22) * toDeg;

    return { yaw, pitch, roll };
  }

  /** @private */
  _cleanup() {
    if (this._stream) {
      this._stream.getTracks().forEach(t => t.stop());
      this._stream = null;
    }
    if (this._video) {
      this._video.srcObject = null;
      this._video = null;
    }
    if (this._landmarker) {
      this._landmarker.close();
      this._landmarker = null;
    }
    this._active = false;
  }
}

window.FaceCapture = FaceCapture;
