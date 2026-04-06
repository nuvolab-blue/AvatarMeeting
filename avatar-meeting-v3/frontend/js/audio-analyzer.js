/**
 * @fileoverview Audio FFT analysis, Viseme generation, and audio emotion estimation.
 *
 * Core module for v2 architecture. Replaces the entire v1 pipeline:
 *   v1: Mic → WebSocket → FastAPI → MuseTalk → JPEG (300-800ms latency)
 *   v2: Mic → Web Audio FFT → AudioAnalyzer → Viseme (<16ms latency)
 *
 * No text transcription needed. Directly maps audio physics to mouth shapes
 * and emotion using energy, spectral centroid, pitch, and flux.
 */

class AudioAnalyzer {
  constructor() {
    /** @private {AudioContext|null} */
    this._ctx = null;
    /** @private {AnalyserNode|null} */
    this._analyserNode = null;
    /** @private {MediaStream|null} */
    this._stream = null;

    /** @private {Uint8Array|null} */
    this._dataArray = null;
    /** @private {Float32Array|null} */
    this._freqArray = null;
    /** @private {Float32Array|null} */
    this._prevSpectrum = null;

    // ---- Smoothed outputs ----
    /** @private */ this._smoothEnergy = 0;
    /** @private */ this._smoothPitch = 180;
    /** @private */ this._isSpeaking = false;

    /** @private */ this._spectralCentroid = 0;
    /** @private */ this._spectralFlux = 0;

    // ---- Viseme state ----
    /** @private */
    this._viseme = { jawOpen: 0, lipStretch: 0, lipPucker: 0, mouthWidth: 0 };
    /** @private */
    this._visemeTarget = { jawOpen: 0, lipStretch: 0, lipPucker: 0, mouthWidth: 0 };

    // ---- Emotion state ----
    /** @private */
    this._emotion = { emotion: 'neutral', intensity: 0 };
    /** @private */ this._emotionIntensity = 0;

    // ---- History buffers (60 frames) ----
    /** @private */ this._energyHistory = [];
    /** @private */ this._pitchHistory = [];

    /** @private */ this._active = false;
  }

  // ==========================================================================
  // Public properties
  // ==========================================================================

  /** @type {boolean} */
  get isActive() { return this._active; }

  /** @type {boolean} Speaking with hysteresis threshold */
  get isSpeaking() { return this._isSpeaking; }

  /** @type {number} Normalized energy 0-1 */
  get energy() { return this._smoothEnergy; }

  /** @type {number} Estimated pitch in Hz */
  get pitch() { return this._smoothPitch; }

  /** @type {number} Spectral centroid (0-frequencyBinCount) */
  get spectralCentroid() { return this._spectralCentroid; }

  /**
   * @type {{jawOpen: number, lipStretch: number, lipPucker: number, mouthWidth: number}}
   */
  get currentViseme() { return this._viseme; }

  /**
   * @type {{emotion: string, intensity: number}}
   * emotion: 'joy' | 'anger' | 'sadness' | 'surprise' | 'fear' | 'neutral'
   */
  get audioEmotion() { return this._emotion; }

  /** @type {AnalyserNode|null} For external visualizer */
  get analyser() { return this._analyserNode; }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  /**
   * Initialize microphone and Web Audio pipeline.
   * @returns {Promise<boolean>}
   */
  async init() {
    try {
      this._stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      this._ctx = new (window.AudioContext || window.webkitAudioContext)();
      const source = this._ctx.createMediaStreamSource(this._stream);

      this._analyserNode = this._ctx.createAnalyser();
      this._analyserNode.fftSize = 2048;
      this._analyserNode.smoothingTimeConstant = 0.75;

      source.connect(this._analyserNode);

      const bufLen = this._analyserNode.frequencyBinCount;
      this._dataArray = new Uint8Array(bufLen);
      this._freqArray = new Float32Array(bufLen);
      this._prevSpectrum = new Float32Array(bufLen);

      this._active = true;
      console.log('[AudioAnalyzer] Initialized — fftSize=%d, sampleRate=%d',
        this._analyserNode.fftSize, this._ctx.sampleRate);
      return true;
    } catch (err) {
      console.error('[AudioAnalyzer] Init failed:', err);
      return false;
    }
  }

