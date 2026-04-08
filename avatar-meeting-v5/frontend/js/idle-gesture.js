/**
 * @fileoverview Natural idle body gesture animator.
 *
 * Applies small Perlin-noise driven rotations to torso/shoulder/arm bones
 * to simulate natural "speaking with gestures" body language.
 *
 * Speech intensity is derived from blendShapes.jawOpen — when the user
 * is talking, gestures become more pronounced; when silent, only subtle
 * idle motion remains.
 *
 * Design:
 *  - Captures each bone's base rotation (rest pose) at registration
 *  - Every frame, applies: finalRot = baseRot * noiseDelta * intensity
 *  - Different noise frequencies per bone to avoid synchronized motion
 */

import * as THREE from 'three';

// ============================================================================
// Simple 1D Perlin-like noise (lightweight, no external lib)
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
  _lerp(a, b, t) { return a + t * (b - a); }
  _grad(hash, x) {
    const h = hash & 15;
    const g = 1 + (h & 7);
    return ((h & 8) ? -g : g) * x;
  }

  /** 1D Perlin noise, returns roughly -1..1 */
  noise(x) {
    const X = Math.floor(x) & 255;
    x -= Math.floor(x);
    const u = this._fade(x);
    return this._lerp(
      this._grad(this._p[X], x),
      this._grad(this._p[X + 1], x - 1),
      u
    ) * 0.5;
  }

  /**
   * Fractal Brownian Motion (multi-octave noise for natural variation)
   */
  fbm(x, octaves = 3) {
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
// Bone name patterns — matches Avaturn / Mixamo / Ready Player Me skeletons
// ============================================================================
const BONE_RULES = [
  // Torso — gentle sway and subtle twist
  {
    pattern: /^(mixamorig:?)?Spine$/i,
    config: {
      seed: 11,
      freqX: 0.25, freqY: 0.20, freqZ: 0.30,
      ampX: 0.020, ampY: 0.025, ampZ: 0.015,
      speechBoost: 1.8,
    },
  },
  {
    pattern: /^(mixamorig:?)?Spine1$/i,
    config: {
      seed: 12,
      freqX: 0.28, freqY: 0.22, freqZ: 0.33,
      ampX: 0.025, ampY: 0.030, ampZ: 0.020,
      speechBoost: 1.8,
    },
  },
  {
    pattern: /^(mixamorig:?)?Spine2$/i,
    config: {
      seed: 13,
      freqX: 0.30, freqY: 0.25, freqZ: 0.35,
      ampX: 0.030, ampY: 0.035, ampZ: 0.025,
      speechBoost: 2.0,
    },
  },

  // Shoulders — slight lift/drop during gestures
  {
    pattern: /^(mixamorig:?)?LeftShoulder$/i,
    config: {
      seed: 21,
      freqX: 0.35, freqY: 0.30, freqZ: 0.40,
      ampX: 0.030, ampY: 0.020, ampZ: 0.025,
      speechBoost: 2.5,
    },
  },
  {
    pattern: /^(mixamorig:?)?RightShoulder$/i,
    config: {
      seed: 22,
      freqX: 0.33, freqY: 0.32, freqZ: 0.38,
      ampX: 0.030, ampY: 0.020, ampZ: 0.025,
      speechBoost: 2.5,
    },
  },

  // Upper arms — subtle swinging
  {
    pattern: /^(mixamorig:?)?LeftArm$/i,
    config: {
      seed: 31,
      freqX: 0.40, freqY: 0.35, freqZ: 0.30,
      ampX: 0.040, ampY: 0.035, ampZ: 0.030,
      speechBoost: 3.0,
    },
  },
  {
    pattern: /^(mixamorig:?)?RightArm$/i,
    config: {
      seed: 32,
      freqX: 0.38, freqY: 0.37, freqZ: 0.32,
      ampX: 0.040, ampY: 0.035, ampZ: 0.030,
      speechBoost: 3.0,
    },
  },

  // Forearms — small random motion
  {
    pattern: /^(mixamorig:?)?LeftForeArm$/i,
    config: {
      seed: 41,
      freqX: 0.45, freqY: 0.40, freqZ: 0.35,
      ampX: 0.030, ampY: 0.025, ampZ: 0.020,
      speechBoost: 2.5,
    },
  },
  {
    pattern: /^(mixamorig:?)?RightForeArm$/i,
    config: {
      seed: 42,
      freqX: 0.43, freqY: 0.42, freqZ: 0.37,
      ampX: 0.030, ampY: 0.025, ampZ: 0.020,
      speechBoost: 2.5,
    },
  },
];

// ============================================================================
// IdleGestureAnimator
// ============================================================================
export class IdleGestureAnimator {
  constructor() {
    /** @private */
    this._targets = [];
    /** @private */
    this._time = 0;

    /** Public settings (controlled from UI) */
    this.enabled = true;
    /** @type {number} Global intensity multiplier (0..2) */
    this.intensity = 1.0;

    /** @private Smoothed speech intensity (from jawOpen) */
    this._speechEnv = 0;

    /** @private Reusable temp objects to avoid GC */
    this._tmpQuat = new THREE.Quaternion();
    this._tmpEuler = new THREE.Euler();
    this._deltaQuat = new THREE.Quaternion();
  }

  /**
   * Scan the avatar's skeleton and register matching bones.
   * Must be called after avatar is loaded into the scene.
   * @param {THREE.Object3D} avatarRoot
   */
  registerAvatar(avatarRoot) {
    this._targets = [];

    if (!avatarRoot) return;

    avatarRoot.traverse((obj) => {
      if (!obj.isBone && obj.type !== 'Bone') return;

      for (const rule of BONE_RULES) {
        if (rule.pattern.test(obj.name)) {
          this._targets.push({
            bone: obj,
            baseQuat: obj.quaternion.clone(),
            noise: new Noise1D(rule.config.seed),
            config: rule.config,
          });
          break;
        }
      }
    });

    console.log(
      `[IdleGesture] Registered ${this._targets.length} bones:`,
      this._targets.map((t) => t.bone.name).join(', ')
    );

    if (this._targets.length === 0) {
      console.warn(
        '[IdleGesture] No matching bones found. ' +
        'Avatar may have non-standard skeleton naming.'
      );
    }
  }

  /**
   * Clear registration (call before loading a new avatar).
   */
  clear() {
    for (const t of this._targets) {
      t.bone.quaternion.copy(t.baseQuat);
    }
    this._targets = [];
  }

  /**
   * Per-frame update. Call after _applyBlendShapes / _applyHeadPose.
   *
   * @param {number} dt - Elapsed ms since last frame
   * @param {Object<string, number>} blendShapes - MediaPipe blendshapes
   */
  update(dt, blendShapes) {
    if (!this.enabled || this._targets.length === 0) {
      for (const t of this._targets) {
        t.bone.quaternion.slerp(t.baseQuat, 0.2);
      }
      return;
    }

    this._time += dt / 1000;

    // Speech envelope from jawOpen (smoothed)
    const jawOpen = blendShapes?.jawOpen || 0;
    const rawSpeech = Math.max(0, (jawOpen - 0.04) / 0.35);
    const targetSpeech = Math.min(1, rawSpeech);

    const attack = 0.25;
    const release = 0.04;
    const coef = targetSpeech > this._speechEnv ? attack : release;
    this._speechEnv += (targetSpeech - this._speechEnv) * coef;

    // Per-bone noise-driven rotation
    for (const t of this._targets) {
      const cfg = t.config;

      const idleAmp = 0.35;
      const speechAmp = this._speechEnv * cfg.speechBoost;
      const totalAmp = (idleAmp + speechAmp) * this.intensity;

      const nx = t.noise.fbm(this._time * cfg.freqX + 0, 3);
      const ny = t.noise.fbm(this._time * cfg.freqY + 100, 3);
      const nz = t.noise.fbm(this._time * cfg.freqZ + 200, 3);

      this._tmpEuler.set(
        nx * cfg.ampX * totalAmp,
        ny * cfg.ampY * totalAmp,
        nz * cfg.ampZ * totalAmp,
        'XYZ'
      );
      this._deltaQuat.setFromEuler(this._tmpEuler);

      // Final rotation = base rotation * delta
      this._tmpQuat.copy(t.baseQuat).multiply(this._deltaQuat);

      // Smooth slerp toward target to avoid jitter
      t.bone.quaternion.slerp(this._tmpQuat, 0.35);
    }
  }
}
