/**
 * @fileoverview MediaPipe Face Landmarker wrapper.
 *
 * Captures 52 ARKit BlendShape coefficients and a 4x4 head pose
 * transformation matrix from the user's webcam in real-time.
 *
 * Uses GPU delegate (Metal/WebGPU on macOS) for maximum performance.
 */

import {
  FaceLandmarker,
  FilesetResolver
} from 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/vision_bundle.mjs';

export class FaceTracker {
  constructor() {
    /** @type {FaceLandmarker|null} */
    this._landmarker = null;
    /** @type {HTMLVideoElement|null} */
    this._video = null;
    /** @type {MediaStream|null} */
    this._stream = null;
    /** @type {boolean} */
    this._running = false;
    /** @type {number} */
    this._lastVideoTime = -1;

    /** @type {Object<string, number>} 52 ARKit BlendShape coefficients (0-1) */
    this.blendShapes = {};
    /** @type {Float32Array|null} 4x4 head pose matrix (column-major) */
    this.transformMatrix = null;
    /** @type {boolean} Whether a face is currently detected */
    this.faceDetected = false;
  }

  /**
   * Initialize camera and MediaPipe Face Landmarker.
   * Downloads the model on first call (~5MB).
   * @returns {Promise<boolean>}
   */
  async init() {
    try {
      // 1. Start camera (640x480, 30fps)
      this._stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 640 },
          height: { ideal: 480 },
          frameRate: { ideal: 30 },
          facingMode: 'user'
        },
        audio: false
      });

      // 2. Connect to PIP preview element
      const pipVideo = document.getElementById('pv');
      if (pipVideo) {
        pipVideo.srcObject = this._stream;
        await pipVideo.play().catch(() => {});
        // Show PIP container
        const pip = document.getElementById('pip');
        if (pip) pip.style.display = 'block';
      }

      // 3. Create internal detection video element
      this._video = document.createElement('video');
      this._video.srcObject = this._stream;
      this._video.setAttribute('playsinline', '');
      this._video.muted = true;
      await this._video.play();

      // Wait for video to have actual dimensions
      await new Promise((resolve) => {
        const check = () => {
          if (this._video.videoWidth > 0 && this._video.videoHeight > 0) resolve();
          else requestAnimationFrame(check);
        };
        check();
      });

      console.log(`[FaceTracker] Camera ready: ${this._video.videoWidth}x${this._video.videoHeight}`);

      // 4. Load MediaPipe WASM fileset
      console.log('[FaceTracker] Loading MediaPipe WASM...');
      const fileset = await FilesetResolver.forVisionTasks(
        'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm'
      );

      // 5. Create Face Landmarker (GPU first, CPU fallback)
      console.log('[FaceTracker] Loading face_landmarker.task...');
      let landmarker = null;
      try {
        landmarker = await FaceLandmarker.createFromOptions(fileset, {
          baseOptions: {
            modelAssetPath:
              'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
            delegate: 'GPU'
          },
          runningMode: 'VIDEO',
          numFaces: 1,
          outputFaceBlendshapes: true,
          outputFacialTransformationMatrixes: true
        });
        console.log('[FaceTracker] Initialized successfully (GPU delegate)');
      } catch (gpuErr) {
        console.warn('[FaceTracker] GPU delegate failed, trying CPU:', gpuErr.message);
        try {
          landmarker = await FaceLandmarker.createFromOptions(fileset, {
            baseOptions: {
              modelAssetPath:
                'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
              delegate: 'CPU'
            },
            runningMode: 'VIDEO',
            numFaces: 1,
            outputFaceBlendshapes: true,
            outputFacialTransformationMatrixes: true
          });
          console.log('[FaceTracker] Initialized successfully (CPU delegate - slower)');
        } catch (cpuErr) {
          console.error('[FaceTracker] Both GPU and CPU failed:', cpuErr);
          this._cleanup();
          return false;
        }
      }

      this._landmarker = landmarker;
      this._running = true;
      this._lastVideoTime = -1;
      this._loop();
      return true;
    } catch (err) {
      console.error('[FaceTracker] Init failed:', err);
      this._cleanup();
      return false;
    }
  }

  /**
   * Detection loop. Synchronized with video frames via requestAnimationFrame.
   * @private
   */
  _loop() {
    if (!this._running || !this._video || !this._landmarker) return;

    const detect = (now) => {
      if (!this._running) return;

      // Only detect on new video frames
      if (this._video.readyState >= 2 &&
          this._video.currentTime !== this._lastVideoTime) {
        this._lastVideoTime = this._video.currentTime;
        try {
          const result = this._landmarker.detectForVideo(this._video, now);
          this._processResult(result);
        } catch (err) {
          // Frame skip - retry next frame
        }
      }

      requestAnimationFrame(detect);
    };
    requestAnimationFrame(detect);
  }

  /**
   * Extract BlendShapes and transform matrix from MediaPipe result.
   * @private
   */
  _processResult(result) {
    // BlendShapes (52 ARKit coefficients)
    if (result.faceBlendshapes && result.faceBlendshapes.length > 0) {
      const cats = result.faceBlendshapes[0].categories;
      for (const cat of cats) {
        this.blendShapes[cat.categoryName] = cat.score;
      }
      this.faceDetected = true;
    } else {
      this.faceDetected = false;
    }

    // Head pose transformation matrix (4x4, column-major)
    if (result.facialTransformationMatrixes &&
        result.facialTransformationMatrixes.length > 0) {
      this.transformMatrix = result.facialTransformationMatrixes[0].data;
    }
  }

  /** Stop camera and release all resources. */
  stop() {
    this._running = false;
    this._cleanup();
    console.log('[FaceTracker] Stopped');
  }

  /** @private */
  _cleanup() {
    if (this._stream) {
      this._stream.getTracks().forEach((t) => t.stop());
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
    // Hide PIP
    const pip = document.getElementById('pip');
    if (pip) pip.style.display = 'none';
    const pv = document.getElementById('pv');
    if (pv) pv.srcObject = null;
  }
}
