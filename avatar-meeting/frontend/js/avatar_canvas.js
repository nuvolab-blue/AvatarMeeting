/**
 * @fileoverview Canvas compositing engine for lip-sync avatar rendering.
 *
 * Key design: The uploaded image frame is FIXED. Facial deformation (mouth,
 * eyes, brows) is performed by the LipSyncLocal engine using drawImage
 * strip-warping. Head pose is reflected as a subtle translation shift.
 *
 * Two rendering modes:
 *  1. MuseTalk frames — server sends pre-rendered JPEG frames (ideal)
 *  2. Local lip-sync  — client-side deformation from audio + camera (fallback)
 */

import LipSyncLocal from './lip_sync_local.js';

const LIPSYNC_FPS = 25;
const FRAME_INTERVAL = 1000 / LIPSYNC_FPS;
const IDLE_GRACE_MS = 600;
const FALLBACK_DELAY_MS = 3000;

const EMOTION_EFFECTS = {
  joy:      { overlay: 'rgba(255, 200, 50, 0.08)',  filter: 'brightness(1.08) saturate(1.15)' },
  anger:    { overlay: 'rgba(220, 40, 40, 0.10)',    filter: 'brightness(0.95) saturate(1.2)' },
  sadness:  { overlay: 'rgba(60, 80, 180, 0.10)',    filter: 'brightness(0.92) saturate(0.85)' },
  surprise: { overlay: 'rgba(255, 220, 100, 0.06)',  filter: 'brightness(1.10) contrast(1.05)' },
  fear:     { overlay: 'rgba(100, 60, 150, 0.08)',   filter: 'brightness(0.90) saturate(0.8)' },
  neutral:  { overlay: null,                          filter: 'none' },
};

class AvatarCanvas {
  /** @param {HTMLCanvasElement} canvasElement */
  constructor(canvasElement) {
    this._canvas = canvasElement;
    this._ctx = canvasElement.getContext('2d');

    // Frame scheduling (MuseTalk)
    this._frameStore = {};
    this._frameTimers = [];
    this._lastFrameEndTime = 0;
    this._idleTimer = null;
    this._isLipsyncMode = false;

    // Static avatar image
    this._staticImage = null;

    // Local lip-sync engine
    this._lipSync = new LipSyncLocal();
    this._lipSyncReady = false;

    // Animation loop
    this._animFrame = null;

    // Emotion
    this._currentEmotion = 'neutral';

    // MuseTalk availability
    this._hasMuseTalkFrames = false;
  }

  // ---- Public API ----

