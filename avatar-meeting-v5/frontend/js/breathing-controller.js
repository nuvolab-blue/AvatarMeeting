/**
 * @fileoverview v13 — Physics-based breathing controller.
 *
 * Implements an anatomically-grounded breathing rig that drives the avatar's
 * thorax/shoulder/neck chain with a skewed sine wave. Inhale is faster than
 * exhale (physiologically accurate ~35/55/10 inhale/exhale/pause split), and
 * each bone in the chain has a small phase offset so the breath visibly
 * propagates from the diaphragm up through the chest and shoulders.
 *
 * The controller stores per-bone REST transforms (quat/pos/scale) at registration
 * time and re-applies a multiplicative delta each frame — this makes it
 * compose cleanly with idle-gesture (which slerps from the same baseQuat)
 * because idle-gesture runs AFTER breathing in the update order.
 */

import * as THREE from 'three';

// ============================================================================
// Bone matching — same canonicalization style as idle-gesture
// ============================================================================
const BONE_PATTERNS = {
  spine:        /^(mixamorig:?)?Spine$/i,
  spine1:       /^(mixamorig:?)?Spine1$/i,
  spine2:       /^(mixamorig:?)?Spine2$/i,
  leftShoulder: /^(mixamorig:?)?LeftShoulder$/i,
  rightShoulder:/^(mixamorig:?)?RightShoulder$/i,
  neck:         /^(mixamorig:?)?Neck$/i,
};

/**
 * Per-bone breath parameters.
 *
 *   phaseOffset : seconds delayed behind the diaphragm (Spine = 0)
 *   scaleY      : vertical scale delta at peak inhale (chest expansion)
 *   rotX        : pitch delta at peak inhale (rad) — chest tilts back slightly
 *   rotZ        : roll delta at peak inhale (rad) — shoulders rise asymmetric
 *   posY        : vertical translation delta at peak (m) — shoulder lift
 */
const BONE_BREATH_PARAMS = {
  spine:         { phaseOffset: 0.00, scaleY: 0.012, rotX: -0.010, rotZ: 0.000, posY: 0.000 },
  spine1:        { phaseOffset: 0.08, scaleY: 0.018, rotX: -0.014, rotZ: 0.000, posY: 0.000 },
  spine2:        { phaseOffset: 0.16, scaleY: 0.022, rotX: -0.018, rotZ: 0.000, posY: 0.000 },
  leftShoulder:  { phaseOffset: 0.20, scaleY: 0.000, rotX:  0.000, rotZ:  0.012, posY: 0.0035 },
  rightShoulder: { phaseOffset: 0.20, scaleY: 0.000, rotX:  0.000, rotZ: -0.012, posY: 0.0035 },
  neck:          { phaseOffset: 0.25, scaleY: 0.000, rotX: -0.006, rotZ: 0.000, posY: 0.000 },
};

/**
 * Skewed breath wave. Returns a value in [0, 1] over a full cycle phase
 * in [0, 1]:
 *
 *   [0.00 .. 0.35]  inhale  — fast cosine ramp up
 *   [0.35 .. 0.90]  exhale  — slower cosine ramp down
 *   [0.90 .. 1.00]  pause   — held at 0
 *
 * @param {number} phase  0..1
 * @returns {number}      0..1
 */
export function skewedBreathWave(phase) {
  if (phase < 0.35) {
    const t = phase / 0.35;
    return 0.5 - 0.5 * Math.cos(Math.PI * t);
  }
  if (phase < 0.90) {
    const t = (phase - 0.35) / 0.55;
    return 0.5 + 0.5 * Math.cos(Math.PI * t);
  }
  return 0;
}

