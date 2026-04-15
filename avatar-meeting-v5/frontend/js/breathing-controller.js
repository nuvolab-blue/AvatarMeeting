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

const HEAD_PATTERN = /^(mixamorig:?)?Head$/i;

/**
 * Per-bone breath parameters — v17 revised (no more scaleY).
 *
 *   phaseOffset : fraction of cycle delayed behind diaphragm
 *   rotX        : pitch in radians (negative = chest tilts back = "chest opens")
 *   rotZ        : roll in radians (shoulder rotation)
 *   posY        : vertical translation in meters (shoulder lift)
 *   posZ        : forward translation in meters (chest pushes forward on inhale)
 *
 * Design: breathing is primarily a FORWARD expansion (posZ) + subtle backward
 * tilt (rotX), NOT vertical stretching. This eliminates the "growing taller"
 * artifact caused by cumulative scaleY in the bone hierarchy.
 */
const BONE_BREATH_PARAMS = {
  spine: {
    phaseOffset: 0.00,
    rotX:   0.000,
    rotZ:   0.000,
    posY:   0.000,
    posZ:   0.004,
  },
  spine1: {
    phaseOffset: 0.08,
    rotX:   0.000,
    rotZ:   0.000,
    posY:   0.000,
    posZ:   0.008,
  },
  spine2: {
    phaseOffset: 0.16,
    rotX:   0.000,
    rotZ:   0.000,
    posY:   0.000,
    posZ:   0.006,
  },
  leftShoulder: {
    phaseOffset: 0.20,
    rotX:   0.000,
    rotZ:   0.010,
    posY:   0.002,
    posZ:   0.003,
  },
  rightShoulder: {
    phaseOffset: 0.20,
    rotX:   0.000,
    rotZ:  -0.010,
    posY:   0.002,
    posZ:   0.003,
  },
  neck: {
    phaseOffset: 0.25,
    rotX:   0.000,
    rotZ:   0.000,
    posY:   0.000,
    posZ:   0.000,
  },
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

    /** @private @type {THREE.Bone|null} */
    this._headBone = null;
    /** @private @type {THREE.Object3D|null} */
    this._avatarRoot = null;
    /** @private */
    this._headRestWorldY = 0;
    /** @private */
    this._tmpVec3 = new THREE.Vector3();
    /** @private */
    this._tmpVec3b = new THREE.Vector3();

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
    this._headBone = null;
    this._avatarRoot = avatarRoot || null;
    this._headRestWorldY = 0;
    if (!avatarRoot) return;

    avatarRoot.updateMatrixWorld(true);

    avatarRoot.traverse((obj) => {
      if (!obj.isBone && obj.type !== 'Bone') return;
      if (!this._headBone && HEAD_PATTERN.test(obj.name)) {
        this._headBone = obj;
      }
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

    if (this._headBone) {
      this._headBone.getWorldPosition(this._tmpVec3);
      this._headRestWorldY = this._tmpVec3.y;
    }

    console.log(
      `[Breathing] Registered ${this._targets.length} bones: ` +
      this._targets.map((t) => t.bone.name).join(', ') +
      (this._headBone ? ` | Head Y-lock at ${this._headRestWorldY.toFixed(4)}` : ' | (no head bone found)')
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
    this._headBone = null;
    this._avatarRoot = null;
    this._headRestWorldY = 0;
  }

  /** @private soft-saturating depth: ≤1 linear, >1 compressed (depth=2 → 1.5) */
  _effectiveDepth() {
    return this.depth <= 1 ? this.depth : 1 + (this.depth - 1) * 0.5;
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

    const effDepth = this._effectiveDepth();

    for (const t of this._targets) {
      const p = t.params;
      let phase = this._phase - p.phaseOffset;
      if (phase < 0) phase += 1;

      const w = skewedBreathWave(phase) * effDepth;

      // --- Rotation delta (shoulder roll only in v17.1) ---
      if (p.rotX !== 0 || p.rotZ !== 0) {
        this._tmpEuler.set(p.rotX * w, 0, p.rotZ * w, 'XYZ');
        this._tmpQuat.setFromEuler(this._tmpEuler);
        t.bone.quaternion.copy(t.restQuat).multiply(this._tmpQuat);
      } else {
        t.bone.quaternion.copy(t.restQuat);
      }

      // --- Position delta (forward expansion + shoulder lift) ---
      if ((p.posY || 0) !== 0 || (p.posZ || 0) !== 0) {
        t.bone.position.set(
          t.restPos.x,
          t.restPos.y + (p.posY || 0) * w,
          t.restPos.z + (p.posZ || 0) * w
        );
      } else {
        t.bone.position.copy(t.restPos);
      }

      // v17: scaleY removed — always restore rest scale to clear any residue.
      if (t.bone.scale.x !== t.restScale.x ||
          t.bone.scale.y !== t.restScale.y ||
          t.bone.scale.z !== t.restScale.z) {
        t.bone.scale.copy(t.restScale);
      }
    }

    // ------------------------------------------------------------------------
    // v17.1: HEAD Y-POSITION LOCK
    // After applying breath deltas to the chest chain, the head may have
    // drifted vertically due to cumulative hierarchy effects. Lock the head's
    // world-space Y to its rest value by adjusting its LOCAL Y, using the
    // parent's world scale to convert world→local delta. This preserves the
    // forward chest expansion visual (posZ unaffected) while guaranteeing
    // the head stays at the same height.
    // ------------------------------------------------------------------------
    if (this._headBone && this._avatarRoot) {
      this._avatarRoot.updateMatrixWorld(true);
      this._headBone.getWorldPosition(this._tmpVec3);
      const dY = this._tmpVec3.y - this._headRestWorldY;
      if (Math.abs(dY) > 1e-5) {
        const parent = this._headBone.parent;
        let invScaleY = 1;
        if (parent) {
          parent.getWorldScale(this._tmpVec3b);
          if (this._tmpVec3b.y > 1e-4) invScaleY = 1 / this._tmpVec3b.y;
        }
        this._headBone.position.y -= dY * invScaleY;
      }
    }
  }
}