  /**
   * Load avatar image and initialise local lip-sync.
   * @param {string} src - Image URL or data URI
   */
  async showStaticImage(src) {
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
      img.src = src;
    });
    this._staticImage = img;

    // Draw immediately
    this._drawStatic();

    // Init local lip-sync (always succeeds — has fallback proportions)
    this._lipSyncReady = await this._lipSync.init(img);
    console.log('[AvatarCanvas] Local lip-sync ready:', this._lipSyncReady);

    // Always start the animation loop
    this._startAnimationLoop();
  }

  /**
   * Set audio amplitude for mouth movement.
   * @param {number} rms - 0 to 1
   */
  setAudioAmplitude(rms) {
    if (this._lipSyncReady) {
      this._lipSync.setAudioAmplitude(rms);
    }
  }

  /**
   * Set facial features from camera face tracker.
   * @param {{mouthOpen:number, browRaise:number, eyeOpen:number}} features
   */
  setFacialFeatures(features) {
    if (this._lipSyncReady) {
      this._lipSync.setFacialFeatures(features);
    }
  }

  /**
   * Set head pose for subtle avatar shift.
   * Uses translation only (no rotation) to avoid the previous zoom/rotation bugs.
   * @param {number} yaw - degrees
   * @param {number} pitch - degrees
   * @param {number} roll - degrees (currently unused)
   */
  setHeadPose(yaw, pitch, roll) {
    if (this._lipSyncReady) {
      this._lipSync.setHeadPose(yaw, pitch);
    }
  }

  /**
   * Enable head pose tracking (called after warm-up frames).
   * Now actually does something since head pose uses safe translation.
   */
  enableHeadPose() {
    // Head pose is always enabled via setHeadPose → LipSyncLocal.setHeadPose
    console.log('[AvatarCanvas] Head pose enabled (translation mode)');
  }

  /**
   * Schedule MuseTalk-generated frames for playback.
   */
  async scheduleFrames(chunkId, jpegFramesB64, wallStartTime) {
    if (!jpegFramesB64 || jpegFramesB64.length === 0) return;

    this._hasMuseTalkFrames = true;
    this._stopAnimationLoop();
    this._isLipsyncMode = true;

    const bitmaps = await Promise.all(
      jpegFramesB64.map(async (b64) => {
        const binary = atob(b64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const blob = new Blob([bytes], { type: 'image/jpeg' });
        return createImageBitmap(blob);
      })
    );

    this._frameStore[chunkId] = { frames: bitmaps, scheduled: true };

    const now = performance.now();
    bitmaps.forEach((bitmap, i) => {
      const delay = Math.max(0, wallStartTime + i * FRAME_INTERVAL - now);
      const timerId = setTimeout(() => {
        this._drawMuseTalkFrame(bitmap);
        this._lastFrameEndTime = performance.now();
      }, delay);
      this._frameTimers.push(timerId);
    });

    const fallbackId = setTimeout(() => {
      if (!this._frameStore[chunkId]?.scheduled) {
        this._isLipsyncMode = false;
        this._startAnimationLoop();
      }
    }, FALLBACK_DELAY_MS);
    this._frameTimers.push(fallbackId);
  }

  handleDone(chunkId) {
    const store = this._frameStore[chunkId];
    if (store) {
      setTimeout(() => {
        store.frames.forEach((bm) => { try { bm.close(); } catch {} });
        delete this._frameStore[chunkId];
      }, 2000);
    }

    // Only restart animation loop if MuseTalk was active
    if (this._isLipsyncMode) {
      if (this._idleTimer) clearTimeout(this._idleTimer);
      const idleDelay = Math.max(IDLE_GRACE_MS,
        this._lastFrameEndTime - performance.now() + IDLE_GRACE_MS);
      this._idleTimer = setTimeout(() => {
        this._isLipsyncMode = false;
        this._startAnimationLoop();
      }, idleDelay);
    }
  }

  setEmotion(emotionParams, emotionLabel = 'neutral') {
    this._currentEmotion = emotionLabel;
  }

  resetAV() {
    this._frameTimers.forEach((id) => clearTimeout(id));
    this._frameTimers = [];
    if (this._idleTimer) { clearTimeout(this._idleTimer); this._idleTimer = null; }
    for (const key of Object.keys(this._frameStore)) {
      this._frameStore[key].frames.forEach((bm) => { try { bm.close(); } catch {} });
    }
    this._frameStore = {};
    this._lastFrameEndTime = 0;
    this._isLipsyncMode = false;
    this._stopAnimationLoop();
    this._canvas.style.transform = 'none';
    this._canvas.style.filter = 'none';
    this._ctx.clearRect(0, 0, this._canvas.width, this._canvas.height);
  }

  get canvas() { return this._canvas; }

  // ---- Private: drawing ----

  /** @private */
  _drawStatic() {
    if (!this._staticImage) return;
    const ctx = this._ctx;
    const w = this._canvas.width;
    const h = this._canvas.height;

    ctx.clearRect(0, 0, w, h);
    this._canvas.style.transform = 'none';
    this._canvas.style.filter = 'none';

    const { dx, dy, dw, dh } = this._aspectFit(this._staticImage, w, h);
    ctx.drawImage(this._staticImage, dx, dy, dw, dh);
  }

  /** @private */
  _drawMuseTalkFrame(bitmap) {
    const ctx = this._ctx;
    const w = this._canvas.width;
    const h = this._canvas.height;

    ctx.clearRect(0, 0, w, h);
    this._applyEmotionFilter();
    ctx.drawImage(bitmap, 0, 0, w, h);
    this._drawEmotionOverlay();
  }

  /** @private */
  _drawLocalLipSync() {
    if (!this._staticImage) return;
    const ctx = this._ctx;
    const w = this._canvas.width;
    const h = this._canvas.height;

    ctx.clearRect(0, 0, w, h);
    this._applyEmotionFilter();

    const { dx, dy, dw, dh } = this._aspectFit(this._staticImage, w, h);

    if (this._lipSyncReady) {
      this._lipSync.render(ctx, dx, dy, dw, dh);
    } else {
      ctx.drawImage(this._staticImage, dx, dy, dw, dh);
    }

    this._drawEmotionOverlay();
  }

  /** @private */
  _applyEmotionFilter() {
    const effect = EMOTION_EFFECTS[this._currentEmotion] || EMOTION_EFFECTS.neutral;
    this._canvas.style.filter = effect.filter;
  }

  /** @private */
  _drawEmotionOverlay() {
    const effect = EMOTION_EFFECTS[this._currentEmotion] || EMOTION_EFFECTS.neutral;
    if (effect.overlay) {
      const ctx = this._ctx;
      ctx.save();
      ctx.globalCompositeOperation = 'source-atop';
      ctx.fillStyle = effect.overlay;
      ctx.fillRect(0, 0, this._canvas.width, this._canvas.height);
      ctx.restore();
    }
  }

  /** @private */
  _aspectFit(source, canvasW, canvasH) {
    const srcW = source.naturalWidth || source.width;
    const srcH = source.naturalHeight || source.height;
    const imgAspect = srcW / srcH;
    const canvasAspect = canvasW / canvasH;
    let dw, dh, dx, dy;
    if (imgAspect > canvasAspect) {
      dw = canvasW; dh = canvasW / imgAspect; dx = 0; dy = (canvasH - dh) / 2;
    } else {
      dh = canvasH; dw = canvasH * imgAspect; dx = (canvasW - dw) / 2; dy = 0;
    }
    return { dx, dy, dw, dh };
  }

  // ---- Private: animation loop ----

  /** @private */
  _startAnimationLoop() {
    this._stopAnimationLoop();
    const loop = () => {
      if (this._isLipsyncMode) return; // MuseTalk frames active
      this._drawLocalLipSync();
      this._animFrame = requestAnimationFrame(loop);
    };
    this._animFrame = requestAnimationFrame(loop);
  }

  /** @private */
  _stopAnimationLoop() {
    if (this._animFrame) {
      cancelAnimationFrame(this._animFrame);
      this._animFrame = null;
    }
  }
}

export default AvatarCanvas;