// ============================================================================
// BreathingController
// ============================================================================
export class BreathingController {
  constructor() {
    /** @private @type {Array<{key:string, bone:THREE.Bone, restQuat:THREE.Quaternion, restPos:THREE.Vector3, restScale:THREE.Vector3, params:object}>} */
    this._targets = [];
    /** @private */
    this._phase = 0;

    this.enabled = true;
    /** breaths per minute */
    this.breathRate = 11;
    /** global depth multiplier (0..2) */
    this.depth = 1.0;

    /** @private temps */
    this._tmpEuler = new THREE.Euler();
    this._tmpQuat = new THREE.Quaternion();
  }

  /**
   * Scan an avatar root, find chest/shoulder/neck bones and snapshot their
   * rest transforms. Safe to call repeatedly — clears previous registration.
   * @param {THREE.Object3D} avatarRoot
   */
  registerAvatar(avatarRoot) {
    this._targets = [];
    if (!avatarRoot) return;

    avatarRoot.updateMatrixWorld(true);

    avatarRoot.traverse((obj) => {
      if (!obj.isBone && obj.type !== 'Bone') return;
      for (const [key, pat] of Object.entries(BONE_PATTERNS)) {
        if (pat.test(obj.name)) {
          this._targets.push({
            key,
            bone: obj,
            restQuat: obj.quaternion.clone(),
            restPos: obj.position.clone(),
            restScale: obj.scale.clone(),
            params: BONE_BREATH_PARAMS[key],
          });
          break;
        }
      }
    });

    console.log(
      `[Breathing] Registered ${this._targets.length} bones: ` +
      this._targets.map((t) => t.bone.name).join(', ')
    );
  }

  /** Restore rest pose and forget targets. */
  clear() {
    for (const t of this._targets) {
      t.bone.quaternion.copy(t.restQuat);
      t.bone.position.copy(t.restPos);
      t.bone.scale.copy(t.restScale);
    }
    this._targets = [];
    this._phase = 0;
  }

  setEnabled(v) {
    this.enabled = !!v;
    if (!this.enabled) {
      // Snap back to rest so idle-gesture has a clean baseline
      for (const t of this._targets) {
        t.bone.quaternion.copy(t.restQuat);
        t.bone.position.copy(t.restPos);
        t.bone.scale.copy(t.restScale);
      }
    }
  }

  /** @param {number} bpm  6..30 */
  setBreathRate(bpm) {
    this.breathRate = Math.max(6, Math.min(30, bpm));
  }

  /** @param {number} d  0..2 */
  setDepth(d) {
    this.depth = Math.max(0, Math.min(2, d));
  }

  /**
   * Advance the breath phase and apply the current breath delta to all
   * registered bones. Must be called BEFORE idle-gesture each frame.
   * @param {number} dtMs
   */
  update(dtMs) {
    if (!this.enabled || this._targets.length === 0) return;

    const dt = Math.min(0.1, dtMs / 1000);
    const cycleSec = 60 / this.breathRate;
    this._phase += dt / cycleSec;
    if (this._phase >= 1) this._phase -= Math.floor(this._phase);

    for (const t of this._targets) {
      const p = t.params;
      let phase = this._phase - p.phaseOffset;
      if (phase < 0) phase += 1;

      const w = skewedBreathWave(phase) * this.depth;

      // Rotation delta (chest tilts back, shoulders rise outward)
      this._tmpEuler.set(p.rotX * w, 0, p.rotZ * w, 'XYZ');
      this._tmpQuat.setFromEuler(this._tmpEuler);
      t.bone.quaternion.copy(t.restQuat).multiply(this._tmpQuat);

      // Vertical scale (chest expansion). Restore X/Z.
      if (p.scaleY !== 0) {
        const s = 1 + p.scaleY * w;
        t.bone.scale.set(t.restScale.x, t.restScale.y * s, t.restScale.z);
      }

      // Vertical translation (shoulder lift)
      if (p.posY !== 0) {
        t.bone.position.set(
          t.restPos.x,
          t.restPos.y + p.posY * w,
          t.restPos.z
        );
      }
    }
  }
}
