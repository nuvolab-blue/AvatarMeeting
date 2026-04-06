/**
 * @fileoverview Perlin Noise implementation for idle micro-expressions.
 *
 * Provides 2D Perlin Noise and fBm (fractional Brownian motion) for
 * generating natural-looking micro-movements in avatar animation.
 */

class PerlinNoise {
  /**
   * @param {number} seed - Reproducible random seed
   */
  constructor(seed = 42) {
    /** @private */
    this._perm = new Uint8Array(512);
    this._init(seed);
  }

  /** @private */
  _init(seed) {
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;

    let s = seed | 0;
    const rand = () => {
      s = (s + 0x6d2b79f5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };

    for (let i = 255; i > 0; i--) {
      const j = (rand() * (i + 1)) | 0;
      const tmp = p[i]; p[i] = p[j]; p[j] = tmp;
    }

    for (let i = 0; i < 512; i++) {
      this._perm[i] = p[i & 255];
    }
  }

  /** @private */
  _fade(t) { return t * t * t * (t * (t * 6 - 15) + 10); }

  /** @private */
  _lerp(a, b, t) { return a + t * (b - a); }

  /** @private */
  _grad(hash, x, y) {
    const h = hash & 3;
    const u = h < 2 ? x : -x;
    const v = h === 0 || h === 3 ? y : -y;
    return u + v;
  }

  /**
   * 2D Perlin Noise.
   * @param {number} x
   * @param {number} y
   * @returns {number} Value in approximately [-1, 1]
   */
  noise(x, y) {
    const xi = Math.floor(x) & 255;
    const yi = Math.floor(y) & 255;
    const xf = x - Math.floor(x);
    const yf = y - Math.floor(y);
    const u = this._fade(xf);
    const v = this._fade(yf);
    const p = this._perm;
    const aa = p[p[xi] + yi];
    const ab = p[p[xi] + yi + 1];
    const ba = p[p[xi + 1] + yi];
    const bb = p[p[xi + 1] + yi + 1];
    const x1 = this._lerp(this._grad(aa, xf, yf), this._grad(ba, xf - 1, yf), u);
    const x2 = this._lerp(this._grad(ab, xf, yf - 1), this._grad(bb, xf - 1, yf - 1), u);
    return this._lerp(x1, x2, v);
  }

  /**
   * fBm (fractional Brownian motion) — multi-octave noise.
   * @param {number} x
   * @param {number} y
   * @param {number} octaves
   * @returns {number} Value in approximately [-0.5, 0.5]
   */
  fbm(x, y, octaves = 3) {
    let value = 0, amplitude = 0.5, frequency = 1;
    for (let i = 0; i < octaves; i++) {
      value += amplitude * this.noise(x * frequency, y * frequency);
      amplitude *= 0.5;
      frequency *= 2;
    }
    return value;
  }
}

window.PerlinNoise = PerlinNoise;