  /**
   * Per-frame update. Call from requestAnimationFrame loop.
   */
  update() {
    if (!this._active || !this._analyserNode) return;

    this._analyserNode.getByteFrequencyData(this._dataArray);

    // 1. Energy
    this._calcEnergy();

    // 2. Speaking detection (hysteresis)
    const threshold = this._isSpeaking ? 0.06 : 0.10;
    this._isSpeaking = this._smoothEnergy > threshold;

    // 3. Pitch
    this._estimatePitch();

    // 4. Spectral centroid
    this._calcSpectralCentroid();

    // 5. Spectral flux
    this._calcSpectralFlux();

    // 6. History
    this._updateHistory();

    // 7. Viseme
    this._updateViseme();

    // 8. Emotion
    this._updateAudioEmotion();

    // Save current spectrum for next frame's flux
    this._prevSpectrum.set(this._dataArray);
  }

  /** Stop microphone and release resources. */
  stop() {
    this._active = false;
    if (this._stream) {
      this._stream.getTracks().forEach((t) => t.stop());
      this._stream = null;
    }
    if (this._ctx && this._ctx.state !== 'closed') {
      this._ctx.close().catch(() => {});
    }
    console.log('[AudioAnalyzer] Stopped');
  }

  // ==========================================================================
  // Private: Energy
  // ==========================================================================

  /** @private */
  _calcEnergy() {
    const data = this._dataArray;
    let sum = 0;
    for (let i = 0; i < data.length; i++) {
      const v = data[i] / 255;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / data.length);
    this._smoothEnergy = this._smoothEnergy * 0.7 + rms * 0.3;
  }

  // ==========================================================================
  // Private: Pitch estimation
  // ==========================================================================

  /** @private */
  _estimatePitch() {
    if (!this._isSpeaking) return; // Keep previous value when silent

    const data = this._dataArray;
    const sampleRate = this._ctx.sampleRate;
    const binWidth = sampleRate / this._analyserNode.fftSize;

    // Search 80-500 Hz range
    const minBin = Math.floor(80 / binWidth);
    const maxBin = Math.min(Math.ceil(500 / binWidth), data.length - 1);

    let maxVal = 0;
    let maxIdx = minBin;
    for (let i = minBin; i <= maxBin; i++) {
      if (data[i] > maxVal) {
        maxVal = data[i];
        maxIdx = i;
      }
    }

    const hz = maxIdx * binWidth;
    // Smooth pitch
    this._smoothPitch = this._smoothPitch * 0.7 + hz * 0.3;
  }

  // ==========================================================================
  // Private: Spectral centroid
  // ==========================================================================

  /** @private */
  _calcSpectralCentroid() {
    const data = this._dataArray;
    let weightedSum = 0;
    let magSum = 0;

    for (let i = 0; i < data.length; i++) {
      weightedSum += i * data[i];
      magSum += data[i];
    }

    this._spectralCentroid = magSum > 0 ? weightedSum / magSum : 0;
  }

  // ==========================================================================
  // Private: Spectral flux
  // ==========================================================================

  /** @private */
  _calcSpectralFlux() {
    const cur = this._dataArray;
    const prev = this._prevSpectrum;
    let flux = 0;

    for (let i = 0; i < cur.length; i++) {
      const diff = cur[i] - prev[i];
      if (diff > 0) flux += diff;
    }

    this._spectralFlux = Math.min(flux / 1000, 1);
  }

  // ==========================================================================
  // Private: History
  // ==========================================================================

  /** @private */
  _updateHistory() {
    this._energyHistory.push(this._smoothEnergy);
    this._pitchHistory.push(this._smoothPitch);

    if (this._energyHistory.length > 60) this._energyHistory.shift();
    if (this._pitchHistory.length > 60) this._pitchHistory.shift();
  }

  // ==========================================================================
  // Private: Viseme
  // ==========================================================================

