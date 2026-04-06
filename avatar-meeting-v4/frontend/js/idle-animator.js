/**
 * @fileoverview Idle animation generator using Perlin Noise.
 *
 * Produces automatic blinks, breathing motion, and micro-expressions
 * when the user is not actively interacting (or as subtle additions).
 */

class IdleAnimator {
  constructor() {
    /** @type {{blink: boolean, breath: boolean, micro: boolean}} */
    this.settings = { blink: true, breath: true, micro: true };

    /** @private */ this._noise = new PerlinNoise(42);
    /** @private */ this._time = 0;

    // Blink state machine
    /** @private */ this._blinkState = 'idle'; // idle, closing, hold, opening
    /** @private */ this._blinkTimer = 0;
    /** @private */ this._blinkInterval = 3.0; // seconds until next blink
    /** @private */ this._blinkValue = 0;
    /** @private */ this._isDoubleBlink = false;
    /** @private */ this._doubleBlinkCount = 0;

    // Blink timing (ms)
    /** @private */ this._BLINK_CLOSE = 75;
    /** @private */ this._BLINK_HOLD = 40;
    /** @private */ this._BLINK_OPEN = 110;

    /** @private */ this._cameraBlinkActive = false;
  }

  /**
   * Set whether camera blink is active (disables idle blink).
   * @param {boolean} active
   */
  setCameraBlinkActive(active) {
    this._cameraBlinkActive = active;
  }

  /**
   * Generate idle BlendShape contributions.
   * @param {number} dt - Elapsed time in ms
   * @returns {Object<string, number>} BlendShape deltas to add
   */
  update(dt) {
    const dtSec = dt / 1000;
    this._time += dtSec;
    const t = this._time;

    const result = {};

    // === Blink ===
    if (this.settings.blink && !this._cameraBlinkActive) {
      this._updateBlink(dt);
      if (this._blinkValue > 0) {
        result.eyeBlinkLeft = this._blinkValue;
        result.eyeBlinkRight = this._blinkValue;
      }
    }

    // === Breath ===
    if (this.settings.breath) {
      result.jawOpen = (result.jawOpen || 0) + Math.sin(t * Math.PI * 1.5) * 0.03; // 0.75Hz
      result._pitchOffset = Math.sin(t * Math.PI * 0.8) * 1.5; // visible head bob (degrees)
    }

    // === Micro-expressions (Perlin fBm) ===
    if (this.settings.micro) {
      const n = this._noise;
      result.mouthSmileLeft = (result.mouthSmileLeft || 0) + n.fbm(t * 0.28, 0.0) * 0.03;
      result.mouthSmileRight = (result.mouthSmileRight || 0) + n.fbm(t * 0.28, 1.0) * 0.03;
      result.browInnerUp = (result.browInnerUp || 0) + n.fbm(t * 0.18, 2.0) * 0.02;

      // ★ v4.3: Much larger head movement for visible idle animation
      result._yawOffset = n.fbm(t * 0.13, 3.0) * 4.0;       // ±4° yaw
      result._pitchOffset = (result._pitchOffset || 0) + n.fbm(t * 0.10, 4.0) * 2.0; // ±2° pitch
      result._rollOffset = n.fbm(t * 0.08, 5.0) * 1.5;       // ±1.5° roll
    }

    return result;
  }

  // ==========================================================================
  // Private: Blink state machine
  // ==========================================================================

  /** @private */
  _updateBlink(dt) {
    this._blinkTimer += dt;

    switch (this._blinkState) {
      case 'idle':
        if (this._blinkTimer >= this._blinkInterval * 1000) {
          this._blinkState = 'closing';
          this._blinkTimer = 0;
          this._isDoubleBlink = Math.random() < 0.2;
          this._doubleBlinkCount = 0;
        }
        break;

      case 'closing':
        this._blinkValue = Math.min(this._blinkTimer / this._BLINK_CLOSE, 1.0);
        if (this._blinkTimer >= this._BLINK_CLOSE) {
          this._blinkState = 'hold';
          this._blinkTimer = 0;
          this._blinkValue = 1.0;
        }
        break;

      case 'hold':
        this._blinkValue = 1.0;
        if (this._blinkTimer >= this._BLINK_HOLD) {
          this._blinkState = 'opening';
          this._blinkTimer = 0;
        }
        break;

      case 'opening':
        this._blinkValue = 1.0 - Math.min(this._blinkTimer / this._BLINK_OPEN, 1.0);
        if (this._blinkTimer >= this._BLINK_OPEN) {
          this._blinkValue = 0;
          this._doubleBlinkCount++;

          if (this._isDoubleBlink && this._doubleBlinkCount < 2) {
            // Start second blink immediately
            this._blinkState = 'closing';
            this._blinkTimer = 0;
          } else {
            this._blinkState = 'idle';
            this._blinkTimer = 0;
            // Random next interval: 2-6 seconds
            this._blinkInterval = 2 + Math.random() * 4;
          }
        }
        break;
    }
  }
}

window.IdleAnimator = IdleAnimator;
