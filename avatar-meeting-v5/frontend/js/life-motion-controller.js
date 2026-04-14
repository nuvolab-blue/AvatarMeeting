/**
 * @fileoverview Life motion controller — microsaccades + camera shake.
 *
 * Two sub-systems:
 *   1. MicrosaccadeController: injects small random eye movements into
 *      blendshape eyeLook* channels at ~3-5Hz (Poisson process).
 *   2. CameraShakeController: adds Perlin-noise micro-jitter to camera
 *      position to simulate handheld/tripod camera breathing.
 *
 * Both effects are subtle by design — they should be perceived
 * subconsciously, not consciously noticed.
 */

import * as THREE from 'three';

// ============================================================================
// 1D Perlin-like noise (inline, no external dep)
// ============================================================================
class Noise1D {
  constructor(seed = 1) {
    this._p = new Uint8Array(512);
    const perm = new Uint8Array(256);
    for (let i = 0; i < 256; i++) perm[i] = i;
    let s = seed;
    for (let i = 255; i > 0; i--) {
      s = (s * 16807) % 2147483647;
      const j = s % (i + 1);
      [perm[i], perm[j]] = [perm[j], perm[i]];
    }
    for (let i = 0; i < 512; i++) this._p[i] = perm[i & 255];
  }
  _fade(t) { return t * t * t * (t * (t * 6 - 15) + 10); }
  _grad(hash, x) {
    const h = hash & 15;
    const g = 1 + (h & 7);
    return ((h & 8) ? -g : g) * x;
  }
  noise(x) {
    const X = Math.floor(x) & 255;
    x -= Math.floor(x);
    const u = this._fade(x);
    const a = this._grad(this._p[X], x);
    const b = this._grad(this._p[X + 1], x - 1);
    return (a + u * (b - a)) * 0.5;
  }
  fbm(x, octaves = 2) {
    let v = 0, amp = 0.5, freq = 1;
    for (let i = 0; i < octaves; i++) {
      v += amp * this.noise(x * freq);
      amp *= 0.5;
      freq *= 2;
    }
    return v;
  }
}

// ============================================================================
// Microsaccade Controller
// ============================================================================
export class MicrosaccadeController {
  constructor() {
    this._offset = { x: 0, y: 0 };
    this._target = { x: 0, y: 0 };
    this._saccadeTimeLeft = 0;
    this._nextSaccadeIn = 0.3;
    this._time = 0;

    this.enabled = true;
    /** @type {number} Global amplitude multiplier 0..2 */
    this.amplitude = 1.0;
    /** @type {number} Mean seconds between saccades */
    this.meanInterval = 0.3;
  }

  /**
   * @param {number} dt - seconds
   * @param {Object} [emotionState] - v14 emotion state for modulation
   */
  update(dt, emotionState) {
    if (!this.enabled) {
      this._offset.x = 0;
      this._offset.y = 0;
      return;
    }

    this._time += dt;
    this._saccadeTimeLeft -= dt;
    this._nextSaccadeIn -= dt;

    // Higher arousal = more frequent saccades
    let intervalMultiplier = 1.0;
    if (emotionState?.active) {
      intervalMultiplier = 1.0 - emotionState.arousal * 0.5;
    }

    if (this._nextSaccadeIn <= 0) {
      const u = Math.random() * 2 - 1;
      const v = Math.random() * 2 - 1;
      this._target.x = u * 0.12;
      this._target.y = v * 0.08;
      this._saccadeTimeLeft = 0.04;

      const meanAdjusted = this.meanInterval * intervalMultiplier;
      this._nextSaccadeIn = -Math.log(Math.random()) * meanAdjusted;
    }

    if (this._saccadeTimeLeft > 0) {
      const blendFactor = Math.min(1, dt / 0.04);
      this._offset.x += (this._target.x - this._offset.x) * blendFactor * 3;
      this._offset.y += (this._target.y - this._offset.y) * blendFactor * 3;
    } else {
      this._offset.x += (this._target.x - this._offset.x) * dt * 5;
      this._offset.y += (this._target.y - this._offset.y) * dt * 5;
    }
  }

  /**
   * Apply current saccade offset as ADDITIVE bias to eyeLook* shapes.
   * @param {Object<string,number>} effectiveShapes
   */
  applyTo(effectiveShapes) {
    if (!this.enabled) return;

    const amp = this.amplitude;
    const x = this._offset.x * amp;
    const y = this._offset.y * amp;

    if (x > 0) {
      effectiveShapes.eyeLookInLeft   = (effectiveShapes.eyeLookInLeft   ?? 0) + x;
      effectiveShapes.eyeLookOutRight = (effectiveShapes.eyeLookOutRight ?? 0) + x;
    } else if (x < 0) {
      const absX = -x;
      effectiveShapes.eyeLookOutLeft = (effectiveShapes.eyeLookOutLeft ?? 0) + absX;
      effectiveShapes.eyeLookInRight = (effectiveShapes.eyeLookInRight ?? 0) + absX;
    }

    if (y > 0) {
      effectiveShapes.eyeLookUpLeft  = (effectiveShapes.eyeLookUpLeft  ?? 0) + y;
      effectiveShapes.eyeLookUpRight = (effectiveShapes.eyeLookUpRight ?? 0) + y;
    } else if (y < 0) {
      const absY = -y;
      effectiveShapes.eyeLookDownLeft  = (effectiveShapes.eyeLookDownLeft  ?? 0) + absY;
      effectiveShapes.eyeLookDownRight = (effectiveShapes.eyeLookDownRight ?? 0) + absY;
    }
  }

  setAmplitude(v) { this.amplitude = Math.max(0, Math.min(2, v)); }
  setEnabled(v) { this.enabled = !!v; }
}

// ============================================================================
// Camera Shake Controller
// ============================================================================
export class CameraShakeController {
  constructor() {
    this._noiseX = new Noise1D(101);
    this._noiseY = new Noise1D(202);
    this._noiseZ = new Noise1D(303);
    this._time = 0;

    this.enabled = true;
    /** @type {number} Amplitude in meters */
    this.amplitude = 0.002;
    /** @type {number} Temporal frequency (Hz) */
    this.frequency = 0.5;

    this.offset = new THREE.Vector3();
  }

  /** @param {number} dt - seconds */
  update(dt) {
    if (!this.enabled) {
      this.offset.set(0, 0, 0);
      return;
    }
    this._time += dt * this.frequency;
    this.offset.x = this._noiseX.fbm(this._time,       2) * this.amplitude;
    this.offset.y = this._noiseY.fbm(this._time + 100, 2) * this.amplitude;
    this.offset.z = this._noiseZ.fbm(this._time + 200, 2) * this.amplitude * 0.5;
  }

  setAmplitude(v) { this.amplitude = Math.max(0, Math.min(0.01, v)); }
  setFrequency(v) { this.frequency = Math.max(0.1, Math.min(2, v)); }
  setEnabled(v) { this.enabled = !!v; }
}

// ============================================================================
// Combined wrapper
// ============================================================================
export class LifeMotionController {
  constructor() {
    this.saccade = new MicrosaccadeController();
    this.shake = new CameraShakeController();
  }

  update(dt, emotionState) {
    this.saccade.update(dt, emotionState);
    this.shake.update(dt);
  }
}
