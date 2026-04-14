/**
 * @fileoverview Spring-damper interpolator for expression blendshapes.
 *
 * Implements a damped harmonic oscillator for each blendshape, enabling
 * anticipation, overshoot, and settle effects — the foundation of natural-
 * looking facial animation (Disney 12 principles).
 *
 * Per-shape parameters allow heavier features (jaw) to have visible
 * overshoot, while fast features (blinks) snap without oscillation.
 */

/**
 * Single-value spring-damper oscillator.
 *
 * Physics:
 *   a = k * (target - x) - c * v      (force = spring + damping)
 *   v += a * dt
 *   x += v * dt
 *
 * stiffness (k): higher = faster response
 * damping (c):   lower  = more oscillation
 *   - Critical damping: c = 2 * sqrt(k)
 *   - Under-damped (overshoot): c < 2 * sqrt(k)
 *   - Over-damped (slow):       c > 2 * sqrt(k)
 */
export class SpringDamper {
  /**
   * @param {Object} opts
   * @param {number} [opts.stiffness=180]
   * @param {number} [opts.damping=18]
   * @param {number} [opts.maxVelocity=30]
   */
  constructor(opts = {}) {
    this.stiffness = opts.stiffness ?? 180;
    this.damping   = opts.damping   ?? 18;
    this.maxVelocity = opts.maxVelocity ?? 30;
    this._x = 0;
    this._v = 0;
  }

  /**
   * Advance simulation by dt seconds toward target. Uses sub-stepping for
   * stability at low frame rates.
   * @param {number} target
   * @param {number} dt
   * @returns {number}
   */
  update(target, dt) {
    if (dt <= 0) return this._x;

    const maxStep = 0.004;
    let remaining = Math.min(dt, 0.1);
    while (remaining > 0) {
      const step = Math.min(remaining, maxStep);
      const acc = this.stiffness * (target - this._x) - this.damping * this._v;
      this._v += acc * step;
      if (this._v >  this.maxVelocity) this._v =  this.maxVelocity;
      if (this._v < -this.maxVelocity) this._v = -this.maxVelocity;
      this._x += this._v * step;
      remaining -= step;
    }
    return this._x;
  }

  snap(value) {
    this._x = value;
    this._v = 0;
  }

  get value()    { return this._x; }
  get velocity() { return this._v; }
}

// ============================================================================
// Per-blendshape parameter presets
// ============================================================================
const SHAPE_PARAMS = {
  // Eyes — snappy, no oscillation
  eyeBlinkLeft:       [400, 40],
  eyeBlinkRight:      [400, 40],
  eyeLookDownLeft:    [350, 37],
  eyeLookDownRight:   [350, 37],
  eyeLookInLeft:      [350, 37],
  eyeLookInRight:     [350, 37],
  eyeLookOutLeft:     [350, 37],
  eyeLookOutRight:    [350, 37],
  eyeLookUpLeft:      [350, 37],
  eyeLookUpRight:     [350, 37],
  eyeSquintLeft:      [280, 28],
  eyeSquintRight:     [280, 28],
  eyeWideLeft:        [280, 28],
  eyeWideRight:       [280, 28],

  // Brows — expressive, slight overshoot
  browDownLeft:       [220, 18],
  browDownRight:      [220, 18],
  browInnerUp:        [200, 16],
  browOuterUpLeft:    [210, 17],
  browOuterUpRight:   [210, 17],

  // Mouth — moderate weight, visible settle
  mouthSmileLeft:     [180, 16],
  mouthSmileRight:    [180, 16],
  mouthFrownLeft:     [170, 16],
  mouthFrownRight:    [170, 16],
  mouthDimpleLeft:    [200, 20],
  mouthDimpleRight:   [200, 20],
  mouthPucker:        [180, 18],
  mouthFunnel:        [180, 18],
  mouthLeft:          [180, 18],
  mouthRight:         [180, 18],
  mouthPressLeft:     [220, 22],
  mouthPressRight:    [220, 22],
  mouthRollLower:     [200, 20],
  mouthRollUpper:     [200, 20],
  mouthShrugLower:    [180, 18],
  mouthShrugUpper:    [180, 18],
  mouthStretchLeft:   [180, 18],
  mouthStretchRight:  [180, 18],
  mouthUpperUpLeft:   [200, 20],
  mouthUpperUpRight:  [200, 20],
  mouthLowerDownLeft: [200, 20],
  mouthLowerDownRight:[200, 20],
  mouthClose:         [220, 22],

  // Jaw — heavy, longest settle (most visible overshoot)
  jawOpen:            [120, 10],
  jawForward:         [150, 14],
  jawLeft:            [150, 14],
  jawRight:           [150, 14],

  // Cheek / Nose — subtle support
  cheekPuff:          [240, 24],
  cheekSquintLeft:    [260, 26],
  cheekSquintRight:   [260, 26],
  noseSneerLeft:      [240, 24],
  noseSneerRight:     [240, 24],

  tongueOut:          [200, 22],
};

const DEFAULT_PARAMS = [220, 22];

/**
 * Manager that holds one SpringDamper per blendshape name.
 */
export class ExpressionSpringBank {
  constructor() {
    /** @private */
    this._springs = new Map();
    this.strength = 1.0;
    this.stiffnessScale = 1.0;
    this.dampingScale = 1.0;
  }

  /** @param {string} name @returns {SpringDamper} */
  getOrCreate(name) {
    let s = this._springs.get(name);
    if (!s) {
      const [k, c] = SHAPE_PARAMS[name] || DEFAULT_PARAMS;
      s = new SpringDamper({
        stiffness: k * this.stiffnessScale,
        damping:   c * this.dampingScale,
      });
      this._springs.set(name, s);
    }
    return s;
  }

  /**
   * Integrate one shape toward target.
   * @param {string} name
   * @param {number} target
   * @param {number} dt
   * @returns {number}
   */
  step(name, target, dt) {
    const s = this.getOrCreate(name);
    const physical = s.update(target, dt);
    return physical * this.strength + target * (1 - this.strength);
  }

  /** Reset all springs (call on avatar reload) */
  reset() {
    this._springs.clear();
  }

  /** Rebuild spring parameters after scale changes */
  rebuild() {
    for (const [name, spring] of this._springs.entries()) {
      const [k, c] = SHAPE_PARAMS[name] || DEFAULT_PARAMS;
      spring.stiffness = k * this.stiffnessScale;
      spring.damping   = c * this.dampingScale;
    }
  }
}
