/**
 * @fileoverview MediaPipe Pose Landmarker wrapper.
 *
 * Detects 33 body landmarks (shoulders, elbows, wrists, hips, etc.)
 * from the user's webcam. Shares the camera stream with FaceTracker.
 *
 * Outputs worldLandmarks (3D coordinates in meters) for upper-body
 * bone rotation computation.
 */

import {
  PoseLandmarker,
  FilesetResolver
} from 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/vision_bundle.mjs';
import { OneEuroFilter } from './one-euro-filter.js';

export class PoseTracker {
  constructor() {
    /** @type {PoseLandmarker|null} */
    this._landmarker = null;
    /** @type {HTMLVideoElement|null} */
    this._video = null;
    /** @type {boolean} */
    this._running = false;
    /** @type {number} */
    this._lastVideoTime = -1;

    /** @type {Array|null} 33 world landmarks (x/y/z in meters + visibility) */
    this.worldLandmarks = null;
    /** @type {boolean} Whether a pose is currently detected */
    this.poseDetected = false;

    // 1€ filters for world landmarks (one trio per landmark, lazy-init)
    this._lmFilters = new Map();
  }

  /**
   * Initialize Pose Landmarker using an existing camera stream.
   * @param {MediaStream} stream - Camera stream (shared from FaceTracker)
   * @returns {Promise<boolean>}
   */
  async init(stream) {
    try {
      // Create a separate video element from the shared stream
      this._video = document.createElement('video');
      this._video.srcObject = stream;
      this._video.setAttribute('playsinline', '');
      this._video.muted = true;
      await this._video.play();

      await new Promise((resolve) => {
        const check = () => {
          if (this._video.videoWidth > 0 && this._video.videoHeight > 0) resolve();
          else requestAnimationFrame(check);
        };
        check();
      });

      console.log(`[PoseTracker] Video ready: ${this._video.videoWidth}x${this._video.videoHeight}`);

      // Load MediaPipe WASM (shared with FaceTracker, cached by browser)
      console.log('[PoseTracker] Loading pose_landmarker_lite.task...');
      const fileset = await FilesetResolver.forVisionTasks(
        'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm'
      );

      // Create Pose Landmarker (GPU first, CPU fallback)
      let landmarker = null;
      try {
        landmarker = await PoseLandmarker.createFromOptions(fileset, {
          baseOptions: {
            modelAssetPath:
              'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
            delegate: 'GPU'
          },
          runningMode: 'VIDEO',
          numPoses: 1,
        });
        console.log('[PoseTracker] Initialized (GPU delegate)');
      } catch (gpuErr) {
        console.warn('[PoseTracker] GPU failed, trying CPU:', gpuErr.message);
        try {
          landmarker = await PoseLandmarker.createFromOptions(fileset, {
            baseOptions: {
              modelAssetPath:
                'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
              delegate: 'CPU'
            },
            runningMode: 'VIDEO',
            numPoses: 1,
          });
          console.log('[PoseTracker] Initialized (CPU delegate - slower)');
        } catch (cpuErr) {
          console.error('[PoseTracker] Both GPU and CPU failed:', cpuErr);
          this._cleanup();
          return false;
        }
      }

      this._landmarker = landmarker;
      this._running = true;
      this._loop();
      return true;
    } catch (err) {
      console.error('[PoseTracker] Init error:', err);
      this._cleanup();
      return false;
    }
  }

  /**
   * Detection loop. Runs at display refresh rate.
   * @private
   */
  _loop() {
    if (!this._running || !this._video || !this._landmarker) return;

    const detect = (now) => {
      if (!this._running) return;

      if (this._video.readyState >= 2 &&
          this._video.currentTime !== this._lastVideoTime) {
        this._lastVideoTime = this._video.currentTime;
        try {
          const result = this._landmarker.detectForVideo(this._video, now);
          if (result.worldLandmarks && result.worldLandmarks.length > 0) {
            const lms = result.worldLandmarks[0];
            const t = performance.now() / 1000;
            for (let i = 0; i < lms.length; i++) {
              let trio = this._lmFilters.get(i);
              if (!trio) {
                trio = {
                  fx: new OneEuroFilter({ minCutoff: 1.0, beta: 0.05 }),
                  fy: new OneEuroFilter({ minCutoff: 1.0, beta: 0.05 }),
                  fz: new OneEuroFilter({ minCutoff: 1.0, beta: 0.05 }),
                };
                this._lmFilters.set(i, trio);
              }
              lms[i].x = trio.fx.filter(lms[i].x, t);
              lms[i].y = trio.fy.filter(lms[i].y, t);
              lms[i].z = trio.fz.filter(lms[i].z, t);
            }
            this.worldLandmarks = lms;
            this.poseDetected = true;
          } else {
            this.poseDetected = false;
          }
        } catch (e) {
          // Frame skip - retry next frame
        }
      }

      requestAnimationFrame(detect);
    };
    requestAnimationFrame(detect);
  }

  /** Stop tracking and release resources. */
  stop() {
    this._running = false;
    this._cleanup();
    console.log('[PoseTracker] Stopped');
  }

  /** @private */
  _cleanup() {
    if (this._video) {
      this._video.srcObject = null;
      this._video = null;
    }
    if (this._landmarker) {
      try { this._landmarker.close(); } catch (e) { /* ignore */ }
      this._landmarker = null;
    }
    this.poseDetected = false;
    this.worldLandmarks = null;
  }
}
