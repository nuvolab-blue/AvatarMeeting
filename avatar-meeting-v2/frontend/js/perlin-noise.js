/**
 * @fileoverview Perlin Noise implementation for idle micro-expressions.
 *
 * Provides 2D Perlin Noise and fBm (fractional Brownian motion) for
 * generating natural-looking micro-movements in avatar animation.
 *
 * Based on Ken Perlin's improved noise algorithm with:
 *  - Seeded permutation table (Fisher-Yates shuffle)
 *  - Improved fade curve: 6t^5 - 15t^4 + 10t^3
 *  - 4-direction gradient selection
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

  /**
   * Initialize permutation table with Fisher-Yates shuffle.
   * @private
   * @param {number} seed
   */
  _init(seed) {
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;

    // Seeded PRNG (mulberry32)
    let s = seed | 0;
    const rand = () => {
      s = (s + 0x6d2b79f5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };

    // Fisher-Yates shuffle
    for (let i = 255; i > 0; i--) {
      const j = (rand() * (i + 1)) | 0;
      const tmp = p[i];
      p[i] = p[j];
      p[j] = tmp;
    }

    // Double to avoid modulo
    for (let i = 0; i < 512; i++) {
      this._perm[i] = p[i & 255];
    }
  }

  /**
   * Improved fade curve: 6t^5 - 15t^4 + 10t^3
   * @private
   * @param {number} t - Value in [0, 1]
   * @returns {number}
   */
  _fade(t) {
    return t * t * t * (t * (t * 6 - 15) + 10);
  }

  /**
   * Linear interpolation.
   * @private
   * @param {number} a
   * @param {number} b
   * @param {number} t
   * @returns {number}
   */
  _lerp(a, b, t) {
    return a + t * (b - a);
  }

  /**
   * Gradient selection using lower 2 bits of hash.
   * 4 directions: (+1,+1), (-1,+1), (+1,-1), (-1,-1)
   * @private
   * @param {number} hash
   * @param {number} x
   * @param {number} y
   * @returns {number}
   */
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
    // Grid cell coordinates
    const xi = Math.floor(x) & 255;
    const yi = Math.floor(y) & 255;

    // Relative position within cell
    const xf = x - Math.floor(x);
    const yf = y - Math.floor(y);

    // Fade curves
    const u = this._fade(xf);
    const v = this._fade(yf);

    // Hash coordinates of 4 corners
    const p = this._perm;
    const aa = p[p[xi] + yi];
    const ab = p[p[xi] + yi + 1];
    const ba = p[p[xi + 1] + yi];
    const bb = p[p[xi + 1] + yi + 1];

    // Bilinear interpolation of gradients
    const x1 = this._lerp(this._grad(aa, xf, yf), this._grad(ba, xf - 1, yf), u);
    const x2 = this._lerp(this._grad(ab, xf, yf - 1), this._grad(bb, xf - 1, yf - 1), u);

    return this._lerp(x1, x2, v);
  }

  /**
   * fBm (fractional Brownian motion) — multi-octave noise.
   * Primary method for generating natural micro-movements.
   * @param {number} x
   * @param {number} y
   * @param {number} octaves - Number of octaves (default 3)
   * @returns {number} Value in approximately [-0.5, 0.5]
   */
  fbm(x, y, octaves = 3) {
    let value = 0;
    let amplitude = 0.5;
    let frequency = 1;

    for (let i = 0; i < octaves; i++) {
      value += amplitude * this.noise(x * frequency, y * frequency);
      amplitude *= 0.5;
      frequency *= 2;
    }

    return value;
  }
}

// ES module export
export default PerlinNoise;

// Browser global (for non-module usage)
if (typeof window !== 'undefined') {
  window.PerlinNoise = PerlinNoise;
}