  /** @private */
  _updateViseme() {
    const tgt = this._visemeTarget;

    if (!this._isSpeaking) {
      // Decay all parameters
      tgt.jawOpen *= 0.82;
      tgt.lipStretch *= 0.82;
      tgt.lipPucker *= 0.82;
      tgt.mouthWidth *= 0.82;

      // Cut near-zero
      if (tgt.jawOpen < 0.005) tgt.jawOpen = 0;
      if (tgt.lipStretch < 0.005) tgt.lipStretch = 0;
      if (tgt.lipPucker < 0.005) tgt.lipPucker = 0;
      if (Math.abs(tgt.mouthWidth) < 0.005) tgt.mouthWidth = 0;
    } else {
      const e = this._smoothEnergy;
      const centroidNorm = Math.min(this._spectralCentroid / 400, 1);

      tgt.jawOpen = Math.min(e * 5.0, 0.85);
      tgt.lipStretch = centroidNorm * 0.45;
      tgt.lipPucker = (1 - centroidNorm) * 0.35;
      tgt.mouthWidth = (centroidNorm - 0.5) * 0.4;
    }

    // Interpolate: faster when speaking, slower when closing
    const speed = this._isSpeaking ? 0.40 : 0.12;
    const v = this._viseme;
    v.jawOpen = v.jawOpen + (tgt.jawOpen - v.jawOpen) * speed;
    v.lipStretch = v.lipStretch + (tgt.lipStretch - v.lipStretch) * speed;
    v.lipPucker = v.lipPucker + (tgt.lipPucker - v.lipPucker) * speed;
    v.mouthWidth = v.mouthWidth + (tgt.mouthWidth - v.mouthWidth) * speed;
  }

  // ==========================================================================
  // Private: Audio emotion estimation
  // ==========================================================================

  /** @private */
  _updateAudioEmotion() {
    const pitch = this._smoothPitch;
    const energy = this._smoothEnergy;
    const flux = this._spectralFlux;

    // Variance calculations
    const pitchVar = this._variance(this._pitchHistory);
    const energyVar = this._variance(this._energyHistory);

    let emotion = 'neutral';
    let intensity = 0;

    if (this._isSpeaking) {
      // Priority-ordered rules
      if (pitch > 200 && energy > 0.22 && pitchVar > 800) {
        emotion = 'joy';
        intensity = Math.min((energy - 0.12) * 3.5, 1);
      } else if (pitch < 155 && energy > 0.28 && pitchVar < 500) {
        emotion = 'anger';
        intensity = Math.min((energy - 0.18) * 2.5, 1);
      } else if (pitch < 150 && energy < 0.14 && energyVar < 0.002) {
        emotion = 'sadness';
        intensity = Math.min((0.18 - energy) * 4, 1);
      } else if (flux > 0.25 && pitchVar > 1500) {
        emotion = 'surprise';
        intensity = Math.min(flux * 2.5, 1);
      } else if (energy > 0.10) {
        emotion = 'neutral';
        intensity = 0.15;
      }
    }

    // Smooth intensity transition
    intensity = Math.max(0, intensity);
    this._emotionIntensity = this._emotionIntensity * 0.65 + intensity * 0.35;

    // Decay when not speaking
    if (!this._isSpeaking) {
      this._emotionIntensity *= 0.93;
    }

    if (this._emotionIntensity < 0.03) {
      this._emotionIntensity = 0;
      emotion = 'neutral';
    }

    this._emotion.emotion = emotion;
    this._emotion.intensity = this._emotionIntensity;
  }

  /**
   * Compute variance of array.
   * @private
   * @param {number[]} arr
   * @returns {number}
   */
  _variance(arr) {
    if (arr.length < 2) return 0;
    let sum = 0;
    for (let i = 0; i < arr.length; i++) sum += arr[i];
    const mean = sum / arr.length;
    let v = 0;
    for (let i = 0; i < arr.length; i++) {
      const d = arr[i] - mean;
      v += d * d;
    }
    return v / arr.length;
  }
}

window.AudioAnalyzer = AudioAnalyzer;
