/**
 * @fileoverview Face tracking using MediaPipe FaceMesh.
 * Estimates head pose (yaw, pitch, roll) and facial feature parameters.
 *
 * Facial features are normalised relative to face height for robustness
 * across different camera distances and face sizes.
 */

/** Landmark indices for head pose estimation */
const NOSE_TIP = 1;
const CHIN = 152;
const LEFT_EYE_OUTER = 263;
const RIGHT_EYE_OUTER = 33;
const LEFT_MOUTH = 287;
const RIGHT_MOUTH = 57;
const FOREHEAD = 10;

/** Smoothing factor for exponential moving average */
const SMOOTH_ALPHA = 0.35;

/** Clamp ranges (degrees) */
const YAW_MAX = 45;
const PITCH_MAX = 45;
const ROLL_MAX = 30;

class FaceTracker {
  constructor() {
    /** @private */ this._faceMesh = null;
    /** @private */ this._camera = null;
    /** @private */ this._animFrame = null;
    /** @private */ this._isRunning = false;

    // Smoothed head pose
    /** @private */ this._smoothYaw = 0;
    /** @private */ this._smoothPitch = 0;
    /** @private */ this._smoothRoll = 0;

    // Smoothed facial features
    /** @private */ this._smoothMouthOpen = 0;
    /** @private */ this._smoothBrowRaise = 0;
    /** @private */ this._smoothEyeOpen = 0.5;

    // Calibration: first N frames establish baseline
    /** @private */ this._calibFrames = 0;
    /** @private */ this._calibSamples = { mouth: [], brow: [], eye: [] };
    /** @private */ this._baseline = null;

    // Callbacks
    /** @private */ this._onHeadPose = null;
    /** @private */ this._onFacialFeatures = null;
  }

  /**
   * Initialise MediaPipe FaceMesh.
   */
  async init() {
    if (typeof FaceMesh === 'undefined') {
      console.warn('[FaceTracker] MediaPipe FaceMesh not loaded.');
      return;
    }

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
    console.log('[FaceTracker] Initialised');
  }

  /**
   * Process a video frame for face detection.
   * @param {HTMLVideoElement} videoElement
   */
  async processFrame(videoElement) {
    if (!this._faceMesh) return;
    try {
      await this._faceMesh.send({ image: videoElement });
    } catch (err) {
      console.error('[FaceTracker] processFrame error:', err);
    }
  }

  /**
   * Start continuous face tracking from a video element.
   * @param {HTMLVideoElement} videoElement
   */
  start(videoElement) {
    this._isRunning = true;
    const loop = async () => {
      if (!this._isRunning) return;
      if (videoElement.readyState >= 2) {
        await this.processFrame(videoElement);
      }
      this._animFrame = requestAnimationFrame(loop);
    };
    this._animFrame = requestAnimationFrame(loop);
    console.log('[FaceTracker] Tracking started');
  }

  /** Stop face tracking. */
  stop() {
    this._isRunning = false;
    if (this._animFrame) {
      cancelAnimationFrame(this._animFrame);
      this._animFrame = null;
    }
  }

  /** @param {function({yaw:number, pitch:number, roll:number}):void} cb */
  onHeadPose(cb) { this._onHeadPose = cb; }

  /** @param {function({mouthOpen:number, browRaise:number, eyeOpen:number}):void} cb */
  onFacialFeatures(cb) { this._onFacialFeatures = cb; }

  // ---- Private ----

  /**
   * Handle FaceMesh results.
   * @private
   */
  _onResults(results) {
    if (!results.multiFaceLandmarks || results.multiFaceLandmarks.length === 0) {
      return;
    }

    const landmarks = results.multiFaceLandmarks[0];

    // Head pose
    const pose = this._estimateHeadPose(landmarks);
    this._smoothYaw = this._ema(this._smoothYaw, pose.yaw, SMOOTH_ALPHA);
    this._smoothPitch = this._ema(this._smoothPitch, pose.pitch, SMOOTH_ALPHA);
    this._smoothRoll = this._ema(this._smoothRoll, pose.roll, SMOOTH_ALPHA);

    const smoothedPose = {
      yaw: this._clamp(this._smoothYaw, -YAW_MAX, YAW_MAX),
      pitch: this._clamp(this._smoothPitch, -PITCH_MAX, PITCH_MAX),
      roll: this._clamp(this._smoothRoll, -ROLL_MAX, ROLL_MAX),
    };

    if (this._onHeadPose) this._onHeadPose(smoothedPose);

    // Facial features
    const features = this._extractFacialFeatures(landmarks);
    if (features && this._onFacialFeatures) {
      this._onFacialFeatures(features);
    }
  }

