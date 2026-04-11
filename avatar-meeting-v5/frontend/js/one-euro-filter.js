/**
 * @fileoverview 1€ Filter — adaptive low-pass filter for noisy real-time signals.
 *
 * Reference: Casiez et al., "1€ Filter: A Simple Speed-based Low-pass Filter
 * for Noisy Input in Interactive Systems" (CHI 2012).
 *
 * Key insight: cutoff frequency adapts to signal velocity.
 *  - Low velocity (still pose) → strong filtering, removes jitter
 *  - High velocity (rapid motion) → weak filtering, no lag
 *
 * This is THE standard solution for MediaPipe-style noisy landmark streams.
 */

class LowPassFilter {
  constructor() {
    this._y = null;
    this._s = null;
  }
  filter(value, alpha) {
    if (this._y === null) {
      this._s = value;
    } else {
      this._s = alpha * value + (1 - alpha) * this._s;
    }
    this._y = value;
    return this._s;
  }
  lastValue() { return this._y; }
}

export class OneEuroFilter {
  /**
   * @param {Object} options
   * @param {number} [options.minCutoff=1.0] - Min cutoff frequency (Hz). Lower = smoother.
   * @param {number} [options.beta=0.007] - Speed coefficient. Higher = more responsive.
   * @param {number} [options.dCutoff=1.0] - Derivative cutoff frequency.
   */
  constructor(options = {}) {
    this.minCutoff = options.minCutoff ?? 1.0;
    this.beta = options.beta ?? 0.007;
    this.dCutoff = options.dCutoff ?? 1.0;
    this._x = new LowPassFilter();
    this._dx = new LowPassFilter();
    this._lastTime = null;
  }

  /** Compute alpha from cutoff and rate */
  _alpha(cutoff, rate) {
    const tau = 1.0 / (2 * Math.PI * cutoff);
    const te = 1.0 / rate;
    return 1.0 / (1.0 + tau / te);
  }

  /**
   * Filter a single value.
   * @param {number} value
   * @param {number} timestamp - in seconds
   * @returns {number}
   */
  filter(value, timestamp) {
    if (this._lastTime === null) {
      this._lastTime = timestamp;
      return this._x.filter(value, 1.0);
    }
    const dt = Math.max(1e-6, timestamp - this._lastTime);
    const rate = 1.0 / dt;
    this._lastTime = timestamp;

    // Estimate derivative
    const dValue = this._x.lastValue() === null
      ? 0
      : (value - this._x.lastValue()) * rate;
    const edValue = this._dx.filter(dValue, this._alpha(this.dCutoff, rate));

    // Adapt cutoff based on speed
    const cutoff = this.minCutoff + this.beta * Math.abs(edValue);
    return this._x.filter(value, this._alpha(cutoff, rate));
  }

  reset() {
    this._x = new LowPassFilter();
    this._dx = new LowPassFilter();
    this._lastTime = null;
  }
}

/**
 * Vector3 wrapper — applies 1€ filter to each component independently.
 */
export class OneEuroFilterVec3 {
  constructor(options) {
    this._fx = new OneEuroFilter(options);
    this._fy = new OneEuroFilter(options);
    this._fz = new OneEuroFilter(options);
  }
  filter(vec3, timestamp) {
    vec3.x = this._fx.filter(vec3.x, timestamp);
    vec3.y = this._fy.filter(vec3.y, timestamp);
    vec3.z = this._fz.filter(vec3.z, timestamp);
    return vec3;
  }
  reset() {
    this._fx.reset(); this._fy.reset(); this._fz.reset();
  }
}
