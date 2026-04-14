/**
 * @fileoverview Audio-based emotion analyzer using Web Audio FFT.
 *
 * Extracts paralinguistic features (pitch, energy, spectral centroid, etc.)
 * and maps them to a valence-arousal 2D emotion space, updated at ~30Hz.
 *
 * Privacy: all processing happens in-browser. No audio leaves the device.
 * Latency: ~50ms (one analysis frame at 30Hz).
 */

export class AudioEmotionAnalyzer {
  constructor() {
    this._ctx = null;
    this._stream = null;
    this._analyser = null;
    this._source = null;
    this._freqBuf = null;
    this._freqFloatBuf = null;
    this._timeBuf = null;
    this._running = false;
    this._rafId = null;

    // Smoothed output state
    this.state = {
      valence: 0,
      arousal: 0,
      energy: 0,
      pitch: null,
      active: false,
    };

    // Baseline calibration state
    this._pitchHistory = [];
    this._energyHistory = [];
    this._lastFrameTime = 0;
    this._prevSpectrum = null;

    // User-controllable
    this.enabled = true;
    this.sensitivity = 1.0;
    this.vadThreshold = 0.015;
  }

  /**
   * Initialize with an independent microphone-only MediaStream.
   * @param {MediaStream} stream - Must contain audio tracks
   * @returns {Promise<boolean>}
   */
  async init(stream) {
    try {
      if (!stream || stream.getAudioTracks().length === 0) {
        console.error('[EmotionAnalyzer] No audio tracks in stream');
        return false;
      }
      this._stream = stream;
      this._ctx = new (window.AudioContext || window.webkitAudioContext)();
      this._source = this._ctx.createMediaStreamSource(stream);
      this._analyser = this._ctx.createAnalyser();
      this._analyser.fftSize = 2048;
      this._analyser.smoothingTimeConstant = 0.3;
      this._source.connect(this._analyser);

      this._freqBuf = new Uint8Array(this._analyser.frequencyBinCount);
      this._freqFloatBuf = new Float32Array(this._analyser.frequencyBinCount);
      this._timeBuf = new Float32Array(this._analyser.fftSize);
      this._prevSpectrum = new Float32Array(this._analyser.frequencyBinCount);

      this._running = true;
      this._loop();

      console.log(
        `[EmotionAnalyzer] Initialized (sampleRate=${this._ctx.sampleRate}, ` +
        `fftSize=${this._analyser.fftSize})`
      );
      return true;
    } catch (err) {
      console.error('[EmotionAnalyzer] Init failed:', err);
      return false;
    }
  }

  stop() {
    this._running = false;
    if (this._rafId) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
    if (this._source) {
      try { this._source.disconnect(); } catch (e) { /* ignore */ }
      this._source = null;
    }
    if (this._ctx) {
      try { this._ctx.close(); } catch (e) { /* ignore */ }
      this._ctx = null;
    }
    if (this._stream) {
      this._stream.getTracks().forEach((t) => t.stop());
      this._stream = null;
    }
    this.state = { valence: 0, arousal: 0, energy: 0, pitch: null, active: false };
  }

  _loop() {
    if (!this._running || !this._analyser) return;
    const now = performance.now();
    if (now - this._lastFrameTime >= 30) {
      this._lastFrameTime = now;
      this._analyzeFrame();
    }
    this._rafId = requestAnimationFrame(() => this._loop());
  }

