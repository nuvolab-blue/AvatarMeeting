/**
 * @fileoverview MediaPipe Face Landmarker wrapper for camera-based face capture.
 *
 * Provides 52 BlendShape coefficients, 478 landmarks, and head pose
 * from the user's webcam in real-time.
 *
 * ★ v4.1: GPU→CPU fallback, error recovery, frame skip on failure
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

    /** @type {Function|null} Called on error */
    this.onError = null;

    /** @private */ this._landmarker = null;
    /** @private {HTMLVideoElement|null} */ this._video = null;
    /** @private {MediaStream|null} */ this._stream = null;
    /** @private */ this._active = false;
    /** @private */ this._rafId = null;
    /** @private */ this._lastTime = -1;
    /** @private */ this._errorCount = 0;
    /** @private */ this._maxErrors = 30; // Stop after 30 consecutive errors
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

      // Wait for video to have actual dimensions
      await new Promise((resolve) => {
        const check = () => {
          if (this._video.videoWidth > 0 && this._video.videoHeight > 0) {
            resolve();
          } else {
            requestAnimationFrame(check);
          }
        };
        check();
      });

      console.log(`[FaceCapture] Camera ready: ${this._video.videoWidth}x${this._video.videoHeight}`);

      // 2. Load MediaPipe Face Landmarker
      console.log('[FaceCapture] Loading MediaPipe Face Landmarker model...');

      let FaceLandmarker, FilesetResolver;
      try {
        const mod = await import(
          'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.22'
        );
        FaceLandmarker = mod.FaceLandmarker;
        FilesetResolver = mod.FilesetResolver;
      } catch (importErr) {
        console.error('[FaceCapture] Failed to load MediaPipe module:', importErr);
        if (this.onError) this.onError('MediaPipeモジュールの読み込みに失敗しました');
        this._cleanup();
        return false;
      }

      const vision = await FilesetResolver.forVisionTasks(
        'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.22/wasm'
      );

      // Try GPU first, fall back to CPU
      let landmarker = null;
      try {
        landmarker = await FaceLandmarker.createFromOptions(vision, {
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
        console.log('[FaceCapture] MediaPipe ready (GPU delegate)');
      } catch (gpuErr) {
        console.warn('[FaceCapture] GPU delegate failed, trying CPU:', gpuErr.message);
        try {
          landmarker = await FaceLandmarker.createFromOptions(vision, {
            baseOptions: {
              modelAssetPath:
                'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
              delegate: 'CPU',
            },
            runningMode: 'VIDEO',
            numFaces: 1,
            outputFaceBlendshapes: true,
            outputFacialTransformationMatrixes: true,
          });
          console.log('[FaceCapture] MediaPipe ready (CPU delegate — slower)');
        } catch (cpuErr) {
          console.error('[FaceCapture] Both GPU and CPU delegate failed:', cpuErr);
          if (this.onError) this.onError('MediaPipeの初期化に失敗しました');
          this._cleanup();
          return false;
        }
      }

      this._landmarker = landmarker;

      // 3. Start processing loop
      this._active = true;
      this._lastTime = -1;
      this._errorCount = 0;
      this._processLoop();

      return true;
    } catch (err) {
      console.error('[FaceCapture] Init failed:', err);
      if (this.onError) this.onError(err.message);
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
    if (!video || video.readyState < 2) return;

    const now = performance.now();
    if (now <= this._lastTime) return;
    this._lastTime = now;

    try {
      const result = this._landmarker.detectForVideo(video, now);

      // Reset error count on success
      this._errorCount = 0;

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
      this._errorCount++;
      if (this._errorCount <= 3) {
        console.warn(`[FaceCapture] Frame error (${this._errorCount}):`, err.message);
      }
      if (this._errorCount >= this._maxErrors) {
        console.error('[FaceCapture] Too many errors, stopping');
        if (this.onError) this.onError('カメラ処理でエラーが多発しました');
        this._active = false;
      }
    }
  }

  /**
   * Extract Euler angles from 4×4 transformation matrix.
   * @private
   * @param {Float32Array} m - 4×4 column-major matrix
   * @returns {{yaw: number, pitch: number, roll: number}} degrees
   */
  _extractPose(m) {
    const r00 = m[0], r10 = m[1], r20 = m[2];
    const r21 = m[6], r22 = m[10];

    const toDeg = 180 / Math.PI;
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
      try { this._landmarker.close(); } catch (e) { /* ignore */ }
      this._landmarker = null;
    }
    this._active = false;
  }
}

window.FaceCapture = FaceCapture;