  /**
   * Estimate yaw, pitch, roll from key landmarks.
   * @private
   */
  _estimateHeadPose(landmarks) {
    const nose = landmarks[NOSE_TIP];
    const chin = landmarks[CHIN];
    const leftEye = landmarks[LEFT_EYE_OUTER];
    const rightEye = landmarks[RIGHT_EYE_OUTER];

    // Yaw
    const eyeMidX = (leftEye.x + rightEye.x) / 2;
    const eyeWidth = Math.abs(leftEye.x - rightEye.x);
    const yaw = eyeWidth > 0.001 ? ((nose.x - eyeMidX) / eyeWidth) * 90 : 0;

    // Pitch
    const eyeMidY = (leftEye.y + rightEye.y) / 2;
    const faceHeight = Math.abs(chin.y - eyeMidY);
    const noseMidRatio = faceHeight > 0.001 ? (nose.y - eyeMidY) / faceHeight : 0.5;
    const pitch = (noseMidRatio - 0.5) * -90;

    // Roll
    const dx = leftEye.x - rightEye.x;
    const dy = leftEye.y - rightEye.y;
    const roll = Math.atan2(dy, dx) * (180 / Math.PI);

    return { yaw, pitch, roll };
  }

  /**
   * Extract facial feature parameters from landmarks.
   * All values are normalised relative to face height for robustness.
   * Uses calibration baseline from first 30 frames.
   * @private
   * @returns {object|null} null during calibration
   */
  _extractFacialFeatures(landmarks) {
    // Reference face height for normalisation
    const faceTop = landmarks[FOREHEAD].y;
    const chinY = landmarks[CHIN].y;
    const faceH = Math.abs(chinY - faceTop);
    if (faceH < 0.01) return null;

    // Raw measurements (normalised by face height)
    const upperLip = landmarks[13];
    const lowerLip = landmarks[14];
    const rawMouth = Math.abs(upperLip.y - lowerLip.y) / faceH;

    const leftBrow = landmarks[105];
    const leftEyeTop = landmarks[159];
    const rawBrow = Math.abs(leftEyeTop.y - leftBrow.y) / faceH;

    const leftEyeUpper = landmarks[159];
    const leftEyeLower = landmarks[145];
    const rawEye = Math.abs(leftEyeUpper.y - leftEyeLower.y) / faceH;

    // Calibration phase: collect baseline samples
    if (this._calibFrames < 15) {
      this._calibSamples.mouth.push(rawMouth);
      this._calibSamples.brow.push(rawBrow);
      this._calibSamples.eye.push(rawEye);
      this._calibFrames++;

      if (this._calibFrames === 15) {
        // Use median as baseline (robust to outliers)
        this._baseline = {
          mouth: this._median(this._calibSamples.mouth),
          brow: this._median(this._calibSamples.brow),
          eye: this._median(this._calibSamples.eye),
        };
        console.log('[FaceTracker] Baseline calibrated:', this._baseline);
        this._calibSamples = null; // free memory
      }

      // During calibration, return neutral values
      return { mouthOpen: 0, browRaise: 0, eyeOpen: 0.5 };
    }

    const bl = this._baseline;

    // Mouth: how much wider than baseline (closed mouth)
    // rawMouth for closed ~0.01-0.02, open ~0.06-0.10 (relative to face height)
    const mouthDelta = Math.max(0, rawMouth - bl.mouth);
    const mouthOpen = this._clamp(mouthDelta / 0.04, 0, 1);

    // Brow: how much higher than baseline
    const browDelta = Math.max(0, rawBrow - bl.brow);
    const browRaise = this._clamp(browDelta / 0.025, 0, 1);

    // Eye: ratio relative to baseline (0.5 = neutral, 0 = closed, 1 = wide)
    const eyeRatio = bl.eye > 0.001 ? rawEye / bl.eye : 1;
    const eyeOpen = this._clamp((eyeRatio - 0.3) / 1.4, 0, 1);

    // Smooth features
    this._smoothMouthOpen = this._ema(this._smoothMouthOpen, mouthOpen, 0.4);
    this._smoothBrowRaise = this._ema(this._smoothBrowRaise, browRaise, 0.3);
    this._smoothEyeOpen = this._ema(this._smoothEyeOpen, eyeOpen, 0.3);

    return {
      mouthOpen: this._smoothMouthOpen,
      browRaise: this._smoothBrowRaise,
      eyeOpen: this._smoothEyeOpen,
    };
  }

  /**
   * Compute median of an array.
   * @private
   */
  _median(arr) {
    const sorted = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
      ? (sorted[mid - 1] + sorted[mid]) / 2
      : sorted[mid];
  }

  /** @private */
  _ema(prev, current, alpha) {
    return prev + alpha * (current - prev);
  }

  /** @private */
  _clamp(val, min, max) {
    return Math.max(min, Math.min(max, val));
  }
}

export default FaceTracker;