  _analyzeFrame() {
    if (!this.enabled) return;

    this._analyser.getByteFrequencyData(this._freqBuf);
    this._analyser.getFloatFrequencyData(this._freqFloatBuf);
    this._analyser.getFloatTimeDomainData(this._timeBuf);

    // --- 1. RMS Energy ---
    let sumSq = 0;
    for (let i = 0; i < this._timeBuf.length; i++) {
      sumSq += this._timeBuf[i] * this._timeBuf[i];
    }
    const rms = Math.sqrt(sumSq / this._timeBuf.length);
    const energy = Math.min(1, rms * 10);
    const active = energy > this.vadThreshold;

    // --- 2. Pitch (80-400Hz range) ---
    const sampleRate = this._ctx.sampleRate;
    const binSize = sampleRate / this._analyser.fftSize;
    const minBin = Math.floor(80 / binSize);
    const maxBin = Math.floor(400 / binSize);

    let maxVal = -Infinity;
    let maxBinIdx = -1;
    for (let i = minBin; i <= maxBin; i++) {
      if (this._freqFloatBuf[i] > maxVal) {
        maxVal = this._freqFloatBuf[i];
        maxBinIdx = i;
      }
    }

    let pitch = null;
    if (active && maxBinIdx > 0 && maxVal > -60) {
      const alpha = this._freqFloatBuf[maxBinIdx - 1] ?? maxVal;
      const beta = maxVal;
      const gamma = this._freqFloatBuf[maxBinIdx + 1] ?? maxVal;
      const denom = alpha - 2 * beta + gamma;
      const p = denom !== 0 ? 0.5 * (alpha - gamma) / denom : 0;
      pitch = (maxBinIdx + p) * binSize;
    }

    // --- 3. Spectral Centroid ---
    let weightedSum = 0;
    let totalMag = 0;
    for (let i = 1; i < this._freqBuf.length; i++) {
      const mag = this._freqBuf[i];
      weightedSum += mag * i * binSize;
      totalMag += mag;
    }
    const centroid = totalMag > 0 ? weightedSum / totalMag : 0;
    const normCentroid = Math.min(1, centroid / 4000);

    // --- 4. Spectral Flux ---
    let flux = 0;
    if (this._prevSpectrum && active) {
      for (let i = 0; i < this._freqBuf.length; i++) {
        const diff = this._freqBuf[i] - this._prevSpectrum[i];
        if (diff > 0) flux += diff;
      }
      flux /= this._freqBuf.length;
    }
    const normFlux = Math.min(1, flux / 20);

    for (let i = 0; i < this._freqBuf.length; i++) {
      this._prevSpectrum[i] = this._freqBuf[i];
    }

    // --- 5. Baseline calibration ---
    if (active && pitch !== null) {
      this._pitchHistory.push(pitch);
      if (this._pitchHistory.length > 100) this._pitchHistory.shift();
    }
    if (active) {
      this._energyHistory.push(energy);
      if (this._energyHistory.length > 100) this._energyHistory.shift();
    }

    const medianPitch = this._median(this._pitchHistory) || 150;
    const medianEnergy = this._median(this._energyHistory) || 0.1;
    const pitchDev = pitch ? (pitch - medianPitch) / medianPitch : 0;
    const energyDev = (energy - medianEnergy) / Math.max(medianEnergy, 0.05);

    // --- 6. Map to Valence-Arousal ---
    let arousal = 0.3 + energyDev * 0.4 + normFlux * 0.3;
    arousal = Math.max(0, Math.min(1, arousal));

    let valence = pitchDev * 0.5 + normCentroid * 0.3 - energyDev * 0.2;
    valence = Math.max(-1, Math.min(1, valence));

    valence *= this.sensitivity;
    arousal *= this.sensitivity;

    // --- 7. Smooth outputs ---
    const smoothingAlpha = active ? 0.15 : 0.05;
    this.state.valence += (valence - this.state.valence) * smoothingAlpha;
    this.state.arousal += (arousal * (active ? 1 : 0.3) - this.state.arousal) * smoothingAlpha;
    this.state.energy += (energy - this.state.energy) * 0.2;
    this.state.pitch = pitch;
    this.state.active = active;
  }

  _median(arr) {
    if (arr.length === 0) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  setEnabled(enabled) {
    this.enabled = !!enabled;
    if (!enabled) {
      this.state = { valence: 0, arousal: 0, energy: 0, pitch: null, active: false };
    }
  }

  setSensitivity(s) {
    this.sensitivity = Math.max(0, Math.min(2, s));
  }

  resetBaseline() {
    this._pitchHistory = [];
    this._energyHistory = [];
  }
}

// ============================================================================
// Emotion → Blendshape bias mapping
// ============================================================================
/**
 * Convert valence-arousal state to blendshape bias values.
 * @param {Object} state - {valence, arousal, active}
 * @param {number} strength - 0..1
 * @returns {Object<string, number>} Partial blendshape deltas
 */
export function emotionToBlendshapeBias(state, strength = 1.0) {
  const bias = {};
  if (!state.active) return bias;

  const v = state.valence;
  const a = state.arousal;
  const s = strength;

  // Positive + High Arousal (joy, excitement, surprise)
  if (v > 0 && a > 0.5) {
    const gain = a * s;
    bias.mouthSmileLeft = v * 0.25 * gain;
    bias.mouthSmileRight = v * 0.25 * gain;
    bias.eyeWideLeft = v * 0.12 * gain;
    bias.eyeWideRight = v * 0.12 * gain;
    bias.browInnerUp = v * 0.10 * gain;
    bias.browOuterUpLeft = v * 0.15 * gain;
    bias.browOuterUpRight = v * 0.15 * gain;
  }
  // Positive + Low Arousal (content, calm)
  else if (v > 0 && a <= 0.5) {
    const gain = v * s;
    bias.mouthSmileLeft = 0.10 * gain;
    bias.mouthSmileRight = 0.10 * gain;
    bias.eyeSquintLeft = 0.05 * gain;
    bias.eyeSquintRight = 0.05 * gain;
  }
  // Negative + High Arousal (anger, fear)
  else if (v < 0 && a > 0.5) {
    const absV = -v;
    const gain = a * s;
    bias.browDownLeft = absV * 0.20 * gain;
    bias.browDownRight = absV * 0.20 * gain;
    bias.mouthFrownLeft = absV * 0.15 * gain;
    bias.mouthFrownRight = absV * 0.15 * gain;
    bias.mouthPressLeft = absV * 0.10 * gain;
    bias.mouthPressRight = absV * 0.10 * gain;
    bias.noseSneerLeft = absV * 0.08 * gain;
    bias.noseSneerRight = absV * 0.08 * gain;
    if (a > 0.7) {
      bias.eyeSquintLeft = absV * 0.10 * gain;
      bias.eyeSquintRight = absV * 0.10 * gain;
    }
  }
  // Negative + Low Arousal (sadness)
  else if (v < 0 && a <= 0.5) {
    const absV = -v;
    const gain = absV * s;
    bias.mouthFrownLeft = 0.12 * gain;
    bias.mouthFrownRight = 0.12 * gain;
    bias.browInnerUp = 0.18 * gain;
    bias.mouthShrugLower = 0.08 * gain;
  }

  return bias;
}
